import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildClaudeSessionRegistry, readClaudeSessionTurns } from '../src/claude-sessions.mjs';
import {
  applyClaudeToolInteractionDeletion,
  applyClaudeTurnDeletion,
  previewClaudeToolInteractionDeletion,
  previewClaudeTurnDeletion,
  restoreClaudeTurnDeleteBackup,
} from '../src/claude-turn-delete.mjs';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const AGENT_ID = 'agent-test';

function jsonl(values) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-turn-delete-'));
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
    { type: 'custom-title', customTitle: 'Claude 轮次删除实验' },
    { type: 'user', uuid: 'meta1', parentUuid: null, isMeta: true, message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } },
    { type: 'user', uuid: 'command1', parentUuid: 'meta1', message: { role: 'user', content: '<command-name>/model</command-name>' } },
    { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-08-05T01:00:00.000Z', cwd: 'D:\\Work\\Demo', message: { role: 'user', content: '检查项目' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: bashToolId, name: 'Bash', input: { command: 'large-output' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: bashToolId, content: `<persisted-output>\nOutput too large. Full output saved to: C:\\old\\tool-results\\large.txt\n</persisted-output>` }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: '检查完成。' }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'a2', timestamp: '2026-08-05T02:00:00.000Z', cwd: 'D:\\Work\\Demo', message: { role: 'user', content: '调用子代理继续分析' } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'u3', message: { role: 'assistant', content: [{ type: 'tool_use', id: agentToolId, name: 'Agent', input: { description: '检查模块' } }] } },
    { type: 'user', uuid: 'u4', parentUuid: 'a3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agentToolId, content: '子代理完成' }] } },
    { type: 'assistant', uuid: 'a4', parentUuid: 'u4', message: { role: 'assistant', content: [{ type: 'text', text: '最终分析完成。' }] } },
  ];
  await writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), jsonl(records), 'utf8');
  await writeFile(path.join(projectDir, 'sessions-index.json'), JSON.stringify({
    version: 1,
    originalPath: 'D:\\Work\\Demo',
    entries: [{ sessionId: SESSION_ID, summary: '索引标题', projectPath: 'D:\\Work\\Demo' }],
  }), 'utf8');
  await writeFile(path.join(toolResultsDir, 'large.txt'), '完整终端输出\n第二行', 'utf8');
  await writeFile(path.join(subagentsDir, `agent-${AGENT_ID}.jsonl`), jsonl([
    { type: 'user', uuid: 'su1', parentUuid: null, message: { role: 'user', content: '检查模块结构' } },
    { type: 'assistant', uuid: 'sa1', parentUuid: 'su1', message: { role: 'assistant', content: [{ type: 'text', text: '子代理结果' }] } },
  ]), 'utf8');
  await writeFile(path.join(subagentsDir, `agent-${AGENT_ID}.meta.json`), JSON.stringify({
    agentId: AGENT_ID,
    toolUseId: agentToolId,
    agentType: 'Explore',
    description: '模块检查',
  }), 'utf8');
  return { root, claudeHome, toolResultsDir, subagentsDir };
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

