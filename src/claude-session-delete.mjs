import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CleanerError, writeFileAtomically } from './core.mjs';
import { buildClaudeSessionRegistry } from './claude-sessions.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKUP_ID_PATTERN = /^delete-\d{8}T\d{6}-[0-9a-f]{8}$/i;
const MAX_BATCH_SIZE = 500;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedPath(value) {
  return path.resolve(value).toLocaleLowerCase();
}

function isInside(root, candidate) {
  const normalizedRoot = normalizedPath(root);
  const normalizedCandidate = normalizedPath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function requireInside(root, candidate, label) {
  const resolved = path.resolve(candidate);
  if (!isInside(root, resolved) || resolved === path.resolve(root)) {
    throw new CleanerError('UNSAFE_CLAUDE_PATH', `Refusing to use an unsafe ${label} path.`, 422, { path: resolved });
  }
  return resolved;
}

function requireSessionIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const ids = [...new Set(values.filter((item) => typeof item === 'string').map((item) => item.trim()))].sort();
  if (!ids.length) throw new CleanerError('MISSING_CLAUDE_SESSION', 'Select at least one Claude Code session.', 400);
  if (ids.length > MAX_BATCH_SIZE) {
    throw new CleanerError('TOO_MANY_CLAUDE_SESSIONS', `At most ${MAX_BATCH_SIZE} Claude Code sessions can be processed at once.`, 422);
  }
  const invalid = ids.find((id) => !UUID_PATTERN.test(id));
  if (invalid) throw new CleanerError('INVALID_CLAUDE_SESSION_ID', 'Claude session ID must be a UUID.', 400, { sessionId: invalid });
  return ids;
}

