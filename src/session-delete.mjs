import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';

import {
  buildCompactConversationPreview,
  CleanerError,
  parseJsonl,
  readRolloutMetadata,
  serializeJsonlPreservingRaw,
  writeFileAtomically,
} from './core.mjs';
import {
  buildSessionRegistry,
  detectRunningCodexProcesses,
} from './registry.mjs';
import {
  inspectTargetSessionLocks,
  invalidateThreadHistory,
  prepareThreadHistoryMutation,
  withTargetSessionLocks,
} from './codex-thread-history.mjs';

function normalizePathKey(value) {
  let comparable = String(value);
  if (process.platform === 'win32') {
    if (/^\\\\\?\\UNC\\/i.test(comparable)) comparable = `\\\\${comparable.slice(8)}`;
    else if (/^\\\\\?\\/i.test(comparable)) comparable = comparable.slice(4);
  }
  const resolved = path.resolve(comparable);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsideSessionRoots(codexHome, filePath) {
  if (!filePath) return false;
  const key = normalizePathKey(filePath);
  return [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ].some((root) => {
    const rootKey = normalizePathKey(root);
    return key.startsWith(`${rootKey}${path.sep}`);
  });
}

function isInsideRoot(root, filePath) {
  if (!root || !filePath) return false;
  const rootKey = normalizePathKey(root);
  const fileKey = normalizePathKey(filePath);
  return fileKey.startsWith(`${rootKey}${path.sep}`);
}

async function managedHistoricalBackupFiles(session, backupRoot) {
  if (session.storageStatus !== 'backup_only') return [];
  const candidates = (session.backupPaths || []).filter((item) => (
    item?.sourceKind === 'cleaner_backup'
    && typeof item.path === 'string'
    && isInsideRoot(backupRoot, item.path)
  ));
  return Promise.all(candidates.map(async (item) => ({
    path: item.path,
    fingerprint: await fileFingerprint(item.path),
  })));
}

async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch (error) {
    throw new CleanerError(
      'SQLITE_UNAVAILABLE',
      'Deleting a whole Codex session requires Node.js 22.5 or newer with node:sqlite.',
      501,
      { cause: error.message },
    );
  }
}

function jsonSafeRow(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'bigint' ? value.toString() : value,
  ]));
}

async function readThreadState(dbPath, sessionId) {
  if (!dbPath) return { row: null, childThreadCount: 0 };
  const sqlite = await loadSqlite();
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout=2000');
    const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(sessionId);
    const sources = db.prepare('SELECT id, source FROM threads WHERE source IS NOT NULL').all();
    let childThreadCount = 0;
    for (const candidate of sources) {
      if (candidate.id === sessionId || typeof candidate.source !== 'string') continue;
      try {
        const source = JSON.parse(candidate.source);
        if (source?.subagent?.thread_spawn?.parent_thread_id === sessionId) childThreadCount += 1;
      } catch {
        // Plain source values such as "cli" are not child-thread metadata.
      }
    }
    return { row: jsonSafeRow(row), childThreadCount };
  } finally {
    db?.close();
  }
}

function extractIndexSessionId(data) {
  return data?.id
    || data?.session_id
    || data?.sessionId
    || data?.thread_id
    || data?.threadId
    || data?.payload?.id
    || data?.payload?.session_id
    || null;
}

async function readIndexState(codexHome, sessionId) {
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  let source;
  try {
    source = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { indexPath, exists: false, source: '', matchingRows: 0, sourceHash: null };
    }
    throw error;
  }
  let matchingRows = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      if (extractIndexSessionId(JSON.parse(line)) === sessionId) matchingRows += 1;
    } catch {
      // Preserve malformed unrelated rows; deletion only removes exact JSON matches.
    }
  }
  return {
    indexPath,
    exists: true,
    source,
    matchingRows,
    sourceHash: createHash('sha256').update(source).digest('hex'),
  };
}

async function fileFingerprint(filePath) {
  const [source, info] = await Promise.all([readFile(filePath), stat(filePath)]);
  return {
    size: info.size,
    mtimeMs: Math.trunc(info.mtimeMs),
    sha256: createHash('sha256').update(source).digest('hex'),
  };
}

function deletionBackupRoot(codexHome, options) {
  if (options.deletionBackupRoot) return options.deletionBackupRoot;
  const ordinaryBackupRoot = options.backupRoot
    || path.join(codexHome, 'backups', 'codex-turn-cleaner');
  return `${ordinaryBackupRoot}-deleted-sessions`;
}

async function resolveProcessCheck(options) {
  if (options.codexProcessCheck) return options.codexProcessCheck;
  if (Array.isArray(options.runningCodexProcesses)) {
    return { available: true, processes: options.runningCodexProcesses };
  }
  return detectRunningCodexProcesses(options.platform);
}

function planTokenFor(plan) {
  return createHash('sha256').update(JSON.stringify({
    sessionId: plan.session.id,
    rolloutPath: plan.rolloutPath,
    rolloutFingerprint: plan.rolloutFingerprint,
    stateDbPath: plan.stateDbPath,
    sqliteRow: plan.sqliteRow,
    indexSourceHash: plan.indexSourceHash,
    indexRows: plan.indexRows,
    historicalBackupFiles: plan.historicalBackupFiles,
  })).digest('hex');
}

