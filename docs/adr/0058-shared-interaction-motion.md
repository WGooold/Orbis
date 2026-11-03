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
| 每个可点击图标反馈（r43推翻旧旋转 / 弹动） | ActionGlyph / M20 修订 | 全部普通按钮统一轻压，手势释放即回位，触控区不变 |
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
| SendFlight | r36：总440ms；前70ms向右至少24pt/dp并收窄，210ms上移至目标右下角，再160ms原位展开；各段使用cubic ease-out，起步快、接近终点持续减速且不回弹；完整末帧一次交接 | 提交时composer矩形 → 右下角对齐的紧凑气泡 → 已布局本地行完整矩形 | 快速发送按 id 独立；同页最多 3 个；离开 / 失效立即取消 |
| ActionGlyph（r43） | 80ms：scale 1→0.94、opacity 1→0.82；release / cancel 160ms复位；两段cubic-bezier(0.2,0,0,1)，无回弹 / 位移 / 旋转 | 只动图形；圆面沿用M11、48pt/dp命中槽固定 | 不补足按压峰值；无物理按下的激活才播放完整轻压；禁用 / 离页清理，连续输入接管；减少动画仅即时透明度反馈 |
| QuotaCoin（S19 / r37，验证中） | 220ms cubic-in 到90°，340ms quartic-out 到180°；44pt/dp 币面、24°左倾轴、13段闭合铜边，约8.43pt/dp厚、174.17pt/dp透视 | 原64×56pt/dp命中槽内实体投影，角标原位淡化；正反面独立读数 | 点击接管；刷新、离页、Host / provider 变化取消；减少动画直接换面，不演示 |
| DirectionalNotice | 220ms，从右 32pt/dp、上 12pt/dp 到原位，伴随淡入；160ms 逆向退出 | 顶部覆盖区 | 保留离场内容至末帧；通知优先，不移动列表 |
| EdgeBack | 跟随系统 / 边缘进度，当前页 1 → 0.96，圆角 0 → 24；向内位移上限 24pt/dp | 当前页 → 真实直接来源 | 取消复用 M08 260 / 24 弹簧；完成复用 180ms 退场 |

这些数值是此次已决定的实现目标，仍需录屏复核，不是已验收参数。M01 通用回位、M02 勾选弹簧、M03 自然高度、M16 下载飞行保持原参数，禁止用一个全局动画粗暴替换所有时长。

所有装饰覆盖层不新增业务对象、不接受触摸、不暴露重复辅助功能元素、不改变测量尺寸。会话 / Host / 分支 / 路由代次变化取消旧任务；退场期间用展示快照保留画面，但不得继续操作已失效对象。动画完成不是网络成功条件；减少 / 关闭动画直接落定，仍执行一次同样的业务动作，不等待固定延时。

2026-11-02 / r33 分类补充：M15 的 iOS 首页刷新属于原生滚动回弹，不归入 SwipeDismiss 或 EdgeBack，也不复用业务页自定义弹簧。`HomePullRefresh` 只观察 pan / offset、绘制系统活动指示器，不改变 ScrollView 的 inset / offset / delegate；释放后列表由同一个系统回弹连续复位，避免系统刷新控件先停靠再收起。顶部、方向、多选、阈值与一次提交契约由 [ADR-0053 §6](0053-settings-entry-page-motion-and-ui-regression-gate.md) 负责；验收附于 MOT-10 / C03，未完成帧审阅不能声称流畅度通过。

### 3. 关闭和发送的身份交接

关闭在松手且越阈值时只提交一次。命令写入后立即进入本地关闭状态，列表呈现层保留一份不可操作的退场卡片，直到滑出再折叠空位；不能通过推迟网络提交来凑足动画。记录 `(host, runtime, generation)` 和任务拥有者，明确失败 / 目标失效时取消退场并按 ADR-0049 恢复。批量关闭复用退出生命周期，每张选中卡片同时退场，不串行等待。目录归档、恢复及下载删除复用生命周期，保留各自确认和真实受理条件；r27 尚未实施的乐观语义不能在本次静默伪造。

