import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  applyClaudeProjectPathMigration,
  applyCodexProjectPathMigration,
  encodeClaudeProjectPath,
  previewClaudeProjectPathMigration,
  previewCodexProjectPathMigration,
  restoreProjectPathMigration,
} from '../src/project-path-migration.mjs';
import { createCleanerServer } from '../src/server.mjs';

const SESSION_ID = '019ffa19-722f-7e90-9551-73c4eab11871';

test('Codex project path migration updates rollout, SQLite and index and can be restored', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-project-path-'));
  const codexHome = path.join(root, '.codex');
  const oldProject = path.join(root, 'old-project');
  const newProject = path.join(root, 'new-project');
  const rolloutDir = path.join(codexHome, 'sessions', '2026', '08', '19');
  const rolloutPath = path.join(rolloutDir, `rollout-${SESSION_ID}.jsonl`);
  const backupRoot = path.join(codexHome, 'backups', 'test');
  await Promise.all([mkdir(rolloutDir, { recursive: true }), mkdir(newProject, { recursive: true })]);
  await writeFile(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: SESSION_ID, cwd: oldProject, model_provider: 'openai' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } })}\n`, 'utf8');
  await writeFile(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id: SESSION_ID, cwd: oldProject, title: '迁移测试' })}\n`, 'utf8');
  const dbPath = path.join(codexHome, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, rollout_path TEXT, archived INTEGER, model_provider TEXT, updated_at INTEGER, created_at INTEGER, cwd TEXT, source TEXT)');
  db.prepare('INSERT INTO threads (id, title, rollout_path, archived, model_provider, cwd) VALUES (?, ?, ?, 0, ?, ?)').run(SESSION_ID, '迁移测试', rolloutPath, 'openai', oldProject);
  db.close();

  const preview = await previewCodexProjectPathMigration(codexHome, { fromPath: oldProject, toPath: newProject, backupRoot, codexProcessCheck: { available: true, processes: [] } });
  assert.deepEqual(preview.summary, { sessions: 1, rolloutFiles: 1, sqliteRows: 1, indexRows: 1 });
  const blocked = await previewCodexProjectPathMigration(codexHome, { fromPath: oldProject, toPath: newProject, backupRoot, codexProcessCheck: { available: true, processes: [{ pid: 1234 }] } });
  assert.equal(blocked.blockedByRunningCodex, true);
  assert.equal(blocked.canApply, false);
  const applied = await applyCodexProjectPathMigration(codexHome, { fromPath: oldProject, toPath: newProject, backupRoot, planToken: preview.planToken, codexProcessCheck: { available: true, processes: [] } });
  assert.equal(JSON.parse((await readFile(rolloutPath, 'utf8')).split(/\r?\n/)[0]).payload.cwd, newProject);
  const changedDb = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(changedDb.prepare('SELECT cwd FROM threads WHERE id = ?').get(SESSION_ID).cwd, newProject);
  changedDb.close();

  await restoreProjectPathMigration('codex', codexHome, { backupRoot, backupDir: applied.backup.backupDir });
  assert.equal(JSON.parse((await readFile(rolloutPath, 'utf8')).split(/\r?\n/)[0]).payload.cwd, oldProject);
  const restoredDb = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(restoredDb.prepare('SELECT cwd FROM threads WHERE id = ?').get(SESSION_ID).cwd, oldProject);
  restoredDb.close();
});

