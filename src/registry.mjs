import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';

import {
  CleanerError,
  listSessions as listFileSessions,
  parseJsonl,
  readRolloutMetadata,
  serializeJsonlPreservingRaw,
  writeFileAtomically,
} from './core.mjs';
import { summarizeSessionHealth } from './session-health.mjs';

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const STATE_DB_RE = /^state_(\d+)\.sqlite$/;
const ROLLOUT_RE = /^rollout-.*\.jsonl$/i;
const execFileAsync = promisify(execFile);

function normalizeDetectedProcess(item) {
  const pid = Number(item?.pid ?? item?.ProcessId);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    parentPid: Number(item?.parentPid ?? item?.ParentProcessId) || null,
    name: String(item?.name ?? item?.Name ?? 'codex').trim() || 'codex',
  };
}

export async function detectRunningCodexProcesses(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const command = [
        "$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'codex.exe' }",
        "$result = @($items | Select-Object @{Name='pid';Expression={$_.ProcessId}}, @{Name='parentPid';Expression={$_.ParentProcessId}}, @{Name='name';Expression={$_.Name}})",
        'ConvertTo-Json -InputObject $result -Compress',
      ].join('; ');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      );
      const parsed = stdout.trim() ? JSON.parse(stdout) : [];
      return {
        available: true,
        processes: (Array.isArray(parsed) ? parsed : [parsed])
          .map(normalizeDetectedProcess)
          .filter(Boolean),
      };
    }

    const { stdout } = await execFileAsync(
      'ps',
      ['-eo', 'pid=,ppid=,comm='],
      { encoding: 'utf8', timeout: 5000 },
    );
    const processes = stdout.split(/\r?\n/).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      const name = path.basename(match[3].trim()).toLowerCase();
      if (name !== 'codex' && name !== 'codex.exe') return null;
      return normalizeDetectedProcess({
        pid: match[1],
        parentPid: match[2],
        name: match[3].trim(),
      });
    }).filter(Boolean);
    return { available: true, processes };
  } catch (error) {
    return {
      available: false,
      processes: [],
      error: error.message,
    };
  }
}

async function resolveCodexProcessCheck(options) {
  if (options.codexProcessCheck) return options.codexProcessCheck;
  if (Array.isArray(options.runningCodexProcesses)) {
    return {
      available: true,
      processes: options.runningCodexProcesses
        .map(normalizeDetectedProcess)
        .filter(Boolean),
    };
  }
  return detectRunningCodexProcesses(options.platform);
}

function normalizePathKey(value) {
  let comparable = String(value);
  if (process.platform === 'win32') {
    if (/^\\\\\?\\UNC\\/i.test(comparable)) comparable = `\\\\${comparable.slice(8)}`;
    else if (/^\\\\\?\\/i.test(comparable)) comparable = comparable.slice(4);
  }
  const resolved = path.resolve(comparable);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function isFile(filePath) {
  if (!filePath) return false;
  try {
    return (await stat(filePath)).isFile();
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
    if (!inRoot) continue;
    const match = line.match(matcher);
    if (match) return match[2].trim();
  }
  return null;
}

async function listStateDbFiles(root) {
  if (!root) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && STATE_DB_RE.test(entry.name))
    .map((entry) => ({
      version: Number.parseInt(entry.name.match(STATE_DB_RE)[1], 10),
      path: path.join(root, entry.name),
    }))
    .sort((left, right) => right.version - left.version)
    .map((entry) => entry.path);
}

