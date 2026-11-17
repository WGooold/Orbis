# ADR-0082：iOS 会话页状态模型与界面调度

日期：2026-11-15

Status: in progress（IOS-CHAT-07–11 已实施；13 的原生列表、交互迁移与阅读修复已实施并通过自动回归，真机待用户验证；最终原生候选 Debug 与无签名设备 Release 构建通过。06 的埋点和模拟器诊断已接入，真机测量尚未完成；未部署。12、14 的测量开启条件尚未满足，15 须另行取得复测依据与基线授权）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) `2026-11-11/r58` 的 S10–S11、S24、S31、M03–M04、M14、M24、V09–V10；[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0054](0054-shared-full-page-navigation.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)、[ADR-0057](0057-chat-latest-question-reminder.md)、[ADR-0058](0058-shared-interaction-motion.md)（IOS-CHAT-01–05）、[ADR-0060](0060-mobile-relay-history-performance.md)（PERF-08–PERF-13）、[ADR-0064](0064-protocol-compatibility.md)。

代码指针以 `1bee5be8` 为基点，同时给出符号名；行号漂移时以符号为准。路径相对 `ios/Orbis/`。

## 1. 背景

IOS-CHAT-01–05 把会话页拆成独立发布的区域，集中了视口策略，并把页面工作与可见性分开。审查这组改动后有两类问题：

- **状态形态。** 区域发布是手写的按属性观察。视图读取全量快照，另靠一个只负责触发重算的发布器失效；两者之间由手写比较函数关联。
- **界面调度。** 页面上"何时提交"和"滚动位置是多少"都没有单一拥有者。远端事件、逐帧动画、布局回调、定时器各自决定时机，冲突靠逐处补丁化解。

仅有的真机剖析（PERF-13）显示开销在布局、测量和绘制，应用代码占比很小。IOS-CHAT-01–05 的验收以区域重建计数为主，两者衡量的不是同一件事。

本 ADR 确定目标结构和实施顺序。不改协议，不触发 ADR-0064 的兼容验证；Android 不在范围。

## 2. 证据

证据分三级。**实测**来自已有记录；**代码**是基点源码中可直接核对的事实；**推断**尚未验证，不得写成结论。

流式输出期间、以及流式中滚动，目前没有任何真机剖析。

### 2.1 实测

| 编号 | 事实 | 出处 |
| --- | --- | --- |
| E1 | 真机输入中文时主线程约占满一个核心。全程主线程 25.2s，其中 12.3s（49%）在输入框测量；4–22s 窗口内应用代码 227ms／14,946ms。条件为 iPad Air 11-inch (M2)、iOS 26.6.1、Debug 构建。 | ADR-0060 PERF-13 |
| E2 | `testQuestionReminderAppearsWhileReadingAndLocatesTheOriginalWithoutFollowing`：来源更新后阅读锚点 252.666→222.666（−30pt）。同设备对照 `e5135ce` 同断言、同位移。 | `.artifacts/ios-chat-control-20261114/ticket05-review.json` |
| E3 | `testQuestionReminderTracksNewSourceQuestionsWithoutMovingTheReader`：阅读锚点约 260.779→200.779（−60pt）。对照在提醒存在性断言提前失败，未到达同一锚点断言。 | 同上 |
| E4 | 静止阅读时的锚点偏移自 2026-11-06 起未修复：PERF-08 的发布时冻结位置策略未通过阅读回归并撤回，IOS-CHAT-04、IOS-CHAT-05 仍失败。 | ADR-0060 PERF-08 补充；ADR-0058 IOS-CHAT-04／05 记录 |
| E5 | 整页转场经 PERF-10 改善。右滑返回第三次迭代仍有长间隔（0／0／7 次，最长 17／17／39ms），原因未确认。条件为 iOS 27.0 模拟器、Debug；真机与实时会话持续发布未覆盖。 | ADR-0060 PERF-10 |
| E6 | `testTurnFileReviewLoadsOnlySelectedFilesAndRetainsCache` 停在汇总卡片入口存在断言，任务前 `59d7d46e` 同设备同断言复现。与本 ADR 无关，列此以免误判为回归。 | `ticket05-review.json` |

### 2.2 代码

状态与发布：

- `ChatScreenSnapshot`（`Orbis/ChatScreenPublications.swift:7`）含 44 个字段，每次提交全量采集。各区域是否失效由 `shellKey`、`headerKey`、`sameTranscript`、`sameComposer`、`sameWorkspace`（同文件 102–135 行）手写比较决定。区域视图可以读取未列入比较的字段，编译器不会提示。
- 区域视图统一接收 `store, screens, target, fallbackRuntime, updates` 五个参数；`updates: ScreenPublication`（`Orbis/Presentation.swift:1063`）只承载失效，不承载数据。
- 归属校验 `target.matches(store)` 分布在 38 个调用点，其中 `Orbis/ChatView.swift` 30 处。清理路径另用 `ChatActionContext.ownsRuntime`，两者语义不同。
- `Orbis/ChatView.swift` 共 2293 行、50 余个类型，含 27 个 `#if DEBUG` 块。
- 部署目标 iOS 17.0。`@Observable` 已在 `OrbisPageMotion`（`Orbis/PageNavigation.swift:223`）与 `AppLocalization` 使用。ADR-0060 PERF-12 的"评估后暂不改动"已把 `@Observable` 迁移列为可选路径，没有记录否决理由。

远端流到界面的路径（一个 delta）：

1. 传输层 `deliver`（`Orbis/WebSocketTransport.swift:763`）逐帧 `Task.yield`。
2. `HostConnection.enqueueIncoming`（`Orbis/OrbisStore.swift:1652`）逐消息 `Task.yield`。
3. `enqueueRuntimeEvent`（同文件 1676 行）按 ctl、msg、history、catchup 的优先级取事件，逐事件 `Task.yield`。
4. `applyDelta`、`publishMessages` 后进入 `scheduleTranscript`（同文件 470 行）。`ChatTranscriptWorker`（`Orbis/Presentation.swift:947`）在后台整体重建转录并复用未变行，只保留最新输入。
5. 回到主线程写入 `messages`、`streamingMessageIds`、`chatTranscript` 三个 `@Published`。
6. Hub 的 `schedulePublication`（`Orbis/OrbisHub.swift:135`）与聊天页的 `schedule`（`Orbis/ChatScreenPublications.swift:262`）各自 `Task.yield` 后采集。前者在当前 Host 有变化时调用 `OrbisStore.objectWillChange.send()`；生产代码中仍有 12 个视图以 `@EnvironmentObject` 观察 `OrbisStore`。
7. 流式行的 `MarkdownPreparation`（`Orbis/Presentation.swift:908`）后台整段解析，流式期间两次解析间隔 60ms。

以上各级都不与显示帧对齐。

逐帧工作：

- `OrbisReplyCard`（`Orbis/InteractionMotion.swift:216`）在 `TimelineView` 内逐帧改 `frame(height:)`，位于 `LazyVStack` 的行内。增高仅当回复处于 live 且为追加时播放（`ReplyCardGrowth.update`，`Orbis/MotionGeometry.swift:371`）；另有凭入场票据触发的首次出现动画。
- `MarkdownMessage`（`Orbis/ChatView.swift:1661`）的 `TimelineView` 每帧把 `now` 传给消息的全部段落（1713 行），含公式段落的 `MathWebSurface`（`Orbis/MathFragment.swift:28`）。`RevealRenderer` 仅 iOS 18 及以上生效。

滚动位置的写入方（iOS 18 路径 `ChatNativeScrollPosition`，`Orbis/ChatView.swift:1023`）：

- `defaultScrollAnchor(.bottom, for: .initialOffset)` 与 `defaultScrollAnchor(following ? .bottom : nil, for: .sizeChanges)`（1046–1047 行）。
- 展开工具前的 `position.scrollTo(y:)` 冻结（1043 行）。
- 策略请求的 `position.scrollTo(id:anchor:)`（1054–1055 行）。
- `position.isPositionedByUser = true`（1065 行）。

iOS 17 另有 `ScrollViewReader`、`scrollPosition(id:)` 与 `LegacyScrollInteraction` 一套适配器。`ChatViewportPolicy`（`Orbis/MotionGeometry.swift:41`）决定意图，但读不到也写不了精确偏移。

转录 body：

- `policy` 是 `ChatTranscriptView` 的 `@State`（`Orbis/ChatView.swift:417`），该视图的 body 同时构建整个 `ForEach`（504 行）。`interactionChanged`（`Orbis/MotionGeometry.swift:93`）在手指按下时改变 `mode`，因此拖动开始与结束各使转录 body 重算一次。
- `conversation` 在 body 内调用 `replyArrivals.observe`（492 行），每次遍历全部行并修改引用对象。

转场：

- `holdScreenPublications`（`Orbis/OrbisHub.swift:156`）是带 1s／5s 上限定时器的全局标志，只暂缓 Hub 与聊天页的发布。放开后积压的变更在停稳后一次提交。
- 根部注入的 `transfers`、`toolInventories`、`hostState`、`notifications`、`agentState`（`Orbis/ContentView.swift:90-95`）直接通知各自的观察者，不经 hold。
- `orbisVisible` 在转场首帧与末帧翻转（`OrbisPageLayer`，`Orbis/PageNavigation.swift:369`）。`ChatMessageRow` 读取 `orbisVisualActive`（`Orbis/ChatView.swift:1142`）只为暂停一个 1Hz 计时（1204 行），`MarkdownMessage` 与 `OrbisReplyCard` 也读取它。

锚点用例的夹具：

- 两项用例都使用 `viewport` 屏，来源更新由 `appendViewportContent`（`Orbis/PreviewSupport.swift:531`）发出 `session.patch`。两者都不带 `--preview-keyboard-stream`，`live.messages` 为空。
- E2 带 `--preview-question-reminder`：更新替换同一条已提交的长回复，在末尾追加一段。
- E3 带 `--preview-viewport-rows` 与 `--preview-reduce-motion`：更新除给长回复追加一段外，还新增一条用户行和一条工具行。
- 因此两项用例中都没有 live 回复，`OrbisReplyCard` 不播放增高动画；E3 还是在减少动画下失败的。E2、E3 的位移不能归因于卡片逐帧改高度。

布局：

- 顶栏、转录、输入区同在一个 `VStack`（`ChatView.body`，`Orbis/ChatView.swift:195`）。IOS-CHAT-03 的测量记录显示父级以 inf／299pt／151.5pt 的高度提议询问输入行，现由 `ChatComposerRowLayout` 的缓存吸收。IOS-CHAT-03 的真机复测尚未完成。

### 2.3 推断

- I1：E2 的位移量与一段新增正文的高度量级一致，表现为滚动视图保持了到底部的距离。E3 的更新同时新增了行，位移更大，不作同样推断。两项的位移由谁写入都尚未确定。
- I2：手指按下触发的转录 body 重算落在滚动起步帧，可能造成起步卡顿。
- I3：逐字显示期间，已显示完的段落也随 `now` 每帧重绘，代价随回复长度增长。
- I4：`orbisVisible` 翻转使已实例化的行在转场首末帧集中重算，与 E5 的长间隔可能相关。
- I5：delta 速率未知。提交次数超过帧率时，多余的采集与失效没有可见收益。

