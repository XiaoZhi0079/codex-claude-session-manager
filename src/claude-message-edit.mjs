import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { CleanerError, hashRolloutSource, writeFileAtomically } from './core.mjs';
import { claudeEditableTextParts, findSession, publicSession, selectedTurn } from './claude-sessions.mjs';

function editRoot(claudeHome, options = {}) {
  return path.resolve(options.backupRoot || path.join(claudeHome, 'backups', 'codex-claude-session-manager-edits'));
}

function collectParts(session, turn) {
  const parts = [];
  for (const record of session._records) {
    if (record.lineNumber < turn.startLine || record.lineNumber > turn.endLine) continue;
    const role = record.data?.message?.role;
    claudeEditableTextParts(record).forEach((part) => parts.push({ ...part, lineNumber: record.lineNumber, role }));
  }
  return parts;
}

function applyPartEdit(data, part, value) {
  const locator = part.locator;
  if (locator.kind === 'message_string') data.message.content = value;
  else if (locator.kind === 'block_text') data.message.content[locator.blockIndex].text = value;
  else if (locator.kind === 'block_value') data.message.content[locator.blockIndex][locator.field] = value;
  else if (locator.kind === 'block_json') data.message.content[locator.blockIndex][locator.field] = JSON.parse(value);
  else if (locator.kind === 'attachment') data.attachment[locator.key] = value;
  else if (locator.kind === 'record_field') data[locator.key] = value;
  else throw new CleanerError('CLAUDE_EDIT_TARGET_NOT_FOUND', 'The selected Claude text field is not editable.', 409);
}

function normalizeEdits(edits) {
  if (!Array.isArray(edits) || !edits.length) throw new CleanerError('NO_CLAUDE_EDITS', 'No Claude message changes were provided.', 400);
  return edits.map((edit) => ({
    targetId: String(edit?.targetId || ''),
    expectedText: String(edit?.expectedText ?? ''),
    newText: String(edit?.newText ?? ''),
  }));
}

export async function previewClaudeMessageEdits(claudeHome, sessionId, turnId, edits, options = {}) {
  const session = await findSession(claudeHome, sessionId);
  const turn = selectedTurn(session, turnId);
  const source = await readFile(session.filePath, 'utf8');
  const available = new Map(collectParts(session, turn).map((part) => [part.targetId, part]));
  const changes = normalizeEdits(edits).map((edit) => {
    const part = available.get(edit.targetId);
    if (!part) throw new CleanerError('CLAUDE_EDIT_TARGET_NOT_FOUND', 'The selected Claude message part was not found.', 404, { targetId: edit.targetId });
    if (part.text !== edit.expectedText) throw new CleanerError('CLAUDE_EDIT_STALE', 'The Claude message changed after it was loaded. Reload and try again.', 409);
    if (part.locator.kind === 'block_json') {
      try { JSON.parse(edit.newText); } catch (error) {
        throw new CleanerError('INVALID_CLAUDE_EDIT_JSON', 'Tool parameters and structured results must remain valid JSON.', 400, { targetId: edit.targetId, technicalMessage: error.message });
      }
    }
    return { ...edit, lineNumber: part.lineNumber, role: part.role, label: part.label, locator: part.locator, before: part.text, after: edit.newText };
  });
  return { session: publicSession(session), turn, changes, sourceHash: hashRolloutSource(source), backupRoot: editRoot(claudeHome, options) };
}

export async function applyClaudeMessageEdits(claudeHome, sessionId, turnId, edits, options = {}) {
  const preview = await previewClaudeMessageEdits(claudeHome, sessionId, turnId, edits, options);
  const session = await findSession(claudeHome, sessionId);
  const turn = selectedTurn(session, turnId);
  const source = await readFile(session.filePath, 'utf8');
  if (options.sourceHash !== preview.sourceHash) throw new CleanerError('CLAUDE_EDIT_STALE', 'The Claude session changed after preview. Reload and try again.', 409);
  const byTarget = new Map(preview.changes.map((change) => [change.targetId, change]));
  const records = session._records.map((record) => {
    if (record.lineNumber < turn.startLine || record.lineNumber > turn.endLine) return record.raw;
    const data = JSON.parse(record.raw);
    let changed = false;
    claudeEditableTextParts(record).forEach((part) => {
      const change = byTarget.get(part.targetId);
      if (change) { applyPartEdit(data, { ...part, locator: change.locator }, change.after); changed = true; }
    });
    return changed ? JSON.stringify(data) : record.raw;
  });
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const nextSource = records.join(newline) + (source.endsWith('\n') ? newline : '');
  const id = `edit-${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-')}-${randomUUID().slice(0, 8)}`;
  const backupDir = path.join(editRoot(claudeHome, options), id);
  await mkdir(path.join(backupDir, 'payload'), { recursive: true });
  const relative = path.relative(claudeHome, preview.session.filePath);
  const payload = path.join(backupDir, 'payload', relative);
  await mkdir(path.dirname(payload), { recursive: true });
  await copyFile(session.filePath, payload);
  const manifestPath = path.join(backupDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ version: 1, kind: 'claude-message-edit', sourceRelativePath: relative }, null, 2), 'utf8');
  await writeFileAtomically(session.filePath, nextSource);
  return { sourceHashBefore: preview.sourceHash, sourceHashAfter: hashRolloutSource(nextSource), changedCount: preview.changes.length, backupDir, manifestPath, filePath: session.filePath };
}

export async function restoreClaudeMessageEdit(claudeHome, options = {}) {
  const backupDir = path.resolve(String(options.backupDir || ''));
  const root = editRoot(claudeHome, options);
  if (!backupDir.startsWith(`${root}${path.sep}`)) throw new CleanerError('UNSAFE_CLAUDE_EDIT_RESTORE', 'The Claude edit backup is outside the managed backup root.', 422);
  const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
  const target = path.resolve(claudeHome, manifest.sourceRelativePath);
  const payload = path.resolve(backupDir, 'payload', manifest.sourceRelativePath);
  if (!target.startsWith(`${path.resolve(claudeHome)}${path.sep}`) || !payload.startsWith(`${backupDir}${path.sep}`)) {
    throw new CleanerError('UNSAFE_CLAUDE_EDIT_RESTORE', 'The Claude edit backup manifest contains an unsafe path.', 422);
  }
  const current = await readFile(target, 'utf8');
  if (options.expectedCurrentHash && hashRolloutSource(current) !== options.expectedCurrentHash) throw new CleanerError('CLAUDE_EDIT_RESTORE_STALE', 'The Claude session changed after editing. Reload before restoring.', 409);
  await copyFile(payload, target);
  return { restored: target, claudeRestartRecommended: true };
}
