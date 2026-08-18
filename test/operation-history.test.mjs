import assert from 'node:assert/strict';
import { appendFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOperationHistory } from '../src/operation-history.mjs';

test('operation history records completed work and exposes only the latest operation for undo', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-operation-history-'));
  const moments = [
    new Date('2026-08-04T01:00:00Z'),
    new Date('2026-08-04T01:00:01Z'),
    new Date('2026-08-04T01:00:02Z'),
    new Date('2026-08-04T01:00:03Z'),
  ];
  const history = createOperationHistory({ backupRoot: root, instanceId: 'instance-a', now: () => moments.shift() });
  const first = await history.start({ kind: 'cleanup', label: '删除轮次', sessionIds: ['session-1'] });
  await history.complete(first, {
    result: { removed: 10 },
    undo: { type: 'rollout_restore', backupPath: 'safe-backup', expectedCurrentHash: 'after' },
  });
  const second = await history.start({ kind: 'backup_delete', label: '永久删除备份' });
  await history.complete(second, { result: { deleted: 1 } });

  const listed = await history.list();
  assert.equal(listed.operations.length, 2);
  assert.equal(listed.latest.id, second);
  assert.equal(listed.latest.canUndo, false);
  assert.equal(listed.operations[1].canUndo, true);
  assert.equal(listed.operations[1].undo.type, 'rollout_restore');
});

test('operation history marks unfinished work from a previous service instance as interrupted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-operation-history-'));
  const firstInstance = createOperationHistory({ backupRoot: root, instanceId: 'old-instance' });
  await firstInstance.start({ kind: 'visibility_repair', label: '可见性修复' });
  const currentInstance = createOperationHistory({ backupRoot: root, instanceId: 'new-instance' });
  const listed = await currentInstance.list();
  assert.equal(listed.latest.status, 'interrupted');
  assert.equal(listed.summary.interrupted, 1);
});

test('history error deletions remain individually restorable after newer operations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-operation-history-'));
  const history = createOperationHistory({ backupRoot: root, instanceId: 'instance-a' });
  const deletion = await history.start({ kind: 'history_error_delete', label: '删除孤立分页历史失败轮次' });
  await history.complete(deletion, { undo: { type: 'history_turn_restore', manifestPath: 'removed-turn.json' } });
  const newer = await history.start({ kind: 'cleanup', label: '更新的操作' });
  await history.complete(newer);

  const listed = await history.list();
  const operation = listed.operations.find((item) => item.id === deletion);
  assert.equal(operation.canUndo, true);
  assert.equal(operation.canRestore, true);
});

test('operation history records failure, undo completion and tolerates a damaged trailing line', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-operation-history-'));
  const history = createOperationHistory({ backupRoot: root, instanceId: 'instance-a' });
  const failed = await history.start({ kind: 'cleanup', label: '删除轮次' });
  await history.fail(failed, Object.assign(new Error('write failed'), { code: 'WRITE_FAILED' }));
  const completed = await history.start({ kind: 'edit', label: '编辑消息' });
  await history.complete(completed, { undo: { type: 'rollout_restore' } });
  const undoOperation = await history.start({ kind: 'undo', label: '撤销编辑消息' });
  await history.complete(undoOperation);
  await history.markUndone(completed, undoOperation);
  await appendFile(history.filePath, '{broken', 'utf8');

  const listed = await history.list();
  assert.equal(listed.invalidLines, 1);
  assert.equal(listed.operations.find((item) => item.id === failed).status, 'failed');
  assert.equal(listed.operations.find((item) => item.id === completed).status, 'undone');
});
