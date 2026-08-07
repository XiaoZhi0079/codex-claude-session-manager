# Local Session Manager

Local Session Manager 是一个面向 Windows 的本地会话管理工具，用于统一查看和管理当前用户的 Codex 与 Claude Code 会话。

无论从哪个目录启动，工具都会读取当前 Windows 用户目录中的 `.codex` 和 `.claude` 数据。它不依赖当前工作目录，不要求在原项目目录中运行，也不会在 Codex 与 Claude Code 之间转换会话格式。

主要功能包括：

- 按项目目录、会话和轮次浏览本机已落盘的记录。
- 查看精简对话或完整落盘上下文。
- 诊断缺少标题、正文、索引、外置工具结果或供应商不匹配等问题。
- 编辑或清理 Codex 会话轮次。
- 单条或批量删除 Codex 与 Claude Code 会话。
- 管理、恢复或永久删除本工具创建的备份。
- 修复可恢复 Codex 会话的供应商可见性。
- 记录写操作，并在具备完整恢复点时提供一键撤销。

服务只监听本机回环地址，默认不会向远端上传会话内容。

> 会话可能包含源码、文件路径、提示词、工具输出、访问令牌或其他敏感信息。不要把 `.codex`、`.claude`、备份目录、SQLite、JSONL 或完整上下文导出提交到公开仓库。

## 运行要求

- Windows 10 或 Windows 11。
- Node.js 22.5 或更高版本。
- 已在当前 Windows 账户下使用过 Codex 或 Claude Code。

项目不依赖任何第三方 npm 包。克隆后不需要执行 `npm install`。

## 快速开始

在 PowerShell 中执行：

```powershell
git clone https://github.com/XiaoZhi0079/codex-turn-cleaner.git
cd codex-turn-cleaner
npm start
```

看到启动地址后，在浏览器打开：

<http://127.0.0.1:18797>

按 `Ctrl+C` 停止服务。

也可以绕过 npm 脚本直接启动：

```powershell
node .\bin\codex-turn-cleaner.mjs
```

当前版本从源码运行。Windows 独立可执行版本尚未发布。

## 扫描范围

工具扫描当前用户的完整会话存储，而不是只扫描启动目录。

### Codex

默认数据目录：

```text
%USERPROFILE%\.codex
```

工具会合并以下来源：

- `sessions/**/rollout-*.jsonl`
- `archived_sessions/**/rollout-*.jsonl`
- 最新可用的 `state_N.sqlite`
- `session_index.jsonl`
- CCSwitch 迁移备份
- 本工具创建的操作备份和删除备份

SQLite 和索引可以提供标题、供应商和可见性信息，JSONL 或可验证备份负责提供正文。工具不会把只有标题、没有可恢复正文的记录伪装成完整会话。

### Claude Code

默认数据目录：

```text
%USERPROFILE%\.claude
```

工具以 `projects/<项目>/<sessionId>.jsonl` 为正文来源，并按会话聚合：

- `tool-results`
- `subagents`
- `tasks`
- `file-history`
- `session-env`
- `sessions-index.json` 中的标题和项目元数据

Codex 与 Claude Code 使用独立的存储适配器。两者在页面中并列管理，不进行格式转换。

## 主要功能

### Codex 会话

- 保留 Codex/SQLite 中的正式标题；正式标题缺失时才从首条真实用户消息推导备用标题。
- 区分 Codex 可见、供应商不匹配、归档、仅 SQLite、仅备份和可恢复状态。
- 精简模式展示正常对话，完整模式展示实际落盘的提示词、消息、工具调用、工具结果和内部事件。
- 支持编辑单条用户或助手消息。
- 支持从所选轮次开始清理，或只删除所选轮次。
- 支持单条和批量删除整会话。
- 支持恢复删除备份、操作快照和供应商可见性备份。
- 支持把可恢复会话调整为当前 Codex 供应商可见。

### Claude Code 会话

- 优先使用 `custom-title`、Claude 摘要和首条真实用户消息生成标题。
- 不把 `/model` 等本地控制命令误认为会话标题或正常轮次。
- 精简模式只显示真实用户输入和 Claude 正文。
- 落盘模式区分人类、Claude、工具、运行时注入、客户端事件和子代理记录。
- 安全读取会话目录中的外置工具结果和子代理流。
- 诊断损坏 JSONL、中断工具调用、缺失外置结果和侧边数据异常。
- 删除时把主 JSONL、侧边目录、任务、文件历史、会话环境和索引记录作为一个会话包处理。
- 支持单条和批量删除，以及删除备份的恢复和永久删除。

## 基本使用

1. 启动工具并打开页面。
2. 在顶部选择 Codex 或 Claude Code。
3. 点击“刷新”扫描当前用户的会话数据。
4. 依次选择项目目录、会话和轮次。
5. 使用精简模式阅读正常对话，或使用完整/落盘模式检查实际保存的上下文。
6. 写操作前先查看预览、影响范围和备份位置。
7. 按页面要求输入确认词后执行。
8. 操作完成后按照页面提示刷新或重新打开对应客户端。

会话、轮次和操作区域可以调整宽度或独立折叠。备份恢复、永久删除和操作历史位于页面对应的管理入口。

## 写操作与安全

工具对写操作采用以下保护：

