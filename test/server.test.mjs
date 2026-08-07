import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-turn-cleaner-server-'));
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
