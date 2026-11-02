# ADR-0058：统一交互动效、触点来源与可中断转场

日期：2026-11-01

Status: accepted（用户已授权；先盘点、定规则及 ticket，再实施。实现及设备验收状态分别记录，本文不宣称交付）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) r31，S10、S15、S24、M01–M03、M05–M12、M14、M16–M20、V01–V03、V06、V09–V13、V16–V18、V21–V22；[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0054](0054-shared-full-page-navigation.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)、[ADR-0057](0057-chat-latest-question-reminder.md)。实施拆分见 [MOT ticket](../agents/interaction-motion-tickets.md)，测试见 [UI 回归方案](../testing/ui-regression.md)。

## Context

用户希望全部交互具有一致、可追溯来源的动效，并明确要求先归纳需求、查实际代码覆盖场景、形成 ADR 与 ticket，最后实施。盘点基点是 `8e259bb`，双端共用组件与实际调用方一并核查；原工作区未提交的 r27 乐观操作文档是既有授权约束，必要规则同步进本分支，但不混入其他任务的代码。

当前存在四个结构问题：选择底色只有淡变，顶栏分支直接替换；iOS 菜单只有扁平列表，Android provider 筛选已有条件分支二级页但缺少共用转场栈；用户消息操作常驻下方；关闭命令隐藏数据早于卡片退场完成。系统边缘返回与应用内整页拖动也尚未共用进度。不能只给用户举出的按钮逐个补动画。

## Decision

### 1. 用户要求与动效类别

| 用户需求 | 共用规则 / ID | 完成形态 |
| --- | --- | --- |
| 首页卡片左滑，红转灰、松手关闭连续 | SwipeDismiss / M10 | 越阈值颜色和提示平滑变化；从释放位置继续滑出屏幕，之后收拢空位；取消回弹 |
| 输入从输入框先右后上快速进入消息区 | SendFlight / M17 新增 | 页面覆盖层按真实输入框与目标行几何运动，准确交给同一消息身份 |
| 长按多选、工具栏形变、蓝底触点扩散 | SelectionReveal + SelectionToolbar / M06 修订 | 三横线转叉，两动作向内合拢后显示批量操作；每次选中都从本次触点展开 |
| 菜单由按钮翻开，二级先变形再翻入 | AnchoredPanel + MenuStack / M18 新增 | 同一表面根、可逆两阶段过渡，逐层返回 |
| 用户消息复制 / Rewind 移到长按上方栏 | MessageActions / M19 新增，S10 修订 | 消息上方横向工具栏，从长按位置展开；不占正文布局 |
| 每个可点击图标反馈；下载弹、齿轮和历史转 | ActionGlyph / M20 新增 | 按动作角色选反馈，图形变化、触控区不变 |
| 上翻出现的最近提问提示从右上出入 | DirectionalNotice / S24 修订 | 右上滑入、反向滑出，保留来源判定及阅读状态 |
| 系统两侧边缘返回挤小当前页、露出来源 | EdgeBack / M08、M14 修订 | Android 接系统进度；iOS 是可选增强，仅在兼容既有交互时启用；取消复原，提交只退一层 |

末两项原需求均编号为 7，此处按八类维护。“翻”使用已有聊天页面的侧向层叠语言（平移、轻微透视与来源露出），不采用配额币的大角度旋转。“最新消息提示”在本次指 ADR-0057 的顶部“最近提问”；底部“回到最新”保留既有位置及点击语义，并在按钮反馈与显隐检查中覆盖。

### 2. 共用契约与参数

两端提供相同语义的 token 与组件，业务页只提供动作、状态、稳定身份和几何来源，不复制时长、弹簧和手势阈值。新增交互必须先归入下表；确实不能归类时先扩充 ADR / feature / 测试，再新增动效实现。不能仅依靠图标名称或文案猜业务成功。

