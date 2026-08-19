import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  access,
  mkdir,
  readFile,
  readdir,
} from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const THREAD_HISTORY_DB_RE = /^thread_history_(\d+)\.sqlite$/i;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultError(code, message, status = 409, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function uniqueSessionIds(values) {
  return [...new Set((values || []).map(String).filter((value) => SESSION_ID_RE.test(value)))].sort();
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readTextIfPresent(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function parseTopLevelTomlString(text, key) {
  let inRoot = true;
  const matcher = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`);
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inRoot = false;
      continue;
    }
    if (inRoot) {
      const match = line.match(matcher);
      if (match) return match[2].trim();
    }
  }
  return null;
}

async function listThreadHistoryDatabases(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && THREAD_HISTORY_DB_RE.test(entry.name))
    .map((entry) => ({
      version: Number.parseInt(entry.name.match(THREAD_HISTORY_DB_RE)[1], 10),
      path: path.join(root, entry.name),
    }));
}

export async function resolveThreadHistoryDbPath(codexHome, options = {}) {
  if (options.threadHistoryDbPath) return options.threadHistoryDbPath;
  const configText = await readTextIfPresent(path.join(codexHome, 'config.toml'));
  const configured = (options.env || process.env).CODEX_SQLITE_HOME
    || parseTopLevelTomlString(configText, 'sqlite_home')
    || null;
  const configuredRoot = configured
    ? (path.isAbsolute(configured) ? configured : path.resolve(codexHome, configured))
    : null;
  if (configuredRoot) {
    const databases = await listThreadHistoryDatabases(configuredRoot);
    databases.sort((left, right) => right.version - left.version);
    if (databases.length) return databases[0].path;
  }
  const roots = [path.join(codexHome, 'sqlite'), codexHome];
  const databases = (await Promise.all(roots.map(listThreadHistoryDatabases))).flat();
  databases.sort((left, right) => right.version - left.version);
  return databases[0]?.path || null;
}

function normalizeProbeRows(value, sessionIds) {
  const rows = Array.isArray(value) ? value : (value ? [value] : []);
  const byId = new Map(rows.map((row) => [String(row.sessionId), row]));
  return sessionIds.map((sessionId) => ({
    sessionId,
    lockPath: byId.get(sessionId)?.lockPath || null,
    active: Boolean(byId.get(sessionId)?.active),
    exists: Boolean(byId.get(sessionId)?.exists),
    error: byId.get(sessionId)?.error || null,
  }));
}

export async function inspectTargetSessionLocks(codexHome, sessionIds, options = {}) {
  const ids = uniqueSessionIds(sessionIds);
  const lockRoot = path.join(codexHome, 'thread-writer-locks');
  if (!ids.length) return { available: true, lockRoot, sessions: [], activeSessionIds: [] };
  if (!await pathExists(lockRoot)) {
    return {
      available: true,
      lockRoot,
      sessions: ids.map((sessionId) => ({ sessionId, lockPath: path.join(lockRoot, `${sessionId}.lock`), active: false, exists: false, error: null })),
      activeSessionIds: [],
    };
  }
  if ((options.platform || process.platform) !== 'win32') {
    return {
      available: false,
      lockRoot,
      sessions: ids.map((sessionId) => ({ sessionId, lockPath: path.join(lockRoot, `${sessionId}.lock`), active: false, exists: null, error: 'target lock probing is only implemented on Windows' })),
      activeSessionIds: [],
      error: 'Target-session lock probing is unavailable on this platform.',
    };
  }

  const script = [
    '$root = $env:CODEX_CLAUDE_SESSION_MANAGER_LOCK_ROOT',
    '$ids = ConvertFrom-Json -InputObject $env:CODEX_CLAUDE_SESSION_MANAGER_SESSION_IDS',
    '$rows = @()',
    'foreach ($id in $ids) {',
    '  $p = Join-Path $root ($id + ".lock")',
    '  $exists = Test-Path -LiteralPath $p',
    '  $active = $false',
    '  $message = $null',
    '  if ($exists) {',
    '    $stream = $null',
    '    try {',
    '      $stream = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)',
    '      $stream.Lock(0, 1)',
    '      $stream.Unlock(0, 1)',
    '    } catch {',
    '      $active = $true',
    '      $message = $_.Exception.Message',
    '    } finally {',
    '      if ($stream) { $stream.Dispose() }',
    '    }',
    '  }',
    '  $rows += [PSCustomObject]@{ sessionId = $id; lockPath = $p; exists = $exists; active = $active; error = $message }',
    '}',
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 2_000_000,
      env: {
        ...process.env,
        CODEX_CLAUDE_SESSION_MANAGER_LOCK_ROOT: lockRoot,
        CODEX_CLAUDE_SESSION_MANAGER_SESSION_IDS: JSON.stringify(ids),
      },
    });
    const sessions = normalizeProbeRows(stdout.trim() ? JSON.parse(stdout) : [], ids);
    return {
      available: true,
      lockRoot,
      sessions,
      activeSessionIds: sessions.filter((item) => item.active).map((item) => item.sessionId),
    };
  } catch (error) {
    return {
      available: false,
      lockRoot,
      sessions: ids.map((sessionId) => ({ sessionId, lockPath: path.join(lockRoot, `${sessionId}.lock`), active: false, exists: null, error: error.message })),
      activeSessionIds: [],
      error: error.message,
    };
  }
}

function acquireWindowsLocks(lockRoot, sessionIds, options = {}) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$root = $env:CODEX_CLAUDE_SESSION_MANAGER_LOCK_ROOT',
    '$ids = ConvertFrom-Json -InputObject $env:CODEX_CLAUDE_SESSION_MANAGER_SESSION_IDS',
    '[System.IO.Directory]::CreateDirectory($root) | Out-Null',
    '$streams = @()',
    'try {',
    '  foreach ($id in $ids) {',
    '    $p = Join-Path $root ($id + ".lock")',
    '    $stream = [System.IO.File]::Open($p, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)',
    '    try { $stream.Lock(0, 1) } catch {',
    '      $stream.Dispose()',
    '      [Console]::Out.WriteLine("BUSY:" + $id)',
    '      [Console]::Out.Flush()',
    '      exit 42',
    '    }',
    '    $streams += $stream',
    '  }',
    '  [Console]::Out.WriteLine("READY")',
    '  [Console]::Out.Flush()',
    '  [Console]::In.ReadLine() | Out-Null',
    '} finally {',
    '  foreach ($stream in $streams) {',
    '    try { $stream.Unlock(0, 1) } catch {}',
    '    $stream.Dispose()',
    '  }',
    '}',
  ].join('; ');
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_CLAUDE_SESSION_MANAGER_LOCK_ROOT: lockRoot,
      CODEX_CLAUDE_SESSION_MANAGER_SESSION_IDS: JSON.stringify(sessionIds),
    },
  });
  const errorFactory = options.errorFactory || defaultError;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(errorFactory('TARGET_SESSION_LOCK_TIMEOUT', 'Timed out while reserving the target Codex session.', 503, { sessionIds }));
    }, options.lockTimeoutMs || 10_000);
    const finish = (error, guard = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(guard);
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const lines = stdout.split(/\r?\n/);
      if (lines.includes('READY')) {
        finish(null, {
          sessionIds,
          release: async () => {
            if (child.exitCode !== null) return;
            child.stdin.end('\n');
            await new Promise((done) => {
              const releaseTimer = setTimeout(() => { child.kill(); done(); }, 3000);
              child.once('exit', () => { clearTimeout(releaseTimer); done(); });
            });
          },
        });
        return;
      }
      const busyLine = lines.find((line) => line.startsWith('BUSY:'));
      if (busyLine) {
        const sessionId = busyLine.slice(5).trim();
        finish(errorFactory(
          'TARGET_SESSION_ACTIVE',
          'Close only the selected Codex session before changing it. Other Codex windows may remain open.',
          409,
          { sessionId, activeSessionIds: [sessionId] },
        ));
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => finish(errorFactory('TARGET_SESSION_LOCK_FAILED', 'Could not reserve the target Codex session.', 503, { sessionIds, cause: error.message })));
    child.once('exit', (code) => {
      if (settled) return;
      const busy = stdout.split(/\r?\n/).find((line) => line.startsWith('BUSY:'))?.slice(5).trim();
      if (busy || code === 42) {
        finish(errorFactory(
          'TARGET_SESSION_ACTIVE',
          'Close only the selected Codex session before changing it. Other Codex windows may remain open.',
          409,
          { sessionId: busy || null, activeSessionIds: busy ? [busy] : sessionIds },
        ));
      } else {
        finish(errorFactory('TARGET_SESSION_LOCK_FAILED', 'Could not reserve the target Codex session.', 503, { sessionIds, code, stderr: stderr.trim() }));
      }
    });
  });
}

export async function withTargetSessionLocks(codexHome, sessionIds, options, action) {
  const ids = uniqueSessionIds(sessionIds);
  if (!ids.length || options?.sessionLocksHeld) return action();
  const lockRoot = path.join(codexHome, 'thread-writer-locks');
  if ((options?.platform || process.platform) !== 'win32') {
    if (!await pathExists(lockRoot)) return action();
    const errorFactory = options?.errorFactory || defaultError;
    throw errorFactory('TARGET_SESSION_LOCK_UNAVAILABLE', 'Target-session locking is unavailable on this platform.', 503, { sessionIds: ids });
  }
  const guard = await acquireWindowsLocks(lockRoot, ids, options);
  try {
    return await action({ sessionLocksHeld: true });
  } finally {
    await guard.release();
  }
}

async function loadSqlite() {
  return import('node:sqlite');
}

function tableExists(db, tableName) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', tableName));
}

export async function backupThreadHistoryDatabase(codexHome, backupDir, options = {}) {
  const dbPath = await resolveThreadHistoryDbPath(codexHome, options);
  if (!dbPath || !await pathExists(dbPath)) return null;
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(dbPath));
  const sqlite = await loadSqlite();
  const sourceDb = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    sourceDb.exec('PRAGMA busy_timeout=5000');
    await sqlite.backup(sourceDb, backupPath);
  } finally {
    sourceDb.close();
  }
  return { dbPath, backupPath };
}

export async function prepareThreadHistoryMutation(codexHome, sessionIds, backupDir, options = {}) {
  const before = await readThreadHistoryState(codexHome, sessionIds, options);
  const affected = before.available && before.sessions.some((session) => (
    session.projection || session.turnRows > 0 || session.itemRows > 0
  ));
  const backup = affected
    ? await backupThreadHistoryDatabase(codexHome, backupDir, options)
    : null;
  const result = { before, affected, backup };
  if (typeof options.onThreadHistoryPrepared === 'function') {
    await options.onThreadHistoryPrepared(result);
  }
  return result;
}

export async function invalidateThreadHistory(codexHome, sessionIds, options = {}) {
  const ids = uniqueSessionIds(sessionIds);
  const dbPath = await resolveThreadHistoryDbPath(codexHome, options);
  if (!ids.length || !dbPath || !await pathExists(dbPath)) {
    return { available: Boolean(dbPath), dbPath, sessionIds: ids, projectionRows: 0, turnRows: 0, itemRows: 0 };
  }
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath);
  let transactionStarted = false;
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const required = ['thread_history_projection_state', 'thread_turns', 'thread_items'];
    if (!required.every((tableName) => tableExists(db, tableName))) {
      return { available: false, dbPath, sessionIds: ids, projectionRows: 0, turnRows: 0, itemRows: 0, reason: 'unsupported_schema' };
    }
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const statements = {
      itemRows: db.prepare('DELETE FROM thread_items WHERE thread_id = ?'),
      turnRows: db.prepare('DELETE FROM thread_turns WHERE thread_id = ?'),
      projectionRows: db.prepare('DELETE FROM thread_history_projection_state WHERE thread_id = ?'),
    };
    const summary = { available: true, dbPath, sessionIds: ids, projectionRows: 0, turnRows: 0, itemRows: 0 };
    for (const sessionId of ids) {
      summary.itemRows += Number(statements.itemRows.run(sessionId).changes);
      summary.turnRows += Number(statements.turnRows.run(sessionId).changes);
      summary.projectionRows += Number(statements.projectionRows.run(sessionId).changes);
    }
    db.exec('COMMIT');
    transactionStarted = false;
    return summary;
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function readThreadHistoryState(codexHome, sessionIds, options = {}) {
  const ids = uniqueSessionIds(sessionIds);
  const dbPath = await resolveThreadHistoryDbPath(codexHome, options);
  if (!ids.length || !dbPath || !await pathExists(dbPath)) return { available: false, dbPath, sessions: [] };
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (!['thread_history_projection_state', 'thread_turns', 'thread_items'].every((name) => tableExists(db, name))) {
      return { available: false, dbPath, sessions: [], reason: 'unsupported_schema' };
    }
    return {
      available: true,
      dbPath,
      sessions: ids.map((sessionId) => ({
        sessionId,
        projection: db.prepare('SELECT next_rollout_byte_offset, next_rollout_ordinal FROM thread_history_projection_state WHERE thread_id = ?').get(sessionId) || null,
        turnRows: Number(db.prepare('SELECT COUNT(*) AS count FROM thread_turns WHERE thread_id = ?').get(sessionId).count),
        itemRows: Number(db.prepare('SELECT COUNT(*) AS count FROM thread_items WHERE thread_id = ?').get(sessionId).count),
      })),
    };
  } finally {
    db.close();
  }
}

export async function readThreadHistoryTurnRows(codexHome, sessionIds, options = {}) {
  const ids = uniqueSessionIds(sessionIds);
  const dbPath = await resolveThreadHistoryDbPath(codexHome, options);
  if (!ids.length || !dbPath || !await pathExists(dbPath)) return { available: false, dbPath, rows: [] };
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (!tableExists(db, 'thread_turns')) return { available: false, dbPath, rows: [], reason: 'unsupported_schema' };
    const query = db.prepare(`
      SELECT thread_id, turn_id, rollout_ordinal, status, error_json, started_at, completed_at
      FROM thread_turns
      WHERE thread_id = ?
      ORDER BY rollout_ordinal ASC
    `);
    const rows = [];
    for (const sessionId of ids) {
      for (const row of query.all(sessionId)) {
        let error = null;
        if (typeof row.error_json === 'string' && row.error_json.trim()) {
          try { error = JSON.parse(row.error_json); } catch { error = { message: row.error_json }; }
        }
        rows.push({
          sessionId: row.thread_id,
          turnId: row.turn_id,
          rolloutOrdinal: row.rollout_ordinal,
          status: row.status,
          error,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        });
      }
    }
    return { available: true, dbPath, rows };
  } finally {
    db.close();
  }
}

export async function deleteOrphanFailedHistoryTurn(codexHome, input = {}, options = {}) {
  const sessionId = String(input.sessionId || '');
  const turnId = String(input.turnId || '');
  const errorFactory = options.errorFactory || defaultError;
  if (!SESSION_ID_RE.test(sessionId) || !SESSION_ID_RE.test(turnId)) {
    throw errorFactory('INVALID_HISTORY_TURN', 'A valid session ID and turn ID are required.', 400);
  }
  if ((input.rolloutTurnIds || []).map(String).includes(turnId)) {
    throw errorFactory('HISTORY_TURN_NOT_ORPHANED', 'This failure is present in the rollout and must be cleaned as a normal turn.', 409);
  }
  const dbPath = await resolveThreadHistoryDbPath(codexHome, options);
  if (!dbPath || !await pathExists(dbPath)) {
    throw errorFactory('THREAD_HISTORY_NOT_FOUND', 'The Codex thread history database was not found.', 404);
  }
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath);
  let transactionStarted = false;
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (!['thread_turns', 'thread_items'].every((name) => tableExists(db, name))) {
      throw errorFactory('UNSUPPORTED_THREAD_HISTORY', 'The Codex thread history schema is not supported.', 422);
    }
    const turn = db.prepare('SELECT * FROM thread_turns WHERE thread_id = ? AND turn_id = ?').get(sessionId, turnId);
    if (!turn) throw errorFactory('HISTORY_TURN_NOT_FOUND', 'The selected history failure no longer exists.', 404);
    if (turn.status !== 'failed' || typeof turn.error_json !== 'string' || !turn.error_json.trim()) {
      throw errorFactory('HISTORY_TURN_NOT_FAILED', 'Only failed history turns with an error can be removed.', 409);
    }
    const items = db.prepare('SELECT * FROM thread_items WHERE thread_id = ? AND turn_id = ? ORDER BY rollout_ordinal').all(sessionId, turnId);
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const itemRows = Number(db.prepare('DELETE FROM thread_items WHERE thread_id = ? AND turn_id = ?').run(sessionId, turnId).changes);
    const turnRows = Number(db.prepare('DELETE FROM thread_turns WHERE thread_id = ? AND turn_id = ?').run(sessionId, turnId).changes);
    db.exec('COMMIT');
    transactionStarted = false;
    return { dbPath, sessionId, turnId, turnRows, itemRows, removed: { turn, items } };
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function restoreOrphanFailedHistoryTurn(codexHome, input = {}, options = {}) {
  const turn = input.turn;
  const items = Array.isArray(input.items) ? input.items : [];
  const errorFactory = options.errorFactory || defaultError;
  if (!turn || !SESSION_ID_RE.test(String(turn.thread_id || '')) || !SESSION_ID_RE.test(String(turn.turn_id || ''))) {
    throw errorFactory('INVALID_HISTORY_RESTORE', 'The history restore payload is invalid.', 400);
  }
  const dbPath = await resolveThreadHistoryDbPath(codexHome, options);
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(dbPath);
  let transactionStarted = false;
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (db.prepare('SELECT 1 FROM thread_turns WHERE thread_id = ? AND turn_id = ?').get(turn.thread_id, turn.turn_id)) {
      throw errorFactory('HISTORY_TURN_ALREADY_PRESENT', 'The failed history turn already exists.', 409);
    }
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const turnColumns = Object.keys(turn);
    db.prepare(`INSERT INTO thread_turns (${turnColumns.join(',')}) VALUES (${turnColumns.map(() => '?').join(',')})`).run(...turnColumns.map((key) => turn[key]));
    for (const item of items) {
      const columns = Object.keys(item);
      db.prepare(`INSERT INTO thread_items (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map((key) => item[key]));
    }
    db.exec('COMMIT');
    transactionStarted = false;
    return { dbPath, sessionId: turn.thread_id, turnId: turn.turn_id, turnRows: 1, itemRows: items.length };
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    throw error;
  } finally {
    db.close();
  }
}
