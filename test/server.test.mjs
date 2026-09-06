import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createCleanerServer } from '../src/server.mjs';

function jsonl(values) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function request(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

test('server records a cleanup and safely undoes the latest operation', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-claude-session-manager-server-'));
  const codexHome = path.join(temp, '.codex');
  const backupRoot = path.join(temp, 'backups');
  const rolloutPath = path.join(temp, 'rollout-test-session.jsonl');
  const source = jsonl([
    { type: 'session_meta', payload: { id: 'test-session' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', turn_id: 'turn-1', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'temporary test' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ]);
  await writeFile(rolloutPath, source, 'utf8');

  const server = createCleanerServer({ codexHome, backupRoot, env: {} });
  try {
    const baseUrl = await listen(server);
    const preview = await request(baseUrl, '/api/preview', {
      rolloutPath,
      selector: { turnId: 'turn-1' },
      mode: 'single',
    });
    await request(baseUrl, '/api/apply', {
      rolloutPath,
      selector: { turnId: 'turn-1' },
      mode: 'single',
      sourceHash: preview.sourceHash,
      confirmation: 'DELETE',
    });

    const history = await request(baseUrl, '/api/operation-history?limit=10');
    assert.equal(history.latest.kind, 'turn_delete_single');
    assert.equal(history.latest.result.removedRecords, preview.preview.removedCount);
    assert.equal(history.latest.canUndo, true);

    const undo = await request(baseUrl, '/api/operation-history/undo-latest', {
      operationId: history.latest.id,
      confirmation: 'UNDO',
    });
    assert.equal(undo.undoneOperationId, history.latest.id);
    assert.equal(await readFile(rolloutPath, 'utf8'), source);

    const afterUndo = await request(baseUrl, '/api/operation-history?limit=10');
    assert.equal(afterUndo.latest.kind, 'undo');
    assert.equal(afterUndo.latest.canUndo, false);
    assert.equal(afterUndo.operations[1].status, 'undone');
  } finally {
    if (server.listening) await close(server);
    await rm(temp, { recursive: true, force: true });
  }
});

test('rollout-path mutation resolves the target session and invalidates only its history projection', async () => {
  const targetId = '019faa00-aaaa-7222-8333-444455556666';
  const otherId = '019faa00-bbbb-7222-8333-444455556666';
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-claude-session-manager-server-history-'));
  const codexHome = path.join(temp, '.codex');
  const backupRoot = path.join(temp, 'backups');
  const rolloutPath = path.join(temp, `rollout-${targetId}.jsonl`);
  await mkdir(codexHome, { recursive: true });
  const source = jsonl([
    { type: 'session_meta', payload: { id: targetId } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', turn_id: 'turn-1', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'temporary test' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ]);
  await writeFile(rolloutPath, source, 'utf8');

  const dbPath = path.join(codexHome, 'thread_history_1.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE thread_history_projection_state (
      thread_id TEXT PRIMARY KEY,
      next_rollout_byte_offset INTEGER NOT NULL,
      next_rollout_ordinal INTEGER NOT NULL
    );
    CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL);
    CREATE TABLE thread_items (thread_id TEXT NOT NULL, item_id TEXT NOT NULL);
  `);
  for (const id of [targetId, otherId]) {
    db.prepare('INSERT INTO thread_history_projection_state VALUES (?, 100, 2)').run(id);
    db.prepare('INSERT INTO thread_turns VALUES (?, ?)').run(id, `${id}-turn`);
    db.prepare('INSERT INTO thread_items VALUES (?, ?)').run(id, `${id}-item`);
  }
  db.close();

  const server = createCleanerServer({ codexHome, backupRoot, env: {} });
  try {
    const baseUrl = await listen(server);
    const preview = await request(baseUrl, '/api/preview', {
      rolloutPath,
      selector: { turnId: 'turn-1' },
      mode: 'single',
    });
    await request(baseUrl, '/api/apply', {
      rolloutPath,
      selector: { turnId: 'turn-1' },
      mode: 'single',
      sourceHash: preview.sourceHash,
      confirmation: 'DELETE',
    });

    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const table of ['thread_history_projection_state', 'thread_turns', 'thread_items']) {
        assert.equal(check.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE thread_id = ?`).get(targetId).count, 0);
        assert.equal(check.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE thread_id = ?`).get(otherId).count, 1);
      }
    } finally {
      check.close();
    }
  } finally {
    if (server.listening) await close(server);
    await rm(temp, { recursive: true, force: true });
  }
});

test('Codex turns remain readable when optional paginated history fails', async () => {
  const sessionId = '01a05dca-4389-72c0-b3ee-e21341451557';
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-session-turn-fallback-'));
  const codexHome = path.join(temp, '.codex');
  const rolloutPath = path.join(codexHome, 'sessions', '2026', '09', '02', `rollout-${sessionId}.jsonl`);
  await mkdir(path.dirname(rolloutPath), { recursive: true });
  await writeFile(rolloutPath, jsonl([
    { type: 'session_meta', payload: { id: sessionId, cwd: temp, model_provider: 'openai' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'still readable' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ]), 'utf8');
  const server = createCleanerServer({
    codexHome,
    backupRoot: path.join(temp, 'backups'),
    env: {},
    threadHistoryTurnReader: async () => { throw new Error('simulated SQLite clear failure'); },
    errorReporter: () => {},
  });
  try {
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/turns`);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.turns.length, 1);
    assert.equal(body.turns[0].summary, 'still readable');
    assert.equal(body.threadHistory.available, false);
    assert.equal(body.threadHistory.reason, 'read_failed');
    assert.equal(body.threadHistory.error.code, 'THREAD_HISTORY_READ_FAILED');
    assert.match(body.threadHistory.error.errorId, /^[0-9a-f-]{36}$/i);
  } finally {
    if (server.listening) await close(server);
    await rm(temp, { recursive: true, force: true });
  }
});

test('Codex tool interaction REST API deletes paired records and operation history restores them', async () => {
  const sessionId = '01a05dca-4389-72c0-b3ee-e21341450001';
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-tool-delete-server-'));
  const codexHome = path.join(temp, '.codex');
  const rolloutPath = path.join(codexHome, 'sessions', '2026', '09', '04', `rollout-${sessionId}.jsonl`);
  const backupRoot = path.join(temp, 'backups');
  await mkdir(path.dirname(rolloutPath), { recursive: true });
  const source = jsonl([
    { type: 'session_meta', payload: { id: sessionId, cwd: temp, model_provider: 'openai' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-tools' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'status', call_id: 'call-api' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-api', output: 'ok' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'finished' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-tools' } },
  ]);
  await writeFile(rolloutPath, source, 'utf8');
  const server = createCleanerServer({ codexHome, backupRoot, env: {} });
  try {
    const baseUrl = await listen(server);
    const endpoint = `/api/sessions/${sessionId}/turns/turn-tools/tools/call-api`;
    const preview = await request(baseUrl, `${endpoint}/delete-preview`, {});
    assert.equal(preview.callBlockCount, 1);
    assert.equal(preview.resultBlockCount, 1);
    await request(baseUrl, `${endpoint}/delete-apply`, { sourceHash: preview.sourceHash, confirmation: 'DELETE' });
    assert.doesNotMatch(await readFile(rolloutPath, 'utf8'), /call-api/);

    const history = await request(baseUrl, '/api/operation-history?limit=10');
    assert.equal(history.latest.kind, 'tool_interaction_delete');
    await request(baseUrl, '/api/operation-history/undo-latest', { operationId: history.latest.id, confirmation: 'UNDO' });
    assert.equal(await readFile(rolloutPath, 'utf8'), source);
  } finally {
    if (server.listening) await close(server);
    await rm(temp, { recursive: true, force: true });
  }
});

test('Codex subagent lists only owned turns and keeps inherited parent context read-only', async () => {
  const parentId = '01a05dca-4389-72c0-b3ee-e21341451001';
  const childId = '01a05dca-4389-72c0-b3ee-e21341451002';
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-subagent-turns-'));
  const codexHome = path.join(temp, '.codex');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '09', '06');
  const backupRoot = path.join(temp, 'backups');
  const parentPrompt = `investigate session migration ${'with complete context '.repeat(10)}`.trim();
  await mkdir(sessionsDir, { recursive: true });
  const inheritedRecords = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-turn-1' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'shared request' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'shared answer' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'parent-turn-1' } },
  ];
  await writeFile(path.join(sessionsDir, `rollout-${parentId}.jsonl`), jsonl([
    { type: 'session_meta', payload: { id: parentId, cwd: temp, thread_source: 'user' } },
    ...inheritedRecords,
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-spawn-turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: parentPrompt }] } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'parent-spawn-turn', item: { type: 'SubAgentActivity', kind: 'started', agent_thread_id: childId, agent_path: '/root/audit' } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'parent-spawn-turn' } },
  ]), 'utf8');
  await writeFile(path.join(sessionsDir, `rollout-${childId}.jsonl`), jsonl([
    {
      type: 'session_meta',
      payload: {
        id: childId,
        cwd: temp,
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: '/root/audit', agent_nickname: 'Auditor' } } },
      },
    },
    ...inheritedRecords,
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn-1' } },
    { type: 'response_item', payload: { type: 'agent_message', author: '/root', recipient: '/root/audit', content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/audit\nSender: /root\nPayload:\n' }, { type: 'encrypted_content', encrypted_content: 'ciphertext' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'child-only analysis' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'child-turn-1' } },
  ]), 'utf8');

  const server = createCleanerServer({ codexHome, backupRoot, env: {} });
  try {
    const baseUrl = await listen(server);
    const turns = await request(baseUrl, `/api/sessions/${childId}/turns`);
    assert.equal(turns.turns.length, 1);
    assert.equal(turns.turns[0].turnId, 'child-turn-1');
    assert.equal(turns.turns[0].index, 0);
    assert.equal(turns.turns[0].rolloutIndex, 1);
    assert.equal(turns.inheritedTurns.length, 1);
    assert.equal(turns.subagentContext.parentSessionId, parentId);
    assert.equal(turns.subagentContext.originatingPrompt, parentPrompt);

    const detail = await request(baseUrl, '/api/turn-detail', {
      sessionId: childId,
      selector: { turnId: 'child-turn-1' },
    });
    assert.deepEqual(detail.detail.messages.map((message) => message.role), ['subagent_task', 'assistant']);
    assert.match(detail.detail.messages[0].text, /NEW_TASK/);
    assert.match(detail.detail.messages[0].text, /加密内容/);
    assert.equal(detail.detail.messages[0].editable, false);

    const context = await request(baseUrl, '/api/full-context', {
      sessionId: childId,
      selector: { turnId: 'child-turn-1' },
      offset: 0,
      limit: 20,
    });
    const inherited = context.detail.records.filter((record) => record.inherited);
    assert.equal(inherited.length, inheritedRecords.length);
    assert.equal(inherited.every((record) => record.editableParts.length === 0), true);
    assert.equal(inherited.every((record) => record.label.startsWith('继承 · ')), true);

    const response = await fetch(`${baseUrl}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: childId, selector: { turnId: 'parent-turn-1' }, mode: 'single' }),
    });
    const error = await response.json();
    assert.equal(response.status, 409);
    assert.equal(error.error.code, 'INHERITED_SUBAGENT_TURN_READ_ONLY');
  } finally {
    if (server.listening) await close(server);
    await rm(temp, { recursive: true, force: true });
  }
});
