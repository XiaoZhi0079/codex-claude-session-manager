# HTTP API

默认基址为 `http://127.0.0.1:18797`。除下载接口外均返回 JSON；错误格式为 `{ "error": { "code", "message", "details" } }`。

## 扫描与诊断

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 服务存活检查 |
| GET | `/api/sessions` | 重新扫描并返回目录、会话和汇总 |
| GET | `/api/sessions/:id/health` | 会话完整性与来源诊断 |
| GET | `/api/sessions/:id/turns` | 解析会话轮次；分页历史数据库异常时仍返回 rollout 正文，并在 `threadHistory` 标注降级原因 |
| POST | `/api/turn-detail` | 读取紧凑轮次消息 |
| POST | `/api/full-context` | 完整上下文筛选、分页与定位 |
| POST | `/api/full-context/export` | 导出 JSONL 或 Markdown |

Codex 轮次的 `status` 可为 `completed`、`failed` 或 `aborted`。`failed` 轮次保留 `task_complete.error.message` 和 `codex_error_info`；精简轮次详情会把错误作为只读 `error` 消息返回，不会将其当作可编辑的助手消息。

## Claude Code 资源

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/claude-code/sessions` | 扫描全部 Claude Code 主会话并返回目录、诊断和空间汇总 |
| GET | `/api/claude-code/sessions/:id/turns` | 返回真实用户对话轮次；排除本地命令控制记录 |
| GET | `/api/claude-code/sessions/:id/turns/:turnId` | 返回只读精简消息 |
| GET | `/api/claude-code/sessions/:id/context` | 返回主记录、完整外置结果与关联子代理上下文 |

上下文接口接受 `turnId`、`offset`、`limit`、`query`、`source`、`role`、`category`、`scope` 与 `lineNumber` 查询参数。`source` 是语义来源，支持 `human`、`claude`、`tool`、`runtime`、`client`、`subagent`；`role` 仅保留原始 JSONL 信封角色筛选。`limit` 范围为 1–200。

Claude 会话删除与备份：

| 方法 | 路径 | 用途 / 确认词 |
|---|---|---|
| POST | `/api/claude-code/session-deletions/preview` | 预览单条或批量完整会话包删除 |
| POST | `/api/claude-code/session-deletions/apply` | 备份并删除；确认词 `PURGE` |
| GET | `/api/claude-code/session-deletion-backups` | 列出工具创建的 Claude 删除备份 |
| POST | `/api/claude-code/session-deletion-backups/restore-preview` | 预览按会话恢复 |
| POST | `/api/claude-code/session-deletion-backups/content` | 安全读取备份内指定会话的精简对话和当前状态差异 |
| POST | `/api/claude-code/session-deletion-backups/restore-apply` | 恢复；确认词 `RESTORE` |
| POST | `/api/claude-code/session-deletion-backups/delete` | 永久删除备份；确认词 `ERASE` |

删除与恢复都必须携带预览返回的 `planToken`。目标状态改变后返回 409，不会继续使用过期计划。

Claude Code 轮次删除：

| 方法 | 路径 | 用途 / 确认词 |
|---|---|---|
| POST | `/api/claude-code/sessions/:id/turns/:turnId/delete-preview` | 预览删除该轮对话及引用的外置产物 |
| POST | `/api/claude-code/sessions/:id/turns/:turnId/delete-apply` | 备份并删除该轮；确认词 `DELETE` |

轮次删除 `mode` 为 `truncate`（该轮及之后截断）或 `single`（仅删除所选轮）。写入接口必须携带预览返回的 `sourceHash`。会一并删除该轮引用的 `tool-results` 外置输出文件与关联子代理 JSONL，写前备份、可一键撤销。

## 轮次编辑与清理

| 方法 | 路径 | 确认词 |
|---|---|---|
| POST | `/api/edit-preview` | 无 |
| POST | `/api/edit-apply` | `EDIT` |
| POST | `/api/edit-restore` | `RESTORE` |
| POST | `/api/preview` | 无 |
| POST | `/api/apply` | `DELETE` |

清理 `mode` 为 `truncate`（从所选轮开始）或 `single`（只删除所选轮）。写入接口必须携带预览返回的 `sourceHash`。

Codex 编辑与清理预览会返回 `targetSessionLock`。若 `activeSessionIds` 非空，必须只关闭这些目标会话后重新预览；其他 Codex 窗口可以继续运行。成功写入会返回 `threadHistory`，其中包含写前状态、数据库备份和仅针对目标会话的投影失效统计。

## 项目路径迁移

| 方法 | 路径 | 用途 / 确认词 |
|---|---|---|
| POST | `/api/project-path-migrations/preview` | 按 `platform`、`fromPath` 和 `toPath` 预览 Codex 或 Claude Code 路径迁移 |
| POST | `/api/project-path-migrations/apply` | 备份并迁移；确认词 `MIGRATE` |

目标项目目录必须已经存在。Codex 迁移要求完全退出 Codex，并更新 rollout、SQLite 与兼容索引；Claude Code 迁移会更新主 JSONL、项目索引，并把会话主文件和侧边目录移入新路径对应的项目存储。成功操作可从操作历史回退。

## Codex 跨电脑会话迁移

| 方法 | 路径 | 用途 / 确认词 |
|---|---|---|
| POST | `/api/codex-session-transfer/export` | 根据 `sessionIds` 下载二进制 `.ccsm` 包 |
| POST | `/api/codex-session-transfer/import-upload` | 以 `application/octet-stream` 上传并完整校验迁移包 |
| POST | `/api/codex-session-transfer/import-preview` | 根据 `transferId`、`pathMappings` 和 `mode` 校验目标项目与冲突 |
| POST | `/api/codex-session-transfer/import-apply` | 重新校验并导入；确认词 `IMPORT` |

`import-upload` 会为目标机上仍然存在的源项目路径返回 `suggestedTargetPath`。`mode=resume` 要求源、目标项目指纹一致，写入 rollout、当前 `state_N.sqlite` 和兼容标题索引，并要求完全退出 Codex。预览结果分别提供 `projectMappingsRequired`（目录未映射）和 `projectContentMismatches`（目录内容不同），避免将两种原因混为一谈。`mode=history` 只写入 rollout，允许项目不一致，不会建立 Codex 可续聊索引。同 ID 同正文跳过，同 ID 不同正文作为硬冲突拒绝覆盖。成功导入会记录 `codex_session_import_restore` 回退描述；若导入后的正文已经变化，自动回退会被拒绝。

## 可见性

| 方法 | 路径 | 确认词 |
|---|---|---|
| GET | `/api/visibility/preview` | 无 |
| POST | `/api/visibility/apply` | `SYNC` |

写入请求必须携带预览返回的 `planToken`。修复只统一 rollout 和 SQLite 的供应商元数据；实际发生修改时会生成带逐项原值的系统安全备份。

## 整会话删除

| 方法 | 路径 | 确认词 |
|---|---|---|
| POST | `/api/session-delete/preview` | 无 |
| POST | `/api/session-delete/apply` | `PURGE` |
| POST | `/api/session-delete/batch-preview` | 无 |
| POST | `/api/session-delete/batch-apply` | `PURGE` |

删除预览和两类恢复预览返回 `targetSessionLock`、`blockedByActiveTarget` 与 `canApply`。应用接口在写入期间再次持有目标会话锁，不能用旧预览绕过。删除、删除备份恢复和轮次快照恢复的成功结果包含 `threadHistory`；其他 Codex 窗口无需关闭。

## 备份管理

会话删除备份：

- `GET /api/deletion-backups`
- `POST /api/deletion-backups/delete`，确认词 `ERASE`
- `POST /api/deletion-backups/restore-preview`
- `POST /api/deletion-backups/content`，按 `backupId + sessionId` 只读查看受管备份正文
- `POST /api/deletion-backups/restore-apply`，确认词 `RESTORE`

轮次操作快照：

- `GET /api/operation-backups`
- `POST /api/operation-backups/delete`，确认词 `ERASE`
- `POST /api/operation-backups/restore-preview`
- `POST /api/operation-backups/content`，只读查看快照正文和当前状态差异
- `POST /api/operation-backups/restore-apply`，确认词 `RESTORE`

系统安全备份：

- `GET /api/system-backups`
- `POST /api/system-backups/delete`，确认词 `ERASE`
- `POST /api/system-backups/visibility-restore-preview`
- `POST /api/system-backups/visibility-restore-apply`，确认词 `ROLLBACK`

可见性回退是字段级合并，不是数据库或 rollout 整体回档。预览只为原修复清单中的会话生成 `rolloutUpdates` / `sqliteUpdates`，忽略备份后新增的会话，并返回 `conflicts`。当前目标缺失或供应商值已不再等于该次修复的目标值时，`canApply` 为 `false`，整批不写入。应用会保留 rollout 中后来追加的记录和 SQLite 其他列，并先为当前状态建立安全点。

## 操作历史与撤销

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/operation-history?limit=100` | 返回折叠后的写操作、汇总和最新操作 |
| POST | `/api/operation-history/undo-latest` | 撤销最新可撤销操作 |

撤销请求必须包含当前最新 `operationId` 和确认词 `UNDO`。服务端会在执行前再次读取历史；如果已有新操作，会返回冲突而不是撤销错误目标。
