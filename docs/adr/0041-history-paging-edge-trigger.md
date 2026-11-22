# ADR-0041：历史分页只由「进入顶部区域」的边沿触发

日期：2026-10-23

Status: accepted（2026-10-23 实现 §1–§4；在线会话与离线历史页共用）

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md) §4、[ADR-0037](0037-session-sync-transaction-contract.md) §5、[ADR-0040](0040-bounded-inbound-delivery.md)

## Context

历史分页现在是「视口在顶部就加载下一頁」的电平触发（[HistoryPaging.kt](../../android/app/src/main/java/com/orbising/orbis/HistoryPaging.kt)）：

- `historyPagingRequests` 用 `snapshotFlow { firstVisibleIndex() to anchorPending() }`，过滤 `index <= 1 && !pending`。
- 它被放在 `LaunchedEffect(runtimeId, sessionId, historyState?.hasOlder, historyRead?.operationId, historyRead?.phase, initialPositioned)` 里。`historyRead.operationId`/`phase` 每完成一页就变 → effect 重启 → `snapshotFlow` **重新发出当前值**（首帧）；只要视口仍在 `index <= 1`，就再请求一页。

于是「停在顶部」不再是一次用户动作，而是一个循环：一页 30 条 entry 落库、投影、产生一次 `session.snapshot`，紧接着请求下一页。现场日志里连续出现 `range=history` 的 `[DEBUG-history] start`（18:54:19.620 / 20.013 / 20.330，中间还夹着同一会话的 catchup），与这条路径一致。

这与 ADR-0037 §5 的判定冲突：历史分页是**用户动作**，失败要立刻可见、可重试；自动续页把用户停在顶部变成了无人监督的连续下载，并且每一页都会推高接收侧队列与 SQLite 写入（ADR-0040 的预算因此更容易被撞到）。

原实现想解决的是另一个问题：「一页 prepend 之后锚点释放，但首行没有移动，分页就停住」。该情形只在**页面短到撑不满视口**时出现；把它推广成「只要在顶部就继续」是这次循环的来源。

## Decision

### §1 按上滑边沿触发

历史分页由视口进入顶部区域的边沿触发，离开后重新武装；当前实现阈值为 firstVisibleIndex 从大于 1 进入小于等于 1。

### §2 每页沿用独立手势

后续分页由新的用户边沿或显式加载操作触发。

### §3 在观察流内判断准入

读取流内部观察最新准入状态，订阅生命周期绑定会话身份与初次定位状态。

### §4 失败仍然可见、可重试

读取失败保留错误与显式重试入口，沿用既有操作生命周期。

### §5 顶部提供显式加载入口

存在更早历史时提供加载入口，展示读取状态与恢复操作；按钮和边沿共用同一读取入口。

## Consequences

- 停在顶部不再产生请求；`range=history` 的次数与用户上滑的次数同阶，而不是与停留时长同阶。
- 每次上滑仍只加载一页（30 条），行为对用户可见、可预期。
- 当前页短到撑不满视口或用户已在顶部时，不会自动补页；顶部显式入口仍允许用户继续加载。

## Verification

