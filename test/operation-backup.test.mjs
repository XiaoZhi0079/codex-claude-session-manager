import assert from 'node:assert/strict';
import { access, copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  applyOperationBackupRestore,
  applyVisibilityBackupRestore,
  deleteOperationBackups,
  deleteSystemBackups,
  listOperationBackups,
  listSystemBackups,
  previewOperationBackupRestore,
  previewVisibilityBackupRestore,
  readOperationBackupContent,
} from '../src/operation-backup.mjs';

const SESSION_ID = '019fabcd-1111-7222-8333-444455556666';
const NO_CODEX_PROCESSES = { available: true, processes: [] };
const RUNNING_CODEX_PROCESSES = { available: true, processes: [{ pid: 4242, name: 'codex' }] };

function rollout(provider = 'old-provider') {
  return [
    JSON.stringify({
      timestamp: '2026-07-24T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: SESSION_ID,
        timestamp: '2026-07-24T00:00:00.000Z',
        cwd: 'D:\\project',
        model_provider: provider,
        source: 'cli',
        thread_source: 'user',
        cli_version: '0.144.1',
      },
    }),
    JSON.stringify({
      timestamp: '2026-07-24T00:01:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Restore this session' }],
      },
    }),
  ].join('\n') + '\n';
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-operation-backup-'));
  const codexHome = path.join(root, '.codex');
  const backupRoot = path.join(codexHome, 'backups', 'codex-turn-cleaner');
  const backupDir = path.join(backupRoot, 'codex-turn-cleaner-2026-07-24-010203004');
  const fileName = `rollout-2026-07-24T00-00-00-${SESSION_ID}.jsonl`;
  const backupPath = path.join(backupDir, fileName);
  const rolloutPath = path.join(codexHome, 'sessions', '2026', '07', '24', fileName);
  await mkdir(backupDir, { recursive: true });
  await writeFile(backupPath, rollout(), 'utf8');
  await writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "custom"\n', 'utf8');
  const dbPath = path.join(codexHome, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      memory_mode TEXT NOT NULL DEFAULT 'enabled',
      preview TEXT NOT NULL DEFAULT '',
      recency_at INTEGER NOT NULL DEFAULT 0,
      recency_at_ms INTEGER NOT NULL DEFAULT 0,
      history_mode TEXT NOT NULL DEFAULT 'legacy',
      is_pinned INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.close();
  return {
    root,
    codexHome,
    backupRoot,
    backupDir,
    backupPath,
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

test('operation snapshot listing and restore recreate rollout, SQLite row, and index', async () => {
  const data = await fixture();
  const listed = await listOperationBackups(data.codexHome, { backupRoot: data.backupRoot });
  assert.equal(listed.summary.count, 1);
  assert.equal(listed.backups[0].kind, 'turn_cleanup');
  assert.equal(listed.backups[0].sessionId, SESSION_ID);

  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    backupId: listed.backups[0].id,
    codexProcessCheck: NO_CODEX_PROCESSES,
    now: new Date('2026-07-30T12:00:00Z'),
  };
  const preview = await previewOperationBackupRestore(data.codexHome, options);
  const backupContent = await readOperationBackupContent(data.codexHome, options);
  assert.equal(backupContent.comparison.state, 'missing');
  assert.equal(backupContent.content.messageCount, 1);
  assert.equal(backupContent.content.messages[0].text, 'Restore this session');
  assert.deepEqual(preview.actions, { rollout: 'restore', sqlite: 'insert', index: 'insert' });
  assert.equal(preview.canApply, true);

  const restored = await applyOperationBackupRestore(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal(restored.restartRequired, true);
  assert.equal(await missing(data.rolloutPath), false);
  assert.equal(await missing(restored.safety.stateDbBackup), false);
  const first = JSON.parse((await readFile(data.rolloutPath, 'utf8')).split(/\r?\n/, 1)[0]);
  assert.equal(first.payload.model_provider, 'custom');
  const db = new DatabaseSync(data.dbPath, { readOnly: true });
  const row = db.prepare('SELECT rollout_path, model_provider, title FROM threads WHERE id = ?').get(SESSION_ID);
  db.close();
  assert.equal(row.rollout_path, data.rolloutPath);
  assert.equal(row.model_provider, 'custom');
  assert.equal(row.title, 'Restore this session');
  const index = await readFile(path.join(data.codexHome, 'session_index.jsonl'), 'utf8');
  assert.equal(index.includes(SESSION_ID), true);
  assert.equal(index.includes('Restore this session'), true);
});

test('operation snapshot restore safely replaces a different current rollout', async () => {
  const data = await fixture();
  await mkdir(path.dirname(data.rolloutPath), { recursive: true });
  await writeFile(data.rolloutPath, rollout('custom') + `${JSON.stringify({ type: 'different' })}\n`, 'utf8');
  const db = new DatabaseSync(data.dbPath);
  db.prepare(`
    INSERT INTO threads
      (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode)
    VALUES (?, ?, 1, 1, 'cli', 'custom', 'D:\\project', 'Current', '{}', 'never')
  `).run(SESSION_ID, data.rolloutPath);
  db.close();
  await writeFile(
    path.join(data.codexHome, 'session_index.jsonl'),
    `${JSON.stringify({ id: SESSION_ID, thread_name: 'Current' })}\n`,
    'utf8',
  );
  const listed = await listOperationBackups(data.codexHome, { backupRoot: data.backupRoot });
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    backupId: listed.backups[0].id,
    codexProcessCheck: NO_CODEX_PROCESSES,
    now: new Date('2026-07-30T13:00:00Z'),
  };
  const preview = await previewOperationBackupRestore(data.codexHome, options);
  assert.equal(preview.actions.rollout, 'replace');
  const result = await applyOperationBackupRestore(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal((await readFile(data.rolloutPath, 'utf8')).includes('different'), false);
  assert.equal((await readFile(result.safety.rolloutBackup, 'utf8')).includes('different'), true);
});

test('operation snapshot restore proceeds while Codex is running and recommends a refresh', async () => {
  const data = await fixture();
  const listed = await listOperationBackups(data.codexHome, { backupRoot: data.backupRoot });
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    backupId: listed.backups[0].id,
    codexProcessCheck: RUNNING_CODEX_PROCESSES,
    now: new Date('2026-07-30T13:30:00Z'),
  };
  const preview = await previewOperationBackupRestore(data.codexHome, options);
  assert.equal(preview.codexRunning, true);
  assert.equal(preview.blockedByRunningCodex, false);
  assert.equal(preview.canApply, true);

  const result = await applyOperationBackupRestore(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  assert.equal(result.codexRefreshRecommended, true);
  assert.equal(await missing(data.rolloutPath), false);
});

test('operation snapshots can be permanently deleted without recursive broad deletion', async () => {
  const data = await fixture();
  const listed = await listOperationBackups(data.codexHome, { backupRoot: data.backupRoot });
  const result = await deleteOperationBackups(data.codexHome, {
    backupRoot: data.backupRoot,
    backupIds: [listed.backups[0].id],
  });
  assert.equal(result.summary.count, 1);
  assert.equal(await missing(data.backupPath), true);
  assert.equal(await missing(data.backupDir), true);
  assert.equal(await missing(data.backupRoot), false);
});

test('system backup cleanup only removes validated backup directories', async () => {
  const data = await fixture();
  const visibilityDir = path.join(data.backupRoot, 'codex-visibility-sync-2026-07-30-010203004');
  const emptySnapshotDir = path.join(data.backupRoot, 'codex-turn-cleaner-2026-07-20-010203004');
  await mkdir(visibilityDir, { recursive: true });
  await mkdir(emptySnapshotDir, { recursive: true });
  await writeFile(path.join(visibilityDir, 'manifest.json'), '{}', 'utf8');
  const listed = await listSystemBackups(data.codexHome, { backupRoot: data.backupRoot });
  assert.equal(listed.summary.count, 2);
  const result = await deleteSystemBackups(data.codexHome, {
    backupRoot: data.backupRoot,
    backupIds: listed.backups.map((backup) => backup.id),
  });
  assert.equal(result.summary.count, 2);
  assert.equal(await missing(visibilityDir), true);
  assert.equal(await missing(emptySnapshotDir), true);
  assert.equal(await missing(data.backupPath), false);
  assert.equal(await missing(data.backupRoot), false);
});

test('visibility backup restore changes only provider fields and creates a safety point', async () => {
  const data = await fixture();
  await mkdir(path.dirname(data.rolloutPath), { recursive: true });
  await writeFile(data.rolloutPath, rollout('custom'), 'utf8');
  const db = new DatabaseSync(data.dbPath);
  db.prepare(`
    INSERT INTO threads
      (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode)
    VALUES (?, ?, 1, 1, 'cli', 'old-provider', 'D:\\project', 'Current', '{}', 'never')
  `).run(SESSION_ID, data.rolloutPath);
  db.close();

  const visibilityDir = path.join(data.backupRoot, 'codex-visibility-sync-2026-07-30-010203004');
  const jsonlDir = path.join(visibilityDir, 'jsonl');
  const stateDir = path.join(visibilityDir, 'state');
  await mkdir(jsonlDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const rolloutBackup = path.join(jsonlDir, `${SESSION_ID}-${path.basename(data.rolloutPath)}`);
  const stateBackup = path.join(stateDir, 'state_5.sqlite');
  await writeFile(rolloutBackup, rollout('old-provider'), 'utf8');
  await copyFile(data.dbPath, stateBackup);
  const currentDb = new DatabaseSync(data.dbPath);
  currentDb.prepare('UPDATE threads SET model_provider = ? WHERE id = ?').run('custom', SESSION_ID);
  const laterMessage = JSON.stringify({
    timestamp: '2026-08-02T09:00:00.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'A message created after visibility repair' }],
    },
  });
  await writeFile(data.rolloutPath, `${await readFile(data.rolloutPath, 'utf8')}${laterMessage}\n`, 'utf8');
  const laterSessionId = '019fabcd-7777-7222-8333-444455556666';
  currentDb.prepare(`
    INSERT INTO threads
      (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode)
    VALUES (?, ?, 2, 2, 'cli', 'custom', 'D:\\project', 'Later session', '{}', 'never')
  `).run(laterSessionId, path.join(data.codexHome, 'sessions', 'later.jsonl'));
  currentDb.close();
  await writeFile(path.join(visibilityDir, 'manifest.json'), JSON.stringify({
    version: 2,
    kind: 'visibility-sync',
    createdAt: '2026-07-30T01:02:03.004Z',
    targetProvider: 'custom',
    stateDbPath: data.dbPath,
    stateDbBackup: stateBackup,
    rolloutBackups: [{
      id: SESSION_ID,
      source: data.rolloutPath,
      backup: rolloutBackup,
      fromProvider: 'old-provider',
    }],
    sqliteProviderBackups: [{ id: SESSION_ID, fromProvider: 'old-provider' }],
  }, null, 2), 'utf8');
  const listed = await listSystemBackups(data.codexHome, { backupRoot: data.backupRoot });
  const backup = listed.backups.find((item) => item.type === 'visibility_sync');
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    backupId: backup.id,
    codexProcessCheck: NO_CODEX_PROCESSES,
    now: new Date('2026-07-30T14:00:00Z'),
  };
  const preview = await previewVisibilityBackupRestore(data.codexHome, options);
  assert.equal(preview.rolloutUpdates.length, 1);
  assert.equal(preview.sqliteUpdates.length, 1);
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.canApply, true);
  const restored = await applyVisibilityBackupRestore(data.codexHome, {
    ...options,
    planToken: preview.planToken,
  });
  const first = JSON.parse((await readFile(data.rolloutPath, 'utf8')).split(/\r?\n/, 1)[0]);
  const restoredSource = await readFile(data.rolloutPath, 'utf8');
  assert.equal(first.payload.model_provider, 'old-provider');
  assert.equal(restoredSource.includes('A message created after visibility repair'), true);
  const restoredDb = new DatabaseSync(data.dbPath, { readOnly: true });
  assert.equal(restoredDb.prepare('SELECT model_provider FROM threads WHERE id = ?').get(SESSION_ID).model_provider, 'old-provider');
  assert.equal(restoredDb.prepare('SELECT model_provider FROM threads WHERE id = ?').get(laterSessionId).model_provider, 'custom');
  restoredDb.close();
  assert.equal(await missing(restored.safety.stateDbBackup), false);
});