## 3. 决策

会话页的三件事各由一个拥有者负责。

### 3.1 状态

每个会话页一个 `@Observable` 页面模型。每个区域一个不可变的 `Equatable` 值，只包含该区域渲染所需的事实。视图读取区域值即完成订阅，不再有独立的失效通道。

模型是区域值的唯一写入者，沿用现有的采集与提交管线：四个业务来源、事件完成后合并采集、转场暂缓、来源重绑。第一步保持单实例加重绑的生命周期，保住 IOS-CHAT-02 的语义。

页面动作收进与会话目标绑定的动作面，当前选择准入与原归属清理各实现一次。调用点可用动作面提供的判定保护本地焦点、触感、任务与视口副作用。

### 3.2 提交时机

页面阶段由一个值表达：活动、移动中、被覆盖、后台。数据提交与动画时钟都读取它。

- 移动中暂缓提交，沿用 PERF-10 的语义与上限。
- 被覆盖或后台时照常提交，只暂停视觉工作，沿用 IOS-CHAT-05 的语义。

远端流是否按显示帧合并提交，由 IOS-CHAT-06 的测量决定。

### 3.3 滚动位置

`ChatViewportPolicy` 继续负责决策，并从转录 body 移入独立的视口控制器。

滚动位置的执行应只有一个写入方。先在现有结构内诊断 E2、E3；现有结构无法同时满足全部阅读场景时，再改由原生列表独占偏移。后者改动面大，须先取得授权。

### 3.4 保持不变

- `ChatViewportPolicy`、`ChatViewportFacts`、`ChatComposerRowGeometry` 是可单测的纯值，保持现状。
- `ChatMessageRow` 的行级等值比较保留。
- `ChatTranscriptWorker` 及后台 Markdown 解析的拥有权不变。
- IOS-CHAT-05 的 Agent interest 租约与 Git 核对时机不变。

## 4. 共同不变量

各工作项都须保持：

- **本地动作即时。** 已受理的发送、回退、跳转、放回输入框不得比现在更晚出现（ADR-0049）。
- **事件公平与优先级。** 传输与入站的逐事件 `Task.yield`、控制帧优先保持不变。
- **转场暂缓。** 同页的远端变更在页面移动期间不落在帧间；新的页面目标以完整上下文交接。
- **失效动作无效。** 页面目标不再是当前选择时，迟到的编辑、选择器与面板回调不产生业务效果。同一 runtime 换 session 视为不同目标。清理动作按原归属执行，不得取消接替会话的读取。
- **按键不发布。** 输入框按键只经 `editDraft` 持久化；store 发起的草稿写入经 `draftRevision`（PERF-12）。
- **租约与轮询。** 覆盖或后台不释放 interest 租约；Git 核对只在前台、置顶、停稳且入场完成时进行。
- **UI 基线。** 未列为需授权的工作项不改变任何可见行为与动效。
- **UI 线程。** 新增工作不在主线程执行耗时计算、I/O 或等待。

## 5. 工作项

| ID | 内容 | 依赖 | 开启条件 | 可见行为 |
| --- | --- | --- | --- | --- |
| IOS-CHAT-06 | 流式与滚动的测量埋点、锚点诊断 | 无 | 无 | 不变 |
| IOS-CHAT-07 | 页面模型与区域状态 | 无 | 无 | 不变 |
| IOS-CHAT-08 | 会话动作面 | 07 | 无 | 不变 |
| IOS-CHAT-09 | 文件拆分与调试探针归位 | 08 | 无 | 不变 |
| IOS-CHAT-10 | 页面阶段与可见性门控 | 07；06 的埋点已合入 | 无 | 不变 |
| IOS-CHAT-11 | 视口控制器与入场票据 | 10 | 无 | 不变 |
| IOS-CHAT-12 | 逐字显示的时钟门控 | 10 | 先确认 I3 成立 | 不变 |
| IOS-CHAT-13 | 阅读锚点修复 | 06 | 诊断结论；列表后端分支须授权 | 修复 E2、E3；列表后端触及 S24、M03、M04、M24、V09 |
| IOS-CHAT-14 | 远端流按帧合并提交 | 06、07 | 测量显示提交次数或其主线程占用成为问题 | 不变 |
| IOS-CHAT-15 | 输入区改为滚动视图的底部安全区内容 | 无 | IOS-CHAT-03 真机复测未通过，且须授权 | 布局结构变化，目标观感不变 |

顺序与并行：

- 07、08、09、10、11 都改 `Orbis/ChatView.swift` 与 `Orbis/ChatScreenPublications.swift`，按此顺序串行。
- 06 只增埋点与诊断开关。测量与诊断在并行工作树、基点上进行，不等待其他项。埋点在 09 之后、10 之前合入，按 09 的拆分结果重定位；10、11、12、14 的前后对比都用这套埋点。
- 10 与 12 都改 `MarkdownMessage` 的时钟逻辑，12 排在 10 之后。
- 13、14、15 在各自开启条件满足后排入，不与 07–12 并行。

每项的回归门槛只列与该项直接相关的既有用例；判定以测试源码为准。

### IOS-CHAT-06 流式与滚动的测量埋点、锚点诊断

范围：不改变产品行为。新增测量埋点与诊断开关，产出两份结论。

必须保持：Release 构建中埋点的开销可忽略；诊断开关仅 DEBUG。

建议做法：

- 用 `OSSignposter` 标记远端 delta 落地、转录提交、聊天页发布提交（附各区域是否失效）、区域 body、回复卡片高度重定目标。按秒统计 delta 数与提交数。聊天页发布提交在基点是 `ChatScreenPublications.commit`（`Orbis/ChatScreenPublications.swift:279`），IOS-CHAT-07 之后随提交迁入页面模型。
- 流式剖析在真机、Release 配置下进行，覆盖三种情形：静止跟随、流式中拖动、流式中整页转场。记录主线程占用分布与帧间隔。预览夹具在 Release 下不可用，流的来源默认采用隔离的 Host／Relay 与合成会话；真实会话限定在明确授权的范围内。真机部分标注"待用户验证"。
- 锚点诊断在模拟器、DEBUG 构建下用既有夹具进行，复用 `PreviewChatScrollProbe`（`Orbis/PreviewSupport.swift:209`）持有的原生滚动视图。在 E2、E3 的来源更新前后记录 `contentOffset.y`、`contentSize.height`、`ScrollPosition` 的状态以及修饰符收到的 `following`，先确定位移是偏移被改写，还是偏移不变而内容在行内移动。
- 再逐一切换单个候选并重跑 E2、E3：阅读态把 `.sizeChanges` 锚点设为 `.top`；阅读态不绑定 `scrollPosition`；把来源更新限定为只在视口下方新增行、不改动视口内的行。每次只变一项。
- 共用脚本放 `~/.orbis/tools/ui-regression/`，结果与边界放本任务 `.artifacts/`。

完成判据：

- 给出真机流式期间每秒 delta 数、每秒提交数、主线程占用的主要去向。
- 给出 E2–E3 位移的写入方，以及哪个候选使原断言通过。
- 两份结论写回本 ADR 第 7 节，作为 IOS-CHAT-13、IOS-CHAT-14 的开启依据。

### IOS-CHAT-07 页面模型与区域状态

范围：`Orbis/ChatScreenPublications.swift`、`Orbis/ChatView.swift`、`Orbis/ContentView.swift`（`NavigationRoot`）、`Orbis/InteractionView.swift`、`Orbis/OrbisHub.swift` 中聊天页的发布部分。首页与目录的 `homeUpdates`、`directoryUpdates` 不在本项。

必须保持：

- IOS-CHAT-02 的全部语义：四源接入、事件完成后一次采集、同页暂缓、换页完整交接、单实例重绑。
- 未变化的区域不重算；一次来源更新只使实际变化的区域失效。
- 行为与观感不变。

建议做法：

- `ChatScreenPublications` 改为 `@MainActor @Observable` 的页面模型，暂名 `ChatScreenModel`。存储属性为各区域的值：壳、顶栏、转录、输入、通知、工作区、导航。
- 各区域值使用自动合成的 `Equatable`。不可比较的成员用小包装类型提供等值（例如转录按 `contentRevision`、连接按对象身份），使"渲染所需的事实都参与比较"由编译器保证。每个区域值包含页面目标，目标变化时各区域自然失效。
- `commit` 构造新的区域值，仅在不等时赋值；重绑时全部赋值。不依赖 `@Observable` 对等值写入的处理方式。
- 区域视图持有模型引用，在 body 顶部读取一次本区域的值再向下传递，保持区域级失效粒度。
- `schedule`、`hold`、`refresh`、来源观察与代次校验原样迁入模型。

待原型验证：`@Observable` 的等值写入是否通知，以所用工具链为准，用 `withObservationTracking` 的单测固定预期。

回归门槛：`Tests/StoreTests.swift` 与 `Tests/HomeHistoryPublicationTests.swift` 中 IOS-CHAT-02 的用例；PERF-09 的 `Tests/ScreenPublicationTests.swift`；`testSourcePatchesOnlyRebuildTranscriptRegion`、`testComposerEditsDoNotRebuildTranscriptOwner`、`testPageMotionKeepsFramesDuringChatEntryAndReturn`。

完成判据：`ScreenPublication` 不再用于聊天页；区域视图不再接收 `updates` 参数；`shellKey`、`headerKey`、`same*` 比较函数删除；上述用例结果与基点一致。

### IOS-CHAT-08 会话动作面

范围：`Orbis/ChatView.swift`、`Orbis/InteractionView.swift`、`Orbis/HistoryBranchView.swift`、`Orbis/DownloadView.swift` 中以 `ChatActionContext` 校验后调用 `OrbisStore` 的位置。

必须保持：第 4 节"失效动作无效"的两种准入语义；各动作的返回值与既有触感、焦点副作用的时机。

建议做法：

- 新增与页面目标绑定的动作面，暂名 `ChatSessionActions`，由页面模型提供。发送、Slash、停止、分页、回退、待发送处理、草稿读写、附件、权限与配置入口都经它转发。
- 当前选择准入与原归属清理准入各实现一次，调用点不再出现 `target.matches(store)`。
- `ChatReadContext` 并入动作面的只读部分。
- 区域值携带渲染所需的 runtime 事实；目标 runtime 暂不可得时沿用该目标的既有事实，由模型保有。视图不再接收 `store` 与 `fallbackRuntime`。

回归门槛：IOS-CHAT-02 的失效动作与同 runtime 换 session 用例；草稿往返、失败附件恢复、乐观发送、工具读取、模型面板、交互草稿的既有用例。

完成判据：区域值承载可比较的页面事实；所有业务动作经会话动作面准入。区域视图保留必要的局部状态、闭包和同目标 runtime 回退；调用点用 `isCurrent` 保护本地副作用，不重复实现归属匹配。配置面板读取保留目标的 owner/runtime，不读取新选择的会话事实。

### IOS-CHAT-09 文件拆分与调试探针归位