export async function previewSessionDeletion(codexHome, options = {}) {
  const sessionId = String(options.sessionId || '').trim();
  if (!sessionId) {
    throw new CleanerError('MISSING_SESSION', 'Select a session before deleting it.', 400);
  }
  const [registry, codexProcessCheck, indexState] = await Promise.all([
    buildSessionRegistry(codexHome, options),
    resolveProcessCheck(options),
    readIndexState(codexHome, sessionId),
  ]);
  const session = registry.sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new CleanerError('SESSION_NOT_FOUND', 'The selected session was not found.', 404, { sessionId });
  }
  const threadState = await readThreadState(registry.stateDbPath, sessionId);
  const rolloutPath = session.hasRollout ? session.rolloutPath : null;
  if (rolloutPath && !isInsideSessionRoots(codexHome, rolloutPath)) {
    throw new CleanerError(
      'UNSAFE_ROLLOUT_PATH',
      'The session rollout is outside the current Codex session directories.',
      422,
      { rolloutPath },
    );
  }
  if (rolloutPath) {
    const metadata = await readRolloutMetadata(rolloutPath);
    if (metadata.id !== sessionId) {
      throw new CleanerError(
        'ROLLOUT_SESSION_MISMATCH',
        'The rollout metadata does not match the selected session.',
        422,
        { expectedId: sessionId, actualId: metadata.id, rolloutPath },
      );
    }
  }

  const actionCount = Number(Boolean(rolloutPath))
    + Number(Boolean(threadState.row))
    + indexState.matchingRows;
  const historicalBackupFiles = await managedHistoricalBackupFiles(session, registry.backupRoot);
  const targetSessionLock = options.sessionLocksHeld
    ? { available: true, sessions: [], activeSessionIds: [], heldByCleaner: true }
    : await inspectTargetSessionLocks(codexHome, [sessionId], options);
  const blockedByActiveTarget = targetSessionLock.activeSessionIds.length > 0;
  const plan = {
    session: {
      id: session.id,
      title: session.title,
      projectPath: session.projectPath,
      storageStatus: session.storageStatus,
      archived: session.archived,
      threadSource: session.threadSource,
    },
    rolloutPath,
    rolloutFingerprint: rolloutPath ? await fileFingerprint(rolloutPath) : null,
    stateDbPath: registry.stateDbPath,
    sqliteRow: threadState.row,
    indexPath: indexState.indexPath,
    indexSourceHash: indexState.sourceHash,
    indexRows: indexState.matchingRows,
    historicalBackupFiles,
    permanentBackupDeletion: historicalBackupFiles.length > 0,
    childThreadCount: threadState.childThreadCount,
    codexProcessCheck,
    codexRunning: codexProcessCheck.processes.length > 0,
    blockedByRunningCodex: false,
    targetSessionLock,
    blockedByActiveTarget,
    refreshCodexAfterApply: codexProcessCheck.processes.length > 0,
    deletionBackupRoot: deletionBackupRoot(codexHome, options),
    summary: {
      rolloutFiles: Number(Boolean(rolloutPath)),
      sqliteRows: Number(Boolean(threadState.row)),
      indexRows: indexState.matchingRows,
      childThreadsKept: threadState.childThreadCount,
      historicalBackupFiles: historicalBackupFiles.length,
    },
    canApply: (actionCount > 0 || historicalBackupFiles.length > 0) && !blockedByActiveTarget,
  };
  return { ...plan, planToken: planTokenFor(plan) };
}

function removeIndexRows(source, sessionId) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(source);
  const kept = source.split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    try {
      return extractIndexSessionId(JSON.parse(line)) !== sessionId;
    } catch {
      return true;
    }
  });
  return kept.join(newline) + (trailingNewline && kept.length ? newline : '');
}

async function createDeletionBackup(codexHome, preview, now, options) {
  const timestamp = now.toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
  const backupDir = path.join(preview.deletionBackupRoot, `${timestamp}-${preview.session.id}`);
  await mkdir(backupDir, { recursive: true });
  let rolloutBackup = null;
  let indexBackup = null;
  let stateDbBackup = null;

  if (preview.rolloutPath) {
    rolloutBackup = path.join(backupDir, path.basename(preview.rolloutPath));
    await copyFile(preview.rolloutPath, rolloutBackup);
  }
  if (preview.indexRows > 0) {
    indexBackup = path.join(backupDir, 'session_index.jsonl');
    await copyFile(preview.indexPath, indexBackup);
  }
  if (preview.sqliteRow) {
    const sqlite = await loadSqlite();
    stateDbBackup = path.join(backupDir, path.basename(preview.stateDbPath));
    const sourceDb = new sqlite.DatabaseSync(preview.stateDbPath, { readOnly: true });
    try {
      sourceDb.exec('PRAGMA busy_timeout=2000');
      await sqlite.backup(sourceDb, stateDbBackup);
    } finally {
      sourceDb.close();
    }
  }
  const threadHistory = await prepareThreadHistoryMutation(
    codexHome,
    [preview.session.id],
    backupDir,
    options,
  );

  const manifestPath = path.join(backupDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    createdAt: now.toISOString(),
    session: preview.session,
    rolloutPath: preview.rolloutPath,
    rolloutBackup,
    stateDbPath: preview.stateDbPath,
    stateDbBackup,
    sqliteRow: preview.sqliteRow,
    indexPath: preview.indexPath,
    indexBackup,
    threadHistoryBackup: threadHistory.backup,
    childThreadsKept: preview.childThreadCount,
    planToken: preview.planToken,
  }, null, 2), 'utf8');
  return { backupDir, manifestPath, rolloutBackup, stateDbBackup, indexBackup, threadHistory };
}