| 家族 | 初始实施参数 | 来源与终点 | 反向 / 打断 |
| --- | --- | --- | --- |
| 阈值状态 | 160ms ease-out | 红关闭 → 灰“松手关闭”，图形同槽交叉淡变；两态共享稳定宽度及居中锚点，反向淡变结束不得因移除长文案而重新居中 | 退回阈值立即反转；每次进入 / 退出阈值均触觉一次，同手势反复切换持续反馈，同侧移动与松手 / 取消回弹不追加触觉 |
| SwipeDismiss | 180ms 滑至卡片宽度外；空位 160ms 收拢 | 释放坐标 → 可见区域外（包含阴影） | 未写入回弹；明确失败恢复原 key / 原列表位置 |
| SelectionReveal | 260ms ease-out 圆形裁切扩散；取消 160ms 反向淡退 | 最近一次按下坐标，圆半径到最远角 | 连续选择分别从各自触点；无触点时用卡片中心 |
| SelectionToolbar | 总 260ms；前 160ms 合拢，后 100ms 显示批量操作 | 固定按钮槽，三条自绘线中的两条旋转 ±45°、中线收拢 | 退出逐段反向；快速切换从当前进度接管 |
| AnchoredPanel | 220ms ease-out；从锚点方向位移 + 0.86 → 1 缩放 + 轻透视 → 正面 | 触发按钮真实屏幕矩形 → 安全区内面板 | 160ms 按原路径退出；锚点消失、换电脑、换页关闭 |
| MenuStack | 容器自然尺寸 160ms；内容随后侧向 220ms，前层轻退 | 同一菜单表面中当前页 → 下一页 | 返回先适配目标尺寸再反向翻；重复操作由转场状态串行接管 |
| MessageActions | 复用 AnchoredPanel，220 / 160ms | 消息可见区域上缘；空间不足时安全区内侧移 / 下置 | 触摸外部、滚动、身份失效关闭；Rewind 仍二次确认 |
| SendFlight | 总 280ms，前 70ms 向右至少24pt/dp或移至消息列并收窄至目标宽度，后 210ms 上移；末 60ms 交接 | 提交时 composer 矩形 → 已布局本地行矩形 | 快速发送按 id 独立；同页最多 3 个；离开 / 失效立即取消 |
| ActionGlyph | 通用 1 → 0.88 → 1，220ms；箭头下移 4pt/dp 后弹回；齿轮 / 历史旋转 90°，260ms | 只动图形，圆面与 48pt/dp 命中槽不动 | 每次有效激活触发；禁用不动；连续点击接管当前值 |
| DirectionalNotice | 220ms，从右 32pt/dp、上 12pt/dp 到原位，伴随淡入；160ms 逆向退出 | 顶部覆盖区 | 保留离场内容至末帧；通知优先，不移动列表 |
| EdgeBack | 跟随系统 / 边缘进度，当前页 1 → 0.96，圆角 0 → 24；向内位移上限 24pt/dp | 当前页 → 真实直接来源 | 取消复用 M08 260 / 24 弹簧；完成复用 180ms 退场 |

这些数值是此次已决定的实现目标，仍需录屏复核，不是已验收参数。M01 通用回位、M02 勾选弹簧、M03 自然高度、M16 下载飞行保持原参数，禁止用一个全局动画粗暴替换所有时长。

所有装饰覆盖层不新增业务对象、不接受触摸、不暴露重复辅助功能元素、不改变测量尺寸。会话 / Host / 分支 / 路由代次变化取消旧任务；退场期间用展示快照保留画面，但不得继续操作已失效对象。动画完成不是网络成功条件；减少 / 关闭动画直接落定，仍执行一次同样的业务动作，不等待固定延时。

2026-11-02 / r33 分类补充：M15 的 iOS 首页刷新属于原生滚动回弹，不归入 SwipeDismiss 或 EdgeBack，也不复用业务页自定义弹簧。`HomePullRefresh` 只观察 pan / offset、绘制系统活动指示器，不改变 ScrollView 的 inset / offset / delegate；释放后列表由同一个系统回弹连续复位，避免系统刷新控件先停靠再收起。顶部、方向、多选、阈值与一次提交契约由 [ADR-0053 §6](0053-settings-entry-page-motion-and-ui-regression-gate.md) 负责；验收附于 MOT-10 / C03，未完成帧审阅不能声称流畅度通过。

### 3. 关闭和发送的身份交接

关闭在松手且越阈值时只提交一次。命令写入后立即进入本地关闭状态，列表呈现层保留一份不可操作的退场卡片，直到滑出再折叠空位；不能通过推迟网络提交来凑足动画。记录 `(host, runtime, generation)` 和任务拥有者，明确失败 / 目标失效时取消退场并按 ADR-0049 恢复。批量关闭复用退出生命周期，每张选中卡片同时退场，不串行等待。目录归档、恢复及下载删除复用生命周期，保留各自确认和真实受理条件；r27 尚未实施的乐观语义不能在本次静默伪造。

