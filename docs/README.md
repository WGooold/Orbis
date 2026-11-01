# Documentation Guide

This directory is organized by authority and maintenance horizon. The root `README.md` remains the product and usage overview; `CONTEXT.md` is the domain vocabulary.

## Current references

- [Claude Code 供应商与官方订阅配额](agents/claude-providers-and-subscription-quota.md)：Host、iOS 和 Android 的配置切换与 5 小时 / 周配额查询。
- `docs/adr/`: accepted architecture decisions. ADRs preserve historical reasoning; a superseded ADR is marked in its header.
- [ADR-0051](adr/0051-ui-style-motion-and-visual-stability-freeze.md)：UI 风格、动效与画面稳定性的统一冻结入口，基线 `2026-11-01/r30`，登记 76 项（已交付 67 项；移动端 66 项及品牌 / Host / Relay 10 项；设备与手动门禁按各轮记录）feature；相关设计与修改前必读，演进时同步维护 ADR 和本机 `AGENTS.md` / `CLAUDE.md`。
- [ADR-0050](adr/0050-fixed-lan-relay-routing.md): LAN / Relay only with fixed LAN-first routing; configurable priorities are removed. Merged into main and locally verified; release validation pending.
- [ADR-0052](adr/0052-turn-file-changes-and-on-demand-diff.md)：Host 保存轮次前后版本、先同步文件元数据，双端按需查看差异并带动画切换文件。
- [ADR-0053](adr/0053-settings-entry-page-motion-and-ui-regression-gate.md)：r15 决策——打字机顺序揭示、运行中工具呈现连续、首页视口稳定、设置页与唯一配对入口、设置 / 下载页转场、下拉刷新、下载飞入；自动用例大部分已实施，Android Pi / Codex 与 V21 定向验证已有结果，iOS 全量、真实输出与手动回归仍待完成；实施拆分见 [UI r15 ticket](agents/ui-r15-tickets.md)。
- [ADR-0054](adr/0054-shared-full-page-navigation.md)：所有下一级整页默认共用滑入、交互式右滑、取消回弹与逐层返回；覆盖添加电脑和离线历史，明确根页、模态及抽屉边界，保留来源页面状态。
- [ADR-0057](adr/0057-chat-latest-question-reminder.md)：主动上翻阅读时覆盖提醒最近提问，点击定位原消息，保持阅读锚点与通知优先。
- [ADR-0058](adr/0058-shared-interaction-motion.md)：统一八类交互动效、32组代码场景及新增交互必须复用的组件规则；[MOT ticket](agents/interaction-motion-tickets.md) 先设计再实施，设备未验收不得记为交付。
- `docs/architecture/agent-state-acceptance.md`: living acceptance checklist for ADR-0032, mapping the 36 audited state modules to their model scope and migration status.
- `docs/testing/isolated-host/README.md`: isolated Host test rig — its own process, state directory and local Relay, so Host/App verification never touches the Host the user is running. Read it before any on-machine pairing or display-projection regression run.
- [UI 回归方案](testing/ui-regression.md)：任何 UI 功能、设计或影响显示的改动完成前必须执行的自动 / 手动模拟器回归、全量用例与 feature 映射、新用例编写要求和证据格式。
- `docs/testing/mobile-ui-polish.md`: mobile UI constraints and isolated iOS / Android regression evidence for ADR-0046.
- `docs/deployment.md`: production Relay deployment and release checks.
- `docs/mail-server.md`: QQ verification mail configuration.
- `docs/deepseek-harness.md`: DeepSeek Harness installation, configuration and supported behavior.
- `docs/codex-permissions.md`: current Codex session permission and approval behavior.
- `android/docs/agent-icons.md`: bundled agent icon sources and notices.
- `android/docs/neumorphism-audit.md`: Android surface-material implementation audit.
- `android/docs/markdown-smoke.md`: manual Markdown rendering fixture.
- `android/docs/history-reload-probe.md`: opt-in history reload E2E scripts, device safety, evidence and verdicts.

## Reference snapshots

These documents describe a specific tool version or a past implementation review. They are useful background, but they are not the current contract by themselves:

- `docs/codex-app-server-protocol.md`: codex-cli 0.154.0 app-server schema snapshot.
- `docs/codex-vs-pi-feature-gap.md`: 2026-09-23 Pi/Codex capability comparison.
- `docs/orbis-ui-design-spec.md`: historical UI design tokens and material guidance. Current UI rules are indexed by ADR-0051; historical alternatives do not override that baseline. The source design file and exported images are intentionally not part of the repository.
- `docs/architecture/`: 2026-10-13 agent state and architecture audit snapshot supporting ADR-0032, including `agent-state-architecture.html`, `agent-state-audit.json`, preview images and the report validation record. It describes the tree before ADR-0032; if it conflicts with source code or the ADR, the source and ADR win.

When a snapshot conflicts with source code, an accepted ADR, or the current product README, use the current source and update the snapshot's status or date instead of treating it as authoritative.

## Agent documentation

- `docs/agents/domain.md`: required domain-context entry point.
- `docs/agents/issue-tracker.md`: issue-writing rules and privacy boundary.
- `docs/agents/triage-labels.md`: tracker label mapping.