发送用本次被本地 outbox 接受的 `clientMessageId` 关联 composer、动画和目标行；不按正文、索引或时间匹配。空闲发送、运行中 followUp / steer、带附件、支持的 prompt / skill Slash 都经相同入口；仍未准入的不飞。已排队项只表示进入队列，不飞向不存在的权威消息。r27 等待前置操作若将来纳入 outbox，也复用此入口而不重放。

跟随状态且目标可见时使用真实气泡落点。r36起在本地受理时即暂时抑制目标行绘制，保留布局与唯一辅助功能语义，避免等两帧取到落点后才隐藏而先闪出完整消息。飞行层复用真实气泡画面，包含正文、附件与材质；到达目标右下角后原位展开至完整宽高，再一次交回列表，不与异位完整气泡交叉淡变。紧凑宽度为min(composer宽度,目标宽度)×0.86，高度为min(72,composer高度,目标高度×0.86)；内容按宽度同比例缩放并裁切，展开使用cubic ease-out，最终高度不设96上限。

上翻阅读、目标未布局 / 不可见时，解除暂存隐藏，只从输入框右移向消息区边缘并淡出，不自动滚动找落点；现有阅读锚点不变。恢复历史、重新进页、网络对账、出队、失败重试以外的状态更新均不得重新触发。重试产生新 id 才可产生新的反馈，失败 / 未确认仍保留下方短状态和恢复入口。

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
| SC20 | 设置齿轮、历史与分支、各级刷新 / 重连 / 重试 | `OrbisIconButton、OrbisMenuIconButton` | `NeumorphIconButton` | 统一轻压 / MOT-08（r43） |
| SC21 | 返回、关闭、更多、筛选、搜索清除、加号、新建、归档、恢复、删除 | `OrbisIconButton、OrbisActionButton、OrbisPageHeader` | `NeumorphIconButton、NeumorphActionButton` | 通用激活 / 选择形变 |
| SC22 | 发送 / 停止、附件、移除附件、重试上传、权限入口 | `ChatView、AttachmentStrip、InteractionView` | `ChatScreen、AttachmentChips、InteractionWorkspace` | ActionGlyph；保留 disabled / haptic |
| SC23 | 消息 / 回复 / 代码 / 路径 / 全文 / 工具复制 | `OrbisCopyButton、CodeBlockView、FullMessageView、ToolDetailView、TurnFileChangesView` | `CopyIconButton、MarkdownText、ToolViews、TurnFileChangeViews` | ActionGlyph + M05 |
| SC24 | 目录新建、Git 分支刷新、文件夹上一级、文件浏览刷新 / 下载 | `SessionViews、ChatView、DownloadBrowserView` | `ComposerSessionInfo、RemoteFileBrowser、DirectoryPickerDialog` | 图标文字按钮也覆盖 |
| SC25 | 文件差异前后文件、关闭、展开；工具 / thinking 折叠箭头 | `TurnFileChangesView、CompactDisclosure` | `TurnFileChangeViews、CompactDisclosure` | ActionGlyph；M03 / M13 保留 |
| SC26 | 通知 / 错误关闭、问卷 / 审批选项、配对取消 | `OrbisNotice、InteractionView、PairingScannerView` | `NoticeBanner、QuestionnaireDialog、InteractionPanel、PairingScreen` | ActionGlyph；不改变授权和成功判定 |
| SC27 | 配额币切换 / 刷新 | `SubscriptionQuotaCoin` | `SubscriptionQuotaView` | QuotaCoin / MOT-22；r37 原生实体厚边、独立双面读数，排除重复动画；r42 固定圆角矩形凹槽和常驻接触影，静止 / 减少动画保留；R58 / R59，完整门禁未完成 |
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
| SC37 | 齿轮、历史 / 分支、刷新 / 重连（r43替代旧旋转角色） | 统一80ms轻压 / 160ms复位，松手 / 取消立即反向；不旋转、不补峰值、不按图标添加触觉或声音。保留禁用 / 减少动画与实际操作语义 | MOT-15 / M20、M12 |
| SC38 | 首页、目录、下载、遗留供应商的逐项选中 / 取消 | 用户引发的每次有效集合变化一次轻触觉；初次长按也只一次；数据清理、离页、退出全选模式不逐项震动 | MOT-16 / M06、M12 |
| SC39 | Qt `Main.qml` 侧栏页面按钮与首页三个统计值 | 选中凹陷、hover 凸起，材质 160ms 交叉渐变；统计槽身份稳定，旧 / 新数字上下滚动 220ms，初始不滚、无中间伪数 | MOT-17 / X03、X05 |
| SC40 | 双端新建会话确认后的启动入口（新建与恢复区别） | 启动请求立即写入；首页末尾展示该 requestId 的本地“启动中”卡，从下方 32pt/dp 上推 220ms，再进入同一启动聊天；快速上线仍完成一次呈现；失败、离页、切 Host 不重播不强拉回。恢复会话保持原入口 | MOT-18 / M23、V12、V17 |
| SC41 | `ChatMessageRow` / `UserMessageCard` 长按动作 | 应用顶部状态 / 标题栏原槽切成消息操作栏（非系统状态栏）；退出、复制、可用 Rewind，按消息身份归属；保留原生文字选择与失败恢复，不新增消息附近浮层 | MOT-19 / M19、S10、S17 |
| SC42 | `ChatQuestionReminder` / `ChatView` 提醒与滚动来源 | 预览最多一行（含标签与定位图标），辅助功能全文；仅距底部 > 三行且最近一次用户滚动朝更早内容，原问题不可见才显示；向最新滚动立即收起，惯性 / 自动更新不更改意图 | MOT-20 / S24、V01–V03 |
| SC43 | `homeCardIsCurrent` 与双端首页打开 / 关闭 / 多选 | 同 Host 已发布完整卡片在后台目录 / 模型刷新期间保持可操作；按 runtime / session / agent 的当前匹配和已认证连接确认，不用同步旗标整体禁用；断线、已删除、身份替换仍不可误操作 | MOT-21 / S18、V13、V18 |

