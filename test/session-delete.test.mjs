import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  applySessionDeletionBatch,
  applySessionDeletionBackupRestore,
  applySessionDeletion,
  deleteSessionDeletionBackups,
  listSessionDeletionBackups,
  previewSessionDeletionBatch,
  previewSessionDeletionBackupRestore,
  previewSessionDeletion,
} from '../src/session-delete.mjs';

const SESSION_ID = '019faa00-aaaa-7222-8333-444455556666';
const CHILD_ID = '019faa00-bbbb-7222-8333-444455556666';
const NO_CODEX_PROCESSES = { available: true, processes: [] };

function rollout() {
  return `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: SESSION_ID,
      cwd: 'D:\\project',
      model_provider: 'custom',
      source: 'cli',
    },
  })}\n${JSON.stringify({
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'turn-1' },
  })}\n`;
}

async function fixture({ withRollout = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-session-delete-'));
  const codexHome = path.join(root, '.codex');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '07', '01');
  const backupRoot = path.join(codexHome, 'backups', 'codex-turn-cleaner');
  const rolloutPath = path.join(sessionsDir, `rollout-2026-07-01T00-00-00-${SESSION_ID}.jsonl`);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  await writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "custom"\n', 'utf8');
  await writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: SESSION_ID, thread_name: 'Delete me' }),
    JSON.stringify({ id: CHILD_ID, thread_name: 'Keep me' }),
  ].join('\n') + '\n', 'utf8');
  if (withRollout) await writeFile(rolloutPath, rollout(), 'utf8');

  const dbPath = path.join(codexHome, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      rollout_path TEXT,
      archived INTEGER,
      model_provider TEXT,
      updated_at INTEGER,
      created_at INTEGER,
      cwd TEXT,
      source TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads
      (id, title, rollout_path, archived, model_provider, updated_at, created_at, cwd, source)
    VALUES (?, ?, ?, 0, 'custom', 1, 1, 'D:\\project', ?)
  `);
  insert.run(SESSION_ID, 'Delete me', rolloutPath, 'cli');
  insert.run(CHILD_ID, 'Keep child', path.join(sessionsDir, `rollout-${CHILD_ID}.jsonl`), JSON.stringify({
    subagent: { thread_spawn: { parent_thread_id: SESSION_ID } },
  }));
  db.close();
  return {
    root,
    codexHome,
    backupRoot,
    rolloutPath,
    dbPath,
    env: { ...process.env, USERPROFILE: root, HOME: root },
  };
}

async function missing(filePath) {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

test('whole-session deletion backs up and removes rollout, SQLite row, and legacy index only', async () => {
  const data = await fixture({ withRollout: true });
  const now = new Date('2026-07-30T12:00:00Z');
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionId: SESSION_ID,
    now,
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const preview = await previewSessionDeletion(data.codexHome, options);
  assert.deepEqual(preview.summary, {
    rolloutFiles: 1,
    sqliteRows: 1,
    indexRows: 1,
    childThreadsKept: 1,
    historicalBackupFiles: 0,
  });
  assert.equal(preview.canApply, true);

  const result = await applySessionDeletion(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal(await missing(data.rolloutPath), true);
  assert.equal(result.childThreadsKept, 1);
  assert.equal(await missing(result.backup.rolloutBackup), false);
  assert.equal(await missing(result.backup.stateDbBackup), false);
  const index = await readFile(path.join(data.codexHome, 'session_index.jsonl'), 'utf8');
  assert.equal(index.includes(SESSION_ID), false);
  assert.equal(index.includes(CHILD_ID), true);

  const db = new DatabaseSync(data.dbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS count FROM threads WHERE id = ?').get(SESSION_ID).count, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM threads WHERE id = ?').get(CHILD_ID).count, 1);
  db.close();
});

test('whole-session deletion can remove SQLite-only residue without fabricating a rollout backup', async () => {
  const data = await fixture({ withRollout: false });
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionId: SESSION_ID,
    now: new Date('2026-07-30T12:00:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const preview = await previewSessionDeletion(data.codexHome, options);
  assert.equal(preview.summary.rolloutFiles, 0);
  assert.equal(preview.summary.sqliteRows, 1);
  const result = await applySessionDeletion(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal(result.backup.rolloutBackup, null);
  assert.equal(await missing(result.backup.stateDbBackup), false);
});

test('whole-session deletion accepts Windows extended-length rollout paths', async () => {
  const data = await fixture({ withRollout: true });
  const extendedPath = `\\\\?\\${data.rolloutPath}`;
  const db = new DatabaseSync(data.dbPath);
  db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(extendedPath, SESSION_ID);
  db.close();
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionId: SESSION_ID,
    now: new Date('2026-07-30T12:30:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const preview = await previewSessionDeletion(data.codexHome, options);
  assert.equal(preview.canApply, true);
  assert.equal(preview.rolloutPath, extendedPath);
  const result = await applySessionDeletion(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal(result.deleted.rolloutFiles, 1);
  assert.equal(await missing(data.rolloutPath), true);
});

test('backup-only session deletion permanently removes tool-owned historical backups', async () => {
  const data = await fixture({ withRollout: true });
  const historicalDir = path.join(data.backupRoot, 'codex-turn-cleaner-2026-07-30-123500000');
  const historicalPath = path.join(historicalDir, path.basename(data.rolloutPath));
  await mkdir(historicalDir, { recursive: true });
  await writeFile(historicalPath, rollout(), 'utf8');
  await unlink(data.rolloutPath);
  await writeFile(
    path.join(data.codexHome, 'session_index.jsonl'),
    `${JSON.stringify({ id: CHILD_ID, thread_name: 'Keep me' })}\n`,
    'utf8',
  );
  const db = new DatabaseSync(data.dbPath);
  db.prepare('DELETE FROM threads WHERE id = ?').run(SESSION_ID);
  db.close();

  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionId: SESSION_ID,
    now: new Date('2026-07-30T12:35:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const preview = await previewSessionDeletion(data.codexHome, options);
  assert.equal(preview.session.storageStatus, 'backup_only');
  assert.equal(preview.canApply, true);
  assert.equal(preview.permanentBackupDeletion, true);
  assert.equal(preview.summary.historicalBackupFiles, 1);

  const result = await applySessionDeletion(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal(result.backup, null);
  assert.equal(result.deleted.historicalBackupFiles, 1);
  assert.equal(await missing(historicalPath), true);
});

test('whole-session deletion proceeds while Codex is running and recommends a refresh', async () => {
  const data = await fixture({ withRollout: true });
  const codexProcessCheck = {
    available: true,
    processes: [{ pid: 1234, parentPid: 1000, name: 'codex.exe' }],
  };
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionId: SESSION_ID,
    now: new Date('2026-07-30T12:00:00Z'),
    codexProcessCheck,
  };
  const preview = await previewSessionDeletion(data.codexHome, options);
  assert.equal(preview.canApply, true);
  assert.equal(preview.codexRunning, true);
  assert.equal(preview.blockedByRunningCodex, false);
  assert.equal(preview.refreshCodexAfterApply, true);
  const result = await applySessionDeletion(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal(result.codexRefreshRecommended, true);
  assert.equal(await missing(data.rolloutPath), true);
});

test('batch deletion uses one backup and removes all selected rows in one operation', async () => {
  const data = await fixture({ withRollout: true });
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionIds: [SESSION_ID, CHILD_ID],
    now: new Date('2026-07-30T13:00:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const preview = await previewSessionDeletionBatch(data.codexHome, options);
  assert.deepEqual(preview.summary, {
    sessions: 2,
    rolloutFiles: 1,
    sqliteRows: 2,
    indexRows: 2,
    metadataOnly: 1,
    childThreadsKept: 0,
    historicalBackupFiles: 0,
    backupOnlySessions: 0,
  });
  const result = await applySessionDeletionBatch(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal(result.deleted.sessions, 2);
  assert.equal(await missing(data.rolloutPath), true);
  assert.equal(await missing(result.backup.stateDbBackup), false);
  const db = new DatabaseSync(data.dbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS count FROM threads').get().count, 0);
  db.close();
  assert.equal((await readFile(path.join(data.codexHome, 'session_index.jsonl'), 'utf8')).trim(), '');
});

test('batch deletion proceeds while Codex is running and recommends a refresh', async () => {
  const data = await fixture({ withRollout: true });
  const codexProcessCheck = {
    available: true,
    processes: [{ pid: 1234, parentPid: 1000, name: 'codex.exe' }],
  };
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionIds: [SESSION_ID, CHILD_ID],
    now: new Date('2026-07-30T13:30:00Z'),
    codexProcessCheck,
  };
  const preview = await previewSessionDeletionBatch(data.codexHome, options);
  assert.equal(preview.canApply, true);
  assert.equal(preview.codexRunning, true);
  assert.equal(preview.blockedByRunningCodex, false);
  assert.equal(preview.refreshCodexAfterApply, true);
  const result = await applySessionDeletionBatch(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal(result.codexRefreshRecommended, true);
  const db = new DatabaseSync(data.dbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS count FROM threads').get().count, 0);
  db.close();
});

test('deletion-backup manager lists and permanently removes only validated backup directories', async () => {
  const data = await fixture({ withRollout: true });
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionId: SESSION_ID,
    now: new Date('2026-07-30T14:00:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const preview = await previewSessionDeletion(data.codexHome, options);
  const deletion = await applySessionDeletion(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  const listed = await listSessionDeletionBackups(data.codexHome, {
    backupRoot: data.backupRoot,
  });
  assert.equal(listed.summary.count, 1);
  assert.equal(listed.backups[0].sessions[0].id, SESSION_ID);
  assert.ok(listed.backups[0].sizeBytes > 0);

  const erased = await deleteSessionDeletionBackups(data.codexHome, {
    backupRoot: data.backupRoot,
    backupIds: [listed.backups[0].id],
  });
  assert.equal(erased.deletedCount, 1);
  assert.equal(await missing(deletion.backup.backupDir), true);
  await assert.rejects(
    deleteSessionDeletionBackups(data.codexHome, {
      backupRoot: data.backupRoot,
      backupIds: ['..'],
    }),
    (error) => ['INVALID_BACKUP_ID', 'BACKUP_NOT_FOUND'].includes(error?.code),
  );
});

test('deletion backup restores one session rollout, SQLite row, and legacy title safely', async () => {
  const data = await fixture({ withRollout: true });
  const baseOptions = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionId: SESSION_ID,
    now: new Date('2026-07-30T15:00:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const deletionPreview = await previewSessionDeletion(data.codexHome, baseOptions);
  const deletion = await applySessionDeletion(data.codexHome, {
    ...baseOptions,
    planToken: deletionPreview.planToken,
  });
  const backupId = path.basename(deletion.backup.backupDir);
  const restoreOptions = {
    backupRoot: data.backupRoot,
    env: data.env,
    backupId,
    sessionIds: [SESSION_ID],
    now: new Date('2026-07-30T15:05:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const restorePreview = await previewSessionDeletionBackupRestore(data.codexHome, restoreOptions);
  assert.deepEqual(restorePreview.summary, {
    sessions: 1,
    rolloutFiles: 1,
    sqliteRows: 1,
    indexRows: 1,
    conflicts: 0,
    alreadyPresent: 0,
  });
  assert.equal(restorePreview.sessions[0].title, 'Delete me');

  const restored = await applySessionDeletionBackupRestore(data.codexHome, {
    ...restoreOptions,
    planToken: restorePreview.planToken,
  });
  assert.equal(restored.restartRequired, true);
  assert.equal(await missing(data.rolloutPath), false);
  assert.equal(await missing(restored.safety.stateDbBackup), false);
  const first = JSON.parse((await readFile(data.rolloutPath, 'utf8')).split(/\r?\n/, 1)[0]);
  assert.equal(first.payload.model_provider, 'custom');
  const index = await readFile(path.join(data.codexHome, 'session_index.jsonl'), 'utf8');
  assert.equal(index.includes(SESSION_ID), true);
  assert.equal(index.includes('Delete me'), true);
  const db = new DatabaseSync(data.dbPath, { readOnly: true });
  const row = db.prepare('SELECT model_provider, rollout_path FROM threads WHERE id = ?').get(SESSION_ID);
  assert.equal(row.model_provider, 'custom');
  assert.equal(row.rollout_path, data.rolloutPath);
  db.close();
});

test('batch deletion backup can restore only one selected session', async () => {
  const data = await fixture({ withRollout: true });
  const deleteOptions = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionIds: [SESSION_ID, CHILD_ID],
    now: new Date('2026-07-30T16:00:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const deletionPreview = await previewSessionDeletionBatch(data.codexHome, deleteOptions);
  const deletion = await applySessionDeletionBatch(data.codexHome, {
    ...deleteOptions,
    planToken: deletionPreview.planToken,
  });
  const restoreOptions = {
    backupRoot: data.backupRoot,
    env: data.env,
    backupId: path.basename(deletion.backup.backupDir),
    sessionIds: [SESSION_ID],
    now: new Date('2026-07-30T16:05:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const preview = await previewSessionDeletionBackupRestore(data.codexHome, restoreOptions);
  const result = await applySessionDeletionBackupRestore(data.codexHome, {
    ...restoreOptions,
    planToken: preview.planToken,
  });
  assert.equal(result.restored.sessions, 1);
  const db = new DatabaseSync(data.dbPath, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS count FROM threads WHERE id = ?').get(SESSION_ID).count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM threads WHERE id = ?').get(CHILD_ID).count, 0);
  db.close();
  const index = await readFile(path.join(data.codexHome, 'session_index.jsonl'), 'utf8');
  assert.equal(index.includes(SESSION_ID), true);
  assert.equal(index.includes(CHILD_ID), false);
});

test('restore preview refuses to overwrite a different current rollout', async () => {
  const data = await fixture({ withRollout: true });
  const deleteOptions = {
    backupRoot: data.backupRoot,
    env: data.env,
    sessionId: SESSION_ID,
    now: new Date('2026-07-30T17:00:00Z'),
    codexProcessCheck: NO_CODEX_PROCESSES,
  };
  const deletionPreview = await previewSessionDeletion(data.codexHome, deleteOptions);
  const deletion = await applySessionDeletion(data.codexHome, {
    ...deleteOptions,
    planToken: deletionPreview.planToken,
  });
  await writeFile(data.rolloutPath, `${rollout()}${JSON.stringify({ type: 'different' })}\n`, 'utf8');
  const preview = await previewSessionDeletionBackupRestore(data.codexHome, {
    backupRoot: data.backupRoot,
    env: data.env,
    backupId: path.basename(deletion.backup.backupDir),
    sessionIds: [SESSION_ID],
    codexProcessCheck: NO_CODEX_PROCESSES,
  });
  assert.equal(preview.summary.conflicts, 1);
  assert.equal(preview.canApply, false);
});
