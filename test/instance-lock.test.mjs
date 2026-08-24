import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireInstanceLocks } from '../src/instance-lock.mjs';
import { resolveCleanerPort, startCleanerServer } from '../src/server.mjs';

test('default server port is fixed at 18797', () => {
  assert.equal(resolveCleanerPort({}, {}), 18797);
});

test('an active Codex or Claude data directory blocks another instance on any port', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ccsm-instance-lock-'));
  const codexHome = path.join(temp, '.codex');
  const claudeHome = path.join(temp, '.claude');
  const otherClaudeHome = path.join(temp, 'other-claude');
  const instanceLockRoot = path.join(temp, 'locks');
  const first = await acquireInstanceLocks({ codexHome, claudeHome, instanceLockRoot, port: 18797 });
  try {
    await assert.rejects(
      acquireInstanceLocks({ codexHome, claudeHome: otherClaudeHome, instanceLockRoot, port: 19999 }),
      (error) => error.code === 'INSTANCE_ALREADY_RUNNING'
        && error.details.resource === 'codex'
        && error.details.port === 18797,
    );
  } finally {
    await first.release();
    await rm(temp, { recursive: true, force: true });
  }
});

test('stale instance locks are replaced and released cleanly', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ccsm-instance-stale-'));
  const codexHome = path.join(temp, '.codex');
  const instanceLockRoot = path.join(temp, 'locks');
  const initial = await acquireInstanceLocks({ codexHome, instanceLockRoot, port: 18797 });
  const lockPath = initial.locks[0].lockPath;
  await initial.release();
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify({ pid: 999999, token: 'stale', port: 18798 }), 'utf8');
  const replacement = await acquireInstanceLocks({
    codexHome,
    instanceLockRoot,
    port: 18797,
    isProcessAlive: () => false,
  });
  try {
    assert.equal(replacement.locks[0].pid, process.pid);
    assert.equal(replacement.locks[0].port, 18797);
  } finally {
    await replacement.release();
    await rm(temp, { recursive: true, force: true });
  }
});

test('startCleanerServer enforces the data-directory lock independently of TCP port', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ccsm-instance-server-'));
  const options = {
    port: 0,
    codexHome: path.join(temp, '.codex'),
    claudeHome: path.join(temp, '.claude'),
    instanceLockRoot: path.join(temp, 'locks'),
    backupRoot: path.join(temp, 'backups'),
    env: {},
  };
  const first = await startCleanerServer(options);
  try {
    await assert.rejects(startCleanerServer(options), { code: 'INSTANCE_ALREADY_RUNNING' });
  } finally {
    await new Promise((resolve) => first.server.close(resolve));
    await first.releaseInstanceLocks();
    await rm(temp, { recursive: true, force: true });
  }
});
