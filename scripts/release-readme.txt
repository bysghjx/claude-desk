Claude Desk {version}（Windows 64 位）
========================================

一、怎么打开
1. 先把压缩包完整解压到一个文件夹（不要在压缩包里直接双击）。
2. 双击 ClaudeDesk.exe。第一次运行时 Windows 可能提示“Windows 已保护你的电脑”，
   点“更多信息”→“仍要运行”。之后开始菜单里会有 Claude Desk。

二、第一次使用：登录 Claude
Claude Desk 通过 Claude Code 和 Claude 对话。
- 如果你的电脑已经装好并登录了 Claude Code，直接就能用。
- 如果没有装：Claude Desk 自带一份 Claude Code。点左下角齿轮打开设置，
  点“打开 Claude 命令行”，在弹出的窗口里输入 /login，按提示用 Claude 账号登录，
  或者填 Anthropic Console 的 API Key。登录完关掉那个窗口即可。
- 用第三方服务商或 API Key 的话，也可以在设置里点“打开 Claude 配置”，
  在 settings.json 的 env 里填 ANTHROPIC_BASE_URL、ANTHROPIC_AUTH_TOKEN（或 ANTHROPIC_API_KEY）。

三、建议另外安装
- Git（https://git-scm.com）：“回退到这里”、独立工作树、右侧改动面板需要它。
- GitHub CLI（https://cli.github.com，可选）：右侧“拉取请求”面板需要它，装好后运行 gh auth login。

四、数据在哪
会话、项目和设置保存在 %USERPROFILE%\.claude-desk\data，不在这个文件夹里。
升级时用新版本的文件夹替换旧的即可，记录不会丢。

五、怎么升级
以后升级不用重新下载完整包，用“更新包”（文件名像 ClaudeDesk-0.25.0-to-0.26.0-update.zip，通常只有几 MB）：
不用解压，把更新包放进“下载”文件夹、桌面或者 Claude Desk 所在的文件夹，打开或切回 Claude Desk 时会自动发现，倒数 10 秒后关闭、更新并重新打开（可以取消；有任务在运行就等它结束）。
放在别的地方也可以：设置 → 关于与更新 → 手动安装，选择那个文件。
更新包要和当前版本对应（文件名里的第一个版本号就是需要的当前版本）；跨了好几个版本的话，用完整包更省事。
