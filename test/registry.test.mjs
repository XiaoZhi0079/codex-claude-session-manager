import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  applyCodexVisibilityRepair,
  buildSessionRegistry,
  previewCodexVisibilityRepair,
} from '../src/registry.mjs';

const SESSION_ID = '019faa00-1111-7222-8333-444455556666';
const NO_CODEX_PROCESSES = {
  available: true,
  processes: [],
};

function rollout(provider = 'openai') {
  return [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: SESSION_ID,
        cwd: 'D:\\project',
        model_provider: provider,
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }),
    JSON.stringify({
      type: 'response_item',
      turn_id: 'turn-1',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1' },
    }),
  ].join('\n') + '\n';
}

async function fixture({ live = true, backup = false, indexedTitle = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-registry-'));
  const codexHome = path.join(root, '.codex');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '07', '01');
  const backupRoot = path.join(codexHome, 'backups', 'codex-claude-session-manager');
  const rolloutPath = path.join(
    sessionsDir,
    `rollout-2026-07-01T00-00-00-${SESSION_ID}.jsonl`,
  );
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  await writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "custom"\n', 'utf8');
  if (indexedTitle) {
    await writeFile(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({
      id: SESSION_ID,
      thread_name: indexedTitle,
      updated_at: '2026-07-01T00:00:00.000Z',
    })}\n`, 'utf8');
  }
  if (live) await writeFile(rolloutPath, rollout('openai'), 'utf8');
  if (backup) {
    const backupDir = path.join(backupRoot, 'older-backup');
    await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(backupDir, path.basename(rolloutPath)), rollout('openai'), 'utf8');
  }

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
  db.prepare(`
    INSERT INTO threads
      (id, title, rollout_path, archived, model_provider, updated_at, created_at, cwd, source)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).run(
    SESSION_ID,
    'Test thread',
    rolloutPath,
    'openai',
    Date.parse('2026-07-01T00:00:00Z'),
    Date.parse('2026-07-01T00:00:00Z'),
    'D:\\project',
    'cli',
  );
  db.close();

  if (live) {
    const old = new Date('2026-07-01T00:00:00Z');
    await utimes(rolloutPath, old, old);
  }
  return { root, codexHome, backupRoot, rolloutPath, dbPath };
}

test('registry discovers provider-hidden live sessions independently of config.toml', async () => {
  const data = await fixture({ live: true });
  const registry = await buildSessionRegistry(data.codexHome, {
    backupRoot: data.backupRoot,
  });
  const session = registry.sessions.find((item) => item.id === SESSION_ID);

  assert.equal(registry.currentProvider, 'custom');
  assert.equal(session.hasRollout, true);
  assert.equal(session.modelProvider, 'openai');
  assert.equal(session.sqliteProvider, 'openai');
  assert.equal(session.codexVisible, false);
  assert.equal(registry.summary.hiddenFromCodex, 1);
});

test('registry keeps the Codex index title instead of replacing it with the first user message', async () => {
  const data = await fixture({
    live: true,
    indexedTitle: 'Gallery 升级',
  });
  const registry = await buildSessionRegistry(data.codexHome, {
    backupRoot: data.backupRoot,
  });
  const session = registry.sessions.find((item) => item.id === SESSION_ID);

  assert.equal(session.title, 'Gallery 升级');
  assert.equal(session.indexed, true);
});

test('visibility repair backs up and normalizes rollout plus SQLite provider', async () => {
  const data = await fixture({ live: true });
  const now = new Date('2026-07-30T00:00:00Z');
  const preview = await previewCodexVisibilityRepair(data.codexHome, {
    backupRoot: data.backupRoot,
    now,
    codexProcessCheck: NO_CODEX_PROCESSES,
  });
  assert.equal(preview.summary.rolloutUpdates, 1);
  assert.equal(preview.summary.sqliteUpdates, 1);

  const result = await applyCodexVisibilityRepair(data.codexHome, {
    backupRoot: data.backupRoot,
    now,
    planToken: preview.planToken,
    codexProcessCheck: NO_CODEX_PROCESSES,
  });
  assert.equal(result.changedRollouts, 1);
  assert.equal(result.changedSqliteRows, 1);
  assert.ok((await stat(result.backup.stateDbBackup)).isFile());

  const first = JSON.parse((await readFile(data.rolloutPath, 'utf8')).split(/\r?\n/, 1)[0]);
  assert.equal(first.payload.model_provider, 'custom');
  const db = new DatabaseSync(data.dbPath, { readOnly: true });
  assert.equal(
    db.prepare('SELECT model_provider FROM threads WHERE id = ?').get(SESSION_ID).model_provider,
    'custom',
  );
  db.close();
});

test('visibility repair restores a missing rollout from a matching backup', async () => {
  const data = await fixture({ live: false, backup: true });
  const now = new Date('2026-07-30T00:00:00Z');
  const preview = await previewCodexVisibilityRepair(data.codexHome, {
    backupRoot: data.backupRoot,
    now,
    codexProcessCheck: NO_CODEX_PROCESSES,
  });
  assert.equal(preview.summary.restores, 1);

  const result = await applyCodexVisibilityRepair(data.codexHome, {
    backupRoot: data.backupRoot,
    now,
    planToken: preview.planToken,
    codexProcessCheck: NO_CODEX_PROCESSES,
  });
  assert.equal(result.restoredRollouts, 1);
  assert.ok((await stat(data.rolloutPath)).isFile());
  const first = JSON.parse((await readFile(data.rolloutPath, 'utf8')).split(/\r?\n/, 1)[0]);
  assert.equal(first.payload.model_provider, 'custom');
});

test('visibility repair refuses to write while Codex is running', async () => {
  const data = await fixture({ live: true });
  const now = new Date('2026-07-30T00:00:00Z');
  const codexProcessCheck = {
    available: true,
    processes: [{ pid: 1234, parentPid: 1000, name: 'codex.exe' }],
  };
  const preview = await previewCodexVisibilityRepair(data.codexHome, {
    backupRoot: data.backupRoot,
    now,
    codexProcessCheck,
  });

  assert.equal(preview.blockedByRunningCodex, true);
  assert.equal(preview.canApply, false);
  assert.equal(preview.summary.runningCodexProcesses, 1);
  assert.equal(preview.summary.rolloutUpdates, 1);

  await assert.rejects(
    applyCodexVisibilityRepair(data.codexHome, {
      backupRoot: data.backupRoot,
      now,
      planToken: preview.planToken,
      codexProcessCheck,
    }),
    (error) => error?.code === 'CODEX_STILL_RUNNING',
  );
});
