import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CleanerError } from './core.mjs';

const SESSION_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const ROLE_FILTERS = new Set(['all', 'system', 'developer', 'user', 'assistant', 'none']);
const SOURCE_FILTERS = new Set(['all', 'human', 'claude', 'tool', 'runtime', 'client', 'subagent']);
const CATEGORY_FILTERS = new Set(['all', 'conversation', 'tool_call', 'tool_result', 'runtime_injection', 'client_event']);
const SCOPE_FILTERS = new Set(['all', 'history', 'current_turn']);
const SENSITIVE_PATTERNS = [
  { kind: '授权令牌', pattern: /\bbearer\s+[a-z0-9._~+/=-]{12,}/i },
  { kind: 'API 密钥', pattern: /\b(?:sk|sess)-[a-z0-9_-]{16,}/i },
  { kind: '密钥或密码字段', pattern: /\b(?:api[_-]?key|access[_-]?token|authorization|client[_-]?secret|password|passwd|secret)\b\s*[:=]\s*["']?[^\s"',}]{8,}/i },
  { kind: '私钥', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
];

export function getDefaultClaudeHome(env = process.env) {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  if (env.CLAUDE_HOME) return env.CLAUDE_HOME;
  return path.join(env.USERPROFILE || env.HOME || os.homedir(), '.claude');
}

async function pathStats(targetPath) {
  try {
    const value = await stat(targetPath);
    return { exists: true, sizeBytes: value.isFile() ? value.size : 0, updatedAt: value.mtime.toISOString() };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, sizeBytes: 0, updatedAt: null };
    throw error;
  }
}

async function directoryStats(root) {
  const rootState = await pathStats(root);
  if (!rootState.exists) return { exists: false, fileCount: 0, sizeBytes: 0 };
  let fileCount = 0;
  let sizeBytes = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) {
        fileCount += 1;
        sizeBytes += (await stat(child)).size;
      }
    }
  }
  return { exists: true, fileCount, sizeBytes };
}

function parseJsonlTolerant(source, sourcePath) {
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const records = [];
  const parseErrors = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    try {
      records.push({ lineNumber: index + 1, raw, data: JSON.parse(raw), sourcePath });
    } catch (error) {
      parseErrors.push({ lineNumber: index + 1, message: error.message });
      records.push({
        lineNumber: index + 1,
        raw,
        data: null,
        sourcePath,
        parseError: error.message,
      });
    }
  }
  return { records, parseErrors };
}

function contentBlocks(record) {
  const content = record?.data?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : '';
  if (block.type === 'tool_use') {
    const input = block.input === undefined ? '' : JSON.stringify(block.input, null, 2);
    return [`工具调用：${block.name || 'unknown'}`, input].filter(Boolean).join('\n');
  }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return block.content;
    return block.content === undefined ? '' : JSON.stringify(block.content, null, 2);
  }
  return '';
}

function visibleMessageText(record) {
  return contentBlocks(record)
    .filter((block) => block.type === 'text')
    .map(blockText)
    .filter(Boolean)
    .join('\n\n');
}

function isActualUserPrompt(record) {
  if (record?.data?.message?.role !== 'user' || record.data?.isMeta === true) return false;
  const text = visibleMessageText(record).trim();
  if (!text) return false;
  return !/^<(?:local-command-caveat|local-command-stdout|command-name|system-reminder|teammate-message)\b/i.test(text);
}

function recordText(record) {
  if (!record.data) return record.raw;
  const blocks = contentBlocks(record);
  if (blocks.length) return blocks.map(blockText).filter(Boolean).join('\n\n');
  const data = record.data;
  if (data.attachment && typeof data.attachment === 'object') {
    for (const key of ['content', 'stdout', 'prompt', 'snippet']) {
      if (typeof data.attachment[key] === 'string' && data.attachment[key]) return data.attachment[key];
    }
    return JSON.stringify(data.attachment, null, 2);
  }
  for (const key of ['customTitle', 'agentName', 'prompt', 'summary', 'text', 'content', 'lastPrompt', 'aiTitle']) {
    if (typeof data[key] === 'string' && data[key]) return data[key];
  }
  return '';
}

