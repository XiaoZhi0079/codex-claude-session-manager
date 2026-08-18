const state = {
  platform: 'codex',
  sessions: [],
  directories: [],
  turns: [],
  selectedDirectory: '*',
  selectedSession: null,
  selectedTurn: null,
  preview: null,
  mode: 'truncate',
  operation: 'messages',
  contextMode: 'compact',
  turnDetail: null,
  fullContext: null,
  fullContextRequestId: 0,
  fullContextSearchTimer: null,
  edits: new Map(),
  editPreview: null,
  lastEdit: null,
  cleanupSourceHash: null,
  cleanupTargetActive: false,
  currentProvider: null,
  registrySummary: null,
  visibilityPlan: null,
  healthSessionId: null,
  healthDiagnosis: null,
  sessionDeletePlan: null,
  selectedSessionIds: new Set(),
  visibleSessionIds: [],
  deletionBackups: [],
  selectedBackupIds: new Set(),
  operationBackups: [],
  selectedOperationBackupIds: new Set(),
  systemBackups: [],
  selectedSystemBackupIds: new Set(),
  visibilityBackupRestorePlan: null,
  backupManagerView: 'deletion',
  restoreBackup: null,
  restoreBackupKind: 'deletion',
  selectedRestoreSessionIds: new Set(),
  visibleRestoreSessionIds: [],
  backupRestorePlan: null,
  backupContent: null,
  backupContentSessionId: null,
  backupContentOffset: 0,
  backupAutoDetectTimer: null,
  backupAutoDetectBusy: false,
  backupInventorySignature: null,
  backupRestoreDetectionSignature: null,
  operationHistory: null,
  lastHistoryErrorDeletion: null,
};

const $ = (id) => document.getElementById(id);

const CODEX_METRICS_HTML = $('metricsDialogBody').innerHTML;
const CODEX_CONTEXT_ROLE_OPTIONS = $('fullContextRoleFilter').innerHTML;
const CODEX_CONTEXT_CATEGORY_OPTIONS = $('fullContextCategoryFilter').innerHTML;

function isClaudePlatform() {
  return state.platform === 'claude';
}

function renderPlatformDocumentation() {
  if (!isClaudePlatform()) {
    $('metricsDialogTitle').textContent = '指标与会话状态说明';
    $('metricsDialogIntro').textContent = '这些数字来自工具合并扫描的 rollout、SQLite、旧索引和备份记录。';
    $('metricsDialogBody').innerHTML = CODEX_METRICS_HTML;
    return;
  }
  $('metricsDialogTitle').textContent = 'Claude Code 指标与数据说明';
  $('metricsDialogIntro').textContent = '主 JSONL 是会话正文真值；子代理、外置工具结果、任务与文件历史作为同一会话的数据包统计。';
  $('metricsDialogBody').innerHTML = `
    <div class="metric-docs">
      <dl class="metric-doc"><dt>会话总计</dt><dd>在 <code>~/.claude/projects</code> 中实际找到的主会话 JSONL 数量，不依赖可能过期的 sessions-index.json。</dd></dl>
      <dl class="metric-doc"><dt>可以继续</dt><dd>主 JSONL 可解析并包含有效记录。它表示具备原生恢复基础，不代表所有外置工具输出都仍然存在。</dd></dl>
      <dl class="metric-doc"><dt>需要注意</dt><dd>检测到损坏 JSONL、缺失外置结果、中断工具调用、无可见轮次或子代理元数据不完整。</dd></dl>
    </div>
    <p class="docs-subhead">Claude Code 会话数据包</p>
    <div class="metric-docs">
      <dl class="metric-doc"><dt>主会话</dt><dd><code>projects/&lt;项目&gt;/&lt;sessionId&gt;.jsonl</code> 保存权威正文和消息链。</dd></dl>
      <dl class="metric-doc"><dt>侧边数据</dt><dd>包括 tool-results、subagents、tasks、file-history 与 session-env；落盘模式会安全解析与当前会话关联的内容。</dd></dl>
      <dl class="metric-doc"><dt>索引标题</dt><dd>标题优先采用 custom-title，其次使用 sessions-index 摘要，最后才回退到第一条用户消息。</dd></dl>
      <dl class="metric-doc"><dt>运行时提示词</dt><dd>Claude Code 的内置身份提示词由客户端运行时组装，不写入历史 JSONL；页面只展示会话实际落盘的 Skill、MCP、Hook 等动态注入。</dd></dl>
    </div>
  `;
}

function configurePlatformUI() {
  const claude = isClaudePlatform();
  $('codexPlatformButton').classList.toggle('active', !claude);
  $('claudePlatformButton').classList.toggle('active', claude);
  $('codexPlatformButton').setAttribute('aria-pressed', String(!claude));
  $('claudePlatformButton').setAttribute('aria-pressed', String(claude));
  $('operationHistoryButton').classList.remove('hidden');
  $('backupManagerButton').classList.remove('hidden');
  $('sessionCommandbar').classList.remove('hidden');
  $('visibilityButton').classList.toggle('hidden', claude);
  $('batchToolbar').classList.remove('hidden');
  $('deleteSessionButton').classList.remove('hidden');
  $('operationSwitcher').classList.remove('hidden');
  $('fullContextExport').classList.toggle('hidden', claude);
  $('sessionPanelTitle').textContent = claude ? 'Claude 会话' : '会话';
  $('turnPanelTitle').textContent = claude ? '对话轮次' : '轮次';
  $('operationPanelTitle').textContent = claude ? '上下文' : '轮次操作';
  $('compactContextDescription').textContent = claude ? '用户与 Claude 回复' : '用户与 Codex 消息';
  $('fullContextModeLabel').textContent = claude ? '落盘模式' : '完整模式';
  $('fullContextDescription').textContent = claude ? '实际保存的工具、注入与客户端事件' : '全部落盘上下文';
  $('fullContextWarning').textContent = claude
    ? '落盘模式展示 Claude Code 实际写入会话包的内容，可能包含敏感数据。内置基础身份提示词由客户端运行时组装，未写入历史 JSONL，因此无法从旧会话精确还原。'
    : '完整模式会显示 session 中实际保存的提示词、环境信息、工具输入与输出等，可能包含敏感数据。请勿直接截图或分享。未写入 session 的运行时内容无法还原。';
  $('fullContextSourceLabel').textContent = claude ? '内容来源' : '角色';
  $('fullContextRoleFilter').innerHTML = claude ? `
    <option value="all">全部来源</option>
    <option value="human">人类</option>
    <option value="claude">Claude</option>
    <option value="tool">工具</option>
    <option value="runtime">运行时注入</option>
    <option value="client">Claude Code 客户端</option>
    <option value="subagent">子代理</option>
  ` : CODEX_CONTEXT_ROLE_OPTIONS;
  $('fullContextCategoryFilter').innerHTML = claude ? `
    <option value="all">全部类型</option>
    <option value="conversation">对话消息</option>
    <option value="tool_call">工具调用</option>
    <option value="tool_result">工具结果</option>
    <option value="runtime_injection">运行时注入</option>
    <option value="client_event">客户端事件</option>
  ` : CODEX_CONTEXT_CATEGORY_OPTIONS;
  $('deletionBackupsTab').textContent = claude ? 'Claude 会话删除备份' : '会话删除备份';
  $('operationBackupsTab').classList.toggle('hidden', claude);
  $('systemBackupsTab').classList.toggle('hidden', claude);
  $('deletionBackupsTab').parentElement.style.gridTemplateColumns = claude ? '1fr' : '';
  if (claude) state.backupManagerView = 'deletion';
  $('sessionFilter').placeholder = claude ? '筛选标题 / 项目 / 会话 ID' : '筛选标题 / 会话 ID';
  $('visibilityPanel').classList.add('hidden');
  if (claude) setOperationView('messages');
  renderPlatformDocumentation();
}

async function setPlatform(platform) {
  if (platform !== 'codex' && platform !== 'claude') return;
  if (state.platform === platform && state.sessions.length) return;
  state.platform = platform;
  try { localStorage.setItem('ctc-platform', platform); } catch {}
  state.sessions = [];
  state.directories = [];
  state.turns = [];
  state.historyErrors = [];
  state.selectedDirectory = '*';
  state.selectedSession = null;
  state.selectedTurn = null;
  state.selectedSessionIds = new Set();
  state.visibleSessionIds = [];
  configurePlatformUI();
  await loadSessions();
}

const displayPath = (path) => String(path || '')
  .replace(/^\\\\\?\\/, '')
  .replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`);

function mergeDirectories(directories) {
  const grouped = new Map();
  for (const directory of directories) {
    const path = displayPath(directory.path);
    const key = normalizedDirectory(path);
    if (!key) continue;
    const current = grouped.get(key);
    if (current) current.count += Number(directory.count) || 0;
    else grouped.set(key, { ...directory, path, count: Number(directory.count) || 0 });
  }
  return [...grouped.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function renderSummary() {
  const summary = state.registrySummary;
  if (!summary) {
    $('summaryChips').innerHTML = '';
    return;
  }
  const chips = isClaudePlatform()
    ? [
      ['会话总计', summary.total, ''],
      ['可以继续', summary.resumable, ''],
      ['需要注意', summary.attention, summary.attention ? ' hot' : ''],
    ]
    : [
      ['会话总计', summary.total, ''],
      ['Codex 可见', summary.codexVisible, ''],
      ['Codex 隐藏', summary.hiddenFromCodex, summary.hiddenFromCodex ? ' hot' : ''],
    ];
  $('summaryChips').innerHTML = chips.map(([label, value, css]) => (
    `<span class="summary-chip${css}"><span class="dot"></span>${label} <b>${value}</b></span>`
  )).join('');
}

const PANEL_CONFIG = [
  { id: 'sessions', elementId: 'panelSessions', label: '会话', min: 250, initial: 384 },
  { id: 'turns', elementId: 'panelTurns', label: '轮次', min: 210, initial: 292 },
  { id: 'operations', elementId: 'panelOperations', label: '轮次操作', min: 330, initial: 720 },
];
const PANEL_PAIRS = { sessions: ['sessions', 'turns'], turns: ['turns', 'operations'] };
const PANEL_COLLAPSED_WIDTH = 42;
const PANEL_RESIZER_WIDTH = 7;

function panelConfig(id) {
  return PANEL_CONFIG.find((panel) => panel.id === id);
}

function readPanelLayout() {
  const defaults = Object.fromEntries(PANEL_CONFIG.map((panel) => [panel.id, panel.initial]));
  try {
    const saved = JSON.parse(localStorage.getItem('ctc-panel-layout') || '{}');
    const known = new Set(PANEL_CONFIG.map((panel) => panel.id));
    const collapsed = new Set((saved.collapsed || []).filter((id) => known.has(id)));
    if (collapsed.size === PANEL_CONFIG.length) collapsed.delete('operations');
    return {
      widths: Object.fromEntries(PANEL_CONFIG.map((panel) => [panel.id, Number(saved.widths?.[panel.id]) || defaults[panel.id]])),
      collapsed,
    };
  } catch {
    return { widths: defaults, collapsed: new Set() };
  }
}

const panelLayout = readPanelLayout();

function savePanelLayout() {
  try {
    localStorage.setItem('ctc-panel-layout', JSON.stringify({
      widths: panelLayout.widths,
      collapsed: [...panelLayout.collapsed],
    }));
  } catch {
    // The layout remains usable even when browser storage is unavailable.
  }
}

function applyPanelLayout() {
  const openPanels = PANEL_CONFIG.filter((panel) => !panelLayout.collapsed.has(panel.id));
  const available = Math.max(288, $('workspace').clientWidth - PANEL_RESIZER_WIDTH * 2);
  const openAvailable = Math.max(96, available - panelLayout.collapsed.size * PANEL_COLLAPSED_WIDTH);
  const minTotal = openPanels.reduce((sum, panel) => sum + panel.min, 0);
  const minScale = minTotal > openAvailable ? openAvailable / minTotal : 1;
  const minimums = Object.fromEntries(openPanels.map((panel) => [panel.id, Math.max(96, Math.floor(panel.min * minScale))]));
  const rendered = {};

  for (const panel of PANEL_CONFIG) {
    rendered[panel.id] = panelLayout.collapsed.has(panel.id)
      ? PANEL_COLLAPSED_WIDTH
      : Math.max(minimums[panel.id], Number(panelLayout.widths[panel.id]) || panel.initial);
  }

  const openTotal = openPanels.reduce((sum, panel) => sum + rendered[panel.id], 0);
  if (openTotal > openAvailable) {
    let excess = openTotal - openAvailable;
    for (let index = openPanels.length - 1; index >= 0 && excess > 0; index -= 1) {
      const panel = openPanels[index];
      const room = rendered[panel.id] - minimums[panel.id];
      const amount = Math.min(room, excess);
      rendered[panel.id] -= amount;
      excess -= amount;
    }
  } else if (openPanels.length) {
    rendered[openPanels.at(-1).id] += openAvailable - openTotal;
  }

  for (const panel of PANEL_CONFIG) {
    const collapsed = panelLayout.collapsed.has(panel.id);
    const element = $(panel.elementId);
    element.classList.toggle('is-collapsed', collapsed);
    element.style.flexBasis = `${Math.round(rendered[panel.id])}px`;
    if (!collapsed) panelLayout.widths[panel.id] = rendered[panel.id];
    document.querySelectorAll(`[data-panel-toggle="${panel.id}"]`).forEach((button) => {
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'}${panel.label}区域`);
      button.title = `${collapsed ? '展开' : '折叠'}${panel.label}区域`;
    });
  }

  document.querySelectorAll('[data-resizer]').forEach((resizer) => {
    const pair = PANEL_PAIRS[resizer.dataset.resizer];
    const disabled = pair.some((id) => panelLayout.collapsed.has(id));
    resizer.classList.toggle('disabled', disabled);
    resizer.setAttribute('aria-disabled', String(disabled));
    resizer.setAttribute('aria-valuenow', String(Math.round($(panelConfig(pair[0]).elementId).getBoundingClientRect().width)));
  });
  savePanelLayout();
}

function resizePanelPair(resizer, delta) {
  const [leftId, rightId] = PANEL_PAIRS[resizer.dataset.resizer];
  if (panelLayout.collapsed.has(leftId) || panelLayout.collapsed.has(rightId)) return;
  const left = $(panelConfig(leftId).elementId);
  const right = $(panelConfig(rightId).elementId);
  const pairWidth = left.getBoundingClientRect().width + right.getBoundingClientRect().width;
  const leftMin = Math.min(panelConfig(leftId).min, Math.max(96, pairWidth - panelConfig(rightId).min));
  const rightMin = Math.min(panelConfig(rightId).min, Math.max(96, pairWidth - leftMin));
  const nextLeft = Math.max(leftMin, Math.min(pairWidth - rightMin, left.getBoundingClientRect().width + delta));
  const nextRight = pairWidth - nextLeft;
  panelLayout.widths[leftId] = nextLeft;
  panelLayout.widths[rightId] = nextRight;
  left.style.flexBasis = `${Math.round(nextLeft)}px`;
  right.style.flexBasis = `${Math.round(nextRight)}px`;
  resizer.setAttribute('aria-valuenow', String(Math.round(nextLeft)));
  savePanelLayout();
}

function initPanelLayout() {
  document.querySelectorAll('[data-panel-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.panelToggle;
      if (panelLayout.collapsed.has(id)) panelLayout.collapsed.delete(id);
      else if (panelLayout.collapsed.size < PANEL_CONFIG.length - 1) panelLayout.collapsed.add(id);
      else setAlert('至少保留一个区域展开。');
      applyPanelLayout();
    });
  });

  document.querySelectorAll('[data-resizer]').forEach((resizer) => {
    resizer.addEventListener('pointerdown', (event) => {
      if (resizer.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      let previousX = event.clientX;
      resizer.setPointerCapture(event.pointerId);
      resizer.classList.add('dragging');
      document.body.classList.add('resizing-panels');
      const move = (moveEvent) => {
        resizePanelPair(resizer, moveEvent.clientX - previousX);
        previousX = moveEvent.clientX;
      };
      const finish = () => {
        resizer.classList.remove('dragging');
        document.body.classList.remove('resizing-panels');
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', finish);
        resizer.removeEventListener('pointercancel', finish);
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', finish);
      resizer.addEventListener('pointercancel', finish);
    });
    resizer.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || resizer.getAttribute('aria-disabled') === 'true') return;
      event.preventDefault();
      resizePanelPair(resizer, event.key === 'ArrowLeft' ? -24 : 24);
    });
  });

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(applyPanelLayout);
  });
  applyPanelLayout();
}

function initTheme() {
  const applyIcon = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    $('themeIcon').innerHTML = dark
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
      : '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>';
  };
  const saved = localStorage.getItem('ctc-theme');
  const initial = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', initial);
  applyIcon();
  $('themeButton').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('ctc-theme', next);
    applyIcon();
  });
}

function setAlert(message, type = 'error') {
  const alert = $('alert');
  alert.textContent = message;
  alert.className = `alert ${type}`;
  if (!message) alert.classList.add('hidden');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `Request failed: ${response.status}`);
  }
  return body;
}

