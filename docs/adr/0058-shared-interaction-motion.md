# ADR-0058：共用交互动效

日期：2026-11-01；Status: accepted。

交互动效复用共用组件，操作、内容身份与阅读保持连贯；取消、离页和辅助功能由共用生命周期管理。

当前动效按 [ADR-0070](0070-unified-design-and-interaction.md) 对齐交互稿，涵盖连续深度、根标签 fade-through、草稿形变和绕行状态。SC01–SC60、MOT-01–MOT-28 保留历史身份；既有修订新增 SC54–SC60、M25–M29，本轮新增场景 SC61–SC71 复用 M03、M06、M09、M25 与 M29。时长、曲线、减少动画与取消路径由共用实现及测试决定。

2026-11-16，V06 / V16 / SC34 的反馈分级候选修订见 [ADR-0083 §6](0083-feedback-levels-and-stale-replies.md#6-分批迁移)。新增 SC92–SC95：F3 从底部进入并按共用 `hold-toast` 管理，F4 位于顶部安全区；去重、关闭、条件解除、后台与电脑切换由反馈拥有者管理，减少动画时直接切换。当前基线与候选验收分开记录于 [ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)。

2026-11-09 S43 / M29 / SC64 修复：Android 底部面板按实际窗口测量并统一处理安全区，窗口完成布局后播放入场；选择、关闭按钮、遮罩、返回和把手拖动复用完整退场。短屏下载选择与问卷采用整段滚动，保留末项与操作按钮的可达性。实现见 [OrbisSheet.kt](../../android/app/src/main/java/com/orbising/orbis/OrbisSheet.kt)、[RemoteFileBrowser.kt](../../android/app/src/main/java/com/orbising/orbis/RemoteFileBrowser.kt) 与 [QuestionnaireDialog.kt](../../android/app/src/main/java/com/orbising/orbis/QuestionnaireDialog.kt)；八类入口、真实窗口边界及动画中间帧回归见 [BottomSheetInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/BottomSheetInstrumentedTest.kt)。修复前失败、修复后自动验证与安装包信息见 [.artifacts/bottom-sheet-20261109](../../.artifacts/bottom-sheet-20261109/)；待用户安装验收。

首页下拉刷新（M15 / UI-05）沿用平台手势与共用回位，网络核对和页面反馈各自管理，已有快照与视口持续保留。实现及回归见 [HomePullRefresh.swift](../../ios/Orbis/Orbis/HomePullRefresh.swift)、[HomePullRefreshTests.swift](../../ios/Orbis/Tests/HomePullRefreshTests.swift)、[MainActivity.kt](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)。

复制反馈（M05 / SC23 / MOT-08）在复制图标与成功勾号之间双向淡入淡出并缩放，图标按钮、文字按钮及消息菜单复用固定图标槽；减少动画设置下直接切换，成功反馈生命周期沿用现有计时。实现见 [CopyFeedback.kt](../../android/app/src/main/java/com/orbising/orbis/CopyFeedback.kt) 与 [InteractionMotion.swift](../../ios/Orbis/Orbis/InteractionMotion.swift)，双向中间帧与尺寸回归见 [CopyFeedbackInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/CopyFeedbackInstrumentedTest.kt)。本次构建及自动验证证据保存在 `.artifacts/ui-regression/copy-glyph-transition/`；视觉效果待用户验证。

下载反馈（M16 / UI-06）表示本地任务受理，复用共用视觉与生命周期，保持命中、布局和阅读稳定。返回来源见 [ADR-0054](0054-shared-full-page-navigation.md)；两端聊天页使用下载飞入，历史页均不放置下载管理入口；实现见 [DownloadFlight.kt](../../android/app/src/main/java/com/orbising/orbis/DownloadFlight.kt) 与 [OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)，回归见 [DownloadFlightInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DownloadFlightInstrumentedTest.kt) 和 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。

目录与文件浏览（FILE-BROWSER-01 / FILE-BROWSER-02）：工作目录支持输入路径跳转；下载支持按完整文件路径发起或在目录内多选。下载浏览器首次从电脑根目录打开，之后按配对电脑恢复最后一次成功读取的目录，重启 App 后仍生效。只保存当前下载浏览请求返回的目录，不保留文件勾选；工作目录及失败、过期的请求不更新记录。实现见 [Android 浏览器](../../android/app/src/main/java/com/orbising/orbis/RemoteFileBrowser.kt)、[Android 连接](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)、[iOS 浏览器](../../ios/Orbis/Orbis/DownloadView.swift) 和 [iOS 连接](../../ios/Orbis/Orbis/OrbisStore.swift)。沿用 `session.browse` 协议。

FILE-BROWSER-02 自动验证：Android 定向单测 6 项、模拟器 6 项通过；Swift 定向测试 3 项、iOS 模拟器 UI 1 项通过。测试见 [Android 单测](../../android/app/src/test/java/com/orbising/orbis/RemoteFileBrowserTest.kt)、[Android 模拟器](../../android/app/src/androidTest/java/com/orbising/orbis/DownloadFileBrowserInstrumentedTest.kt)、[Swift 状态测试](../../ios/Orbis/Tests/StoreTests.swift) 与 [iOS UI 测试](../../ios/Orbis/UITests/OrbisUITests.swift)。构建、首次失败和复验保存在 [.artifacts/file-browser-resume-20261121](../../.artifacts/file-browser-resume-20261121/)；未部署，未发布共享 QA 候选，真机待用户验证。

目录引用（CHAT-PATH-02）：聊天输入框的 `@` 浏览器用目录行右侧的按钮选择并引用电脑目录；点击目录行仍进入该目录。文件下载页继续只选择文件并保留独立的最近下载目录。引用复用现有文字路径，不改变浏览或下载协议。回归见 [Swift 路径用例](../../ios/Orbis/Tests/ComputerPathMentionTests.swift)、[Android 路径用例](../../android/app/src/test/java/com/orbising/orbis/MessageInputTest.kt) 和 [Android 浏览器用例](../../android/app/src/androidTest/java/com/orbising/orbis/DownloadFileBrowserInstrumentedTest.kt)。

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
| SC68 | 归档显示从筛选菜单移至其左侧独立按钮，未选中凸起，选中凹陷并高亮实心图标；搜索与 Agent / provider 筛选保持 |
| SC69 | 新建卡片右对齐 Agent 名称，Codex 右侧版本图标与原选择菜单 |
| SC70 | 新建卡片空输入直接启动，按钮在启动三角与发送箭头间切换，沿用草稿开合和形变 |
| SC71 | iOS 侧边栏对齐 Android 的三项预览、分级筛选、固定多选工具栏与电脑状态 |
| SC73 | 新建配置沿用选择弹层与乐观启动；配置未确认不放行首句，运行中后续设置与当前工具审批分开确认 |
| SC76 | Android 运行中显示原生本轮配置；仅确认存在差异时显示“下轮已设”，保存中、未确认和修改失败分别呈现；顶栏入口复用选择弹层，保留输入草稿 |
| SC77 | 次要 info 复用共用对话框的进入、退场和焦点；打开或关闭说明不执行相邻操作 |
| SC78 | 权限页分类切换仅更新当前选项区；草稿选择跨类别保留，固定应用按钮提交并退场，取消丢弃待选值 |
| SC79 | 新建卡片模型使用独立整行，深度与权限拥有独立固定槽位；权限组合不参与卡片宽度计算，入口沿用配置选择面板 |
| SC80 | 各 Agent 模型与深度复用共用配置弹层、提交退场和配置账本；无本轮事实的非 Codex 会话明确显示所选值，Claude effort 使用深度入口及既有失败重试 |
| SC82 | iOS 首页多选与左滑反馈独立于关闭准入；受限会话左滑显示锁和短状态，达到关闭距离后回弹并说明原因，混合关闭保留受限会话的选择；共用选中填色位于文字下方 |
| SC83 | Codex 完整子代理清单核对：原生能力、分页、嵌套、读取竞争与断线回退 |
| SC84 | iOS 顶栏模型与深度面板对齐本轮／下轮事实、保存状态、失败重试与草稿保持 |
| SC85 | Codex 权限显示跟随原生已保存选项，实际执行下一轮生效；目录差异不阻塞确认，回执丢失后读取原生设置恢复；发送失败保留输入并显示权限原因 |
| SC86 | 四家 Agent 的模型面板在本轮与所选模型、深度均确认相同时仅显示本轮；确认差异才显示下轮／后续选择，未知事实保留“当前所选” |
| SC87 | Claude 回复结束后保留原生已确认的深度；模型、别名或设置变化使旧观察失效，手机后续选择不覆盖本轮事实 |
| SC89 | iOS 单工具与嵌套工具组展开、收起时由内容自然高度带动回复表面，保留连续动效、阅读位置与内部状态 |
| SC90 | iOS 跳到最新消息以稳定尾部行定位，懒加载高度修正不使可见卡片反向抽动；保留滚动动效、减少动画、后续跟随与手动阅读 |
| SC91 | 迟到、重复的连接层回包与非致命协议错误静默；在途请求保留唯一归属，致命连接错误仍呈现 |
| SC92 | F3 底部短反馈与 F4 顶部横幅分层，按身份去重、优先级、操作、关闭和作用域管理生命周期 |
| SC93 | 自动重连与电脑离线使用既有连接状态；确认需要用户解决的连接问题才进入 F4，条件解除后恢复 |
| SC94 | 发送、配置、同步、目录、工具、文件与附件失败回到对象原位；离开对象后的有效提醒按 F3 呈现 |
| SC95 | 命令选项读取器先认领在途协议错误，再使用连接请求前缀；失败留在菜单，过期回包保持静默 |
| SC107 | Android 子代理展开行：平置标题行与旋转箭头；凹陷面内的父子树以状态点、缩进与细线表达层级（S59；取代 SC52 的整宽凸起按钮形态） |
| SC115 | Android 侧边栏会话目录：已展开分支的懒加载行首帧使用自然高度；已挂载行展开、收起时保留原动效（S19 / V21） |

入口：[基线](0051-ui-style-motion-and-visual-stability-freeze.md)；[根部规则](../../AGENTS.md#测试)；[iOS 动效](../../ios/Orbis/Orbis/InteractionMotion.swift) / [几何测试](../../ios/Orbis/Tests/MotionGeometryTests.swift) / [UI 测试](../../ios/Orbis/UITests/OrbisUITests.swift)；[Android 动效](../../android/app/src/main/java/com/orbising/orbis/InteractionMotion.kt) / [设备测试](../../android/app/src/androidTest/java/com/orbising/orbis/InteractionMotionInstrumentedTest.kt)；[证据](../../.artifacts/ui-regression/)。

2026-11-14，SC89 / M03 / M24 / S31：iOS 回复表面只在回复增高或首次入场动画期间持有裁剪高度，其余时间采用内容自然高度，避免工具折叠与外层测量争用布局。实现见 [InteractionMotion.swift](../../ios/Orbis/Orbis/InteractionMotion.swift)；中间帧、长聊天锚点、嵌套工具组与减少动画回归见 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。修复前失败、自动验证、构建与资源清理记录见 [.artifacts/ios-tool-disclosure-20261114/verification.json](../../.artifacts/ios-tool-disclosure-20261114/verification.json)。未发布；真机观感待用户验证。

2026-11-14，SC90 / SC42 / V01–V03：iOS 18+ 显式跳转使用既有尾部行身份与底部对齐，避免把懒加载的估算内容边缘作为动画目标；iOS 17 沿用原有尾部行路径。实现见 [ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)；原生可见卡片中间帧、不同距离、减少动画与更新期间跳转回归见 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。修复前反向位移、实际验证与资源清理记录见 [.artifacts/ios-jump-to-latest-20261114/verification.json](../../.artifacts/ios-jump-to-latest-20261114/verification.json)。未发布；真机观感待用户验证。

2026-11-20，SC115 / S19 / V21：侧边栏会话与目录尾项复用折叠组件，已展开行重新挂载时不重播高度动画；滚动不新增整目录遍历或刷新。实现见 [SessionDrawer.kt](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt)、[UiPolish.kt](../../android/app/src/main/java/com/orbising/orbis/UiPolish.kt)；回归见 [SessionDrawerScrollInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/SessionDrawerScrollInstrumentedTest.kt)，[隔离对照证据](../../.artifacts/android-drawer-fling-20261120/isolated-fixed/instrumentation.log)。未发布，真机体感待验证。

2026-11-05 MOT-14 / SC03 / SC08 / SC36：Android 目录后台投影与 IO 首载保持既有动效与视口行为。对应 S19 / V21、PERF-07、R48 / R57 / R65，回归见 [DrawerCatalogBackgroundInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DrawerCatalogBackgroundInstrumentedTest.kt)；实际验证与待验收项见 `.artifacts/ui-regression/20261105-drawer-background/summary.md`。

2026-11-06 MOT-27 / SC50 / S31：统一内容步骤复用回复增高和自然折叠；默认收起多工具组，展开后按固定页增加工具。已显示卡片边界在历史前插时保留，工具组以首个原生工具身份跨实时与历史表示保持外框身份。双端共用夹具与实际执行见 [证据](../../.artifacts/unified-chat-cards-20261106/)；设备与用户视觉验收待完成。

2026-11-08：SC53 的凸起呼吸效果已被 M28 实心 / 空心状态点与绕行弧取代。旧证据保存在 `.artifacts/ui-regression/20261107-home-raised-sync-dot/`；本轮验证与安装验收见 [ADR-0070](0070-unified-design-and-interaction.md)。

2026-11-09 M10 / SC59：左滑露出关闭区时，进度环靠近卡片右缘并保留 12dp 留白及浅色底轨，拖动初段即可辨认进度；恢复关闭区弹性滑入、淡入缩放和文字交叉渐变，固定文字槽保持排版稳定。超过 40% 后保留 4% 回差，轻微回拖不重启文案动画，松手触发与可见上膛状态一致。实现见 [iOS 首页](../../ios/Orbis/Orbis/ContentView.swift) 与 [Android 首页](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)，回归见 [iOS UI 测试](../../ios/Orbis/UITests/OrbisUITests.swift) 与 [Android 设备测试](../../android/app/src/androidTest/java/com/orbising/orbis/HomeSwipeCloseInstrumentedTest.kt)。初版回归、动画修订构建与手机安装证据见 [.artifacts/home-swipe-close-20261109](../../.artifacts/home-swipe-close-20261109/)；最终手势观感待用户验证。

## 2026-11-14：iOS 会话 UI 控制对齐（分阶段实施）

会话 UI 按区域观察展示状态，后台转录继续复用现有串行 worker、稳定行身份和同会话中间结果发布。页面身份与内容异步拥有权分别管理；布局、视口意图和页面工作具有各自明确的拥有者。Android 的不可变展示投影、确定宽度测量及用户移动代次作为对齐依据。

| Ticket | 实施范围 | 状态 |
| --- | --- | --- |
| IOS-CHAT-01 | 输入子树拥有草稿与局部面板；消息正文与工具的动作依赖独立于全局观察 | 已实施，定向自动验证通过；待用户验证 |
| IOS-CHAT-02 | 导航与会话各区域的展示发布边界、来源重绑 | 已实施，定向自动验证通过；待用户验证 |
| IOS-CHAT-03 | 原生输入框确定宽度测量及有界缓存 | 已实施，定向自动验证通过；待用户验证 |
| IOS-CHAT-04 | 视口策略、显式命令和用户移动归属 | 已实施，定向验证及既有失败对照完成；待用户验证 |
| IOS-CHAT-05 | 页面工作生命周期与组合回归 | 已实施，定向验证及既有失败对照完成；待用户验证 |

IOS-CHAT-01 将草稿、Slash 选择、发送选项、附件选择及权限面板交给 `ChatComposerView`。消息中的文件动作通过稳定环境引用传递，工具与完整内容读取使用带连接／会话归属的 `ChatReadContext`；详情保持原 reader 观察。放回输入框沿用 `saveDraft`／`draftRevision`。实现见 [ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)、[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)、[HistoryBranchView.swift](../../ios/Orbis/Orbis/HistoryBranchView.swift)。

回归用途见 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift) 的 `testComposerEditsDoNotRebuildTranscriptOwner` 及草稿、附件恢复、工具读取用例；实际构建、自动验证、对照和清理证据见 [.artifacts/ios-chat-control-20261114](../../.artifacts/ios-chat-control-20261114/)。部署与用户验收单独记录。

IOS-CHAT-01 自动验证：Swift 定向 6/6、最终设备定向 5/5，通过输入子树计数、草稿往返、失败附件恢复、乐观发送与工具详情。`testTruncatedContentAndToolArguments` 首轮停在截断补充文案的存在断言，`59d7d46e` 同设备对照同断言失败，保留原断言与首次证据。模拟器为 Orbis iOS Standard 2／iOS 27.0；真机中文组字、输入体感与最终用户验收待完成。

IOS-CHAT-02 将导航、页面壳、顶栏、正文、输入、通知与交互工作区拆成独立发布边界。四个业务来源在事件完成后合并采集，先安装导航与区域快照，再通知视图；同页遵守转场 hold，新的电脑／会话目标以完整上下文交接。页面动作使用固定 `ChatActionContext`，附件选择保留打开时的目标；菜单清理核对原连接内的 runtime／session。转录继续复用既有 worker 与分支代次，不增加另一套转录拥有权。canonical map 比较留在后台投影 worker，未变映射复用 rewind 准备结果。实现见 [ChatScreenPublications.swift](../../ios/Orbis/Orbis/ChatScreenPublications.swift)、[ContentView.swift](../../ios/Orbis/Orbis/ContentView.swift)、[ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)。

IOS-CHAT-02 自动验证：Swift 定向 16/16、设备定向 8/8；覆盖四源接入、最终快照、同页 hold 与切页交接、失效动作、同 runtime 换 session、后台映射比较及真实区域重建计数，并回归草稿、失败附件、乐观发送、工具读取、模型面板与交互草稿。测试用途见 [StoreTests.swift](../../ios/Orbis/Tests/StoreTests.swift)、[HomeHistoryPublicationTests.swift](../../ios/Orbis/Tests/HomeHistoryPublicationTests.swift) 与 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；构建和设备证据见 [.artifacts/ios-chat-control-20261114/ticket02-check](../../.artifacts/ios-chat-control-20261114/ticket02-check/)。部署和用户验收待完成。

IOS-CHAT-03 仅将输入行交给 `ChatComposerRowLayout`，按两侧实际按钮尺寸与 10pt 间距分配编辑器剩余宽度，测量和放置复用 `height:nil` 的同一提案；原生 TextField、焦点、按键与既有修饰链保持。缓存只保留 ideal 与最近有限宽度，`updateCache` 清除两者，遵守原生内部编辑及环境变化的布局有效性。实现见 [ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)、[MotionGeometry.swift](../../ios/Orbis/Orbis/MotionGeometry.swift)。

IOS-CHAT-03 自动验证：Swift 定向 11/11、设备定向 5/5；新增 [ComposerRowGeometryTests.swift](../../ios/Orbis/Tests/ComposerRowGeometryTests.swift) 与实际原生输入行测量用例，覆盖长中文草稿收缩／增长、焦点保持、48pt 按钮槽与 10pt 间距，并回归 Slash／审批／流式内容下的键盘。测量提案附件记录父级 inf／299pt／151.5pt 高度提案，编辑器测量与放置均无指定高度；记录边界是 styled TextField 的 LayoutSubview，不代表 TextKit 内部或物理按键调用数。构建、设备、提案及截图证据见 [.artifacts/ios-chat-control-20261114/ticket03-check](../../.artifacts/ios-chat-control-20261114/ticket03-check/)。真机组字、观感与用户验收待完成。

IOS-CHAT-04 将跟随／阅读／真实交互、提醒、分页边沿及显式滚动命令集中到纯 `ChatViewportPolicy`；像素事实保留在原生引用盒，仅离散状态实际变化时发布。iOS 17／18 执行命令前核对当前页面目标、请求序号及上下文／用户移动代次；展开工具继续同步冻结，历史完成保持既有 connection 级语义。实现见 [ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)、[MotionGeometry.swift](../../ios/Orbis/Orbis/MotionGeometry.swift)，回归见 [ChatViewportTests.swift](../../ios/Orbis/Tests/ChatViewportTests.swift) 与 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。

IOS-CHAT-04 自动验证：Swift 定向 22/22，设备定向共 9 项通过、1 项按既有可见软件键盘前提跳过、2 项原问题提醒用例失败；后两项均在 source 更新后出现 30pt 阅读锚点上移。`e5135ce` 同设备对照在首项同一锚点及原断言精确复现；第二项对照在提醒存在性断言提前失败，不能据此声称其锚点判定已完成。该静止阅读问题在 [ADR-0060](0060-mobile-relay-history-performance.md) 已记录，原断言和首次证据保留。独立的定位提问→native idle→source 更新用例通过，确认保持位置且不恢复跟随；无可见键盘环境下的输入区缩放回归通过。实际构建、对照、复核和清理见 [.artifacts/ios-chat-control-20261114/ticket04-review.json](../../.artifacts/ios-chat-control-20261114/ticket04-review.json)；真机观感、iOS 17 原生适配器运行与用户验收待完成。


2026-11-15，IOS-CHAT-05 将页面业务订阅与可见工作分开管理。挂载的会话通过原连接、Host 代次、runtime／session 和精确 token 保有 Agent interest lease；覆盖或后台不释放，实际离开才释放，来源快照失效不销毁页面租约。历史兴趣仍由原导航拥有。Git 核对只在场景前台、页面置顶、转场停稳且入场完成时执行，恢复时立即核对，后续沿用 15 秒周期。实现见 [AgentState.swift](../../ios/Orbis/Orbis/AgentState.swift)、[ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)、[PageNavigation.swift](../../ios/Orbis/Orbis/PageNavigation.swift) 与 [OrbisStore.swift](../../ios/Orbis/Orbis/OrbisStore.swift)。

隐藏页面暂停逐帧／周期视觉工作、文字揭示与飞行动画，来源投影及必要读取保持原同步语义；返回时直接采用最新正文和高度，不补播隐藏期间的变化，后续前台追加仍使用既有动效。工具、完整正文、历史和文件差异使用固定来源与 presentation／request 归属；新动作核对当前目标，迟到回调与清理只作用于原请求。旧弹层独立退役，不能级联关闭替换后的弹层；全文入口以单一布局容器持有一个弹层 owner。实现见 [InteractionMotion.swift](../../ios/Orbis/Orbis/InteractionMotion.swift)、[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)、[ToolContent.swift](../../ios/Orbis/Orbis/ToolContent.swift)、[TurnFileChangesView.swift](../../ios/Orbis/Orbis/TurnFileChangesView.swift) 与 [HistoryBranchView.swift](../../ios/Orbis/Orbis/HistoryBranchView.swift)。

IOS-CHAT-05 自动验证：最终候选 Swift 定向 88/88、iOS 模拟器构建通过；组合 UI 回归分批执行，原 16 项中 13 项有通过证据、3 项原断言仍失败，并非一次全绿运行。通过项包括真实覆盖／返回期间 lease 与草稿保持、Git 暂停、六次隐藏来源更新及 arrival 不补播，原生输入焦点正反对照与覆盖后的实际坐标点击，详情替换后导出、全文失败重试和严格单一弹层查询，以及输入、发送／下载飞行、展开、阅读与输入区缩放。测试用途见 [AgentStateTests.swift](../../ios/Orbis/Tests/AgentStateTests.swift)、[VisualActivityGeometryTests.swift](../../ios/Orbis/Tests/VisualActivityGeometryTests.swift)、[ReplyCardMotionTests.swift](../../ios/Orbis/Tests/ReplyCardMotionTests.swift)、[ToolContentTests.swift](../../ios/Orbis/Tests/ToolContentTests.swift)、[TurnFileChangesTests.swift](../../ios/Orbis/Tests/TurnFileChangesTests.swift) 与 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。

未通过项及边界：两项问题提醒用例仍发生 source 更新后的阅读锚点位移；首项与 IOS-CHAT-03 对照同断言精确复现，第二项对照被提醒存在性前置断言阻断。文件变更缓存 UI 用例停在汇总卡片入口存在断言，任务前 `59d7d46e` 同设备同断言复现；该版本的原生文件变更用例也在同类入口断言失败。本轮因此没有取得 Turn sheet 打开、滑页、缓存回切及原生关闭的 UI 通过证据；原断言和首次失败保留。实际构建、分批结果、对照、独立复核和清理见 [.artifacts/ios-chat-control-20261114/ticket05-review.json](../../.artifacts/ios-chat-control-20261114/ticket05-review.json)。真机中文组字与体感、真实前后台 UI 往返、iOS 17 原生适配器运行、生产周期长时间运行及交叉版本验收待完成；部署、安装与用户验收分别记录。
