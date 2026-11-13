# ADR-0054：下一级整页统一导航与交互式返回

日期：2026-10-31

Status: accepted（完整设备与手动门禁按验证记录，不把实施等同于验收通过）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) `2026-10-31/r24`，M07–M08、M14、V17–V18。

## Context

页面返回效果过去逐页接入：聊天、设置、下载及历史与分支已有相同手势，但添加电脑在两端都未接入，Android 离线历史直接替换首页。iOS 还依赖一份页面白名单开启手势，新增页面容易漏接；Android 保留来源页面后，下层的系统返回处理器也需要统一管理。

整页导航使用共用机制，覆盖当前可进入的下一级整页及后续新增页面。“下一级”是相对来源页的层级，不限定为导航栈的第二项。

## Decision

### 1. 通用行为

应用内下一级整页接入平台共用导航，保留直接来源实例、业务状态与阅读位置。进入、交互返回、取消和降级共享生命周期，完成交接后来源立即可操作。

### 2. 当前整页覆盖清单

| 路径 | iOS | Android |
| --- | --- | --- |
| 首页 / 会话目录 → 在线聊天 | 共用导航栈 | 共用页面容器 |
| 会话目录 → 离线会话 / 只读历史 | 复用聊天导航路径 | 从直接替换首页改为共用页面容器 |
| 根标签 → 设置 / 供应商 | 平级根页面，保留状态 | 平级根页面，保留状态 |
| 首页 → 下载 | 返回首页 | 返回首页 |
| 聊天 → 下载 | 返回原聊天 | 返回原聊天 |
| 聊天 → 历史与分支 | 返回原聊天 | 返回原聊天 |
| 历史与分支 → 下载 | 先返回历史，再从历史返回聊天 | 入口已移除；返回聊天后可从下载入口打开 |
| 侧边栏电脑菜单 → 添加电脑 | 纳入共用导航栈的默认手势 | 从直接替换页面改为共用页面容器，来源目录保留 |

目录入口在 iOS 原本先收起抽屉再进入整页，因此返回来源为首页；Android 原本保留目录抽屉状态，本次保留该平台行为。返回沿用真实来源实例。

### 3. 边界

聊天、供应商与设置为平级根页面；会话、下载、历史、文件与配对使用下一级整页。根标签只出现在根页面，切换采用 fade-through。首句草稿进入会话采用卡片到整页形状过渡，返回继续复用普通推回。选择 Sheet、抽屉与系统页面维护各自拥有者；业务门禁由原有拥有者校验。当前修订见 [ADR-0070](0070-unified-design-and-interaction.md)。

### 4. 实现约束

iOS OrbisPageStack 管理路径与来源快照，OrbisPageTransition 提供共用过渡；Android OrbisPageHost 统一 SwipeBackLayer、系统返回与页面活跃状态。网络和配对结果由原业务模型确认。

## Verification