范围：纯结构调整，不改逻辑。

建议做法：

- `Orbis/ChatView.swift` 按区域拆分：页面壳、顶栏、转录与滚动适配、输入区、消息行、Markdown、各面板。新文件加入 `Orbis.xcodeproj`。
- 生产视图内的探针调用收成少量调试修饰符，定义移到 `Orbis/PreviewSupport.swift`；Release 下为空实现。

回归门槛：全量编译；依赖探针的既有 UI 用例结果与基点一致。

完成判据：测量探针、夹具和调试界面集中在 `PreviewSupport`，Release 为空实现；原生后端的 DEBUG 比较入口保留至真机验收。iOS 17 的 SwiftUI 转录与滚动适配属于 Release 兼容路径，待该系统原生后端验收后再移除。

### IOS-CHAT-10 页面阶段与可见性门控

范围：`Orbis/PageNavigation.swift`（`OrbisPageLayer`）、`Orbis/OrbisDesign.swift`（`orbisVisualActive`）、页面模型，以及会话页内读取可见性的视图。

必须保持：

- 被覆盖的页面照常提交数据；返回时露出的来源页是当前内容。
- 隐藏期间的更新成为新的基线，返回后不补播入场与逐字显示（IOS-CHAT-05）。
- PERF-10 的暂缓语义与安全上限。

建议做法：

- 页面阶段作为页面模型上的一个值，由页面层在阶段变化时写入。聊天页的转场暂缓改为读取阶段；Hub 级的 `holdScreenPublications` 继续服务首页与目录。
- 可见性变化只使动画时钟的拥有者失效。把计时、逐字显示、卡片增高各自的时钟隔离成叶子视图，或经稳定的 `@Observable` 引用按需读取阶段。已静止的消息行、Markdown 与卡片在转场首末帧不重算。

待原型验证：环境值依赖的失效粒度；按需读取 `@Observable` 属性在这些视图里是否达到预期。

观察项：根部注入的五个对象不经暂缓。IOS-CHAT-06 的转场剖析显示它们造成丢帧时，再把相应视图改为经页面模型读取。

回归门槛：`Tests/PageTransitionWorkTests.swift`、`Tests/VisualActivityGeometryTests.swift`、`Tests/ReplyCardMotionTests.swift`；`testPageMotionKeepsFramesDuringChatEntryAndReturn`、`testCoveredChatKeepsSourceLeaseAndDraftWhileGitPollingPauses`。

完成判据：

- 由可见性变化引起的、已静止的行与 Markdown 重建计数为零（`ChatUpdateProbe`，`Orbis/PreviewSupport.swift:1183`）。正在流式的行、以及暂缓放开后的数据提交不在此列。
- 按 PERF-10 的方法与条件复测帧数与长间隔，不劣于 PERF-10 记录；真机结果另行记录。

### IOS-CHAT-11 视口控制器与入场票据

范围：`ChatTranscriptView`、`ChatScrollObserver`、`ChatNativeScrollPosition`、`ReplyCardArrivals` 的调用方。

必须保持：

- `Tests/ChatViewportTests.swift` 固定的全部策略语义。
- 入场票据一次性领取，回滚、替换 live 身份或加载旧页不重播。
- 离开跟随或失去就绪时，尚未领取的票据作废。现在 `observe` 随每次 body 执行而达到这一点；改为提交时登记后须显式保住。
- 页面目标或历史代次变化时视口状态重置，且不发出滚动请求。

建议做法：

- 新增 `@Observable` 视口控制器，持有 `ChatViewportPolicy`，由页面模型持有，重绑与历史代次变化时重置。逐帧的滚动度量仍留在视图本地的引用盒。
- 把跟随、跳转按钮、提问提醒、滚动请求、上下文代次作为各自独立的存储属性，仅在变化时赋值。只有跳转按钮、提问提醒与滚动修饰符读取控制器；构建 `ForEach` 的 body 不读取。
- `replyArrivals.observe` 改在转录区域值提交时调用，先于视图失效送达；body 内不再有副作用。跟随或就绪事实变化时同样作废票据。它需要的就绪与跟随事实由页面阶段和视口控制器提供。

待原型验证：票据登记相对懒加载行创建的先后。登记须在新行的 `ReplyCardAppearance` 初始化之前完成。

回归门槛：`Tests/ChatViewportTests.swift`、`Tests/ReplyCardMotionTests.swift`；`testQuestionLocationRemainsReadingAfterNativeIdleAndSourcePublication`、`testToolDisclosureAnimatesReplyLayoutContinuously`、`testViewportSqueezeRemainsResponsiveWhileLongReplyIsPublished`、`testSendFlightMovesRightThenUpAndHandsOffTheSameMessage`。

完成判据：手指按下与抬起不使转录区域重算（`ChatUpdateProbe` 的转录计数）；真机流式中拖动的起步帧间隔按 IOS-CHAT-06 的方法记录。

### IOS-CHAT-12 逐字显示的时钟门控

范围：`MarkdownMessage`、`MathFragment`。仅影响 iOS 18 及以上的逐字显示路径。

开启条件：先用绘制计数确认 I3，即已显示完的段落在每个时钟周期被重绘。不成立则关闭本项，不改代码。

必须保持：M04 的可见结果逐帧一致；流式结束后排队字符继续显示完；隐藏期间不补播。

建议做法：字符区间整体低于 `RevealClock.settledBelow` 的段落接收恒定的时钟与时间，使其渲染输入稳定；只有仍有未显示字符的段落接收逐帧时间。

回归门槛：`Tests/RevealClockTests.swift` 与既有逐字显示 UI 用例。

完成判据：长回复流式期间，已显示完段落的绘制计数不随帧增长；真机流式的主线程占用按 IOS-CHAT-06 的方法对比记录。

### IOS-CHAT-13 阅读锚点修复

开启条件：IOS-CHAT-06 的锚点诊断完成。

必须保持，四类场景同时成立：

- 跟随时新内容保持贴底。
- 阅读时下方内容增长，阅读位置不动。
- 阅读时上方加载更早的消息，阅读位置不动。
- 展开或收起工具时，被操作的行位置连续。

提问提醒的定位、跳到最新、用户移动的归属沿用 ADR-0057 与 IOS-CHAT-04。

分支一，现有结构内修复：诊断显示某个 SwiftUI 配置能让 E2、E3 的原断言通过，且上述四类场景的既有用例不退化时采用。不涉及基线变更。

分支二，原生列表独占偏移：分支一无法同时满足四类场景时采用。实施前须取得授权，并在本 ADR 补充细化设计。方向与已知风险：

- `UICollectionView` 加 diffable data source，行内容经 `UIHostingConfiguration` 复用现有 `ChatMessageRow`。流式只重配尾部条目；阅读态的锚点保持用显式的偏移补偿。
- `ChatViewportPolicy` 保持为决策来源，由滚动代理回调驱动。iOS 17／18 两套适配器、逐行视口观察与相关 preference 随之退役。
- 风险：环境值需逐条目注入；preference 与 anchor 能否跨宿主边界待原型验证，发送飞行落点与视口观察可能需要改为引用登记；自适应高度与 M24 的逐帧增高、M03 的展开冻结如何配合；交互式收键盘、文本选择、消息菜单；UI 用例的元素查询方式。
- 触及 S24、M03、M04、M24、V09，按基线变更处理。

回归门槛：E2、E3 的原断言；`testQuestionLocationRemainsReadingAfterNativeIdleAndSourcePublication`、`testToolDisclosureAnimatesReplyLayoutContinuously`、`testViewportSqueezeRemainsResponsiveWhileLongReplyIsPublished`；历史分页与阅读锚点的既有用例。

完成判据：E2、E3 以原断言通过，并保留首次失败证据作对照；四类场景在真机上由用户验收。

### IOS-CHAT-14 远端流按帧合并提交

开启条件：IOS-CHAT-06 显示真机流式期间每秒提交数超过显示帧率，或提交及其引发的布局在主线程占用中成为主要项。不满足则不实施。

必须保持：第 4 节"本地动作即时"与"事件公平与优先级"；流式文本的可见节奏不慢于现状。

建议做法：只在页面模型的提交这一步合并。远端来源的变更等到下一显示帧提交一次；本地已受理的动作经动作面立即提交。上游各级 `Task.yield` 与转录 worker 不变。

回归门槛：乐观发送、发送飞行、Slash 即时气泡的既有用例；IOS-CHAT-07 的发布用例。

完成判据：真机流式期间每帧至多一次页面提交；主线程占用按 IOS-CHAT-06 的方法对比记录；本地动作的出现时机由用例固定。

### IOS-CHAT-15 输入区改为滚动视图的底部安全区内容

开启条件：IOS-CHAT-03 的真机复测显示输入测量仍占主线程主要份额，且已取得授权。

必须保持：PERF-13 的对齐要求第 4 条所列外观与交互；iOS 17／18 两条路径的到底距离计算；交互式收键盘。

建议做法：转录滚动视图以 `safeAreaInset(edge: .bottom)` 承载输入区，使输入区的测量脱离页面 `VStack` 的高度协商，与 ADR-0060 PERF-13 记录的 Android 结构一致。

回归门槛：`Tests/ComposerRowGeometryTests.swift`；输入框增长、按钮贴底、发送飞行、Slash、硬件键盘、键盘期间流式的既有用例。

完成判据：同一台设备上复测中文输入，由用户验收。

## 6. 验证

- **口径分开。** 07、08、09 属于行为不变的结构调整，以既有用例结果与基点一致为门槛。10、11、12、14 属于调度调整，以真机帧间隔与主线程占用为验收，重建计数只作回归门槛。13 以原断言通过与用户验收为准。
- **对照。** 性能对比使用同一设备、同一配置、同一夹具，对照为该项合入前的提交。
- **既有失败。** E2、E3、E6 保留原断言与首次证据。13 完成前，E2、E3 不计为各项的回归；对照基点为 `1bee5be8`。
- **新增用例。** 仅针对各项新引入的易错点：等值提交不通知、重绑全部通知、两种准入语义、票据登记先于行创建、本地动作不被合并推迟。用途写在测试代码注释。
- **设备与构建。** 模拟器与真机经共享入口借用，构建取得对应输出目录的租约。
- **登记。** 需要用户手动回归的工作项在产出候选版本时经 `orbis-qa` 登记到共享测试看板，绑定候选版本、安装包、独立环境与步骤。
- **交付。** 实现、自动验证、部署与用户验收分别记录，交付以用户验收完成为准。

## 7. 实施与验证记录