test('预览可按 single 模式计算删除区间与引用的外置产物', async () => {
  const fixture = await createFixture();
  try {
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    const turn0 = listed.turns[0];
    const preview = await previewClaudeTurnDeletion(fixture.claudeHome, SESSION_ID, turn0.turnId, {
      mode: 'single',
      backupRoot: path.join(fixture.root, 'backups'),
    });
    assert.equal(preview.mode, 'single');
    assert.equal(preview.startLine, 4);
    assert.equal(preview.endLine, 7);
    assert.equal(preview.removedRecordCount, 4);
    assert.equal(preview.keptRecordCount, 7);
    assert.equal(typeof preview.sourceHash, 'string');
    assert.equal(preview.externalArtifacts.toolResultFiles.length, 1);
    assert.equal(preview.externalArtifacts.subagents.length, 0);
    assert.ok(preview.nextTurn);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('删除 single 模式轮次会移除该轮记录并清理对应 tool-results 文件', async () => {
  const fixture = await createFixture();
  try {
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    const turn0 = listed.turns[0];
    const preview = await previewClaudeTurnDeletion(fixture.claudeHome, SESSION_ID, turn0.turnId, {
      mode: 'single',
      backupRoot: path.join(fixture.root, 'backups'),
    });
    const result = await applyClaudeTurnDeletion(fixture.claudeHome, SESSION_ID, turn0.turnId, {
      mode: 'single',
      sourceHash: preview.sourceHash,
      backupRoot: path.join(fixture.root, 'backups'),
    });
    assert.equal(result.deleted.recordCount, 4);
    assert.equal(result.deleted.toolResultFiles, 1);
    assert.equal(result.deleted.subagents, 0);
    assert.ok(result.backup.backupDir.startsWith(path.join(fixture.root, 'backups')));
    assert.equal(await exists(path.join(fixture.toolResultsDir, 'large.txt')), false);

    const registry = await buildClaudeSessionRegistry(fixture.claudeHome);
    assert.equal(registry.summary.total, 1);
    assert.equal(registry.sessions[0].turnCount, 1);
    assert.equal(registry.sessions[0].persistedOutputCount, 0);
    assert.equal(registry.sessions[0].recordCount, 7);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('删除 truncate 模式轮次会截断到文件末尾并清理关联子代理', async () => {
  const fixture = await createFixture();
  try {
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    const turn1 = listed.turns[1];
    const preview = await previewClaudeTurnDeletion(fixture.claudeHome, SESSION_ID, turn1.turnId, {
      mode: 'truncate',
      backupRoot: path.join(fixture.root, 'backups'),
    });
    assert.equal(preview.removedRecordCount, 4);
    assert.equal(preview.endLine, 11);
    const result = await applyClaudeTurnDeletion(fixture.claudeHome, SESSION_ID, turn1.turnId, {
      mode: 'truncate',
      sourceHash: preview.sourceHash,
      backupRoot: path.join(fixture.root, 'backups'),
    });
    assert.equal(result.deleted.subagents, 1);
    assert.equal(await exists(path.join(fixture.subagentsDir, `agent-${AGENT_ID}.jsonl`)), false);
    assert.equal(await exists(path.join(fixture.subagentsDir, `agent-${AGENT_ID}.meta.json`)), false);

    const registry = await buildClaudeSessionRegistry(fixture.claudeHome);
    assert.equal(registry.sessions[0].turnCount, 1);
    assert.equal(registry.sessions[0].subagentCount, 0);
    assert.equal(registry.sessions[0].recordCount, 7);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('撤销可恢复主 JSONL 与被清理的外置产物', async () => {
  const fixture = await createFixture();
  try {
    const original = await readFile(path.join(fixture.claudeHome, 'projects', 'D--Work-Demo', `${SESSION_ID}.jsonl`), 'utf8');
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    const turn0 = listed.turns[0];
    const preview = await previewClaudeTurnDeletion(fixture.claudeHome, SESSION_ID, turn0.turnId, {
      mode: 'single',
      backupRoot: path.join(fixture.root, 'backups'),
    });
    const result = await applyClaudeTurnDeletion(fixture.claudeHome, SESSION_ID, turn0.turnId, {
      mode: 'single',
      sourceHash: preview.sourceHash,
      backupRoot: path.join(fixture.root, 'backups'),
    });
    assert.equal(await exists(path.join(fixture.toolResultsDir, 'large.txt')), false);

    const restored = await restoreClaudeTurnDeleteBackup(fixture.claudeHome, {
      backupRoot: path.join(fixture.root, 'backups'),
      backupDir: result.backup.backupDir,
      expectedCurrentHash: result.sourceHashAfter,
    });
    assert.equal(restored.restoredFileCount >= 2, true);

    const restoredMain = await readFile(path.join(fixture.claudeHome, 'projects', 'D--Work-Demo', `${SESSION_ID}.jsonl`), 'utf8');
    assert.equal(restoredMain, original);
    assert.equal(await readFile(path.join(fixture.toolResultsDir, 'large.txt'), 'utf8'), '完整终端输出\n第二行');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('sourceHash 不匹配时拒绝应用删除', async () => {
  const fixture = await createFixture();
  try {
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    await assert.rejects(
      applyClaudeTurnDeletion(fixture.claudeHome, SESSION_ID, listed.turns[0].turnId, {
        mode: 'single',
        sourceHash: 'stale-hash',
        backupRoot: path.join(fixture.root, 'backups'),
      }),
      (error) => error.code === 'CLAUDE_TURN_STALE_ROLLOUT',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('工具交互删除会原子移除调用、配对结果和外置输出，并可完整撤销', async () => {
  const fixture = await createFixture();
  try {
    const mainFile = path.join(fixture.claudeHome, 'projects', 'D--Work-Demo', `${SESSION_ID}.jsonl`);
    const original = await readFile(mainFile, 'utf8');
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    const turn = listed.turns[0];
    const preview = await previewClaudeToolInteractionDeletion(fixture.claudeHome, SESSION_ID, turn.turnId, 'toolu_bash', {
      backupRoot: path.join(fixture.root, 'backups'),
    });
    assert.equal(preview.callBlockCount, 1);
    assert.equal(preview.resultBlockCount, 1);
    assert.equal(preview.affectedRecordCount, 2);
    assert.equal(preview.externalArtifacts.toolResultFiles.length, 1);

    const result = await applyClaudeToolInteractionDeletion(fixture.claudeHome, SESSION_ID, turn.turnId, 'toolu_bash', {
      sourceHash: preview.sourceHash,
      backupRoot: path.join(fixture.root, 'backups'),
    });
    const edited = (await readFile(mainFile, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(edited.length, 11);
    assert.equal(edited.some((record) => record.message?.content?.some?.((block) => block.id === 'toolu_bash' || block.tool_use_id === 'toolu_bash')), false);
    assert.equal(edited.find((record) => record.uuid === 'a1').message.content.length, 0);
    assert.equal(edited.find((record) => record.uuid === 'u2').message.content.length, 0);
    assert.equal(edited.find((record) => record.uuid === 'a2').message.content[0].text, '检查完成。');
    assert.equal(await exists(path.join(fixture.toolResultsDir, 'large.txt')), false);

    await restoreClaudeTurnDeleteBackup(fixture.claudeHome, {
      backupRoot: path.join(fixture.root, 'backups'),
      backupDir: result.backup.backupDir,
      expectedCurrentHash: result.sourceHashAfter,
    });
    assert.equal(await readFile(mainFile, 'utf8'), original);
    assert.equal(await readFile(path.join(fixture.toolResultsDir, 'large.txt'), 'utf8'), '完整终端输出\n第二行');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('子代理工具交互删除只清理匹配的子代理文件', async () => {
  const fixture = await createFixture();
  try {
    const listed = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    const turn = listed.turns[1];
    const preview = await previewClaudeToolInteractionDeletion(fixture.claudeHome, SESSION_ID, turn.turnId, 'toolu_agent', {
      backupRoot: path.join(fixture.root, 'backups'),
    });
    assert.equal(preview.externalArtifacts.subagents.length, 1);
    const result = await applyClaudeToolInteractionDeletion(fixture.claudeHome, SESSION_ID, turn.turnId, 'toolu_agent', {
      sourceHash: preview.sourceHash,
      backupRoot: path.join(fixture.root, 'backups'),
    });
    assert.equal(result.deleted.subagents, 1);
    assert.equal(await exists(path.join(fixture.subagentsDir, `agent-${AGENT_ID}.jsonl`)), false);
    assert.equal(await exists(path.join(fixture.subagentsDir, `agent-${AGENT_ID}.meta.json`)), false);
    const after = await readClaudeSessionTurns(fixture.claudeHome, SESSION_ID);
    assert.equal(after.turns.length, 2);
    assert.equal(after.turns[0].toolCallCount, 1);
    assert.equal(after.turns[1].toolCallCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