async function stateOrNull(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function walkArtifact(root) {
  const state = await stateOrNull(root);
  if (!state) return { exists: false, kind: null, files: [], sizeBytes: 0, fingerprint: null };
  if (state.isSymbolicLink()) {
    throw new CleanerError('UNSAFE_CLAUDE_SYMLINK', 'Claude session packages containing symbolic links are not modified.', 422, { path: root });
  }
  if (state.isFile()) {
    const content = await readFile(root);
    return {
      exists: true,
      kind: 'file',
      files: [{ relativePath: '.', kind: 'file', sizeBytes: content.length, sha256: sha256(content) }],
      sizeBytes: content.length,
      fingerprint: sha256(`file\0${content.length}\0${sha256(content)}`),
    };
  }
  if (!state.isDirectory()) {
    throw new CleanerError('UNSUPPORTED_CLAUDE_ARTIFACT', 'Claude session package contains an unsupported filesystem entry.', 422, { path: root });
  }
  const entries = [];
  const pending = [{ absolutePath: root, relativePath: '' }];
  while (pending.length) {
    const current = pending.pop();
    const children = await readdir(current.absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    if (!children.length) entries.push({ relativePath: current.relativePath || '.', kind: 'directory', sizeBytes: 0, sha256: null });
    for (const child of children) {
      const absolutePath = path.join(current.absolutePath, child.name);
      const relativePath = path.join(current.relativePath, child.name);
      const childState = await lstat(absolutePath);
      if (childState.isSymbolicLink()) {
        throw new CleanerError('UNSAFE_CLAUDE_SYMLINK', 'Claude session packages containing symbolic links are not modified.', 422, { path: absolutePath });
      }
      if (childState.isDirectory()) {
        entries.push({ relativePath, kind: 'directory', sizeBytes: 0, sha256: null });
        pending.push({ absolutePath, relativePath });
      } else if (childState.isFile()) {
        const content = await readFile(absolutePath);
        entries.push({ relativePath, kind: 'file', sizeBytes: content.length, sha256: sha256(content) });
      } else {
        throw new CleanerError('UNSUPPORTED_CLAUDE_ARTIFACT', 'Claude session package contains an unsupported filesystem entry.', 422, { path: absolutePath });
      }
    }
  }
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const sizeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    exists: true,
    kind: 'directory',
    files: entries,
    sizeBytes,
    fingerprint: sha256(JSON.stringify(entries)),
  };
}

async function fileState(targetPath) {
  const artifact = await walkArtifact(targetPath);
  if (!artifact.exists) return { exists: false, sizeBytes: 0, fingerprint: null };
  if (artifact.kind !== 'file') throw new CleanerError('CLAUDE_INDEX_NOT_FILE', 'Claude sessions-index.json must be a regular file.', 422, { path: targetPath });
  return { exists: true, sizeBytes: artifact.sizeBytes, fingerprint: artifact.fingerprint };
}

function artifactDefinitions(claudeHome, session) {
  const projectDir = path.dirname(session.filePath);
  return [
    { kind: 'main_jsonl', path: session.filePath },
    { kind: 'session_sidecars', path: path.join(projectDir, session.id) },
    { kind: 'tasks', path: path.join(claudeHome, 'tasks', session.id) },
    { kind: 'file_history', path: path.join(claudeHome, 'file-history', session.id) },
    { kind: 'session_env', path: path.join(claudeHome, 'session-env', session.id) },
  ];
}

function assertManagedArtifact(claudeHome, session, artifact) {
  const projectsRoot = path.join(claudeHome, 'projects');
  const allowedRoots = {
    main_jsonl: path.dirname(session.filePath),
    session_sidecars: path.dirname(session.filePath),
    tasks: path.join(claudeHome, 'tasks'),
    file_history: path.join(claudeHome, 'file-history'),
    session_env: path.join(claudeHome, 'session-env'),
  };
  const resolved = requireInside(allowedRoots[artifact.kind], artifact.path, artifact.kind);
  if (!isInside(projectsRoot, session.filePath)) {
    throw new CleanerError('UNSAFE_CLAUDE_SESSION_PATH', 'Claude main session file is outside the projects directory.', 422, { path: session.filePath });
  }
  const expectedName = artifact.kind === 'main_jsonl' ? `${session.id}.jsonl` : session.id;
  if (path.basename(resolved).toLocaleLowerCase() !== expectedName.toLocaleLowerCase()) {
    throw new CleanerError('UNSAFE_CLAUDE_SESSION_PATH', 'Claude session artifact name does not match its session ID.', 422, { path: resolved });
  }
  return resolved;
}

async function readIndex(projectDir) {
  const indexPath = path.join(projectDir, 'sessions-index.json');
  const state = await fileState(indexPath);
  if (!state.exists) return { path: indexPath, state, value: null, parseError: null };
  try {
    const value = JSON.parse(await readFile(indexPath, 'utf8'));
    return { path: indexPath, state, value, parseError: null };
  } catch (error) {
    return { path: indexPath, state, value: null, parseError: error.message };
  }
}

function publicSessionPlan(session) {
  return {
    id: session.id,
    title: session.title,
    projectPath: session.projectPath,
    projectKey: session.projectKey,
    artifactCount: session.artifacts.length,
    fileCount: session.artifacts.reduce((sum, artifact) => sum + artifact.fileCount, 0),
    sizeBytes: session.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
    subagentCount: session.subagentCount,
  };
}

function deletionBackupRoot(claudeHome, options = {}) {
  return path.resolve(options.backupRoot || path.join(claudeHome, 'backups', 'local-session-manager-deleted-sessions'));
}

async function assertBackupRoot(root, { create = false } = {}) {
  if (create) await mkdir(root, { recursive: true });
  const state = await stateOrNull(root);
  if (!state) return false;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new CleanerError('UNSAFE_CLAUDE_BACKUP_ROOT', 'Claude deletion backup root must be a regular directory, not a link.', 422, { path: root });
  }
  return true;
}

function planTokenFor(plan) {
  return sha256(JSON.stringify({
    sessionIds: plan.sessions.map((session) => session.id),
    artifacts: plan.sessions.flatMap((session) => session.artifacts.map((artifact) => ({
      sessionId: session.id,
      kind: artifact.kind,
      relativePath: artifact.relativePath,
      fingerprint: artifact.fingerprint,
    }))),
    indexes: plan.indexes.map((index) => ({ projectKey: index.projectKey, fingerprint: index.state.fingerprint, exists: index.state.exists })),
  }));
}

