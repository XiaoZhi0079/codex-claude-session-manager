import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  backupThreadHistoryDatabase,
  deleteOrphanFailedHistoryTurn,
  inspectTargetSessionLocks,
  invalidateThreadHistory,
  prepareThreadHistoryMutation,
  readThreadHistoryState,
  readThreadHistoryTurnRows,
  resolveThreadHistoryDbPath,
  restoreOrphanFailedHistoryTurn,
  withTargetSessionLocks,
} from '../src/codex-thread-history.mjs';
import {
  applyCleanup,
  CLEANUP_MODES,
  hashRolloutSource,
} from '../src/core.mjs';

const TARGET_ID = '019faa00-aaaa-7222-8333-444455556666';
const OTHER_ID = '019faa00-bbbb-7222-8333-444455556666';
const FAILED_TURN_ID = '019faa00-cccc-7222-8333-444455556666';

async function historyFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-thread-history-'));
  const codexHome = path.join(root, '.codex');
  await mkdir(codexHome, { recursive: true });
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
  const projection = db.prepare('INSERT INTO thread_history_projection_state VALUES (?, ?, ?)');
  const turn = db.prepare('INSERT INTO thread_turns VALUES (?, ?)');
  const item = db.prepare('INSERT INTO thread_items VALUES (?, ?)');
  for (const id of [TARGET_ID, OTHER_ID]) {
    projection.run(id, 120, 4);
    turn.run(id, `${id}-turn`);
    item.run(id, `${id}-item-1`);
    item.run(id, `${id}-item-2`);
  }
  db.close();
  return { root, codexHome, dbPath };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

test('thread history resolution uses the newest supported database', async () => {
  const data = await historyFixture();
  const newer = path.join(data.codexHome, 'thread_history_3.sqlite');
  await writeFile(newer, '', 'utf8');
  assert.equal(await resolveThreadHistoryDbPath(data.codexHome), newer);
});

test('configured SQLite home takes precedence over higher-version default databases', async () => {
  const data = await historyFixture();
  const configuredRoot = path.join(data.root, 'configured-sqlite');
  await mkdir(configuredRoot, { recursive: true });
  const configuredDb = path.join(configuredRoot, 'thread_history_1.sqlite');
  await writeFile(configuredDb, '', 'utf8');
  await writeFile(path.join(data.codexHome, 'thread_history_9.sqlite'), '', 'utf8');
  assert.equal(await resolveThreadHistoryDbPath(data.codexHome, {
    env: { CODEX_SQLITE_HOME: configuredRoot },
  }), configuredDb);
});

test('target invalidation preserves every other session and creates a valid backup', async () => {
  const data = await historyFixture();
  const backupDir = path.join(data.root, 'backup');
  const prepared = await prepareThreadHistoryMutation(data.codexHome, [TARGET_ID], backupDir);
  assert.equal(prepared.affected, true);
  assert.equal(await exists(prepared.backup.backupPath), true);

  const backupDb = new DatabaseSync(prepared.backup.backupPath, { readOnly: true });
  assert.equal(backupDb.prepare('SELECT COUNT(*) AS count FROM thread_items').get().count, 4);
  backupDb.close();

  const result = await invalidateThreadHistory(data.codexHome, [TARGET_ID]);
  assert.deepEqual(
    { projectionRows: result.projectionRows, turnRows: result.turnRows, itemRows: result.itemRows },
    { projectionRows: 1, turnRows: 1, itemRows: 2 },
  );
  const state = await readThreadHistoryState(data.codexHome, [TARGET_ID, OTHER_ID]);
  const target = state.sessions.find((session) => session.sessionId === TARGET_ID);
  const other = state.sessions.find((session) => session.sessionId === OTHER_ID);
  assert.deepEqual({ projection: target.projection, turns: target.turnRows, items: target.itemRows }, {
    projection: null,
    turns: 0,
    items: 0,
  });
  assert.equal(other.projection.next_rollout_byte_offset, 120);
  assert.equal(other.projection.next_rollout_ordinal, 4);
  assert.equal(other.turnRows, 1);
  assert.equal(other.itemRows, 2);
});

