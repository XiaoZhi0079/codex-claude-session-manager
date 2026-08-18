import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyClaudeSessionDeletion,
  applyClaudeSessionDeletionBackupRestore,
  deleteClaudeSessionDeletionBackups,
  listClaudeSessionDeletionBackups,
  previewClaudeSessionDeletion,
  previewClaudeSessionDeletionBackupRestore,
  readClaudeSessionDeletionBackupContent,
} from '../src/claude-session-delete.mjs';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

function rollout(id, prompt) {
  return `${JSON.stringify({ type: 'user', uuid: `${id}-user`, cwd: 'D:\\Work\\Demo', message: { role: 'user', content: prompt } })}\n${JSON.stringify({ type: 'assistant', uuid: `${id}-assistant`, message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } })}\n`;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-delete-'));
  const claudeHome = path.join(root, '.claude');
  const backupRoot = path.join(claudeHome, 'backups', 'test-deleted-sessions');
  const projectDir = path.join(claudeHome, 'projects', 'D--Work-Demo');
  await mkdir(projectDir, { recursive: true });
  for (const [id, title] of [[FIRST_ID, '第一会话'], [SECOND_ID, '第二会话']]) {
    await writeFile(path.join(projectDir, `${id}.jsonl`), rollout(id, title), 'utf8');
  }
  await mkdir(path.join(projectDir, FIRST_ID, 'tool-results'), { recursive: true });
  await writeFile(path.join(projectDir, FIRST_ID, 'tool-results', 'large.txt'), '完整输出', 'utf8');
  for (const rootName of ['tasks', 'file-history', 'session-env']) {
    const target = path.join(claudeHome, rootName, FIRST_ID);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'data.json'), JSON.stringify({ sessionId: FIRST_ID, rootName }), 'utf8');
  }
  await writeFile(path.join(projectDir, 'sessions-index.json'), JSON.stringify({
    version: 1,
    originalPath: 'D:\\Work\\Demo',
    entries: [
      { sessionId: FIRST_ID, summary: '第一会话', projectPath: 'D:\\Work\\Demo' },
      { sessionId: SECOND_ID, summary: '第二会话', projectPath: 'D:\\Work\\Demo' },
    ],
  }), 'utf8');
  return { root, claudeHome, backupRoot, projectDir };
}

async function exists(target) {
  try { await readFile(target); return true; } catch (error) { if (error?.code === 'EISDIR') return true; if (error?.code === 'ENOENT') return false; throw error; }
}

