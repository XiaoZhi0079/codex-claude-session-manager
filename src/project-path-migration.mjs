import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';

import {
  CleanerError,
  readRolloutMetadata,
  writeFileAtomically,
} from './core.mjs';
import {
  buildSessionRegistry,
  detectRunningCodexProcesses,
} from './registry.mjs';
import { buildClaudeSessionRegistry } from './claude-sessions.mjs';

const PATH_FIELDS = ['cwd', 'project_path', 'projectPath', 'workspace'];

function normalizePath(value) {
  const text = String(value || '').trim();
  if (!text || !path.isAbsolute(text)) {
    throw new CleanerError('INVALID_PROJECT_PATH', 'Project paths must be absolute paths.', 400, { path: value });
  }
  return path.normalize(text);
}

function pathKey(value) {
  const normalized = normalizePath(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function isInside(root, candidate) {
  const rootKey = pathKey(root);
  const candidateKey = pathKey(candidate);
  return candidateKey.startsWith(`${rootKey}${path.sep}`);
}

function requireInside(root, candidate, label) {
  if (!isInside(root, candidate)) {
    throw new CleanerError('UNSAFE_PROJECT_PATH_BACKUP', `The ${label} path is outside its managed directory.`, 422, { path: candidate });
  }
}

async function ensureTargetDirectory(targetPath) {
  try {
    const info = await stat(targetPath);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CleanerError('PROJECT_TARGET_NOT_FOUND', 'The new project directory does not exist. Rename the folder first, then migrate its session path.', 422, { targetPath });
    }
    throw new CleanerError('INVALID_PROJECT_TARGET', 'The new project path is not a readable directory.', 422, { targetPath, cause: error.message });
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileState(filePath) {
  try {
    const source = await readFile(filePath, 'utf8');
    const info = await stat(filePath);
    return { exists: true, source, sha256: sha256(source), size: info.size };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, source: '', sha256: null, size: 0 };
    throw error;
  }
}

function replacePathFields(object, fromPath, toPath) {
  if (!object || typeof object !== 'object') return 0;
  let changed = 0;
  for (const key of PATH_FIELDS) {
    if (typeof object[key] === 'string' && samePath(object[key], fromPath)) {
      object[key] = toPath;
      changed += 1;
    }
  }
  return changed;
}

function rewriteJsonl(source, fromPath, toPath, mode) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(source);
  const lines = source.split(/\r?\n/);
  if (trailing) lines.pop();
  let changedRecords = 0;
  const output = lines.map((raw) => {
    if (!raw.trim()) return raw;
    let data;
    try { data = JSON.parse(raw); } catch { return raw; }
    let changed = 0;
    if (mode === 'codex') {
      if (data?.type !== 'session_meta') return raw;
      changed += replacePathFields(data, fromPath, toPath);
      changed += replacePathFields(data?.payload, fromPath, toPath);
    } else {
      changed += replacePathFields(data, fromPath, toPath);
    }
    if (!changed) return raw;
    changedRecords += 1;
    return JSON.stringify(data);
  });
  return {
    source: output.join(newline) + (trailing && output.length ? newline : ''),
    changedRecords,
  };
}

function rewriteCodexIndex(source, fromPath, toPath) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailing = /\r?\n$/.test(source);
  const lines = source.split(/\r?\n/);
  if (trailing) lines.pop();
  let changedRows = 0;
  const output = lines.map((raw) => {
    if (!raw.trim()) return raw;
    let data;
    try { data = JSON.parse(raw); } catch { return raw; }
    const changed = replacePathFields(data, fromPath, toPath)
      + replacePathFields(data?.payload, fromPath, toPath);
    if (!changed) return raw;
    changedRows += 1;
    return JSON.stringify(data);
  });
  return { source: output.join(newline) + (trailing && output.length ? newline : ''), changedRows };
}

async function loadSqlite() {
  try { return await import('node:sqlite'); } catch (error) {
    throw new CleanerError('SQLITE_UNAVAILABLE', 'Project path migration requires Node.js 22.5 or newer with node:sqlite.', 501, { cause: error.message });
  }
}