| ID | 实现 | 自动验证 | 部署 | 用户验收 |
| --- | --- | --- | --- | --- |
| IOS-CHAT-06 | `ChatSchedulingTrace` 标记 delta、转录/页面提交、区域 body、卡片重定高与实际 Markdown 绘制；这些通用调度 signpost 保持 Release 可选采集。页面入口、首遍 body、arrive/首个空闲帧、取消以及 `NativeSnapshotCommit` 属于 DEBUG-only 探针，Release 不编译这条路径；DEBUG 原生锚点采样与三个互斥候选在 `PreviewSupport` | 原 iPhone 模拟器已逐一运行基线与三个候选，结论见下；真机流式速率、主线程、帧间隔与入口到首个空闲帧尚无 Release 数据，未达到本项完成判据 | 未部署 | 真机待用户验证 |
| IOS-CHAT-07 | `ChatScreenModel` 的七个区域值使用合成等值；保留四源、代次校验、合并采集、同页暂缓与重绑交接；聊天页独立失效通道已删除 | `StoreTests`、发布与模型用例通过；来源更新、输入隔离与转场 UI 用例通过 | 未部署 | 待用户验证 |
| IOS-CHAT-08 | `ChatSessionActions` 集中当前目标准入和原归属清理；保留目标 runtime 的 fallback；缓存历史预览/重试保留离线路径 | 同 runtime 换 session、过期动作、离线历史与原读取/发送核心用例通过；发送飞行与覆盖页草稿 UI 用例通过 | 未部署 | 待用户验证 |
| IOS-CHAT-09 | 页面壳、顶栏、转录、输入、行、Markdown、面板分文件；探针实现在 `PreviewSupport`，新文件已登记 Xcode 工程 | Debug 原生测试构建与无签名设备 Release 构建通过；核心包编译通过 | 未部署；无签名产物不是可安装交付 | 待用户验证 |
| IOS-CHAT-10 | 页面模型持有阶段；移动中暂缓，被覆盖/后台继续提交；稳定引用只由需要视觉时钟的叶子读取；转录完整 View 值在 mount 内保持稳定；同一入场 token 只排一次任务 | 阶段、隐藏基线、动效与覆盖页租约用例通过；静态覆盖严格断言连续三次通过；重复入场的失败对照与三次修复复验见下；未确认性能不劣 | 未部署 | 真机待用户验证 |
| IOS-CHAT-11 | 独立视口控制器；提交先登记票据，失去跟随/就绪立即作废；mount token 隔离旧回调；新挂载重置并重送最近几何事实；已挂载行按 token 保留离散视口事实 | 策略、票据时序、目标身份与生命周期核心用例通过；拖动不重建、提问定位、工具展开、发送飞行与视口收缩 UI 用例通过；真机流式拖动未测 | 未部署 | 真机待用户验证 |
| IOS-CHAT-12 | 未开启；实际绘制埋点已就位，尚未确认 I3 | 未作时钟门控优化 | 未部署 | 待测量后确定 |
| IOS-CHAT-13 | iOS 18+ 默认以原生 UICollectionView + UIHostingConfiguration 承载既有行，iOS 17 保留 Release SwiftUI 兼容路径；Coordinator 独占偏移，stable row anchor 保持阅读；显式跨宿主环境/窗口坐标/发送视觉通道；页面持有展开与面板状态；原 SwiftUI 路径同时承担 iOS 17 兼容与高版本 DEBUG 对照 | 迁移 p5 完整 UI 32/32、原 E3 正常重复 10/10、严格展开 5/5；最终 p6 请求抢占修复 3/3、受影响阅读/滚动门槛 10/10；原断言与首失败保留，证据见下 | 未部署 | 四类阅读场景真机待用户验证 |
| IOS-CHAT-14 | 未开启；真机提交速率/主线程依据不足 | 上游逐事件让出与 worker 保持原样 | 未部署 | 待测量后确定 |
| IOS-CHAT-15 | 未开启；待 IOS-CHAT-03 真机复测与授权 | 输入区仍使用既有布局 | 未部署 | 待用户验证 |

### 首轮自动验证与交付边界（2026-11-15）

以下保留首轮失败与测量边界，后续修复结果见本节后面的复验记录。

- 核心：`.artifacts/adr0082/final-clean-core/run.log`，241 项、20 个 suite 通过。新增易错点集中在 `Tests/ChatScreenModelTests.swift`；离线历史动作复用 `StoreTests.offlineBranchBrowsingAndPagingNeverActivateOrSendCommands` 固定准入与零网络发送。
- 原生构建：`.artifacts/adr0082/final-debug/run.log` 的 Debug `build-for-testing` 通过；`.artifacts/adr0082/final-release/run.log` 的设备 Release 无签名构建通过。构建进程与残留服务的归属核验、定向恢复和租约释放证据保留在各 `*-recovery/cleanup.json`。
- 候选是基于 `1bee5be8` 的未提交工作区；源码指纹、文件清单、验证结果及开启条件汇总在 `.artifacts/adr0082/verification.json`，不以基点提交冒充本轮候选版本。
- 正常 UI 回归：`.artifacts/adr0082/normal-regression/tests.xcresult`，未启用锚点诊断，10 项中 9 项通过；新增静态覆盖用例的额外 transcript 计数断言为 5→7，原始失败保留。该轮行/Markdown 计数未变；`.artifacts/adr0082/static-diagnosis/tests.xcresult` 的同断言另轮通过，不能据此抹去前一轮失败。诊断边界见 `static-diagnosis/transcript-invalidation-review.json`。
- 清理临时打印后的局部复验：`final-ui/tests.xcresult`，6 项中 5 项通过，静态覆盖的严格 transcript 断言仍为 6→7。此前 `static-repeat/tests.xcresult` 三轮也复现 6→7：稳定读取后没有真正的转录区域提交，capture/content revision 不变，`_printChanges` 只报 `@self`；行/Markdown 保持 3/6。`equality-regression` 另轮全部比较项为 true 且用例通过，尚未确认偶发额外 body 的具体输入。原断言保留，临时打印已清除，证据在 `static-repeat/transcript-cover-review.json` 与 `equality-regression/diagnostics-review`。
- 模拟器使用共享入口，设备为 `Orbis iOS Standard 2`（iPhone 17、iOS 27.0，UDID `7FF4790F-0FF4-4072-A950-BD186648DDCE`），Debug。最初 iPad 运行的整窗手势落在常驻抽屉，不能替代原 iPhone 的阅读/返回回归，证据保留但不作同条件结论。
- 共享测试看板登记调用返回拒绝，未创建新卡片；没有将基点 SHA 当作包含本轮未提交代码的候选。没有签名安装包、独立真机环境、部署或人工验收结果。

### 2026-11-15 调度与原生列表失效边界修复

- IOS-CHAT-07-R1：输入区区域值不再携带原始草稿，只以 draftRevision 接收外部草稿修改；编辑器本地副本失效时通过动作面读取草稿。页面的文件复核 presenter 只观察独立的 canReadTranscript 投影，不再依赖完整转录区域。
- IOS-CHAT-10-R2：未挂载聊天页的根导航移动也暂缓快照采集，行为与是否曾进入聊天无关；已挂载的覆盖页及后台页仍继续提交。移动上限只由 Hub 的一套计时器管理。视觉活动另发布布尔投影，active/moving 互换不通知视觉时钟。
- IOS-CHAT-11-R1 / IOS-CHAT-13-R2：Coordinator 直接订阅视口引用的离散状态，拖动和定位请求不再调用 SwiftUI 行构建闭包。消息按 ID 与语义输入缓存，只有变化行构造 ChatMessageRow / AnyView；表头、空状态及工具区分别比较各自输入，工具清单仅以当前 runtime 的行存在性驱动列表构建。实际转录变化仍扫描行 revision 并使用受支持的 diffable 快照更新。
- 原生宿主环境不再以 visible / scenePhase 作为重配置键；折叠、回复卡片及共享动效叶子读取稳定的 chatVisualActivity。操作反馈和跳到最新恢复隐藏时禁用动画。窗口触摸观察改为每个 window 一个被动识别器、弱引用登记探针；纯几何探针不登记触摸。真正卸载后清理行缓存，覆盖保留时继续复用。
- IOS-CHAT-06-R1 / IOS-CHAT-08-R1：signpost 改用 dynamicTracing；聊天页在构造时取得非可选的 fallback runtime，移除顶栏和输入区四处强制解包。历史页一次回调复用同一动作面；固定挂载目标的无效 onChange 已移除。

本轮证据在 `.artifacts/ios-chat-review-20261115/`，源码清单及快照为 `candidate.json` / `source.zip`；基点是 `1bee5be8`，包含修复的未提交工作树指纹为 `625d6d186ccef4d3d91ce671a352dc950720a43df957e88060196eebc646b77e`。

- `core-r3/run.log`：模型、视口与 Store 相关回归 117/117，通过草稿后无关提交隔离、冷/暖导航、单一超时释放、原生缓存与独立视口订阅。原覆盖页夹具补上真实 mount 后保留原 covered/background 断言；首轮夹具失败保留在 `core/`。
- `ui-r2/tests.xcresult`、`ui-r2-summary.json`：池内 iPhone 17 原生路径 15/15，无跳过。覆盖/返回和拖动的原判据增加 nativeRow / nativeAuxiliary / nativeReconfigure / nativeSnapshot 计数；来源更新要求三次只构建、重配置三个变化行且不重建辅助行。输入隔离、E2/E3 阅读、历史前插、移动阅读、连续请求抢占、工具展开、选择文字、发送与下载飞行、页面移动均通过。
- `native-build-r2/run.log` 与 `release-build/run.log`：Debug 测试构建和设备 Release 无签名构建通过。初轮 `ui/tests.xcresult` 捕获过直接调用 UICollectionView.reconfigureItems 与 diffable 数据源不兼容的 UIKit 断言，已删除该路径并恢复 snapshot.reconfigureItems；原失败与 `ui-first-crash.ips` 保留。本轮构建及模拟器资源的退出和租约释放另存各自 cleanup / recovery 证据。
- `signpost-result.json`：macOS 独立进程未开启 Instruments 时，普通 category 的 isEnabled 为 true、dynamicTracing 为 false。此记录不代表 iOS 真机耗时或关闭路径已实测。

当前规范为 ADR-0051 的 `2026-11-11/r58`；该 ADR 已登记原生候选影响的 S24、M03、M04、M24、V09，根部两份本机指南及本 ADR 的旧 r51 引用已同步。候选尚未部署，无签名安装包、独立真机配对环境、真机流式测量或用户验收；不将本轮修复和自动回归记为新基线已验收。共享看板可读取，但新建本轮测试卡片返回 `user rejected MCP tool call`，未创建；请求结果保留在 `qa-registration.json`。

### IOS-CHAT-06 锚点诊断

原 iPhone、同一构建逐个候选运行；原断言未放宽。脚本为 `~/.orbis/tools/ui-regression/run-ios-ui-tests.py`，原始运行在 `.artifacts/adr0082/diagnostic-simulator/command.log`，完整原生/策略样本在对应 `anchor-*/tests.xcresult` 附件。

| 候选 | E2 | E3 |
| --- | --- | --- |
| baseline | 阅读锚点 −30pt，原位置断言失败 | 提醒存在性断言失败，未到来源更新 |
| reading-top | 同样 −30pt | 提醒出现，阅读锚点查询为空，未到来源更新 |
| unbound-reading | 首次提醒存在性断言失败 | 原完整用例通过，但切换分支本身出现原生跳动 |
| below-only | 浅色、深色原完整用例通过 | 提醒存在性断言失败，未到来源更新 |

