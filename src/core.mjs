import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const MODERN_TURN_START_TYPE = 'task_started';
const MODERN_TURN_END_TYPE = 'task_complete';
const LEGACY_TURN_START_TYPE = 'turn_context';
export const CLEANUP_MODES = Object.freeze({
  TRUNCATE: 'truncate',
  SINGLE: 'single',
});

export class CleanerError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'CleanerError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function getDefaultCodexHome(env = process.env) {
  if (env.CODEX_HOME) return env.CODEX_HOME;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, '.codex');
}

export function parseJsonl(text, source = 'inline') {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  return lines.map((raw, index) => {
    try {
      return {
        lineNumber: index + 1,
        raw,
        data: JSON.parse(raw),
        source,
      };
    } catch (error) {
      throw new CleanerError('INVALID_JSONL', `Invalid JSONL at ${source}:${index + 1}`, 422, {
        source,
        lineNumber: index + 1,
        cause: error.message,
      });
    }
  });
}

export function serializeJsonl(records) {
  if (records.length === 0) return '';
  return records.map((record) => JSON.stringify(record.data)).join('\n') + '\n';
}

export function serializeJsonlPreservingRaw(records, options = {}) {
  if (records.length === 0) return '';
  const newline = options.newline || '\n';
  const trailingNewline = options.trailingNewline !== false;
  const body = records.map((record) => (
    typeof record.raw === 'string' ? record.raw : JSON.stringify(record.data)
  )).join(newline);
  return trailingNewline ? `${body}${newline}` : body;
}

export function hashRolloutSource(source) {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function getRecordType(data) {
  if (data?.type === 'event_msg' && data?.payload?.type) return data.payload.type;
  if (data?.type === 'response_item' && data?.payload?.type) return data.payload.type;
  return data?.type
    || data?.payload?.type
    || data?.event
    || data?.name
    || data?.payload?.type
    || data?.payload?.event
    || data?.item?.type
    || null;
}

export function getRecordTurnId(data) {
  return data?.turn_id
    || data?.turnId
    || data?.payload?.turn_id
    || data?.payload?.turnId
    || data?.payload?.internal_chat_message_metadata_passthrough?.turn_id
    || data?.item?.turn_id
    || data?.item?.turnId
    || data?.item?.internal_chat_message_metadata_passthrough?.turn_id
    || data?.metadata?.turn_id
    || data?.metadata?.turnId
    || null;
}

function getRecordTimestamp(data) {
  return data?.timestamp
    || data?.ts
    || data?.created_at
    || data?.createdAt
    || data?.payload?.timestamp
    || null;
}

function flattenText(value, output = []) {
  if (value == null) return output;
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenText(item, output);
    return output;
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'message', 'input_text']) {
      if (key in value) flattenText(value[key], output);
    }
  }
  return output;
}

function isInjectedUserContext(text) {
  const normalized = text.trim().toLowerCase();
  return [
    '<environment_context',
    '<permissions instructions',
    '<turn_aborted',
    '<model_switch',
    '<collaboration_mode',
    '<skills_instructions',
    '<system',
    '<developer',
    'another language model started to solve this problem',
  ].some((prefix) => normalized.startsWith(prefix));
}

function getUserSummary(records) {
  for (const record of records) {
    const data = record.data;
    const item = data?.item || data?.payload?.item || data?.payload || data?.message || data;
    const role = item?.role || data?.role || data?.payload?.role;
    if (role !== 'user') continue;

    const text = flattenText(item?.content ?? item?.text ?? data?.content ?? data?.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text && !isInjectedUserContext(text)) {
      return text.length > 160 ? `${text.slice(0, 157)}...` : text;
    }
  }
  return '';
}

