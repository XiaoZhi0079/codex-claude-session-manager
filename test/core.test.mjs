import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyCleanup,
  applyMessageEdits,
  applyToolInteractionDeletion,
  buildCompactConversationPreview,
  buildFullContextDetail,
  buildToolInteractionDeletePreview,
  buildTurnMessageDetail,
  mergeThreadHistoryTurnRows,
  CLEANUP_MODES,
  cleanRecords,
  hashRolloutSource,
  listTurnsFromRecords,
  parseJsonl,
  previewMessageEdits,
  restoreRolloutBackup,
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

test('Codex task errors and aborted turns are visible in compact turn details', () => {
  const records = parseJsonl(jsonl([
    { type: 'session_meta', payload: { id: 'errors' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-error' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retry this' }] },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-error',
        error: { message: 'stream disconnected before completion', codex_error_info: 'other' },
      },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-aborted' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'stop this' }] },
    },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-aborted', reason: 'interrupted' } },
  ]));

  const turns = listTurnsFromRecords(records);
  assert.equal(turns[0].status, 'failed');
  assert.equal(turns[0].error.message, 'stream disconnected before completion');
  assert.equal(turns[1].status, 'aborted');
  assert.equal(turns[1].abortReason, 'interrupted');

  const failedDetail = buildTurnMessageDetail(records, { turnId: 'turn-error' });
  assert.deepEqual(failedDetail.messages.map((message) => message.role), ['user', 'error']);
  assert.equal(failedDetail.messages[1].text, 'stream disconnected before completion');
  assert.equal(failedDetail.messages[1].editable, false);

  const compact = buildCompactConversationPreview(records);
  assert.deepEqual(compact.messages.map((message) => message.role), ['user', 'error', 'user', 'error']);

  const context = buildFullContextDetail(records, { turnId: 'turn-error' }, { offset: 0, limit: 20 });
  assert.equal(context.records.at(-1).label, 'Codex 错误');
  assert.equal(context.records.at(-1).text, 'stream disconnected before completion');
});

test('thread history failures merge by turn id and preserve unmatched diagnostics', () => {
  const turns = [{ index: 0, turnId: 'turn-1', status: 'aborted' }];
  const result = mergeThreadHistoryTurnRows(turns, [
    { turnId: 'turn-1', status: 'failed', error: { message: 'upstream 400' } },
    { turnId: 'stale-turn', status: 'failed', error: { message: 'stale projection error' } },
  ]);
  assert.equal(result.turns[0].status, 'failed');
  assert.equal(result.turns[0].error.message, 'upstream 400');
  assert.equal(result.unmatchedErrors[0].turnId, 'stale-turn');
});

test('cleanup requires the preview hash and preserves untouched raw lines', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-claude-session-manager-'));
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

function codexToolFixture() {
  return [
    { type: 'session_meta', payload: { id: 'tool-session' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'tool-turn' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect it' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: '{"path":"before.txt"}', call_id: 'call-1' } },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: [{ type: 'input_text', text: 'first line' }, { type: 'input_text', text: 'second line' }],
      },
    },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'stored summary' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'tool-turn' } },
  ];
}

test('Codex compact and stored views expose editable tool calls and results in client order', () => {
  const records = parseJsonl(jsonl(codexToolFixture()));
  const detail = buildTurnMessageDetail(records, { turnId: 'tool-turn' });
  assert.deepEqual(detail.messages.map((message) => message.role), ['user', 'tool_call', 'tool_result', 'assistant']);
  assert.equal(detail.messages[1].name, 'read_file');
  assert.equal(detail.messages[1].toolUseId, 'call-1');
  assert.equal(detail.messages[1].parts[0].text, '{"path":"before.txt"}');
  assert.deepEqual(detail.messages[2].parts.map((part) => part.text), ['first line', 'second line']);

  const context = buildFullContextDetail(records, { turnId: 'tool-turn' }, { offset: 0, limit: 20 });
  const callRecord = context.records.find((record) => record.type === 'function_call');
  const resultRecord = context.records.find((record) => record.type === 'function_call_output');
  assert.equal(callRecord.editableParts.length, 1);
  assert.deepEqual(callRecord.toolCalls, [{ id: 'call-1', name: 'read_file' }]);
  assert.equal(resultRecord.editableParts.length, 2);
  assert.equal(context.records.find((record) => record.type === 'reasoning').editableParts[0].text, 'stored summary');
});

test('Codex tool fields can be edited, invalid JSON is rejected, and an interaction can be deleted and restored', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-tool-edit-'));
  const rolloutPath = path.join(temp, 'rollout-tool-session.jsonl');
  const backupRoot = path.join(temp, 'backups');
  const source = jsonl(codexToolFixture());
  await writeFile(rolloutPath, source, 'utf8');
  const records = parseJsonl(source);
  const detail = buildTurnMessageDetail(records, { turnId: 'tool-turn' });
  const callPart = detail.messages.find((message) => message.role === 'tool_call').parts[0];
  const resultPart = detail.messages.find((message) => message.role === 'tool_result').parts[0];

  await assert.rejects(
    previewMessageEdits({
      rolloutPath,
      selector: { turnId: 'tool-turn' },
      sourceHash: hashRolloutSource(source),
      edits: [{ targetId: callPart.targetId, expectedText: callPart.text, newText: '{broken' }],
    }),
    (error) => error?.code === 'INVALID_TOOL_EDIT_JSON',
  );

  const edited = await applyMessageEdits({
    rolloutPath,
    selector: { turnId: 'tool-turn' },
    sourceHash: hashRolloutSource(source),
    backupRoot,
    edits: [
      { targetId: callPart.targetId, expectedText: callPart.text, newText: '{"path":"after.txt"}' },
      { targetId: resultPart.targetId, expectedText: resultPart.text, newText: 'edited first line' },
    ],
  });
  const editedRecords = parseJsonl(await readFile(rolloutPath, 'utf8'));
  assert.equal(editedRecords[3].data.payload.arguments, '{"path":"after.txt"}');
  assert.equal(editedRecords[4].data.payload.output[0].text, 'edited first line');

  const deletionPreview = buildToolInteractionDeletePreview(editedRecords, { turnId: 'tool-turn' }, 'call-1');
  assert.equal(deletionPreview.callBlockCount, 1);
  assert.equal(deletionPreview.resultBlockCount, 1);
  const editedSource = await readFile(rolloutPath, 'utf8');
  const deleted = await applyToolInteractionDeletion({
    rolloutPath,
    selector: { turnId: 'tool-turn' },
    callId: 'call-1',
    sourceHash: hashRolloutSource(editedSource),
    backupRoot,
  });
  const afterDelete = await readFile(rolloutPath, 'utf8');
  assert.doesNotMatch(afterDelete, /call-1/);
  assert.match(afterDelete, /"done"/);

  await restoreRolloutBackup({
    rolloutPath,
    backupPath: deleted.backupFile,
    backupRoot,
    expectedCurrentHash: deleted.sourceHashAfter,
  });
  assert.match(await readFile(rolloutPath, 'utf8'), /call-1/);
  assert.ok(edited.backupFile);
});
