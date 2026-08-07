import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  diagnoseSessionHealth,
  summarizeSessionHealth,
} from '../src/session-health.mjs';

function healthySession(overrides = {}) {
  return {
    id: 'session-1',
    title: 'Friendly title',
    indexTitle: 'Friendly title',
    sqliteTitle: 'First user message',
    projectPath: 'D:\\project',
    hasRollout: true,
    rolloutPath: 'D:\\sessions\\rollout.jsonl',
    indexed: true,
    sqliteIndexed: true,
    sqliteRolloutPath: 'D:\\sessions\\rollout.jsonl',
    modelProvider: 'custom',
    sqliteProvider: 'custom',
    currentProvider: 'custom',
    codexVisible: true,
    archived: false,
    storageStatus: 'live',
    backupPaths: [],
    recoverableFromBackup: false,
    ...overrides,
  };
}

test('healthy summary accepts different friendly and SQLite titles as informational', () => {
  const summary = summarizeSessionHealth(healthySession());
  assert.equal(summary.state, 'healthy');
  assert.equal(summary.issueCount, 0);
  assert.equal(summary.codexVisible, true);
});

test('provider mismatch is explained as an actionable attention state', () => {
  const summary = summarizeSessionHealth(healthySession({
    sqliteProvider: 'openai',
    codexVisible: false,
  }));
  assert.equal(summary.state, 'attention');
  assert.equal(summary.label, '需处理');
  assert.ok(summary.issueCount >= 1);
});

test('backup-only and irrecoverable metadata residue are distinguished', () => {
  const backupOnly = summarizeSessionHealth(healthySession({
    hasRollout: false,
    rolloutPath: null,
    indexed: false,
    sqliteIndexed: false,
    sqliteRolloutPath: null,
    codexVisible: false,
    storageStatus: 'backup_only',
    backupPaths: [{ sourceKind: 'cleaner_backup', path: 'D:\\backup.jsonl' }],
  }));
  const residue = summarizeSessionHealth(healthySession({
    hasRollout: false,
    rolloutPath: null,
    indexed: false,
    sqliteIndexed: true,
    codexVisible: false,
    storageStatus: 'sqlite_only',
    backupPaths: [],
  }));
  assert.equal(backupOnly.state, 'backup_only');
  assert.equal(residue.state, 'incomplete');
});

test('diagnosis reports live file facts, title sources, findings, and safe preview actions', async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'codex-health-'));
  const rolloutPath = path.join(codexHome, 'rollout.jsonl');
  const stateDbPath = path.join(codexHome, 'state_5.sqlite');
  await writeFile(rolloutPath, '{}\n', 'utf8');
  await writeFile(stateDbPath, 'sqlite fixture', 'utf8');
  await writeFile(path.join(codexHome, 'session_index.jsonl'), '{}\n', 'utf8');

  const diagnosis = await diagnoseSessionHealth(codexHome, healthySession({
    rolloutPath,
    sqliteRolloutPath: rolloutPath,
    stateDbPath,
  }));
  assert.equal(diagnosis.sources.rollout.status, 'present');
  assert.equal(diagnosis.sources.sqlite.status, 'present');
  assert.equal(diagnosis.sources.legacyIndex.status, 'present');
  assert.equal(diagnosis.sources.legacyIndex.title, 'Friendly title');
  assert.equal(diagnosis.findings.some((item) => item.code === 'TITLE_SOURCES_DIFFER'), true);
  assert.equal(diagnosis.actions.find((item) => item.id === 'view_context').available, true);
  assert.equal(diagnosis.actions.find((item) => item.id === 'visibility_repair').available, false);
});