export function listTurnsFromRecords(records) {
  const modernStarts = [];
  records.forEach((record, index) => {
    if (getRecordType(record.data) === MODERN_TURN_START_TYPE) modernStarts.push(index);
  });

  if (modernStarts.length) {
    return modernStarts.map((startIndex, ordinal) => {
      const nextStartIndex = ordinal + 1 < modernStarts.length
        ? modernStarts[ordinal + 1]
        : records.length;
      const startTurnId = getRecordTurnId(records[startIndex].data);
      let endIndex = nextStartIndex - 1;

      for (let index = startIndex; index < nextStartIndex; index += 1) {
        const record = records[index];
        if (getRecordType(record.data) !== MODERN_TURN_END_TYPE) continue;
        const endTurnId = getRecordTurnId(record.data);
        if (!startTurnId || !endTurnId || endTurnId === startTurnId) {
          endIndex = index;
          break;
        }
      }

      const slice = records.slice(startIndex, endIndex + 1);
      const turnId = startTurnId
        || slice.map((record) => getRecordTurnId(record.data)).find(Boolean)
        || null;
      return {
        index: ordinal,
        turnId,
        boundaryKind: 'task',
        completed: getRecordType(records[endIndex]?.data) === MODERN_TURN_END_TYPE,
        startIndex,
        endIndex,
        startLine: records[startIndex].lineNumber,
        endLine: records[endIndex].lineNumber,
        recordCount: endIndex - startIndex + 1,
        timestamp: getRecordTimestamp(records[startIndex].data),
        summary: getUserSummary(slice),
      };
    });
  }

  let starts = [];
  records.forEach((record, index) => {
    if (getRecordType(record.data) === LEGACY_TURN_START_TYPE) starts.push(index);
  });

  if (!starts.length) {
    records.forEach((record, index) => {
      const data = record.data;
      const item = data?.item || data?.payload?.item || data?.payload || data?.message || data;
      const role = item?.role || data?.role || data?.payload?.role;
      if (role !== 'user' && getRecordType(data) !== 'user_message') return;
      const text = flattenText(item?.content ?? item?.text ?? item?.message ?? data?.content ?? data?.text)
        .join(' ')
        .trim();
      if (text && !isInjectedUserContext(text)) starts.push(index);
    });
  }

  return starts.map((startIndex, ordinal) => {
    const endIndex = ordinal + 1 < starts.length ? starts[ordinal + 1] - 1 : records.length - 1;
    const slice = records.slice(startIndex, endIndex + 1);
    const turnId = slice.map((record) => getRecordTurnId(record.data)).find(Boolean) || null;
    return {
      index: ordinal,
      turnId,
      boundaryKind: getRecordType(records[startIndex].data) === LEGACY_TURN_START_TYPE
        ? 'turn_context'
        : 'user_message',
      completed: true,
      startIndex,
      endIndex,
      startLine: records[startIndex].lineNumber,
      endLine: records[endIndex].lineNumber,
      recordCount: endIndex - startIndex + 1,
      timestamp: getRecordTimestamp(records[startIndex].data),
      summary: getUserSummary(slice),
    };
  });
}

function findTurn(records, selector) {
  const turns = listTurnsFromRecords(records);
  let turn = null;

  if (selector?.turnId) {
    turn = turns.find((candidate) => candidate.turnId === selector.turnId);
  } else if (Number.isInteger(selector?.index)) {
    turn = turns.find((candidate) => candidate.index === selector.index);
  } else if (Number.isInteger(selector?.startLine)) {
    turn = turns.find((candidate) => candidate.startLine === selector.startLine);
  }

  if (!turn) {
    throw new CleanerError('TURN_NOT_FOUND', 'The selected turn was not found in this session.', 404, {
      selector,
    });
  }
  return turn;
}

const VISIBLE_ASSISTANT_PHASES = new Set([null, 'commentary', 'final_answer', 'final']);

function getMessageLocation(data) {
  const candidates = [
    { container: data?.payload, path: ['payload'] },
    { container: data?.item, path: ['item'] },
    { container: data?.payload?.item, path: ['payload', 'item'] },
  ];
  return candidates.find((candidate) => (
    candidate.container?.type === 'message'
    && typeof candidate.container?.role === 'string'
    && Array.isArray(candidate.container?.content)
  )) || null;
}

function contextRecordText(data, location) {
  if (location) {
    return location.container.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }

  const type = getRecordType(data);
  if (type === 'session_meta') {
    return data?.payload?.base_instructions?.text
      || data?.payload?.baseInstructions?.text
      || '';
  }
  if (type === 'agent_message' || type === 'user_message') {
    return typeof data?.payload?.message === 'string' ? data.payload.message : '';
  }
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
    const input = data?.payload?.arguments
      || data?.payload?.input
      || data?.arguments
      || data?.input
      || '';
    return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_search_output') {
    const output = data?.payload?.output ?? data?.output;
    return typeof output === 'string' ? output : (output == null ? '' : JSON.stringify(output, null, 2));
  }
  if (type === 'reasoning') {
    return flattenText(data?.payload?.summary ?? data?.summary).join('\n\n');
  }
  return '';
}

