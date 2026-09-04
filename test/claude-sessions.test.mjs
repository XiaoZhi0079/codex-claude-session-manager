import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeSessionRegistry,
  readClaudeFullContext,
  readClaudeSessionTurns,
  readClaudeTurnDetail,
} from '../src/claude-sessions.mjs';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const AGENT_ID = 'agent-test';

function jsonl(values) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-session-registry-'));
  const claudeHome = path.join(root, '.claude');
  const projectDir = path.join(claudeHome, 'projects', 'D--Work-Demo');
  const sessionDir = path.join(projectDir, SESSION_ID);
  const toolResultsDir = path.join(sessionDir, 'tool-results');
  const subagentsDir = path.join(sessionDir, 'subagents');
  await mkdir(toolResultsDir, { recursive: true });
  await mkdir(subagentsDir, { recursive: true });
  await mkdir(path.join(claudeHome, 'tasks', SESSION_ID), { recursive: true });
  await mkdir(path.join(claudeHome, 'file-history', SESSION_ID), { recursive: true });
  await mkdir(path.join(claudeHome, 'session-env', SESSION_ID), { recursive: true });

  const bashToolId = 'toolu_bash';
  const agentToolId = 'toolu_agent';
  const records = [
    { type: 'custom-title', customTitle: 'Claude 存储实验' },
    { type: 'user', uuid: 'meta1', parentUuid: null, isMeta: true, message: { role: 'user', content: '<local-command-caveat>ignore me</local-command-caveat>' } },
    { type: 'user', uuid: 'command1', parentUuid: 'meta1', message: { role: 'user', content: '<command-name>/model</command-name>' } },
    { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-08-05T01:00:00.000Z', cwd: 'D:\\Work\\Demo', message: { role: 'user', content: '检查项目' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-05T01:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: bashToolId, name: 'Bash', input: { command: 'large-output' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-08-05T01:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: bashToolId, content: `<persisted-output>\nOutput too large. Full output saved to: C:\\old\\tool-results\\large.txt\n</persisted-output>` }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-08-05T01:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '检查完成。' }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: '2026-08-05T02:00:00.000Z', cwd: 'D:\\Work\\Demo', message: { role: 'user', content: [{ type: 'text', text: '调用子代理继续分析' }] } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'u3', timestamp: '2026-08-05T02:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: agentToolId, name: 'Agent', input: { description: '检查模块' } }] } },
    { type: 'user', uuid: 'u4', parentUuid: 'a3', timestamp: '2026-08-05T02:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agentToolId, content: '子代理完成' }] } },
    { type: 'assistant', uuid: 'a4', parentUuid: 'u4', timestamp: '2026-08-05T02:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '最终分析完成。' }] } },
  ];
  await writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), jsonl(records), 'utf8');
  await writeFile(path.join(projectDir, 'sessions-index.json'), JSON.stringify({
    version: 1,
    originalPath: 'D:\\Work\\Demo',
    entries: [{ sessionId: SESSION_ID, summary: '过期索引标题', projectPath: 'D:\\Work\\Demo' }],
  }), 'utf8');
  await writeFile(path.join(toolResultsDir, 'large.txt'), '完整终端输出\n第二行', 'utf8');
  await writeFile(path.join(subagentsDir, `agent-${AGENT_ID}.jsonl`), jsonl([
    { type: 'user', uuid: 'su1', parentUuid: null, message: { role: 'user', content: '检查模块结构' } },
    { type: 'assistant', uuid: 'sa1', parentUuid: 'su1', message: { role: 'assistant', content: [{ type: 'text', text: '子代理发现结果' }] } },
  ]), 'utf8');
  await writeFile(path.join(subagentsDir, `agent-${AGENT_ID}.meta.json`), JSON.stringify({
    agentId: AGENT_ID,
    toolUseId: agentToolId,
    agentType: 'Explore',
    description: '模块检查',
  }), 'utf8');
  await writeFile(path.join(claudeHome, 'tasks', SESSION_ID, '1.json'), JSON.stringify({ id: '1', status: 'completed' }), 'utf8');
  return { root, claudeHome };
}

