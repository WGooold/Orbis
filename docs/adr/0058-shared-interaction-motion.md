# ADR-0058：共用交互动效

日期：2026-11-01；Status: accepted。

选择、工具栏、菜单、消息操作、发送、提醒、图标反馈和边缘返回复用共用组件。网络操作不等待动画；身份、阅读锚点、命中与辅助功能语义保持稳定。取消、离页和减少动画由共用生命周期处理。

当前沿用 r48 消息旁菜单与显式选字、r43 按钮轻压；iOS 双侧边缘增强暂不交付。具体几何、时长、曲线和覆盖由实现及测试断言决定，不在 ADR 复制。SC01–SC47、MOT-01–MOT-26 为保留标识。

首页下拉刷新（M15 / UI-05）只在列表顶部、向下手势达到阈值后触发一次；多选、左滑关闭与抽屉横拖不触发。列表和指示器随原生拉伸 / 共用回位状态恢复，不等待网络完成，不插入同步状态行，保留上一版完整快照与视口。iOS 观察原生 pan 和 offset，不接管 delegate、recognizer 或 contentInset；Android 沿用 Material3 手势。实现及回归见 [HomePullRefresh.swift](../../ios/Orbis/Orbis/HomePullRefresh.swift)、[HomePullRefreshTests.swift](../../ios/Orbis/Tests/HomePullRefreshTests.swift)、[MainActivity.kt](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)。

下载反馈（M16 / UI-06）只在本地实际创建或排队任务后，从点击位置向同页下载按钮飞入；它不表示下载完成。覆盖聊天、历史及其下载入口；浮层不参与命中或布局，不移动阅读锚点。连续点击有并发上限，离页 / 切会话取消，减少动画时使用按钮淡变反馈。返回来源由 [ADR-0054](0054-shared-full-page-navigation.md) 管理。实现见 [DownloadFlight.kt](../../android/app/src/main/java/com/orbising/orbis/DownloadFlight.kt) 与 [OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)，回归见 [DownloadFlightInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DownloadFlightInstrumentedTest.kt) 和 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。

| 场景 | 作用 |
| --- | --- |
| SC01 | 首页单卡左滑、越阈值、松手 / 回退 / 拒绝恢复 |
| SC02 | 首页长按 / 后续点选 / 最后一项取消 / 批量关闭 |
| SC03 | 目录在线和离线会话、搜索结果的长按 / 多选归档与恢复 |
| SC04 | 下载记录：传输中、暂停、失败、完成整卡；批量删除确认与取消 |
| SC05 | 遗留供应商移除多选 |
| SC06 | 首页电脑切换 |
| SC07 | 目录电脑切换 / 添加 / 取消配对及二级电脑清单 |
| SC08 | 目录 Agent / 已归档 / provider 筛选与设置入口 |
| SC09 | 历史与分支的其他分支 / 工具筛选 |
| SC10 | 设置 Agent 供应商切换 |
| SC11 | 当前聊天用户消息、带附件、长文本、分支上的用户消息 |
| SC12 | 历史预览和离线缓存用户消息 |
| SC13 | 本地 pending / 队列 / 未确认 / 失败用户消息 |
| SC14 | 空闲文本、附件提交 |
| SC15 | 运行中 followUp / steer；Claude 默认排队；重试 |
| SC16 | prompt / skill Slash 与模型 / thinking 等控制命令 |
| SC17 | 最近提问显隐、源消息变化、通知覆盖、定位、切会话 |
| SC18 | 回到最新按钮 |
| SC19 | 所有首页 / 聊天 / 历史下载按钮（含角标） |
| SC20 | 设置齿轮、历史与分支、各级刷新 / 重连 / 重试 |
| SC21 | 返回、关闭、更多、筛选、搜索清除、加号、新建、归档、恢复、删除 |
| SC22 | 发送 / 停止、附件、移除附件、重试上传、权限入口 |
| SC23 | 消息 / 回复 / 代码 / 路径 / 全文 / 工具复制 |
| SC24 | 目录新建、Git 分支刷新、文件夹上一级、文件浏览刷新 / 下载 |
| SC25 | 文件差异前后文件、关闭、展开；工具 / thinking 折叠箭头 |
| SC26 | 通知 / 错误关闭、问卷 / 审批选项、配对取消 |
| SC27 | 配额币切换 / 刷新 |
| SC28 | 首页 / 目录 → 在线聊天 / 离线历史 / 设置 |
| SC29 | 首页 / 聊天 / 历史 → 下载；聊天 → 历史 → 下载逐层返回 |
| SC30 | 已配对后的添加电脑 |
| SC31 | 新会话、文件浏览、扫码、权限 / 会话信息、工具 / 全文、交互、文件差异 Sheet / Dialog |
| SC32 | 首次配对根页、首页抽屉、系统文件选择 / 分享 / 外链 |
| SC33 | Android SwipeBackLayer 的系统左右边缘返回；所有 OrbisPageHost 调用方 |
| SC34 | 双端标题、会话状态、筛选摘要、选中计数、连接状态与短反馈；Host 状态与数字 |
| SC35 | 双端共用 icon / action / menu / copy 按钮及导航来源 |
| SC36 | SessionDrawerView / SessionDrawer 的 Agent、provider、归档、搜索筛选 |
| SC37 | 齿轮、历史 / 分支、刷新 / 重连（r43替代旧旋转角色） |
| SC38 | 首页、目录、下载、遗留供应商的逐项选中 / 取消 |
| SC39 | Qt Main.qml 侧栏页面按钮与首页三个统计值 |
| SC40 | 双端新建会话确认后的启动入口（新建与恢复区别） |
| SC41 | ChatMessageRow / UserMessageCard 长按动作 |
| SC42 | ChatQuestionReminder / ChatView 提醒与滚动来源 |
| SC43 | homeCardIsCurrent 与双端首页打开 / 关闭 / 多选 |
| SC44 | 官网转盘与交互演示 |
| SC45 | Claude 后台子任务 |
| SC46 | 全 App 语言选择 |
| SC47 | 回复卡片增高与首次入场 |

入口：[基线](0051-ui-style-motion-and-visual-stability-freeze.md)；[根部规则](../../AGENTS.md#测试)；[iOS 动效](../../ios/Orbis/Orbis/InteractionMotion.swift) / [几何测试](../../ios/Orbis/Tests/MotionGeometryTests.swift) / [UI 测试](../../ios/Orbis/UITests/OrbisUITests.swift)；[Android 动效](../../android/app/src/main/java/com/orbising/orbis/InteractionMotion.kt) / [设备测试](../../android/app/src/androidTest/java/com/orbising/orbis/InteractionMotionInstrumentedTest.kt)；[证据](../../.artifacts/ui-regression/)。


2026-11-05 MOT-14 / SC03 / SC08 / SC36：Android 目录后台投影与IO首载沿用现有展开、冻结视口、默认前五条与更多行为；补 `DrawerCatalogBackgroundInstrumentedTest` 的异步首载 / 显式收起保持、连续状态 / 正文更新后几何和点击、切Host / 搜索隔离。对应 S19 / V21、PERF-07、R48 / R57 / R65。没有新增动效或触觉参数；最终验证与用户门禁见 `.artifacts/ui-regression/20261105-drawer-background/summary.md`。