test('Claude deletion backs up the complete session package and safely restores it', async () => {
  const fixture = await createFixture();
  try {
    const preview = await previewClaudeSessionDeletion(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      sessionId: FIRST_ID,
    });
    assert.equal(preview.canApply, true);
    assert.equal(preview.summary.sessions, 1);
    assert.equal(preview.summary.mainFiles, 1);
    assert.equal(preview.summary.artifactDirectories, 4);
    assert.equal(preview.summary.artifactFiles, 5);
    assert.equal(preview.summary.indexRows, 1);

    const deleted = await applyClaudeSessionDeletion(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      sessionId: FIRST_ID,
      planToken: preview.planToken,
      now: '2026-08-05T10:00:00.000Z',
    });
    assert.equal(deleted.deleted.sessions, 1);
    assert.equal(await exists(path.join(fixture.projectDir, `${FIRST_ID}.jsonl`)), false);
    assert.equal(await exists(path.join(fixture.projectDir, `${SECOND_ID}.jsonl`)), true);
    assert.equal(await exists(path.join(fixture.projectDir, FIRST_ID)), false);
    assert.equal(await exists(path.join(fixture.claudeHome, 'tasks', FIRST_ID)), false);
    const indexAfterDelete = JSON.parse(await readFile(path.join(fixture.projectDir, 'sessions-index.json'), 'utf8'));
    assert.deepEqual(indexAfterDelete.entries.map((entry) => entry.sessionId), [SECOND_ID]);

    const listed = await listClaudeSessionDeletionBackups(fixture.claudeHome, { backupRoot: fixture.backupRoot });
    assert.equal(listed.backups.length, 1);
    assert.equal(listed.backups[0].sessions[0].id, FIRST_ID);
    const backupContent = await readClaudeSessionDeletionBackupContent(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      backupId: listed.backups[0].id,
      sessionId: FIRST_ID,
    });
    assert.equal(backupContent.comparison.state, 'missing');
    assert.equal(backupContent.content.messageCount, 2);
    assert.equal(backupContent.content.messages[0].text, '第一会话');
    const restorePreview = await previewClaudeSessionDeletionBackupRestore(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      backupId: listed.backups[0].id,
      sessionIds: [FIRST_ID],
    });
    assert.equal(restorePreview.summary.conflicts, 0);
    const restored = await applyClaudeSessionDeletionBackupRestore(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      backupId: listed.backups[0].id,
      sessionIds: [FIRST_ID],
      planToken: restorePreview.planToken,
    });
    assert.equal(restored.restored.sessions, 1);
    assert.equal(await exists(path.join(fixture.projectDir, `${FIRST_ID}.jsonl`)), true);
    assert.equal(await exists(path.join(fixture.projectDir, FIRST_ID, 'tool-results', 'large.txt')), true);
    const indexAfterRestore = JSON.parse(await readFile(path.join(fixture.projectDir, 'sessions-index.json'), 'utf8'));
    assert.deepEqual(new Set(indexAfterRestore.entries.map((entry) => entry.sessionId)), new Set([FIRST_ID, SECOND_ID]));

    const erased = await deleteClaudeSessionDeletionBackups(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      backupIds: [listed.backups[0].id],
    });
    assert.equal(erased.deletedCount, 1);
    assert.equal((await listClaudeSessionDeletionBackups(fixture.claudeHome, { backupRoot: fixture.backupRoot })).backups.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Claude deletion refuses a stale preview instead of deleting changed data', async () => {
  const fixture = await createFixture();
  try {
    const preview = await previewClaudeSessionDeletion(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      sessionId: FIRST_ID,
    });
    await writeFile(path.join(fixture.projectDir, `${FIRST_ID}.jsonl`), `${rollout(FIRST_ID, '第一会话')}\n`, 'utf8');
    await assert.rejects(
      applyClaudeSessionDeletion(fixture.claudeHome, {
        backupRoot: fixture.backupRoot,
        sessionId: FIRST_ID,
        planToken: preview.planToken,
      }),
      (error) => error.code === 'CLAUDE_DELETE_PLAN_CHANGED',
    );
    assert.equal(await exists(path.join(fixture.projectDir, `${FIRST_ID}.jsonl`)), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Claude batch deletion creates one backup and keeps unrelated sessions', async () => {
  const fixture = await createFixture();
  try {
    const preview = await previewClaudeSessionDeletion(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      sessionIds: [FIRST_ID, SECOND_ID],
    });
    const result = await applyClaudeSessionDeletion(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      sessionIds: [FIRST_ID, SECOND_ID],
      planToken: preview.planToken,
      now: '2026-08-05T11:00:00.000Z',
    });
    assert.equal(result.deleted.sessions, 2);
    assert.equal((await listClaudeSessionDeletionBackups(fixture.claudeHome, { backupRoot: fixture.backupRoot })).backups[0].sessions.length, 2);
    const index = JSON.parse(await readFile(path.join(fixture.projectDir, 'sessions-index.json'), 'utf8'));
    assert.deepEqual(index.entries, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Claude restore rejects a tampered manifest that targets arbitrary .claude files', async () => {
  const fixture = await createFixture();
  try {
    const preview = await previewClaudeSessionDeletion(fixture.claudeHome, { backupRoot: fixture.backupRoot, sessionId: FIRST_ID });
    const deleted = await applyClaudeSessionDeletion(fixture.claudeHome, {
      backupRoot: fixture.backupRoot,
      sessionId: FIRST_ID,
      planToken: preview.planToken,
      now: '2026-08-05T12:00:00.000Z',
    });
    const manifestPath = path.join(deleted.backup.backupDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.sessions[0].artifacts[0].sourceRelativePath = 'settings.json';
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await assert.rejects(
      previewClaudeSessionDeletionBackupRestore(fixture.claudeHome, {
        backupRoot: fixture.backupRoot,
        backupId: deleted.backup.id,
        sessionIds: [FIRST_ID],
      }),
      (error) => error.code === 'INVALID_CLAUDE_BACKUP',
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
