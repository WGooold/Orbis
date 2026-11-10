# ADR-0070：统一设计、页面流程与连续动效

日期：2026-11-08

Status: accepted（实施与自动验证分别记录；待用户安装验收）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)、[ADR-0063](0063-mobile-app-language.md)。

## 依据

[交互稿](../design/Orbis%20交互稿.html)定义手机页面、操作顺序、手势与动效目标，[设计规范](../design/orbis-design-system.md)补充语义 token、组件、辅助功能和桌面映射。可点稿件中的示例数据与模拟成功不作为业务结果依据；实际发送、关闭、配置和连接结果沿用领域拥有者及现有账本。

本轮取代旧四层含深色凹槽、页面私有灰绿 / 转盘配色、经典外观、供应商横拨、目录凸起卡片与凹槽托盘、状态点呼吸、新建会话面板等 UI 决策。旧场景编号及其历史证据保留，新行为使用下列编号。

## 决策

| Feature | 行为 | 场景 |
| --- | --- | --- |
| S34 / M25 | 雾蓝与灰绿各含浅深两套语义色，全 App 同步；凹陷同色、嵌套保留内影，按压连续经过凸起 / 平面 / 凹陷，禁用去影并显示淡墨色与细轮廓 | SC54 |
| S35 / M27 | 新建在首页展开本地草稿，选 Agent、目录并可写首句；显式启动后创建远端会话，草稿形状展开到聊天页，首句复用发送账本；收起保留草稿，空输入启动见 S49 | SC55 |
| S36 | 供应商双圈分区：内圈换 Agent、外圈浏览配置、间隔凹槽不响应；手势从初触区域锁定，停稳后显式应用，独占配置先确认；5 小时和 7 天配额并列 | SC57 |
| S37 / M26 | 聊天、供应商、设置为平级根标签并保留状态；内容依次淡出、上浮淡入；设置仅连接、外观、语言，协议候选经应用后重连，外观采用缩略屏、系统选项和材质色块 | SC56 / SC54 |
| S38 | 目录使用单行树与引导线；活动状态或空闲时间占同一槽位；目录尾新建携带对应目录 | SC58 |
| M29 | 共用选择面板与菜单采用统一进退、把手跟手、取消与减少动画 | SC56 / SC55 |
| M28 | 运行、同步、重连使用实心点和绕行弧，空闲为空心点；减少动画时弧停止 | SC54 |
| M10 修订 | 左滑按卡片宽度 40% 上膛，进度环、危险色与“松手关闭”反馈；回拖解除，未达门槛的快甩回弹 | SC59 |
| S39 / V12 | 回复完成默认系统通知：仅来源明确 completed、同回合活动证据和来源代次推进后提示；按 Host / 会话 / 回合去重，取消、失败、未知、重连不补发 | SC60 |
| S40 | 首页卡片为标题两行、路径一行、模型与运行状态共用一行；长模型名省略，待确认复用状态槽位；Codex 同时可用终端版与桌面版时先选版本 | SC61 |
| S41 / M09 | 根级目录抽屉覆盖标签栏；聊天、供应商、设置保持平级，系统返回在供应商和设置直接离开应用 | SC62 |
| S42 | 双圈拖动分别锁定初触环；布局更新不重启手势，Agent 切换后拖动、吸附与绘制共用当前外圈位置；取消时清理拖动态；圆盘按钮不显示点击光晕 | SC63 |
| S43 / M29 | 选择面板尊重可用视口高度，内容滚动；选中后完成退场动画再提交，取消沿用共用关闭生命周期 | SC64 |
| S44 | 设置只显示必要状态与当前值；非显然后果由 info 图标展开；跟随系统以明确选中状态呈现 | SC65 |
| S45 | 历史与分支页不提供下载管理入口；文件下载动作保留，下载记录从首页或聊天进入 | SC66 |
| S46 | 文件差异视图显示当前差异位置与差异总数 | SC67 |
| S47 / M25 | 侧边栏归档显示位于筛选按钮左侧，未选中为凸起轮廓图标，选中为凹陷高亮实心图标；筛选菜单只管理 Agent / provider，搜索与筛选在切换时保留 | SC68 |
| S48 | 新建卡片 Agent 名称右对齐，Codex 以短名称和右侧版本图标呈现，点击展开原版本列表；保留版本的完整辅助功能名称及圆形选中凹陷，移除 Agent 按钮的方形点击光晕 | SC69 |
| S49 / M27 | 新建卡片空输入时显示可点击的启动三角，有内容时切换发送箭头；点击或回车沿原 `createSession` 开窗路径启动，空输入不创建消息；移除输入框下方首句要求提示，保留卡片开合与形变 | SC70 |