async function readCodexRows(dbPath, fromPath) {
  if (!dbPath) return [];
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((row) => row.name));
    if (!columns.has('id') || !columns.has('cwd')) return [];
    return db.prepare('SELECT id, cwd FROM threads WHERE cwd IS NOT NULL').all()
      .filter((row) => typeof row.cwd === 'string' && samePath(row.cwd, fromPath))
      .map((row) => ({ id: String(row.id), cwd: row.cwd }));
  } finally {
    db.close();
  }
}

async function processCheck(options) {
  if (options.codexProcessCheck) return options.codexProcessCheck;
  if (Array.isArray(options.runningCodexProcesses)) return { available: true, processes: options.runningCodexProcesses };
  return detectRunningCodexProcesses(options.platform);
}

function migrationToken(value) {
  return sha256(JSON.stringify(value));
}

function timestamp(now = new Date()) {
  return now.toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
}

async function copyDatabase(dbPath, targetPath) {
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    await sqlite.backup(db, targetPath);
  } finally {
    db.close();
  }
}

export async function previewCodexProjectPathMigration(codexHome, options = {}) {
  const fromPath = normalizePath(options.fromPath);
  const toPath = normalizePath(options.toPath);
  if (samePath(fromPath, toPath)) throw new CleanerError('PROJECT_PATH_UNCHANGED', 'The old and new project paths are the same.', 400);
  await ensureTargetDirectory(toPath);

  const registry = await buildSessionRegistry(codexHome, { backupRoot: options.backupRoot, env: options.env });
  const rolloutUpdates = [];
  for (const session of registry.sessions) {
    if (!session.rolloutPath) continue;
    const metadata = await readRolloutMetadata(session.rolloutPath);
    if (!metadata.projectPath || !samePath(metadata.projectPath, fromPath)) continue;
    const state = await fileState(session.rolloutPath);
    const rewritten = rewriteJsonl(state.source, fromPath, toPath, 'codex');
    if (rewritten.changedRecords) rolloutUpdates.push({ id: session.id, path: session.rolloutPath, state, changedRecords: rewritten.changedRecords });
  }
  const sqliteRows = await readCodexRows(registry.stateDbPath, fromPath);
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  const indexState = await fileState(indexPath);
  const indexUpdate = indexState.exists ? rewriteCodexIndex(indexState.source, fromPath, toPath) : { source: '', changedRows: 0 };
  const codexProcessCheck = await processCheck(options);
  const sessionIds = [...new Set([...rolloutUpdates.map((item) => item.id), ...sqliteRows.map((item) => item.id)])];
  const blockedByRunningCodex = codexProcessCheck.available && codexProcessCheck.processes.length > 0;
  const tokenData = {
    fromPath,
    toPath,
    rollouts: rolloutUpdates.map((item) => [item.id, item.path, item.state.sha256]),
    sqliteRows,
    stateDbPath: registry.stateDbPath,
    indexHash: indexState.sha256,
    indexRows: indexUpdate.changedRows,
  };
  return {
    platform: 'codex', fromPath, toPath, sessionIds, rolloutUpdates, sqliteRows,
    stateDbPath: registry.stateDbPath,
    indexPath, indexState, indexRows: indexUpdate.changedRows,
    codexProcessCheck, blockedByRunningCodex,
    canApply: sessionIds.length > 0 && !blockedByRunningCodex,
    planToken: migrationToken(tokenData),
    summary: { sessions: sessionIds.length, rolloutFiles: rolloutUpdates.length, sqliteRows: sqliteRows.length, indexRows: indexUpdate.changedRows },
  };
}

async function createCodexBackup(preview, backupRoot, now) {
  const backupDir = path.join(backupRoot, `project-path-migration-codex-${timestamp(now)}`);
  const rolloutDir = path.join(backupDir, 'rollouts');
  await mkdir(rolloutDir, { recursive: true });
  const rollouts = [];
  for (const item of preview.rolloutUpdates) {
    const backup = path.join(rolloutDir, `${item.id}.jsonl`);
    await copyFile(item.path, backup);
    rollouts.push({ id: item.id, source: item.path, backup, beforeHash: item.state.sha256 });
  }
  let stateDbBackup = null;
  if (preview.sqliteRows.length) {
    stateDbBackup = path.join(backupDir, path.basename(preview.stateDbPath));
    await copyDatabase(preview.stateDbPath, stateDbBackup);
  }
  let indexBackup = null;
  if (preview.indexRows) {
    indexBackup = path.join(backupDir, 'session_index.jsonl');
    await copyFile(preview.indexPath, indexBackup);
  }
  return { backupDir, manifestPath: path.join(backupDir, 'manifest.json'), rollouts, stateDbBackup, indexBackup };
}