export async function applySessionDeletion(codexHome, options = {}) {
  const preview = await previewSessionDeletion(codexHome, options);
  if (!options.sessionLocksHeld) {
    return withTargetSessionLocks(codexHome, [preview.session.id], {
      ...options,
      errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
    }, () => applySessionDeletion(codexHome, { ...options, sessionLocksHeld: true }));
  }
  if (typeof options.planToken !== 'string' || options.planToken !== preview.planToken) {
    throw new CleanerError(
      'STALE_SESSION_DELETE_PLAN',
      'The session changed after deletion preview. Refresh the preview and try again.',
      409,
    );
  }
  if (!preview.canApply) {
    throw new CleanerError('SESSION_NOT_DELETABLE', 'No live Codex session data was found to delete.', 422);
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const backup = preview.permanentBackupDeletion ? null : await createDeletionBackup(codexHome, preview, now, options);
  let rolloutRemoved = false;
  let indexChanged = false;
  let db;
  let transactionStarted = false;
  const removedHistoricalBackups = [];
  try {
    if (preview.rolloutPath) {
      await unlink(preview.rolloutPath);
      rolloutRemoved = true;
    }
    if (preview.indexRows > 0) {
      const currentIndex = await readFile(preview.indexPath, 'utf8');
      const currentHash = createHash('sha256').update(currentIndex).digest('hex');
      if (currentHash !== preview.indexSourceHash) {
        throw new CleanerError(
          'STALE_SESSION_DELETE_PLAN',
          'The legacy session index changed after preview.',
          409,
        );
      }
      await writeFileAtomically(preview.indexPath, removeIndexRows(currentIndex, preview.session.id));
      indexChanged = true;
    }
    for (const historical of preview.historicalBackupFiles) {
      await unlink(historical.path);
      removedHistoricalBackups.push(historical.path);
    }
    if (preview.sqliteRow) {
      const sqlite = await loadSqlite();
      db = new sqlite.DatabaseSync(preview.stateDbPath);
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = db.prepare('DELETE FROM threads WHERE id = ?').run(preview.session.id);
      if (Number(result.changes) !== 1) {
        throw new CleanerError(
          'SQLITE_THREAD_NOT_FOUND',
          'The selected SQLite thread changed after preview.',
          409,
        );
      }
    }
    const historyInvalidation = await invalidateThreadHistory(codexHome, [preview.session.id], options);
    if (transactionStarted) {
      db.exec('COMMIT');
      transactionStarted = false;
    }
    return {
      preview,
      backup,
      deleted: {
        rolloutFiles: Number(rolloutRemoved),
        sqliteRows: Number(Boolean(preview.sqliteRow)),
        indexRows: preview.indexRows,
        historicalBackupFiles: removedHistoricalBackups.length,
      },
      childThreadsKept: preview.childThreadCount,
      codexRefreshRecommended: preview.codexRunning,
      threadHistory: { ...backup?.threadHistory, invalidation: historyInvalidation },
    };
  } catch (error) {
    if (transactionStarted) {
      try { db?.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    const rollbackErrors = [];
    if (rolloutRemoved && backup?.rolloutBackup) {
      try { await copyFile(backup.rolloutBackup, preview.rolloutPath); } catch (rollbackError) {
        rollbackErrors.push({ target: preview.rolloutPath, message: rollbackError.message });
      }
    }
    if (indexChanged && backup?.indexBackup) {
      try { await copyFile(backup.indexBackup, preview.indexPath); } catch (rollbackError) {
        rollbackErrors.push({ target: preview.indexPath, message: rollbackError.message });
      }
    }
    if (error instanceof CleanerError) {
      error.details = {
        ...error.details,
        backupDir: backup?.backupDir || null,
        removedHistoricalBackups,
        rollbackErrors,
      };
      throw error;
    }
    throw new CleanerError(
      'SESSION_DELETE_FAILED',
      'Deleting the whole session failed. File changes were rolled back where possible.',
      500,
      {
        cause: error.message,
        backupDir: backup?.backupDir || null,
        removedHistoricalBackups,
        rollbackErrors,
      },
    );
  } finally {
    db?.close();
  }
}

function requireSessionIds(value) {
  if (!Array.isArray(value)) {
    throw new CleanerError('MISSING_SESSIONS', 'Select one or more sessions before batch deletion.', 400);
  }
  const ids = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  if (!ids.length) {
    throw new CleanerError('MISSING_SESSIONS', 'Select one or more sessions before batch deletion.', 400);
  }
  if (ids.length > 500) {
    throw new CleanerError('TOO_MANY_SESSIONS', 'Delete at most 500 sessions in one batch.', 400);
  }
  return ids;
}

async function readBatchThreadState(dbPath, sessionIds) {
  if (!dbPath) return { rowsById: new Map(), childCounts: new Map() };
  const sqlite = await loadSqlite();
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout=2000');
    const allRows = db.prepare('SELECT * FROM threads').all();
    const selected = new Set(sessionIds);
    const rowsById = new Map();
    const childCounts = new Map(sessionIds.map((id) => [id, 0]));
    for (const row of allRows) {
      if (selected.has(row.id)) rowsById.set(row.id, jsonSafeRow(row));
      if (typeof row.source !== 'string') continue;
      try {
        const source = JSON.parse(row.source);
        const parentId = source?.subagent?.thread_spawn?.parent_thread_id;
        if (childCounts.has(parentId) && !selected.has(row.id)) {
          childCounts.set(parentId, childCounts.get(parentId) + 1);
        }
      } catch {
        // Plain source values are not child-thread metadata.
      }
    }
    return { rowsById, childCounts };
  } finally {
    db?.close();
  }
}

async function readBatchIndexState(codexHome, sessionIds) {
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  let source;
  try {
    source = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { indexPath, source: '', sourceHash: null, counts: new Map() };
    }
    throw error;
  }
  const selected = new Set(sessionIds);
  const counts = new Map(sessionIds.map((id) => [id, 0]));
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const id = extractIndexSessionId(JSON.parse(line));
      if (selected.has(id)) counts.set(id, counts.get(id) + 1);
    } catch {
      // Malformed unrelated rows are preserved.
    }
  }
  return {
    indexPath,
    source,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    counts,
  };
}

function batchPlanTokenFor(plan) {
  return createHash('sha256').update(JSON.stringify({
    sessions: plan.sessions.map((session) => ({
      id: session.id,
      rolloutPath: session.rolloutPath,
      rolloutFingerprint: session.rolloutFingerprint,
      sqliteRow: session.sqliteRow,
      indexRows: session.indexRows,
      historicalBackupFiles: session.historicalBackupFiles,
    })),
    stateDbPath: plan.stateDbPath,
    indexSourceHash: plan.indexSourceHash,
  })).digest('hex');
}

export async function previewSessionDeletionBatch(codexHome, options = {}) {
  const sessionIds = requireSessionIds(options.sessionIds);
  const [registry, codexProcessCheck, indexState] = await Promise.all([
    buildSessionRegistry(codexHome, options),
    resolveProcessCheck(options),
    readBatchIndexState(codexHome, sessionIds),
  ]);
  const registryById = new Map(registry.sessions.map((session) => [session.id, session]));
  const missingIds = sessionIds.filter((id) => !registryById.has(id));
  if (missingIds.length) {
    throw new CleanerError(
      'SESSION_NOT_FOUND',
      'One or more selected sessions were not found.',
      404,
      { sessionIds: missingIds },
    );
  }
  const threadState = await readBatchThreadState(registry.stateDbPath, sessionIds);
  const sessions = await Promise.all(sessionIds.map(async (id) => {
    const session = registryById.get(id);
    const rolloutPath = session.hasRollout ? session.rolloutPath : null;
    if (rolloutPath && !isInsideSessionRoots(codexHome, rolloutPath)) {
      throw new CleanerError(
        'UNSAFE_ROLLOUT_PATH',
        'A selected rollout is outside the current Codex session directories.',
        422,
        { sessionId: id, rolloutPath },
      );
    }
    if (rolloutPath) {
      const metadata = await readRolloutMetadata(rolloutPath);
      if (metadata.id !== id) {
        throw new CleanerError(
          'ROLLOUT_SESSION_MISMATCH',
          'A selected rollout does not match its session ID.',
          422,
          { expectedId: id, actualId: metadata.id, rolloutPath },
        );
      }
    }
    const historicalBackupFiles = await managedHistoricalBackupFiles(session, registry.backupRoot);
    return {
      id,
      title: session.title,
      projectPath: session.projectPath,
      storageStatus: session.storageStatus,
      archived: session.archived,
      threadSource: session.threadSource,
      rolloutPath,
      rolloutFingerprint: rolloutPath ? await fileFingerprint(rolloutPath) : null,
      sqliteRow: threadState.rowsById.get(id) || null,
      indexRows: indexState.counts.get(id) || 0,
      childThreadsKept: threadState.childCounts.get(id) || 0,
      historicalBackupFiles,
    };
  }));
  const undeletable = sessions.filter((session) => (
    !session.rolloutPath
    && !session.sqliteRow
    && !session.indexRows
    && !session.historicalBackupFiles.length
  ));
  if (undeletable.length) {
    throw new CleanerError(
      'SESSION_NOT_DELETABLE',
      '所选条目中包含仅存在于历史备份的会话，无法作为 Codex 当前会话删除。请取消选择“仅备份”条目。',
      422,
      { sessionIds: undeletable.map((session) => session.id) },
    );
  }
  const summary = {
    sessions: sessions.length,
    rolloutFiles: sessions.filter((session) => session.rolloutPath).length,
    sqliteRows: sessions.filter((session) => session.sqliteRow).length,
    indexRows: sessions.reduce((total, session) => total + session.indexRows, 0),
    metadataOnly: sessions.filter((session) => !session.rolloutPath && session.sqliteRow).length,
    childThreadsKept: sessions.reduce((total, session) => total + session.childThreadsKept, 0),
    historicalBackupFiles: sessions.reduce((total, session) => total + session.historicalBackupFiles.length, 0),
    backupOnlySessions: sessions.filter((session) => session.historicalBackupFiles.length > 0).length,
  };
  const targetSessionLock = options.sessionLocksHeld
    ? { available: true, sessions: [], activeSessionIds: [], heldByCleaner: true }
    : await inspectTargetSessionLocks(codexHome, sessionIds, options);
  const blockedByActiveTarget = targetSessionLock.activeSessionIds.length > 0;
  const plan = {
    sessions,
    summary,
    stateDbPath: registry.stateDbPath,
    indexPath: indexState.indexPath,
    indexSourceHash: indexState.sourceHash,
    codexProcessCheck,
    codexRunning: codexProcessCheck.processes.length > 0,
    blockedByRunningCodex: false,
    targetSessionLock,
    blockedByActiveTarget,
    refreshCodexAfterApply: codexProcessCheck.processes.length > 0,
    deletionBackupRoot: deletionBackupRoot(codexHome, options),
    canApply: sessions.length > 0 && !blockedByActiveTarget,
  };
  return { ...plan, planToken: batchPlanTokenFor(plan) };
}