function contextRecordLabel(data, location, typeOverride = null) {
  const type = typeOverride || getRecordType(data) || 'unknown';
  const role = location?.container?.role || null;
  if (type === 'session_meta') return 'Codex 基础提示词与会话元数据';
  if (role === 'system') return '系统提示词';
  if (role === 'developer') return '开发者提示词';
  if (role === 'user') return '用户消息或注入上下文';
  if (role === 'assistant') return 'Codex 消息';
  const labels = {
    turn_context: '本轮运行上下文',
    world_state: '工作区状态',
    task_started: '任务开始',
    task_complete: '任务结束',
    thread_settings_applied: '线程设置更新',
    reasoning: '推理记录',
    function_call: '工具调用',
    function_call_output: '工具返回',
    custom_tool_call: '自定义工具调用',
    custom_tool_call_output: '自定义工具返回',
    tool_search_call: '工具搜索调用',
    tool_search_output: '工具搜索结果',
    token_count: '令牌统计',
    agent_message: 'Codex 事件消息',
    user_message: '用户事件消息',
  };
  return labels[type] || type;
}

function fullContextRecord(record, recordIndex, turn) {
  const location = getMessageLocation(record.data);
  const container = location?.container || null;
  const type = (
    record.data?.type === 'response_item'
    && typeof record.data?.payload?.type === 'string'
    && record.data.payload.type
  ) || getRecordType(record.data) || 'unknown';
  return {
    recordIndex,
    lineNumber: record.lineNumber,
    scope: recordIndex < turn.startIndex ? 'history' : 'current_turn',
    outerType: record.data?.type || null,
    type,
    label: contextRecordLabel(record.data, location, type),
    role: container?.role || null,
    phase: container?.phase || null,
    turnId: getRecordTurnId(record.data),
    timestamp: getRecordTimestamp(record.data),
    name: record.data?.payload?.name || record.data?.name || null,
    text: contextRecordText(record.data, location),
    raw: record.raw,
  };
}

export function buildFullContextDetail(records, selector, options = {}) {
  const context = buildFullContextCollection(records, selector);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new CleanerError('INVALID_CONTEXT_OFFSET', 'Context offset must be a non-negative integer.', 400, {
      offset,
    });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new CleanerError('INVALID_CONTEXT_LIMIT', 'Context page size must be between 1 and 200.', 400, {
      limit,
    });
  }

  const contextRecordCount = context.contextRecordCount;
  const pageOffset = Math.min(offset, Math.max(0, contextRecordCount - 1));
  const pageEnd = Math.min(contextRecordCount, pageOffset + limit);
  return {
    turn: context.turn,
    records: context.records.slice(pageOffset, pageEnd),
    page: {
      offset: pageOffset,
      limit,
      startLine: records[pageOffset]?.lineNumber || null,
      endLine: records[pageEnd - 1]?.lineNumber || null,
      nextOffset: pageEnd < contextRecordCount ? pageEnd : null,
      previousOffset: pageOffset > 0 ? Math.max(0, pageOffset - limit) : null,
    },
    contextRecordCount,
    sessionRecordCount: context.sessionRecordCount,
    futureRecordCount: context.futureRecordCount,
  };
}

export function buildFullContextCollection(records, selector) {
  const turn = findTurn(records, selector);
  const contextRecordCount = turn.endIndex + 1;
  return {
    turn,
    records: records
      .slice(0, contextRecordCount)
      .map((record, recordIndex) => fullContextRecord(record, recordIndex, turn)),
    contextRecordCount,
    sessionRecordCount: records.length,
    futureRecordCount: Math.max(0, records.length - contextRecordCount),
  };
}

function collectTurnMessages(records, selector) {
  const turn = findTurn(records, selector);
  const messages = [];
  const targets = new Map();

  for (let recordIndex = turn.startIndex; recordIndex <= turn.endIndex; recordIndex += 1) {
    const record = records[recordIndex];
    const location = getMessageLocation(record.data);
    if (!location) continue;

    const { container } = location;
    const role = container.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const phase = typeof container.phase === 'string' && container.phase ? container.phase : null;
    if (role === 'assistant' && !VISIBLE_ASSISTANT_PHASES.has(phase)) continue;

    const expectedType = role === 'user' ? 'input_text' : 'output_text';
    const parts = [];
    container.content.forEach((content, contentIndex) => {
      if (content?.type !== expectedType || typeof content?.text !== 'string') return;
      const targetId = `${recordIndex}:${contentIndex}`;
      const part = {
        targetId,
        contentIndex,
        type: content.type,
        text: content.text,
      };
      parts.push(part);
      targets.set(targetId, {
        ...part,
        recordIndex,
        lineNumber: record.lineNumber,
        role,
        phase,
        containerPath: location.path,
      });
    });
    if (!parts.length) continue;

    const text = parts.map((part) => part.text).join('\n\n').trim();
    if (role === 'user' && isInjectedUserContext(text)) {
      for (const part of parts) targets.delete(part.targetId);
      continue;
    }

    messages.push({
      messageId: String(recordIndex),
      recordIndex,
      lineNumber: record.lineNumber,
      role,
      phase,
      text,
      parts,
    });
  }

  return { turn, messages, targets };
}

