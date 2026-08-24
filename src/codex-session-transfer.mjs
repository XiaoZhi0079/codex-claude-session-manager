import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

import {
  CleanerError,
  listSessions,
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
  invalidateThreadHistory,
  inspectTargetSessionLocks,
  withTargetSessionLocks,
} from './codex-thread-history.mjs';

const execFileAsync = promisify(execFile);
const FORMAT = 'ccsm-codex-session-transfer';
const FORMAT_VERSION = 1;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const MAX_ROLLOUT_BYTES = 512 * 1024 * 1024;
const TRANSFER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_GIT_EXCLUDES = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'target', 'coverage',
  '.cache', '.next', '.nuxt', '.turbo', '.venv', 'venv', '__pycache__',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function loadSqlite() {
  try { return await import('node:sqlite'); } catch (error) {
    throw new CleanerError('SQLITE_UNAVAILABLE', 'Session transfer requires Node.js 22.5 or newer with node:sqlite.', 501, { cause: error.message });
  }
}

function normalizePathKey(value) {
  const normalized = path.resolve(nativePath(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function nativePath(value) {
  let text = String(value || '').trim();
  if (process.platform === 'win32') {
    if (/^\\\\\?\\UNC\\/i.test(text)) text = `\\\\${text.slice(8)}`;
    else if (/^\\\\\?\\/i.test(text)) text = text.slice(4);
  }
  return path.normalize(text);
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(nativePath(root)), path.resolve(nativePath(candidate)));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function hashFiles(root, relativeFiles, kind, git = {}) {
  const hash = createHash('sha256');
  let bytes = 0;
  let files = 0;
  const sorted = [...new Set(relativeFiles.map((item) => String(item).replaceAll('\\', '/')))].sort();
  for (const relative of sorted) {
    if (!relative || relative.includes('\0')) continue;
    const target = path.resolve(root, relative);
    if (!isInside(root, target)) continue;
    let info;
    try { info = await lstat(target); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      const link = await readlink(target);
      hash.update(`symlink\0${relative}\0${link}\0`);
      files += 1;
      continue;
    }
    if (!info.isFile()) continue;
    hash.update(`file\0${relative}\0${info.size}\0`);
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    hash.update('\0');
    bytes += info.size;
    files += 1;
  }
  return { available: true, kind, digest: hash.digest('hex'), files, bytes, ...git };
}

async function gitOutput(cwd, args, options = {}) {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: options.encoding || 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

async function nonGitFiles(root) {
  const output = [];
  async function visit(directory, relativeRoot = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && NON_GIT_EXCLUDES.has(entry.name.toLowerCase())) continue;
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, relative);
      else if (entry.isFile()) output.push(relative);
      if (output.length > 100_000) {
        throw new CleanerError('PROJECT_TOO_LARGE_TO_FINGERPRINT', 'The non-Git project contains more than 100,000 relevant files.', 422, { projectPath: root });
      }
    }
  }
  await visit(root);
  return output;
}

export async function fingerprintProject(projectPath) {
  const root = path.resolve(String(projectPath || ''));
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    return { available: false, kind: 'unavailable', reason: error?.code === 'ENOENT' ? 'directory_missing' : 'directory_unreadable' };
  }
  try {
    const gitRoot = String(await gitOutput(root, ['rev-parse', '--show-toplevel'])).trim();
    const [head, branch, remote, rawFiles] = await Promise.all([
      gitOutput(root, ['rev-parse', 'HEAD']).then((value) => value.trim()),
      gitOutput(root, ['branch', '--show-current']).then((value) => value.trim()),
      gitOutput(root, ['config', '--get', 'remote.origin.url']).then((value) => value.trim()).catch(() => ''),
      gitOutput(root, ['ls-files', '-co', '--exclude-standard', '-z']),
    ]);
    const files = rawFiles.split('\0').filter(Boolean);
    return hashFiles(root, files, 'git', { head, branch, remote: remote || null, repositoryRoot: gitRoot });
  } catch {
    try {
      return await hashFiles(root, await nonGitFiles(root), 'files');
    } catch (error) {
      return { available: false, kind: 'files', reason: 'fingerprint_failed', error: error.message };
    }
  }
}

