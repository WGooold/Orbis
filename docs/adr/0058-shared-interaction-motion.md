# ADR-0058：共用交互动效

日期：2026-11-01；Status: accepted。

交互动效复用共用组件，操作、内容身份与阅读保持连贯；取消、离页和辅助功能由共用生命周期管理。

当前沿用 r48 消息旁菜单与显式选字、r43 按钮轻压；iOS 双侧边缘增强暂不交付。具体几何、时长、曲线和覆盖由实现及测试断言决定，不在 ADR 复制。SC01–SC50、MOT-01–MOT-27 为保留标识。

首页下拉刷新（M15 / UI-05）沿用平台手势与共用回位，网络核对和页面反馈各自管理，已有快照与视口持续保留。实现及回归见 [HomePullRefresh.swift](../../ios/Orbis/Orbis/HomePullRefresh.swift)、[HomePullRefreshTests.swift](../../ios/Orbis/Tests/HomePullRefreshTests.swift)、[MainActivity.kt](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)。

复制反馈（M05 / SC23 / MOT-08）在复制图标与成功勾号之间双向淡入淡出并缩放，图标按钮、文字按钮及消息菜单复用固定图标槽；减少动画设置下直接切换，成功反馈生命周期沿用现有计时。实现见 [CopyFeedback.kt](../../android/app/src/main/java/com/orbising/orbis/CopyFeedback.kt) 与 [InteractionMotion.swift](../../ios/Orbis/Orbis/InteractionMotion.swift)，双向中间帧与尺寸回归见 [CopyFeedbackInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/CopyFeedbackInstrumentedTest.kt)。本次构建及自动验证证据保存在 `.artifacts/ui-regression/copy-glyph-transition/`；视觉效果待用户验证。

下载反馈（M16 / UI-06）表示本地任务受理，复用共用视觉与生命周期，保持命中、布局和阅读稳定。返回来源见 [ADR-0054](0054-shared-full-page-navigation.md)；实现见 [DownloadFlight.kt](../../android/app/src/main/java/com/orbising/orbis/DownloadFlight.kt) 与 [OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)，回归见 [DownloadFlightInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DownloadFlightInstrumentedTest.kt) 和 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。

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
| SC50 | 各后端内容步骤分卡、并行工具组折叠与局部分页（S31） |

入口：[基线](0051-ui-style-motion-and-visual-stability-freeze.md)；[根部规则](../../AGENTS.md#测试)；[iOS 动效](../../ios/Orbis/Orbis/InteractionMotion.swift) / [几何测试](../../ios/Orbis/Tests/MotionGeometryTests.swift) / [UI 测试](../../ios/Orbis/UITests/OrbisUITests.swift)；[Android 动效](../../android/app/src/main/java/com/orbising/orbis/InteractionMotion.kt) / [设备测试](../../android/app/src/androidTest/java/com/orbising/orbis/InteractionMotionInstrumentedTest.kt)；[证据](../../.artifacts/ui-regression/)。

2026-11-05 MOT-14 / SC03 / SC08 / SC36：Android 目录后台投影与 IO 首载保持既有动效与视口行为。对应 S19 / V21、PERF-07、R48 / R57 / R65，回归见 [DrawerCatalogBackgroundInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DrawerCatalogBackgroundInstrumentedTest.kt)；实际验证与待验收项见 `.artifacts/ui-regression/20261105-drawer-background/summary.md`。

2026-11-06 MOT-27 / SC50 / S31：统一内容步骤复用回复增高和自然折叠；默认收起多工具组，展开后按固定页增加工具。已显示卡片边界在历史前插时保留，工具组以首个原生工具身份跨实时与历史表示保持外框身份。双端共用夹具与实际执行见 [证据](../../.artifacts/unified-chat-cards-20261106/)；设备与用户视觉验收待完成。
