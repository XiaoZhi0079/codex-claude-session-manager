import { readFile } from 'node:fs/promises';

import {
  buildFullContextCollection,
  CleanerError,
  hashRolloutSource,
  parseJsonl,
} from './core.mjs';

const ROLE_FILTERS = new Set(['all', 'system', 'developer', 'user', 'assistant', 'none']);
const CATEGORY_FILTERS = new Set([
  'all',
  'prompt',
  'message',
  'tool_call',
  'tool_result',
  'internal_event',
]);
const SCOPE_FILTERS = new Set(['all', 'history', 'current_turn']);
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'tool_search_call']);
const TOOL_RESULT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'tool_search_output',
]);

const SENSITIVE_PATTERNS = [
  { kind: '授权令牌', pattern: /\bbearer\s+[a-z0-9._~+/=-]{12,}/i },
  { kind: 'API 密钥', pattern: /\b(?:sk|sess)-[a-z0-9_-]{16,}/i },
  {
    kind: '密钥或密码字段',
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|passwd|secret)\b\s*[:=]\s*["']?[^\s"',}]{8,}/i,
  },
  { kind: '私钥', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
];

function normalizeEnum(value, allowed, fallback, code, label) {
  const normalized = typeof value === 'string' && value ? value : fallback;
  if (!allowed.has(normalized)) {
    throw new CleanerError(code, `${label} is not supported.`, 400, { value: normalized });
  }
  return normalized;
}

function normalizeOptions(options = {}) {
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
  if (options.lineNumber !== undefined && (!Number.isInteger(options.lineNumber) || options.lineNumber < 1)) {
    throw new CleanerError('INVALID_CONTEXT_LINE', 'Context line number must be a positive integer.', 400, {
      lineNumber: options.lineNumber,
    });
  }
  return {
    offset,
    limit,
    lineNumber: options.lineNumber ?? null,
    query: typeof options.query === 'string' ? options.query.trim() : '',
    role: normalizeEnum(options.role, ROLE_FILTERS, 'all', 'INVALID_CONTEXT_ROLE', 'Context role filter'),
    category: normalizeEnum(
      options.category,
      CATEGORY_FILTERS,
      'all',
      'INVALID_CONTEXT_CATEGORY',
      'Context category filter',
    ),
    scope: normalizeEnum(options.scope, SCOPE_FILTERS, 'all', 'INVALID_CONTEXT_SCOPE', 'Context scope filter'),
  };
}

function collectContextRecords(records, selector) {
  return buildFullContextCollection(records, selector);
}

export function classifyContextRecord(record) {
  if (record.type === 'session_meta' || record.role === 'system' || record.role === 'developer') {
    return 'prompt';
  }
  if (TOOL_CALL_TYPES.has(record.type)) return 'tool_call';
  if (TOOL_RESULT_TYPES.has(record.type)) return 'tool_result';
  if (record.role === 'user' || record.role === 'assistant' || record.type === 'agent_message' || record.type === 'user_message') {
    return 'message';
  }
  return 'internal_event';
}

function sensitiveKindsForRecord(record) {
  const source = `${record.text || ''}\n${record.raw || ''}`.slice(0, 500_000);
  return SENSITIVE_PATTERNS
    .filter(({ pattern }) => pattern.test(source))
    .map(({ kind }) => kind);
}

function enrichRecord(record) {
  const sensitiveKinds = sensitiveKindsForRecord(record);
  return {
    ...record,
    category: classifyContextRecord(record),
    hasSensitiveContent: sensitiveKinds.length > 0,
    sensitiveKinds,
  };
}

function recordMatches(record, options) {
  if (options.role !== 'all') {
    if (options.role === 'none' ? record.role : record.role !== options.role) return false;
  }
  if (options.category !== 'all' && record.category !== options.category) return false;
  if (options.scope !== 'all' && record.scope !== options.scope) return false;
  if (options.query) {
    const searchText = [
      record.label,
      record.text,
      record.raw,
      record.type,
      record.role,
      record.phase,
      record.name,
      record.turnId,
      record.lineNumber,
    ].filter((value) => value !== null && value !== undefined).join('\n').toLocaleLowerCase();
    if (!searchText.includes(options.query.toLocaleLowerCase())) return false;
  }
  return true;
}

function buildFilteredContext(records, selector, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const context = collectContextRecords(records, selector);
  const enriched = context.records.map(enrichRecord);
  const filtered = enriched.filter((record) => recordMatches(record, options));
  return { options, context, enriched, filtered };
}

export function buildFullContextView(records, selector, rawOptions = {}) {
  const { options, context, enriched, filtered } = buildFilteredContext(records, selector, rawOptions);
  let offset = Math.min(options.offset, Math.max(0, filtered.length - 1));
  let lineFound = null;
  if (options.lineNumber !== null) {
    const lineIndex = filtered.findIndex((record) => record.lineNumber === options.lineNumber);
    if (lineIndex < 0) {
      throw new CleanerError(
        'CONTEXT_LINE_NOT_FOUND',
        'The requested line is outside the selected context or hidden by the current filters.',
        404,
        { lineNumber: options.lineNumber },
      );
    }
    offset = Math.floor(lineIndex / options.limit) * options.limit;
    lineFound = options.lineNumber;
  }
  const pageEnd = Math.min(filtered.length, offset + options.limit);
  const pageRecords = filtered.slice(offset, pageEnd);
  return {
    turn: context.turn,
    records: pageRecords,
    filters: {
      query: options.query,
      role: options.role,
      category: options.category,
      scope: options.scope,
    },
    page: {
      offset,
      limit: options.limit,
      startLine: pageRecords[0]?.lineNumber || null,
      endLine: pageRecords.at(-1)?.lineNumber || null,
      nextOffset: pageEnd < filtered.length ? pageEnd : null,
      previousOffset: offset > 0 ? Math.max(0, offset - options.limit) : null,
      lineFound,
    },
    contextRecordCount: context.contextRecordCount,
    filteredRecordCount: filtered.length,
    sessionRecordCount: context.sessionRecordCount,
    futureRecordCount: context.futureRecordCount,
    sensitiveContextRecordCount: enriched.filter((record) => record.hasSensitiveContent).length,
    sensitiveFilteredRecordCount: filtered.filter((record) => record.hasSensitiveContent).length,
  };
}

function markdownFence(text) {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function buildReadableMarkdown(context, records, filters, metadata = {}) {
  const lines = [
    '# Codex 完整上下文',
    '',
    `- 会话 ID：${metadata.sessionId || '未知'}`,
    `- 所选轮次：第 ${context.turn.index + 1} 轮${context.turn.turnId ? `（${context.turn.turnId}）` : ''}`,
    `- 上下文范围：第 1–${context.contextRecordCount} 条落盘记录`,
    `- 导出记录：${records.length} 条`,
    `- 筛选条件：关键词=${filters.query || '无'}；角色=${filters.role}；类型=${filters.category}；范围=${filters.scope}`,
    '',
  ];
  if (records.some((record) => record.hasSensitiveContent)) {
    lines.push('> 警告：导出内容中检测到疑似密钥、令牌或密码字段，请勿直接分享。', '');
  }
  for (const record of records) {
    const metadataParts = [
      `L${record.lineNumber}`,
      record.type,
      record.role ? `role=${record.role}` : null,
      record.phase ? `phase=${record.phase}` : null,
      `category=${record.category}`,
      record.scope === 'current_turn' ? '当前轮' : '此前上下文',
    ].filter(Boolean);
    lines.push(`## ${record.label}`, '', metadataParts.join(' · '), '');
    if (record.hasSensitiveContent) {
      lines.push(`> 可能含敏感信息：${record.sensitiveKinds.join('、')}`, '');
    }
    const content = record.text || record.raw || '(无可读文本)';
    const fence = markdownFence(content);
    lines.push(`${fence}text`, content, fence, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildFullContextExport(records, selector, rawOptions = {}, metadata = {}) {
  const format = rawOptions.format || 'jsonl';
  if (format !== 'jsonl' && format !== 'markdown') {
    throw new CleanerError('INVALID_CONTEXT_EXPORT_FORMAT', 'Context export format must be jsonl or markdown.', 400, {
      format,
    });
  }
  const { options, context, filtered } = buildFilteredContext(records, selector, rawOptions);
  const filters = {
    query: options.query,
    role: options.role,
    category: options.category,
    scope: options.scope,
  };
  const sessionPart = String(metadata.sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36) || 'session';
  const baseName = `codex-context-${sessionPart}-turn-${context.turn.index + 1}`;
  if (format === 'jsonl') {
    return {
      content: filtered.length ? `${filtered.map((record) => record.raw).join('\n')}\n` : '',
      contentType: 'application/x-ndjson; charset=utf-8',
      fileName: `${baseName}.jsonl`,
      recordCount: filtered.length,
    };
  }
  return {
    content: buildReadableMarkdown(context, filtered, filters, metadata),
    contentType: 'text/markdown; charset=utf-8',
    fileName: `${baseName}.md`,
    recordCount: filtered.length,
  };
}

export async function readFullContextView({ rolloutPath, selector, ...options }) {
  const source = await readFile(rolloutPath, 'utf8');
  const records = parseJsonl(source, rolloutPath);
  return {
    rolloutPath,
    sourceHash: hashRolloutSource(source),
    ...buildFullContextView(records, selector, options),
  };
}

export async function readFullContextExport({ rolloutPath, selector, ...options }) {
  const source = await readFile(rolloutPath, 'utf8');
  const records = parseJsonl(source, rolloutPath);
  return buildFullContextExport(records, selector, options, { sessionId: options.sessionId });
}
