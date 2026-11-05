# Orbis 原生聊天使用路径审计

审计日期：2026-11-05。范围：Android / iOS 当前聊天、历史、输入、权限、附件、工具、后台任务与下载源码，以及相关 ADR。本文说明原生 App 原来如何使用，为独立 mobile HTML 提供语义依据；不以 HTML 的演示行为反推原生能力。供应商配置、后端准备和新建的更完整路径见[原生入口与启动审计](orbis-native-usage-audit.md)。

本次只读核对产品源码，随后仅新增本审计文档。未运行构建、模拟器、真机、真实 Host 或账号请求。下文“已接入”表示存在源码实现，不表示已部署、设备验收通过或当前用户安装包一定具备。基线为 [ADR-0051 r48](../adr/0051-ui-style-motion-and-visual-stability-freeze.md)；本文不新增 feature、不改变基线参数，也不提高既有验收状态。行号是审计时定位，后续代码变化以符号与相邻上下文为准。

## 1. 操作先定位到正确对象

| 对象 | 原生含义 | 相关操作 |
| --- | --- | --- |
| Host / 电脑 | 已配对的具体电脑；拥有目录、运行入口、下载来源 | 切电脑、浏览远端文件、下载、核对状态 |
| Session | 持久会话身份，可能有历史而没有在线 Runtime | 恢复、归档、取消归档、浏览历史 |
| Runtime | 当前可控制的在线路由身份，可在恢复后更换 | 发送、停止、配置、执行声明的 Slash、关闭 |
| turn / 主回合 | 当前一次用户输入驱动的执行 | 停止当前回合、展示本轮耗时和文件变化 |
| queue item | 已受理、尚待投递的具体输入 | 查看投递方式、撤回、核对是否已交给 Agent |
| interaction request | 一次确切审批、问题或表单请求 | 允许、拒绝、提交答案、取消 |
| transfer task | 某次上传或下载 | 暂停、续传、重试、取消、删除本机记录 |
| background task | Claude 原生子代理 / teammate 库存项 | 当前版本只读查看状态与父子关系 |

