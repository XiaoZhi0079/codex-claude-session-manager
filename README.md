# Local Session Manager

一个面向 Windows 的本地 Codex 与 Claude Code 会话管理器。

它读取本机已经落盘的会话数据，提供搜索、轮次查看、完整上下文、诊断、编辑、清理、备份、恢复和删除功能。工具不代替 Codex 或 Claude Code，也不会把两个平台的会话格式互相转换。

Codex 模块合并正文、SQLite、旧索引和备份；Claude Code 模块按原生存储结构扫描主 JSONL、外置工具结果、子代理、任务、文件历史与会话环境。

服务默认只监听 `127.0.0.1:18797`，不上传会话内容，不依赖第三方 npm 包。运行环境要求 Node.js 22.5 或更高版本。

> **安全提示**：会话内容可能包含代码、路径、提示词、工具输出和密钥片段。这个项目默认只绑定本机回环地址，但仍然不要把 `.codex`、`.claude`、备份目录或导出的上下文提交到公开仓库。

## 快速开始

在 PowerShell 中克隆并进入项目目录：

```powershell
git clone https://github.com/XiaoZhi0079/codex-turn-cleaner.git
cd codex-turn-cleaner
```

直接启动（推荐先验证环境）：

```powershell
node .\bin\codex-turn-cleaner.mjs
```

然后打开 <http://127.0.0.1:18797>。

需要系统级命令时，在管理员 PowerShell 中执行：

```powershell
npm install --global .
codex-turn-cleaner
```

升级源码后，重新执行 `npm install --global .` 即可更新全局命令。若端口已占用，可使用 `--port 18798` 启动到其他端口。

## 当前功能

页面顶部可以在 Codex 与 Claude Code 两个并列模块之间切换。两者共享目录、会话、轮次和上下文布局，但底层使用不同的存储适配器。

### Codex

- 合并识别 `sessions`、`archived_sessions`、`session_index.jsonl`、`state_N.sqlite`、CCSwitch 备份和本工具备份。
- 保留 Codex/SQLite 中的正式标题，只有缺少标题时才从正文推导备用标题。
- 区分 Codex 可见、供应商不匹配、归档、仅 SQLite、仅备份和可恢复会话。
- 紧凑模式查看正常对话；完整模式查看实际落盘的提示词、消息、工具调用、工具结果和内部事件。
- 编辑单条用户/助手消息，或按轮次边界执行两种删除：从所选轮开始清理、只删除所选轮。
- 单条或批量删除整会话，并管理、恢复或永久删除本工具生成的备份。
- 把可恢复会话统一到当前供应商，使 Codex 重新识别。
- 所有写操作使用预览指纹、备份、事务或失败回滚；写操作进入操作历史。
- 最新且具有完整恢复点的操作可以一键撤销。
- 会话、轮次、轮次操作三个区域可拖动调整宽度并独立折叠。

### Claude Code

- 全局扫描 `~/.claude/projects/*/*.jsonl`，不把可能过期的 `sessions-index.json` 当作正文真值。
- 标题优先级为 `custom-title`、Claude 摘要、第一条真实用户消息；`/model` 等本地命令不会误当标题或对话轮次。
- 聚合主 JSONL、`tool-results`、`subagents`、`tasks`、`file-history` 与 `session-env` 的数量和空间占用。
- 精简模式只显示真实用户输入和 Claude 正文；落盘模式按“人类、Claude、工具、运行时注入、客户端、子代理”展示实际保存的记录。
- 安全读取超过 30,000 字符后由 Bash/PowerShell 外置的 `tool-results` 原文，并提示缺失引用。
- 诊断损坏 JSONL、无正文轮次、中断工具调用、缺失外置结果与子代理元数据异常。
- 单条或批量删除完整 Claude 会话包；删除前备份主 JSONL、侧边目录、tasks、file-history、session-env 与原索引记录。
- Claude 删除备份支持按会话恢复和永久删除；恢复遇到同 ID 的不同现有内容时拒绝覆盖。
- Claude Code 内置基础身份提示词由客户端运行时组装，没有写入历史 JSONL；落盘模式不会把客户端 `type=system` 事件误称为系统提示词。