[测试规则](../../AGENTS.md#测试)；[SwipeBackInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/SwipeBackInstrumentedTest.kt)；[PageNavigationInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/PageNavigationInstrumentedTest.kt)；[HistorySwipeBackInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/HistorySwipeBackInstrumentedTest.kt)；[原始证据](../../.artifacts/)。

## Consequences

2026-11-09：Android 历史与分支页移除右上角下载入口；文件下载仍可在历史内容中发起，下载管理从聊天页或首页进入。iOS 路径未改变。根级目录抽屉覆盖标签栏，供应商和设置仍与聊天平级；系统返回在这两个页面按根页面行为直接离开应用，不先切回聊天（S41 / SC62）。

新整页只需接入导航容器即可继承统一行为，修复手势或参数时有共用入口。来源页面继续保留状态；模态与抽屉的交互边界保持清晰。历史下载入口移除记录见 S45 / SC66，根页面返回行为见 S41 / SC62；M14 仍负责通用整页规则。

## 2026-11-01 / r31 共用动效修订（已接入，验证中）

[ADR-0058](0058-shared-interaction-motion.md) 统一菜单、选择工具栏、图标反馈、最近提问右上出入及边缘返回。本文先前的导航来源、提示条件、阅读稳定和业务判定保持；对应动效参数以该修订为目标，未完成双端门禁不记为验收通过。实施与测试映射见 [MOT ticket](0058-shared-interaction-motion.md)。

## 2026-11-02 / r35 交互补充（已接入，验证中）

r35 修订：Android 系统边缘返回缩小、两侧留缝、来源蒙层与向右完整退出按 ADR-0058；iOS 可选新增双侧手势仍暂不交付。详见 [ADR-0058](0058-shared-interaction-motion.md)；双端门禁未完成前不记为验收。

## 2026-11-03 / r40：返回交接后立即可操作（已实施，验证中）

iOS 已复现返回首页后卡片仍短暂不可操作，另复现短拖结束误点扫码与历史卡片。共用容器统一返回交接与手势竞争，来源在交接后立即可操作；既有 M08 / M14 / V13、EdgeBack、SC28–SC30 / SC35、MOT-09 / MOT-13 与 R19–R22 / R47 继续适用。

iOS 确认退场采用 180ms ease-out，取消沿用质量 1 / 刚度 260 / 阻尼 24 的弹簧；Android 沿用既有 180ms。减少动画与已屏外情况直接交接，横拖由容器管理按钮按压和 touch-up。即时性交接通过应用内单调时钟记录，自动化调度预算为 300ms。

2026-11-03：应用内实测与最终专项支持修复；完整 iOS 全量受外接盘中断和共享设备残留锁阻塞，Android 深色按压反馈及其他全量失败保留，完整人工与最终动效帧尚未验收。测试入口与证据见 [测试规则](../../AGENTS.md#测试)、[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift) 和 `.artifacts/ui-regression/20261103-ios-return-response/summary.md`。

## 2026-11-13：iOS 整页全部常驻，返回来源不再是静帧（已实施，待用户验证）

iOS 整页导航改为常驻层容器，与 Android OrbisPageHost 一致：首页与每一层整页同时挂载，最上层接收输入，下一层是返回来源。右滑返回、返回键和嵌套返回露出的都是真实页面实例，阅读位置、输入草稿与期间的更新随之保留；交换单页的旧实现（透明 NavigationStack 下只常驻根页面）被替换，页面返回不再取用任何截图。层级顺序即推入顺序，路径增删由 `OrbisPageStack` 管理，路径变化本身不再驱动转场。

动效与手势沿用 ADR-0058 参数：推入使用与返回同一组弹簧（`.orbisSwipeBack(velocity: 0)`，新增 `InteractionMotion.pageEnter`），来源层同步恢复压缩与 0.34 遮罩；右滑过程、三分之一提交阈值、180ms 退出与取消弹簧保持原值；页面自己的返回控件走与手势相同的提交路径，不再有第二段系统动画。草稿卡片形变仍以进入瞬间的静帧补齐矩形外区域，暂未改动。

每层各自保留一个承托控制器，被覆盖的页面从原生无障碍枚举中移除（`accessibilityHidden` 对显式无障碍子树不可靠，此前是被覆盖根页面出现在 XCUITest 树中的原因）。推入时的层宽在下一帧读取，兄弟动画（如正在关闭的抽屉）可能先报出中间宽度；层宽变化不得让页面停在屏外。

验证（iOS 27.0 模拟器，Orbis iOS Standard 2）：`testNestedPagesSwipeBackOneLevelAtATime`、`testHistorySwipeBackReturnsToChat`、`testChatSwipeBackReboundsThenReturnsHome`、`testSettingsAndDownloadsSwipeBack`、`testAddComputerPageReboundsAndSwipesBack`、`testDraftSurvivesBackNavigationAndSlashRequiresSelection`、`testSlashPickerStaysAboveKeyboard`、`testScrolledHomeKeepsCardPositionAfterChatReturn`、`testOptionalEdgeBackKeepsExistingIOSNavigation`、`testChatReturnImmediatelyAcceptsCardEntry` 通过（10/11）。既有失败保留：`testNewSessionEntersChatAtOnceAndFailureOffersRetryInPlace`:1140 修复前后同一断言（先前记录为既有失败）；`testFullPageReturnBudgetAndNestedSourceReentry`:1882 仍按“根标签切换会产生一次页面返回”的旧预期断言，该预期自根标签改造后失效。Swift 482 项单元测试通过。未覆盖：iPad 常驻目录布局与真机手感；`testScrolledHomeKeepsCardPositionAfterChatReturn` 在 iPad 上仍有 fixture 派发失败。证据见 [.artifacts/nested-live-layers-20261113](../../.artifacts/nested-live-layers-20261113/)。用户验收：待用户验证。