test('reads failed turn status and error_json from paginated history', async () => {
  const data = await historyFixture();
  const db = new DatabaseSync(path.join(data.codexHome, 'thread_history_1.sqlite'));
  db.exec('ALTER TABLE thread_turns ADD COLUMN rollout_ordinal INTEGER; ALTER TABLE thread_turns ADD COLUMN status TEXT; ALTER TABLE thread_turns ADD COLUMN error_json TEXT; ALTER TABLE thread_turns ADD COLUMN started_at INTEGER; ALTER TABLE thread_turns ADD COLUMN completed_at INTEGER;');
  db.prepare('INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, error_json) VALUES (?, ?, ?, ?, ?)')
    .run(TARGET_ID, 'history-error-turn', 99, 'failed', JSON.stringify({ message: 'upstream bad request', codexErrorInfo: 'other' }));
  db.close();
  const result = await readThreadHistoryTurnRows(data.codexHome, [TARGET_ID]);
  const row = result.rows.find((item) => item.turnId === 'history-error-turn');
  assert.equal(row.status, 'failed');
  assert.equal(row.error.message, 'upstream bad request');
});

test('reads legacy thread_turns schemas without optional status columns', async () => {
  const data = await historyFixture();
  const result = await readThreadHistoryTurnRows(data.codexHome, [TARGET_ID]);
  assert.equal(result.available, true);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], {
    sessionId: TARGET_ID,
    turnId: `${TARGET_ID}-turn`,
    rolloutOrdinal: null,
    status: null,
    error: null,
    startedAt: null,
    completedAt: null,
  });
  assert.equal(result.capabilities.error_json, false);
  assert.equal(result.capabilities.status, false);
});