async function resolveCodexState(codexHome, env = process.env) {
  const configPath = path.join(codexHome, 'config.toml');
  const configText = await readTextIfPresent(configPath);
  const configuredProvider = parseTopLevelTomlString(configText, 'model_provider');
  const sqliteHomeValue = parseTopLevelTomlString(configText, 'sqlite_home')
    || env.CODEX_SQLITE_HOME
    || null;
  const sqliteHome = sqliteHomeValue
    ? (path.isAbsolute(sqliteHomeValue) ? sqliteHomeValue : path.resolve(codexHome, sqliteHomeValue))
    : null;

  const roots = [];
  if (sqliteHome) roots.push(sqliteHome);
  roots.push(path.join(codexHome, 'sqlite'), codexHome);

  const seen = new Set();
  const dbPaths = [];
  for (const root of roots) {
    for (const dbPath of await listStateDbFiles(root)) {
      const key = normalizePathKey(dbPath);
      if (seen.has(key)) continue;
      seen.add(key);
      dbPaths.push(dbPath);
    }
  }

  return {
    configPath,
    configText,
    currentProvider: configuredProvider || 'openai',
    sqliteHome,
    stateDbPaths: dbPaths,
    primaryStateDbPath: dbPaths[0] || null,
  };
}

async function loadSqliteModule({ required = false } = {}) {
  try {
    return await import('node:sqlite');
  } catch (error) {
    if (!required) return null;
    throw new CleanerError(
      'SQLITE_UNAVAILABLE',
      'Codex visibility repair requires Node.js 22.5 or newer with node:sqlite.',
      501,
      { cause: error.message },
    );
  }
}

function normalizeDbTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(milliseconds).toISOString();
  }
  return typeof value === 'string' && value ? value : null;
}

async function readThreadRows(dbPath) {
  const sqlite = await loadSqliteModule();
  if (!sqlite || !dbPath) return { available: Boolean(sqlite), rows: [] };

  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout=2000');
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((row) => row.name));
    if (!columns.has('id')) return { available: true, rows: [] };

    const requested = [
      'id',
      'title',
      'rollout_path',
      'archived',
      'model_provider',
      'updated_at',
      'created_at',
      'cwd',
      'source',
    ];
    const expressions = requested.map((column) => (
      columns.has(column) ? `"${column}" AS "${column}"` : `NULL AS "${column}"`
    ));
    const rows = db.prepare(`SELECT ${expressions.join(', ')} FROM threads`).all().map((row) => ({
      id: String(row.id || '').trim(),
      title: typeof row.title === 'string' ? row.title.trim() : '',
      rolloutPath: typeof row.rollout_path === 'string' && row.rollout_path.trim()
        ? path.resolve(row.rollout_path)
        : null,
      archived: Boolean(row.archived),
      modelProvider: typeof row.model_provider === 'string' ? row.model_provider.trim() : null,
      updatedAt: normalizeDbTimestamp(row.updated_at) || normalizeDbTimestamp(row.created_at),
      projectPath: typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd.trim() : null,
      source: row.source ?? null,
      stateDbPath: dbPath,
    })).filter((row) => row.id);
    return { available: true, rows };
  } catch (error) {
    return {
      available: true,
      rows: [],
      error: error.message,
    };
  } finally {
    db?.close();
  }
}

