# Documentation Guide

- [ADR-0064](adr/0064-protocol-compatibility.md)：协议 18 起的兼容策略；第一阶段恢复 Android 与既有 18 / 19 的互通，验证中。

This directory is organized by authority and maintenance horizon. The root `README.md` remains the product and usage overview; `CONTEXT.md` is the domain vocabulary.

## Current references

- [原生QUIC主分支集成](testing/native-quic-main-integration-20261105.md)：协议18/19版本引导修正、四承载组合、双端构建与功能回归；完整设备验收状态另列。

- [ADR-0062](adr/0062-claude-background-agents-and-session-activity.md)：Claude 主回合与后台子任务库存独立，双端活动展示、任务区和关闭能力；r44 / S26 / R61，已接入，设备与真实原生联动待验证。
- [ADR-0065](adr/0065-native-quic-relay-transport.md)：Host↔Relay↔手机两段原生 QUIC、独立 WS / QUIC 切换与同机 Relay 适配器；[完整公网测试报告](testing/native-quic-public-performance-20261104.md)保留全部五轮结果，未证明吞吐提速，真实手机与发布门禁分别验收。
- [QUIC 分层测试方案](testing/native-quic-layered-diagnostics.md)与[诊断结果](testing/native-quic-layered-results-20261104.md)：原始 TLS/QUIC 五轮、双段负载交错对照、传输 / writer / 队列证据；发现测试 socket 接收丢包及 CPU quota 条件，不把信号记为单因果结论或已修复。
- [五流功能回归](testing/native-quic-five-stream-results-20261105.md)：history > catchup > bulk、旧端兼容、四种承载组合与双端原功能对照；本轮不再测速，既有失败和未完成门禁分别记录。

- [Claude Code 供应商与官方订阅配额](agents/claude-providers-and-subscription-quota.md)：Host、iOS 和 Android 的配置切换与 5 小时 / 周配额查询。
- `docs/adr/`: current architecture decisions and constraints with lasting value. Replaced or duplicate material is removed after useful constraints and references are merged into the current decision. Retired numbers are not reused; Git retains deleted history.
- [ADR-0051](adr/0051-ui-style-motion-and-visual-stability-freeze.md)：UI 风格、动效与画面稳定性的统一冻结入口，基线 `2026-11-03/r44`，登记 81 项（已交付 67 项；移动端 71 项及品牌 / Host / Relay 10 项；设备与手动门禁按各轮记录）feature；相关设计与修改前必读，演进时同步维护 ADR 和本机 `AGENTS.md` / `CLAUDE.md`。
- [ADR-0050](adr/0050-fixed-lan-relay-routing.md): LAN / Relay only with fixed LAN-first routing; configurable priorities are removed. Merged into main and locally verified; release validation pending.
- [ADR-0052](adr/0052-turn-file-changes-and-on-demand-diff.md)：Host 保存轮次前后版本、先同步文件元数据，双端按需查看差异并带动画切换文件。
- [ADR-0046](adr/0046-mobile-ui-stability-and-material.md)：阅读锚点、材质、流式呈现、列表稳定及设置 / 外观；整页导航见 ADR-0054，刷新与下载反馈见 ADR-0058，验收状态单独记录。
- [ADR-0054](adr/0054-shared-full-page-navigation.md)：所有下一级整页默认共用滑入、交互式右滑、取消回弹与逐层返回；覆盖添加电脑和离线历史，明确根页、模态及抽屉边界，保留来源页面状态。
- [ADR-0057](adr/0057-chat-latest-question-reminder.md)：主动上翻阅读时覆盖提醒最近提问，点击定位原消息，保持阅读锚点与通知优先。
- [ADR-0061](adr/0061-codex-selection-and-native-settings-reconciliation.md)：Codex 下一轮模型 / effort 与原生完整设置快照分开对账，保留首次输入前选型，并避免权限更新重置选择。
- [ADR-0058](adr/0058-shared-interaction-motion.md)：统一八类交互动效、32组代码场景及新增交互必须复用的组件规则；[MOT ticket](agents/interaction-motion-tickets.md) 先设计再实施，设备未验收不得记为交付。
- `docs/architecture/agent-state-acceptance.md`: living acceptance checklist for ADR-0032, mapping the 36 audited state modules to their model scope and migration status.
- `docs/testing/isolated-host/README.md`: isolated Host test rig — its own process, state directory and local Relay, so Host/App verification never touches the Host the user is running. Read it before any on-machine pairing or display-projection regression run.
- [本机 Android 模拟器入口](testing/android-emulator.md)：所有 agent / 工作树共用的设备借用、隔离 ADB、诊断与退出清理。
- [本机 iOS 模拟器外接存储](testing/ios-simulator-storage.md)：12 台共享池、新增 iOS 设备、外接数据目录及借用前检查。
- [共享资源解锁与遗留锁恢复](testing/resource-lock-recovery.md)：所有 agent 的强制收尾、主 / 子任务责任、忘记解锁与异常退出后的核查、定向释放及阻塞交接。
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