### 共用实现与边界

- **文字家族 M21**：离散短标签 / 状态变化采用 160ms 淡变，新出现的移动端短标签淡入；Host 统计初值稳定、不滚动；旧文字仅用于绘制、不增加辅助功能节点。动态正文沿用 M04 流式揭示，输入中的文字、密码、代码、计时器不逐字符重播；错误及结果立即更新语义，动画不能延迟事实。尺寸由既有固定槽或自然布局决定，不把整个聊天重新布局。
- **按压 M20 / M12**：使用平台 Button pressed / InteractionSource；指针观察不能吞掉滚动。r43起所有普通图标共享轻压 / 复位曲线，取消r35旋转与短按补峰值；复制对勾、配额币专属翻面、下载飞入目标反馈保持去重。导航保留来源实例 / 快照，不靠全局 sleep。r43不为普通图标增添轻触觉或声音，M12已有提交 / 选择触觉保持。
- **集合 M22 / 新建 M23**：目录使用稳定 key 的列表项过渡；Android 同一目录组件的目录快照插入 / 删除也复用该过渡，保留视口补偿，不扩展到聊天历史补页与流式投影。iOS 动画事务仅由筛选条件触发，搜索变化只重绑叶子行的辅助功能命中区域，不重建目录 / 列表容器。新建卡是账本 requestId 的展示，不能作为已连接事实；本地追加不重写服务器排序。进入聊天后撤掉展示副本，真实首页次序仍按权威快照。减少动画直接落定 / 导航，不能等固定时长。
- **消息操作 M19**：顶栏所有者只属于当前页面 / Host / 会话 / messageId；切换 / 删除 / 分支改写失效立即退出，Rewind 在激活时重新校验并继续原确认。历史和离线页面也给同样顶栏动作，原生选中文本的复制 / 全选保留。
- **边缘 M08**：偏移不超过缩小产生的半侧空隙减 8dp，确保两侧仍露出来源；拖动中来源遮罩最高 0.34、最低 0.18，提交沿右滑位移降为 0。系统回调只提交一次，IME / 选择 / 菜单 / Sheet 优先不变。

### r35 验证要求

新增 MOT-11–21、R45–R55 与 SC33–43；双端 L1–L4、C01–C18、A1–A4（iPad A5）、Qt 构建 / 材质测试及侧栏与数字实机帧检查。针对方向意图、身份跨刷新、返回两侧缝隙 / 退出、长按顶栏、创建只一次和 reduced-motion 写行为测试。沿用同设备同配置 `8ab14b6` 作基线；不能用旧失败名单代替实跑，也不因编译通过关单。证据 `.artifacts/ui-regression/20261102-motion-refinement/`。

