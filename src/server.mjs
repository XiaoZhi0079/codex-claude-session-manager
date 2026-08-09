import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyCleanup,
  applyMessageEdits,
  CLEANUP_MODES,
  CleanerError,
  getDefaultCodexHome,
  getSession,
  listTurnsFromRecords,
  previewCleanup,
  previewMessageEdits,
  readRollout,
  readTurnMessageDetail,
  restoreRolloutBackup,
} from './core.mjs';
import { readFullContextExport, readFullContextView } from './context-view.mjs';
import {
  applyCodexVisibilityRepair,
  buildSessionRegistry,
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
} from './operation-backup.mjs';
import { diagnoseSessionHealth } from './session-health.mjs';
import { createOperationHistory } from './operation-history.mjs';
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
} from './claude-session-delete.mjs';
import {
  applyClaudeTurnDeletion,
  previewClaudeTurnDeletion,
  restoreClaudeTurnDeleteBackup,
} from './claude-turn-delete.mjs';

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

function sendDownload(response, download) {
  response.writeHead(200, {
    'content-type': download.contentType,
    'content-disposition': `attachment; filename="${download.fileName}"`,
    'content-length': Buffer.byteLength(download.content, 'utf8'),
    'cache-control': 'no-store',
    'x-context-record-count': String(download.recordCount),
  });
  response.end(download.content);
}

function sendError(response, error) {
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

export function createCleanerServer(options = {}) {
  const env = options.env || process.env;
  const codexHome = options.codexHome || getDefaultCodexHome(env);
  const claudeHome = options.claudeHome || getDefaultClaudeHome(env);
  const backupRoot = options.backupRoot
    || env.CODEX_CLEANER_BACKUP_ROOT
    || path.join(codexHome, 'backups', 'codex-turn-cleaner');
  const claudeBackupRoot = options.claudeBackupRoot
    || env.CLAUDE_SESSION_MANAGER_BACKUP_ROOT
    || path.join(claudeHome, 'backups', 'local-session-manager-deleted-sessions');
  const claudeTurnBackupRoot = options.claudeTurnBackupRoot
    || env.CLAUDE_TURN_MANAGER_BACKUP_ROOT
    || path.join(claudeHome, 'backups', 'local-session-manager-deleted-turns');
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');
  const operationHistory = createOperationHistory({
    backupRoot,
    instanceId: options.instanceId,
  });
  let registryCache = null;
  let claudeRegistryCache = null;

  async function executeRecordedOperation(meta, action, completionBuilder = () => ({})) {
    const operationId = await operationHistory.start(meta);
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
      return restoreRolloutBackup({
        rolloutPath: undo.rolloutPath,
        backupPath: undo.backupPath,
        expectedCurrentHash: undo.expectedCurrentHash,
        backupRoot,
      });
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

      if (requestUrl.pathname === '/api/operation-history' && request.method === 'GET') {
        const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '100', 10);
        sendJson(response, 200, await operationHistory.list({
          limit: Number.isInteger(limit) ? limit : 100,
        }));
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
        const records = await readRollout(session.rolloutPath);
        sendJson(response, 200, {
          session,
          turns: listTurnsFromRecords(records),
          recordCount: records.length,
        });
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
        const rolloutPath = await resolveRolloutFromBody(codexHome, body, sessions);
        const result = await previewMessageEdits({
          rolloutPath,
          selector: requireSelector(body),
          edits: body.edits,
          sourceHash: body.sourceHash,
        });
        sendJson(response, 200, { backupRoot, ...result });
        return;
      }

      if (requestUrl.pathname === '/api/edit-apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'EDIT') {
          throw new CleanerError('EDIT_CONFIRMATION_REQUIRED', 'Type EDIT to apply message changes.', 400);
        }
        const sessions = body.rolloutPath ? null : await loadSessions();
        const rolloutPath = await resolveRolloutFromBody(codexHome, body, sessions);
        const result = await executeRecordedOperation({
          kind: 'message_edit',
          label: '编辑会话消息',
          sessionIds: body.sessionId ? [body.sessionId] : [],
        }, () => applyMessageEdits({
          rolloutPath,
          selector: requireSelector(body),
          edits: body.edits,
          sourceHash: body.sourceHash,
          backupRoot,
        }), (value) => ({
          result: { editedMessages: value.preview?.summary?.changedMessages || value.preview?.edits?.length || 0 },
          undo: {
            type: 'rollout_restore',
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
        const rolloutPath = await resolveRolloutFromBody(codexHome, body, sessions);
        const result = await executeRecordedOperation({
          kind: 'message_edit_restore',
          label: '恢复编辑前的会话消息',
          sessionIds: body.sessionId ? [body.sessionId] : [],
        }, () => restoreRolloutBackup({
          rolloutPath,
          backupPath: body.backupPath,
          expectedCurrentHash: body.expectedCurrentHash,
          backupRoot,
        }), (value) => ({
          result: { restoredFrom: value.restoredFrom },
          undo: {
            type: 'rollout_restore',
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
        const rolloutPath = await resolveRolloutFromBody(codexHome, body, sessions);
        const mode = requireCleanupMode(body);
        sendJson(response, 200, {
          backupRoot,
          ...await previewCleanup({
            rolloutPath,
            selector: requireSelector(body),
            mode,
          }),
        });
        return;
      }

      if (requestUrl.pathname === '/api/apply' && request.method === 'POST') {
        const body = await readJsonRequest(request);
        if (body.confirmation !== 'DELETE') {
          throw new CleanerError('CONFIRMATION_REQUIRED', 'Type DELETE to apply this change.', 400);
        }
        const sessions = body.rolloutPath ? null : await loadSessions();
        const rolloutPath = await resolveRolloutFromBody(codexHome, body, sessions);
        const mode = requireCleanupMode(body);
        const result = await executeRecordedOperation({
          kind: mode === CLEANUP_MODES.SINGLE ? 'turn_delete_single' : 'turn_delete_truncate',
          label: mode === CLEANUP_MODES.SINGLE ? '删除选中轮次' : '从选中轮次开始清理',
          sessionIds: body.sessionId ? [body.sessionId] : [],
        }, () => applyCleanup({
          rolloutPath,
          selector: requireSelector(body),
          mode,
          sourceHash: body.sourceHash,
          backupRoot,
        }), (value) => ({
          result: { removedRecords: value.preview?.removedRecords?.length || value.preview?.summary?.removedRecords || 0 },
          undo: {
            type: 'rollout_restore',
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
  const raw = options.port ?? env.CODEX_CLEANER_PORT ?? env.PORT ?? '18797';
  const port = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(raw).trim() !== String(port)) {
    throw new CleanerError('INVALID_PORT', 'Cleaner port must be an integer from 0 to 65535.', 400, { port: raw });
  }
  return port;
}

function hasExplicitPort(options, env) {
  return options.port !== undefined
    || env.CODEX_CLEANER_PORT !== undefined
    || env.PORT !== undefined;
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
  const explicitPort = hasExplicitPort(options, env);
  const maxAttempts = explicitPort ? 1 : Math.max(1, options.portFallbackCount || 10);

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = requestedPort === 0 ? 0 : requestedPort + attempt;
    if (port > 65535) break;
    const server = createCleanerServer(options);
    try {
      await listen(server, port, host);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return { server, url: `http://${host}:${actualPort}`, port: actualPort };
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EACCES' && error?.code !== 'EADDRINUSE') throw error;
    }
  }

  throw lastError || new CleanerError('PORT_UNAVAILABLE', 'No available cleaner port was found.', 503);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startCleanerServer();
  process.stdout.write(`Codex Turn Cleaner running at ${url}\n`);
}