E2 基线与 reading-top 的 source2 均为：内容高度 2714→2744、原生 offset 1969→1999、assistant 屏幕 top −1663.333→−1693.333，viewport/insets 不变且无拖动/减速。卡片的内容坐标不变，距底 141pt 不变，证明该次位移包含原生 offset 改写；不能只解释为行内重排。`ScrollPosition` 仍保留 `id=chat-bottom,user=false`，与尾部身份参与尺寸变化定位相符，但目前不能区分绑定与 SwiftUI 内部尺寸锚点的具体写入路径。

below-only 的 E2 offset 固定 2121，内容高度 2866→3108，原长卡片的位置和高度不变。该候选只在下方新增行，保留原提问；E3 仍保留新增用户行。它表明同一长行增长是 E2 的触发条件，没有证明现有结构对全部阅读场景成立。unbound-reading 的 E3 后续来源更新 offset 固定，但切换时约 100ms 内 offset 增加约 565pt、content 增加约 424pt，不能直接作为产品配置采用。

E3 基线八次 idle 的策略均已 positioned、browsed、towardEarlier，native 长回复框也持续覆盖视口；控制器却记录 `hasVisibleRows=false`，导致 questionOutside 与提醒为 false。这是独立的离散视口事实线索，不能把存在性提前失败当作来源更新保持锚点的结果。

挂载后重送最近离散视口事实与原生距离，避免初次几何早于父页面挂载时被丢弃；`anchor-after-viewport-replay/tests.xcresult` 复验仍为 E2 −30pt、E3 提醒提前失败，该措施没有解决已记录的两项阅读失败。

### IOS-CHAT-13 现有结构对照与原生迁移

代码指针：`ChatTranscriptView.ChatNativeScrollPosition`、`ChatRowViewportObserver`、`MotionGeometry.ChatViewportReports`、`ChatMessageRow.ChatAssistantAccessibility`。

- `ScrollPosition` 从首次挂载起使用默认的 `Never` ID 类型；显式提问/最新定位仍由同一个 position 的 `scrollTo(id:anchor:)` 执行。`repair/anchors-r1` 证明在手势开始时才清空旧 String position 会被同轮回写为 `id=chat-bottom,user=false`，E2 仍失败。`repair/anchors-r2` 的 `ScrollViewReader` 候选虽消除了来源更新位移，定位后的连续手势仍回跳，未采用。
- E2 最终配置在 `repair/anchors-r3/tests.xcresult` 的浅色、深色完整原流程通过。source2 内容高度 2714→2744，offset 始终 1969，长回复 top 始终 −1663.333，`position` 为 `user=true;point=nil;edge=nil;id=nil`。这固定了原生偏移被尾部 ID 跟踪带动的触发路径，不把 SwiftUI 私有实现细节当作已知事实。
- E3 的可见行事实改由已挂载行 token 登记，消失时注销，后续几何不重新登记已消失 host；当前问题 ID 的几何单独筛选，同 ID 重叠 host 以内侧报告为准。两个纯值回归位于 `Tests/ChatViewportTests.swift`，防止无关 lazy 更新覆盖已有可见报告。
- E3 随后暴露出独立 AX 缺失：`repair/anchors-r3-attachments` 中正文视觉存在，但整块长回复不在 AX 树，原锚点 query 数量为 0。助手 surface 加 `.accessibilityElement(children: .contain)` 后，`repair/e3-r4/tests.xcresult` 完整原用例曾通过。source2 内容高度 3272→3534，offset 始终 2386，长回复 top 始终 −1694.265、height 2460→2520；提醒更新为新问题。但 `repair/final-ui-r6/tests.xcresult` 的 18 项正常回归仍有 E3 在来源更新前的 `XCTAssertNotNil(anchor)` 失败，说明内层 AX 容器尚未消除间歇缺失。各段原标签、`isHittable` 与 1pt 位置断言保留。
- 新增 `testHistoryPrependPreservesTheVisibleReadingAnchor`：初始真实 canonical page 为 21–32，历史请求以 entry21 为 before、entry32 为目标；响应经 SQLite/Store 应用并关联 applied ack，等待页面实际发布 32 条且包含 entry20 后，核对同一原生文本的 y/width/height 均在 1pt 内，视口不变，并实际滚到更早消息。`repair/anchors-r2` 与 `repair/final-ui` 均通过，未以 ack 或固定等待代替页面发布完成。

现有结构的后续正常重复复验仍未满足 E3 的完成判据。失败时，长回复的正文、标题与复制按钮一起从真实聊天 ScrollView 的 AX 子树消失；原查询数量为零。失败专用诊断连续十秒重做原查询仍未恢复，局部 ScrollView 与全局查询结果一致。诊断只在原锚点已经为 nil 时执行，不回填锚点，不更改原断言，成功路径没有新增等待。

`repair/e3-ax-review.json` 汇总各轮配置、源码指纹与原生结果。移动整卡 AX 容器、合并复制 action、修改 AX shape、在滚动结束修改标识、删除手动 user-position 写入、展平整卡 AX、恢复 String ID 跟踪、移除等值包装、全程仅使用 Reader、禁用目标布局注册，以及移除裁剪层的候选，均未稳定消除原失败。String 对照还重新出现 E2 的 −30pt 偏移。未将单轮或诊断模式通过当作修复完成。

`repair/e3-r22/tests.xcresult` 仅把同一转录的 LazyVStack 换成 VStack，原 E3 正常重复五次均通过；其余可见正文和断言保留。该结果提示惰性宿主路径参与现象，尚不能证明框架具体根因，也不能证明原生 hosted cell 一定通过。普通堆栈会失去长历史按需实例化，未作为产品方案采用。与 r21 的惰性对照及 r25 的裁剪/遮罩对照源码快照分别保存在 `repair/source-r21.zip`、`repair/source-r22.zip`、`repair/source-r25.zip`，内部文件摘要与对应 manifest 已逐项核对。

未奏效的产品候选已撤回，保留已验证的 Never position、独立视口事实登记和完整 mount 稳定边界；还原后的产品源码与 r8 逐文件摘要一致，UI 测试另增加短拖动前后 row/Markdown 计数约束。还原候选与源码快照为 `repair/candidate-restored.json`、`repair/source-restored.zip`。原生列表原型于 2026-11-15 获得授权：以 UICollectionView 与 UIHostingConfiguration 承载既有 ChatMessageRow，先用原长回复和原 E3 断言验证，再迁移现有交互。

最后一项现有结构对照 r26 仅禁用 ScrollView 默认裁剪，并在相同视口边界外裁剪；原 E3 正常重复五次为 4 通过、1 次 `XCTAssertNotNil` 失败，已撤回。证据为 `repair/e3-r26/tests.xcresult`，源码为 `repair/source-r26.zip`。

原生原型 `ChatNativeTranscriptView` 使用 UICollectionView diffable 稳定行 ID 与 UIHostingConfiguration，原 ChatMessageRow 和 80 段真实 Text 保持原样。Coordinator 是该分支唯一的应用侧偏移执行者；阅读锚点采用真实可见行 ID 与相对视口位置；SwiftUI 的旧位置绑定与逐行视口观察不进入该分支。独立宿主通过 `ChatNativeTranscriptEnvironmentReader` 显式传递页面上下文。首版以 DEBUG 开关接入，原 E3 只把手势容器选择改为实际 collection view，正文查询、可见性、视口边界与来源更新后的 1pt 断言均保留。`repair/e3-p1/tests.xcresult` 正常重复 5/5，独立复验 `repair/e3-p1-repeat/tests.xcresult` 为 10/10；候选与源码为 `repair/candidate-p1.json`、`repair/source-p1.zip`。这证明首版原型通过该项自动门槛，尚不代表完整交互迁移或真机验收完成。

交互迁移继续保留实际 hosted row：原生 cell 持有坐标登记通道，向窗口转换后再供菜单与飞行动画使用；发送视觉内容另行跨宿主登记；工具、完整内容与文字选择面板以及展开/工具分页状态由页面级 `ChatTranscriptInteractionState` 持有，普通 cell 回收不结束面板。原 token/handle 归属清理继续沿用。迁移当时原生列表在 Debug 和 Release 中默认启用，原 SwiftUI 转录仅以 DEBUG 开关保留为对照；R4 补回 iOS 17 的 Release 兼容路径。

原生迁移 p3 的完整记录保留在 `repair/gates-p3/tests.xcresult`：8 项通过、2 项失败。E2 的视口相等断言暴露了 `604.0000000000003` 与 `604.0` 的浮点差；原生 collection 的公开无障碍矩形现按屏幕像素取整（最终仅 DEBUG 编译），原断言未改，但断言读取的 `accessibilityFrame` 值已经改变；该结果不能证明 Release 中未取整的 AX 矩形完全相等。新增展开用例首轮把实际工具行 `tool-card:preview-tool` 错写为 `m2`；原始样本同时暴露了真实尺寸缺陷：cell 从 120pt 直接变成 290pt，正文头部从 442pt 移至 527pt 后返回。更正行 ID 没有被计为修复尺寸缺陷，首次证据保留于 `repair/gates-p3/hosted-disclosure-first-failure.json`。

原生展开沿用 `.orbisCollapse` 的 `Spring.smooth(duration: 0.26)`，以真实测量高度推进 cell 布局，静止时恢复自然高度；保留子内容状态、减少动态效果与页面覆盖时的收敛语义。p4 的 12 次运行中 10 次通过、2 次失败；E2、E3 和工具组各 3/3，严格展开用例 1/3，关闭中间帧仍有正文 208.6667pt、cell 233pt 的差异。p5 将尺寸观察置于内容自然高度之后、填满宿主之前，尺寸变化立即使 intrinsic size 失效，移除额外异步跳转，并避免几何回调内递归布局。`repair/motion-p5/tests.xcresult` 使用相同测试源码和原 1pt 阈值，连续 5/5 通过；覆盖首次开、关、再开、嵌套展开以及真实 cell 回收后状态保留。20 组逐帧样本的 cell/正文最大高度差约 0.3334pt，摘要见 `repair/motion-p5/hosted-disclosure-sample-summary.json`。

p5 的正常完整回归为 32/32，原 E3 独立正常重复为 10/10，均未开启锚点诊断；结果分别在 `repair/final-p5/tests.xcresult` 与 `repair/e3-final-p5/tests.xcresult`。包括真实历史前插、长回复与移动阅读、工具展开、拖动/静态返回的重建计数、代码/表格横向阅读、发送与下载飞行、菜单、文字选择及页面转场。代码/表格、回收后的工具状态与发送交接截图已目检，见 `repair/final-p5-horizontal-attachments`、`repair/final-p5-disclosure-attachments`、`repair/final-p5-send-attachments`。该轮候选及源码为 `repair/candidate-p5.json`、`repair/source-p5.zip`。

