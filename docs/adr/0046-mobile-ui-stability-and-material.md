# ADR-0046：移动端的阅读位置、材质和动效统一约束

日期：2026-10-29

Status: accepted

关联：[ADR-0039](0039-content-change-signals.md)、[ADR-0041](0041-history-paging-edge-trigger.md)、[ADR-0042](0042-bounded-shadow-bitmaps.md)

2026-10-30：本文的 17 项约束及后续 UI feature 已归入 [ADR-0051 冻结基线](0051-ui-style-motion-and-visual-stability-freeze.md)。相关设计与修改先查该索引；本文继续保留具体决策与历史验收证据。卡片旁操作中的旧别名 / 下载方案已被后续实现替换，当前适用范围按该基线 S14 / S20，不恢复已移除按钮。

## Context

本记录定义两端共用的界面约束，补充现有协议和状态决策，
并取代历史 UI 文档中与本记录冲突的字号、圆角和嵌套材质规则。

长回复不能用「最后一个列表项仍可见」推断用户正在看末尾：一个助手轮次本身就可能跨越几十屏。
发送、刷新、后台同步和输入聚焦也不能各自拥有一套追新策略。
同一张卡片里逐层加阴影、加载时插入提示行、状态文案改变宽度，会放大流式更新带来的视觉抖动。

## Decision

### 1. 聊天只有一个跟随规则

聊天按实际像素距离统一跟随，用户滚动持有阅读锚点，显式定位恢复相应位置；分页、刷新和内容交接共同维护稳定消息身份。两端通过原生滚动机制保持行内偏移，分页触发见 ADR-0041，最近提问定位见 ADR-0057。

参考：[ADR-0057](0057-chat-latest-question-reminder.md)。

### 2. 同一块内容只有一个材质外框

独立表面使用统一材质外框，后代按层级与内容内距继承平铺明度、圆角和聚焦表达；相关操作按阅读宽度与所属关系布局。Android 阴影采用 ADR-0042 的有界缓存。

材质参数：浅色四层 `#DDE3EF / #E6EBF4 / #EDF1F8 / #F3F6FB`，深色 `#1C1F26 / #23262E / #292D36 / #2F333D`；相邻层 HSL 明度约差 1–3%，阴影采用带色墨色。侧边图标的可见圆面为 36pt/dp，图标 18pt/dp，触控区 48pt/dp。

2026-11-03 / r38（S02 / S19，验证中）：首页 Agent 身份图标与设置供应商图标通过共用 `AgentIconRecess` 绘制局部凹槽。首页徽标为 44pt/dp、16pt/dp 圆角；供应商图标为 32pt/dp，背景凹槽为 40pt/dp、14pt/dp 圆角；配额币为 44pt/dp，背景圆槽为 48pt/dp，命中区 64×56pt/dp。两端经典 / 雾蓝浅深色的 Claude Code 与 Codex 翻面帧已审阅，设置区凹槽保留；完整手动与设备验收仍未完成，证据见 UI 回归 R59。

2026-11-05 / r47（S02 / S03 / S04 / S19，验证中）：iOS 侧边栏采用独立表面根，圆角 24pt/dp、柔影强度 1、位移与模糊 4pt/dp、暗影 alpha 0.38、高光 alpha 0.70，后代继承 layer=1 / depth=1；专项及待验收范围见 R65。Android 已恢复原生抽屉形状、背景及原有入口阴影。

### 3. 字体、文件名和稳定的反馈槽

界面复用统一文字层级、原生断行和稳定反馈槽位，文件名按主名与扩展名布局，状态变化维持阅读几何。当前文字档位为 20 / 15 / 13 / 12，数字等宽，行内图标光学校正为 0.125em。

### 4. 动画保持内容身份

动画复用内容身份与共用组件，折叠按需构建并保留内部状态，流式揭示按新增字素顺序推进。复制反馈由同一生命周期管理，平台原生手势与减少动画设置决定降级；参数和覆盖见 ADR-0058。

2026-11-06 MARKDOWN-LIVE-01（M04 / V09）：Android 后台 Markdown 解析以最后实际显示的文档作为等待期间的基线，缓存命中也更新该基线；读取结果按请求版本推进，较旧结果不覆盖已显示的新正文，中间结果仍可继续上屏。修复缓存命中后下一次缓存未命中导致正文回退、渐显重播的窗口，保持既有渐显参数与原生文本布局。实现及回归见 [MarkdownText.kt](../../android/app/src/main/java/com/orbising/orbis/MarkdownText.kt)、[MarkdownPresentationInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/MarkdownPresentationInstrumentedTest.kt)、[StreamingRevealInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/StreamingRevealInstrumentedTest.kt)，合成复现及验证状态见 [verification.json](../../.artifacts/codex-typewriter-flicker-20261106/verification.json)。Android 真机待用户验证。

