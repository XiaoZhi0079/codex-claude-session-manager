# 系统架构

## 目标与边界

Local Session Manager 是本地单进程工具：Node.js HTTP 服务负责扫描和受控写入，原生 HTML/CSS/JavaScript 页面负责交互。没有远端后端、登录系统或第三方运行时依赖。服务默认绑定 `127.0.0.1`。

工具不把 `config.toml` 当作会话清单。供应商配置只用于确定当前目标供应商；会话身份与正文来自多个可验证数据源的合并。

## 模块职责

| 文件 | 职责 |
|---|---|
| `bin/codex-turn-cleaner.mjs` | 命令行参数、启动和退出处理 |
| `src/server.mjs` | 静态页面、REST 路由、写操作审计和一键撤销编排 |
| `src/registry.mjs` | 合并扫描会话来源、判定 Codex 可见性、供应商统一 |
| `src/core.mjs` | JSONL 解析、轮次边界、消息编辑、轮次清理和 rollout 恢复 |
| `src/context-view.mjs` | 完整上下文分类、过滤、分页、定位和导出 |
| `src/claude-sessions.mjs` | Claude Code 主会话扫描、标题解析、轮次、侧边数据、子代理、诊断与落盘上下文 |
| `src/claude-session-delete.mjs` | Claude 完整会话包删除预览、指纹校验、备份、恢复与永久删除 |
| `src/claude-turn-delete.mjs` | Claude 单轮对话删除预览、主 JSONL 与外置产物备份、字节保留重写与恢复 |
| `src/session-health.mjs` | 单会话正文、标题、SQLite、供应商和备份诊断 |
| `src/session-delete.mjs` | 整会话预览、单条/批量删除、删除备份管理和恢复 |
| `src/operation-backup.mjs` | 轮次快照与系统备份的发现、删除、预览和恢复 |
| `src/operation-history.mjs` | 追加式操作事件、状态折叠、中断识别和撤销资格 |
| `public/index.html` | 当前正式页面结构 |
| `public/app.js` | 页面状态、API 调用和交互逻辑 |
| `public/styles.css`、`public/redesign.css` | 基础样式和当前视觉系统 |

## 会话来源合并

扫描顺序不是简单覆盖，而是按会话 ID 合并事实：

1. `sessions/**/rollout-*.jsonl` 与 `archived_sessions/**/rollout-*.jsonl` 提供正文、项目目录、时间和供应商元数据。
2. 最新可用的 `state_N.sqlite` 中 `threads` 表提供 Codex 当前线程索引、正式标题、rollout 路径和 `model_provider`。
3. `session_index.jsonl` 提供旧版 Codex 标题与索引兼容信息。
4. CCSwitch 迁移备份和本工具普通备份用于诊断正文是否仍可恢复。
5. 整会话删除备份单独管理，不作为普通“仅备份会话”重新混入列表。

输出会话对象保留各来源事实，再计算 `storageStatus`、`codexVisible`、`hiddenFromCodex` 等展示状态。友好标题优先使用 Codex/SQLite 或旧索引标题，只有正式标题缺失时才从首条用户消息推导。

## 主要数据流

### 平台适配

Codex 与 Claude Code 是并列领域，不进行会话格式转换。Codex 会话以 rollout/SQLite 合并事实为基础；Claude Code 会话以 `projects/<项目>/<sessionId>.jsonl` 为正文真值，并按 sessionId 聚合 `tool-results`、`subagents`、`tasks`、`file-history` 与 `session-env`。前端共享三栏交互，但 API 和解析模块彼此独立。

Claude Code 的 `sessions-index.json` 只补充摘要标题和项目路径。`custom-title` 优先级最高；带 `isMeta`、`<local-command-*>` 或 `<command-name>` 的控制记录只在落盘模式显示，不参与精简标题和轮次边界。

Claude JSONL 的 `message.role` 是传输信封角色，不等于内容来源：工具结果通常使用 `user` 信封，客户端事件也可能使用 `system` 类型。Claude 落盘模式因此额外计算 `source`，区分人类、Claude、工具、运行时注入、客户端事件和子代理。内置基础身份提示词存在于 Claude Code 运行时，不属于历史 JSONL 可恢复事实。

Claude 删除把主 JSONL、`projects/<项目>/<sessionId>`、`tasks/<sessionId>`、`file-history/<sessionId>`、`session-env/<sessionId>` 和索引条目视为一个聚合。删除前逐项计算指纹并复制到工具专属备份目录，验证副本后才删除；恢复只写回缺失或完全一致的目标，拒绝覆盖不同内容。

### 只读操作

浏览器请求 → `src/server.mjs` → registry/core/context/health → 读取本地文件或 SQLite → JSON 返回。只读接口不会创建操作历史。

### 写操作

浏览器预览 → 服务端读取当前事实并生成哈希化计划 → 用户输入确认词 → 服务端重新校验计划/文件 → 创建备份或安全点 → 原子文件写入或 SQLite 事务 → 写后验证 → 记录完成事件 → 页面提示刷新方式。

任一步骤失败时，模块使用原始正文、备份或事务执行回滚，并把回滚错误记录到操作历史。

### 一键撤销

操作历史只把最新完成且带 `undo` 恢复描述的记录标记为 `canUndo`。撤销请求再次核对操作 ID，随后根据恢复类型调用 rollout 恢复、会话删除备份恢复或可见性备份恢复。撤销本身也是新的操作记录，原记录随后标记为 `undone`。

## 操作历史模型

历史文件是 JSONL 追加日志，每个操作由事件折叠为当前状态：

- `started`：写操作即将开始；
- `completed`：写入成功并记录摘要/恢复描述；
- `failed`：执行失败及回滚结果；
- `undone`：原操作已由另一次撤销操作恢复。

每次服务启动都有新 `instanceId`。旧实例只有 `started`、没有结束事件的操作会显示为“已中断”，提醒用户到备份管理检查，而不是假定成功或失败。
