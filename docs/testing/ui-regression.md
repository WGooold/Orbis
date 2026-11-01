# 移动端 UI 回归方案

本轮统一交互动效（r31 / ADR-0058）：32场景与MOT ticket先行，双端共用组件已接入。Android全量154项4失败/7外部夹具assumption，iOS全量69项8失败，均未超同设备同配置基线，但受影响既有失败仍阻塞验收。最终Android深色大字20项、实际减少动画19项、iOS SE小屏大字10项及iPad6项定向通过；截图与部分录屏已审阅，完整C/R/A门禁未完成。见 [交互动效验证记录](interaction-motion.md)。

日期：2026-11-01。适用基线：[ADR-0051](../adr/0051-ui-style-motion-and-visual-stability-freeze.md) `2026-11-01/r31`；整页导航范围见 [ADR-0054](../adr/0054-shared-full-page-navigation.md)；门禁决策见 [ADR-0053 §8](../adr/0053-settings-entry-page-motion-and-ui-regression-gate.md#8-ui-回归门禁立即生效)。

本方案规定 UI 改动完成前必须执行的自动与手动回归、新用例的编写要求和证据格式。设备、构建目录、锁与产物保留一律遵守根目录 `AGENTS.md` / `CLAUDE.md`（共享池、合计最多 10 台、独占锁、固定构建目录）。本文中的模拟器只指从共享池借用的设备，不授权新建设备。

## 1. 门禁：什么时候必须跑

| 改动类型 | 自动回归 | 手动回归 | 平台 |
| --- | --- | --- | --- |
| 新增 / 修改 UI 功能、页面、组件；视觉、布局、动效、手势、触觉、文案变更 | L1–L4 全量 | 核心冒烟 §4.2 + 受影响 ID 专项 §4.4–§4.6 + 外观矩阵 §2.3 | 改了哪个平台跑哪个 |
| 会改变显示的重构、性能优化、状态 / 投影 / 协议 / Host 显示数据修复 | 同上 | 同上 | 消费该数据的平台 |
| 修改 ADR-0051 规则或参数、共用 token / 组件、双端共享投影契约 | 同上 | 同上 | **两端都跑** |
| 只写 UI 设计、尚未改代码 | — | — | 设计说明须列出 §5 要求的自动与手动用例 |
| 纯文档（ADR、指南、本方案） | L0 | — | — |

- “完成”指全部要求的层级已在当前提交上实际运行，并记录在 §6 的结果中。设备排队等待、只编译通过、只跑定向用例都不算完成。确实无法运行的层级必须写明原因和未覆盖的范围，不能写成通过。
- 定向用例用于开发中快速迭代；交付前仍要跑全量。修复回归失败后，重跑受影响的类，再跑一次全量，或至少把失败类所在的整组跑完。

## 2. 环境

### 2.1 设备（共享池）

设备身份以 `~/.orbis/simulator-pool/pool.json` 为准，使用前按本机指南取得 `registry.lock` 和设备锁。本文不记录 UDID 或 serial。

| 用途 | 池内设备（名称） | 说明 |
| --- | --- | --- |
| iOS 主力 / 窄屏 | `Orbis Adjacent Actions`（iPhone SE 3rd gen，375pt，iOS 27.0） | 默认跑全量 UI 套件和窄屏 / XXXL 检查 |
| iOS 标准宽度 | `Orbis Layout Regression`（iPhone 17，iOS 27.0） | 手动冒烟与截图抽查；登记时为 Booted，借用前先核实归属 |
| iOS 宽屏抽查 | iPad Air 11-inch (M4)，iOS 27.0 | 改动影响宽屏布局时抽查 |
| Android 主力 | `Orbis_UI_Polish_35`（API 35） | 全量 instrumentation；可无窗口启动 |
| Android 补充 | `Medium_Phone_API_37.0` | 预览镜像不支持本仓库的 Espresso 输入注入，只用于手动和截图，结果不能替代 API 35 自动回归 |

- 池中没有所需系统时，报告配置缺口，不扩容。iOS 17 兼容分支目前没有可运行设备，只能记为“未运行”。
- Android 无窗口启动：`emulator -avd Orbis_UI_Polish_35 -port <port> -no-window -gpu swiftshader_indirect -no-snapshot-save -no-audio`。本机 adb 服务可能反复重启：安装后用 `adb -s <serial> shell dumpsys package com.orbising.orbis | grep lastUpdateTime` 核对确实装上了新包。枚举 USB 真机时 adb 服务曾崩溃，这时可以用仅本任务使用的私有 adb 端口，不接触真机。

### 2.2 构建目录

iOS `ios/Orbis/build/DerivedData`、Swift 包 `ios/Orbis/.build`、Android `android/app/build`。构建前按本机指南在 `~/.orbis/build-leases/` 取得对应租约。

### 2.3 外观与可访问性矩阵

| 代号 | iOS | Android | 何时必须 |
| --- | --- | --- | --- |
| A1 浅色标准 | 默认 | 默认 | 每项手动检查 |
| A2 深色 | `--preview-dark`，或 `xcrun simctl ui <udid> appearance dark` | `adb -s <serial> shell cmd uimode night yes` | 每项手动检查 |
| A3 大字体 / 窄屏 | 375pt 设备 + `-UIPreferredContentSizeCategoryName UICTContentSizeCategoryAccessibilityXXXL`（多数正文是固定 token，XXXL 不等于支持 Dynamic Type） | `adb shell settings put system font_scale 1.5`，测试内可用 360dp 宽度 | 改动涉及布局、文字、触控区 |
| A4 减少动画 | `--preview-reduce-motion`，或系统设置 › 辅助功能 › 减少动态效果 | `adb shell settings put global animator_duration_scale 0`（同时设 `transition_animation_scale` / `window_animation_scale`） | 改动涉及动效或手势 |
| A5 宽屏 | iPad 抽查 | — | 改动影响宽屏 |

手动改过的系统设置必须在 `trap` / `finally` 中恢复（例如 `font_scale 1.0`、`animator_duration_scale 1`、`uimode night no`），不能留给下一个借用者。

### 2.4 夹具

- iOS：Debug 包通过启动参数打开预览：`--preview-screen=<home|drawer|new-session|chat|slash|approval|tool|queue|notices|interactions|truncated|viewport|changes|history|status|providers|downloads>`，以及 `--preview-dark`、`--preview-reduce-motion`、`--preview-hosts=2`（第二台电脑）。zsh 中每个启动参数要分开传：拼成一个字符串会被静默忽略，退回首页。UI 测试统一通过 `OrbisUITests.launch(_:dark:arguments:)` 启动。
- Android：设备测试使用 `HomeFixture.kt` 等 Compose 测试夹具，没有可直接启动的预览入口。需要整页截图时，用临时 Compose 测试渲染 `RemoteApp`；交付前删除临时测试，恢复可见性修改。
- 真实 Host：只用隔离 Host（独立进程、状态目录和本机 Relay），原则见 [isolated-host](isolated-host/README.md)，其中脚本面向 Windows。不得连接、重启或配对用户正在使用的 Host、生产 Relay 和真实会话。

## 3. 自动回归

### 3.1 层级与命令

以下命令在仓库根目录执行，`$RUN` 指 `.artifacts/ui-regression/<YYYYMMDD-HHMM>-<任务>/`。

| 层级 | 内容 | 命令 |
| --- | --- | --- |
| L0 文档一致性 | ADR-0051 ID 唯一与计数、相对链接、两个本机入口一致 | `diff AGENTS.md CLAUDE.md`；ID：`grep -oE '^\| [SMVX][0-9]{2} ' docs/adr/0051-*.md \| sort \| uniq -d` 输出为空，且各类计数与 §2 表一致；链接逐个核对目标文件存在 |
| L1 单元 | iOS 核心与 Swift 测试；Android JVM 单元测试 | `bash scripts/check-ios.sh`（含 swift test、源码 / plist / scheme 检查，完整 Xcode 下另做 Simulator Debug 构建与包检查）；`cd android && ./gradlew testDebugUnitTest` |
| L2 构建 | iOS Simulator Debug；Android Debug 与 AndroidTest 包 | iOS 已含在 L1 脚本；`cd android && ./gradlew assembleDebug assembleDebugAndroidTest` |
| L3 设备 UI 全量 | iOS `OrbisUITests` 全部用例；Android 全部 instrumentation（隔离 Host 配对用例除外） | 见下方 |
| L4 截图 / 帧审阅 | 逐张核对 L3 附件截图；动效改动核对录屏帧 | 见 §4.1 |

iOS L3（显式 UDID，关闭并行克隆）：

```sh
xcodebuild test -project ios/Orbis/Orbis.xcodeproj -scheme Orbis \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath ios/Orbis/build/DerivedData \
  -parallel-testing-enabled NO -collect-test-diagnostics never \
  -resultBundlePath "$RUN/ios-ui.xcresult" CODE_SIGN_IDENTITY=-
```

Android L3（显式 serial，不向所有设备安装，不用 Gradle Managed Devices）：

```sh
adb -s "$SERIAL" install -r -t android/app/build/outputs/apk/debug/app-debug.apk
adb -s "$SERIAL" install -r -t android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s "$SERIAL" shell am instrument -w -r \
  -e notClass com.orbising.orbis.IsolatedHostPairingInstrumentedTest \
  com.orbising.orbis.test/androidx.test.runner.AndroidJUnitRunner | tee "$RUN/android-ui.log"
```

定向运行时加 `-e class com.orbising.orbis.<类名>[#方法]`（iOS 用 `-only-testing:OrbisUITests/OrbisUITests/<方法>`）。测试截图位于测试 App 的外部 files 目录，用 `adb -s "$SERIAL" pull` 取回到 `$RUN/android-screenshots/`。改动配对流程时，另按隔离 Host 说明运行 `IsolatedHostPairingInstrumentedTest`。本机若已有一键回归脚本（在本机开发指南中登记，依赖本机环境，不入库），可以替代上述命令，但层级、设备锁、结果和证据要求不变。

### 3.2 既有失败的基线处理

- 全量通过的标准：本次失败集合是基线失败集合的子集，且受影响 ID 的用例全部通过。基线是本次改动的父提交（或合并基点）上，同一设备、同一配置的同一套件结果。没有当日记录时，先在基线上跑一遍。
- 不能沿用旧结论。例如 2026-10-29 在 `2d57907` 上记录过 `SessionHostOwnership`、`CodexPermissions` 自由文本、`Dsh` 新建说明、`Questionnaire` 四项设备失败，必须在当前基线上复核后才能列为既有失败。
- 只在冷启动时出现一次的性能预算超时（如 `ChatEntryInstrumentedTest` 首次入场），可以重跑一次。重跑通过时，两次结果都要保留并注明；重跑仍失败即为失败。

### 3.3 全量用例与 feature 映射

修改某个 ID 时，至少先跑映射到它的用例做定向验证；交付前跑全量。新增用例时同步更新本表。

**iOS `OrbisUITests`（合并后 71 项，含 r31 新增 4 项及主线原生文件审阅 / 按需启动新增 2 项；历史运行计数按证据保留）**

| 区域 | 用例 | 主要 ID |
| --- | --- | --- |
| 首页加载 / 同步 | `testHomePublishesCompleteSnapshotsWithoutReturningToLoading`、`testHomeRetriesFailedBackgroundRuntime`、`testHomeBackgroundSyncFailureStaysInConnectionPill`、`testHomeInlineStatusInDarkAndLargeText`、`testHomeKeepsCardsAfterDirectoryReplay` | S18、V16、V18 |
| 首页手势 / 多选 / 关闭 | `testHomeVerticalDragsScrollFromCardsAndKeepSelection`、`testHomeLongListScrollsToEndInBothAppearances`、`testHomeLongPressSelectsAndClosesOnlyCheckedSessions`、`testHomeShortSwipeReboundsAndLongSwipeClosesOnlyThatRuntime`、`testSwipeCloseHidesBeforeConfirmationAndRestoresOnRejection`、`testSwipeRightFromLeftSideOpensDirectory` | S15、M06、M09–M12、V11 |
| 首页与目录入口 | `testHomeDirectorySearchAndNewSession`、`testNewSessionOffersLaunchableDeepSeekBeforeBackendIsReady`、`testCompactionStatusInHomeChatAndDrawer` | S19–S20、V05 |
| 目录抽屉 | `testDrawerCardsKeepUniformGeometryForShortAndLongTitles`、`testDrawerLongPressArchivesAndRestoresOnlyCheckedSessions`、`testDrawerSelectionClearsOnCancelSearchAndClose`、`testDrawerFollowsEdgeDragAndShowsOneDirectory`、`testDrawerCollapseShrinksContentWithoutAnotherDrag` | S15、S19、M06、M09、V17 |
| 聊天入场 / 返回 | `testCachedOnlineChatEntryTiming`、`testChatSwipeBackReboundsThenReturnsHome`、`testDraftSurvivesBackNavigationAndSlashRequiresSelection` | M07–M08、V13、V17 |
| 聊天视口 | `testLongTranscriptAppearsAndToolExpansionKeepsItsPositionWithoutDragging`、`testLongFinalReplyKeepsReadingPositionAndOnlyFollowsAfterJump`、`testNewMessagesAndToolsPreserveTheMovingReadingAnchor` | V01–V03、M03 |
| Claude 模型回复身份 | `testClaudeNativeHandoffKeepsOneCopyAcrossConsecutiveTurns`（明暗，三阶段 canonical / live 交接；每段正文唯一） | V09、V17–V18 |
| 聊天内容 / 顶栏 | `testRefreshKeepsHeaderTextAndTruncationStable`、`testClosedDisclosureDefersWorkAcrossChatReentryAndRetainsState`、`testUserMessageCopyAndRewind`、`testToolDetailsLoadPagesAndClose`、`testTruncatedContentAndToolArguments`、`testHistoryPreviewAndNavigation` | S10–S11、S17、S20、M03、M05、V05、V14 |
| 输入 / 审批 / 队列 | `testSlashPickerStaysAboveKeyboard`、`testOptimisticSendReconcilesAndRejectedSendRestores`、`testUnconfirmedSendCanBeCheckedWithoutResending`、`testCompactionQueuedSendCanBeWithdrawn`、`testApprovalOverlayKeepsComposerStableWhileSubmitting`、`testQueueCancellationNotificationsAndRuntimeFacts`、`testToolExportAndInteractionDraftSwitching` | V06–V08、V10、V12、V17 |
| 连接状态 / 供应商（r15 后为设置页） | `testCompactQuotaCardsAndTransparentSwitch`、`testFixedRoutingAndStatusProviderSwitch`、`testBasicConnectionStatusAndDirectoryProviderMismatch` | S18–S19、S22–S23 |
| 下载 | `testDownloadCardsPauseResumeAndSelectWithoutSideButtons` | S15、S20 |
| 轮次文件审阅 | `testTurnFileReviewLoadsOnlySelectedFilesAndRetainsCache`、`testTurnFileReviewDarkAppearance`、`testTurnFileReviewOnlyHeaderPullCloses`、`testNativeTurnFileReviewShowsSourceAndReadsOnlySelectedDetail` | S21、M13、V19 |
| 全页面明暗 | `testPageScreenshotsInBothAppearances` | S01–S09、S16 |
| r15 设置与入口 | `testSettingsPageOrderAndSingleHostMenu` | S18、S22 |
| r24 整页导航 | `testSettingsAndDownloadsSwipeBack`、`testChatDownloadsReturnToSameChat`、`testHistoryDownloadsReturnToHistory`、`testHistorySwipeBackReturnsToChat`、`testAddComputerPageReboundsAndSwipesBack`、`testNestedPagesSwipeBackOneLevelAtATime` | M07–M08、M14、V17–V18 |
| r15 流式、首页 / 目录视口与飞入 | `testStreamingRevealAdvancesInOrderAcrossBlocks`、`testStreamingRevealWithReducedMotionShowsEveryBlockImmediately`、`testHomeTopShowsNewAndPromotedSessions`、`testHomeScrolledAnchorSurvivesInsertionAndReordering`、`testDrawerScrolledSessionsKeepTheirPositionDuringCatalogUpdates`、`testDrawerTopKeepsNewAndPromotedDirectoriesVisible`、`testDownloadFlightStartsAtTapAndEndsAtButton`、`testDownloadFlightWithReducedMotionHighlightsWithoutFlying`、`testHistoryDownloadButtonAndFlight` | M04、V21、M16 |

Codex 桌面新会话同步回归（S18、V16–V18）：Host `host-service.test.ts` 的 `new %s sessions complete homepage model reads and retries without reconnecting` 分别验证终端 / 桌面后端，在同一加密连接内创建后立即读取 identity、execution、interactions，并带 agentKind 重试，均须 ready 且交互库存为已确认的空集合。不能先重连或手工调用 announce 才断言通过。Android `HomePresentationTest.newDesktopCodexSessionCompletesSplitHomeReadsAndRetryWithoutRestarting` 与 iOS `HomeRuntimeLoadingTests.newDesktopCodexSessionCompletesSplitHomeReadsAndRetryWithoutRestarting` 覆盖分批接收、保留旧卡片、完成与重试退出同步态；设备映射仍为 `HomeLoadingInstrumentedTest` 与 iOS 首页加载 / 同步五项用例。专项手动 R25；Host 模拟通过不替代真实桌面 App / 设备门禁。

**Android instrumentation（`androidTest`）**

| 区域 | 测试类（用例数） | 主要 ID |
| --- | --- | --- |
| 首页 | `HomeLoadingInstrumentedTest`（2）、`HomeNavigationInstrumentedTest`（3）、`HomeSelectionInstrumentedTest`（1）、`HomeSwipeCloseInstrumentedTest`（1）、`OptimisticActionsInstrumentedTest`（3） | S18、M06、M10–M12、V10–V11、V13、V18 |
| 转场 | `SwipeBackInstrumentedTest`（4）、`ChatEntryInstrumentedTest`（1） | M07–M08、V13 |
| 聊天视口 / 内容 | `ChatViewportInstrumentedTest`（9）、`DeferredDisclosureInstrumentedTest`（2）、`MarkdownInstrumentedTest`（1）、`ToolPanelInstrumentedTest`（3）、`ToolContentInstrumentedTest`（2）、`DisplayScenariosInstrumentedTest`（1）、`ClaudeHistoryInstrumentedTest`（1）、`LiveHistoryReloadInstrumentedTest`（1） | S11、S20、M03、V01–V04、V09、V14 |
| 顶栏 / 输入 / 交互 | `ChatStatusLayoutInstrumentedTest`（2）、`ComposerSessionInfoInstrumentedTest`（3）、`InteractionWorkspaceInstrumentedTest`（5）、`QuestionnaireInstrumentedTest`（2）、`CodexPermissionsInstrumentedTest`（3）、`NotificationsInstrumentedTest`（2）、`DshInstrumentedTest`（2） | S12、S17、V05–V08、V12、V17 |
| 目录 | `SessionDrawerLayoutInstrumentedTest`（2）、`SessionArchiveSelectionInstrumentedTest`（3）、`SessionProviderFilterInstrumentedTest`（3）、`SessionHostOwnershipInstrumentedTest`（3） | S15、S19、M06、M09、V17 |
| 新建会话 Agent 选择 | `DshInstrumentedTest#selectsLaunchableDeepSeekBeforeBackendReadyAndCreatesSessionInChosenDirectory` | S20、V12、V16–V18 |
| 状态 / 供应商 | `SubscriptionQuotaInstrumentedTest`（1）、`ProviderSelectionInstrumentedTest`（1） | S19、S22 |
| 下载 / 文件 | `DownloadFileBrowserInstrumentedTest`（3）、`TurnFileChangesInstrumentedTest`（6，含原生 Codex 来源提示及 Pi 预览清单点击、入场期间完整清单 / 首段 diff 到达和关闭重开）、`ChatViewportInstrumentedTest#turnChangeSummaryFollowsTheWholeTurnWhenAnchoredInsideIt` | S09、S15、S20–S21、M13、V19 |
| 材质 / 字形 / 控件 | `UiPolishInstrumentedTest`（3）、`NeumorphInstrumentedTest`（1） | S01–S09、S12、M04、V15 |
| 非 UI 但在同一设备套件 | `SessionGraphStoreInstrumentedTest`（32）、`SessionSyncSelectionInstrumentedTest`（6）、`SessionSyncSlowLinkInstrumentedTest`（2） | 缓存 / 同步正确性，全量时一并运行 |
| 需要隔离 Host | `IsolatedHostPairingInstrumentedTest`（1）；`ToolContinuityCaptureInstrumentedTest`（1，无参数时自动跳过，传入配对载荷与 cwd 时做真实输出逐帧捕获） | 配对；V20 定位 |
| Pi 连续工具交接 | `ToolContinuityInstrumentedTest`（2，跟随与上滑阅读；连续同 head 更新后父节点补齐） | V20、V09、V01–V04、V18 |
| r15 首页 / 目录视口与下拉刷新 | `HomeViewportInstrumentedTest`（6，其中 M15 两项）、`SessionDrawerViewportInstrumentedTest`（3） | M15、V21 |
| r15 设置与入口 | `SettingsEntryInstrumentedTest`（3） | S18、S22–S23 |
| r24 整页导航 | `SwipeBackPagesInstrumentedTest`（2，位于 `SwipeBackInstrumentedTest.kt`）、`HistorySwipeBackInstrumentedTest`（1，真实历史 / 聊天 / 下载层级）、`PageNavigationInstrumentedTest`（3，添加电脑 / 离线历史 / 嵌套系统返回） | M07–M08、M14、V17–V18 |
| r15 下载飞入 | `DownloadFlightInstrumentedTest`（1） | M16 |
| r15 流式顺序 | `StreamingRevealInstrumentedTest`（1）；`UiPolishInstrumentedTest#revealKeepsEmojiAndCombiningCharactersTogether` 改用新时钟 | M04 |

与 UI 相关的单元测试（L1 中必须通过）：iOS `RevealClockTests`、`HomeRuntimeLoadingTests`、`StoreTests`、`AgentStateTests`、`PendingSendTests`、`PresentationTests`、`TurnFileChangesTests`；Android `HomePresentationTest`、`ChatListItemReuseTest`、`HistoryPagingTest`、`MessagePresentationTest`、`StatusScreenTest`、`SubscriptionQuotaTest`、`UiPolishTest`、`PendingSendsTest`、`TurnFileChangesTest`、`RevealScheduleTest`、`HomeViewportAnchorTest`。

Claude 运行中发送的适配器回归（V10、V12、V17）：`claude plugin test packages/claude-mod` 的 `reconnect.test.ts` 覆盖主回合期间不调用 `prompt.submit`、同批消息串行提交、停止与工具事件、子 Agent 完成、Host 轮末捕获屏障及重连代次隔离；设备端仍关联两端乐观发送用例。真实联动验收按 R17 执行，插件模拟通过不能替代设备 / 真实 TUI 验收。

App 按需启动 DeepSeek / Codex Desktop（S20、V12、V16–V18；ADR-0056 §2.1）：Host `host-service.test.ts` 覆盖 DSH 与 Codex Desktop 在未预启动时，先按 `launchableAgents` 公告可选，再由会话请求挂载后端并成功激活；已接入两类 runtime 时直接调用会话 API，断言不调用启动回调。iOS / Android 用例验证仅出现在 `launchableAgents` 的 DeepSeek 仍可选。R32 需另做两端真 Host / 真 Agent 手动确认；Host 自动测试通过不代表设备或真实后端门禁通过。

Claude 输出交接回归（V09、V17–V18）：Host `claude-transcript.test.ts` / `claude-mods-bridge.test.ts` 覆盖一对多 UUID 原子提交、逐 patch 无重复、跨轮清理、迟到事件与落盘超时；官方插件 `reconnect.test.ts` 覆盖主 / 子步骤归属和封口顺序。iOS `StoreTests.claudeStepHandoffPreservesIdenticalTextFromTheNextTurn` 保留合法同文的下一轮；Android `ClaudeHistoryInstrumentedTest` 使用 `scripts/claude-history-fixture.mjs` 的 bridge 3 数据，断言运行中交接、轮末和重连后各段正文只有一份。专项手动 R18。

所有状态输入契约（[ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md)，V05、V09–V10、V12、V16–V18）：AIN-01–AIN-07 覆盖协议全集、状态准入、命令回执、各适配器与双端 outbox、专用服务。`runtime-command-lifecycle.test.ts`、`runtime-input-policy.test.ts` 及 Codex / Pi bridge / Claude / DSH 和两端 PendingSend 测试已补充；iOS 新增 `testUnconfirmedSendCanBeCheckedWithoutResending`、`testCompactionQueuedSendCanBeWithdrawn`，Store 单测覆盖 Slash 草稿在拒绝 / 未确认后保留、成功后清理；Android `OptimisticActionsInstrumentedTest`（3 项）验证排队撤回、未确认核对及不提供自动重发。实现与门禁结果分开记录，未完成全量前不记为通过。
带 `assumeTrue(ValueAnimator.areAnimatorsEnabled())` 的设备用例（下载飞入、流式顺序）在系统关闭动画时跳过，A4 路径以手动检查为准。


原生 Codex 文件审阅（ADR-0052 §9.1，S21 / V19；M13 保持）：Host 新增 `codex-turn-file-changes.test.ts`、`codex-native-file-review.test.ts`，覆盖整轮 revision 替换、拒绝 / 未完成 / 失败部分落盘、空 diff 失效、旧轮 / 迟到事件、外部同时写入不混入、重启 / 过期与零正文概况。双端模型扩展 `TurnFileChangesTests` / `TurnFileChangesTest`；设备用例为 iOS `testNativeTurnFileReviewShowsSourceAndReadsOnlySelectedDetail`、Android `nativeSummaryShowsToolScopeWithoutReadingDetail`。同时保留并执行既有轮末位置、落位读取、预览扩容、关闭手势及缓存用例；两端 L1–L4、C01–C18、A1–A4 与 R28 均须记录实际结果，定向通过不替代全量门禁。

S24 最近提问提示（ADR-0057）：iOS `ChatQuestionTests`、`testQuestionReminderAppearsWhileReadingAndLocatesTheOriginalWithoutFollowing`、`testQuestionReminderTracksNewSourceQuestionsWithoutMovingTheReader`；Android `ChatQuestionTest`、`ChatQuestionReminderInstrumentedTest`（4）。覆盖源消息身份、可见性、点击定位、阅读锚点、通知优先和 Host 隔离，配合既有视口用例及手动 R31，A1–A5；未验收不得计为交付。


### 3.4 r31 共用交互动效映射

本节补充 §3.3，既有用例不删、不跳、不放宽。来源 [ADR-0058](../adr/0058-shared-interaction-motion.md)、[MOT ticket](../agents/interaction-motion-tickets.md)。实际落地用例及证据列于 [交互动效验证记录](interaction-motion.md)；存在不代表通过，缺项明确保留。

| Ticket / 场景 | 自动验证要求 | 手动 / feature |
| --- | --- | --- |
| MOT-01 | 两端 InteractionMotion 纯几何：触点最远角、路径分段、边界裁切、返回进度；生命周期清理 | 所有R33–R40、V18 |
| MOT-02 / SC01–02 | 扩展 HomeSwipeCloseInstrumentedTest 与 iOS 首页关闭：中帧保留、完全滑出、拒绝恢复、一次提交；Android `thresholdCrossingsVibrateInBothDirectionsAndRepeatedlyBeforeClosingItsRuntime` 覆盖反复双向越阈值逐次触觉及同侧不重复 | C09、R33 / M10、V11、V21 |
| MOT-03 / SC02–05 | 扩展首页 / 目录归档 / 下载 / 供应商选择；`InteractionMotionInstrumentedTest.selectionStartsAtTheTouchAndReversesWithoutMovingTheCard`；iOS现有多选用例及中帧审阅 | C10–C13、R34 / S15、M06 |
| MOT-04 / SC06–10 | Android `InteractionMotionInstrumentedTest.menuChangesItsContainerBeforeSlidingToTheChildAndBack`、iOS `testComputerSubmenuReturnsWithinOneAnchoredPanel`：锚点、安全区、自然尺寸、两阶段、返回优先、菜单失效 | C11–C12、C18、R35 / M18 |
| MOT-05 / SC11–13 | 更新原复制/Rewind入口并保留业务断言；新增长按、滚动/文本选择共存、栏失效 | C05、C15、R36 / S10、M19 |
| MOT-06 / SC14–16 | 扩展 PendingSend 和乐观发送设备用例；`InteractionMotionTest` / `MotionGeometryTests`；Android `sendFlightUsesTheAcceptedIdentityAndNeverLandsQueuedOrReadingMessages`；iOS `testSendFlightMovesRightThenUpAndHandsOffTheSameMessage` / `testSendFlightWithReducedMotionKeepsTheMessageAndNoOverlay` | C05–C06、R37 / M17、V09–V10 |
| MOT-07 / SC17–18 | 原 ChatQuestionReminder 及 iOS 两专项保留；新增中帧和退出内容 / 通知优先 | C05、R31、R38 / S24 |
| MOT-08 / SC18–27 | 新增 ActionGlyph 有效点击 / 禁用 / 连点 / 图形反馈，保留下载飞行、复制、配额专项 | C06–C08、C12–C15、R39 / M20 |
| MOT-09 / SC28–32 | 扩展 SwipeBack、PageNavigation、iOS嵌套返回；系统左右边缘取消和完成、菜单/IME/选择优先 | C04、R19–R22、R40 / M08、M14 |
| MOT-10 | 32组场景调用方逐项审计；最终双端全量L1–L4与同设备基线比较 | C01–C18、A1–A4，宽屏A5 |

## 4. 手动回归

### 4.1 执行方式与证据

- 手动回归必须在池内模拟器上实际操作：人工操作，或由 Agent 通过 `xcrun simctl` / `adb shell input`、UI 测试辅助和截图完成。逐项对照预期结果，并留下截图、录屏或帧序列。Agent 必须亲自查看截图和帧，不能只凭自动用例通过就勾选手动项。
- 录屏：iOS `xcrun simctl io <udid> recordVideo --codec h264 "$RUN/<名>.mp4"`；Android `adb -s <serial> shell screenrecord --bit-rate 8000000 /sdcard/<名>.mp4` 后 pull。检查动效和闪屏时按 60fps 抽帧（如 `ffmpeg -i in.mp4 -vf fps=60 frames/%04d.png`）。至少核对起始、约 1/3、约 2/3、结束、取消 / 反向各一帧；闪屏问题逐帧比对。
- 每项记录：编号、平台、设备、外观代号、结果（通过 / 失败 / 未运行，并写原因）、证据路径。失败附复现步骤。

### 4.2 核心冒烟清单（每次必做，受影响平台全做）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| C01 | 冷启动到首页 | 首帧不白屏；首版快照前，加载态占列表空态位置，没有半成品卡片；快照到后一次发布全部卡片 | S18、V18 |
| C02 | 首页长列表滚到底再回顶；从卡片上起手竖拖 | 滚动顺畅；卡片等宽，标题两行等高；竖拖不误触左滑关闭或抽屉 | S19、M09–M11 |
| C03 | 首页下拉刷新 | 只在顶部触发；拖动时整张会话列表与手指同步下移，指示器跟随显示；松手触发一次刷新后列表和指示器回到原位，首卡与滚动锚点无跳动；进度 / 失败仍显示在胶囊或列表空态 | M15、S18、V21 |
| C04 | 点卡片进入聊天，再右滑返回：先拖 1/4 后松手（取消），再拖过 1/3 | 从右侧滑入，首页底层压缩并加遮罩；取消时回弹；返回时跟手，回到首页后立即可点 | M07–M08、V13 |
| C05 | 聊天中上滑阅读，等待新消息 / 流式到达，再点“回到最新” | 阅读位置不被抢；超过三行显示“回到最新”；点击后恢复跟随；流式文字按顺序逐字出现（r15 后） | V01–V04、M04 |
| C06 | 聚焦输入框，输入多行，打开 Slash 菜单 | 输入框为凹槽并显示柔和双环；键盘上移输入区，顶栏不动；Slash 菜单在键盘上方 | S12、S17、V08 |
| C07 | 展开 / 收起 thinking 与工具卡；打开工具详情 | 约 260ms 自然高度折叠；展开状态保留；详情可分页、可关闭 | M03、S20、V14 |
| C08 | 触发审批 / 问卷，提交与取消 | 单项确认浮在输入区上方，提交时 composer 不位移；多步骤间草稿保留 | V07、M12 |
| C09 | 首页卡片左滑：短滑后松手，再滑过半宽 | 短滑回弹；越过半宽时提示“松手关闭”并触觉一次；退回“关闭”同样触觉一次，同手势反复跨阈值持续反馈，同侧移动和松手 / 回弹不追加；松手后退场；多选模式下不触发 | M10、M12、V11 |
| C10 | 长按卡片进入多选，再点选和退出 | 进入多选时触觉一次；选中按r31从本次触点260ms扩散，取消160ms；卡片几何不变 | S15、M06、M12 |
| C11 | 从左缘拖开目录，折叠 / 展开目录，搜索，归档 / 恢复 | 抽屉跟手吸附；折叠后高度立即收缩；一次只展开一个目录 | M09、S19、V17 |
| C12 | 打开设置页（r15 前由“更多操作 › 连接状态”进入，r15 后点右上角齿轮）；检查当前连接事实行；点配额币；打开供应商切换 | 分区顺序正确；连接延迟以整数毫秒显示，无样本时为“暂不可用”；供应商卡片区（r15 后位于最上方）：44pt/dp 环、角标、左倾 24° 翻面；切换菜单透明无底色 | S19、S22–S23、M14 |
| C13 | 打开首页下载页；整卡暂停 / 继续，长按多选 | 没有旁置按钮；长按多选；r15 后可从右侧滑入、右滑返回首页 | S20、S15、M14 |
| C14 | 在 Codex 长回合（多次工具调用，消息超过 4 条）结束后查看轮次文件概况；Pi 一轮改动超过 4 个文件时，先直接点击预览中的 `.kt` / `.md` 文件，再展开完整清单后打开作对照；查看器入场期间注入完整清单与首段 diff；关闭重开并左右切换文件；正文滚到中段后快速向下甩回顶部并继续下拉 / 快甩；再从标题区短拉、长拉 | 概况卡在整轮最后一行之后，不在回合中段；概况是单个内凹块，标题行可点开查看器，每个文件一行、状态字母颜色正确，长文件名不被目录挤压，未知行数显示短状态而非“+— −—”；预览升级为完整清单时不崩溃、不改选中文件，直接打开与先展开清单具有相同查看语义；跟手、落位、首尾回弹；只请求已落位文件的详情；正文到顶只在差异区内回弹，卡片不移动不关闭；标题区短拉回弹、长拉或快甩关闭，滑出过程中仍显示当前文件、不变成空白或加载态 | S21、M13、V19 |
| C15 | 复制消息 / 代码 | 原位对勾，2.5 秒后恢复；重复复制重置计时 | M05、V16 |
| C16 | 切换明暗后重看 C01、C04、C12 | 明暗四层底板；单层材质外框；柔影方向正确，没有纯黑硬边 | S01–S04 |
| C17 | 断开再恢复电脑连接（隔离夹具或预览注入） | 胶囊依次表达连接中 / 同步中 / 同步失败；失败时胶囊旁出现 48 命中的重试；卡片不移位 | S18、V16、V18 |
| C18 | 两台电脑间切换（iOS `--preview-hosts=2`，Android 夹具） | 首页与目录只显示当前电脑；其他电脑待确认时显示红点；旧卡片不能操作新会话 | S18、V17 |

### 4.3 外观矩阵要求

- 核心冒烟在受影响平台上至少覆盖 A1 与 A2。
- 涉及布局、文字或触控区的改动，受影响页面加跑 A3。iOS 用 375pt 设备，Android 用 1.5 字体缩放，检查截断、换行、遮挡和 48 命中区。
- 涉及动效或手势的改动，受影响项加跑 A4：动画跳过或直接切换后，状态、选择、网络语义和阅读位置与正常路径一致。

### 4.4 动效专项（改动或新增动效时）

对每个受影响的动效检查：起始帧、中间帧、结束帧；取消 / 反向（手指拖回、松手回弹）；动画中再次触发或被手势打断；减少动画（A4）；动画期间数据刷新、列表更新或键盘弹出；离开页面、切换会话或电脑后没有残留浮层和计时。参数（时长、弹簧、阈值、位移）以录屏帧或测试断言核对 ADR-0051 的数值。触觉只能在真机确认体感，模拟器只核对调用时机。

### 4.5 稳定性专项（改动影响列表、滚动或状态时）

刷新与重连期间保留上一版快照；长文本、长标题与超长路径；分页边沿只取一页；拖动中和惯性中有数据更新；键盘出现 / 收起；失败恢复与重试；乐观发送对账、消息身份与重复气泡；会话 / 电脑切换后状态隔离。闪屏或跳动问题必须用逐帧证据定位，不能只看静态截图。

### 4.6 r15 专项手动清单（对应 ticket 实施后执行）

| 编号 | 步骤 | 预期 | ID / ticket |
| --- | --- | --- | --- |
| R01 | 在隔离 Host 或回放夹具中，让助手流式输出多段长文本（含列表和代码块）；录屏 60fps | 文字从前到后逐字出现；任一帧只有游标前一小段连续字在渐显，不会出现前后两处同时渐显或整段突然出现；大批到达时呈快速连续推进，积压不超过 450ms | M04 / UI-01 |
| R02 | 流式中途进入该会话；流式中出现新段落；正文被改写；减少动画 | 进入时已有文字直接显示；新段落从游标处继续；改写时立即落定，不重放；减少动画时直接显示 | M04 / UI-01 |
| R03 | 跟随模式下，用真实输出触发长时间运行的工具（Pi bash、Codex 命令、Claude 工具），从开始录屏到结果到达；Pi 至少连续调用六次，回放结果先到 / 调用条目后到，并在缺口期间插入多个同 head 更新、下一条工具结果和恢复快照 | 工具卡从出现到完成始终是同一张紧凑卡，原地更新状态；已有正文与实时工具行均不能提前移除；列表不能缩成单条结果并露出更早消息入口，已加载的分页边界不回退；父节点补齐后只保留一份 canonical 内容；全程无跳动、空白帧或整屏闪烁 | V20、V09、V01–V04、V18 / UI-02 |
| R04 | 非跟随状态（上滑阅读中）重复 R03 | 阅读锚点不动；不弹回底部 | V20、V02–V03 / UI-02 |
| R05 | Android 首页停在顶部时，新建会话 / 让下方会话因活动排到第一 | 视口留在顶部，新的首卡可见，不被挤到视口上方 | V21 / UI-03 |
| R06 | 首页向下滚动半屏后：其他会话排序变化；当前视口首卡自身被排到顶部；新增和关闭会话；拖动 / 惯性中发生变化 | 视口首张完整卡片的屏幕位置不变；该卡被移走时保持原像素偏移，不跟着跳；手势中不重新定位 | V21 / UI-03 |
| R07 | 目录抽屉列表重复 R05–R06（两端） | 同上 | V21 / UI-03 |
| R08 | 首页右上角：只有“下载”和齿轮“设置”两个图标；点齿轮 | 进入设置页：分区依次为供应商、当前连接、配对信息；没有“已配对电脑”切换区，也没有添加 / 取消配对入口 | S22 / UI-04 |
| R09 | 点连接胶囊；在同步失败状态下点胶囊旁的重试；遍历首页电脑切换菜单、设置页、聊天页、目录筛选菜单、provider 不匹配对话框和错误提示文案 | 胶囊无跳转，仍显示连接 / 同步状态，读屏读出状态而不是按钮；重试仍然生效；目录筛选菜单和不匹配对话框的入口文字为“设置”，并进入设置页；除侧边栏底部电脑菜单外，没有添加电脑或取消配对入口；文案不再指向已删除的入口 | S18、S22 / UI-04 |
| R10 | 打开侧边栏，点击底部电脑行 | 菜单中有切换电脑、添加电脑、取消配对当前电脑；取消配对仍需二次确认 | S22 / UI-04 |
| R11 | 设置页与首页下载页：打开（滑入），拖 1/4 后松手，再拖过 1/3；入场动画中途右滑；减少动画 | 与聊天的 M07 / M08 一致：跟手、回弹、返回首页后立即可点；Android 入场可被接管；减少动画时直接切换 | M14 / UI-04 |
| R12 | 聊天中上滑阅读并输入草稿，点顶栏下载；先拖 1/4 后松手，再分别用右滑、返回按钮、系统返回退出 | 下载页从右侧滑入；右滑时底层露出的是这个聊天，不是首页；返回后阅读位置、草稿、展开状态不变；首页下载入口仍返回首页 | M14 / UI-04 |
| R13 | 核查设置内供应商菜单与遗留二级页入口；若未来恢复为整页再右滑 | 当前供应商切换为菜单、不恢复遗留入口；未来整页通过共用容器返回设置页 | M14 / UI-04 |
| R14 | Android 首页下拉刷新：顶部下拉并保持拖动、松手；非顶部尝试、多选中、左滑关闭、右滑打开抽屉、断开连接时 | 顶部拖动时整张列表跟手下移，松手后列表与指示器回到原位且首卡 / 视口稳定；仅顶部触发刷新；多选 / 左滑关闭 / 右滑抽屉手势不误触刷新；断开时触发重连 | M15 / UI-05 |
| R15 | 聊天中点击文件产物卡、Markdown 文件链接；连续点 4 次；未连接时点击；减少动画 | 图标从点击处沿弧线飞到右上角下载按钮，按钮轻弹，角标增加；同时最多 3 个飞行；未连接时不飞并提示；减少动画只高亮按钮；阅读位置不变 | M16 / UI-06 |
| R16 | 打开“历史与分支”页：查看顶栏；点其中的文件下载；点顶栏下载按钮，再右滑返回 | 顶栏有与聊天同款的下载按钮，带角标；文件飞向这个按钮；下载页滑入，右滑露出并返回历史页，搜索词、筛选和滚动位置不变 | M14、M16 / UI-04、UI-06 |

历史返回专项（r24）：Android 548 项单元与 iOS 223 项 Swift 测试、两端构建及返回定向用例通过；Android 全量 135 项有 11 项失败（基线对照未完成），最终 iOS 全量与完整手动 / 外观门禁未完成。证据见 `.artifacts/ui-regression/20261031-history-swipe/summary.md`，不记为全量验收通过。

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R19 | 聊天中上滑阅读、输入草稿并展开工具后打开“历史与分支”；拖 1/4 松手，再拖过 1/3；重新打开历史，进下载后右滑或系统返回；明暗与减少动画重试 | 历史从右侧滑入；短拖回弹，拖动中露出原聊天，完成返回同一聊天且阅读位置、草稿、展开不变；可再次打开历史；历史内下载先返回历史，再右滑返回聊天；动画中断不残留遮罩 | M08、M14、V17 |
| R20 | 侧边栏底部电脑菜单→添加电脑：短拖、长拖、取消按钮、Android 系统返回；重复进入；首次未配对引导及配对进行中重试 | 添加电脑复用整页入场、回弹、底层和返回；iOS 返回收起目录后的首页，Android 恢复原目录且立即可操作；首次引导无返回手势；安全配对遮罩不能被手势绕过 | M07–M08、M14、V18 |
| R21 | 目录中离线会话→只读历史：短拖、越阈值、返回按钮、Android 系统返回；保留目录搜索和展开后重复进入 | 双端同款返回，Android 不再直接替换首页；来源实例、目录状态和阅读锚点不变，底层来源正确 | M08、M14、V17–V18 |
| R22 | 聊天→历史（输入搜索并滚动）→下载；分别用手势、按钮、系统返回逐层退出；每层短拖、动画中重入、竖向滚动与页内横滚；明暗 / 窄屏 / 大字体 / 减少动画 | 每次只退一层，下载→历史→聊天→首页，不被后台来源抢走；草稿、搜索词、筛选、位置与展开不变，无残留遮罩；Sheet / 对话框、抽屉、差异横向切文件保留本身规则 | M07–M10、M13–M14、V17–V18 |
| R23 | 设置页分别检查有 Host RTT 与无 RTT 样本状态；切换 LAN / Relay 公告，横屏或窄屏再检查 | 固定“连接延迟”行显示 Host 每两秒采样后公告的当前路径 RTT，整数毫秒；缺样本 / 未连接显示“暂不可用”；值变化不改变行顺序或其他状态，无空间跳动 | S23 / UI-07 |

### 4.7 Claude 运行中发送专项

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R17 | 隔离 Host / Claude TUI 中启动长回合，在 App 连发两条 follow-up；观察当前输出与工具；停止主回合；再分别测试正常结束、子 Agent 先结束和 Host 重连 | 当前回合继续同步，停止可达；子 Agent 结束不触发主回合 follow-up；主回合结束且 Host 轮末捕获完成后顺序提交，每条只执行一次；原生用户行消除待确认状态；旧代次消息不补发到新 Host。两端分别保留发送前、运行中、落地截图及事件顺序证据 | V10、V12、V17 |

| R18 | 隔离 Claude 主回合含工具和多段正文，步骤落盘时保持运行；立即开始下一轮，重复相同短回复；延迟磁盘写入超过 3 秒；再重连。两端明暗录屏，抽查窄屏 / 减少动画 | 每个步骤的正文与 thinking 只出现一份；同文的不同轮都保留；旧轮清理与迟到结束不删下一轮；已声明但未落盘的正文保留，后续原子交接；工具卡与阅读锚点连续。需保存步骤 UUID / patch 顺序，不能以文本去重通过 | V09、V17–V18（关联 V02–V03、V20） |

### 4.9 全状态用户输入专项（ADR-0055）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R24 | 两端各 Agent 在 idle、运行、审批等待、独立 / 自动压缩、停止和恢复 / 断线时，按 ADR-0055 矩阵提交文本+附件、followUp / steer、Slash、回答和撤回；覆盖受理、成功、明确失败与未确认；明暗 / 窄屏 / 大字体 / 减少动画 | 每项有责任拥有者和明确结果；不支持给出原因；未确认不自动重发；队列可核对，无重复或永久发送中，失败正文 / 附件可找回，状态更新不抢阅读位置。真实后端缺口单独登记 | V05、V09–V10、V12、V16–V18 |

### 4.10 Codex 桌面新会话同步专项

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R25 | 两端分别连接隔离 Host，保留至少一张既有卡片，在 APP 新建 Codex 桌面版会话；回首页后再新建一条；下拉刷新；模拟一次模型读取失败后点胶囊重试；另以终端 Codex 作对照。全程保持 APP 和 E2E 连接，不重启；A1 / A2，A3 / A4 抽查 | 准备时保留旧完整卡片，identity / execution / interactions 齐备后一次发布新卡片并退出“正在同步”；正常新建不常驻“同步失败”；失败后的重试也能恢复，不依赖重新握手；桌面公共 ID 不进入 adapter 原生 thread 查找，无半成品卡片与位置跳变 | S18、V16–V18 |

### 4.12 原生 Codex 文件审阅专项（ADR-0052 §9.1）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R28 | 隔离 Codex terminal / Desktop 各执行一轮：原生 patch 连续修改同一文件，同时在外部修改另一文件；再分别拒绝、部分失败、取消文件工具，并回放空 diff；两端明暗 / 窄屏 / 大字 / 减少动画查看卡片、展开清单、打开 / 滑动详情及重启重读 | 卡片只展示原生 tracker 已记录的净变化，提示“仅记录 Codex 文件工具变更”，详情范围为“Codex 文件工具”；提议不算成功，未知或空 diff 失效不伪报零变化；外部工作区变化不从快照混入；未选中文件无详情请求，历史固定、版本 / 缓存 / 手势规则保持；不宣称 shell 全覆盖或逐行独占归属 | S21、M13、V19 |

### 4.13 App 按需启动后端专项（ADR-0056 §2.1）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R32 | 分别在 Windows / macOS Host 未带 `--dsh`、未预启动 DeepSeek，及未带 `--codex` 的场景配对 iOS / Android。测试 DeepSeek 服务已运行但 Host 未接入、服务未运行、已有 DSH runtime；Codex Desktop 已打开且已接入、未打开、未包装的既有实例；再分别新建与恢复会话，并快速连续提交两次请求 | 新建页将可启动的 DeepSeek / Codex Desktop 显示为可选，`agents` 未就绪时仍不假报在线。已接入的 runtime 直接复用；未接入时 Host 仅启动一次 / 连接现有 DSH 服务，等待真实握手后才创建或恢复；两个请求共用后端准备且不重复创建同一请求。未安装、坏配置、接入失败或超时有明确错误，不能留下 pending / 假成功。Host 设置项清楚标明只控制预启动。记录两端明暗截图、请求 / 握手顺序、进程与服务 PID、会话 ID 及失败回执；用 A1–A4 核对错误全文、重试、草稿和返回 | S20、X03、V12、V16–V18 |

### 最近提问提示专项（ADR-0057 / S24）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R31 | 打开含长回复的会话，先保持跟随，再上翻；滚到原提问与更早轮次；点击提示，再回到最新。加入连续同文提问、长多行/emoji/附件问题、本地发送失败/未确认、源端新问题、通知、补页及分支/电脑切换；重复明暗、窄屏大字、减少动画及宽屏 | 初始不显示；主动阅读离底部三行且原问题不可见后显示两行预览；原问题可见和回到最新收起。点击只定位原消息、保留非跟随，不自动分页。源端更新不带走锚点，不把本地待确认消息当已发送问题；通知优先、隔离无残留。浮层出现前后正文/输入区几何不变；r31按220ms从右32/上12滑入、160ms逆向退出，无尺寸动画，减少动画直切；辅助功能保留全文，触控至少48pt/dp | S24（关联 S10、S13、S17、V01–V04、V06、V09、V17–V18） |


### r31 共用交互动效专项

| 编号 | 步骤 | 预期 | ID / ticket |
| --- | --- | --- | --- |
| R33 | 左滑跨阈值再退回、再次跨阈值松手；拒绝/断线/换电脑 | 红灰平滑；每次进入 / 退出阈值各触觉一次，单手势至少反复三轮，同侧移动及松手 / 回弹不追加；卡片完全滑出再收拢；恢复不串身份 | M10 / MOT-02 |
| R34 | 首页、目录、下载、供应商分别长按和触点不同时逐项选择；快速反选和退出 | 蓝底从各自触点展开；工具栏线段旋转/合拢/渐显；几何和确认取消保持 | S15、M06 / MOT-03 |
| R35 | 所有菜单入口四角/窄屏展开；电脑二级进入返回；连续操作/系统返回/切电脑 | 从锚点翻开；容器先变形再侧向翻页；返回相反且只退一层 | M18 / MOT-04 |
| R36 | 当前聊天、长文本、附件、历史预览和离线消息长按；复制、Rewind、滚动及文字选择 | 上方操作栏，常驻下方操作移除；pending恢复区仍在；不推动正文/绕过确认 | S10、M19 / MOT-05 |
| R37 | 文本、多行、附件、运行中排队、重试、连发、断线、上翻阅读中发送 | 先右后上；准确身份交接；不追新、不重播、不飞向不存在的行 | M17 / MOT-06 |
| R38 | 上翻触发最近提问，原文进入视野/点击/通知覆盖/新问题/换会话 | 右上滑入、原路滑出；末帧前内容保留，阅读锚点不动 | S24 / MOT-07 |
| R39 | 按SC19–SC27逐入口点击图标，重复点击、禁用、减少动画 | 下载箭头弹、设置和历史旋转，其他轻弹；48命中不变，无重复专属动画 | M20 / MOT-08 |
| R40 | Android整页左右边缘取消/完成/三层返回；菜单、IME、多选、Sheet和根页对照；iOS仅在保留可选增强时测双侧，否则验证原返回无回归 | 压缩顶层露来源；返回优先级正确，无双重pop或丢草稿/锚点；iOS不可为新增边缘行为牺牲文字选择/横滚/Sheet | M08、M14 / MOT-09 |

每项 A1–A4，包含起始、1/3、2/3、末帧、反向与取消证据；共用组件接入不能免除调用方手动检查。C10 的160ms旧选中淡入在r31实施后改按触点260ms扩散、取消160ms验证，不删除其他断言。C15复制的用户消息入口改为长按操作栏，助手/代码保持原入口。

## 5. 新增或修改 UI 时的用例编写要求

1. **同一任务写用例。** 每个新增或修改的 feature ID 至少有：一个设备 UI 用例，断言该规则的具体数值或几何（坐标、尺寸、可见性、顺序、帧序），只断言“元素存在”不够；状态或逻辑另配单元测试；以及 §4 的手动清单条目。同时更新 §3.3 映射。
2. **动效用例**至少断言起点和终点状态、取消 / 反向后的状态、减少动画路径与正常路径的语义一致。时间相关断言使用夹具注入或可控时钟，不依赖墙钟睡眠。中间帧通过截图附件或帧序列人工复核。
3. **稳定性用例**在拖动中、惯性中和数据更新时断言锚点项的屏幕坐标（容差 ≤ 1pt/dp）。闪屏类问题要有逐帧复现夹具或回放数据。
4. **两端对齐。** 规则适用两端时，两端都写用例，名称尽量对应。平台差异写入 ADR-0051 的平台差异。
5. **只写设计时**，设计说明列出拟新增的自动用例（名称、断言、夹具）和手动步骤，评审通过后实施时落地。
6. **不得删除、跳过或放宽既有用例**来让改动通过。基线规则被有意替代时，在 ADR-0051 修订记录中说明，并同步改写对应用例。

M15 r22 回归记录：Android 隔离工作树 L1 / L2（`testDebugUnitTest`、`assembleDebug`、`assembleDebugAndroidTest`）通过；请求发出后指示器短生命周期回弹的设备、L4 和手动 C03 / R14 / A1–A4 因 API 35 共享设备由其他任务独占而未运行，详见 `.artifacts/ui-regression/20261031-1240-m15-refresh-recovery/`。

M15 r23 回归记录：Android 隔离工作树 L1 / L2（`testDebugUnitTest`、`assembleDebug`、`assembleDebugAndroidTest`）通过；列表位移与旋转指示器共用回位弹簧，设备、L4 和手动 C03 / R14 / A1–A4 因 API 35 共享设备由其他任务独占而未运行，详见 `.artifacts/ui-regression/20261031-1335-m15-smooth-release/`。

### 5.1 r15 新增用例

自动用例已落地。iOS 新增 `RevealClockTests`、`testStreamingRevealAdvancesInOrderAcrossBlocks`、`testStreamingRevealWithReducedMotionShowsEveryBlockImmediately`、首页与目录 V21 用例，以及下载飞入和减少动画用例；Android 新增 `RevealScheduleTest`、`HomeViewportAnchorTest`、`StreamingRevealInstrumentedTest`、`HomeViewportInstrumentedTest`（含下拉刷新）、`SessionDrawerViewportInstrumentedTest`、`SettingsEntryInstrumentedTest`、`SwipeBackPagesInstrumentedTest`、`DownloadFlightInstrumentedTest`。当前 56 项 iOS UI 全量未运行；Android API 35 全量 131 项中 4 项失败，失败集合与 127 项基线的 4 项相同。手动 C01–C18、R01–R16、外观矩阵与完整 L4 审阅仍待执行。

| ticket | 平台 | 拟新增用例 | 断言要点 |
| --- | --- | --- | --- |
| UI-01 | 两端单元 | iOS `RevealClockTests`；Android `GlyphRevealClockTest` | 多批到达时开始时间单调；活动区间连续；积压压缩到 450ms 内；跨块共享游标；非前缀续写立即落定；结束时剩余积压在 450ms 内揭示完；Android 活动字素 ≤ 128 |
| UI-01 | iOS UI / Android 设备 | `testStreamingRevealAdvancesInOrderAcrossBlocks`、`testStreamingRevealWithReducedMotionShowsEveryBlockImmediately`；`StreamingRevealInstrumentedTest` | 夹具分批推送多段文本，按帧采样已绘制字素位置，后段不得早于前段；减少动画时直接显示 |
| UI-02 | Android 单元 / 设备 / iOS UI | `SessionToolContinuityTest`（11）；`ToolContinuityInstrumentedTest`（2）；`ToolContinuityCaptureInstrumentedTest`；iOS 真实输出用例待补 | 单元覆盖重复 head、后继结果、live 交接、缓存首屏、恢复快照 / catchup、父节点由历史或缓存补齐后的原子交接、真实回退、缓存重建及终态事实；设备验证跟随 / 阅读位置与分页边界。隔离真实输出逐帧记录源序号、head、父链、投影 key / 高度，捕获工具活动、转录不回退与最终回合结束。R03 / R04、A1–A4；iOS 与 Claude 真实输出仍待验证 |
| UI-03 | Android 设备 / 单元 | `HomeViewportInstrumentedTest`；`SessionDrawerViewportInstrumentedTest`；`HomeViewportAnchorTest` | 顶部插入 / 重排后首项索引为 0 且偏移为 0；首页 / 目录滚动中首张完整卡片屏幕 y 不变（≤ 1dp）；锚卡被移走时像素偏移不变；拖动中不重新定位 |
| UI-03 | iOS UI | `testHomeTopShowsNewAndPromotedSessions`、`testHomeScrolledAnchorSurvivesInsertionAndReordering`、`testDrawerScrolledSessionsKeepTheirPositionDuringCatalogUpdates`、`testDrawerTopKeepsNewAndPromotedDirectoriesVisible` | 同上；首页 / 目录定向用例已通过，iOS 全量与手动复核待完成 |
| UI-04 | 两端 | `SettingsEntryInstrumentedTest`；`testSettingsPageOrderAndSingleHostMenu` | 右上角只有下载与齿轮设置；连接胶囊不可点击，读屏语义为状态，失败重试仍可用；设置页分区顺序，且没有已配对电脑区；排障入口文字为“设置”；除侧边栏电脑菜单外，全树中没有“添加电脑”“取消配对”节点 |
| UI-04 | 两端 | `SwipeBackInstrumentedTest` 扩展；`testSettingsAndDownloadsSwipeBack`、`testChatDownloadsReturnToSameChat`、`testHistorySwipeBackReturnsToChat`；Android `HistorySwipeBackInstrumentedTest` | 历史页滑入、短拖回弹、右滑露出并返回原聊天，草稿与列表位置保留；历史内下载只退一层；设置 / 首页下载页入场、取消回弹、返回首页、返回后可点；从聊天和历史页进入的下载页滑入，右滑底层为来源页，返回来源页且锚点与草稿不变；二级页返回设置 |
| UI-05 | Android 设备 | `HomeViewportInstrumentedTest#pullingAtTheTopMovesTheListAndRestoresItsPositionAfterRefresh`、`darkThemePullMovesAndRestoresTheWholeList` | 按住顶部下拉时首卡 y 至少下移 20px；松手后首卡回到原 y（容差 1dp）且只触发一次刷新；非顶部 / 多选不触发；复位后卡片仍可点；右滑仍打开目录、左滑仍关闭卡片；浅 / 深色保存拖动帧。A3 / A4 重跑定向用例确认位移与复位语义不变 |
| UI-06 | 两端 | `DownloadFlightInstrumentedTest`；`testDownloadFlightStartsAtTapAndEndsAtButton`、`testDownloadFlightWithReducedMotionHighlightsWithoutFlying`、`testHistoryDownloadButtonAndFlight` | 聊天页与历史页：起飞位置接近点击点，终点为本页下载按钮中心（容差 4pt/dp）；任务未创建时不起飞；同时 ≤ 3 个；减少动画不飞；阅读锚点不变；飞行层不拦截点击；历史页下载按钮的规格与角标和聊天页一致 |
| UI-07 | 两端 | iOS `testBasicConnectionStatusAndDirectoryProviderMismatch`；Android `SettingsEntryInstrumentedTest#settingsPutProvidersFirstAndHaveNoComputerEntries`（含明暗两项）、`StatusScreenTest.connection latency shows host RTT or an unavailable value` | Host `device-link.test.ts` / `host-service.test.ts` 覆盖单路径持续采样、活动路径公告、过期回声与换路隔离；iOS `PresentationTests.connectionLatencyRequiresAConnectedValidSampleAndRoundsMilliseconds` 与 Android `StatusScreenTest` 覆盖取整、缺值、无效值和断线；两端 UI 验证有 / 无样本，Android 还核对路径和读数变化时行位置不动 |

## 6. 结果记录

2026-11-01 最近提问提示（S24 / ADR-0057）：iOS 233 核心测试与 App / UI Test 构建、Android 568 JVM 测试和 APK 构建通过；Android 提醒专项 4 项通过，全量 146 项 4 失败均属于同设备基线 139 项 5 失败集合。iOS 新增定向用例发现刷新后锚点断言失败，完整设备 / 手动及 A1–A5 未完成，不记为验收通过。证据见 `.artifacts/ui-regression/20261101-question-reminder/summary.md`。

2026-11-01 App 按需启动 DeepSeek / Codex Desktop（r30 / S20、X03、V12、V16–V18）：Host / DesktopRuntime 61 项与生命周期 13 项通过，2 项 Windows 条件未运行；类型检查、lint、Android JVM 571 项 / 两包构建、Swift Core 237 项通过。iPhone 17 全量 67 项为 55 通过 / 12 失败；新增 DeepSeek 用例的原生辅助功能标签定位修正后，新建页整组 2 项通过，并覆盖明暗、XXXL、减少动画。110 张全量命名截图联系表与 5 张专项截图已查看，不能替代完整 L4 / 手动。Android 在两次设备尝试中分别发生 ADB 断开、ADB `libunwind` 崩溃，没有有效仪器结果。未重建父提交作受控基线；C01–C18、375pt、R32 真后端与 Windows 仍未验收。iOS 原开关机状态已恢复；Android 只进入浅色标准配置，所设值与保存原值相同，未进入深色 / 大字 / 减少动画。本轮设备进程已退出且租约已释放。R31 保留给最近提问提示，本专项使用 R32。证据、12 项完整失败和未跑清单见 `.artifacts/ui-regression/20261101-agent-on-demand/summary.md`，未部署。

2026-11-01 Codex 桌面新会话同步：Host 公共 Session / 原生 thread ID 边界修复已用回放验证“修复前桌面失败、终端通过；修复后两者通过”，相关 Host 236 项全过。隔离 Node 全量失败集合与基线相同；Android 549 项、Swift 224 项与双端构建通过；iOS 首页同步专项 5 项通过，全量为 54 通过 / 7 失败，111 张命名全量截图及专项 16 张已查看。Android 设备回归因共享池兼容设备连续被其他任务独占而未运行；完整手动 C01–C18 / R25 未完成，不能记为全量验收。最终状态与失败见 `.artifacts/ui-regression/20261101-new-session-sync/summary.md`。

2026-11-01 设置延迟（S23 / UI-07）：两端单元 / 构建和设置页定向通过；Android API 35 全量 138 项的 7 失败与同设备 / 同配置基线一致，A3 / A4 各 3 项定向通过。iOS SE 全量 61 项 7 失败，基线为 6 失败；新增压缩状态等待失败，A3 组内复核（含设置 / 返回）4 项通过，首轮失败仍保留。Host 早期全量 1537 通过 / 5 跳过，后续并发输入生命周期改动期间复跑有 3 项失败；延迟专项通过。两端附件已审阅，独立手动 C01–C18 与完整外观门禁未完成，不记为完整验收通过。证据见 `.artifacts/ui-regression/20261101-settings-latency/summary.md`。

2026-11-01 Codex 原生文件变更（S21 / V19，M13 保持）：协议 18 接入 Codex terminal / Desktop 同轮原生 diff 与文件工具来源；Host 不以工作区快照补齐未知变化。Node 限并发 1,645 / 1,650 通过、0 失败、5 项条件未运行；iOS Swift 230 项及 Debug 构建、Android JVM 565 项及 Debug / AndroidTest 构建通过，Android 文件审阅四种配置各 6 项通过。Android 全量 L3 为 129 通过 / 7 失败 / 7 条件未满足，失败名称匹配 10 月 31 日记录，本轮未重建父版本作受控对照。iPhone 17 / iPad Air 原生文件审阅专项各 4 / 4；iPhone 17 全量 L3 为 56 / 64、8 失败，其中 7 个名称与此前同设备记录相同，额外聊天入口计时失败单项重跑通过但仍保留为间歇失败。手动续跑在 iPad Air / SE 直接操作，并用 UI 测试辅助录屏后亲自核对：SE 明暗各 18 项均 16 过 / 2 失败，另补 9 / 9；Android 十组 132 次为 124 过 / 8 次失败，返回 / 归档补跑 14 / 14，设置入口单项重跑通过仍保留首轮超时。已查看 iOS 全量 117 张有效附件的命名联系表、SE 明暗 / 补跑及 Android A1–A4 概览；文件审阅主流程与 iPhone 标题关闭连续帧已核对，Android 关闭中间帧仍缺。审批 / 问卷、深色首页交互、电脑归属失败，以及冷启动、多行软键盘、第二电脑正常同步等缺口均记录到逐项清单；UI 用例数量不等于 C01–C18 通过数。保留 r28 应用与捕获的当前 iOS 测试驱动存在版本边界，不宣称共享工作树当前源码全通过。设备设置已恢复，本任务租约已释放。完整手动 / L4 和 R28 真实 Codex / Desktop 模型轮次仍未通过；未部署。详见 `.artifacts/ui-regression/20261101-native-codex-file-changes/` 下的 `report.json`、`manual-checklist.md` 和 `manual-resume/summary.json`，不得记为验收通过。

2026-10-31 Claude 输出身份续跑：共享池上限按用户要求同步调整为合计 10 台，仍优先复用已有固定设备。两端 Claude 交接专项通过；iOS 全量 59 项 6 失败，Android 全量 135 项 5 失败 / 7 跳过；当前同设备基线复核与完整手动门禁未完成。证据与失败清单见 `.artifacts/ui-regression/20261031-claude-identity-resume/summary.md`，不能记为全量通过。

每次回归在 `$RUN` 下保存：`ios-ui.xcresult`、`android-ui.log`、截图 / 录屏 / 帧目录、单元与构建日志、已填写的 `manual-checklist.md`，以及 `summary.md`。按本机指南保留，失败记录不得因后续成功而删除，除非同用例同配置已有成功结果覆盖。结论写入对应的 ADR 修订、专题测试记录或 ticket。

`summary.md` 模板：

```markdown
# UI 回归结果：<任务>
- 提交：<sha>（基线 <sha>）；日期；执行人 / Agent
- 受影响 ID：<…>；平台：iOS / Android / 两端
- 设备：<池内名称、系统>；外观：A1 A2 A3 A4
| 层级 | 结果 | 证据 |
| L0 / L1 / L2 / L3 iOS / L3 Android / L4 | 通过 n / 失败 n / 未运行（原因） | 路径 |
- 失败与基线比较：本次失败集合 ⊆ 基线？列出名称
- 手动：C01–C18 结果；专项编号结果
- 未运行与未验收：真机、真实 Host、iOS 17、触觉体感等
```

## 7. 不在本方案结论内

模拟器夹具不替代真机触觉体感、多真实 Host、真实后端和网络、真实订阅账号，也不覆盖 VoiceOver / TalkBack 全流程。这些项目以对应专题的真实环境验收为准，并在结果中单列为未验收。