async function assertHash(filePath, expected, code = 'STALE_PROJECT_PATH_PLAN') {
  const state = await fileState(filePath);
  if (!state.exists || state.sha256 !== expected) {
    throw new CleanerError(code, 'A session file changed after the migration preview. Refresh and try again.', 409, { filePath });
  }
  return state;
}

export async function applyCodexProjectPathMigration(codexHome, options = {}) {
  const preview = await previewCodexProjectPathMigration(codexHome, options);
  if (preview.blockedByRunningCodex) throw new CleanerError('CODEX_STILL_RUNNING', 'Close every Codex window and terminal session before migrating a project path.', 409);
  if (options.planToken !== preview.planToken) throw new CleanerError('STALE_PROJECT_PATH_PLAN', 'The project path migration plan changed. Preview it again.', 409);
  if (!preview.canApply) throw new CleanerError('PROJECT_PATH_NOT_FOUND', 'No Codex sessions use the selected old project path.', 404);
  for (const item of preview.rolloutUpdates) await assertHash(item.path, item.state.sha256);
  if (preview.indexRows) await assertHash(preview.indexPath, preview.indexState.sha256);

  const backupRoot = options.backupRoot || path.join(codexHome, 'backups', 'codex-claude-session-manager');
  const backup = await createCodexBackup(preview, backupRoot, options.now || new Date());
  const changedRollouts = [];
  let indexChanged = false;
  let db;
  let transaction = false;
  try {
    for (const item of preview.rolloutUpdates) {
      const current = await readFile(item.path, 'utf8');
      const rewritten = rewriteJsonl(current, preview.fromPath, preview.toPath, 'codex');
      await writeFileAtomically(item.path, rewritten.source);
      changedRollouts.push(item.path);
    }
    if (preview.indexRows) {
      const current = await readFile(preview.indexPath, 'utf8');
      await writeFileAtomically(preview.indexPath, rewriteCodexIndex(current, preview.fromPath, preview.toPath).source);
      indexChanged = true;
    }
    if (preview.sqliteRows.length) {
      const sqlite = await loadSqlite();
      db = new sqlite.DatabaseSync(preview.stateDbPath);
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
      const update = db.prepare('UPDATE threads SET cwd = ? WHERE id = ? AND cwd = ?');
      for (const row of preview.sqliteRows) {
        const result = update.run(preview.toPath, row.id, row.cwd);
        if (Number(result.changes) !== 1) throw new CleanerError('STALE_PROJECT_PATH_PLAN', 'A Codex SQLite thread changed after preview.', 409, { id: row.id });
      }
      db.exec('COMMIT');
      transaction = false;
    }
    const afterRollouts = [];
    for (const item of preview.rolloutUpdates) afterRollouts.push({ path: item.path, hash: (await fileState(item.path)).sha256 });
    const manifest = {
      version: 1, kind: 'project-path-migration', platform: 'codex', createdAt: new Date().toISOString(),
      fromPath: preview.fromPath, toPath: preview.toPath, sessionIds: preview.sessionIds,
      rollouts: backup.rollouts, afterRollouts,
      stateDbPath: preview.stateDbPath, stateDbBackup: backup.stateDbBackup, sqliteRows: preview.sqliteRows,
      indexPath: preview.indexPath, indexBackup: backup.indexBackup,
      indexAfterHash: preview.indexRows ? (await fileState(preview.indexPath)).sha256 : null,
    };
    await writeFile(backup.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { preview, backup, changedRollouts: changedRollouts.length, changedSqliteRows: preview.sqliteRows.length, changedIndexRows: preview.indexRows, restartRequired: true };
  } catch (error) {
    if (transaction) try { db?.exec('ROLLBACK'); } catch {}
    const rollbackErrors = [];
    for (const item of backup.rollouts) try { await copyFile(item.backup, item.source); } catch (cause) { rollbackErrors.push({ path: item.source, message: cause.message }); }
    if (indexChanged && backup.indexBackup) try { await copyFile(backup.indexBackup, preview.indexPath); } catch (cause) { rollbackErrors.push({ path: preview.indexPath, message: cause.message }); }
    error.details = { ...(error.details || {}), backupDir: backup.backupDir, rollbackErrors };
    throw error;
  } finally {
    db?.close();
  }
}

export function encodeClaudeProjectPath(projectPath) {
  return normalizePath(projectPath).replace(/[^a-zA-Z0-9_-]/g, '-');
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new CleanerError('INVALID_CLAUDE_PROJECT_INDEX', 'A Claude project index is not valid JSON.', 422, { filePath, cause: error.message });
  }
}

