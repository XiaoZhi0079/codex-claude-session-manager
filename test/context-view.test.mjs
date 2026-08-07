import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFullContextExport,
  buildFullContextView,
  classifyContextRecord,
} from '../src/context-view.mjs';
import { parseJsonl } from '../src/core.mjs';

function fixture() {
  return parseJsonl(`${[
    {
      type: 'session_meta',
      payload: { id: 'context-session', base_instructions: { text: 'system foundation' } },
    },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'developer rule password=super-secret-value' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'search every context record' }],
      },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call', name: 'lookup', arguments: '{"query":"context"}' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'tool result with context match' },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'finished first task' }],
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'future record' }],
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ].map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('full context view searches all records before pagination and excludes future turns', () => {
  const detail = buildFullContextView(fixture(), { turnId: 'turn-1' }, {
    query: 'context',
    offset: 0,
    limit: 1,
  });
  assert.equal(detail.contextRecordCount, 8);
  assert.equal(detail.filteredRecordCount, 4);
  assert.equal(detail.records.length, 1);
  assert.equal(detail.records.some((record) => record.text === 'future record'), false);
  assert.equal(detail.page.nextOffset, 1);
});

test('full context view filters by role, category and current turn', () => {
  const roleDetail = buildFullContextView(fixture(), { turnId: 'turn-1' }, { role: 'developer' });
  assert.equal(roleDetail.filteredRecordCount, 1);
  assert.equal(roleDetail.records[0].category, 'prompt');
  assert.equal(roleDetail.records[0].hasSensitiveContent, true);

  const toolDetail = buildFullContextView(fixture(), { turnId: 'turn-1' }, {
    category: 'tool_result',
    scope: 'current_turn',
  });
  assert.equal(toolDetail.filteredRecordCount, 1);
  assert.equal(toolDetail.records[0].type, 'function_call_output');
  assert.equal(toolDetail.records[0].label, '工具返回');
  assert.equal(toolDetail.records[0].text, 'tool result with context match');
});

test('full context line jump locates an absolute JSONL line', () => {
  const detail = buildFullContextView(fixture(), { turnId: 'turn-1' }, {
    lineNumber: 6,
    limit: 2,
  });
  assert.equal(detail.page.lineFound, 6);
  assert.equal(detail.records.some((record) => record.lineNumber === 6), true);
});

test('context record categories distinguish prompts, tools, messages and internal events', () => {
  const detail = buildFullContextView(fixture(), { turnId: 'turn-1' }, { limit: 20 });
  const categories = new Set(detail.records.map(classifyContextRecord));
  assert.deepEqual(categories, new Set(['prompt', 'message', 'tool_call', 'tool_result', 'internal_event']));
});

test('context exports preserve filtered raw JSONL and create readable Markdown', () => {
  const records = fixture();
  const raw = buildFullContextExport(records, { turnId: 'turn-1' }, {
    format: 'jsonl',
    category: 'tool_result',
  }, { sessionId: 'context-session' });
  assert.equal(raw.recordCount, 1);
  assert.match(raw.content, /function_call_output/);
  assert.doesNotMatch(raw.content, /future record/);

  const markdown = buildFullContextExport(records, { turnId: 'turn-1' }, {
    format: 'markdown',
    role: 'developer',
  }, { sessionId: 'context-session' });
  assert.equal(markdown.recordCount, 1);
  assert.match(markdown.content, /^# Codex 完整上下文/m);
  assert.match(markdown.content, /可能含敏感信息/);
  assert.match(markdown.content, /developer rule/);
});