export function buildTurnMessageDetail(records, selector) {
  const { turn, messages } = collectTurnMessages(records, selector);
  return {
    turn,
    messages,
    messageCount: messages.length,
  };
}

function validateMessageEdits(records, selector, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new CleanerError('INVALID_EDITS', 'At least one message edit is required.', 400);
  }
  if (edits.length > 100) {
    throw new CleanerError('TOO_MANY_EDITS', 'At most 100 message edits can be applied at once.', 400);
  }

  const { turn, targets } = collectTurnMessages(records, selector);
  const seen = new Set();
  const validated = [];
  for (const edit of edits) {
    if (typeof edit?.targetId !== 'string' || seen.has(edit.targetId)) {
      throw new CleanerError('INVALID_EDIT_TARGET', 'Each edit target must be unique.', 400, {
        targetId: edit?.targetId,
      });
    }
    seen.add(edit.targetId);

    const target = targets.get(edit.targetId);
    if (!target) {
      throw new CleanerError('EDIT_TARGET_NOT_FOUND', 'The editable message target was not found in this turn.', 404, {
        targetId: edit.targetId,
      });
    }
    if (typeof edit.expectedText !== 'string' || edit.expectedText !== target.text) {
      throw new CleanerError('STALE_MESSAGE', 'The message text changed after it was loaded.', 409, {
        targetId: edit.targetId,
      });
    }
    if (typeof edit.newText !== 'string' || !edit.newText.trim()) {
      throw new CleanerError('INVALID_EDIT_TEXT', 'Edited message text cannot be empty.', 400, {
        targetId: edit.targetId,
      });
    }
    if (edit.newText.length > 1_000_000) {
      throw new CleanerError('EDIT_TEXT_TOO_LARGE', 'Edited message text is too large.', 413, {
        targetId: edit.targetId,
      });
    }
    if (edit.newText === target.text) continue;
    validated.push({ target, newText: edit.newText });
  }

  if (!validated.length) {
    throw new CleanerError('NO_EDIT_CHANGES', 'No message text changed.', 400);
  }
  return { turn, validated };
}

export function buildMessageEditPreview(records, selector, edits) {
  const { turn, validated } = validateMessageEdits(records, selector, edits);
  return {
    turn,
    changedCount: validated.length,
    changes: validated.map(({ target, newText }) => ({
      targetId: target.targetId,
      lineNumber: target.lineNumber,
      role: target.role,
      phase: target.phase,
      before: target.text,
      after: newText,
    })),
  };
}

function setValueAtPath(root, objectPath, contentIndex, text) {
  let container = root;
  for (const key of objectPath) container = container?.[key];
  if (!Array.isArray(container?.content) || !container.content[contentIndex]) {
    throw new CleanerError('EDIT_TARGET_NOT_FOUND', 'The editable message target no longer exists.', 409);
  }
  container.content[contentIndex].text = text;
}

function editMessageRecords(records, selector, edits) {
  const { validated } = validateMessageEdits(records, selector, edits);
  const editedRecords = records.slice();
  const clonedRecords = new Map();

  for (const { target, newText } of validated) {
    let editedRecord = clonedRecords.get(target.recordIndex);
    if (!editedRecord) {
      editedRecord = {
        ...records[target.recordIndex],
        raw: null,
        data: structuredClone(records[target.recordIndex].data),
      };
      editedRecords[target.recordIndex] = editedRecord;
      clonedRecords.set(target.recordIndex, editedRecord);
    }
    setValueAtPath(editedRecord.data, target.containerPath, target.contentIndex, newText);
  }

  return editedRecords;
}

export function buildTruncatePreview(records, selector) {
  const turn = findTurn(records, selector);
  const removedCount = records.length - turn.startIndex;
  return {
    mode: 'truncate_from_turn_to_end',
    turn,
    startLine: turn.startLine,
    endLine: records.at(-1)?.lineNumber || 0,
    keptCount: turn.startIndex,
    removedCount,
    totalCount: records.length,
    firstRemovedType: getRecordType(records[turn.startIndex]?.data),
    lastRemovedType: getRecordType(records.at(-1)?.data),
  };
}

export function truncateRecords(records, selector) {
  const preview = buildTruncatePreview(records, selector);
  return records.slice(0, preview.turn.startIndex);
}