async function listJsonlFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonlFiles(fullPath));
    } else if (entry.isFile() && ROLLOUT_RE.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readBackupCandidate(filePath, sourceKind) {
  try {
    const [metadata, info] = await Promise.all([
      readRolloutMetadata(filePath),
      stat(filePath),
    ]);
    if (!metadata.id) return null;
    return {
      id: metadata.id,
      path: filePath,
      sourceKind,
      modelProvider: metadata.modelProvider || null,
      projectPath: metadata.projectPath || null,
      summary: metadata.summary || '',
      updatedAt: info.mtime.toISOString(),
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  } catch {
    return null;
  }
}

async function mapWithConcurrency(items, mapper, limit = 8) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function listBackupCandidates(codexHome, backupRoot, env = process.env) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const roots = [
    { path: backupRoot, sourceKind: 'cleaner_backup' },
    { path: path.join(home, '.cc-switch', 'backups'), sourceKind: 'cc_switch_backup' },
  ].filter((item) => item.path);

  const seenRoots = new Set();
  const files = [];
  for (const root of roots) {
    const key = normalizePathKey(root.path);
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    for (const filePath of await listJsonlFiles(root.path)) {
      if (normalizePathKey(filePath).startsWith(`${normalizePathKey(codexHome)}${path.sep}`)) {
        const liveRoots = [
          normalizePathKey(path.join(codexHome, 'sessions')),
          normalizePathKey(path.join(codexHome, 'archived_sessions')),
        ];
        if (liveRoots.some((liveRoot) => normalizePathKey(filePath).startsWith(`${liveRoot}${path.sep}`))) {
          continue;
        }
      }
      files.push({ filePath, sourceKind: root.sourceKind });
    }
  }

  const candidates = await mapWithConcurrency(
    files,
    (item) => readBackupCandidate(item.filePath, item.sourceKind),
    8,
  );
  return candidates.filter(Boolean);
}

function sessionStatus(session) {
  if (session.hasRollout) return session.archived ? 'archived' : 'live';
  if (session.backupPaths?.length) return 'backup_only';
  if (session.sqliteIndexed) return 'sqlite_only';
  return 'index_only';
}

export async function buildSessionRegistry(codexHome, options = {}) {
  const env = options.env || process.env;
  const backupRoot = options.backupRoot
    || path.join(codexHome, 'backups', 'codex-claude-session-manager');
  const codexState = await resolveCodexState(codexHome, env);
  const [fileSessions, primaryDb, backups] = await Promise.all([
    listFileSessions(codexHome),
    readThreadRows(codexState.primaryStateDbPath),
    listBackupCandidates(codexHome, backupRoot, env),
  ]);

  const byId = new Map();
  for (const session of fileSessions) {
    if (!session.id) continue;
    byId.set(session.id, {
      ...session,
      indexTitle: session.indexed ? session.title : null,
      sqliteTitle: null,
      modelProvider: session.modelProvider || null,
      backupPaths: [],
      sqliteIndexed: false,
      sqliteRolloutPath: null,
      sqliteProvider: null,
      stateDbPath: codexState.primaryStateDbPath,
    });
  }

  for (const row of primaryDb.rows) {
    const existing = byId.get(row.id) || {
      id: row.id,
      index: null,
      title: '(untitled)',
      updatedAt: null,
      projectPath: null,
      rolloutPath: null,
      hasRollout: false,
      indexed: false,
      archived: row.archived,
      source: row.source,
      threadSource: null,
      modelProvider: null,
      indexTitle: null,
      sqliteTitle: row.title || null,
      backupPaths: [],
    };
    const rolloutExists = await isFile(row.rolloutPath);
    let rolloutMetadata = null;
    if (rolloutExists && !existing.hasRollout) {
      rolloutMetadata = await readRolloutMetadata(row.rolloutPath);
    }
    byId.set(row.id, {
      ...existing,
      title: existing.indexed && existing.title && existing.title !== '(untitled)'
        ? existing.title
        : row.title || existing.title,
      updatedAt: row.updatedAt || existing.updatedAt,
      projectPath: row.projectPath || rolloutMetadata?.projectPath || existing.projectPath,
      rolloutPath: rolloutExists ? row.rolloutPath : existing.rolloutPath,
      hasRollout: existing.hasRollout || rolloutExists,
      archived: existing.hasRollout ? existing.archived : row.archived,
      modelProvider: existing.modelProvider || rolloutMetadata?.modelProvider || null,
      sqliteIndexed: true,
      sqliteTitle: row.title || existing.sqliteTitle || null,
      sqliteRolloutPath: row.rolloutPath,
      sqliteProvider: row.modelProvider,
      stateDbPath: row.stateDbPath,
      sqliteSource: row.source,
    });
  }

  const backupsById = new Map();
  for (const backup of backups) {
    const list = backupsById.get(backup.id) || [];
    list.push(backup);
    backupsById.set(backup.id, list);
  }
  for (const [id, candidates] of backupsById) {
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const existing = byId.get(id) || {
      id,
      index: null,
      title: candidates[0].summary || '(untitled)',
      updatedAt: candidates[0].updatedAt,
      projectPath: candidates[0].projectPath,
      rolloutPath: null,
      hasRollout: false,
      indexed: false,
      archived: false,
      source: null,
      threadSource: null,
      modelProvider: null,
      indexTitle: null,
      sqliteTitle: null,
      sqliteIndexed: false,
      sqliteRolloutPath: null,
      sqliteProvider: null,
      stateDbPath: codexState.primaryStateDbPath,
    };
    byId.set(id, {
      ...existing,
      title: existing.title === '(untitled)' && candidates[0].summary
        ? candidates[0].summary
        : existing.title,
      updatedAt: existing.updatedAt || candidates[0].updatedAt,
      projectPath: existing.projectPath || candidates[0].projectPath,
      backupPaths: candidates,
      bestBackupPath: candidates[0].path,
      backupProvider: candidates[0].modelProvider,
    });
  }

  const sessions = [...byId.values()].map((session) => {
    const effectiveProvider = session.sqliteProvider || session.modelProvider || session.backupProvider || null;
    const codexVisible = Boolean(
      session.hasRollout
      && session.sqliteIndexed
      && session.sqliteProvider === codexState.currentProvider,
    );
    const merged = {
      ...session,
      currentProvider: codexState.currentProvider,
      effectiveProvider,
      codexVisible,
      storageStatus: sessionStatus(session),
      recoverableFromBackup: Boolean(
        !session.hasRollout
        && session.sqliteIndexed
        && session.sqliteRolloutPath
        && session.bestBackupPath
      ),
    };
    return {
      ...merged,
      health: summarizeSessionHealth(merged, { currentProvider: codexState.currentProvider }),
    };
  }).sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || '') || 0;
    const rightTime = Date.parse(right.updatedAt || '') || 0;
    return rightTime - leftTime;
  });

  return {
    codexHome,
    backupRoot,
    currentProvider: codexState.currentProvider,
    stateDbPath: codexState.primaryStateDbPath,
    stateDbPaths: codexState.stateDbPaths,
    sqliteAvailable: primaryDb.available,
    sqliteError: primaryDb.error || null,
    sessions,
    summary: {
      total: sessions.length,
      live: sessions.filter((session) => session.storageStatus === 'live').length,
      archived: sessions.filter((session) => session.storageStatus === 'archived').length,
      backupOnly: sessions.filter((session) => session.storageStatus === 'backup_only').length,
      sqliteOnly: sessions.filter((session) => session.storageStatus === 'sqlite_only').length,
      codexVisible: sessions.filter((session) => session.codexVisible).length,
      hiddenFromCodex: sessions.filter((session) => session.hasRollout && !session.codexVisible).length,
      recoverable: sessions.filter((session) => session.recoverableFromBackup).length,
    },
  };
}

