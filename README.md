# Claude Desk

面向 Windows 的本地 Claude Code 桌面工作空间，支持项目、多会话和工具协作。无需注册 Claude Desk 账号，使用 Claude Code 登录或兼容 Anthropic 接口的服务商配置。

## 功能

- 项目与多会话管理，支持图片、文件引用、插话和消息队列。
- 实时查看工具调用、子智能体和权限申请。
- 内置文件浏览、Git 改动审查、终端和浏览器预览。
- 管理 MCP、插件、技能、模型和服务商（支持 Anthropic 及 OpenAI 兼容接口）。
- 服务商可单独开启 Cursor 兼容模式，将完整的 XML 工具调用交给 Claude Code 执行，沿用当前权限审批。
- 在「设置 → Claude → 检查版本」查看当前 Claude Code 的版本、路径及官方公开版本，不自动升级。
- 本地保存会话，支持历史导入、数据备份和用量统计。
- 从 GitHub 检查更新，支持增量下载安装与失败回滚。

## 使用

1. 在 [Releases](https://github.com/bysghjx/claude-desk/releases) 下载 Windows x64 完整包，解压后运行 `ClaudeDesk.exe`。首次 Release 发布前可使用下方源码方式运行。
2. 打开「Claude Code 环境」窗口，检测已安装的 Claude Code，或选择解压并使用内置版。
3. 登录 Claude Code，或在设置中配置服务商。
4. 选择项目文件夹，输入任务开始使用。

会话数据保存在 `%USERPROFILE%\.claude-desk\data`，可在设置中备份。

主进程卡住超过 1 秒（窗口显示「未响应」）时，会把当时正在处理的请求、调用栈和卡顿时长记到 `%USERPROFILE%\.claude-desk\logs\stalls.log`，便于排查。

## 更新

Beta 用户发现比当前版本更新的正式版时会优先升级正式版，即使开启了预览通道、同时存在下一版 Beta。没有对应增量包时，程序自动下载正式版完整包和文件清单，校验后沿用原安装流程升级，不需要手动解压；不会降级到更旧的正式版。

后台通知使用两种轻柔短音：提问、审批和错误使用待处理音，任务完成使用完成音，替代 Windows 默认提示音。可在「设置 → 通知与电源」分别试听；空闲关闭到托盘时不再显示后台运行提示。

在「设置 → 服务商」添加服务商时，可将接口格式选为 **OpenAI Chat（`/v1/chat/completions`）** 或 **OpenAI Responses（`/v1/responses`，适用于 Codex 系列、o3-pro 等仅支持 Responses 接口的模型与中转站）**，直接接入 OpenAI、DeepSeek、通义或 OpenAI 格式的中转站，无需另装 LiteLLM。Claude Desk 会在本机 127.0.0.1 代理转换请求与流式响应，固定使用 Bearer 认证，与 Cursor 兼容模式互斥。已知限制：

- 不支持 Anthropic 提示缓存，长会话费用更高、首字响应也可能更慢。
- WebSearch 等服务端工具不可用；PDF 附件无法发送给 OpenAI 格式模型（会降级为文字提示）；图片需要所选模型本身支持识图。
- Claude Code 的提示词与工具按 Claude 调优，切换其他模型后，多步任务和修改文件的稳定性取决于模型本身。

使用会把工具调用返回为正文 `<invoke>` 的服务商时，可在「设置 → 服务商 → 编辑」开启 **Cursor 兼容模式**，保存后从会话的下一条消息生效。客户端只转换本次请求已声明、参数符合定义的完整调用，由 Claude Code 执行和回传真实结果；正文附带的所谓结果会被丢弃。每次先执行首个完整调用，再让模型根据真实结果继续；缺失必填参数、未知工具或不完整调用会报错。代码块和引用示例不转换。兼容模式下普通回复可能稍晚显示。

此模式默认关闭，针对特定服务商的返回格式，并不表示 Claude Desk 与 Cursor 官方产品存在关联。关闭时保留工具调用异常自动中止防护。

正式版启动时检查 GitHub Releases，之后每小时检查一次，也可在「设置 → 关于与更新」手动检查。默认在没有任务运行时倒数 10 秒自动安装，可取消或关闭自动安装。

在「关于与更新」可开启「接收预览版更新」，保存后检查正式版与预览版中的更高版本。默认只接收正式版；关闭预览版后会等待更高的正式版，不会自动降级。

这个通道开关只控制 GitHub 在线更新。本地放在下载、桌面、程序目录或上一级目录中的匹配版本更新 ZIP（包括 Beta）仍会检测；完整包不作为本地增量更新包识别。

同一页面可填写仅用于检查和下载更新的 HTTP/HTTPS 代理，例如 `http://127.0.0.1:7890`，留空则直连。也可填写可信的 GitHub 下载加速前缀，例如 `https://mirror.example.com/`；官方包下载失败后才尝试「前缀 + 原始 GitHub 下载地址」。版本信息与 SHA-256 仍从 GitHub 获取，加速下载同样校验大小、哈希和包内版本。

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

首次发布只有完整包，之后为最近 5 个正式版和最近 5 个预览版中有文件清单的较低版本生成增量包。请保留每次发布附带的 JSON 文件清单，供下次构建使用；已发布版本需用新版本号发布。

预览版使用 `0.30.0-beta.1`、`0.30.0-rc.1` 等版本号和对应标签，Actions 会自动标为预览版，不替换最新正式版。首次上线预览通道时，应先发布包含新更新器的正式版：0.29.4 及以前的用户先通过正式版更新获得预览通道和新版安装器，再开启预览更新。更新包会同时升级应用和独立安装器，后续可从预览版继续升级到更高预览版或正式版。

只在本地构建、没有发布到 GitHub 的预览版，`npm run release` 会把它的文件清单写入 `scripts/preview-manifests/`（只保留最近 5 个），请和代码一起提交；之后发布的版本会据此生成从该预览版升级的增量包，否则预览版用户只能下载完整包。

## 技术与参考

基于 Electron 和官方 Claude Agent SDK，独立实现。界面与扩展管理参考 AionUi、Codex 的公开实现，具体来源见 [REFERENCES.md](REFERENCES.md)。