function packageSchema(db) {
  db.exec(`
    CREATE TABLE bundle_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      archived INTEGER NOT NULL,
      project_path TEXT,
      source_provider TEXT,
      rollout_name TEXT NOT NULL,
      rollout_relative_path TEXT NOT NULL,
      rollout_sha256 TEXT NOT NULL,
      rollout_canonical_sha256 TEXT NOT NULL,
      rollout_bytes INTEGER NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      thread_source TEXT,
      project_fingerprint_json TEXT,
      rollout_gzip BLOB NOT NULL
    );
    CREATE TABLE thread_edges (parent_id TEXT NOT NULL, child_id TEXT NOT NULL, relation TEXT NOT NULL);
  `);
}

function canonicalRolloutHash(source, label = 'rollout') {
  const records = parseJsonl(Buffer.isBuffer(source) ? source.toString('utf8') : String(source), label);
  const normalized = records.map((record) => {
    const data = structuredClone(record.data);
    if (data?.type === 'session_meta') {
      const payload = data.payload || data;
      for (const key of ['cwd', 'project_path', 'projectPath', 'workspace', 'model_provider', 'modelProvider']) {
        if (key in payload) payload[key] = '';
      }
    }
    return JSON.stringify(data);
  }).join('\n');
  return sha256(normalized);
}

function safeRelativeRollout(codexHome, session) {
  const relative = path.relative(nativePath(codexHome), nativePath(session.rolloutPath)).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new CleanerError('UNSAFE_ROLLOUT_PATH', 'A selected rollout is outside the Codex data directory.', 422, {
      sessionId: session.id,
      rolloutPath: session.rolloutPath,
      codexHome,
    });
  }
  if (!relative.startsWith('sessions/') && !relative.startsWith('archived_sessions/')) {
    throw new CleanerError('UNSUPPORTED_ROLLOUT_LOCATION', 'Only formal sessions and archived_sessions rollouts can be exported.', 422, { sessionId: session.id });
  }
  return relative;
}

