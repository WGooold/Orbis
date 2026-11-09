# ADR-0058：共用交互动效

日期：2026-11-01；Status: accepted。

交互动效复用共用组件，操作、内容身份与阅读保持连贯；取消、离页和辅助功能由共用生命周期管理。

当前动效按 [ADR-0070](0070-unified-design-and-interaction.md) 对齐交互稿，涵盖连续深度、根标签 fade-through、草稿形变和绕行状态。SC01–SC60、MOT-01–MOT-28 保留历史身份；既有修订新增 SC54–SC60、M25–M29，本轮新增场景 SC61–SC67 复用 M03、M09 与 M29。时长、曲线、减少动画与取消路径由共用实现及测试决定。

2026-11-09 M10 / SC59：左滑露出关闭区时，进度环靠近卡片右缘并保留 12dp 留白及浅色底轨，拖动初段即可辨认进度；恢复关闭区弹性滑入、淡入缩放和文字交叉渐变，固定文字槽保持排版稳定。超过 40% 后保留 4% 回差，轻微回拖不重启文案动画，松手触发与可见上膛状态一致。实现见 [iOS 首页](../../ios/Orbis/Orbis/ContentView.swift) 与 [Android 首页](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)，回归见 [iOS UI 测试](../../ios/Orbis/UITests/OrbisUITests.swift) 与 [Android 设备测试](../../android/app/src/androidTest/java/com/orbising/orbis/HomeSwipeCloseInstrumentedTest.kt)。初版回归、动画修订构建与手机安装证据见 [.artifacts/home-swipe-close-20261109](../../.artifacts/home-swipe-close-20261109/)；最终手势观感待用户验证。

2026-11-09 S43 / M29 / SC64 修复：Android 底部面板按实际窗口测量并统一处理安全区，窗口完成布局后播放入场；选择、关闭按钮、遮罩、返回和把手拖动复用完整退场。短屏下载选择与问卷采用整段滚动，保留末项与操作按钮的可达性。实现见 [OrbisSheet.kt](../../android/app/src/main/java/com/orbising/orbis/OrbisSheet.kt)、[RemoteFileBrowser.kt](../../android/app/src/main/java/com/orbising/orbis/RemoteFileBrowser.kt) 与 [QuestionnaireDialog.kt](../../android/app/src/main/java/com/orbising/orbis/QuestionnaireDialog.kt)；八类入口、真实窗口边界及动画中间帧回归见 [BottomSheetInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/BottomSheetInstrumentedTest.kt)。修复前失败、修复后自动验证与安装包信息见 [.artifacts/bottom-sheet-20261109](../../.artifacts/bottom-sheet-20261109/)；待用户安装验收。

首页下拉刷新（M15 / UI-05）沿用平台手势与共用回位，网络核对和页面反馈各自管理，已有快照与视口持续保留。实现及回归见 [HomePullRefresh.swift](../../ios/Orbis/Orbis/HomePullRefresh.swift)、[HomePullRefreshTests.swift](../../ios/Orbis/Tests/HomePullRefreshTests.swift)、[MainActivity.kt](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)。

复制反馈（M05 / SC23 / MOT-08）在复制图标与成功勾号之间双向淡入淡出并缩放，图标按钮、文字按钮及消息菜单复用固定图标槽；减少动画设置下直接切换，成功反馈生命周期沿用现有计时。实现见 [CopyFeedback.kt](../../android/app/src/main/java/com/orbising/orbis/CopyFeedback.kt) 与 [InteractionMotion.swift](../../ios/Orbis/Orbis/InteractionMotion.swift)，双向中间帧与尺寸回归见 [CopyFeedbackInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/CopyFeedbackInstrumentedTest.kt)。本次构建及自动验证证据保存在 `.artifacts/ui-regression/copy-glyph-transition/`；视觉效果待用户验证。

下载反馈（M16 / UI-06）表示本地任务受理，复用共用视觉与生命周期，保持命中、布局和阅读稳定。返回来源见 [ADR-0054](0054-shared-full-page-navigation.md)；Android 聊天页及 iOS 聊天 / 历史页使用下载飞入，Android 历史页不再放置下载管理入口；实现见 [DownloadFlight.kt](../../android/app/src/main/java/com/orbising/orbis/DownloadFlight.kt) 与 [OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)，回归见 [DownloadFlightInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DownloadFlightInstrumentedTest.kt) 和 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。

