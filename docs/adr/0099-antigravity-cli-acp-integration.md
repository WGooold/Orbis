# ADR-0099：Antigravity CLI 的 App 客户端接入

日期：2026-11-25 · 状态：已决定，分支实现；未部署，真实账号与设备验收待验证。

历史：2026-11-19 的 ACP 草案（原编号 0090，`f13aab5`）及 AGY-01–03（末端 `028936f`）保存在本地 `archive/agy-acp-20261119`。主线的 ADR-0090 已用于 Linux Headless Host；此 ADR 取代 AGY 旧方案，不改变 Linux ADR。

关联：[Host Agent state](0032-host-owned-agent-state-model.md)、[乐观操作](0049-optimistic-send-and-source-reconciliation.md)、[交互状态](0055-agent-input-lifecycle-and-state-coverage.md)、[协议兼容](0064-protocol-compatibility.md)、[目录与历史](0069-session-catalog-and-bounded-history-loading.md)、[可恢复启动](0072-session-configuration-and-recoverable-launch.md)、[Agent 启停](0094-host-agent-enablement.md)、[Codex 启动](0095-codex-unified-catalog-and-launch-modes.md)。

## 选择与边界

Orbis App 是交互界面。Host 启动本机官方 `agy acp` 子进程，通过 ACP v1 stdio 接入；Relay 继续传输 Orbis 加密消息。手机不直接连接 Google 或 ACP，Host 不开终端、不做镜像、不附着 Antigravity 桌面/TUI 已运行的会话，也不读取私有数据库或包装 `agy -p`。

验证基线固定为 [`agy 1.5.17`][release]（2026-11-25）及 [`ACP v1`][schema]。实现开始时观测到 1.5.16，随后核对官方发布记录和隔离握手，交付以 1.5.17 为准。发布记录与握手分别确认版本和能力，不能从版本推断登录、模型或回放已可用。[官方 ACP][acp] 提供本机子进程入口和 API key 认证。[官方 FAQ][faq] 对第三方使用个人 Antigravity 登录及消费计划另有限制；本接入不支持订阅转用、浏览器 OAuth、账号切换或绕过授权。

### AGY-11｜Host 所有权、启用与认证

- Host 进程必须本机设置 `ORBIS_AGY_ENABLED=1` 并通过环境提供获授权的 `GEMINI_API_KEY`。CLI 可从 PATH 或本机配置的绝对 `ORBIS_AGY_ENTRY` 发现；版本与 `initialize` 的 list/load 能力均需匹配。`authenticate(gemini-api-key)` 和原生 `session/list` 通过后才标记就绪。不把凭据作为认证数据写入 App、Relay、Orbis 配置或日志；原生 stderr 不进入 Host 日志。不回退个人凭据。
- Host 使用专用 `agy-acp` profile、受限子进程环境和独占 owner lock；保留原生会话，不复制其它 profile。只操作自产进程，以 EOF 停止，超时定向终止所属进程；清理未确认则保留锁。进程异常后只尝试恢复传输，不恢复写操作。启动、文件 I/O 和握手不阻塞 App 主线程。
- 由现有 Agent 启用策略管理此来源；无本机许可时不显示入口。用户在授权 Host 的 Agent 设置启用 Antigravity CLI；不可用时在该页查看诊断并重试。CLI 新状态目录可将本机显式启用作为初始选择。启动不安装、不登录、不改全局权限。请求 `--sandbox`，并保留原生权限规则；不把该参数当作所有平台均验证的沙盒保证。

实现：[`agy-client.ts`](../../packages/host/src/agy-client.ts)、[`acp-client.ts`](../../packages/host/src/acp-client.ts)、[`agent-enablement.ts`](../../packages/host/src/agent-enablement.ts)、[`host-service.ts`](../../packages/host/src/host-service.ts)。

### AGY-12｜目录、生命周期和交互

| Codex CLI 对照 | AGY 行为 |
| --- | --- |
| 目录和恢复 | `agy` 独立 kind，`agy:<原生 ID>` 是目录及控制身份。只读、限时分页 `session/list`；分页不完整保留已确认行，不把失败当空目录。显式恢复用 `session/load` 读取 ACP 回放，连接代次变化时重建历史 epoch。`session/resume` 不回放，不用它替换历史读取。只显示回放提供的内容，不补造时间或原生条目 ID。 |
| 新建和首句 | 复用现有 `session.launch` / 启动账本，native ID 确认后才通知 App；首句只在匹配的启动已就绪时发送。没有 native ID 的模糊创建只保留未知结果，不自动重建；有原生会话 ID 则按原会话恢复。AGY 不开 TUI。 |
| 发送、停止、排队 | 走 `session/prompt`、`session/cancel`。一个会话同一时刻只提交一个原生 prompt；忙时支持后续排队、撤回以及先停止再立即发送。同一提交 ID 不发第二次；持久 spent 标记只防重，不是送达证明。未确认的回合不继续派发挂起队列。附件沿用 Host 已落地的路径提示，不请求客户端文件能力。 |
| 权限、问题和工具 | 通过 App 现有交互卡确认原生一次性权限选项；取消、超时、关闭或断线清理待确认。支持有界、平坦的必填字符串／枚举／布尔 ACP 表单；不代理 URL、敏感输入或未知请求。流式文本、思考、标题、上下文用量及有界工具摘要按实际 ACP 更新投影；不把任意参数、工具输出或诊断正文放进共享事件。 |
| 模型与深度 | 从原生会话 `configOptions` 生成会话内选择器，只发该会话实际提供的选项；`session/set_config_option` 的结果需要原生读回。新建前无安全可读的模型目录，使用原生默认，不为取目录新建占位会话。没有实际执行配置事实时不宣称「本轮使用」。 |
| 关闭、历史与不支持项 | 若协商 `session/close`，用运行代次确认并关闭确切会话，历史仍可重新打开。AGY 不提供归档、删除、原生文件差异、原始工具展开、跨会话并行子任务或其它没有验证清楚的原生功能；不把 `/quit`、关闭、回滚或归档互相替代。 |

