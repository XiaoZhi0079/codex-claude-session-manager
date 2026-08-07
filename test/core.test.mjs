import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyCleanup,
  buildFullContextDetail,
  CLEANUP_MODES,
  cleanRecords,
  hashRolloutSource,
  listTurnsFromRecords,
  parseJsonl,
} from '../src/core.mjs';

function jsonl(values) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

function modernFixture() {
  return [
    { type: 'session_meta', payload: { id: 'session-1', cwd: '/tmp/project' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    {
      type: 'response_item',
      turn_id: 'turn-1',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'first request' }],
      },
    },
    { type: 'event_msg', payload: { type: 'thread_settings_applied' } },
    {
      type: 'response_item',
      turn_id: 'turn-1',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'first answer' }],
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    {
      type: 'response_item',
      turn_id: 'turn-2',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'second request' }],
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ];
}

test('modern turns use task boundaries and ignore thread_settings_applied inside a task', () => {
  const records = parseJsonl(jsonl(modernFixture()));
  const turns = listTurnsFromRecords(records);

  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => ({
    turnId: turn.turnId,
    startLine: turn.startLine,
    endLine: turn.endLine,
    boundaryKind: turn.boundaryKind,
  })), [
    { turnId: 'turn-1', startLine: 2, endLine: 6, boundaryKind: 'task' },
    { turnId: 'turn-2', startLine: 8, endLine: 10, boundaryKind: 'task' },
  ]);
});

test('A mode truncates from the selected task without deleting the previous task', () => {
  const records = parseJsonl(jsonl(modernFixture()));
  const cleaned = cleanRecords(records, { turnId: 'turn-2' }, CLEANUP_MODES.TRUNCATE);

  assert.equal(cleaned.length, 7);
  assert.equal(cleaned[5].data.payload.type, 'task_complete');
  assert.equal(cleaned[5].data.payload.turn_id, 'turn-1');
  assert.equal(cleaned[6].data.payload.type, 'thread_settings_applied');
});

test('B mode removes only the selected completed task and keeps later task settings', () => {
  const records = parseJsonl(jsonl(modernFixture()));
  const cleaned = cleanRecords(records, { turnId: 'turn-1' }, CLEANUP_MODES.SINGLE);

  assert.deepEqual(cleaned.map((record) => record.lineNumber), [1, 7, 8, 9, 10]);
  assert.equal(listTurnsFromRecords(cleaned).length, 1);
  assert.equal(listTurnsFromRecords(cleaned)[0].turnId, 'turn-2');
});

test('legacy rollouts fall back to turn_context boundaries', () => {
  const records = parseJsonl(jsonl([
    { type: 'session_meta', payload: { id: 'legacy' } },
    { type: 'turn_context', payload: {} },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'legacy first' }],
      },
    },
    { type: 'turn_context', payload: {} },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'legacy second' }],
      },
    },
  ]));

  const turns = listTurnsFromRecords(records);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => [turn.startLine, turn.endLine, turn.boundaryKind]), [
    [2, 3, 'turn_context'],
    [4, 5, 'turn_context'],
  ]);
});

test('full context includes persisted base instructions and every record through the selected turn', () => {
  const records = parseJsonl(jsonl([
    {
      type: 'session_meta',
      payload: { id: 'full-context', base_instructions: { text: 'built-in Codex instructions' } },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'developer instructions' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'first request' }],
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'future request' }],
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ]));

  const detail = buildFullContextDetail(records, { turnId: 'turn-1' }, { offset: 0, limit: 20 });
  assert.equal(detail.contextRecordCount, 5);
  assert.equal(detail.sessionRecordCount, 8);
  assert.equal(detail.futureRecordCount, 3);
  assert.equal(detail.records[0].label, 'Codex 基础提示词与会话元数据');
  assert.equal(detail.records[0].text, 'built-in Codex instructions');
  assert.equal(detail.records[2].role, 'developer');
  assert.equal(detail.records[2].text, 'developer instructions');
  assert.equal(detail.records.some((record) => record.text === 'future request'), false);
});

test('cleanup requires the preview hash and preserves untouched raw lines', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-turn-cleaner-'));
  const rolloutPath = path.join(temp, 'rollout-session-1.jsonl');
  const backupRoot = path.join(temp, 'backups');
  const source = modernFixture()
    .map((value, index) => (index === 0 ? `{ "type": "session_meta", "payload": { "id": "session-1" } }` : JSON.stringify(value)))
    .join('\r\n') + '\r\n';
  await writeFile(rolloutPath, source, 'utf8');

  const result = await applyCleanup({
    rolloutPath,
    selector: { turnId: 'turn-2' },
    mode: CLEANUP_MODES.TRUNCATE,
    sourceHash: hashRolloutSource(source),
    backupRoot,
  });
  const cleaned = await readFile(rolloutPath, 'utf8');

  assert.match(cleaned, /^\{ "type": "session_meta"/);
  assert.ok(cleaned.includes('\r\n'));
  assert.equal(result.validation.recordCount, 7);
  assert.ok(result.backupFile);

  await assert.rejects(
    applyCleanup({
      rolloutPath,
      selector: { turnId: 'turn-1' },
      mode: CLEANUP_MODES.TRUNCATE,
      sourceHash: hashRolloutSource(source),
      backupRoot,
    }),
    (error) => error?.code === 'STALE_ROLLOUT',
  );
});
