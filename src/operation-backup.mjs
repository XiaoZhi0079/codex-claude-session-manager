import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
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

const SNAPSHOT_KINDS = [
  {
    prefix: 'codex-turn-editor-restore-point-',
    kind: 'message_edit_restore_point',
    label: '编辑撤销安全点',
  },
  {
    prefix: 'codex-turn-editor-',
    kind: 'message_edit',
    label: '消息编辑前快照',
  },
  {
    prefix: 'codex-turn-cleaner-',
    kind: 'turn_cleanup',
    label: '轮次清理前快照',
  },
];

function normalizePathKey(value) {
  let comparable = String(value || '');
  if (process.platform === 'win32') {
    if (/^\\\\\?\\UNC\\/i.test(comparable)) comparable = `\\\\${comparable.slice(8)}`;
    else if (/^\\\\\?\\/i.test(comparable)) comparable = comparable.slice(4);
  }
  const resolved = path.resolve(comparable);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsideRoot(root, candidate) {
  const rootKey = normalizePathKey(root);
  const candidateKey = normalizePathKey(candidate);
  return candidateKey.startsWith(`${rootKey}${path.sep}`);
}

function isInsideSessionRoots(codexHome, candidate) {
  return [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ].some((root) => isInsideRoot(root, candidate));
}

function snapshotKind(directoryName) {
  return SNAPSHOT_KINDS.find((item) => directoryName.startsWith(item.prefix)) || null;
}

function snapshotId(directoryName, fileName) {
  return Buffer.from(`${directoryName}\n${fileName}`, 'utf8').toString('base64url');
}

function parseDirectoryTimestamp(directoryName) {
  const match = directoryName.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(\d{3})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
}

function recordTimestamp(data) {
  return data?.timestamp
    || data?.payload?.timestamp
    || data?.created_at
    || data?.updated_at
    || null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionMetadata(records, fallback) {
  const metaRecord = records.find((record) => record.data?.type === 'session_meta');
  const payload = metaRecord?.data?.payload || metaRecord?.data || {};
  const id = payload.id || payload.session_id || fallback.id || null;
  let latestMs = timestampMs(payload.timestamp || metaRecord?.data?.timestamp);
  for (const record of records) {
    const current = timestampMs(recordTimestamp(record.data));
    if (current !== null && (latestMs === null || current > latestMs)) latestMs = current;
  }
  const createdMs = timestampMs(payload.timestamp || metaRecord?.data?.timestamp) || latestMs || Date.now();
  return {
    id,
    payload,
    createdMs,
    updatedMs: latestMs || createdMs,
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

async function pathFingerprint(filePath) {
  try {
    return await fileFingerprint(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readSnapshot(backupRoot, directory, entry) {
  const kind = snapshotKind(directory.name);
  if (!kind || !entry.isFile() || !entry.name.endsWith('.jsonl')) return null;
  const backupDir = path.join(backupRoot, directory.name);
  const filePath = path.join(backupDir, entry.name);
  if (!isInsideRoot(backupRoot, filePath)) return null;
  const [metadata, info] = await Promise.all([
    readRolloutMetadata(filePath),
    stat(filePath),
  ]);
  if (!metadata.id) return null;
  return {
    id: snapshotId(directory.name, entry.name),
    kind: kind.kind,
    kindLabel: kind.label,
    directoryName: directory.name,
    fileName: entry.name,
    backupDir,
    path: filePath,
    createdAt: parseDirectoryTimestamp(directory.name) || info.birthtime.toISOString(),
    snapshotAt: info.mtime.toISOString(),
    sessionId: metadata.id,
    title: metadata.summary || '(untitled)',
    projectPath: metadata.projectPath || null,
    modelProvider: metadata.modelProvider || null,
    sizeBytes: info.size,
  };
}

export async function listOperationBackups(codexHome, options = {}) {
  const backupRoot = options.backupRoot
    || path.join(codexHome, 'backups', 'codex-turn-cleaner');
  let directories;
  try {
    directories = await readdir(backupRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { root: backupRoot, backups: [], summary: { count: 0, sizeBytes: 0 } };
    }
    throw error;
  }

  const backups = [];
  for (const directory of directories) {
    if (!directory.isDirectory() || !snapshotKind(directory.name)) continue;
    const backupDir = path.join(backupRoot, directory.name);
    const info = await lstat(backupDir);
    if (info.isSymbolicLink()) continue;
    for (const entry of await readdir(backupDir, { withFileTypes: true })) {
      const snapshot = await readSnapshot(backupRoot, directory, entry);
      if (snapshot) backups.push(snapshot);
    }
  }
  backups.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return {
    root: backupRoot,
    backups,
    summary: {
      count: backups.length,
      sizeBytes: backups.reduce((total, backup) => total + backup.sizeBytes, 0),
    },
  };
}

async function requireSnapshot(codexHome, backupId, options) {
  const id = String(backupId || '').trim();
  if (!id) throw new CleanerError('MISSING_OPERATION_BACKUP', 'Select a session snapshot.', 400);
  const listed = await listOperationBackups(codexHome, options);
  const snapshot = listed.backups.find((item) => item.id === id);
  if (!snapshot) {
    throw new CleanerError('OPERATION_BACKUP_NOT_FOUND', 'The selected session snapshot was not found.', 404, {
      backupId: id,
    });
  }
  return { ...snapshot, backupRoot: listed.root };
}

export async function readOperationBackupContent(codexHome, options = {}) {
  const snapshot = await requireSnapshot(codexHome, options.backupId, options);
  const source = await readFile(snapshot.path, 'utf8');
  const records = parseJsonl(source, snapshot.path);
  const preview = await previewOperationBackupRestore(codexHome, options);
  let currentSummary = null;
  if (preview.currentFingerprint) {
    try {
      const currentRecords = parseJsonl(await readFile(preview.rolloutTarget, 'utf8'), preview.rolloutTarget);
      const current = buildCompactConversationPreview(currentRecords, { offset: 0, limit: 1 });
      currentSummary = {
        recordCount: current.recordCount,
        turnCount: current.turnCount,
        messageCount: current.messageCount,
      };
    } catch (error) {
      currentSummary = { parseError: error.message };
    }
  }
  const comparison = preview.actions.rollout === 'already_present'
    ? { state: 'identical', label: '当前正文与快照一致', currentExists: true }
    : (preview.actions.rollout === 'replace'
      ? { state: 'replace', label: '当前正文与快照不同；恢复会先保存当前版本，再用快照替换', currentExists: true }
      : { state: 'missing', label: '当前正文缺失，可从此快照恢复', currentExists: false });
  return {
    backupId: snapshot.id,
    createdAt: snapshot.createdAt,
    snapshotKind: snapshot.kind,
    snapshotKindLabel: snapshot.kindLabel,
    session: { id: snapshot.sessionId, title: snapshot.title, projectPath: snapshot.projectPath },
    provider: { backup: snapshot.modelProvider || null, restoreTarget: preview.currentProvider || null },
    contentAvailable: true,
    comparison: { ...comparison, current: currentSummary },
    content: buildCompactConversationPreview(records, options),
  };
}

function derivedRolloutTarget(codexHome, snapshot) {
  const match = snapshot.fileName.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T.*\.jsonl$/i);
  if (!match) {
    throw new CleanerError(
      'BACKUP_TARGET_UNKNOWN',
      'The snapshot filename does not contain its original Codex session date.',
      422,
      { fileName: snapshot.fileName },
    );
  }
  return path.join(codexHome, 'sessions', match[1], match[2], match[3], snapshot.fileName);
}

async function readCurrentThread(dbPath, sessionId) {
  if (!dbPath) return null;
  const sqlite = await importSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(sessionId);
    if (!row) return null;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? value.toString() : value,
    ]));
  } finally {
    db.close();
  }
}

async function readIndexState(codexHome, sessionId) {
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  let source = '';
  let exists = false;
  try {
    source = await readFile(indexPath, 'utf8');
    exists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let count = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      const id = data.id || data.session_id || data.sessionId || data.thread_id || data.threadId;
      if (id === sessionId) count += 1;
    } catch {
      // Preserve unrelated malformed rows.
    }
  }
  return {
    indexPath,
    source,
    sourceHash: exists ? createHash('sha256').update(source).digest('hex') : null,
    count,
  };
}

function stringifyObject(value, fallback) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') return JSON.stringify(value);
  return fallback;
}

