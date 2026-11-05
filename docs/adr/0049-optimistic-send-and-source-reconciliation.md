# ADR-0049：用户操作的乐观显示与源端对账

日期：2026-10-30；2026-11-01 扩展范围（§5–§7）

Status: accepted（§1–§4 的消息发送与首页关闭已实施，隔离模拟器回归通过，真机待复测；§5–§7 的范围扩展已决定，并于 ADR-0051 r32 实现：§7 账本与全部种类（OPT-00–OPT-09、OPT-H1）两端完成，单元通过，两端设备全量失败集合不超出同设备 main 基线，A1–A4 专项通过；人工 C01–C18、R26 / R27 逐项与真实 Host 未执行，不记为交付）

关联：[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0028](0028-host-notification-lifecycle.md)、[ADR-0031](0031-host-permission-management.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0035](0035-incremental-session-reconcile.md)、[ADR-0046](0046-mobile-ui-stability-and-material.md)、[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)、[ADR-0054](0054-shared-full-page-navigation.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)

## Context

手机发送消息后，用户气泡要等 Host 回传用户消息才出现。Pi、Claude 或网络较慢时，这段空白很明显；
Android 还要等命令结果才清空输入框。iOS 曾明确放弃本地回显，原因是各后端回传的用户消息身份不同，
本地行无法和权威行对上，会留下重复气泡。

每条 `user_message` 都带手机生成的 `messageId`（下称 App id）。各后端对它的处理不同：

| 后端 | 排队项 `queueId` | 用户消息首次出现 | 出现时的 id | 能否关联 App id |
| --- | --- | --- | --- | --- |
| Pi | App id | live `message_start` | 扩展随机生成；落盘后用 `persistedMessages` 映射到 entry id | 不能：扩展没有把 App id 交给这条消息 |
| Codex（终端 / 桌面） | App id | live `item/started` | `clientUserMessageId` 回带后等于 App id；entry id 是 item id | 能（旧版 app-server 不回带时退化为 item id） |
| DSH Web | App id（`requestId`） | `user/message` 事件，立即成为 canonical | `seq` 派生的 entry id | 原生事件有 `source.rpcId`，但没有投影出来；映射只在回合结束时发送 |
| DSH ACP（遗留） | 不排队 | 回合结束时作为 canonical 落盘 | entry id | `persistedMessages` 给出 App id → entry id |
| Claude Code | 无队列 | 只来自 transcript 行 | transcript uuid | 不能：Mods 提交没有回传身份 |

另外，`delivery` 模式的消息先进入 Host 投影的队列，交付后才进入聊天；DSH Web 即使空闲也先入队。
断线时，客户端把未完成命令记为 `cancelled`，但命令可能已经送达 Host。
这些情况下都不能用文本匹配猜身份：同一句话可以连续发两次，后端也会追加附件路径或改写正文。

### 2026-11-01 范围扩展

原 §5 用“可核对、可恢复、不诱导危险后续操作”三条筛选其他操作。其中“可核对”实际是实现条件，
结论因此偏保守：归档和撤回排队只列为建议，回答审批维持锁定等待，模型切换整体不乐观。
乐观操作按体验分级（§5），
并补充各操作的规则（§6）和所有操作共用的客户端操作账本（§7）。

2026-11-01 核对的现状：

- 归档 / 取消归档：两端都等 `session.archive.changed` 触发目录刷新后才移动卡片。
  Android 跟踪请求并有 30 秒超时，iOS 没有回执跟踪。
- 撤回排队消息：队列项等回执后才移除。
- 回答审批 / 问卷：面板保持提交中，等回执后才收起。
- 关闭通知：发出关闭后重新读取通知集合，横幅等读取结果返回才消失。
- 附件：上传完成前不能发送，用户要等上传结束再点发送。
- 模型 / 思考级别：通过 Slash 选项提交，Host 确认后顶栏才显示新值。
- 新建 / 恢复会话：发出启动请求后停在原处等待，Runtime 上线后才进入聊天。
- 发起下载：点击后立即在下载列表建立任务行，进度和失败都显示在这一行，已经是乐观显示。