发送用本次被本地 outbox 接受的 `clientMessageId` 关联 composer、动画和目标行；不按正文、索引或时间匹配。空闲发送、运行中 followUp / steer、带附件、支持的 prompt / skill Slash 都经相同入口；仍未准入的不飞。已排队项只表示进入队列，不飞向不存在的权威消息。r27 等待前置操作若将来纳入 outbox，也复用此入口而不重放。

跟随状态且目标可见时使用真实气泡落点，飞行副本与目标只在交接窗交叉淡变。上翻阅读、目标未布局 / 不可见时，只从输入框右移向消息区边缘并淡出，不自动滚动找落点；现有阅读锚点不变。恢复历史、重新进页、网络对账、出队、失败重试以外的状态更新均不得重新触发。重试产生新 id 才可产生新的反馈，失败 / 未确认仍保留下方短状态和恢复入口。

### 4. 选择模式和图标

按下位置必须在手势被识别前用不消费事件的观察器记录，长按和后续点击共享坐标来源；滚动、左滑、目录拖动不能被选择装饰抢占。选中仍是 7% 主色与 1pt/dp 描边，卡片不缩放、不换深度，22pt/dp 标记槽始终保留。取消选择不向邻卡扩散。

顶栏使用稳定的槽，不以插入 / 移除按钮驱动整栏跳位。只有首页的三横线有三线变叉；返回箭头变叉采用同一进度下的旋转 / 交叉过渡；目录原本就是叉的退出入口保持叉，只过渡标题和动作组。首页下载 / 齿轮向中间合拢后淡出，“关闭”批量按钮在同一区域显现；目录的新建 / 刷新与归档 / 恢复、下载和遗留供应商的批量操作遵守同一变换逻辑，不凭空新增按钮。

所有应用绘制的可点击图标都走共用 ActionGlyph，包含图标文字按钮里的图标。复制沿用 M05 对勾及 2.5s 恢复，再加激活反馈；发送 / 停止 / 审批触觉仍只按 M12。配额币已有专属翻面与下载飞入目标已有弹簧，复用现有动作，不能叠加两个缩放。装饰图标、静态状态灯、禁用图标、系统选择器不播放假点击反馈。

### 5. 菜单与长按操作栏

MenuStack 属于一个弹层内的导航，拥有根锚点、每层稳定 key、当前页、返回历史、容器尺寸、转场进度和焦点恢复。下一页先按内容自然尺寸变形，再从右侧翻入；旧内容保持至交接结束，不重新开第二个 Popup / Overlay 造成闪烁。返回按钮、系统返回、辅助功能 escape 先退一层，根层才关闭；点外部关闭整组。窄屏 / 长列表安全区裁切并可滚动，不以固定高度截断选项。

首页仍是直接选择电脑的单层菜单；侧边栏根菜单分为“切换电脑”“添加电脑”“取消配对当前电脑”，切换电脑打开二级清单。目录 Agent / provider 筛选可以分组为子菜单；历史筛选与设置供应商切换保持简单列表但继承同样的锚点展开。将来菜单有子级必须接 MenuStack；表单 / Slash 参数 / 权限当前属于工作区或 Sheet，不强行改成菜单。

用户消息长按展示横向操作栏，复制在前，可用时 Rewind 在后；操作栏具有同样的图标反馈、命中尺寸、复制成功状态。iOS 为系统文字选择菜单额外留出64pt，避免两栏重叠；Android 将选区复制/全选与消息操作组合在同一面板中。用户消息下方不再常驻这两个按钮，pending / 失败 / 未确认 / 撤回状态与恢复入口仍保留。用户与助手的文字选择、链接、代码复制必须可用；长按识别不能吞掉滚动或对附件的点击。历史 / 离线只读消息同样支持复制，只在原有能力允许时给 Rewind。操作与可用性在激活时重新检查，不能沿用打开时的过期快照。

### 6. 边缘返回的平台契约