function synthesizedThreadRow({ snapshot, session, targetPath, provider, metadata }) {
  const payload = metadata.payload;
  const title = snapshot.title || session?.title || '(untitled)';
  const cwd = snapshot.projectPath || session?.projectPath || payload.cwd || '';
  const git = payload.git || {};
  const source = stringifyObject(payload.source, 'cli');
  const createdSeconds = Math.trunc(metadata.createdMs / 1000);
  const updatedSeconds = Math.trunc(metadata.updatedMs / 1000);
  return {
    id: snapshot.sessionId,
    rollout_path: targetPath,
    created_at: createdSeconds,
    updated_at: updatedSeconds,
    source,
    model_provider: provider,
    cwd,
    title,
    sandbox_policy: stringifyObject(payload.sandbox_policy, JSON.stringify({ type: 'disabled' })),
    approval_mode: payload.approval_mode || 'never',
    tokens_used: 0,
    has_user_event: 0,
    archived: 0,
    archived_at: null,
    git_sha: git.commit_hash || payload.git_sha || null,
    git_branch: git.branch || payload.git_branch || null,
    git_origin_url: git.repository_url || payload.git_origin_url || null,
    cli_version: payload.cli_version || '',
    first_user_message: title,
    agent_nickname: null,
    agent_role: null,
    memory_mode: payload.memory_mode || 'enabled',
    model: payload.model || null,
    reasoning_effort: payload.reasoning_effort || null,
    agent_path: null,
    created_at_ms: metadata.createdMs,
    updated_at_ms: metadata.updatedMs,
    thread_source: payload.thread_source || snapshot.threadSource || 'user',
    preview: title,
    recency_at: updatedSeconds,
    recency_at_ms: metadata.updatedMs,
    history_mode: payload.history_mode || 'legacy',
    name: null,
    is_pinned: 0,
  };
}