test('Claude project path migration moves session storage, rewrites cwd and can be restored', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-project-path-'));
  const claudeHome = path.join(root, '.claude');
  const oldProject = path.join(root, 'old-project');
  const newProject = path.join(root, 'new-project');
  const oldKey = encodeClaudeProjectPath(oldProject);
  const newKey = encodeClaudeProjectPath(newProject);
  const oldStorage = path.join(claudeHome, 'projects', oldKey);
  const newStorage = path.join(claudeHome, 'projects', newKey);
  const oldFile = path.join(oldStorage, `${SESSION_ID}.jsonl`);
  const newFile = path.join(newStorage, `${SESSION_ID}.jsonl`);
  const backupRoot = path.join(claudeHome, 'backups', 'test');
  await Promise.all([mkdir(path.join(oldStorage, SESSION_ID), { recursive: true }), mkdir(newProject, { recursive: true })]);
  await writeFile(oldFile, `${JSON.stringify({ type: 'user', uuid: 'u1', cwd: oldProject, message: { role: 'user', content: 'hello' } })}\n${JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })}\n`, 'utf8');
  await writeFile(path.join(oldStorage, SESSION_ID, 'tool.txt'), 'sidecar', 'utf8');
  await writeFile(path.join(oldStorage, 'sessions-index.json'), `${JSON.stringify({ version: 1, originalPath: oldProject, entries: [{ sessionId: SESSION_ID, summary: '迁移测试', projectPath: oldProject }] }, null, 2)}\n`, 'utf8');

  const preview = await previewClaudeProjectPathMigration(claudeHome, { fromPath: oldProject, toPath: newProject, backupRoot });
  assert.equal(preview.summary.sessions, 1);
  assert.equal(preview.conflicts.length, 0);
  const applied = await applyClaudeProjectPathMigration(claudeHome, { fromPath: oldProject, toPath: newProject, backupRoot, planToken: preview.planToken });
  assert.equal(JSON.parse((await readFile(newFile, 'utf8')).split(/\r?\n/)[0]).cwd, newProject);
  assert.equal(await readFile(path.join(newStorage, SESSION_ID, 'tool.txt'), 'utf8'), 'sidecar');
  const targetIndex = JSON.parse(await readFile(path.join(newStorage, 'sessions-index.json'), 'utf8'));
  assert.equal(targetIndex.originalPath, newProject);
  assert.equal(targetIndex.entries[0].projectPath, newProject);

  await restoreProjectPathMigration('claude', claudeHome, { backupRoot, backupDir: applied.backup.backupDir });
  assert.equal(JSON.parse((await readFile(oldFile, 'utf8')).split(/\r?\n/)[0]).cwd, oldProject);
  assert.equal(await readFile(path.join(oldStorage, SESSION_ID, 'tool.txt'), 'utf8'), 'sidecar');

  const manifestPath = path.join(applied.backup.backupDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files[0].path = path.join(root, 'outside.jsonl');
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  await assert.rejects(
    restoreProjectPathMigration('claude', claudeHome, { backupRoot, backupDir: applied.backup.backupDir }),
    (error) => error.code === 'UNSAFE_PROJECT_PATH_BACKUP',
  );
});

test('project path migration REST API records a reversible Claude operation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-path-api-'));
  const claudeHome = path.join(root, '.claude');
  const codexHome = path.join(root, '.codex');
  const oldProject = path.join(root, 'old-project');
  const newProject = path.join(root, 'new-project');
  const oldStorage = path.join(claudeHome, 'projects', encodeClaudeProjectPath(oldProject));
  const oldFile = path.join(oldStorage, `${SESSION_ID}.jsonl`);
  await Promise.all([mkdir(oldStorage, { recursive: true }), mkdir(newProject, { recursive: true })]);
  await writeFile(oldFile, `${JSON.stringify({ type: 'user', uuid: 'u1', cwd: oldProject, message: { role: 'user', content: 'hello' } })}\n`, 'utf8');
  const server = createCleanerServer({
    claudeHome,
    codexHome,
    backupRoot: path.join(root, 'operation-history'),
    claudeTurnBackupRoot: path.join(root, 'claude-migrations'),
    env: {},
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const post = async (pathname, body) => {
      const response = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await response.json();
      assert.equal(response.ok, true, JSON.stringify(payload));
      return payload;
    };
    const preview = await post('/api/project-path-migrations/preview', { platform: 'claude', fromPath: oldProject, toPath: newProject });
    assert.equal(preview.summary.sessions, 1);
    await post('/api/project-path-migrations/apply', { platform: 'claude', fromPath: oldProject, toPath: newProject, planToken: preview.planToken, confirmation: 'MIGRATE' });
    const history = await (await fetch(`${baseUrl}/api/operation-history`)).json();
    assert.equal(history.latest.kind, 'claude_project_path_migration');
    assert.equal(history.latest.canUndo, true);
    await post('/api/operation-history/undo-latest', { operationId: history.latest.id, confirmation: 'UNDO' });
    assert.equal(JSON.parse((await readFile(oldFile, 'utf8')).trim()).cwd, oldProject);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
