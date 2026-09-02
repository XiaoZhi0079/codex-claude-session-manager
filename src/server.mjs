import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { pickDirectory } from './directory-picker.mjs';

import {
  applyCleanup,
  applyMessageEdits,
  CLEANUP_MODES,
  CleanerError,
  getDefaultCodexHome,
  getSession,
  listTurnsFromRecords,
  mergeThreadHistoryTurnRows,
  previewCleanup,
  previewMessageEdits,
  readRollout,
  readRolloutMetadata,
  readTurnMessageDetail,
  restoreRolloutBackup,
} from './core.mjs';
import { readFullContextExport, readFullContextView } from './context-view.mjs';
import {
  applyCodexVisibilityRepair,
  buildSessionRegistry,
  detectRunningCodexProcesses,
  previewCodexVisibilityRepair,
} from './registry.mjs';
import {
  applySessionDeletionBatch,
  applySessionDeletionBackupRestore,
  applySessionDeletion,
  deleteSessionDeletionBackups,
  listSessionDeletionBackups,
  previewSessionDeletionBatch,
  previewSessionDeletionBackupRestore,
  previewSessionDeletion,
  readSessionDeletionBackupContent,
} from './session-delete.mjs';
import {
  applyOperationBackupRestore,
  applyVisibilityBackupRestore,
  deleteOperationBackups,
  deleteSystemBackups,
  listOperationBackups,
  listSystemBackups,
  previewOperationBackupRestore,
  previewVisibilityBackupRestore,
  readOperationBackupContent,
} from './operation-backup.mjs';
import { diagnoseSessionHealth } from './session-health.mjs';
import { createOperationHistory } from './operation-history.mjs';
import {
  deleteOrphanFailedHistoryTurn,
  inspectTargetSessionLocks,
  prepareThreadHistoryMutation,
  readThreadHistoryTurnRows,
  restoreOrphanFailedHistoryTurn,
  withTargetSessionLocks,
} from './codex-thread-history.mjs';
import {
  buildClaudeSessionRegistry,
  getDefaultClaudeHome,
  readClaudeFullContext,
  readClaudeSessionTurns,
  readClaudeTurnDetail,
} from './claude-sessions.mjs';
import {
  applyClaudeSessionDeletion,
  applyClaudeSessionDeletionBackupRestore,
  deleteClaudeSessionDeletionBackups,
  listClaudeSessionDeletionBackups,
  previewClaudeSessionDeletion,
  previewClaudeSessionDeletionBackupRestore,
  readClaudeSessionDeletionBackupContent,
} from './claude-session-delete.mjs';
import {
  applyClaudeTurnDeletion,
  previewClaudeTurnDeletion,
  restoreClaudeTurnDeleteBackup,
} from './claude-turn-delete.mjs';
import {
  applyClaudeMessageEdits,
  previewClaudeMessageEdits,
  restoreClaudeMessageEdit,
} from './claude-message-edit.mjs';
import {
  applyClaudeProjectPathMigration,
  applyCodexProjectPathMigration,
  previewClaudeProjectPathMigration,
  previewCodexProjectPathMigration,
  restoreProjectPathMigration,
} from './project-path-migration.mjs';
import {
  applyCodexSessionImport,
  createCodexSessionPackage,
  previewCodexSessionImport,
  stageCodexSessionPackageStream,
  undoCodexSessionImport,
} from './codex-session-transfer.mjs';
import { acquireInstanceLocks } from './instance-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function isClaudeOperation(kind) {
  return String(kind || '').startsWith('claude_');
}

function publicProjectPathPlan(plan) {
  return {
    platform: plan.platform,
    fromPath: plan.fromPath,
    toPath: plan.toPath,
    sessionIds: plan.sessionIds,
    sessions: plan.sessions || [],
    summary: plan.summary,
    conflicts: plan.conflicts || [],
    blockedByRunningCodex: Boolean(plan.blockedByRunningCodex),
    codexProcessCheck: plan.codexProcessCheck || null,
    canApply: plan.canApply,
    planToken: plan.planToken,
  };
}

function projectPathPlatform(value) {
  if (value === 'codex' || value === 'claude') return value;
  throw new CleanerError('INVALID_PROJECT_PATH_PLATFORM', 'Project path migration platform must be codex or claude.', 400);
}

function sendDownload(response, download) {
  const content = Buffer.isBuffer(download.content)
    ? download.content
    : Buffer.from(download.content, 'utf8');
  response.writeHead(200, {
    'content-type': download.contentType,
    'content-disposition': `attachment; filename="${download.fileName}"`,
    'content-length': content.length,
    'cache-control': 'no-store',
    'x-context-record-count': String(download.recordCount ?? download.sessionCount ?? 0),
  });
  response.end(content);
}

async function sendFileDownload(response, download) {
  response.writeHead(200, {
    'content-type': download.contentType,
    'content-disposition': `attachment; filename="${download.fileName}"`,
    'content-length': download.sizeBytes,
    'cache-control': 'no-store',
    'x-context-record-count': String(download.sessionCount ?? 0),
  });
  try { await pipeline(createReadStream(download.filePath), response); }
  finally { await unlink(download.filePath).catch(() => {}); }
}