### r35 实施位置与验证状态

设计先行提交 `f415a2c`。两端 `InteractionMotion` 统一按压 / 松开、文字、列表、新建卡片参数；业务动作不等待反馈。Android `SwipeBack` 接 0.92 压缩、双侧缝隙和右滑退出；iOS 保留原右滑导航。`MessageActions` / 页级 `OrbisMessageActionScope` 将长按消息操作放入原顶栏，隐藏组不可触达，原生文字选择保留。新建展示按 requestId 归属，打开其他页 / 目录 / 选择其他会话后取消跟随，不取消已受理请求。

Qt `Motion.js` / `MotionText.qml` 共用 160ms 淡变、220ms 数字滚动，侧栏在稳定按钮槽中交叉过渡凸起 / 凹陷。系统减少动画使用 macOS NSWorkspace / Windows 客户区动画偏好，运行时更新；无自制强制音效。

Android 669 项 JVM、双端构建及 Qt 5 项测试已通过；Android 全量 168 项 5 失败 / 7 外部夹具 assumption，5 失败在同设备 `8ab14b6` 基线复现。详细外观、iOS、画面与未完成门禁以 [r35 验证记录](../testing/interaction-motion.md#2026-11-02--r35-交互细化) 为准。MOT-11–21 均保持验证中；按压来源在快速嵌套导航时的全周期、真机触觉 / 静音、系统边缘箭头组合仍需人工验收，不能据组件中帧测试宣称全部入口已经验收。

### 2026-11-03 / r36：发送原位展开与前快后慢

SC14–SC16 / MOT-06 的原简化文字副本在末60ms淡出，完整行另行出现，造成断层。改为 iOS Canvas symbol / Android GraphicsLayer 复用真实气泡画面，70ms右移、210ms上移、160ms原位展开；各段 `1-(1-t)^3` 前快后慢，末端无过冲和回弹。目标从受理开始只占布局，不重复绘制；展开至完整尺寸后一次交回列表。长消息不设96高度上限，覆盖层沿聊天视口上缘裁切，避免跨过顶栏。页面覆盖 / 后台取消飞行，但在原行仍存在时保留目标注册，返回后下一次发送仍能准确落地。

iOS 正式行用不参与动画的绘制遮罩切换，保持可选择原生文字的不透明度与辅助功能节点；动画完成回调执行一次交接，不以额外定时器或文字淡入结束。正常时钟、软件键盘展开的录屏复查约366.1–366.7秒片段，已覆盖右移、上移、展开和无淡入的交接；冻结阶段不能代替这条连续路径。证据为 `.artifacts/ui-regression/20261103-send-unfold/verified-ios-targeted-video.mp4` 及 `verified-live-normal-*`。

几何用例检查单调减速、紧凑落点、展开锚点与完整高度；iOS设备检查长文真实像素和 A1–A4，Android检查正文及附件绘制末帧一致、隐藏 / 返回后再次发送、排队与阅读兜底。适用 C05–C06 / R37，完整双端 L1–L4 / C01–C18 / A1–A4 仍按回归方案记录。设备与手动结论见 [交互动效验证记录](../testing/interaction-motion.md)，未完成门禁不记验收。

## 2026-11-03 / r37：宣传片配额硬币原生移植（验证中）

用户指定现有设置页订阅额度硬币参照 `../video/claude` 中的效果；源片为 HTML/CSS 三维投影。双端实现同构 `QuotaCoinGeometry`，将圆柱厚边投影为闭合切片，按远近绘制并只展示朝向相机的币面。13段铜色边渐层参考 `#F3D3C3 / #C97A55 / #8A4426`，正面继续使用当前明暗 / 经典 / 雾蓝 token；没有新的白色卡片。侧面不能退化为零宽平面、镜像图标或透明闪帧。每次翻转只扫光一次，接触影宽度随角度收窄到35%，币面中心不额外摆动或抬升。

同一线性 phase 在两端映射到 cubic-in / quartic-out，各段分别220 / 340ms；不能在动画与几何中重复缓动。每个窗口独立保存700ms读数插值，翻面不把旧窗口的圆弧继续变成新窗口的值。角标仍原位淡至45%，命中区64×56保持，业务查询、首次双面演示、手动接管、刷新失败保留旧值与辅助功能说明沿用S19。减少动画跳过三维、扫光与演示，直接切换本地周期。专属动效不叠加 ActionGlyph 的缩放 / 旋转 / 触觉。

验证对应 MOT-22 / SC27、S02 / S19 / M11 / V18；两端几何单测、配额设备整类、L1–L4全量、C01–C18、R58与A1–A4必须分别记录。实现接入不代表设备或人工门禁通过。

2026-11-03 S19 / r37（MOT-22 / R58）：宣传片配额硬币的实体铜边、双面投影、扫光和220/340ms节奏已移植双端原生组件。最终隔离Swift351项、Android677项及两端构建通过，含并行图标底座修改的集成快照另构建通过。iOS SE配额专项首轮1失败后同设备2/2通过（四种外观与减少动画/XXXL）；Android配额3/3，受影响整组12/13，通用控件PixelCopy超时。iOS6张附件与实际翻面帧、Android4张组件外观图已看；Android系统全屏帧被System UI无响应弹窗干扰。资源压力下基线全量未跑完，随后共享池12项触发本任务10台上限拒绝；完整L3/L4、C01–C18、R58与Android A3未完成，不记验收。源码快照、失败、资源释放及产物边界见 `.artifacts/ui-regression/20261103-quota-coin/summary.md`。

### SC44：官网宣传片交互（2026-11-03 / r41）

归类为网页展示 `WebShowcase`，关联 X07–X10 / MOT-23 / R60。直接移植宣传片 `5672fd8` 的 S2 / S3 / S4 原始布局、机身和 GSAP 时间线，`cinema.js` / `film.js` 负责网页输入和可见性时钟。不把演示参数或成功态写回移动端 / Host。

转盘保留 393×669 卡片、1.2 倍卡片比例、半径 950 和 11 槽。播放按原片 6.2–15.3s 连续采样加速曲线转 33 格，并保留镜头升高 / 落定；手动状态使用完整可选卡片，1150ms expo-out 转到目标，横向意图超过 8px 才捕获，纵向交给页面。标题按 38ms 间隔、450ms 去模糊显字。

7 章只显示功能名称、画面与播放 / 重置；默认停在可操作位置，播放按各原片片段时长，不再统一 8500ms。手动发送保留右移 24px / 80ms 与 500ms 飞入交接、30ms 逐字墨水；保留权限与最近提问、420ms expo-out 推页 / 360ms power3-inOut 返回、520ms 二次曲线文件飞入、450ms 长按 / 260ms 触点扩散与工具栏形变、新卡 720px 起升 720ms + 300ms 落定。配额沿 24° 斜轴、220ms cubic-in + 340ms quartic-out，13 层铜边、双面图标与进度环、标签直立和底影收窄。扫码保留取景、锁定与连接回执；仅本地演示。

离屏 / 隐藏停止帧时钟，恢复不追赶。减少动画默认暂停并直接到操作终点，系统偏好变化即时停播。隐藏页面、已关闭卡片和抽屉退出焦点树；手动推页继承原片层级，目标位于来源页之上、模态层之下，不能用 inert 代替绘制层级；下载仅列出点选文件，返回保留来源；新建卡保留所选 Agent 身份。静态 CSS / SVG 掩膜与本地 GSAP 保持既有 CSP，真实发布 / 激活仍由站点接口决定。

本条不改变 SC01–SC43。R60 记录浏览器功能、原片关键帧与响应式证据；共享池 / 真机 / 其他浏览器未完成仍保持验证中。

2026-11-03 左滑补齐：`addFilmShake` 共用原片 200ms、x 为 6 / −5 / 4 / −2 / 0 的轻震；手动左滑首次超过 150 原片 px 时调用一次，同一手势内回拉 / 再越线不重复。松手、取消、切章或其他动作接管时复位 x=0，卡片仍按原阈值关闭 / 回弹。仅真实用户事件在支持时尝试 `navigator.vibrate(12)`，拒绝 / 缺少 API 不阻塞视觉或关闭；减少动画不轻震、不请求振动，播放不触发硬件。新增 R60 中帧 / 去重 / 取消 / API 退路断言，实际硬件体感未验收。

2026-11-03 / r40（验证中）：按用户反馈放大设置供应商凹槽，普通图标后方由40改为48pt/dp、圆角16，配额币后方由48改为56pt/dp、圆角28；图标和币面尺寸、供应商行布局与命中区保持。硬币底部改为常驻柔和接触影，34×10pt/dp、中心下移21pt/dp，随翻面收窄至35%，侧面透明度保留静止的75%；浅 / 深色使用既有带色scrim，中心alpha分别0.32 / 0.52。完整软影足迹位于56圆槽内；减少动画仍保留静止投影。分类沿用QuotaCoin / SC27 / MOT-22，影响S02、S04、S19，关联S13、S22、S25、M11；R58 / R59与双端L0–L4、C01–C18、A1–A4逐项记录，未完成门禁不记验收。证据 `.artifacts/ui-regression/20261103-provider-well-shadow/`。

2026-11-03 r40 凹槽/底影验证：隔离基线/候选 Swift 351/352 项、Android 681/682 项及双端构建通过。iOS 配额/外观专项 4/4；Android 正常字体/动画基线和候选专项各 7/7，大字体及减少动画各 7/7；双端两品牌四外观翻面帧已看，未见新增裁切。Android 首轮全量继承大字体/动画关闭，候选 23 失败对基线 22 失败，新增两项 PixelCopy 错误所在整类同配置复测双方各 5/5；保留原失败集合。标准配置补跑与 iOS 全量在外接盘断连时中断（Android 基线 28 项，iOS 基线 52 项为 46 过/6 失败，候选均未开始）。完整 L3/L4、C01–C18 与真实 Host 未完成，不记验收。原始失败、源码/包边界和 Android 清理阻塞见 `.artifacts/ui-regression/20261103-provider-well-shadow/summary.md`。

2026-11-03 / r42（验证中）：设置供应商凹槽统一为圆角矩形，普通标识与配额币均直接复用 `AgentIconRecess` 的默认16pt/dp圆角、既有材质与内影方向；取消配额币专用圆形/半边长圆角。普通32pt/dp标识配48pt/dp底座、44pt/dp硬币配56pt/dp底座，原居中、行布局、角标和64×56pt/dp命中区保持；硬币常驻底影与翻面几何/时序不变。范围S02 / S03 / S04 / S19，关联S22 / S25、SC27 / MOT-22、R58 / R59。新形状仍需双端L1–L4、C01–C18及A1–A4验证；旧r40圆形截图不替代本轮结果。证据 `.artifacts/ui-regression/20261103-provider-well-rounded/`。

2026-11-03 r42 圆角矩形验证：iOS 352/352、Android 682/682 单测及双端构建通过，源码检查确认普通图标和配额币共用默认16pt/dp圆角/内影。全机单台队列仍被旧磁盘故障的Android进程及残留锁阻塞，本轮L3/L4、C01–C18、R58/R59和A1–A4未运行，保留验证中；旧圆形截图不算新形状验收。源码边界、产物哈希及阻塞见 `.artifacts/ui-regression/20261103-provider-well-rounded/summary.md`。

## 2026-11-03 / r40：返回交接后立即可操作（已实施，验证中）

用户报告 iOS 聊天右滑回首页后，列表已经可见但仍须等待才能再次打开卡片。既有 M08 / M14 / V13 与本文的来源身份规则已要求返回后立即可操作，本次补充可测量的交接边界，不新增 feature ID。归类沿用 EdgeBack、SC28–SC30 / SC35、MOT-09 / MOT-13；并纳入 R19–R22 / R47。

iOS 的确认退场不再复用取消回弹并等待弹簧 `.removed`：统一采用共用 180ms ease-out 退场，到达屏外后同一完成回调无动画弹出一层，不能再有第二段原生退场、固定防抖或透明拦截层。取消仍保留质量 1 / 刚度 260 / 阻尼 24、速度接续、原阈值与来源遮罩。减少动画或松手时已在屏外直接交接。已提交返回期间不接受顶层重复按钮，离页 / 新手势令旧完成回调失效；来源预览在交接前始终不可交互，交接后仍使用原导航栈实例。

覆盖聊天 / 离线会话、设置、首页及聊天 / 历史来源的下载、历史与分支、已配对后的添加电脑；目录抽屉、菜单、Sheet 和系统页面独立检查，不借此改变原手势或业务门禁。Android 保留现有 180ms 退场实现。

验证：Debug 单调时钟记录手势释放→路径提交，正常动画预算 300ms（180ms 动画加模拟器调度余量），减少动画 / 已屏外同一调用直接完成；禁止以 XCTest 的自动空闲等待作为即时性证据。新增聊天连续返回重入与整页 / 嵌套返回预算用例，保留取消回弹、来源草稿 / 搜索和多层只退一层的既有断言。执行双端 L1–L4、C01–C18、受影响专项及 A1–A4，结果与未跑项保存 `.artifacts/ui-regression/20261103-ios-return-response/`；实现完成不代表设备 / 手动门禁通过。

本轮整页审计另复现“右滑松手同时点中下方按钮”：添加电脑从扫码按钮起手的短拖会打开扫码 Sheet，历史页从卡片起手会打开预览，旧用例仅核对标题存在而漏掉误操作。共用返回容器识别横拖后按目录现行规则临时停用内容按钮，取消其按压，直到本次 touch-up 事件派发完再恢复；手势识别器仍位于外层，竖向滚动、按钮尺寸与原业务启用条件保持。正常点按在取消后立即恢复。补强原添加电脑 / 历史短拖用例，断言不出现扫码 Sheet / 历史预览；不删除既有取消回弹、返回来源与草稿断言。

2026-11-03 r40 返回响应验证：代码已实施，应用内实测与最终专项支持返回交接修复；完整iOS全量受外接盘中断和共享设备残留锁阻塞，Android深色按压反馈及其他全量失败保留，完整人工/最终动效帧未验收。结果与未跑范围见 [UI 回归方案 §6](../testing/ui-regression.md) 和 `.artifacts/ui-regression/20261103-ios-return-response/summary.md`。


## 2026-11-03 / r43：按钮轻压重设计（已接入，验证中）

用户明确要求推翻“转一圈再转回来”。本节替代r31 / r35的ActionGlyph角色旋转、下载箭头下弹与短按补峰值；不新增feature，M20 / M12及SC18–27、SC35、SC37沿用原身份。

- 视觉：普通图标一律在80ms内轻压至94%、墨色透明度82%；松手或取消立即从当前值160ms复位，两段使用cubic-bezier(0.2,0,0,1)，无过冲。原图标、圆面、文字、48命中槽和布局不变；菜单三线/叉的语义形变仍独立存在。
- 生命周期：一个可取消任务拥有图标进度；物理up/cancel优先，不等待向下动作完成。同次物理点击的activation不再启动第二段反馈；再次按下接管当前值。键盘/读屏或同帧合并的有效点击仅一次80/160ms反馈，初始挂载旧activation不重播；禁用立即复位，离开取消任务。
- 状态：按压只表示触摸。实际加载指示器、复制成功对勾与2.5秒恢复、选择、发送飞行、配额币翻面保持各自状态与动画；不因图标名称暗示请求已发出或成功。删除共用旋转按压额外触觉，明确提交/选择仍遵循M12。
- 减少动画：不缩放、不插值，仅在按住期间即时使用82%透明度；松开恢复，激活不延时、不演示。
- 验证：双端生命周期单元用例；Android生产组件48ms取消后208ms恢复、重按/禁用与零附加触觉；iOS生产按钮夹具的取消、连续激活、命中槽及明暗/减少动画。沿用所有原按钮、导航、复制、下载、配额用例；R39 / R47 / R49、L1–L4、C01–C18及A1–A4均要求执行，不能拿仅编译或预览替代设备门禁。证据 `.artifacts/ui-regression/20261103-button-feedback/`。

2026-11-03 / r43验证：Swift355/355、Android685/685单元测试，iOS应用及UI测试构建、Android Debug/AndroidTest均通过。网页设计预览在320/736px明暗与减少动画检查通过，已看浅色窄屏及深色截图，但不计原生设备验收。双端共享入口仍被`provider-well-shadow-standard-full`与`Codex permission model preservation`的设备锁阻塞；L3/L4、C01–C18、R39/R47/R49及原生A1–A4未运行，不能比较同设备基点失败集合，保持验证中。证据 `.artifacts/ui-regression/20261103-button-feedback/summary.md`。
