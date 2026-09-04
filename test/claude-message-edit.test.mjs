import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readClaudeSessionTurns } from '../src/claude-sessions.mjs';
import { applyClaudeMessageEdits, previewClaudeMessageEdits, restoreClaudeMessageEdit } from '../src/claude-message-edit.mjs';

test('Claude message edits support string messages and stored tool text, then restore from backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-message-edit-'));
  const sessionId = '019faa00-aaaa-7222-8333-444455556666';
  const project = path.join(root, 'projects', 'project');
  await mkdir(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  const source = [
    { uuid: 'u1', message: { role: 'user', content: 'hello' } },
    { type: 'attachment', uuid: 'x1', attachment: { type: 'skill', content: 'old injection' } },
    { uuid: 't1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo old' } }] } },
    { uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'old result' }] } },
    { uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] } },
  ].map(JSON.stringify).join('\n') + '\n';
  await writeFile(file, source, 'utf8');
  const turns = await readClaudeSessionTurns(root, sessionId);
  const turnId = turns.turns[0].turnId;
  const edits = [
    { targetId: 'u1:0', expectedText: 'hello', newText: 'hi' },
    { targetId: 'x1:attachment:content', expectedText: 'old injection', newText: 'new injection' },
    { targetId: 't1:0:input', expectedText: '{\n  "command": "echo old"\n}', newText: '{\n  "command": "echo new",\n  "timeout": 30\n}' },
    { targetId: 'r1:0:result', expectedText: 'old result', newText: 'new result' },
  ];
  const preview = await previewClaudeMessageEdits(root, sessionId, turnId, edits);
  const applied = await applyClaudeMessageEdits(root, sessionId, turnId, edits, { sourceHash: preview.sourceHash, backupRoot: path.join(root, 'backups') });
  const edited = await readFile(file, 'utf8');
  assert.match(edited, /"content":"hi"/);
  assert.match(edited, /new injection/);
  assert.match(edited, /echo new/);
  assert.match(edited, /"timeout":30/);
  assert.match(edited, /new result/);
  assert.match(edited, /world/);
  await restoreClaudeMessageEdit(root, { backupRoot: path.join(root, 'backups'), backupDir: applied.backupDir, expectedCurrentHash: applied.sourceHashAfter });
  assert.equal(await readFile(file, 'utf8'), source);
});

test('Claude message edits reject invalid structured tool JSON before writing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-message-edit-json-'));
  const sessionId = '019faa00-bbbb-7222-8333-444455556666';
  const project = path.join(root, 'projects', 'project');
  await mkdir(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  const source = [
    { uuid: 'u1', message: { role: 'user', content: 'run it' } },
    { uuid: 't1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo ok' } }] } },
  ].map(JSON.stringify).join('\n') + '\n';
  await writeFile(file, source, 'utf8');
  const turns = await readClaudeSessionTurns(root, sessionId);
  await assert.rejects(
    previewClaudeMessageEdits(root, sessionId, turns.turns[0].turnId, [{
      targetId: 't1:0:input',
      expectedText: '{\n  "command": "echo ok"\n}',
      newText: '{ broken',
    }]),
    (error) => error.code === 'INVALID_CLAUDE_EDIT_JSON',
  );
  assert.equal(await readFile(file, 'utf8'), source);
});