export async function previewClaudeSessionDeletion(claudeHome, options = {}) {
  const sessionIds = requireSessionIds(options.sessionIds ?? options.sessionId);
  const registry = await buildClaudeSessionRegistry(claudeHome);
  const byId = new Map(registry.sessions.map((session) => [session.id, session]));
  const missing = sessionIds.filter((id) => !byId.has(id));
  if (missing.length) throw new CleanerError('CLAUDE_SESSION_NOT_FOUND', 'One or more Claude Code sessions were not found.', 404, { sessionIds: missing });

  const sessions = [];
  const indexMap = new Map();
  for (const id of sessionIds) {
    const source = byId.get(id);
    const artifacts = [];
    for (const definition of artifactDefinitions(claudeHome, source)) {
      const artifactPath = assertManagedArtifact(claudeHome, source, definition);
      const state = await walkArtifact(artifactPath);
      if (!state.exists) continue;
      artifacts.push({
        kind: definition.kind,
        path: artifactPath,
        relativePath: path.relative(claudeHome, artifactPath),
        entryKind: state.kind,
        fileCount: state.files.filter((item) => item.kind === 'file').length,
        sizeBytes: state.sizeBytes,
        fingerprint: state.fingerprint,
      });
    }
    if (!artifacts.some((artifact) => artifact.kind === 'main_jsonl')) {
      throw new CleanerError('CLAUDE_SESSION_NOT_DELETABLE', 'Claude Code session no longer has a main JSONL file.', 409, { sessionId: id });
    }
    const projectDir = path.dirname(source.filePath);
    if (!indexMap.has(source.projectKey)) {
      const index = await readIndex(projectDir);
      indexMap.set(source.projectKey, { ...index, projectKey: source.projectKey, projectDir });
    }
    const index = indexMap.get(source.projectKey);
    const indexEntry = Array.isArray(index.value?.entries)
      ? index.value.entries.find((entry) => entry?.sessionId === id) || null
      : null;
    sessions.push({ ...source, artifacts, indexEntry });
  }
  const indexes = [...indexMap.values()].sort((left, right) => left.projectKey.localeCompare(right.projectKey));
  const plan = {
    sessions,
    indexes,
    deletionBackupRoot: deletionBackupRoot(claudeHome, options),
    summary: {
      sessions: sessions.length,
      mainFiles: sessions.length,
      artifactDirectories: sessions.reduce((sum, session) => sum + session.artifacts.filter((artifact) => artifact.entryKind === 'directory').length, 0),
      artifactFiles: sessions.reduce((sum, session) => sum + session.artifacts.reduce((count, artifact) => count + artifact.fileCount, 0), 0),
      indexRows: sessions.filter((session) => session.indexEntry).length,
      totalBytes: sessions.reduce((sum, session) => sum + session.artifacts.reduce((value, artifact) => value + artifact.sizeBytes, 0), 0),
      invalidIndexes: indexes.filter((index) => index.parseError).length,
      subagentsIncluded: sessions.reduce((sum, session) => sum + session.subagentCount, 0),
    },
  };
  return {
    canApply: true,
    sessions: sessions.map(publicSessionPlan),
    summary: plan.summary,
    deletionBackupRoot: plan.deletionBackupRoot,
    planToken: planTokenFor(plan),
    claudeRefreshRecommended: true,
  };
}

async function materializeDeletionPlan(claudeHome, options) {
  const preview = await previewClaudeSessionDeletion(claudeHome, options);
  if (!options.planToken || preview.planToken !== options.planToken) {
    throw new CleanerError('CLAUDE_DELETE_PLAN_CHANGED', 'Claude Code session files changed after preview. Refresh and preview the deletion again.', 409);
  }
  const registry = await buildClaudeSessionRegistry(claudeHome);
  const ids = preview.sessions.map((session) => session.id);
  const full = await buildDeletionPlanFromRegistry(claudeHome, registry, ids, options);
  if (planTokenFor(full) !== options.planToken) {
    throw new CleanerError('CLAUDE_DELETE_PLAN_CHANGED', 'Claude Code session files changed after preview. Refresh and preview the deletion again.', 409);
  }
  return full;
}

async function buildDeletionPlanFromRegistry(claudeHome, registry, sessionIds, options) {
  const byId = new Map(registry.sessions.map((session) => [session.id, session]));
  const sessions = [];
  const indexMap = new Map();
  for (const id of sessionIds) {
    const source = byId.get(id);
    if (!source) throw new CleanerError('CLAUDE_SESSION_NOT_FOUND', 'Claude Code session was not found.', 404, { sessionId: id });
    const artifacts = [];
    for (const definition of artifactDefinitions(claudeHome, source)) {
      const artifactPath = assertManagedArtifact(claudeHome, source, definition);
      const state = await walkArtifact(artifactPath);
      if (!state.exists) continue;
      artifacts.push({ kind: definition.kind, path: artifactPath, relativePath: path.relative(claudeHome, artifactPath), entryKind: state.kind, fileCount: state.files.filter((item) => item.kind === 'file').length, sizeBytes: state.sizeBytes, fingerprint: state.fingerprint });
    }
    const projectDir = path.dirname(source.filePath);
    if (!indexMap.has(source.projectKey)) indexMap.set(source.projectKey, { ...(await readIndex(projectDir)), projectKey: source.projectKey, projectDir });
    const index = indexMap.get(source.projectKey);
    const indexEntry = Array.isArray(index.value?.entries) ? index.value.entries.find((entry) => entry?.sessionId === id) || null : null;
    sessions.push({ ...source, artifacts, indexEntry });
  }
  const indexes = [...indexMap.values()].sort((left, right) => left.projectKey.localeCompare(right.projectKey));
  return { sessions, indexes, deletionBackupRoot: deletionBackupRoot(claudeHome, options) };
}