export async function createCodexSessionPackage(codexHome, options = {}) {
  const ids = [...new Set((options.sessionIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new CleanerError('MISSING_EXPORT_SESSIONS', 'Select one or more Codex sessions to export.', 400);
  const [registry, fileSessions] = await Promise.all([
    buildSessionRegistry(codexHome, options),
    listSessions(codexHome),
  ]);
  const byId = new Map(registry.sessions.map((session) => [session.id, session]));
  const formalById = new Map(fileSessions.filter((session) => session.hasRollout).map((session) => [session.id, session]));
  const sessions = ids.map((id) => {
    const registrySession = byId.get(id);
    const formalSession = formalById.get(id);
    if (!registrySession || !formalSession) return registrySession;
    return {
      ...registrySession,
      rolloutPath: formalSession.rolloutPath,
      archived: formalSession.archived,
      hasRollout: true,
    };
  });
  const invalid = ids.filter((id, index) => !sessions[index]?.hasRollout || !sessions[index]?.rolloutPath);
  if (invalid.length) throw new CleanerError('SESSION_NOT_EXPORTABLE', 'Only sessions with a formal rollout can be exported.', 422, { sessionIds: invalid });

  const projectPaths = [...new Set(sessions.map((session) => session.projectPath).filter(Boolean))];
  const fingerprints = new Map();
  for (const projectPath of projectPaths) fingerprints.set(projectPath, await fingerprintProject(projectPath));

  const transferRoot = options.transferRoot || path.join(codexHome, 'backups', 'codex-claude-session-manager', 'transfers');
  const exportDir = path.join(transferRoot, 'exports');
  await mkdir(exportDir, { recursive: true });
  const packagePath = path.join(exportDir, `${randomUUID()}.ccsm`);
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(packagePath);
  let buildError = null;
  try {
    packageSchema(db);
    const insertMeta = db.prepare('INSERT INTO bundle_meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries({ format: FORMAT, format_version: String(FORMAT_VERSION), created_at: new Date().toISOString(), session_count: String(sessions.length) })) {
      insertMeta.run(key, value);
    }
    const insert = db.prepare(`INSERT INTO sessions (
      id, title, archived, project_path, source_provider, rollout_name, rollout_relative_path,
      rollout_sha256, rollout_canonical_sha256, rollout_bytes, created_at, updated_at, thread_source,
      project_fingerprint_json, rollout_gzip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const session of sessions) {
      const source = await readFile(session.rolloutPath);
      if (source.length > MAX_ROLLOUT_BYTES) throw new CleanerError('ROLLOUT_TOO_LARGE', 'A selected rollout exceeds the 512 MB transfer limit.', 413, { sessionId: session.id });
      const metadata = await readRolloutMetadata(session.rolloutPath);
      if (metadata.id !== session.id) throw new CleanerError('SESSION_ROLLOUT_MISMATCH', 'A selected rollout does not match its session ID.', 422, { sessionId: session.id, rolloutSessionId: metadata.id });
      parseJsonl(source.toString('utf8'), session.rolloutPath);
      const info = await stat(session.rolloutPath);
      insert.run(
        session.id, session.title || metadata.summary || '(untitled)', Number(Boolean(session.archived)),
        session.projectPath || metadata.projectPath || null, metadata.modelProvider || session.modelProvider || null,
        path.basename(session.rolloutPath), safeRelativeRollout(codexHome, session), sha256(source), canonicalRolloutHash(source, session.rolloutPath), source.length,
        metadata.timestamp || info.birthtime.toISOString(), session.updatedAt || info.mtime.toISOString(),
        session.threadSource || metadata.threadSource || 'user',
        JSON.stringify(fingerprints.get(session.projectPath) || { available: false, kind: 'unavailable', reason: 'project_path_missing' }),
        gzipSync(source),
      );
    }
  } catch (error) {
    buildError = error;
  } finally {
    db.close();
  }
  if (buildError) {
    await unlink(packagePath).catch(() => {});
    throw buildError;
  }
  const packageBytes = (await stat(packagePath)).size;
  if (packageBytes > MAX_PACKAGE_BYTES) {
    await unlink(packagePath).catch(() => {});
    throw new CleanerError('TRANSFER_PACKAGE_TOO_LARGE', 'The generated transfer package exceeds the 1 GB limit.', 413);
  }
  const result = {
    contentType: 'application/vnd.ccsm.session-transfer',
    fileName: `codex-sessions-${new Date().toISOString().slice(0, 10)}.ccsm`,
    sessionCount: sessions.length,
    sizeBytes: packageBytes,
  };
  if (options.keepFile) return { ...result, filePath: packagePath };
  const content = await readFile(packagePath);
  await unlink(packagePath).catch(() => {});
  return { ...result, content };
}

function requireTransferPath(transferRoot, transferId) {
  if (!TRANSFER_ID_RE.test(String(transferId || ''))) throw new CleanerError('INVALID_TRANSFER_ID', 'The session-transfer identifier is invalid.', 400);
  const target = path.join(transferRoot, 'staging', `${transferId}.ccsm`);
  if (!isInside(transferRoot, target)) throw new CleanerError('UNSAFE_TRANSFER_PATH', 'The staged transfer path is unsafe.', 422);
  return target;
}

function readPackageRows(packagePath) {
  return loadSqlite().then((sqlite) => {
    let db;
    try {
      db = new sqlite.DatabaseSync(packagePath, { readOnly: true });
      const meta = Object.fromEntries(db.prepare('SELECT key, value FROM bundle_meta').all().map((row) => [row.key, row.value]));
      if (meta.format !== FORMAT || Number(meta.format_version) !== FORMAT_VERSION) {
        throw new CleanerError('UNSUPPORTED_TRANSFER_FORMAT', 'This is not a supported Codex session-transfer package.', 422, { format: meta.format, version: meta.format_version });
      }
      const count = Number(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count);
      if (!count) throw new CleanerError('EMPTY_TRANSFER_PACKAGE', 'The transfer package contains no sessions.', 422);
      if (count > 5_000) throw new CleanerError('TRANSFER_SESSION_LIMIT', 'A transfer package may contain at most 5,000 sessions.', 422, { count });
      const rows = db.prepare(`SELECT
        id, title, archived, project_path, source_provider, rollout_name, rollout_relative_path,
        rollout_sha256, rollout_canonical_sha256, rollout_bytes, created_at, updated_at, thread_source, project_fingerprint_json
        FROM sessions ORDER BY updated_at DESC`).all();
      for (const row of rows) {
        if (!SESSION_ID_RE.test(String(row.id || ''))) throw new CleanerError('INVALID_TRANSFER_SESSION_ID', 'A transfer package contains an invalid session ID.', 422, { sessionId: row.id });
        if (String(row.title || '').length > 2_000 || String(row.project_path || '').length > 32_000 || Number(row.rollout_bytes) < 1 || Number(row.rollout_bytes) > MAX_ROLLOUT_BYTES) {
          throw new CleanerError('INVALID_TRANSFER_SESSION_METADATA', 'A transfer package contains invalid session metadata or size declarations.', 422, { sessionId: row.id });
        }
      }
      return { meta, rows };
    } catch (error) {
      if (error instanceof CleanerError) throw error;
      throw new CleanerError('INVALID_TRANSFER_PACKAGE', 'The selected file is not a valid session-transfer package.', 422, { cause: error.message });
    } finally {
      db?.close();
    }
  });
}

function publicPackageSession(row) {
  return {
    id: String(row.id), title: row.title || '(untitled)', archived: Boolean(row.archived),
    projectPath: row.project_path || null, provider: row.source_provider || null,
    bytes: Number(row.rollout_bytes), createdAt: row.created_at || null, updatedAt: row.updated_at || null,
    threadSource: row.thread_source || 'user',
    rolloutSha256: row.rollout_sha256,
    projectFingerprint: parseProjectFingerprint(row.project_fingerprint_json, row.id),
  };
}

function parseProjectFingerprint(value, sessionId) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new CleanerError('INVALID_PROJECT_FINGERPRINT', 'A project fingerprint in the transfer package is invalid.', 422, { sessionId });
  }
}

async function validatePackageRows(packagePath, rows) {
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(packagePath, { readOnly: true });
  try {
    for (const row of rows) {
      const compressed = db.prepare('SELECT rollout_gzip FROM sessions WHERE id = ?').get(row.id)?.rollout_gzip;
      let source;
      try { source = gunzipSync(compressed, { maxOutputLength: MAX_ROLLOUT_BYTES + 1 }); } catch (error) {
        throw new CleanerError('CORRUPT_TRANSFER_ROLLOUT', 'A compressed rollout in the transfer package is damaged.', 422, { sessionId: row.id, cause: error.message });
      }
      if (source.length !== Number(row.rollout_bytes)
        || sha256(source) !== row.rollout_sha256
        || canonicalRolloutHash(source, `transfer:${row.id}`) !== row.rollout_canonical_sha256) {
        throw new CleanerError('TRANSFER_CHECKSUM_MISMATCH', 'A rollout checksum in the transfer package does not match.', 422, { sessionId: row.id });
      }
      const records = parseJsonl(source.toString('utf8'), `transfer:${row.id}`);
      const meta = records.find((record) => record.data?.type === 'session_meta')?.data?.payload;
      if ((meta?.id || meta?.session_id) !== row.id) throw new CleanerError('TRANSFER_SESSION_MISMATCH', 'A rollout does not match its transfer manifest.', 422, { sessionId: row.id });
    }
  } finally { db.close(); }
}

export async function stageCodexSessionPackage(content, transferRoot) {
  if (!Buffer.isBuffer(content) || content.length < 16) throw new CleanerError('EMPTY_TRANSFER_UPLOAD', 'Select a non-empty .ccsm file.', 400);
  if (content.length > MAX_PACKAGE_BYTES) throw new CleanerError('TRANSFER_PACKAGE_TOO_LARGE', 'The transfer package exceeds the 1 GB limit.', 413);
  if (content.subarray(0, 15).toString('utf8') !== 'SQLite format 3') throw new CleanerError('INVALID_TRANSFER_PACKAGE', 'The selected file is not a .ccsm SQLite package.', 422);
  const transferId = randomUUID();
  const packagePath = requireTransferPath(transferRoot, transferId);
  await mkdir(path.dirname(packagePath), { recursive: true });
  await writeFile(packagePath, content, { flag: 'wx' });
  try { return await inspectStagedPackage(packagePath, transferId); } catch (error) {
    await unlink(packagePath).catch(() => {});
    throw error;
  }
}

async function inspectStagedPackage(packagePath, transferId) {
  const header = Buffer.alloc(15);
  const handle = await open(packagePath, 'r');
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (header.toString('utf8') !== 'SQLite format 3') throw new CleanerError('INVALID_TRANSFER_PACKAGE', 'The selected file is not a .ccsm SQLite package.', 422);
  const pkg = await readPackageRows(packagePath);
  await validatePackageRows(packagePath, pkg.rows);
  const projects = [...new Map(pkg.rows.map((row) => [row.project_path || '', {
    sourcePath: row.project_path || null,
    fingerprint: parseProjectFingerprint(row.project_fingerprint_json, row.id),
    sessionCount: pkg.rows.filter((item) => item.project_path === row.project_path).length,
  }])).values()];
  await Promise.all(projects.map(async (project) => {
    if (!project.sourcePath) return;
    const candidate = path.resolve(nativePath(project.sourcePath));
    const info = await stat(candidate).catch(() => null);
    if (info?.isDirectory()) project.suggestedTargetPath = candidate;
  }));
  return {
    transferId,
    createdAt: pkg.meta.created_at || null,
    sessions: pkg.rows.map(publicPackageSession),
    projects,
  };
}

export async function stageCodexSessionPackageStream(readable, transferRoot, options = {}) {
  const declaredBytes = Number(options.declaredBytes || 0);
  if (declaredBytes > MAX_PACKAGE_BYTES) throw new CleanerError('TRANSFER_PACKAGE_TOO_LARGE', 'The transfer package exceeds the 1 GB limit.', 413);
  const transferId = randomUUID();
  const packagePath = requireTransferPath(transferRoot, transferId);
  await mkdir(path.dirname(packagePath), { recursive: true });
  let totalBytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        callback(new CleanerError('TRANSFER_PACKAGE_TOO_LARGE', 'The transfer package exceeds the 1 GB limit.', 413));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(readable, limiter, createWriteStream(packagePath, { flags: 'wx' }));
    if (totalBytes < 16) throw new CleanerError('EMPTY_TRANSFER_UPLOAD', 'Select a non-empty .ccsm file.', 400);
    return await inspectStagedPackage(packagePath, transferId);
  } catch (error) {
    await unlink(packagePath).catch(() => {});
    throw error;
  }
}

function rewriteSessionMeta(source, sessionId, targetProjectPath, provider) {
  const records = parseJsonl(source.toString('utf8'), `transfer:${sessionId}`);
  const index = records.findIndex((record) => record.data?.type === 'session_meta');
  if (index < 0) throw new CleanerError('SESSION_META_NOT_FOUND', 'The transferred rollout has no session metadata.', 422, { sessionId });
  const edited = { ...records[index], raw: null, data: structuredClone(records[index].data) };
  const payload = edited.data.payload || edited.data;
  if (targetProjectPath) payload.cwd = targetProjectPath;
  payload.model_provider = provider;
  records[index] = edited;
  return Buffer.from(serializeJsonlPreservingRaw(records, {
    newline: source.includes(Buffer.from('\r\n')) ? '\r\n' : '\n',
    trailingNewline: source.at(-1) === 10,
  }), 'utf8');
}

function mappedPath(mappings, sourcePath) {
  const entry = (mappings || []).find((item) => normalizePathKey(item.sourcePath) === normalizePathKey(sourcePath));
  return entry?.targetPath ? path.resolve(entry.targetPath) : null;
}

async function currentRolloutHash(filePath) {
  try { return sha256(await readFile(filePath)); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function currentCanonicalRolloutHash(filePath) {
  try {
    const source = await readFile(filePath);
    return { raw: sha256(source), canonical: canonicalRolloutHash(source, filePath) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function planToken(plan) {
  return sha256(JSON.stringify({
    transferId: plan.transferId, mode: plan.mode, packageBytes: plan.packageBytes,
    currentProvider: plan.currentProvider, stateDbPath: plan.stateDbPath,
    sessions: plan.sessions.map((item) => ({
      id: item.id,
      rolloutSha256: item.rolloutSha256,
      action: item.action,
      rolloutTarget: item.rolloutTarget,
      targetProjectPath: item.targetProjectPath,
      projectState: item.projectState,
    })),
  }));
}

export async function previewCodexSessionImport(codexHome, options = {}) {
  const mode = options.mode === 'history' ? 'history' : 'resume';
  const packagePath = requireTransferPath(options.transferRoot, options.transferId);
  const packageInfo = await stat(packagePath).catch(() => null);
  if (!packageInfo?.isFile()) throw new CleanerError('TRANSFER_NOT_FOUND', 'The staged session-transfer package was not found.', 404);
  const [{ rows }, registry] = await Promise.all([readPackageRows(packagePath), buildSessionRegistry(codexHome, options)]);
  await validatePackageRows(packagePath, rows);
  const existingById = new Map(registry.sessions.map((session) => [session.id, session]));
  const fingerprintCache = new Map();
  const sessions = [];
  for (const row of rows) {
    const sourceFingerprint = parseProjectFingerprint(row.project_fingerprint_json, row.id);
    const targetProjectPath = row.project_path ? mappedPath(options.pathMappings, row.project_path) : null;
    let targetFingerprint = null;
    let projectState = row.project_path ? 'mapping_required' : 'not_applicable';
    if (targetProjectPath) {
      if (!fingerprintCache.has(targetProjectPath)) fingerprintCache.set(targetProjectPath, await fingerprintProject(targetProjectPath));
      targetFingerprint = fingerprintCache.get(targetProjectPath);
      projectState = sourceFingerprint.available && targetFingerprint.available && sourceFingerprint.digest === targetFingerprint.digest
        ? 'matched'
        : 'mismatch';
    }
    const relative = String(row.rollout_relative_path || '').replaceAll('\\', '/');
    if (relative.startsWith('../') || (!relative.startsWith('sessions/') && !relative.startsWith('archived_sessions/'))) {
      throw new CleanerError('UNSAFE_TRANSFER_ROLLOUT_PATH', 'A rollout path in the transfer package is unsafe.', 422, { sessionId: row.id });
    }
    let rolloutTarget = path.resolve(codexHome, ...relative.split('/'));
    if (!isInside(codexHome, rolloutTarget)) throw new CleanerError('UNSAFE_TRANSFER_ROLLOUT_PATH', 'A rollout target escaped Codex storage.', 422, { sessionId: row.id });
    const existing = existingById.get(String(row.id));
    const existingFingerprint = existing?.rolloutPath
      ? await currentCanonicalRolloutHash(existing.rolloutPath)
      : await currentCanonicalRolloutHash(rolloutTarget);
    const sameContent = existingFingerprint && (
      existingFingerprint.raw === row.rollout_sha256
      || existingFingerprint.canonical === row.rollout_canonical_sha256
    );
    const metadataConflict = Boolean(existing && !existingFingerprint && (existing.sqliteIndexed || existing.indexed));
    if (sameContent && existing?.rolloutPath) rolloutTarget = existing.rolloutPath;
    const action = sameContent
      ? (mode === 'resume' && !existing?.sqliteIndexed ? 'activate' : 'already_present')
      : (existingFingerprint || metadataConflict ? 'conflict' : 'import');
    sessions.push({
      ...publicPackageSession(row), targetProjectPath, targetFingerprint, projectState,
      rolloutTarget, action, existingRolloutPath: existing?.rolloutPath || null,
    });
  }
  const locks = options.sessionLocksHeld
    ? { available: true, sessions: [], activeSessionIds: [], heldByCleaner: true }
    : await inspectTargetSessionLocks(codexHome, sessions.filter((item) => item.action === 'import' || item.action === 'activate').map((item) => item.id), options);
  const summary = {
    sessions: sessions.length,
    importable: sessions.filter((item) => item.action === 'import' || item.action === 'activate').length,
    activations: sessions.filter((item) => item.action === 'activate').length,
    alreadyPresent: sessions.filter((item) => item.action === 'already_present').length,
    conflicts: sessions.filter((item) => item.action === 'conflict').length,
    projectMatches: sessions.filter((item) => item.projectState === 'matched' || item.projectState === 'not_applicable').length,
    projectMappingsRequired: sessions.filter((item) => item.projectState === 'mapping_required').length,
    projectContentMismatches: sessions.filter((item) => item.projectState === 'mismatch').length,
    projectMismatches: sessions.filter((item) => !['matched', 'not_applicable'].includes(item.projectState)).length,
  };
  const plan = {
    transferId: options.transferId, mode, packagePath, packageBytes: packageInfo.size,
    currentProvider: registry.currentProvider, stateDbPath: registry.stateDbPath,
    sessions, summary, targetSessionLock: locks,
    canApply: summary.importable > 0 && summary.conflicts === 0 && locks.activeSessionIds.length === 0
      && (mode === 'history' || (summary.projectMismatches === 0 && registry.sqliteAvailable && Boolean(registry.stateDbPath))),
  };
  return { ...plan, planToken: planToken(plan) };
}

function threadRow(session, provider) {
  const createdMs = Date.parse(session.createdAt || '') || Date.now();
  const updatedMs = Date.parse(session.updatedAt || '') || createdMs;
  return {
    id: session.id,
    rollout_path: session.rolloutTarget,
    created_at: Math.trunc(createdMs / 1000),
    updated_at: Math.trunc(updatedMs / 1000),
    source: 'cli',
    model_provider: provider,
    cwd: session.targetProjectPath || '',
    title: session.title || '(untitled)',
    sandbox_policy: JSON.stringify({ type: 'disabled' }),
    approval_mode: 'never', tokens_used: 0, has_user_event: 0,
    archived: Number(Boolean(session.archived)), archived_at: session.archived ? Math.trunc(updatedMs / 1000) : null,
    git_sha: session.targetFingerprint?.head || null,
    git_branch: session.targetFingerprint?.branch || null,
    git_origin_url: session.targetFingerprint?.remote || null,
    cli_version: '', first_user_message: session.title || '(untitled)',
    agent_nickname: null, agent_role: null, memory_mode: 'enabled', model: null,
    reasoning_effort: null, agent_path: null, created_at_ms: createdMs, updated_at_ms: updatedMs,
    thread_source: session.threadSource || 'user', preview: session.title || '(untitled)', recency_at: Math.trunc(updatedMs / 1000),
    recency_at_ms: updatedMs, history_mode: 'legacy', name: null, is_pinned: 0,
  };
}

function insertThreads(db, sessions, provider) {
  const definitions = db.prepare('PRAGMA table_info(threads)').all();
  const columns = new Set(definitions.map((item) => item.name));
  for (const session of sessions) {
    const row = threadRow(session, provider);
    const missingRequired = definitions.filter((column) => column.notnull && column.dflt_value == null && !column.pk && !(column.name in row));
    if (missingRequired.length) throw new CleanerError('UNSUPPORTED_CODEX_SCHEMA', 'The current Codex database has required thread fields this tool cannot safely synthesize.', 409, { columns: missingRequired.map((item) => item.name) });
    const names = Object.keys(row).filter((name) => columns.has(name));
    db.prepare(`INSERT INTO threads (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((name) => row[name] ?? null));
  }
}

async function packageRollouts(packagePath, sessions, provider) {
  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(packagePath, { readOnly: true });
  try {
    return sessions.map((session) => {
      const compressed = db.prepare('SELECT rollout_gzip FROM sessions WHERE id = ?').get(session.id)?.rollout_gzip;
      return {
        session,
        content: rewriteSessionMeta(
          gunzipSync(compressed, { maxOutputLength: MAX_ROLLOUT_BYTES + 1 }),
          session.id,
          session.targetProjectPath,
          provider,
        ),
      };
    });
  } finally { db.close(); }
}

function appendIndexRows(source, sessions) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trimmed = source.replace(/(?:\r?\n)+$/, '');
  const additions = sessions.map((session) => JSON.stringify({ id: session.id, thread_name: session.title || '(untitled)', updated_at: session.updatedAt || new Date().toISOString() })).join(newline);
  return `${trimmed}${trimmed ? newline : ''}${additions}${additions ? newline : ''}`;
}

export async function applyCodexSessionImport(codexHome, options = {}) {
  const preview = await previewCodexSessionImport(codexHome, options);
  const targets = preview.sessions.filter((item) => item.action === 'import' || item.action === 'activate');
  if (!options.sessionLocksHeld) {
    return withTargetSessionLocks(codexHome, targets.map((item) => item.id), {
      ...options,
      errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
    }, () => applyCodexSessionImport(codexHome, { ...options, sessionLocksHeld: true }));
  }
  if (options.planToken !== preview.planToken) throw new CleanerError('STALE_IMPORT_PLAN', 'The transfer package, project, or Codex state changed after preview.', 409);
  if (!preview.canApply) throw new CleanerError('SESSION_IMPORT_BLOCKED', 'The session import cannot be applied safely. Resolve project mismatches, conflicts, or active sessions first.', 422, { summary: preview.summary });
  if (preview.mode === 'resume') {
    const check = options.codexProcessCheck || await detectRunningCodexProcesses();
    if (check.available && check.processes.length) throw new CleanerError('CODEX_STILL_RUNNING', 'Close Codex before importing resumable sessions.', 409, { processes: check.processes });
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const backupRoot = options.backupRoot || path.join(codexHome, 'backups', 'codex-claude-session-manager');
  const safetyDir = path.join(backupRoot, 'restore-points', `session-import-${now.toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID()}`);
  await mkdir(safetyDir, { recursive: true });
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  let indexSource = '';
  try { indexSource = await readFile(indexPath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const payloads = await packageRollouts(
    preview.packagePath,
    targets.filter((item) => item.action === 'import'),
    preview.currentProvider,
  );
  const created = [];
  let indexChanged = false;
  let db;
  let transaction = false;
  try {
    for (const item of payloads) {
      await mkdir(path.dirname(item.session.rolloutTarget), { recursive: true });
      await writeFileAtomically(item.session.rolloutTarget, item.content);
      created.push({ id: item.session.id, path: item.session.rolloutTarget, sha256: sha256(item.content) });
    }
    if (preview.mode === 'resume') {
      const sqlite = await loadSqlite();
      db = new sqlite.DatabaseSync(preview.stateDbPath);
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
      insertThreads(db, targets, preview.currentProvider);
      await writeFileAtomically(indexPath, appendIndexRows(indexSource, targets));
      indexChanged = true;
      await invalidateThreadHistory(codexHome, targets.map((item) => item.id), options);
      db.exec('COMMIT');
      transaction = false;
    }
    const manifestPath = path.join(safetyDir, 'import-manifest.json');
    const rolloutChecks = [];
    for (const session of targets) {
      rolloutChecks.push({ id: session.id, path: session.rolloutTarget, sha256: await currentRolloutHash(session.rolloutTarget) });
    }
    await writeFile(manifestPath, JSON.stringify({
      kind: 'codex-session-import', createdAt: now.toISOString(), mode: preview.mode,
      stateDbPath: preview.stateDbPath, indexPath, indexBeforeSha256: sha256(indexSource),
      indexRowsAdded: preview.mode === 'resume' ? targets.map((item) => item.id) : [],
      rolloutChecks,
      created,
    }, null, 2), 'utf8');
    return { preview, imported: preview.summary, manifestPath, restartRequired: preview.mode === 'resume' };
  } catch (error) {
    if (transaction) { try { db?.exec('ROLLBACK'); } catch {} }
    if (indexChanged) await writeFileAtomically(indexPath, indexSource).catch(() => {});
    for (const item of created) await unlink(item.path).catch(() => {});
    throw error;
  } finally { db?.close(); }
}

function removeIndexRows(source, ids) {
  const selected = new Set(ids);
  const trailing = /\r?\n$/.test(source);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const kept = lines.filter((line) => {
    try {
      const data = JSON.parse(line);
      return !selected.has(data.id || data.session_id || data.thread_id);
    } catch { return true; }
  });
  return kept.join(newline) + (trailing && kept.length ? newline : '');
}

export async function undoCodexSessionImport(codexHome, options = {}) {
  const manifestPath = path.resolve(String(options.manifestPath || ''));
  const backupRoot = path.resolve(options.backupRoot || path.join(codexHome, 'backups', 'codex-claude-session-manager'));
  if (!isInside(backupRoot, manifestPath)) throw new CleanerError('UNSAFE_IMPORT_MANIFEST', 'The import restore manifest is outside the managed backup directory.', 422);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.kind !== 'codex-session-import') throw new CleanerError('INVALID_IMPORT_MANIFEST', 'The selected restore point is not a session import.', 422);
  const ids = [...new Set([
    ...manifest.created.map((item) => item.id),
    ...(manifest.indexRowsAdded || []),
  ])];
  return withTargetSessionLocks(codexHome, ids, {
    ...options,
    errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
  }, async () => {
    for (const item of manifest.rolloutChecks || manifest.created) {
      const current = await currentRolloutHash(item.path);
      if (current !== item.sha256) throw new CleanerError('IMPORTED_SESSION_CHANGED', 'An imported session has changed since import, so automatic rollback was refused.', 409, { sessionId: item.id });
    }
    if (manifest.mode === 'resume') {
      const check = options.codexProcessCheck || await detectRunningCodexProcesses();
      if (check.available && check.processes.length) throw new CleanerError('CODEX_STILL_RUNNING', 'Close Codex before rolling back a session import.', 409);
      const sqlite = await loadSqlite();
      const db = new sqlite.DatabaseSync(manifest.stateDbPath);
      try {
        db.exec('BEGIN IMMEDIATE');
        const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((column) => column.name));
        const expectedPaths = new Map((manifest.rolloutChecks || manifest.created).map((item) => [item.id, item.path]));
        const readRow = columns.has('rollout_path')
          ? db.prepare('SELECT id, rollout_path FROM threads WHERE id = ?')
          : db.prepare('SELECT id FROM threads WHERE id = ?');
        for (const id of ids) {
          const row = readRow.get(id);
          if (!row || (columns.has('rollout_path') && normalizePathKey(row.rollout_path) !== normalizePathKey(expectedPaths.get(id)))) {
            throw new CleanerError('IMPORTED_SESSION_INDEX_CHANGED', 'An imported session index changed since import, so automatic rollback was refused.', 409, { sessionId: id });
          }
        }
        const remove = columns.has('rollout_path')
          ? db.prepare('DELETE FROM threads WHERE id = ? AND rollout_path = ?')
          : db.prepare('DELETE FROM threads WHERE id = ?');
        for (const id of ids) remove.run(...(columns.has('rollout_path') ? [id, expectedPaths.get(id)] : [id]));
        const indexSource = await readFile(manifest.indexPath, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error));
        await writeFileAtomically(manifest.indexPath, removeIndexRows(indexSource, manifest.indexRowsAdded || []));
        await invalidateThreadHistory(codexHome, ids, options);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      } finally { db.close(); }
    }
    for (const item of manifest.created) await unlink(item.path);
    return { removedSessionIds: ids, restartRequired: manifest.mode === 'resume' };
  });
}
