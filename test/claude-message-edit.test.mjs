import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readClaudeSessionTurns } from '../src/claude-sessions.mjs';
import { applyClaudeMessageEdits, previewClaudeMessageEdits, restoreClaudeMessageEdit } from '../src/claude-message-edit.mjs';

test('Claude message edits update only the selected text block and restore from backup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-message-edit-'));
  const sessionId = '019faa00-aaaa-7222-8333-444455556666';
  const project = path.join(root, 'projects', 'project');
  await mkdir(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  const source = [
    { uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] } },
  ].map(JSON.stringify).join('\n') + '\n';
  await writeFile(file, source, 'utf8');
  const turns = await readClaudeSessionTurns(root, sessionId);
  const turnId = turns.turns[0].turnId;
  const edit = { targetId: 'u1:0', expectedText: 'hello', newText: 'hi' };
  const preview = await previewClaudeMessageEdits(root, sessionId, turnId, [edit]);
  const applied = await applyClaudeMessageEdits(root, sessionId, turnId, [edit], { sourceHash: preview.sourceHash, backupRoot: path.join(root, 'backups') });
  assert.match(await readFile(file, 'utf8'), /hi/);
  assert.match(await readFile(file, 'utf8'), /world/);
  await restoreClaudeMessageEdit(root, { backupRoot: path.join(root, 'backups'), backupDir: applied.backupDir, expectedCurrentHash: applied.sourceHashAfter });
  assert.equal(await readFile(file, 'utf8'), source);
});
