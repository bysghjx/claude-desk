# 实现参考

- OpenAI Codex（Apache-2.0）：https://github.com/openai/codex 。本次阅读公开的 skills crate（https://github.com/openai/codex/blob/main/codex-rs/skills/src/lib.rs）和 core skills 模块（https://github.com/openai/codex/blob/main/codex-rs/core/src/skills.rs），参考元数据 / 加载 / 选择分层；没有复制 Rust 源码。
- AionUi（Apache-2.0）：本地 `work/aionui-reference`。阅读 `packages/desktop/src/renderer/pages/settings/SkillsSettings/SkillsHubSettings.tsx`、`SkillDetailPage.tsx`，以及 `components/agent/ContextUsageIndicator.tsx`；参考技能来源标记、导入与详情查看。没有复制 React 组件。
- Claude Code 插件清单参考：https://code.claude.com/docs/en/plugins-reference 。运行本机官方 CLI 的 `plugin --help`、各操作 `--help` 和 `plugin list --json --available` 验证实际能力。
- 本机 SDK `sdk.d.ts` 的 `skills`、`plugins`、`ModelUsage` 和 result 文档：技能是上下文过滤；modelUsage 与 total_cost_usd 在持续输入会话内为累计返回值，统计采用增量。


v0.9.0 存储参考：
- https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs （独立会话 JSONL 日志）
- https://github.com/openai/codex/blob/main/codex-rs/state/src/lib.rs （SQLite 元数据索引）
- AionUi 本地 `packages/desktop/src/process/services/database/drivers/BetterSqlite3Driver.ts` 与 `IConversationRepository.ts` （事务和会话仓库）。
本应用独立实现 SQLite 权威记录与当前会话文件副本，不宣称复制 Codex 全部存储格式或日志重放机制。