test('database backup helper safely snapshots the current thread history', async () => {
  const data = await historyFixture();
  const result = await backupThreadHistoryDatabase(data.codexHome, path.join(data.root, 'backup'));
  assert.equal(await exists(result.backupPath), true);
  const backupDb = new DatabaseSync(result.backupPath, { readOnly: true });
  assert.equal(backupDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  backupDb.close();
});

test('deletes and restores only an orphan failed history turn', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-orphan-history-'));
  const codexHome = path.join(root, '.codex');
  await mkdir(codexHome, { recursive: true });
  const dbPath = path.join(codexHome, 'thread_history_1.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER,
      PRIMARY KEY (thread_id, turn_id)
    );
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
      item_json TEXT NOT NULL, item_type TEXT NOT NULL, updated_at_ordinal INTEGER NOT NULL,
      PRIMARY KEY (thread_id, turn_id, item_id)
    );
  `);
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(TARGET_ID, FAILED_TURN_ID, 10, 'failed', JSON.stringify({ message: 'bad request' }), 1, 2);
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(TARGET_ID, OTHER_ID, 20, 'completed', null, 3, 4);
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(TARGET_ID, FAILED_TURN_ID, 'user-1', 11, 1, '{"type":"userMessage"}', 'userMessage', 11);
  db.close();

  const deleted = await deleteOrphanFailedHistoryTurn(codexHome, {
    sessionId: TARGET_ID,
    turnId: FAILED_TURN_ID,
    rolloutTurnIds: [OTHER_ID],
  });
  assert.deepEqual({ turns: deleted.turnRows, items: deleted.itemRows }, { turns: 1, items: 1 });
  const afterDelete = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(afterDelete.prepare('SELECT COUNT(*) AS count FROM thread_turns').get().count, 1);
  assert.equal(afterDelete.prepare('SELECT status FROM thread_turns WHERE turn_id = ?').get(OTHER_ID).status, 'completed');
  afterDelete.close();

  const restored = await restoreOrphanFailedHistoryTurn(codexHome, deleted.removed);
  assert.deepEqual({ turns: restored.turnRows, items: restored.itemRows }, { turns: 1, items: 1 });
  const afterRestore = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(afterRestore.prepare('SELECT error_json FROM thread_turns WHERE turn_id = ?').get(FAILED_TURN_ID).error_json, JSON.stringify({ message: 'bad request' }));
  assert.equal(afterRestore.prepare('SELECT COUNT(*) AS count FROM thread_items WHERE turn_id = ?').get(FAILED_TURN_ID).count, 1);
  afterRestore.close();

  await assert.rejects(
    deleteOrphanFailedHistoryTurn(codexHome, {
      sessionId: TARGET_ID,
      turnId: FAILED_TURN_ID,
      rolloutTurnIds: [FAILED_TURN_ID],
    }),
    (error) => error?.code === 'HISTORY_TURN_NOT_ORPHANED',
  );
});

test('cleanup backs up and invalidates only the selected paginated session', async () => {
  const data = await historyFixture();
  const rolloutPath = path.join(data.root, `rollout-${TARGET_ID}.jsonl`);
  const source = [
    { type: 'session_meta', payload: { id: TARGET_ID } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(rolloutPath, source, 'utf8');

  const result = await applyCleanup({
    codexHome: data.codexHome,
    sessionId: TARGET_ID,
    rolloutPath,
    selector: { turnId: 'turn-2' },
    mode: CLEANUP_MODES.TRUNCATE,
    sourceHash: hashRolloutSource(source),
    backupRoot: path.join(data.root, 'backups'),
    onThreadHistoryInvalidated: async ({ validatedSource }) => {
      const diskSource = await readFile(rolloutPath, 'utf8');
      assert.equal(diskSource, validatedSource);
      assert.equal(diskSource.includes('turn-2'), false);
    },
  });
  assert.equal(result.threadHistory.invalidation.projectionRows, 1);
  assert.equal(await exists(result.threadHistory.backup.backupPath), true);
  const state = await readThreadHistoryState(data.codexHome, [TARGET_ID, OTHER_ID]);
  assert.equal(state.sessions[0].projection, null);
  assert.notEqual(state.sessions[1].projection, null);
});

test('cleanup invalidates a stale projection created after the write-side backup check', async () => {
  const data = await historyFixture();
  const rolloutPath = path.join(data.root, `rollout-${TARGET_ID}.jsonl`);
  const source = [
    { type: 'session_meta', payload: { id: TARGET_ID } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(rolloutPath, source, 'utf8');

  const before = new DatabaseSync(data.dbPath);
  before.prepare('DELETE FROM thread_items WHERE thread_id = ?').run(TARGET_ID);
  before.prepare('DELETE FROM thread_turns WHERE thread_id = ?').run(TARGET_ID);
  before.prepare('DELETE FROM thread_history_projection_state WHERE thread_id = ?').run(TARGET_ID);
  before.close();

  const result = await applyCleanup({
    codexHome: data.codexHome,
    sessionId: TARGET_ID,
    rolloutPath,
    selector: { turnId: 'turn-2' },
    mode: CLEANUP_MODES.TRUNCATE,
    sourceHash: hashRolloutSource(source),
    backupRoot: path.join(data.root, 'backups'),
    onThreadHistoryPrepared: async ({ affected }) => {
      assert.equal(affected, false);
      const raced = new DatabaseSync(data.dbPath);
      raced.prepare('INSERT INTO thread_history_projection_state VALUES (?, 999, 9)').run(TARGET_ID);
      raced.prepare('INSERT INTO thread_turns VALUES (?, ?)').run(TARGET_ID, 'stale-turn');
      raced.prepare('INSERT INTO thread_items VALUES (?, ?)').run(TARGET_ID, 'stale-item');
      raced.close();
    },
  });

  assert.equal(result.threadHistory.affected, false);
  assert.deepEqual(
    {
      projectionRows: result.threadHistory.invalidation.projectionRows,
      turnRows: result.threadHistory.invalidation.turnRows,
      itemRows: result.threadHistory.invalidation.itemRows,
    },
    { projectionRows: 1, turnRows: 1, itemRows: 1 },
  );
  const state = await readThreadHistoryState(data.codexHome, [TARGET_ID, OTHER_ID]);
  assert.equal(state.sessions[0].projection, null);
  assert.notEqual(state.sessions[1].projection, null);
});

test('target locks block the active session but allow unrelated sessions', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-thread-lock-'));
  const codexHome = path.join(root, '.codex');
  await mkdir(codexHome, { recursive: true });

  const before = await inspectTargetSessionLocks(codexHome, [TARGET_ID]);
  assert.deepEqual(before.activeSessionIds, []);

  await withTargetSessionLocks(codexHome, [TARGET_ID], {}, async () => {
    const held = await inspectTargetSessionLocks(codexHome, [TARGET_ID, OTHER_ID]);
    assert.deepEqual(held.activeSessionIds, [TARGET_ID]);
    let unrelatedRan = false;
    await withTargetSessionLocks(codexHome, [OTHER_ID], {}, async () => {
      unrelatedRan = true;
    });
    assert.equal(unrelatedRan, true);
    await assert.rejects(
      withTargetSessionLocks(codexHome, [TARGET_ID], {}, async () => {}),
      (error) => error?.code === 'TARGET_SESSION_ACTIVE',
    );
  });

  const after = await inspectTargetSessionLocks(codexHome, [TARGET_ID]);
  assert.deepEqual(after.activeSessionIds, []);
});
