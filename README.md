# Codex & Claude Code Session Manager

一个面向 Windows 的 Codex 与 Claude Code 会话管理工具，可以在浏览器中查看、诊断、编辑、删除和恢复本机会话。

## 主要功能

- 按平台、项目和会话浏览 Codex 与 Claude Code 历史记录。
- 查看精简对话、完整落盘上下文、工具调用和错误信息。
- 编辑用户或助手消息，删除单个轮次，或从指定轮次开始截断。
- 单条或批量删除完整会话。
- 诊断标题、正文、索引、工具结果和供应商可见性问题。
- 管理本工具创建的备份，并从操作历史回退具备恢复点的操作。
- 修复可恢复 Codex 会话的供应商可见性。

## 快速开始

需要 Windows 10/11 和 Node.js 22.5 或更高版本。项目没有第三方运行依赖，不需要执行 `npm install`。

```powershell
git clone https://github.com/XiaoZhi0079/codex-claude-session-manager.git
cd codex-claude-session-manager
node .\bin\codex-claude-session-manager.mjs
```

启动后打开：

<http://127.0.0.1:18797>

按 `Ctrl+C` 停止服务。

## 使用方法

1. 在页面顶部选择 Codex 或 Claude Code。
2. 点击“刷新”，然后选择项目、会话和轮次。
3. 使用精简模式阅读对话，或切换到完整模式检查落盘内容。
4. 在诊断、轮次操作、操作历史或备份管理中选择需要执行的操作。
5. 根据页面预览和确认提示完成修改，随后刷新或重新打开对应客户端。

修改正在使用的目标会话前应先关闭该会话。供应商可见性修复涉及多个 Codex 会话，需要完全退出 Codex 后执行。

## 开发

```powershell
npm start
npm test
npm pack --dry-run
```

项目结构：

```text
bin/       命令行入口
src/       服务端与会话处理模块
public/    浏览器界面
test/      自动化测试
docs/      架构、API 和数据安全文档
```

详细资料：

- [系统架构](docs/ARCHITECTURE.md)
- [数据安全、回滚与撤销](docs/DATA-SAFETY.md)
- [HTTP API](docs/API.md)

## 问题反馈

提交 Issue 时，请说明 Windows 与 Node.js 版本、使用的平台、操作步骤和脱敏后的错误信息。

## 许可证

本仓库目前未声明开源许可证。公开可见不等于允许复制、修改、再分发或商业使用；使用和分发权限以后续提供的 `LICENSE` 为准。
