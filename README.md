# Claude Desk

面向 Windows 的本地 Claude Code 桌面工作空间，支持项目、多会话和工具协作。无需注册 Claude Desk 账号，使用 Claude Code 登录或兼容 Anthropic 接口的服务商配置。

## 功能

- 项目与多会话管理，支持图片、文件引用、插话和消息队列。
- 实时查看工具调用、子智能体和权限申请。
- 内置文件浏览、Git 改动审查、终端和浏览器预览。
- 管理 MCP、插件、技能、模型和服务商。
- 本地保存会话，支持历史导入、数据备份和用量统计。
- 从 GitHub 检查更新，支持增量下载安装与失败回滚。

## 使用

1. 在 [Releases](https://github.com/bysghjx/claude-desk/releases) 下载 Windows x64 完整包，解压后运行 `ClaudeDesk.exe`。首次 Release 发布前可使用下方源码方式运行。
2. 打开「Claude Code 环境」窗口，检测已安装的 Claude Code，或选择解压并使用内置版。
3. 登录 Claude Code，或在设置中配置服务商。
4. 选择项目文件夹，输入任务开始使用。

会话数据保存在 `%USERPROFILE%\.claude-desk\data`，可在设置中备份。

## 更新

正式版启动时检查 GitHub Releases，之后每小时检查一次，也可在「设置 → 关于与更新」手动检查。默认在没有任务运行时倒数 10 秒自动安装，可取消或关闭自动安装。

没有适合当前版本的增量包时，从 Releases 下载完整包。也支持在设置中手动选择本地更新 ZIP。

## 开发

使用 Windows 和 Node.js 24：

```powershell
npm ci
npm start
```

- `npm test`：运行测试。
- `npm run package`：构建 Windows x64 程序。
- `npm run release`：生成完整 ZIP、文件清单，以及有基准版本时的增量 ZIP。

## 自动发布

同步修改 `package.json` 和 `package-lock.json` 的版本号，提交并推送后，再推送对应标签，例如：

```powershell
git tag v0.29.2
git push origin v0.29.2
```

GitHub Actions 的 **Release Windows** 会执行测试、构建并发布 Release。也可通过 **Run workflow** 输入已有标签来触发或重试；普通 `main` 分支推送不会发布版本。

首次发布只有完整包，之后生成「上一正式版 → 新版」的增量包。请保留每次发布附带的 JSON 文件清单，供下次构建使用；已发布版本需用新版本号发布。

## 技术与参考

基于 Electron 和官方 Claude Agent SDK，独立实现。界面与扩展管理参考 AionUi、Codex 的公开实现，具体来源见 [REFERENCES.md](REFERENCES.md)。