async function fingerprint(filePath) {
  const info = await stat(filePath);
  return {
    size: info.size,
    mtimeMs: Math.trunc(info.mtimeMs),
  };
}

function isInsideSessionRoots(codexHome, filePath) {
  const key = normalizePathKey(filePath);
  return [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ].some((root) => {
    const rootKey = normalizePathKey(root);
    return key.startsWith(`${rootKey}${path.sep}`);
  });
}

function planTokenFor(plan) {
  const stable = {
    targetProvider: plan.targetProvider,
    stateDbPath: plan.stateDbPath,
    codexProcessCheck: {
      available: plan.codexProcessCheck.available,
      processIds: plan.codexProcessCheck.processes.map((item) => item.pid).sort((a, b) => a - b),
    },
    rolloutUpdates: plan.rolloutUpdates.map((item) => ({
      id: item.id,
      path: item.path,
      fingerprint: item.fingerprint,
    })),
    sqliteUpdates: plan.sqliteUpdates.map((item) => ({
      id: item.id,
      fromProvider: item.fromProvider,
    })),
    restores: plan.restores.map((item) => ({
      id: item.id,
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      fingerprint: item.fingerprint,
    })),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export async function previewCodexVisibilityRepair(codexHome, options = {}) {
  const [registry, codexProcessCheck] = await Promise.all([
    buildSessionRegistry(codexHome, options),
    resolveCodexProcessCheck(options),
  ]);
  const now = options.now instanceof Date ? options.now : new Date();
  const codexRunning = codexProcessCheck.processes.length > 0;
  const rolloutUpdates = [];
  const sqliteUpdates = [];
  const restores = [];
  const skippedActive = [];
  const unresolved = [];

  for (const session of registry.sessions) {
    if (session.hasRollout) {
      if (!session.sqliteIndexed) {
        unresolved.push({ id: session.id, reason: 'rollout_not_indexed' });
        continue;
      }
      const fileInfo = await fingerprint(session.rolloutPath);
      const recentlyModified = now.getTime() - fileInfo.mtimeMs < ACTIVE_WINDOW_MS;
      const needsRollout = session.modelProvider !== registry.currentProvider;
      const needsSqlite = session.sqliteProvider !== registry.currentProvider;
      if (!needsRollout && !needsSqlite) continue;
      // When process detection is unavailable, retain the conservative mtime
      // fallback. When it is available, all writes are blocked while Codex is
      // running, so a recently closed session can be repaired immediately.
      if (!codexProcessCheck.available && recentlyModified) {
        skippedActive.push({ id: session.id, path: session.rolloutPath });
        continue;
      }
      if (needsRollout) {
        rolloutUpdates.push({
          id: session.id,
          path: session.rolloutPath,
          fromProvider: session.modelProvider,
          fingerprint: fileInfo,
        });
      }
      if (needsSqlite) {
        sqliteUpdates.push({
          id: session.id,
          fromProvider: session.sqliteProvider,
        });
      }
      continue;
    }

    if (session.recoverableFromBackup) {
      if (!isInsideSessionRoots(codexHome, session.sqliteRolloutPath)) {
        unresolved.push({ id: session.id, reason: 'unsafe_restore_path' });
        continue;
      }
      restores.push({
        id: session.id,
        sourcePath: session.bestBackupPath,
        targetPath: session.sqliteRolloutPath,
        fromProvider: session.backupProvider,
        fingerprint: await fingerprint(session.bestBackupPath),
      });
      if (session.sqliteProvider !== registry.currentProvider) {
        sqliteUpdates.push({
          id: session.id,
          fromProvider: session.sqliteProvider,
        });
      }
      continue;
    }

    if (session.sqliteIndexed) {
      unresolved.push({ id: session.id, reason: 'rollout_missing_no_backup' });
    } else if (session.backupPaths?.length) {
      unresolved.push({ id: session.id, reason: 'backup_not_indexed' });
    }
  }

  const plan = {
    targetProvider: registry.currentProvider,
    stateDbPath: registry.stateDbPath,
    sqliteAvailable: registry.sqliteAvailable,
    codexProcessCheck,
    blockedByRunningCodex: codexRunning,
    canApply: Boolean(
      registry.sqliteAvailable
      && registry.stateDbPath
      && !codexRunning
    ),
    rolloutUpdates,
    sqliteUpdates,
    restores,
    skippedActive,
    unresolved,
    summary: {
      rolloutUpdates: rolloutUpdates.length,
      sqliteUpdates: sqliteUpdates.length,
      restores: restores.length,
      skippedActive: skippedActive.length,
      unresolved: unresolved.length,
      alreadyVisible: registry.summary.codexVisible,
      runningCodexProcesses: codexProcessCheck.processes.length,
    },
  };
  return {
    ...plan,
    planToken: planTokenFor(plan),
  };
}

async function assertFingerprint(filePath, expected) {
  const actual = await fingerprint(filePath);
  if (actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
    throw new CleanerError(
      'STALE_VISIBILITY_PLAN',
      'A session or backup changed after the visibility preview. Refresh the preview and try again.',
      409,
      { filePath, expected, actual },
    );
  }
}

async function rewriteRolloutProvider(filePath, sessionId, targetProvider) {
  const source = await readFile(filePath, 'utf8');
  const records = parseJsonl(source, filePath);
  const recordIndex = records.findIndex((record) => (
    record.data?.type === 'session_meta'
    && (record.data?.payload?.id === sessionId || record.data?.payload?.session_id === sessionId)
  ));
  if (recordIndex < 0) {
    throw new CleanerError(
      'SESSION_META_NOT_FOUND',
      'The rollout does not contain matching session metadata.',
      422,
      { filePath, sessionId },
    );
  }

  const current = records[recordIndex];
  const edited = {
    ...current,
    raw: null,
    data: structuredClone(current.data),
  };
  edited.data.payload = edited.data.payload || {};
  edited.data.payload.model_provider = targetProvider;
  records[recordIndex] = edited;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(source);
  await writeFileAtomically(
    filePath,
    serializeJsonlPreservingRaw(records, { newline, trailingNewline }),
  );
}

async function createVisibilityBackup(plan, backupRoot, now = new Date()) {
  const timestamp = now.toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
  const backupDir = path.join(backupRoot, `codex-visibility-sync-${timestamp}`);
  const jsonlDir = path.join(backupDir, 'jsonl');
  const stateDir = path.join(backupDir, 'state');
  await mkdir(jsonlDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const copied = [];
  for (const item of plan.rolloutUpdates) {
    const backupPath = path.join(jsonlDir, `${item.id}-${path.basename(item.path)}`);
    await copyFile(item.path, backupPath);
    copied.push({ id: item.id, source: item.path, backup: backupPath, fromProvider: item.fromProvider });
  }

  const sqlite = await loadSqliteModule({ required: true });
  const dbBackupPath = path.join(stateDir, path.basename(plan.stateDbPath));
  const sourceDb = new sqlite.DatabaseSync(plan.stateDbPath, { readOnly: true });
  try {
    sourceDb.exec('PRAGMA busy_timeout=2000');
    await sqlite.backup(sourceDb, dbBackupPath);
  } finally {
    sourceDb.close();
  }

  const manifestPath = path.join(backupDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    version: 2,
    kind: 'visibility-sync',
    createdAt: now.toISOString(),
    targetProvider: plan.targetProvider,
    stateDbPath: plan.stateDbPath,
    stateDbBackup: dbBackupPath,
    rolloutBackups: copied,
    sqliteProviderBackups: plan.sqliteUpdates.map((item) => ({
      id: item.id,
      fromProvider: item.fromProvider,
    })),
    restores: plan.restores,
    planToken: plan.planToken,
  }, null, 2), 'utf8');

  return {
    backupDir,
    manifestPath,
    stateDbBackup: dbBackupPath,
    copied,
  };
}

export async function applyCodexVisibilityRepair(codexHome, options = {}) {
  const preview = await previewCodexVisibilityRepair(codexHome, options);
  if (preview.blockedByRunningCodex) {
    throw new CleanerError(
      'CODEX_STILL_RUNNING',
      'Close every Codex window and terminal session, then refresh the visibility preview.',
      409,
      {
        processes: preview.codexProcessCheck.processes,
      },
    );
  }
  if (typeof options.planToken !== 'string' || options.planToken !== preview.planToken) {
    throw new CleanerError(
      'STALE_VISIBILITY_PLAN',
      'The visibility plan changed. Preview it again before applying.',
      409,
    );
  }
  if (!preview.canApply) {
    throw new CleanerError(
      'STATE_DB_UNAVAILABLE',
      preview.codexProcessCheck.available
        ? 'No writable Codex state database was found.'
        : 'Codex process detection is unavailable and no writable state database was found.',
      501,
      {
        stateDbPath: preview.stateDbPath,
        processCheckError: preview.codexProcessCheck.error || null,
      },
    );
  }

  const actionCount = preview.rolloutUpdates.length
    + preview.sqliteUpdates.length
    + preview.restores.length;
  if (!actionCount) {
    return {
      preview,
      noOp: true,
      message: 'All recoverable sessions are already visible to the current Codex provider.',
    };
  }

  for (const item of preview.rolloutUpdates) {
    await assertFingerprint(item.path, item.fingerprint);
  }
  for (const item of preview.restores) {
    await assertFingerprint(item.sourcePath, item.fingerprint);
    if (await isFile(item.targetPath)) {
      throw new CleanerError(
        'RESTORE_TARGET_EXISTS',
        'A missing rollout reappeared after preview. Refresh before applying.',
        409,
        { targetPath: item.targetPath },
      );
    }
  }

  const backupRoot = options.backupRoot
    || path.join(codexHome, 'backups', 'codex-claude-session-manager');
  const backup = await createVisibilityBackup(preview, backupRoot, options.now || new Date());
  const backupBySource = new Map(backup.copied.map((item) => [normalizePathKey(item.source), item.backup]));
  const restoredTargets = [];
  const changedFiles = [];
  let db;
  let transactionStarted = false;

  try {
    for (const item of preview.rolloutUpdates) {
      await rewriteRolloutProvider(item.path, item.id, preview.targetProvider);
      changedFiles.push(item.path);
    }

    for (const item of preview.restores) {
      await mkdir(path.dirname(item.targetPath), { recursive: true });
      await copyFile(item.sourcePath, item.targetPath);
      restoredTargets.push(item.targetPath);
      const metadata = await readRolloutMetadata(item.targetPath);
      if (metadata.id !== item.id) {
        throw new CleanerError(
          'BACKUP_SESSION_MISMATCH',
          'A backup rollout does not match the SQLite thread it would restore.',
          422,
          { expectedId: item.id, actualId: metadata.id },
        );
      }
      await rewriteRolloutProvider(item.targetPath, item.id, preview.targetProvider);
    }

    const sqlite = await loadSqliteModule({ required: true });
    db = new sqlite.DatabaseSync(preview.stateDbPath);
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const update = db.prepare('UPDATE threads SET model_provider = ? WHERE id = ?');
    const ids = new Set([
      ...preview.sqliteUpdates.map((item) => item.id),
      ...preview.rolloutUpdates.map((item) => item.id),
      ...preview.restores.map((item) => item.id),
    ]);
    for (const id of ids) {
      const result = update.run(preview.targetProvider, id);
      if (Number(result.changes) !== 1) {
        throw new CleanerError(
          'SQLITE_THREAD_NOT_FOUND',
          'A planned Codex thread was not found while applying visibility repair.',
          409,
          { id },
        );
      }
    }
    db.exec('COMMIT');
    transactionStarted = false;

    return {
      preview,
      noOp: false,
      backup,
      changedRollouts: preview.rolloutUpdates.length,
      restoredRollouts: preview.restores.length,
      changedSqliteRows: ids.size,
      restartRequired: true,
    };
  } catch (error) {
    if (transactionStarted) {
      try {
        db?.exec('ROLLBACK');
      } catch {
        // Preserve the original failure; the consistent DB backup is reported below.
      }
    }
    const rollbackErrors = [];
    for (const filePath of changedFiles) {
      const backupPath = backupBySource.get(normalizePathKey(filePath));
      if (!backupPath) continue;
      try {
        await copyFile(backupPath, filePath);
      } catch (rollbackError) {
        rollbackErrors.push({ filePath, message: rollbackError.message });
      }
    }
    for (const targetPath of restoredTargets) {
      try {
        await unlink(targetPath);
      } catch (rollbackError) {
        if (rollbackError?.code !== 'ENOENT') {
          rollbackErrors.push({ filePath: targetPath, message: rollbackError.message });
        }
      }
    }
    if (error instanceof CleanerError) {
      error.details = {
        ...error.details,
        backupDir: backup.backupDir,
        rollbackErrors,
      };
      throw error;
    }
    throw new CleanerError(
      'VISIBILITY_SYNC_FAILED',
      'Codex visibility repair failed. Modified rollout files were rolled back where possible.',
      500,
      {
        cause: error.message,
        backupDir: backup.backupDir,
        rollbackErrors,
      },
    );
  } finally {
    db?.close();
  }
}
