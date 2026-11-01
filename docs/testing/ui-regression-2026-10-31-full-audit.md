# 2026-10-31 UI / UX 全量自动回归与特性盘点

执行日期：2026-10-31，Asia/Taipei。源码提交：`157dc2d5776eeb1d41c7151ae3bc1f44785e862c`；执行范围包含工作区原有的 5 处未提交修改，本任务未修改产品源码或测试断言。

**结论：当前回归未通过。** 两端全量自动 UI 套件已运行；独立手动清单与真实后端专项未完整完成，不能记为全部验收通过，也不能据此更新 feature 的交付状态。

## 范围与特性

冻结基线为 [ADR-0051](../adr/0051-ui-style-motion-and-visual-stability-freeze.md) `2026-10-31/r24`：69 项，其中 App 59 项（S01–S22、M01–M16、V01–V21），品牌 / Host / Relay 10 项（X01–X10）。ADR 登记已交付 67 项，并不代表本轮 67 项全部重新验收通过。V20、V21，以及 M14 r24、M15 r21–r23、M16 的完整门禁仍须按实际证据判定。

完整逐项规则及来源：[本轮特性清单](../../.artifacts/ui-regression/20261031-1747-full-audit/feature-inventory.md)。本任务没有新增或修改 feature，基线版本、计数及两个本机入口保持不变。

## 执行结果

| 层级 / 套件 | 本轮结果 | 证据（相对本轮产物目录） |
| --- | --- | --- |
| L0 | 69 个 ID 唯一、22 / 16 / 21 / 10 计数正确、ADR 相对链接无缺失、AGENTS.md 与 CLAUDE.md 完全一致 | `l0.json` |
| Host / 协议等 Node 测试 | 1536 通过、0 失败、5 跳过，共 1541；typecheck、lint 通过 | `host-tests.json`、`host-typecheck.log`、`host-lint.log` |
| iOS L1 | Swift 223 项、20 个 suite 通过；源码 / plist / scheme 检查通过 | `ios-core-build.log` |
| iOS L2 | Simulator Debug 构建及 App bundle 检查通过 | `ios-core-build.log` |
| Android L1 | JVM 548 项、60 个 suite 通过，无失败 / 跳过 | `android-unit-results/`、`android-unit-build.log` |
| Android L2 | Debug App 与 AndroidTest APK 构建通过 | `android-unit-build.log`、`android-apk-sha256.json` |
| iOS L3 全量 | **53 通过、8 失败、0 跳过，共 61** | `ios-ui.xcresult`、`ios-test-summary.json`、`ios-ui.log` |
| Android L3 标准配置全量 | **124 通过、7 失败、7 跳过，共 138** | `android-standard/android-ui.log`、`android-standard/test-results.json` |
| Android 隔离夹具补跑 | 6 次执行中 4 通过、2 失败；其中原跳过的 5 项为 3 通过 / 2 失败，另 1 项为重复通过，不作为额外新增覆盖累计 | `android-fixtures/fixture-*.log` |
| L4 | 已查看 iOS 110 张命名 PNG、Android 标准配置本轮新生成的 128 张 PNG（含 60 张配额翻面帧）、补跑夹具 5 张 PNG，以及手动明暗矩阵；不代表所有动效的 60fps 连续录屏审阅完成 | `ios-attachments/manifest.json`、`review/*-index.json`、`review/*.jpg`、`ios-manual/` |
| 手动 | 已实际检查部分设置 / 配额 / 多选 / 目录 / 输入 / 复制 / 来源草稿保留；C01–C18、R01–R22、A1–A4 未完整逐项验收 | `manual-checklist.md` |

完整产物目录：[`.artifacts/ui-regression/20261031-1747-full-audit/`](../../.artifacts/ui-regression/20261031-1747-full-audit/)。本轮未在父提交另跑同设备对照，因此以下失败均记录为**当前失败**，不自动归类为已知旧失败。测试失败仍需区分产品行为、夹具与断言问题。

## iOS 当前 8 项失败

设备：池内 `Orbis Adjacent Actions`，iPhone SE（3rd generation），375pt，iOS 27.0；显式 UDID，`-parallel-testing-enabled NO`。

所有位置均在 `ios/Orbis/UITests/OrbisUITests.swift`。

| 用例 | 行号 | 本轮观测 |
| --- | ---: | --- |
| `testAddComputerPageReboundsAndSwipesBack` | 853 | 长拖后没有等到首页目录入口；短拖附件实际显示扫码弹层及相机授权提示，需定位手势与按钮命中 |
| `testApprovalOverlayKeepsComposerStableWhileSubmitting` | 1169 | 未等到“允许”操作，后续 composer 几何断言未执行 |
| `testDrawerCollapseShrinksContentWithoutAnotherDrag` | 1388 | 折叠用例断言失败；iPhone 17 手动普通目录折叠成功，不能覆盖 SE 上该用例失败 |
| `testDrawerSelectionClearsOnCancelSearchAndClose` | 1349 | 目标卡片不可命中 |
| `testLongTranscriptAppearsAndToolExpansionKeepsItsPositionWithoutDragging` | 1080 | 展开工具框为 `(42, -566, 283, 40)`，位置断言失败 |
| `testPageScreenshotsInBothAppearances` | 1447 | 页面预期文字未出现，用例提前结束；另补拍明暗静态页面，不能替代该失败 |
| `testSwipeRightFromLeftSideOpensDirectory` | 667 | 目录取消横拖后，左滑关闭会话断言失败 |
| `testToolExportAndInteractionDraftSwitching` | 1481 | 交互输入节点等待失败；工具导出阶段已留下附件 |