function compactText(value, limit = 160) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function recordTimestamp(record) {
  const value = record?.data?.timestamp || record?.data?.message?.timestamp;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildTurns(records) {
  const turns = [];
  let current = null;
  for (const record of records) {
    const role = record.data?.message?.role || (record.data?.type === 'user' ? 'user' : null);
    const blocks = contentBlocks(record);
    const userText = role === 'user'
      ? blocks.filter((block) => block.type === 'text').map(blockText).filter(Boolean).join('\n\n')
      : '';
    const startsTurn = role === 'user' && isActualUserPrompt(record);
    if (startsTurn) {
      if (current) {
        current.endLine = record.lineNumber - 1;
        turns.push(current);
      }
      current = {
        index: turns.length,
        turnId: record.data?.uuid || `line-${record.lineNumber}`,
        startLine: record.lineNumber,
        endLine: record.lineNumber,
        timestamp: recordTimestamp(record),
        summary: compactText(userText, 120) || '(无用户文本)',
        userMessageCount: 1,
        assistantMessageCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
      };
    }
    if (!current) continue;
    current.endLine = record.lineNumber;
    if (role === 'assistant' && visibleMessageText(record)) current.assistantMessageCount += 1;
    current.toolCallCount += blocks.filter((block) => block.type === 'tool_use').length;
    current.toolResultCount += blocks.filter((block) => block.type === 'tool_result').length;
  }
  if (current) turns.push(current);
  return turns;
}

function readTitle(records, indexEntry) {
  const custom = [...records].reverse().find((record) => (
    record.data?.type === 'custom-title' && typeof record.data?.customTitle === 'string'
  ))?.data?.customTitle;
  if (custom?.trim()) return { title: custom.trim(), source: 'custom-title' };
  if (typeof indexEntry?.summary === 'string' && indexEntry.summary.trim() && indexEntry.summary !== 'New Conversation') {
    return { title: indexEntry.summary.trim(), source: 'sessions-index' };
  }
  const firstUser = records.find(isActualUserPrompt);
  const fallback = compactText(visibleMessageText(firstUser), 120);
  return { title: fallback || indexEntry?.summary || '(无标题会话)', source: fallback ? 'first-user-message' : 'fallback' };
}

async function readProjectIndex(projectDir) {
  try {
    const value = JSON.parse(await readFile(path.join(projectDir, 'sessions-index.json'), 'utf8'));
    return {
      originalPath: typeof value.originalPath === 'string' ? value.originalPath : null,
      entries: new Map((Array.isArray(value.entries) ? value.entries : [])
        .filter((entry) => typeof entry?.sessionId === 'string')
        .map((entry) => [entry.sessionId, entry])),
    };
  } catch {
    return { originalPath: null, entries: new Map() };
  }
}

function collectToolState(records) {
  const calls = new Map();
  const results = new Set();
  const persistedReferences = [];
  for (const record of records) {
    for (const block of contentBlocks(record)) {
      if (block.type === 'tool_use' && block.id) calls.set(block.id, { name: block.name || 'unknown', lineNumber: record.lineNumber });
      if (block.type === 'tool_result' && block.tool_use_id) results.add(block.tool_use_id);
      if (block.type === 'tool_result') {
        const content = blockText(block);
        const match = content.match(/<persisted-output>[\s\S]*?Full output saved to:\s*([^\r\n]+)[\s\S]*?<\/persisted-output>/i);
        if (match) persistedReferences.push({ lineNumber: record.lineNumber, reportedPath: match[1].trim() });
      }
    }
  }
  return {
    calls,
    results,
    incompleteCalls: [...calls.entries()]
      .filter(([id]) => !results.has(id))
      .map(([id, value]) => ({ id, ...value })),
    persistedReferences,
  };
}

async function resolvePersistedReferences(sessionDir, references) {
  const toolResultsDir = path.resolve(sessionDir, 'tool-results');
  const resolved = [];
  for (const reference of references) {
    const candidate = path.resolve(toolResultsDir, path.basename(reference.reportedPath));
    const safe = candidate.startsWith(`${toolResultsDir}${path.sep}`);
    const state = safe ? await pathStats(candidate) : { exists: false, sizeBytes: 0, updatedAt: null };
    resolved.push({ ...reference, actualPath: safe ? candidate : null, ...state });
  }
  return resolved;
}

async function listSubagents(sessionDir) {
  const root = path.join(sessionDir, 'subagents');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const agents = [];
    for (const entry of entries) {
      const match = entry.isFile() && entry.name.match(/^agent-(.+)\.jsonl$/i);
      if (!match) continue;
      const agentId = match[1];
      const jsonlPath = path.join(root, entry.name);
      const metaPath = path.join(root, `agent-${agentId}.meta.json`);
      let metadata = null;
      try { metadata = JSON.parse(await readFile(metaPath, 'utf8')); } catch {}
      const state = await pathStats(jsonlPath);
      agents.push({ agentId, jsonlPath, metaPath: (await pathStats(metaPath)).exists ? metaPath : null, metadata, sizeBytes: state.sizeBytes });
    }
    return agents;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function inspectSession({ claudeHome, projectDir, projectKey, sessionId, filePath, indexEntry, originalPath }) {
  const source = await readFile(filePath, 'utf8');
  const parsed = parseJsonlTolerant(source, filePath);
  const records = parsed.records;
  const fileState = await pathStats(filePath);
  const sessionDir = path.join(projectDir, sessionId);
  const toolState = collectToolState(records);
  const persistedOutputs = await resolvePersistedReferences(sessionDir, toolState.persistedReferences);
  const subagents = await listSubagents(sessionDir);
  const [sidecars, tasks, fileHistory, sessionEnv] = await Promise.all([
    directoryStats(sessionDir),
    directoryStats(path.join(claudeHome, 'tasks', sessionId)),
    directoryStats(path.join(claudeHome, 'file-history', sessionId)),
    directoryStats(path.join(claudeHome, 'session-env', sessionId)),
  ]);
  const turns = buildTurns(records);
  const title = readTitle(records, indexEntry);
  const cwdRecord = [...records].reverse().find((record) => typeof record.data?.cwd === 'string' && record.data.cwd.trim());
  const projectPath = cwdRecord?.data?.cwd || indexEntry?.projectPath || originalPath || null;
  const roles = records.map((record) => record.data?.message?.role).filter(Boolean);
  const missingPersistedOutputs = persistedOutputs.filter((item) => !item.exists);
  const findings = [];
  if (parsed.parseErrors.length) findings.push({ severity: 'critical', code: 'invalid-jsonl', message: `${parsed.parseErrors.length} 行 JSON 无法解析` });
  if (!turns.length) findings.push({ severity: 'warning', code: 'no-visible-turns', message: '没有识别到包含用户正文的轮次' });
  if (toolState.incompleteCalls.length) findings.push({ severity: 'warning', code: 'incomplete-tool-calls', message: `${toolState.incompleteCalls.length} 个工具调用缺少结果，可能是中断会话` });
  if (missingPersistedOutputs.length) findings.push({ severity: 'critical', code: 'missing-tool-results', message: `${missingPersistedOutputs.length} 个外置工具结果文件缺失` });
  if (subagents.some((agent) => !agent.metaPath)) findings.push({ severity: 'warning', code: 'missing-agent-meta', message: '部分子代理缺少元数据文件' });
  const healthState = findings.some((item) => item.severity === 'critical')
    ? 'critical'
    : (findings.length ? 'attention' : 'healthy');
  const totalBytes = fileState.sizeBytes + sidecars.sizeBytes + tasks.sizeBytes + fileHistory.sizeBytes + sessionEnv.sizeBytes;
  return {
    id: sessionId,
    title: title.title,
    titleSource: title.source,
    projectKey,
    projectPath,
    filePath,
    sessionDir,
    createdAt: recordTimestamp(records.find((record) => recordTimestamp(record))) || indexEntry?.created || null,
    updatedAt: fileState.updatedAt || indexEntry?.modified || null,
    gitBranch: [...records].reverse().find((record) => typeof record.data?.gitBranch === 'string')?.data?.gitBranch || indexEntry?.gitBranch || null,
    recordCount: records.length,
    turnCount: turns.length,
    userMessageCount: roles.filter((role) => role === 'user').length,
    assistantMessageCount: roles.filter((role) => role === 'assistant').length,
    parseErrorCount: parsed.parseErrors.length,
    toolCallCount: toolState.calls.size,
    incompleteToolCallCount: toolState.incompleteCalls.length,
    persistedOutputCount: persistedOutputs.length,
    missingPersistedOutputCount: missingPersistedOutputs.length,
    subagentCount: subagents.length,
    sidecars,
    tasks,
    fileHistory,
    sessionEnv,
    totalBytes,
    mainFileBytes: fileState.sizeBytes,
    health: {
      state: healthState,
      label: healthState === 'healthy' ? '正常' : (healthState === 'critical' ? '异常' : '需注意'),
      summary: findings.length ? findings.map((item) => item.message).join('；') : '正文与已引用侧边数据完整。',
      findings,
    },
    resumable: records.length > 0 && parsed.parseErrors.length === 0,
    indexMetadata: indexEntry ? {
      indexed: true,
      summary: indexEntry.summary || null,
      messageCount: indexEntry.messageCount ?? null,
      modified: indexEntry.modified || null,
    } : { indexed: false },
    _records: records,
    _turns: turns,
    _subagents: subagents,
    _persistedOutputs: persistedOutputs,
  };
}

function publicSession(session) {
  const { _records, _turns, _subagents, _persistedOutputs, ...value } = session;
  return value;
}

export async function buildClaudeSessionRegistry(claudeHome = getDefaultClaudeHome()) {
  const projectsRoot = path.join(claudeHome, 'projects');
  let projectEntries = [];
  try {
    projectEntries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const sessions = [];
  for (const projectEntry of projectEntries.filter((entry) => entry.isDirectory())) {
    const projectDir = path.join(projectsRoot, projectEntry.name);
    const index = await readProjectIndex(projectDir);
    const entries = await readdir(projectDir, { withFileTypes: true });
    for (const entry of entries) {
      const match = entry.isFile() && entry.name.match(SESSION_FILE_PATTERN);
      if (!match) continue;
      sessions.push(await inspectSession({
        claudeHome,
        projectDir,
        projectKey: projectEntry.name,
        sessionId: match[1],
        filePath: path.join(projectDir, entry.name),
        indexEntry: index.entries.get(match[1]),
        originalPath: index.originalPath,
      }));
    }
  }
  sessions.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  const directoryMap = new Map();
  for (const session of sessions) {
    const directory = session.projectPath || `存储目录：${session.projectKey}`;
    const key = process.platform === 'win32' ? directory.toLocaleLowerCase() : directory;
    const current = directoryMap.get(key);
    if (current) current.count += 1;
    else directoryMap.set(key, { path: directory, count: 1 });
  }
  return {
    claudeHome,
    sessions: sessions.map(publicSession),
    directories: [...directoryMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
    summary: {
      total: sessions.length,
      healthy: sessions.filter((session) => session.health.state === 'healthy').length,
      attention: sessions.filter((session) => session.health.state !== 'healthy').length,
      resumable: sessions.filter((session) => session.resumable).length,
      withSubagents: sessions.filter((session) => session.subagentCount > 0).length,
      mainFileBytes: sessions.reduce((sum, session) => sum + session.mainFileBytes, 0),
      sidecarBytes: sessions.reduce((sum, session) => sum + session.sidecars.sizeBytes + session.tasks.sizeBytes + session.fileHistory.sizeBytes + session.sessionEnv.sizeBytes, 0),
      totalBytes: sessions.reduce((sum, session) => sum + session.totalBytes, 0),
    },
  };
}

async function findSession(claudeHome, sessionId) {
  if (!SESSION_FILE_PATTERN.test(`${sessionId}.jsonl`)) {
    throw new CleanerError('INVALID_CLAUDE_SESSION_ID', 'Claude session ID must be a UUID.', 400, { sessionId });
  }
  const projectsRoot = path.join(claudeHome, 'projects');
  let projects = [];
  try { projects = await readdir(projectsRoot, { withFileTypes: true }); } catch (error) {
    if (error?.code === 'ENOENT') throw new CleanerError('CLAUDE_SESSION_NOT_FOUND', 'Claude session was not found.', 404, { sessionId });
    throw error;
  }
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const projectDir = path.join(projectsRoot, project.name);
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    if (!(await pathStats(filePath)).exists) continue;
    const index = await readProjectIndex(projectDir);
    return inspectSession({
      claudeHome,
      projectDir,
      projectKey: project.name,
      sessionId,
      filePath,
      indexEntry: index.entries.get(sessionId),
      originalPath: index.originalPath,
    });
  }
  throw new CleanerError('CLAUDE_SESSION_NOT_FOUND', 'Claude session was not found.', 404, { sessionId });
}

export async function readClaudeSessionTurns(claudeHome, sessionId) {
  const session = await findSession(claudeHome, sessionId);
  return { session: publicSession(session), turns: session._turns, recordCount: session._records.length };
}

function selectedTurn(session, turnId) {
  const turn = session._turns.find((item) => item.turnId === turnId || String(item.index) === String(turnId));
  if (!turn) throw new CleanerError('CLAUDE_TURN_NOT_FOUND', 'Claude conversation turn was not found.', 404, { turnId });
  return turn;
}

export async function readClaudeTurnDetail(claudeHome, sessionId, turnId) {
  const session = await findSession(claudeHome, sessionId);
  const turn = selectedTurn(session, turnId);
  const records = session._records.filter((record) => record.lineNumber >= turn.startLine && record.lineNumber <= turn.endLine);
  const messages = [];
  for (const record of records) {
    const role = record.data?.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const textParts = contentBlocks(record).filter((block) => block.type === 'text').map((block, index) => ({
      targetId: `${record.data?.uuid || record.lineNumber}:${index}`,
      text: blockText(block),
    })).filter((part) => part.text);
    if (!textParts.length) continue;
    messages.push({ role, phase: role === 'assistant' ? 'final_answer' : null, lineNumber: record.lineNumber, parts: textParts });
  }
  return {
    session: publicSession(session),
    turn,
    messages,
    messageCount: messages.length,
    readOnly: true,
  };
}

function normalizeContextOptions(options = {}) {
  const offset = Number(options.offset ?? 0);
  const limit = Number(options.limit ?? 50);
  if (!Number.isInteger(offset) || offset < 0) throw new CleanerError('INVALID_CONTEXT_OFFSET', 'Context offset must be a non-negative integer.', 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CleanerError('INVALID_CONTEXT_LIMIT', 'Context page size must be between 1 and 200.', 400);
  const role = options.role || 'all';
  const source = options.source || 'all';
  const categoryAliases = { prompt: 'runtime_injection', message: 'conversation', internal_event: 'client_event' };
  const category = categoryAliases[options.category] || options.category || 'all';
  const scope = options.scope || 'all';
  if (!ROLE_FILTERS.has(role)) throw new CleanerError('INVALID_CONTEXT_ROLE', 'Context role filter is not supported.', 400, { role });
  if (!SOURCE_FILTERS.has(source)) throw new CleanerError('INVALID_CONTEXT_SOURCE', 'Context source filter is not supported.', 400, { source });
  if (!CATEGORY_FILTERS.has(category)) throw new CleanerError('INVALID_CONTEXT_CATEGORY', 'Context category filter is not supported.', 400, { category });
  if (!SCOPE_FILTERS.has(scope)) throw new CleanerError('INVALID_CONTEXT_SCOPE', 'Context scope filter is not supported.', 400, { scope });
  return { offset, limit, role, source, category, scope, query: String(options.query || '').trim(), lineNumber: options.lineNumber ? Number(options.lineNumber) : null };
}

function userControlKind(record) {
  if (record?.data?.message?.role !== 'user') return null;
  const text = visibleMessageText(record).trim();
  if (/^<system-reminder\b/i.test(text)) return 'runtime';
  if (/^<(?:local-command-caveat|local-command-stdout|command-name|teammate-message)\b/i.test(text)) return 'client';
  if (record.data?.isMeta === true) return 'client';
  return null;
}

function contextCategory(record) {
  const blocks = contentBlocks(record);
  if (blocks.some((block) => block.type === 'tool_use')) return 'tool_call';
  if (blocks.some((block) => block.type === 'tool_result')) return 'tool_result';
  const role = record.data?.message?.role;
  if (record.data?.type === 'attachment' || role === 'system' || role === 'developer' || userControlKind(record) === 'runtime') return 'runtime_injection';
  if ((role === 'user' && isActualUserPrompt(record)) || role === 'assistant') return 'conversation';
  return 'client_event';
}

function contextSource(record, stream = 'main') {
  if (stream !== 'main') return 'subagent';
  const category = contextCategory(record);
  if (category === 'tool_result') return 'tool';
  if (category === 'tool_call') return 'claude';
  if (category === 'runtime_injection') return 'runtime';
  if (category === 'client_event') return 'client';
  if (record.data?.message?.role === 'user') return 'human';
  if (record.data?.message?.role === 'assistant') return 'claude';
  return 'client';
}

function sourceLabel(source) {
  return {
    human: '人类',
    claude: 'Claude',
    tool: '工具',
    runtime: '运行时注入',
    client: 'Claude Code 客户端',
    subagent: '子代理',
  }[source] || source;
}

function sensitiveKinds(text, raw) {
  const source = `${text || ''}\n${raw || ''}`.slice(0, 500_000);
  return SENSITIVE_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ kind }) => kind);
}

async function externalOutputForRecord(session, record) {
  const reference = session._persistedOutputs.find((item) => item.lineNumber === record.lineNumber);
  if (!reference?.exists || !reference.actualPath) return null;
  return { text: await readFile(reference.actualPath, 'utf8'), path: reference.actualPath, sizeBytes: reference.sizeBytes };
}

async function buildContextRecords(session, turn) {
  const mainRecords = session._records.filter((record) => record.lineNumber <= turn.endLine);
  const context = [];
  for (const record of mainRecords) {
    const category = contextCategory(record);
    const external = category === 'tool_result' ? await externalOutputForRecord(session, record) : null;
    const text = external?.text ?? recordText(record);
    const role = record.data?.message?.role || null;
    const source = contextSource(record);
    const kinds = sensitiveKinds(text, record.raw);
    context.push({
      lineNumber: record.lineNumber,
      sourceLineNumber: record.lineNumber,
      stream: 'main',
      label: external ? '工具结果 · 外置完整输出' : `${sourceLabel(source)} · ${record.data?.type || '未知记录'}`,
      text,
      raw: record.raw,
      type: record.data?.type || 'invalid_jsonl',
      role,
      source,
      phase: null,
      name: contentBlocks(record).find((block) => block.type === 'tool_use')?.name || null,
      turnId: session._turns.find((item) => record.lineNumber >= item.startLine && record.lineNumber <= item.endLine)?.turnId || null,
      category,
      scope: record.lineNumber >= turn.startLine ? 'current_turn' : 'history',
      hasSensitiveContent: kinds.length > 0,
      sensitiveKinds: kinds,
      externalOutput: external ? { path: external.path, sizeBytes: external.sizeBytes } : null,
    });
  }
  let syntheticLine = session._records.length + 1;
  const visibleToolIds = new Set();
  for (const record of mainRecords) {
    for (const block of contentBlocks(record)) if (block.type === 'tool_use' && block.id) visibleToolIds.add(block.id);
  }
  for (const agent of session._subagents) {
    if (agent.metadata?.toolUseId && !visibleToolIds.has(agent.metadata.toolUseId)) continue;
    const parsed = parseJsonlTolerant(await readFile(agent.jsonlPath, 'utf8'), agent.jsonlPath);
    for (const record of parsed.records) {
      const text = recordText(record);
      const role = record.data?.message?.role || null;
      const stream = `agent-${agent.agentId}`;
      const source = contextSource(record, stream);
      const kinds = sensitiveKinds(text, record.raw);
      context.push({
        lineNumber: syntheticLine,
        sourceLineNumber: record.lineNumber,
        stream,
        label: `子代理 ${agent.metadata?.description || agent.agentId} · ${role || record.data?.type || '记录'}`,
        text,
        raw: record.raw,
        type: record.data?.type || 'invalid_jsonl',
        role,
        source,
        phase: 'subagent',
        name: contentBlocks(record).find((block) => block.type === 'tool_use')?.name || null,
        turnId: agent.metadata?.toolUseId || null,
        category: contextCategory(record),
        scope: 'current_turn',
        hasSensitiveContent: kinds.length > 0,
        sensitiveKinds: kinds,
        externalOutput: null,
      });
      syntheticLine += 1;
    }
  }
  return context;
}

function contextMatches(record, options) {
  if (options.role !== 'all' && (options.role === 'none' ? record.role : record.role !== options.role)) return false;
  if (options.source !== 'all' && record.source !== options.source) return false;
  if (options.category !== 'all' && record.category !== options.category) return false;
  if (options.scope !== 'all' && record.scope !== options.scope) return false;
  if (!options.query) return true;
  return [record.label, record.text, record.raw, record.type, record.role, record.source, record.name, record.turnId, record.stream]
    .filter((value) => value !== null && value !== undefined)
    .join('\n')
    .toLocaleLowerCase()
    .includes(options.query.toLocaleLowerCase());
}

export async function readClaudeFullContext(claudeHome, sessionId, turnId, rawOptions = {}) {
  const session = await findSession(claudeHome, sessionId);
  const turn = selectedTurn(session, turnId);
  const options = normalizeContextOptions(rawOptions);
  const all = await buildContextRecords(session, turn);
  const filtered = all.filter((record) => contextMatches(record, options));
  let offset = Math.min(options.offset, Math.max(0, filtered.length - 1));
  let lineFound = null;
  if (options.lineNumber) {
    const index = filtered.findIndex((record) => record.lineNumber === options.lineNumber);
    if (index < 0) throw new CleanerError('CONTEXT_LINE_NOT_FOUND', 'The requested context line was not found.', 404, { lineNumber: options.lineNumber });
    offset = Math.floor(index / options.limit) * options.limit;
    lineFound = options.lineNumber;
  }
  const end = Math.min(filtered.length, offset + options.limit);
  return {
    session: publicSession(session),
    turn,
    records: filtered.slice(offset, end),
    filters: { query: options.query, role: options.role, source: options.source, category: options.category, scope: options.scope },
    page: {
      offset,
      limit: options.limit,
      nextOffset: end < filtered.length ? end : null,
      previousOffset: offset > 0 ? Math.max(0, offset - options.limit) : null,
      lineFound,
    },
    contextRecordCount: all.length,
    filteredRecordCount: filtered.length,
    sessionRecordCount: session._records.length,
    futureRecordCount: session._records.filter((record) => record.lineNumber > turn.endLine).length,
    sensitiveContextRecordCount: all.filter((record) => record.hasSensitiveContent).length,
    sensitiveFilteredRecordCount: filtered.filter((record) => record.hasSensitiveContent).length,
    runtimePrompt: {
      builtInPromptPersisted: false,
      message: 'Claude Code 内置基础提示词未写入该会话；这里只能展示实际落盘的运行时注入和会话记录。',
    },
  };
}