function removeBatchIndexRows(source, sessionIds) {
  const selected = new Set(sessionIds);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(source);
  const kept = source.split(/\r?\n/).filter((line) => {
    if (!line.trim()) return false;
    try {
      return !selected.has(extractIndexSessionId(JSON.parse(line)));
    } catch {
      return true;
    }
  });
  return kept.join(newline) + (trailingNewline && kept.length ? newline : '');
}

async function createBatchDeletionBackup(codexHome, preview, now, options) {
  const timestamp = now.toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
  const backupDir = path.join(
    preview.deletionBackupRoot,
    `batch-${timestamp}-${preview.sessions.length}-sessions`,
  );
  const rolloutDir = path.join(backupDir, 'rollouts');
  await mkdir(rolloutDir, { recursive: true });
  const rolloutBackups = [];
  for (const session of preview.sessions) {
    if (!session.rolloutPath) continue;
    const backupPath = path.join(rolloutDir, `${session.id}-${path.basename(session.rolloutPath)}`);
    await copyFile(session.rolloutPath, backupPath);
    rolloutBackups.push({ id: session.id, source: session.rolloutPath, backup: backupPath });
  }
  let indexBackup = null;
  if (preview.summary.indexRows > 0) {
    indexBackup = path.join(backupDir, 'session_index.jsonl');
    await copyFile(preview.indexPath, indexBackup);
  }
  let stateDbBackup = null;
  if (preview.summary.sqliteRows > 0) {
    const sqlite = await loadSqlite();
    stateDbBackup = path.join(backupDir, path.basename(preview.stateDbPath));
    const sourceDb = new sqlite.DatabaseSync(preview.stateDbPath, { readOnly: true });
    try {
      sourceDb.exec('PRAGMA busy_timeout=2000');
      await sqlite.backup(sourceDb, stateDbBackup);
    } finally {
      sourceDb.close();
    }
  }
  const threadHistory = await prepareThreadHistoryMutation(
    codexHome,
    preview.sessions.map((session) => session.id),
    backupDir,
    options,
  );
  const manifestPath = path.join(backupDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    createdAt: now.toISOString(),
    kind: 'batch-session-delete',
    sessions: preview.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      projectPath: session.projectPath,
      storageStatus: session.storageStatus,
      rolloutPath: session.rolloutPath,
      sqliteRow: session.sqliteRow,
      indexRows: session.indexRows,
      childThreadsKept: session.childThreadsKept,
      historicalBackupFiles: session.historicalBackupFiles,
    })),
    rolloutBackups,
    stateDbPath: preview.stateDbPath,
    stateDbBackup,
    indexPath: preview.indexPath,
    indexBackup,
    threadHistoryBackup: threadHistory.backup,
    planToken: preview.planToken,
  }, null, 2), 'utf8');
  return { backupDir, manifestPath, rolloutBackups, stateDbBackup, indexBackup, threadHistory };
}