触觉用于发送、配置应用、根标签选择、多选变化、危险确认，以及双圈盘越格选择（外圈轻、里圈较重）。共用时长和曲线由两端 `InteractionMotion`、Host `Theme` 与官网 token 管理；菜单、选择面板、对话框、短反馈与减少动画沿用共用生命周期。功能文案保持直白，行为后果放在操作上；确有必要的补充说明由 info 控件按需展开。界面文案不以 `·` 分隔信息。阅读锚点、稳定身份、乐观对账与协议兼容继续由 ADR-0046 / 0049 / 0055 / 0064 维护。

设置页的连接协议行显示当前选择模式；实际路由由连接状态展示。现有 Auto 使用 WebSocket，见 [ADR-0065](0065-native-quic-relay-transport.md)。交互稿中的 QUIC 优先和固定连接示例列为待确认项；选项文字不能代替实际连接事实。

权限面板暂存候选并显式应用，文案使用当前会话的真实作用域；本地未受理时保留面板与候选。iOS 的显示与提交共用最新会话、选项、禁用原因、待答交互和待处理操作门禁。实现见 [RuntimePermissions](../../android/app/src/main/java/com/orbising/orbis/RuntimePermissions.kt)与 [PermissionsView](../../ios/Orbis/Orbis/ChatView.swift)，iOS 的动态门禁回归见 [StoreTests](../../ios/Orbis/Tests/StoreTests.swift)。

回复完成默认走手机系统通知；仅在同一已认证会话与来源代次内观察到活动回合及明确的 `live.turn.outcome=completed` 后投递，按回合身份去重。取消、失败、未知结果与恢复快照不补发成功提示。iOS 在已配对前台生命周期申请系统授权，应用挂起且没有推送通道时不能持续接收；旧 Host 缺少完成结果字段时保持静默。字段与通知生命周期见 [ADR-0028](0028-host-notification-lifecycle.md)。

Host 共用四主题、连续深度、原生 SVG 图标、焦点、禁用与加载状态；官网实际入口 `cinema-site` 采用同源 token，并同步可交互演示的草稿、目录及配额流程。Host / 官网没有对应逐页画稿，布局与信息编排的验收单独进行。

## 实现入口

- Android：[OrbisTokens.kt](../../android/app/src/main/java/com/orbising/orbis/OrbisTokens.kt)、[Neumorph.kt](../../android/app/src/main/java/com/orbising/orbis/Neumorph.kt)、[MainActivity.kt](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)、[SessionDraft.kt](../../android/app/src/main/java/com/orbising/orbis/SessionDraft.kt)、[DesignSettings.kt](../../android/app/src/main/java/com/orbising/orbis/DesignSettings.kt)、[ProviderDialScreen.kt](../../android/app/src/main/java/com/orbising/orbis/ProviderDialScreen.kt)、[SessionDrawer.kt](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt)。
- iOS：[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)、[ContentView.swift](../../ios/Orbis/Orbis/ContentView.swift)、[SessionViews.swift](../../ios/Orbis/Orbis/SessionViews.swift)、[StatusViews.swift](../../ios/Orbis/Orbis/StatusViews.swift)、[ProviderDialGeometry.swift](../../ios/Orbis/Orbis/ProviderDialGeometry.swift)。
- Host：[Theme.qml](../../packages/windows-host/src/qml/Theme.qml)、[Surface.qml](../../packages/windows-host/src/qml/Surface.qml)、[NeuSurface.cpp](../../packages/windows-host/src/NeuSurface.cpp)、[Main.qml](../../packages/windows-host/src/qml/Main.qml)。
- 官网：[入口](../../packages/relay/src/web/index.html)、[tokens.css](../../packages/relay/src/web/tokens.css)、[design-system.css](../../packages/relay/src/web/design-system.css)、[资源白名单](../../packages/relay/src/web.ts)。
- 本地化：[共用目录](../../localization/mobile.json)与[生成校验](../../scripts/generate-mobile-localizations.py)。
- 回复通知：[共享 source](../../packages/protocol/src/session-source.ts)、[Android 完成事实](../../android/app/src/main/java/com/orbising/orbis/ReplyCompletion.kt)、[iOS 完成事实与系统通知](../../ios/Orbis/Orbis/Notifications.swift)；首句校验沿用两端 `HostConnection`。

## 验证与交付

2026-11-10 S49 / SC70：空输入启动复用 Android `db3204b^` 与 iOS `8e5cccb^` 中的新建调用路径，`session.activate` 继续使用 `spawnMode: tui`。实现见两端 `SessionDraft`、`HostConnection` / `OrbisStore`；回归见 `DesignAlignmentInstrumentedTest`、`LaunchLedgerTests`、`OrbisUITests` 与 `design-demo-policy.test.ts`。构建、自动验证和交付状态见[本次证据](../../.artifacts/empty-draft-start-20261110/verification.json)；待用户验证。