实现与断言：[`agy-runtime.ts`](../../packages/host/src/agy-runtime.ts)、[`agy-runtime.test.ts`](../../packages/host/src/agy-runtime.test.ts)、[`agy-approval.ts`](../../packages/host/src/agy-approval.ts)、[`agy-elicitation.test.ts`](../../packages/host/src/agy-elicitation.test.ts)、[`agy-submission-fence.test.ts`](../../packages/host/src/agy-submission-fence.test.ts)。

### AGY-13｜App 和桌面入口

iOS／Android 在配对 Host 确认能力后才允许新建与恢复；复用 Agent 拨盘、目录、草稿、历史、模型设置、交互和关闭确认。桌面 Agent 页只用于本机启用、显示接入状态或后台重试，不提供终端入口。旧 Host 不公告 `agent.agy`，新 App 不向它声明或发起 AGY 操作。没有该能力的设备看不到 AGY 启用项、运行态、目录、启动记录或诊断；先过滤再构造目录计数、工作区、分页和增量。换连接或失去能力不重用旧投影；协议版本不变。

实现：[`OrbisStore.swift`](../../ios/Orbis/Orbis/OrbisStore.swift)、[`HostConnection.kt`](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)、[`Main.qml`](../../packages/windows-host/src/qml/Main.qml)。测试：[`LaunchLedgerTests.swift`](../../ios/Orbis/Tests/LaunchLedgerTests.swift)、[`AgyIntegrationTest.kt`](../../android/app/src/test/java/com/orbising/orbis/AgyIntegrationTest.kt)、[`OverviewRowHoverTest.cpp`](../../packages/windows-host/src/tests/OverviewRowHoverTest.cpp)。

### AGY-14｜验证与交付

- 同版隔离 Host／Relay／ACP fixture 检查协商、新建、流式消息、历史和同设备能力撤回；夹具不等价于有凭据的真实推理。测试见 [`host-service.test.ts`](../../packages/host/src/host-service.test.ts) 和 [`device-agent-visibility.test.ts`](../../packages/host/src/device-agent-visibility.test.ts)。
- 代码验证：Node 类型检查、打包、定向 lint 通过；[Node](../../.artifacts/agy-acp-20261125/node-verified.log) 459 项通过、3 项跳过；[iOS Swift](../../.artifacts/agy-acp-20261125/swift-final/run.log) 80 项通过，无签名 Simulator 构建成功；[Android](../../.artifacts/agy-acp-20261125/android-final/run.log) 35 项通过，另有已核验的 [Debug APK](../../.artifacts/agy-acp-20261125/android-debug/artifact-verification.log)；[Qt/macOS](../../.artifacts/agy-acp-20261125/qt-agy-verified/run.log) 构建、Host live-change 和 AGY 界面用例通过。Qt Kimi Web 的既有断言在 [基线](../../.artifacts/agy-acp-20261125/qt-baseline-kimi/run.log) 同样失败，未改断言。
- [已发布 Relay v0.1.24 对照](../../.artifacts/agy-acp-20261125/relay-release-delivery.log)使用该 tag 的真实 Relay 构建，并复用同版正对照的 Node 加密链路测试；不等价于运行旧 iOS／Android 安装包。实机 CLI 用同一启动参数在无凭据的隔离环境确认 `1.5.17`、ACP v1、list/load/close 能力和未登录的原生拒绝（[证据](../../.artifacts/agy-acp-20261125/native-production-flags.log)）；未调用真实模型或使用个人账号。
- [本地证据目录](../../.artifacts/agy-acp-20261125/)保留首次失败、构建租约清理、重跑和对照。QA 看板需要可拉取的候选提交，本地候选尚未发布到远端。
- 待用户验证：用隔离 Host／Relay 和获授权的 API key，安装对应候选 App。检查首次启动与首句、审批允许/拒绝、停止／排队、关闭后重开、断线恢复、旧版 App 不出现 AGY。真实模型响应、实际权限表单以及 Windows/Linux Host 设备环境需分别确认。未签发、未部署；用户验收独立记录。

[acp]: https://antigravity.google/docs/ide/extensions/acp/
[faq]: https://antigravity.google/docs/faq/
[release]: https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.17
[schema]: https://agentclientprotocol.com/protocol/schema