[测试规则](../../AGENTS.md#测试)；[HistoryPagingTest.kt](../../android/app/src/test/java/com/orbising/orbis/HistoryPagingTest.kt)；[原始证据](../../.artifacts/)。

## CHAT-PAGING-01：聊天页按手势松手分页（2026-11-18）

在线及缓存聊天页移除可见的「更早的消息」按钮，保留读屏动作。主动上翻到顶部区域并松手最多读取一页；已在顶部（包括不足一屏）须达到下拉阈值再松手。手势开始和结束均校验准入，读取中的手势不排队；停留、回弹、布局变化、定位与回包不触发前台续页。游标不推进时进入失败而非续页。预取与传输重发仍由各自的预算和操作归属控制。Android 独立离线历史列表维持原有 §1–§5 行为。

失败时「重试」与最近提问互斥；重试在原位显示加载状态。分页状态不增减可见列表行。验证见 [分页锚点和请求计数](../../.artifacts/chat-history-20261118/ios-ui-r4/command.log)、[Android 读操作单测](../../.artifacts/chat-history-20261118/android-build-r3/)及 [Android 提示互斥](../../.artifacts/chat-history-20261118/android-ui-r3/instrumentation.log)。未部署，未做真机验收。

## CHAT-PAGING-02：聊天区顶部分页状态（V04）

前台历史分页及重试期间，在聊天区顶部居中显示小进度圈和「正在加载更早的历史…」。提示沿用顶部覆盖槽，不新增列表行、不拦截滚动；成功或结束后收起，失败保留既有重试。首屏同步、后台预取及 Android 独立离线历史列表保持原有呈现。

实现见 [iOS 聊天顶部](../../ios/Orbis/Orbis/ChatHeaderView.swift)及 [Android 聊天顶部组件](../../android/app/src/main/java/com/orbising/orbis/ChatQuestionReminder.kt)。自动验证：[iOS 分页等待与阅读锚点](../../.artifacts/chat-history-loading.aIPaMH/ios-device/command.log)、[Android 加载状态、提示互斥及锚点](../../.artifacts/chat-history-loading.aIPaMH/android-ui/instrumentation.log)。未部署，未做真机验收。

## CHAT-PAGING-03：松手触发反馈（V04）

有效手势松手后，顶部进度提示立即出现并用 `state` 动效短滑入，不改变列表布局；系统减少动画时直接显示。前台分页获准只触发一次共用操作触感，不把短拉、取消、合并请求或后台预取当成一次新动作。

自动验证：[iOS 即时状态](../../.artifacts/chat-history-trigger-feedback.t9aWWx/swift/run.log)、[iOS 分页与阅读锚点](../../.artifacts/chat-history-trigger-feedback.t9aWWx/ios-device/command.log)、[Android 进场位移与锚点](../../.artifacts/chat-history-trigger-feedback.t9aWWx/android-ui-r2/instrumentation.log)。未部署；真机触感和观感待用户验证。

## CHAT-PAGING-04：松手前的下拉进度（V04）

有可读旧页时，顶部区域内的有效下拉沿用分页准入与原阈值，进度环随手势距离填满或退回，达到阈值时显示「松手加载」。反向退回阈值内、未达阈值松手或取消，不提交分页。达到阈值后松手，原位切到不定进度的加载状态；触感仍只在实际准入后触发。保持列表布局和后台预取不变。

自动验证：[iOS 阈值与取消](../../.artifacts/chat-history-pull-progress.o8gy7V/swift-r2/run.log)、[iOS 分页与阅读锚点](../../.artifacts/chat-history-pull-progress.o8gy7V/ios-device/command.log)、[Android 按住时的进度、回拉与取消](../../.artifacts/chat-history-pull-progress.o8gy7V/android-ui-r2/instrumentation.log)。未部署；真机观感待用户验证。

## CHAT-PAGING-05：Android 下拉提示柔影

淡入层包含透明的外扩留白，让提示条的高光和阴影随提示一起移动、淡入，不被矩形合成边界截断。手势阈值、触感及阅读锚点不变。实现见 [Android 聊天顶部组件](../../android/app/src/main/java/com/orbising/orbis/ChatQuestionReminder.kt)，像素回归见 [聊天顶部仪器测试](../../android/app/src/androidTest/java/com/orbising/orbis/ChatQuestionReminderInstrumentedTest.kt)。[修复前失败与修复后证据](../../.artifacts/android-history-pull-shadow.c3wx6R/verification.json)；本地签名试装包已生成，未部署，真机观感待用户验证。

## CHAT-PAGING-06：进度圈填满时的触感（V04）

聊天历史下拉从未满切换到「松手加载」时，沿用首页卡片左滑关闭的操作触感。保持拉满不重复反馈；回拉退回后再次拉满可重新反馈。松手仍按原阈值提交，取消不请求；手势提交与分页受理不再补震。显式重试与读屏动作沿用受理反馈。此条更新 CHAT-PAGING-03 / 04 的手势触感时机。

实现见 [iOS 视口](../../ios/Orbis/Orbis/ChatPageScheduling.swift)、[iOS 聊天转录](../../ios/Orbis/Orbis/ChatTranscriptView.swift)和 [Android 分页手势](../../android/app/src/main/java/com/orbising/orbis/HistoryPaging.kt)。自动验证：[iOS 手势和视口单测](../../.artifacts/chat-history-arming-20261120/swift/run.log)、[iOS 分页与阅读锚点](../../.artifacts/chat-history-arming-20261120/ios-device/command.log)、[Android 分页单测](../../.artifacts/chat-history-arming-20261120/android-build/build.log)、[Android 按住、回拉、取消和松手的触感回调](../../.artifacts/chat-history-arming-20261120/android-ui/instrumentation.log)。未部署；真机触感待用户验证。

真机验收使用独立 [QA 候选](../../.artifacts/chat-history-arming-20261120/qa/registration.json) `8472f7bf`；用户领取后构建安装包，不沿用本地模拟器产物。

## CHAT-PAGING-07：聊天顶部历史提示动效（V04）

下拉提示轻入场，位置和进度环直接跟手；跨越或回退阈值时，图标和文案过渡。松手后原位切换到加载圈；取消、成功或读完时收起提示；加载和失败重试在同一个顶部槽过渡。退场只保留画面，读屏和点击只对当前状态有效。沿用系统减少动画设置，不改变分页准入、触感、通知优先级和阅读锚点。

实现见 [iOS 顶部覆盖层](../../ios/Orbis/Orbis/ChatHeaderView.swift)和 [Android 顶部覆盖层](../../android/app/src/main/java/com/orbising/orbis/ChatQuestionReminder.kt)；回归见 [iOS 分页与锚点](../../ios/Orbis/UITests/OrbisUITests.swift)和 [Android 动画时钟及手势](../../android/app/src/androidTest/java/com/orbising/orbis/ChatQuestionReminderInstrumentedTest.kt)。

自动验证（工作区）：[Android 分页单测 6 项](../../.artifacts/chat-history-motion-20261122/android-build/test-results/testDebugUnitTest/TEST-com.orbising.orbis.HistoryPagingTest.xml)、[模拟器逐帧、手势与锚点回归 4 项](../../.artifacts/chat-history-motion-20261122/android-ui/instrumentation.log)、[Swift 手势与视口单测 3 项](../../.artifacts/chat-history-motion-20261122/swift/run.log)、[iOS 模拟器常规与减少动画的分页锚点回归 2 项](../../.artifacts/chat-history-motion-20261122/ios-device/command.log)通过。[共享 QA 第 2 轮](../../.artifacts/chat-history-motion-20261122/qa/registration.json)使用上一轮候选基线，仅加入本次改动；待用户领取后构建安装包，不沿用工作区的模拟器产物。未部署，真机观感待用户验证。