收尾审查新增 IOS-CHAT-13-R1：定位问题的原生动画尚在运行时，新接受的“跳到最新”请求必须立即接管。`testJumpToLatestInterruptsTheInFlightQuestionLocation` 在真实定位按钮启动动画后，通过同一 viewport 动作面于约 80ms 发出新请求，避免 XCUI 等待 idle 将连续动作串行化。未修负对照 `repair/preemption-control/tests.xcresult` 的方向断言失败：旧动画仍在运行，request sequence 1→2、context 均为 2，新请求后仍向旧目标移动约 1611.333pt；其后终点与手势断言未执行。p6 只在接受新合法请求时，经唯一 offset writer 停止旧动画再执行新目标；同一用例与夹具连续 3/3 通过，包含最终落底及后续真实拖动解除跟随。三轮第二请求后向旧目标的额外移动均为 0pt。证据为 `repair/preemption-p6/tests.xcresult`；原始样本与失败结论均保留。

最终 p6 的受影响门槛在 `repair/final-p6/tests.xcresult` 为 10/10：原 E2/E3、定位后的 idle/来源发布、三项原 SC90 跳转、长回复阅读、真实历史前插、移动阅读与来源更新，以及严格 hosted 展开/回收。p5 的完整回归没有冒充 p6 结果；这次局部修复后按影响重跑上述门槛。最终源码清单与快照为 `repair/candidate-p6.json`、`repair/source-p6.zip`，指纹为 `a91391c3ace59f97de88aa23b372eff85f9d73e4f27995997126810a0732a7f5`。`repair/native-p6/run.log` 的 Debug 测试构建与 `repair/release-p6/run.log` 的设备 Release 无签名构建均通过；对应 `*-recovery/cleanup.json` 核验所属构建进程退出并释放租约。核心相关 11 个文件与已通过 244 项测试的候选摘要一致，复用依据为 `repair/core-source-reuse-p6.json`。无签名构建不构成可安装交付，真机测量、部署与用户验收仍未完成。

### 静态覆盖与重复入场修复

`ChatView.ChatTranscriptRegion` 在 `@State` 中保存一个 mount 首次构造的完整 `EquatableView<ChatTranscriptView>`，区域模型仍按原观察关系更新。仅缓存 action captures 的候选在 `repair/static-r2` 连续三次失败；完整 View 值稳定后，`repair/static-r3/tests.xcresult` 的原 transcript/row/Markdown 严格断言连续三次通过。探针仍位于原转录 body，未移动计数点或放宽断言。`ChatActionContext.pageIdentity` 同时包含连接对象与会话 identity，替换同 host/session 的 owner 会重建整个 mount，避免缓存旧动作或焦点闭包；对应核心回归位于 `ChatScreenModelTests`。

IOS-CHAT-10-R1：`repair/final-ui/tests.xcresult` 的首入曾记录 0 帧。新增 `testRepeatedPageAppearanceDoesNotRestartTheEntryAnimation` 复用原 PageMotion 的完整进入/返回断言，DEBUG 夹具重复同一个 `onAppear`。未修复对照 `repair/motion-control` 捕捉到同 token 两次 `arrive`（offset 402、0），第二次立即 finish/reset，原 `frames > 3` 断言以 0 失败。`OrbisPageStack.appeared` 现按准备 token 只排一次任务；`repair/motion-fixed` 连续三次通过，六次进入均是两次 appeared、一次 arrive。首次自然失败缺少事件采样，不将其具体回调次数写成已证实事实；对照与复验汇总在 `repair/motion-regression.json`。帧预算未开启，这些结果不证明性能不劣。

核心默认并行执行时发现共享语言测试互扰，首次证据保留于 `repair/core/run.log`；串行对照通过后，将 `SessionModelPresentationTests` 与已有切语言用例放在同一 MainActor，同步断言和产品语言实现不变。`repair/core-final/run.log` 默认并行 244 项、20 个 suite 全部通过。

### 调度与性能观测

正常回归的 PageMotion（未开锚点诊断）四段依次为：首次进入 21 帧/0 次长间隔/最长 23.8ms，返回键 14/0/16.7，再次进入 20/1/33.3，右滑返回 81/0/16.7；两次起滑等待为 214.0/154.6ms。证据在 `normal-simulator/command.log`。旧 `ticket05-final-check` 单次记录依次为 21/1/27.3、14/0/16.7、21/0/16.7、82/0/16.7。双方均为同设备、Debug 和 entry 夹具，但旧记录的源码 fingerprint 不等于最终 review 基点的直接重建，且只有单次样本、未启用性能预算断言。因此仅作描述性记录，不能确认性能不劣，也不能替代真机 Release 实时流测量。

最终局部复验的 PageMotion 依次为 21/0/19.5、14/0/16.7、21/0/16.7、82/1/49.5，两次起滑等待 214.3/156.6ms，见 `final-ui-simulator/command.log`。用例通过，但右滑仍出现长间隔，不能把用例通过写作性能门槛通过。

真机静止跟随、流式拖动、流式转场三种情形的每秒 delta/提交数、主线程占用与帧间隔仍待测量。当前页面入口到首个空闲帧及原生快照提交探针只在 DEBUG 编译；Release 版本的对应真机测量仍待补做。IOS-CHAT-12、14 的开启条件尚未得到证据支持，IOS-CHAT-15 也未取得复测与授权。

### 2026-11-15 原生回收与调度复核修复

- IOS-CHAT-13-R3：文件摘要按行及 changeSetId 借用页面级 disclosure；cell 回收不清除“显示更多文件”的展开状态。摘要异步匹配移到实际消息行的 TurnChangeSummaryLoader，匹配结果同属页面行引用；不再把首次加载任务挂在初始为空的 ForEach 上，复用时也不先清空卡片。公式测量以内容、实际宽度、字号、粗体、颜色、链接颜色、对齐及屏幕倍率为键，使用有数量和成本上限的缓存；首次复用布局即保留已测高度，WebKit 启动期间不回显原始公式，渲染失败仍显示原文。宽度随离线引擎的本地 size 消息返回，Android 继续读取原有 revision/height 字段。
- IOS-CHAT-11-R2：行缓存的生成与保留移到 make/updateUIView 的快照闭包，原生视口通知只消费已接收快照。每批只构造一次读取动作面和流式集合，空流式集合跳过逐行求交。实际转录更新仍扫描全部行并比较语义输入；新增 Release 可用的 NativeTranscriptInputs signpost 记录行数与耗时，不据此预判性能影响。
- IOS-CHAT-10-R3：OrbisVisualActive 只订阅一个可比较的环境投影；有页面活动引用时不读取回退的场景/可见性值，实际动画叶子继续按需观察页面活动。托管 cell 的系统前后台失效范围仍需真机核验。
- IOS-CHAT-09-R1：原生列表探针接线和页面动效探针经 ChatDebugProbes 入口集中到 PreviewSupport，Release 使用空实现；无障碍矩形的像素取整仅在 Debug 编译。HistoryBranchView 在每个动作内复用同一会话动作面。
- R3 当时将 SwiftUI 对照转录及 iOS 17/18 旧滚动适配器限制在 Debug 编译；R4 恢复 iOS 17 的 Release SwiftUI 兼容路径，iOS 18 及以上继续默认使用原生列表。删除条件为 IOS-CHAT-13 真机交互、阅读、前后台及 iOS 17 验收完成，并保留必要的原断言对照证据；届时删除 --preview-swiftui-transcript、旧转录和专用滚动适配器。OrbisCollapse、orbisAnchor 的非原生分支仍服务聊天页以外的共享控件；TrackedSendTarget 的非原生分支服务 iOS 17 兼容转录及 DEBUG 对照转录，按实际调用范围保留。

本轮验证位于 `.artifacts/ios-chat-review-followup-20261115/`：

- `core/run.log` 的 49 项页面/视口/动效/公式核心回归与 `turn-changes-core/run.log` 的 15 项文件变更回归通过；共享数学引擎 `npx vitest run shared/math-tests/core.test.mjs` 为 34/34。数量与源码指纹汇总到 `verification.json`。
- `debug-r6/run.log` 的 Debug 测试构建、`final-ui/tests.xcresult` 的 7 项目标回归通过：文件展开回收、公式高度回收、工具展开逐帧布局、原 E2/E3 阅读锚点、静态覆盖返回及拖动不重建。未改 E2/E3 的业务断言与 1pt 阈值。
- `math-visual-build/run.log` 与 `math-visual-ui/tests.xcresult` 补验通过：公式回收用例额外等待可见 WebView 的实际公式内容，并断言原文 \frac 不存在；离线公式的浅/深色与流式回退用例通过。截图检查后将回退文本的弹性框显式设为 minHeight 0，缓存占位期间按零高裁剪；首次高度用例通过的截图未作为实际渲染完成的证据。补验的 44 帧 math-recycled cell 高度均为 101pt；视觉证据在 `math-visual-attachments/`，文件展开截图在 `final-ui-attachments/`。
- `release/run.log` 的无签名设备 Release 构建通过。该产物用于编译验证，不是可安装交付包。构建与模拟器的退出、残留服务核验和租约释放分别记录在各 cleanup / recovery 文件。
- 共享池的两台 iPhone 处于既有崩溃隔离状态，入口拒绝启动；未改变隔离保护。本轮使用池内 iPad Air 11-inch (M4)、iOS 27.0、Debug。扩展覆盖用例的首次整窗右滑落在常驻目录，手势改按实际下载页的水平范围执行，原业务断言保留。
- iPad 扩展的覆盖恢复、历史前插和 PageMotion 用例未通过；`ui-r2/`、`ui-r3/` 的原始失败保留。用先前候选源码快照和同一测试文件、设备及断言对照，`control-ui/tests.xcresult` 三项均在相同断言复现：覆盖恢复的 source/Git 恢复等待超时，历史响应维持 responses=0，PageMotion 等待 count=4 超时。对照源码来自先前的 `source.zip`，不是将 1bee5be8 冒充包含工作区实现的候选；归属及指纹见 `control-source/control-manifest.json`。这三项未计为通过，也不据此宣称 iPad 全套验收完成。
- QA 草稿 `case_99ff49dc405d6d6b004a` 已登记，结果在 `qa-registration.json`。R3 当时尚无冻结提交、签名安装包或独立真机配对环境；真机长会话流式、前后台与 iOS 17 验收仍为待用户验证。IOS-CHAT-12/14/15 的开启条件不变，本轮未部署。

### 2026-11-15 架构复核修复（R4）