async function apiDownload(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody?.error?.message || `Request failed: ${response.status}`);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'codex-context.txt';
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { fileName, recordCount: Number(response.headers.get('x-context-record-count') || 0) };
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function selectorForTurn(turn) {
  if (turn.turnId) return { turnId: turn.turnId };
  return { startLine: turn.startLine };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const OPERATION_STATUS = {
  completed: ['已完成', 'status-completed'],
  failed: ['失败', 'status-failed'],
  interrupted: ['已中断', 'status-interrupted'],
  running: ['执行中', 'status-running'],
  undone: ['已撤销', 'status-undone'],
};

function operationResultText(operation) {
  if (operation.status === 'failed') return operation.error?.message || '操作失败，未记录详细原因。';
  if (operation.status === 'interrupted') return '服务在操作完成记录写入前退出，请到备份管理核对相关安全备份。';
  if (operation.status === 'running') return '操作仍在当前服务实例中执行。';
  if (operation.status === 'undone') return `已由操作 ${String(operation.undoOperationId || '').slice(0, 8)} 撤销。`;
  const result = operation.result || {};
  if (operation.kind === 'history_error_delete') return `已删除分页历史失败轮次 ${result.turnId || ''}；可单独恢复，不受后续操作影响。`;
  if (operation.kind === 'history_error_restore') return `已恢复分页历史失败轮次 ${result.turnId || ''}。`;
  if (result.claudeRestartRecommended || result.claudeRefreshRecommended) return 'Claude 会话数据已写入；需要退出或重新打开 Claude Code 才能看到最终状态。';
  if (result.restartRequired || result.codexRefreshRecommended) return '数据已写入；重新打开相关目标会话时 Codex 会读取最终状态，其他窗口无需退出。';
  if (result.count !== undefined) return `处理 ${result.count} 项。`;
  if (result.deleted) return '删除已完成，并已记录删除结果。';
  if (result.restored) return '恢复已完成。';
  return '操作已完成。';
}

function operationDetailsText(operation) {
  const details = operation.details || {};
  const titles = details.sessionTitles || {};
  const titleText = Object.entries(titles).map(([id, title]) => `${title} (${String(id).slice(0, 8)})`).join('、');
  const parts = [];
  if (titleText) parts.push(`会话：${titleText}`);
  if (details.turnId) parts.push(`轮次：${details.turnId}`);
  if (details.selector) parts.push(`轮次：${details.selector.turnId || (details.selector.index !== undefined ? `第 ${Number(details.selector.index) + 1} 轮` : '已选轮次')}`);
  if (details.mode) parts.push(`模式：${details.mode === 'single' ? '仅此轮' : details.mode === 'truncate' ? '此轮及之后' : details.mode}`);
  if (details.originalOperationId) parts.push(`来源操作：${String(details.originalOperationId).slice(0, 8)}`);
  return parts.join(' · ');
}

function renderOperationHistory() {
  const history = state.operationHistory;
  const list = history?.operations || [];
  if (!history) {
    $('operationHistorySummary').textContent = '正在读取本工具执行过的写操作...';
    $('operationHistoryList').innerHTML = '<div class="list-status">正在读取...</div>';
    return;
  }
  const summary = history.summary;
  $('operationHistorySummary').textContent = `${summary.total} 次操作 · ${summary.failed} 次失败 · ${summary.interrupted} 次中断 · ${summary.undone} 次已撤销`;
  $('operationHistoryList').innerHTML = list.length ? list.map((operation) => {
    const [statusLabel, statusClass] = OPERATION_STATUS[operation.status] || [operation.status, ''];
    const sessionText = operation.sessionIds?.length
      ? `${operation.sessionIds.length} 个会话 · ${operation.sessionIds.map((id) => operation.details?.sessionTitles?.[id] || state.sessions.find((session) => session.id === id)?.title || String(id).slice(0, 8)).join('、')}`
      : '未指定会话';
    return `
      <article class="operation-history-entry">
        <div class="operation-history-main">
          <strong>${escapeHtml(operation.label || operation.kind)}</strong>
          <span class="operation-status ${statusClass}">${escapeHtml(statusLabel)}</span>
          ${operation.canUndo ? '<span class="operation-reversible">可回退此操作</span>' : ''}
        </div>
        <div class="operation-history-meta">${escapeHtml(formatDate(operation.startedAt))} · ${escapeHtml(sessionText)}</div>
        ${operationDetailsText(operation) ? `<div class="operation-history-details">${escapeHtml(operationDetailsText(operation))}</div>` : ''}
        <p>${escapeHtml(operationResultText(operation))}</p>
        ${operation.canUndo && !operation.isLatest ? `<button type="button" class="btn btn-sm outline-accent" data-undo-operation="${escapeHtml(operation.id)}">回退此操作</button>` : ''}
      </article>`;
  }).join('') : '<div class="list-status">还没有写操作记录。预览、扫描和刷新不会记入这里。</div>';

  const latest = history.latest;
  const canUndo = Boolean(latest?.canUndo);
  $('operationUndoPanel').classList.toggle('hidden', !canUndo);
  $('operationUndoConfirmation').value = '';
  $('undoLatestOperationButton').disabled = true;
  if (canUndo) {
    $('operationUndoTitle').textContent = `撤销最近操作：${latest.label}`;
    $('operationUndoDescription').textContent = '回退最新写操作；也可以在下方每条已完成操作旁单独回退。工具会再次校验快照和当前状态，发生冲突时不会覆盖。';
  }
}

async function restoreHistoryErrorOperation(operationId) {
  if (!operationId || !window.confirm('恢复这次删除的分页历史失败轮次？只恢复该轮次及其关联分页项目。')) return;
  const result = await api('/api/operation-history/restore-history-error', {
    method: 'POST',
    body: JSON.stringify({ operationId, confirmation: 'RESTORE' }),
  });
  state.lastHistoryErrorDeletion = null;
  state.operationHistory = await api('/api/operation-history?limit=100');
  if ($('operationHistoryDialog').open) renderOperationHistory();
  if (state.selectedSession) await loadTurns();
  setAlert(`已恢复分页历史失败轮次 ${result.turnId || ''}。`, 'success');
}

async function undoOperation(operationId) {
  if (!operationId || !window.confirm('回退这条操作？工具会重新校验安全快照与当前数据，冲突时不会覆盖。')) return;
  const result = await api('/api/operation-history/undo', {
    method: 'POST',
    body: JSON.stringify({ operationId, confirmation: 'UNDO' }),
  });
  state.operationHistory = await api('/api/operation-history?limit=100');
  renderOperationHistory();
  if (state.selectedSession) await loadTurns();
  setAlert(`已回退操作 ${operationId.slice(0, 8)}。`, 'success');
}

async function openOperationHistory() {
  setAlert('');
  state.operationHistory = null;
  renderOperationHistory();
  $('operationHistoryDialog').showModal();
  state.operationHistory = await api('/api/operation-history?limit=100');
  renderOperationHistory();
}

function closeOperationHistory() {
  $('operationHistoryDialog').close();
}

async function undoLatestOperation() {
  const latest = state.operationHistory?.latest;
  if (!latest?.canUndo) return;
  const result = await api('/api/operation-history/undo-latest', {
    method: 'POST',
    body: JSON.stringify({
      operationId: latest.id,
      confirmation: $('operationUndoConfirmation').value,
    }),
  });
  state.operationHistory = await api('/api/operation-history?limit=100');
  renderOperationHistory();
  await loadSessions();
  const refreshMessage = result.restartRequired
    ? ' 请重新打开相关目标会话，以读取恢复后的状态；其他 Codex 窗口无需退出。'
    : (result.claudeRestartRecommended
      ? ' 请退出或重新打开 Claude Code，以读取恢复后的会话。'
      : ' 请重新打开相关目标会话；其他 Codex 窗口无需退出。');
  setAlert(`已撤销“${latest.label}”。${refreshMessage}`, 'success');
}

function setOperationView(operation) {
  state.operation = operation;
  const messagesActive = operation === 'messages';
  $('messagesView').classList.toggle('hidden', !messagesActive);
  $('cleanupView').classList.toggle('hidden', messagesActive);
  $('messagesTabButton').classList.toggle('active', messagesActive);
  $('cleanupTabButton').classList.toggle('active', !messagesActive);
  $('messagesTabButton').setAttribute('aria-selected', String(messagesActive));
  $('cleanupTabButton').setAttribute('aria-selected', String(!messagesActive));
  $('modeBadge').textContent = messagesActive
    ? '编辑模式'
    : (state.mode === 'single' ? '删除模式 · B' : '删除模式 · A');
}

function resetCleanupPreview() {
  state.preview = null;
  state.cleanupSourceHash = null;
  state.cleanupTargetActive = false;
  $('previewTurn').textContent = '-';
  $('previewLines').textContent = '-';
  $('previewRecords').textContent = '-';
  $('previewNext').textContent = '-';
  $('previewBackup').textContent = '-';
  $('modeWarning').textContent = '';
  $('modeWarning').className = 'mode-warning hidden';
  $('confirmation').value = '';
  $('applyButton').disabled = true;
  $('cleanupTabButton').disabled = !state.selectedTurn;
  $('result').textContent = '';
}

function storageStatusLabel(session) {
  if (session.storageStatus === 'live') return '活动';
  if (session.storageStatus === 'archived') return '已归档';
  if (session.storageStatus === 'backup_only') return '仅备份';
  if (session.storageStatus === 'sqlite_only') return '仅 SQLite';
  return '仅旧索引';
}

function isSessionDeletable(session) {
  return Boolean(
    session?.hasRollout
    || session?.sqliteIndexed
    || session?.indexed
    || session?.backupPaths?.some((item) => item.sourceKind === 'cleaner_backup'),
  );
}

function clearEditPreview() {
  state.editPreview = null;
  $('editPreview').classList.add('hidden');
  $('editChanges').innerHTML = '';
  $('editSessionWarning').textContent = '';
  $('editSessionWarning').className = 'mode-warning hidden';
  $('editConfirmation').value = '';
  $('applyEditButton').disabled = true;
}

function resetMessageEditor({ keepLastEdit = false } = {}) {
  state.turnDetail = null;
  state.fullContext = null;
  state.fullContextRequestId += 1;
  clearTimeout(state.fullContextSearchTimer);
  state.edits = new Map();
  clearEditPreview();
  if (!keepLastEdit) state.lastEdit = null;
  $('messageList').innerHTML = '<div class="list-status">请选择一个轮次。</div>';
  $('fullContextList').innerHTML = '<div class="list-status">请选择一个轮次。</div>';
  $('fullContextSensitiveWarning').textContent = '';
  $('fullContextSensitiveWarning').classList.add('hidden');
  setFullContextControlsEnabled(false);
  $('compactContextButton').disabled = true;
  $('fullContextButton').disabled = true;
  $('contextModeSummary').textContent = '请选择一个轮次';
  $('editActions').classList.add('hidden');
  $('previewEditsButton').disabled = true;
  $('editResult').classList.add('hidden');
  $('editResultText').textContent = '';
  $('restoreEditButton').disabled = true;
}

function resetTurnWorkspace({ keepLastEdit = false } = {}) {
  state.selectedTurn = null;
  resetCleanupPreview();
  resetMessageEditor({ keepLastEdit });
  setOperationView('messages');
}

function normalizedDirectory(value) {
  return displayPath(value)
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function sessionMatchesDirectory(session) {
  if (state.selectedDirectory === '*') return true;
  if (isClaudePlatform()) return normalizedDirectory(session.projectPath) === normalizedDirectory(state.selectedDirectory);
  if (state.selectedDirectory === '__backup_only__') return session.storageStatus === 'backup_only';
  if (state.selectedDirectory === '__unknown__') return !session.projectPath;
  return normalizedDirectory(session.projectPath) === normalizedDirectory(state.selectedDirectory);
}

function updateBatchControls() {
  const selectedCount = state.selectedSessionIds.size;
  $('selectedSessionCount').textContent = `已选 ${selectedCount}`;
  $('clearSessionSelectionButton').disabled = selectedCount === 0;
  $('batchDeleteSessionsButton').disabled = selectedCount === 0;
  const visible = state.visibleSessionIds;
  const selectedVisible = visible.filter((id) => state.selectedSessionIds.has(id)).length;
  $('selectVisibleSessions').checked = visible.length > 0 && selectedVisible === visible.length;
  $('selectVisibleSessions').indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  $('selectVisibleSessions').disabled = visible.length === 0;
}

function renderDirectories() {
  if (isClaudePlatform()) {
    const options = [
      '<option value="">选择目录...</option>',
      `<option value="*">全部目录 (${state.sessions.length})</option>`,
      ...state.directories.map((directory) => (
        `<option value="${escapeHtml(directory.path)}">${escapeHtml(displayPath(directory.path))} (${directory.count})</option>`
      )),
    ];
    $('directoryFilter').innerHTML = options.join('');
    const matchingDirectory = state.directories.find(
      (directory) => normalizedDirectory(directory.path) === normalizedDirectory(state.selectedDirectory),
    );
    if (matchingDirectory) state.selectedDirectory = matchingDirectory.path;
    if (state.selectedDirectory !== '*' && !matchingDirectory) state.selectedDirectory = '*';
    $('directoryFilter').value = state.selectedDirectory;
    $('sessionFilter').disabled = !state.selectedDirectory;
    return;
  }
  const unknownCount = state.sessions.filter((session) => !session.projectPath).length;
  const backupOnlyCount = state.sessions.filter((session) => session.storageStatus === 'backup_only').length;
  const options = [
    '<option value="">选择目录...</option>',
    `<option value="*">全部目录 (${state.sessions.length})</option>`,
    ...(backupOnlyCount
      ? [`<option value="__backup_only__">仅备份会话 (${backupOnlyCount})</option>`]
      : []),
    ...state.directories.map((directory) => (
      `<option value="${escapeHtml(directory.path)}">${escapeHtml(directory.path)} (${directory.count})</option>`
    )),
  ];
  if (unknownCount) options.push(`<option value="__unknown__">未标记目录 (${unknownCount})</option>`);
  $('directoryFilter').innerHTML = options.join('');

  const matchingDirectory = state.directories.find(
    (directory) => normalizedDirectory(directory.path) === normalizedDirectory(state.selectedDirectory),
  );
  if (matchingDirectory) state.selectedDirectory = matchingDirectory.path;
  const available = state.selectedDirectory === '*'
    || (state.selectedDirectory === '__backup_only__' && backupOnlyCount > 0)
    || state.selectedDirectory === '__unknown__'
    || Boolean(matchingDirectory);
  if (!available) state.selectedDirectory = '*';
  $('directoryFilter').value = state.selectedDirectory;
  $('sessionFilter').disabled = !state.selectedDirectory;
}

function claudeTitleSourceLabel(source) {
  const labels = {
    'custom-title': '自定义标题',
    'sessions-index': 'Claude 摘要',
    'first-user-message': '首条消息回退',
    fallback: '无标题',
  };
  return labels[source] || source || '未知标题来源';
}

function renderClaudeSessions() {
  const filter = $('sessionFilter').value.trim().toLowerCase();
  const directorySessions = state.sessions.filter(sessionMatchesDirectory);
  const sessions = directorySessions.filter((session) => (
    `${session.title || ''} ${session.id || ''} ${session.projectPath || ''} ${session.projectKey || ''} ${session.gitBranch || ''}`
      .toLowerCase()
      .includes(filter)
  ));
  state.visibleSessionIds = sessions.map((session) => session.id);
  updateBatchControls();
  $('sessionCount').textContent = filter ? `${sessions.length} / ${directorySessions.length}` : `${sessions.length} 个会话`;
  if (!sessions.length) {
    state.visibleSessionIds = [];
    updateBatchControls();
    $('sessions').innerHTML = '<div class="list-status">当前目录没有匹配的 Claude Code 会话。</div>';
    return;
  }
  $('sessions').innerHTML = sessions.map((session) => {
    const selected = state.selectedSession?.id === session.id ? ' selected' : '';
    const checked = state.selectedSessionIds.has(session.id) ? ' checked' : '';
    const health = session.health || { state: 'attention', label: '需诊断', summary: '缺少健康信息。' };
    return `
      <div class="session-entry claude-session-entry">
        <input type="checkbox" aria-label="选择 Claude 会话 ${escapeHtml(session.title || session.id)}" data-session-select="${escapeHtml(session.id)}"${checked}>
        <button class="session-row${selected}" type="button" data-session-id="${escapeHtml(session.id)}">
          <span class="session-title" title="${escapeHtml(session.title)}">${escapeHtml(session.title || '(无标题会话)')}</span>
          <span class="session-project">${escapeHtml(displayPath(session.projectPath) || session.projectKey || '未知项目目录')}</span>
          <span class="session-meta">${escapeHtml([
            formatDate(session.updatedAt),
            `${session.turnCount} 轮`,
            `${session.recordCount} 条记录`,
            session.subagentCount ? `${session.subagentCount} 个子代理` : '',
            session.persistedOutputCount ? `${session.persistedOutputCount} 个外置结果` : '',
            claudeTitleSourceLabel(session.titleSource),
          ].filter(Boolean).join(' · '))}</span>
          <span class="claude-storage-strip"><span>主文件 ${escapeHtml(formatBytes(session.mainFileBytes))}</span><span>会话数据包 ${escapeHtml(formatBytes(session.totalBytes))}</span>${session.gitBranch ? `<span>分支 ${escapeHtml(session.gitBranch)}</span>` : ''}</span>
          <span class="session-id">${escapeHtml(session.id)}</span>
        </button>
        <button class="session-health-button health-${escapeHtml(health.state)}" type="button" data-session-health="${escapeHtml(session.id)}" title="${escapeHtml(`${health.label}：${health.summary}`)}" aria-label="诊断 Claude 会话 ${escapeHtml(session.title || session.id)}">
          <span class="health-dot" aria-hidden="true"></span><span>诊断</span>
        </button>
      </div>
    `;
  }).join('');
}

function renderSessions() {
  if (isClaudePlatform()) {
    renderClaudeSessions();
    return;
  }
  const filter = $('sessionFilter').value.trim().toLowerCase();
  if (!state.selectedDirectory) {
    state.visibleSessionIds = [];
    updateBatchControls();
    $('sessionCount').textContent = `${state.directories.length} 个目录`;
    $('sessions').innerHTML = '<div class="list-status">请先选择项目目录。</div>';
    return;
  }

  const directorySessions = state.sessions.filter(sessionMatchesDirectory);
  const sessions = directorySessions.filter((session) => {
    const haystack = `${session.title || ''} ${session.id || ''} ${session.projectPath || ''} ${session.source || ''} ${session.threadSource || ''} ${session.storageStatus || ''} ${storageStatusLabel(session)}`.toLowerCase();
    return haystack.includes(filter);
  });
  state.visibleSessionIds = sessions.filter(isSessionDeletable).map((session) => session.id);
  updateBatchControls();

  $('sessionCount').textContent = filter
    ? `${sessions.length} / ${directorySessions.length}`
    : `${sessions.length} 个会话`;
  if (!sessions.length) {
    $('sessions').innerHTML = '<div class="list-status">当前目录没有匹配的会话。</div>';
    return;
  }

  $('sessions').innerHTML = sessions.map((session) => {
    const selected = state.selectedSession?.id === session.id ? ' selected' : '';
    const checked = state.selectedSessionIds.has(session.id) ? ' checked' : '';
    const deletable = isSessionDeletable(session);
    const checkboxHint = deletable
      ? `选择会话 ${session.title || session.id}`
      : '该条目只存在于不受本工具管理的外部备份';
    const health = session.health || {
      state: session.codexVisible ? 'healthy' : 'attention',
      label: session.codexVisible ? '正常' : '需诊断',
      summary: '打开诊断查看各数据来源。',
    };
    return `
      <div class="session-entry">
        <input type="checkbox" aria-label="${escapeHtml(checkboxHint)}" title="${escapeHtml(checkboxHint)}" data-session-select="${escapeHtml(session.id)}"${checked}${deletable ? '' : ' disabled'}>
        <button class="session-row${selected}" type="button" data-session-id="${escapeHtml(session.id)}">
          <span class="session-title" title="${escapeHtml(session.title || '(untitled)')}">${escapeHtml(session.title || '(untitled)')}</span>
          <span class="session-project">${escapeHtml(displayPath(session.projectPath) || '未知项目目录')}</span>
          <span class="session-meta">${escapeHtml([
            formatDate(session.updatedAt),
            storageStatusLabel(session),
            session.modelProvider
              ? `会话供应商 ${session.modelProvider}`
              : (session.sqliteProvider ? `索引供应商 ${session.sqliteProvider}` : ''),
            session.modelProvider && session.sqliteProvider && session.modelProvider !== session.sqliteProvider
              ? `索引供应商 ${session.sqliteProvider}`
              : '',
            session.codexVisible ? 'Codex 可见' : (session.hasRollout ? 'Codex 隐藏' : '无正文'),
            session.recoverableFromBackup ? '可从备份恢复' : '',
            session.threadSource === 'subagent' ? '子代理' : '',
            session.indexed ? '' : '由 rollout 恢复',
            `健康 ${health.label}`,
          ].filter(Boolean).join(' · '))}</span>
          <span class="session-id">${escapeHtml(session.id || '')}</span>
        </button>
        <button class="session-health-button health-${escapeHtml(health.state)}" type="button" data-session-health="${escapeHtml(session.id)}" title="${escapeHtml(`${health.label}：${health.summary}`)}" aria-label="诊断会话 ${escapeHtml(session.title || session.id)}">
          <span class="health-dot" aria-hidden="true"></span><span>诊断</span>
        </button>
      </div>
    `;
  }).join('');
}

function healthSourceStatus(status) {
  const labels = {
    present: '存在',
    archived: '已归档',
    missing: '缺失',
    row_missing: '文件存在，记录缺失',
    file_missing: '索引文件缺失',
    database_missing: '数据库文件缺失',
    consistent: '一致',
    mismatch: '不一致',
  };
  return labels[status] || status || '未知';
}

function healthSourceCard(label, status, rows, tone = '') {
  return `
    <article class="health-source-card${tone ? ` ${tone}` : ''}">
      <header><strong>${escapeHtml(label)}</strong><span>${escapeHtml(healthSourceStatus(status))}</span></header>
      <dl>${rows.filter((row) => row[1] !== null && row[1] !== undefined && row[1] !== '').map(([name, value, pathValue]) => `
        <dt>${escapeHtml(name)}</dt><dd${pathValue ? ' class="health-path"' : ''} title="${escapeHtml(String(value))}">${escapeHtml(pathValue ? displayPath(value) : value)}</dd>
      `).join('')}</dl>
    </article>
  `;
}

function renderSessionHealth(diagnosis) {
  state.healthDiagnosis = diagnosis;
  const session = diagnosis.session;
  const summary = diagnosis.summary;
  $('sessionHealthTitle').textContent = session.title || session.id;
  $('sessionHealthSubtitle').textContent = displayPath(session.projectPath) || '未标记项目目录';
  $('sessionHealthState').textContent = summary.label;
  $('sessionHealthState').className = `health-state health-${summary.state}`;
  $('sessionHealthSummary').textContent = summary.summary;
  $('sessionHealthIdentity').textContent = `${session.id} · 当前供应商 ${diagnosis.currentProvider || '未知'} · ${summary.codexVisible ? 'Codex 可见' : 'Codex 当前不可见'}`;

  $('sessionHealthFindings').innerHTML = diagnosis.findings.length
    ? diagnosis.findings.map((item) => `
      <article class="health-finding severity-${item.severity}">
        <span class="health-finding-level">${item.severity === 'critical' ? '严重' : (item.severity === 'warning' ? '注意' : '说明')}</span>
        <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.explanation)}</p></div>
      </article>
    `).join('')
    : '<div class="health-empty">未发现异常，也没有额外说明。</div>';

  const { rollout, sqlite, legacyIndex, backups, provider } = diagnosis.sources;
  const sourceCards = [
    healthSourceCard('rollout 正文', rollout.status, [
      ['路径', rollout.path, true],
      ['供应商', rollout.provider],
      ['大小', rollout.exists ? formatBytes(rollout.sizeBytes) : null],
      ['修改时间', rollout.updatedAt ? formatDate(rollout.updatedAt) : null],
    ], rollout.exists ? 'source-ok' : 'source-missing'),
    healthSourceCard('SQLite 线程记录', sqlite.status, [
      ['数据库', sqlite.database.path, true],
      ['rollout_path', sqlite.rolloutPath, true],
      ['标题', sqlite.title],
      ['供应商', sqlite.provider],
      ['来源', sqlite.source],
    ], sqlite.status === 'present' ? 'source-ok' : 'source-missing'),
    healthSourceCard('旧标题索引', legacyIndex.status, [
      ['文件', legacyIndex.file.path, true],
      ['标题', legacyIndex.title],
      ['修改时间', legacyIndex.file.updatedAt ? formatDate(legacyIndex.file.updatedAt) : null],
    ], legacyIndex.status === 'present' ? 'source-ok' : ''),
    healthSourceCard('供应商关系', provider.consistent ? 'consistent' : 'mismatch', [
      ['当前配置', provider.current],
      ['rollout', provider.rollout],
      ['SQLite', provider.sqlite],
      ['最新备份', provider.backup],
    ], provider.consistent ? 'source-ok' : 'source-missing'),
  ];
  if (backups.entries.length) {
    sourceCards.push(`
      <article class="health-source-card health-backups source-ok">
        <header><strong>历史备份</strong><span>${backups.count} 份</span></header>
        <div class="health-backup-list">${backups.entries.map((backup) => `
          <div>
            <strong>${backup.sourceKind === 'cc_switch_backup' ? 'CCSwitch' : '本工具'} · ${formatBytes(backup.sizeBytes)}</strong>
            <span>${escapeHtml(formatDate(backup.updatedAt))} · ${escapeHtml(backup.provider || '供应商未知')}</span>
            <code title="${escapeHtml(backup.path)}">${escapeHtml(displayPath(backup.path))}</code>
          </div>
        `).join('')}</div>
      </article>
    `);
  } else {
    sourceCards.push(healthSourceCard('历史备份', backups.status, [['数量', '0 份']], 'source-missing'));
  }
  $('sessionHealthSources').innerHTML = sourceCards.join('');

  $('sessionHealthActions').innerHTML = diagnosis.actions.map((action) => `
    <div class="health-action-row">
      <button type="button" data-health-action="${escapeHtml(action.id)}"${action.available ? '' : ' disabled'}>${escapeHtml(action.label)}</button>
      <span>${escapeHtml(action.reason)}</span>
    </div>
  `).join('');
}

function renderClaudeSessionHealth(session) {
  const health = session.health || { state: 'attention', label: '需注意', summary: '缺少诊断结果。', findings: [] };
  $('sessionHealthTitle').textContent = session.title || session.id;
  $('sessionHealthSubtitle').textContent = displayPath(session.projectPath) || session.projectKey || '未知项目目录';
  $('sessionHealthState').textContent = health.label;
  $('sessionHealthState').className = `health-state health-${health.state}`;
  $('sessionHealthSummary').textContent = health.summary;
  $('sessionHealthIdentity').textContent = `${session.id} · ${session.resumable ? '具备原生恢复基础' : '原生恢复可能失败'} · 标题来源 ${claudeTitleSourceLabel(session.titleSource)}`;
  $('sessionHealthFindings').innerHTML = health.findings?.length
    ? health.findings.map((item) => `
      <article class="health-finding severity-${item.severity}">
        <span class="health-finding-level">${item.severity === 'critical' ? '严重' : '注意'}</span>
        <div><strong>${escapeHtml(item.message)}</strong><p>${escapeHtml(item.code)}</p></div>
      </article>
    `).join('')
    : '<div class="health-empty">主正文和已引用的侧边数据完整。</div>';
  $('sessionHealthSources').innerHTML = [
    healthSourceCard('主会话 JSONL', 'present', [
      ['路径', session.filePath, true],
      ['记录', `${session.recordCount} 条`],
      ['轮次', `${session.turnCount} 轮`],
      ['大小', formatBytes(session.mainFileBytes)],
    ], 'source-ok'),
    healthSourceCard('会话侧边目录', session.sidecars.exists ? 'present' : 'missing', [
      ['路径', session.sessionDir, true],
      ['文件', `${session.sidecars.fileCount} 个`],
      ['大小', formatBytes(session.sidecars.sizeBytes)],
      ['子代理', `${session.subagentCount} 个`],
      ['外置结果', `${session.persistedOutputCount} 个，缺失 ${session.missingPersistedOutputCount} 个`],
    ], session.sidecars.exists ? 'source-ok' : ''),
    healthSourceCard('Tasks', session.tasks.exists ? 'present' : 'missing', [
      ['文件', `${session.tasks.fileCount} 个`], ['大小', formatBytes(session.tasks.sizeBytes)],
    ]),
    healthSourceCard('File History', session.fileHistory.exists ? 'present' : 'missing', [
      ['文件', `${session.fileHistory.fileCount} 个`], ['大小', formatBytes(session.fileHistory.sizeBytes)],
    ]),
    healthSourceCard('Session Env', session.sessionEnv.exists ? 'present' : 'missing', [
      ['文件', `${session.sessionEnv.fileCount} 个`], ['大小', formatBytes(session.sessionEnv.sizeBytes)],
    ]),
  ].join('');
  $('sessionHealthActions').innerHTML = `
    <div class="health-action-row">
      <button type="button" data-health-action="view_context"${session.turnCount ? '' : ' disabled'}>查看落盘上下文</button>
      <span>查看操作本身只读，展示主会话、工具结果、运行时注入和关联子代理。</span>
    </div>
  `;
}

async function openSessionHealth(sessionId) {
  state.healthSessionId = sessionId;
  state.healthDiagnosis = null;
  const session = state.sessions.find((item) => item.id === sessionId);
  $('sessionHealthTitle').textContent = session?.title || '会话健康诊断';
  $('sessionHealthSubtitle').textContent = '正在读取会话的全部数据来源...';
  $('sessionHealthState').textContent = '读取中';
  $('sessionHealthState').className = 'health-state';
  $('sessionHealthSummary').textContent = '正在检查正文、SQLite、标题、供应商和备份。';
  $('sessionHealthIdentity').textContent = sessionId;
  $('sessionHealthFindings').innerHTML = '<div class="list-status">正在诊断...</div>';
  $('sessionHealthSources').innerHTML = '<div class="list-status">正在检查文件...</div>';
  $('sessionHealthActions').innerHTML = '';
  if (!$('sessionHealthDialog').open) $('sessionHealthDialog').showModal();
  if (isClaudePlatform()) {
    renderClaudeSessionHealth(session);
    return;
  }
  const diagnosis = await api(`/api/sessions/${encodeURIComponent(sessionId)}/health`);
  renderSessionHealth(diagnosis);
}

function closeSessionHealth() {
  state.healthDiagnosis = null;
  state.healthSessionId = null;
  $('sessionHealthDialog').close();
}

async function runHealthAction(actionId) {
  const sessionId = state.healthSessionId;
  if (!sessionId) return;
  closeSessionHealth();
  if (actionId === 'view_context') {
    await selectSession(sessionId);
    if (state.turns.length) {
      await selectTurn(0);
      await setContextMode('full');
    }
    return;
  }
  if (actionId === 'visibility_repair') {
    await previewVisibilityRepair();
    return;
  }
  if (actionId === 'open_backups') {
    state.backupManagerView = 'operation';
    await openBackupManager({ sessionId });
    return;
  }
  if (actionId === 'delete_session') {
    await selectSession(sessionId);
    await previewSessionDelete();
  }
}

function renderTurns(turns) {
  const historyErrors = state.historyErrors || [];
  $('turnCount').textContent = `${turns.length} 轮${historyErrors.length ? ` · ${historyErrors.length} 条分页失败` : ''}`;
  if (!turns.length && !historyErrors.length) {
    $('turns').className = 'turns-empty';
    $('turns').textContent = '没有识别到轮次边界。';
    return;
  }

  $('turns').className = 'turn-table';
  const sortedErrors = [...historyErrors].sort((left, right) => Number(left.rolloutOrdinal ?? Infinity) - Number(right.rolloutOrdinal ?? Infinity));
  const errorRows = sortedErrors.map((item) => `
    <div class="history-error-row" data-history-error-row="${escapeHtml(item.turnId || '')}">
      <span class="history-error-index">分页历史</span>
      <span class="history-error-time">rollout #${escapeHtml(String(item.rolloutOrdinal ?? '?'))}</span>
      <span class="history-error-detail"><strong>失败（仅来自 Codex 分页历史）</strong><code>${escapeHtml(item.turnId || '')}</code><span>${escapeHtml(item.error?.message || 'Codex 记录为失败')}</span></span>
      <button type="button" class="btn btn-sm danger-outline" data-delete-history-error="${escapeHtml(item.turnId || '')}">删除</button>
    </div>
  `);
  const rows = [];
  let errorIndex = 0;
  for (const turn of turns) {
    while (errorIndex < sortedErrors.length
      && turn.historyRolloutOrdinal != null
      && Number(sortedErrors[errorIndex].rolloutOrdinal ?? Infinity) < Number(turn.historyRolloutOrdinal)) {
      rows.push(errorRows[errorIndex++]);
    }
    rows.push(`
      <button class="turn-row${state.selectedTurn?.index === turn.index ? ' selected' : ''}${turn.status === 'failed' ? ' has-error' : ''}${turn.status === 'aborted' ? ' is-aborted' : ''}" type="button" data-turn-index="${turn.index}">
        <span>${turn.index + 1}</span>
        <span>${escapeHtml(formatDate(turn.timestamp))}</span>
        <span>${turn.startLine}-${turn.endLine}</span>
        <span>${turn.status === 'failed' ? '<strong class="turn-status-error">错误</strong> ' : (turn.status === 'aborted' ? '<strong class="turn-status-aborted">中止</strong> ' : '')}${escapeHtml(turn.summary || turn.turnId || '(无用户文本)')}</span>
      </button>
    `);
  }
  while (errorIndex < errorRows.length) rows.push(errorRows[errorIndex++]);
  const undoBanner = state.lastHistoryErrorDeletion ? `
    <div class="history-error-undo-banner">
      <span>刚刚删除了分页历史失败轮次 <code>${escapeHtml(state.lastHistoryErrorDeletion.turnId)}</code></span>
      <button type="button" class="btn btn-sm outline-accent" data-restore-history-operation="${escapeHtml(state.lastHistoryErrorDeletion.operationId)}">立即恢复</button>
    </div>
  ` : '';
  $('turns').innerHTML = undoBanner + `
    <div class="turn-header">
      <span>#</span><span>时间</span><span>行号</span><span>摘要</span>
    </div>
    ${rows.join('')}
  `;
}

async function deleteHistoryErrorTurn(turnId) {
  if (!state.selectedSession || !turnId) return;
  const confirmed = window.confirm('只删除该孤立失败轮次的 Codex 分页历史记录，不修改 rollout。删除前会自动备份，是否继续？');
  if (!confirmed) return;
  const body = await api(`/api/sessions/${encodeURIComponent(state.selectedSession.id)}/history-errors/${encodeURIComponent(turnId)}/delete`, {
    method: 'POST',
    body: JSON.stringify({ confirmation: 'DELETE' }),
  });
  state.lastHistoryErrorDeletion = { operationId: body.operationId, turnId };
  await loadTurns();
  setAlert(`已删除孤立失败轮次 ${body.turnId || turnId}；轮次列表顶部可立即恢复，操作历史中也有独立恢复按钮。`, 'success');
}

function renderCleanupPreview(body) {
  const preview = body.preview;
  const isSingle = preview.mode === 'delete_single_turn';
  $('previewSession').textContent = state.selectedSession?.title || state.selectedSession?.id || '-';
  $('previewTurn').textContent = preview.turn.summary || preview.turn.turnId || `line ${preview.startLine}`;
  $('previewLines').textContent = `${preview.startLine} - ${preview.endLine}`;
  $('previewRecords').textContent = `删除 ${preview.removedCount}，保留 ${preview.keptCount}`;
  $('previewNext').textContent = preview.nextTurn
    ? (preview.nextTurn.summary || preview.nextTurn.turnId || `第 ${preview.nextTurn.index + 1} 轮`)
    : '无';
  $('previewBackup').textContent = body.backupRoot || '-';
  if (state.operation === 'cleanup') $('modeBadge').textContent = isSingle ? '删除模式 · B' : '删除模式 · A';
  const targetActive = !isClaudePlatform() && Boolean(body.targetSessionLock?.activeSessionIds?.length);
  state.cleanupTargetActive = targetActive;
  if (targetActive) {
    $('modeWarning').textContent = '所选 Codex 会话仍在窗口中打开。请只关闭这个目标会话，然后重新预览；其他 Codex 窗口可以继续使用。';
    $('modeWarning').className = 'mode-warning warning';
  } else if (isClaudePlatform()) {
    const external = preview.externalArtifacts;
    const parts = [];
    if (external?.toolResultFiles?.length) parts.push(`${external.toolResultFiles.length} 个外置工具结果文件`);
    if (external?.subagents?.length) parts.push(`${external.subagents.length} 个子代理`);
    if (parts.length) {
      $('modeWarning').textContent = `本轮引用的外置产物将一并删除：${parts.join('、')}。删除时会同步清理这些文件，撤销可完整恢复。`;
      $('modeWarning').className = 'mode-warning warning';
    } else {
      $('modeWarning').textContent = '';
      $('modeWarning').className = 'mode-warning hidden';
    }
  } else if (isSingle && preview.keepsLaterTurns) {
    $('modeWarning').textContent = `警告：后续 ${preview.laterTurnCount} 轮将被保留，但其中可能引用本轮产生的上下文。只需关闭目标会话，其他 Codex 窗口可以继续使用。`;
    $('modeWarning').className = 'mode-warning warning';
  } else if (!isClaudePlatform()) {
    $('modeWarning').textContent = '只需关闭目标会话，其他 Codex 窗口可以继续使用。应用后重新打开目标会话，Codex 会从 rollout 重建分页历史。';
    $('modeWarning').className = 'mode-warning';
  } else {
    $('modeWarning').textContent = '';
    $('modeWarning').className = 'mode-warning hidden';
  }
  $('confirmation').value = '';
  $('applyButton').disabled = true;
  $('result').textContent = '';
}

function messageRoleLabel(message) {
  if (message.role === 'user') return '你';
  if (message.role === 'error') return message.phase === 'turn_aborted' ? 'Codex · 任务中止' : 'Codex · 错误';
  if (isClaudePlatform()) {
    if (message.phase === 'commentary') return 'Claude · 过程回复';
    if (message.phase === 'subagent') return 'Claude · 子代理';
    return 'Claude';
  }
  if (message.phase === 'commentary') return 'Codex · 过程回复';
  if (message.phase === 'final_answer') return 'Codex · 最终回复';
  return 'Codex';
}

function findMessagePart(targetId) {
  for (const message of state.turnDetail?.messages || []) {
    const part = message.parts.find((candidate) => candidate.targetId === targetId);
    if (part) return part;
  }
  return null;
}

function resizeMessageEditor(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 88), 360)}px`;
}

function renderMessages() {
  const messages = state.turnDetail?.messages || [];
  if (!messages.length) {
    $('messageList').innerHTML = '<div class="list-status">本轮没有可见的用户或 Codex 消息。</div>';
    $('editActions').classList.add('hidden');
    return;
  }

  $('messageList').innerHTML = messages.map((message) => `
    <article class="message-block role-${message.role}">
      <header class="message-head">
        <strong>${escapeHtml(messageRoleLabel(message))}</strong>
        <span>第 ${message.lineNumber} 行</span>
      </header>
      ${message.parts.map((part) => message.editable === false ? `
        <div class="message-part runtime-error-message"><pre>${escapeHtml(part.text)}</pre></div>
      ` : `
        <div class="message-part">
          <textarea data-message-target="${part.targetId}" readonly spellcheck="false">${escapeHtml(state.edits.get(part.targetId)?.newText ?? part.text)}</textarea>
          ${`<div class="message-actions">
            <button type="button" data-edit-target="${part.targetId}">编辑</button>
          </div>`}
        </div>
      `).join('')}
    </article>
  `).join('');
  $('editActions').classList.toggle('hidden', !messages.some((message) => message.editable !== false));
  $('messageList').querySelectorAll('textarea[data-message-target]').forEach(resizeMessageEditor);
  updateEditControls();
}

function contextScopeLabel(scope) {
  return scope === 'current_turn' ? '当前轮' : '此前上下文';
}

function contextCategoryLabel(category) {
  const labels = {
    prompt: '提示词',
    message: '消息',
    tool_call: '工具调用',
    tool_result: '工具结果',
    internal_event: '内部事件',
    conversation: '对话消息',
    runtime_injection: '运行时注入',
    client_event: '客户端事件',
  };
  return labels[category] || category;
}

function contextSourceLabel(source) {
  return {
    human: '人类',
    claude: 'Claude',
    tool: '工具',
    runtime: '运行时注入',
    client: 'Claude Code 客户端',
    subagent: '子代理',
  }[source] || source;
}

function setFullContextControlsEnabled(enabled) {
  [
    'fullContextSearch',
    'fullContextRoleFilter',
    'fullContextCategoryFilter',
    'fullContextCurrentOnly',
    'fullContextTurnJump',
    'fullContextLineJump',
    'fullContextLineJumpButton',
    'exportFullContextJsonlButton',
    'exportFullContextMarkdownButton',
    'fullContextFirstButton',
    'fullContextPreviousButton',
    'fullContextCurrentButton',
    'fullContextNextButton',
  ].forEach((id) => { $(id).disabled = !enabled; });
}

function syncFullContextTurnJump() {
  const select = $('fullContextTurnJump');
  select.innerHTML = state.turns.length
    ? state.turns.map((turn) => `<option value="${turn.index}">第 ${turn.index + 1} 轮 · ${escapeHtml(turn.summary || turn.turnId || '无标题')}</option>`).join('')
    : '<option value="">选择轮次…</option>';
  select.value = state.selectedTurn ? String(state.selectedTurn.index) : '';
}

function fullContextFilterPayload() {
  const value = $('fullContextRoleFilter').value;
  return {
    query: $('fullContextSearch').value.trim(),
    role: isClaudePlatform() ? 'all' : value,
    source: isClaudePlatform() ? value : 'all',
    category: $('fullContextCategoryFilter').value,
    scope: $('fullContextCurrentOnly').checked ? 'current_turn' : 'all',
  };
}

function highlightContextText(value, query) {
  const source = String(value || '');
  if (!query) return escapeHtml(source);
  const matcher = new RegExp(`(${escapeRegExp(query)})`, 'gi');
  return source.split(matcher).map((part, index) => (
    index % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)
  )).join('');
}

function formatRawContextRecord(raw) {
  const source = String(raw || '');
  if (source.length > 200_000) return source;
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

function renderFullContext() {
  const detail = state.fullContext;
  if (!detail) {
    $('fullContextList').innerHTML = '<div class="list-status">正在读取完整上下文...</div>';
    return;
  }

  const pageStart = detail.records.length ? detail.page.offset + 1 : 0;
  const pageEnd = detail.page.offset + detail.records.length;
  $('contextModeSummary').textContent = `筛选 ${detail.filteredRecordCount} / 上下文 ${detail.contextRecordCount} 条 · 当前页 ${pageStart}-${pageEnd}${detail.futureRecordCount ? ` · 当前轮后 ${detail.futureRecordCount} 条未纳入` : ''}`;
  $('fullContextFirstButton').disabled = detail.page.offset === 0;
  $('fullContextPreviousButton').disabled = detail.page.previousOffset === null;
  $('fullContextNextButton').disabled = detail.page.nextOffset === null;
  $('fullContextCurrentButton').disabled = detail.records.some((record) => record.lineNumber === state.selectedTurn.startLine);
  $('exportFullContextJsonlButton').disabled = detail.filteredRecordCount === 0;
  $('exportFullContextMarkdownButton').disabled = detail.filteredRecordCount === 0;

  const sensitiveWarning = $('fullContextSensitiveWarning');
  if (detail.sensitiveContextRecordCount > 0) {
    sensitiveWarning.textContent = `检测到 ${detail.sensitiveContextRecordCount} 条记录可能含密钥、令牌或密码字段；当前筛选结果中有 ${detail.sensitiveFilteredRecordCount} 条。导出或分享前请检查。`;
    sensitiveWarning.classList.remove('hidden');
  } else {
    sensitiveWarning.textContent = '';
    sensitiveWarning.classList.add('hidden');
  }

  if (!detail.records.length) {
    $('fullContextList').innerHTML = '<div class="list-status">当前筛选条件没有匹配记录。</div>';
    return;
  }

  $('fullContextList').innerHTML = detail.records.map((record) => {
    const normalizedQuery = detail.filters.query.toLocaleLowerCase();
    const textMatches = normalizedQuery && String(record.text || '').toLocaleLowerCase().includes(normalizedQuery);
    const rawOnlyMatch = normalizedQuery && !textMatches && String(record.raw || '').toLocaleLowerCase().includes(normalizedQuery);
    const metadata = [
      `第 ${record.lineNumber} 行`,
      record.stream && record.stream !== 'main' ? `stream=${record.stream}` : '',
      record.sourceLineNumber && record.sourceLineNumber !== record.lineNumber ? `源文件第 ${record.sourceLineNumber} 行` : '',
      record.type,
      record.source ? `来源=${contextSourceLabel(record.source)}` : '',
      record.role ? `role=${record.role}` : '',
      record.phase ? `phase=${record.phase}` : '',
      record.name ? `name=${record.name}` : '',
      record.turnId ? `turn=${record.turnId}` : '',
      contextCategoryLabel(record.category),
      rawOnlyMatch ? '匹配原始 JSON' : '',
    ].filter(Boolean).join(' · ');
    const textContent = highlightContextText(record.text, detail.filters.query);
    const largeToolResult = record.category === 'tool_result' && record.text?.length > 4_000;
    const textMarkup = !record.text
      ? ''
      : (largeToolResult
        ? `<details class="large-context-text"><summary>展开大型工具结果 · ${formatBytes(record.text.length)}</summary><pre>${textContent}</pre></details>`
        : `<pre class="full-context-text">${textContent}</pre>`);
    return `
      <article data-context-line="${record.lineNumber}" class="full-context-record scope-${record.scope}${record.type === 'session_meta' ? ' base-instructions' : ''}${record.hasSensitiveContent ? ' sensitive-record' : ''}${detail.page.lineFound === record.lineNumber ? ' jump-target' : ''}">
        <header class="full-context-record-head">
          <div>
            <strong>${escapeHtml(record.label)}</strong>
            <span>${escapeHtml(metadata)}</span>
          </div>
          <span class="full-context-badges">
            ${record.hasSensitiveContent ? `<span class="context-sensitive-badge" title="${escapeHtml(record.sensitiveKinds.join('、'))}">可能含敏感信息</span>` : ''}
            ${record.externalOutput ? `<span class="context-sensitive-badge">外置结果 ${escapeHtml(formatBytes(record.externalOutput.sizeBytes))}</span>` : ''}
            <span class="context-scope">${contextScopeLabel(record.scope)}</span>
          </span>
        </header>
        ${textMarkup}
        <details class="full-context-raw">
          <summary>查看完整原始 JSON${record.raw?.length > 200_000 ? ` · ${formatBytes(record.raw.length)}` : ''}</summary>
          <pre>${highlightContextText(formatRawContextRecord(record.raw), detail.filters.query)}</pre>
        </details>
      </article>
    `;
  }).join('');
  if (detail.page.lineFound) {
    requestAnimationFrame(() => {
      $('fullContextList').querySelector(`[data-context-line="${detail.page.lineFound}"]`)?.scrollIntoView({ block: 'center' });
    });
  }
}

function updateContextModeUI() {
  const full = state.contextMode === 'full';
  $('compactContextButton').classList.toggle('active', !full);
  $('fullContextButton').classList.toggle('active', full);
  $('compactContextButton').setAttribute('aria-selected', String(!full));
  $('fullContextButton').setAttribute('aria-selected', String(full));
  $('messageList').classList.toggle('hidden', full);
  $('fullContextView').classList.toggle('hidden', !full);
  if (full) {
    $('editActions').classList.add('hidden');
    $('editPreview').classList.add('hidden');
    $('editResult').classList.add('hidden');
    renderFullContext();
  } else if (state.turnDetail) {
    $('contextModeSummary').textContent = `${state.turnDetail.messageCount} 条可见消息`;
    renderMessages();
    if (state.editPreview) $('editPreview').classList.remove('hidden');
    renderEditResult();
  }
}

async function loadFullContext(offset = 0, options = {}) {
  if (!state.selectedSession || !state.selectedTurn) return;
  const requestId = ++state.fullContextRequestId;
  $('fullContextList').innerHTML = '<div class="list-status">正在读取完整上下文...</div>';
  try {
    let body;
    if (isClaudePlatform()) {
      const filters = fullContextFilterPayload();
      const params = new URLSearchParams({
        turnId: state.selectedTurn.turnId,
        offset: String(offset),
        limit: '50',
        query: filters.query,
        role: filters.role,
        source: filters.source,
        category: filters.category,
        scope: filters.scope,
      });
      if (options.lineNumber) params.set('lineNumber', String(options.lineNumber));
      body = await api(`/api/claude-code/sessions/${encodeURIComponent(state.selectedSession.id)}/context?${params}`);
    } else {
      body = await api('/api/full-context', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: state.selectedSession.id,
          selector: selectorForTurn(state.selectedTurn),
          offset,
          limit: 50,
          lineNumber: options.lineNumber,
          ...fullContextFilterPayload(),
        }),
      });
    }
    if (requestId !== state.fullContextRequestId) return;
    state.fullContext = body.detail;
    renderFullContext();
  } catch (error) {
    if (requestId === state.fullContextRequestId) {
      $('fullContextList').innerHTML = `<div class="list-status">${escapeHtml(error.message)}</div>`;
    }
    throw error;
  }
}

async function jumpToFullContextLine(lineNumber) {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new Error('请输入有效的正整数行号。');
  }
  $('fullContextSearch').value = '';
  $('fullContextRoleFilter').value = 'all';
  $('fullContextCategoryFilter').value = 'all';
  $('fullContextCurrentOnly').checked = false;
  await loadFullContext(0, { lineNumber });
}

async function exportFullContext(format) {
  if (!state.selectedSession || !state.selectedTurn) return;
  if (isClaudePlatform()) {
    setAlert('Claude Code 导出将在后续阶段加入；当前落盘模式已显示全部可读取内容。');
    return;
  }
  const buttons = [$('exportFullContextJsonlButton'), $('exportFullContextMarkdownButton')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await apiDownload('/api/full-context/export', {
      sessionId: state.selectedSession.id,
      selector: selectorForTurn(state.selectedTurn),
      format,
      ...fullContextFilterPayload(),
    });
    setAlert(`已导出 ${result.recordCount} 条上下文记录：${result.fileName}`, 'success');
  } finally {
    buttons.forEach((button) => { button.disabled = state.fullContext?.filteredRecordCount === 0; });
  }
}

async function setContextMode(mode) {
  state.contextMode = mode === 'full' ? 'full' : 'compact';
  updateContextModeUI();
  if (state.contextMode === 'full' && state.selectedTurn && !state.fullContext) {
    await loadFullContext(0);
  }
}

function updateEditControls() {
  $('previewEditsButton').disabled = state.edits.size === 0;
  $('discardEditsButton').disabled = state.edits.size === 0;
}

function editPayload() {
  return [...state.edits.values()];
}

function renderEditPreview(body) {
  const preview = body.preview;
  const targetActive = Boolean(body.targetSessionLock?.activeSessionIds?.length);
  state.editPreview = { ...preview, blockedByActiveTarget: targetActive };
  $('editChanges').innerHTML = preview.changes.map((change) => `
    <article class="edit-change">
      <div class="change-head">
        <strong>${escapeHtml(messageRoleLabel(change))}</strong>
        <span>第 ${change.lineNumber} 行</span>
      </div>
      <div class="change-version before">
        <span>修改前</span>
        <pre>${escapeHtml(change.before)}</pre>
      </div>
      <div class="change-version after">
        <span>修改后</span>
        <pre>${escapeHtml(change.after)}</pre>
      </div>
    </article>
  `).join('');
  $('editPreview').classList.remove('hidden');
  $('editSessionWarning').textContent = isClaudePlatform()
    ? '应用后会备份并改写 Claude 主会话 JSONL；如需恢复，可使用本次操作的回退。'
    : (targetActive
      ? '所选 Codex 会话仍在窗口中打开。请只关闭这个目标会话，然后重新预览；其他 Codex 窗口无需退出。'
      : '应用后工具会使所选会话的分页历史投影失效；重新打开该会话时 Codex 会从 rollout 重建。其他 Codex 窗口可保持打开。');
  $('editSessionWarning').className = `mode-warning${targetActive ? ' warning' : ''}`;
  $('editConfirmation').value = '';
  $('applyEditButton').disabled = true;
}

function renderEditResult() {
  if (!state.lastEdit) {
    $('editResult').classList.add('hidden');
    return;
  }
  $('editResultText').textContent = JSON.stringify({
    changedMessages: state.lastEdit.changedCount,
    backupFile: state.lastEdit.backupPath || state.lastEdit.backupDir,
  }, null, 2);
  $('editResult').classList.remove('hidden');
  $('restoreEditButton').disabled = false;
}

async function loadSessions() {
  setAlert('');
  resetTurnWorkspace();
  $('sessions').innerHTML = `<div class="list-status">正在扫描 ${isClaudePlatform() ? 'Claude Code' : 'Codex'} 会话...</div>`;
  $('sessionCount').textContent = '正在扫描...';
  $('turns').className = 'turns-empty';
  $('turns').textContent = '请选择一个会话。';
  $('turnCount').textContent = '尚未选择会话';
  $('turnContext').classList.add('hidden');
  const body = await api(isClaudePlatform() ? '/api/claude-code/sessions' : '/api/sessions');
  state.sessions = body.sessions;
  state.directories = mergeDirectories(body.directories || []);
  if (isClaudePlatform()) {
    const availableSessionIds = new Set(state.sessions.map((session) => session.id));
    state.selectedSessionIds = new Set([...state.selectedSessionIds].filter((id) => availableSessionIds.has(id)));
    state.currentProvider = null;
    state.registrySummary = body.summary || null;
  } else {
    const availableSessionIds = new Set(state.sessions.map((session) => session.id));
    state.selectedSessionIds = new Set(
      [...state.selectedSessionIds].filter((id) => {
        const session = state.sessions.find((item) => item.id === id);
        return availableSessionIds.has(id) && isSessionDeletable(session);
      }),
    );
    state.currentProvider = body.currentProvider;
    state.registrySummary = body.registrySummary || null;
  }
  if (state.selectedSession && !state.sessions.some((session) => session.id === state.selectedSession.id)) {
    state.selectedSession = null;
    $('deleteSessionButton').disabled = true;
  }
  const summary = state.registrySummary;
  $('codexHome').textContent = isClaudePlatform()
    ? `Claude 本地数据 · ${summary?.total || state.sessions.length} 会话 · ${state.directories.length} 个项目目录 · ${formatBytes(summary?.totalBytes || 0)}`
    : `实时数据 · ${summary?.total || state.sessions.length} 会话 · ${state.directories.length} 个项目目录`;
  renderSummary();
  renderDirectories();
  renderSessions();
}

async function loadTurns() {
  const prefix = isClaudePlatform() ? '/api/claude-code/sessions' : '/api/sessions';
  const body = await api(`${prefix}/${encodeURIComponent(state.selectedSession.id)}/turns`);
  state.turns = body.turns;
  state.historyErrors = body.historyErrors || [];
  renderTurns(body.turns);
  syncFullContextTurnJump();
}

async function selectSession(sessionId) {
  setAlert('');
  resetTurnWorkspace();
  state.selectedSession = state.sessions.find((session) => session.id === sessionId);
  if (isClaudePlatform()) {
    $('deleteSessionButton').disabled = !state.selectedSession;
    $('deleteSessionButton').title = '备份完整会话包后删除该 Claude Code 会话';
    $('cleanupTabButton').disabled = false;
    $('previewSession').textContent = state.selectedSession?.title || sessionId;
    $('turnContext').textContent = state.selectedSession
      ? `← ${state.selectedSession.title || '(无标题会话)'} · ${String(state.selectedSession.id || '').slice(0, 8)}`
      : '';
    $('turnContext').classList.toggle('hidden', !state.selectedSession);
    renderSessions();
    await loadTurns();
    return;
  }
  const deletable = isSessionDeletable(state.selectedSession);
  $('deleteSessionButton').disabled = !deletable;
  $('deleteSessionButton').title = deletable
    ? (state.selectedSession?.storageStatus === 'backup_only'
      ? '永久删除该会话由本工具生成的全部历史备份'
      : '备份并删除选中的 Codex 会话')
    : '该条目只存在于不受本工具管理的外部备份';
  $('cleanupTabButton').disabled = true;
  $('previewSession').textContent = state.selectedSession?.title || sessionId;
  $('turnContext').textContent = state.selectedSession
    ? `← ${state.selectedSession.title || '(untitled)'} · ${String(state.selectedSession.id || '').slice(0, 8)}`
    : '';
  $('turnContext').classList.toggle('hidden', !state.selectedSession);
  renderSessions();
  if (state.selectedSession?.hasRollout) {
    await loadTurns();
  } else {
    state.turns = [];
    $('turns').className = 'turns-empty';
    $('turns').textContent = state.selectedSession?.storageStatus === 'backup_only'
      ? '该会话只存在于历史备份。可以使用“删除整个会话”永久删除本工具生成的全部备份副本。'
      : '该记录没有 rollout 正文，只能删除残留索引。';
    $('turnCount').textContent = state.selectedSession?.storageStatus === 'backup_only' ? '仅备份' : '仅元数据';
  }
}

async function selectTurn(index, options = {}) {
  setAlert('');
  const preservedEdit = options.preserveLastEdit ? state.lastEdit : null;
  resetCleanupPreview();
  resetMessageEditor({ keepLastEdit: options.preserveLastEdit });
  state.lastEdit = preservedEdit;
  state.selectedTurn = state.turns[index];
  syncFullContextTurnJump();
  $('cleanupTabButton').disabled = false;
  renderTurns(state.turns);
  $('messageList').innerHTML = '<div class="list-status">正在加载本轮消息...</div>';

  if (isClaudePlatform()) {
    const turnUrl = `/api/claude-code/sessions/${encodeURIComponent(state.selectedSession.id)}/turns/${encodeURIComponent(state.selectedTurn.turnId)}`;
    const [detailBody, cleanupBody] = await Promise.all([
      api(turnUrl),
      api(`${turnUrl}/delete-preview`, {
        method: 'POST',
        body: JSON.stringify({ mode: state.mode }),
      }),
    ]);
    state.turnDetail = detailBody;
    state.preview = cleanupBody.preview;
    state.cleanupSourceHash = cleanupBody.sourceHash;
    state.turnDetail.sourceHash = cleanupBody.sourceHash;
    renderMessages();
    $('compactContextButton').disabled = false;
    $('fullContextButton').disabled = false;
    setFullContextControlsEnabled(true);
    $('exportFullContextJsonlButton').disabled = true;
    $('exportFullContextMarkdownButton').disabled = true;
    updateContextModeUI();
    if (state.contextMode === 'full') await loadFullContext(0);
    renderCleanupPreview(cleanupBody);
    setOperationView(options.operation || 'messages');
    return;
  }

  const requestBody = {
    sessionId: state.selectedSession.id,
    selector: selectorForTurn(state.selectedTurn),
  };
  const [detailBody, cleanupBody] = await Promise.all([
    api('/api/turn-detail', { method: 'POST', body: JSON.stringify(requestBody) }),
    api('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ ...requestBody, mode: state.mode }),
    }),
  ]);
  state.turnDetail = detailBody.detail;
  state.preview = cleanupBody.preview;
  state.cleanupSourceHash = cleanupBody.sourceHash;
  renderMessages();
  $('compactContextButton').disabled = false;
  $('fullContextButton').disabled = false;
  setFullContextControlsEnabled(true);
  renderCleanupPreview(cleanupBody);
  renderEditResult();
  updateContextModeUI();
  if (state.contextMode === 'full') await loadFullContext(0);
  setOperationView(options.operation || 'messages');
}

async function refreshCleanupPreview() {
  if (!state.selectedTurn) return;
  const body = await api(
    isClaudePlatform()
      ? `/api/claude-code/sessions/${encodeURIComponent(state.selectedSession.id)}/turns/${encodeURIComponent(state.selectedTurn.turnId)}/delete-preview`
      : '/api/preview',
    {
      method: 'POST',
      body: JSON.stringify(
        isClaudePlatform()
          ? { mode: state.mode }
          : { sessionId: state.selectedSession.id, selector: selectorForTurn(state.selectedTurn), mode: state.mode },
      ),
    },
  );
  state.preview = body.preview;
  state.cleanupSourceHash = body.sourceHash;
  renderCleanupPreview(body);
}

async function previewEdits() {
  const body = await api(isClaudePlatform()
    ? `/api/claude-code/sessions/${encodeURIComponent(state.selectedSession.id)}/turns/${encodeURIComponent(state.selectedTurn.turnId)}/edit-preview`
    : '/api/edit-preview', {
    method: 'POST',
    body: JSON.stringify({
      ...(isClaudePlatform() ? {} : { sessionId: state.selectedSession.id, selector: selectorForTurn(state.selectedTurn) }),
      sourceHash: state.turnDetail.sourceHash,
      edits: editPayload(),
    }),
  });
  renderEditPreview(body);
}

async function applyEdits() {
  const turnIndex = state.selectedTurn.index;
  const body = await api(isClaudePlatform()
    ? `/api/claude-code/sessions/${encodeURIComponent(state.selectedSession.id)}/turns/${encodeURIComponent(state.selectedTurn.turnId)}/edit-apply`
    : '/api/edit-apply', {
    method: 'POST',
    body: JSON.stringify({
      ...(isClaudePlatform() ? {} : { sessionId: state.selectedSession.id, selector: selectorForTurn(state.selectedTurn) }),
      sourceHash: state.turnDetail.sourceHash,
      edits: editPayload(),
      confirmation: $('editConfirmation').value,
    }),
  });
  state.lastEdit = {
    backupPath: body.backupFile,
    backupDir: body.backupDir,
    expectedCurrentHash: body.sourceHashAfter,
    changedCount: body.preview?.changedCount || body.changedCount,
  };
  await loadTurns();
  await selectTurn(turnIndex, { preserveLastEdit: true, operation: 'messages' });
  setAlert(`消息修改完成，原始 ${isClaudePlatform() ? 'Claude 会话文件' : 'rollout'} 已备份；重新打开目标会话时会读取修改后的内容。`, 'success');
}

async function restoreLastEdit() {
  const turnIndex = state.selectedTurn.index;
  const body = await api(isClaudePlatform() ? '/api/claude-code/edit-restore' : '/api/edit-restore', {
    method: 'POST',
    body: JSON.stringify({
      ...(isClaudePlatform() ? { backupDir: state.lastEdit.backupDir } : { sessionId: state.selectedSession.id, backupPath: state.lastEdit.backupPath }),
      expectedCurrentHash: state.lastEdit.expectedCurrentHash,
      confirmation: 'RESTORE',
    }),
  });
  state.lastEdit = null;
  await loadTurns();
  await selectTurn(turnIndex, { operation: 'messages' });
  setAlert(`已撤销本次编辑。重新打开目标会话时会读取恢复后的 ${isClaudePlatform() ? 'Claude' : 'Codex'} 会话。`, 'success');
}

async function applyCleanup() {
  setAlert('');
  const body = await api(
    isClaudePlatform()
      ? `/api/claude-code/sessions/${encodeURIComponent(state.selectedSession.id)}/turns/${encodeURIComponent(state.selectedTurn.turnId)}/delete-apply`
      : '/api/apply',
    {
      method: 'POST',
      body: JSON.stringify(
        isClaudePlatform()
          ? { mode: state.mode, sourceHash: state.cleanupSourceHash, confirmation: $('confirmation').value }
          : {
              sessionId: state.selectedSession.id,
              selector: selectorForTurn(state.selectedTurn),
              mode: state.mode,
              sourceHash: state.cleanupSourceHash,
              confirmation: $('confirmation').value,
            },
      ),
    },
  );
  const summary = JSON.stringify(isClaudePlatform()
    ? {
        mode: state.mode,
        backupDir: body.backup?.backupDir,
        removedRecords: body.deleted.recordCount,
        removedToolResultFiles: body.deleted.toolResultFiles,
        removedSubagents: body.deleted.subagents,
      }
    : {
        mode: state.mode,
        backupDir: body.backupDir,
        removedRecords: body.preview.removedCount,
        remainingRecords: body.validation.recordCount,
      }, null, 2);
  await selectSession(state.selectedSession.id);
  $('result').textContent = summary;
  setOperationView('cleanup');
  setAlert('清理完成，原始 rollout 已备份；如存在分页历史，也已保存安全副本。重新打开目标会话时 Codex 会重建历史。', 'success');
}

function renderVisibilityPlan(plan) {
  state.visibilityPlan = plan;
  $('visibilityProvider').textContent = plan.targetProvider || '-';
  $('visibilityRollouts').textContent = String(plan.summary.rolloutUpdates);
  $('visibilitySqlite').textContent = String(plan.summary.sqliteUpdates);
  $('visibilityRestores').textContent = String(plan.summary.restores);
  $('visibilityCodexProcesses').textContent = String(plan.summary.runningCodexProcesses || 0);
  $('visibilityActive').textContent = String(plan.summary.skippedActive);
  $('visibilityUnresolved').textContent = String(plan.summary.unresolved);
  const processWarning = $('visibilityProcessWarning');
  if (plan.blockedByRunningCodex) {
    const processIds = (plan.codexProcessCheck?.processes || [])
      .map((item) => item.pid)
      .join('、');
    processWarning.textContent = `检测到运行中的 Codex 进程${processIds ? `（PID ${processIds}）` : ''}。必须完全退出所有 Codex 窗口和终端会话，否则 Codex 会把修复结果写回旧供应商。退出后保持本页面打开，再点“可见性修复”重新预览。`;
    processWarning.classList.remove('hidden');
  } else if (plan.codexProcessCheck?.available === false) {
    processWarning.textContent = '无法检测 Codex 进程。工具将继续使用最近修改时间保护活跃会话；请确认所有 Codex 窗口和终端会话均已退出。';
    processWarning.classList.remove('hidden');
  } else {
    processWarning.textContent = '';
    processWarning.classList.add('hidden');
  }
  $('visibilityConfirmation').value = '';
  $('applyVisibilityButton').disabled = true;
  $('visibilityResult').textContent = '';
  $('visibilityPanel').classList.remove('hidden');
}

async function previewVisibilityRepair() {
  setAlert('');
  $('visibilityButton').disabled = true;
  try {
    const plan = await api('/api/visibility/preview');
    renderVisibilityPlan(plan);
    if (plan.blockedByRunningCodex) {
      setAlert('检测到 Codex 仍在运行。请完全退出 Codex 后重新预览；当前不会写入任何会话。');
    } else if (!plan.canApply) {
      setAlert('未找到可写的 Codex state SQLite，当前只能识别会话，不能修复 Codex 可见性。');
    }
  } finally {
    $('visibilityButton').disabled = false;
  }
}

async function applyVisibilityRepair() {
  const body = await api('/api/visibility/apply', {
    method: 'POST',
    body: JSON.stringify({
      planToken: state.visibilityPlan.planToken,
      confirmation: $('visibilityConfirmation').value,
    }),
  });
  $('visibilityResult').textContent = JSON.stringify(body.noOp ? {
    message: body.message,
  } : {
    targetProvider: body.preview.targetProvider,
    changedRollouts: body.changedRollouts,
    restoredRollouts: body.restoredRollouts,
    changedSqliteRows: body.changedSqliteRows,
    skippedActive: body.preview.summary.skippedActive,
    unresolved: body.preview.summary.unresolved,
    backupDir: body.backup.backupDir,
    restartRequired: body.restartRequired,
  }, null, 2);
  await loadSessions();
  $('visibilityPanel').classList.remove('hidden');
  if (body.noOp) {
    setAlert('所有可恢复会话已经对当前 Codex 供应商可见。', 'success');
    return;
  }
  setAlert(
    `会话统一完成，回退备份已保留在“系统安全备份”。请重新启动 Codex；无法自动处理的会话未被修改。`,
    'success',
  );
}

function closeSessionDeleteDialog() {
  state.sessionDeletePlan = null;
  $('sessionDeleteConfirmation').value = '';
  $('applySessionDeleteButton').disabled = true;
  $('sessionDeleteDialog').close();
}

function renderSessionDeletePlan(plan) {
  const claude = isClaudePlatform();
  if (claude) {
    const isBatch = plan.sessions.length > 1;
    state.sessionDeletePlan = { ...plan, isBatch, platform: 'claude' };
    $('sessionDeleteIntro').textContent = '从 Claude Code 中移除完整会话包与索引；操作前会创建可恢复备份。删除正在打开的会话后，请退出或重新打开 Claude Code，避免客户端缓存将其重新写回。';
    $('sessionDeletePrimaryLabel').textContent = '主会话 JSONL';
    $('sessionDeleteSecondaryLabel').textContent = '会话数据目录';
    $('sessionDeleteIndexLabel').textContent = '索引记录';
    $('sessionDeleteFilesLabel').textContent = '备份文件总数';
    $('sessionDeleteChildrenLabel').textContent = '包含的子代理';
    $('sessionDeleteTitle').textContent = isBatch
      ? `${plan.sessions.length} 个会话：${plan.sessions.slice(0, 3).map((session) => session.title || session.id).join('、')}${plan.sessions.length > 3 ? '…' : ''}`
      : (plan.sessions[0].title || plan.sessions[0].id);
    $('sessionDeleteRollouts').textContent = String(plan.summary.mainFiles);
    $('sessionDeleteSqlite').textContent = String(plan.summary.artifactDirectories);
    $('sessionDeleteIndex').textContent = String(plan.summary.indexRows);
    $('sessionDeleteHistorical').textContent = String(plan.summary.artifactFiles);
    $('sessionDeleteChildren').textContent = String(plan.summary.subagentsIncluded || 0);
    $('sessionDeleteBackup').textContent = plan.deletionBackupRoot;
    $('sessionDeleteConfirmation').value = '';
    $('sessionDeleteResult').textContent = '';
    $('applySessionDeleteButton').disabled = true;
    $('applySessionDeleteButton').textContent = isBatch ? '备份并批量删除会话' : '备份并删除整个会话';
    const messages = [
      `将备份并删除 ${plan.summary.artifactFiles} 个文件，共 ${formatBytes(plan.summary.totalBytes)}。`,
      '如果目标会话仍在 Claude Code 中打开，它可能在客户端退出前被再次写回。',
    ];
    if (plan.summary.invalidIndexes) messages.push(`${plan.summary.invalidIndexes} 个 sessions-index.json 无法解析；工具不会改写这些损坏索引。`);
    $('sessionDeleteWarning').textContent = messages.join(' ');
    $('sessionDeleteWarning').classList.remove('hidden');
    return;
  }
  $('sessionDeleteIntro').textContent = '从 Codex 中移除正文、索引和分页历史；只需关闭目标会话，其他 Codex 窗口可以继续使用。';
  $('sessionDeletePrimaryLabel').textContent = 'rollout 文件';
  $('sessionDeleteSecondaryLabel').textContent = 'SQLite 记录';
  $('sessionDeleteIndexLabel').textContent = '旧索引记录';
  $('sessionDeleteFilesLabel').textContent = '历史备份文件';
  $('sessionDeleteChildrenLabel').textContent = '保留的子代理会话';
  const isBatch = Array.isArray(plan.sessions);
  state.sessionDeletePlan = { ...plan, isBatch, platform: 'codex' };
  $('sessionDeleteTitle').textContent = isBatch
    ? `${plan.sessions.length} 个会话：${plan.sessions.slice(0, 3).map((session) => session.title || session.id).join('、')}${plan.sessions.length > 3 ? '…' : ''}`
    : (plan.session.title || plan.session.id);
  $('sessionDeleteRollouts').textContent = String(plan.summary.rolloutFiles);
  $('sessionDeleteSqlite').textContent = String(plan.summary.sqliteRows);
  $('sessionDeleteIndex').textContent = String(plan.summary.indexRows);
  $('sessionDeleteHistorical').textContent = String(plan.summary.historicalBackupFiles || 0);
  $('sessionDeleteChildren').textContent = String(plan.summary.childThreadsKept);
  $('sessionDeleteBackup').textContent = plan.summary.historicalBackupFiles
    ? '不创建新副本；所列历史备份将被永久删除'
    : plan.deletionBackupRoot;
  $('sessionDeleteConfirmation').value = '';
  $('sessionDeleteResult').textContent = '';
  $('applySessionDeleteButton').disabled = true;
  $('applySessionDeleteButton').textContent = plan.summary.historicalBackupFiles
    ? '永久删除历史备份'
    : '备份并删除整个会话';
  const warning = $('sessionDeleteWarning');
  const messages = [];
  if (plan.blockedByActiveTarget) {
    const count = plan.targetSessionLock?.activeSessionIds?.length || 1;
    messages.push(`${count} 个目标会话仍在 Codex 中打开。请只关闭这些目标会话后重新预览；其他 Codex 窗口可以保持打开。`);
  } else if (plan.codexRunning) {
    messages.push('其他 Codex 窗口仍在运行，不影响本次删除。目标会话已关闭，工具会在写入期间锁定它。');
  }
  if (plan.summary.historicalBackupFiles) {
    messages.push(`将永久删除 ${plan.summary.historicalBackupFiles} 份由本工具生成的历史 JSONL 备份；这些文件不会再次备份。`);
  }
  const metadataOnly = isBatch ? plan.summary.metadataOnly : Number(!plan.rolloutPath && plan.summary.sqliteRows > 0);
  if (metadataOnly) {
    messages.push(`${metadataOnly} 个会话只剩 SQLite 元数据；只能移除残留标题和索引，无法备份不存在的正文。`);
  }
  if (plan.summary.childThreadsKept) {
    messages.push(`检测到 ${plan.summary.childThreadsKept} 个直接子代理线程；本次不会连带删除它们。`);
  }
  warning.textContent = messages.join(' ');
  warning.classList.toggle('hidden', messages.length === 0);
}

async function previewSessionDelete() {
  if (!state.selectedSession) return;
  setAlert('');
  $('deleteSessionButton').disabled = true;
  try {
    const plan = await api(isClaudePlatform() ? '/api/claude-code/session-deletions/preview' : '/api/session-delete/preview', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.selectedSession.id }),
    });
    renderSessionDeletePlan(plan);
    $('sessionDeleteDialog').showModal();
  } finally {
    $('deleteSessionButton').disabled = isClaudePlatform() ? !state.selectedSession : !isSessionDeletable(state.selectedSession);
  }
}

async function previewBatchSessionDelete() {
  const sessionIds = [...state.selectedSessionIds];
  if (!sessionIds.length) return;
  setAlert('');
  $('batchDeleteSessionsButton').disabled = true;
  try {
    const plan = await api(isClaudePlatform() ? '/api/claude-code/session-deletions/preview' : '/api/session-delete/batch-preview', {
      method: 'POST',
      body: JSON.stringify({ sessionIds }),
    });
    renderSessionDeletePlan(plan);
    $('sessionDeleteDialog').showModal();
  } finally {
    updateBatchControls();
  }
}

async function applySessionDelete() {
  const plan = state.sessionDeletePlan;
  if (!plan) return;
  const claude = plan.platform === 'claude';
  const endpoint = claude
    ? '/api/claude-code/session-deletions/apply'
    : (plan.isBatch ? '/api/session-delete/batch-apply' : '/api/session-delete/apply');
  const body = await api(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      ...(claude
        ? (plan.isBatch ? { sessionIds: plan.sessions.map((session) => session.id) } : { sessionId: plan.sessions[0].id })
        : (plan.isBatch ? { sessionIds: plan.sessions.map((session) => session.id) } : { sessionId: plan.session.id })),
      planToken: plan.planToken,
      confirmation: $('sessionDeleteConfirmation').value,
    }),
  });
  const backupDir = body.backup?.backupDir || null;
  const deletedIds = claude
    ? plan.sessions.map((session) => session.id)
    : (plan.isBatch ? plan.sessions.map((session) => session.id) : [plan.session.id]);
  closeSessionDeleteDialog();
  deletedIds.forEach((id) => state.selectedSessionIds.delete(id));
  state.selectedSession = null;
  state.turns = [];
  $('deleteSessionButton').disabled = true;
  await loadSessions();
  if (claude) {
    setAlert(`${deletedIds.length} 个 Claude Code 会话已删除；完整备份位于 ${backupDir}。请退出或重新打开 Claude Code；如果删除的是当前活动会话，客户端退出前仍可能重新写入它。`, 'success');
    return;
  }
  const deletedHistorical = body.deleted?.historicalBackupFiles || 0;
  setAlert(
    deletedHistorical
      ? `已永久删除 ${deletedHistorical} 份历史备份，会话已从本工具列表移除。`
      : `${deletedIds.length} 个会话已从 Codex 中删除；可恢复备份位于 ${backupDir}。其他 Codex 窗口无需退出。`,
    'success',
  );
}

function renderBackupManager() {
  const operationView = !isClaudePlatform() && state.backupManagerView === 'operation';
  const systemView = !isClaudePlatform() && state.backupManagerView === 'system';
  const deletionView = !operationView && !systemView;
  $('deletionBackupsTab').classList.toggle('active', deletionView);
  $('operationBackupsTab').classList.toggle('active', operationView);
  $('systemBackupsTab').classList.toggle('active', systemView);
  $('deletionBackupsTab').setAttribute('aria-selected', String(deletionView));
  $('operationBackupsTab').setAttribute('aria-selected', String(operationView));
  $('systemBackupsTab').setAttribute('aria-selected', String(systemView));
  const backups = operationView
    ? state.operationBackups
    : (systemView ? state.systemBackups : state.deletionBackups);
  const totalBytes = backups.reduce((total, backup) => total + backup.sizeBytes, 0);
  const viewLabel = operationView ? '会话快照' : (systemView ? '系统安全备份' : (isClaudePlatform() ? 'Claude 会话删除备份' : '会话删除备份'));
  $('backupManagerSummary').textContent = isClaudePlatform()
    ? `${backups.length} 个 Claude 会话删除备份 · ${formatBytes(totalBytes)}`
    : `${backups.length} 个${viewLabel} · ${formatBytes(totalBytes)}`;
  $('backupManagerWarning').textContent = systemView
    ? '左侧复选框仅用于永久删除。可见性修复备份保存当时被改动的 rollout 和一致的 SQLite 快照；回退时只恢复清单中的供应商字段，不用旧文件覆盖后来数据。'
    : (operationView
    ? '左侧复选框仅用于永久删除。点击“查看备份”可直接阅读快照内容和恢复影响；替换当前正文前会自动生成安全点。'
    : (isClaudePlatform()
      ? '左侧复选框仅用于永久删除。批量备份会列出其中的每个 Claude 会话；可直接查看/恢复单个会话，也可批量选择恢复。'
      : '左侧复选框仅用于永久删除。批量备份会列出其中的每个会话；可直接查看/恢复单个会话，也可批量选择恢复。'));
  if (!backups.length) {
    $('backupManagerList').innerHTML = `<div class="list-status">暂无${isClaudePlatform() ? ' Claude 会话删除备份' : viewLabel}。</div>`;
  } else if (systemView) {
    $('backupManagerList').innerHTML = backups.map((backup) => {
      const checked = state.selectedSystemBackupIds.has(backup.id) ? ' checked' : '';
      return `
        <div class="backup-entry">
          <input type="checkbox" aria-label="选择系统备份 ${escapeHtml(backup.typeLabel)} 用于永久删除" title="选择用于永久删除" data-system-backup-select="${escapeHtml(backup.id)}"${checked}>
          <span class="backup-title">${escapeHtml(backup.typeLabel)}</span>
          <div class="backup-entry-actions">
            <strong>${formatBytes(backup.sizeBytes)}</strong>
            ${backup.type === 'visibility_sync' ? `<button type="button" data-system-backup-restore="${escapeHtml(backup.id)}">查看回退范围</button>` : ''}
          </div>
          <span class="backup-meta">${escapeHtml(formatDate(backup.createdAt))} · ${escapeHtml(backup.type)}</span>
          <span class="backup-path">${escapeHtml(displayPath(backup.path))}</span>
        </div>
      `;
    }).join('');
  } else if (operationView) {
    $('backupManagerList').innerHTML = backups.map((backup) => {
      const checked = state.selectedOperationBackupIds.has(backup.id) ? ' checked' : '';
      const title = backup.title || backup.sessionId;
      return `
        <div class="backup-entry">
          <input type="checkbox" aria-label="选择快照 ${escapeHtml(title)} 用于永久删除" title="选择用于永久删除" data-operation-backup-select="${escapeHtml(backup.id)}"${checked}>
          <span class="backup-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
          <div class="backup-entry-actions">
            <strong>${formatBytes(backup.sizeBytes)}</strong>
            <button type="button" data-operation-backup-open="${escapeHtml(backup.id)}">查看备份</button>
          </div>
          <span class="backup-meta">${escapeHtml(backup.kindLabel)} · 生成于 ${escapeHtml(formatDate(backup.createdAt))} · ${escapeHtml(String(backup.sessionId).slice(0, 8))}</span>
          <span class="backup-path">${escapeHtml(backup.path)}</span>
        </div>
      `;
    }).join('');
  } else {
    $('backupManagerList').innerHTML = backups.map((backup) => {
      const checked = state.selectedBackupIds.has(backup.id) ? ' checked' : '';
      const multiSession = backup.sessions.length > 1;
      const singleSession = backup.sessions[0] || null;
      const packageTitle = multiSession
        ? `批量删除备份 · ${backup.sessions.length} 个会话`
        : (singleSession?.title || singleSession?.id || '单会话删除备份');
      const sessionRows = multiSession ? `
        <div class="backup-package-sessions">
          ${backup.sessions.map((session) => `
            <div class="backup-package-session">
              <button type="button" class="backup-session-title-button" data-backup-session-open="${escapeHtml(backup.id)}" data-backup-session-id="${escapeHtml(session.id)}" title="只查看并恢复这个会话">${escapeHtml(session.title || '(untitled)')}</button>
              <span class="session-id">${escapeHtml(session.id)}</span>
              <button type="button" data-backup-session-open="${escapeHtml(backup.id)}" data-backup-session-id="${escapeHtml(session.id)}">查看/恢复此会话</button>
            </div>
          `).join('')}
        </div>
      ` : '';
      return `
        <div class="backup-entry${multiSession ? ' backup-package-entry' : ''}">
          <input type="checkbox" aria-label="选择备份包 ${escapeHtml(packageTitle)} 用于永久删除" title="选择整个备份包用于永久删除" data-backup-select="${escapeHtml(backup.id)}"${checked}>
          ${multiSession
            ? `<span class="backup-title">${escapeHtml(packageTitle)}</span>`
            : `<button type="button" class="backup-session-title-button backup-title" data-backup-session-open="${escapeHtml(backup.id)}" data-backup-session-id="${escapeHtml(singleSession.id)}" title="查看并恢复这个会话">${escapeHtml(packageTitle)}</button>`}
          <div class="backup-entry-actions">
            <strong>${formatBytes(backup.sizeBytes)}</strong>
            ${multiSession
              ? `<button type="button" data-backup-batch-open="${escapeHtml(backup.id)}">批量选择恢复</button>`
              : `<button type="button" data-backup-session-open="${escapeHtml(backup.id)}" data-backup-session-id="${escapeHtml(singleSession.id)}">查看/恢复</button>`}
          </div>
          <span class="backup-meta">${escapeHtml(formatDate(backup.createdAt))} · ${multiSession ? '一次批量删除产生的备份包' : '单会话备份'}</span>
          ${sessionRows}
          <span class="backup-path">${escapeHtml(backup.backupDir)}</span>
        </div>
      `;
    }).join('');
  }
  $('backupDeleteConfirmation').value = '';
  $('deleteSelectedBackupsButton').disabled = true;
}

async function previewVisibilitySystemBackup(backupId) {
  const plan = await api('/api/system-backups/visibility-restore-preview', {
    method: 'POST',
    body: JSON.stringify({ backupId }),
  });
  state.visibilityBackupRestorePlan = plan;
  $('visibilityRestoreCreated').textContent = formatDate(plan.createdAt);
  $('visibilityRestoreTarget').textContent = plan.targetProvider || '未知';
  $('visibilityRestoreRollouts').textContent = String(plan.rolloutUpdates.length);
  $('visibilityRestoreSqlite').textContent = String(plan.sqliteUpdates.length);
  $('visibilityRestoreConflicts').textContent = String(plan.conflicts.length);
  $('visibilityRestoreLegacy').textContent = plan.legacyManifest ? '是；SQLite 变更由备份数据库差异推断' : '否；清单明确记录了变更';
  const messages = [];
  if (plan.blockedByRunningCodex) messages.push('检测到 Codex 正在运行。请完全退出 Codex 后重新预览。');
  if (plan.conflicts.length) messages.push(`检测到 ${plan.conflicts.length} 个当前状态冲突；为避免覆盖后续修改，本次整批回退已禁止，不会写入任何数据。`);
  if (!plan.rolloutUpdates.length && !plan.sqliteUpdates.length && !plan.conflicts.length) messages.push('当前状态已经与该备份一致，无需恢复。');
  $('visibilityRestoreWarning').textContent = messages.join(' ');
  $('visibilityRestoreWarning').classList.toggle('hidden', messages.length === 0);
  $('visibilityRestoreConfirmation').value = '';
  $('applyVisibilityBackupRestoreButton').disabled = true;
  if ($('backupManagerDialog').open) $('backupManagerDialog').close();
  $('visibilityBackupRestoreDialog').showModal();
}

function closeVisibilityBackupRestore() {
  state.visibilityBackupRestorePlan = null;
  $('visibilityBackupRestoreDialog').close();
}

async function applyVisibilitySystemBackup() {
  const plan = state.visibilityBackupRestorePlan;
  if (!plan) return;
  const body = await api('/api/system-backups/visibility-restore-apply', {
    method: 'POST',
    body: JSON.stringify({
      backupId: plan.backupId,
      planToken: plan.planToken,
      confirmation: $('visibilityRestoreConfirmation').value,
    }),
  });
  closeVisibilityBackupRestore();
  await loadSessions();
  setAlert(`已回退 ${body.restoredRollouts} 个 rollout 和 ${body.restoredSqliteRows} 条 SQLite 的供应商字段；备份之后新增的会话和消息均已保留。当前状态安全点位于 ${body.safety.safetyDir}。请重新启动 Codex。`, 'success');
}

async function openBackupManager(options = {}) {
  setAlert('');
  if (isClaudePlatform()) {
    const deletionBody = await api('/api/claude-code/session-deletion-backups');
    state.deletionBackups = deletionBody.backups || [];
    state.operationBackups = [];
    state.systemBackups = [];
    state.backupManagerView = 'deletion';
    state.selectedBackupIds = new Set(
      [...state.selectedBackupIds].filter((id) => state.deletionBackups.some((backup) => backup.id === id)),
    );
    if (options.sessionId) {
      state.selectedBackupIds = new Set(state.deletionBackups
        .filter((backup) => backup.sessions?.some((session) => session.id === options.sessionId))
        .map((backup) => backup.id));
    }
    state.backupInventorySignature = backupInventorySignature();
    renderBackupManager();
    $('backupManagerDialog').showModal();
    updateBackupAutoDetectTimer();
    return;
  }
  const [deletionBody, operationBody, systemBody] = await Promise.all([
    api('/api/deletion-backups'),
    api('/api/operation-backups'),
    api('/api/system-backups'),
  ]);
  state.deletionBackups = deletionBody.backups || [];
  state.operationBackups = operationBody.backups || [];
  state.systemBackups = systemBody.backups || [];
  state.selectedBackupIds = new Set(
    [...state.selectedBackupIds].filter((id) => state.deletionBackups.some((backup) => backup.id === id)),
  );
  state.selectedOperationBackupIds = new Set(
    [...state.selectedOperationBackupIds].filter((id) => state.operationBackups.some((backup) => backup.id === id)),
  );
  state.selectedSystemBackupIds = new Set(
    [...state.selectedSystemBackupIds].filter((id) => state.systemBackups.some((backup) => backup.id === id)),
  );
  if (options.sessionId) {
    const matchesDeletion = state.deletionBackups.filter((backup) => backup.sessions?.some((session) => session.id === options.sessionId));
    const matchesOperation = state.operationBackups.filter((backup) => backup.sessionId === options.sessionId || backup.sessions?.some((session) => session.id === options.sessionId));
    const matchesSystem = state.systemBackups.filter((backup) => backup.sessionId === options.sessionId || backup.sessionIds?.includes(options.sessionId) || backup.sessions?.some((session) => session.id === options.sessionId));
    state.selectedBackupIds = new Set(matchesDeletion.map((backup) => backup.id));
    state.selectedOperationBackupIds = new Set(matchesOperation.map((backup) => backup.id));
    state.selectedSystemBackupIds = new Set(matchesSystem.map((backup) => backup.id));
    state.backupManagerView = matchesDeletion.length ? 'deletion' : (matchesOperation.length ? 'operation' : 'system');
  }
  state.backupInventorySignature = backupInventorySignature();
  renderBackupManager();
  $('backupManagerDialog').showModal();
  updateBackupAutoDetectTimer();
}

function closeBackupManager() {
  state.selectedBackupIds = new Set();
  state.selectedOperationBackupIds = new Set();
  state.selectedSystemBackupIds = new Set();
  $('backupManagerDialog').close();
  updateBackupAutoDetectTimer();
}

function backupInventorySignature() {
  const compact = (items) => items.map((item) => ({
    id: item.id,
    createdAt: item.createdAt,
    sizeBytes: item.sizeBytes,
    sessions: item.sessions?.map((session) => session.id) || [],
    type: item.type || item.kind || null,
  }));
  return JSON.stringify({
    platform: state.platform,
    deletion: compact(state.deletionBackups),
    operation: compact(state.operationBackups),
    system: compact(state.systemBackups),
  });
}

async function refreshBackupInventoryReadOnly() {
  if (isClaudePlatform()) {
    const deletionBody = await api('/api/claude-code/session-deletion-backups');
    state.deletionBackups = deletionBody.backups || [];
    state.operationBackups = [];
    state.systemBackups = [];
  } else {
    const [deletionBody, operationBody, systemBody] = await Promise.all([
      api('/api/deletion-backups'),
      api('/api/operation-backups'),
      api('/api/system-backups'),
    ]);
    state.deletionBackups = deletionBody.backups || [];
    state.operationBackups = operationBody.backups || [];
    state.systemBackups = systemBody.backups || [];
  }
  state.selectedBackupIds = new Set(
    [...state.selectedBackupIds].filter((id) => state.deletionBackups.some((backup) => backup.id === id)),
  );
  state.selectedOperationBackupIds = new Set(
    [...state.selectedOperationBackupIds].filter((id) => state.operationBackups.some((backup) => backup.id === id)),
  );
  state.selectedSystemBackupIds = new Set(
    [...state.selectedSystemBackupIds].filter((id) => state.systemBackups.some((backup) => backup.id === id)),
  );
}

function backupRestoreRequest() {
  const operationRestore = state.restoreBackupKind === 'operation';
  const claudeRestore = state.restoreBackupKind === 'claude-deletion';
  return {
    endpoint: claudeRestore
      ? '/api/claude-code/session-deletion-backups/restore-preview'
      : (operationRestore ? '/api/operation-backups/restore-preview' : '/api/deletion-backups/restore-preview'),
    body: operationRestore
      ? { backupId: state.restoreBackup.id }
      : { backupId: state.restoreBackup.id, sessionIds: [...state.selectedRestoreSessionIds] },
  };
}

async function detectBackupChanges({ manual = false } = {}) {
  if (state.backupAutoDetectBusy) return;
  state.backupAutoDetectBusy = true;
  if (manual) $('detectBackupChangesButton').disabled = true;
  try {
    if ($('backupManagerDialog').open) {
      const before = state.backupInventorySignature || backupInventorySignature();
      await refreshBackupInventoryReadOnly();
      const after = backupInventorySignature();
      state.backupInventorySignature = after;
      if (before !== after) {
        renderBackupManager();
        $('backupAutoDetectStatus').textContent = `检测到备份变化，列表已更新 · ${new Date().toLocaleTimeString()}`;
      } else {
        $('backupAutoDetectStatus').textContent = `未发现变化 · ${new Date().toLocaleTimeString()} · 不会自动写入`;
      }
    }
    if ($('backupRestoreDialog').open && state.restoreBackup && state.selectedRestoreSessionIds.size) {
      const request = backupRestoreRequest();
      const plan = await api(request.endpoint, { method: 'POST', body: JSON.stringify(request.body) });
      if (state.backupRestoreDetectionSignature && state.backupRestoreDetectionSignature !== plan.planToken) {
        renderBackupRestorePlan(plan);
        const sessionId = state.backupContentSessionId || (state.selectedRestoreSessionIds.size === 1
          ? [...state.selectedRestoreSessionIds][0]
          : null);
        if (sessionId) await loadBackupContent(sessionId, state.backupContentOffset);
        setAlert('检测到恢复目标发生变化，已重新生成只读预览；请重新核对后确认。');
      }
      state.backupRestoreDetectionSignature = plan.planToken;
    }
  } catch (error) {
    if ($('backupManagerDialog').open) $('backupAutoDetectStatus').textContent = `检测失败：${error.message}`;
    if (manual) setAlert(`只读检测失败：${error.message}`);
  } finally {
    state.backupAutoDetectBusy = false;
    if (manual) $('detectBackupChangesButton').disabled = false;
  }
}

function updateBackupAutoDetectTimer() {
  clearInterval(state.backupAutoDetectTimer);
  state.backupAutoDetectTimer = null;
  const dialogOpen = $('backupManagerDialog').open || $('backupRestoreDialog').open;
  if (!dialogOpen || !$('backupAutoDetectEnabled').checked) return;
  state.backupAutoDetectTimer = setInterval(() => detectBackupChanges(), 15_000);
}

async function deleteSelectedBackups() {
  const operationView = !isClaudePlatform() && state.backupManagerView === 'operation';
  const systemView = !isClaudePlatform() && state.backupManagerView === 'system';
  const backupIds = operationView
    ? [...state.selectedOperationBackupIds]
    : (systemView ? [...state.selectedSystemBackupIds] : [...state.selectedBackupIds]);
  const endpoint = isClaudePlatform()
    ? '/api/claude-code/session-deletion-backups/delete'
    : (operationView
    ? '/api/operation-backups/delete'
    : (systemView ? '/api/system-backups/delete' : '/api/deletion-backups/delete'));
  const body = await api(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      backupIds,
      confirmation: $('backupDeleteConfirmation').value,
    }),
  });
  const refreshed = await api(isClaudePlatform()
    ? '/api/claude-code/session-deletion-backups'
    : (operationView
    ? '/api/operation-backups'
    : (systemView ? '/api/system-backups' : '/api/deletion-backups')));
  if (operationView) {
    state.selectedOperationBackupIds = new Set();
    state.operationBackups = refreshed.backups || [];
  } else if (systemView) {
    state.selectedSystemBackupIds = new Set();
    state.systemBackups = refreshed.backups || [];
  } else {
    state.selectedBackupIds = new Set();
    state.deletionBackups = refreshed.backups || [];
  }
  renderBackupManager();
  await loadSessions();
  const deletedCount = operationView || systemView ? body.summary.count : body.deletedCount;
  const freedBytes = operationView || systemView ? body.summary.sizeBytes : body.freedBytes;
  setAlert(`已永久删除 ${deletedCount} 个备份，释放 ${formatBytes(freedBytes)}。`, 'success');
}

function updateRestoreSelectionControls() {
  const selectedCount = state.selectedRestoreSessionIds.size;
  $('selectedRestoreSessionCount').textContent = `已选 ${selectedCount}`;
  $('previewBackupRestoreButton').disabled = selectedCount === 0;
  const visible = state.visibleRestoreSessionIds;
  const selectedVisible = visible.filter((id) => state.selectedRestoreSessionIds.has(id)).length;
  $('selectVisibleRestoreSessions').checked = visible.length > 0 && selectedVisible === visible.length;
  $('selectVisibleRestoreSessions').indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  $('selectVisibleRestoreSessions').disabled = visible.length === 0;
}

function resetBackupRestorePlan() {
  state.backupRestorePlan = null;
  state.backupRestoreDetectionSignature = null;
  $('backupRestorePlan').classList.add('hidden');
  $('backupRestoreConfirmation').value = '';
  $('applyBackupRestoreButton').disabled = true;
}

function resetBackupContent() {
  state.backupContent = null;
  state.backupContentSessionId = null;
  state.backupContentOffset = 0;
  $('backupContentMeta').classList.add('hidden');
  $('backupContentState').className = 'backup-content-state';
  $('backupContentState').textContent = '请选择';
  $('backupContentSummary').textContent = '选择一个备份会话后，将在这里显示实际保存的用户与助手消息。';
  $('backupContentMessages').innerHTML = '<div class="list-status">尚未选择要查看的会话。</div>';
  $('backupContentPagination').classList.add('hidden');
}

function backupContentEndpoint() {
  if (state.restoreBackupKind === 'operation') return '/api/operation-backups/content';
  if (state.restoreBackupKind === 'claude-deletion') return '/api/claude-code/session-deletion-backups/content';
  return '/api/deletion-backups/content';
}

function backupMessageRoleLabel(message) {
  if (message.role === 'user') return '你';
  if (message.role === 'error') return message.phase === 'turn_aborted' ? 'Codex · 任务中止' : 'Codex · 错误';
  return state.restoreBackupKind === 'claude-deletion' ? 'Claude' : 'Codex';
}

function renderBackupContent(detail) {
  state.backupContent = detail;
  const comparison = detail.comparison || { state: 'unknown', label: '未知' };
  $('backupContentState').className = `backup-content-state state-${comparison.state || 'unknown'}`;
  $('backupContentState').textContent = comparison.state === 'missing'
    ? '可恢复'
    : (comparison.state === 'identical' ? '已存在' : (comparison.state === 'metadata_only' ? '仅元数据' : '有差异'));
  $('backupContentMeta').classList.remove('hidden');
  $('backupContentTitle').textContent = detail.session?.title || '(untitled)';
  $('backupContentSessionId').textContent = detail.session?.id || '-';
  $('backupContentProject').textContent = detail.session?.projectPath || '未知';
  $('backupContentCreated').textContent = formatDate(detail.createdAt);
  $('backupContentComparison').textContent = comparison.label || '未知';
  const provider = detail.provider?.restoreTarget
    ? `${detail.provider.backup || '未知'} → ${detail.provider.restoreTarget}`
    : (detail.provider?.backup || (state.restoreBackupKind === 'claude-deletion' ? '保持 Claude 原生格式' : '未知'));
  $('backupContentProvider').textContent = provider;

  if (!detail.contentAvailable || !detail.content) {
    $('backupContentSummary').textContent = detail.unavailableReason || '这个备份没有可读取的会话正文。';
    $('backupContentCounts').textContent = '没有 rollout 正文';
    $('backupContentMessages').innerHTML = `<div class="list-status">${escapeHtml(detail.unavailableReason || '没有可显示的消息。')}</div>`;
    $('backupContentPagination').classList.add('hidden');
    return;
  }
  const content = detail.content;
  $('backupContentSummary').textContent = '以下内容直接解析自受管备份；这里只显示真实用户和助手消息，不会读取备份目录之外的文件。';
  $('backupContentCounts').textContent = `${content.turnCount} 轮 · ${content.messageCount} 条消息 · ${content.recordCount} 条落盘记录`;
  $('backupContentMessages').innerHTML = content.messages.length
    ? content.messages.map((message) => `
      <article class="backup-content-message role-${escapeHtml(message.role)}">
        <header><strong>${escapeHtml(backupMessageRoleLabel(message))}</strong><span>第 ${(message.turnIndex ?? 0) + 1} 轮 · 第 ${message.lineNumber} 行</span></header>
        <pre>${escapeHtml(message.text)}</pre>
      </article>
    `).join('')
    : '<div class="list-status">备份中没有识别到可见的用户或助手消息。</div>';
  const page = content.page;
  $('backupContentPagination').classList.toggle('hidden', content.messageCount <= page.limit);
  $('backupContentPreviousButton').disabled = page.previousOffset === null;
  $('backupContentNextButton').disabled = page.nextOffset === null;
  const first = content.messageCount ? page.offset + 1 : 0;
  const last = Math.min(content.messageCount, page.offset + content.messages.length);
  $('backupContentPageSummary').textContent = `${first}–${last} / ${content.messageCount} 条消息`;
}

async function loadBackupContent(sessionId, offset = 0) {
  if (!state.restoreBackup || !sessionId) return;
  state.backupContentSessionId = sessionId;
  state.backupContentOffset = offset;
  $('backupContentState').className = 'backup-content-state';
  $('backupContentState').textContent = '读取中';
  $('backupContentSummary').textContent = '正在校验备份清单并解析会话正文...';
  $('backupContentMessages').innerHTML = '<div class="list-status">正在安全读取备份内容...</div>';
  try {
    const detail = await api(backupContentEndpoint(), {
      method: 'POST',
      body: JSON.stringify({ backupId: state.restoreBackup.id, sessionId, offset, limit: 80 }),
    });
    if (state.backupContentSessionId !== sessionId || state.backupContentOffset !== offset) return;
    renderBackupContent(detail);
  } catch (error) {
    $('backupContentState').className = 'backup-content-state state-error';
    $('backupContentState').textContent = '读取失败';
    $('backupContentSummary').textContent = error.message;
    $('backupContentMessages').innerHTML = '<div class="list-status">无法读取这个备份的会话正文。</div>';
    throw error;
  }
}

function renderBackupRestoreSessions() {
  const filter = $('backupRestoreFilter').value.trim().toLowerCase();
  const sessions = (state.restoreBackup?.sessions || []).filter((session) => (
    `${session.title || ''} ${session.id}`.toLowerCase().includes(filter)
  ));
  state.visibleRestoreSessionIds = sessions.map((session) => session.id);
  if (!sessions.length) {
    $('backupRestoreList').innerHTML = '<div class="list-status">当前筛选条件下没有匹配的会话。</div>';
  } else {
    $('backupRestoreList').innerHTML = sessions.map((session) => {
      const checked = state.selectedRestoreSessionIds.has(session.id) ? ' checked' : '';
      return `
        <div class="restore-session-entry">
          <input type="checkbox" data-restore-session="${escapeHtml(session.id)}"${checked}>
          <span class="backup-title">${escapeHtml(session.title || '(untitled)')}</span>
          <span class="session-id">${escapeHtml(session.id)}</span>
          <button type="button" data-restore-content="${escapeHtml(session.id)}">查看内容</button>
        </div>
      `;
    }).join('');
  }
  updateRestoreSelectionControls();
}

async function openBackupRestore(backupId, sessionId = null) {
  const backup = state.deletionBackups.find((item) => item.id === backupId);
  if (!backup) return;
  const selectedSession = sessionId
    ? backup.sessions.find((session) => session.id === sessionId)
    : null;
  if (sessionId && !selectedSession) {
    throw new Error('所选会话不在这个备份包中，请刷新备份列表后重试。');
  }
  if ($('backupManagerDialog').open) $('backupManagerDialog').close();
  state.restoreBackupKind = isClaudePlatform() ? 'claude-deletion' : 'deletion';
  state.restoreBackup = backup;
  state.selectedRestoreSessionIds = new Set();
  state.visibleRestoreSessionIds = [];
  $('backupRestoreTitle').textContent = selectedSession
    ? `恢复会话：${selectedSession.title || selectedSession.id}`
    : (isClaudePlatform() ? '从 Claude 批量删除备份恢复' : '从批量删除备份恢复');
  $('backupRestoreSource').textContent = selectedSession
    ? `${formatDate(backup.createdAt)} · 来自包含 ${backup.sessions.length} 个会话的备份包 · ${backup.backupDir}`
    : `${formatDate(backup.createdAt)} · 批量备份包内共 ${backup.sessions.length} 个会话 · ${backup.backupDir}`;
  $('backupRestoreFilter').value = '';
  resetBackupRestorePlan();
  resetBackupContent();
  const directSession = selectedSession || (backup.sessions.length === 1 ? backup.sessions[0] : null);
  $('backupRestoreSelection').classList.toggle('hidden', Boolean(directSession));
  if (directSession) {
    state.selectedRestoreSessionIds = new Set([directSession.id]);
  } else {
    renderBackupRestoreSessions();
  }
  $('backupRestoreDialog').showModal();
  updateBackupAutoDetectTimer();
  if (directSession) {
    await Promise.all([
      loadBackupContent(directSession.id),
      previewBackupRestore(),
    ]);
  }
}

async function openOperationBackupRestore(backupId) {
  const snapshot = state.operationBackups.find((item) => item.id === backupId);
  if (!snapshot) return;
  if ($('backupManagerDialog').open) $('backupManagerDialog').close();
  state.restoreBackupKind = 'operation';
  state.restoreBackup = {
    ...snapshot,
    sessions: [{
      id: snapshot.sessionId,
      title: snapshot.title,
      projectPath: snapshot.projectPath,
    }],
  };
  state.selectedRestoreSessionIds = new Set([snapshot.sessionId]);
  state.visibleRestoreSessionIds = [];
  $('backupRestoreTitle').textContent = '恢复轮次操作快照';
  $('backupRestoreSource').textContent = `${snapshot.kindLabel} · ${formatDate(snapshot.createdAt)} · ${snapshot.path}`;
  $('backupRestoreFilter').value = '';
  resetBackupRestorePlan();
  resetBackupContent();
  $('backupRestoreSelection').classList.add('hidden');
  $('backupRestoreDialog').showModal();
  updateBackupAutoDetectTimer();
  await Promise.all([
    loadBackupContent(snapshot.sessionId),
    previewBackupRestore(),
  ]);
}

function closeBackupRestore() {
  state.restoreBackup = null;
  state.restoreBackupKind = 'deletion';
  state.selectedRestoreSessionIds = new Set();
  resetBackupRestorePlan();
  resetBackupContent();
  $('backupRestoreDialog').close();
  updateBackupAutoDetectTimer();
}

function renderBackupRestorePlan(plan) {
  state.backupRestorePlan = plan;
  state.backupRestoreDetectionSignature = plan.planToken || null;
  if (state.restoreBackupKind === 'claude-deletion') {
    $('backupRestorePrimaryLabel').textContent = '恢复文件';
    $('backupRestoreReplacedLabel').textContent = '已经存在';
    $('backupRestoreSecondaryLabel').textContent = '恢复数据目录';
    $('backupRestoreIndexLabel').textContent = '恢复索引记录';
    $('backupRestoreProviderLabel').textContent = '恢复方式';
    $('backupRestoreSessions').textContent = String(plan.summary.sessions);
    $('backupRestoreRollouts').textContent = String(plan.summary.artifactFiles);
    $('backupRestoreReplaced').textContent = String(plan.summary.alreadyPresent || 0);
    $('backupRestoreSqlite').textContent = '随会话包恢复';
    $('backupRestoreIndex').textContent = String(plan.summary.indexRows);
    $('backupRestoreConflicts').textContent = String(plan.summary.conflicts);
    $('backupRestoreProvider').textContent = '保持 Claude 原生格式';
    const messages = [];
    if (plan.summary.conflicts) messages.push(`${plan.summary.conflicts} 个目标路径已有不同内容；工具拒绝覆盖。`);
    if (plan.summary.alreadyPresent) messages.push(`${plan.summary.alreadyPresent} 个数据项已与备份一致，将跳过。`);
    $('backupRestoreWarning').textContent = messages.join(' ');
    $('backupRestoreWarning').classList.toggle('hidden', messages.length === 0);
    $('backupRestoreConfirmation').value = '';
    $('applyBackupRestoreButton').disabled = true;
    $('backupRestorePlan').classList.remove('hidden');
    $('applyBackupRestoreButton').textContent = plan.summary.sessions > 1 ? '安全恢复所选会话' : '安全恢复这个会话';
    return;
  }
  $('backupRestorePrimaryLabel').textContent = '恢复 rollout';
  $('backupRestoreReplacedLabel').textContent = '替换现有正文';
  $('backupRestoreSecondaryLabel').textContent = '写入 SQLite';
  $('backupRestoreIndexLabel').textContent = '恢复旧索引';
  $('backupRestoreProviderLabel').textContent = '当前供应商';
  $('backupRestoreSessions').textContent = String(plan.summary.sessions);
  $('backupRestoreRollouts').textContent = String(plan.summary.rolloutFiles);
  $('backupRestoreReplaced').textContent = String(plan.summary.replacedRollouts || 0);
  $('backupRestoreSqlite').textContent = String(plan.summary.sqliteRows);
  $('backupRestoreIndex').textContent = String(plan.summary.indexRows);
  $('backupRestoreConflicts').textContent = String(plan.summary.conflicts);
  $('backupRestoreProvider').textContent = plan.currentProvider;
  const messages = [];
  if (plan.blockedByActiveTarget) {
    const count = plan.targetSessionLock?.activeSessionIds?.length || 1;
    messages.push(`${count} 个目标会话仍在 Codex 中打开。请只关闭这些目标会话后重新预览；其他 Codex 窗口可以保持打开。`);
  } else if (plan.codexRunning) {
    messages.push('其他 Codex 窗口仍在运行，不影响本次恢复。工具会锁定目标会话并清理其分页历史投影。');
  }
  if (plan.summary.conflicts) {
    messages.push(`${plan.summary.conflicts} 个当前 rollout 与备份内容不同，工具拒绝覆盖。`);
  }
  if (plan.summary.replacedRollouts) {
    messages.push(`${plan.summary.replacedRollouts} 个当前正文将被所选快照替换；工具会先保存恢复前安全点。`);
  }
  if (plan.summary.alreadyPresent) {
    messages.push(`${plan.summary.alreadyPresent} 个会话已经完整存在，不需要重复恢复。`);
  }
  $('backupRestoreWarning').textContent = messages.join(' ');
  $('backupRestoreWarning').classList.toggle('hidden', messages.length === 0);
  $('backupRestoreConfirmation').value = '';
  $('applyBackupRestoreButton').disabled = true;
  $('backupRestorePlan').classList.remove('hidden');
  $('applyBackupRestoreButton').textContent = plan.summary.sessions > 1 ? '安全恢复所选会话' : '安全恢复这个会话';
}

async function previewBackupRestore() {
  if (!state.restoreBackup || !state.selectedRestoreSessionIds.size) return;
  setAlert('');
  const request = backupRestoreRequest();
  const plan = await api(request.endpoint, {
    method: 'POST',
    body: JSON.stringify(request.body),
  });
  renderBackupRestorePlan(plan);
  if (state.selectedRestoreSessionIds.size === 1) {
    const [sessionId] = state.selectedRestoreSessionIds;
    if (state.backupContentSessionId !== sessionId) await loadBackupContent(sessionId);
  }
}

async function applyBackupRestore() {
  const plan = state.backupRestorePlan;
  if (!plan) return;
  const operationRestore = state.restoreBackupKind === 'operation';
  const claudeRestore = state.restoreBackupKind === 'claude-deletion';
  const body = await api(claudeRestore
    ? '/api/claude-code/session-deletion-backups/restore-apply'
    : (operationRestore ? '/api/operation-backups/restore-apply' : '/api/deletion-backups/restore-apply'), {
    method: 'POST',
    body: JSON.stringify(operationRestore
      ? {
        backupId: plan.backupId,
        planToken: plan.planToken,
        confirmation: $('backupRestoreConfirmation').value,
      }
      : {
        backupId: plan.backupId,
        sessionIds: plan.sessions.map((session) => session.id),
        planToken: plan.planToken,
        confirmation: $('backupRestoreConfirmation').value,
      }),
  });
  closeBackupRestore();
  await loadSessions();
  if (claudeRestore) {
    setAlert(`已恢复 ${body.restored.sessions} 个 Claude Code 会话。请退出或重新打开 Claude Code，以重新读取会话列表。`, 'success');
    return;
  }
  setAlert(
    `已恢复 ${body.restored.sessions} 个会话；当前状态安全备份位于 ${body.safety.safetyDir}。打开目标会话时 Codex 会从 rollout 重建分页历史，其他窗口无需退出。`,
    'success',
  );
}

$('codexPlatformButton').addEventListener('click', () => setPlatform('codex').catch((error) => setAlert(error.message)));
$('claudePlatformButton').addEventListener('click', () => setPlatform('claude').catch((error) => setAlert(error.message)));
$('refreshButton').addEventListener('click', () => loadSessions().catch((error) => setAlert(error.message)));
$('metricsHelpButton').addEventListener('click', () => $('metricsDialog').showModal());
$('closeMetricsButton').addEventListener('click', () => $('metricsDialog').close());
$('closeSessionHealthButton').addEventListener('click', closeSessionHealth);
$('reloadSessionHealthButton').addEventListener('click', () => {
  if (state.healthSessionId) openSessionHealth(state.healthSessionId).catch((error) => setAlert(error.message));
});
$('sessionHealthActions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-health-action]');
  if (!button || button.disabled) return;
  runHealthAction(button.dataset.healthAction).catch((error) => setAlert(error.message));
});
$('visibilityButton').addEventListener('click', () => previewVisibilityRepair().catch((error) => setAlert(error.message)));
$('closeVisibilityButton').addEventListener('click', () => {
  state.visibilityPlan = null;
  $('visibilityPanel').classList.add('hidden');
});
$('visibilityConfirmation').addEventListener('input', () => {
  $('applyVisibilityButton').disabled = !(
    state.visibilityPlan?.canApply
    && $('visibilityConfirmation').value === 'SYNC'
  );
});
$('applyVisibilityButton').addEventListener('click', () => applyVisibilityRepair().catch((error) => setAlert(error.message)));
$('deleteSessionButton').addEventListener('click', () => previewSessionDelete().catch((error) => setAlert(error.message)));
$('closeSessionDeleteButton').addEventListener('click', closeSessionDeleteDialog);
$('sessionDeleteConfirmation').addEventListener('input', () => {
  $('applySessionDeleteButton').disabled = !(
    state.sessionDeletePlan?.canApply
    && $('sessionDeleteConfirmation').value === 'PURGE'
  );
});
$('applySessionDeleteButton').addEventListener('click', () => applySessionDelete().catch((error) => setAlert(error.message)));
$('batchDeleteSessionsButton').addEventListener('click', () => previewBatchSessionDelete().catch((error) => setAlert(error.message)));
$('clearSessionSelectionButton').addEventListener('click', () => {
  state.selectedSessionIds = new Set();
  renderSessions();
});
$('selectVisibleSessions').addEventListener('change', (event) => {
  for (const id of state.visibleSessionIds) {
    if (event.target.checked) state.selectedSessionIds.add(id);
    else state.selectedSessionIds.delete(id);
  }
  renderSessions();
});
$('backupManagerButton').addEventListener('click', () => openBackupManager().catch((error) => setAlert(error.message)));
$('backupManagerDialog').addEventListener('close', updateBackupAutoDetectTimer);
$('backupRestoreDialog').addEventListener('close', updateBackupAutoDetectTimer);
$('backupAutoDetectEnabled').addEventListener('change', () => {
  $('backupAutoDetectStatus').textContent = $('backupAutoDetectEnabled').checked
    ? '打开期间每 15 秒检测一次，不会自动恢复或修改会话。'
    : '自动检测已关闭；仍可使用“立即检测”。';
  updateBackupAutoDetectTimer();
});
$('detectBackupChangesButton').addEventListener('click', () => detectBackupChanges({ manual: true }));
$('operationHistoryButton').addEventListener('click', () => openOperationHistory().catch((error) => setAlert(error.message)));
$('closeOperationHistoryButton').addEventListener('click', closeOperationHistory);
$('operationHistoryList').addEventListener('click', (event) => {
  const undo = event.target.closest('[data-undo-operation]');
  if (undo) {
    undoOperation(undo.dataset.undoOperation).catch((error) => setAlert(error.message));
    return;
  }
  const button = event.target.closest('[data-restore-history-operation]');
  if (button) restoreHistoryErrorOperation(button.dataset.restoreHistoryOperation).catch((error) => setAlert(error.message));
});
$('operationUndoConfirmation').addEventListener('input', () => {
  $('undoLatestOperationButton').disabled = !(
    state.operationHistory?.latest?.canUndo
    && $('operationUndoConfirmation').value === 'UNDO'
  );
});
$('undoLatestOperationButton').addEventListener('click', () => undoLatestOperation().catch((error) => setAlert(error.message)));
$('closeBackupManagerButton').addEventListener('click', closeBackupManager);
$('deletionBackupsTab').addEventListener('click', () => {
  state.backupManagerView = 'deletion';
  renderBackupManager();
});
$('operationBackupsTab').addEventListener('click', () => {
  state.backupManagerView = 'operation';
  renderBackupManager();
});
$('systemBackupsTab').addEventListener('click', () => {
  state.backupManagerView = 'system';
  renderBackupManager();
});
$('backupManagerList').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-backup-select], [data-operation-backup-select], [data-system-backup-select]');
  if (!checkbox) return;
  const operationBackupId = checkbox.dataset.operationBackupSelect;
  const systemBackupId = checkbox.dataset.systemBackupSelect;
  const target = operationBackupId
    ? state.selectedOperationBackupIds
    : (systemBackupId ? state.selectedSystemBackupIds : state.selectedBackupIds);
  const id = operationBackupId || systemBackupId || checkbox.dataset.backupSelect;
  if (checkbox.checked) target.add(id);
  else target.delete(id);
  $('backupDeleteConfirmation').value = '';
  $('deleteSelectedBackupsButton').disabled = true;
});
$('backupManagerList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-backup-session-open], [data-backup-batch-open], [data-operation-backup-open], [data-system-backup-restore]');
  if (!button) return;
  if (button.dataset.systemBackupRestore) {
    previewVisibilitySystemBackup(button.dataset.systemBackupRestore).catch((error) => setAlert(error.message));
  } else if (button.dataset.operationBackupOpen) {
    openOperationBackupRestore(button.dataset.operationBackupOpen).catch((error) => setAlert(error.message));
  } else if (button.dataset.backupSessionOpen) {
    openBackupRestore(button.dataset.backupSessionOpen, button.dataset.backupSessionId).catch((error) => setAlert(error.message));
  } else {
    openBackupRestore(button.dataset.backupBatchOpen).catch((error) => setAlert(error.message));
  }
});
$('backupDeleteConfirmation').addEventListener('input', () => {
  const selectedCount = state.backupManagerView === 'operation'
    ? state.selectedOperationBackupIds.size
    : (state.backupManagerView === 'system'
      ? state.selectedSystemBackupIds.size
      : state.selectedBackupIds.size);
  $('deleteSelectedBackupsButton').disabled = !(
    selectedCount > 0
    && $('backupDeleteConfirmation').value === 'ERASE'
  );
});
$('deleteSelectedBackupsButton').addEventListener('click', () => deleteSelectedBackups().catch((error) => setAlert(error.message)));
$('closeVisibilityBackupRestoreButton').addEventListener('click', closeVisibilityBackupRestore);
$('visibilityRestoreConfirmation').addEventListener('input', () => {
  $('applyVisibilityBackupRestoreButton').disabled = !(
    state.visibilityBackupRestorePlan?.canApply
    && $('visibilityRestoreConfirmation').value === 'ROLLBACK'
  );
});
$('applyVisibilityBackupRestoreButton').addEventListener('click', () => applyVisibilitySystemBackup().catch((error) => setAlert(error.message)));
$('closeBackupRestoreButton').addEventListener('click', closeBackupRestore);
$('backupRestoreFilter').addEventListener('input', () => {
  resetBackupRestorePlan();
  renderBackupRestoreSessions();
});
$('backupRestoreList').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-restore-session]');
  if (!checkbox) return;
  if (checkbox.checked) state.selectedRestoreSessionIds.add(checkbox.dataset.restoreSession);
  else state.selectedRestoreSessionIds.delete(checkbox.dataset.restoreSession);
  resetBackupRestorePlan();
  updateRestoreSelectionControls();
});
$('backupRestoreList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-restore-content]');
  if (!button) return;
  loadBackupContent(button.dataset.restoreContent).catch((error) => setAlert(error.message));
});
$('selectVisibleRestoreSessions').addEventListener('change', (event) => {
  for (const id of state.visibleRestoreSessionIds) {
    if (event.target.checked) state.selectedRestoreSessionIds.add(id);
    else state.selectedRestoreSessionIds.delete(id);
  }
  resetBackupRestorePlan();
  renderBackupRestoreSessions();
});
$('previewBackupRestoreButton').addEventListener('click', () => previewBackupRestore().catch((error) => setAlert(error.message)));
$('backupContentPreviousButton').addEventListener('click', () => {
  const offset = state.backupContent?.content?.page?.previousOffset;
  if (offset !== null && offset !== undefined) loadBackupContent(state.backupContentSessionId, offset).catch((error) => setAlert(error.message));
});
$('backupContentNextButton').addEventListener('click', () => {
  const offset = state.backupContent?.content?.page?.nextOffset;
  if (offset !== null && offset !== undefined) loadBackupContent(state.backupContentSessionId, offset).catch((error) => setAlert(error.message));
});
$('backupRestoreConfirmation').addEventListener('input', () => {
  $('applyBackupRestoreButton').disabled = !(
    state.backupRestorePlan?.canApply
    && $('backupRestoreConfirmation').value === 'RESTORE'
  );
});
$('applyBackupRestoreButton').addEventListener('click', () => applyBackupRestore().catch((error) => setAlert(error.message)));
$('sessionFilter').addEventListener('input', renderSessions);
$('directoryFilter').addEventListener('change', () => {
  state.selectedDirectory = $('directoryFilter').value;
  state.selectedSession = null;
  $('deleteSessionButton').disabled = true;
  state.turns = [];
  $('sessionFilter').value = '';
  $('sessionFilter').disabled = !state.selectedDirectory;
  resetTurnWorkspace();
  $('turns').className = 'turns-empty';
  $('turns').textContent = state.selectedDirectory ? '请选择一个会话。' : '请先选择项目目录。';
  $('turnCount').textContent = '尚未选择会话';
  $('turnContext').classList.add('hidden');
  renderSessions();
});
$('sessions').addEventListener('click', (event) => {
  const healthButton = event.target.closest('[data-session-health]');
  if (healthButton) {
    openSessionHealth(healthButton.dataset.sessionHealth).catch((error) => setAlert(error.message));
    return;
  }
  const row = event.target.closest('[data-session-id]');
  if (!row) return;
  selectSession(row.dataset.sessionId).catch((error) => setAlert(error.message));
});
$('sessions').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-session-select]');
  if (!checkbox) return;
  if (checkbox.checked) state.selectedSessionIds.add(checkbox.dataset.sessionSelect);
  else state.selectedSessionIds.delete(checkbox.dataset.sessionSelect);
  updateBatchControls();
});
$('turns').addEventListener('click', (event) => {
  const historyRestore = event.target.closest('[data-restore-history-operation]');
  if (historyRestore) {
    restoreHistoryErrorOperation(historyRestore.dataset.restoreHistoryOperation).catch((error) => setAlert(error.message));
    return;
  }
  const historyDelete = event.target.closest('[data-delete-history-error]');
  if (historyDelete) {
    deleteHistoryErrorTurn(historyDelete.dataset.deleteHistoryError).catch((error) => setAlert(error.message));
    return;
  }
  const row = event.target.closest('[data-turn-index]');
  if (!row) return;
  selectTurn(Number.parseInt(row.dataset.turnIndex, 10)).catch((error) => setAlert(error.message));
});
$('messagesTabButton').addEventListener('click', () => setOperationView('messages'));
$('cleanupTabButton').addEventListener('click', () => setOperationView('cleanup'));
$('compactContextButton').addEventListener('click', () => setContextMode('compact').catch((error) => setAlert(error.message)));
$('fullContextButton').addEventListener('click', () => setContextMode('full').catch((error) => setAlert(error.message)));
$('fullContextFirstButton').addEventListener('click', () => loadFullContext(0).catch((error) => setAlert(error.message)));
$('fullContextPreviousButton').addEventListener('click', () => {
  const offset = state.fullContext?.page?.previousOffset;
  if (offset !== null && offset !== undefined) loadFullContext(offset).catch((error) => setAlert(error.message));
});
$('fullContextCurrentButton').addEventListener('click', () => {
  if (state.selectedTurn) jumpToFullContextLine(state.selectedTurn.startLine).catch((error) => setAlert(error.message));
});
$('fullContextNextButton').addEventListener('click', () => {
  const offset = state.fullContext?.page?.nextOffset;
  if (offset !== null && offset !== undefined) loadFullContext(offset).catch((error) => setAlert(error.message));
});
$('fullContextSearch').addEventListener('input', () => {
  clearTimeout(state.fullContextSearchTimer);
  state.fullContextSearchTimer = setTimeout(() => {
    loadFullContext(0).catch((error) => setAlert(error.message));
  }, 280);
});
['fullContextRoleFilter', 'fullContextCategoryFilter', 'fullContextCurrentOnly'].forEach((id) => {
  $(id).addEventListener('change', () => loadFullContext(0).catch((error) => setAlert(error.message)));
});
$('fullContextTurnJump').addEventListener('change', (event) => {
  const turnIndex = Number.parseInt(event.target.value, 10);
  if (Number.isInteger(turnIndex) && turnIndex !== state.selectedTurn?.index) {
    selectTurn(turnIndex, { operation: 'messages' }).catch((error) => setAlert(error.message));
  }
});
$('fullContextLineJumpButton').addEventListener('click', () => {
  const lineNumber = Number.parseInt($('fullContextLineJump').value, 10);
  jumpToFullContextLine(lineNumber).catch((error) => setAlert(error.message));
});
$('fullContextLineJump').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('fullContextLineJumpButton').click();
});
$('exportFullContextJsonlButton').addEventListener('click', () => {
  exportFullContext('jsonl').catch((error) => setAlert(error.message));
});
$('exportFullContextMarkdownButton').addEventListener('click', () => {
  exportFullContext('markdown').catch((error) => setAlert(error.message));
});
$('messageList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-edit-target]');
  if (!button) return;
  const targetId = button.dataset.editTarget;
  const textarea = $('messageList').querySelector(`[data-message-target="${targetId}"]`);
  textarea.readOnly = !textarea.readOnly;
  button.textContent = textarea.readOnly ? '编辑' : '完成';
  if (!textarea.readOnly) textarea.focus();
});
$('messageList').addEventListener('input', (event) => {
  const textarea = event.target.closest('[data-message-target]');
  if (!textarea) return;
  const part = findMessagePart(textarea.dataset.messageTarget);
  if (!part) return;
  if (textarea.value === part.text) {
    state.edits.delete(part.targetId);
  } else {
    state.edits.set(part.targetId, {
      targetId: part.targetId,
      expectedText: part.text,
      newText: textarea.value,
    });
  }
  clearEditPreview();
  updateEditControls();
  resizeMessageEditor(textarea);
});
$('discardEditsButton').addEventListener('click', () => {
  state.edits = new Map();
  clearEditPreview();
  renderMessages();
});
$('previewEditsButton').addEventListener('click', () => previewEdits().catch((error) => setAlert(error.message)));
$('editConfirmation').addEventListener('input', () => {
  $('applyEditButton').disabled = !(
    state.editPreview
    && !state.editPreview.blockedByActiveTarget
    && $('editConfirmation').value === 'EDIT'
  );
});
$('applyEditButton').addEventListener('click', () => applyEdits().catch((error) => setAlert(error.message)));
$('restoreEditButton').addEventListener('click', () => restoreLastEdit().catch((error) => setAlert(error.message)));
document.querySelectorAll('input[name="cleanupMode"]').forEach((input) => {
  input.addEventListener('change', () => {
    state.mode = input.value;
    resetCleanupPreview();
    refreshCleanupPreview().catch((error) => setAlert(error.message));
    setOperationView('cleanup');
  });
});
$('confirmation').addEventListener('input', () => {
  $('applyButton').disabled = !(
    state.preview
    && !state.cleanupTargetActive
    && $('confirmation').value === 'DELETE'
  );
});
$('applyButton').addEventListener('click', () => applyCleanup().catch((error) => setAlert(error.message)));

try {
  const savedPlatform = localStorage.getItem('ctc-platform');
  if (savedPlatform === 'claude' || savedPlatform === 'codex') state.platform = savedPlatform;
} catch {}
configurePlatformUI();
initTheme();
initPanelLayout();
setOperationView('messages');
loadSessions().catch((error) => setAlert(error.message));
