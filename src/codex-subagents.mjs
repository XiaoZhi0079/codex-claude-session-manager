import {
  CleanerError,
  getRecordTurnId,
  getVisibleUserText,
  listTurnsFromRecords,
  readRollout,
} from './core.mjs';

function parsedSource(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function codexSubagentInfo(session) {
  for (const value of [session?.source, session?.sqliteSource]) {
    const spawn = parsedSource(value)?.subagent?.thread_spawn;
    if (!spawn?.parent_thread_id) continue;
    return {
      parentId: spawn.parent_thread_id,
      depth: Number.isInteger(spawn.depth) ? spawn.depth : 1,
      agentPath: spawn.agent_path || null,
      nickname: spawn.agent_nickname || null,
      role: spawn.agent_role || null,
    };
  }
  return null;
}

function selectedTurn(turns, selector) {
  if (selector?.turnId) return turns.find((turn) => turn.turnId === selector.turnId) || null;
  if (Number.isInteger(selector?.index)) return turns.find((turn) => turn.index === selector.index) || null;
  if (Number.isInteger(selector?.startLine)) return turns.find((turn) => turn.startLine === selector.startLine) || null;
  return null;
}

export function classifySubagentTurns(childTurns, parentTurns) {
  const parentTurnIds = new Set(parentTurns.map((turn) => turn.turnId).filter(Boolean));
  const inheritedTurns = [];
  for (const turn of childTurns) {
    if (!turn.turnId || !parentTurnIds.has(turn.turnId)) break;
    inheritedTurns.push(turn);
  }
  const inheritedIds = new Set(inheritedTurns.map((turn) => turn.turnId));
  return {
    inheritedTurns,
    ownTurns: childTurns.filter((turn) => !inheritedIds.has(turn.turnId)),
    inheritedRanges: inheritedTurns.map((turn) => ({ startLine: turn.startLine, endLine: turn.endLine, turnId: turn.turnId })),
  };
}

function findOriginatingParentTurn(parentRecords, parentTurns, childSessionId) {
  const activity = parentRecords.find((record) => {
    const item = record?.data?.payload?.item || record?.data?.item;
    return String(item?.type || '').toLowerCase() === 'subagentactivity'
      && item?.kind === 'started'
      && item?.agent_thread_id === childSessionId;
  });
  if (!activity) return null;
  const turnId = getRecordTurnId(activity.data);
  return parentTurns.find((turn) => turn.turnId === turnId) || null;
}

export async function inspectCodexSubagentInheritance(session, sessions, options = {}) {
  const info = codexSubagentInfo(session);
  const childRecords = options.childRecords || (session?.rolloutPath ? await readRollout(session.rolloutPath) : []);
  const childTurns = listTurnsFromRecords(childRecords);
  if (!info) {
    return { info: null, parent: null, childTurns, inheritedTurns: [], ownTurns: childTurns, inheritedRanges: [] };
  }
  const parent = sessions.find((candidate) => candidate.id === info.parentId) || null;
  if (!parent?.rolloutPath) {
    return { info, parent, childTurns, inheritedTurns: [], ownTurns: childTurns, inheritedRanges: [], unavailableReason: 'parent_rollout_missing' };
  }
  let parentRecords;
  let parentTurns;
  try {
    parentRecords = await readRollout(parent.rolloutPath);
    parentTurns = listTurnsFromRecords(parentRecords);
  } catch (error) {
    return { info, parent, childTurns, inheritedTurns: [], ownTurns: childTurns, inheritedRanges: [], unavailableReason: error?.code || 'parent_rollout_read_failed' };
  }
  const originatingTurn = findOriginatingParentTurn(parentRecords, parentTurns, session?.id);
  return {
    info,
    parent,
    childTurns,
    originatingTurn: originatingTurn ? {
      turnId: originatingTurn.turnId,
      prompt: getVisibleUserText(parentRecords.slice(originatingTurn.startIndex, originatingTurn.endIndex + 1)) || null,
      startLine: originatingTurn.startLine,
      endLine: originatingTurn.endLine,
    } : null,
    ...classifySubagentTurns(childTurns, parentTurns),
  };
}

export function assertCodexTurnIsOwned(inheritance, selector) {
  if (!inheritance?.inheritedTurns?.length) return;
  const turn = selectedTurn(inheritance.childTurns, selector);
  if (!turn) return;
  if (!inheritance.inheritedTurns.some((candidate) => candidate.turnId === turn.turnId)) return;
  throw new CleanerError(
    'INHERITED_SUBAGENT_TURN_READ_ONLY',
    'This turn is inherited from the parent Codex session and is read-only in the subagent view.',
    409,
    { turnId: turn.turnId, parentSessionId: inheritance.info?.parentId || null },
  );
}