- 检查点提交 `f1977599f3dae045b2a96f020fc13e621bf6c2b0` 保存 1bee5be8 之上的完整审查树。R3 清单的 190 个文件与该提交逐项 SHA-256 一致，摘要 `9f69b076ef3763c3c99abf61232ab28a2207502a3716d1334968f9d4b2180439` 的对应证明位于 `.artifacts/ios-chat-architecture-review-20261115/checkpoint.json`。后续修复在独立分支 `fix/ios-chat-review-20261115` 进行。
- IOS-CHAT-13-R4：iOS 17 在 Debug/Release 均使用保留的 SwiftUI 转录与 LegacyScrollInteraction；iOS 18 及以上默认使用原生列表。iOS 17 原生后端仍待验收，不能将高版本模拟器结果当成该系统运行证据。
- Coordinator 删除 suppressFollowing、sawReadingInput，直接读取唯一的 ChatViewportPolicy.following；原生首次测量就绪改为 OrbisCore 的纯值 ChatNativeViewportPlacement，与页面收到消息后的分页就绪分别命名。手势同步交接与初始布局的回归位于 ChatScreenModelTests、ChatViewportTests。
- 阅读锚点优先选择起点仍在视口内的行，单个超长回复保留负起点回退。快照插入通过 UICollectionView 布局的 targetContentOffset 在替换可见范围之前提供锚点目标；布局事务结束前继续补偿自适应尺寸变化。快照应用与非动画偏移不继承 UIKit 隐式动画；页面指标仍通过布局外的调度发布。新增上方展开与历史前插的 CADisplayLink 断言，检查同一阅读行 ID 在各采样点的 cell 模型及 presentation 外框，阈值均为 1pt。探针用 cell 当前承载的行身份，避免快照转换期间按新 indexPath 误标旧 cell；未测量 cell 对象身份、hosted 正文内部位置或所有实际显示帧。
- SwiftUI 与原生宿主保留必要的坐标、菜单及测量适配；展开动效共用 OrbisCollapseMotion.spring。ChatMessageRow 明确新增环境依赖须同步传入独立 cell 宿主。ChatTranscriptMount 收拢挂载期不变的引用与闭包，DEBUG 校验可比较的引用、动作目标及 token 与首次挂载一致；焦点及返回闭包仍遵守挂载期不变约定，不声称可比较闭包。额外 body 重算的框架根因仍未证实。
- IOS-CHAT-11-R3：整批快照按页面转录发布 revision、宿主环境、工具占位及空页高度缓存；非空转录的键不包含视口高度。多行输入回归同时断言 nativeInputs 扫描计数不变，NativeTranscriptInputs signpost 保留用于真机长会话测量。rewindEnabled、canSend 仅进入用户行的动作比较；真实转录发布仍扫描语义输入。
- R4 首次完整回归在 `47d05cc2` 上为 39/41；来源补丁及输入后来源补丁两项在等待 transcript body 计数增长时失败，原断言和首次结果保留在 `final-candidate/`。该结果不能证明原生列表漏更新。`78e0146` 将状态和 revision 同步捕获于区域 body，再显式传给几何、环境及快照构造；header 与 toolText 使用同次捕获，防止延迟读取混用发布。探针位置与业务断言未改。
- `observation-fix/` 的原来源补丁断言随后暴露页面壳多重算：转录、变更行及重配置均增加 3 次，page 也增加 3 次。延迟页面构造通过 actions getter 读取 transcript.target，订阅了整个转录区域；`8da81875` 将动作目标保存为 ObservationIgnored 的同批捕获值，ownsMount 复用该值。新增核心测试要求转录状态确实发布时，动作构造与归属读取不收到区域失效；不以改计数点或放宽原页面隔离断言消除失败。
- 权限与模型面板读取原目标的 owner/runtime，模型展示投影由 HostConnection 提供并供 Hub 复用；移除该面板动作的重复准入判断。页面模型缓存同批捕获的 target，视口回调只做一次 mount/当前归属检查。08、09 的完成判据与当前保留的 runtime 回退、局部副作用门控、DEBUG 比较入口及 iOS 17 Release 路径对齐。

本轮证据位于 `.artifacts/ios-chat-architecture-review-20261115/`，源码冻结于 `8da818758e7de7363e203ca8bd7bddb5742808ae`：

- `final-confirmed/` 的最终 Debug 构建、573 项核心测试（62 个 suite）及 41/41 会话页 UI 回归通过；选集在 `full-selection.json`，包含先前完整 32 项与本轮扩展。设备为共享池健康的 iPhone 17、iOS 27.0；未改变原两台 iPhone 的隔离。当前 Swift 源码指纹与实际测试的 `c03ef2f9a7fdc50219086032aab994361df299f25f15173b9202c067aaa333f7` 一致，`candidate-source.json` 的 188 项范围清单也与冻结提交一致。六张最终截图检查覆盖阅读锚点、文件展开回收、公式实际渲染和模型面板，见 `final-attachments/`。汇总及构建、设备、控制工作树清理记录指针在 `verification.json`；相应归属进程已退出，租约释放，模拟器关机已核验。
- `ownership-fix/` 的 16 项页面核心测试与 3 项定向 UI 通过；原来源补丁、输入后来源补丁和多行输入的严格隔离断言均保留。首次完整失败在 `final-candidate/`，后续页面重算失败在 `observation-fix/`，不合并覆盖其结果。
- 负对照提交 `9825c959f7aaacaf703ec89d84e0cd2781bb6f2a` 仅撤掉原生 layout 的阅读目标和可见行起点优先规则，其他源码与固定候选一致。相同测试文件 SHA-256 为 `d6ed83839cc561e46102934dc2bdcc1e4ca7a90d93f44681dce719e8f908dd05`；同一健康 iPhone 17、iOS 27.0、Debug 运行的两个用例均在原 1pt 断言失败。上方展开的最大采样偏差为 168.333333pt，历史前插为 72pt，后者有一个 presentation 几何记录缺失。见 `negative-control-verification/`、`negative-control-summary.json`；生成工作树在进程退出、租约释放后移除，提交分支及日志保留。
- 固定候选的上方展开、收起、历史前插三个约 1.05 秒窗口共 189 个记录点，指定行 ID 在所有点均有模型和 presentation 外框。前两者最大 minY 偏差小于 1e-12pt，历史前插为 0pt；最大相邻采样间隔分别为 33.359、33.939、38.321ms。见 `final-anchor-summary.json`。这是采样位置证据，不是实际显示帧覆盖率、正文内部像素或 cell 对象身份的证明。
- `release/` 的无签名设备 Release 构建退出码为 0，LC_BUILD_VERSION 的最低系统为 iOS 17.0，SDK 为 27.2；输出只用于编译验证。见 `release-verification.json`，不作为可安装交付包或 iOS 17 运行证据。
- 原 QA Case `case_99ff49dc405d6d6b004a` 已新增 Round 3 `round_447b7322fe568b8f3893`，绑定 `8da81875` 并保留早轮，见 `qa-round-final.json`。历史 checklist 的 iOS 17 原生后端门槛仍保留；本轮 candidate/reason 明确该系统使用 SwiftUI 兼容路径，未据此删除旧路径。签名包、独立手机配对环境、真机长会话、前后台与 iOS 17 运行验收仍待完成，未部署。

### 2026-11-16 代码审查复核（R5）

审查对 `main...a48c508a` 提出 9 项，逐项核实后处理如下。

- IOS-CHAT-10-R4：卸载只按挂载 token 判定归属。选择变更会先替换动作目标，原先同时比较目标，导致离开的页面无法卸载，视觉活动保持 active。回归为 `replacedSelectionStillUnmountsTheDepartingPage`；恢复旧判定的负对照在同一断言失败。
- IOS-CHAT-13-R5 文件摘要：工具调用后的正文把最终回复拆出新卡片，锚点随之移到新卡片，原行锚点为空。行级摘要状态跨 cell 复用保留，原行因此残留卡片。TurnChangeSummaryLoader 在该行不再加载时清空摘要。回归为 `testFileSummaryFollowsAnchorsWhenTheReplySplits`，夹具参数 `--preview-change-anchor-handoff`；旧实现的负对照得到 2 张卡片。
- IOS-CHAT-13-R5 重复行 ID：原生快照对每个 ID 保留首行并继续应用，Debug 仍触发断言。原实现在重复存在期间拒绝全部快照，Release 下转录停止更新，重复消失后才恢复。回归为 `nativeItemsKeepTheFirstRowForADuplicatedID`。
- 历史与分支页移除下载管理入口，iOS 与 Android 一致（S45 / SC66）。历史预览中的文件下载照常受理，不再有飞入。移除后，窄屏上聊天页之上的历史页、下载页都不再打开下一页，被覆盖的聊天页上方不会发生转场。宽屏（≥600pt）的常驻会话目录仍可在“聊天 → 历史/下载”时推入添加电脑页或替换页面栈，此时聊天页被覆盖。
- IOS-CHAT-10-R5：页面移动期间，导航区域在聊天页被覆盖时也暂缓，移动结束时补提交；聊天页其他区域照常提交。选择变更（目标或运行时不同）与重绑定立即提交，页面身份不落后于动作目标。回归为 `coveredChatDefersOnlyNavigationUntilMotionEnds`、`coveredMotionStillCommitsANewSelectionToNavigation`；去掉暂缓的负对照在两条断言失败（`nav-hold-negative/`）。宽屏实机待用户验证。
- 未复现，不改：
  - 惯性滑动中点停。iOS 27.0 模拟器、iPhone 17、Debug 下，点按时 `isDecelerating` 为 1，UIKit 随后依次调用 willBeginDragging、didEndDragging(decelerate=false) 与 didEndDecelerating，交互标志清除，跳到最新正常生效。临时探针与用例已移除；真机未验证。
  - 标题按钮强调色。原生缓存键包含宿主环境的 accent，它与标题取自同一次提交的 kind，颜色变化时标题即重建。
- 性能与清理：
  - `ownsMount` 改用 `ChatActionContext.isCurrent(in:)`，滚动回调不再构造动作面或查找回退运行时；`ChatNoticesRegion` 去掉重复的 `isCurrent`；挂载与可见性判定直接比较 `actionTarget`。
  - 原生行继续注册落点并记录下载起点，但只有存在发送动画项时才取气泡内容，动画结束后释放；不再在每次更新时包装并保留整行内容。
  - 删除未使用的 `ChatScreenSnapshot.modelPresentation`；当前选择的会话键统一由 `ChatActionContext.selectedIdentity` 计算。

本轮证据位于 `.artifacts/ios-chat-review-r5-20261115/`，设备为共享池 iPhone 17、iOS 27.0、Debug：

