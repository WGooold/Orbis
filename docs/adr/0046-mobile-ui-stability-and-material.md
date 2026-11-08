# ADR-0046：移动端的阅读位置、材质和动效统一约束

日期：2026-10-29

Status: accepted

关联：[ADR-0039](0039-content-change-signals.md)、[ADR-0041](0041-history-paging-edge-trigger.md)、[ADR-0042](0042-bounded-shadow-bitmaps.md)

当前 UI 索引见 [ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)。2026-11-08 的材质、外观与页面流程由 [ADR-0070](0070-unified-design-and-interaction.md) 修订；本文继续维护阅读位置、稳定身份与可恢复操作的约束。

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

材质采用雾蓝 / 灰绿与浅 / 深组合的四主题、三层表面；凹陷继承所在表面的底色并保留内影。只有最外层凸起投外影，嵌套凸起使用明度台阶。参数统一见[设计规范](../design/orbis-design-system.md)第 12 节与各端共用组件。

### 3. 字体、文件名和稳定的反馈槽

界面复用统一文字层级、原生断行和稳定反馈槽位，文件名按主名与扩展名布局，状态变化维持阅读几何。当前文字档位为 20 / 15 / 13 / 12，数字等宽，行内图标光学校正为 0.125em。

### 4. 动画保持内容身份

动画复用内容身份与共用组件，折叠按需构建并保留内部状态，流式揭示按新增字素顺序推进。复制反馈由同一生命周期管理，平台原生手势与减少动画设置决定降级；参数和覆盖见 ADR-0058。

2026-11-06 MARKDOWN-LIVE-01（M04 / V09）：Android 后台 Markdown 解析以最后实际显示的文档作为等待期间的基线，缓存命中也更新该基线；读取结果按请求版本推进，较旧结果不覆盖已显示的新正文，中间结果仍可继续上屏。修复缓存命中后下一次缓存未命中导致正文回退、渐显重播的窗口，保持既有渐显参数与原生文本布局。实现及回归见 [MarkdownText.kt](../../android/app/src/main/java/com/orbising/orbis/MarkdownText.kt)、[MarkdownPresentationInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/MarkdownPresentationInstrumentedTest.kt)、[StreamingRevealInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/StreamingRevealInstrumentedTest.kt)，合成复现及验证状态见 [verification.json](../../.artifacts/codex-typewriter-flicker-20261106/verification.json)。Android 真机待用户验证。

参考：[ADR-0048](0048-online-chat-entry-budget.md)；[ADR-0058 SC47](0058-shared-interaction-motion.md)；[Android 连续性决策](0057-android-tool-transcript-continuity.md)。

### 5. 设置与配对入口（S22 / S23 / S28 / S29）

设置集中呈现连接、外观和语言；供应商是平级根页面，电脑切换与配对复用电脑菜单。连接胶囊呈现实际路径状态和重试，整页导航共用 ADR-0054。

2026-11-06 S28 / SC48：当前连接增加“连接协议”，从所选电脑的实际 adapter 显示 WS / QUIC，LAN 显示 WS，未连接或未知显示“暂不可用”。复用两端 `StatusRow` 和中英文目录；协议与断线判定见 `PresentationTests` / `StatusScreenTest`，电脑隔离见 `MultiHostTests`，设备显示见 `testCurrentConnectionProtocol` / `SettingsEntryInstrumentedTest`。实现已完成，构建、自动验证及额外回归失败分别见 [本次验证记录](../../.artifacts/ui-regression/20261106-connection-protocol/verification.json)；未部署，待用户安装验证。

per-Host 协议模式保留 `auto` / `ws` / `quic` 偏好，当前 Auto 使用 WebSocket，实际路由见 [ADR-0065](0065-native-quic-relay-transport.md)。选择面板暂存候选，显式应用后保存并重新连接，摘要依据实际 adapter 与路径更新。原 SC49 证据保留于[协议模式验证记录](../../.artifacts/ui-regression/20261106-auto-relay-selection/verification.json)，新交互以 SC56 单独验证。

参考：[ADR-0054](0054-shared-full-page-navigation.md)；[ContentView.swift](../../ios/Orbis/Orbis/ContentView.swift)；[StatusViews.swift](../../ios/Orbis/Orbis/StatusViews.swift)；[MainActivity.kt](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)；[SettingsEntryInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/SettingsEntryInstrumentedTest.kt)。

### 6. 首页与目录视口稳定（V21）

列表更新维护当前阅读锚点与用户滚动，顶部保持顶部，其余位置按稳定卡片身份和像素偏移结算。

2026-11-07 HOME-STABILITY-01（V21 / M10）：Android 首页卡片在视口校正后保持不透明，继续使用既有移动和关闭动画。修复 `requestScrollToItem` 重置列表动画记录后，默认入场淡入让已显示卡片整体变淡的闪屏。逐帧回归见 [HomeViewportInstrumentedTest](../../android/app/src/androidTest/java/com/orbising/orbis/HomeViewportInstrumentedTest.kt)；修复前重排首帧失败，修复后同一断言与首页手势共 9 项设备测试、6 项视口单元测试通过。构建使用隔离副本，供应商页面的编译调整仅在副本内应用；本次未安装真机，待用户验证。执行边界与原始证据见 [verification.json](../../.artifacts/home-stability-20261107/verification.json)。

参考：[HomePresentation.kt](../../android/app/src/main/java/com/orbising/orbis/HomePresentation.kt)；[HomeViewportAnchorTest.kt](../../android/app/src/test/java/com/orbising/orbis/HomeViewportAnchorTest.kt)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。

### 7. 本机外观选择（S25）

外观按本机选择即时生效，复用统一材质、字号和聚焦规则，保留导航、内容身份与语义色。默认雾蓝并跟随系统浅深色；缩略屏允许手动指定浅色 / 深色，材质色块选择雾蓝 / 灰绿。iOS 旧 `classic` / `insetFocus` 偏好迁为雾蓝，实施与验证见 ADR-0070。

参考：[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)；[Neumorph.kt](../../android/app/src/main/java/com/orbising/orbis/Neumorph.kt)。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## Consequences

新页面复用共用视觉与交互组件，嵌套层次通过统一的空间和材质表达。
UI 状态更新不改变消息 key、会话身份或协议事实；历史位置校正只维持原来的阅读锚点。
模糊渐显是可降级的绘制效果，不是消息完成或同步完成的证据。

历史材质与配额币对照保存在 `.artifacts/ui-regression/20261103-provider-well-shadow/`、`.artifacts/ui-regression/20261103-provider-well-rounded/`；目录后台投影证据见 `.artifacts/ui-regression/20261105-drawer-background/summary.md`。这些证据对应当时实现，本轮视觉验收单独记录。