async function resolveProcessCheck(options) {
  if (options.codexProcessCheck) return options.codexProcessCheck;
  if (Array.isArray(options.runningCodexProcesses)) {
    return { available: true, processes: options.runningCodexProcesses };
  }
  return detectRunningCodexProcesses(options.platform);
}

function restorePlanToken(plan) {
  return createHash('sha256').update(JSON.stringify({
    backupId: plan.backupId,
    backupFingerprint: plan.backupFingerprint,
    rolloutTarget: plan.rolloutTarget,
    currentFingerprint: plan.currentFingerprint,
    stateDbPath: plan.stateDbPath,
    currentThread: plan.currentThread,
    indexSourceHash: plan.indexSourceHash,
    currentProvider: plan.currentProvider,
    actions: plan.actions,
  })).digest('hex');
}

export async function previewOperationBackupRestore(codexHome, options = {}) {
  const [snapshot, registry, codexProcessCheck] = await Promise.all([
    requireSnapshot(codexHome, options.backupId, options),
    buildSessionRegistry(codexHome, options),
    resolveProcessCheck(options),
  ]);
  const source = await readFile(snapshot.path, 'utf8');
  const records = parseJsonl(source, snapshot.path);
  const fallbackMetadata = await readRolloutMetadata(snapshot.path);
  const metadata = sessionMetadata(records, fallbackMetadata);
  if (metadata.id !== snapshot.sessionId) {
    throw new CleanerError('BACKUP_SESSION_MISMATCH', 'The session snapshot metadata is inconsistent.', 422, {
      expectedId: snapshot.sessionId,
      actualId: metadata.id,
    });
  }
  const session = registry.sessions.find((item) => item.id === snapshot.sessionId) || null;
  const rolloutTarget = session?.rolloutPath
    || session?.sqliteRolloutPath
    || derivedRolloutTarget(codexHome, snapshot);
  if (!isInsideSessionRoots(codexHome, rolloutTarget)) {
    throw new CleanerError('UNSAFE_RESTORE_PATH', 'The snapshot restore target is outside Codex session storage.', 422, {
      rolloutTarget,
    });
  }
  const [backupFingerprint, currentFingerprint, currentThread, indexState] = await Promise.all([
    fileFingerprint(snapshot.path),
    pathFingerprint(rolloutTarget),
    readCurrentThread(registry.stateDbPath, snapshot.sessionId),
    readIndexState(codexHome, snapshot.sessionId),
  ]);
  const rolloutAction = !currentFingerprint
    ? 'restore'
    : (currentFingerprint.sha256 === backupFingerprint.sha256 ? 'already_present' : 'replace');
  const sqliteAction = !currentThread
    ? 'insert'
    : ((currentThread.rollout_path !== rolloutTarget || currentThread.model_provider !== registry.currentProvider)
      ? 'update'
      : 'already_present');
  const indexAction = indexState.count > 0 ? 'already_present' : 'insert';
  const actions = { rollout: rolloutAction, sqlite: sqliteAction, index: indexAction };
  const actionCount = Object.values(actions).filter((action) => !['already_present', 'none'].includes(action)).length;
  const targetSessionLock = options.sessionLocksHeld
    ? { available: true, sessions: [], activeSessionIds: [], heldByCleaner: true }
    : await inspectTargetSessionLocks(codexHome, [snapshot.sessionId], options);
  const blockedByActiveTarget = targetSessionLock.activeSessionIds.length > 0;
  const plan = {
    backupId: snapshot.id,
    backupPath: snapshot.path,
    backupFingerprint,
    sessionId: snapshot.sessionId,
    title: snapshot.title,
    projectPath: snapshot.projectPath,
    snapshotKind: snapshot.kind,
    snapshotKindLabel: snapshot.kindLabel,
    snapshotCreatedAt: snapshot.createdAt,
    recordCount: records.length,
    rolloutTarget,
    currentFingerprint,
    currentProvider: registry.currentProvider,
    stateDbPath: registry.stateDbPath,
    currentThread,
    indexPath: indexState.indexPath,
    indexSourceHash: indexState.sourceHash,
    codexProcessCheck,
    codexRunning: codexProcessCheck.processes.length > 0,
    blockedByRunningCodex: false,
    targetSessionLock,
    blockedByActiveTarget,
    refreshCodexAfterApply: codexProcessCheck.processes.length > 0,
    actions,
    threadRow: synthesizedThreadRow({
      snapshot,
      session,
      targetPath: rolloutTarget,
      provider: registry.currentProvider,
      metadata,
    }),
    indexRow: {
      id: snapshot.sessionId,
      thread_name: snapshot.title || '(untitled)',
      updated_at: new Date(metadata.updatedMs).toISOString(),
    },
    summary: {
      sessions: 1,
      rolloutFiles: Number(rolloutAction === 'restore' || rolloutAction === 'replace'),
      replacedRollouts: Number(rolloutAction === 'replace'),
      sqliteRows: Number(sqliteAction === 'insert' || sqliteAction === 'update'),
      indexRows: Number(indexAction === 'insert'),
      conflicts: 0,
      alreadyPresent: Number(actionCount === 0),
    },
    canApply: Boolean(
      actionCount > 0
      && registry.sqliteAvailable
      && registry.stateDbPath
      && !blockedByActiveTarget
    ),
  };
  return { ...plan, planToken: restorePlanToken(plan) };
}