export function buildDeleteSingleTurnPreview(records, selector) {
  const turn = findTurn(records, selector);
  const turns = listTurnsFromRecords(records);
  const nextTurn = turns[turn.index + 1] || null;
  const removedCount = turn.endIndex - turn.startIndex + 1;

  return {
    mode: 'delete_single_turn',
    turn,
    nextTurn,
    startLine: turn.startLine,
    endLine: turn.endLine,
    keptCount: records.length - removedCount,
    removedCount,
    totalCount: records.length,
    keepsLaterTurns: Boolean(nextTurn),
    laterTurnCount: Math.max(0, turns.length - turn.index - 1),
    firstRemovedType: getRecordType(records[turn.startIndex]?.data),
    lastRemovedType: getRecordType(records[turn.endIndex]?.data),
  };
}

export function deleteSingleTurnRecords(records, selector) {
  const preview = buildDeleteSingleTurnPreview(records, selector);
  return records.slice(0, preview.turn.startIndex).concat(records.slice(preview.turn.endIndex + 1));
}

export function buildCleanupPreview(records, selector, mode = CLEANUP_MODES.TRUNCATE) {
  if (mode === CLEANUP_MODES.TRUNCATE) return buildTruncatePreview(records, selector);
  if (mode === CLEANUP_MODES.SINGLE) return buildDeleteSingleTurnPreview(records, selector);
  throw new CleanerError('INVALID_MODE', 'Cleanup mode must be "truncate" or "single".', 400, { mode });
}

export function cleanRecords(records, selector, mode = CLEANUP_MODES.TRUNCATE) {
  if (mode === CLEANUP_MODES.TRUNCATE) return truncateRecords(records, selector);
  if (mode === CLEANUP_MODES.SINGLE) return deleteSingleTurnRecords(records, selector);
  throw new CleanerError('INVALID_MODE', 'Cleanup mode must be "truncate" or "single".', 400, { mode });
}

export async function previewCleanup({ rolloutPath, selector, mode = CLEANUP_MODES.TRUNCATE }) {
  const source = await readFile(rolloutPath, 'utf8');
  const records = parseJsonl(source, rolloutPath);
  return {
    rolloutPath,
    sourceHash: hashRolloutSource(source),
    preview: buildCleanupPreview(records, selector, mode),
  };
}

function timestampForPath(now = new Date()) {
  return now.toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
}

export async function createBackup({ files, backupRoot, label = 'codex-turn-cleaner', now = new Date() }) {
  const backupDir = path.join(backupRoot, `${label}-${timestampForPath(now)}`);
  await mkdir(backupDir, { recursive: true });

  const copied = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      const target = path.join(backupDir, path.basename(file));
      await copyFile(file, target);
      copied.push({ source: file, backup: target });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  return { backupDir, copied };
}

export async function writeFileAtomically(filePath, content) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

function requireMatchingSourceHash(source, sourceHash) {
  if (typeof sourceHash !== 'string' || !sourceHash) {
    throw new CleanerError('SOURCE_HASH_REQUIRED', 'Reload this turn before editing messages.', 400);
  }
  const actualHash = hashRolloutSource(source);
  if (actualHash !== sourceHash) {
    throw new CleanerError('STALE_ROLLOUT', 'The rollout changed after this turn was loaded. Reload and try again.', 409, {
      expectedHash: sourceHash,
      actualHash,
    });
  }
  return actualHash;
}

export async function readTurnMessageDetail({ rolloutPath, selector }) {
  const source = await readFile(rolloutPath, 'utf8');
  const records = parseJsonl(source, rolloutPath);
  return {
    rolloutPath,
    sourceHash: hashRolloutSource(source),
    ...buildTurnMessageDetail(records, selector),
  };
}

export async function readFullContextDetail({ rolloutPath, selector, offset = 0, limit = 50 }) {
  const source = await readFile(rolloutPath, 'utf8');
  const records = parseJsonl(source, rolloutPath);
  return {
    rolloutPath,
    sourceHash: hashRolloutSource(source),
    ...buildFullContextDetail(records, selector, { offset, limit }),
  };
}

export async function previewMessageEdits({ rolloutPath, selector, edits, sourceHash }) {
  const source = await readFile(rolloutPath, 'utf8');
  const actualHash = requireMatchingSourceHash(source, sourceHash);
  const records = parseJsonl(source, rolloutPath);
  return {
    rolloutPath,
    sourceHash: actualHash,
    preview: buildMessageEditPreview(records, selector, edits),
  };
}