- 执行前生成预览和源文件指纹。
- 执行时重新校验文件，拒绝使用已经过期的预览。
- 删除或修改前创建备份或安全点。
- SQLite 修改使用事务。
- 文件写入尽量使用原子替换。
- 写入失败时尝试恢复原始内容。
- 操作结果写入本地操作历史。

不同操作对客户端运行状态有不同要求：

| 操作 | 客户端可以运行 | 生效方式 |
|---|---:|---|
| 扫描、诊断、预览和上下文查看 | 是 | 立即 |
| Codex 消息编辑和轮次清理 | 是 | 刷新或重新打开会话 |
| 删除 Codex 整会话 | 是 | 刷新或重新打开 Codex |
| 删除 Claude Code 会话 | 建议退出相关会话 | 重新打开 Claude Code 后复核 |
| 永久删除本工具备份 | 是 | 立即且不可撤销 |
| Codex 供应商可见性修复 | 否 | 完全退出 Codex 后执行 |
| 恢复涉及 SQLite 的 Codex 备份 | 否 | 完全退出 Codex 后执行 |

客户端可能缓存旧列表或在退出前重新写入正在使用的会话。执行删除、恢复或可见性修复后，应按页面提示重新启动客户端并再次刷新本工具。

## 备份位置

Codex 普通操作、轮次编辑、可见性修复和恢复安全点：

```text
%USERPROFILE%\.codex\backups\codex-turn-cleaner
```

Codex 整会话删除备份：

```text
%USERPROFILE%\.codex\backups\codex-turn-cleaner-deleted-sessions
```

Claude Code 整会话删除备份：

```text
%USERPROFILE%\.claude\backups\local-session-manager-deleted-sessions
```

“备份管理”只管理通过结构和路径校验的本工具备份，不会把 CCSwitch 备份或任意目录当作可删除目标。永久删除备份不可撤销。

## 启动参数

```text
--port <port>                 指定本地端口
--codex-home <path>           指定 Codex 数据目录
--claude-home <path>          指定 Claude Code 数据目录
--backup-root <path>          指定 Codex 普通操作备份目录
--claude-backup-root <path>   指定 Claude Code 删除备份目录
-h, --help                    显示帮助
```

示例：

```powershell
npm start -- --port 18798
```

可用环境变量：

- `CODEX_CLEANER_PORT`
- `PORT`
- `CODEX_HOME`
- `CLAUDE_CONFIG_DIR`
- `CLAUDE_HOME`
- `CODEX_CLEANER_BACKUP_ROOT`
- `CLAUDE_SESSION_MANAGER_BACKUP_ROOT`

## 已知限制

- 工具只能展示实际落盘或存在于可验证备份中的内容。
- 从未保存、已被永久删除或无法解析的内容不能恢复。
- 只有 SQLite 标题但没有 JSONL 或匹配备份的会话没有正文可读。
- 删除中间轮次后，后续内容可能仍在语义上引用已删除的上下文。
- 操作历史不是无限撤销栈；只有最新、未撤销且具备完整恢复点的操作可以一键撤销。
- Claude Code 的内置基础身份提示词由客户端在运行时组装，未必写入历史 JSONL。
- 恢复会话记录不会恢复已经删除的项目源码或工作目录。

## 常见问题

### 从其他目录启动会漏掉会话吗？

不会。默认扫描范围由当前用户的 `%USERPROFILE%\.codex` 和 `%USERPROFILE%\.claude` 决定，与启动命令所在目录无关。

### 页面打不开怎么办？

确认 Node.js 版本满足要求：

```powershell
node --version
```

检查默认端口是否被占用：

```powershell
Get-NetTCPConnection -LocalPort 18797 -State Listen -ErrorAction SilentlyContinue
```

端口被占用时可以改用：

```powershell
npm start -- --port 18798
```

### 列表中没有刚产生的会话怎么办？

点击页面中的“刷新”。如果刚执行过恢复、删除或供应商可见性修复，请完全退出并重新打开对应客户端，然后再次刷新。

### 删除后客户端仍显示旧会话怎么办？

这通常是客户端缓存导致的。先重新打开客户端，再回到本工具刷新确认。在确认不需要恢复前，不要永久删除对应备份。

### 原项目目录已经不存在，还能找到会话吗？

可能可以。会话正文通常保存在用户目录下的 Codex 或 Claude Code 数据目录，而不是只保存在项目目录中。但恢复会话不会恢复已删除的项目源码。

## 开发与测试

项目使用 Node.js 内置模块和原生 HTML、CSS、JavaScript，没有第三方运行依赖。

```powershell
npm test
npm pack --dry-run
```

项目结构：

```text
bin/       命令行入口
src/       服务端、会话解析、删除、恢复和备份模块
public/    浏览器界面
test/      Node.js 原生测试
docs/      架构、API 和数据安全文档
```

详细资料：

- [系统架构](docs/ARCHITECTURE.md)
- [数据安全、回滚与撤销](docs/DATA-SAFETY.md)
- [HTTP API](docs/API.md)

## 问题反馈

提交 Issue 时，请提供：

- Windows 版本
- Node.js 版本
- 使用的是 Codex 还是 Claude Code
- 可复现的操作步骤
- 脱敏后的错误信息

不要上传真实 JSONL、SQLite、备份清单、完整上下文、访问令牌或密钥。

## 许可证

本仓库目前未声明开源许可证。公开可见不等于允许复制、修改、再分发或商业使用；使用和分发权限以仓库后续提供的 `LICENSE` 为准。
