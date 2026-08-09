import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { CleanerError, hashRolloutSource, writeFileAtomically } from './core.mjs';
import { findSession, publicSession, selectedTurn } from './claude-sessions.mjs';

const TURN_DELETE_MODES = new Set(['truncate', 'single']);

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
    throw new CleanerError('UNSAFE_CLAUDE_TURN_PATH', `Refusing to use an unsafe ${label} path.`, 422, { path: resolved });
  }
  return resolved;
}

function turnDeletionBackupRoot(claudeHome, options = {}) {
  return path.resolve(options.backupRoot || path.join(claudeHome, 'backups', 'local-session-manager-deleted-turns'));
}

function requireTurnDeleteMode(mode) {
  const value = mode || 'single';
  if (!TURN_DELETE_MODES.has(value)) {
    throw new CleanerError('INVALID_CLAUDE_TURN_MODE', 'Claude turn deletion mode must be "truncate" or "single".', 400, { mode: value });
  }
  return value;
}

async function stateOrNull(targetPath) {
  try {
    return await stat(targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function toolUseIdsInRange(session, startLine, endLine) {
  const ids = new Set();
  for (const record of session._records) {
    if (record.lineNumber < startLine || record.lineNumber > endLine) continue;
    const content = record.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block?.id === 'string' && block.id) ids.add(block.id);
    }
  }
  return ids;
}

function externalArtifactsForTurn(session, turn, startLine, endLine) {
  const toolResultFiles = session._persistedOutputs
    .filter((item) => item.lineNumber >= startLine && item.lineNumber <= endLine && item.actualPath)
    .map((item) => ({ path: item.actualPath, lineNumber: item.lineNumber }));
  const toolUseIds = toolUseIdsInRange(session, startLine, endLine);
  const subagents = session._subagents
    .filter((agent) => toolUseIds.has(agent.metadata?.toolUseId));
  return { toolResultFiles, subagents };
}

function computeRemoval(session, turn, mode) {
  const lastLine = session._records.length;
  const startLine = turn.startLine;
  const endLine = mode === 'truncate' ? lastLine : turn.endLine;
  return {
    mode,
    startLine,
    endLine,
    removedLineCount: endLine - startLine + 1,
    keptLineCount: session._records.length - (endLine - startLine + 1),
  };
}

function rewriteJsonlWithoutRange(session, source, startLine, endLine) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(source);
  const kept = session._records.filter((record) => record.lineNumber < startLine || record.lineNumber > endLine);
  const body = kept.map((record) => record.raw).join(newline);
  return trailingNewline ? `${body}${newline}` : body;
}

function countLines(source) {
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

function assertManagedToolResult(claudeHome, session, filePath) {
  const root = path.join(path.dirname(session.filePath), session.id, 'tool-results');
  return requireInside(root, filePath, 'Claude tool-result');
}

function assertManagedSubagent(claudeHome, session, agent, kind = 'jsonl') {
  const root = path.join(path.dirname(session.filePath), session.id, 'subagents');
  const filePath = kind === 'meta' ? agent.metaPath : agent.jsonlPath;
  return requireInside(root, filePath, 'Claude subagent');
}

async function assertBackupRoot(root, { create = false } = {}) {
  if (create) await mkdir(root, { recursive: true });
  const state = await stateOrNull(root);
  if (!state) return false;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new CleanerError('UNSAFE_CLAUDE_TURN_BACKUP_ROOT', 'Claude turn backup root must be a regular directory, not a link.', 422, { path: root });
  }
  return true;
}