Android 接系统 predictive back 的左右边缘进度和取消事件，让系统绘制小箭头，应用只按进度压缩顶层并露出真实来源；不得另外画第二个系统箭头。不支持进度的旧版本保留一次普通系统返回并播放共用退场。页内右滑继续 M08，不能与系统回调重复提交。系统边缘返回时 IME、菜单子级、模态、选择模式的返回优先级先于整页返回；保留来源页不能抢占。

用户于 2026-11-01 补充：iOS 双侧边缘返回是可选增强，不能为了对齐 Android 牺牲现有交互。iOS 没有 Android 式右边缘系统返回箭头；应用导航容器的双侧压缩与轻量指示仅在键盘、文字选择、横向代码/文件滚动及 Sheet 手势均能自然共存时启用。无法证明兼容或发现冲突则撤回新增边缘行为，保留原返回方式；这不阻塞其他七类动效。左侧普通页内右滑继续 M08（包括其原有键盘收起和页面返回行为）。只在有来源页且允许返回时启用；根首页边缘仍打开目录，首次配对不退出应用。本次决定暂不交付 iOS 新增双侧边缘手势：基础用例通过不足以证明所有原生选区及横滚兼容，已撤回新增压缩/指示/右侧向内返回代码，并增加保留原返回的回归。系统文件选择 / 分享 / 浏览器继续平台自己的手势。Sheet 保持原生下拉关闭，文件差异正文不因此获得横向退出或下拉退出；横向文件 Pager / 代码滚动优先。不得把“两侧”理解成给根页或系统页面强加返回。

### 7. 实际源码覆盖清单

下列为实施前盘点，符号名是稳定定位入口，行号以工作树为准。调用同一组件也列明业务场景，不能以修改共用组件代替逐场景验收。

