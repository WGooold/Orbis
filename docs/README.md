# Documentation Guide

- [ADR-0064](adr/0064-protocol-compatibility.md)：协议18起的兼容策略；Relay已部署、Host18/19适配已合并未部署，旧App连接专项通过，完整门禁未验收。

This directory is organized by authority and maintenance horizon. The root `README.md` remains the product and usage overview; `CONTEXT.md` is the domain vocabulary.

## Current references

- [ADR-0077](adr/0077-cli-host-and-headless-validation.md)：CLI Host 产品化与无头运行调研；现有入口、逐后端缺口、Linux 有限证据及分阶段验证方案，提案未实现、未发布。
- [ADR-0078](adr/0078-linux-desktop-host.md)：Linux 桌面 Host 适配；凭据、终端 / 浏览器、桌面集成、打包更新与验证门槛，提案未实现、未构建。
- [ADR-0079](adr/0079-codex-vscode-integration.md)：Codex VS Code 独立来源与 app-server 接入边界；包装器为候选方案，dev-only 设置和 transport 尚待原型验证，未实现。
- [ADR-0080](adr/0080-mobile-math-rendering.md)：移动端通用数学公式渲染；共用离线引擎、LaTeX / AMS 覆盖、原文回退、资源边界及验证证据，待用户验证。

- [QUIC 诊断复核](architecture/native-quic-peer-project-review.md)。

- [原生QUIC主分支集成](../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-main-integration-20261105.md)：协议18/19版本引导修正、四承载组合、双端构建与功能回归；完整设备验收状态另列。

- [ADR-0062](adr/0062-claude-background-agents-and-session-activity.md)：Claude 主回合与后台子任务库存独立，双端活动展示、任务区和关闭能力；r44 / S26 / R61，已接入，设备与真实原生联动待验证。
- [ADR-0068](adr/0068-unified-subagent-inventory-and-app-hints.md)：Host 跨 Agent 子代理库存、精简显示字段与 App 统一提示；S33 / SC52，已实现，未部署，设备与用户验收待完成。
- [ADR-0065](adr/0065-native-quic-relay-transport.md)：Host↔Relay↔手机两段原生 QUIC、独立 WS / QUIC 切换与同机 Relay 适配器；[完整公网测试报告](../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-public-performance-20261104.md)保留全部五轮结果，未证明吞吐提速，真实手机与发布门禁分别验收。
- [QUIC 分层测试方案](../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-layered-diagnostics.md)与[诊断结果](../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-layered-results-20261104.md)：原始 TLS/QUIC 五轮、双段负载交错对照、传输 / writer / 队列证据；发现测试 socket 接收丢包及 CPU quota 条件，不把信号记为单因果结论或已修复。
- [五流功能回归](../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-five-stream-results-20261105.md)：history > catchup > bulk、旧端兼容、四种承载组合与双端原功能对照；本阶段验证功能，既有失败与待验收门禁分别记录。

- [供应商管理与订阅配额](adr/0019-host-provider-management.md)：Host、iOS 和 Android 的配置切换与 5 小时 / 周配额查询。
- `docs/adr/`: current architecture decisions and constraints with lasting value. Replaced or duplicate material is removed after useful constraints and references are merged into the current decision. Retired numbers are not reused; Git retains deleted history.
- [ADR-0051](adr/0051-ui-style-motion-and-visual-stability-freeze.md)：`2026-11-08/r50` UI 基线与稳定 feature 标识。
- [ADR-0070](adr/0070-unified-design-and-interaction.md)：四主题、首句草稿、双圈供应商、三组设置、目录树与共用动效；[交互稿](design/Orbis%20交互稿.html)和[设计规范](design/orbis-design-system.md)为本轮对照来源。自动验证与用户验收分开记录。
- [ADR-0066](adr/0066-unified-chat-card-presentation.md)：各后端共用内容步骤分卡、折叠工具组及显示片段锚点；S31 / SC50，双端已实现并通过定向自动验证，设备视觉与用户验收待完成。
- [ADR-0067](adr/0067-host-app-field-transport-rules.md)：Host↔App 的 19 条传输规则、完整字段归类及分组回归门槛。
- [ADR-0050](adr/0050-fixed-lan-relay-routing.md): LAN / Relay only with fixed LAN-first routing; configurable priorities are removed. Merged into main and locally verified; release validation pending.
- [ADR-0052](adr/0052-turn-file-changes-and-on-demand-diff.md)：Host 保存轮次前后版本、先同步文件元数据，双端按需查看差异并带动画切换文件。
- [ADR-0046](adr/0046-mobile-ui-stability-and-material.md)：阅读锚点、材质、流式呈现、列表稳定及设置 / 外观；整页导航见 ADR-0054，刷新与下载反馈见 ADR-0058，验收状态单独记录。
- [ADR-0054](adr/0054-shared-full-page-navigation.md)：所有下一级整页默认共用滑入、交互式右滑、取消回弹与逐层返回；覆盖添加电脑和离线历史，明确根页、模态及抽屉边界，保留来源页面状态。
- [ADR-0057](adr/0057-chat-latest-question-reminder.md)：主动上翻阅读时覆盖提醒最近提问，点击定位原消息，保持阅读锚点与通知优先。
- [ADR-0061](adr/0061-codex-selection-and-native-settings-reconciliation.md)：Codex 下一轮模型 / effort 与原生完整设置快照分开对账，保留首次输入前选型，并避免权限更新重置选择。
- [ADR-0058](adr/0058-shared-interaction-motion.md)：共用交互及代码入口。
- `docs/deployment.md`: production Relay deployment and release checks.
- `docs/mail-server.md`: QQ verification mail configuration.
- `docs/deepseek-harness.md`: DeepSeek Harness installation, configuration and supported behavior.
- [ADR-0031](adr/0031-host-permission-management.md): session permission management and approval behavior.
- `android/docs/agent-icons.md`: bundled agent icon sources and notices.
- `android/docs/markdown-smoke.md`: manual Markdown rendering fixture.
- `scripts/windows/history-client-reload-probe.ps1`: opt-in history reload E2E scripts, device safety, evidence and verdicts.

## Agent documentation

- `docs/agents/domain.md`: required domain-context entry point.
- `docs/agents/issue-tracker.md`: issue-writing rules and privacy boundary.
- `docs/agents/triage-labels.md`: tracker label mapping.

## 测试入口

- [根部约束](../AGENTS.md#测试)；[Android 测试](../android/app/src/)；[iOS 测试](../ios/Orbis/Tests/) / [UI 测试](../ios/Orbis/UITests/)；[Host / 协议测试](../packages/)；[测试工具](../scripts/)；[原始证据](../.artifacts/)。