function turnBackupId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  return `turn-${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function createTurnBackup(claudeHome, files, options = {}) {
  const root = turnDeletionBackupRoot(claudeHome, options);
  await assertBackupRoot(root, { create: true });
  const id = turnBackupId(options.now ? new Date(options.now) : new Date());
  const backupDir = requireInside(root, path.join(root, id), 'Claude turn backup');
  await mkdir(backupDir, { recursive: false });
  const manifest = {
    version: 1,
    kind: 'claude-turn-delete',
    state: 'prepared',
    createdAt: (options.now ? new Date(options.now) : new Date()).toISOString(),
    files: [],
  };
  for (const file of files) {
    const sourceRelativePath = path.relative(claudeHome, file.path);
    if (sourceRelativePath.startsWith('..')) {
      throw new CleanerError('UNSAFE_CLAUDE_TURN_BACKUP_SOURCE', 'Claude turn backup source is outside the claude home.', 422, { path: file.path });
    }
    const backupRelativePath = path.join('payload', sourceRelativePath);
    const target = requireInside(backupDir, path.join(backupDir, backupRelativePath), 'Claude turn backup payload');
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file.path, target);
    const original = await readFile(file.path);
    const copied = await readFile(target);
    if (!original.equals(copied)) {
      throw new CleanerError('CLAUDE_TURN_BACKUP_VERIFY_FAILED', 'Claude turn backup verification failed.', 500, { path: file.path });
    }
    manifest.files.push({
      role: file.role,
      sourceRelativePath,
      backupRelativePath,
    });
  }
  const manifestPath = path.join(backupDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { id, backupDir, manifestPath, manifest };
}

export async function previewClaudeTurnDeletion(claudeHome, sessionId, turnId, options = {}) {
  const session = await findSession(claudeHome, sessionId);
  const turn = selectedTurn(session, turnId);
  const mode = requireTurnDeleteMode(options.mode);
  const source = await readFile(session.filePath, 'utf8');
  const sourceHash = hashRolloutSource(source);
  const removal = computeRemoval(session, turn, mode);
  const artifacts = externalArtifactsForTurn(session, turn, removal.startLine, removal.endLine);
  const nextTurn = session._turns[turn.index + 1] || null;
  return {
    session: publicSession(session),
    turn,
    nextTurn,
    mode,
    sourceHash,
    removedRecordCount: removal.removedLineCount,
    keptRecordCount: removal.keptLineCount,
    startLine: removal.startLine,
    endLine: removal.endLine,
    externalArtifacts: {
      toolResultFiles: artifacts.toolResultFiles.map((item) => ({ path: item.path, lineNumber: item.lineNumber })),
      subagents: artifacts.subagents.map((agent) => ({
        agentId: agent.agentId,
        jsonlPath: agent.jsonlPath,
        metaPath: agent.metaPath,
      })),
    },
    backupRoot: turnDeletionBackupRoot(claudeHome, options),
    claudeRefreshRecommended: true,
  };
}

export async function applyClaudeTurnDeletion(claudeHome, sessionId, turnId, options = {}) {
  const session = await findSession(claudeHome, sessionId);
  const turn = selectedTurn(session, turnId);
  const mode = requireTurnDeleteMode(options.mode);
  const source = await readFile(session.filePath, 'utf8');
  const sourceHashBefore = hashRolloutSource(source);
  if (typeof options.sourceHash !== 'string' || !options.sourceHash || sourceHashBefore !== options.sourceHash) {
    throw new CleanerError('CLAUDE_TURN_STALE_ROLLOUT', 'The Claude session file changed after this turn was loaded. Reload and try again.', 409, {
      expectedHash: options.sourceHash,
      actualHash: sourceHashBefore,
    });
  }
  const removal = computeRemoval(session, turn, mode);
  const artifacts = externalArtifactsForTurn(session, turn, removal.startLine, removal.endLine);
  const nextSource = rewriteJsonlWithoutRange(session, source, removal.startLine, removal.endLine);

  const files = [
    { role: 'main_jsonl', path: session.filePath },
    ...artifacts.toolResultFiles.map((item) => ({ role: 'tool_result', path: item.path })),
    ...artifacts.subagents.flatMap((agent) => [
      { role: 'subagent_jsonl', path: agent.jsonlPath },
      ...(agent.metaPath ? [{ role: 'subagent_meta', path: agent.metaPath }] : []),
    ]),
  ];
  const backup = await createTurnBackup(claudeHome, files, options);

  let changed = false;
  const deletedFiles = [];
  try {
    await writeFileAtomically(session.filePath, nextSource);
    changed = true;
    const verifiedSource = await readFile(session.filePath, 'utf8');
    if (countLines(verifiedSource) !== removal.keptLineCount) {
      throw new CleanerError('CLAUDE_TURN_WRITE_VERIFY_FAILED', 'The rewritten Claude session did not match the expected record count.', 500, {
        expected: removal.keptLineCount,
        actual: countLines(verifiedSource),
      });
    }

    for (const item of artifacts.toolResultFiles) {
      assertManagedToolResult(claudeHome, session, item.path);
      await rm(item.path, { force: false });
      deletedFiles.push(item.path);
    }
    for (const agent of artifacts.subagents) {
      if (agent.metaPath) {
        assertManagedSubagent(claudeHome, session, agent, 'meta');
        await rm(agent.metaPath, { force: false });
        deletedFiles.push(agent.metaPath);
      }
      assertManagedSubagent(claudeHome, session, agent, 'jsonl');
      await rm(agent.jsonlPath, { force: false });
      deletedFiles.push(agent.jsonlPath);
    }

    backup.manifest.state = 'completed';
    backup.manifest.deleted = { recordCount: removal.removedLineCount, files: deletedFiles };
    await writeFileAtomically(backup.manifestPath, `${JSON.stringify(backup.manifest, null, 2)}\n`);
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (changed) await writeFileAtomically(session.filePath, source);
      for (const file of backup.manifest.files) {
        const target = requireInside(claudeHome, path.join(claudeHome, file.sourceRelativePath), 'Claude turn rollback target');
        const payload = requireInside(backup.backupDir, path.join(backup.backupDir, file.backupRelativePath), 'Claude turn backup payload');
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(payload, target);
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError.message);
    }
    if (error instanceof CleanerError) {
      error.details = { ...error.details, backupDir: backup.backupDir, rollbackErrors };
      throw error;
    }
    throw new CleanerError('CLAUDE_TURN_DELETE_FAILED', 'Deleting the Claude turn failed; the session was restored where possible.', 500, {
      cause: error.message,
      backupDir: backup.backupDir,
      rollbackErrors,
    });
  }

  return {
    deleted: {
      recordCount: removal.removedLineCount,
      toolResultFiles: artifacts.toolResultFiles.length,
      subagents: artifacts.subagents.length,
    },
    backup: { id: backup.id, backupDir: backup.backupDir, manifestPath: backup.manifestPath },
    sourceHashBefore,
    sourceHashAfter: hashRolloutSource(nextSource),
    claudeRefreshRecommended: true,
  };
}

export async function restoreClaudeTurnDeleteBackup(claudeHome, options = {}) {
  const root = turnDeletionBackupRoot(claudeHome, options);
  if (!(await assertBackupRoot(root))) {
    throw new CleanerError('CLAUDE_TURN_BACKUP_NOT_FOUND', 'Claude turn deletion backup was not found.', 404, { backupDir: options.backupDir });
  }
  const backupDir = requireInside(root, path.resolve(options.backupDir), 'Claude turn backup');
  const manifestPath = path.join(backupDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new CleanerError('INVALID_CLAUDE_TURN_BACKUP', 'Claude turn deletion backup manifest is invalid.', 422, { backupDir: options.backupDir });
  }
  if (manifest.kind !== 'claude-turn-delete' || manifest.version !== 1 || !Array.isArray(manifest.files)) {
    throw new CleanerError('INVALID_CLAUDE_TURN_BACKUP', 'Claude turn deletion backup is incomplete or unsupported.', 422);
  }
  const main = manifest.files.find((file) => file.role === 'main_jsonl');
  if (!main) throw new CleanerError('INVALID_CLAUDE_TURN_BACKUP', 'Claude turn deletion backup does not contain its main JSONL.', 422);

  const mainTarget = requireInside(claudeHome, path.join(claudeHome, main.sourceRelativePath), 'Claude turn main target');
  const currentSource = await readFile(mainTarget, 'utf8');
  if (typeof options.expectedCurrentHash === 'string' && options.expectedCurrentHash
    && hashRolloutSource(currentSource) !== options.expectedCurrentHash) {
    throw new CleanerError('CLAUDE_TURN_RESTORE_STALE', 'The Claude session file changed after the turn was deleted. Refresh and undo again.', 409);
  }

  const restored = [];
  for (const file of manifest.files) {
    const payload = requireInside(backupDir, path.join(backupDir, file.backupRelativePath), 'Claude turn backup payload');
    const target = requireInside(claudeHome, path.join(claudeHome, file.sourceRelativePath), 'Claude turn restore target');
    if (file.role === 'main_jsonl') {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(payload, target);
      restored.push(target);
      continue;
    }
    const state = await stateOrNull(target);
    if (state) {
      const current = await readFile(target);
      const backedUp = await readFile(payload);
      if (!current.equals(backedUp)) {
        throw new CleanerError('CLAUDE_TURN_RESTORE_CONFLICT', 'Restore target contains different current content. Refusing to overwrite.', 409, { path: target });
      }
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(payload, target);
    restored.push(target);
  }
  return { restored, restoredFileCount: restored.length, claudeRestartRecommended: true };
}