test('visibility backup restore keeps a rollout recreated by repair and rolls back only its provider metadata', async () => {
  const data = await fixture();
  await mkdir(path.dirname(data.rolloutPath), { recursive: true });
  const appended = `${rollout('custom')}${JSON.stringify({
    timestamp: '2026-08-03T09:00:00.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep this later message' }] },
  })}\n`;
  await writeFile(data.rolloutPath, appended, 'utf8');
  const db = new DatabaseSync(data.dbPath);
  db.prepare(`
    INSERT INTO threads
      (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode)
    VALUES (?, ?, 1, 1, 'cli', 'custom', 'D:\\project', 'Recreated', '{}', 'never')
  `).run(SESSION_ID, data.rolloutPath);
  db.close();

  const visibilityDir = path.join(data.backupRoot, 'codex-visibility-sync-2026-07-30-010203004');
  const stateDir = path.join(visibilityDir, 'state');
  await mkdir(stateDir, { recursive: true });
  const stateBackup = path.join(stateDir, 'state_5.sqlite');
  await copyFile(data.dbPath, stateBackup);
  const backupDb = new DatabaseSync(stateBackup);
  backupDb.prepare('UPDATE threads SET model_provider = ? WHERE id = ?').run('old-provider', SESSION_ID);
  backupDb.close();
  await writeFile(path.join(visibilityDir, 'manifest.json'), JSON.stringify({
    version: 2,
    kind: 'visibility-sync',
    createdAt: '2026-07-30T01:02:03.004Z',
    targetProvider: 'custom',
    stateDbPath: data.dbPath,
    stateDbBackup: stateBackup,
    rolloutBackups: [],
    sqliteProviderBackups: [{ id: SESSION_ID, fromProvider: 'old-provider' }],
    restores: [{
      id: SESSION_ID,
      sourcePath: path.join(data.backupRoot, 'old-source.jsonl'),
      targetPath: data.rolloutPath,
      fromProvider: 'old-provider',
    }],
  }, null, 2), 'utf8');

  const listed = await listSystemBackups(data.codexHome, { backupRoot: data.backupRoot });
  const backup = listed.backups.find((item) => item.type === 'visibility_sync');
  const options = {
    backupRoot: data.backupRoot,
    env: data.env,
    backupId: backup.id,
    codexProcessCheck: NO_CODEX_PROCESSES,
    now: new Date('2026-08-04T14:00:00Z'),
  };
  const preview = await previewVisibilityBackupRestore(data.codexHome, options);
  assert.equal(preview.rolloutUpdates.length, 1);
  assert.equal(preview.rolloutUpdates[0].restoredByRepair, true);
  assert.equal(preview.canApply, true);

  await applyVisibilityBackupRestore(data.codexHome, { ...options, planToken: preview.planToken });
  const restoredSource = await readFile(data.rolloutPath, 'utf8');
  assert.equal(JSON.parse(restoredSource.split(/\r?\n/, 1)[0]).payload.model_provider, 'old-provider');
  assert.equal(restoredSource.includes('Keep this later message'), true);
});
