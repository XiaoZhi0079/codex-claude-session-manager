import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCleanerServer } from '../src/server.mjs';

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('Claude REST resources expose sessions, turns, compact detail and full context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-server-api-'));
  const claudeHome = path.join(root, '.claude');
  const codexHome = path.join(root, '.codex');
  const projectDir = path.join(claudeHome, 'projects', 'D--Demo');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), [
    { type: 'user', uuid: 'u1', parentUuid: null, cwd: 'D:\\Demo', message: { role: 'user', content: 'API 测试' } },
    { type: 'assistant', uuid: 'tool-call', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-api', name: 'Bash', input: { command: 'echo ok' } }] } },
    { type: 'user', uuid: 'tool-result', parentUuid: 'tool-call', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-api', content: 'ok' }] } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: '测试完成' }] } },
  ].map((value) => JSON.stringify(value)).join('\n') + '\n', 'utf8');

  const server = createCleanerServer({ claudeHome, codexHome, backupRoot: path.join(root, 'backups'), env: {} });
  try {
    const baseUrl = await listen(server);
    const sessionsResponse = await fetch(`${baseUrl}/api/claude-code/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessions = await sessionsResponse.json();
    assert.equal(sessions.summary.total, 1);
    assert.equal(sessions.sessions[0].id, SESSION_ID);

    const turnsResponse = await fetch(`${baseUrl}/api/claude-code/sessions/${SESSION_ID}/turns`);
    assert.equal(turnsResponse.status, 200);
    const turns = await turnsResponse.json();
    assert.equal(turns.turns.length, 1);
    const turnId = turns.turns[0].turnId;

    const detailResponse = await fetch(`${baseUrl}/api/claude-code/sessions/${SESSION_ID}/turns/${turnId}`);
    assert.equal(detailResponse.status, 200);
    assert.equal((await detailResponse.json()).readOnly, false);

    const contextResponse = await fetch(`${baseUrl}/api/claude-code/sessions/${SESSION_ID}/context?turnId=${turnId}&category=message`);
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json();
    assert.equal(context.detail.filteredRecordCount, 2);

    const toolPreviewResponse = await fetch(`${baseUrl}/api/claude-code/sessions/${SESSION_ID}/turns/${turnId}/tools/tool-api/delete-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(toolPreviewResponse.status, 200);
    const toolPreview = await toolPreviewResponse.json();
    assert.equal(toolPreview.resultBlockCount, 1);
    const toolDeleteResponse = await fetch(`${baseUrl}/api/claude-code/sessions/${SESSION_ID}/turns/${turnId}/tools/tool-api/delete-apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceHash: toolPreview.sourceHash, confirmation: 'DELETE' }),
    });
    assert.equal(toolDeleteResponse.status, 200);
    assert.equal((await toolDeleteResponse.json()).deleted.callBlocks, 1);

    const deletePreviewResponse = await fetch(`${baseUrl}/api/claude-code/session-deletions/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });
    assert.equal(deletePreviewResponse.status, 200);
    const deletePreview = await deletePreviewResponse.json();
    const deleteResponse = await fetch(`${baseUrl}/api/claude-code/session-deletions/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, planToken: deletePreview.planToken, confirmation: 'PURGE' }),
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal((await deleteResponse.json()).deleted.sessions, 1);
    const emptySessions = await (await fetch(`${baseUrl}/api/claude-code/sessions`)).json();
    assert.equal(emptySessions.summary.total, 0);

    const backupList = await (await fetch(`${baseUrl}/api/claude-code/session-deletion-backups`)).json();
    assert.equal(backupList.backups.length, 1);
    const restorePreviewResponse = await fetch(`${baseUrl}/api/claude-code/session-deletion-backups/restore-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupId: backupList.backups[0].id, sessionIds: [SESSION_ID] }),
    });
    assert.equal(restorePreviewResponse.status, 200);
    const restorePreview = await restorePreviewResponse.json();
    const restoreResponse = await fetch(`${baseUrl}/api/claude-code/session-deletion-backups/restore-apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupId: backupList.backups[0].id, sessionIds: [SESSION_ID], planToken: restorePreview.planToken, confirmation: 'RESTORE' }),
    });
    assert.equal(restoreResponse.status, 200);
    assert.equal((await restoreResponse.json()).restored.sessions, 1);

    const invalidResponse = await fetch(`${baseUrl}/api/claude-code/sessions/not-a-uuid/turns`);
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json()).error.code, 'INVALID_CLAUDE_SESSION_ID');
  } finally {
    if (server.listening) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('Claude deletion is recorded and can be undone through operation history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-server-undo-'));
  const claudeHome = path.join(root, '.claude');
  const codexHome = path.join(root, '.codex');
  const projectDir = path.join(claudeHome, 'projects', 'D--Undo');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), `${JSON.stringify({
    type: 'user', uuid: 'u1', cwd: 'D:\\Undo', message: { role: 'user', content: '撤销测试' },
  })}\n`, 'utf8');
  const server = createCleanerServer({ claudeHome, codexHome, backupRoot: path.join(root, 'operation-history'), env: {} });
  try {
    const baseUrl = await listen(server);
    const preview = await (await fetch(`${baseUrl}/api/claude-code/session-deletions/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: SESSION_ID }),
    })).json();
    const deleted = await fetch(`${baseUrl}/api/claude-code/session-deletions/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: SESSION_ID, planToken: preview.planToken, confirmation: 'PURGE' }),
    });
    assert.equal(deleted.status, 200);
    const history = await (await fetch(`${baseUrl}/api/operation-history`)).json();
    assert.equal(history.latest.canUndo, true);
    const undone = await fetch(`${baseUrl}/api/operation-history/undo-latest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: history.latest.id, confirmation: 'UNDO' }),
    });
    assert.equal(undone.status, 200);
    const sessions = await (await fetch(`${baseUrl}/api/claude-code/sessions`)).json();
    assert.equal(sessions.summary.total, 1);
  } finally {
    if (server.listening) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});
