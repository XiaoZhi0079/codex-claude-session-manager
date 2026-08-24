import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CleanerError } from './core.mjs';

function normalizedDataPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function lockName(kind, dataPath) {
  const digest = createHash('sha256').update(normalizedDataPath(dataPath)).digest('hex');
  return `${kind}-${digest}.lock`;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function defaultLockRoot(env) {
  const base = env.LOCALAPPDATA || os.tmpdir();
  return path.join(base, 'CodexClaudeSessionManager', 'instance-locks');
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

async function acquireDataLock(kind, dataPath, lockRoot, options) {
  const lockPath = path.join(lockRoot, lockName(kind, dataPath));
  const isAlive = options.isProcessAlive || processIsAlive;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    let handle;
    try {
      handle = await open(lockPath, 'wx');
      const owner = {
        format: 'ccsm-instance-lock-v1',
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        resource: kind,
        dataPath: path.resolve(dataPath),
        port: options.port,
      };
      await handle.writeFile(JSON.stringify(owner, null, 2), 'utf8');
      return {
        ...owner,
        lockPath,
        async release() {
          const current = await readOwner(lockPath);
          await handle.close().catch(() => {});
          if (current?.token === token) await unlink(lockPath).catch(() => {});
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readOwner(lockPath);
      if (owner && isAlive(Number(owner.pid))) {
        throw new CleanerError(
          'INSTANCE_ALREADY_RUNNING',
          `Another session-manager instance is already using the ${kind} data directory.`,
          409,
          { ...owner, lockPath },
        );
      }
      await unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      });
    }
  }
  throw new CleanerError('INSTANCE_LOCK_BUSY', 'Could not acquire the session-manager instance lock.', 409, { kind, dataPath, lockPath });
}

export async function acquireInstanceLocks(options = {}) {
  const env = options.env || process.env;
  const lockRoot = options.instanceLockRoot
    || env.CODEX_CLAUDE_SESSION_MANAGER_INSTANCE_LOCK_ROOT
    || defaultLockRoot(env);
  await mkdir(lockRoot, { recursive: true });
  const resources = [
    ['codex', options.codexHome],
    ['claude', options.claudeHome],
  ].filter(([, dataPath]) => dataPath);
  resources.sort((left, right) => normalizedDataPath(left[1]).localeCompare(normalizedDataPath(right[1])) || left[0].localeCompare(right[0]));
  const locks = [];
  let released = false;
  try {
    for (const [kind, dataPath] of resources) {
      locks.push(await acquireDataLock(kind, dataPath, lockRoot, options));
    }
  } catch (error) {
    await Promise.allSettled(locks.map((lock) => lock.release()));
    throw error;
  }
  return {
    lockRoot,
    locks,
    async release() {
      if (released) return;
      released = true;
      await Promise.allSettled([...locks].reverse().map((lock) => lock.release()));
    },
  };
}