## 安装与启动

先在管理员 PowerShell 中确认 npm 的全局目录是系统级目录：

```powershell
npm config get prefix
```

本机应显示 `C:\Program Files\nodejs`。随后在项目目录执行：

```powershell
npm install --global .
codex-turn-cleaner
```

打开 `http://127.0.0.1:18797`。源码升级后重新执行安装命令即可更新全局命令。

也可以不安装，直接运行：

```powershell
node .\bin\codex-turn-cleaner.mjs
```

可用参数：

```text
--port <port>          指定本地端口
--codex-home <path>    指定 .codex 数据目录
--claude-home <path>   指定 .claude 数据目录
--backup-root <path>   指定普通操作备份目录
--claude-backup-root <path> 指定 Claude 会话删除备份目录
```

对应环境变量为 `CODEX_CLEANER_PORT`、`PORT`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`CLAUDE_HOME`、`CODEX_CLEANER_BACKUP_ROOT`、`CLAUDE_SESSION_MANAGER_BACKUP_ROOT`。

## 项目结构

```text
bin/                         命令行入口
src/                         服务端、会话解析、删除、恢复与备份模块
public/                      HTML、CSS 和前端 JavaScript
docs/                        架构、API 与数据安全文档
test/                        Node.js 原生测试
```

## 推荐工作流

1. 点击“刷新”，重新扫描本机数据源。
2. 选择目录、会话和轮次；先查看紧凑或完整上下文。
3. 编辑、清理、删除、恢复或修复之前先查看服务端预览。
4. 按页面要求输入 `EDIT`、`DELETE`、`PURGE`、`SYNC`、`RESTORE`、`ROLLBACK`、`ERASE` 或 `UNDO`。
5. 写操作完成后按提示刷新/重新打开 Codex；涉及 SQLite 恢复或供应商修复时重新启动 Codex。
6. 需要复核时打开“操作历史”；需要手动恢复或释放空间时打开“备份管理”。

Claude Code 当前工作流是：切换到 Claude Code → 选择项目与会话 → 查看轮次 → 在精简/落盘模式间切换 → 使用“诊断”检查会话数据包。删除时先预览完整数据包并输入 `PURGE`；需要恢复或释放备份空间时打开“备份管理”。

## Codex 运行时规则

| 操作 | Codex 可运行 | 生效方式 |
|---|---:|---|
| 扫描、诊断、预览、上下文查看/导出 | 是 | 立即 |
| 消息编辑、轮次清理 | 是 | 刷新或重新打开该会话 |
| 单条/批量删除整会话 | 是 | 刷新或重新打开 Codex，避免旧缓存继续显示 |
| 永久删除本工具备份 | 是 | 立即，不可撤销 |
| 可见性修复 | 否 | 完全退出 Codex 后执行，随后重新启动 |
| 恢复删除备份、会话快照、可见性备份 | 否 | 完全退出 Codex 后执行，随后重新启动 |
| 一键撤销 | 取决于原操作 | 轮次文件恢复可运行；涉及 SQLite 的恢复要求退出 Codex |

工具允许 Codex 运行时删除或编辑，是因为每次都会校验当前文件状态并保留恢复点；Codex 可能仍缓存旧列表，因此页面会明确提示刷新。需要修改或插入 SQLite 线程记录的恢复操作会主动阻止运行时写入。

## 数据和备份位置

默认 Codex 数据目录：

```text
%USERPROFILE%\.codex
```

普通轮次、编辑、可见性与恢复安全点：

```text
%USERPROFILE%\.codex\backups\codex-turn-cleaner
```

整会话删除备份：

```text
%USERPROFILE%\.codex\backups\codex-turn-cleaner-deleted-sessions
```

