import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { CleanerError } from './core.mjs';

const HISTORY_VERSION = 1;
const MAX_LIST_ITEMS = 500;

function isoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function safeValue(value, depth = 0, key = '') {
  if (depth > 5) return '[truncated]';
  if (/password|secret|authorization|raw|content/i.test(key)) return '[redacted]';
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value ?? null;
  }
  if (typeof value === 'string') return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 80)
        .map(([childKey, childValue]) => [childKey, safeValue(childValue, depth + 1, childKey)]),
    );
  }
  return String(value);
}

function historyFile(backupRoot) {
  if (typeof backupRoot !== 'string' || !backupRoot.trim()) {
    throw new CleanerError('INVALID_OPERATION_HISTORY_ROOT', 'A valid operation history root is required.', 500);
  }
  return path.join(path.resolve(backupRoot), 'operation-history.jsonl');
}

async function readEvents(filePath) {
  let source;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { events: [], invalidLines: 0 };
    throw error;
  }
  const events = [];
  let invalidLines = 0;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.version === HISTORY_VERSION && typeof event?.operationId === 'string') events.push(event);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { events, invalidLines };
}

function foldEvents(events, currentInstanceId) {
  const operations = new Map();
  for (const event of events) {
    if (event.event === 'started') {
      operations.set(event.operationId, {
        id: event.operationId,
        kind: event.kind,
        label: event.label,
        startedAt: event.at,
        completedAt: null,
        status: event.instanceId === currentInstanceId ? 'running' : 'interrupted',
        instanceId: event.instanceId,
        sessionIds: event.sessionIds || [],
        details: event.details || {},
        result: null,
        undo: null,
        undoneAt: null,
        undoOperationId: null,
        error: null,
      });
      continue;
    }
    const operation = operations.get(event.operationId);
    if (!operation) continue;
    if (event.event === 'completed') {
      operation.status = 'completed';
      operation.completedAt = event.at;
      operation.result = event.result || {};
      operation.undo = event.undo || null;
    } else if (event.event === 'failed') {
      operation.status = 'failed';
      operation.completedAt = event.at;
      operation.error = event.error || { message: 'Unknown operation failure.' };
    } else if (event.event === 'undone') {
      operation.status = 'undone';
      operation.undoneAt = event.at;
      operation.undoOperationId = event.undoOperationId || null;
    }
  }
  return [...operations.values()]
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

export function createOperationHistory(options = {}) {
  const backupRoot = options.backupRoot;
  const filePath = historyFile(backupRoot);
  const instanceId = options.instanceId || randomUUID();
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  let writeQueue = Promise.resolve();

  function append(event) {
    const serialized = `${JSON.stringify({ version: HISTORY_VERSION, ...event })}\n`;
    writeQueue = writeQueue.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, serialized, 'utf8');
    });
    return writeQueue;
  }

  async function start(input = {}) {
    const operationId = randomUUID();
    await append({
      event: 'started',
      operationId,
      instanceId,
      at: isoDate(input.at || now()),
      kind: String(input.kind || 'unknown'),
      label: String(input.label || input.kind || '未知操作'),
      sessionIds: [...new Set((input.sessionIds || []).map(String))].slice(0, 500),
      details: safeValue(input.details || {}),
    });
    return operationId;
  }

  async function complete(operationId, input = {}) {
    await append({
      event: 'completed',
      operationId,
      instanceId,
      at: isoDate(input.at || now()),
      result: safeValue(input.result || {}),
      undo: input.undo ? safeValue(input.undo) : null,
    });
  }

  async function fail(operationId, error, input = {}) {
    await append({
      event: 'failed',
      operationId,
      instanceId,
      at: isoDate(input.at || now()),
      error: safeValue({
        code: error?.code || 'OPERATION_FAILED',
        message: error?.message || 'Operation failed.',
        rollbackErrors: error?.details?.rollbackErrors || [],
      }),
    });
  }

  async function markUndone(operationId, undoOperationId, input = {}) {
    await append({
      event: 'undone',
      operationId,
      instanceId,
      undoOperationId,
      at: isoDate(input.at || now()),
    });
  }

  async function list(input = {}) {
    await writeQueue;
    const { events, invalidLines } = await readEvents(filePath);
    const allOperations = foldEvents(events, instanceId);
    const limit = Number.isInteger(input.limit)
      ? Math.min(Math.max(input.limit, 1), MAX_LIST_ITEMS)
      : 100;
    const operations = allOperations.slice(0, limit).map((operation, index) => ({
      ...operation,
      isLatest: index === 0,
      canUndo: index === 0 && operation.status === 'completed' && Boolean(operation.undo),
      canRestore: operation.kind === 'history_error_delete'
        && operation.status === 'completed'
        && operation.undo?.type === 'history_turn_restore',
    }));
    return {
      filePath,
      instanceId,
      operations,
      latest: operations[0] || null,
      invalidLines,
      summary: {
        total: allOperations.length,
        completed: allOperations.filter((item) => item.status === 'completed').length,
        failed: allOperations.filter((item) => item.status === 'failed').length,
        interrupted: allOperations.filter((item) => item.status === 'interrupted').length,
        undone: allOperations.filter((item) => item.status === 'undone').length,
      },
    };
  }

  return {
    filePath,
    instanceId,
    start,
    complete,
    fail,
    markUndone,
    list,
  };
}