async function importSqlite() {
  try {
    return await import('node:sqlite');
  } catch (error) {
    throw new CleanerError('SQLITE_UNAVAILABLE', 'Restoring a session snapshot requires Node.js 22.5 or newer.', 501, {
      cause: error.message,
    });
  }
}

async function rewriteRolloutProvider(filePath, sessionId, provider) {
  const source = await readFile(filePath, 'utf8');
  const records = parseJsonl(source, filePath);
  const record = records.find((item) => (
    item.data?.type === 'session_meta'
    && (item.data?.payload?.id === sessionId || item.data?.payload?.session_id === sessionId)
  ));
  if (!record) throw new CleanerError('SESSION_META_NOT_FOUND', 'The restored snapshot has no session metadata.', 422);
  record.raw = null;
  record.data = structuredClone(record.data);
  record.data.payload = record.data.payload || {};
  record.data.payload.model_provider = provider;
  await writeFileAtomically(filePath, serializeJsonlPreservingRaw(records, {
    newline: source.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: /\r?\n$/.test(source),
  }));
}

async function createRestoreSafetyPoint(codexHome, preview, backupRoot, now, options) {
  const timestamp = now.toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
  const safetyDir = path.join(backupRoot, 'restore-points', `snapshot-restore-${timestamp}-${preview.sessionId}`);
  await mkdir(safetyDir, { recursive: true });
  let rolloutBackup = null;
  if (preview.currentFingerprint) {
    rolloutBackup = path.join(safetyDir, path.basename(preview.rolloutTarget));
    await copyFile(preview.rolloutTarget, rolloutBackup);
  }
  let indexBackup = null;
  try {
    indexBackup = path.join(safetyDir, 'session_index.jsonl');
    await copyFile(preview.indexPath, indexBackup);
  } catch (error) {
    if (error?.code === 'ENOENT') indexBackup = null;
    else throw error;
  }
  const sqlite = await importSqlite();
  const stateDbBackup = path.join(safetyDir, path.basename(preview.stateDbPath));
  const sourceDb = new sqlite.DatabaseSync(preview.stateDbPath, { readOnly: true });
  try {
    sourceDb.exec('PRAGMA busy_timeout=2000');
    await sqlite.backup(sourceDb, stateDbBackup);
  } finally {
    sourceDb.close();
  }
  const threadHistory = await prepareThreadHistoryMutation(
    codexHome,
    [preview.sessionId],
    safetyDir,
    options,
  );
  const manifestPath = path.join(safetyDir, 'restore-manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    createdAt: now.toISOString(),
    sourceBackupId: preview.backupId,
    sourceBackupPath: preview.backupPath,
    sessionId: preview.sessionId,
    rolloutTarget: preview.rolloutTarget,
    rolloutBackup,
    stateDbBackup,
    indexBackup,
    threadHistoryBackup: threadHistory.backup,
    planToken: preview.planToken,
  }, null, 2), 'utf8');
  return { safetyDir, manifestPath, rolloutBackup, stateDbBackup, indexBackup, threadHistory };
}

function appendIndexRow(source, row) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trimmed = source.replace(/(?:\r?\n)+$/, '');
  return `${trimmed}${trimmed ? newline : ''}${JSON.stringify(row)}${newline}`;
}