export async function applyMessageEdits({
  rolloutPath,
  selector,
  edits,
  sourceHash,
  backupRoot,
  now = new Date(),
}) {
  const source = await readFile(rolloutPath, 'utf8');
  const sourceHashBefore = requireMatchingSourceHash(source, sourceHash);
  const records = parseJsonl(source, rolloutPath);
  const preview = buildMessageEditPreview(records, selector, edits);
  const editedRecords = editMessageRecords(records, selector, edits);
  const backup = await createBackup({
    files: [rolloutPath],
    backupRoot,
    label: 'codex-turn-editor',
    now,
  });
  const backupFile = backup.copied[0]?.backup;
  if (!backupFile) {
    throw new CleanerError('BACKUP_FAILED', 'The rollout could not be backed up.', 500, { rolloutPath });
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(source);
  const editedSource = serializeJsonlPreservingRaw(editedRecords, { newline, trailingNewline });
  let changed = false;
  try {
    await writeFileAtomically(rolloutPath, editedSource);
    changed = true;
    const validatedSource = await readFile(rolloutPath, 'utf8');
    const validationRecords = parseJsonl(validatedSource, rolloutPath);
    const sourceHashAfter = hashRolloutSource(validatedSource);
    return {
      rolloutPath,
      backupDir: backup.backupDir,
      backupFile,
      backup,
      preview,
      sourceHashBefore,
      sourceHashAfter,
      validation: {
        recordCount: validationRecords.length,
        validJsonl: true,
      },
    };
  } catch (error) {
    const rollbackErrors = [];
    if (changed) {
      try { await writeFileAtomically(rolloutPath, source); } catch (rollbackError) {
        rollbackErrors.push({ path: rolloutPath, message: rollbackError.message });
      }
    }
    if (error instanceof CleanerError) {
      error.details = { ...error.details, backupFile, rollbackErrors };
      throw error;
    }
    throw new CleanerError('MESSAGE_EDIT_FAILED', 'Editing messages failed; the original rollout was restored where possible.', 500, {
      cause: error.message,
      backupFile,
      rollbackErrors,
    });
  }
}

export async function restoreRolloutBackup({
  rolloutPath,
  backupPath,
  expectedCurrentHash,
  backupRoot,
  now = new Date(),
}) {
  if (typeof backupPath !== 'string' || typeof backupRoot !== 'string') {
    throw new CleanerError('INVALID_BACKUP_PATH', 'A valid editor backup path is required.', 400);
  }
  const resolvedRoot = path.resolve(backupRoot);
  const resolvedBackup = path.resolve(backupPath);
  if (!resolvedBackup.startsWith(`${resolvedRoot}${path.sep}`)
    || path.basename(resolvedBackup) !== path.basename(rolloutPath)) {
    throw new CleanerError('INVALID_BACKUP_PATH', 'The selected backup does not belong to this rollout.', 400);
  }

  const currentSource = await readFile(rolloutPath, 'utf8');
  const sourceHashBefore = requireMatchingSourceHash(currentSource, expectedCurrentHash);
  const backupSource = await readFile(resolvedBackup, 'utf8');
  parseJsonl(backupSource, resolvedBackup);

  const restorePoint = await createBackup({
    files: [rolloutPath],
    backupRoot,
    label: 'codex-turn-editor-restore-point',
    now,
  });
  const restorePointFile = restorePoint.copied[0]?.backup;
  if (!restorePointFile) {
    throw new CleanerError('BACKUP_FAILED', 'The current rollout could not be backed up before restore.', 500);
  }

  let changed = false;
  try {
    await writeFileAtomically(rolloutPath, backupSource);
    changed = true;
    const restoredSource = await readFile(rolloutPath, 'utf8');
    const validationRecords = parseJsonl(restoredSource, rolloutPath);
    return {
      rolloutPath,
      restoredFrom: resolvedBackup,
      restorePointDir: restorePoint.backupDir,
      restorePointFile,
      sourceHashBefore,
      sourceHashAfter: hashRolloutSource(restoredSource),
      validation: {
        recordCount: validationRecords.length,
        validJsonl: true,
      },
    };
  } catch (error) {
    const rollbackErrors = [];
    if (changed) {
      try { await writeFileAtomically(rolloutPath, currentSource); } catch (rollbackError) {
        rollbackErrors.push({ path: rolloutPath, message: rollbackError.message });
      }
    }
    if (error instanceof CleanerError) {
      error.details = { ...error.details, restorePointFile, rollbackErrors };
      throw error;
    }
    throw new CleanerError('ROLLOUT_RESTORE_FAILED', 'Restoring the rollout failed; the previous state was restored where possible.', 500, {
      cause: error.message,
      restorePointFile,
      rollbackErrors,
    });
  }
}

export async function applyCleanup({
  rolloutPath,
  selector,
  mode = CLEANUP_MODES.TRUNCATE,
  sourceHash,
  backupRoot,
  now = new Date(),
}) {
  const source = await readFile(rolloutPath, 'utf8');
  const sourceHashBefore = requireMatchingSourceHash(source, sourceHash);
  const records = parseJsonl(source, rolloutPath);
  const preview = buildCleanupPreview(records, selector, mode);
  const cleaned = cleanRecords(records, selector, mode);
  const backup = await createBackup({
    files: [rolloutPath],
    backupRoot,
    now,
  });

  const backupFile = backup.copied[0]?.backup;
  if (!backupFile) {
    throw new CleanerError('BACKUP_FAILED', 'The rollout could not be backed up.', 500, { rolloutPath });
  }

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(source);
  const cleanedSource = serializeJsonlPreservingRaw(cleaned, { newline, trailingNewline });
  let changed = false;
  try {
    await writeFileAtomically(rolloutPath, cleanedSource);
    changed = true;
    const validatedSource = await readFile(rolloutPath, 'utf8');
    const validationRecords = parseJsonl(validatedSource, rolloutPath);
    return {
      rolloutPath,
      backupDir: backup.backupDir,
      backupFile,
      backup,
      preview,
      sourceHashBefore,
      sourceHashAfter: hashRolloutSource(validatedSource),
      validation: {
        recordCount: validationRecords.length,
        validJsonl: true,
      },
    };
  } catch (error) {
    const rollbackErrors = [];
    if (changed) {
      try { await writeFileAtomically(rolloutPath, source); } catch (rollbackError) {
        rollbackErrors.push({ path: rolloutPath, message: rollbackError.message });
      }
    }
    if (error instanceof CleanerError) {
      error.details = { ...error.details, backupFile, rollbackErrors };
      throw error;
    }
    throw new CleanerError('CLEANUP_FAILED', 'Cleaning the turn failed; the original rollout was restored where possible.', 500, {
      cause: error.message,
      backupFile,
      rollbackErrors,
    });
  }
}

export async function applyTruncate(options) {
  return applyCleanup({ ...options, mode: CLEANUP_MODES.TRUNCATE });
}

export async function applySingleTurn(options) {
  return applyCleanup({ ...options, mode: CLEANUP_MODES.SINGLE });
}

export async function readRollout(rolloutPath) {
  return parseJsonl(await readFile(rolloutPath, 'utf8'), rolloutPath);
}

function extractSessionId(data) {
  return data?.id
    || data?.session_id
    || data?.sessionId
    || data?.thread_id
    || data?.threadId
    || data?.conversation_id
    || data?.conversationId
    || data?.payload?.id
    || data?.payload?.session_id
    || data?.payload?.sessionId
    || data?.payload?.thread_id
    || data?.payload?.threadId
    || null;
}

function extractTitle(data) {
  return data?.title
    || data?.thread_name
    || data?.threadName
    || data?.name
    || data?.metadata?.title
    || data?.payload?.title
    || '(untitled)';
}

function extractRolloutPath(data, codexHome) {
  const value = data?.path
    || data?.rollout_path
    || data?.rolloutPath
    || data?.session_path
    || data?.sessionPath
    || data?.file
    || null;
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.join(codexHome, value);
}

export async function listIndexedSessions(codexHome = getDefaultCodexHome()) {
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  let text;
  try {
    text = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = parseJsonl(text, indexPath);
  return records.map((record, index) => {
    const data = record.data;
    return {
      index,
      id: extractSessionId(data),
      title: extractTitle(data),
      updatedAt: data?.updated_at || data?.updatedAt || data?.timestamp || data?.ts || null,
      projectPath: data?.cwd || data?.project_path || data?.projectPath || data?.workspace || null,
      rolloutPath: extractRolloutPath(data, codexHome),
      raw: data,
    };
  });
}

function sessionIdFromRolloutFile(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function summaryFromRecord(data) {
  return getUserSummary([{ data }]);
}

export async function readRolloutMetadata(rolloutPath) {
  const stream = createReadStream(rolloutPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let metadata = {};
  let foundSessionMeta = false;
  let summary = '';
  let lineCount = 0;

  try {
    for await (const raw of lines) {
      lineCount += 1;
      if (!raw.trim()) continue;

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }

      if (!foundSessionMeta && getRecordType(data) === 'session_meta') {
        const payload = data.payload || data;
        metadata = {
          id: extractSessionId(data) || extractSessionId(payload),
          timestamp: getRecordTimestamp(data),
          projectPath: payload?.cwd || payload?.project_path || payload?.projectPath || null,
          modelProvider: payload?.model_provider || payload?.modelProvider || null,
          source: payload?.source || null,
          threadSource: payload?.thread_source || payload?.threadSource || null,
          raw: data,
        };
        foundSessionMeta = true;
      }

      if (!summary) summary = summaryFromRecord(data);
      if (metadata.id && summary) break;
      if (lineCount >= 400) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return {
    ...metadata,
    id: metadata.id || sessionIdFromRolloutFile(rolloutPath),
    summary,
  };
}

async function listRolloutFiles(root) {
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
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    } else if (entry.isDirectory()) {
      files.push(...await listRolloutFiles(fullPath));
    }
  }
  return files;
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

async function sessionFromRollout(rolloutPath, { archived, indexedById }) {
  const [metadata, info] = await Promise.all([
    readRolloutMetadata(rolloutPath),
    stat(rolloutPath),
  ]);
  const id = metadata.id || sessionIdFromRolloutFile(rolloutPath);
  if (!id) return null;

  const indexed = indexedById.get(id) || null;
  const title = indexed?.title && indexed.title !== '(untitled)'
    ? indexed.title
    : metadata.summary || '(untitled)';

  return {
    index: indexed?.index ?? null,
    id,
    title,
    updatedAt: indexed?.updatedAt || info.mtime.toISOString(),
    projectPath: indexed?.projectPath || metadata.projectPath || null,
    rolloutPath,
    hasRollout: true,
    indexed: Boolean(indexed),
    archived,
    source: metadata.source,
    threadSource: metadata.threadSource,
    modelProvider: metadata.modelProvider || null,
    raw: indexed?.raw || null,
  };
}

async function pathIsFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function findFileByNamePart(root, namePart) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.includes(namePart) && entry.name.endsWith('.jsonl')) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = await findFileByNamePart(fullPath, namePart);
      if (found) return found;
    }
  }
  return null;
}