参考：[ADR-0048](0048-online-chat-entry-budget.md)；[ADR-0058 SC47](0058-shared-interaction-motion.md)；[Android 连续性决策](0057-android-tool-transcript-continuity.md)。

### 5. 设置与配对入口（S22 / S23）

设置集中呈现供应商、连接、配对、外观和语言，电脑行与侧边栏提供电脑管理入口。连接胶囊呈现实际路径状态和重试，整页导航共用 ADR-0054。

参考：[ADR-0054](0054-shared-full-page-navigation.md)；[ContentView.swift](../../ios/Orbis/Orbis/ContentView.swift)；[StatusViews.swift](../../ios/Orbis/Orbis/StatusViews.swift)；[MainActivity.kt](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)；[SettingsEntryInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/SettingsEntryInstrumentedTest.kt)。

### 6. 首页与目录视口稳定（V21）

列表更新维护当前阅读锚点与用户滚动，顶部保持顶部，其余位置按稳定卡片身份和像素偏移结算。

2026-11-07 HOME-STABILITY-01（V21 / M10）：Android 首页卡片在视口校正后保持不透明，继续使用既有移动和关闭动画。修复 `requestScrollToItem` 重置列表动画记录后，默认入场淡入让已显示卡片整体变淡的闪屏。逐帧回归见 [HomeViewportInstrumentedTest](../../android/app/src/androidTest/java/com/orbising/orbis/HomeViewportInstrumentedTest.kt)；修复前重排首帧失败，修复后同一断言与首页手势共 9 项设备测试、6 项视口单元测试通过。构建使用隔离副本，供应商页面的编译调整仅在副本内应用；本次未安装真机，待用户验证。执行边界与原始证据见 [verification.json](../../.artifacts/home-stability-20261107/verification.json)。

参考：[HomePresentation.kt](../../android/app/src/main/java/com/orbising/orbis/HomePresentation.kt)；[HomeViewportAnchorTest.kt](../../android/app/src/test/java/com/orbising/orbis/HomeViewportAnchorTest.kt)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。

### 7. 本机外观选择（S25）

外观按本机选择即时生效，复用统一材质、字号和聚焦规则，保留导航、内容身份与语义色。默认经典，雾蓝对应既有 insetFocus 存储值，明暗跟随系统设置。

参考：[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)；[Neumorph.kt](../../android/app/src/main/java/com/orbising/orbis/Neumorph.kt)。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## Consequences

新页面复用共用视觉与交互组件，嵌套层次通过统一的空间和材质表达。
UI 状态更新不改变消息 key、会话身份或协议事实；历史位置校正只维持原来的阅读锚点。
模糊渐显是可降级的绘制效果，不是消息完成或同步完成的证据。

2026-11-03 / r40（验证中）：放大设置供应商凹槽，普通图标后方由40改为48pt/dp、圆角16，配额币后方由48改为56pt/dp、圆角28；图标和币面尺寸、供应商行布局与命中区保持。硬币底部改为常驻柔和接触影，34×10pt/dp、中心下移21pt/dp，随翻面收窄至35%，侧面透明度保留静止的75%；浅 / 深色使用既有带色scrim，中心alpha分别0.32 / 0.52。完整软影足迹位于56圆槽内；减少动画仍保留静止投影。分类沿用QuotaCoin / SC27 / MOT-22，影响S02、S04、S19，关联S13、S22、S25、M11；R58 / R59与双端L0–L4、C01–C18、A1–A4逐项记录，未完成门禁不记验收。证据 `.artifacts/ui-regression/20261103-provider-well-shadow/`。


2026-11-03 / r42（验证中）：设置供应商凹槽统一为圆角矩形，普通标识与配额币均直接复用 `AgentIconRecess` 的默认16pt/dp圆角、既有材质与内影方向；取消配额币专用圆形/半边长圆角。普通32pt/dp标识配48pt/dp底座、44pt/dp硬币配56pt/dp底座，原居中、行布局、角标和64×56pt/dp命中区保持；硬币常驻底影与翻面几何/时序不变。范围S02 / S03 / S04 / S19，关联S22 / S25、SC27 / MOT-22、R58 / R59。新形状仍需双端L1–L4、C01–C18及A1–A4验证；旧r40圆形截图不替代本轮结果。证据 `.artifacts/ui-regression/20261103-provider-well-rounded/`。



2026-11-05 Android 目录后台专项：S19 / V21、ADR-0060 PERF-07。仅调整后台投影、行事实复用、标题缓存和IO启动水合；原 DrawerPanel / NeumorphSurface / 形状 / 阴影 / 布局参数不改。SC03 / SC08 / SC36、MOT-14 的受影响设备专项及结果见 `.artifacts/ui-regression/20261105-drawer-background/summary.md`；用户体感仍待验证。
