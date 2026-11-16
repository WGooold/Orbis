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