export async function resolveRolloutPath(codexHome, session) {
  if (session?.rolloutPath && await pathIsFile(session.rolloutPath)) return session.rolloutPath;
  if (!session?.id) return null;
  return findFileByNamePart(path.join(codexHome, 'sessions'), session.id)
    || findFileByNamePart(path.join(codexHome, 'archived_sessions'), session.id);
}

export async function listSessions(codexHome = getDefaultCodexHome()) {
  const indexedSessions = await listIndexedSessions(codexHome);
  const indexedById = new Map(indexedSessions.filter((session) => session.id).map((session) => [session.id, session]));
  const [activeFiles, archivedFiles] = await Promise.all([
    listRolloutFiles(path.join(codexHome, 'sessions')),
    listRolloutFiles(path.join(codexHome, 'archived_sessions')),
  ]);
  const discovered = await mapWithConcurrency([
    ...activeFiles.map((rolloutPath) => ({ rolloutPath, archived: false })),
    ...archivedFiles.map((rolloutPath) => ({ rolloutPath, archived: true })),
  ], (item) => sessionFromRollout(item.rolloutPath, { archived: item.archived, indexedById }), 8);

  const byId = new Map(indexedSessions.map((session) => [session.id, {
    ...session,
    hasRollout: false,
    indexed: true,
    archived: false,
  }]));
  for (const candidate of discovered.filter(Boolean)) {
    const existing = byId.get(candidate.id);
    if (existing?.hasRollout && existing.archived && !candidate.archived) {
      byId.set(candidate.id, candidate);
      continue;
    }
    if (existing?.hasRollout && !existing.archived && candidate.archived) continue;
    byId.set(candidate.id, {
      ...candidate,
      ...(existing || {}),
      title: existing?.title && existing.title !== '(untitled)' ? existing.title : candidate.title,
      updatedAt: existing?.updatedAt || candidate.updatedAt,
      projectPath: existing?.projectPath || candidate.projectPath,
      rolloutPath: candidate.rolloutPath,
      hasRollout: true,
      indexed: Boolean(existing?.indexed || candidate.indexed),
      archived: candidate.archived,
      source: candidate.source,
      threadSource: candidate.threadSource,
    });
  }

  return [...byId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || '') || 0;
    const rightTime = Date.parse(right.updatedAt || '') || 0;
    return rightTime - leftTime;
  });
}

export async function getSession(codexHome, sessionId, sessions = null) {
  const availableSessions = sessions || await listSessions(codexHome);
  const session = availableSessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    throw new CleanerError('SESSION_NOT_FOUND', 'The selected session was not found.', 404, { sessionId });
  }
  return session;
}