## Decision

### 1. 客户端管理待确认发送

待确认发送属于按 Host / Session 归属的本地 outbox，在界面中叠加权威记录，并按消息身份交接。进程内状态与发送前的持久草稿副本按各自生命周期保存。

### 2. Host 负责声明对应关系，客户端只做精确匹配

Host / backend 将 App id 声明为 clientMessageId 或等价持久映射，客户端按该身份完成本地行与权威行的交接。各后端保留原生消息身份，来源适配负责确定性关联。

### 3. 位置和状态

本地行按创建时锚点与 delivery 归属呈现，Host 队列和消息身份决定交接。等待、发送、受理、失败与未确认保持可辨，输入和附件随本地受理及恢复副本规则交接。

### 4. 兜底规则：源端始终为准

发送结果由原生受理、权威身份与完整状态核对确认，结果未知时保持可见。已确认受理的兼容路径采用有界核对；用户重试建立新操作身份，恢复正文和附件由 outbox 管理。

### 5. 操作分级：只按体验判断（2026-11-01，取代原 §5）

乐观显示适用于结果由用户决定、失败可原位恢复且提前呈现保持事实可靠的操作。其他操作即时反馈进度，最终状态由源端确认；身份与恢复能力由共用模型承接。

| 分级 | 操作 | 立即显示 | 规则 |
| --- | --- | --- | --- |
| 乐观 | 发送消息、followUp / steer 入队、失败后重发 | 本地气泡 / 队列提交态 | §1–§4。steer 只乐观显示入队，不提前显示中断 |
| 乐观 | 带附件发送 | 带附件和上传进度的气泡 | §6.1、§6.2 |
| 乐观 | 产生对话的 Slash（目录 `source` 为 `prompt` / `skill`） | 本地用户气泡 | §6.1 |
| 乐观 | 撤回排队消息 | 队列项移除 | §6.3 |
| 乐观 | 首页关闭会话（左滑、多选） | 卡片退场 | 首页关闭规则（已实施），断线按 §7.4 L4 |
| 乐观 | 归档 / 取消归档（含多选） | 卡片移到目标列表 | §6.4 |
| 乐观 | 回答审批 / 问卷、取消提问 | 面板收起，原位显示回答摘要 | §6.5 |
| 乐观 | 关闭通知 | 横幅消失 | §6.6 |
| 乐观 | 发起下载 | 下载列表任务行 | 已符合，维持现状 |
| 条件乐观 | 模型、思考级别 | 所选值，带“切换中” | §6.7 |
| 即时反馈 | 停止 | 按钮变为“停止中” | “已停止”等原生中断确认 |
| 即时反馈 | 新建 / 恢复会话 | 立即进入聊天页，状态为“启动中” | §6.8 |
| 即时反馈 | Rewind、分支跳转、`/new`、`/fork` | 目标处显示处理中 | 历史裁剪、会话切换和草稿替换等确认后才发生 |
| 等确认 | 权限设置 | 处理中 | 显示必须与真实安全状态一致（ADR-0031） |
| 等确认 | 供应商 / 账号切换 | 处理中 | 牵涉计费和账号归属 |

### 6. 各操作规则

每个操作都是 §7 账本中的一种操作（§7.5）。下面只写各自的呈现和种类规则；
阶段、断线、期限、作用域和冲突由 §7 统一处理。

#### 6.1 带附件发送与产生对话的 Slash

附件与产生对话的 Slash 复用本地气泡、身份对账及输入准入。附件上传属于发送前置，正文与附件完整提交；prompt / skill 命令通过来源声明关联生成的消息。

#### 6.2 等待前置操作的消息

发送按创建顺序等待附件、配置或会话启动，前置结果决定继续提交或原位失败恢复。写入前保存正文与附件副本，进程重开后恢复到所属会话草稿。

#### 6.3 撤回排队消息

撤回立即呈现退场，按 Host 队列核对取消、已交付或拒绝；未确认时保留核对状态，明确失败时原位恢复。

#### 6.4 归档 / 取消归档

归档立即叠加目标位置，逐项按权威目录结算，失败原位恢复并维护视口。断线后按完整目录核对。

