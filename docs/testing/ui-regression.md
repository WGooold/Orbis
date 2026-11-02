# 移动端 UI 回归方案

本轮用户操作乐观显示（r32 / ADR-0049 §5–§7）：两端操作账本与全部乐观种类已实施，等待气泡附件、Android 恢复缓存历史、启动落地顺序与输入焦点于 r32 收尾。iOS 全量 79 项 74 通过，5 项失败与同设备 main 构建相同；Android 全量 163 项的失败均与同设备 main 构建相同，或由设备动画设置导致并在恢复后通过。人工 C / R 与真实 Host 未执行。见 §6 r32 记录。

本轮统一交互动效（r31 / ADR-0058）：32场景与MOT ticket先行，双端共用组件已接入。Android全量154项4失败/7外部夹具assumption，iOS全量69项8失败，均未超同设备同配置基线，但受影响既有失败仍阻塞验收。最终Android深色大字20项、实际减少动画19项、iOS SE小屏大字10项及iPad6项定向通过；截图与部分录屏已审阅，完整C/R/A门禁未完成。见 [交互动效验证记录](interaction-motion.md)。

2026-11-02 M15 iOS r33：观察原生顶部拖动，在释放时触发一次刷新；指示器不再设置刷新停靠高度，列表只执行一次原生回弹。隔离 `765b0a3` 上 338 核心测试与构建通过，SE 首页手势 4 / 4、iPhone 17 / SE 下拉 3 / 3（含 A1–A4、短拉 / 多选）通过；iPad 同设备前后下拉均实际刷新一次，回弹源帧已审阅。SE 全量 82 项为 75 通过 / 7 失败，6 项原实现同设备复现，上传失败恢复一项在原实现及当前单独复跑通过，首轮失败保留；176 张附件已查看。完整人工 C01–C18、真实 Host、真机体感未验收，不记完整门禁通过。共享主工作树后续 r34 外观修改不在此隔离结论内。详见 `.artifacts/ui-regression/20261102-ios-refresh-rebound/summary.md`。

