# ADR-0083：错误与提示分级；迟到回包静默（SC91–SC95）

日期：2026-11-16

Status: SC91–SC95 两端已实现，定向自动验证与编译通过。F0–F5 规范及 F3 底部短反馈 / F4 顶部横幅的可见行为调整已确认，作为 r59 候选；未部署，待用户验证。

关联：[设计规范「错误与提示的形式和时机」](../design/orbis-design-system.md#错误与提示的形式和时机)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)（未确认不是失败）、[ADR-0064](0064-protocol-compatibility.md)（v0.1.19 对照）、[ADR-0070](0070-unified-design-and-interaction.md)、[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) V06 / V16、[ADR-0058](0058-shared-interaction-motion.md) SC34、[ADR-0081](0081-host-startup-blocking-and-feedback.md)（Host 桌面端反馈）。

代码指针以 `c9fd052c` 为基点，给出符号名；行号漂移时以符号为准。

## 1. 背景

Android 把迟到或重复的合法回包报成「收到不支持的中继服务器消息，请在电脑端检查协议版本」，并以常驻错误条显示。

- 目录与历史窗口的能力探测、目录查询、历史兴趣订阅由连接层按 `requestId` 自管：`HostConnection` 只在请求仍在途时前置消费回包。
- 每个已认证 `device.ready` 都会用新 ID 重发两个能力探测并重置兴趣订阅；兴趣订阅 20 s 未确认时也会换 ID 重发。前一轮的回包随后到达时已无所属请求，落到 `RelayReducer.reducePayload` 的类型白名单，被当作未知消息。
- 同类的跨版本情形：v0.1.19 Host 不认识这些探测，回带 `requestId` 的 `protocol.error(invalid_request)`。迟到的这条在 Android 走 reducer 的通用分支，变成「电脑端拒绝了请求（invalid_request）」；在 iOS 走 `case "protocol.error"` 的兜底，写进常驻的 `errorMessage`。iOS 对未知类型 `default: break`，没有第一种误报。

背后的呈现问题：Android 的共享 `error` 通道有两层（6 s 自动消失 / 常驻），iOS 的 `errorMessage` 只有一种常驻顶部条；设计规范只规定了「一个任务一种容器」和短反馈动效。噪音和真正需要处理的问题以同一种形式出现，此前没有成文的分级规则。

## 2. 决策

### 2.1 呈现分级

设计规范 §8 新增「错误与提示的形式和时机」，适用于手机 App，是唯一规范来源：F0 静默、F1 原位、F2 状态、F3 短反馈、F4 横幅、F5 对话框；按“有无所属 → 是否需决定 → 是否属于对象 → 是否持续状态 → 是否全局且只有用户能解决”的顺序选层级。时机规则包括结果确定后再呈现、先状态后升级、请求归属唯一、去重合并和跟随作用域。共享错误通道（Android `RemoteState.error`、iOS `OrbisStore.errorMessage`）只承载 F4。

与原规范相比改了两条（V06 / V16 / SC34 的规范描述）：

- 错误不再一律常驻：用短反馈（F3）时原位已有记录，按 `hold-toast` 消失；需要用户处理的用横幅（F4），随条件解除。
- 短反馈从下边缘升起，错误横幅贴顶部，两者分开位置。

这两条已纳入 [ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) 的 `2026-11-16/r59` 候选修订；实现、自动验证、部署与用户验收分别记录于 §6。当前已验收基线保留为 r58。

### 2.2 SC91：迟到回包按 F0 处理

- 连接层自管的请求 ID 统一为 `conn:` + UUID，两端相同。在途回包与协议错误照旧由所属读取器先消费。
- Android：这些请求的回包类型（含一直由连接层消费的 `session.catalog.page`、`agent.menu.options.page`）到达 reducer 即丢弃；带该前缀的 `protocol.error` 丢弃，写一条 `relay.reply_dropped` 诊断日志，且不置 `preserveErrorOnClose`。
- iOS：带该前缀的 `protocol.error` 丢弃；所有入站消息已记入连接事件。
- 致命错误码（`unauthorized`、`invalid_message`、`protocol_version_mismatch`、`runtime_mismatch`）不丢弃：Host 对版本不兼容同样回传触发请求的 `requestId`，这类错误说明整条连接不可用，照常按 F4 呈现。
- 同版本下真正未知的顶层消息类型维持 F4：ADR-0064 要求新消息类型在能力确认后发送，出现未知类型说明存在兼容缺陷。

## 3. 实现

| 端 | 位置 | 内容 |
| --- | --- | --- |
| Android | `RemoteState.kt` `CONNECTION_OWNED_REQUEST_PREFIX` / `connectionRequestId()` / `isConnectionOwnedRequest()` / `CONNECTION_FATAL_PROTOCOL_CODES` / `isStaleConnectionError()` / `CONNECTION_OWNED_REPLIES` | 前缀、ID 生成、致命码与回包类型 |
| Android | `RemoteState.kt` `RelayReducer.reducePayload` 及其 `protocol.error` 分支 | 迟到回包与非致命协议错误丢弃 |
| Android | `AgentCatalogRange.kt` `CatalogViewReads.connect` / `needMore`；`ReadReconcileSchedule.kt` `HistoryWindowInterest.publish`；`HostConnection.kt` `device.ready` 后的历史能力探测 | 改用 `connectionRequestId()` |
| Android | `HostConnection.kt` 回包处理（`relay.reply_dropped`、`preserveErrorOnClose`、`stopReconnectOnClose`） | 诊断日志；被丢弃的协议错误不保留旧错误；致命码集合复用同一常量 |
| iOS | `Models.swift` `connectionOwnedRequestPrefix` / `connectionRequestId()` / `connectionFatalProtocolCodes` / `isStaleConnectionError(_:)` | 前缀、ID 生成与判定 |
| iOS | `HostCatalog.swift` `CatalogViewReads.connect` / `needMore`；`ReadReconcileSchedule.swift` `HistoryWindowInterest.publish`；`OrbisStore.swift` `device.ready` 后的历史能力探测 | 改用 `connectionRequestId()` |
| iOS | `OrbisStore.swift` `receive` 的 `case "protocol.error"` | 迟到的非致命协议错误丢弃 |

SC91 无新增用户文案；SC92–SC95 的文案同步见 §6.3。

## 4. 兼容

SC91 与 SC95 只改请求 ID 的取值及本地回包归属，字段和协议号不变；SC92–SC94 是 App 本地状态与呈现改造。下列历史对照属于 SC91，不作为本轮新增联测结论。

- 当前 Host：`DeviceE2ePayloadSchema` 对这四类请求只校验长度（≤128 / 256），带前缀的 ID 实际解析通过。
- v0.1.19 Host：不认识这些请求，只校验 `requestId` 为 1–128 字符，在 `invalid_request` 中原样回传（源码核对，未运行旧版 Host）。前缀 ID 长 41 字符。
- 旧 App 与新 Host：不受影响，ID 由 App 生成。

## 5. 验证

本节保留 SC91 的原始自动验证与未运行项；SC92–SC95 的新增验证和交付状态见 §6。

| 项 | 结果 |
| --- | --- |
| 修复前（Android） | 新增 4 个用例失败，复现原文案「收到不支持的中继服务器消息…」与「电脑端拒绝了请求（invalid_request）…」 |
| 修复前（iOS） | 新增 3 个用例失败；第二次 `device.ready` 后，第一轮探测迟到的 `invalid_request` 写入 `errorMessage` |
| 致命码对照，修复前 | 只按前缀丢弃时，迟到的 `protocol_version_mismatch` 被吞掉：两端各 1 个断言失败 |
| 修复后（Android） | `RelayReducerTest` 100/100、`CatalogViewReadsTest` 6/6、`ReadReconcileScheduleTest` 5/5、`AgentCatalogRangeTest` 5/5、`ProtocolCompatibilityTest` 4/4、`LegacyProtocolConnectionTest` 8/8 |
| 修复后（iOS） | `StoreTests`、`CatalogViewReadsTests`、`ReadReconcileScheduleTests` 共 102 个通过 |
| Host schema | 带前缀 ID 的四类请求解析通过 |

新增用例：

- Android：`RelayReducerTest` 的 `late or duplicate connection owned replies are dropped without a relay error`（含未知类型仍报错的对照），以及 `late protocol errors for connection owned requests are dropped`（含无主 ID 与致命码仍报错的对照）；`CatalogViewReadsTest`、`ReadReconcileScheduleTest` 的前缀用例。
- iOS：`StoreTests.lateCapabilityRepliesAfterReprobeStaySilent`（含无主 ID 与致命码仍报错的对照）；`CatalogViewReadsTests`、`ReadReconcileScheduleTests` 的前缀用例。

未运行：

- `PublishedProtocol18InteropTest`：需显式提供冻结的 Host 18 本地夹具（`ORBIS_LEGACY18_NODE_FIXTURE`），本次未提供；该用例也不覆盖这几个探测。
- Android 设备测试。
- iOS Xcode 应用目标构建；改动的 Swift 文件均由 SwiftPM 包编译。
- 真实 v0.1.19 Host 联测。

证据见 [verification.json](../../.artifacts/stale-reply-20261116/verification.json)。

部署：未部署，尚无候选安装包。用户验收：待用户验证。安装候选包后正常使用，经历重连、局域网与中继切换、快速切换会话，不应再出现「不支持的中继服务器消息」或「请求格式无效或当前版本不支持」。

## 6. 分批迁移

2026-11-16，SC92–SC95 / V06 / V16 / SC34，r59 候选。规范来源为设计规范 §8；下列四批两端实施完成，本节不改变 §5 的 SC91 历史证据。

| 批次 | 场景 | 迁移范围 |
| --- | --- | --- |
| 反馈框架 | SC92 | 写入时声明层级；F3 与 F4 各自管理身份、去重、关闭、条件解除及前后台 / 电脑作用域；同时成立的 F4 按重新配对、版本不兼容、电脑未打开、其他取一条 |
| 连接与诊断 | SC93 | 自动重连、路由切换与离线进入 F2；迟到、重复和可恢复的无主结果进入 F0；凭据 / 配对、版本与已确认的握手超时进入 F4，附解决操作 |
| 对象与操作 | SC94 | 发送、配置、历史同步、目录、工具、文件、下载、附件及会话操作的失败留在所属对象；确认结果或离开原位后的有效提醒使用 F3，取消配对等决定沿用 F5 |
| 命令菜单 | SC95 | `menuOptions` 先认领在途协议错误，再给自管请求加 `conn:` 前缀；读取失败留在菜单，过期结果进入 F0，致命连接码仍由连接层处理 |

### 6.1 验收路径

| 触发条件 | 层级与时机 | 消失与恢复 | 文案与操作 |
| --- | --- | --- | --- |
| 已完成的操作结果；离开原位后仍有用的失败提醒 | F3，结果确定且 App 在前台时 | 无操作停 `hold-toast`；有操作停到执行或关闭；新反馈替换旧反馈，重复身份不重新计时，后台不补放 | 结果句；最多一个操作，如「草稿已保留」 |
| 凭据被拒或配对材料不完整 | F4，连接层确认后 | 重新配对成功或条件解除；关闭后同一条件不再出现，解除后再次成立可重新出现 | 配对问题与「重新配对」 |
| 版本不兼容或同版本未知顶层消息 | F4，确认连接无法继续后 | 更新并恢复连接；关闭后同一条件不再出现 | 更新手机与电脑端 Orbis 的简短提示；不展示协议错误码 |
| 已确认端到端握手超时 | F4，超时前保持 F2 | 连接恢复自动解除；关闭后本次条件不再出现 | 「电脑端 Orbis 未打开，打开后会自动连接」及连接恢复操作 |
| 自动重连、电脑离线、路由切换 | F2，连接状态确认后 | 状况解除时恢复既有状态词 | 复用状态显示 |
| 发送、配置、同步、目录、工具、下载或上传失败 | F1，所属请求给出确定结果后 | 原位重试 / 核对成功或对象移除；旧数据继续可用 | 对象自己的错误行、发送状态槽、下载行或附件位 |
| 命令选项在途协议错误、超时与迟到回包 | 在途失败 F1；迟到、重复或失去归属为 F0 | 菜单重开 / 读取成功恢复；过期结果仅诊断 | 菜单原位显示读取失败，不写全局横幅 |
| 切换电脑、进入后台 | 随作用域管理 F1–F4 | 清除上一台电脑的反馈；后台不积累 F3，回前台按当前 F2 / F4 条件呈现 | 不补放已过期短反馈 |

### 6.2 实现与验证入口

| 场景 | Android | iOS |
| --- | --- | --- |
| SC92 | `Feedback.kt` 的 `FeedbackState`；`MainActivity.FeedbackOverlay`；`InteractionMotion.ToastHold` | `Models.swift` 的 `FeedbackState` / `FeedbackTiming.holdToast`；`OrbisStore.presentFeedback`；`ContentView.rootWithNotices` |
| SC93 | `HostConnection.kt` 的连接恢复 / 超时与 `RemoteState.kt` 的协议错误分派 | `OrbisStore.connectionFeedback` 与传输层连接状态回调 |
| SC94 | `RemoteState.kt`、`HostConnection.kt`、`OperationKinds.kt`、`AgentModelProjection.kt` / `AgentModelState.kt` 的领域状态；`withTransferFailureFeedback` 按下载页 / 附件可见性决定离开原位后的 F3；相关面板与状态槽 | `OrbisStore.objectErrors` / `sessionOperationErrors` / `menuErrors` / `queueErrors` / `interactionErrors`；`setFeedbackPage` 与 `FileTransfers.didFailTask` 管理离开原位后的 F3；相关对象视图 |
| SC95 | `MenuOptionsLoader.owns` / `consume`；`HostConnection` 入站分派 | `AgentState.swift` 的 `MenuOptionsLoader.consume`；`OrbisStore.receive` |

定向回归入口：Android `FeedbackTest`、`MenuOptionsLoaderTest`、`RelayReducerTest`；iOS `FeedbackTests`、`MenuOptionsTests`、`StoreTests`。用例分别覆盖竞争条件、关闭后抑制、解除复位、重复反馈不重置身份、旧计时器不清除新反馈、后台不积累，以及菜单在途错误与致命连接码的归属。测试结果与实际执行范围见[本轮证据](../../.artifacts/feedback-levels-20261116/verification.json)。

iOS 原位与连接集成用例为 `StoreTests.rejectedStopAndOfflineCloseStayOnTheirRuntimeCards`、`relayRejectionsUseTheirConditionAndDismissedConditionsStayHidden`、`menuProtocolFailureStaysInlineAndLateDuplicateIsSilent`。SC95 行为红测保留于 `.artifacts/feedback-levels-20261116/ios/menu-behavior-red-complete/run.log`；框架与 Android 红测各自保留首次失败证据，最终结果另见证据。

| 自动验证 | 实际结果 |
| --- | --- |
| Android 单元回归 | 870 项，862 通过、8 跳过，0 失败；跳过项与执行范围见平台证据 |
| Android 仪器用例源码 | `compileDebugAndroidTestKotlin` 通过；设备用例未执行 |
| iOS 回归 | `final-regression` 275 项通过；末轮 `final-dispatch-green` 56 项通过，选择器有交集，数量不相加 |
| iOS App | 应用目标编译通过；最终构建路径与源码对应关系见本轮汇总证据 |
| 文案 | `generate-mobile-localizations.py --check` 通过；固定文案覆盖、参数与两端生成一致 |

收尾回归覆盖转移失败离开原位后的 F3、历史失败任务恢复不补放 F3、切换电脑后按仍成立条件恢复 F4、取消配对失败的原位反馈、嵌入错误码的展示过滤，以及合法文件回包先由读取器认领、真正未知类型仍按 F4 呈现。平台原始结果、首次失败、构建租约与清理各自保存在 `.artifacts/feedback-levels-20261116/android/` 和 `ios/`；汇总见 [verification.json](../../.artifacts/feedback-levels-20261116/verification.json)。

### 6.3 文案与交付

应用拥有的修改文案同步维护 `localization/mobile.json`，来自电脑端的固定文案由 `mobile-host.json` 白名单保持双向映射；两者通过 `scripts/generate-mobile-localizations.py` 生成两端 `LocalizationCatalog`，并以 `--check` 校验固定文案覆盖、参数与生成结果。用户界面使用「电脑端 Orbis」等产品名称，内部错误码及协议细节保留在诊断。

实施：两端完成。自动验证：上述领域、框架、读取器回归与编译通过。部署：未部署。用户验收：待用户验证；共享 QA 的候选、安装包、隔离环境与步骤按同一 Case 登记，等待用户在网页领取后构建与安装，人工验收由用户记录。

### 6.4 SC96–SC98：拒绝结果结算与反馈归属回归

2026-11-16，基于 `0a54d4e2` 的反馈分级实现核对并修复；不改变 §5 / §6.2 的历史验证记录。

- SC96：Host 的明确拒绝同时结算所属操作与命令等待者；带 `commandId` / `requestId` 的版本拒绝保留连接横幅，并结束对应命令、账本启动或配置请求。核对读取被拒不能推断其他写操作失败。iOS 已知消息失去读取器归属时仅记诊断，未知顶层类型仍呈现版本横幅。
- LAUNCH-FEEDBACK-01：两端将一次性启动反馈与配置读取 / 保存错误分开。上次启动结束或放弃后，可继续使用已确认配置重试；真实配置错误仍须先核对。
- SC97：输入和首句校验留在各自输入区域，不写首页卡片或侧栏操作结果；Android 首句校验显式归属新建卡片，合法重试清除旧提示。iOS 原先只污染首页卡片，侧栏未受影响，且编辑原本能够清除错误。
- SC98：失败原因保留文件名、用户路径及自然语言；Android 仅识别已知内部码并处理其注记，缓存正则；iOS 不再改写路径中的 `host` / `runtime` / `relay`。
- SC92 / SC93 修正：Android 切换电脑时保留该电脑的未解除条件与关闭状态，清除短反馈；`host_disabled` 恢复自动重连，设置操作显示「设置」。iOS 此项原已使用重连操作。删除 Android 无语义的 `preserveErrorOnClose` / `preserveError` 和重复不可达错误分派。

实现与用例：Android `RelayReducer.rejectProtocolOperation`、`SessionConfigurationState.admitConfiguredLaunch`、`Feedback.kt`、`HostConnection.validateMessageInput`；`CommandRejectionFeedbackTest`、`LaunchFeedbackRegressionTest`、`FeedbackTest`。iOS `HostConnection.rejectCorrelatedProtocolOperation` / `composerFeedback`、`ChatScreenSnapshot.inputError`、`SessionDraftView`；`StoreTests`、`LaunchLedgerTests`、`FeedbackTests`。

自动验证：Android 首轮 19 项中 10 项预期失败，补充验证 25 项中 5 项预期失败，修复后最终 216 项通过；iOS 7 项修复前回归暴露问题，最终 162 项领域回归及另 2 项请求 ID 回归通过，应用目标编译通过。文案生成校验通过。首次失败、夹具修正、源码摘要、构建租约与清理记录见[本轮证据](../../.artifacts/feedback-review-20261116/verification.json)。

部署：未部署；本轮未生成安装候选、未运行设备交互或真实旧 Host / Relay 联测。用户验收：待用户验证。

### 6.5 SC99–SC101：拒绝归属与启动提示生命周期补齐

2026-11-16，继续核对 §6.4 的实现；原始失败及历史验证记录保留。

- SC99：两端的普通与连接级协议拒绝共用各端的结算入口。Android 结束对应目录、激活、浏览、首页模型、供应商及配置请求；两端分别认领 `commandId` / `requestId`，同一回包可结束不同操作。连接横幅与所属请求结果同时保留。账本核对读取优先交回读取器并移除在途记录，只按当前连接的新鲜权威状态核对，不把读取失败当作其他写操作的拒绝回执；已结束读取的旧 ID 重复拒绝也不结算写操作。iOS 历史失败只由同步读取器收尾。
- SC100：Android 上次启动日志加载完成或结算后，自动解除等待该日志的提示，独立输入与配置错误保留；登记新启动时统一清理旧提示。iOS 编辑只清除输入校验提示，启动恢复提示保留到对应条件解除或合法启动准入完成。Android 新建目标检查失败沿 SC97 留在新建草稿。
- SC101：Android 未登记的内部机器码及其注记也只留诊断；文件名、路径、自然语言及 WS / QUIC 原因保留。裸蛇形标识按机器码处理，带扩展名或路径的名称保留。此前误标 SC94 的输入与文案用例改回其所属 SC97 / SC98，新增场景使用本节新 ID。

实现与回归：Android `RelayReducer.rejectProtocolOperation`、`SessionConfigurationState.reconcileLaunchJournal`、`HostConnection.validateNewSessionTarget`、`feedbackFailureText`；`CommandRejectionFeedbackTest`、`LaunchFeedbackRegressionTest`、`FeedbackTest`。iOS `HostConnection.rejectCorrelatedProtocolOperation` / `clearSessionLaunchValidationError`、`SessionDraftView`；`LaunchLedgerTests`、`QuitLedgerTests`、`ArchiveLedgerTests`。

自动验证：Android 修复前 11 项中 5 项失败；扩展回归中旧的“连接拒绝不结束浏览”断言失败，保留首次证据并按 SC99 更新为结束浏览且保留横幅；最终 271 项通过。iOS 新回归在修复前触发 9 条失败断言，195 项领域回归通过，补齐旧读取重复拒绝保护后 49 项定向回归通过，两组有交集。两端文案生成校验通过。原始日志、源码摘要、应用编译及构建租约清理见[本轮证据](../../.artifacts/feedback-review-followup-20261116/verification.json)。

部署：未部署，未生成本轮安装候选，未运行设备交互或真实旧 Host / Relay 联测。共享 QA MCP 初始化被拒绝连接，本轮未登记；沿用同一 Case 的新轮次要求保存在本轮证据中，候选发布后再登记。用户验收：待用户验证。

### 6.6 SC99–SC102：复核修正

2026-11-16，复核 §6.5 实现后修正；§6.5 记录保留。

- SC100：iOS 恢复其他会话不清除上次启动提示，只有新建启动准入才清除，与 Android 一致。
- SC102：iOS 激活请求未能写出时的“未连接到电脑”提示，在下一次 `device.ready` 或激活成功写出后解除；编辑仍只清除输入校验提示。
- SC99：iOS 普通与连接级拒绝未附原因时，配置、历史、目录浏览、待发送消息与命令操作各自使用所属文案，只有账本回执使用通用文案。
- SC101：两端机器码后接句末标点仍按机器码处理；点号后接字母或数字时视为扩展名并保留。

实现与回归：iOS `HostConnection.activateTarget` / `rejectCorrelatedProtocolOperation`、`FeedbackText.reason`；`LaunchLedgerTests`、`FeedbackTests`。Android `feedbackFailureText`；`FeedbackTest`。

自动验证：新增回归在修复前 iOS 4 项全部失败（8 条断言），Android `FeedbackTest` 1 项失败；修复后 iOS 相关 164 项、Android 34 项通过，文案校验通过。原始日志、源码摘要与构建租约清理见[本轮证据](../../.artifacts/feedback-review-fix-20261116/verification.json)。

部署：未部署，未生成安装候选，未运行设备交互。共享 QA MCP 本次连接失败，未登记。用户验收：待用户验证。

### 6.7 SC103–SC106：复核遗留项处理

2026-11-16，处理 §6.6 未修复的复核项；§6.5、§6.6 记录保留，以下各项取代 §6.5 中对应表述。

- SC103：取代 SC101 的“裸蛇形标识按机器码处理”中的大写部分。两端全大写名称（如环境变量）按用户可读细节保留原文；小写蛇形标识（含加引号或位于 JSON 中）仍按机器码处理。
- SC104：取代 Android 新建草稿统一标题。新建卡片只在上次启动待核对时显示“启动未确认”标题与说明按钮，其余草稿错误（含输入校验与目标电脑检查）直接以错误色显示原因；属 r59 候选内的可见调整，待用户验证。
- SC105：取代 SC99 中列表与激活请求的“连接横幅与所属请求结果同时保留”。Android 连接级拒绝结束所属列表与激活请求，只由连接横幅说明，不写入会话列表错误；配置、目录浏览、首页读取与供应商请求仍同时保留横幅与原位结果。账本启动的普通拒绝仍只在启动页说明。
- SC106：Android 启动日志在加载完成及每次变更后通知连接对账，等待该日志的提示不再依赖各处单独刷新。订阅在连接启动读取缓存后开始，随连接关闭取消；连接关闭后不复用，新配对重建连接。
- SC106-R1：冷读恢复先发布变更序号，再解除 `awaitLoaded` 屏障；调用方恢复时可同时观察到快照与加载通知。`ConfiguredLaunchJournalTest` 以直接恢复的等待者固定原时序竞态，发布验证证据见 `.artifacts/client-release-20261117/android-race/`。
- Android 配置化启动登记只更新提示字段，不再用读取时的配置副本整体覆盖。

实现与回归：Android `feedbackFailureText`、`SessionConfigurationState.launchErrorTitle` / `SessionDraft`、`RelayReducer.rejectProtocolOperation`、`ConfiguredLaunchJournal.changes` / `HostConnection`、`HostConnection.createConfiguredSession`；`FeedbackTest`、`LaunchFeedbackRegressionTest`、`CommandRejectionFeedbackTest`、`ConfiguredLaunchJournalTest`。iOS `FeedbackText.reason`；`FeedbackTests`。

自动验证：修复前 Android 新断言 3 项失败，iOS 新用例的全大写注记断言失败；账本启动只在启动页说明的用例修复前即通过，作为防回退保留；`ConfiguredLaunchJournal.changes` 为新增接口，无修复前对照，`HostConnection` 订阅与启动登记字段更新无单元测试覆盖。修复后 Android 全部单元测试 900 项通过（8 项跳过），iOS 全部包测试 617 项及 XCTest 14 项通过（1 项跳过），文案校验通过；证据见[本轮证据](../../.artifacts/feedback-review-fix-20261116/verification.json)。

部署：未部署，未生成安装候选，未运行设备交互。共享 QA MCP 本次连接失败，未登记。用户验收：待用户验证。


### 6.8 FEEDBACK-POSITION-01：提示位置与对象归属

F4 在页头上方占独立位置，进入配对页时让位于配对原位反馈；F3 锚在当前页面底部控件上方，与输入栏、交互卡片及回到最新按钮分开。F1 留在所属卡片、附件输入、历史读取或供应商控件；关闭失败只标到请求目标，附件准备失败按电脑与会话隔离。

实现与验证入口：Android `FeedbackBannerSlot` / `FeedbackOverlay`、`FeedbackPositionInstrumentedTest`、`FeedbackTest`；iOS `FeedbackBottomAnchorKey`、`ChatSessionActions.uploadFailed`、`FileTransferTests`、`StoreTests` 与 `OrbisUITests` 的提示位置用例。

自动验证：Android 120 项单元测试、5 项 API 35 模拟器用例通过；iOS 141 项包测试、3 项 iPad 模拟器用例通过，两端构建与本地化校验通过。首次失败、复跑及截图见[证据目录](../../.artifacts/feedback-positions/)；共用池的 iPhone 处于保护状态，本轮未验证 iPhone 布局。部署：未部署。用户验收：待用户验证。

### 6.9 QUOTA-FEEDBACK-01：配额查询失败留在配额区

已认证的拒绝立即结束所属配额查询，失败显示在对应配置的双周期读数下方，不写入供应商目录错误。短暂断线保留同一电脑的最后读数；浏览其他 Agent 不清除已有结果。重试清除旧错误，过期回包不改写本次结果。

回归入口：Android `SubscriptionQuotaTest`、`ProviderDialInstrumentedTest.quotaRefreshStaysAvailableAfterTheFirstReading`；iOS `HostStateTests`、`OrbisUITests.testProviderCatalogProblemAndQuotaErrorNeverOverlapDialOrQuotaCells`。Android 106 项定向单测及 1 项模拟器用例、iOS 146 项包测试及 2 项 iPad 模拟器用例通过。首次失败、复跑和截图见[证据目录](../../.artifacts/quota-feedback-20261120/)；未部署，未验证真实账号及 iPhone 布局。

### QUOTA-FEEDBACK-02：目录暂缺不取消配额查询

供应商目录暂缺或不完整时，保留上次配额，并按原请求归属接收回包；目录恢复后在原配置下显示结果。目录确认原配置不再支持查询时，与收到供应商变更通知一样，清除该 Agent 的旧配额及在途请求；迟到回包不恢复已失效的数据。

实现与回归：Android `applyHostDomainProjection`、`withSubscriptionResult`、`SubscriptionQuotaTest`；iOS `HostState.reconcileQuotaProviders`、`HostStateTests.temporaryCatalogGapKeepsQuotaButAConfirmedSwitchInvalidatesIt`。Android 108 项定向单测、iOS 147 项定向包测试通过，首次失败与复跑见[证据目录](../../.artifacts/feedback-patch-review-20261120/)；本轮未重跑设备测试，未部署。