2026-11-09 S48 / SC69：Android、iOS 与交互稿同步新建卡片的短名称、右侧版本图标及右对齐。Android 4 项定向设备回归通过，覆盖 320dp 完整名称、四个 Agent 按住无光晕、版本选择与实际提交目标；iOS 构建及版本菜单回归通过，桌面版单独可用断言通过，后续 Shift+Return 用例复现原有失败，原断言保留。截图、首次及既有失败指针、Release 安装包与签名校验见[本次证据](../../.artifacts/2026-11-09-codex-compact-draft/verification.json)；待用户安装验证。

2026-11-09 S47 / SC68：Android 与 iOS 的归档显示改为筛选左侧独立按钮，使用共用图标按钮的选中深度与图标状态。Android 的归档选择、provider 筛选和电脑归属 9 项设备回归通过，选中与未选中截图已核对；iOS 测试构建通过，设备回归未执行。实现、Release 包、签名与资源清理见[本次证据](../../.artifacts/drawer-archive-toggle-20261109/verification.json)；待用户安装验证。

2026-11-09 S40 / SC61：Android 首页模型与运行状态合并为一行，长模型名省略，待确认占用同一状态槽位；[HomeMaterialInstrumentedTest](../../android/app/src/androidTest/java/com/orbising/orbis/HomeMaterialInstrumentedTest.kt) 的浅深色两项回归通过，截图核对行内显示与多选几何。构建、Release 包与校验见[本次证据](../../.artifacts/home-model-status-row-20261109/verification.json)；待用户安装验证。

遵循[根部测试规则](../../AGENTS.md#测试)。本轮原始基线证据保存在 [.artifacts/design-alignment-20261108](../../.artifacts/design-alignment-20261108/)；Android 细节修订的构建、单元与设备验证、初次失败、视觉对照、未确定项及包信息保存在 [.artifacts/orbis-android-refinements-20261109](../../.artifacts/orbis-android-refinements-20261109/)。各平台自动验证、交付包、安装和用户验收各自记录；本记录的 accepted 表示采用该决策。

2026-11-09 S42 / SC63：Android 切换 Agent 后外圈仍引用旧位置状态的问题已修复；[ProviderDialInstrumentedTest](../../android/app/src/androidTest/java/com/orbising/orbis/ProviderDialInstrumentedTest.kt) 同时检查配置选择、绘制位置与拖动中间态。修复前同一位置断言失败，修复后 7 项供应商设备测试通过；[构建、首次失败与回归证据](../../.artifacts/provider-dial-state-20261109/)分别保留。安装与手动回归待用户验证。

同日 iOS S42 / SC63 核对：iPhone 17 与 iPad Air 模拟器上的连续内圈切换、外圈正反拖动、配置文字位置回归均通过，覆盖普通与减少动画；未修改圆盘实现。用例见 [OrbisUITests.testProviderOuterRingMovesAfterRepeatedAgentDrags](../../ios/Orbis/UITests/OrbisUITests.swift)，[本轮证据](../../.artifacts/provider-dial-ios-20261109/verification.json)同时保留既有键盘浏览用例的失败及历史证据；真机待用户验证。

共享 source 恢复与原生结果映射见 [执行记录](../../.artifacts/design-alignment-20261108/source-outcome-recovery-tests.log)，旧 Host / 新 Pi 能力门禁见 [兼容证据](../../.artifacts/design-alignment-20261108/source-outcome-gate/)。官网 [视觉比对](../../.artifacts/design-alignment-20261108/site/visual-qa.json)、[浏览器回归](../../.artifacts/design-alignment-20261108/site/run-final-dial/)及[编译静态资产](../../.artifacts/design-alignment-20261108/site/compiled-assets-check.json)分别保留。Host 独立本地包与签名、实际打包 runtime 核验见 [delivery.json](../../.artifacts/design-alignment-20261108/host/delivery-source-final/delivery.json)。本轮未部署 Relay、未替换正在运行的 Host；手机安装验收待完成。

Android 的[逐屏对照与设备证据](../../.artifacts/design-alignment-20261108/android/comparison/qa.json)、iOS 的[逐屏对照与设备证据](../../.artifacts/design-alignment-20261108/ios/comparison/visual-check.json)各自记录字体、布局、材质、图标与文案核对，静态截图与动效 / 业务回归分开。交付包、哈希、验证入口、平台边界和待验收项汇总于 [verification.json](../../.artifacts/design-alignment-20261108/verification.json)。
