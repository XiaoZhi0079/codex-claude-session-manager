# HTTP API

默认基址为 `http://127.0.0.1:18797`。除下载接口外均返回 JSON；错误格式为 `{ "error": { "code", "message", "details" } }`。

## 扫描与诊断

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 服务存活检查 |
| GET | `/api/sessions` | 重新扫描并返回目录、会话和汇总 |
| GET | `/api/sessions/:id/health` | 会话完整性与来源诊断 |
| GET | `/api/sessions/:id/turns` | 解析会话轮次 |
| POST | `/api/turn-detail` | 读取紧凑轮次消息 |
| POST | `/api/full-context` | 完整上下文筛选、分页与定位 |
| POST | `/api/full-context/export` | 导出 JSONL 或 Markdown |

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

## 可见性

| 方法 | 路径 | 确认词 |
|---|---|---|
| GET | `/api/visibility/preview` | 无 |
| POST | `/api/visibility/apply` | `SYNC` |

写入请求必须携带预览返回的 `planToken`。

## 整会话删除

| 方法 | 路径 | 确认词 |
|---|---|---|
| POST | `/api/session-delete/preview` | 无 |
| POST | `/api/session-delete/apply` | `PURGE` |
| POST | `/api/session-delete/batch-preview` | 无 |
| POST | `/api/session-delete/batch-apply` | `PURGE` |

## 备份管理

会话删除备份：

- `GET /api/deletion-backups`
- `POST /api/deletion-backups/delete`，确认词 `ERASE`
- `POST /api/deletion-backups/restore-preview`
- `POST /api/deletion-backups/restore-apply`，确认词 `RESTORE`

轮次操作快照：

- `GET /api/operation-backups`
- `POST /api/operation-backups/delete`，确认词 `ERASE`
- `POST /api/operation-backups/restore-preview`
- `POST /api/operation-backups/restore-apply`，确认词 `RESTORE`

系统安全备份：

- `GET /api/system-backups`
- `POST /api/system-backups/delete`，确认词 `ERASE`
- `POST /api/system-backups/visibility-restore-preview`
- `POST /api/system-backups/visibility-restore-apply`，确认词 `ROLLBACK`

## 操作历史与撤销

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/operation-history?limit=100` | 返回折叠后的写操作、汇总和最新操作 |
| POST | `/api/operation-history/undo-latest` | 撤销最新可撤销操作 |

撤销请求必须包含当前最新 `operationId` 和确认词 `UNDO`。服务端会在执行前再次读取历史；如果已有新操作，会返回冲突而不是撤销错误目标。