| 场景编号 | 实际入口与操作 | iOS | Android | 家族 / ticket |
| --- | --- | --- | --- | --- |
| SC01 | 首页单卡左滑、越阈值、松手 / 回退 / 拒绝恢复 | `ContentView.swift / HomeView.closeSwipeGesture、runtimeCard` | `MainActivity.kt / RuntimeListScreen`、`HomeSwipeClose.kt` | SwipeDismiss / MOT-02 |
| SC02 | 首页长按 / 后续点选 / 最后一项取消 / 批量关闭 | `HomeView` | `RuntimeListScreen` | Selection、Toolbar / MOT-03 |
| SC03 | 目录在线和离线会话、搜索结果的长按 / 多选归档与恢复 | `SessionViews.swift / SessionDrawerView` | `SessionDrawer.kt / SessionDrawer、DrawerSessionRow` | 同上 |
| SC04 | 下载记录：传输中、暂停、失败、完成整卡；批量删除确认与取消 | `DownloadView.swift / DownloadsView` | `MainActivity.kt / AllDownloadsScreen、DownloadTaskCard` | 同上；完成 ShareLink 也要记录触点 |
| SC05 | 遗留供应商移除多选 | `StatusViews.swift / AgentProvidersView` | `MainActivity.kt / AgentProvidersScreen` | 共用选择和图标；仅预览 / 组件覆盖，不恢复入口 |
| SC06 | 首页电脑切换 | `HomeView.hostSwitcher、hostSwitchMenuItems` | `MainActivity.kt / HomeHostSwitcher` | AnchoredPanel / MOT-04 |
| SC07 | 目录电脑切换 / 添加 / 取消配对及二级电脑清单 | `SessionDrawerView.hostSelector` | `SessionDrawer.kt / DrawerHostSwitcher` | AnchoredPanel、MenuStack / MOT-04 |
| SC08 | 目录 Agent / 已归档 / provider 筛选与设置入口 | `SessionDrawerView.filterMenuItems` | `SessionDrawer.kt / DrawerAgentFilterMenu` | 同上 |
| SC09 | 历史与分支的其他分支 / 工具筛选 | `HistoryBranchView.swift` | `HistoryTreePage.kt` | AnchoredPanel |
| SC10 | 设置 Agent 供应商切换 | `StatusViews.swift / AgentStatusProviderCard` | `AgentStatusProviderCard.kt` | AnchoredPanel；选择仍等确认 |
| SC11 | 当前聊天用户消息、带附件、长文本、分支上的用户消息 | `ChatView.swift / ChatMessageRow` | `MainActivity.kt / UserMessageCard` | MessageActions / MOT-05 |
| SC12 | 历史预览和离线缓存用户消息 | 复用 `ChatMessageRow`，`HistoryBranchView` | `HistoryTreePage`、`OfflineHistoryScreen` 复用消息卡 | MessageActions；只读复制 |
| SC13 | 本地 pending / 队列 / 未确认 / 失败用户消息 | `PendingSendStatus、QueuedMessagesView` | `PendingSendStatus、PendingMessagesPanel` | 保留下方状态；复制动作共用，禁止不存在的 Rewind |
| SC14 | 空闲文本、附件提交 | `ChatView.submit` | `ChatScreen.submitMessage` 及发送回调 | SendFlight / MOT-06 |
| SC15 | 运行中 followUp / steer；Claude 默认排队；重试 | 同上及 `pendingAction` | 同上及 `PendingSendAction` | SendFlight；未准入不飞，不把队列当已发送 |
| SC16 | prompt / skill Slash 与模型 / thinking 等控制命令 | `SlashPickerView`、`RuntimeInfoView` | `SlashCommandPicker`、运行时详情 / 交互工作区 | 前者实际创建 outbox 才接 SendFlight，后者仅按钮反馈 |
| SC17 | 最近提问显隐、源消息变化、通知覆盖、定位、切会话 | `ChatView` 顶部 overlay | `ChatQuestionReminder.kt` 及 `ChatScreen` | DirectionalNotice / MOT-07 |
| SC18 | 回到最新按钮 | `ChatView` 底部 overlay | `ChatScreen` 底部浮动按钮 | ActionGlyph，沿用位置 / 跟随规则 |
| SC19 | 所有首页 / 聊天 / 历史下载按钮（含角标） | `OrbisIconButton`、`downloadFlightTarget` | `DownloadStatusButton`、`DownloadFlight.kt` | ActionGlyph / MOT-08；与 M16 去重 |
| SC20 | 设置齿轮、历史与分支、各级刷新 / 重连 / 重试 | `OrbisIconButton、OrbisMenuIconButton` | `NeumorphIconButton` | 旋转角色 / MOT-08 |
| SC21 | 返回、关闭、更多、筛选、搜索清除、加号、新建、归档、恢复、删除 | `OrbisIconButton、OrbisActionButton、OrbisPageHeader` | `NeumorphIconButton、NeumorphActionButton` | 通用激活 / 选择形变 |
| SC22 | 发送 / 停止、附件、移除附件、重试上传、权限入口 | `ChatView、AttachmentStrip、InteractionView` | `ChatScreen、AttachmentChips、InteractionWorkspace` | ActionGlyph；保留 disabled / haptic |
| SC23 | 消息 / 回复 / 代码 / 路径 / 全文 / 工具复制 | `OrbisCopyButton、CodeBlockView、FullMessageView、ToolDetailView、TurnFileChangesView` | `CopyIconButton、MarkdownText、ToolViews、TurnFileChangeViews` | ActionGlyph + M05 |
| SC24 | 目录新建、Git 分支刷新、文件夹上一级、文件浏览刷新 / 下载 | `SessionViews、ChatView、DownloadBrowserView` | `ComposerSessionInfo、RemoteFileBrowser、DirectoryPickerDialog` | 图标文字按钮也覆盖 |
| SC25 | 文件差异前后文件、关闭、展开；工具 / thinking 折叠箭头 | `TurnFileChangesView、CompactDisclosure` | `TurnFileChangeViews、CompactDisclosure` | ActionGlyph；M03 / M13 保留 |
| SC26 | 通知 / 错误关闭、问卷 / 审批选项、配对取消 | `OrbisNotice、InteractionView、PairingScannerView` | `NoticeBanner、QuestionnaireDialog、InteractionPanel、PairingScreen` | ActionGlyph；不改变授权和成功判定 |
| SC27 | 配额币切换 / 刷新 | `SubscriptionQuotaCoin` | `SubscriptionQuotaView` | 既有专属翻面，明确排除重复动画 |
| SC28 | 首页 / 目录 → 在线聊天 / 离线历史 / 设置 | `OrbisPageStack、OrbisPageTransition` | `OrbisPageHost、SwipeBackLayer` | EdgeBack / MOT-09 |
| SC29 | 首页 / 聊天 / 历史 → 下载；聊天 → 历史 → 下载逐层返回 | 同上 | 同上 | 同上；保存来源实例 |
| SC30 | 已配对后的添加电脑 | 同上、`PairingScannerView` | 同上、`PairingScreen` | 同上；安全配对阻断保持 |
| SC31 | 新会话、文件浏览、扫码、权限 / 会话信息、工具 / 全文、交互、文件差异 Sheet / Dialog | 各页 `.sheet`、`orbisSheet` / `OrbisDialogPanel` | `NeumorphDialog`、BottomSheet / 系统 Dialog | 原生模态；内部按钮继承；不混成菜单或整页 |
| SC32 | 首次配对根页、首页抽屉、系统文件选择 / 分享 / 外链 | `ContentView、SessionDrawerModifier`、系统组件 | `RemoteApp、ModalNavigationDrawer`、系统组件 | 明确边界；M09 和系统手势保留 |