- 最终版本：`final3-build/` 的 Debug 构建与 `final3-release/` 的无签名设备 Release 编译均通过。`final3-ui/` 的 55 项 UI 全部通过，选集见 `final3-selection.json`，含原 41 项、R5 新增与受影响用例及下述 4 项。`cleanup-core/run.log` 的核心 577 项全部通过。本轮改动单独保存为 `r5-candidate.patch`，SHA-256 见 `r5-candidate.patch.sha256`；其中不含同一工作树里另一任务的额度相关改动，最终运行时这些改动均在。
- 发送动效的 3 个用例只断言几何。`final3-attachments/` 中长文本发送进行到 0.82 时的截图显示，飞行气泡带有完整正文，按需取内容后落点视觉仍存在。
- `swiftui-cards-ui/`：`testFileSummaryFollowsAnchorsWhenTheReplySplits` 在 SwiftUI 转录后端（iOS 17 Release 路径）通过。
- `final-core/run.log`：首轮核心 575 项通过。`core-unmount-negative/` 为卸载判定的负对照，`nav-hold-negative/` 为导航暂缓的负对照。
- `final2-ui-simulator/`：该轮已被后续改动取代，中途用中断信号停止。入口在停止子进程时报错，保留了设备租约；随后在注册表互斥内核对归属、进程退出与关机状态后释放，见 `lease-recovery.json`。
- `final-ui/`：基于移除入口前的构建，44 项中 42 项通过；选集见 `final-selection.json`，含原 41 项与新增 3 项。两项失败为既有问题，见下文。`cards-negative/` 为文件摘要的负对照。
- `fling-probe-5/`：滑动中点停的有效样本，含 `fling-log.txt` 与测试结果。探针补丁为 `fling-probe-source/fling-probe.patch`；前 4 轮因合成手势未产生惯性或点按晚于惯性结束而无效，原样保留。
- `history-ui/`：入口移除后，进入历史页或经下载返回的 15 项用例中 12 项通过。英文标题在只剩一个页头动作时不再折行，原“必须折行”判据改为“标题不压到动作按钮下”；`recheck-candidate-ui/` 两轮通过，截图确认标题完整。其余两项失败与未改动 HEAD 相同，见下文。
- 对照：`control-head-ui/`、`control-main-ui/` 为 HEAD（a48c508a）与 main（1bee5be8）的工作树构建；`recheck-head-ui/` 与候选版本在同一租约内各运行两轮。对照工作树在记录后移除。
- `release/`：候选版本的无签名设备 Release 构建通过，仅作编译验证。
- 本轮期间，同一工作树另有任务的未提交改动：`docs/adr/0070-unified-design-and-interaction.md`、`StatusViews.swift`、`PreviewSupport.swift` 的额度读取、`OrbisUITests.swift` 的额度用例，以及 Android `ProviderDial*`。本轮各次 iOS 构建可能包含其中 iOS 部分。这些改动位于供应商额度页面，不在聊天与历史路径上，不属于本轮提交范围。

以下 4 项在未改动的 HEAD 上以相同断言失败，其中后两项在 main 上也同样失败；首次失败证据保留在 `final-ui/`、`history-ui/`、`control-*-ui/`、`recheck-head-ui/`、`main-nav-ui/`。根因都是断言落后于已记录的产品决定，本轮按决定更新断言：

- `testNativeTurnFileReviewShowsSourceAndReadsOnlySelectedDetail`：说明文字自 583dcdbb（11-11）起收入 info 按钮。现断言卡片显示“记录不完整”，说明不内联，点开 info 后出现、关闭后消失。
- `testTurnFileReviewLoadsOnlySelectedFilesAndRetainsCache`：旧期望来自 6b55dc73（10-31）的整轮末尾规则。91953f11（11-06）改为由锚定消息最后一个片段所在卡片承载；Android `TurnChangePresentationWorker` 同样按卡片匹配，Codex Host 的 `#reviewAnchor` 取本轮最后一条助手消息。经决定保留该规则。夹具仍锚定第一步，代表旧版 Host 的中途锚点；现断言摘要位于锚定卡片之后、下一张卡片之前。main 在更早的断言失败，摘要卡未出现，即 R3 修复的初始空 ForEach 问题。
- `testChatDownloadsReturnToSameChat`：XCUI 仍能查到被覆盖页面里保留的原生文本视图，AccessibilityReachProbe 的说明已记录这一点。现改用可达性探针判断被覆盖与返回后的状态。
- `testFullPageReturnBudgetAndNestedSourceReentry`：设置已成为根标签（S37），不经页面返回，指标没有 count。c44ccc5d 已同样调整姊妹用例。现从计数序列中去掉设置。

orbis-qa 连接失败（502），本轮未登记共享测试看板。未部署；真机交互、阅读与前后台仍待用户验证。

### 2026-11-17 输入框回归修复

S12／S17／SC55、IOS-CHAT-01／03：共用编辑器按软回车提交配置显示发送或普通换行键；显式草稿替换把 UTF-16 光标移到末尾，普通编辑和组字保留原位置。占位符复用文字容器的 inset 与 padding。移除不存在的 `usesTextLayoutManager` 属性，并明确初始容器高度的 `CGFloat` 类型。

`.artifacts/ios-review-fixes-20261117/verification.json` 记录本轮编译、54 项核心定向测试和资源清理；首次编译发现的高度类型歧义保留于 `app-build/`。`testSlashSelectionAppendsArgumentsAfterReplacement` 已加入并编译，未执行 UI／真机回归。共享 QA 服务拒绝连接，登记阻塞见 `qa-registration.json`；未部署，待用户验证。

### 2026-11-17 IOS-CHAT-16 显式定位与原生运动的控制权

原生列表的 `nativeMotionActive` 同时包含手指操作和松手后的惯性，原实现据此延后全部显式请求。跳到最新会先切换跟随并隐藏按钮，实际定位仍等惯性停止。首次引入为 `f1977599`，`4591dfa8` 的请求协调重构保留了该规则；R5 的列表点停样本没有覆盖惯性期间直接点击跳底按钮。

控制权按手指直接操作、有效显式定位、既有惯性、自动跟随／阅读补偿排序。`ChatNativeTranscriptView.Coordinator` 区分真实触摸和原生运动：手指接触时保留 UIKit 控制；松手后，跳到最新和定位提问共用请求协调入口。新请求先取得 alignment 归属、清理旧阅读锚点与方向、结束旧交互，再通过既有唯一偏移写入入口停止被替换的运动。目标执行继续等待当前快照就绪；自动几何补偿继续保留惯性。锚点采集统一避开显式定位，迟到的惯性结束回调在直接触摸期间不结束新交互。

实现：`Orbis/ChatNativeTranscriptView.swift`。策略回归为 `Tests/ChatViewportTests.swift` 的 `explicitIntentSurvivesOldGestureIdleButYieldsToANewGesture`；原生回归为 `DeviceTests/ChatNativeSnapshotTests.swift` 的 `testLatestRequestTakesOverAnUnfinishedSyntheticInteraction`、`testQuestionRequestTakesOverAnUnfinishedSyntheticInteraction`，并复用 worker 阻塞期间抢占旧定位动画的既有用例。新增原生用例使用合成 delegate 生命周期，不代表真实 UIKit 惯性。

验证证据位于 `.artifacts/ios-decelerating-jump-20261117/`：修改原生实现前的策略选集 16 项通过，候选核心定向选集 24 项通过；原生实现与测试仅通过 Swift 语法解析，尚未完成本轮 iOS 编译和设备运行。共享 QA MCP 拒绝连接，登记阻塞与本轮要求保留于 `qa-registration-status.json`、`qa-request-draft.json`。真实惯性中点击现有按钮的负对照与候选、手指按住、减少动画、跳后跟随、再次拖动及 iOS 17 兼容路径均待设备验证；未生成安装包、未部署，待用户验证。

### 2026-11-17 IOS-CHAT-17 系统侧栏尺寸重算时保持消息定位

原生消息列表在首次定位后，跟随状态的 `targetContentOffset` 原先直接接受 UIKit 提议的位置，再由后续布局回调校正到底部。系统侧栏参与页面尺寸协商和消息自适应测量时，这两个位置可能不同。候选实现使用本次布局的内容高度和视口高度直接返回底部目标；新显式定位、进行中的定位动画和用户拖动仍优先，已完成的跳底请求继续允许跟随。系统侧栏、首页与折叠布局保持现状。

实现见 [ChatNativeTranscriptView.swift](../../ios/Orbis/Orbis/ChatNativeTranscriptView.swift)。回归 `ChatNativeSnapshotTests.testNativeRelayoutTargetsLatestBeforeDeferredResolution` 使用真实原生列表，在窄屏、展开及阅读区尺寸下同步调整视口，检查布局目标、即时底部位置及等待处理的提问定位。该夹具不模拟系统侧栏本身。验证、首次编译失败与资源清理分别记录于 [.artifacts/iphone-duo-chat-entry-20261117/verification.json](../../.artifacts/iphone-duo-chat-entry-20261117/verification.json)；未安装，系统侧栏下反复进入会话的画面稳定性待用户验证。

首次候选的用户验收未通过，进入会话时消息抖动仍存在；该结论与首次证据保留于 `round2/first-candidate-feedback.json`。后续修复按 IOS-CHAT-18 跟踪。

### 2026-11-18 IOS-CHAT-18 消息排版的安全区归属

消息视口由外层 SwiftUI 安排安全区，原生列表及消息单元格按分配尺寸排版。`contentInsetAdjustmentBehavior = .never` 之外，组合布局显式使用 `.none`，`NativeTranscriptCell.safeAreaInsets` 返回零，避免组合布局和 `UIHostingConfiguration` 再次扣除页面过渡中变化的安全区。仅固定组合布局宽度仍会让托管正文重排；失败样本保留于本轮 `native-tests/`，未放宽几何断言。

回归为 `ChatNativeSnapshotTests.testChangingSystemBarSafeAreaKeepsMessageWidthHeightAndPosition`、旧配置对照 `testLegacySafeAreaReferenceReproducesMessageWidthChange` 及 `OrbisUITests.testSystemTabChatReentryKeepsMessageGeometryStable`。后者从滑入开始记录原生单元格逐帧几何，覆盖连续三次进入；预览开关只选用系统 TabView 路径，不代表实际 Duo 竖向侧栏或折叠姿态。

证据：[round2/verification.json](../../.artifacts/iphone-duo-chat-entry-20261117/round2/verification.json)。共享 iPhone 17／iOS 27.0 上，同一租约内修改前源码的安全区用例失败，最终候选通过；三种视口共 45 个采样点的消息宽度、行高、纵向位置不变，窄屏对照的纵向变化为 53.67 点。原生选集 9 项通过，已有 `testHostedDisclosureResizesCellWithoutSelfSizingAnimation` 的中间帧数量断言在对照和候选均失败，原断言与证据保留；完整页面的连续进出、阅读位置／跳到最新及工具展开 3 项通过。编译通过，候选源码、产物及资源清理分别记录。

本轮直接模拟器验证已获授权。Duo 设备因既有 PosterBoard 崩溃处于共享池隔离状态，未启动；QA 服务拒绝连接，登记草案保留本轮要求。仅在隔离预览环境安装模拟器包，未部署到用户设备；实际 Duo 侧栏下三个姿态及键盘交互待用户验证。

## 8. 评估后不采用与范围外

- **引入状态管理依赖。** 系统的 Observation 已覆盖所需能力，不新增第三方架构库。
- **移除上游的逐事件让出。** 它们承担接收公平与控制帧优先，合并只在页面提交处进行。
- **被覆盖时冻结数据。** 返回时来源页须是当前内容，冻结会在露出时跳变。
- **调整实时回复卡片的增高方式。** E2、E3 的夹具都不含 live 回复，E3 还是在减少动画下失败的，目前没有针对它的实测依据。IOS-CHAT-06 的流式剖析给出依据后另行立项，属 M24 基线变更。
- **`HostConnection` 拆分与整体迁移到 Observation。** `Orbis/OrbisStore.swift` 3843 行、全应用 132 个 `@Published` 与 32 个手动版本计数是聊天页复杂度的上游来源。迁移后 Hub 转发与大部分版本计数可以删除，12 个直接观察 `OrbisStore` 的视图也不再随每次 Host 事件重算。影响全应用，另立 ADR。
- **首页与目录的发布器。** `homeUpdates`、`directoryUpdates` 保持现状，随上一条一并处理。