function insertThreadRow(db, row) {
  const table = db.prepare('PRAGMA table_info(threads)').all();
  const columns = new Set(table.map((item) => item.name));
  const names = Object.keys(row).filter((name) => columns.has(name));
  const requiredWithoutValue = table.filter((item) => (
    item.notnull
    && item.dflt_value === null
    && !names.includes(item.name)
  ));
  if (requiredWithoutValue.length) {
    throw new CleanerError('SQLITE_SCHEMA_UNSUPPORTED', 'The Codex thread table has unsupported required columns.', 422, {
      columns: requiredWithoutValue.map((item) => item.name),
    });
  }
  db.prepare(
    `INSERT INTO threads (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...names.map((name) => row[name] ?? null));
}

export async function applyOperationBackupRestore(codexHome, options = {}) {
  const preview = await previewOperationBackupRestore(codexHome, options);
  if (!options.sessionLocksHeld) {
    return withTargetSessionLocks(codexHome, [preview.sessionId], {
      ...options,
      errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
    }, () => applyOperationBackupRestore(codexHome, { ...options, sessionLocksHeld: true }));
  }
  if (typeof options.planToken !== 'string' || options.planToken !== preview.planToken) {
    throw new CleanerError('STALE_OPERATION_RESTORE_PLAN', 'The snapshot or current Codex state changed after preview.', 409);
  }
  if (!preview.canApply) {
    throw new CleanerError('SNAPSHOT_ALREADY_RESTORED', 'This snapshot is already the current session state.', 422);
  }
  const backupRoot = options.backupRoot
    || path.join(codexHome, 'backups', 'codex-turn-cleaner');
  const now = options.now instanceof Date ? options.now : new Date();
  const safety = await createRestoreSafetyPoint(codexHome, preview, backupRoot, now, options);
  const threadHistory = safety.threadHistory;
  let rolloutChanged = false;
  let indexChanged = false;
  let db;
  let transactionStarted = false;
  try {
    if (['restore', 'replace'].includes(preview.actions.rollout)) {
      await mkdir(path.dirname(preview.rolloutTarget), { recursive: true });
      await copyFile(preview.backupPath, preview.rolloutTarget);
      rolloutChanged = true;
      await rewriteRolloutProvider(preview.rolloutTarget, preview.sessionId, preview.currentProvider);
    }
    if (preview.actions.index === 'insert') {
      let currentIndex = '';
      let currentHash = null;
      try {
        currentIndex = await readFile(preview.indexPath, 'utf8');
        currentHash = createHash('sha256').update(currentIndex).digest('hex');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (currentHash !== preview.indexSourceHash) {
        throw new CleanerError('STALE_OPERATION_RESTORE_PLAN', 'The legacy session index changed after preview.', 409);
      }
      await writeFileAtomically(preview.indexPath, appendIndexRow(currentIndex, preview.indexRow));
      indexChanged = true;
    }
    if (['insert', 'update'].includes(preview.actions.sqlite)) {
      const sqlite = await importSqlite();
      db = new sqlite.DatabaseSync(preview.stateDbPath);
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      if (preview.actions.sqlite === 'insert') {
        insertThreadRow(db, preview.threadRow);
      } else {
        const result = db.prepare('UPDATE threads SET rollout_path = ?, model_provider = ? WHERE id = ?').run(
          preview.rolloutTarget,
          preview.currentProvider,
          preview.sessionId,
        );
        if (Number(result.changes) !== 1) {
          throw new CleanerError('SQLITE_THREAD_NOT_FOUND', 'The session row disappeared after preview.', 409);
        }
      }
    }
    const historyInvalidation = await invalidateThreadHistory(codexHome, [preview.sessionId], options);
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
      threadHistory: { ...threadHistory, invalidation: historyInvalidation },
    };
  } catch (error) {
    if (transactionStarted) {
      try { db?.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    const rollbackErrors = [];
    if (rolloutChanged) {
      try {
        if (safety.rolloutBackup) await copyFile(safety.rolloutBackup, preview.rolloutTarget);
        else await unlink(preview.rolloutTarget);
      } catch (rollbackError) {
        rollbackErrors.push({ target: preview.rolloutTarget, message: rollbackError.message });
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
    throw new CleanerError('OPERATION_BACKUP_RESTORE_FAILED', 'Restoring the session snapshot failed.', 500, {
      cause: error.message,
      safetyDir: safety.safetyDir,
      rollbackErrors,
    });
  } finally {
    db?.close();
  }
}

export async function deleteOperationBackups(codexHome, options = {}) {
  const ids = [...new Set((options.backupIds || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!ids.length) throw new CleanerError('MISSING_OPERATION_BACKUPS', 'Select one or more session snapshots.', 400);
  const listed = await listOperationBackups(codexHome, options);
  const available = new Map(listed.backups.map((backup) => [backup.id, backup]));
  const missing = ids.filter((id) => !available.has(id));
  if (missing.length) {
    throw new CleanerError('OPERATION_BACKUP_NOT_FOUND', 'One or more selected snapshots were not found.', 404, {
      backupIds: missing,
    });
  }
  const deleted = [];
  const touchedDirectories = new Set();
  for (const id of ids) {
    const backup = available.get(id);
    if (!isInsideRoot(listed.root, backup.path) || path.dirname(backup.path) !== backup.backupDir) {
      throw new CleanerError('UNSAFE_OPERATION_BACKUP', 'Refusing to delete an unsafe snapshot path.', 422, {
        path: backup.path,
      });
    }
    const info = await lstat(backup.path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CleanerError('UNSAFE_OPERATION_BACKUP', 'Refusing to delete a non-file snapshot.', 422, {
        path: backup.path,
      });
    }
    await unlink(backup.path);
    touchedDirectories.add(backup.backupDir);
    deleted.push({ id, path: backup.path, sizeBytes: backup.sizeBytes, sessionId: backup.sessionId });
  }
  for (const directory of touchedDirectories) {
    if ((await readdir(directory)).length === 0) await rmdir(directory);
  }
  return {
    deleted,
    summary: {
      count: deleted.length,
      sizeBytes: deleted.reduce((total, item) => total + item.sizeBytes, 0),
    },
  };
}

async function recursiveDirectorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isFile()) total += (await stat(fullPath)).size;
    else if (entry.isDirectory()) total += await recursiveDirectorySize(fullPath);
  }
  return total;
}

function systemBackupId(relativePath) {
  return Buffer.from(`system\n${relativePath}`, 'utf8').toString('base64url');
}

async function systemBackupEntry(root, fullPath, type, typeLabel) {
  const info = await lstat(fullPath);
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  const relativePath = path.relative(root, fullPath);
  return {
    id: systemBackupId(relativePath),
    type,
    typeLabel,
    relativePath,
    path: fullPath,
    createdAt: info.birthtime.toISOString(),
    updatedAt: info.mtime.toISOString(),
    sizeBytes: await recursiveDirectorySize(fullPath),
  };
}

export async function listSystemBackups(codexHome, options = {}) {
  const root = options.backupRoot
    || path.join(codexHome, 'backups', 'codex-turn-cleaner');
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
    const fullPath = path.join(root, entry.name);
    if (entry.name.startsWith('codex-visibility-sync-')) {
      const backup = await systemBackupEntry(root, fullPath, 'visibility_sync', '可见性修复安全备份');
      if (backup) backups.push(backup);
      continue;
    }
    if (entry.name === 'restore-points') {
      for (const child of await readdir(fullPath, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const backup = await systemBackupEntry(
          root,
          path.join(fullPath, child.name),
          'restore_point',
          '恢复前安全点',
        );
        if (backup) backups.push(backup);
      }
      continue;
    }
    if (snapshotKind(entry.name) && (await readdir(fullPath)).length === 0) {
      const backup = await systemBackupEntry(root, fullPath, 'empty_snapshot_directory', '空快照目录');
      if (backup) backups.push(backup);
    }
  }
  backups.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return {
    root,
    backups,
    summary: {
      count: backups.length,
      sizeBytes: backups.reduce((total, backup) => total + backup.sizeBytes, 0),
    },
  };
}

async function requireVisibilityBackup(codexHome, backupId, options) {
  const listed = await listSystemBackups(codexHome, options);
  const backup = listed.backups.find((item) => item.id === String(backupId || ''));
  if (!backup || backup.type !== 'visibility_sync') {
    throw new CleanerError('VISIBILITY_BACKUP_NOT_FOUND', 'The selected visibility backup was not found.', 404);
  }
  const manifestPath = path.join(backup.path, 'manifest.json');
  if (!isInsideRoot(backup.path, manifestPath)) {
    throw new CleanerError('UNSAFE_VISIBILITY_BACKUP', 'The visibility manifest path is unsafe.', 422);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const dbBackup = path.resolve(manifest.stateDbBackup || '');
  if (!isInsideRoot(backup.path, dbBackup)) {
    throw new CleanerError('UNSAFE_VISIBILITY_BACKUP', 'The SQLite backup is outside the selected backup.', 422);
  }
  return { backup, manifest, manifestPath, dbBackup };
}

function visibilityRestoreToken(plan) {
  return createHash('sha256').update(JSON.stringify({
    backupId: plan.backupId,
    targetProvider: plan.targetProvider,
    rolloutUpdates: plan.rolloutUpdates.map((item) => ({
      id: item.id,
      target: item.target,
      fromProvider: item.fromProvider,
      fingerprint: item.currentFingerprint,
    })),
    sqliteUpdates: plan.sqliteUpdates,
    conflicts: plan.conflicts,
  })).digest('hex');
}

async function sqliteProviderMap(dbPath) {
  const sqlite = await importSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    return new Map(db.prepare('SELECT id, model_provider FROM threads').all().map((row) => [
      String(row.id),
      row.model_provider == null ? null : String(row.model_provider),
    ]));
  } finally {
    db.close();
  }
}

export async function previewVisibilityBackupRestore(codexHome, options = {}) {
  const { backup, manifest, dbBackup } = await requireVisibilityBackup(codexHome, options.backupId, options);
  const registry = await buildSessionRegistry(codexHome, options);
  if (!registry.stateDbPath) {
    throw new CleanerError('STATE_DB_UNAVAILABLE', 'No current Codex state database was found.', 501);
  }
  const processCheck = options.codexProcessCheck || await detectRunningCodexProcesses(options.platform);
  const targetProvider = manifest.targetProvider || null;
  const rolloutUpdates = [];
  const conflicts = [];
  for (const item of manifest.rolloutBackups || []) {
    const backupPath = path.resolve(item.backup || '');
    const target = path.resolve(item.source || '');
    if (!isInsideRoot(backup.path, backupPath) || !isInsideSessionRoots(codexHome, target)) {
      conflicts.push({ id: item.id, source: 'rollout', reason: 'unsafe_path' });
      continue;
    }
    const [original, currentExists] = await Promise.all([
      readRolloutMetadata(backupPath),
      pathFingerprint(target),
    ]);
    if (!currentExists) {
      conflicts.push({ id: item.id, source: 'rollout', reason: 'current_rollout_missing' });
      continue;
    }
    const current = await readRolloutMetadata(target);
    const fromProvider = item.fromProvider || original.modelProvider || null;
    if (current.modelProvider === fromProvider) continue;
    if (current.modelProvider !== targetProvider) {
      conflicts.push({ id: item.id, source: 'rollout', reason: 'provider_changed_after_backup', currentProvider: current.modelProvider });
      continue;
    }
    rolloutUpdates.push({
      id: item.id,
      target,
      fromProvider,
      currentProvider: current.modelProvider,
      currentFingerprint: currentExists,
    });
  }

  // Visibility repair may recreate a missing rollout from an older backup.
  // Roll back only its provider metadata so messages appended afterwards remain intact.
  const recordedRolloutIds = new Set((manifest.rolloutBackups || []).map((item) => String(item.id)));
  for (const item of manifest.restores || []) {
    const id = String(item.id);
    if (recordedRolloutIds.has(id)) continue;
    const target = path.resolve(item.targetPath || '');
    if (!isInsideSessionRoots(codexHome, target)) {
      conflicts.push({ id, source: 'rollout', reason: 'unsafe_path' });
      continue;
    }
    const currentFingerprint = await pathFingerprint(target);
    if (!currentFingerprint) {
      conflicts.push({ id, source: 'rollout', reason: 'current_rollout_missing' });
      continue;
    }
    const current = await readRolloutMetadata(target);
    const fromProvider = item.fromProvider ?? null;
    if (current.modelProvider === fromProvider) continue;
    if (current.modelProvider !== targetProvider) {
      conflicts.push({ id, source: 'rollout', reason: 'provider_changed_after_backup', currentProvider: current.modelProvider });
      continue;
    }
    rolloutUpdates.push({
      id,
      target,
      fromProvider,
      currentProvider: current.modelProvider,
      currentFingerprint,
      restoredByRepair: true,
    });
  }

  const [backupProviders, currentProviders] = await Promise.all([
    sqliteProviderMap(dbBackup),
    sqliteProviderMap(registry.stateDbPath),
  ]);
  const recorded = Array.isArray(manifest.sqliteProviderBackups)
    ? manifest.sqliteProviderBackups
    : [...backupProviders]
      .filter(([, provider]) => provider !== targetProvider)
      .map(([id, fromProvider]) => ({ id, fromProvider }));
  const sqliteUpdates = [];
  for (const item of recorded) {
    const id = String(item.id);
    const fromProvider = item.fromProvider ?? backupProviders.get(id) ?? null;
    if (!currentProviders.has(id)) {
      conflicts.push({ id, source: 'sqlite', reason: 'current_row_missing' });
      continue;
    }
    const currentProvider = currentProviders.get(id);
    if (currentProvider === fromProvider) continue;
    if (currentProvider !== targetProvider) {
      conflicts.push({ id, source: 'sqlite', reason: 'provider_changed_after_backup', currentProvider });
      continue;
    }
    sqliteUpdates.push({ id, fromProvider, currentProvider });
  }
  const plan = {
    backupId: backup.id,
    backupPath: backup.path,
    createdAt: manifest.createdAt || backup.createdAt,
    targetProvider,
    stateDbPath: registry.stateDbPath,
    legacyManifest: !Array.isArray(manifest.sqliteProviderBackups),
    rolloutUpdates,
    sqliteUpdates,
    conflicts,
    processCheck,
    blockedByRunningCodex: processCheck.processes.length > 0,
    canApply: Boolean(
      (rolloutUpdates.length || sqliteUpdates.length)
      && !conflicts.length
      && processCheck.processes.length === 0
    ),
  };
  return { ...plan, planToken: visibilityRestoreToken(plan) };
}

async function createVisibilityRestoreSafety(preview, backupRoot, now) {
  const timestamp = now.toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
  const safetyDir = path.join(backupRoot, 'restore-points', `visibility-restore-${timestamp}`);
  const rolloutDir = path.join(safetyDir, 'jsonl');
  await mkdir(rolloutDir, { recursive: true });
  const rollouts = [];
  for (const item of preview.rolloutUpdates) {
    const target = path.join(rolloutDir, `${item.id}-${path.basename(item.target)}`);
    await copyFile(item.target, target);
    rollouts.push({ id: item.id, source: item.target, backup: target });
  }
  const sqlite = await importSqlite();
  const stateDbBackup = path.join(safetyDir, path.basename(preview.stateDbPath));
  const sourceDb = new sqlite.DatabaseSync(preview.stateDbPath, { readOnly: true });
  try {
    await sqlite.backup(sourceDb, stateDbBackup);
  } finally {
    sourceDb.close();
  }
  await writeFile(path.join(safetyDir, 'restore-manifest.json'), JSON.stringify({
    createdAt: now.toISOString(),
    kind: 'visibility-backup-restore-safety',
    sourceBackupId: preview.backupId,
    rollouts,
    stateDbBackup,
  }, null, 2), 'utf8');
  return { safetyDir, stateDbBackup, rollouts };
}

export async function applyVisibilityBackupRestore(codexHome, options = {}) {
  const preview = await previewVisibilityBackupRestore(codexHome, options);
  if (preview.blockedByRunningCodex) {
    throw new CleanerError('CODEX_STILL_RUNNING', 'Close Codex before restoring a visibility backup.', 409);
  }
  if (options.planToken !== preview.planToken) {
    throw new CleanerError('STALE_VISIBILITY_RESTORE', 'The visibility restore preview changed.', 409);
  }
  if (!preview.canApply) {
    throw new CleanerError('VISIBILITY_RESTORE_BLOCKED', 'The visibility backup cannot be restored safely.', 422, {
      conflicts: preview.conflicts,
    });
  }
  for (const item of preview.rolloutUpdates) {
    const current = await pathFingerprint(item.target);
    if (!current || current.sha256 !== item.currentFingerprint.sha256) {
      throw new CleanerError('STALE_VISIBILITY_RESTORE', 'A rollout changed after preview.', 409, { id: item.id });
    }
  }
  const backupRoot = options.backupRoot || path.join(codexHome, 'backups', 'codex-turn-cleaner');
  const safety = await createVisibilityRestoreSafety(preview, backupRoot, options.now || new Date());
  const changedRolloutIds = new Set();
  let db;
  let transactionStarted = false;
  try {
    for (const item of preview.rolloutUpdates) {
      await rewriteRolloutProvider(item.target, item.id, item.fromProvider);
      changedRolloutIds.add(item.id);
    }
    const sqlite = await importSqlite();
    db = new sqlite.DatabaseSync(preview.stateDbPath);
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const update = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?');
    for (const item of preview.sqliteUpdates) {
      const result = update.run(item.fromProvider, item.id, item.currentProvider);
      if (Number(result.changes) !== 1) throw new CleanerError('STALE_VISIBILITY_RESTORE', 'A SQLite row changed after preview.', 409, { id: item.id });
    }
    db.exec('COMMIT');
    transactionStarted = false;
    return {
      preview,
      safety,
      restoredRollouts: preview.rolloutUpdates.length,
      restoredSqliteRows: preview.sqliteUpdates.length,
      restartRequired: true,
    };
  } catch (error) {
    if (transactionStarted) {
      try { db?.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    const rollbackErrors = [];
    for (const item of safety.rollouts) {
      if (!changedRolloutIds.has(item.id)) continue;
      try { await copyFile(item.backup, item.source); } catch (rollbackError) {
        rollbackErrors.push({ path: item.source, message: rollbackError.message });
      }
    }
    if (error instanceof CleanerError) {
      error.details = { ...error.details, safetyDir: safety.safetyDir, rollbackErrors };
      throw error;
    }
    throw new CleanerError('VISIBILITY_RESTORE_FAILED', 'Restoring provider state failed; changed rollout files were rolled back where possible.', 500, {
      cause: error.message,
      safetyDir: safety.safetyDir,
      rollbackErrors,
    });
  } finally {
    db?.close();
  }
}

export async function deleteSystemBackups(codexHome, options = {}) {
  const ids = [...new Set((options.backupIds || []).map((item) => String(item || '').trim()).filter(Boolean))];
  if (!ids.length) throw new CleanerError('MISSING_SYSTEM_BACKUPS', 'Select one or more system backups.', 400);
  const listed = await listSystemBackups(codexHome, options);
  const available = new Map(listed.backups.map((backup) => [backup.id, backup]));
  const missing = ids.filter((id) => !available.has(id));
  if (missing.length) {
    throw new CleanerError('SYSTEM_BACKUP_NOT_FOUND', 'One or more selected system backups were not found.', 404, {
      backupIds: missing,
    });
  }
  const deleted = [];
  for (const id of ids) {
    const backup = available.get(id);
    const resolvedRoot = path.resolve(listed.root);
    const resolvedTarget = path.resolve(backup.path);
    const parent = path.dirname(resolvedTarget);
    const restoreRoot = path.join(resolvedRoot, 'restore-points');
    const allowedParent = parent === resolvedRoot || parent === restoreRoot;
    if (!allowedParent || resolvedTarget === resolvedRoot || !isInsideRoot(resolvedRoot, resolvedTarget)) {
      throw new CleanerError('UNSAFE_SYSTEM_BACKUP', 'Refusing to delete an unsafe system backup target.', 422, {
        path: resolvedTarget,
      });
    }
    const info = await lstat(resolvedTarget);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new CleanerError('UNSAFE_SYSTEM_BACKUP', 'Refusing to recursively delete a non-directory backup.', 422, {
        path: resolvedTarget,
      });
    }
    await rm(resolvedTarget, { recursive: true, force: false });
    deleted.push({
      id,
      path: resolvedTarget,
      type: backup.type,
      sizeBytes: backup.sizeBytes,
    });
  }
  return {
    deleted,
    summary: {
      count: deleted.length,
      sizeBytes: deleted.reduce((total, backup) => total + backup.sizeBytes, 0),
    },
  };
}