### 8. 扩展与维护要求

新增页面、菜单、二级菜单、图标按钮、可选择卡片及发送入口必须引用此 ADR 的家族；为每个入口登记 `场景 → 共用组件 → feature → 自动用例 → 手动帧证据`。公共组件默认带动效、减少动画路径和清理；业务代码不能再直接拼装一套动画。新增例外写明原因、边界和回归，不以临时 flag 绕开全部动画。

应用自己的无样式 Button / clickable、菜单 Popup、选择 overlay 都属于审计范围。原生 Sheet、系统分享 / 文本选择等保留系统行为，并在盘点表写明，不以“所有动效”移除平台可访问性或手势契约。

## Verification

MOT-01–MOT-10 全部有具体实现入口、依赖和验收条件。正常 / 反向 / 取消 / 连点 / 数据更新 / 离页 / 减少动画每个家族均测；触觉时机自动可测，体感只能真机，不伪报。

两端 L1–L4、C01–C18、A1–A4 与新增 R33–R40 全跑；窄屏和 iPad 按 A3 / A5 检查。基线使用同设备、同配置的 `8e259bb`；已有 S24 iOS 锚点失败仍须实测，不能把它直接当作豁免。证据放 `.artifacts/ui-regression/20261101-interaction-motion/`，缺设备 / 未跑 / 失败逐项记录。

设计与 ticket 已先提交为 `0fcb8f3`，之后在 `codex/interaction-motion` 实施。当前共用组件及32组业务入口已接入，处于双端验证中，不代表验收通过。

### 实现位置与补充约束

- iOS：`InteractionMotion.swift` 提供触点观察、SelectionFill/Toolbar、MotionGlyph/ActionSymbol/MotionButton、消息操作栏、SendFlight及返回优先级；`MotionGeometry.swift` 放纯几何。`OrbisDesign.swift` 的 Overlay/MenuPanel 负责单表面菜单栈、自然高度、滚动和焦点恢复。原有整页右滑返回仍在 `ContentView.swift / OrbisPageTransition`，本次不交付 iOS 新增双侧边缘增强。
- Android：`InteractionMotion.kt` 提供同语义 token、触点和图标/选择组件；`MotionMenu.kt` 提供共用 Popup 栈；`MessageActions.kt` 通过原生 TextToolbar 保留选区与全选；`MessageSendFlight.kt` 负责准确身份飞行；`SwipeBack.kt` 负责系统 predictive back、来源保留及输入法/多选优先级。
- iOS 用户消息操作栏由真实 UIScrollView 的 pan 开始事件关闭；键盘/安全区引起的几何变化只重新定位，不误关闭。Android 保留原生选区操作，文字选择不是新的业务消息。
- 发送目标可使用源消息明确声明的 `clientMessageId` 接续本地身份；禁止正文匹配。装饰副本无可访问性节点；只有实际落到可见目标的飞行才隐藏目标行，排队/非跟随兜底不得隐藏消息。分支改写、Host/会话变化及后台切换取消飞行。键盘、旋转或窗口尺寸变化使起点/目标坐标失效时立即取消装饰轨迹并显示真实消息；只取消飞行，不清空仍在页面上的目标注册。
- 工具栏隐藏组不得拦截点击或读屏；iOS 退出时移除活动批量动作，仅保留不可访问的尺寸副本。菜单隐藏测量副本不登记焦点。二级转场仅当前页可操作。

详细入口审计、自动用例、未跑项目和证据见 [交互动效验证记录](../testing/interaction-motion.md)；MOT-10 完成之前保留“验证中”。