export async function applySessionDeletionBatch(codexHome, options = {}) {
  const preview = await previewSessionDeletionBatch(codexHome, options);
  if (!options.sessionLocksHeld) {
    return withTargetSessionLocks(codexHome, preview.sessions.map((session) => session.id), {
      ...options,
      errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
    }, () => applySessionDeletionBatch(codexHome, { ...options, sessionLocksHeld: true }));
  }
  if (typeof options.planToken !== 'string' || options.planToken !== preview.planToken) {
    throw new CleanerError(
      'STALE_SESSION_DELETE_PLAN',
      'The selected sessions changed after batch preview. Refresh and try again.',
      409,
    );
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const hasRecoverableDeletion = preview.summary.rolloutFiles > 0
    || preview.summary.sqliteRows > 0
    || preview.summary.indexRows > 0;
  const backup = hasRecoverableDeletion
    ? await createBatchDeletionBackup(codexHome, preview, now, options)
    : null;
  const backupById = new Map((backup?.rolloutBackups || []).map((item) => [item.id, item.backup]));
  const removedRollouts = [];
  let indexChanged = false;
  let db;
  let transactionStarted = false;
  const removedHistoricalBackups = [];
  try {
    for (const session of preview.sessions) {
      if (!session.rolloutPath) continue;
      await unlink(session.rolloutPath);
      removedRollouts.push(session);
    }
    if (preview.summary.indexRows > 0) {
      const currentIndex = await readFile(preview.indexPath, 'utf8');
      const currentHash = createHash('sha256').update(currentIndex).digest('hex');
      if (currentHash !== preview.indexSourceHash) {
        throw new CleanerError('STALE_SESSION_DELETE_PLAN', 'The legacy index changed after preview.', 409);
      }
      await writeFileAtomically(
        preview.indexPath,
        removeBatchIndexRows(currentIndex, preview.sessions.map((session) => session.id)),
      );
      indexChanged = true;
    }
    for (const session of preview.sessions) {
      for (const historical of session.historicalBackupFiles) {
        await unlink(historical.path);
        removedHistoricalBackups.push(historical.path);
      }
    }
    const sqliteSessions = preview.sessions.filter((session) => session.sqliteRow);
    if (sqliteSessions.length) {
      const sqlite = await loadSqlite();
      db = new sqlite.DatabaseSync(preview.stateDbPath);
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const statement = db.prepare('DELETE FROM threads WHERE id = ?');
      for (const session of sqliteSessions) {
        const result = statement.run(session.id);
        if (Number(result.changes) !== 1) {
          throw new CleanerError(
            'SQLITE_THREAD_NOT_FOUND',
            'A selected SQLite thread changed after preview.',
            409,
            { sessionId: session.id },
          );
        }
      }
    }
    const historyInvalidation = await invalidateThreadHistory(
      codexHome,
      preview.sessions.map((session) => session.id),
      options,
    );
    if (transactionStarted) {
      db.exec('COMMIT');
      transactionStarted = false;
    }
    return {
      preview,
      backup,
      deleted: {
        ...preview.summary,
        historicalBackupFiles: removedHistoricalBackups.length,
      },
      codexRefreshRecommended: preview.codexRunning,
      threadHistory: { ...backup?.threadHistory, invalidation: historyInvalidation },
    };
  } catch (error) {
    if (transactionStarted) {
      try { db?.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    const rollbackErrors = [];
    for (const session of removedRollouts) {
      try {
        await copyFile(backupById.get(session.id), session.rolloutPath);
      } catch (rollbackError) {
        rollbackErrors.push({ target: session.rolloutPath, message: rollbackError.message });
      }
    }
    if (indexChanged && backup?.indexBackup) {
      try { await copyFile(backup.indexBackup, preview.indexPath); } catch (rollbackError) {
        rollbackErrors.push({ target: preview.indexPath, message: rollbackError.message });
      }
    }
    if (error instanceof CleanerError) {
      error.details = {
        ...error.details,
        backupDir: backup?.backupDir || null,
        removedHistoricalBackups,
        rollbackErrors,
      };
      throw error;
    }
    throw new CleanerError(
      'SESSION_BATCH_DELETE_FAILED',
      'Batch deletion failed. File changes were rolled back where possible.',
      500,
      {
        cause: error.message,
        backupDir: backup?.backupDir || null,
        removedHistoricalBackups,
        rollbackErrors,
      },
    );
  } finally {
    db?.close();
  }
}

async function directorySize(root) {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(fullPath);
    else total += (await lstat(fullPath)).size;
  }
  return total;
}

export async function listSessionDeletionBackups(codexHome, options = {}) {
  const root = deletionBackupRoot(codexHome, options);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { root, backups: [], summary: { count: 0, sizeBytes: 0 } };
    throw error;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const backupDir = path.join(root, entry.name);
    const manifestPath = path.join(backupDir, 'manifest.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const sessions = Array.isArray(manifest.sessions)
        ? manifest.sessions
        : (manifest.session ? [manifest.session] : []);
      const legacyTitles = new Map();
      if (manifest.indexBackup) {
        const indexBackup = requirePathInside(backupDir, manifest.indexBackup, 'index backup');
        const indexSource = await readFile(indexBackup, 'utf8');
        for (const line of indexSource.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line);
            const id = extractIndexSessionId(row);
            if (id && row.thread_name) legacyTitles.set(id, row.thread_name);
          } catch {
            // Ignore malformed historical index rows.
          }
        }
      }
      backups.push({
        id: entry.name,
        backupDir,
        createdAt: manifest.createdAt || null,
        sessions: sessions.map((session) => ({
          id: session.id,
          title: legacyTitles.get(session.id) || session.title || '(untitled)',
          projectPath: session.projectPath || null,
        })),
        sizeBytes: await directorySize(backupDir),
      });
    } catch {
      // Ignore incomplete directories that do not contain a valid deletion manifest.
    }
  }
  backups.sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
  return {
    root,
    backups,
    summary: {
      count: backups.length,
      sizeBytes: backups.reduce((total, backup) => total + backup.sizeBytes, 0),
    },
  };
}

function safeBackupTarget(root, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new CleanerError('INVALID_BACKUP_ID', 'Invalid deletion-backup identifier.', 400, { id });
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(root, id);
  if (target === resolvedRoot || path.dirname(target) !== resolvedRoot) {
    throw new CleanerError('INVALID_BACKUP_PATH', 'Deletion-backup path escaped its root.', 400, { id });
  }
  return target;
}