请求保持 Host、Session、Runtime 与来源代次身份。连接、主回合执行、压缩 / 重试活动、后台任务和发送回执是独立事实。证据：[RemoteViewModel.kt:277](../../android/app/src/main/java/com/orbising/orbis/RemoteViewModel.kt#L277)、[RemoteState.kt:65](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt#L65)、[ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md#7-串行恢复与隔离)、[ADR-0062](../adr/0062-claude-background-agents-and-session-activity.md#1-三类事实分开)。

## 2. 在线、历史、缓存与恢复

### 2.1 打开已在线会话

用户先确定电脑，再点在线会话卡；目录项如果存在同 Session 的 live Runtime，也进入该 Runtime。聊天先呈现已有缓存，再订阅和同步源端内容，缓存显示不以网络往返完成为前提。首次进入以已缓存末尾内容为入口；用户向上阅读、分页或打开详情之后，后台同步维护当前阅读锚点。

Android 选择时设置当前 Runtime、发布缓存会话并清除离线选择；iOS 先种入缓存，再发布消息和同步。返回只是导航，不停止 Agent。证据：[HostConnection.kt:805](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L805)、[OrbisStore.swift:581](../../ios/Orbis/Orbis/OrbisStore.swift#L581)、[ADR-0048](../adr/0048-online-chat-entry-budget.md#decision)。

### 2.2 点击没有在线 Runtime 的历史目录项

两端当前默认行为如下。

| 平台 | 用户点击后的实际路径 | 后续行为 |
| --- | --- | --- |
| Android | 普通目录点击调用 `openSession(hostId, sessionId)`；没有 live Runtime 就直接 `activateSession` | 请求在电脑恢复，进入启动状态；独立的 `openOfflineSession` 才明确选择本机缓存 |
| iOS | 有 live Runtime 时进入在线聊天；否则先 `openCachedSession` | 有缓存进入缓存聊天；无缓存显示“本机尚无缓存”，连接就绪时对话框提供“在电脑继续会话” |

证据：[RemoteViewModel.kt:298](../../android/app/src/main/java/com/orbising/orbis/RemoteViewModel.kt#L298)、[ContentView.swift:165](../../ios/Orbis/Orbis/ContentView.swift#L165)。Android 归档目录项另有规则：存在缓存时打开历史，没有缓存时进入选择状态，而不是直接恢复，[SessionDrawer.kt:794](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt#L794)。

### 2.3 只读缓存怎么用

- Android 进入独立 `OfflineHistoryScreen`：标题标“只读历史”，展示本机 transcript、分页、读取失败与重试；这个页面没有 composer，也没有在线聊天的历史树入口。
- iOS 用 `cached:<session>` 表示缓存目标，复用聊天页；用户可以查看本地历史分支。输入位置显示离线浏览说明及“在电脑继续会话”，电脑未连接或激活中时不能继续。
- 只读缓存表示会话阅读模式，不保证所有 Host 操作都断线。Android 缓存历史中的文件路径仍可向当前在线 Host 请求下载；下载不需要原 Runtime 存活。

证据：[MainActivity.kt:1313](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L1313)、[MainActivity.kt:1435](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L1435)、[OrbisStore.swift:908](../../ios/Orbis/Orbis/OrbisStore.swift#L908)、[ChatView.swift:389](../../ios/Orbis/Orbis/ChatView.swift#L389)、[HistoryBranchView.swift:123](../../ios/Orbis/Orbis/HistoryBranchView.swift#L123)。

### 2.4 在电脑恢复会话

恢复以 Session 和 Agent 类型定位。供应商不匹配会被拒绝；Android 激活入口还明确要求先恢复已归档会话。提交后立即进入“启动中”占位聊天，可编辑草稿和创建等待启动的消息。已有缓存先显示；启动失败或未确认在原位说明，提供重试与返回。返回不取消启动，后来成功也不强制把用户拉回。

“已受理启动”不等于 Runtime 已上线。用户明确重试建立新的操作身份。证据：[HostConnection.kt:546](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L546)、[HostConnection.kt:576](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L576)、[OrbisStore.swift:1085](../../ios/Orbis/Orbis/OrbisStore.swift#L1085)、[OrbisStore.swift:1107](../../ios/Orbis/Orbis/OrbisStore.swift#L1107)、[ChatView.swift:118](../../ios/Orbis/Orbis/ChatView.swift#L118)、[ADR-0049](../adr/0049-optimistic-send-and-source-reconciliation.md#68-新建--恢复会话即时反馈)。

## 3. 输入、停止、队列与结果恢复

### 3.1 用户通常如何发送

| 当前情况 | 原生操作 | 实际含义 |
| --- | --- | --- |
| 主回合空闲 | 写正文 / 选择附件 → 发送 | 向当前目标提交普通输入；附件、配置或启动尚未完成时可先在本机等待 |
| 主回合运行，待发内容为空 | 点输入区右侧停止按钮 | 请求停止当前回合；发出请求不等于已确认停止 |
| 主回合运行，已有正文，Claude | 点发送 | 自动选择 `followUp`，等待当前回合结束后投递 |
| 主回合运行，已有正文，其他 Agent | 点发送 → 选“完成后发送”或“插入当前任务” | 分别提交 `followUp` / `steer`；支持与否、具体执行由后端决定 |
| 输入以 `/` 开头 | 从当前命令菜单选择命令与参数 → 提交 | 执行结构化 Slash；随意键入未选择的 `/...` 不能冒充普通消息 |
| 需要审批 / 回答问题 | 在交互面板处理具体请求 | 答案经专用响应通道，不是向聊天发送“同意” |

证据：[MainActivity.kt:2073](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2073)、[MainActivity.kt:2189](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2189)、[ChatView.swift:504](../../ios/Orbis/Orbis/ChatView.swift#L504)、[Presentation.swift:76](../../ios/Orbis/Orbis/Presentation.swift#L76)。Android 的停止 / 发送判定只看运行和空正文；iOS 同时考虑附件是否为空，差异见第 6 节。

两端发送入口检查正文与目标；上传失败 / 取消的附件先处理。上传未完成、模型 / effort 切换未确认、会话启动中或前一条本机等待输入未就绪时，可以先产生本机 `Waiting` 消息。它标明等待原因，前置条件完成才写入通道。正文与附件完整提交。证据：[HostConnection.kt:1210](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L1210)、[OrbisStore.swift:1624](../../ios/Orbis/Orbis/OrbisStore.swift#L1624)、[ADR-0049](../adr/0049-optimistic-send-and-source-reconciliation.md#62-等待前置操作的消息)。

### 3.2 后端的投递语义并不相同

| 后端 | 跟进、插入和停止的范围 |
| --- | --- |
| Pi | 扩展持有待投递输入，原生可执行时逐条投递；使用原生 abort 与队列语义 |
| Codex / Codex Desktop | 适配器持有队列；既有 `steer` 是中断当前回合并优先下一条 |
| Claude Mods | 仅支持跟进排队，不支持 `steer`；停止等待主回合中断事实 |
| DSH Web | 原生 queue / steer / cancel，并按原生请求和队列身份核对 |
| 旧 DSH ACP | 只支持 idle 直接发送；没有原生队列时 followUp / steer 明确失败，保留可恢复输入 |

以上为 [ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md#5-后端能力与-slash-子路径) 的后端契约，不表示手机已经为每种不支持情况隐藏了所有按钮。设计稿按当前 Agent 呈现已声明的投递能力。

### 3.3 所有状态下的准入与反馈

完整状态矩阵由 [ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md#3-准入优先级先匹配先处理) 定义。下表保留影响用户理解的关键差别；实际能力和最终准入仍由 Host / 后端确认。

输入准入依据连接、目标、执行、原生活动与能力组合求值；控制、读取和传输由对应拥有者处理。实际判定以 [ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md) 与实现为准。

当前双端 composer 的发送 / 停止主分支主要检查 `status == running`。因此不能把上表说成“每个客户端按钮都已按全部状态独立禁用”；源码 UI、Host 契约和真实设备行为需分开验证。

### 3.4 消息气泡下的发送状态

| 状态 | 呈现与操作 |
| --- | --- |
| Sending / Accepted | 显示发送进度，等待原生提交与身份确认 |
| Waiting | 显示本机前置等待原因 |
| Queued | 显示真实排队状态和可用撤回入口 |
| Failed | 显示原因及重发、恢复草稿、删除操作 |
| Unconfirmed | 显示待核对结果及显式核对入口 |

证据：[PendingSends.kt:4](../../android/app/src/main/java/com/orbising/orbis/PendingSends.kt#L4)、[MainActivity.kt:3772](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L3772)、[HostConnection.kt:1307](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L1307)、[ChatView.swift:548](../../ios/Orbis/Orbis/ChatView.swift#L548)。

命令受理、队列受理、原生投递、模型执行与 canonical 历史落地分别需要证据。`accepted` 不等于 `delivered`，`delivered` 也不替代最终消息身份对账。结果未知时保留可见状态和显式核对入口。详见 [ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md#6-生命周期与所有结果路径)。

### 3.5 队列怎么撤回

输入被 Host 接受排队后，用户可在 composer 上方看到内容、投递方式和状态。只有仍可撤回的 accepted 项开放撤回；撤回未确认时禁用重复撤回。已经交给 Agent 则显示 `already_delivered` / `not_cancelable` 对应结果，按实际结果反馈。

Android 为有界竖向列表，iOS 单项一张卡、多项横向卡片。同一输入按身份在队列与 transcript 间交接；客户端仍保留隐藏的正文、附件和身份恢复副本，直到精确落地或用户明确撤回 / 删除。这个副本不是权威历史，也不保证进程硬退出后的持久 outbox。证据：[MainActivity.kt:4117](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L4117)、[ChatView.swift:1533](../../ios/Orbis/Orbis/ChatView.swift#L1533)、[ADR-0049](../adr/0049-optimistic-send-and-source-reconciliation.md#63-撤回排队消息)、[ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md#8-显示与现有-adr-的修订)。

## 4. 审批、问题和远程交互

用户遇到单个 confirm 时，可直接在 composer 上方的浮层允许 / 拒绝；多请求或其他表单类型提供“打开”入口，进入远程交互工作区并切换请求。支持确认、单选、多选、问卷与文本输入。输入草稿与请求身份绑定；收起工作区不代表提交，也不能把一般聊天正文当作答案。

操作对象是确切 `requestId`、扩展及所属会话。请求过期、正在提交、断线时不能重复回答；来源已消失或被取消也不能补交旧答案。提交受理后面板可暂收起并在原位显示摘要；失败且请求仍有效时恢复面板与答案。成功回执与请求真的从库存消失仍须核对，按请求拥有者的事实结算。

证据：[InteractionWorkspace.kt:59](../../android/app/src/main/java/com/orbising/orbis/InteractionWorkspace.kt#L59)、[InteractionView.swift:11](../../ios/Orbis/Orbis/InteractionView.swift#L11)、[InteractionView.swift:105](../../ios/Orbis/Orbis/InteractionView.swift#L105)、[OrbisStore.swift:657](../../ios/Orbis/Orbis/OrbisStore.swift#L657)、[ADR-0049](../adr/0049-optimistic-send-and-source-reconciliation.md#65-回答审批--问卷取消提问)。

## 5. Slash、模型、effort 与权限

### 5.1 原生命令菜单

用户在 composer 输入 `/` 后，从 Runtime 当前发布的目录选择命令；目录包含内置命令、skill、prompt template 和扩展，并带参数候选与要求。手机不维护一份假定所有 Agent 通用的自由命令表。提交依据当前目录及参数校验。

产生对话的 skill / template 走消息发送与恢复路径；模型 / thinking 走配置账本；`tree` 打开历史页面，不把节点 ID 粘进正文。命令是否只读、能否在忙碌时执行由后端能力决定。证据：[HostConnection.kt:1405](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L1405)、[MainActivity.kt:2658](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2658)、[ChatView.swift:1393](../../ios/Orbis/Orbis/ChatView.swift#L1393)、[ADR-0003](../adr/0003-runtime-owned-slash-command-menu.md)、[ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md#5-后端能力与-slash-子路径)。

### 5.2 看模型与调整思考级别

Android 顶栏显示模型与 thinking，切换主要经 Slash 命令和参数菜单。iOS 还可以点聊天标题打开“会话信息”，查看模型、原生供应商、思考级别、上下文、执行状态、重试 / 压缩、耗时及各状态来源；有合法 model / thinking 选项时直接点选。iOS 信息页还提供“核对会话状态”。来源状态按已核对、部分或不可用分别呈现。

证据：[MainActivity.kt:1995](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L1995)、[ChatView.swift:227](../../ios/Orbis/Orbis/ChatView.swift#L227)、[ChatView.swift:1625](../../ios/Orbis/Orbis/ChatView.swift#L1625)。本次检查的 Android 顶栏没有同等标题点击信息面板，不据此推断整个应用完全没有其他诊断入口。

模型 / effort 一般要求 idle；DSH Web 支持运行中更新下一轮配置，不修改正在执行的请求。选中值可以先显示“切换中”，确认后才去掉标记。此时发送的消息先在本机等配置；切换失败则回确认前的值，并使依赖它的等待消息失败。断线 / 超时显示未确认并读取源端配置；连续选择保留最新意图。

Codex 还有重要对账边界：首次输入前 Host 已保存的下一轮 model / effort 选择，在重复原生观测中保持，两个字段独立核对。原生真正改变字段或确认目标值后再交回该字段的原生来源。证据：[ADR-0049](../adr/0049-optimistic-send-and-source-reconciliation.md#67-模型与思考级别条件乐观)、[ADR-0061](../adr/0061-codex-selection-and-native-settings-reconciliation.md#1-分开保存选型和原生观测)。

### 5.3 会话权限

用户从 cwd / Git 信息旁的权限入口打开当前会话权限。Host 提供 summary、details、setting ID、选项、当前值及禁用原因；手机按这些 opaque 值提交，按 Host 的原生权限投影呈现。权限更新作用于当前会话配置，审批与 App 默认设置分别管理。

- Android 先选值，再点“应用到当前会话”；组件要求连接、idle、没有待确认设置及禁用原因。聊天调用处还要求权限来源 ready、没有交互和队列。
- iOS 点选项直接提交；状态层要求安全连接、idle、无有效交互、无待处理动作、选项合法且没有 disabledReason。
- 权限等待真实确认，信息缺失时呈现实际可用性；Android 会说明由电脑管理，iOS 当前 composer 没有 metadata 时不显示该入口。

证据：[RuntimePermissions.kt:66](../../android/app/src/main/java/com/orbising/orbis/RuntimePermissions.kt#L66)、[RuntimePermissions.kt:109](../../android/app/src/main/java/com/orbising/orbis/RuntimePermissions.kt#L109)、[MainActivity.kt:2137](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2137)、[ChatView.swift:491](../../ios/Orbis/Orbis/ChatView.swift#L491)、[ChatView.swift:1453](../../ios/Orbis/Orbis/ChatView.swift#L1453)、[OrbisStore.swift:1558](../../ios/Orbis/Orbis/OrbisStore.swift#L1558)、[ADR-0031](../adr/0031-host-permission-management.md#decision)。

## 6. 手机附件与电脑文件

### 6.1 上传后随消息发送

典型路径：点回形针 → 系统文件选择器多选 → composer 出现附件 chip 与上传状态 → 输入正文并发送。源码单次选择取最多 10 个，单文件上限 100 MiB；不把该上限解释成已经证明所有跨批选择场景都严格累计限额。文件上传到会话 cwd 下约定的 `.orbis-uploads/`，iOS 路径还按内容 hash 分组。消息引用完成后的 Host 文件路径，上传与消息提交是两个步骤。

附件不是独立投递通道：正文与路径一起进入同一 delivery、排队和失败流程。上传未完可以先等待；失败 / 取消附件需要用户处理。当前实现采用附件路径语义，模型原生图像 / 多模态 content parts 的覆盖仍有限。

证据：[ArtifactUploadStore.kt:46](../../android/app/src/main/java/com/orbising/orbis/ArtifactUploadStore.kt#L46)、[MainActivity.kt:1695](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L1695)、[FileTransfers.swift:311](../../ios/Orbis/Orbis/FileTransfers.swift#L311)、[ADR-0012:19](../adr/0012-receiver-driven-upload.md)、[ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md#5-后端能力与-slash-子路径)。

点附件叉号时，未传完的取消传输，已传完的从这条待发消息移除。发送受理后清掉 composer 的附件关联，不等于取消已交给等待消息的上传。附件关联由状态层保存，不只存在于一个页面的瞬时布局中。证据：[MainActivity.kt:2147](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2147)、[MainActivity.kt:2244](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2244)、[RemoteViewModel.kt:392](../../android/app/src/main/java/com/orbising/orbis/RemoteViewModel.kt#L392)、[ChatView.swift:565](../../ios/Orbis/Orbis/ChatView.swift#L565)、[FileTransfers.swift:343](../../ios/Orbis/Orbis/FileTransfers.swift#L343)。

### 6.2 当前 Android 与 iOS 的实现差异

| 场景 | Android 当前源码 | iOS 当前源码 | 审计判断 |
| --- | --- | --- | --- |
| 只有附件，没有正文 | `canSubmitInput` 空正文返回 false；运行时空正文又按停止模式判断 | `canSubmit` 允许非空附件，停止按钮也检查附件为空；发送可生成默认正文 | Android 底层支持附件正文兜底，不等于当前 UI 已开放纯附件发送 |
| running followUp / steer 带附件 | 三个运行中分支只调用 `sendMessage(input, delivery)`；facade 附件参数默认空列表 | 所有非 Slash delivery 都传附件 IDs | Android 这些分支未提交当前附件，属于待修复的源码路径缺口 |
| idle 带附件 | 显式传完成路径与上传 task IDs | 传附件 IDs，状态层等待完成 | 两端存在正常附件提交路径 |

Android 证据：[MessagePresentation.kt:201](../../android/app/src/main/java/com/orbising/orbis/MessagePresentation.kt#L201)、[MainActivity.kt:2658](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2658)、[MainActivity.kt:2078](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2078)、[MainActivity.kt:2236](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2236)、[RemoteViewModel.kt:374](../../android/app/src/main/java/com/orbising/orbis/RemoteViewModel.kt#L374)。iOS 证据：[ChatView.swift:103](../../ios/Orbis/Orbis/ChatView.swift#L103)、[ChatView.swift:515](../../ios/Orbis/Orbis/ChatView.swift#L515)、[ChatView.swift:565](../../ios/Orbis/Orbis/ChatView.swift#L565)。

以上为直接调用链核对，未做设备复现，本次未修复原生实现。HTML 若采用一致的附件语义，应说明它保留的是设计契约，而不是声称双端现有入口完全一致。

### 6.3 正文文件链接

聊天正文中的电脑文件路径、artifact 附件卡提供下载入口；点击是向 Host 请求文件，不是本地代码编辑器跳转。http / https / mailto 则交系统打开。离线缓存中的路径本身不保证文件已在手机，也不保证原文件仍存在。证据：[MarkdownText.kt:77](../../android/app/src/main/java/com/orbising/orbis/MarkdownText.kt#L77)、[ChatView.swift:1222](../../ios/Orbis/Orbis/ChatView.swift#L1222)。

## 7. 历史、会话分支、Rewind 与 Git

### 7.1 历史树的实际操作链

用户点顶栏时钟“历史与分支”，或从命令目录选 `tree`，进入整页历史。可以搜索、筛选、展开其他分支和工具 / 设置细节；点击节点只是预览。明确选择用户节点的“编辑这条消息并重新开始”，或助手节点的“从这条回复后继续”，才提交历史移动。`tree` 的目标来自 Host 公布的节点选项，不让用户手填不受支持的节点 ID。

iOS 在缓存会话里显示“查看这个分支的缓存”，只切本地缓存阅读，不改变电脑上的当前叶节点。Android 的独立只读历史页没有这套入口。证据：[HistoryTree.kt:8](../../android/app/src/main/java/com/orbising/orbis/HistoryTree.kt#L8)、[HistoryTreePage.kt:70](../../android/app/src/main/java/com/orbising/orbis/HistoryTreePage.kt#L70)、[HistoryTreePage.kt:106](../../android/app/src/main/java/com/orbising/orbis/HistoryTreePage.kt#L106)、[HistoryBranchView.swift:110](../../ios/Orbis/Orbis/HistoryBranchView.swift#L110)。

### 7.2 消息菜单与 Rewind

当前 r48 将消息操作菜单和显式文字选择分开：打开消息菜单后可复制消息、选择文字；满足条件的用户消息还有 Rewind。选择文字进入只读选择层。

Rewind 只为当前路径上、Host 历史目录声明可操作的用户节点提供；连接就绪、主回合 idle 且没有相关待处理动作时才开放。历史改写不乐观，等确认后重建聊天，必要时恢复原文到输入框。证据：[MessageActions.kt:25](../../android/app/src/main/java/com/orbising/orbis/MessageActions.kt#L25)、[MainActivity.kt:2386](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2386)、[ChatView.swift:298](../../ios/Orbis/Orbis/ChatView.swift#L298)、[OrbisStore.swift:636](../../ios/Orbis/Orbis/OrbisStore.swift#L636)、[ADR-0051:607](../adr/0051-ui-style-motion-and-visual-stability-freeze.md)。

### 7.3 不同后端的“回到这里”

| 后端 | 当前语义 | 作用范围 |
| --- | --- | --- |
| Pi | 同 Session 内换历史 leaf | 不等同 Git checkout |
| Codex / Codex Desktop | 同 Session / thread 原地回退；用户节点退到该轮前，助手节点保留所选完整轮 | 不隐式 fork，不回滚工作区文件；回退、历史刷新与电脑显示刷新是不同结果 |
| DSH | 原生 fork 可返回新的 Session ID；App 打开新 Session 并把编辑草稿交给它 | 原会话保留，编辑后的输入属于新分支 |

这张表只描述已核对的后端路径，不为其他后端补造相同行为。Android 在回执中明确区分新 Session 与原地移动，iOS 也根据返回 Session 身份决定激活还是刷新。证据：[MainActivity.kt:1808](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L1808)、[OrbisStore.swift:1607](../../ios/Orbis/Orbis/OrbisStore.swift#L1607)、[ADR-0023](../adr/0023-codex-revert-and-client-refresh.md#1-tree-保持原地-revert-的语义)。

### 7.4 输入区 Git branch 是另一件事

cwd 旁的分支名来自 Host 的 `runtime.git.request`，展示工作目录对应的 Git 分支或 detached HEAD。它只读，不执行 checkout，也不向 Agent 发一条命令。状态尚未同步、非仓库或未获取到分支时明确显示对应事实。顶栏“历史与分支”因此用时钟入口，Git 分支行保持独立只读语义。证据：[MainActivity.kt:2035](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2035)、[ComposerSessionInfo.kt:68](../../android/app/src/main/java/com/orbising/orbis/ComposerSessionInfo.kt#L68)、[HostConnection.kt:865](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L865)、[OrbisStore.swift:592](../../ios/Orbis/Orbis/OrbisStore.swift#L592)。

## 8. Thinking、工具详情和轮末文件审阅

### 8.1 回复如何阅读

聊天按用户消息与助手回合组织，thinking 可折叠；tool call 与 result 合并显示，避免把原始工具回执当成另一个助手回答。工具概要可含名称、状态、耗时、退出码、错误和省略说明。完整原文按显式查看操作读取。

### 8.2 工具原文的原生路径

典型步骤：展开工具概要 → 点“参数 / 输出 / 结果”的明确读取入口 → 进入工具详情 → 读取下一页或开启跟随输出 → 按需复制已读取内容、导出当前部分或取消导出。iOS 导出完成还可分享导出文件。

详情有读取范围、分页、是否 final、来源缺口和内存保留窗口。到当前范围末尾不一定表示工具停止；空文本、尚未产生、不可用、被截断和不可恢复缺口是不同状态。取消详情读取或导出只取消该次读操作，不停止 Agent。离页与后台取消按读取归属管理。

证据：[ToolViews.kt:35](../../android/app/src/main/java/com/orbising/orbis/ToolViews.kt#L35)、[ToolViews.kt:115](../../android/app/src/main/java/com/orbising/orbis/ToolViews.kt#L115)、[ChatView.swift:929](../../ios/Orbis/Orbis/ChatView.swift#L929)、[ChatView.swift:1074](../../ios/Orbis/Orbis/ChatView.swift#L1074)、[ToolDetailView.swift:4](../../ios/Orbis/Orbis/ToolDetailView.swift#L4)、[ADR-0045](../adr/0045-tool-summaries-and-on-demand-content.md#1-分离工具摘要内容引用和原始内容)。

### 8.3 轮末文件审阅

典型步骤：读完助手回合 → 查看轮末文件概况 → 点某文件 → 独立 diff 查看器 → 左右切换文件 / 加载文件清单 → 返回聊天。原生已接入文件名、增删数、差异行号与颜色、文件状态、清单分页、按文件读取、缓存和版本隔离。只在选中文件落位后读正文，邻页外壳不等于已经预取相邻文件 diff。

这里的范围是“本轮净变化”，不是 `git diff HEAD` 的整个当前工作区，也不提供代码撤销按钮。历史审阅绑定冻结版本，覆盖与可用性按实际来源呈现。

| 来源 | 当前实现边界 |
| --- | --- |
| Codex / Codex Desktop | 原生文件工具 tracker 来源，固定 partial 或 unavailable；提示仅记录 Codex 文件工具变更，不承诺所有 shell、MCP、子代理写入 |
| Pi / Claude | Host 有界范围及起止窗口快照；范围与归属限制需要显示，不声明由助手独占造成 |
| DSH Web | 时间窗快照，尚无执行前屏障，明确 partial；不拿另一套原生 changes 接口假装同一来源 |
| 空原生 diff | 可能是净文本为零或记录失效，不能证明整个工作区无修改 |

证据：[TurnFileChangesView.swift:15](../../ios/Orbis/Orbis/TurnFileChangesView.swift#L15)、[TurnFileChangeViews.kt:63](../../android/app/src/main/java/com/orbising/orbis/TurnFileChangeViews.kt#L63)、[ADR-0052](../adr/0052-turn-file-changes-and-on-demand-diff.md#9-初版实现接入与剩余验收)、[ADR-0052](../adr/0052-turn-file-changes-and-on-demand-diff.md#9-初版实现接入与剩余验收)、[ADR-0052](../adr/0052-turn-file-changes-and-on-demand-diff.md#91-2026-11-01codex--codex-desktop-原生轮次记录验证中)。

工具分页、跟随、导出及完整 diff 阅读属于原生深层功能；独立设计稿按实际演示深度说明范围，源码接入与真实读取分别记录。

## 9. Claude 后台子任务

主回合与后台任务可以同时拥有不同状态。主回合 idle 时即使仍有子任务运行，composer 仍按主回合允许正常输入。主回合 stop 也不承诺全部子任务停止。

用户在 composer 附近点开紧凑子任务区，看到任务名、kind、status 及可确认的 parent 关系；列表最大高度 160，内部滚动。任务以真实 ID 区分，同名不合并。未知 / 读取失败时保留最后已知清单并说明“正在核对”；来源缺席时明确呈现可用性。

首版只读，没有子 transcript 查看、逐项 stop 或停止全部后台任务。活跃任务、库存未知 / 截断时撤回 quit 能力；子任务在电脑结束并完成状态同步后，主会话恢复关闭能力。后台子任务不进入普通会话目录、历史恢复、归档或批量关闭。

证据：[BackgroundTasks.kt:18](../../android/app/src/main/java/com/orbising/orbis/BackgroundTasks.kt#L18)、[ChatView.swift:1696](../../ios/Orbis/Orbis/ChatView.swift#L1696)、[RemoteState.kt:89](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt#L89)、[RemoteState.kt:109](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt#L109)、[ADR-0062](../adr/0062-claude-background-agents-and-session-activity.md#1-三类事实分开)、[ADR-0062](../adr/0062-claude-background-agents-and-session-activity.md#4-控制范围与关闭)。

## 10. 返回、停止、关闭、归档与删除

| 用户动作 | 精确作用对象 | 保留与确认规则 |
| --- | --- | --- |
| 返回 / 离开聊天 | 页面导航 | Agent、启动及独立传输继续；不把返回变成 stop 或 quit |
| 停止生成 | 当前 Runtime 所属主回合 | 等原生中断；不删除历史、不关闭 Host、不撤销已改文件 |
| 关闭在线会话 | 当前仍有 quit 能力的精确 Runtime | 发声明的 `quit`；卡片可按账本先退场，再核对 Runtime 下线；保留持久 Session |
| 归档 / 恢复 | 持久 Session 的目录属性 | 发 `session.archive`；目录卡片可先移动，仍需权威目录 / 回执确认；不等于删除 transcript |
| 撤回队列 | 某一未交付的 queue item | 只取消该项；若已投递，说明真实结果 |
| 取消读取 / 下载 / 上传 | 某次读或传输任务 | 不停止 Agent，不取消无关传输 |
| 删除下载记录与本机文件 | 手机任务与本地副本 | 不删除电脑源文件 |
| 删除本机失败 / 未确认消息行 | 客户端恢复副本 | 不删除电脑历史，也不能证明旧输入从未执行 |

关闭按当前能力准入。能力未就绪、原生不支持、子任务活跃 / 未知时拒绝。关闭操作本身允许账本乐观隐藏，重连后仍在运行则恢复并说明未确认；停止、权限与历史改写则不乐观完成。证据：[HostConnection.kt:1504](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L1504)、[HostConnection.kt:1573](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L1573)、[OrbisStore.swift:1310](../../ios/Orbis/Orbis/OrbisStore.swift#L1310)、[OrbisStore.swift:1885](../../ios/Orbis/Orbis/OrbisStore.swift#L1885)、[ADR-0049](../adr/0049-optimistic-send-and-source-reconciliation.md#75-操作种类)。

归档需要安全连接、已知会话类型且没有同项操作在处理。没有在线 Runtime 的会话可归档；在线 Pi / Claude 先退出，在线 Codex / DSH 等路径要求空闲。Android 对 Codex / DSH 显式检查一个关联 Runtime 的 idle；iOS 检查该 Session 的所有在线 Runtime 均 idle。两端恢复归档都针对 Session，不由关闭在线卡片替代。证据：[SessionDrawer.kt:839](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt#L839)、[SessionViews.swift:289](../../ios/Orbis/Orbis/SessionViews.swift#L289)、[OrbisStore.swift:1177](../../ios/Orbis/Orbis/OrbisStore.swift#L1177)。

## 11. 下载到手机的完整路径

### 11.1 从哪里开始下载

- 从聊天顶栏或主页进入下载管理页；它与 Host 交互，不以当前 live Runtime 存在为前提。
- 点“浏览电脑文件”，进入目录 / 返回上级，选择普通文件后点“下载到手机”。
- iOS 还可在下载页直接输入电脑文件的完整路径。
- 点聊天中的电脑文件路径或 artifact 卡，同样创建该 Host 的下载任务。

文件浏览是远端电脑文件系统，不是选择手机保存目录。已配对设备能够请求 Host 账户可读取的文件，是否存在、是否可读仍由源端检查。证据：[MainActivity.kt:2035](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2035)、[RemoteFileBrowser.kt:149](../../android/app/src/main/java/com/orbising/orbis/RemoteFileBrowser.kt#L149)、[DownloadView.swift:24](../../ios/Orbis/Orbis/DownloadView.swift#L24)、[ADR-0005:5](../adr/0005-receiver-driven-range-download.md)。当前下载入口以接收方驱动协议为准。

### 11.2 任务状态与完成后的操作

下载任务按 Host 隔离，显示文件名、进度、状态及必要错误。进行中点击暂停，失败点击重试，暂停点击继续；重启传输保留可用偏移，断线按传输生命周期暂停。换页面不等于换任务归属。收到全部字节仍须完成长度 / hash 验证，验证完成后发布本地文件。

| 操作 | Android | iOS |
| --- | --- | --- |
| 运行中任务轻点 | 暂停当前下载 | 暂停 queued / downloading / verifying 任务 |
| 失败 / 暂停任务轻点 | 连接就绪时重试 / 继续 | 连接就绪时 restart |
| 已完成任务轻点 | 当前卡片没有 open / share 分支；显示保存位置，系统 URI 显示手机系统“下载”目录 | 有本机路径时 `ShareLink` 打开系统分享 |
| 长按 | 进入多选，选择任务后删除确认 | 进入多选，选择任务后删除确认 |
| 删除 | 删除记录和本地文件，处理该任务在途传输 | 删除对话框明确“电脑上的原文件不受影响” |

证据：[HostConnection.kt:1841](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L1841)、[FileTransfers.swift:247](../../ios/Orbis/Orbis/FileTransfers.swift#L247)、[MainActivity.kt:2750](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2750)、[MainActivity.kt:2885](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2885)、[DownloadView.swift:56](../../ios/Orbis/Orbis/DownloadView.swift#L56)、[DownloadView.swift:64](../../ios/Orbis/Orbis/DownloadView.swift#L64)。

## 12. 独立设计稿的表达原则

独立设计稿沿真实领域对象与原生能力组织操作，以明确状态呈现受理、执行、失败和核对。设计简化及源码平台差异分别记录，演示深度随入口说明；具体功能关系见[设计稿](orbis-menu-concept.md)。

## 13. 验证边界与后续证据

本文依据源码、ADR 和关键调用链交叉核对，并完成文档静态检查；原生运行与设备验收以对应历史证据为准。

| 证据 | 对应范围 |
| --- | --- |
| 源码路径 | 入口、参数、状态检查与平台差异 |
| ADR 契约 | 领域语义、身份与恢复原则 |
| 历史记录 | 对应版本实际执行的验证 |
| 文档静态检查 | 引用、结构与所读事实一致性 |

待完成验收包括：完整输入状态真实后端门禁见 [ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md#verification)；Codex 选型对账的实施 / 验证边界见 [ADR-0061](../adr/0061-codex-selection-and-native-settings-reconciliation.md#验证与实际完成范围)；Claude 后台任务设备与真实原生联动未验收见 [ADR-0062](../adr/0062-claude-background-agents-and-session-activity.md#实施与验证记录2026-11-03)；轮次文件审阅仍有真实后端、网络、可访问性和手动门禁缺口，见 [ADR-0052](../adr/0052-turn-file-changes-and-on-demand-diff.md#evidence)、[ADR-0052](../adr/0052-turn-file-changes-and-on-demand-diff.md#evidence)。消息菜单、复制反馈等新基线仍以 [ADR-0051 的验证记录](../adr/0051-ui-style-motion-and-visual-stability-freeze.md) 为准。各项状态以其实际证据为准。