合并主线时统一登记为 r31，保留主线按需启动的 r30 / R32；本专题旧证据中的 R32–R39 对应当前 R33–R40。既有证据不改写，合并本身不替代设备验收。


## 2026-11-02 / r35：按压、文字、导航与列表连续性（已接入，验证中）

本节按用户新增 11 项反馈修订 r31；同名规则以本节为准，旧证据保留。基点为 `8ab14b6`，包含 r32 乐观启动与等待输入，不能回退这些业务语义。iOS 新增双侧边缘手势仍为可选且本轮不强加，现有右滑返回保留。

| 场景 | 用户要求与实际源码入口 | 共享实现 / 验收目标 | Ticket / feature |
| --- | --- | --- | --- |
| SC33 | Android `SwipeBackLayer` 的系统左右边缘返回；所有 `OrbisPageHost` 调用方 | 当前页跟手缩至 0.92，向手势反方向偏移，靠近一侧仍留至少 8dp 缝隙；直接来源保持普通右滑相同灰黑遮罩；提交后向右完整滑出，取消回弹 | MOT-11 / M08、M14 |
| SC34 | 双端标题、会话状态、筛选摘要、选中计数、连接状态与短反馈；Host 状态与数字 | 短文字 160ms 淡变，最多 4pt/dp 纵向位移；数字采用上下滚动；保留当前字号、布局槽、可访问文本与错误全文 | MOT-12 / M21、V05、V16 |
| SC35 | 双端共用 icon / action / menu / copy 按钮及导航来源 | 从 down 开始，up / cancel 回位；业务动作立即受理，导航源图层与退出菜单保留反馈到末帧，不人为延迟发送 / 停止 / 审批 | MOT-13 / M20、V13 |
| SC36 | `SessionDrawerView` / `SessionDrawer` 的 Agent、provider、归档、搜索筛选 | 稳定 key 的项插入 / 移除淡变 160ms，位置自然过渡 220ms；不为动画重建列表、重播初始进入、放宽视口断言 | MOT-14 / M22、V21 |
| SC37 | 齿轮、历史 / 分支、刷新 / 重连等旋转角色 | 按下 260ms 旋至 360°，松开 / 取消 260ms 从当前角度回到 0；短点接管当前值。每次有效按下轻触觉，系统允许时点击声；禁用、系统减少动画与静音遵守平台设置 | MOT-15 / M20、M12 |
| SC38 | 首页、目录、下载、遗留供应商的逐项选中 / 取消 | 用户引发的每次有效集合变化一次轻触觉；初次长按也只一次；数据清理、离页、退出全选模式不逐项震动 | MOT-16 / M06、M12 |
| SC39 | Qt `Main.qml` 侧栏页面按钮与首页三个统计值 | 选中凹陷、hover 凸起，材质 160ms 交叉渐变；统计槽身份稳定，旧 / 新数字上下滚动 220ms，初始不滚、无中间伪数 | MOT-17 / X03、X05 |
| SC40 | 双端新建会话确认后的启动入口（新建与恢复区别） | 启动请求立即写入；首页末尾展示该 requestId 的本地“启动中”卡，从下方 32pt/dp 上推 220ms，再进入同一启动聊天；快速上线仍完成一次呈现；失败、离页、切 Host 不重播不强拉回。恢复会话保持原入口 | MOT-18 / M23、V12、V17 |
| SC41 | `ChatMessageRow` / `UserMessageCard` 长按动作 | 应用顶部状态 / 标题栏原槽切成消息操作栏（非系统状态栏）；退出、复制、可用 Rewind，按消息身份归属；保留原生文字选择与失败恢复，不新增消息附近浮层 | MOT-19 / M19、S10、S17 |
| SC42 | `ChatQuestionReminder` / `ChatView` 提醒与滚动来源 | 预览最多一行（含标签与定位图标），辅助功能全文；仅距底部 > 三行且最近一次用户滚动朝更早内容，原问题不可见才显示；向最新滚动立即收起，惯性 / 自动更新不更改意图 | MOT-20 / S24、V01–V03 |
| SC43 | `homeCardIsCurrent` 与双端首页打开 / 关闭 / 多选 | 同 Host 已发布完整卡片在后台目录 / 模型刷新期间保持可操作；按 runtime / session / agent 的当前匹配和已认证连接确认，不用同步旗标整体禁用；断线、已删除、身份替换仍不可误操作 | MOT-21 / S18、V13、V18 |

