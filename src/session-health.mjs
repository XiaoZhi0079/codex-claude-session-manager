import path from 'node:path';
import { stat } from 'node:fs/promises';

function normalizedPath(value) {
  if (!value) return null;
  let comparable = String(value);
  if (process.platform === 'win32') {
    if (/^\\\\\?\\UNC\\/i.test(comparable)) comparable = `\\\\${comparable.slice(8)}`;
    else if (/^\\\\\?\\/i.test(comparable)) comparable = comparable.slice(4);
  }
  const resolved = path.resolve(comparable);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  const leftKey = normalizedPath(left);
  const rightKey = normalizedPath(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function finding(code, severity, title, explanation, action = null) {
  return { code, severity, title, explanation, action };
}

function meaningfulTitle(value) {
  const title = String(value || '').trim();
  return Boolean(title && title !== '(untitled)');
}

function evaluateSession(session, currentProvider) {
  const findings = [];
  const backups = session.backupPaths || [];
  const indexTitle = session.indexTitle
    || (session.indexed ? session.raw?.thread_name || session.raw?.title || session.title : null);
  const sqliteTitle = session.sqliteTitle || null;

  if (!session.hasRollout) {
    if (session.recoverableFromBackup) {
      findings.push(finding(
        'ROLLOUT_RECOVERABLE',
        'warning',
        '正式正文缺失，但找到了可自动恢复的备份',
        'SQLite 仍保存原始 rollout 路径，本工具可以在统一会话时把匹配备份恢复回去。',
        'visibility_repair',
      ));
    } else if (backups.length) {
      findings.push(finding(
        'BACKUP_ONLY',
        'warning',
        '当前只剩历史备份',
        'sessions 与 archived_sessions 中没有正式正文，因此 Codex 不会把它当作活动会话。',
        backups.some((backup) => backup.sourceKind === 'cleaner_backup') ? 'open_backups' : null,
      ));
    } else {
      findings.push(finding(
        'ROLLOUT_MISSING',
        'critical',
        '正文文件已经缺失',
        '没有找到正式 rollout，也没有找到可用备份，原始对话内容无法由本工具还原。',
      ));
    }
  }

  if (!session.sqliteIndexed) {
    findings.push(finding(
      'SQLITE_ROW_MISSING',
      session.hasRollout ? 'warning' : 'critical',
      'SQLite 中没有线程记录',
      session.hasRollout
        ? '正文仍可读取，但 Codex 的会话列表缺少这条索引；当前统一流程不会凭空创建未知结构的线程记录。'
        : 'Codex 没有可用于定位该会话的线程记录。',
    ));
  }

  if (session.hasRollout && session.sqliteIndexed && session.sqliteRolloutPath
    && !samePath(session.rolloutPath, session.sqliteRolloutPath)) {
    findings.push(finding(
      'ROLLOUT_PATH_MISMATCH',
      'warning',
      'SQLite 指向了不同的正文路径',
      '工具扫描到的正式正文与 SQLite 的 rollout_path 不一致，Codex 可能读取旧路径或不存在的文件。',
    ));
  }

  if (session.sqliteIndexed && session.sqliteProvider !== currentProvider) {
    findings.push(finding(
      'SQLITE_PROVIDER_MISMATCH',
      'warning',
      'SQLite 供应商与当前配置不一致',
      `SQLite 记录属于 ${session.sqliteProvider || '未知供应商'}，当前配置是 ${currentProvider || '未知供应商'}。`,
      session.hasRollout ? 'visibility_repair' : null,
    ));
  }

  if (session.hasRollout && session.modelProvider !== currentProvider) {
    findings.push(finding(
      'ROLLOUT_PROVIDER_MISMATCH',
      'warning',
      '正文供应商与当前配置不一致',
      `rollout 记录属于 ${session.modelProvider || '未知供应商'}，当前配置是 ${currentProvider || '未知供应商'}。`,
      session.sqliteIndexed ? 'visibility_repair' : null,
    ));
  }

  if (session.hasRollout && session.sqliteIndexed && session.modelProvider && session.sqliteProvider
    && session.modelProvider !== session.sqliteProvider) {
    findings.push(finding(
      'PROVIDER_SOURCES_CONFLICT',
      'warning',
      '正文与 SQLite 的供应商互相冲突',
      `rollout 是 ${session.modelProvider}，SQLite 是 ${session.sqliteProvider}。`,
      'visibility_repair',
    ));
  }

  if (!session.indexed) {
    findings.push(finding(
      'LEGACY_INDEX_MISSING',
      'info',
      '旧会话标题索引中没有记录',
      '这不会单独导致正文丢失；工具会按实际可用情况继续使用 SQLite 标题、正文摘要或备份摘要。',
    ));
  }

  if (!meaningfulTitle(indexTitle) && !meaningfulTitle(sqliteTitle) && !meaningfulTitle(session.title)) {
    findings.push(finding(
      'TITLE_MISSING',
      'warning',
      '没有找到可用标题',
      '旧索引、SQLite 和当前合并结果都没有有效标题。',
    ));
  } else if (meaningfulTitle(indexTitle) && meaningfulTitle(sqliteTitle) && indexTitle !== sqliteTitle) {
    findings.push(finding(
      'TITLE_SOURCES_DIFFER',
      'info',
      '标题来源不同',
      '旧索引保存了友好标题，SQLite 保存的是另一标题；会话列表会优先显示旧索引标题。',
    ));
  }

  if (session.archived) {
    findings.push(finding(
      'ARCHIVED_SESSION',
      'info',
      '会话位于归档目录',
      '正文仍然存在，但它属于 archived_sessions，而不是活动 sessions。',
    ));
  }

  if (backups.length) {
    const cleanerCount = backups.filter((backup) => backup.sourceKind === 'cleaner_backup').length;
    const ccSwitchCount = backups.filter((backup) => backup.sourceKind === 'cc_switch_backup').length;
    findings.push(finding(
      'BACKUPS_AVAILABLE',
      'info',
      `找到 ${backups.length} 份历史副本`,
      [cleanerCount ? `本工具 ${cleanerCount} 份` : '', ccSwitchCount ? `CCSwitch ${ccSwitchCount} 份` : '']
        .filter(Boolean)
        .join('，'),
      cleanerCount ? 'open_backups' : null,
    ));
  }

  return { findings, indexTitle, sqliteTitle };
}

export function summarizeSessionHealth(session, options = {}) {
  const currentProvider = options.currentProvider || session.currentProvider || null;
  const { findings } = evaluateSession(session, currentProvider);
  const issueCount = findings.filter((item) => item.severity !== 'info').length;
  const hasCritical = findings.some((item) => item.severity === 'critical');
  let state = 'healthy';
  let label = session.archived ? '结构完整' : '正常';
  let summary = session.codexVisible
    ? '正文、SQLite 和当前供应商相互一致。'
    : '会话结构完整，但当前不一定出现在 Codex 活动列表中。';

  if (!session.hasRollout && session.backupPaths?.length) {
    state = session.recoverableFromBackup ? 'recoverable' : 'backup_only';
    label = session.recoverableFromBackup ? '可恢复' : '仅备份';
    summary = session.recoverableFromBackup
      ? '正式正文缺失，但存在可按原路径恢复的备份。'
      : '没有正式正文，只保留了历史副本。';
  } else if (hasCritical) {
    state = 'incomplete';
    label = '数据不完整';
    summary = findings.find((item) => item.severity === 'critical')?.title || '会话缺少关键数据。';
  } else if (issueCount) {
    state = 'attention';
    label = '需处理';
    summary = findings.find((item) => item.severity === 'warning')?.title || '检测到需要处理的状态。';
  }

  return {
    state,
    label,
    summary,
    issueCount,
    codexVisible: Boolean(session.codexVisible),
  };
}

async function fileState(filePath) {
  if (!filePath) return { exists: false, path: null, sizeBytes: 0, updatedAt: null };
  try {
    const info = await stat(filePath);
    return {
      exists: info.isFile(),
      path: filePath,
      sizeBytes: info.isFile() ? info.size : 0,
      updatedAt: info.mtime.toISOString(),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, path: filePath, sizeBytes: 0, updatedAt: null };
    return { exists: false, path: filePath, sizeBytes: 0, updatedAt: null, error: error.message };
  }
}

function availableInBackupManager(filePath) {
  return /[\\/](?:codex-turn-editor-restore-point-|codex-turn-editor-|codex-claude-session-manager-|codex-turn-cleaner-)[^\\/]+[\\/]/i
    .test(String(filePath || ''));
}

export async function diagnoseSessionHealth(codexHome, session, options = {}) {
  const currentProvider = options.currentProvider || session.currentProvider || null;
  const { findings, indexTitle, sqliteTitle } = evaluateSession(session, currentProvider);
  const [rolloutFile, sqliteFile, indexFile] = await Promise.all([
    fileState(session.rolloutPath),
    fileState(session.stateDbPath),
    fileState(path.join(codexHome, 'session_index.jsonl')),
  ]);
  const backups = (session.backupPaths || []).map((backup) => ({
    path: backup.path,
    sourceKind: backup.sourceKind,
    provider: backup.modelProvider || null,
    projectPath: backup.projectPath || null,
    title: backup.summary || null,
    sizeBytes: backup.size || 0,
    updatedAt: backup.updatedAt || null,
    managedByTool: backup.sourceKind === 'cleaner_backup',
    availableInBackupManager: backup.sourceKind === 'cleaner_backup'
      && availableInBackupManager(backup.path),
  }));
  const summary = summarizeSessionHealth(session, { currentProvider });
  const actions = [
    {
      id: 'view_context',
      label: '查看完整上下文',
      available: Boolean(session.hasRollout),
      reason: session.hasRollout ? '正文可读。' : '没有正式正文。',
    },
    {
      id: 'visibility_repair',
      label: '统一会话',
      available: Boolean(
        session.recoverableFromBackup
        || (session.hasRollout && session.sqliteIndexed && !session.codexVisible)
      ),
      reason: session.codexVisible
        ? '当前已经对 Codex 可见，无需再次统一。'
        : (session.sqliteIndexed
          ? '可使用现有可见性统一流程预览。'
          : '缺少 SQLite 线程记录，现有统一流程无法安全创建。'),
    },
    {
      id: 'open_backups',
      label: '打开备份管理',
      available: backups.some((backup) => backup.availableInBackupManager),
      reason: backups.some((backup) => backup.availableInBackupManager)
        ? '找到了可在“轮次操作快照”中查看的历史副本。'
        : (backups.some((backup) => backup.managedByTool)
          ? '找到了系统级备份；统一接入备份管理将在第二阶段完成。'
          : '没有本工具可直接管理的备份。'),
    },
    {
      id: 'delete_session',
      label: session.hasRollout ? '删除会话' : '删除残留',
      available: Boolean(
        session.hasRollout
        || session.sqliteIndexed
        || session.indexed
        || backups.some((backup) => backup.managedByTool)
      ),
      reason: '删除仍会进入现有预览和确认流程。',
    },
  ];

  return {
    session: {
      id: session.id,
      title: session.title,
      projectPath: session.projectPath,
      storageStatus: session.storageStatus,
      archived: Boolean(session.archived),
      updatedAt: session.updatedAt,
    },
    summary,
    currentProvider,
    findings,
    sources: {
      rollout: {
        status: rolloutFile.exists ? (session.archived ? 'archived' : 'present') : 'missing',
        ...rolloutFile,
        provider: session.modelProvider || null,
      },
      sqlite: {
        status: !sqliteFile.exists ? 'database_missing' : (session.sqliteIndexed ? 'present' : 'row_missing'),
        database: sqliteFile,
        rolloutPath: session.sqliteRolloutPath || null,
        provider: session.sqliteProvider || null,
        title: sqliteTitle,
        source: session.sqliteSource || null,
      },
      legacyIndex: {
        status: !indexFile.exists ? 'file_missing' : (session.indexed ? 'present' : 'row_missing'),
        file: indexFile,
        title: indexTitle,
      },
      backups: {
        status: backups.length ? 'present' : 'missing',
        count: backups.length,
        entries: backups,
      },
      provider: {
        current: currentProvider,
        rollout: session.modelProvider || null,
        sqlite: session.sqliteProvider || null,
        backup: session.backupProvider || null,
        consistent: Boolean(
          session.hasRollout
          && session.sqliteIndexed
          && session.modelProvider === currentProvider
          && session.sqliteProvider === currentProvider
        ),
      },
    },
    actions,
  };
}