日期：2026-11-03。适用基线：[ADR-0051](../adr/0051-ui-style-motion-and-visual-stability-freeze.md) `2026-11-03/r37`；整页导航范围见 [ADR-0054](../adr/0054-shared-full-page-navigation.md)；门禁决策见 [ADR-0053 §8](../adr/0053-settings-entry-page-motion-and-ui-regression-gate.md#8-ui-回归门禁立即生效)。

本方案规定 UI 改动完成前必须执行的自动与手动回归、新用例的编写要求和证据格式。设备、构建目录、锁与产物保留一律遵守根目录 `AGENTS.md` / `CLAUDE.md`（共享池、合计最多 10 台、独占锁、固定构建目录）。本文中的模拟器只指从共享池借用的设备，不授权新建设备。

## 1. 门禁：什么时候必须跑

2026-11-02 部署前路径回归：S21 / V19 的 Codex 原生绝对路径改用证据自身的 POSIX / Windows 方言，工作区内显示路径仍为 `/` 分隔；`codex-turn-file-changes.test.ts` 在所有 runner 上模拟 Windows 默认路径函数，覆盖既有的两项绝对路径断言。构建与部署验证记录位于 `.artifacts/delivery-20261102/`；本次未重跑设备 L3 / L4、C01–C18、R28 与 A1–A4，不能据此提升原生文件审阅或其他 UI feature 的验收状态。

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

2026-11-03 Android 配置切换输入区（V05、V10、V12；R27）：`ConfigComposerInstrumentedTest` 直接点击生产 `ChatScreen` 的 Slash 选项和发送按钮，使用配置账本及 `RelayReducer` 回执，覆盖 Codex / Pi 的模型与思考切换、已确认值重复选择、拒绝、未写入；断言切换结束后发送图标可见且可继续输入。仅替换传输提交，不代表真实 Agent 联动。既有 `ConfigLedgerTest` 继续覆盖确认前发送、规范化、失败连带、连续选择和断线核对。手动 R27 补查同配置重复提交、失败后继续提问、未写入保留命令草稿；完整 C01–C18 / A1–A4 与真实 Host 结果单独记录。

回答重复提示（V06–V07、V16、V22）：`host-service.test.ts` 的 `keeps only the appropriate interaction feedback` 四组加密 Relay 用例覆盖 App 成功无顶部横幅、电脑端完成 / 取消 / 超时各一条，以及重复终态、事件转发与通知重取；配合 `notification-store.test.ts`、`runtime-command-lifecycle.test.ts`。双端沿用 OPT-05 设备用例，真实隔离 Host 按 R26 检查顶部与底部不得重复显示成功提示。

2026-11-02 Codex 终端来源与开窗专项（R56；S20、V12、V17–V18、X03）：Host `codex-terminal-environment.test.ts` 与真实隔离 CLI 对照覆盖继承 Desktop 来源覆盖值导致的新建误标；只在终端子进程清除覆盖值。`codex-session-ownership.test.ts`、`codex-terminal-macos.test.ts`、`macos-terminal.test.ts`、既有 `codex-runtime.test.ts` / `codex-terminal-sync.test.ts` 覆盖 App 终端路由不被历史来源改派、精确 CLI / endpoint、真实 TTY 启动确认、失败回执 / 空闲订阅释放、已有会话保留、等待窗口与 native TUI 检测和 PID 复核关闭。设备消费既有启动失败路径：iOS `testNewSessionEntersChatAtOnceAndFailureOffersRetryInPlace`、Android `OptimisticPresentationInstrumentedTest#aFailedLaunchOffersRetryAndBackInPlace`。完整 L1–L4、C01–C18 / A1–A4 与真实隔离 TUI 仍须独立记录，夹具不得算作真实窗口验收。

修改某个 ID 时，至少先跑映射到它的用例做定向验证；交付前跑全量。新增用例时同步更新本表。

2026-11-03 Claude 长会话恢复（R18；V09–V10、V16–V18）：`session-source.test.ts` 覆盖 257 / 1,055 条初始化、字节超限批次、unknown→checkpoint 与后续连续增量；`claude-transcript.test.ts` 覆盖长原生日志继续追加后 Host 重开 preview 的最新 head。Android `ClaudeHistoryInstrumentedTest#existingHistoryAndRunningTurnSurviveParallelToolsAndReconnect` 使用 `ORBIS_CLAUDE_HISTORY_PREFIX=1053` 的真实 Host / Relay / Mods 夹具，比较同设备同 App 的修复前后结果。iOS 沿用 source recovery 核心与 Claude 身份设备映射；完整双端 L1–L4 / C01–C18 / A1–A4 结果不得由此定向对照替代。

**iOS `OrbisUITests`（合并后 83 项：主线 71 项含 r31 新增 4 项及原生文件审阅 / 按需启动新增 2 项，r32 乐观操作新增 8 项，r33 下拉刷新新增 3 项，r34 外观切换新增 1 项；历史运行计数按证据保留）**

| 区域 | 用例 | 主要 ID |
| --- | --- | --- |
| 首页加载 / 同步 | `testHomePublishesCompleteSnapshotsWithoutReturningToLoading`、`testHomeRetriesFailedBackgroundRuntime`、`testHomeBackgroundSyncFailureStaysInConnectionPill`、`testHomeInlineStatusInDarkAndLargeText`、`testHomeKeepsCardsAfterDirectoryReplay` | S18、V16、V18 |
| 首页手势 / 多选 / 关闭 | `testHomeVerticalDragsScrollFromCardsAndKeepSelection`、`testHomeLongListScrollsToEndInBothAppearances`、`testHomeLongPressSelectsAndClosesOnlyCheckedSessions`、`testHomeShortSwipeReboundsAndLongSwipeClosesOnlyThatRuntime`、`testSwipeCloseHidesBeforeConfirmationAndRestoresOnRejection`、`testSwipeRightFromLeftSideOpensDirectory` | S15、M06、M09–M12、V11 |
| 首页下拉刷新 | `HomePullRefreshTests`（3 项核心）；`testHomePullRefreshReturnsListToItsStartingPosition`、`testHomePullRefreshInDarkLargeTextAndReducedMotion`、`testHomePullRefreshIgnoresShortPullsAndSelection` | M15、S18、V21 |
| 首页与目录入口 | `testHomeDirectorySearchAndNewSession`、`testNewSessionOffersLaunchableDeepSeekBeforeBackendIsReady`、`testCompactionStatusInHomeChatAndDrawer` | S19–S20、V05 |
| 目录抽屉 | `testDrawerCardsKeepUniformGeometryForShortAndLongTitles`、`testDrawerLongPressArchivesAndRestoresOnlyCheckedSessions`、`testDrawerSelectionClearsOnCancelSearchAndClose`、`testDrawerFollowsEdgeDragAndShowsOneDirectory`、`testDrawerCollapseShrinksContentWithoutAnotherDrag` | S15、S19、M06、M09、V17 |
| 聊天入场 / 返回 | `testCachedOnlineChatEntryTiming`、`testChatSwipeBackReboundsThenReturnsHome`、`testDraftSurvivesBackNavigationAndSlashRequiresSelection` | M07–M08、V13、V17 |
| 聊天视口 | `testLongTranscriptAppearsAndToolExpansionKeepsItsPositionWithoutDragging`、`testLongFinalReplyKeepsReadingPositionAndOnlyFollowsAfterJump`、`testNewMessagesAndToolsPreserveTheMovingReadingAnchor` | V01–V03、M03 |
| Claude 模型回复身份 | `testClaudeNativeHandoffKeepsOneCopyAcrossConsecutiveTurns`（明暗，三阶段 canonical / live 交接；每段正文唯一） | V09、V17–V18 |
| 聊天内容 / 顶栏 | `testRefreshKeepsHeaderTextAndTruncationStable`、`testClosedDisclosureDefersWorkAcrossChatReentryAndRetainsState`、`testUserMessageCopyAndRewind`、`testToolDetailsLoadPagesAndClose`、`testTruncatedContentAndToolArguments`、`testHistoryPreviewAndNavigation` | S10–S11、S17、S20、M03、M05、V05、V14 |
| 输入 / 审批 / 队列 | `testSlashPickerStaysAboveKeyboard`、`testOptimisticSendReconcilesAndRejectedSendRestores`、`testUnconfirmedSendCanBeCheckedWithoutResending`、`testCompactionQueuedSendCanBeWithdrawn`、`testApprovalOverlayKeepsComposerStableWhileSubmitting`、`testQueueCancellationNotificationsAndRuntimeFacts`、`testToolExportAndInteractionDraftSwitching` | V06–V08、V10、V12、V17 |
| 连接状态 / 供应商（r15 后为设置页） | `testCompactQuotaCardsAndTransparentSwitch`、`testQuotaCoinReducedMotionKeepsBothReadingsAndTheTouchTarget`、`testFixedRoutingAndStatusProviderSwitch`、`testBasicConnectionStatusAndDirectoryProviderMismatch` | S18–S19、S22–S23 |
| 下载 | `testDownloadCardsPauseResumeAndSelectWithoutSideButtons` | S15、S20 |
| 轮次文件审阅 | `testTurnFileReviewLoadsOnlySelectedFilesAndRetainsCache`、`testTurnFileReviewDarkAppearance`、`testTurnFileReviewOnlyHeaderPullCloses`、`testNativeTurnFileReviewShowsSourceAndReadsOnlySelectedDetail` | S21、M13、V19 |
| 全页面明暗 | `testPageScreenshotsInBothAppearances` | S01–S09、S16、S25 |
| r15 设置与入口 | `testSettingsPageOrderAndSingleHostMenu` | S18、S22 |
| r34 外观切换 | `testInsetFocusAppearanceSwitchPersistsAcrossLaunches` | S01–S04、S12、S22、S25 |
| r24 整页导航 | `testSettingsAndDownloadsSwipeBack`、`testChatDownloadsReturnToSameChat`、`testHistoryDownloadsReturnToHistory`、`testHistorySwipeBackReturnsToChat`、`testAddComputerPageReboundsAndSwipesBack`、`testNestedPagesSwipeBackOneLevelAtATime` | M07–M08、M14、V17–V18 |
| r15 流式、首页 / 目录视口与飞入 | `testStreamingRevealAdvancesInOrderAcrossBlocks`、`testStreamingRevealWithReducedMotionShowsEveryBlockImmediately`、`testHomeTopShowsNewAndPromotedSessions`、`testHomeScrolledAnchorSurvivesInsertionAndReordering`、`testDrawerScrolledSessionsKeepTheirPositionDuringCatalogUpdates`、`testDrawerTopKeepsNewAndPromotedDirectoriesVisible`、`testDownloadFlightStartsAtTapAndEndsAtButton`、`testDownloadFlightWithReducedMotionHighlightsWithoutFlying`、`testHistoryDownloadButtonAndFlight` | M04、V21、M16 |

**Android instrumentation（`androidTest`）**

| 区域 | 测试类（用例数） | 主要 ID |
| --- | --- | --- |
| 首页 | `HomeLoadingInstrumentedTest`（2）、`HomeNavigationInstrumentedTest`（3）、`HomeSelectionInstrumentedTest`（1）、`HomeSwipeCloseInstrumentedTest`（1）、`OptimisticActionsInstrumentedTest`（3） | S18、M06、M10–M12、V10–V11、V13、V18 |
| 转场 | `SwipeBackInstrumentedTest`（4）、`ChatEntryInstrumentedTest`（1） | M07–M08、V13 |
| 聊天视口 / 内容 | `ChatViewportInstrumentedTest`（9）、`DeferredDisclosureInstrumentedTest`（2）、`MarkdownInstrumentedTest`（1）、`ToolPanelInstrumentedTest`（3）、`ToolContentInstrumentedTest`（2）、`DisplayScenariosInstrumentedTest`（1）、`ClaudeHistoryInstrumentedTest`（1）、`LiveHistoryReloadInstrumentedTest`（1） | S11、S20、M03、V01–V04、V09、V14 |
| 顶栏 / 输入 / 交互 | `ChatStatusLayoutInstrumentedTest`（2）、`ComposerSessionInfoInstrumentedTest`（3）、`InteractionWorkspaceInstrumentedTest`（5）、`QuestionnaireInstrumentedTest`（2）、`CodexPermissionsInstrumentedTest`（3）、`NotificationsInstrumentedTest`（2）、`DshInstrumentedTest`（2） | S12、S17、V05–V08、V12、V17 |
| 目录 | `SessionDrawerLayoutInstrumentedTest`（2）、`SessionArchiveSelectionInstrumentedTest`（3）、`SessionProviderFilterInstrumentedTest`（3）、`SessionHostOwnershipInstrumentedTest`（3） | S15、S19、M06、M09、V17 |
| 新建会话 Agent 选择 | `DshInstrumentedTest#selectsLaunchableDeepSeekBeforeBackendReadyAndCreatesSessionInChosenDirectory` | S20、V12、V16–V18 |
| 状态 / 供应商 | `SubscriptionQuotaInstrumentedTest`（3，查询 / 翻面、快速接管与减少动画）、`ProviderSelectionInstrumentedTest`（1） | S19、S22 |
| 下载 / 文件 | `DownloadFileBrowserInstrumentedTest`（3）、`TurnFileChangesInstrumentedTest`（6，含原生 Codex 来源提示及 Pi 预览清单点击、入场期间完整清单 / 首段 diff 到达和关闭重开）、`ChatViewportInstrumentedTest#turnChangeSummaryFollowsTheWholeTurnWhenAnchoredInsideIt` | S09、S15、S20–S21、M13、V19 |
| 材质 / 字形 / 控件 | `UiPolishInstrumentedTest`（3）、`NeumorphInstrumentedTest`（1） | S01–S09、S12、M04、V15 |
| 非 UI 但在同一设备套件 | `SessionGraphStoreInstrumentedTest`（32）、`SessionSyncSelectionInstrumentedTest`（6）、`SessionSyncSlowLinkInstrumentedTest`（2） | 缓存 / 同步正确性，全量时一并运行 |
| 需要隔离 Host | `IsolatedHostPairingInstrumentedTest`（1）；`ToolContinuityCaptureInstrumentedTest`（1，无参数时自动跳过，传入配对载荷与 cwd 时做真实输出逐帧捕获） | 配对；V20 定位 |
| Pi 连续工具交接 | `ToolContinuityInstrumentedTest`（2，跟随与上滑阅读；连续同 head 更新后父节点补齐） | V20、V09、V01–V04、V18 |
| r15 首页 / 目录视口与下拉刷新 | `HomeViewportInstrumentedTest`（6，其中 M15 两项）、`SessionDrawerViewportInstrumentedTest`（3） | M15、V21 |
| r15 设置与入口 | `SettingsEntryInstrumentedTest`（5） | S18、S22–S23、S25 |
| r24 整页导航 | `SwipeBackPagesInstrumentedTest`（2，位于 `SwipeBackInstrumentedTest.kt`）、`HistorySwipeBackInstrumentedTest`（1，真实历史 / 聊天 / 下载层级）、`PageNavigationInstrumentedTest`（3，添加电脑 / 离线历史 / 嵌套系统返回） | M07–M08、M14、V17–V18 |
| r15 下载飞入 | `DownloadFlightInstrumentedTest`（1） | M16 |
| r15 流式顺序 | `StreamingRevealInstrumentedTest`（1）；`UiPolishInstrumentedTest#revealKeepsEmojiAndCombiningCharactersTogether` 改用新时钟 | M04 |

与 UI 相关的单元测试（L1 中必须通过）：iOS `RevealClockTests`、`HomeRuntimeLoadingTests`、`StoreTests`、`AgentStateTests`、`PendingSendTests`、`PresentationTests`、`TurnFileChangesTests`、`OperationLedgerTests`、`QuitLedgerTests`；Android `HomePresentationTest`、`ChatListItemReuseTest`、`HistoryPagingTest`、`MessagePresentationTest`、`StatusScreenTest`、`SubscriptionQuotaTest`、`UiPolishTest`、`PendingSendsTest`、`TurnFileChangesTest`、`RevealScheduleTest`、`HomeViewportAnchorTest`、`OperationLedgerTest`、`QuitLedgerTest`。

Claude 运行中发送的适配器回归（V10、V12、V17）：`claude plugin test packages/claude-mod` 的 `reconnect.test.ts` 覆盖主回合期间不调用 `prompt.submit`、同批消息串行提交、停止与工具事件、子 Agent 完成、Host 轮末捕获屏障及重连代次隔离；设备端仍关联两端乐观发送用例。真实联动验收按 R17 执行，插件模拟通过不能替代设备 / 真实 TUI 验收。

DSH 原生 inbox 来源回归（V09–V10、V12、V17；ADR-0020 / ADR-0031 / ADR-0055）：`dsh-web-runtime.test.ts` 的 `keeps runtime context out of the user queue across recovery, live updates and delivery` 覆盖恢复投影、实时用户事件与队列投影：权限、子代理 / 后台完成、插件、自动目标和未知显式来源均排除，内部 `rpcId` 不结算用户消息，300 条内部通知不占 256 条用户队列预算，完整内部清单确认用户队列为空；同文人类消息、浏览器 steer 与旧版无来源消息仍保留。`dsh-web-history.test.ts` 同时核对非用户来源不创建聊天消息 / App 发送身份；`scripts/test-dsh-web.mjs` 用隔离真实 DSH 验证权限命令保留原生上下文、App 用户队列为空且不发起模型请求。设备沿用 iOS `testQueueCancellationNotificationsAndRuntimeFacts` / `testCompactionQueuedSendCanBeWithdrawn` / `testUnconfirmedSendCanBeCheckedWithoutResending` 与 Android `OptimisticActionsInstrumentedTest`、`InteractionWorkspaceInstrumentedTest`，它们验证消费端队列与权限交互，不能替代真实 DSH 联动。手动专项 R41。

iOS 同步拒收 / 终态重放（V05–V06、V16–V18；ADR-0037）：`session-sync-tasks.test.ts` 覆盖首次 ACK 终态、成功后重复请求、初次未发送 / 已 abort 的 ACK，以及未确认响应重派至 queued / processing 时的迟到 ACK。`StoreTests.newerCommittedPatchSupersedesAnOlderPreviewWithoutShowingTheHostEcho`、`stalePreviewWithoutACompleteAppliedBaselineKeepsAVisibleRecoveryError`、`hostRejectionEchoPreservesTheSpecificLocalFailureAndOtherErrorsRemainVisible` 覆盖已持久化新版本、工具依赖未齐、具体错误与不相关错误隔离。设备沿用首页同步五项、`testRefreshKeepsHeaderTextAndTruncationStable`、聊天视口 / 历史用例；需以 R43 隔离 Host 回放核对真实回执顺序，不能用预览夹具替代。

Claude 首页首次同步（S18、V16、V18；ADR-0033 §16）：`agent-backend.test.ts` 的三组 `announces a complete home baseline without waiting for history` 在历史定位一直未返回时，验证无审批 / 有审批 / 仅 Hook 在线均立即具有完整首页领域，审批保持等待，离线目标不发布空清单；`host-service.test.ts` 的 Claude 加密通道用例在任何历史请求之前核对首次读取。消费端沿用 iOS `HomeRuntimeLoadingTests` / 首页加载同步五项 UI 用例与 Android `HomeLoadingInstrumentedTest`，不得用这些夹具代替 R42 真后端 / 双端联动。

Claude 首次启动项目授权回归（V12、V17–V18；ADR-0033 §14）：`claude-workspace-trust.test.ts` / `claude-launcher.test.ts` 覆盖先登记再开窗、既有配置保留、损坏配置拒绝、并发项目、默认 / 自定义配置、Git 子目录 / linked worktree / 嵌套仓库、符号链接和宽泛根拒绝。专项手动 R29（早期记录曾误用已占用的 R19；R19 保留给历史返回）；macOS TUI 握手通过不替代 Windows 或 App 设备门禁。

跨 Agent 启动准备（ADR-0056，S16、V12、V16–V18）：`agent-startup.test.ts` / `spawner.test.ts` / `desktop-terminal.test.ts` / `macos-terminal.test.ts` 覆盖 Pi TUI/RPC、Codex 独立 / remote TUI 和终端开窗；`claude-startup.test.ts` / `claude-launcher.test.ts` 覆盖具名 MCP 临时授权、拒绝优先、插件 / 管理策略、登录失败与本地 setup；`claude-mods-bridge.test.ts` 验证启动失败取消等待；`codex-terminal-sync.test.ts` 验证配置失败不创建 thread；`dsh-client.test.ts` 验证 initialize 未支持交互明确失败。真实项目 / 账号 / 新建 / 恢复按 R30 两端覆盖，完整门禁未完成，不以 Host 测试代替。

App 按需启动 DeepSeek / Codex Desktop（S20、V12、V16–V18；ADR-0056 §2.1）：Host `host-service.test.ts` 覆盖 DSH 与 Codex Desktop 在未预启动时，先按 `launchableAgents` 公告可选，再由会话请求挂载后端并成功激活；已接入两类 runtime 时直接调用会话 API，断言不调用启动回调。iOS / Android 用例验证仅出现在 `launchableAgents` 的 DeepSeek 仍可选。R32 需另做两端真 Host / 真 Agent 手动确认；Host 自动测试通过不代表设备或真实后端门禁通过。

Claude 输出交接回归（V09、V17–V18）：Host `claude-transcript.test.ts` / `claude-mods-bridge.test.ts` 覆盖一对多 UUID 原子提交、逐 patch 无重复、跨轮清理、迟到事件与落盘超时；官方插件 `reconnect.test.ts` 覆盖主 / 子步骤归属和封口顺序。iOS `StoreTests.claudeStepHandoffPreservesIdenticalTextFromTheNextTurn` 保留合法同文的下一轮；Android `ClaudeHistoryInstrumentedTest` 使用 `scripts/claude-history-fixture.mjs` 的 bridge 3 数据，断言运行中交接、轮末和重连后各段正文只有一份。专项手动 R18。

所有状态输入契约（[ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md)，V05、V09–V10、V12、V16–V18）：AIN-01–AIN-07 覆盖协议全集、状态准入、命令回执、各适配器与双端 outbox、专用服务。`runtime-command-lifecycle.test.ts`、`runtime-input-policy.test.ts` 及 Codex / Pi bridge / Claude / DSH 和两端 PendingSend 测试已补充；iOS 新增 `testUnconfirmedSendCanBeCheckedWithoutResending`、`testCompactionQueuedSendCanBeWithdrawn`，Store 单测覆盖 Slash 草稿在拒绝 / 未确认后保留、成功后清理；Android `OptimisticActionsInstrumentedTest`（3 项）验证排队撤回、未确认核对及不提供自动重发。实现与门禁结果分开记录，未完成全量前不记为通过。

用户操作的乐观显示（[ADR-0049 §5–§7](../adr/0049-optimistic-send-and-source-reconciliation.md#5-操作分级只按体验判断2026-11-01取代原-5)，V07、V10–V12、V22；r27 决策，r32 已实施、验证中）：
- 两端单元：扩展 `PendingSendTests` / `PendingSendsTest`，覆盖 `waiting` 的三种前置操作、同会话顺序、失败连带和草稿副本恢复，以及 prompt / skill Slash 的 App id 落地。另新增两端同构的乐观操作状态机测试，覆盖撤回、归档、回答、通知、模型切换和会话启动的落地、拒绝、60 秒无回执、断线、失效和同对象冲突。
- Host / 协议：覆盖 `slash.execute` 的 App id，以及各后端为 Slash 产生的用户消息声明 `clientMessageId`。
- 设备：扩展 iOS `testOptimisticSendReconcilesAndRejectedSendRestores`、`testQueueCancellationNotificationsAndRuntimeFacts`、`testApprovalOverlayKeepsComposerStableWhileSubmitting`、`testDrawerLongPressArchivesAndRestoresOnlyCheckedSessions`，以及 Android `OptimisticActionsInstrumentedTest`、`InteractionWorkspaceInstrumentedTest`、`SessionArchiveSelectionInstrumentedTest`、`NotificationsInstrumentedTest`。断言结果在回执前呈现，拒绝后回到原位置（≤ 1pt/dp），阅读锚点与视口不动，正文只出现一次。
- 手动：R26、R27。

设计已登记，实际用例名和通过结果随实施更新；扩展用例不得放宽现有断言。已实施部分：

| ticket | 单元（两端同构） | 设备定向 | 状态 |
| --- | --- | --- | --- |
| OPT-00 账本核心 | iOS `OperationLedgerTests`、Android `OperationLedgerTest`（各 22 项，含 5 组固定种子随机序列；断线规则变异检验两端均失败） | 无（纯逻辑） | 2026-11-01 通过 |
| OPT-01 `quit`（V11 r27） | iOS `QuitLedgerTests`（13 项）、Android `QuitLedgerTest`（12 项，Android 无 `shutdown` 一项，见 ADR-0049 §7.7）；Android `PendingSendsTest` 的关闭用例改为账本语义，断线一项按 V11 r27 改为保持隐藏 | iOS `testSwipeCloseHidesBeforeConfirmationAndRestoresOnRejection`、`testCloseKeepsTheCardHiddenThroughADisconnectAndRestoresItWhenStillOnline`（r32，预览夹具 `--preview-close=drop`：断线保持隐藏，重连后仍在线则原位恢复并提示“关闭会话未确认”）、`testHomeLongPressSelectsAndClosesOnlyCheckedSessions`、`testHomeShortSwipeReboundsAndLongSwipeClosesOnlyThatRuntime`、`testSwipeRightFromLeftSideOpensDirectory`；Android `OptimisticActionsInstrumentedTest`（2）、`HomeSwipeCloseInstrumentedTest`、`HomeSelectionInstrumentedTest` | 2026-11-01 单元、构建与定向设备通过；R27 关闭断线项以 r32 设备用例覆盖（预览注入）；全量门禁归 OPT-10 |
| OPT-H1 Host 设备回执 | `host-service.test.ts`（归档 / 启动的 success、failure 与原因码） | 无 | 2026-11-01 通过 |
| OPT-02 `dismiss`（V22） | iOS `DismissLedgerTests`、Android `DismissLedgerTest`（各 8 项） | iOS `testQueueCancellationNotificationsAndRuntimeFacts`（关闭通知部分）；Android `OptimisticPresentationInstrumentedTest#aDismissedNoticeLeavesAtOnceAndTheOtherStays` | 单元通过；设备见 OPT-10 记录 |
| OPT-03 `archive`（V22） | iOS `ArchiveLedgerTests`、Android `ArchiveLedgerTest`（各 9 项） | iOS `testDrawerLongPressArchivesAndRestoresOnlyCheckedSessions`；Android `SessionArchiveSelectionInstrumentedTest`、`OptimisticPresentationInstrumentedTest#archivingMovesTheCardToTheArchiveAtOnce` | 单元通过；设备见 OPT-10 记录 |
| OPT-04 `queueCancel`（V22） | iOS `QueueCancelLedgerTests`、Android `QueueCancelLedgerTest`（各 10 项）；iOS `StoreTests` 队列撤回用例改为账本语义 | iOS `testQueueCancellationNotificationsAndRuntimeFacts`（撤回后退场且不闪回） | 单元通过；设备见 OPT-10 记录 |
| OPT-05 `respond`（V07、V22） | iOS `RespondLedgerTests`、Android `RespondLedgerTest`（各 9 项）；iOS `StoreTests` 交互用例改为账本语义 | iOS `testApprovalOverlayKeepsComposerStableWhileSubmitting`（收起与原位摘要）、`testApprovalRejectionBringsThePanelBackInPlace`（预览夹具 `--preview-respond-reject`）、`testOptimisticStatesAcrossAppearances`（A1–A4）；Android `OptimisticPresentationInstrumentedTest#answeringCollapsesThePanelIntoAnInPlaceSummaryAndARejectionBringsItBack`、`InteractionWorkspaceInstrumentedTest` | 单元通过；设备见 OPT-10 记录 |
| OPT-06 `waiting`（V10） | iOS `WaitingSendTests`、Android `WaitingSendTest`（各 6 项） | iOS `testModelSwitchShowsTheChoiceWithItsMarkWithoutMovingTheHeader`（切换中发送：气泡立即出现、清空输入、标明“等待模型切换”）、`testOptimisticSendReconcilesAndRejectedSendRestores`、`testSendingWhileUploadingShowsTheAttachmentInTheBubbleAndSubmitsTogether`（r32，`--preview-upload-waiting`：气泡内缩略图 / 文件名 / 进度、上传完成后正文与附件一起提交、只出现一次）、`testFailedUploadFailsOnlyItsMessageAndRestoreReturnsTextAndAttachment`（r32，`--preview-upload-waiting=fail`：后一条不越过前一条、失败只影响所属消息、放回输入框带回正文与附件）；Android `OptimisticActionsInstrumentedTest`、`OptimisticPresentationInstrumentedTest#aMessageSentWhileUploadingShowsItsAttachmentsInTheBubble`（r32） | 见 r32 记录 |
| OPT-07 `config`（V12、V05） | iOS `ConfigLedgerTests`、Android `ConfigLedgerTest`（各 7 项）；iOS `StoreTests` Slash 用例改为账本语义 | iOS `testModelSwitchShowsTheChoiceWithItsMarkWithoutMovingTheHeader`（预览夹具 `--preview-model-switch`；顶栏不位移、会话信息显示“（切换中）”）、`testRefreshKeepsHeaderTextAndTruncationStable`；Android `OptimisticPresentationInstrumentedTest#switchingShowsTheChosenModelWithItsMarkInTheSameSlot`、`ChatStatusLayoutInstrumentedTest` | 单元通过；设备见 OPT-10 记录 |
| OPT-08 `launch`（V12、V10） | iOS `LaunchLedgerTests`（8 项）、Android `LaunchLedgerTest`（7 项；r32 两端补充“Runtime 先于 session.activated 上线”，iOS 另有输入焦点交接）；iOS `StoreTests` 启动用例改为立即进入 | iOS `testNewSessionEntersChatAtOnceAndFailureOffersRetryInPlace`（预览夹具 `--preview-launch-fail`：立即进入、标题为目标名称、“启动中”、失败原位、重试、返回）、`testOptimisticStatesAcrossAppearances`（A1–A4）、`testHomeDirectorySearchAndNewSession`、`testSendingWhileTheSessionStartsWaitsAndSubmitsOnceItIsOnline`（r32，`--preview-launch-slow`：启动中发送标明“等待会话启动”、上线后写入且只出现一次、输入框焦点不丢）；Android `OptimisticPresentationInstrumentedTest#aFailedLaunchOffersRetryAndBackInPlace`、`LaunchPageInstrumentedTest`（r32，3 项：启动中写的消息立即出现、恢复时先显示缓存历史、上线后输入框保持焦点） | 单元通过；设备见 OPT-10 记录 |
| OPT-09 prompt / skill Slash（V10） | iOS `SlashMessageTests`、Android `SlashMessageTest`（各 4 项）；Host `codex-runtime.test.ts`（skill 声明 `clientUserMessageId`）、`dsh-web-runtime.test.ts`（r32，DSH skill 以 App id 作 requestId 并声明 `clientMessageId`） | 无新增（判定与结算由单元覆盖） | 单元通过 |
| OPT-10 全量门禁 | iOS SwiftPM 331 项、Android JVM 664 项通过；Debug / AndroidTest APK 与 iOS `build-for-testing` 通过 | iOS 池内 iPhone 17 `OrbisUITests` 全量 67 项：59 通过、8 失败，main `e4df87a` 同设备重跑这 8 项同样失败；其中审批与交互草稿两项为预览夹具问题，修正后通过。Android 池内 `Orbis_UI_Polish_35` 151 项：138 通过、5 失败、8 项需隔离 Host 跳过；归档多选一项断言旧行为，改写后通过，其余 4 项 main 同设备同样失败 | 自动 L1–L3 失败集合不超出同设备基线；A1–A4：Android 夜间 / 字体 1.5 / 关闭动画专项通过，iOS 外观矩阵（含 iPhone SE）；L4 已查看两端相关截图；C01–C18、R26 / R27 人工逐项未执行，不记为通过。证据 `.artifacts/ui-regression/2026-11-01-optimistic-actions/opt-10/` |

带 `assumeTrue(ValueAnimator.areAnimatorsEnabled())` 的设备用例（下载飞入、流式顺序）在系统关闭动画时跳过，A4 路径以手动检查为准。

Codex 桌面新会话同步回归（S18、V16–V18）：Host `host-service.test.ts` 的 `new %s sessions complete homepage model reads and retries without reconnecting` 分别验证终端 / 桌面后端，在同一加密连接内创建后立即读取 identity、execution、interactions，并带 agentKind 重试，均须 ready 且交互库存为已确认的空集合。不能先重连或手工调用 announce 才断言通过。Android `HomePresentationTest.newDesktopCodexSessionCompletesSplitHomeReadsAndRetryWithoutRestarting` 与 iOS `HomeRuntimeLoadingTests.newDesktopCodexSessionCompletesSplitHomeReadsAndRetryWithoutRestarting` 覆盖分批接收、保留旧卡片、完成与重试退出同步态；设备映射仍为 `HomeLoadingInstrumentedTest` 与 iOS 首页加载 / 同步五项用例。专项手动 R25；Host 模拟通过不替代真实桌面 App / 设备门禁。

原生 Codex 文件审阅（ADR-0052 §9.1，S21 / V19；M13 保持）：Host 新增 `codex-turn-file-changes.test.ts`、`codex-native-file-review.test.ts`，覆盖整轮 revision 替换、拒绝 / 未完成 / 失败部分落盘、空 diff 失效、旧轮 / 迟到事件、外部同时写入不混入、重启 / 过期与零正文概况。双端模型扩展 `TurnFileChangesTests` / `TurnFileChangesTest`；设备用例为 iOS `testNativeTurnFileReviewShowsSourceAndReadsOnlySelectedDetail`、Android `nativeSummaryShowsToolScopeWithoutReadingDetail`。同时保留并执行既有轮末位置、落位读取、预览扩容、关闭手势及缓存用例；两端 L1–L4、C01–C18、A1–A4 与 R28 均须记录实际结果，定向通过不替代全量门禁。


S24 最近提问提示（ADR-0057）：iOS `ChatQuestionTests`、`testQuestionReminderAppearsWhileReadingAndLocatesTheOriginalWithoutFollowing`、`testQuestionReminderTracksNewSourceQuestionsWithoutMovingTheReader`；Android `ChatQuestionTest`、`ChatQuestionReminderInstrumentedTest`（4）。覆盖源消息身份、可见性、点击定位、阅读锚点、通知优先和 Host 隔离，配合既有视口用例及手动 R31，A1–A5；未验收不得计为交付。


### R58：宣传片配额硬币原生移植（S19 / ADR-0058 / MOT-22，验证中）

- L1：iOS `QuotaCoinGeometryTests`、Android `QuotaCoinGeometryTest`；正反面落定正向且相同大小，90°实体侧边闭合，连续投影不越出操作槽，曲线只缓动一次。
- L3：保留 iOS `testCompactQuotaCardsAndTransparentSwitch` 和 Android `SubscriptionQuotaInstrumentedTest` 原用例；补快速连点 / 首次演示接管、刷新中断 / 失败保留周期、离页和减少动画。全量套件仍须运行。
- L4 / 手动：C12、C16 和 R58，A1–A4，经典 / 雾蓝浅深色；逐帧审阅铜色厚度、侧面无空洞、背面无镜像、单次扫光、影宽35%、角标和触控区固定、每面配额环对应真实读数。补全部 C01–C18，不以几何单测代替视觉门禁。
- 本轮源码基线和候选快照及证据保存在 `.artifacts/ui-regression/20261103-quota-coin/`；设备占用、既有失败和未跑项分别记录，未完成门禁不记通过。

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

r35 增补（同属 §3.3 的自动映射；完整结果见 [r35 验证记录](interaction-motion.md#2026-11-02--r35-交互细化)）：

| Ticket / 场景 | 实际自动验证入口 | 手动 / feature |
| --- | --- | --- |
| MOT-11 / SC33 | Android `InteractionMotionTest`、`predictiveBackOnBothEdgesCancelsOrCommitsOnlyOnePage`；iOS `testOptionalEdgeBackKeepsExistingIOSNavigation` | R45 / M08、M14 |
| MOT-12 / SC34 | `discreteLabelsKeepOnlyTheLiveAccessibilityValueDuringTheirFade`、`ChatStatusLayoutInstrumentedTest`、iOS 状态外观矩阵、Qt `MotionTextTest` | R46 / M21、V05、V16 |
| MOT-13 / SC35、MOT-15 / SC37 | `physicalPressShowsFeedbackBeforeDispatchAndCancellationDoesNotClick`、`iconActivationChangesTheGlyphWithoutChangingItsHitTarget`；双端共用组件和导航来源中帧 | R47、R49 / M20、M12、V13 |
| MOT-14 / SC36 | `SessionDrawerViewportInstrumentedTest`、`SessionProviderFilterInstrumentedTest`、iOS `testDrawerScrolledSessionsKeepTheirPositionDuringCatalogUpdates` 及搜索 / 归档既有用例 | R48 / M22、V21 |
| MOT-16 / SC38 | `HomeSelectionInstrumentedTest` 逐项触觉次数、目录 / 下载选择；iOS 首页 / 目录 / 下载多选 | R50 / M06、M12 |
| MOT-17 / SC39 | Qt `MotionTextTest`、`--smoke-motion` 普通 / 减少动画的真实窗口中帧 | R51 / X03、X05 |
| MOT-18 / SC40 | `newSessionCardRisesBeforeHandingOffExactlyOnce`、LaunchLedger、双端启动失败 / 重试 / 启动中输入；iOS 新卡录屏 | R52 / M23、V12、V17 |
| MOT-19 / SC41 | `nativeTextLongPressReplacesThePageHeaderWithoutMovingTheBubble`；iOS `testUserMessageCopyAndRewind`、`testOptimisticSendReconcilesAndRejectedSendRestores` | R53 / M19、S10、S17 |
| MOT-20 / SC42 | `ChatQuestionReminderInstrumentedTest`、iOS 两项最近提问专项（保留锚点断言） | R54 / S24、V01–V03 |
| MOT-21 / SC43 | `HomePresentationTest`、`HomeRuntimeLoadingTests`、`HomeLoadingInstrumentedTest`、iOS `testHomeKeepsCardsAfterDirectoryReplay` | R55 / S18、V13、V18 |


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
| C03 | 首页下拉刷新 | 只在顶部触发；拖动时整张会话列表与手指同步下移，指示器跟随显示；松手触发一次刷新后列表和指示器连续、平滑地回到原位，无分段跳动，首卡与滚动锚点无跳动；进度 / 失败仍显示在胶囊或列表空态 | M15、S18、V21 |
| C04 | 点卡片进入聊天，再右滑返回：先拖 1/4 后松手（取消），再拖过 1/3 | 从右侧滑入，首页底层压缩并加遮罩；取消时回弹；返回时跟手，回到首页后立即可点 | M07–M08、V13 |
| C05 | 聊天中上滑阅读，等待新消息 / 流式到达，再点“回到最新” | 阅读位置不被抢；超过三行显示“回到最新”；点击后恢复跟随；流式文字按顺序逐字出现（r15 后） | V01–V04、M04 |
| C06 | 聚焦输入框，输入多行，打开 Slash 菜单 | 输入框为凹槽并显示柔和双环；键盘上移输入区，顶栏不动；Slash 菜单在键盘上方 | S12、S17、V08 |
| C07 | 展开 / 收起 thinking 与工具卡；打开工具详情 | 约 260ms 自然高度折叠；展开状态保留；详情可分页、可关闭 | M03、S20、V14 |
| C08 | 触发审批 / 问卷，提交与取消 | 单项确认浮在输入区上方，提交时 composer 不位移；多步骤间草稿保留 | V07、M12 |
| C09 | 首页卡片左滑：短滑后松手，再滑过半宽 | 短滑回弹；越过半宽时提示“松手关闭”并触觉一次；退回“关闭”同样触觉一次，同手势反复跨阈值持续反馈，同侧移动和松手 / 回弹不追加；松手后退场；多选模式下不触发 | M10、M12、V11 |
| C10 | 长按卡片进入多选，再点选和退出 | 每次有效选中或取消触觉一次，首次长按不重复；选中按r31从本次触点260ms扩散，取消160ms；卡片几何不变 | S15、M06、M12 |
| C11 | 从左缘拖开目录，折叠 / 展开目录，搜索，归档 / 恢复 | 抽屉跟手吸附；折叠后高度立即收缩；一次只展开一个目录 | M09、S19、V17 |
| C12 | 打开设置页（r15 前由“更多操作 › 连接状态”进入，r15 后点右上角齿轮）；检查当前连接事实行；点配额币；打开供应商切换 | 分区顺序正确，底部另有“外观”单选分区；连接延迟以整数毫秒显示，无样本时为“暂不可用”；供应商卡片区（r15 后位于最上方）：44pt/dp 环、固定角标、左倾 24° 实体厚边翻面（r37，R58）；切换菜单透明无底色 | S19、S22–S23、M14 |
| C13 | 打开首页下载页；整卡暂停 / 继续，长按多选 | 没有旁置按钮；长按多选；r15 后可从右侧滑入、右滑返回首页 | S20、S15、M14 |
| C14 | 在 Codex 长回合（多次工具调用，消息超过 4 条）结束后查看轮次文件概况；Pi 一轮改动超过 4 个文件时，先直接点击预览中的 `.kt` / `.md` 文件，再展开完整清单后打开作对照；查看器入场期间注入完整清单与首段 diff；关闭重开并左右切换文件；正文滚到中段后快速向下甩回顶部并继续下拉 / 快甩；再从标题区短拉、长拉 | 概况卡在整轮最后一行之后，不在回合中段；概况是单个内凹块，标题行可点开查看器，每个文件一行、状态字母颜色正确，长文件名不被目录挤压，未知行数显示短状态而非“+— −—”；预览升级为完整清单时不崩溃、不改选中文件，直接打开与先展开清单具有相同查看语义；跟手、落位、首尾回弹；只请求已落位文件的详情；正文到顶只在差异区内回弹，卡片不移动不关闭；标题区短拉回弹、长拉或快甩关闭，滑出过程中仍显示当前文件、不变成空白或加载态 | S21、M13、V19 |
| C15 | 用户消息长按切换页顶栏后复制；助手 / 代码沿用原入口 | 原位对勾，2.5 秒后恢复；重复复制重置计时 | M05、V16 |
| C16 | 切换明暗及经典 / 雾蓝外观后重看 C01、C04、C12 | 明暗四层底板；单层材质外框；柔影方向正确，没有纯黑硬边；选择即时生效 | S01–S04、S25 |
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

### 4.7 Claude 启动与运行中发送专项

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R17 | 隔离 Host / Claude TUI 中启动长回合，在 App 连发两条 follow-up；观察当前输出与工具；停止主回合；再分别测试正常结束、子 Agent 先结束和 Host 重连 | 当前回合继续同步，停止可达；子 Agent 结束不触发主回合 follow-up；主回合结束且 Host 轮末捕获完成后顺序提交，每条只执行一次；原生用户行消除待确认状态；旧代次消息不补发到新 Host。两端分别保留发送前、运行中、落地截图及事件顺序证据 | V10、V12、V17 |

| R29 | 两端 App 分别选择尚未信任的新项目打开 Claude，再从子目录 / linked worktree 恢复；重复自定义配置目录、配置损坏和写入占用场景。macOS / Windows 分别核对实际终端与 hello | 首次启动直接进入 TUI 并由匹配 launchId 的 hello 完成连接；只信任目标仓库，其他项目 / 工具权限 / MCP 配置不变；损坏或占用明确失败且不开窗，不能提前显示已连接。保存配置字段差异（不含凭据）、启动与握手证据 | V12、V17–V18 |
| R18 | 隔离 Claude 主回合含工具和多段正文，步骤落盘时保持运行；立即开始下一轮，重复相同短回复；延迟磁盘写入超过 3 秒；再重连。补测超过 256 条历史的 resume、继续发送 / 回复及关闭 App 后重开。两端明暗录屏，抽查窄屏 / 减少动画 | 每个步骤的正文与 thinking 只出现一份；同文的不同轮都保留；旧轮清理与迟到结束不删下一轮；已声明但未落盘的正文保留，后续原子交接；工具卡与阅读锚点连续。长历史恢复后 Host preview 与原生最新 head 一致，seq 继续推进，新消息重开仍可见。需保存步骤 UUID / patch 顺序，不能以文本去重通过 | V09–V10、V16–V18（关联 V02–V03、V20） |
| R42 | 隔离 Host 先打开 Claude，再连接两端 App 并停留首页；加入第二个未选中 Claude，会话历史保持慢读；分别测试无审批、有待答审批、仅 Hook 在线与重连 / 重新加载，按 A1–A4 检查连接胶囊及卡片 | 首次 `agent.state.request` 的 identity / execution / interactions 均完整可用；没有审批时是明确空清单，有审批时保留真实等待状态。首页准备不依赖 `session.sync` 完成，不出现由交互清单 unknown 引起的“同步失败”；原有卡片 / 列表视口保持，真实读取失败仍显示原因与重试 | S18、V16、V18 |

### 4.9 全状态用户输入专项（ADR-0055）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R24 | 两端各 Agent 在 idle、运行、审批等待、独立 / 自动压缩、停止和恢复 / 断线时，按 ADR-0055 矩阵提交文本+附件、followUp / steer、Slash、回答和撤回；覆盖受理、成功、明确失败与未确认；明暗 / 窄屏 / 大字体 / 减少动画 | 每项有责任拥有者和明确结果；不支持给出原因；未确认不自动重发；队列可核对，无重复或永久发送中，失败正文 / 附件可找回，状态更新不抢阅读位置。真实后端缺口单独登记 | V05、V09–V10、V12、V16–V18 |

### 4.10 Codex 桌面新会话同步专项

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R25 | 两端分别连接隔离 Host，保留至少一张既有卡片，在 APP 新建 Codex 桌面版会话；回首页后再新建一条；下拉刷新；模拟一次模型读取失败后点胶囊重试；另以终端 Codex 作对照。全程保持 APP 和 E2E 连接，不重启；A1 / A2，A3 / A4 抽查 | 准备时保留旧完整卡片，identity / execution / interactions 齐备后一次发布新卡片并退出“正在同步”；正常新建不常驻“同步失败”；失败后的重试也能恢复，不依赖重新握手；桌面公共 ID 不进入 adapter 原生 thread 查找，无半成品卡片与位置跳变 | S18、V16–V18 |

### 4.11 用户操作乐观显示专项（ADR-0049 §5–§7，r27 决策，r32 已实施、验证中）

2026-11-01 实施（OPT-00–OPT-09、OPT-H1），2026-11-02 收尾（r32）。R26 / R27 的成功、拒绝、上传失败、启动中发送与关闭后断线路径已由预览注入的设备用例脚本化执行并逐张审阅截图；60 秒无回执、撤回 / 回答 / 归档的断线与真实 Host 路径只有单元覆盖。人工逐项未执行，不记为通过。拒绝、无回执和断线使用预览注入或隔离 Host，不连接生产 Host。

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R26 | 两端分别做以下操作，各自走成功、Host 拒绝、60 秒无回执、断线后重连四条路径：撤回排队消息，另加撤回时恰好投递；目录中单项与多选归档、取消归档；回答单项审批与多步骤问卷，另加电脑端先答、请求过期；关闭通知。上滑阅读时重复一次；明暗、窄屏、大字体、减少动画 | 点击后立即退场或移到目标列表；回答后面板收起，原位显示摘要，敏感输入只显示“已提交”；App 回答成功后顶部不得再出现“交互已完成”，另一设备的请求同步移除；电脑端完成、取消、超时与提交失败仍显示对应事实。拒绝时在原位置恢复并说明原因，答案保留；撤回已投递时提示“已交给 Agent”，消息只在聊天出现一次；请求失效时显示事实。无回执转“未确认”并重新读取，不自动重试；断线时列表类保持呈现，重连后核对；通知只在本设备消失。阅读锚点与列表视口不动，无闪回 | V22、V07（关联 V02–V03、V06、V16–V17、V21） |
| R27 | 两端：附件上传中点发送，再连发一条纯文本；上传失败、取消上传。执行 prompt / skill Slash。idle 时切换模型或思考级别，确认前发送；分别模拟确认、规范化、拒绝、无回执、连续两次选择。新建会话与恢复会话，启动中输入草稿并发送；分别模拟启动成功、失败、超时，以及启动中返回首页。首页左滑关闭后断线再重连。明暗、窄屏、大字体、减少动画 | 气泡立即出现，输入框清空，标明在等什么；同会话按创建顺序提交，后一条不越过前一条；附件失败只影响本条，可重试 / 放回 / 删除。配置确认前不以旧配置执行，失败时选择器回到确认值，等待中的消息转失败，可按当前配置发送。Slash 气泡由权威行替换且只出现一次。新建 / 恢复立即进入聊天页，显示“启动中”，失败原位显示原因，草稿保留。关闭断线期间卡片保持隐藏，重连后仍在线则恢复并提示 | V10–V12（关联 M07、M14、V05、V09、V13、V17） |

### 4.12 原生 Codex 文件审阅专项（ADR-0052 §9.1）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R28 | 隔离 Codex terminal / Desktop 各执行一轮：原生 patch 连续修改同一文件，同时在外部修改另一文件；再分别拒绝、部分失败、取消文件工具，并回放空 diff；两端明暗 / 窄屏 / 大字 / 减少动画查看卡片、展开清单、打开 / 滑动详情及重启重读 | 卡片只展示原生 tracker 已记录的净变化，提示“仅记录 Codex 文件工具变更”，详情范围为“Codex 文件工具”；提议不算成功，未知或空 diff 失效不伪报零变化；外部工作区变化不从快照混入；未选中文件无详情请求，历史固定、版本 / 缓存 / 手势规则保持；不宣称 shell 全覆盖或逐行独占归属 | S21、M13、V19 |

### 4.13 各 Agent 首次准备专项（ADR-0056）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R30 | 两端分别启动 / 恢复 Pi TUI/RPC、Codex TUI/Desktop、Claude、DeepSeek ACP/Web；测试新项目、已有信任、自定义配置目录、显式禁用 / 管理拒绝、坏配置、账号缺失和原生无响应。Claude 添加具名项目 MCP 和明确拒绝项；桌面 setup 验证仍能登录。macOS / Windows 分别核对开窗；A1–A4 检查错误全文、重试、草稿和返回 | 所选项目资源在授权范围内加载；正常工具审批仍出现；不批准被明确拒绝的 MCP、不回答 OAuth / MFA；写入失败不创建新 thread 或留下等待；进程 / 窗口成功不提前显示连接成功，原生握手或明确失败才终结。完整账户初始化等未支持路径单独记缺口，不记为通过 | S16、V12、V16–V18 |
| R32 | 分别在 Windows / macOS Host 未带 `--dsh`、未预启动 DeepSeek，及未带 `--codex` 的场景配对 iOS / Android。测试 DeepSeek 服务已运行但 Host 未接入、服务未运行、已有 DSH runtime；Codex Desktop 已打开且已接入、未打开、未包装的既有实例；再分别新建与恢复会话，并快速连续提交两次请求 | 新建页将可启动的 DeepSeek / Codex Desktop 显示为可选，`agents` 未就绪时仍不假报在线。已接入的 runtime 直接复用；未接入时 Host 仅启动一次 / 连接现有 DSH 服务，等待真实握手后才创建或恢复；两个请求共用后端准备且不重复创建同一请求。未安装、坏配置、接入失败或超时有明确错误，不能留下 pending / 假成功。Host 设置项清楚标明只控制预启动。记录两端明暗截图、请求 / 握手顺序、进程与服务 PID、会话 ID 及失败回执；用 A1–A4 核对错误全文、重试、草稿和返回 | S20、X03、V12、V16–V18 |

### 最近提问提示专项（ADR-0057 / S24）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R31 | 打开含长回复的会话，先保持跟随，再上翻；滚到原提问与更早轮次；点击提示，再回到最新。加入连续同文提问、长多行/emoji/附件问题、本地发送失败/未确认、源端新问题、通知、补页及分支/电脑切换；重复明暗、窄屏大字、减少动画及宽屏 | 初始不显示；主动阅读离底部三行且原问题不可见后显示两行预览；原问题可见和回到最新收起。点击只定位原消息、保留非跟随，不自动分页。源端更新不带走锚点，不把本地待确认消息当已发送问题；通知优先、隔离无残留。浮层出现前后正文/输入区几何不变；r31按220ms从右32/上12滑入、160ms逆向退出，无尺寸动画，减少动画直切；辅助功能保留全文，触控至少48pt/dp | S24（关联 S10、S13、S17、V01–V04、V06、V09、V17–V18） |


### r31 共用交互动效专项

| 编号 | 步骤 | 预期 | ID / ticket |
| --- | --- | --- | --- |
| R33 | 左滑跨阈值再退回、再次跨阈值松手；拒绝/断线/换电脑；录屏逐帧检查反向切回“关闭”及淡变结束 | 提示槽宽度稳定，文字不得在淡变期间或结束时重新居中跳位；红灰平滑；每次进入 / 退出阈值各触觉一次，单手势至少反复三轮，同侧移动及松手 / 回弹不追加；卡片完全滑出再收拢；恢复不串身份 | M10 / MOT-02 |
| R34 | 首页、目录、下载、供应商分别长按和触点不同时逐项选择；快速反选和退出 | 蓝底从各自触点展开；工具栏线段旋转/合拢/渐显；几何和确认取消保持 | S15、M06 / MOT-03 |
| R35 | 所有菜单入口四角/窄屏展开；电脑二级进入返回；连续操作/系统返回/切电脑 | 从锚点翻开；容器先变形再侧向翻页；返回相反且只退一层 | M18 / MOT-04 |
| R36 | 当前聊天、长文本、附件、历史预览和离线消息长按；复制、Rewind、滚动及文字选择 | r35 应用页顶栏切换为操作栏，常驻下方操作移除；pending恢复区仍在；不推动正文/绕过确认 | S10、M19 / MOT-05 |
| R37 | 文本、多行、附件、运行中排队、重试、连发、断线、上翻阅读中发送 | 先右后上；准确身份交接；不追新、不重播、不飞向不存在的行 | M17 / MOT-06 |
| R38 | 上翻触发最近提问，原文进入视野/点击/通知覆盖/新问题/换会话 | 右上滑入、原路滑出；末帧前内容保留，阅读锚点不动 | S24 / MOT-07 |
| R39 | 按SC19–SC27逐入口点击图标，重复点击、禁用、减少动画 | 下载箭头弹、设置和历史旋转，其他轻弹；48命中不变，无重复专属动画 | M20 / MOT-08 |
| R40 | Android整页左右边缘取消/完成/三层返回；菜单、IME、多选、Sheet和根页对照；iOS仅在保留可选增强时测双侧，否则验证原返回无回归 | 压缩顶层露来源；返回优先级正确，无双重pop或丢草稿/锚点；iOS不可为新增边缘行为牺牲文字选择/横滚/Sheet | M08、M14 / MOT-09 |

每项 A1–A4，包含起始、1/3、2/3、末帧、反向与取消证据；共用组件接入不能免除调用方手动检查。C10 的160ms旧选中淡入在r31实施后改按触点260ms扩散、取消160ms验证，不删除其他断言。C15复制的用户消息入口改为长按操作栏，助手/代码保持原入口。

### DSH 内部上下文与用户队列专项

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R41 | 两端连接隔离 DSH：idle 时切换权限；运行中产生子代理汇报与后台完成通知，再夹入 App followUp、浏览器 steer 和同文消息；断线重连、退出重进并撤回真实用户队列项。原生 inbox 包含超过 256 条内部通知时重复检查；A1–A4 与上翻阅读状态对照 | 内部上下文供 Agent 正常消费，但不显示为用户排队消息、不创建用户气泡或结算 App 发送回执；权限切换不发起模型请求。真实用户消息按来源身份显示且可正常撤回 / 投递；完整内部清单确认 App 队列为空，不因内部通知容量或缺少用户消息字段变成不完整；阅读锚点与会话 / 电脑隔离保持 | V09–V10、V12、V17 |

### iOS 同步拒收与终态重放专项

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R43 | iOS 连接隔离 Host：首份同步已 applied 后延迟 30 秒重放同 commandId / syncId 请求，再发送冲突 rejected 和迟到 socket 失败；另在未确认首份响应重派 queued / processing 时送达首份 applied；回放旧 preview 晚于完整新 patch、工具依赖尚未齐的旧 preview 和非法 checkpoint。上翻阅读并按 A1–A4 检查状态 / 错误 / 重试 | 已提交任务不再生成快照且终态不翻转；合法迟到 ACK 结束等待并释放预留，不发送第二份响应。从未发送响应 / 已 abort 的 ACK 不复活事务。已完整提交的新 source 保持消息与阅读位置、旧包仍 rejected；不完整新状态有具体恢复提示；Host 同码回声不覆盖已有具体原因，不相关错误仍可见。保存 commandId / syncId、source epoch / seq、ACK 与派发计数，不保存会话正文 | V05–V06、V16–V18 |

### 4.10 雾蓝外观专项（ADR-0059）

| 编号 | 步骤 | 预期 | ID |
| --- | --- | --- | --- |
| R44 | 两端设置页切换“经典 / 雾蓝”，离开设置到首页、目录、聊天输入、下载再返回；有草稿与上翻阅读时切换；重启 App。两种外观各在 A1 / A2、A3 窄屏大字、A4 减少动画下截图，对照参考图检查底板、输入凹陷、按钮层次与文字对比 | 选择即时且持久，默认/未知值为经典；设置页选中内凹、蓝色文字和对勾。雾蓝底板为浅灰蓝或深蓝灰，输入与选中态有上白下灰柔和内影；导航、草稿、阅读位置、消息身份、状态和触控尺寸不变，不出现双层阴影或硬边 | S01–S04、S12、S19、S22、S25 |

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

2026-11-03 Android 配置切换输入按钮（V05、V10、V12；R27）：修复 composer 等待被配置账本独占消费的通用回执，受理后清空命令并解除输入等待，确认 / 拒绝 / 未确认仍由配置账本负责。修复前生产 composer 设备专项7项6失败，覆盖Codex/Pi模型与思考、重复选择、拒绝；修复后7/7，A1–A4各7/7，673项JVM及两包构建通过。候选全量178项165过 / 6失败 / 7外部条件未满足；5项在当次基线亦失败，额外顶栏Compose空闲超时在原设备整类对照中基线 / 候选各2/2通过，首轮仍保留。基线第155项配额UI ANR，仅154项完成，不能宣称全量门禁通过。设备会话曾发生UiAutomation连接/断开异常，重借后专项恢复；本任务设置已还原，残留锁按owner / 进程 / 端口核对后释放。已看相关普通 / 深色 / 大字截图，完整L4、人工C01–C18、完整R27和真实Host未执行。工作区有并发配额改动，最终构建使用排除该未完成改动的隔离副本，本次修复及测试与共享文件一致；未部署用户手机。证据与准确边界见 `.artifacts/ui-regression/20261103-config-composer/summary.md`。

2026-11-03 Claude 长会话恢复同步（V09–V10、V16–V18 / R18）：对运行中 Host 的加密 LAN 探针确认旧 preview 的 `seq=0` 停滞及最新 head 拒收；257 / 1,055 条历史复现，255 / 256 条对照正常。修复前新增 4 项回归失败，修复后相关 Node 65 项、TypeScript / lint、Android JVM 681 项 / 两包构建、Swift Core 351 项通过。Node 全量 1,694 项为 1,685 通过 / 4 失败 / 5 条件未运行，失败整文件复测后仍有 2 项 Codex launcher 失败，未宣称全量通过。共享 Android API 35 同设备 / 同 APK：旧 Host 在追加后不再更新的断言失败，候选首次连接夹具超时、第二次在安装时模拟器退出（-6），失败证据保留。用户要求第三次重试后，候选长历史 / 后续回复 / 重建 ViewModel 与连接后的重开专项 1 / 1 通过，旧协议仍在追加后超时；模块哈希前后一致，三张关键截图已审阅，设备正常恢复设置并释放租约。完整双端 L3–L4、C01–C18、R18 人工、A1–A4 和用户真机未完成；Host 候选已打包 / 验签但未安装重启，不能记为现场恢复或 UI 验收通过。设备故障、锁清理、包哈希和未跑范围见 `.artifacts/ui-regression/20261103-claude-resume-sync/summary.md`。

回答重复提示修复：Host 加密 Relay / 通知存储 / 命令生命周期共 76 项通过，`tsc -p tsconfig.tests.json --noEmit` 通过。证据 `.artifacts/ui-regression/interaction-feedback-dedup/`。本次仅修改 Host 通知生成入口，未构建或部署运行中 Host；双端 L1–L4、C01–C18、R26 与 A1–A4 未执行，当前移动端工作树含并行未提交变更，未建立本修复的隔离设备基线，不记完整门禁或设备验收通过。

2026-11-02 iOS 同步拒收（V05–V06、V16–V18，ADR-0037 / R43）：Host 已 applied 事务不重派、首个有效 ACK 终态与响应资格修复；iOS 已完整提交的新 source 替代旧 preview，本地具体原因不被通用拒收回声覆盖。修复前 Host 两项核心回放与 iOS 三项新增用例均失败；最终 Host 相关 91 项、iOS Swift 338 项 / 32 suites、TypeScript / 修改文件 lint、App / UI Test 构建与 L0 通过。隔离候选及父提交 `765b0a3` 使用池内同一 iPad Air M4 / iOS 27 / Debug、显式 UDID 与关闭并行，42 个 App / UI Test Swift 输入仅 OrbisStore 不同。候选全量 79 项：70 通过 / 9 失败；父提交仅复核这 9 项：8 项同样失败，额外聊天入场计时父提交通过，候选重复 3 次仍 1 失败 / 2 通过，差异来源未定，不能声称失败集合未扩大。同步状态 / 错误 / 恢复与聊天刷新相关既有 UI 用例通过。导出 172 张附件并亲自查看相关 7 张；完整 L4、C01–C18、R43 真实隔离 Host / App 联动、A1–A4 与 375pt 窄屏尚未完成，不记为完整 UI 验收通过。全量 / 基线断言失败返回 65，外层重复关闭已 Shutdown 设备导致清理返回 1；确认本任务进程退出与 owner 后释放残留设备锁，计时复测正常清理，最终设备 Shutdown、设备 / 构建锁均已释放。未部署运行中的 Host 或用户真机，现场通用错误码尚不足以归因每次拒收。证据及未覆盖范围见 [修复验证记录](../../.artifacts/ui-regression/20261102-session-sync-rejected/summary.md)。

2026-11-02 Claude 首页同步（S18 / V16 / V18，ADR-0033 §16）：Host `announce` 补充完整 Hook 交互清单，不再等历史同步。新增适配器三场景在修复前均失败；修改后相关 117 项与加密首次读取、TypeScript / 修改文件 lint / L0 通过。Node 全量 1661 通过、2 项 Codex launcher 失败、5 条件未运行，整类复测仍失败。iOS 构建时 Core 338 项 / Debug 构建通过，首页定向 5 项和全量中的同 5 项均过；全量 81 项 66 过 / 15 失败。Android JVM 667 项 / 两包构建通过；首页定向与实际关闭动画各 2 / 2，全量 164 项 151 过 / 6 失败 / 7 条件未满足；全量首页 PixelCopy 失败在整类复测通过，失败类复测仍有其他 5 失败。首页 iOS 16 张、Android 20 张截图已看；其他任务在运行期间修改 iOS 源码，本轮原生结果只对应当次构建输入，不声称当前共享工作区或同设备受控基线通过。C01–C18 完整手动、R42 真 Claude 联动、完整 L4 与 iOS 窄屏 / A4 未完成，不能记为验收通过；证据与限制见 `.artifacts/ui-regression/20261102-claude-home-sync/summary.md`。本任务设备 / 构建锁已释放，Android 设置核对恢复，未部署。

2026-11-02 DSH 内部上下文 / 用户队列（V09–V10、V12、V17，R41）：Host 来源过滤与回执对账已修复。最终定向 76 项通过，新增用例用修复前适配器回放如期失败；Node 全量 1658 通过 / 5 条件跳过，类型检查与变更文件 lint 通过。隔离官方 DSH smoke 验证权限切换保留原生 `user-approval` 上下文、App 完整用户队列为空、模型请求不增加。iOS Swift 335 / Android JVM 667 与双端构建通过；池内 iPhone 17 全量 79 项为 73 通过 / 6 失败，Android API 35 全量 164 项为 153 通过 / 4 失败 / 7 外部条件未满足，隔离 Host pairing 类未运行。队列撤回、审批确认与发送对账相关用例通过；本轮未重建父提交作同设备同配置对照，不能宣称全量门禁通过。已查看两端队列、撤回与权限截图；完整 L4、C01–C18、A1–A4 和两端真实隔离 DSH 联动 R41 未完成。测试期间其他任务修改手机端及 Host 同步源码，本结果仅对应保存的构建产物与 DSH 文件，不覆盖后来的共享工作区修改。设备 / 构建租约已释放，未部署运行中的 Host。失败清单、源码 / 包哈希与未跑范围见 `.artifacts/ui-regression/20261102-dsh-inbox-source/summary.md` 和 `manual-checklist.md`，不记为完整 UI 验收通过。

2026-11-01 最近提问提示（S24 / ADR-0057）：iOS 233 核心测试与 App / UI Test 构建、Android 568 JVM 测试和 APK 构建通过；Android 提醒专项 4 项通过，全量 146 项 4 失败均属于同设备基线 139 项 5 失败集合。iOS 新增定向用例发现刷新后锚点断言失败，完整设备 / 手动及 A1–A5 未完成，不记为验收通过。证据见 `.artifacts/ui-regression/20261101-question-reminder/summary.md`。

2026-11-01 各 Agent 启动准备：源码已补项目授权、部分启动前检查和失败收尾；Pi 原生隔离 RPC 信任对照、Codex 原生配置服务、Claude composer / 项目 MCP smoke 有证据。Windows、DSH 真后端及双端完整 L1–L4 / 手动 / R29–R30 尚未验收；当前 Host 安装包未部署。最终 Host 检查结果、失败与未跑清单见 `.artifacts/ui-regression/20261101-agent-startup/summary.md`，不得称全部首次审批已解决。

2026-11-02 用户操作乐观显示收尾（r32，合入 main `706a1bd` 与 `fdcd0fc` 后）：iOS SwiftPM 335 项、Android JVM 667 项、Host / protocol / bridge / Pi 扩展 1554 项通过。新增 iOS 4 项设备用例（上传中发送、上传失败与顺序、启动中发送后上线及输入焦点、关闭后断线重连）、Android `LaunchPageInstrumentedTest` 3 项与上传气泡 1 项；定向首轮暴露并修正：iOS“Runtime 先于 session.activated 上线”时等待消息不写入、启动页输入焦点丢失，Android 启动页不显示启动中写的消息，两端启动状态色不一致（Android 显示为错误红）。iOS 池内 iPhone 17 全量 79 项：74 通过、5 失败（`testAddComputerPageReboundsAndSwipesBack`、`testDrawerCollapseShrinksContentWithoutAnotherDrag`、`testLongTranscriptAppearsAndToolExpansionKeepsItsPositionWithoutDragging` 与两项最近提问提示），main `fdcd0fc` 构建同设备重跑这 5 项同样失败；新增与既有乐观用例全部通过。首轮全量因 UI 测试编译错误实际执行的是旧产物，已作废并在修正后重跑。A3：池内 iPhone SE（375pt）外观矩阵与新增用例通过；XXXL 截图发现状态行的转圈随动态字体放大、溢出 26pt 槽位遮挡“上传中 / 发送中”文字，限定为小号后重跑通过。 Android 池内 `Orbis_UI_Polish_35` 全量 163 项：140 通过、13 失败；4 项（`CodexPermissions` 自由文本、`Dsh` 新建、`Questionnaire` 草稿、`SessionHostOwnership`）main 构建同设备同样失败；9 项（`InteractionMotion` 6、`SwipeBack` 3）因设备系统动画缩放为 0（中止的首轮全量使 `InteractionReducedMotion` 的恢复未执行），按 2026-11-01 记录恢复为 1 后 `SwipeBack` 3 / 3、`InteractionReducedMotion` 1 / 1、`InteractionMotion` 逐方法 7 / 7 通过，动画为 0 时被跳过的 `DownloadFlight`、`StreamingReveal` 重跑 2 / 2；整类运行时 `predictiveBack…` 截图得到 `DeadObjectException` 使仪器输出中断，main 构建同样如此。池内 API 37 设备与当前 Espresso 不兼容（`InputManager.getInstance`），池内只有一台兼容的 Android 设备。A2–A4：Android 乐观 / 启动页 9 项在夜间（切换后等待 20 秒）、字体 1.5、关闭动画下各 9 / 9，设备设置以只读启动核对已恢复；iOS 外观矩阵加入上传气泡。L4 已逐张查看新增截图。C01–C18、R26 / R27 人工逐项与真实 Host 未执行，不记为通过。证据：`.artifacts/ui-regression/2026-11-02-optimistic-merge/`。

2026-11-01 用户操作乐观显示（分支原 r31，合并后为 r32 / V07、V10–V12、V22，ADR-0049 OPT-00–OPT-10）：iOS SwiftPM 331 项、Android JVM 664 项、Host 相关用例与两端构建通过。iOS 池内 iPhone 17 全量 67 项 59 通过、8 失败，main `e4df87a` 同设备重跑 8 项同样失败；审批与交互草稿两项为预览夹具问题（`interactions` 领域被声明为空），修正夹具后通过，并新增审批拒绝、启动失败原位、模型切换中发送与 A1–A4 外观矩阵 4 项；截图审阅发现 iOS 启动页标题显示占位 id，已修正并加断言。Android 池内 `Orbis_UI_Polish_35`：151 项 138 通过、5 失败、8 项需隔离 Host 跳过；归档多选一项断言旧行为，改写后通过，其余 4 项（`CodexPermissions` 自由文本、`Dsh` 新建文案、`Questionnaire` 草稿、`SessionHostOwnership`）main 同设备同样失败；新增`OptimisticPresentationInstrumentedTest` 5 项通过。本机 adb 服务在运行中多次崩溃重启，改用私有端口与逐类 `am instrument`，输出中断的类按设备 logcat 的 `run finished` 核对后重跑。A1–A4：Android 夜间 / 字体 1.5 / 关闭动画下 `OptimisticPresentationInstrumentedTest` 各 5 项通过，设备设置用后恢复；iOS 外观矩阵在 iPhone 17 与 iPhone SE（375pt）运行。L4 已逐张查看相关截图，并用录屏抽帧核对启动失败原位。C01–C18、R26 / R27 人工逐项与真实 Host 未执行，不记为通过。证据：`.artifacts/ui-regression/2026-11-01-optimistic-actions/opt-10/`。

2026-11-01 App 按需启动 DeepSeek / Codex Desktop（r30 / S20、X03、V12、V16–V18）：Host / DesktopRuntime 61 项与生命周期 13 项通过，2 项 Windows 条件未运行；类型检查、lint、Android JVM 571 项 / 两包构建、Swift Core 237 项通过。iPhone 17 全量 67 项为 55 通过 / 12 失败；新增 DeepSeek 用例的原生辅助功能标签定位修正后，新建页整组 2 项通过，并覆盖明暗、XXXL、减少动画。110 张全量命名截图联系表与 5 张专项截图已查看，不能替代完整 L4 / 手动。Android 在两次设备尝试中分别发生 ADB 断开、ADB `libunwind` 崩溃，没有有效仪器结果。未重建父提交作受控基线；C01–C18、375pt、R32 真后端与 Windows 仍未验收。iOS 原开关机状态已恢复；Android 只进入浅色标准配置，所设值与保存原值相同，未进入深色 / 大字 / 减少动画。本轮设备进程已退出且租约已释放。R31 保留给最近提问提示，本专项使用 R32。证据、12 项完整失败和未跑清单见 `.artifacts/ui-regression/20261101-agent-on-demand/summary.md`，未部署。

2026-11-01 Codex 桌面新会话同步：Host 公共 Session / 原生 thread ID 边界修复已用回放验证“修复前桌面失败、终端通过；修复后两者通过”，相关 Host 236 项全过。隔离 Node 全量失败集合与基线相同；Android 549 项、Swift 224 项与双端构建通过；iOS 首页同步专项 5 项通过，全量为 54 通过 / 7 失败，111 张命名全量截图及专项 16 张已查看。Android 设备回归因共享池兼容设备连续被其他任务独占而未运行；完整手动 C01–C18 / R25 未完成，不能记为全量验收。最终状态与失败见 `.artifacts/ui-regression/20261101-new-session-sync/summary.md`。

2026-11-01 设置延迟（S23 / UI-07）：两端单元 / 构建和设置页定向通过；Android API 35 全量 138 项的 7 失败与同设备 / 同配置基线一致，A3 / A4 各 3 项定向通过。iOS SE 全量 61 项 7 失败，基线为 6 失败；新增压缩状态等待失败，A3 组内复核（含设置 / 返回）4 项通过，首轮失败仍保留。Host 早期全量 1537 通过 / 5 跳过，后续并发输入生命周期改动期间复跑有 3 项失败；延迟专项通过。两端附件已审阅，独立手动 C01–C18 与完整外观门禁未完成，不记为完整验收通过。证据见 `.artifacts/ui-regression/20261101-settings-latency/summary.md`。

2026-11-01 Codex 原生文件变更（S21 / V19，M13 保持）：协议 18 接入 Codex terminal / Desktop 同轮原生 diff 与文件工具来源；Host 不以工作区快照补齐未知变化。Node 限并发 1,645 / 1,650 通过、0 失败、5 项条件未运行；iOS Swift 230 项及 Debug 构建、Android JVM 565 项及 Debug / AndroidTest 构建通过，Android 文件审阅四种配置各 6 项通过。Android 全量 L3 为 129 通过 / 7 失败 / 7 条件未满足，失败名称匹配 10 月 31 日记录，本轮未重建父版本作受控对照。iPhone 17 / iPad Air 原生文件审阅专项各 4 / 4；iPhone 17 全量 L3 为 56 / 64、8 失败，其中 7 个名称与此前同设备记录相同，额外聊天入口计时失败单项重跑通过但仍保留为间歇失败。手动续跑在 iPad Air / SE 直接操作，并用 UI 测试辅助录屏后亲自核对：SE 明暗各 18 项均 16 过 / 2 失败，另补 9 / 9；Android 十组 132 次为 124 过 / 8 次失败，返回 / 归档补跑 14 / 14，设置入口单项重跑通过仍保留首轮超时。已查看 iOS 全量 117 张有效附件的命名联系表、SE 明暗 / 补跑及 Android A1–A4 概览；文件审阅主流程与 iPhone 标题关闭连续帧已核对，Android 关闭中间帧仍缺。审批 / 问卷、深色首页交互、电脑归属失败，以及冷启动、多行软键盘、第二电脑正常同步等缺口均记录到逐项清单；UI 用例数量不等于 C01–C18 通过数。保留 r28 应用与捕获的当前 iOS 测试驱动存在版本边界，不宣称共享工作树当前源码全通过。设备设置已恢复，本任务租约已释放。完整手动 / L4 和 R28 真实 Codex / Desktop 模型轮次仍未通过；未部署。详见 `.artifacts/ui-regression/20261101-native-codex-file-changes/` 下的 `report.json`、`manual-checklist.md` 和 `manual-resume/summary.json`，不得记为验收通过。

2026-10-31 全量健康检查（`157dc2d`，r24，不修改产品源码）：Node 1536 通过 / 5 跳过，Swift 223 项与 Android JVM 548 项通过，两端构建通过；iOS 全量 61 项为 53 通过 / 8 失败；Android 标准动画与 1.0 字体配置全量 138 项为 124 通过 / 7 失败 / 7 跳过。另补跑原跳过的 5 项隔离夹具，3 通过 / 2 失败，剩余真实环境专项未运行。命名截图已审阅，完整手动清单及连续录屏门禁未完成，不记为全量验收通过。失败、配置差异与证据见 [本轮回归记录](ui-regression-2026-10-31-full-audit.md)。

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

2026-11-02 雾蓝外观（r34 / S25）：双端主题 token、设置切换及持久化已实现；Swift 341 项、两端构建与 Android JVM 通过。iOS 全量 83 项为 77 通过 / 6 失败；Android 设置 / 材质 / 配额受影响整类重试通过，但全量因 ADB 断连未完成。两端浅色 / 深色设置截图已审阅；iOS 375pt 设置切换、Android 字体 1.5 + 关闭动画定向通过，Android 系统设置已恢复。L4 全量、C01–C18、R44 全页面、完整 A3–A4 和同设备父提交对照未完成，不记为验收通过。证据见 `.artifacts/ui-regression/20261102-inset-focus/summary.md`。

2026-11-02 S25 显示名称修订：设置页选项改为“雾蓝”，内部选择值 `insetFocus` 不变。L0、iOS 设置页定向 UI 1 / 1、Android Debug 与 AndroidTest 构建通过；Android 设置页定向测试因 ADB 在安装时断连未运行。全量、同设备基线及 C01–C18 / R44 / A1–A4 未补跑，维持未验收；本次证据见 `.artifacts/ui-regression/20261102-fog-blue-rename/summary.md`。

## r35 交互动效补充（已接入，验证中）

| 编号 | 专项 / ticket | 验收 | ID |
| --- | --- | --- | --- |
| R45 | 系统边缘缩小、双侧缝隙及完整右滑退场 / MOT-11 | ADR-0058 SC33 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | M08、M14 |
| R46 | 共用离散文字切换与出现 / MOT-12 | ADR-0058 SC34 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | M21、V05、V16 |
| R47 | 按下即时反馈与来源保留 / MOT-13 | ADR-0058 SC35 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | M20、V13 |
| R48 | 目录筛选集合过渡 / MOT-14 | ADR-0058 SC36 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | M22、V21 |
| R49 | 旋转按下整圈 / 松开返回与系统反馈 / MOT-15 | ADR-0058 SC37 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | M20、M12 |
| R50 | 每项选中和取消的触觉 / MOT-16 | ADR-0058 SC38 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | M06、M12 |
| R51 | Host 侧栏凹陷过渡和滚动统计 / MOT-17 | ADR-0058 SC39 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | X03、X05 |
| R52 | 新建卡片追加与启动导航交接 / MOT-18 | ADR-0058 SC40 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | M23、V12、V17 |
| R53 | 消息长按替换页顶状态栏 / MOT-19 | ADR-0058 SC41 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | M19、S10、S17 |
| R54 | 单行提醒和最后上翻意图 / MOT-20 | ADR-0058 SC42 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | S24、V01–V03 |
| R55 | 同步期间有效卡片可交互 / MOT-21 | ADR-0058 SC43 的起始、中帧、结束、取消 / 连点 / 失效 / 减少动画；正常 / 明暗 / 窄屏大字；保留旧业务断言 | S18、V13、V18 |
| R56 | 从 App 新建 / 恢复 Codex 终端会话，重复打开已连接会话；模拟 Terminal 不可用 / 只接受 open 但脚本未执行；首轮落盘前退出；终端运行后关闭 / 重开；分别对照 Codex Desktop 选择与历史 `originator=Codex Desktop` | 用户所选后端保持；同一 backend / thread / endpoint 与手机对应且电脑有真实终端；失败显示全文并提供重试 / 返回，不报已开窗，不遗留新增空闲写锁；已有或运行中的任务不被失败打断。等待 shell 与 TUI 都能被看门狗识别，关闭前复核进程身份并确认退出，不处理桌面 / app-server；A1–A4 下草稿、失败页与导航保持。只用隔离 Host / Codex home，不改用户现场会话 | S20、V12、V17–V18、X03 |

§3.3 增补映射：MOT-11→InteractionMotion / PageNavigation 设备中帧；MOT-12/13/15/16→共用按压 / 文字 / 多选设备用例；MOT-14→目录筛选与视口；MOT-17→Qt 材质 / 页面帧；MOT-18→LaunchLedger 与新建交接；MOT-19→用户消息复制 / Rewind 与顶栏；MOT-20→ChatQuestion / 提醒滚动方向；MOT-21→HomePresentation / HomeRuntimeLoading / 首页刷新点击。具体自动用例与每轮结果见 [r35 验证记录](interaction-motion.md#2026-11-02--r35-交互细化)。双端已执行全量，受影响失败继续修复 / 复核；完整 C / R / A 尚未完成，历史失败保留。

2026-11-03 S19 / r37（MOT-22 / R58）：宣传片配额硬币的实体铜边、双面投影、扫光和220/340ms节奏已移植双端原生组件。最终隔离Swift351项、Android677项及两端构建通过，含并行图标底座修改的集成快照另构建通过。iOS SE配额专项首轮1失败后同设备2/2通过（四种外观与减少动画/XXXL）；Android配额3/3，受影响整组12/13，通用控件PixelCopy超时。iOS6张附件与实际翻面帧、Android4张组件外观图已看；Android系统全屏帧被System UI无响应弹窗干扰。资源压力下基线全量未跑完，随后共享池12项触发本任务10台上限拒绝；完整L3/L4、C01–C18、R58与Android A3未完成，不记验收。源码快照、失败、资源释放及产物边界见 `.artifacts/ui-regression/20261103-quota-coin/summary.md`。