#### 6.5 回答审批 / 问卷、取消提问

回答后收起面板并在原位反馈，确认结果由请求拥有者裁决；失败恢复仍有效的请求与答案，失效请求呈现其终态。短反馈由会话生命周期持有，敏感内容以提交状态表达。

#### 6.6 关闭通知

关闭按本设备的通知身份立即隐藏，并由后续完整通知状态核对。

#### 6.7 模型与思考级别（条件乐观）

配置选择立即呈现切换进度，权威配置确认后结算，依赖消息按前置顺序提交；失败恢复确认值及待发送内容。Codex 按字段分开核对下一轮选型与原生观测，见 ADR-0061。

参考：[ADR-0061](0061-codex-selection-and-native-settings-reconciliation.md)；[ADR-0021](0021-codex-terminal-host-attachment.md#revision-2026-11-03-model-selection-before-the-first-input)；[ADR-0031](0031-host-permission-management.md)。

#### 6.8 新建 / 恢复会话（即时反馈）

启动立即进入目标聊天页并呈现启动状态，已有会话先显示缓存。草稿和等待消息随启动身份交接，失败在原位保留输入并提供恢复。

### 7. 客户端操作账本：所有乐观操作的共用模型

§5 的每个操作都记在同一本账上，由账本统一负责阶段、断线、期限、作用域和冲突。
各操作定义目标、叠加效果和落地判据（§7.5）。

#### 7.1 边界

每个 HostConnection 持有进程内操作账本，界面按创建顺序叠加未结算操作，结算后由权威状态接管。

#### 7.2 操作记录

| 字段 | 含义 |
| --- | --- |
| `opId` | 一次操作的身份：runtime.command 使用 commandId，DeviceE2ePayload 使用 requestId（ADR-0055 §6） |
| `kind` | 操作种类（§7.5） |
| `target` | 目标键：对象身份，例如 `runtime:<runtimeId>`、`session:<agentKind>:<sessionId>`、`queue:<sessionId>:<queueId>`、`interaction:<runtimeId>:<requestId>`、`notification:<runtimeId>:<hostEpoch>:<notificationId>`、`config:<sessionId>:<设置名>`、`launch:<requestId>` |
| `effect` | 操作产生的源端对象身份，例如消息的 App id；与 opId 分开 |
| `basis` | 创建时已应用的权威版本：落地判据要读的领域的 `(modelEpoch, revision)`，或会话来源位置 |
| `connection` | 写入通道时的连接代次。本机每建立一次加密连接加一 |
| `settledRead` | 操作处理之后的权威读取序号，用于因果核对（L2） |
| `prerequisites` | 尚未完成的前置操作（§6.2） |
| `phase`、`deadline`、`detail` | 阶段、回执期限、原因 |

#### 7.3 阶段

| 阶段 | 含义 | 离开条件 |
| --- | --- | --- |
| `waiting` | 本机已创建，等前置操作，尚未写入通道 | 前置完成 → 写入通道 → `sent`；前置失败 → `rejected` |
| `sent` | 已写入加密通道 | 同 opId 回执：受理 → `accepted`，明确失败 → `rejected`；断线或期限到 → `unknown` |
| `accepted` | Host 已受理，尚无最终结果 | 落地证据 → `landed`；明确失败 → `rejected`；断线或种类期限到 → `unknown` |
| `unknown` | 可能已执行，结果未知 | 核对（§7.4 L5）→ `landed`、`rejected` 或 `unconfirmed` |
| `unconfirmed` | 有界核对后仍无证据（ADR-0055 P12） | 保持可见并提供核对入口；之后出现落地证据仍转 `landed` |
| `landed` | 权威状态已体现结果 | 删除记录 |
| `rejected` | 明确未执行，或结果不明规则判定未生效 | 按种类显示原因与操作，用户处理或提示结束后删除 |
| `expired` | 目标或作用域已不存在 | 删除记录，不提示 |

任何阶段出现落地证据都直接转 `landed`，例如 `sent` 时权威记录已经带回 App id。

#### 7.4 不变量

- **L1 身份**：以关联回执、权威版本和本机生命周期事件推进阶段。
- **L2 因果**：状态单调推进，反向证据来自操作之后的完整核对。
- **L3 叠加**：呈现叠加可逆，删除操作即回归权威状态。
- **L4 断线**：已发操作进入 unknown，等待操作继续服从前置结果。
- **L5 核对**：通过完整状态、私有回执与种类判据结算未知结果。
- **L6 重试**：用户重试建立新的操作和身份。
- **L7 作用域**：操作随 Host、Session 与连接代次归属失效。
- **L8 期限**：按统一回执预算和种类期限触发核对。
- **L9 顺序**：冲突串行，同会话消息保持创建顺序。
- **L10 预算**：账本按容量准入并保留未结算记录。
- **L11 生命周期**：进程内账本与发送前草稿副本分别管理。

当前回执预算为 60 秒，账本容量为 256 条。

#### 7.5 操作种类

每种操作只定义下表各列；阶段、断线、期限、作用域和冲突全部由账本处理。

| 种类 | 本地呈现 | 权威确认来源 |
| --- | --- | --- |
| `send` | 本地气泡或队列提交态 | 源端声明的消息身份 |
| `quit` | 首页卡片退场 | 在线列表、离线事件及操作回执 |
| `archive` | 目标目录位置 | 权威目录中的归档状态 |
| `queueCancel` | 队列项退场 | 原生队列取消或交付结果 |
| `respond` | 原位回答摘要 | 请求拥有者的处理结果 |
| `dismiss` | 本设备横幅隐藏 | 本设备通知状态 |
| `config` | 所选值与切换进度 | model 域确认的配置 |
| `launch` | 目标聊天启动态 | 同请求激活结果及 Runtime 上线 |

操作期限与因果结算由账本统一处理，当前异步结果核对期限为 15 秒。

依赖关系：`send` 可以依赖 `config`、`launch` 或附件上传（§6.2 的 `waiting`）；前置被拒绝时，
依赖它的 `send` 一起转 `rejected`。

#### 7.6 Host 前提与已知缺口

账本依赖版本化领域、幂等回执和稳定消息身份，按完整权威状态结算。DeviceView.operations 当前每设备保留至多 256 条回执；回执缺席表示证据不足。

OPT-H1 已接入 session.archive / session.activate 的 requestId 回执，OPT-01 已接入两端的设备私有操作读取；ADR-0055（main `74c4d01`）将 pending 与 unconfirmed 分别保留。

在线列表仍缺领域版本和读取请求，通知快照仍缺请求身份；同连接内通过有序事件及核对读取时点建立因果，新连接以首份认证状态为基线，路径切换乱序可能增加一次未确认提示。

Slash 的 messageId 已由 Codex skill 和 DSH Web skill 声明。Pi prompt 与 Claude 用户命令尚缺稳定声明，继续使用 §4 的受理后有界核对路径。

#### 7.7 与现有实现的关系

- `closingRuntimes`、Android `sessionArchiveRequests`、`pendingQueueCancellations`、`submittingInteractions`，以及模型 / 思考级别
  原先经 `pendingActionIds` 的跟踪，都已迁为账本中的种类，并删除各自的计时与断线代码。
- `send` 种类（2026-11-01 实施决定）：账本负责写入通道之前的 `waiting`（附件上传、配置切换、会话启动这三种前置，
  以及同会话顺序）；写入通道后交给 ADR-0055 的 `PendingSendOutbox` / `PendingSends.kt` 结算（只按 Host 声明的身份、
  断线转未确认、不自动重发、隐藏恢复副本）。两者在写入时交接：账本记录删除，outbox 行从 `waiting` 进入发送中。
  outbox 继续负责写入后的对账与恢复。
- ADR-0055 的本轮实现保留队列接管后的隐藏恢复副本、使用静态的“已排队 / 未确认”呈现，并去掉 pending 的
  15 秒删除兜底；写入通道后的 `send` 沿用这些语义（ADR-0055 已合入 main `74c4d01`，交接见上一条）。
- 两端账本同构：类型、转移、不变量和测试用例一一对应。种类定义集中在 iOS `OperationKinds.swift`、Android `OperationKinds.kt`。
- 平台差异：iOS 的 `HostConnection` 可以切换配对并有 `shutdown()`，两处都让账本全部失效（L7）；Android 的
  `HostConnection` 按配对创建、随配对销毁，账本随之消失，没有对应入口。Android 的 `device.ready` 可能先于握手确认到达，
  因此两端都在“加密通道可用”与“首个经认证的 `device.ready`”中先到的一个开启新的连接代次。
- `launch` 的平台差异（2026-11-02 补齐 Android）：恢复已有会话时，两端启动页都先显示缓存历史（V13）。iOS 沿用缓存会话的聊天页；
  Android 读取本机缓存的会话图并在启动页显示，会话上线后由真实会话接替。启动页上的本地行与发送飞入按启动请求的会话归属
  （恢复时为原会话，新建时为占位身份）；Android 此前按在线 Runtime 取会话，启动中写的消息不显示，已修正。
  会话上线时输入框焦点交给真实会话页，正在输入不被打断：iOS 的聊天页按 Runtime 身份重建，由连接层显式交接焦点；
  Android 沿用同一输入框节点保持焦点。两端的草稿、等待中的消息、失败原位提示与“离开后不拉回”一致。
- `launch` 的落地顺序：真实 Host 先广播 Runtime 上线，再回复同一 requestId 的 `session.activated`。账本须在切到真实会话、
  清除启动状态之前按启动请求的 Session 判定落地，否则等它的消息永远不会写入（2026-11-02 iOS 修正，两端补充该顺序的用例）。
- 与共用交互动效（[ADR-0058](0058-shared-interaction-motion.md)）：首页关闭的呈现层退场副本只负责动画，卡片是否隐藏由账本
  `quit` 叠加决定；账本拒绝或核对后会话仍在线时，卡片按 ADR-0058 §3 回到原位置。发送飞入按 clientMessageId 绑定，
  重发与等待中的消息同样适用；飞入不代表写入或成功。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## Consequences

发送后的气泡立即出现，并从“发送中”平滑变为权威行；所有后端都使用同一条精确对账规则。
代价是协议新增一个可选字段，每个后端都要维护“手机发送 → 原生用户消息”的对应关系。
Claude 只能通过 Host 自己提交的正文建立对应；正文被原生改写时会进入兜底规则，表现为气泡短暂消失后由权威行补上。
待确认发送不跨进程保存，App 被杀时未送达的正文不会恢复。

2026-11-01 扩展后，用户能直接决定结果的操作都在点击时就看到结果，失败在原处恢复，等待不再出现在附件上传、
配置切换和会话启动之前。停止、权限和供应商等误判代价高的操作保持诚实的“处理中”。
代价是：`slash.execute` 要携带 App id，各后端要为 Slash 产生的消息声明对应关系；两端要维护更多同构状态机；
UI 回归要覆盖每个乐观操作的拒绝、无回执和断线路径。所有操作改走同一本账后，断线、期限、作用域和冲突只实现一次，
新增操作只需定义种类；代价是现有的五套跟踪状态要迁移。`send` 只把写入通道之前的等待放进账本，写入后仍由
ADR-0055 的 outbox 结算（§7.7），因此发送存在一次交接，两端都要守住交接时的身份不变。

## 实施结果

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 后续操作

旧逐操作评估已由 §5–§7 的统一分类与账本规则替代。

### 首页关闭的乐观规则（本轮实施）

首页关闭由 quit 账本叠加与权威在线状态共同管理，呈现层按共用动效退场；拒绝原位恢复，断线按新连接的状态核对。OPT-01 已替换旧 closingRuntimes 与独立计时逻辑。

## 验证与证据

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 2026-11-01 输入生命周期补充

输入生命周期按 [ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md) 统一管理。Host 队列接管后，outbox 保留恢复副本到精确落地或明确撤回，按真实队列与核对结果呈现状态。当前 outbox 为进程内状态，普通 pending 的 15 秒删除机制已移除。

## 2026-11-01 操作账本实施（OPT-00、OPT-01）

原实施基线为 `ec5b7af`，后续随 r32 合入。

- **OPT-00 账本核心**：iOS `OperationLedger.swift`、Android `OperationLedger.kt`，纯值、不做 IO、不计时。
  两端各 22 项单测覆盖 L1–L11，另有 5 组固定种子随机序列逐步断言 §7 的六条性质。
  变异检验：把断线规则改成只处理 `sent`，两端均有用例失败。
- **OPT-01 接线与 `quit`**：两端连接层持有账本；断线 / 新连接、命令回执（`command.result`、`runtime.error`、`protocol.error`）、
  在线列表（`device.ready`、`runtime.online` / `runtime.offline`）、设备私有回执读取和统一时钟都作为账本输入。
  首页隐藏卡片 = 未结算的 `quit` 叠加。删除 iOS `closingRuntimes` / `closeFinished`、Android `closingRuntimes` /
  `watchClosingRuntime` 及各自计时。关闭命令不再进入通用的 `runtimeActions` / `pendingCommands` 跟踪。
- **验证与未验收**：账本不变量、变异对照与关闭定向结果见`.artifacts/ui-regression/2026-11-01-optimistic-actions/opt-01/`；后续r32补关闭后断线设备用例，真实Host核对与完整用户仍未验收，见对应任务证据。

## 2026-11-01 其余种类实施（OPT-H1、OPT-02–OPT-10）

分支 `feat/optimistic-actions`（基线 main `e4df87a`）。

- **OPT-H1 Host 设备回执**：`session.archive` / `session.activate` 按 requestId 写设备私有回执（success / failure，
  失败带 `agent_unsupported`、`session_not_found` 等原因码）；`host-service.test.ts` 覆盖成功与失败。
- **OPT-02 `dismiss`**：关闭通知只在本设备隐藏，快照确认后结算；断线保持隐藏，新连接的首个快照核对（§7.6 缺口 6）。
- **OPT-03 `archive`**：卡片立即移到目标列表；Host 回执成功后仍保持叠加到目录体现（`successLands = false`，15 秒后转核对），
  避免目录刷新前闪回；批量归档逐张结算，拒绝在原列表原位恢复并合并为一条说明。
- **OPT-04 `queueCancel`**：队列项立即退场；`already_delivered` 就近说明、消息随权威记录出现；`cancelled` 不再单独显示（§6.3 实施细化）；
  运行时离线时按在线列表让撤回结束，不在每次重连时误判。
- **OPT-05 `respond`**：面板立即收起，原位覆盖式摘要（自由文本 / 敏感输入只显示“已提交”），草稿保留到结算；拒绝恢复面板并说明；
  请求已失效时显示事实。
- **OPT-06 `waiting`**：附件上传中、模型 / 思考级别切换中、会话启动中发送，气泡立即出现并清空输入，状态行标明在等什么，
  气泡内显示附件（图片缩略图、文件名与上传进度，2026-11-02 补齐）；
  同会话按创建顺序写入；前置失败只影响依赖它的消息（可重试 / 放回 / 删除）；等待中的正文另存副本（V17）。写入后交给 outbox（§7.7）。
- **OPT-07 `config`**：选择器与顶栏立即显示所选值并带“切换中”，Host 的模型领域发布确认值后去掉标记；失败回到确认值并连带等待中的消息。
- **OPT-08 `launch`**：确认新建 / 恢复后立即进入聊天页显示“启动中”，可写草稿和发送等待消息；失败或未确认在原位提供“重试”“返回”；
  用户离开后启动继续、成功不拉回；草稿和等待消息在上线后迁到真实会话。恢复时两端都先显示缓存历史（Android 2026-11-02 补齐，§7.7）。
- **OPT-09 Slash 消息**：`slash.execute` 带可选 `messageId`；Codex skill 把它声明为 `clientUserMessageId`，两端按消息乐观显示；
  DSH Web skill 自 2026-11-02 起同样声明；Claude 用户命令与 Pi prompt 模板暂走 §4 兼容兜底（§7.6 缺口 7）。

### OPT实施索引

旧实施草稿并入本索引；具体账本契约以§5–§7为准，设备 / 用户 / 真实Host未验收状态保留。

| 编号 | 已实施范围 | 边界 |
| --- | --- | --- |
| OPT-00 | 纯值账本 / L1–L11 | 时钟与 IO 由连接层驱动 |
| OPT-H1 | Host设备私有回执 | 按原请求ID核对 |
| OPT-01 | 接线 / quit | 真实Host断线未验收 |
| OPT-02 | dismiss | 设备 / 用户状态见OPT-10 |
| OPT-03 | archive | 成功回执后叠加保持到目录体现 |
| OPT-04 | queueCancel | 按真实cancelled / delivered / 不可取消核对 |
| OPT-05 | respond | 敏感回答呈现提交状态，拒绝原位恢复 |
| OPT-06 | send / waiting | 附件 / 顺序 / V17副本，结算由ADR-0055 outbox负责 |
| OPT-07 | config | 前置确认 / 连带等待消息 |
| OPT-08 | launch | 恢复缓存 / 等待行 / 上线顺序 / 焦点交接 |
| OPT-09 | prompt / skill Slash | 原生声明clientMessageId；未声明沿§4兼容兜底 |
| OPT-10 | 验收登记 | r32自动与外观有证据，用户R26 / R27及真实Host未完 |

## 2026-11-02 收尾（ADR-0051 r32）

分支 `feat/optimistic-actions` 合入 main `706a1bd`（共用交互动效，原 r31 顺延为 r32）与 `fdcd0fc`（启动准备、关闭触觉、diff 路径）后补齐：

- **等待气泡的附件**（§6.1）：两端气泡内显示附件，图片为降采样缩略图，其他文件为图标；文件名按 S09 保留扩展名，下方为上传状态与进度。
- **Android 启动页**（§7.7）：本地行与发送飞入按启动请求的会话归属，修正启动中写的消息不显示；恢复已有会话时先显示本机缓存历史。
- **启动落地顺序**（§7.7）：真实 Host 先广播 Runtime 上线、再回复 `session.activated`。iOS 原先在这一顺序下先切页、清除启动状态，
  账本无法判定启动落地，等它的消息不写入；改为先按启动请求的 Session 核对再切页，两端补充该顺序的单测。
- **输入焦点**：会话上线时输入框焦点交给真实会话页，正在输入不被打断（iOS 显式交接，Android 同一输入框节点保持）。
- **启动状态色**：“启动中”与运行中同色，“启动未确认”与等待同色。此前 iOS 落到空闲绿、Android 落到错误红，两端不一致且 Android 误示为错误。
- **状态行转圈**：iOS 气泡下方“发送中 / 等待”的转圈不随动态字体放大，XXXL 下不再溢出 26pt 槽位遮挡文字（A3 截图审阅发现）。
- **DSH Web skill 身份**（§7.6 缺口 7）：以 App id 作 `session/prompt` 的 requestId，原生用户消息据 rpcId 声明 `clientMessageId`。
- **预览注入与设备用例**：iOS `--preview-upload-waiting[=fail]`、`--preview-launch-slow`、`--preview-close=drop`，分别覆盖上传中发送 / 上传失败与顺序、
  启动中发送后上线、关闭后断线再重连（V11 r27）；Android `LaunchPageInstrumentedTest`（3）与 `OptimisticPresentationInstrumentedTest` 的上传气泡用例。

r32 验证记录见 `.artifacts/ui-regression/2026-11-02-optimistic-merge/summary.md`。

## r30 动效交接补充

关闭退场与发送飞入通过 [ADR-0058](0058-shared-interaction-motion.md) 统一管理，展示副本按领域身份绑定；网络提交、业务结算和阅读锚点由各自拥有者维护。§5–§7 已于 2026-11-02 随 ADR-0051 r32 合入，验收范围见实施记录。

## 2026-11-02 / r35 交互补充（已接入，验证中）

新建启动卡通过 requestId 与账本关联，按 [ADR-0058](0058-shared-interaction-motion.md) 交接聊天页；恢复、重试和减少动画沿各自生命周期处理。双端完整验收仍待完成。