export async function deleteSessionDeletionBackups(codexHome, options = {}) {
  const ids = [...new Set((options.backupIds || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!ids.length) {
    throw new CleanerError('MISSING_BACKUPS', 'Select one or more deletion backups.', 400);
  }
  const listed = await listSessionDeletionBackups(codexHome, options);
  const available = new Map(listed.backups.map((backup) => [backup.id, backup]));
  const missingIds = ids.filter((id) => !available.has(id));
  if (missingIds.length) {
    throw new CleanerError('BACKUP_NOT_FOUND', 'One or more deletion backups were not found.', 404, {
      backupIds: missingIds,
    });
  }
  const deleted = [];
  for (const id of ids) {
    const target = safeBackupTarget(listed.root, id);
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CleanerError('UNSAFE_BACKUP_TARGET', 'Refusing to recursively delete an unsafe target.', 422, {
        backupId: id,
      });
    }
    await rm(target, { recursive: true, force: false });
    deleted.push({
      id,
      sizeBytes: available.get(id).sizeBytes,
      sessions: available.get(id).sessions,
    });
  }
  return {
    root: listed.root,
    deleted,
    deletedCount: deleted.length,
    freedBytes: deleted.reduce((total, backup) => total + backup.sizeBytes, 0),
  };
}

function requirePathInside(root, candidate, label) {
  if (!candidate) return null;
  const rootKey = normalizePathKey(root);
  const candidateKey = normalizePathKey(candidate);
  if (!candidateKey.startsWith(`${rootKey}${path.sep}`)) {
    throw new CleanerError(
      'UNSAFE_BACKUP_CONTENT',
      `A deletion backup contains an unsafe ${label} path.`,
      422,
      { root, candidate },
    );
  }
  return path.resolve(candidate);
}

async function readDeletionBackup(codexHome, backupId, options) {
  const listed = await listSessionDeletionBackups(codexHome, options);
  if (!listed.backups.some((backup) => backup.id === backupId)) {
    throw new CleanerError('BACKUP_NOT_FOUND', 'The selected deletion backup was not found.', 404, {
      backupId,
    });
  }
  const backupDir = safeBackupTarget(listed.root, backupId);
  const manifestPath = path.join(backupDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sessions = Array.isArray(manifest.sessions)
    ? manifest.sessions
    : (manifest.session ? [{
      ...manifest.session,
      rolloutPath: manifest.rolloutPath || manifest.session.rolloutPath || null,
      sqliteRow: manifest.sqliteRow || manifest.session.sqliteRow || null,
      indexRows: manifest.indexRows ?? manifest.session.indexRows ?? 0,
    }] : []);
  const rolloutBackups = Array.isArray(manifest.rolloutBackups)
    ? manifest.rolloutBackups
    : (manifest.rolloutBackup && manifest.session
      ? [{ id: manifest.session.id, source: manifest.rolloutPath, backup: manifest.rolloutBackup }]
      : []);
  const rolloutById = new Map();
  for (const item of rolloutBackups) {
    rolloutById.set(item.id, {
      ...item,
      backup: requirePathInside(backupDir, item.backup, 'rollout backup'),
    });
  }
  return {
    backupId,
    backupDir,
    manifestPath,
    manifest,
    sessions,
    rolloutById,
    indexBackup: requirePathInside(backupDir, manifest.indexBackup, 'index backup'),
  };
}

export async function readSessionDeletionBackupContent(codexHome, options = {}) {
  const backupId = String(options.backupId || '').trim();
  const sessionId = String(options.sessionId || '').trim();
  if (!backupId || !sessionId) {
    throw new CleanerError('MISSING_BACKUP_SESSION', 'Select a backup session before viewing its content.', 400);
  }
  const backup = await readDeletionBackup(codexHome, backupId, options);
  const manifestSession = backup.sessions.find((session) => session.id === sessionId);
  if (!manifestSession) {
    throw new CleanerError('BACKUP_SESSION_NOT_FOUND', 'The selected session is not contained in this backup.', 404, { sessionId });
  }
  const rolloutBackup = backup.rolloutById.get(sessionId) || null;
  if (!rolloutBackup?.backup) {
    return {
      backupId,
      session: {
        id: sessionId,
        title: manifestSession.title || manifestSession.sqliteRow?.title || '(untitled)',
        projectPath: manifestSession.projectPath || manifestSession.sqliteRow?.cwd || null,
      },
      contentAvailable: false,
      unavailableReason: '该备份只有 SQLite 或索引元数据，没有可读取的 rollout 正文。',
      comparison: { state: 'metadata_only', label: '仅元数据', currentExists: false },
      content: null,
    };
  }

  const backupSource = await readFile(rolloutBackup.backup, 'utf8');
  const records = parseJsonl(backupSource, rolloutBackup.backup);
  const metadata = await readRolloutMetadata(rolloutBackup.backup);
  if (metadata.id !== sessionId) {
    throw new CleanerError('BACKUP_SESSION_MISMATCH', 'The rollout backup does not match the selected session ID.', 422, {
      expectedId: sessionId,
      actualId: metadata.id,
    });
  }
  const backupFingerprint = await fileFingerprint(rolloutBackup.backup);
  const rolloutTarget = manifestSession.rolloutPath || rolloutBackup.source || null;
  if (rolloutTarget && !isInsideSessionRoots(codexHome, rolloutTarget)) {
    throw new CleanerError('UNSAFE_RESTORE_PATH', 'The backed-up rollout target is outside Codex session storage.', 422, { rolloutTarget });
  }
  let currentFingerprint = null;
  let currentSummary = null;
  if (rolloutTarget) {
    try {
      currentFingerprint = await fileFingerprint(rolloutTarget);
      try {
        const currentRecords = parseJsonl(await readFile(rolloutTarget, 'utf8'), rolloutTarget);
        const current = buildCompactConversationPreview(currentRecords, { offset: 0, limit: 1 });
        currentSummary = {
          recordCount: current.recordCount,
          turnCount: current.turnCount,
          messageCount: current.messageCount,
        };
      } catch (error) {
        currentSummary = { parseError: error.message };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const identical = Boolean(currentFingerprint && currentFingerprint.sha256 === backupFingerprint.sha256);
  const comparison = currentFingerprint
    ? (identical
      ? { state: 'identical', label: '当前内容与备份一致', currentExists: true }
      : { state: 'different', label: '当前正文与备份不同，删除备份恢复会拒绝覆盖', currentExists: true })
    : { state: 'missing', label: '当前正文缺失，可从此备份恢复', currentExists: false };

  return {
    backupId,
    createdAt: backup.manifest.createdAt || null,
    session: {
      id: sessionId,
      title: manifestSession.title || metadata.summary || '(untitled)',
      projectPath: manifestSession.projectPath || metadata.projectPath || null,
    },
    provider: { backup: metadata.modelProvider || null },
    contentAvailable: true,
    comparison: { ...comparison, current: currentSummary },
    content: buildCompactConversationPreview(records, options),
  };
}

async function readBackupIndexRows(backup, sessionIds) {
  if (!backup.indexBackup) return new Map();
  const selected = new Set(sessionIds);
  const rows = new Map();
  const source = await readFile(backup.indexBackup, 'utf8');
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      const id = extractIndexSessionId(data);
      if (selected.has(id) && !rows.has(id)) rows.set(id, data);
    } catch {
      // Ignore malformed rows in the historical index backup.
    }
  }
  return rows;
}

function isoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  }
  if (typeof value === 'string' && value) return value;
  return new Date().toISOString();
}

function restoreIndexRow(session, backupIndexRow) {
  if (backupIndexRow) return backupIndexRow;
  return {
    id: session.id,
    thread_name: session.title || session.sqliteRow?.title || '(untitled)',
    updated_at: isoTimestamp(session.sqliteRow?.updated_at || session.sqliteRow?.created_at),
  };
}

function restorePlanTokenFor(plan) {
  return createHash('sha256').update(JSON.stringify({
    backupId: plan.backupId,
    currentProvider: plan.currentProvider,
    stateDbPath: plan.stateDbPath,
    indexSourceHash: plan.indexSourceHash,
    sessions: plan.sessions.map((session) => ({
      id: session.id,
      rolloutTarget: session.rolloutTarget,
      rolloutBackupFingerprint: session.rolloutBackupFingerprint,
      rolloutCurrentFingerprint: session.rolloutCurrentFingerprint,
      rolloutAction: session.rolloutAction,
      sqliteAction: session.sqliteAction,
      indexAction: session.indexAction,
      sqliteRow: session.sqliteRow,
      indexRow: session.indexRow,
    })),
  })).digest('hex');
}

export async function previewSessionDeletionBackupRestore(codexHome, options = {}) {
  const backupId = String(options.backupId || '').trim();
  if (!backupId) {
    throw new CleanerError('MISSING_BACKUP', 'Select a deletion backup before restoring.', 400);
  }
  const sessionIds = requireSessionIds(options.sessionIds);
  const [backup, registry, codexProcessCheck, indexState] = await Promise.all([
    readDeletionBackup(codexHome, backupId, options),
    buildSessionRegistry(codexHome, options),
    resolveProcessCheck(options),
    readBatchIndexState(codexHome, sessionIds),
  ]);
  const manifestById = new Map(backup.sessions.map((session) => [session.id, session]));
  const missingIds = sessionIds.filter((id) => !manifestById.has(id));
  if (missingIds.length) {
    throw new CleanerError(
      'BACKUP_SESSION_NOT_FOUND',
      'One or more selected sessions are not contained in this backup.',
      404,
      { sessionIds: missingIds },
    );
  }
  const [threadState, backupIndexRows] = await Promise.all([
    readBatchThreadState(registry.stateDbPath, sessionIds),
    readBackupIndexRows(backup, sessionIds),
  ]);
  const sessions = [];
  for (const id of sessionIds) {
    const manifestSession = manifestById.get(id);
    const rolloutBackup = backup.rolloutById.get(id) || null;
    const rolloutTarget = manifestSession.rolloutPath || rolloutBackup?.source || null;
    if (rolloutTarget && !isInsideSessionRoots(codexHome, rolloutTarget)) {
      throw new CleanerError(
        'UNSAFE_RESTORE_PATH',
        'A backed-up session points outside the current Codex session directories.',
        422,
        { sessionId: id, rolloutTarget },
      );
    }
    let rolloutBackupFingerprint = null;
    let rolloutCurrentFingerprint = null;
    let rolloutAction = 'none';
    let rolloutConflict = false;
    if (rolloutBackup?.backup) {
      const metadata = await readRolloutMetadata(rolloutBackup.backup);
      if (metadata.id !== id) {
        throw new CleanerError(
          'BACKUP_SESSION_MISMATCH',
          'A rollout backup does not match its manifest session ID.',
          422,
          { expectedId: id, actualId: metadata.id },
        );
      }
      rolloutBackupFingerprint = await fileFingerprint(rolloutBackup.backup);
      try {
        rolloutCurrentFingerprint = await fileFingerprint(rolloutTarget);
        if (rolloutCurrentFingerprint.sha256 !== rolloutBackupFingerprint.sha256) {
          rolloutConflict = true;
          rolloutAction = 'conflict';
        } else {
          rolloutAction = 'already_present';
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        rolloutAction = 'restore';
      }
    }
    const sqliteRow = manifestSession.sqliteRow || null;
    const currentSqliteRow = threadState.rowsById.get(id) || null;
    const sqliteAction = sqliteRow
      ? (currentSqliteRow ? 'already_present' : 'insert')
      : 'none';
    const indexRow = restoreIndexRow({
      ...manifestSession,
      title: backupIndexRows.get(id)?.thread_name || manifestSession.title,
    }, backupIndexRows.get(id));
    const indexAction = (indexState.counts.get(id) || 0) > 0 ? 'already_present' : 'insert';
    sessions.push({
      id,
      title: indexRow.thread_name || manifestSession.title || id,
      projectPath: manifestSession.projectPath || sqliteRow?.cwd || null,
      archived: Boolean(manifestSession.archived ?? sqliteRow?.archived),
      rolloutBackup: rolloutBackup?.backup || null,
      rolloutTarget,
      rolloutBackupFingerprint,
      rolloutCurrentFingerprint,
      rolloutAction,
      rolloutConflict,
      sqliteRow,
      currentSqliteRow,
      sqliteAction,
      indexRow,
      indexAction,
    });
  }
  const summary = {
    sessions: sessions.length,
    rolloutFiles: sessions.filter((session) => session.rolloutAction === 'restore').length,
    sqliteRows: sessions.filter((session) => session.sqliteAction === 'insert').length,
    indexRows: sessions.filter((session) => session.indexAction === 'insert').length,
    conflicts: sessions.filter((session) => session.rolloutConflict).length,
    alreadyPresent: sessions.filter((session) => (
      session.rolloutAction === 'already_present'
      && session.sqliteAction !== 'insert'
      && session.indexAction !== 'insert'
    )).length,
  };
  const actionCount = summary.rolloutFiles + summary.sqliteRows + summary.indexRows;
  const targetSessionLock = options.sessionLocksHeld
    ? { available: true, sessions: [], activeSessionIds: [], heldByCleaner: true }
    : await inspectTargetSessionLocks(codexHome, sessionIds, options);
  const blockedByActiveTarget = targetSessionLock.activeSessionIds.length > 0;
  const plan = {
    backupId,
    backupDir: backup.backupDir,
    currentProvider: registry.currentProvider,
    stateDbPath: registry.stateDbPath,
    indexPath: indexState.indexPath,
    indexSourceHash: indexState.sourceHash,
    codexProcessCheck,
    codexRunning: codexProcessCheck.processes.length > 0,
    blockedByRunningCodex: false,
    targetSessionLock,
    blockedByActiveTarget,
    refreshCodexAfterApply: codexProcessCheck.processes.length > 0,
    sessions,
    summary,
    canApply: actionCount > 0
      && summary.conflicts === 0
      && !blockedByActiveTarget,
  };
  return { ...plan, planToken: restorePlanTokenFor(plan) };
}

async function rewriteRestoredRolloutProvider(filePath, sessionId, provider) {
  const source = await readFile(filePath, 'utf8');
  const records = parseJsonl(source, filePath);
  const recordIndex = records.findIndex((record) => (
    record.data?.type === 'session_meta'
    && (record.data?.payload?.id === sessionId || record.data?.payload?.session_id === sessionId)
  ));
  if (recordIndex < 0) {
    throw new CleanerError('SESSION_META_NOT_FOUND', 'Restored rollout metadata was not found.', 422, {
      sessionId,
      filePath,
    });
  }
  const edited = {
    ...records[recordIndex],
    raw: null,
    data: structuredClone(records[recordIndex].data),
  };
  edited.data.payload = edited.data.payload || {};
  edited.data.payload.model_provider = provider;
  records[recordIndex] = edited;
  await writeFileAtomically(filePath, serializeJsonlPreservingRaw(records, {
    newline: source.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: /\r?\n$/.test(source),
  }));
}

function appendRestoredIndexRows(source, rows) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trimmed = source.replace(/(?:\r?\n)+$/, '');
  const additions = rows.map((row) => JSON.stringify(row)).join(newline);
  return `${trimmed}${trimmed ? newline : ''}${additions}${additions ? newline : ''}`;
}

async function createRestoreSafetyBackup(codexHome, preview, backupRoot, now, options) {
  const timestamp = now.toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
  const safetyDir = path.join(backupRoot, 'restore-points', `restore-${timestamp}-${preview.backupId}`);
  await mkdir(safetyDir, { recursive: true });
  let indexBackup = null;
  try {
    indexBackup = path.join(safetyDir, 'session_index.jsonl');
    await copyFile(preview.indexPath, indexBackup);
  } catch (error) {
    if (error?.code === 'ENOENT') indexBackup = null;
    else throw error;
  }
  let stateDbBackup = null;
  if (preview.stateDbPath) {
    const sqlite = await loadSqlite();
    stateDbBackup = path.join(safetyDir, path.basename(preview.stateDbPath));
    const sourceDb = new sqlite.DatabaseSync(preview.stateDbPath, { readOnly: true });
    try {
      sourceDb.exec('PRAGMA busy_timeout=2000');
      await sqlite.backup(sourceDb, stateDbBackup);
    } finally {
      sourceDb.close();
    }
  }
  const threadHistory = await prepareThreadHistoryMutation(
    codexHome,
    preview.sessions.map((session) => session.id),
    safetyDir,
    options,
  );
  const manifestPath = path.join(safetyDir, 'restore-manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    createdAt: now.toISOString(),
    sourceBackupId: preview.backupId,
    sessionIds: preview.sessions.map((session) => session.id),
    stateDbBackup,
    indexBackup,
    threadHistoryBackup: threadHistory.backup,
    planToken: preview.planToken,
  }, null, 2), 'utf8');
  return { safetyDir, manifestPath, stateDbBackup, indexBackup, threadHistory };
}