| 场景 | 作用 |
| --- | --- |
| SC01 | 首页单卡关闭 |
| SC02 | 首页多选 |
| SC03 | 目录多选 |
| SC04 | 下载记录操作 |
| SC05 | 供应商移除 |
| SC06 | 首页电脑切换 |
| SC07 | 目录电脑管理 |
| SC08 | 目录筛选与设置 |
| SC09 | 历史筛选 |
| SC10 | 供应商切换 |
| SC11 | 当前用户消息 |
| SC12 | 历史用户消息 |
| SC13 | 本地待确认消息 |
| SC14 | 空闲发送 |
| SC15 | 运行中发送 |
| SC16 | Slash 命令 |
| SC17 | 最近提问提醒 |
| SC18 | 回到最新 |
| SC19 | 下载按钮 |
| SC20 | 设置与刷新 |
| SC21 | 导航与列表操作 |
| SC22 | 输入与附件操作 |
| SC23 | 复制反馈 |
| SC24 | 目录与文件浏览 |
| SC25 | 文件与工具切换 |
| SC26 | 通知与交互 |
| SC27 | 配额显示 |
| SC28 | 首页与目录导航 |
| SC29 | 下载导航 |
| SC30 | 添加电脑 |
| SC31 | 业务面板 |
| SC32 | 系统与根页面 |
| SC33 | 边缘返回 |
| SC34 | 状态与短反馈 |
| SC35 | 共用操作按钮 |
| SC36 | 目录筛选更新 |
| SC37 | 刷新按钮反馈 |
| SC38 | 选择反馈 |
| SC39 | 桌面导航 |
| SC40 | 会话启动 |
| SC41 | 消息长按 |
| SC42 | 提醒与滚动 |
| SC43 | 首页会话操作 |
| SC44 | 官网演示 |
| SC45 | 后台子任务 |
| SC46 | 语言选择 |
| SC47 | 回复卡片变化 |
| SC48 | 当前连接协议与电脑、路径、断线状态同步（S28） |
| SC49 | 设置页三种协议模式选择与 Host 隔离（S29） |
| SC50 | 各后端内容步骤分卡、并行工具组折叠与局部分页（S31 / [ADR-0066](0066-unified-chat-card-presentation.md)） |
| SC51 | Android 首版三根导航与供应商弧盘（横拨由 SC57 双圈交互替换） |
| SC52 | 跨 Agent 子代理短标题、状态与不完整 / 待核对提示（S33；复用既有任务折叠与稳定身份） |
| SC53 | 旧首页凸起呼吸状态点（由 M28 绕行弧替换；保留历史证据） |
| SC54 | 四主题跨页、Agent 作用域、外观选择、绕行状态与减少动画 |
| SC55 | 本地草稿开合、首发、失败保留、Host 归属与聊天形状展开 |
| SC56 | 协议候选选择、取消与显式应用重连 |
| SC57 | 双圈初触分区、凹槽、阈值、吸附、停稳后应用与双配额 |
| SC58 | 单行目录树、状态 / 时间槽、目录末新建与阅读保持 |
| SC59 | 40% 关闭上膛、回拖解除、未上膛快甩回弹 |
| SC60 | 回复完成通知只由来源明确终态驱动，跨来源代次与重连保持去重 |
| SC61 | 首页会话卡片固定行数，Codex 同时有终端版和桌面版时可明确选择 |
| SC62 | 根级抽屉覆盖底部标签栏；供应商和设置的系统返回直接离开根页面 |
| SC63 | 供应商双圈拖动保持独立，取消后恢复状态且点击无额外光晕 |
| SC64 | 选择弹层适配可用高度、长内容可滚动、提交和取消均播放完整退场 |
| SC65 | 设置文案保持简短，必要说明按 info 展开，跟随系统状态清晰可辨 |
| SC66 | 历史与分支不提供下载管理入口，历史文件仍可下载 |
| SC67 | 文件差异视图显示当前位置与已读总数或完整差异总数 |

入口：[基线](0051-ui-style-motion-and-visual-stability-freeze.md)；[根部规则](../../AGENTS.md#测试)；[iOS 动效](../../ios/Orbis/Orbis/InteractionMotion.swift) / [几何测试](../../ios/Orbis/Tests/MotionGeometryTests.swift) / [UI 测试](../../ios/Orbis/UITests/OrbisUITests.swift)；[Android 动效](../../android/app/src/main/java/com/orbising/orbis/InteractionMotion.kt) / [设备测试](../../android/app/src/androidTest/java/com/orbising/orbis/InteractionMotionInstrumentedTest.kt)；[证据](../../.artifacts/ui-regression/)。

2026-11-05 MOT-14 / SC03 / SC08 / SC36：Android 目录后台投影与 IO 首载保持既有动效与视口行为。对应 S19 / V21、PERF-07、R48 / R57 / R65，回归见 [DrawerCatalogBackgroundInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DrawerCatalogBackgroundInstrumentedTest.kt)；实际验证与待验收项见 `.artifacts/ui-regression/20261105-drawer-background/summary.md`。

2026-11-06 MOT-27 / SC50 / S31：统一内容步骤复用回复增高和自然折叠；默认收起多工具组，展开后按固定页增加工具。已显示卡片边界在历史前插时保留，工具组以首个原生工具身份跨实时与历史表示保持外框身份。双端共用夹具与实际执行见 [证据](../../.artifacts/unified-chat-cards-20261106/)；设备与用户视觉验收待完成。

2026-11-08：SC53 的凸起呼吸效果已被 M28 实心 / 空心状态点与绕行弧取代。旧证据保存在 `.artifacts/ui-regression/20261107-home-raised-sync-dot/`；本轮验证与安装验收见 [ADR-0070](0070-unified-design-and-interaction.md)。