xcresult 另记录运行时警告：`Publishing changes from within view updates is not allowed, this will cause undefined behavior.`，未在本任务中更改实现。

## Android 当前 7 项失败

设备：池内 `Orbis_UI_Polish_35`，API 35。标准配置显式设置字体缩放为 1.0、三个系统动画缩放为 1.0；执行后恢复借用前的 1.5 / 0 / 0 / 0。所有安装、测试均限定到该设备。

| 测试类 / 方法 | 本轮观测 |
| --- | --- |
| `CodexPermissionsInstrumentedTest.freeTextQuestionCanBeAnsweredWithoutSelectingADummyOption` | 自由文本输入失败 |
| `DshInstrumentedTest.selectsDeepSeekAndCreatesSessionInChosenDirectory` | 预期组件未显示 |
| `HomeNavigationInstrumentedTest.pointerDownRespondsBeforeScrollPressDelayAndCancelDoesNotNavigate` | 按下反馈没有在列表点击延迟前生效 |
| `HomeNavigationInstrumentedTest.quickTapDrawsPressedCardBeforeOpeningOnce` | 快速点击的下压反馈断言失败 |
| `HomeSwipeCloseInstrumentedTest.shortSwipeReboundsAndEachGestureVibratesOnlyOnceBeforeClosingItsRuntime` | 滑动容器裁剪了卡片阴影 |
| `QuestionnaireInstrumentedTest.editingAndRestoringTheFormPreservesDraftsUntilOneExplicitSubmission` | 表单文本输入失败 |
| `SessionHostOwnershipInstrumentedTest.missingAndStaleHostnamesStayTogetherAndCreationRequiresPairedConnection` | 不应存在的“切换电脑”节点仍存在 |

借用设备的初始配置实际上为字体 1.5、动画关闭。该配置的首次全量为 118 通过、11 失败、9 跳过，保留于 `android-adb36/`，没有覆盖。额外失败为两项 composer 布局、目录内视口锚点、工具详情分页位置；这些也是该配置下的当前失败，不因标准配置通过而删除。下载飞入及流式揭示因关闭动画跳过，随后在标准配置中通过。

## 隔离夹具补跑与剩余边界

- `ClaudeHistoryInstrumentedTest`：1 项通过；使用真实 Host / Relay / Claude bridge 实现及合成原生转录，不等同真实 Claude TUI 输出验收。
- `ToolContentInstrumentedTest`：2 项通过，覆盖四类 Agent 的工具摘要和按需正文读取；其中 1 项在标准全量中已通过，补跑不重复累计覆盖。
- `DisplayScenariosInstrumentedTest`：1 项通过，覆盖压缩、失败回合、带产物投影。
- `SessionSyncSlowLinkInstrumentedTest`：Pi / Codex 两项均失败，`exercise` 第 116 行预期同步请求数 7，实际 15；末尾内容已显示并留有截图。原始统计、夹具日志和失败日志保留。
- 标准全量剩余未运行：`LiveHistoryReloadInstrumentedTest` 需要显式真实历史环境；`ToolContinuityCaptureInstrumentedTest` 需要隔离 Host 配对与真实输出捕获参数。默认按方案排除的 `IsolatedHostPairingInstrumentedTest` 未另跑。
- iOS 17 设备池配置缺口、真机触觉、真实多 Host / 网络 / 订阅账号、VoiceOver / TalkBack 全流程未验收；没有扩容设备池。

## 环境恢复与产物

本机 SDK 的 ADB 37.0.1 在安装 / instrumentation 期间多次重置连接或退出，相关失败尝试分别保留。使用 Google 官方 `platform-tools_r36.0.2-darwin.zip` 解压出的备用 ADB、独立本机端口和同一池内 AVD 后完成测试，没有替换全局 SDK。标准配置仍失败，不能将产品测试失败归因于前面的 ADB 启动问题。

设备锁覆盖启动、安装、测试、截图及恢复；构建使用既定目录并取得共享构建租约。任务拥有的模拟器操作和夹具进程均已退出，独占锁已释放；原有构建缓存与全部失败证据继续保留。iOS 手动截图遇到系统相机提示遮挡的首轮、以及未稳定的配对首帧均单独保留，后续重拍只用于静态审阅，不抹去原始证据。
