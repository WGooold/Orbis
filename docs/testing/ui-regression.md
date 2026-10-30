# 移动端 UI 回归方案

日期：2026-10-31。适用基线：[ADR-0051](../adr/0051-ui-style-motion-and-visual-stability-freeze.md) `2026-10-31/r19`；门禁决策见 [ADR-0053 §8](../adr/0053-settings-entry-page-motion-and-ui-regression-gate.md#8-ui-回归门禁立即生效)。

本方案规定 UI 改动完成前必须执行的自动与手动回归、新用例的编写要求和证据格式。设备、构建目录、锁与产物保留一律遵守根目录 `AGENTS.md` / `CLAUDE.md`（共享池、合计最多 5 台、独占锁、固定构建目录）。本文中的模拟器只指从共享池借用的设备，不授权新建设备。

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

**iOS `OrbisUITests`（56 项）**

| 区域 | 用例 | 主要 ID |
| --- | --- | --- |
| 首页加载 / 同步 | `testHomePublishesCompleteSnapshotsWithoutReturningToLoading`、`testHomeRetriesFailedBackgroundRuntime`、`testHomeBackgroundSyncFailureStaysInConnectionPill`、`testHomeInlineStatusInDarkAndLargeText`、`testHomeKeepsCardsAfterDirectoryReplay` | S18、V16、V18 |
| 首页手势 / 多选 / 关闭 | `testHomeVerticalDragsScrollFromCardsAndKeepSelection`、`testHomeLongListScrollsToEndInBothAppearances`、`testHomeLongPressSelectsAndClosesOnlyCheckedSessions`、`testHomeShortSwipeReboundsAndLongSwipeClosesOnlyThatRuntime`、`testSwipeCloseHidesBeforeConfirmationAndRestoresOnRejection`、`testSwipeRightFromLeftSideOpensDirectory` | S15、M06、M09–M12、V11 |
| 首页与目录入口 | `testHomeDirectorySearchAndNewSession`、`testCompactionStatusInHomeChatAndDrawer` | S19–S20、V05 |
| 目录抽屉 | `testDrawerCardsKeepUniformGeometryForShortAndLongTitles`、`testDrawerLongPressArchivesAndRestoresOnlyCheckedSessions`、`testDrawerSelectionClearsOnCancelSearchAndClose`、`testDrawerFollowsEdgeDragAndShowsOneDirectory`、`testDrawerCollapseShrinksContentWithoutAnotherDrag` | S15、S19、M06、M09、V17 |
| 聊天入场 / 返回 | `testCachedOnlineChatEntryTiming`、`testChatSwipeBackReboundsThenReturnsHome`、`testDraftSurvivesBackNavigationAndSlashRequiresSelection` | M07–M08、V13、V17 |
| 聊天视口 | `testLongTranscriptAppearsAndToolExpansionKeepsItsPositionWithoutDragging`、`testLongFinalReplyKeepsReadingPositionAndOnlyFollowsAfterJump`、`testNewMessagesAndToolsPreserveTheMovingReadingAnchor` | V01–V03、M03 |
| 聊天内容 / 顶栏 | `testRefreshKeepsHeaderTextAndTruncationStable`、`testClosedDisclosureDefersWorkAcrossChatReentryAndRetainsState`、`testUserMessageCopyAndRewind`、`testToolDetailsLoadPagesAndClose`、`testTruncatedContentAndToolArguments`、`testHistoryPreviewAndNavigation` | S10–S11、S17、S20、M03、M05、V05、V14 |
| 输入 / 审批 / 队列 | `testSlashPickerStaysAboveKeyboard`、`testOptimisticSendReconcilesAndRejectedSendRestores`、`testApprovalOverlayKeepsComposerStableWhileSubmitting`、`testQueueCancellationNotificationsAndRuntimeFacts`、`testToolExportAndInteractionDraftSwitching` | V06–V08、V10、V12、V17 |
| 连接状态 / 供应商（r15 后为设置页） | `testCompactQuotaCardsAndTransparentSwitch`、`testFixedRoutingAndStatusProviderSwitch`、`testBasicConnectionStatusAndDirectoryProviderMismatch` | S18–S19、S22 |
| 下载 | `testDownloadCardsPauseResumeAndSelectWithoutSideButtons` | S15、S20 |
| 轮次文件审阅 | `testTurnFileReviewLoadsOnlySelectedFilesAndRetainsCache`、`testTurnFileReviewDarkAppearance` | S21、M13、V19 |
| 全页面明暗 | `testPageScreenshotsInBothAppearances` | S01–S09、S16 |
| r15 设置与入口 | `testSettingsPageOrderAndSingleHostMenu` | S18、S22 |
| r15 页面转场 | `testSettingsAndDownloadsSwipeBack`、`testChatDownloadsReturnToSameChat`、`testHistoryDownloadsReturnToHistory` | M08、M14 |
| r15 流式、首页 / 目录视口与飞入 | `testStreamingRevealAdvancesInOrderAcrossBlocks`、`testStreamingRevealWithReducedMotionShowsEveryBlockImmediately`、`testHomeTopShowsNewAndPromotedSessions`、`testHomeScrolledAnchorSurvivesInsertionAndReordering`、`testDrawerScrolledSessionsKeepTheirPositionDuringCatalogUpdates`、`testDrawerTopKeepsNewAndPromotedDirectoriesVisible`、`testDownloadFlightStartsAtTapAndEndsAtButton`、`testDownloadFlightWithReducedMotionHighlightsWithoutFlying`、`testHistoryDownloadButtonAndFlight` | M04、V21、M16 |

**Android instrumentation（`androidTest`）**

| 区域 | 测试类（用例数） | 主要 ID |
| --- | --- | --- |
| 首页 | `HomeLoadingInstrumentedTest`（2）、`HomeNavigationInstrumentedTest`（3）、`HomeSelectionInstrumentedTest`（1）、`HomeSwipeCloseInstrumentedTest`（1）、`OptimisticActionsInstrumentedTest`（2） | S18、M06、M10–M12、V10–V11、V13、V18 |
| 转场 | `SwipeBackInstrumentedTest`（4）、`ChatEntryInstrumentedTest`（1） | M07–M08、V13 |
| 聊天视口 / 内容 | `ChatViewportInstrumentedTest`（8）、`DeferredDisclosureInstrumentedTest`（2）、`MarkdownInstrumentedTest`（1）、`ToolPanelInstrumentedTest`（3）、`ToolContentInstrumentedTest`（2）、`DisplayScenariosInstrumentedTest`（1）、`ClaudeHistoryInstrumentedTest`（1）、`LiveHistoryReloadInstrumentedTest`（1） | S11、S20、M03、V01–V04、V09、V14 |
| 顶栏 / 输入 / 交互 | `ChatStatusLayoutInstrumentedTest`（2）、`ComposerSessionInfoInstrumentedTest`（3）、`InteractionWorkspaceInstrumentedTest`（5）、`QuestionnaireInstrumentedTest`（2）、`CodexPermissionsInstrumentedTest`（3）、`NotificationsInstrumentedTest`（2）、`DshInstrumentedTest`（2） | S12、S17、V05–V08、V12、V17 |
| 目录 | `SessionDrawerLayoutInstrumentedTest`（2）、`SessionArchiveSelectionInstrumentedTest`（3）、`SessionProviderFilterInstrumentedTest`（3）、`SessionHostOwnershipInstrumentedTest`（3） | S15、S19、M06、M09、V17 |
| 状态 / 供应商 | `SubscriptionQuotaInstrumentedTest`（1）、`ProviderSelectionInstrumentedTest`（1） | S19、S22 |
| 下载 / 文件 | `DownloadFileBrowserInstrumentedTest`（3）、`TurnFileChangesInstrumentedTest`（3） | S09、S15、S20–S21、M13、V19 |
| 材质 / 字形 / 控件 | `UiPolishInstrumentedTest`（3）、`NeumorphInstrumentedTest`（1） | S01–S09、S12、M04、V15 |
| 非 UI 但在同一设备套件 | `SessionGraphStoreInstrumentedTest`（32）、`SessionSyncSelectionInstrumentedTest`（6）、`SessionSyncSlowLinkInstrumentedTest`（2） | 缓存 / 同步正确性，全量时一并运行 |
| 需要隔离 Host | `IsolatedHostPairingInstrumentedTest`（1）；`ToolContinuityCaptureInstrumentedTest`（1，无参数时自动跳过，传入配对载荷与 cwd 时做真实输出逐帧捕获） | 配对；V20 定位 |
| r15 首页 / 目录视口与下拉刷新 | `HomeViewportInstrumentedTest`（5）、`SessionDrawerViewportInstrumentedTest`（3） | M15、V21 |
| r15 设置与入口 | `SettingsEntryInstrumentedTest`（3） | S18、S22 |
| r15 页面转场 | `SwipeBackPagesInstrumentedTest`（2，位于 `SwipeBackInstrumentedTest.kt`） | M14 |
| r15 下载飞入 | `DownloadFlightInstrumentedTest`（1） | M16 |
| r15 流式顺序 | `StreamingRevealInstrumentedTest`（1）；`UiPolishInstrumentedTest#revealKeepsEmojiAndCombiningCharactersTogether` 改用新时钟 | M04 |

与 UI 相关的单元测试（L1 中必须通过）：iOS `RevealClockTests`、`HomeRuntimeLoadingTests`、`StoreTests`、`AgentStateTests`、`PendingSendTests`、`PresentationTests`、`TurnFileChangesTests`；Android `HomePresentationTest`、`ChatListItemReuseTest`、`HistoryPagingTest`、`MessagePresentationTest`、`StatusScreenTest`、`SubscriptionQuotaTest`、`UiPolishTest`、`PendingSendsTest`、`TurnFileChangesTest`、`RevealScheduleTest`、`HomeViewportAnchorTest`。

带 `assumeTrue(ValueAnimator.areAnimatorsEnabled())` 的设备用例（下载飞入、流式顺序）在系统关闭动画时跳过，A4 路径以手动检查为准。

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
| C03 | 首页下拉刷新（Android 在 r15 实施后检查） | 只在顶部可拉；指示器在请求发出后收起；卡片与视口不跳；同步进度显示在胶囊 | M15、S18、V21 |
| C04 | 点卡片进入聊天，再右滑返回：先拖 1/4 后松手（取消），再拖过 1/3 | 从右侧滑入，首页底层压缩并加遮罩；取消时回弹；返回时跟手，回到首页后立即可点 | M07–M08、V13 |
| C05 | 聊天中上滑阅读，等待新消息 / 流式到达，再点“回到最新” | 阅读位置不被抢；超过三行显示“回到最新”；点击后恢复跟随；流式文字按顺序逐字出现（r15 后） | V01–V04、M04 |
| C06 | 聚焦输入框，输入多行，打开 Slash 菜单 | 输入框为凹槽并显示柔和双环；键盘上移输入区，顶栏不动；Slash 菜单在键盘上方 | S12、S17、V08 |
| C07 | 展开 / 收起 thinking 与工具卡；打开工具详情 | 约 260ms 自然高度折叠；展开状态保留；详情可分页、可关闭 | M03、S20、V14 |
| C08 | 触发审批 / 问卷，提交与取消 | 单项确认浮在输入区上方，提交时 composer 不位移；多步骤间草稿保留 | V07、M12 |
| C09 | 首页卡片左滑：短滑后松手，再滑过半宽 | 短滑回弹；越过半宽时提示“松手关闭”并触觉一次；松手后退场；多选模式下不触发 | M10、M12、V11 |
| C10 | 长按卡片进入多选，再点选和退出 | 进入多选时触觉一次；选中样式 160ms 淡入；卡片几何不变 | S15、M06、M12 |
| C11 | 从左缘拖开目录，折叠 / 展开目录，搜索，归档 / 恢复 | 抽屉跟手吸附；折叠后高度立即收缩；一次只展开一个目录 | M09、S19、V17 |
| C12 | 打开设置页（r15 前由“更多操作 › 连接状态”进入，r15 后点右上角齿轮）；点配额币；打开供应商切换 | 供应商卡片区（r15 后位于最上方）：44pt/dp 环、角标、左倾 24° 翻面；切换菜单透明无底色 | S19、S22、M14 |
| C13 | 打开首页下载页；整卡暂停 / 继续，长按多选 | 没有旁置按钮；长按多选；r15 后可从右侧滑入、右滑返回首页 | S20、S15、M14 |
| C14 | 打开轮次文件概况和查看器，左右切换文件 | 跟手、落位、首尾回弹；只请求已落位文件的详情 | S21、M13、V19 |
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
| R03 | 跟随模式下，用真实输出触发长时间运行的工具（Pi bash、Codex 命令、Claude 工具），从开始录屏到结果到达 | 工具卡从出现到完成始终是同一张紧凑卡，原地更新状态；没有大块原文闪现后再收起；全程无跳动、空白帧或整屏闪烁 | V20 / UI-02 |
| R04 | 非跟随状态（上滑阅读中）重复 R03 | 阅读锚点不动；不弹回底部 | V20、V02–V03 / UI-02 |
| R05 | Android 首页停在顶部时，新建会话 / 让下方会话因活动排到第一 | 视口留在顶部，新的首卡可见，不被挤到视口上方 | V21 / UI-03 |
| R06 | 首页向下滚动半屏后：其他会话排序变化；当前视口首卡自身被排到顶部；新增和关闭会话；拖动 / 惯性中发生变化 | 视口首张完整卡片的屏幕位置不变；该卡被移走时保持原像素偏移，不跟着跳；手势中不重新定位 | V21 / UI-03 |
| R07 | 目录抽屉列表重复 R05–R06（两端） | 同上 | V21 / UI-03 |
| R08 | 首页右上角：只有“下载”和齿轮“设置”两个图标；点齿轮 | 进入设置页：分区依次为供应商、当前连接、配对信息；没有“已配对电脑”切换区，也没有添加 / 取消配对入口 | S22 / UI-04 |
| R09 | 点连接胶囊；在同步失败状态下点胶囊旁的重试；遍历首页电脑切换菜单、设置页、聊天页、目录筛选菜单、provider 不匹配对话框和错误提示文案 | 胶囊无跳转，仍显示连接 / 同步状态，读屏读出状态而不是按钮；重试仍然生效；目录筛选菜单和不匹配对话框的入口文字为“设置”，并进入设置页；除侧边栏底部电脑菜单外，没有添加电脑或取消配对入口；文案不再指向已删除的入口 | S18、S22 / UI-04 |
| R10 | 打开侧边栏，点击底部电脑行 | 菜单中有切换电脑、添加电脑、取消配对当前电脑；取消配对仍需二次确认 | S22 / UI-04 |
| R11 | 设置页与首页下载页：打开（滑入），拖 1/4 后松手，再拖过 1/3；入场动画中途右滑；减少动画 | 与聊天的 M07 / M08 一致：跟手、回弹、返回首页后立即可点；Android 入场可被接管；减少动画时直接切换 | M14 / UI-04 |
| R12 | 聊天中上滑阅读并输入草稿，点顶栏下载；先拖 1/4 后松手，再分别用右滑、返回按钮、系统返回退出 | 下载页从右侧滑入；右滑时底层露出的是这个聊天，不是首页；返回后阅读位置、草稿、展开状态不变；首页下载入口仍返回首页 | M14 / UI-04 |
| R13 | 设置页内进入供应商二级页再右滑 | 返回设置页，不直接回首页 | M14 / UI-04 |
| R14 | Android 首页下拉刷新：顶部下拉、非顶部尝试、多选中、左滑中、断开连接时 | 只在顶部触发；多选和左滑中不触发；断开时触发重连；卡片与视口稳定 | M15 / UI-05 |
| R15 | 聊天中点击文件产物卡、Markdown 文件链接；连续点 4 次；未连接时点击；减少动画 | 图标从点击处沿弧线飞到右上角下载按钮，按钮轻弹，角标增加；同时最多 3 个飞行；未连接时不飞并提示；减少动画只高亮按钮；阅读位置不变 | M16 / UI-06 |
| R16 | 打开“历史与分支”页：查看顶栏；点其中的文件下载；点顶栏下载按钮，再右滑返回 | 顶栏有与聊天同款的下载按钮，带角标；文件飞向这个按钮；下载页滑入，右滑露出并返回历史页，搜索词、筛选和滚动位置不变 | M14、M16 / UI-04、UI-06 |

## 5. 新增或修改 UI 时的用例编写要求

1. **同一任务写用例。** 每个新增或修改的 feature ID 至少有：一个设备 UI 用例，断言该规则的具体数值或几何（坐标、尺寸、可见性、顺序、帧序），只断言“元素存在”不够；状态或逻辑另配单元测试；以及 §4 的手动清单条目。同时更新 §3.3 映射。
2. **动效用例**至少断言起点和终点状态、取消 / 反向后的状态、减少动画路径与正常路径的语义一致。时间相关断言使用夹具注入或可控时钟，不依赖墙钟睡眠。中间帧通过截图附件或帧序列人工复核。
3. **稳定性用例**在拖动中、惯性中和数据更新时断言锚点项的屏幕坐标（容差 ≤ 1pt/dp）。闪屏类问题要有逐帧复现夹具或回放数据。
4. **两端对齐。** 规则适用两端时，两端都写用例，名称尽量对应。平台差异写入 ADR-0051 的平台差异。
5. **只写设计时**，设计说明列出拟新增的自动用例（名称、断言、夹具）和手动步骤，评审通过后实施时落地。
6. **不得删除、跳过或放宽既有用例**来让改动通过。基线规则被有意替代时，在 ADR-0051 修订记录中说明，并同步改写对应用例。

### 5.1 r15 新增用例

自动用例已落地。iOS 新增 `RevealClockTests`、`testStreamingRevealAdvancesInOrderAcrossBlocks`、`testStreamingRevealWithReducedMotionShowsEveryBlockImmediately`、首页与目录 V21 用例，以及下载飞入和减少动画用例；Android 新增 `RevealScheduleTest`、`HomeViewportAnchorTest`、`StreamingRevealInstrumentedTest`、`HomeViewportInstrumentedTest`（含下拉刷新）、`SessionDrawerViewportInstrumentedTest`、`SettingsEntryInstrumentedTest`、`SwipeBackPagesInstrumentedTest`、`DownloadFlightInstrumentedTest`。当前 56 项 iOS UI 全量未运行；Android API 35 全量 131 项中 4 项失败，失败集合与 127 项基线的 4 项相同。手动 C01–C18、R01–R16、外观矩阵与完整 L4 审阅仍待执行。

| ticket | 平台 | 拟新增用例 | 断言要点 |
| --- | --- | --- | --- |
| UI-01 | 两端单元 | iOS `RevealClockTests`；Android `GlyphRevealClockTest` | 多批到达时开始时间单调；活动区间连续；积压压缩到 450ms 内；跨块共享游标；非前缀续写立即落定；结束时剩余积压在 450ms 内揭示完；Android 活动字素 ≤ 128 |
| UI-01 | iOS UI / Android 设备 | `testStreamingRevealAdvancesInOrderAcrossBlocks`、`testStreamingRevealWithReducedMotionShowsEveryBlockImmediately`；`StreamingRevealInstrumentedTest` | 夹具分批推送多段文本，按帧采样已绘制字素位置，后段不得早于前段；减少动画时直接显示 |
| UI-02 | Android 设备 / iOS UI | `ToolContinuityCaptureInstrumentedTest`；iOS 真实输出用例待补 | 隔离 Host 真实输出逐帧记录：捕获运行中工具活动、转录行数不回退、最终回合结束；审阅工具卡身份 / 高度、跟随位置与空白帧。iOS 与 Claude 真实输出仍待验证 |
| UI-03 | Android 设备 / 单元 | `HomeViewportInstrumentedTest`；`SessionDrawerViewportInstrumentedTest`；`HomeViewportAnchorTest` | 顶部插入 / 重排后首项索引为 0 且偏移为 0；首页 / 目录滚动中首张完整卡片屏幕 y 不变（≤ 1dp）；锚卡被移走时像素偏移不变；拖动中不重新定位 |
| UI-03 | iOS UI | `testHomeTopShowsNewAndPromotedSessions`、`testHomeScrolledAnchorSurvivesInsertionAndReordering`、`testDrawerScrolledSessionsKeepTheirPositionDuringCatalogUpdates`、`testDrawerTopKeepsNewAndPromotedDirectoriesVisible` | 同上；首页 / 目录定向用例已通过，iOS 全量与手动复核待完成 |
| UI-04 | 两端 | `SettingsEntryInstrumentedTest`；`testSettingsPageOrderAndSingleHostMenu` | 右上角只有下载与齿轮设置；连接胶囊不可点击，读屏语义为状态，失败重试仍可用；设置页分区顺序，且没有已配对电脑区；排障入口文字为“设置”；除侧边栏电脑菜单外，全树中没有“添加电脑”“取消配对”节点 |
| UI-04 | 两端 | `SwipeBackInstrumentedTest` 扩展；`testSettingsAndDownloadsSwipeBack`、`testChatDownloadsReturnToSameChat` | 设置 / 首页下载页入场、取消回弹、返回首页、返回后可点；从聊天和历史页进入的下载页滑入，右滑底层为来源页，返回来源页且锚点与草稿不变；二级页返回设置 |
| UI-05 | Android 设备 | `HomeViewportInstrumentedTest#pullingAtTheTopRefreshesOnceWithoutMovingTheCards` | 顶部下拉调用一次 `refreshHome`；非顶部 / 多选 / 左滑中不调用；指示器收起；卡片坐标不变 |
| UI-06 | 两端 | `DownloadFlightInstrumentedTest`；`testDownloadFlightStartsAtTapAndEndsAtButton`、`testDownloadFlightWithReducedMotionHighlightsWithoutFlying`、`testHistoryDownloadButtonAndFlight` | 聊天页与历史页：起飞位置接近点击点，终点为本页下载按钮中心（容差 4pt/dp）；任务未创建时不起飞；同时 ≤ 3 个；减少动画不飞；阅读锚点不变；飞行层不拦截点击；历史页下载按钮的规格与角标和聊天页一致 |

## 6. 结果记录

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
