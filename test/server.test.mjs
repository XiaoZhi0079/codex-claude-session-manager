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
