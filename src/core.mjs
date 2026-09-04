import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  invalidateThreadHistory,
  prepareThreadHistoryMutation,
  withTargetSessionLocks,
} from './codex-thread-history.mjs';

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

function runtimeEventMessage(record, recordIndex = null) {
  const data = record?.data || record;
  if (data?.type !== 'event_msg') return null;
  const payload = data.payload || {};
  if (payload.type === 'task_complete' && payload.error) {
    const text = typeof payload.error === 'string'
      ? payload.error
      : (typeof payload.error.message === 'string' ? payload.error.message : 'Codex task failed.');
    return {
      messageId: recordIndex === null ? null : `runtime:${recordIndex}`,
      recordIndex,
      lineNumber: record?.lineNumber || null,
      role: 'error',
      phase: 'task_error',
      text,
      errorInfo: payload.error?.codex_error_info ?? null,
      editable: false,
      parts: [{ targetId: null, contentIndex: null, type: 'error_text', text }],
    };
  }
  if (payload.type === 'turn_aborted' && payload.reason) {
    const text = typeof payload.reason === 'string'
      ? payload.reason
      : JSON.stringify(payload.reason, null, 2);
    return {
      messageId: recordIndex === null ? null : `runtime:${recordIndex}`,
      recordIndex,
      lineNumber: record?.lineNumber || null,
      role: 'error',
      phase: 'turn_aborted',
      text,
      errorInfo: null,
      editable: false,
      parts: [{ targetId: null, contentIndex: null, type: 'error_text', text }],
    };
  }
  return null;
}

function turnRuntimeStatus(records) {
  const events = records.map((record) => runtimeEventMessage(record)).filter(Boolean);
  const failure = events.find((event) => event.phase === 'task_error');
  const aborted = events.find((event) => event.phase === 'turn_aborted');
  return {
    status: failure ? 'failed' : (aborted ? 'aborted' : 'completed'),
    error: failure ? { message: failure.text, info: failure.errorInfo } : null,
    abortReason: aborted?.text || null,
  };
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
      const runtimeStatus = turnRuntimeStatus(slice);
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
        ...runtimeStatus,
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
    const runtimeStatus = turnRuntimeStatus(slice);
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
      ...runtimeStatus,
    };
  });
}

export function mergeThreadHistoryTurnRows(turns, historyRows = []) {
  const byTurnId = new Map(historyRows.filter((row) => row?.turnId).map((row) => [row.turnId, row]));
  const matched = new Set();
  const merged = turns.map((turn) => {
    const row = byTurnId.get(turn.turnId);
    if (!row) return turn;
    matched.add(row.turnId);
    const errorMessage = row.error?.message || null;
    return {
      ...turn,
      status: row.status === 'failed' || errorMessage ? 'failed' : (row.status === 'aborted' ? 'aborted' : turn.status),
      error: errorMessage ? { message: errorMessage, info: row.error.codexErrorInfo ?? row.error.codex_error_info ?? null } : turn.error,
      historyStatus: row.status,
      historyRolloutOrdinal: row.rolloutOrdinal,
    };
  });
  return {
    turns: merged,
    unmatchedErrors: historyRows.filter((row) => (
      !matched.has(row.turnId) && (row.status === 'failed' || row.error?.message)
    )),
  };
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
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'tool_search_call']);
const TOOL_RESULT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output']);

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

function getToolLocation(data) {
  const candidates = [
    { container: data?.payload, path: ['payload'] },
    { container: data?.item, path: ['item'] },
    { container: data?.payload?.item, path: ['payload', 'item'] },
    { container: data, path: [] },
  ];
  return candidates.find(({ container }) => (
    TOOL_CALL_TYPES.has(container?.type) || TOOL_RESULT_TYPES.has(container?.type)
  )) || null;
}

function toolIdentifier(container) {
  return container?.call_id || container?.id || null;
}

