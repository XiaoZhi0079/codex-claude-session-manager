import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  applyCodexSessionImport,
  createCodexSessionPackage,
  previewCodexSessionImport,
  stageCodexSessionPackage,
  undoCodexSessionImport,
} from '../src/codex-session-transfer.mjs';
import { createCleanerServer } from '../src/server.mjs';

const sessionId = '019faa00-aaaa-7222-8333-444455556666';

function rolloutSource(cwd, provider = 'openai') {
  return `${[
    { timestamp: '2026-08-24T08:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd, model_provider: provider, source: 'cli' } },
    { timestamp: '2026-08-24T08:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-08-24T08:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue this work' }] } },
    { timestamp: '2026-08-24T08:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ].map(JSON.stringify).join('\n')}\n`;
}

function createStateDatabase(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    model_provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  )`);
  db.close();
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

test('Codex sessions export, verify project context, import, and roll back safely', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ccsm-transfer-'));
  const sourceHome = path.join(temp, 'source-codex');
  const targetHome = path.join(temp, 'target-codex');
  const sourceProject = path.join(temp, 'source-project');
  const targetProject = path.join(temp, 'target-project');
  const sourceRollout = path.join(sourceHome, 'sessions', '2026', '08', '24', `rollout-2026-08-24T08-00-00-${sessionId}.jsonl`);
  const targetDbPath = path.join(targetHome, 'state_5.sqlite');
  const transferRoot = path.join(temp, 'transfer-state');
  const backupRoot = path.join(targetHome, 'backups', 'codex-claude-session-manager');
  try {
    await Promise.all([
      mkdir(path.dirname(sourceRollout), { recursive: true }),
      mkdir(sourceProject, { recursive: true }),
      mkdir(targetProject, { recursive: true }),
      mkdir(targetHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(sourceProject, 'app.mjs'), 'export const answer = 42;\n'),
      writeFile(path.join(targetProject, 'app.mjs'), 'export const answer = 42;\n'),
      writeFile(sourceRollout, rolloutSource(sourceProject)),
    ]);
    createStateDatabase(targetDbPath);

    const exported = await createCodexSessionPackage(sourceHome, {
      sessionIds: [sessionId],
      transferRoot,
      env: {},
    });
    assert.equal(exported.sessionCount, 1);
    assert.equal(exported.content.subarray(0, 15).toString(), 'SQLite format 3');

    const staged = await stageCodexSessionPackage(exported.content, transferRoot);
    assert.equal(staged.sessions[0].id, sessionId);
    assert.equal(staged.projects[0].suggestedTargetPath, path.resolve(sourceProject));
    const importOptions = {
      transferRoot,
      backupRoot,
      transferId: staged.transferId,
      pathMappings: [{ sourcePath: sourceProject, targetPath: targetProject }],
      mode: 'resume',
      env: {},
      codexProcessCheck: { available: true, processes: [] },
    };
    const preview = await previewCodexSessionImport(targetHome, importOptions);
    assert.equal(preview.sessions[0].projectState, 'matched');
    assert.equal(preview.canApply, true);

    const applied = await applyCodexSessionImport(targetHome, { ...importOptions, planToken: preview.planToken });
    const targetRollout = applied.preview.sessions[0].rolloutTarget;
    const importedSource = await readFile(targetRollout, 'utf8');
    assert.equal(JSON.parse(importedSource.split(/\r?\n/)[0]).payload.cwd, targetProject);
    const db = new DatabaseSync(targetDbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT id, cwd, model_provider FROM threads WHERE id = ?').get(sessionId);
      assert.equal(row.cwd, targetProject);
      assert.equal(row.model_provider, 'openai');
    } finally { db.close(); }

    const repeated = await previewCodexSessionImport(targetHome, importOptions);
    assert.equal(repeated.sessions[0].action, 'already_present');
    assert.equal(repeated.summary.alreadyPresent, 1);

    const undone = await undoCodexSessionImport(targetHome, {
      backupRoot,
      manifestPath: applied.manifestPath,
      codexProcessCheck: { available: true, processes: [] },
    });
    assert.deepEqual(undone.removedSessionIds, [sessionId]);
    await assert.rejects(readFile(targetRollout), { code: 'ENOENT' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('resume import is blocked when project files differ, while history import remains available', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ccsm-transfer-mismatch-'));
  const sourceHome = path.join(temp, 'source-codex');
  const targetHome = path.join(temp, 'target-codex');
  const sourceProject = path.join(temp, 'source-project');
  const targetProject = path.join(temp, 'target-project');
  const sourceRollout = path.join(sourceHome, 'sessions', '2026', '08', '24', `rollout-${sessionId}.jsonl`);
  const transferRoot = path.join(temp, 'transfers');
  try {
    await Promise.all([mkdir(path.dirname(sourceRollout), { recursive: true }), mkdir(sourceProject), mkdir(targetProject), mkdir(targetHome)]);
    await Promise.all([
      writeFile(path.join(sourceProject, 'app.mjs'), 'source\n'),
      writeFile(path.join(targetProject, 'app.mjs'), 'different\n'),
      writeFile(sourceRollout, rolloutSource(sourceProject)),
    ]);
    const exported = await createCodexSessionPackage(sourceHome, { sessionIds: [sessionId], transferRoot, env: {} });
    const staged = await stageCodexSessionPackage(exported.content, transferRoot);
    const base = { transferRoot, transferId: staged.transferId, pathMappings: [{ sourcePath: sourceProject, targetPath: targetProject }], env: {} };
    const unmapped = await previewCodexSessionImport(targetHome, { ...base, pathMappings: [], mode: 'resume' });
    assert.equal(unmapped.summary.projectMappingsRequired, 1);
    assert.equal(unmapped.summary.projectContentMismatches, 0);
    const resume = await previewCodexSessionImport(targetHome, { ...base, mode: 'resume' });
    assert.equal(resume.sessions[0].projectState, 'mismatch');
    assert.equal(resume.summary.projectMappingsRequired, 0);
    assert.equal(resume.summary.projectContentMismatches, 1);
    assert.equal(resume.canApply, false);
    const history = await previewCodexSessionImport(targetHome, { ...base, mode: 'history' });
    assert.equal(history.canApply, true);
    await applyCodexSessionImport(targetHome, {
      ...base,
      mode: 'history',
      planToken: history.planToken,
      backupRoot: path.join(targetHome, 'backups'),
    });
    await writeFile(path.join(targetProject, 'app.mjs'), 'source\n');
    createStateDatabase(path.join(targetHome, 'state_5.sqlite'));
    const promotion = await previewCodexSessionImport(targetHome, { ...base, mode: 'resume' });
    assert.equal(promotion.sessions[0].action, 'activate');
    assert.equal(promotion.canApply, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('session-transfer REST endpoints download binary packages and accept raw uploads', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ccsm-transfer-api-'));
  const sourceHome = path.join(temp, 'source-codex');
  const targetHome = path.join(temp, 'target-codex');
  const sourceProject = path.join(temp, 'source-project');
  const targetProject = path.join(temp, 'target-project');
  const rollout = path.join(sourceHome, 'sessions', '2026', '08', '24', `rollout-${sessionId}.jsonl`);
  let sourceServer;
  let targetServer;
  try {
    await Promise.all([mkdir(path.dirname(rollout), { recursive: true }), mkdir(sourceProject), mkdir(targetProject), mkdir(targetHome)]);
    await Promise.all([
      writeFile(path.join(sourceProject, 'main.txt'), 'same project\n'),
      writeFile(path.join(targetProject, 'main.txt'), 'same project\n'),
      writeFile(rollout, rolloutSource(sourceProject)),
    ]);
    createStateDatabase(path.join(targetHome, 'state_5.sqlite'));
    sourceServer = createCleanerServer({ codexHome: sourceHome, backupRoot: path.join(temp, 'source-backups'), env: {} });
    const sourceUrl = await listen(sourceServer);
    const download = await fetch(`${sourceUrl}/api/codex-session-transfer/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionIds: [sessionId] }),
    });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /\.ccsm/);
    const bundle = Buffer.from(await download.arrayBuffer());
    await close(sourceServer);

    targetServer = createCleanerServer({ codexHome: targetHome, backupRoot: path.join(temp, 'target-backups'), env: {}, codexProcessCheck: { available: true, processes: [] } });
    const targetUrl = await listen(targetServer);
    const upload = await fetch(`${targetUrl}/api/codex-session-transfer/import-upload`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bundle,
    });
    assert.equal(upload.status, 201);
    const staged = await upload.json();
    const previewResponse = await fetch(`${targetUrl}/api/codex-session-transfer/import-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transferId: staged.transferId, mode: 'resume', pathMappings: [{ sourcePath: sourceProject, targetPath: targetProject }] }),
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200, JSON.stringify(preview));
    assert.equal(preview.canApply, true);
    const applyResponse = await fetch(`${targetUrl}/api/codex-session-transfer/import-apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transferId: staged.transferId,
        mode: 'resume',
        pathMappings: [{ sourcePath: sourceProject, targetPath: targetProject }],
        planToken: preview.planToken,
        confirmation: 'IMPORT',
      }),
    });
    const applied = await applyResponse.json();
    assert.equal(applyResponse.status, 200, JSON.stringify(applied));
    const history = await (await fetch(`${targetUrl}/api/operation-history?limit=5`)).json();
    assert.equal(history.latest.kind, 'codex_session_import');
    assert.equal(history.latest.canUndo, true);
    assert.equal(history.latest.details.sessionTitles[sessionId], 'continue this work');
    const undoResponse = await fetch(`${targetUrl}/api/operation-history/undo`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: history.latest.id, confirmation: 'UNDO' }),
    });
    assert.equal(undoResponse.status, 200, await undoResponse.text());
  } finally {
    await close(sourceServer);
    await close(targetServer);
    await rm(temp, { recursive: true, force: true });
  }
});

test('Windows extended-length rollout paths remain exportable inside CODEX_HOME', { skip: process.platform !== 'win32' }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ccsm-transfer-extended-path-'));
  const codexHome = path.join(temp, '.codex');
  const project = path.join(temp, 'project');
  const rollout = path.join(codexHome, 'sessions', '2026', '08', '24', `rollout-${sessionId}.jsonl`);
  try {
    await Promise.all([mkdir(path.dirname(rollout), { recursive: true }), mkdir(project)]);
    await Promise.all([writeFile(path.join(project, 'main.txt'), 'extended path\n'), writeFile(rollout, rolloutSource(project))]);
    const dbPath = path.join(codexHome, 'state_5.sqlite');
    createStateDatabase(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, archived)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
        sessionId,
        `\\\\?\\${rollout}`,
        1,
        1,
        'cli',
        'openai',
        project,
        'extended path session',
      );
    } finally { db.close(); }
    const bundle = await createCodexSessionPackage(codexHome, {
      sessionIds: [sessionId],
      transferRoot: path.join(temp, 'transfers'),
      env: {},
    });
    assert.equal(bundle.sessionCount, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