function updatedClaudeEntry(entry, toPath) {
  const value = structuredClone(entry);
  replacePathFields(value, value.projectPath || toPath, toPath);
  if ('projectPath' in value) value.projectPath = toPath;
  return value;
}

async function buildClaudeIndexOutputs(claudeHome, sessions, fromPath, toPath, targetKey) {
  const byKey = new Map();
  for (const session of sessions) {
    if (!byKey.has(session.projectKey)) byKey.set(session.projectKey, []);
    byKey.get(session.projectKey).push(session);
  }
  const involvedKeys = new Set([...byKey.keys(), targetKey]);
  const states = new Map();
  for (const key of involvedKeys) {
    const filePath = path.join(claudeHome, 'projects', key, 'sessions-index.json');
    states.set(key, { key, path: filePath, state: await fileState(filePath), value: await readJson(filePath, { version: 1, entries: [] }) });
  }
  const migratedIds = new Set(sessions.map((session) => session.id));
  const target = states.get(targetKey);
  const migratedEntries = [];
  for (const [key, keySessions] of byKey) {
    const state = states.get(key);
    const ids = new Set(keySessions.map((session) => session.id));
    for (const entry of Array.isArray(state.value.entries) ? state.value.entries : []) {
      if (ids.has(entry?.sessionId)) migratedEntries.push(updatedClaudeEntry(entry, toPath));
    }
    if (key !== targetKey) state.value.entries = (Array.isArray(state.value.entries) ? state.value.entries : []).filter((entry) => !ids.has(entry?.sessionId));
  }
  const existingTarget = (Array.isArray(target.value.entries) ? target.value.entries : []).filter((entry) => !migratedIds.has(entry?.sessionId));
  const fallbackEntries = sessions.filter((session) => !migratedEntries.some((entry) => entry.sessionId === session.id)).map((session) => ({
    sessionId: session.id, summary: session.title, projectPath: toPath, modified: session.updatedAt,
  }));
  target.value = { ...target.value, originalPath: toPath, entries: [...existingTarget, ...migratedEntries, ...fallbackEntries] };
  for (const item of states.values()) item.output = `${JSON.stringify(item.value, null, 2)}\n`;
  return [...states.values()];
}