function insertSqliteRows(db, sessions, provider) {
  const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((row) => row.name));
  const statementCache = new Map();
  for (const session of sessions) {
    const row = {
      ...session.sqliteRow,
      id: session.id,
      rollout_path: session.rolloutTarget || session.sqliteRow?.rollout_path || null,
      model_provider: provider,
      title: session.sqliteRow?.title || session.title,
      cwd: session.sqliteRow?.cwd || session.projectPath || null,
      archived: session.sqliteRow?.archived ?? Number(session.archived),
    };
    const names = Object.keys(row).filter((name) => columns.has(name));
    if (!names.includes('id')) names.unshift('id');
    const cacheKey = names.join('\u0000');
    let statement = statementCache.get(cacheKey);
    if (!statement) {
      statement = db.prepare(
        `INSERT INTO threads (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
      );
      statementCache.set(cacheKey, statement);
    }
    statement.run(...names.map((name) => row[name] ?? null));
  }
}

export async function applySessionDeletionBackupRestore(codexHome, options = {}) {
  const preview = await previewSessionDeletionBackupRestore(codexHome, options);
  if (!options.sessionLocksHeld) {
    return withTargetSessionLocks(codexHome, preview.sessions.map((session) => session.id), {
      ...options,
      errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
    }, () => applySessionDeletionBackupRestore(codexHome, { ...options, sessionLocksHeld: true }));
  }
  if (preview.summary.conflicts > 0) {
    throw new CleanerError(
      'RESTORE_CONFLICT',
      'A current rollout differs from its deletion backup. Refusing to overwrite it.',
      409,
    );
  }
  if (typeof options.planToken !== 'string' || options.planToken !== preview.planToken) {
    throw new CleanerError(
      'STALE_BACKUP_RESTORE_PLAN',
      'The current Codex state or deletion backup changed after preview.',
      409,
    );
  }
  if (!preview.canApply) {
    throw new CleanerError('BACKUP_ALREADY_RESTORED', 'The selected sessions are already present.', 422);
  }
  const ordinaryBackupRoot = options.backupRoot
    || path.join(codexHome, 'backups', 'codex-turn-cleaner');
  const now = options.now instanceof Date ? options.now : new Date();
  const safety = await createRestoreSafetyBackup(codexHome, preview, ordinaryBackupRoot, now, options);
  const copiedRollouts = [];
  let indexChanged = false;
  let db;
  let transactionStarted = false;
  try {
    for (const session of preview.sessions) {
      if (session.rolloutAction !== 'restore') continue;
      await mkdir(path.dirname(session.rolloutTarget), { recursive: true });
      await copyFile(session.rolloutBackup, session.rolloutTarget);
      copiedRollouts.push(session.rolloutTarget);
      await rewriteRestoredRolloutProvider(
        session.rolloutTarget,
        session.id,
        preview.currentProvider,
      );
    }
    const indexRows = preview.sessions
      .filter((session) => session.indexAction === 'insert')
      .map((session) => session.indexRow);
    if (indexRows.length) {
      let currentIndex = '';
      let currentIndexExists = false;
      try {
        currentIndex = await readFile(preview.indexPath, 'utf8');
        currentIndexExists = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const currentHash = currentIndexExists
        ? createHash('sha256').update(currentIndex).digest('hex')
        : null;
      if (currentHash !== preview.indexSourceHash) {
        throw new CleanerError('STALE_BACKUP_RESTORE_PLAN', 'The legacy index changed after preview.', 409);
      }
      await writeFileAtomically(preview.indexPath, appendRestoredIndexRows(currentIndex, indexRows));
      indexChanged = true;
    }
    const sqliteSessions = preview.sessions.filter((session) => session.sqliteAction === 'insert');
    if (sqliteSessions.length) {
      const sqlite = await loadSqlite();
      db = new sqlite.DatabaseSync(preview.stateDbPath);
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      insertSqliteRows(db, sqliteSessions, preview.currentProvider);
    }
    const historyInvalidation = await invalidateThreadHistory(
      codexHome,
      preview.sessions.map((session) => session.id),
      options,
    );
    if (transactionStarted) {
      db.exec('COMMIT');
      transactionStarted = false;
    }
    return {
      preview,
      safety,
      restored: preview.summary,
      restartRequired: true,
      codexRefreshRecommended: preview.codexRunning,
      threadHistory: { ...safety.threadHistory, invalidation: historyInvalidation },
    };
  } catch (error) {
    if (transactionStarted) {
      try { db?.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    const rollbackErrors = [];
    for (const rolloutPath of copiedRollouts) {
      try { await unlink(rolloutPath); } catch (rollbackError) {
        if (rollbackError?.code !== 'ENOENT') {
          rollbackErrors.push({ target: rolloutPath, message: rollbackError.message });
        }
      }
    }
    if (indexChanged) {
      try {
        if (safety.indexBackup) await copyFile(safety.indexBackup, preview.indexPath);
        else await unlink(preview.indexPath);
      } catch (rollbackError) {
        rollbackErrors.push({ target: preview.indexPath, message: rollbackError.message });
      }
    }
    if (error instanceof CleanerError) {
      error.details = { ...error.details, safetyDir: safety.safetyDir, rollbackErrors };
      throw error;
    }
    throw new CleanerError(
      'BACKUP_RESTORE_FAILED',
      'Restoring deleted sessions failed. New files and index changes were rolled back where possible.',
      500,
      { cause: error.message, safetyDir: safety.safetyDir, rollbackErrors },
    );
  } finally {
    db?.close();
  }
}