function codexEditablePartsForRecord(record, recordIndex) {
  const messageLocation = getMessageLocation(record.data);
  if (messageLocation) {
    const { container } = messageLocation;
    const expectedType = container.role === 'user' ? 'input_text' : 'output_text';
    if (container.role !== 'user' && container.role !== 'assistant') return [];
    return container.content.flatMap((content, contentIndex) => {
      if (content?.type !== expectedType || typeof content.text !== 'string') return [];
      return [{
        targetId: `${recordIndex}:${contentIndex}`,
        contentIndex,
        type: content.type,
        text: content.text,
        label: container.role === 'user' ? '用户消息' : '模型回复',
        locator: { kind: 'message_text', containerPath: messageLocation.path, contentIndex },
      }];
    });
  }

  const toolLocation = getToolLocation(record.data);
  if (!toolLocation) {
    const type = getRecordType(record.data);
    if ((type === 'agent_message' || type === 'user_message') && typeof record.data?.payload?.message === 'string') {
      return [{
        targetId: `${recordIndex}:event:message`,
        text: record.data.payload.message,
        label: type === 'agent_message' ? 'Codex 事件消息' : '用户事件消息',
        locator: { kind: 'record_text', valuePath: ['payload', 'message'] },
      }];
    }
    if (type === 'reasoning') {
      const summaryPath = record.data?.payload?.summary !== undefined ? ['payload', 'summary'] : ['summary'];
      let summary = record.data;
      for (const key of summaryPath) summary = summary?.[key];
      if (typeof summary === 'string') {
        return [{
          targetId: `${recordIndex}:reasoning:summary`,
          text: summary,
          label: '推理摘要',
          locator: { kind: 'record_text', valuePath: summaryPath },
        }];
      }
      if (Array.isArray(summary)) {
        return summary.flatMap((part, summaryIndex) => (typeof part?.text === 'string' ? [{
          targetId: `${recordIndex}:reasoning:summary:${summaryIndex}`,
          text: part.text,
          label: summary.length > 1 ? `推理摘要 ${summaryIndex + 1}` : '推理摘要',
          locator: { kind: 'record_text', valuePath: [...summaryPath, summaryIndex, 'text'] },
        }] : []));
      }
    }
    return [];
  }
  const { container } = toolLocation;
  if (TOOL_CALL_TYPES.has(container.type)) {
    const field = ['arguments', 'input', 'action'].find((candidate) => Object.hasOwn(container, candidate));
    if (!field || container[field] == null) return [];
    const json = typeof container[field] !== 'string';
    const jsonString = field === 'arguments' && typeof container[field] === 'string';
    return [{
      targetId: `${recordIndex}:tool:${field}`,
      text: json ? JSON.stringify(container[field], null, 2) : container[field],
      label: json || jsonString ? '工具参数（JSON）' : '工具参数',
      locator: { kind: json ? 'tool_json' : (jsonString ? 'tool_json_string' : 'tool_string'), containerPath: toolLocation.path, field },
    }];
  }

  const field = Object.hasOwn(container, 'output') ? 'output' : (Object.hasOwn(container, 'result') ? 'result' : null);
  if (!field || container[field] == null) return [];
  const output = container[field];
  if (typeof output === 'string') {
    return [{
      targetId: `${recordIndex}:tool:${field}`,
      text: output,
      label: '工具结果',
      locator: { kind: 'tool_string', containerPath: toolLocation.path, field },
    }];
  }
  if (Array.isArray(output) && output.length > 0 && output.every((part) => part && typeof part.text === 'string')) {
    return output.map((part, outputIndex) => ({
      targetId: `${recordIndex}:tool:${field}:${outputIndex}`,
      text: part.text,
      label: output.length > 1 ? `工具结果 ${outputIndex + 1}` : '工具结果',
      locator: { kind: 'tool_output_text', containerPath: toolLocation.path, field, outputIndex },
    }));
  }
  return [{
    targetId: `${recordIndex}:tool:${field}`,
    text: JSON.stringify(output, null, 2),
    label: '工具结果（JSON）',
    locator: { kind: 'tool_json', containerPath: toolLocation.path, field },
  }];
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
  if (type === 'task_complete' && data?.payload?.error) {
    return typeof data.payload.error === 'string'
      ? data.payload.error
      : (data.payload.error.message || JSON.stringify(data.payload.error, null, 2));
  }
  if (type === 'turn_aborted' && data?.payload?.reason) {
    return typeof data.payload.reason === 'string'
      ? data.payload.reason
      : JSON.stringify(data.payload.reason, null, 2);
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
    task_complete: data?.payload?.error ? 'Codex 错误' : '任务结束',
    turn_aborted: '任务已中止',
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
  const toolLocation = getToolLocation(record.data);
  const container = location?.container || null;
  const type = (
    record.data?.type === 'response_item'
    && typeof record.data?.payload?.type === 'string'
    && record.data.payload.type
  ) || getRecordType(record.data) || 'unknown';
  const editableParts = recordIndex >= turn.startIndex ? codexEditablePartsForRecord(record, recordIndex) : [];
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
    editableParts,
    toolCalls: toolLocation && TOOL_CALL_TYPES.has(toolLocation.container.type) && toolIdentifier(toolLocation.container)
      ? [{ id: toolIdentifier(toolLocation.container), name: toolLocation.container.name || 'unknown' }]
      : [],
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
  const toolNames = new Map();

  for (let recordIndex = turn.startIndex; recordIndex <= turn.endIndex; recordIndex += 1) {
    const toolLocation = getToolLocation(records[recordIndex].data);
    if (toolLocation && TOOL_CALL_TYPES.has(toolLocation.container.type)) {
      const id = toolIdentifier(toolLocation.container);
      if (id) toolNames.set(id, toolLocation.container.name || 'unknown');
    }
  }

  for (let recordIndex = turn.startIndex; recordIndex <= turn.endIndex; recordIndex += 1) {
    const record = records[recordIndex];
    const runtimeMessage = runtimeEventMessage(record, recordIndex);
    if (runtimeMessage) {
      messages.push(runtimeMessage);
      continue;
    }
    const toolLocation = getToolLocation(record.data);
    if (toolLocation) {
      const id = toolIdentifier(toolLocation.container);
      const isCall = TOOL_CALL_TYPES.has(toolLocation.container.type);
      const parts = codexEditablePartsForRecord(record, recordIndex);
      for (const part of parts) {
        targets.set(part.targetId, {
          ...part,
          recordIndex,
          lineNumber: record.lineNumber,
          role: isCall ? 'tool_call' : 'tool_result',
          phase: isCall ? 'tool_call' : 'tool_result',
        });
      }
      const displayText = contextRecordText(record.data, null);
      messages.push({
        messageId: String(recordIndex),
        recordIndex,
        lineNumber: record.lineNumber,
        role: isCall ? 'tool_call' : 'tool_result',
        phase: isCall ? 'tool_call' : 'tool_result',
        name: isCall ? (toolLocation.container.name || 'unknown') : (toolNames.get(id) || 'unknown'),
        toolUseId: id,
        text: displayText,
        parts: parts.length ? parts : [{ targetId: `display:${recordIndex}`, text: displayText }],
        editable: parts.length > 0,
      });
      continue;
    }
    const location = getMessageLocation(record.data);
    if (!location) continue;

    const { container } = location;
    const role = container.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const phase = typeof container.phase === 'string' && container.phase ? container.phase : null;
    if (role === 'assistant' && !VISIBLE_ASSISTANT_PHASES.has(phase)) continue;

    const expectedType = role === 'user' ? 'input_text' : 'output_text';
    const parts = [];
    codexEditablePartsForRecord(record, recordIndex).forEach((part) => {
      const { targetId } = part;
      parts.push(part);
      targets.set(targetId, {
        ...part,
        recordIndex,
        lineNumber: record.lineNumber,
        role,
        phase,
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
      editable: true,
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

export function buildCompactConversationPreview(records, rawOptions = {}) {
  const offsetValue = Number(rawOptions.offset ?? 0);
  const limitValue = Number(rawOptions.limit ?? 80);
  const offset = Number.isInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
  const limit = Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 200) : 80;
  const maxMessageChars = 16_000;
  const turns = listTurnsFromRecords(records);
  const messages = [];
  let truncatedMessageCount = 0;
  let turnCursor = 0;
  for (let recordIndex = 0; recordIndex < records.length && turnCursor < turns.length; recordIndex += 1) {
    while (turnCursor < turns.length && recordIndex > turns[turnCursor].endIndex) turnCursor += 1;
    const turn = turns[turnCursor];
    if (!turn || recordIndex < turn.startIndex || recordIndex > turn.endIndex) continue;
    const record = records[recordIndex];
    const runtimeMessage = runtimeEventMessage(record, recordIndex);
    if (runtimeMessage) {
      const truncated = runtimeMessage.text.length > maxMessageChars;
      if (truncated) truncatedMessageCount += 1;
      messages.push({
        role: runtimeMessage.role,
        phase: runtimeMessage.phase,
        errorInfo: runtimeMessage.errorInfo,
        lineNumber: record.lineNumber,
        turnIndex: turn.index,
        text: truncated
          ? `${runtimeMessage.text.slice(0, maxMessageChars)}\n\n[内容过长，已截断]`
          : runtimeMessage.text,
        truncated,
      });
      continue;
    }
    const location = getMessageLocation(record.data);
    if (!location) continue;
    const role = location.container.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const phase = typeof location.container.phase === 'string' && location.container.phase
      ? location.container.phase
      : null;
    if (role === 'assistant' && !VISIBLE_ASSISTANT_PHASES.has(phase)) continue;
    const expectedType = role === 'user' ? 'input_text' : 'output_text';
    const sourceText = location.container.content
      .filter((part) => part?.type === expectedType && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n\n')
      .trim();
    if (!sourceText || (role === 'user' && isInjectedUserContext(sourceText))) continue;
    const truncated = sourceText.length > maxMessageChars;
    if (truncated) truncatedMessageCount += 1;
    messages.push({
      role,
      phase,
      lineNumber: record.lineNumber,
      turnIndex: turn.index,
      text: truncated ? `${sourceText.slice(0, maxMessageChars)}\n\n[内容过长，已截断]` : sourceText,
      truncated,
    });
  }

  const end = Math.min(messages.length, offset + limit);
  return {
    messages: messages.slice(offset, end),
    recordCount: records.length,
    turnCount: turns.length,
    messageCount: messages.length,
    truncatedMessageCount,
    page: {
      offset,
      limit,
      nextOffset: end < messages.length ? end : null,
      previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
    },
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
    if (target.locator?.kind === 'tool_json' || target.locator?.kind === 'tool_json_string') {
      try {
        JSON.parse(edit.newText);
      } catch (error) {
        throw new CleanerError('INVALID_TOOL_EDIT_JSON', 'Tool parameters or results must remain valid JSON.', 400, {
          targetId: edit.targetId,
          cause: error.message,
        });
      }
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

function setEditableTarget(root, target, text) {
  const locator = target.locator;
  if (!locator || locator.kind === 'message_text') {
    setValueAtPath(root, locator?.containerPath || target.containerPath, locator?.contentIndex ?? target.contentIndex, text);
    return;
  }
  if (locator.kind === 'record_text') {
    let container = root;
    for (const key of locator.valuePath.slice(0, -1)) container = container?.[key];
    const key = locator.valuePath.at(-1);
    if (!container || typeof container[key] !== 'string') {
      throw new CleanerError('EDIT_TARGET_NOT_FOUND', 'The editable stored text no longer exists.', 409);
    }
    container[key] = text;
    return;
  }
  let container = root;
  for (const key of locator.containerPath) container = container?.[key];
  if (!container) throw new CleanerError('EDIT_TARGET_NOT_FOUND', 'The editable tool target no longer exists.', 409);
  if (locator.kind === 'tool_string' || locator.kind === 'tool_json_string') {
    container[locator.field] = text;
    return;
  }
  if (locator.kind === 'tool_json') {
    container[locator.field] = JSON.parse(text);
    return;
  }
  if (locator.kind === 'tool_output_text') {
    if (!Array.isArray(container[locator.field]) || typeof container[locator.field][locator.outputIndex]?.text !== 'string') {
      throw new CleanerError('EDIT_TARGET_NOT_FOUND', 'The editable tool result no longer exists.', 409);
    }
    container[locator.field][locator.outputIndex].text = text;
  }
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
    setEditableTarget(editedRecord.data, target, newText);
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

export async function createBackup({ files, backupRoot, label = 'codex-claude-session-manager', now = new Date() }) {
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

export async function applyMessageEdits(options) {
  const {
    rolloutPath,
    codexHome,
    sessionId,
    selector,
    edits,
    sourceHash,
    backupRoot,
    now = new Date(),
  } = options;
  if (codexHome && sessionId && !options.sessionLocksHeld) {
    return withTargetSessionLocks(codexHome, [sessionId], {
      ...options,
      errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
    }, () => applyMessageEdits({ ...options, sessionLocksHeld: true }));
  }
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
  const threadHistory = codexHome && sessionId
    ? await prepareThreadHistoryMutation(codexHome, [sessionId], backup.backupDir, options)
    : null;

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
    const historyInvalidation = codexHome && sessionId
      ? await invalidateThreadHistory(codexHome, [sessionId], options)
      : null;
    if (typeof options.onThreadHistoryInvalidated === 'function') {
      await options.onThreadHistoryInvalidated({ rolloutPath, validatedSource, historyInvalidation });
    }
    return {
      rolloutPath,
      backupDir: backup.backupDir,
      backupFile,
      backup,
      preview,
      sourceHashBefore,
      sourceHashAfter,
      threadHistory: { ...threadHistory, invalidation: historyInvalidation },
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

function toolInteraction(records, selector, callId) {
  if (typeof callId !== 'string' || !callId) {
    throw new CleanerError('INVALID_TOOL_CALL_ID', 'A tool call ID is required.', 400);
  }
  const turn = findTurn(records, selector);
  const calls = [];
  const results = [];
  for (let recordIndex = turn.startIndex; recordIndex <= turn.endIndex; recordIndex += 1) {
    const location = getToolLocation(records[recordIndex].data);
    if (!location) continue;
    if (TOOL_CALL_TYPES.has(location.container.type) && toolIdentifier(location.container) === callId) {
      calls.push({ recordIndex, record: records[recordIndex], container: location.container });
    } else if (TOOL_RESULT_TYPES.has(location.container.type) && location.container.call_id === callId) {
      results.push({ recordIndex, record: records[recordIndex], container: location.container });
    }
  }
  if (!calls.length) {
    throw new CleanerError('TOOL_CALL_NOT_FOUND', 'The selected Codex tool call was not found in this turn.', 404, { callId });
  }
  return {
    turn,
    callId,
    name: calls[0].container.name || 'unknown',
    calls,
    results,
  };
}

export function buildToolInteractionDeletePreview(records, selector, callId) {
  const interaction = toolInteraction(records, selector, callId);
  return {
    turn: interaction.turn,
    toolUseId: interaction.callId,
    name: interaction.name,
    callBlockCount: interaction.calls.length,
    resultBlockCount: interaction.results.length,
    affectedRecordCount: new Set([...interaction.calls, ...interaction.results].map(({ recordIndex }) => recordIndex)).size,
    externalArtifacts: { toolResultFiles: [], subagents: [] },
  };
}

function deleteToolInteractionRecords(records, selector, callId) {
  const interaction = toolInteraction(records, selector, callId);
  const removed = new Set([...interaction.calls, ...interaction.results].map(({ recordIndex }) => recordIndex));
  return { interaction, records: records.filter((_, recordIndex) => !removed.has(recordIndex)) };
}

export async function previewToolInteractionDeletion({ rolloutPath, selector, callId, backupRoot }) {
  const source = await readFile(rolloutPath, 'utf8');
  return {
    ...buildToolInteractionDeletePreview(parseJsonl(source, rolloutPath), selector, callId),
    sourceHash: hashRolloutSource(source),
    backupRoot,
  };
}

export async function applyToolInteractionDeletion(options) {
  const { rolloutPath, codexHome, sessionId, selector, callId, sourceHash, backupRoot, now = new Date() } = options;
  if (codexHome && sessionId && !options.sessionLocksHeld) {
    return withTargetSessionLocks(codexHome, [sessionId], {
      ...options,
      errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
    }, () => applyToolInteractionDeletion({ ...options, sessionLocksHeld: true }));
  }
  const source = await readFile(rolloutPath, 'utf8');
  const sourceHashBefore = requireMatchingSourceHash(source, sourceHash);
  const records = parseJsonl(source, rolloutPath);
  const { interaction, records: editedRecords } = deleteToolInteractionRecords(records, selector, callId);
  const backup = await createBackup({ files: [rolloutPath], backupRoot, label: 'codex-tool-interaction-delete', now });
  const backupFile = backup.copied[0]?.backup;
  if (!backupFile) throw new CleanerError('BACKUP_FAILED', 'The rollout could not be backed up.', 500, { rolloutPath });
  const threadHistory = codexHome && sessionId
    ? await prepareThreadHistoryMutation(codexHome, [sessionId], backup.backupDir, options)
    : null;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(source);
  const editedSource = serializeJsonlPreservingRaw(editedRecords, { newline, trailingNewline });
  let changed = false;
  try {
    await writeFileAtomically(rolloutPath, editedSource);
    changed = true;
    const validatedSource = await readFile(rolloutPath, 'utf8');
    const validationRecords = parseJsonl(validatedSource, rolloutPath);
    try {
      toolInteraction(validationRecords, selector, callId);
      throw new CleanerError('TOOL_DELETE_VERIFY_FAILED', 'The selected Codex tool interaction still exists after rewriting the rollout.', 500);
    } catch (error) {
      if (error?.code !== 'TOOL_CALL_NOT_FOUND') throw error;
    }
    const historyInvalidation = codexHome && sessionId
      ? await invalidateThreadHistory(codexHome, [sessionId], options)
      : null;
    if (typeof options.onThreadHistoryInvalidated === 'function') {
      await options.onThreadHistoryInvalidated({ rolloutPath, validatedSource, historyInvalidation });
    }
    return {
      rolloutPath,
      backupDir: backup.backupDir,
      backupFile,
      backup,
      deleted: {
        toolUseId: interaction.callId,
        name: interaction.name,
        callBlocks: interaction.calls.length,
        resultBlocks: interaction.results.length,
        toolResultFiles: 0,
        subagents: 0,
      },
      sourceHashBefore,
      sourceHashAfter: hashRolloutSource(validatedSource),
      threadHistory: { ...threadHistory, invalidation: historyInvalidation },
      codexRefreshRecommended: true,
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
    throw new CleanerError('TOOL_DELETE_FAILED', 'Deleting the Codex tool interaction failed; the original rollout was restored where possible.', 500, {
      cause: error.message,
      backupFile,
      rollbackErrors,
    });
  }
}

export async function restoreRolloutBackup(options) {
  const {
    rolloutPath,
    codexHome,
    sessionId,
    backupPath,
    expectedCurrentHash,
    backupRoot,
    now = new Date(),
  } = options;
  if (codexHome && sessionId && !options.sessionLocksHeld) {
    return withTargetSessionLocks(codexHome, [sessionId], {
      ...options,
      errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
    }, () => restoreRolloutBackup({ ...options, sessionLocksHeld: true }));
  }
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
  const threadHistory = codexHome && sessionId
    ? await prepareThreadHistoryMutation(codexHome, [sessionId], restorePoint.backupDir, options)
    : null;

  let changed = false;
  try {
    await writeFileAtomically(rolloutPath, backupSource);
    changed = true;
    const restoredSource = await readFile(rolloutPath, 'utf8');
    const validationRecords = parseJsonl(restoredSource, rolloutPath);
    const historyInvalidation = codexHome && sessionId
      ? await invalidateThreadHistory(codexHome, [sessionId], options)
      : null;
    if (typeof options.onThreadHistoryInvalidated === 'function') {
      await options.onThreadHistoryInvalidated({ rolloutPath, validatedSource: restoredSource, historyInvalidation });
    }
    return {
      rolloutPath,
      restoredFrom: resolvedBackup,
      restorePointDir: restorePoint.backupDir,
      restorePointFile,
      sourceHashBefore,
      sourceHashAfter: hashRolloutSource(restoredSource),
      threadHistory: { ...threadHistory, invalidation: historyInvalidation },
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

export async function applyCleanup(options) {
  const {
    rolloutPath,
    codexHome,
    sessionId,
    selector,
    mode = CLEANUP_MODES.TRUNCATE,
    sourceHash,
    backupRoot,
    now = new Date(),
  } = options;
  if (codexHome && sessionId && !options.sessionLocksHeld) {
    return withTargetSessionLocks(codexHome, [sessionId], {
      ...options,
      errorFactory: (code, message, status, details) => new CleanerError(code, message, status, details),
    }, () => applyCleanup({ ...options, sessionLocksHeld: true }));
  }
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
  const threadHistory = codexHome && sessionId
    ? await prepareThreadHistoryMutation(codexHome, [sessionId], backup.backupDir, options)
    : null;

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(source);
  const cleanedSource = serializeJsonlPreservingRaw(cleaned, { newline, trailingNewline });
  let changed = false;
  try {
    await writeFileAtomically(rolloutPath, cleanedSource);
    changed = true;
    const validatedSource = await readFile(rolloutPath, 'utf8');
    const validationRecords = parseJsonl(validatedSource, rolloutPath);
    const historyInvalidation = codexHome && sessionId
      ? await invalidateThreadHistory(codexHome, [sessionId], options)
      : null;
    if (typeof options.onThreadHistoryInvalidated === 'function') {
      await options.onThreadHistoryInvalidated({ rolloutPath, validatedSource, historyInvalidation });
    }
    return {
      rolloutPath,
      backupDir: backup.backupDir,
      backupFile,
      backup,
      preview,
      sourceHashBefore,
      sourceHashAfter: hashRolloutSource(validatedSource),
      threadHistory: { ...threadHistory, invalidation: historyInvalidation },
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