export async function previewClaudeProjectPathMigration(claudeHome, options = {}) {
  const fromPath = normalizePath(options.fromPath);
  const toPath = normalizePath(options.toPath);
  if (samePath(fromPath, toPath)) throw new CleanerError('PROJECT_PATH_UNCHANGED', 'The old and new project paths are the same.', 400);
  await ensureTargetDirectory(toPath);
  const registry = await buildClaudeSessionRegistry(claudeHome);
  const sessions = registry.sessions.filter((session) => session.projectPath && samePath(session.projectPath, fromPath));
  const targetKey = encodeClaudeProjectPath(toPath);
  const targetDir = path.join(claudeHome, 'projects', targetKey);
  const moves = [];
  const conflicts = [];
  for (const session of sessions) {
    const targetFile = path.join(targetDir, `${session.id}.jsonl`);
    const targetSidecar = path.join(targetDir, session.id);
    const sameFile = pathKey(session.filePath) === pathKey(targetFile);
    const targetFileState = sameFile ? { exists: false } : await fileState(targetFile);
    let targetSidecarExists = false;
    try { targetSidecarExists = !sameFile && (await stat(targetSidecar)).isDirectory(); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (targetFileState.exists) conflicts.push({ sessionId: session.id, path: targetFile, kind: 'main-file' });
    if (targetSidecarExists) conflicts.push({ sessionId: session.id, path: targetSidecar, kind: 'sidecar' });
    const sourceState = await fileState(session.filePath);
    const rewritten = rewriteJsonl(sourceState.source, fromPath, toPath, 'claude');
    moves.push({
      id: session.id, title: session.title, sourceKey: session.projectKey,
      sourceFile: session.filePath, targetFile, sourceSidecar: session.sessionDir, targetSidecar,
      sourceState, changedRecords: rewritten.changedRecords,
    });
  }
  const indexes = await buildClaudeIndexOutputs(claudeHome, sessions, fromPath, toPath, targetKey);
  const tokenData = { fromPath, toPath, targetKey, moves: moves.map((item) => [item.id, item.sourceFile, item.targetFile, item.sourceState.sha256]), indexes: indexes.map((item) => [item.path, item.state.sha256]), conflicts };
  return {
    platform: 'claude', fromPath, toPath, targetKey, targetDir, sessions: sessions.map((session) => ({ id: session.id, title: session.title })),
    sessionIds: sessions.map((session) => session.id), moves, indexes, conflicts,
    canApply: sessions.length > 0 && conflicts.length === 0,
    planToken: migrationToken(tokenData),
    summary: { sessions: sessions.length, mainFiles: moves.length, sidecarDirectories: moves.filter((item) => item.sourceSidecar !== item.targetSidecar).length, indexes: indexes.length, conflicts: conflicts.length },
  };
}

async function pathExists(target) {
  try { await stat(target); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function createClaudeBackup(preview, backupRoot, now) {
  const backupDir = path.join(backupRoot, `project-path-migration-claude-${timestamp(now)}`);
  const filesDir = path.join(backupDir, 'files');
  await mkdir(filesDir, { recursive: true });
  const files = [];
  for (const [index, item] of [...preview.moves.map((move) => ({ path: move.sourceFile, state: move.sourceState })), ...preview.indexes.map((entry) => ({ path: entry.path, state: entry.state }))].entries()) {
    const backup = item.state.exists ? path.join(filesDir, `${index}-${path.basename(item.path)}`) : null;
    if (backup) await copyFile(item.path, backup);
    files.push({ path: item.path, existed: item.state.exists, beforeHash: item.state.sha256, backup });
  }
  return { backupDir, manifestPath: path.join(backupDir, 'manifest.json'), files };
}

async function restoreFileSnapshots(files) {
  const errors = [];
  for (const item of files) {
    try {
      if (item.existed) {
        await mkdir(path.dirname(item.path), { recursive: true });
        await copyFile(item.backup, item.path);
      } else if (await pathExists(item.path)) {
        await unlink(item.path);
      }
    } catch (error) { errors.push({ path: item.path, message: error.message }); }
  }
  return errors;
}

export async function applyClaudeProjectPathMigration(claudeHome, options = {}) {
  const preview = await previewClaudeProjectPathMigration(claudeHome, options);
  if (options.planToken !== preview.planToken) throw new CleanerError('STALE_PROJECT_PATH_PLAN', 'The Claude project path migration plan changed. Preview it again.', 409);
  if (!preview.canApply) {
    if (preview.conflicts.length) throw new CleanerError('CLAUDE_PROJECT_TARGET_CONFLICT', 'The new Claude project storage already contains one or more matching session files.', 409, { conflicts: preview.conflicts });
    throw new CleanerError('PROJECT_PATH_NOT_FOUND', 'No Claude Code sessions use the selected old project path.', 404);
  }
  for (const item of preview.moves) await assertHash(item.sourceFile, item.sourceState.sha256);
  for (const item of preview.indexes) if (item.state.exists) await assertHash(item.path, item.state.sha256);
  const backupRoot = options.backupRoot || path.join(claudeHome, 'backups', 'codex-claude-session-manager-deleted-turns');
  const backup = await createClaudeBackup(preview, backupRoot, options.now || new Date());
  const movedSidecars = [];
  const createdTargets = [];
  try {
    await mkdir(preview.targetDir, { recursive: true });
    for (const item of preview.moves) {
      const source = await readFile(item.sourceFile, 'utf8');
      const rewritten = rewriteJsonl(source, preview.fromPath, preview.toPath, 'claude').source;
      await mkdir(path.dirname(item.targetFile), { recursive: true });
      await writeFileAtomically(item.targetFile, rewritten);
      if (pathKey(item.sourceFile) !== pathKey(item.targetFile)) {
        createdTargets.push(item.targetFile);
        await unlink(item.sourceFile);
      }
      if (pathKey(item.sourceSidecar) !== pathKey(item.targetSidecar) && await pathExists(item.sourceSidecar)) {
        await rename(item.sourceSidecar, item.targetSidecar);
        movedSidecars.push({ source: item.sourceSidecar, target: item.targetSidecar });
      }
    }
    for (const item of preview.indexes) {
      await mkdir(path.dirname(item.path), { recursive: true });
      await writeFileAtomically(item.path, item.output);
    }
    const manifest = {
      version: 1, kind: 'project-path-migration', platform: 'claude', createdAt: new Date().toISOString(),
      fromPath: preview.fromPath, toPath: preview.toPath, sessionIds: preview.sessionIds,
      files: backup.files,
      targets: await Promise.all(preview.moves.map(async (item) => ({ source: item.sourceFile, target: item.targetFile, afterHash: (await fileState(item.targetFile)).sha256 }))),
      sidecars: preview.moves.filter((item) => pathKey(item.sourceSidecar) !== pathKey(item.targetSidecar)).map((item) => ({ source: item.sourceSidecar, target: item.targetSidecar })),
      indexAfter: await Promise.all(preview.indexes.map(async (item) => ({ path: item.path, hash: (await fileState(item.path)).sha256 }))),
    };
    await writeFile(backup.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { preview, backup, movedSessions: preview.moves.length, movedSidecars: movedSidecars.length, changedIndexes: preview.indexes.length, claudeRestartRecommended: true };
  } catch (error) {
    const rollbackErrors = [];
    for (const item of movedSidecars.reverse()) try { await rename(item.target, item.source); } catch (cause) { rollbackErrors.push({ path: item.target, message: cause.message }); }
    for (const target of createdTargets) try { if (await pathExists(target)) await unlink(target); } catch (cause) { rollbackErrors.push({ path: target, message: cause.message }); }
    rollbackErrors.push(...await restoreFileSnapshots(backup.files));
    error.details = { ...(error.details || {}), backupDir: backup.backupDir, rollbackErrors };
    throw error;
  }
}

function requireMigrationManifest(backupRoot, backupDir) {
  const root = path.resolve(backupRoot);
  const target = path.resolve(String(backupDir || ''));
  if (!target.startsWith(`${root}${path.sep}`)) throw new CleanerError('UNSAFE_PROJECT_PATH_BACKUP', 'The project path backup is outside the managed backup directory.', 422);
  return { backupDir: target, manifestPath: path.join(target, 'manifest.json') };
}

export async function restoreProjectPathMigration(platform, home, options = {}) {
  const { backupDir, manifestPath } = requireMigrationManifest(options.backupRoot, options.backupDir);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.kind !== 'project-path-migration' || manifest?.platform !== platform) throw new CleanerError('INVALID_PROJECT_PATH_BACKUP', 'The project path migration backup is invalid.', 422);
  if (platform === 'codex') {
    const sessionRoots = [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
    for (const item of manifest.rollouts || []) {
      if (!sessionRoots.some((root) => isInside(root, item.source))) throw new CleanerError('UNSAFE_PROJECT_PATH_BACKUP', 'A Codex rollout restore target is outside the session directories.', 422, { path: item.source });
      requireInside(backupDir, item.backup, 'rollout backup');
    }
    if (pathKey(manifest.indexPath) !== pathKey(path.join(home, 'session_index.jsonl'))) throw new CleanerError('UNSAFE_PROJECT_PATH_BACKUP', 'The Codex index restore target is invalid.', 422);
    if (manifest.indexBackup) requireInside(backupDir, manifest.indexBackup, 'index backup');
    if (!isInside(home, manifest.stateDbPath) || path.dirname(path.resolve(manifest.stateDbPath)) !== path.resolve(home)) throw new CleanerError('UNSAFE_PROJECT_PATH_BACKUP', 'The Codex state database restore target is invalid.', 422);
    for (const item of manifest.afterRollouts) await assertHash(item.path, item.hash, 'PROJECT_PATH_RESTORE_CONFLICT');
    if (manifest.indexAfterHash) await assertHash(manifest.indexPath, manifest.indexAfterHash, 'PROJECT_PATH_RESTORE_CONFLICT');
    const sqlite = await loadSqlite();
    let db;
    let transaction = false;
    try {
      if (manifest.sqliteRows.length) {
        const check = new sqlite.DatabaseSync(manifest.stateDbPath, { readOnly: true });
        try {
          const statement = check.prepare('SELECT cwd FROM threads WHERE id = ?');
          for (const row of manifest.sqliteRows) {
            const current = statement.get(row.id);
            if (!current || !samePath(current.cwd, manifest.toPath)) throw new CleanerError('PROJECT_PATH_RESTORE_CONFLICT', 'A Codex thread changed after project path migration.', 409, { id: row.id });
          }
        } finally { check.close(); }
      }
      for (const item of manifest.rollouts) await copyFile(item.backup, item.source);
      if (manifest.indexBackup) await copyFile(manifest.indexBackup, manifest.indexPath);
      if (manifest.sqliteRows.length) {
        db = new sqlite.DatabaseSync(manifest.stateDbPath);
        db.exec('PRAGMA busy_timeout=5000');
        db.exec('BEGIN IMMEDIATE');
        transaction = true;
        const update = db.prepare('UPDATE threads SET cwd = ? WHERE id = ? AND cwd = ?');
        for (const row of manifest.sqliteRows) {
          const result = update.run(row.cwd, row.id, manifest.toPath);
          if (Number(result.changes) !== 1) throw new CleanerError('PROJECT_PATH_RESTORE_CONFLICT', 'A Codex thread changed after project path migration.', 409, { id: row.id });
        }
        db.exec('COMMIT');
        transaction = false;
      }
      return { restoredSessions: manifest.sessionIds.length, restartRequired: true };
    } catch (error) {
      if (transaction) try { db?.exec('ROLLBACK'); } catch {}
      throw error;
    } finally { db?.close(); }
  }

  const projectsRoot = path.join(home, 'projects');
  for (const item of [...(manifest.targets || []), ...(manifest.indexAfter || [])]) requireInside(projectsRoot, item.path || item.source || item.target, 'Claude project storage');
  for (const item of manifest.targets || []) {
    requireInside(projectsRoot, item.source, 'Claude source session');
    requireInside(projectsRoot, item.target, 'Claude target session');
  }
  for (const item of manifest.sidecars || []) {
    requireInside(projectsRoot, item.source, 'Claude source sidecar');
    requireInside(projectsRoot, item.target, 'Claude target sidecar');
  }
  for (const item of manifest.files || []) {
    requireInside(projectsRoot, item.path, 'Claude restore target');
    if (item.backup) requireInside(backupDir, item.backup, 'Claude file backup');
  }
  for (const item of manifest.targets) await assertHash(item.target, item.afterHash, 'PROJECT_PATH_RESTORE_CONFLICT');
  for (const item of manifest.indexAfter) await assertHash(item.path, item.hash, 'PROJECT_PATH_RESTORE_CONFLICT');
  for (const item of [...manifest.sidecars].reverse()) {
    if (await pathExists(item.target)) {
      if (await pathExists(item.source)) throw new CleanerError('PROJECT_PATH_RESTORE_CONFLICT', 'A Claude sidecar directory already exists at the old project path.', 409, { path: item.source });
      await mkdir(path.dirname(item.source), { recursive: true });
      await rename(item.target, item.source);
    }
  }
  for (const item of manifest.targets) {
    const original = manifest.files.find((file) => pathKey(file.path) === pathKey(item.source));
    await mkdir(path.dirname(item.source), { recursive: true });
    await copyFile(original.backup, item.source);
    if (pathKey(item.source) !== pathKey(item.target)) await unlink(item.target);
  }
  await restoreFileSnapshots(manifest.files.filter((file) => file.path.endsWith('sessions-index.json')));
  return { restoredSessions: manifest.sessionIds.length, claudeRestartRecommended: true };
}
