import { createHash } from 'node:crypto';
import path from 'node:path';
import { copyFile, mkdir, readFile } from 'node:fs/promises';

import { CleanerError, writeFileAtomically } from './core.mjs';

const DESKTOP_STATE_FILES = ['.codex-global-state.json', '.codex-global-state.json.bak'];
const TOP_LEVEL_THREAD_MAPS = [
  'thread-workspace-root-hints',
  'thread-projectless-output-directories',
  'thread-project-assignments',
  'electron-remote-hosted-pip-task-visibility-state',
];
const ATOM_THREAD_MAPS = [
  'heartbeat-thread-permissions-by-id',
  'prompt-history',
  'thread-descriptions-v1',
  'composer-prompt-drafts-v2',
];
const ATOM_THREAD_KEY_PREFIXES = [
  'thread-reference-capability:',
  'thread-client-id-v1:',
  'thread-tab-routes-v1:',
];

function hashSource(source) {
  return createHash('sha256').update(source).digest('hex');
}

function removeMapKeys(container, ids) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return 0;
  let removed = 0;
  for (const id of ids) {
    if (!Object.hasOwn(container, id)) continue;
    delete container[id];
    removed += 1;
  }
  return removed;
}

function removeArrayValues(value, ids) {
  if (!Array.isArray(value)) return 0;
  const before = value.length;
  const kept = value.filter((item) => !ids.has(item));
  value.splice(0, value.length, ...kept);
  return before - kept.length;
}

function removeNestedArrayValues(value, ids) {
  if (Array.isArray(value)) {
    let removed = removeArrayValues(value, ids);
    for (const item of value) removed += removeNestedArrayValues(item, ids);
    return removed;
  }
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((total, item) => total + removeNestedArrayValues(item, ids), 0);
}

function removeNestedThreadKeys(value, ids) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  let removed = 0;
  for (const key of Object.keys(value)) {
    if (ids.has(key)) {
      delete value[key];
      removed += 1;
      continue;
    }
    removed += removeNestedThreadKeys(value[key], ids);
  }
  return removed;
}

function removeDesktopReferences(state, sessionIds) {
  const ids = new Set(sessionIds);
  let removed = 0;
  for (const key of TOP_LEVEL_THREAD_MAPS) removed += removeMapKeys(state[key], ids);
  removed += removeArrayValues(state['projectless-thread-ids'], ids);
  removed += removeNestedArrayValues(state['sidebar-project-thread-orders'], ids);
  removed += removeNestedThreadKeys(state['sidebar-project-thread-orders'], ids);

  const atom = state['electron-persisted-atom-state'];
  if (atom && typeof atom === 'object' && !Array.isArray(atom)) {
    for (const key of ATOM_THREAD_MAPS) removed += removeMapKeys(atom[key], ids);
    removed += removeNestedArrayValues(atom['unread-thread-ids-by-host-v1'], ids);
    const bindings = atom['client-thread-bindings-v1'];
    if (bindings && typeof bindings === 'object' && !Array.isArray(bindings)) {
      for (const [key, value] of Object.entries(bindings)) {
        if (!ids.has(value)) continue;
        delete bindings[key];
        removed += 1;
      }
    }
    for (const key of Object.keys(atom)) {
      if (!ATOM_THREAD_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
      if (!sessionIds.some((id) => key.includes(id) || key.includes(encodeURIComponent(id)))) continue;
      delete atom[key];
      removed += 1;
    }
  }
  return removed;
}

function transformedDesktopState(source, sessionIds, filePath) {
  let state;
  try {
    state = JSON.parse(source);
  } catch (error) {
    throw new CleanerError(
      'CODEX_DESKTOP_STATE_INVALID',
      'Codex desktop state is not valid JSON, so its deleted-session references cannot be cleaned safely.',
      422,
      { filePath, technicalMessage: error.message },
    );
  }
  const references = removeDesktopReferences(state, sessionIds);
  if (!references) return { references: 0, source };
  const trailingNewline = /\r?\n$/.test(source);
  return { references, source: `${JSON.stringify(state)}${trailingNewline ? '\n' : ''}` };
}

export async function inspectCodexDesktopState(codexHome, sessionIds) {
  const ids = [...new Set(sessionIds.map(String).filter(Boolean))];
  const files = [];
  for (const name of DESKTOP_STATE_FILES) {
    const filePath = path.join(codexHome, name);
    let source;
    try {
      source = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const transformed = transformedDesktopState(source, ids, filePath);
    if (!transformed.references) continue;
    files.push({
      path: filePath,
      sourceHash: hashSource(source),
      references: transformed.references,
    });
  }
  return {
    files,
    references: files.reduce((total, file) => total + file.references, 0),
  };
}

export async function backupCodexDesktopState(preview, backupDir) {
  if (!preview?.files?.length) return [];
  const desktopDir = path.join(backupDir, 'desktop-state');
  await mkdir(desktopDir, { recursive: true });
  const backups = [];
  for (const item of preview.files) {
    const backupPath = path.join(desktopDir, path.basename(item.path));
    await copyFile(item.path, backupPath);
    backups.push({ path: item.path, backupPath, sourceHash: item.sourceHash, references: item.references });
  }
  return backups;
}

export async function applyCodexDesktopStateCleanup(preview, sessionIds, backups = []) {
  const prepared = [];
  for (const item of preview?.files || []) {
    const source = await readFile(item.path, 'utf8');
    if (hashSource(source) !== item.sourceHash) {
      throw new CleanerError(
        'STALE_CODEX_DESKTOP_STATE',
        'Codex desktop state changed after deletion preview. Close or refresh Codex and preview again.',
        409,
        { filePath: item.path },
      );
    }
    const transformed = transformedDesktopState(source, sessionIds, item.path);
    if (transformed.references !== item.references) {
      throw new CleanerError(
        'STALE_CODEX_DESKTOP_STATE',
        'Codex desktop session references changed after deletion preview.',
        409,
        { filePath: item.path, expected: item.references, actual: transformed.references },
      );
    }
    prepared.push({ path: item.path, references: transformed.references, source: transformed.source });
  }
  const changed = [];
  try {
    for (const item of prepared) {
      await writeFileAtomically(item.path, item.source);
      changed.push({ path: item.path, references: item.references });
    }
  } catch (error) {
    const rollbackErrors = await rollbackCodexDesktopState(backups);
    throw new CleanerError(
      'CODEX_DESKTOP_STATE_WRITE_FAILED',
      'Updating Codex desktop session references failed and was rolled back where possible.',
      500,
      { technicalMessage: error.message, rollbackErrors },
    );
  }
  return {
    files: changed,
    references: changed.reduce((total, item) => total + item.references, 0),
  };
}

export async function rollbackCodexDesktopState(backups) {
  const errors = [];
  for (const item of backups || []) {
    try {
      await copyFile(item.backupPath, item.path);
    } catch (error) {
      errors.push({ target: item.path, message: error.message });
    }
  }
  return errors;
}