function backupId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  return `delete-${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function copyArtifact(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
}

async function createDeletionBackup(claudeHome, plan, options = {}) {
  const root = plan.deletionBackupRoot;
  await assertBackupRoot(root, { create: true });
  const id = backupId(options.now ? new Date(options.now) : new Date());
  const backupDir = requireInside(root, path.join(root, id), 'Claude deletion backup');
  await mkdir(backupDir, { recursive: false });
  const manifest = {
    version: 1,
    kind: 'claude-session-delete',
    state: 'prepared',
    createdAt: (options.now ? new Date(options.now) : new Date()).toISOString(),
    sessions: [],
    indexes: [],
  };
  for (const session of plan.sessions) {
    const saved = { id: session.id, title: session.title, projectPath: session.projectPath, projectKey: session.projectKey, subagentCount: session.subagentCount, indexEntry: session.indexEntry, artifacts: [] };
    for (const artifact of session.artifacts) {
      const backupRelativePath = path.join('payload', artifact.relativePath);
      const target = requireInside(backupDir, path.join(backupDir, backupRelativePath), 'Claude backup payload');
      await copyArtifact(artifact.path, target);
      const copied = await walkArtifact(target);
      if (copied.fingerprint !== artifact.fingerprint) throw new CleanerError('CLAUDE_BACKUP_VERIFY_FAILED', 'Claude session backup verification failed.', 500, { sessionId: session.id, kind: artifact.kind });
      saved.artifacts.push({ kind: artifact.kind, sourceRelativePath: artifact.relativePath, backupRelativePath, entryKind: artifact.entryKind, fileCount: artifact.fileCount, sizeBytes: artifact.sizeBytes, fingerprint: artifact.fingerprint });
    }
    manifest.sessions.push(saved);
  }
  for (const index of plan.indexes) {
    if (!index.state.exists) continue;
    const backupRelativePath = path.join('indexes', index.projectKey, 'sessions-index.json');
    const target = requireInside(backupDir, path.join(backupDir, backupRelativePath), 'Claude index backup');
    await copyArtifact(index.path, target);
    const copied = await fileState(target);
    if (copied.fingerprint !== index.state.fingerprint) throw new CleanerError('CLAUDE_BACKUP_VERIFY_FAILED', 'Claude index backup verification failed.', 500, { projectKey: index.projectKey });
    manifest.indexes.push({ projectKey: index.projectKey, sourceRelativePath: path.relative(claudeHome, index.path), backupRelativePath, fingerprint: index.state.fingerprint, parseError: index.parseError });
  }
  const manifestPath = path.join(backupDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { id, backupDir, manifestPath, manifest };
}

async function assertArtifactUnchanged(artifact) {
  const current = await walkArtifact(artifact.path);
  if (!current.exists || current.fingerprint !== artifact.fingerprint) {
    throw new CleanerError('CLAUDE_DELETE_SOURCE_CHANGED', 'Claude Code wrote to the session while it was being deleted. The operation was stopped.', 409, { path: artifact.path });
  }
}

async function writeIndexesWithoutSessions(plan) {
  const selected = new Set(plan.sessions.map((session) => session.id));
  for (const index of plan.indexes) {
    if (!index.state.exists || index.parseError || !index.value) continue;
    const current = await fileState(index.path);
    if (current.fingerprint !== index.state.fingerprint) throw new CleanerError('CLAUDE_INDEX_CHANGED', 'Claude sessions-index.json changed during deletion.', 409, { path: index.path });
    const entries = Array.isArray(index.value.entries) ? index.value.entries.filter((entry) => !selected.has(entry?.sessionId)) : [];
    await writeFileAtomically(index.path, `${JSON.stringify({ ...index.value, entries }, null, 2)}\n`);
  }
}

async function restorePreparedBackup(claudeHome, backup, plan) {
  const errors = [];
  for (const session of backup.manifest.sessions) {
    for (const artifact of session.artifacts) {
      const source = requireInside(backup.backupDir, path.join(backup.backupDir, artifact.backupRelativePath), 'Claude backup source');
      const target = requireInside(claudeHome, path.join(claudeHome, artifact.sourceRelativePath), 'Claude restore target');
      try {
        const current = await walkArtifact(target);
        if (!current.exists) await copyArtifact(source, target);
        else if (current.fingerprint !== artifact.fingerprint) throw new Error(`Target changed: ${target}`);
      } catch (error) { errors.push(error.message); }
    }
  }
  for (const index of backup.manifest.indexes) {
    try {
      const source = requireInside(backup.backupDir, path.join(backup.backupDir, index.backupRelativePath), 'Claude index backup source');
      const target = requireInside(claudeHome, path.join(claudeHome, index.sourceRelativePath), 'Claude index restore target');
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true });
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new CleanerError('CLAUDE_DELETE_ROLLBACK_FAILED', 'Claude session deletion failed and could not be fully rolled back.', 500, { errors, sessions: plan.sessions.map((session) => session.id) });
}

export async function applyClaudeSessionDeletion(claudeHome, options = {}) {
  const plan = await materializeDeletionPlan(claudeHome, options);
  const backup = await createDeletionBackup(claudeHome, plan, options);
  try {
    for (const session of plan.sessions) {
      for (const artifact of session.artifacts) {
        await assertArtifactUnchanged(artifact);
        assertManagedArtifact(claudeHome, session, artifact);
        await rm(artifact.path, { recursive: artifact.entryKind === 'directory', force: false });
      }
    }
    await writeIndexesWithoutSessions(plan);
    backup.manifest.state = 'completed';
    backup.manifest.completedAt = new Date().toISOString();
    await writeFileAtomically(backup.manifestPath, `${JSON.stringify(backup.manifest, null, 2)}\n`);
  } catch (error) {
    try {
      await restorePreparedBackup(claudeHome, backup, plan);
      backup.manifest.state = 'rolled-back';
      backup.manifest.failure = { code: error?.code || 'DELETE_FAILED', message: error?.message || String(error) };
      await writeFileAtomically(backup.manifestPath, `${JSON.stringify(backup.manifest, null, 2)}\n`);
    } catch (rollbackError) {
      throw rollbackError;
    }
    throw error;
  }
  return {
    deleted: {
      sessions: plan.sessions.length,
      sessionIds: plan.sessions.map((session) => session.id),
      artifactFiles: plan.sessions.reduce((sum, session) => sum + session.artifacts.reduce((count, artifact) => count + artifact.fileCount, 0), 0),
      sizeBytes: plan.sessions.reduce((sum, session) => sum + session.artifacts.reduce((value, artifact) => value + artifact.sizeBytes, 0), 0),
    },
    backup: { id: backup.id, backupDir: backup.backupDir },
    claudeRefreshRecommended: true,
  };
}

async function directorySize(root) {
  const state = await walkArtifact(root);
  return state.sizeBytes;
}

function safeBackupTarget(root, id) {
  if (!BACKUP_ID_PATTERN.test(id)) throw new CleanerError('INVALID_CLAUDE_BACKUP_ID', 'Claude deletion backup ID is invalid.', 400, { backupId: id });
  return requireInside(root, path.join(root, id), 'Claude deletion backup');
}

function validateManifest(manifest) {
  if (manifest.kind !== 'claude-session-delete' || manifest.version !== 1 || manifest.state !== 'completed' || !Array.isArray(manifest.sessions)) {
    throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude deletion backup is incomplete or unsupported.', 422);
  }
  const allowedKinds = new Set(['main_jsonl', 'session_sidecars', 'tasks', 'file_history', 'session_env']);
  for (const session of manifest.sessions) {
    if (!UUID_PATTERN.test(session?.id || '')) throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup contains an invalid session ID.', 422);
    if (typeof session.projectKey !== 'string' || !session.projectKey || path.basename(session.projectKey) !== session.projectKey) {
      throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup contains an unsafe project key.', 422);
    }
    if (!Array.isArray(session.artifacts)) throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup artifact list is invalid.', 422);
    const expected = {
      main_jsonl: path.join('projects', session.projectKey, `${session.id}.jsonl`),
      session_sidecars: path.join('projects', session.projectKey, session.id),
      tasks: path.join('tasks', session.id),
      file_history: path.join('file-history', session.id),
      session_env: path.join('session-env', session.id),
    };
    const seen = new Set();
    for (const artifact of session.artifacts) {
      if (!allowedKinds.has(artifact?.kind) || seen.has(artifact.kind)) throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup contains an invalid or duplicate artifact.', 422);
      seen.add(artifact.kind);
      const source = path.normalize(artifact.sourceRelativePath || '');
      const backup = path.normalize(artifact.backupRelativePath || '');
      if (source !== path.normalize(expected[artifact.kind]) || backup !== path.normalize(path.join('payload', expected[artifact.kind]))) {
        throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup artifact path does not match its session identity.', 422);
      }
      if (!/^[0-9a-f]{64}$/i.test(artifact.fingerprint || '')) throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup artifact fingerprint is invalid.', 422);
    }
    if (!seen.has('main_jsonl')) throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup does not contain its main JSONL file.', 422);
  }
  if (manifest.indexes !== undefined && !Array.isArray(manifest.indexes)) throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup index list is invalid.', 422);
  for (const index of manifest.indexes || []) {
    if (typeof index.projectKey !== 'string' || path.basename(index.projectKey) !== index.projectKey) throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup contains an unsafe index project key.', 422);
    if (path.normalize(index.sourceRelativePath || '') !== path.normalize(path.join('projects', index.projectKey, 'sessions-index.json'))
      || path.normalize(index.backupRelativePath || '') !== path.normalize(path.join('indexes', index.projectKey, 'sessions-index.json'))
      || !/^[0-9a-f]{64}$/i.test(index.fingerprint || '')) {
      throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude backup index metadata is invalid.', 422);
    }
  }
  return manifest;
}

async function readBackup(claudeHome, backupId, options = {}) {
  const root = deletionBackupRoot(claudeHome, options);
  if (!(await assertBackupRoot(root))) throw new CleanerError('CLAUDE_BACKUP_NOT_FOUND', 'Claude deletion backup was not found.', 404, { backupId });
  const backupDir = safeBackupTarget(root, backupId);
  const state = await stateOrNull(backupDir);
  if (!state?.isDirectory() || state.isSymbolicLink()) throw new CleanerError('CLAUDE_BACKUP_NOT_FOUND', 'Claude deletion backup was not found.', 404, { backupId });
  const manifestPath = requireInside(backupDir, path.join(backupDir, 'manifest.json'), 'Claude deletion manifest');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new CleanerError('INVALID_CLAUDE_BACKUP', 'Claude deletion backup manifest is invalid.', 422, { backupId }); }
  validateManifest(manifest);
  return { root, backupDir, manifestPath, manifest };
}

export async function listClaudeSessionDeletionBackups(claudeHome, options = {}) {
  const root = deletionBackupRoot(claudeHome, options);
  if (!(await assertBackupRoot(root))) return { backupRoot: root, backups: [] };
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return { backupRoot: root, backups: [] }; throw error; }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !BACKUP_ID_PATTERN.test(entry.name)) continue;
    try {
      const backup = await readBackup(claudeHome, entry.name, options);
      backups.push({
        id: entry.name,
        backupDir: backup.backupDir,
        createdAt: backup.manifest.createdAt || null,
        sizeBytes: await directorySize(backup.backupDir),
        sessions: backup.manifest.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          projectPath: session.projectPath,
          projectKey: session.projectKey,
          artifactCount: session.artifacts.length,
          fileCount: session.artifacts.reduce((sum, artifact) => sum + artifact.fileCount, 0),
          sizeBytes: session.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
        })),
      });
    } catch {
      // Incomplete prepared or rolled-back directories are intentionally hidden.
    }
  }
  backups.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  return { backupRoot: root, backups };
}

function restorePlanTokenFor(plan) {
  return sha256(JSON.stringify({
    backupId: plan.backupId,
    sessions: plan.sessions.map((session) => ({ id: session.id, artifacts: session.artifacts.map((artifact) => ({ kind: artifact.kind, action: artifact.action, currentFingerprint: artifact.currentFingerprint, fingerprint: artifact.fingerprint })) })),
    indexes: plan.indexes.map((index) => ({ projectKey: index.projectKey, exists: index.state.exists, fingerprint: index.state.fingerprint })),
  }));
}

export async function previewClaudeSessionDeletionBackupRestore(claudeHome, options = {}) {
  const backup = await readBackup(claudeHome, options.backupId, options);
  const sessionIds = requireSessionIds(options.sessionIds);
  const byId = new Map(backup.manifest.sessions.map((session) => [session.id, session]));
  const missing = sessionIds.filter((id) => !byId.has(id));
  if (missing.length) throw new CleanerError('CLAUDE_BACKUP_SESSION_NOT_FOUND', 'Selected Claude sessions are not present in this backup.', 404, { sessionIds: missing });
  const sessions = [];
  const indexMap = new Map();
  for (const id of sessionIds) {
    const manifestSession = byId.get(id);
    const artifacts = [];
    for (const artifact of manifestSession.artifacts) {
      const backupPath = requireInside(backup.backupDir, path.join(backup.backupDir, artifact.backupRelativePath), 'Claude backup payload');
      const saved = await walkArtifact(backupPath);
      if (!saved.exists || saved.fingerprint !== artifact.fingerprint) throw new CleanerError('CLAUDE_BACKUP_DAMAGED', 'A Claude deletion backup artifact is missing or damaged.', 422, { sessionId: id, kind: artifact.kind });
      const targetPath = requireInside(claudeHome, path.join(claudeHome, artifact.sourceRelativePath), 'Claude restore target');
      const current = await walkArtifact(targetPath);
      artifacts.push({ ...artifact, backupPath, targetPath, action: !current.exists ? 'restore' : (current.fingerprint === artifact.fingerprint ? 'already_present' : 'conflict'), currentFingerprint: current.fingerprint });
    }
    sessions.push({ ...manifestSession, artifacts });
    if (!indexMap.has(manifestSession.projectKey)) {
      const projectDir = path.dirname(sessions.at(-1).artifacts.find((artifact) => artifact.kind === 'main_jsonl').targetPath);
      indexMap.set(manifestSession.projectKey, { ...(await readIndex(projectDir)), projectKey: manifestSession.projectKey, projectDir });
    }
  }
  const indexes = [...indexMap.values()].sort((left, right) => left.projectKey.localeCompare(right.projectKey));
  const conflicts = sessions.flatMap((session) => session.artifacts.filter((artifact) => artifact.action === 'conflict').map((artifact) => ({ sessionId: session.id, kind: artifact.kind, path: artifact.targetPath })));
  for (const index of indexes) {
    if (index.parseError) conflicts.push({ sessionId: null, kind: 'sessions_index', path: index.path });
  }
  const plan = { backupId: options.backupId, backup, sessions, indexes, conflicts };
  const summary = {
    sessions: sessions.length,
    artifactFiles: sessions.reduce((sum, session) => sum + session.artifacts.filter((artifact) => artifact.action === 'restore').reduce((count, artifact) => count + artifact.fileCount, 0), 0),
    alreadyPresent: sessions.reduce((sum, session) => sum + session.artifacts.filter((artifact) => artifact.action === 'already_present').length, 0),
    indexRows: sessions.filter((session) => session.indexEntry).length,
    conflicts: conflicts.length,
  };
  return {
    backupId: options.backupId,
    sessions: sessions.map((session) => ({ id: session.id, title: session.title, projectPath: session.projectPath })),
    summary,
    conflicts,
    canApply: conflicts.length === 0,
    indexStates: indexes.map((index) => ({ projectKey: index.projectKey, exists: index.state.exists, fingerprint: index.state.fingerprint })),
    planToken: restorePlanTokenFor(plan),
  };
}

async function materializeRestorePlan(claudeHome, options) {
  const preview = await previewClaudeSessionDeletionBackupRestore(claudeHome, options);
  if (!options.planToken || preview.planToken !== options.planToken) throw new CleanerError('CLAUDE_RESTORE_PLAN_CHANGED', 'Claude restore targets changed after preview. Preview the restore again.', 409);
  if (preview.summary.conflicts) throw new CleanerError('CLAUDE_RESTORE_CONFLICT', 'Claude restore would overwrite different current session data.', 409, { conflicts: preview.conflicts });
  const backup = await readBackup(claudeHome, options.backupId, options);
  const byId = new Map(backup.manifest.sessions.map((session) => [session.id, session]));
  const sessions = requireSessionIds(options.sessionIds).map((id) => byId.get(id));
  return { preview, backup, sessions };
}

function mergeIndexEntries(current, backupValue, sessions) {
  const base = current && typeof current === 'object'
    ? current
    : { ...(backupValue && typeof backupValue === 'object' ? backupValue : {}), entries: [] };
  const selected = new Map(sessions.filter((session) => session.indexEntry).map((session) => [session.id, session.indexEntry]));
  const entries = (Array.isArray(base.entries) ? base.entries : []).filter((entry) => !selected.has(entry?.sessionId));
  entries.push(...selected.values());
  return { ...base, entries };
}

export async function applyClaudeSessionDeletionBackupRestore(claudeHome, options = {}) {
  const { preview, backup, sessions } = await materializeRestorePlan(claudeHome, options);
  const copied = [];
  const originalIndexes = [];
  try {
    for (const sessionPreview of preview.sessions) {
      const manifestSession = sessions.find((session) => session.id === sessionPreview.id);
      for (const artifact of manifestSession.artifacts) {
        const source = requireInside(backup.backupDir, path.join(backup.backupDir, artifact.backupRelativePath), 'Claude backup payload');
        const target = requireInside(claudeHome, path.join(claudeHome, artifact.sourceRelativePath), 'Claude restore target');
        const current = await walkArtifact(target);
        if (current.exists) {
          if (current.fingerprint !== artifact.fingerprint) {
            throw new CleanerError('CLAUDE_RESTORE_CONFLICT', 'Claude restore target changed while the restore was running.', 409, { path: target });
          }
          continue;
        }
        await copyArtifact(source, target);
        const restored = await walkArtifact(target);
        if (restored.fingerprint !== artifact.fingerprint) {
          throw new CleanerError('CLAUDE_RESTORE_VERIFY_FAILED', 'A restored Claude session artifact did not match its backup.', 500, { path: target });
        }
        copied.push(target);
      }
    }
    const byProject = new Map();
    for (const session of sessions) {
      if (!byProject.has(session.projectKey)) byProject.set(session.projectKey, []);
      byProject.get(session.projectKey).push(session);
    }
    for (const [projectKey, projectSessions] of byProject) {
      const main = projectSessions[0].artifacts.find((artifact) => artifact.kind === 'main_jsonl');
      const targetMain = requireInside(claudeHome, path.join(claudeHome, main.sourceRelativePath), 'Claude main restore target');
      const index = await readIndex(path.dirname(targetMain));
      const expectedIndex = preview.indexStates.find((item) => item.projectKey === projectKey);
      if (index.parseError || !expectedIndex || index.state.exists !== expectedIndex.exists || index.state.fingerprint !== expectedIndex.fingerprint) {
        throw new CleanerError('CLAUDE_RESTORE_PLAN_CHANGED', 'Claude sessions-index.json changed while the restore was running.', 409, { path: index.path });
      }
      originalIndexes.push({ path: index.path, exists: index.state.exists, content: index.state.exists ? await readFile(index.path, 'utf8') : null });
      const manifestIndex = backup.manifest.indexes.find((item) => item.projectKey === projectKey);
      let backupValue = null;
      if (manifestIndex) {
        const source = requireInside(backup.backupDir, path.join(backup.backupDir, manifestIndex.backupRelativePath), 'Claude index backup');
        try { backupValue = JSON.parse(await readFile(source, 'utf8')); } catch {}
      }
      const merged = mergeIndexEntries(index.value, backupValue, projectSessions);
      await mkdir(path.dirname(index.path), { recursive: true });
      await writeFileAtomically(index.path, `${JSON.stringify(merged, null, 2)}\n`);
    }
  } catch (error) {
    for (const target of copied.reverse()) {
      if (isInside(claudeHome, target) && target !== path.resolve(claudeHome)) await rm(target, { recursive: true, force: true });
    }
    for (const index of originalIndexes.reverse()) {
      if (index.exists) await writeFileAtomically(index.path, index.content);
      else await rm(index.path, { force: true });
    }
    throw error;
  }
  return {
    restored: { sessions: sessions.length, sessionIds: sessions.map((session) => session.id), artifactFiles: preview.summary.artifactFiles },
    claudeRestartRecommended: true,
  };
}

export async function deleteClaudeSessionDeletionBackups(claudeHome, options = {}) {
  const backupIds = [...new Set(Array.isArray(options.backupIds) ? options.backupIds : [])];
  if (!backupIds.length) throw new CleanerError('MISSING_CLAUDE_BACKUPS', 'Select at least one Claude deletion backup.', 400);
  const root = deletionBackupRoot(claudeHome, options);
  const deleted = [];
  for (const id of backupIds) {
    const backup = await readBackup(claudeHome, id, options);
    const sizeBytes = await directorySize(backup.backupDir);
    const target = safeBackupTarget(root, id);
    if (target === root || !isInside(root, target)) throw new CleanerError('UNSAFE_CLAUDE_BACKUP_TARGET', 'Refusing to recursively delete an unsafe Claude backup target.', 422, { backupId: id });
    await rm(target, { recursive: true, force: false });
    deleted.push({ id, sizeBytes });
  }
  return { deleted, deletedCount: deleted.length, freedBytes: deleted.reduce((sum, item) => sum + item.sizeBytes, 0) };
}