function sendError(response, error) {
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  if (error instanceof CleanerError) {
    sendJson(response, error.status, {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  sendJson(response, 500, {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected cleaner error.',
    },
  });
}

async function readJsonRequest(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > 2_000_000) {
      throw new CleanerError('REQUEST_TOO_LARGE', 'Request body must be smaller than 2 MB.', 413);
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CleanerError('INVALID_JSON', 'Request body must be valid JSON.', 400);
  }
}

function safeStaticPath(publicDir, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(publicDir, `.${decodeURIComponent(requested)}`);
  const root = path.resolve(publicDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new CleanerError('INVALID_PATH', 'Invalid static path.', 400);
  }
  return resolved;
}

async function serveStatic(requestUrl, response, publicDir) {
  const filePath = safeStaticPath(publicDir, requestUrl.pathname);
  const content = await readFile(filePath);
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  response.end(content);
}

function requireSelector(body) {
  const selector = body.selector || {};
  if (!selector.turnId && !Number.isInteger(selector.index) && !Number.isInteger(selector.startLine)) {
    throw new CleanerError('MISSING_SELECTOR', 'Select a turn before previewing or applying.', 400);
  }
  return selector;
}

function requireCleanupMode(body) {
  const mode = body.mode || CLEANUP_MODES.TRUNCATE;
  if (mode !== CLEANUP_MODES.TRUNCATE && mode !== CLEANUP_MODES.SINGLE) {
    throw new CleanerError('INVALID_MODE', 'Cleanup mode must be "truncate" or "single".', 400, { mode });
  }
  return mode;
}

function listProjectDirectories(sessions) {
  const directories = new Map();
  for (const session of sessions) {
    if (typeof session.projectPath !== 'string' || !session.projectPath.trim()) continue;
    const directoryPath = path.normalize(session.projectPath.trim());
    const key = process.platform === 'win32' ? directoryPath.toLowerCase() : directoryPath;
    const existing = directories.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      directories.set(key, { path: directoryPath, count: 1 });
    }
  }
  return [...directories.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveRolloutFromBody(codexHome, body, sessions = null) {
  if (body.rolloutPath) return body.rolloutPath;
  if (!body.sessionId) {
    throw new CleanerError('MISSING_SESSION', 'Select a session before continuing.', 400);
  }
  const session = await getSession(codexHome, body.sessionId, sessions);
  if (!session.rolloutPath) {
    throw new CleanerError('ROLLOUT_NOT_FOUND', 'No rollout JSONL was found for this session.', 404, {
      sessionId: body.sessionId,
    });
  }
  return session.rolloutPath;
}

async function resolveMutationTarget(codexHome, body, sessions = null) {
  const rolloutPath = await resolveRolloutFromBody(codexHome, body, sessions);
  const metadata = await readRolloutMetadata(rolloutPath);
  const requestedSessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
    ? body.sessionId.trim()
    : null;
  if (requestedSessionId && metadata.id && requestedSessionId !== metadata.id) {
    throw new CleanerError(
      'SESSION_ROLLOUT_MISMATCH',
      'The selected session does not match the rollout metadata.',
      409,
      { requestedSessionId, rolloutSessionId: metadata.id },
    );
  }
  const sessionId = requestedSessionId || metadata.id || null;
  if (!sessionId) {
    throw new CleanerError('MISSING_SESSION_ID', 'The rollout does not identify its Codex session.', 422, {
      rolloutPath,
    });
  }
  return { rolloutPath, sessionId };
}

function compatibleBackupRoot(home, currentName, legacyName) {
  const current = path.join(home, 'backups', currentName);
  const legacy = path.join(home, 'backups', legacyName);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function createCleanerServer(options = {}) {
  const env = options.env || process.env;
  const codexHome = options.codexHome || getDefaultCodexHome(env);
  const claudeHome = options.claudeHome || getDefaultClaudeHome(env);
  const backupRoot = options.backupRoot
    || env.CODEX_CLAUDE_SESSION_MANAGER_BACKUP_ROOT
    || env.CODEX_CLEANER_BACKUP_ROOT
    || compatibleBackupRoot(codexHome, 'codex-claude-session-manager', 'codex-turn-cleaner');
  const claudeBackupRoot = options.claudeBackupRoot
    || env.CODEX_CLAUDE_SESSION_MANAGER_CLAUDE_BACKUP_ROOT
    || env.CLAUDE_SESSION_MANAGER_BACKUP_ROOT
    || compatibleBackupRoot(claudeHome, 'codex-claude-session-manager-deleted-sessions', 'local-session-manager-deleted-sessions');
  const claudeTurnBackupRoot = options.claudeTurnBackupRoot
    || env.CODEX_CLAUDE_SESSION_MANAGER_CLAUDE_TURN_BACKUP_ROOT
    || env.CLAUDE_TURN_MANAGER_BACKUP_ROOT
    || compatibleBackupRoot(claudeHome, 'codex-claude-session-manager-deleted-turns', 'local-session-manager-deleted-turns');
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');
  const operationHistory = createOperationHistory({
    backupRoot,
    instanceId: options.instanceId,
  });
  const transferRoot = options.transferRoot || path.join(backupRoot, 'transfers');
  let registryCache = null;
  let claudeRegistryCache = null;
  let lastSessionExportAttempt = null;
  const reportServerError = options.errorReporter || ((entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  });

  async function executeRecordedOperation(meta, action, completionBuilder = () => ({})) {
    const sessionIds = [...new Set((meta.sessionIds || []).map(String))];
    let sessionTitles = { ...(meta.details?.sessionTitles || {}) };
    try {
      const registry = isClaudeOperation(meta.kind)
        ? await loadClaudeRegistry({ refresh: true })
        : await loadRegistry({ refresh: true });
      sessionTitles = {
        ...sessionTitles,
        ...Object.fromEntries(sessionIds
        .map((id) => registry.sessions.find((session) => session.id === id))
        .filter(Boolean)
        .map((session) => [session.id, session.title || '(无标题会话)'])),
      };
    } catch {
      // Operation recording must not block the mutation if title lookup fails.
    }
    const operationId = await operationHistory.start({
      ...meta,
      details: { ...(meta.details || {}), sessionTitles },
    });
    try {
      const result = await action();
      await operationHistory.complete(operationId, completionBuilder(result) || {});
      return { ...result, operationId };
    } catch (error) {
      try {
        await operationHistory.fail(operationId, error);
      } catch {
        // Preserve the action error when the audit file is temporarily unavailable.
      }
      throw error;
    }
  }

  async function executeUndo(undo) {
    if (undo.type === 'rollout_restore') {
      const target = await resolveMutationTarget(codexHome, {
        rolloutPath: undo.rolloutPath,
        sessionId: undo.sessionId,
      });
      return restoreRolloutBackup({
        codexHome,
        sessionId: target.sessionId,
        rolloutPath: target.rolloutPath,
        backupPath: undo.backupPath,
        expectedCurrentHash: undo.expectedCurrentHash,
        backupRoot,
      });
    }
    if (undo.type === 'history_turn_restore') {
      const manifestPath = path.resolve(String(undo.manifestPath || ''));
      const allowedRoot = `${path.resolve(backupRoot)}${path.sep}`;
      if (!manifestPath.startsWith(allowedRoot)) {
        throw new CleanerError('UNSAFE_HISTORY_RESTORE', 'The history restore manifest is outside the backup directory.', 422);
      }
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      return withTargetSessionLocks(codexHome, [manifest.turn.thread_id], {
        errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
      }, () => restoreOrphanFailedHistoryTurn(codexHome, manifest, {
        errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
      }));
    }
    if (undo.type === 'session_delete_restore') {
      const preview = await previewSessionDeletionBackupRestore(codexHome, {
        backupRoot,
        env,
        backupId: undo.backupId,
        sessionIds: undo.sessionIds,
      });
      return applySessionDeletionBackupRestore(codexHome, {
        backupRoot,
        env,
        backupId: undo.backupId,
        sessionIds: undo.sessionIds,
        planToken: preview.planToken,
      });
    }
    if (undo.type === 'visibility_restore') {
      const preview = await previewVisibilityBackupRestore(codexHome, {
        backupRoot,
        env,
        backupId: undo.backupId,
      });
      return applyVisibilityBackupRestore(codexHome, {
        backupRoot,
        env,
        backupId: undo.backupId,
        planToken: preview.planToken,
      });
    }
    if (undo.type === 'claude_session_delete_restore') {
      const preview = await previewClaudeSessionDeletionBackupRestore(claudeHome, {
        backupRoot: claudeBackupRoot,
        backupId: undo.backupId,
        sessionIds: undo.sessionIds,
      });
      return applyClaudeSessionDeletionBackupRestore(claudeHome, {
        backupRoot: claudeBackupRoot,
        backupId: undo.backupId,
        sessionIds: undo.sessionIds,
        planToken: preview.planToken,
      });
    }
    if (undo.type === 'claude_turn_delete_restore') {
      return restoreClaudeTurnDeleteBackup(claudeHome, {
        backupRoot: claudeTurnBackupRoot,
        backupDir: undo.backupDir,
        expectedCurrentHash: undo.expectedCurrentHash,
      });
    }
    if (undo.type === 'claude_message_edit_restore') {
      return restoreClaudeMessageEdit(claudeHome, {
        backupRoot: undo.backupRoot,
        backupDir: undo.backupDir,
        expectedCurrentHash: undo.expectedCurrentHash,
      });
    }
    if (undo.type === 'project_path_migration_restore') {
      if (undo.platform === 'codex') {
        const check = options.codexProcessCheck || await detectRunningCodexProcesses();
        if (check.available && check.processes.length) {
          throw new CleanerError('CODEX_STILL_RUNNING', 'Close every Codex window and terminal session before restoring a project path migration.', 409);
        }
      }
      return restoreProjectPathMigration(
        undo.platform,
        undo.platform === 'claude' ? claudeHome : codexHome,
        { backupRoot: undo.backupRoot, backupDir: undo.backupDir },
      );
    }
    if (undo.type === 'codex_session_import_restore') {
      return undoCodexSessionImport(codexHome, {
        backupRoot,
        manifestPath: undo.manifestPath,
        codexProcessCheck: options.codexProcessCheck,
      });
    }
    throw new CleanerError('UNDO_NOT_SUPPORTED', 'The latest operation does not have a supported restore point.', 409);
  }

  async function loadRegistry({ refresh = false } = {}) {
    if (refresh || !registryCache) {
      registryCache = await buildSessionRegistry(codexHome, { backupRoot, env });
    }
    return registryCache;
  }

  async function loadSessions(options = {}) {
    return (await loadRegistry(options)).sessions;
  }

  async function loadClaudeRegistry({ refresh = false } = {}) {
    if (refresh || !claudeRegistryCache) {
      claudeRegistryCache = await buildClaudeSessionRegistry(claudeHome);
    }
    return claudeRegistryCache;
  }

  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');

      if (requestUrl.pathname === '/api/health' && request.method === 'GET') {
        sendJson(response, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === '/api/system/select-directory' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.initialPath !== undefined && typeof body.initialPath !== 'string') {
          throw new CleanerError('INVALID_INITIAL_DIRECTORY', 'Initial directory must be a string.', 400);
        }
        let selectedPath;
        try {
          selectedPath = await (options.directoryPicker || pickDirectory)({ initialPath: body.initialPath || '' });
        } catch {
          throw new CleanerError('DIRECTORY_PICKER_FAILED', '无法打开系统目录选择窗口。', 500);
        }
        sendJson(response, 200, { canceled: !selectedPath, path: selectedPath || null });
        return;
      }

      if (requestUrl.pathname === '/api/operation-history' && request.method === 'GET') {
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '100', 10);
        sendJson(response, 200, await operationHistory.list({
          limit: Number.isInteger(limit) ? limit : 100,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/codex-session-transfer/export' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        const sessionIds = [...new Set((body.sessionIds || []).map(String))];
        const attemptId = randomUUID();
        try {
          const download = await createCodexSessionPackage(codexHome, {
            backupRoot,
            transferRoot,
            env,
            sessionIds,
            keepFile: true,
          });
          lastSessionExportAttempt = {
            attemptId,
            at: new Date().toISOString(),
            status: 'success',
            sessionIds,
            sessionCount: download.sessionCount,
            sizeBytes: download.sizeBytes,
          };
          await sendFileDownload(response, download);
        } catch (error) {
          lastSessionExportAttempt = {
            attemptId,
            at: new Date().toISOString(),
            status: 'failed',
            sessionIds,
            error: {
              code: error?.code || 'INTERNAL_ERROR',
              message: error?.message || 'Unexpected export error.',
              details: error?.details || {},
            },
          };
          throw error;
        }
        return;
      }

      if (requestUrl.pathname === '/api/codex-session-transfer/export-diagnostic' && request.method === 'GET') {
        sendJson(response, 200, { lastAttempt: lastSessionExportAttempt });
        return;
      }

      if (requestUrl.pathname === '/api/codex-session-transfer/import-upload' && request.method === 'POST') {
        sendJson(response, 201, await stageCodexSessionPackageStream(request, transferRoot, {
          declaredBytes: request.headers['content-length'],
        }));
        return;
      }

      if (requestUrl.pathname === '/api/codex-session-transfer/import-preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        const plan = await previewCodexSessionImport(codexHome, {
          backupRoot,
          transferRoot,
          env,
          transferId: body.transferId,
          pathMappings: body.pathMappings,
          mode: body.mode,
          codexProcessCheck: options.codexProcessCheck,
        });
        const { packagePath: _packagePath, ...publicPlan } = plan;
        sendJson(response, 200, publicPlan);
        return;
      }

      if (requestUrl.pathname === '/api/codex-session-transfer/import-apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'IMPORT') {
          throw new CleanerError('SESSION_IMPORT_CONFIRMATION_REQUIRED', 'Type IMPORT to import the selected Codex sessions.', 400);
        }
        const preview = await previewCodexSessionImport(codexHome, {
          backupRoot, transferRoot, env, transferId: body.transferId,
          pathMappings: body.pathMappings, mode: body.mode,
          codexProcessCheck: options.codexProcessCheck,
        });
        const result = await executeRecordedOperation({
          kind: 'codex_session_import',
          label: preview.mode === 'history' ? '导入 Codex 历史会话' : '导入 Codex 会话并恢复续聊',
          sessionIds: preview.sessions.filter((session) => session.action === 'import').map((session) => session.id),
          details: {
            mode: preview.mode,
            transferId: body.transferId,
            count: preview.summary.importable,
            sessionTitles: Object.fromEntries(preview.sessions.map((session) => [session.id, session.title || '(无标题会话)'])),
          },
        }, () => applyCodexSessionImport(codexHome, {
          backupRoot, transferRoot, env, transferId: body.transferId,
          pathMappings: body.pathMappings, mode: body.mode,
          planToken: body.planToken,
          codexProcessCheck: options.codexProcessCheck,
        }), (value) => ({
          result: { importedSessions: value.preview.summary.importable, mode: value.preview.mode, restartRequired: value.restartRequired },
          undo: { type: 'codex_session_import_restore', manifestPath: value.manifestPath },
        }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/operation-history/undo-latest' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'UNDO') {
          throw new CleanerError('UNDO_CONFIRMATION_REQUIRED', 'Type UNDO to undo the latest operation.', 400);
        }
        const history = await operationHistory.list({ limit: 1 });
        const latest = history.latest;
        if (!latest || body.operationId !== latest.id) {
          throw new CleanerError('STALE_UNDO_REQUEST', 'The latest operation changed. Refresh operation history and try again.', 409);
        }
        if (!latest.canUndo || !latest.undo) {
          throw new CleanerError('UNDO_NOT_AVAILABLE', 'The latest operation is not reversible from operation history.', 409);
        }
        const result = await executeRecordedOperation({
          kind: 'undo',
          label: `撤销：${latest.label}`,
          sessionIds: latest.sessionIds,
          details: { originalOperationId: latest.id },
        }, () => executeUndo(latest.undo), (undoResult) => ({
          result: {
            originalOperationId: latest.id,
            restartRequired: Boolean(undoResult.restartRequired),
            claudeRestartRecommended: Boolean(undoResult.claudeRestartRecommended),
          },
        }));
        await operationHistory.markUndone(latest.id, result.operationId);
        registryCache = null;
        claudeRegistryCache = null;
        sendJson(response, 200, { ...result, undoneOperationId: latest.id });
        return;
      }

      if (requestUrl.pathname === '/api/operation-history/undo' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'UNDO') {
          throw new CleanerError('UNDO_CONFIRMATION_REQUIRED', 'Type UNDO to roll back this operation.', 400);
        }
        const history = await operationHistory.list({ limit: 500 });
        const original = history.operations.find((operation) => operation.id === body.operationId);
        if (!original || !original.canUndo || !original.undo) {
          throw new CleanerError('UNDO_NOT_AVAILABLE', 'This operation cannot be rolled back.', 409);
        }
        const result = await executeRecordedOperation({
          kind: 'undo',
          label: `回退：${original.label}`,
          sessionIds: original.sessionIds,
          details: { originalOperationId: original.id },
        }, () => executeUndo(original.undo), (undoResult) => ({
          result: {
            originalOperationId: original.id,
            restartRequired: Boolean(undoResult.restartRequired),
            claudeRestartRecommended: Boolean(undoResult.claudeRestartRecommended),
          },
        }));
        await operationHistory.markUndone(original.id, result.operationId);
        registryCache = null;
        claudeRegistryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/project-path-migrations/preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        const claude = projectPathPlatform(body.platform) === 'claude';
        const plan = claude
          ? await previewClaudeProjectPathMigration(claudeHome, {
            fromPath: body.fromPath,
            toPath: body.toPath,
            backupRoot: claudeTurnBackupRoot,
          })
          : await previewCodexProjectPathMigration(codexHome, {
            fromPath: body.fromPath,
            toPath: body.toPath,
            backupRoot,
            env,
            codexProcessCheck: options.codexProcessCheck,
          });
        sendJson(response, 200, publicProjectPathPlan(plan));
        return;
      }

      if (requestUrl.pathname === '/api/project-path-migrations/apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'MIGRATE') {
          throw new CleanerError('PROJECT_PATH_MIGRATION_CONFIRMATION_REQUIRED', 'Type MIGRATE to migrate the selected project path.', 400);
        }
        const claude = projectPathPlatform(body.platform) === 'claude';
        const preview = claude
          ? await previewClaudeProjectPathMigration(claudeHome, { fromPath: body.fromPath, toPath: body.toPath, backupRoot: claudeTurnBackupRoot })
          : await previewCodexProjectPathMigration(codexHome, { fromPath: body.fromPath, toPath: body.toPath, backupRoot, env, codexProcessCheck: options.codexProcessCheck });
        const result = await executeRecordedOperation({
          kind: claude ? 'claude_project_path_migration' : 'project_path_migration',
          label: claude ? '迁移 Claude Code 项目路径' : '迁移 Codex 项目路径',
          sessionIds: preview.sessionIds,
          details: { fromPath: preview.fromPath, toPath: preview.toPath },
        }, () => (claude
          ? applyClaudeProjectPathMigration(claudeHome, {
            fromPath: body.fromPath,
            toPath: body.toPath,
            planToken: body.planToken,
            backupRoot: claudeTurnBackupRoot,
          })
          : applyCodexProjectPathMigration(codexHome, {
            fromPath: body.fromPath,
            toPath: body.toPath,
            planToken: body.planToken,
            backupRoot,
            env,
            codexProcessCheck: options.codexProcessCheck,
          })), (value) => ({
          result: {
            count: value.preview.sessionIds.length,
            fromPath: value.preview.fromPath,
            toPath: value.preview.toPath,
            restartRequired: Boolean(value.restartRequired),
            claudeRestartRecommended: Boolean(value.claudeRestartRecommended),
          },
          undo: {
            type: 'project_path_migration_restore',
            platform: claude ? 'claude' : 'codex',
            backupRoot: claude ? claudeTurnBackupRoot : backupRoot,
            backupDir: value.backup.backupDir,
          },
        }));
        registryCache = null;
        claudeRegistryCache = null;
        sendJson(response, 200, {
          ...result,
          preview: publicProjectPathPlan(result.preview),
          backup: result.backup ? { backupDir: result.backup.backupDir } : null,
        });
        return;
      }

      if (requestUrl.pathname === '/api/operation-history/restore-history-error' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'RESTORE') {
          throw new CleanerError('RESTORE_CONFIRMATION_REQUIRED', 'Type RESTORE to restore this failed history turn.', 400);
        }
        const history = await operationHistory.list({ limit: 500 });
        const original = history.operations.find((operation) => operation.id === body.operationId);
        if (!original || !original.canRestore || !original.undo) {
          throw new CleanerError('HISTORY_ERROR_RESTORE_NOT_AVAILABLE', 'This history failure deletion is not available for restore.', 409);
        }
        const result = await executeRecordedOperation({
          kind: 'history_error_restore',
          label: '恢复分页历史失败轮次',
          sessionIds: original.sessionIds,
          details: { originalOperationId: original.id },
        }, () => executeUndo(original.undo), (value) => ({
          result: { turnId: value.turnId, restoredTurns: value.turnRows, restoredItems: value.itemRows },
        }));
        await operationHistory.markUndone(original.id, result.operationId);
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/sessions' && request.method === 'GET') {
        const registry = await loadRegistry({ refresh: true });
        const sessions = registry.sessions;
        sendJson(response, 200, {
          codexHome,
          directories: listProjectDirectories(sessions),
          sessions,
          currentProvider: registry.currentProvider,
          stateDbPath: registry.stateDbPath,
          sqliteAvailable: registry.sqliteAvailable,
          registrySummary: registry.summary,
        });
        return;
      }

      if (requestUrl.pathname === '/api/claude-code/sessions' && request.method === 'GET') {
        sendJson(response, 200, await loadClaudeRegistry({ refresh: true }));
        return;
      }

      const claudeTurnsMatch = requestUrl.pathname.match(/^\/api\/claude-code\/sessions\/([^/]+)\/turns$/);
      if (claudeTurnsMatch && request.method === 'GET') {
        sendJson(response, 200, await readClaudeSessionTurns(
          claudeHome,
          decodeURIComponent(claudeTurnsMatch[1]),
        ));
        return;
      }

      const claudeTurnMatch = requestUrl.pathname.match(/^\/api\/claude-code\/sessions\/([^/]+)\/turns\/([^/]+)$/);
      if (claudeTurnMatch && request.method === 'GET') {
        sendJson(response, 200, await readClaudeTurnDetail(
          claudeHome,
          decodeURIComponent(claudeTurnMatch[1]),
          decodeURIComponent(claudeTurnMatch[2]),
        ));
        return;
      }

      const claudeContextMatch = requestUrl.pathname.match(/^\/api\/claude-code\/sessions\/([^/]+)\/context$/);
      if (claudeContextMatch && request.method === 'GET') {
        const turnId = requestUrl.searchParams.get('turnId');
        if (!turnId) {
          throw new CleanerError('MISSING_CLAUDE_TURN', 'Select a Claude conversation turn before reading context.', 400);
        }
        const integerParam = (name, fallback) => {
          const value = requestUrl.searchParams.get(name);
          if (value === null || value === '') return fallback;
          const parsed = Number.parseInt(value, 10);
          return Number.isInteger(parsed) ? parsed : Number.NaN;
        };
        sendJson(response, 200, {
          detail: await readClaudeFullContext(
            claudeHome,
            decodeURIComponent(claudeContextMatch[1]),
            turnId,
            {
              offset: integerParam('offset', 0),
              limit: integerParam('limit', 50),
              lineNumber: integerParam('lineNumber', null),
              query: requestUrl.searchParams.get('query') || '',
              role: requestUrl.searchParams.get('role') || 'all',
              source: requestUrl.searchParams.get('source') || 'all',
              category: requestUrl.searchParams.get('category') || 'all',
              scope: requestUrl.searchParams.get('scope') || 'all',
            },
          ),
        });
        return;
      }

      const claudeTurnDeletePreviewMatch = requestUrl.pathname.match(/^\/api\/claude-code\/sessions\/([^/]+)\/turns\/([^/]+)\/delete-preview$/);
      if (claudeTurnDeletePreviewMatch && request.method === 'POST') {
        const body = await readJsonRequest(request);
        const result = await previewClaudeTurnDeletion(
          claudeHome,
          decodeURIComponent(claudeTurnDeletePreviewMatch[1]),
          decodeURIComponent(claudeTurnDeletePreviewMatch[2]),
          { mode: body.mode, backupRoot: claudeTurnBackupRoot },
        );
        sendJson(response, 200, {
          backupRoot: result.backupRoot,
          sourceHash: result.sourceHash,
          preview: {
            mode: result.mode,
            turn: result.turn,
            nextTurn: result.nextTurn,
            startLine: result.startLine,
            endLine: result.endLine,
            removedCount: result.removedRecordCount,
            keptCount: result.keptRecordCount,
            externalArtifacts: result.externalArtifacts,
          },
        });
        return;
      }

      const claudeTurnDeleteApplyMatch = requestUrl.pathname.match(/^\/api\/claude-code\/sessions\/([^/]+)\/turns\/([^/]+)\/delete-apply$/);
      if (claudeTurnDeleteApplyMatch && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'DELETE') {
          throw new CleanerError('CLAUDE_TURN_DELETE_CONFIRMATION_REQUIRED', 'Type DELETE to delete this Claude conversation turn.', 400);
        }
        const sessionId = decodeURIComponent(claudeTurnDeleteApplyMatch[1]);
        const turnId = decodeURIComponent(claudeTurnDeleteApplyMatch[2]);
        const result = await executeRecordedOperation({
          kind: body.mode === 'truncate' ? 'claude_turn_delete_truncate' : 'claude_turn_delete_single',
          label: body.mode === 'truncate' ? '从选中轮次清理 Claude 会话' : '删除选中 Claude 轮次',
          sessionIds: [sessionId],
          details: { turnId, mode: body.mode },
          details: { turnId },
        }, () => applyClaudeTurnDeletion(claudeHome, sessionId, turnId, {
          mode: body.mode,
          sourceHash: body.sourceHash,
          backupRoot: claudeTurnBackupRoot,
        }), (value) => ({
          result: {
            deleted: value.deleted,
            claudeRefreshRecommended: value.claudeRefreshRecommended,
          },
          undo: {
            type: 'claude_turn_delete_restore',
            backupDir: value.backup.backupDir,
            expectedCurrentHash: value.sourceHashAfter,
          },
        }));
        claudeRegistryCache = null;
        sendJson(response, 200, result);
        return;
      }

      const claudeEditPreviewMatch = requestUrl.pathname.match(/^\/api\/claude-code\/sessions\/([^/]+)\/turns\/([^/]+)\/edit-preview$/);
      if (claudeEditPreviewMatch && request.method === 'POST') {
        const body = await readJsonRequest(request);
        const sessionId = decodeURIComponent(claudeEditPreviewMatch[1]);
        const turnId = decodeURIComponent(claudeEditPreviewMatch[2]);
        const result = await previewClaudeMessageEdits(claudeHome, sessionId, turnId, body.edits, { backupRoot: claudeTurnBackupRoot });
        sendJson(response, 200, { preview: result, sourceHash: result.sourceHash, targetSessionLock: await inspectTargetSessionLocks(codexHome, []) });
        return;
      }

      const claudeEditApplyMatch = requestUrl.pathname.match(/^\/api\/claude-code\/sessions\/([^/]+)\/turns\/([^/]+)\/edit-apply$/);
      if (claudeEditApplyMatch && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'EDIT') throw new CleanerError('CLAUDE_EDIT_CONFIRMATION_REQUIRED', 'Type EDIT to apply Claude message changes.', 400);
        const sessionId = decodeURIComponent(claudeEditApplyMatch[1]);
        const turnId = decodeURIComponent(claudeEditApplyMatch[2]);
        const result = await executeRecordedOperation({ kind: 'claude_message_edit', label: '编辑 Claude 会话消息', sessionIds: [sessionId], details: { turnId, changedMessages: body.edits?.length || 0 } }, () => applyClaudeMessageEdits(claudeHome, sessionId, turnId, body.edits, { sourceHash: body.sourceHash, backupRoot: claudeTurnBackupRoot }), (value) => ({
          result: { editedMessages: value.changedCount, claudeRefreshRecommended: true },
          undo: { type: 'claude_message_edit_restore', backupRoot: claudeTurnBackupRoot, backupDir: value.backupDir, expectedCurrentHash: value.sourceHashAfter },
        }));
        claudeRegistryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/claude-code/edit-restore' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'RESTORE') throw new CleanerError('CLAUDE_EDIT_RESTORE_CONFIRMATION_REQUIRED', 'Type RESTORE to undo Claude message changes.', 400);
        const result = await restoreClaudeMessageEdit(claudeHome, { backupRoot: claudeTurnBackupRoot, backupDir: body.backupDir, expectedCurrentHash: body.expectedCurrentHash });
        claudeRegistryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/claude-code/session-deletions/preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await previewClaudeSessionDeletion(claudeHome, {
          backupRoot: claudeBackupRoot,
          sessionId: body.sessionId,
          sessionIds: body.sessionIds,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/claude-code/session-deletions/apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'PURGE') {
          throw new CleanerError('CLAUDE_SESSION_DELETE_CONFIRMATION_REQUIRED', 'Type PURGE to delete the selected Claude Code sessions.', 400);
        }
        const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds : [body.sessionId];
        const result = await executeRecordedOperation({
          kind: sessionIds.length > 1 ? 'claude_session_batch_delete' : 'claude_session_delete',
          label: sessionIds.length > 1 ? '批量删除 Claude 会话' : '删除 Claude 会话',
          sessionIds,
        }, () => applyClaudeSessionDeletion(claudeHome, {
          backupRoot: claudeBackupRoot,
          sessionId: body.sessionId,
          sessionIds: body.sessionIds,
          planToken: body.planToken,
        }), (value) => ({
          result: { deleted: value.deleted, claudeRefreshRecommended: value.claudeRefreshRecommended },
          undo: value.backup?.id ? {
            type: 'claude_session_delete_restore',
            backupId: value.backup.id,
            sessionIds: value.deleted.sessionIds,
          } : null,
        }));
        claudeRegistryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/claude-code/session-deletion-backups' && request.method === 'GET') {
        sendJson(response, 200, await listClaudeSessionDeletionBackups(claudeHome, { backupRoot: claudeBackupRoot }));
        return;
      }

      if (requestUrl.pathname === '/api/claude-code/session-deletion-backups/delete' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'ERASE') {
          throw new CleanerError('CLAUDE_BACKUP_DELETE_CONFIRMATION_REQUIRED', 'Type ERASE to permanently delete selected Claude backups.', 400);
        }
        const result = await executeRecordedOperation({
          kind: 'claude_deletion_backup_delete',
          label: '永久删除 Claude 会话备份',
          details: { backupIds: body.backupIds },
        }, () => deleteClaudeSessionDeletionBackups(claudeHome, {
          backupRoot: claudeBackupRoot,
          backupIds: body.backupIds,
        }), (value) => ({ result: { count: value.deletedCount, sizeBytes: value.freedBytes } }));
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/claude-code/session-deletion-backups/restore-preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await previewClaudeSessionDeletionBackupRestore(claudeHome, {
          backupRoot: claudeBackupRoot,
          backupId: body.backupId,
          sessionIds: body.sessionIds,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/claude-code/session-deletion-backups/content' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await readClaudeSessionDeletionBackupContent(claudeHome, {
          backupRoot: claudeBackupRoot,
          backupId: body.backupId,
          sessionId: body.sessionId,
          offset: body.offset,
          limit: body.limit,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/claude-code/session-deletion-backups/restore-apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'RESTORE') {
          throw new CleanerError('CLAUDE_BACKUP_RESTORE_CONFIRMATION_REQUIRED', 'Type RESTORE to restore selected Claude sessions.', 400);
        }
        const result = await executeRecordedOperation({
          kind: 'claude_deletion_backup_restore',
          label: '从 Claude 删除备份恢复',
          sessionIds: body.sessionIds,
          details: { backupId: body.backupId },
        }, () => applyClaudeSessionDeletionBackupRestore(claudeHome, {
          backupRoot: claudeBackupRoot,
          backupId: body.backupId,
          sessionIds: body.sessionIds,
          planToken: body.planToken,
        }), (value) => ({ result: { restored: value.restored, claudeRestartRecommended: value.claudeRestartRecommended } }));
        claudeRegistryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/visibility/preview' && request.method === 'GET') {
        sendJson(response, 200, await previewCodexVisibilityRepair(codexHome, {
          backupRoot,
          env,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/visibility/apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'SYNC') {
          throw new CleanerError(
            'VISIBILITY_CONFIRMATION_REQUIRED',
            'Type SYNC to make recoverable sessions visible to Codex.',
            400,
          );
        }
        const result = await executeRecordedOperation({
          kind: 'visibility_repair',
          label: '修复 Codex 会话可见性',
        }, () => applyCodexVisibilityRepair(codexHome, {
          backupRoot,
          env,
          planToken: body.planToken,
        }), (value) => ({
          result: {
            changedRollouts: value.changedRollouts,
            restoredRollouts: value.restoredRollouts,
            changedSqliteRows: value.changedSqliteRows,
            restartRequired: value.restartRequired,
          },
          undo: value.backup?.backupDir ? {
            type: 'visibility_restore',
            backupId: path.basename(value.backup.backupDir),
          } : null,
        }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/session-delete/preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await previewSessionDeletion(codexHome, {
          backupRoot,
          env,
          sessionId: body.sessionId,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/session-delete/apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'PURGE') {
          throw new CleanerError(
            'SESSION_DELETE_CONFIRMATION_REQUIRED',
            'Type PURGE to delete the whole session.',
            400,
          );
        }
        const result = await executeRecordedOperation({
          kind: 'session_delete',
          label: '删除会话',
          sessionIds: [body.sessionId],
        }, () => applySessionDeletion(codexHome, {
          backupRoot,
          env,
          sessionId: body.sessionId,
          planToken: body.planToken,
        }), (value) => ({
          result: { deleted: value.deleted, codexRefreshRecommended: value.codexRefreshRecommended },
          undo: value.backup?.backupDir ? {
            type: 'session_delete_restore',
            backupId: path.basename(value.backup.backupDir),
            sessionIds: [body.sessionId],
          } : null,
        }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/session-delete/batch-preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await previewSessionDeletionBatch(codexHome, {
          backupRoot,
          env,
          sessionIds: body.sessionIds,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/session-delete/batch-apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'PURGE') {
          throw new CleanerError(
            'SESSION_DELETE_CONFIRMATION_REQUIRED',
            'Type PURGE to batch-delete whole sessions.',
            400,
          );
        }
        const result = await executeRecordedOperation({
          kind: 'session_batch_delete',
          label: '批量删除会话',
          sessionIds: body.sessionIds,
        }, () => applySessionDeletionBatch(codexHome, {
          backupRoot,
          env,
          sessionIds: body.sessionIds,
          planToken: body.planToken,
        }), (value) => ({
          result: { deleted: value.deleted, codexRefreshRecommended: value.codexRefreshRecommended },
          undo: value.backup?.backupDir ? {
            type: 'session_delete_restore',
            backupId: path.basename(value.backup.backupDir),
            sessionIds: body.sessionIds,
          } : null,
        }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/deletion-backups' && request.method === 'GET') {
        sendJson(response, 200, await listSessionDeletionBackups(codexHome, { backupRoot }));
        return;
      }

      if (requestUrl.pathname === '/api/deletion-backups/delete' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'ERASE') {
          throw new CleanerError(
            'BACKUP_DELETE_CONFIRMATION_REQUIRED',
            'Type ERASE to permanently delete selected backups.',
            400,
          );
        }
        const result = await executeRecordedOperation({
          kind: 'deletion_backup_delete',
          label: '永久删除会话备份',
          details: { backupIds: body.backupIds },
        }, () => deleteSessionDeletionBackups(codexHome, {
          backupRoot,
          backupIds: body.backupIds,
        }), (value) => ({ result: value.summary }));
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/deletion-backups/restore-preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await previewSessionDeletionBackupRestore(codexHome, {
          backupRoot,
          env,
          backupId: body.backupId,
          sessionIds: body.sessionIds,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/deletion-backups/content' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await readSessionDeletionBackupContent(codexHome, {
          backupRoot,
          env,
          backupId: body.backupId,
          sessionId: body.sessionId,
          offset: body.offset,
          limit: body.limit,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/deletion-backups/restore-apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'RESTORE') {
          throw new CleanerError(
            'BACKUP_RESTORE_CONFIRMATION_REQUIRED',
            'Type RESTORE to restore selected deleted sessions.',
            400,
          );
        }
        const result = await executeRecordedOperation({
          kind: 'deletion_backup_restore',
          label: '从会话删除备份恢复',
          sessionIds: body.sessionIds,
          details: { backupId: body.backupId },
        }, () => applySessionDeletionBackupRestore(codexHome, {
          backupRoot,
          env,
          backupId: body.backupId,
          sessionIds: body.sessionIds,
          planToken: body.planToken,
        }), (value) => ({ result: { restored: value.restored, restartRequired: value.restartRequired } }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/operation-backups' && request.method === 'GET') {
        sendJson(response, 200, await listOperationBackups(codexHome, { backupRoot }));
        return;
      }

      if (requestUrl.pathname === '/api/operation-backups/delete' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'ERASE') {
          throw new CleanerError(
            'BACKUP_DELETE_CONFIRMATION_REQUIRED',
            'Type ERASE to permanently delete selected session snapshots.',
            400,
          );
        }
        const result = await executeRecordedOperation({
          kind: 'operation_backup_delete',
          label: '永久删除轮次操作快照',
          details: { backupIds: body.backupIds },
        }, () => deleteOperationBackups(codexHome, {
          backupRoot,
          backupIds: body.backupIds,
        }), (value) => ({ result: value.summary }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/operation-backups/restore-preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await previewOperationBackupRestore(codexHome, {
          backupRoot,
          env,
          backupId: body.backupId,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/operation-backups/content' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await readOperationBackupContent(codexHome, {
          backupRoot,
          env,
          backupId: body.backupId,
          offset: body.offset,
          limit: body.limit,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/operation-backups/restore-apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'RESTORE') {
          throw new CleanerError(
            'BACKUP_RESTORE_CONFIRMATION_REQUIRED',
            'Type RESTORE to restore the selected session snapshot.',
            400,
          );
        }
        const result = await executeRecordedOperation({
          kind: 'operation_backup_restore',
          label: '从轮次操作快照恢复',
          details: { backupId: body.backupId },
        }, () => applyOperationBackupRestore(codexHome, {
          backupRoot,
          env,
          backupId: body.backupId,
          planToken: body.planToken,
        }), (value) => ({ result: { restored: value.restored, restartRequired: value.restartRequired } }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/system-backups' && request.method === 'GET') {
        sendJson(response, 200, await listSystemBackups(codexHome, { backupRoot }));
        return;
      }

      if (requestUrl.pathname === '/api/system-backups/delete' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'ERASE') {
          throw new CleanerError(
            'BACKUP_DELETE_CONFIRMATION_REQUIRED',
            'Type ERASE to permanently delete selected system backups.',
            400,
          );
        }
        const result = await executeRecordedOperation({
          kind: 'system_backup_delete',
          label: '永久删除系统安全备份',
          details: { backupIds: body.backupIds },
        }, () => deleteSystemBackups(codexHome, {
          backupRoot,
          backupIds: body.backupIds,
        }), (value) => ({ result: value.summary }));
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/system-backups/visibility-restore-preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        sendJson(response, 200, await previewVisibilityBackupRestore(codexHome, {
          backupRoot,
          env,
          backupId: body.backupId,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/system-backups/visibility-restore-apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'ROLLBACK') {
          throw new CleanerError('VISIBILITY_RESTORE_CONFIRMATION_REQUIRED', 'Type ROLLBACK to restore provider state.', 400);
        }
        const result = await executeRecordedOperation({
          kind: 'visibility_backup_restore',
          label: '恢复可见性修复前的供应商状态',
          details: { backupId: body.backupId },
        }, () => applyVisibilityBackupRestore(codexHome, {
          backupRoot,
          env,
          backupId: body.backupId,
          planToken: body.planToken,
        }), (value) => ({
          result: {
            restoredRollouts: value.restoredRollouts,
            restoredSqliteRows: value.restoredSqliteRows,
            restartRequired: value.restartRequired,
          },
        }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      const healthMatch = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/health$/);
      if (healthMatch && request.method === 'GET') {
        const registry = await loadRegistry({ refresh: true });
        const session = await getSession(
          codexHome,
          decodeURIComponent(healthMatch[1]),
          registry.sessions,
        );
        sendJson(response, 200, await diagnoseSessionHealth(codexHome, session, {
          currentProvider: registry.currentProvider,
        }));
        return;
      }

      const turnsMatch = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/turns$/);
      if (turnsMatch && request.method === 'GET') {
        const session = await getSession(codexHome, decodeURIComponent(turnsMatch[1]), await loadSessions());
        if (!session.rolloutPath) {
          throw new CleanerError('ROLLOUT_NOT_FOUND', 'No rollout JSONL was found for this session.', 404);
        }
        let records;
        try {
          records = await readRollout(session.rolloutPath);
        } catch (error) {
          if (error instanceof CleanerError) throw error;
          throw new CleanerError(
            'ROLLOUT_READ_FAILED',
            'The formal Codex rollout could not be read.',
            500,
            { sessionId: session.id, rolloutPath: session.rolloutPath, technicalMessage: error?.message || String(error) },
          );
        }
        let history;
        try {
          history = await (options.threadHistoryTurnReader || readThreadHistoryTurnRows)(codexHome, [session.id]);
        } catch (error) {
          const errorId = randomUUID();
          reportServerError({
            level: 'error',
            event: 'thread_history_read_failed',
            errorId,
            sessionId: session.id,
            error: { name: error?.name || 'Error', code: error?.code || null, message: error?.message || String(error) },
          });
          history = {
            available: false,
            dbPath: error?.details?.dbPath || null,
            rows: [],
            reason: 'read_failed',
            error: {
              code: 'THREAD_HISTORY_READ_FAILED',
              errorId,
              technicalMessage: error?.message || String(error),
            },
          };
        }
        const merged = mergeThreadHistoryTurnRows(listTurnsFromRecords(records), history.rows);
        sendJson(response, 200, {
          session,
          turns: merged.turns,
          historyErrors: merged.unmatchedErrors,
          threadHistory: {
            available: history.available,
            dbPath: history.dbPath,
            rowCount: history.rows.length,
            reason: history.reason || null,
            capabilities: history.capabilities || null,
            error: history.error || null,
          },
          recordCount: records.length,
        });
        return;
      }

      const historyErrorDeleteMatch = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/history-errors\/([^/]+)\/delete$/);
      if (historyErrorDeleteMatch && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'DELETE') {
          throw new CleanerError('CONFIRMATION_REQUIRED', 'Type DELETE to remove this failed history turn.', 400);
        }
        const sessionId = decodeURIComponent(historyErrorDeleteMatch[1]);
        const turnId = decodeURIComponent(historyErrorDeleteMatch[2]);
        const session = await getSession(codexHome, sessionId, await loadSessions());
        if (!session.rolloutPath) throw new CleanerError('ROLLOUT_NOT_FOUND', 'No rollout JSONL was found for this session.', 404);
        const records = await readRollout(session.rolloutPath);
        const rolloutTurnIds = listTurnsFromRecords(records).map((turn) => turn.turnId).filter(Boolean);
        const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
        const backupDir = path.join(backupRoot, 'history-error-deletions', `${timestamp}-${sessionId}-${turnId}`);
        const result = await executeRecordedOperation({
          kind: 'history_error_delete',
          label: '删除孤立分页历史失败轮次',
          sessionIds: [sessionId],
          details: { turnId },
        }, () => withTargetSessionLocks(codexHome, [sessionId], {
          errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
        }, async () => {
          await mkdir(backupDir, { recursive: true });
          const backup = await prepareThreadHistoryMutation(codexHome, [sessionId], backupDir);
          const deleted = await deleteOrphanFailedHistoryTurn(codexHome, { sessionId, turnId, rolloutTurnIds }, {
            errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
          });
          const manifestPath = path.join(backupDir, 'removed-turn.json');
          await writeFile(manifestPath, JSON.stringify(deleted.removed, null, 2), 'utf8');
          return { ...deleted, backup, manifestPath };
        }), (value) => ({
          result: { turnId, removedTurns: value.turnRows, removedItems: value.itemRows },
          undo: { type: 'history_turn_restore', manifestPath: value.manifestPath },
        }));
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/turn-detail' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        const sessions = body.rolloutPath ? null : await loadSessions();
        const rolloutPath = await resolveRolloutFromBody(codexHome, body, sessions);
        sendJson(response, 200, {
          backupRoot,
          detail: await readTurnMessageDetail({
            rolloutPath,
            selector: requireSelector(body),
          }),
        });
        return;
      }

      if (requestUrl.pathname === '/api/full-context' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        const sessions = body.rolloutPath ? null : await loadSessions();
        const rolloutPath = await resolveRolloutFromBody(codexHome, body, sessions);
        sendJson(response, 200, {
          detail: await readFullContextView({
            rolloutPath,
            selector: requireSelector(body),
            offset: body.offset ?? 0,
            limit: body.limit ?? 50,
            lineNumber: body.lineNumber,
            query: body.query,
            role: body.role,
            category: body.category,
            scope: body.scope,
          }),
        });
        return;
      }

      if (requestUrl.pathname === '/api/full-context/export' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (!body.sessionId) {
          throw new CleanerError('MISSING_SESSION', 'Select a registered session before exporting context.', 400);
        }
        const rolloutPath = await resolveRolloutFromBody(
          codexHome,
          { sessionId: body.sessionId },
          await loadSessions(),
        );
        sendDownload(response, await readFullContextExport({
          rolloutPath,
          sessionId: body.sessionId,
          selector: requireSelector(body),
          format: body.format,
          query: body.query,
          role: body.role,
          category: body.category,
          scope: body.scope,
        }));
        return;
      }

      if (requestUrl.pathname === '/api/edit-preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        const sessions = body.rolloutPath ? null : await loadSessions();
        const { rolloutPath, sessionId } = await resolveMutationTarget(codexHome, body, sessions);
        const result = await previewMessageEdits({
          rolloutPath,
          selector: requireSelector(body),
          edits: body.edits,
          sourceHash: body.sourceHash,
        });
        sendJson(response, 200, {
          backupRoot,
          ...result,
          targetSessionLock: await inspectTargetSessionLocks(codexHome, [sessionId]),
        });
        return;
      }

      if (requestUrl.pathname === '/api/edit-apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'EDIT') {
          throw new CleanerError('EDIT_CONFIRMATION_REQUIRED', 'Type EDIT to apply message changes.', 400);
        }
        const sessions = body.rolloutPath ? null : await loadSessions();
        const { rolloutPath, sessionId } = await resolveMutationTarget(codexHome, body, sessions);
        const result = await executeRecordedOperation({
          kind: 'message_edit',
          label: '编辑会话消息',
          sessionIds: [sessionId],
          details: { selector: requireSelector(body), changedMessages: body.edits?.length || 0 },
        }, () => applyMessageEdits({
          codexHome,
          sessionId,
          rolloutPath,
          selector: requireSelector(body),
          edits: body.edits,
          sourceHash: body.sourceHash,
          backupRoot,
        }), (value) => ({
          result: { editedMessages: value.preview?.summary?.changedMessages || value.preview?.edits?.length || 0 },
          undo: {
            type: 'rollout_restore',
            sessionId,
            rolloutPath: value.rolloutPath,
            backupPath: value.backupFile,
            expectedCurrentHash: value.sourceHashAfter,
          },
        }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/edit-restore' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'RESTORE') {
          throw new CleanerError('RESTORE_CONFIRMATION_REQUIRED', 'Type RESTORE to undo this edit.', 400);
        }
        const sessions = body.rolloutPath ? null : await loadSessions();
        const { rolloutPath, sessionId } = await resolveMutationTarget(codexHome, body, sessions);
        const result = await executeRecordedOperation({
          kind: 'message_edit_restore',
          label: '恢复编辑前的会话消息',
          sessionIds: [sessionId],
          details: { backupPath: body.backupPath },
        }, () => restoreRolloutBackup({
          codexHome,
          sessionId,
          rolloutPath,
          backupPath: body.backupPath,
          expectedCurrentHash: body.expectedCurrentHash,
          backupRoot,
        }), (value) => ({
          result: { restoredFrom: value.restoredFrom },
          undo: {
            type: 'rollout_restore',
            sessionId,
            rolloutPath: value.rolloutPath,
            backupPath: value.restorePointFile,
            expectedCurrentHash: value.sourceHashAfter,
          },
        }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/api/preview' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        const sessions = body.rolloutPath ? null : await loadSessions();
        const { rolloutPath, sessionId } = await resolveMutationTarget(codexHome, body, sessions);
        const mode = requireCleanupMode(body);
        sendJson(response, 200, {
          backupRoot,
          ...await previewCleanup({
            rolloutPath,
            selector: requireSelector(body),
            mode,
          }),
          targetSessionLock: await inspectTargetSessionLocks(codexHome, [sessionId]),
        });
        return;
      }

      if (requestUrl.pathname === '/api/apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'DELETE') {
          throw new CleanerError('CONFIRMATION_REQUIRED', 'Type DELETE to apply this change.', 400);
        }
        const sessions = body.rolloutPath ? null : await loadSessions();
        const { rolloutPath, sessionId } = await resolveMutationTarget(codexHome, body, sessions);
        const mode = requireCleanupMode(body);
        const result = await executeRecordedOperation({
          kind: mode === CLEANUP_MODES.SINGLE ? 'turn_delete_single' : 'turn_delete_truncate',
          label: mode === CLEANUP_MODES.SINGLE ? '删除选中轮次' : '从选中轮次开始清理',
          sessionIds: [sessionId],
          details: { selector: requireSelector(body), mode },
        }, () => applyCleanup({
          codexHome,
          sessionId,
          rolloutPath,
          selector: requireSelector(body),
          mode,
          sourceHash: body.sourceHash,
          backupRoot,
        }), (value) => ({
          result: { removedRecords: value.preview?.removedCount || 0 },
          undo: {
            type: 'rollout_restore',
            sessionId,
            rolloutPath: value.rolloutPath,
            backupPath: value.backupFile,
            expectedCurrentHash: value.sourceHashAfter,
          },
        }));
        registryCache = null;
        sendJson(response, 200, result);
        return;
      }

      if (requestUrl.pathname.startsWith('/api/')) {
        throw new CleanerError('NOT_FOUND', 'API route not found.', 404);
      }

      if (request.method !== 'GET') {
        throw new CleanerError('METHOD_NOT_ALLOWED', 'Only GET is supported for static files.', 405);
      }
      if (requestUrl.pathname === '/favicon.ico') {
        response.writeHead(204, { 'cache-control': 'public, max-age=86400' });
        response.end();
        return;
      }
      await serveStatic(requestUrl, response, publicDir);
    } catch (error) {
      sendError(response, error);
    }
  });
}

export function resolveCleanerPort(options = {}, env = process.env) {
  const raw = options.port
    ?? env.CODEX_CLAUDE_SESSION_MANAGER_PORT
    ?? env.CODEX_CLEANER_PORT
    ?? env.PORT
    ?? '18797';
  const port = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(raw).trim() !== String(port)) {
    throw new CleanerError('INVALID_PORT', 'Cleaner port must be an integer from 0 to 65535.', 400, { port: raw });
  }
  return port;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startCleanerServer(options = {}) {
  const env = options.env || process.env;
  const requestedPort = resolveCleanerPort(options, env);
  const host = options.host || '127.0.0.1';
  const codexHome = options.codexHome || getDefaultCodexHome(env);
  const claudeHome = options.claudeHome || getDefaultClaudeHome(env);
  const instanceLocks = await acquireInstanceLocks({
    ...options,
    env,
    port: requestedPort,
    codexHome,
    claudeHome,
  });
  const server = createCleanerServer({ ...options, codexHome, claudeHome });
  try {
    await listen(server, requestedPort, host);
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : requestedPort;
    server.once('close', () => { instanceLocks.release().catch(() => {}); });
    return {
      server,
      url: `http://${host}:${actualPort}`,
      port: actualPort,
      releaseInstanceLocks: () => instanceLocks.release(),
    };
  } catch (error) {
    await instanceLocks.release();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startCleanerServer();
  process.stdout.write(`Codex & Claude Code Session Manager running at ${url}\n`);
}