操作历史：

```text
%USERPROFILE%\.codex\backups\codex-turn-cleaner\operation-history.jsonl
```

Claude Code 整会话删除备份：

```text
%USERPROFILE%\.claude\backups\local-session-manager-deleted-sessions
```

“备份管理”只管理经过结构和路径校验的本工具备份，不会删除 CCSwitch 备份或任意目录。永久删除不会伪装成可撤销操作。

## 重要限制

- 工具只能展示实际写入 rollout 或可验证备份的内容；从未落盘、已被永久删除或无法解密的内容不能恢复。
- 只有 SQLite 标题但没有 rollout/匹配备份的会话没有正文可读。
- 只有 CCSwitch 备份、但没有安全目标路径或 SQLite 线程身份的条目不会被工具伪造成正式会话。
- 删除模式只保证 JSONL 结构有效；删除中间轮次后，后续语义可能仍引用已经删除的上下文。
- 操作历史不是无限撤销栈：只有当前最新、未撤销且具有完整恢复点的操作开放一键撤销。旧恢复点仍可在“备份管理”中人工检查。
- Claude Code 的 `sessions-index.json` 仅用于补充标题和项目元数据；索引中存在但主 JSONL 不存在的记录不会伪装成完整会话。
- Claude Code 落盘模式只读取位于当前会话安全侧边目录中的外置结果；JSONL 中指向任意其他路径的引用不会被读取。
- 删除正在使用的 Claude 会话后，Claude Code 可能在退出前从内存重新写回该会话；删除完成后应退出或重新打开 Claude Code，并再次刷新本工具确认。

## 开发与验证

```powershell
npm test
npm pack --dry-run
```

详细资料：

- [系统架构](docs/ARCHITECTURE.md)
- [数据安全、回滚与撤销](docs/DATA-SAFETY.md)
- [HTTP API](docs/API.md)

## 常见问题

### 页面打不开

确认 Node.js 版本满足 `>=22.5`，并检查端口是否已被占用：

```powershell
node --version
Get-NetTCPConnection -LocalPort 18797 -State Listen -ErrorAction SilentlyContinue
```

端口冲突时，使用 `node .\bin\codex-turn-cleaner.mjs --port 18798`，然后访问对应地址。

### 从旧目录迁移后全局命令报 `EPERM` 或找不到模块

旧版本如果使用过 `npm install --global .`，全局安装可能仍指向旧目录。请在管理员 PowerShell 中卸载，再进入新克隆的项目目录重新安装：

```powershell
npm uninstall --global codex-turn-cleaner
cd codex-turn-cleaner
npm install --global .
codex-turn-cleaner --help
```

### 列表中没有刚产生的会话

点击页面中的“刷新”。Codex 或 Claude Code 可能仍持有旧缓存；涉及恢复、供应商可见性或 SQLite 的操作时，应完全退出对应客户端后再刷新。

### 删除后客户端仍显示旧会话

这是客户端缓存造成的可能性较高。工具删除前会创建备份；先刷新或重新打开客户端，再回到本工具确认。不要在确认需要恢复前永久删除备份。

### 原项目目录已经不存在

会话正文通常仍保存在 `%USERPROFILE%\.claude\projects` 或 `%USERPROFILE%\.codex` 下，项目目录本身不会承载全部对话正文。本工具可以从现存正文或工具备份恢复会话；但恢复会话不会恢复被删除的项目源码。需要继续在原项目上下文中工作时，应先重建原路径。

### 如何报告问题

提交 Issue 时请提供 Node.js 版本、操作系统、复现步骤和脱敏后的错误信息。不要上传 JSONL、SQLite、备份清单、访问令牌、密钥或完整上下文导出文件。

## 许可证

本仓库目前未声明开源许可证。未经项目所有者另行授权，不应将代码用于再分发或商业发行；发布到 GitHub 前请根据实际意图补充合适的 `LICENSE` 文件。