### 共用实现与边界

- **文字家族 M21**：离散短标签 / 状态变化采用 160ms 淡变，新出现的移动端短标签淡入；Host 统计初值稳定、不滚动；旧文字仅用于绘制、不增加辅助功能节点。动态正文沿用 M04 流式揭示，输入中的文字、密码、代码、计时器不逐字符重播；错误及结果立即更新语义，动画不能延迟事实。尺寸由既有固定槽或自然布局决定，不把整个聊天重新布局。
- **按压 M20 / M12**：使用平台 Button pressed / InteractionSource；指针观察不能吞掉滚动。旋转角色共享 down / release 曲线，非旋转图标从 down 轻压并在 up 回弹；复制对勾、配额币专属翻面、下载飞入目标反馈保持去重。导航保留来源实例 / 快照，不靠全局 sleep。iOS 以系统轻触觉为主；无可靠尊重静音的应用点击声时不自制强制音频。
- **集合 M22 / 新建 M23**：目录使用稳定 key 的列表项过渡；Android 同一目录组件的目录快照插入 / 删除也复用该过渡，保留视口补偿，不扩展到聊天历史补页与流式投影。iOS 动画事务仅由筛选条件触发，搜索变化只重绑叶子行的辅助功能命中区域，不重建目录 / 列表容器。新建卡是账本 requestId 的展示，不能作为已连接事实；本地追加不重写服务器排序。进入聊天后撤掉展示副本，真实首页次序仍按权威快照。减少动画直接落定 / 导航，不能等固定时长。
- **消息操作 M19**：顶栏所有者只属于当前页面 / Host / 会话 / messageId；切换 / 删除 / 分支改写失效立即退出，Rewind 在激活时重新校验并继续原确认。历史和离线页面也给同样顶栏动作，原生选中文本的复制 / 全选保留。
- **边缘 M08**：偏移不超过缩小产生的半侧空隙减 8dp，确保两侧仍露出来源；拖动中来源遮罩最高 0.34、最低 0.18，提交沿右滑位移降为 0。系统回调只提交一次，IME / 选择 / 菜单 / Sheet 优先不变。

### r35 验证要求

新增 MOT-11–21、R45–R55 与 SC33–43；双端 L1–L4、C01–C18、A1–A4（iPad A5）、Qt 构建 / 材质测试及侧栏与数字实机帧检查。针对方向意图、身份跨刷新、返回两侧缝隙 / 退出、长按顶栏、创建只一次和 reduced-motion 写行为测试。沿用同设备同配置 `8ab14b6` 作基线；不能用旧失败名单代替实跑，也不因编译通过关单。证据 `.artifacts/ui-regression/20261102-motion-refinement/`。

### r35 实施位置与验证状态

设计先行提交 `f415a2c`。两端 `InteractionMotion` 统一按压 / 松开、文字、列表、新建卡片参数；业务动作不等待反馈。Android `SwipeBack` 接 0.92 压缩、双侧缝隙和右滑退出；iOS 保留原右滑导航。`MessageActions` / 页级 `OrbisMessageActionScope` 将长按消息操作放入原顶栏，隐藏组不可触达，原生文字选择保留。新建展示按 requestId 归属，打开其他页 / 目录 / 选择其他会话后取消跟随，不取消已受理请求。

Qt `Motion.js` / `MotionText.qml` 共用 160ms 淡变、220ms 数字滚动，侧栏在稳定按钮槽中交叉过渡凸起 / 凹陷。系统减少动画使用 macOS NSWorkspace / Windows 客户区动画偏好，运行时更新；无自制强制音效。

Android 669 项 JVM、双端构建及 Qt 5 项测试已通过；Android 全量 168 项 5 失败 / 7 外部夹具 assumption，5 失败在同设备 `8ab14b6` 基线复现。详细外观、iOS、画面与未完成门禁以 [r35 验证记录](../testing/interaction-motion.md#2026-11-02--r35-交互细化) 为准。MOT-11–21 均保持验证中；按压来源在快速嵌套导航时的全周期、真机触觉 / 静音、系统边缘箭头组合仍需人工验收，不能据组件中帧测试宣称全部入口已经验收。