test('Claude registry uses native title metadata and aggregates the complete session bundle', async () => {
  const fixture = await createFixture();
  try {
    const registry = await buildClaudeSessionRegistry(fixture.claudeHome);
    assert.equal(registry.summary.total, 1);
    assert.equal(registry.summary.healthy, 1);
    assert.equal(registry.summary.withSubagents, 1);
    assert.equal(registry.directories[0].path, 'D:\\Work\\Demo');
    const session = registry.sessions[0];
    assert.equal(session.title, 'Claude 存储实验');
    assert.equal(session.titleSource, 'custom-title');
    assert.equal(session.turnCount, 2);
    assert.equal(session.persistedOutputCount, 1);
    assert.equal(session.missingPersistedOutputCount, 0);
    assert.equal(session.subagentCount, 1);
    assert.equal(session.tasks.fileCount, 1);
    assert.equal(session.health.state, 'healthy');
    assert.ok(session.totalBytes > session.mainFileBytes);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Claude compact turns mirror visible user, tool, result, and assistant blocks in order', async () => {
  const fixture = await createFixture();
  try {
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    assert.equal(listed.turns.length, 2);
    assert.equal(listed.turns[0].summary, '检查项目');
    assert.equal(listed.turns[0].toolCallCount, 1);
    const detail = await readClaudeTurnDetail(fixture.claudeHome, SESSION_ID, listed.turns[0].turnId);
    assert.equal(detail.readOnly, false);
    assert.deepEqual(detail.messages.map((message) => message.role), ['user', 'tool_call', 'tool_result', 'assistant']);
    assert.equal(detail.messages[0].parts[0].text, '检查项目');
    assert.equal(detail.messages[1].name, 'Bash');
    assert.match(detail.messages[1].parts[0].text, /large-output/);
    assert.match(detail.messages[2].parts[0].text, /完整终端输出/);
    assert.equal(detail.messages[1].editable, true);
    assert.equal(detail.messages[1].parts[0].targetId, 'a1:0:input');
    assert.equal(detail.messages[2].editable, false);
    assert.match(detail.messages[2].readOnlyReason, /外置文件/);
    assert.equal(detail.messages[2].externalOutput.sizeBytes > 0, true);
    assert.equal(detail.messages[3].parts[0].text, '检查完成。');
    assert.deepEqual([detail.messages[0].parts[0].targetId, detail.messages[3].parts[0].targetId], ['u1:0', 'a2:0']);

    const second = await readClaudeTurnDetail(fixture.claudeHome, SESSION_ID, listed.turns[1].turnId);
    assert.deepEqual(second.messages.map((message) => message.role), ['user', 'tool_call', 'tool_result', 'assistant']);
    assert.equal(second.messages[1].editable, true);
    assert.equal(second.messages[2].editable, true);
    assert.equal(second.messages[2].parts[0].targetId, 'u4:0:result');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Claude full context resolves safe tool-results and includes linked subagent streams', async () => {
  const fixture = await createFixture();
  try {
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    const first = await readClaudeFullContext(fixture.claudeHome, SESSION_ID, listed.turns[0].turnId, {
      category: 'tool_result',
    });
    assert.equal(first.filteredRecordCount, 1);
    assert.match(first.records[0].text, /完整终端输出/);
    assert.equal(first.records[0].externalOutput.sizeBytes > 0, true);
    assert.deepEqual(first.records[0].editableParts, []);

    const toolInput = await readClaudeFullContext(fixture.claudeHome, SESSION_ID, listed.turns[0].turnId, {
      category: 'tool_call',
      scope: 'current_turn',
    });
    assert.equal(toolInput.records[0].editableParts[0].targetId, 'a1:0:input');
    assert.match(toolInput.records[0].editableParts[0].text, /large-output/);

    const second = await readClaudeFullContext(fixture.claudeHome, SESSION_ID, listed.turns[1].turnId, {
      query: '子代理发现结果',
    });
    assert.equal(second.filteredRecordCount, 1);
    assert.equal(second.records[0].stream, `agent-${AGENT_ID}`);
    assert.equal(second.records[0].phase, 'subagent');
    assert.deepEqual(second.records[0].editableParts, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Claude stored context uses semantic sources and does not mislabel client system events as prompts', async () => {
  const fixture = await createFixture();
  try {
    const projectDir = path.join(fixture.claudeHome, 'projects', 'D--Work-Demo');
    const sessionPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    const original = await readFile(sessionPath, 'utf8');
    await writeFile(sessionPath, `${original.trimEnd()}\n${jsonl([
      { type: 'attachment', attachment: { type: 'skill_listing', content: 'skill runtime instructions' } },
      { type: 'system', subtype: 'turn_duration', durationMs: 10 },
    ])}`, 'utf8');
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    const detail = await readClaudeFullContext(fixture.claudeHome, SESSION_ID, listed.turns.at(-1).turnId, {
      source: 'runtime',
    });
    assert.equal(detail.filteredRecordCount, 1);
    assert.equal(detail.records[0].category, 'runtime_injection');
    assert.equal(detail.records[0].source, 'runtime');
    assert.match(detail.records[0].text, /skill runtime instructions/);
    const client = await readClaudeFullContext(fixture.claudeHome, SESSION_ID, listed.turns.at(-1).turnId, {
      source: 'client',
    });
    assert.ok(client.records.some((record) => record.type === 'system' && record.category === 'client_event'));
    assert.equal(client.runtimePrompt.builtInPromptPersisted, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
