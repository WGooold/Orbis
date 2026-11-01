# ADR-0049：用户操作的乐观显示与源端对账

日期：2026-10-30；2026-11-01 扩展范围（§5–§7）

Status: accepted（§1–§4 的消息发送与首页关闭已实施，隔离模拟器回归通过，真机待复测；§5–§7 的范围扩展已决定：§7 账本核心与首页关闭迁移（OPT-00、OPT-01）已实现并通过单元与定向设备用例，其余种类待实施；UI 回归全量门禁完成前不记为交付）

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
用户决定只从体验判断哪些操作应当乐观，实现难度不作为排除理由。本次扩展按此重新分级（§5），
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

### 1. 待确认发送是客户端本地状态，不是源端事实

- 发送时在当前 Host 连接下创建一条**待确认发送**（pending send），字段为 App id、`commandId`、正文、
  附件路径、`delivery`、Session ID、创建时的锚点消息和状态。它属于 ADR-0032 的客户端本地 outbox，
  不写入历史缓存或 applied baseline，也不参与 source epoch、分页和覆盖判断。
- 待确认发送与权威记录分开存放，只在发布界面时叠加。`replace` 快照、分页补入、alias 退场、
  epoch 更换都只修改权威记录，不会误删或复制本地行。
- 所有状态都只对当前 Host 和该 Session 可见。按 Session ID 而不是 Runtime ID 归属，
  这样 Runtime 重新上线后仍能找到这条记录。进程退出后不恢复：已送达的消息会随同步出现，
  未送达的正文不会恢复（§6.2 写入通道前的等待消息例外）。

### 2. Host 负责声明对应关系，客户端只做精确匹配

协议的 `ChatMessage` 新增可选字段 `clientMessageId`。由手机 `user_message` 产生的用户消息首次出现时，
无论是 live 行还是 canonical 显示行，后端都要在消息上携带原 App id。Host 不改写后端自己的 `messageId`，
Pi 的 live → entry 映射、Codex 的 `persistedEntryId` 等现有身份链保持不变。

- **Pi**：扩展登记“已交给 Pi、尚未出现”的手机发送，内容就是传给 `pi.sendUserMessage` 的结构。
  用户角色的 `message_start` 只认领内容完全相同的最早一条登记，并在 live 的开始、结束和 source live 行上
  都标注 `clientMessageId`。空闲直发和队列投递使用同一套登记。
- **Codex**：`withClientMessageId` 在设置 `messageId` 的同时设置 `clientMessageId`。canonical Entry
  保持 item id 作为 `messageId`，同样从 item 的 `clientId`（rollout 落盘为 `client_id`）声明 `clientMessageId`。
- **DSH Web**：用户消息的 `source.kind = user` 且有 `source.rpcId` 时，把它投影为 `clientMessageId`。
  该值保存在原生日志中，live、canonical 和重新读取的历史都能保留。
- **DSH ACP**：保留回合结束时的 `persistedMessages`（App id → entry id）。客户端把它视为同等的对应声明。
- **Claude Code**：Mods 接受提交时，Host 在该 Session 登记 App id 和实际提交的正文。Transcript 刷新后，
  只把登记之后新增、正文与登记**完全相同**的最早一条用户行映射到该 App id，并在 canonical 投影中标注。
  这是 Claude 后端解释原生事实的一部分（ADR-0032）：比较对象是 Host 自己提交的那段正文，
  不是客户端猜测。登记数量和保存时间都有上限，超出后放弃对应，转用 §4 的兜底规则。
- 协议显示投影把 user 角色条目数据里的 `clientMessageId` 复制到显示行。这只增加可选身份信息，
  不改变显示语义，因此不升级 `projectionVersion`。

客户端认为待确认发送已经**落地**的条件，按以下任一条判断：

1. 权威记录中有消息的 `messageId` 或 `clientMessageId` 等于 App id；
2. Host 以 `persistedMessages` 或 `persistedEntryId` 声明 App id → entry id，且该 entry 已在权威记录中。

落地后立即删除本地记录。之后 live 行退场、换成 canonical 行或被 `replace` 清空，都由权威记录自己处理，
本地行不会再次出现。客户端不按正文相等或前缀匹配做对账。

### 3. 位置和状态

- 无 `delivery` 的消息显示在聊天中，插在创建时最后一条权威消息之后。因此 Claude 或 DSH ACP 的助手流
  先于用户行到达时，顺序仍然是“用户消息 → 回复”。锚点不存在时放在末尾。
- 带 `delivery` 的消息先在队列面板中显示为“提交中”。一旦 Host 队列出现同一 `queueId`，
  就删除本地记录，此后由 Host 队列项负责显示、撤回和交付。
- 聊天中的本地消息如果出现在 Host 队列里（例如 DSH Web 空闲时也入队），继续留在聊天中，
  同时隐藏该队列项，避免同一条消息出现两次。如果 Host 报告 `cancelled` 或 `rejected`，
  按 §4 变为失败；本机撤回成功的消息直接删除。
- 状态包括：
  - `waiting`：本机已创建、尚未写入通道，正在等待前置操作（§6.2）；
  - `sending`：已经写入加密通道，尚未收到结果；
  - `accepted`：收到 `ok = true` 的 `pending` 或 `success`；
  - `failed`：Host 明确拒绝，包括 `failure`、`runtime_busy`、`message_id_conflict` 和队列 `rejected`；
    或前置操作失败（§6.2）；
  - `unconfirmed`：断线、Host 离线或 Runtime 离线导致客户端合成 `cancelled`。此时命令可能已经送达。
  `sending` / `accepted` 只显示轻量的发送中标记，不另起提示行（ADR-0046 §3）。
  `waiting` 用同一位置的轻量标记写明在等什么。`failed` / `unconfirmed` 在气泡下方显示原因和操作。
- 发送成功后，输入框和附件立即清空；没有写入通道时保留输入，并且不创建本地记录。
  §6.2 的等待消息例外：本地记录在写入通道前创建，输入框随即清空，内容由气泡和草稿副本保留。

### 4. 兜底规则：源端始终为准

- **与 ADR-0055 的关系**：本节的 idle 兜底删除只适用于已确认原生受理、但缺少身份对应的兼容路径。
  仍在排队或 `unconfirmed` 的输入不能因 idle 或超时被删除；结果未知时保持可见并核对（ADR-0055 §6、§8）。
  `waiting` 尚未发出，不适用本节。
- **`accepted` 但没有对应关系**：创建后观察到 Runtime 进入 running / waiting，之后回到 idle，
  且在回到 idle 后应用过一次权威状态，消息仍未落地时，删除本地记录。
  如果 Runtime 在接受后超过 15 秒仍是 idle，也执行同一判断。需要权威状态时主动发起一次同步，
  不等下一次推送。这样，即使某个后端漏掉对应关系，也只会短暂缺少气泡，不会永久重复。
- **`unconfirmed`**：重连后，Runtime 为 idle、Host 队列没有该 App id，且应用权威状态后仍未落地，
  改为 `failed("未确认送达")`。Runtime 仍在运行时继续等待；如果之后落地，照常删除。
- **失败操作**：重新发送（新的 App id 和 `commandId`）、放回输入框、删除。不能沿用旧 App id 重试：
  Pi / Codex 空闲直发不按 App id 去重，DSH 会对同一 App id 返回之前的失败结果。
  `unconfirmed` 在核对完成前不提供重新发送，以免已送达的消息被重复提交。
- 不自动重发，也不把本地记录当成交付事实。队列状态仍以 Host 的 Runtime queue state 为准。

### 5. 操作分级：只按体验判断（2026-11-01，取代原 §5）

判断一个操作是否乐观，只问三件事：

1. 结果是否主要由用户自己决定，几乎总会成功；
2. 提前显示错了，会不会让用户误判 Agent 或电脑的真实状态，并据此做错事；
3. 失败时能否在同一对象上原地恢复，且不丢用户输入。

三条都满足的操作先显示结果。第 2 条不满足的只给即时反馈，结果等源端确认。
实现难度、后端是否已经回传身份都不是排除理由；缺少的对应关系由 Host / 后端补齐，原则同 §2。

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

切换电脑、打开会话、查看缓存历史、复制、搜索、草稿、展开工具或差异等本地 / 只读操作，
本来就应即时完成，不属于乐观范畴。只读 Slash 查询显示加载。

停止不乐观的原因：用户看到“已停止”可能就放下手机，而 Agent 还在改文件，误判的代价太大。
权限不乐观的原因：关掉自动批准后若界面先显示已关闭、Agent 实际仍在自动批准，是危险方向的误判。

### 6. 各操作规则

每个操作都是 §7 账本中的一种操作（§7.5）。下面只写各自的呈现和种类规则；
阶段、断线、期限、作用域和冲突由 §7 统一处理。

#### 6.1 带附件发送与产生对话的 Slash

- **附件**：点发送时附件还没上传完，也立即创建本地气泡并清空输入框。气泡内显示附件
  （图片缩略图，文件名按 S09）及上传进度。消息按 §6.2 等待，全部附件上传完成后才写入 `user_message`，
  正文和附件一起提交，不能先发正文、后补附件（ADR-0055 §5）。上传失败或被取消时，气泡转失败，
  原因指明是哪个附件；操作为“重试”“放回输入框”“删除”，放回时正文和附件都回到输入框。
- **产生对话的 Slash**：命令目录中 `source` 为 `prompt` 或 `skill` 的命令执行后，立即显示本地用户气泡，
  正文是用户选择的命令和参数（如 `/name 参数`）。`slash.execute` 为这类命令携带 App id；
  后端展开出的用户消息首次出现时按 §2 声明 `clientMessageId`。权威行可能是展开后的正文，
  替换时保留呈现身份（V09），不按 `/name` 匹配。后端暂时无法声明时走 §4 的兼容兜底。
  其他来源的命令不显示本地气泡，执行期间只显示处理中。
- 这两类操作的准入仍按 ADR-0055 §5：例如 skill / template 只在 idle 执行，不能执行时不显示本地气泡。

#### 6.2 等待前置操作的消息

`waiting` 表示消息已在本机创建，但前面的操作还没完成，暂不写入通道。前置操作只有三种：
附件上传（§6.1）、本会话的模型 / 思考级别切换（§6.7）、会话启动（§6.8）。

- 气泡立即出现，输入框清空。轻量标记写明在等什么：“上传中”“等待模型切换”“等待会话启动”。
- 同一会话按创建顺序提交：前一条还在等待时，后发的消息排在它后面，不越过它。
  前置操作完成后依次写入通道，进入 `sending`，之后按 §2–§4 处理。
- 前置操作失败时，这条消息转 `failed`，原因写明前置操作。操作为“重试”“放回输入框”“删除”；
  配置切换失败时把“重试”换成“按当前配置发送”。附件失败只影响所属消息，后面的消息继续提交；
  配置切换或会话启动失败时，所有等待它的消息一起转失败。
- `waiting` 从未发出，因此没有未确认状态；断线也不改变它，前置操作因断线中止时按该操作的结果处理。
- 写入通道前，正文和附件引用按 V17 的草稿规则另存一份；写入后删除这份副本。进程退出时仍在等待的消息，
  下次打开时回到该会话的输入框，已有草稿则接在其后。附件按传输任务既有的恢复规则处理。

#### 6.3 撤回排队消息

- 点撤回后，队列项立即按既有移除呈现退场。
- `cancelled`：完成，不再显示。
- `already_delivered`：不放回队列。在队列区就近提示“撤回未完成：消息已交给 Agent”，
  消息随权威记录出现在聊天中。
- `not_cancelable` 或其他明确失败：队列项回到原位置并显示原因，可以再撤回。
- 断线或 60 秒无回执（§7）：队列项回到原位，标“撤回未确认”，核对前不能再次撤回。
  重连后以 Host 队列为准：仍在队列则去掉标记、可再撤回；已在聊天中落地则按 `already_delivered` 提示；
  其余情况保持“撤回未确认”并提供核对入口，不自动再次撤回。
- 聊天中本地行对应的隐藏队列项（§3）撤回成功时，本地行直接删除（原规则）。

#### 6.4 归档 / 取消归档

- 请求写入后，卡片立即从当前列表退场，并出现在目标列表（归档区或正常列表）；
  多选批量相同，每张卡片单独核对。列表视口按 V21 保持。
- Host 明确拒绝：卡片回到原列表的原位置，提示“归档未完成：原因”，批量时写明数量。
- 成功回执后，以 `session.archive.changed` 或随后的目录读取确认；目录仍显示旧状态时，恢复并提示。
- 60 秒无回执：主动重新读取目录，按读取结果显示；结果出来前保持乐观位置。Android 现有的 30 秒超时改用此规则。
- 断线：保持乐观位置，以重连后的首个权威目录核对。

#### 6.5 回答审批 / 问卷、取消提问

- 提交后，面板立即按既有退场收起，输入区恢复；还有其他待处理请求时直接切到下一项，各项草稿保留（V07）。
- 原面板位置用覆盖式短状态显示回答摘要（V06，不插入消息行、不推动正文）：确认结果、选项名，或“已提交”。
  自由文本和敏感输入只显示“已提交”，不回显内容。确认前带轻量处理中标记，确认后约 2.5 秒消失（V16）。
- Host 拒绝且请求仍有效（校验失败、通道错误等）：面板回到原位，保留已填答案并显示原因。
- 请求已失效（过期、电脑端或另一台设备已回答、被取消）：不恢复面板，短状态改为对应事实，
  例如“已在电脑上处理”“已过期”，不声称本机回答已生效。
- 断线或 60 秒无回执：短状态改为“未确认”。重连后以交互快照为准：请求仍在，则恢复面板并保留答案；
  请求已不在，则显示“已处理”，不声称是本机回答生效。同一请求只能被回答一次，
  重复回答由请求拥有者校验并拒绝（ADR-0055 I06）。

#### 6.6 关闭通知

- 点关闭后，横幅立即按既有关闭呈现消失，本机记下该通知身份。
- 关闭只影响本设备对该通知的展示，其他设备不变，也不完成命令或审批（ADR-0028 §3）。
- 以 Host 返回的 `removedNotificationIds` 或后续通知快照确认。快照表明本设备仍未关闭该通知时
  （关闭未送达或被拒），通知重新显示，不另弹错误。
- 断线：保持隐藏，以重连后的首个通知快照核对。

#### 6.7 模型与思考级别（条件乐观）

- 前提是当前允许修改（ADR-0055 §5：通常要求 idle；DSH Web 运行中修改的是下一轮配置）。
  不允许时不显示新值，按原规则说明原因。
- 选择后，选择器和顶栏立即显示所选值，并带“切换中”标记；标记消失才表示后端已确认生效。
  顶栏宽度、槽位和省略规则按 V05 不变。
- 确认前发送的消息按 §6.2 等待：气泡立即出现，配置确认后才写入通道，不会以旧配置执行。
- 切换失败：选择器和顶栏回到确认前的值，就近提示原因；等待它的消息一起转失败（“模型切换未完成，消息未发送”）。
- 确认值与所选值不同（后端规范化或别名解析）时，显示确认值并去掉标记。
- 切换中再次选择：显示最新选择；前一次结束后，只在最新选择与确认值不同时再提交。
- 断线或 60 秒无回执：标记改为“未确认”，重连后读取权威配置。与所选值一致时去掉标记并提交等待的消息；
  不一致时按切换失败处理。

#### 6.8 新建 / 恢复会话（即时反馈）

- 在新建面板确认或在目录选择恢复后，立即通过共用导航进入该会话的聊天页（M07 / M14 的入场），
  顶栏状态显示“启动中”，不显示在线、模型等需要源端确认的状态。恢复已有会话时先显示缓存历史（V13）。
  新建面板本身仍是 Sheet（ADR-0054），本条只改变确认后的去向。
- 启动中可以输入草稿。草稿先归属本次启动请求，Host 确认 Session ID 后转到该会话（V17）。
- 启动中发送的消息按 §6.2 等待“会话启动”；Runtime 上线后按 §2–§4 和 ADR-0055 的准入依次提交。
- 启动失败：在聊天页原位显示原因及“重试”“返回”，草稿保留，不自动退回原页面。
- 超时沿用现有启动超时，超时后显示“启动未确认”，以随后的会话列表为准。
- 返回首页不取消启动；启动成功后，会话照常出现在首页。

### 7. 客户端操作账本：所有乐观操作的共用模型

§5 的每个操作都记在同一本账上，由账本统一负责阶段、断线、期限、作用域和冲突。
各操作只定义自己的目标、叠加效果和落地判据（§7.5）。不再为单个操作另建跟踪表。

#### 7.1 边界

- 每个 Host 连接（两端的 `HostConnection`）持有一本**操作账本**。它属于 ADR-0032 的 AppLocalState
  （审计 31–36 的“未确认 outbox”），只在当前进程内存中。
- 权威状态只有三类：Host 发布的版本化领域（ADR-0032：`modelEpoch` 加领域 `revision`）、
  会话来源（ADR-0026 / ADR-0037 的 source epoch / seq），以及带身份的回执（命令回执、设备私有回执
  `DeviceView.operations`）。账本不写入权威状态、历史缓存、applied baseline 或目录缓存。
- 界面 = 权威状态叠加账本：按创建顺序，把未结算操作的效果叠加到权威状态上。叠加是纯函数；
  删除一条操作，界面就回到权威状态，“原位恢复”不需要逐个操作实现。

#### 7.2 操作记录

| 字段 | 含义 |
| --- | --- |
| `opId` | 幂等键：`runtime.command` 用 commandId，`DeviceE2ePayload` 请求用 requestId。一个 opId 只代表一次用户意图，不复用（ADR-0055 §6） |
| `kind` | 操作种类（§7.5） |
| `target` | 目标键：对象身份，例如 `runtime:<runtimeId>`、`session:<agentKind>:<sessionId>`、`queue:<sessionId>:<queueId>`、`interaction:<runtimeId>:<requestId>`、`notification:<runtimeId>:<hostEpoch>:<notificationId>`、`config:<sessionId>:<设置名>`、`launch:<requestId>` |
| `effect` | 操作产生的源端对象身份，例如消息的 App id；与 opId 分开 |
| `basis` | 创建时已应用的权威版本：落地判据要读的领域的 `(modelEpoch, revision)`，或会话来源位置 |
| `connection` | 写入通道时的连接代次。本机每建立一次加密连接加一 |
| `settledRead` | Host 处理完这次操作时的读取序号。本机每发起一次权威读取加一；回复的序号大于它，才能作为反向证据（L2）。同步生效的种类（`dismiss`）取写入通道时的序号；在 Host 上异步完成的种类（`quit`、`archive` 等）取最终成功回执到达时的序号；转为结果不明时取当时的序号 |
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

- **L1 只认身份证据**：阶段只因以下事件改变：同一 opId 的回执（在写入它的连接或之后的连接上收到，
  或在 `DeviceView.operations` 中读到；opId 不复用，所以重连后才处理到的回执照常生效）；符合种类落地判据、且版本新于 `basis` 的权威状态；本机事件
  （断线、作用域变化、期限、用户操作）。不按正文、位置、时间或动画推断。
- **L2 单调与因果**：终态不回退；`pending` 不覆盖更具体的结果。正向证据（权威状态已体现结果）
  只要新于 `basis` 即可采用。反向证据（权威状态表明没有生效）必须在因果上晚于这次操作，只有三种来源：
  这次操作的回执；Host 处理完这次操作之后才发起的读取的完整回复（序号大于 `settledRead`，同一有序通道）；
  以及之后某个连接代次的首份完整快照。在 Host 上异步完成的操作（`quit`、`archive` 等），写入后马上发起的读取
  仍可能早于执行完成，因此只认最终成功回执之后发起的读取；只有同步生效的种类（`dismiss`）可以用写入之后发起的读取。
  推送来的更新即使版本更新，也可能是在 Host 处理这次操作之前生成的，不能作为反向证据。
- **L3 叠加可逆**：叠加只改变目标对象的呈现，按创建顺序应用。删除全部操作后，界面与权威状态完全一致。
- **L4 断线**：连接断开时，所有 `sent` / `accepted` 操作统一转 `unknown`，`waiting` 不变。
  列表类操作（quit、archive、dismiss）在 `unknown` 期间保持叠加效果，内容类操作显示“未确认”。
  单个操作不再自己处理断线。
- **L5 核对**：`unknown` 操作在新连接的首个完整权威状态到达、且同 opId 的设备私有回执已读取
  （或该种类没有设备回执）之后核对，依次看：落地判据 → 设备私有回执 → 种类的“结果不明”规则（§7.5）。
  期限到期的操作由账本主动发起一次读取，以它的回复作为反向证据，不等推送。
- **L6 不重发**：账本不会用新 opId 自动重发，也不会用同一 opId 自动再次提交。
  用户主动重试时生成新操作和新身份。
- **L7 作用域**：换电脑、取消配对、会话被替换或 Runtime 代次变化时，相关操作转 `expired`；
  迟到的回执和旧连接代次的回执不作用于新目标。
- **L8 统一期限**：没有原生终结事件的操作，从写入通道起 60 秒内没有回执就转 `unknown`
  （与 ADR-0055 §6 的回执预算一致）。已登记的种类参数（发送兜底 15 秒、首页关闭 15 / 60 秒）作为种类规则保留。
- **L9 冲突与顺序**：同一目标同时只有一个未结算的冲突操作，冲突入口在结算前禁用并说明原因。
  同一会话的消息类操作按创建顺序写入通道，后创建的不越过仍在 `waiting` 的前一条。
- **L10 有界**：每本账本最多 256 条未结算操作。满时明确拒绝新的乐观操作，不淘汰未结算记录。
- **L11 进程范围**：账本不跨进程保存；唯一例外是 §6.2 写入通道前的草稿副本。

#### 7.5 操作种类

每种操作只定义下表各列；阶段、断线、期限、作用域和冲突全部由账本处理。

| 种类 | opId / 效果身份 | 叠加 | 落地证据 | 明确拒绝 | 结果不明时 |
| --- | --- | --- | --- | --- | --- |
| `send`（含 followUp / steer、prompt / skill Slash） | commandId / App id | 本地气泡；带 delivery 时为队列提交态 | 权威记录中有 App id 对应的消息（§2）；队列受理不算落地 | 回执失败；队列 `rejected` | 保持 `unconfirmed`，核对前不提供重发（§4、ADR-0055 P06 / P12） |
| `quit` | commandId / runtimeId | 隐藏首页卡片 | 该 Runtime 不在新于 `basis` 的完整在线列表中，或收到 `runtime.offline` | 回执失败；成功后 15 秒仍在线 | 新连接的首个在线列表中仍在线 → `rejected`（“关闭会话未确认：会话仍在运行”） |
| `archive` | requestId / sessionId | 卡片移到目标列表 | 新于 `basis` 的目录中归档状态等于目标值，或带同一 requestId 的 `session.archive.changed` | 带同一 requestId 的 `protocol.error` | 新连接的首个完整目录中仍为旧状态 → `rejected`（未确认） |
| `queueCancel` | commandId / queueId | 隐藏队列项 | 回执或队列状态为 `cancelled` | `not_cancelable`；`already_delivered`（显示“已交给 Agent”）；其他失败 | 队列项仍在 → 恢复并标“撤回未确认”；消息已落地 → 按 `already_delivered` |
| `respond` | commandId / 交互 requestId | 收起面板，原位显示摘要 | 回执成功，或新于 `basis` 的完整交互快照中该请求已不存在 | 回执失败且请求仍有效 | 请求仍在 → 恢复面板与答案；已不在 → 显示“已处理” |
| `dismiss` | 无回执；身份为 notificationId + hostEpoch | 隐藏横幅 | `removedNotificationIds` 含该通知，或新于 `basis` 的本设备通知快照不含它 | 关闭之后发起的通知读取，其回复仍含它（L2） | 保持隐藏，以新连接的首份通知快照核对 |
| `config`（模型、思考级别） | commandId / 设置名 | 所选值加“切换中” | model 域发布的确认值，新于 `basis`；与所选不同时显示确认值 | 回执失败 | 读取权威配置：与所选一致 → `landed`，否则 `rejected` |
| `launch`（新建 / 恢复） | requestId / 随后的 sessionId | 聊天页加“启动中” | 同一 requestId 的 `session.activated`，且该 Session 的 Runtime 上线 | 带同一 requestId 的错误 | 以随后的会话列表核对；仍无结果 → `unconfirmed`（“启动未确认”） |

依赖关系：`send` 可以依赖 `config`、`launch` 或附件上传（§6.2 的 `waiting`）；前置被拒绝时，
依赖它的 `send` 一起转 `rejected`。

#### 7.6 Host 前提与已知缺口

账本的保证成立，依赖 Host 守住以下事实：

- **版本化领域**：catalog、interactions、model、execution 等按 ADR-0032 发布 `modelEpoch` 和 `revision`，
  完整快照与部分结果可以区分；通知按 ADR-0028 有独立版本。
- **回执**：`runtime.command` 的结果带 commandId；同一 commandId 不重复执行，重复请求重放原回执
  （ADR-0055 §6）。基线已有设备私有回执 `DeviceView.operations`，每台设备最多 256 条、按最旧淘汰；
  账本核对时读取它，但查不到不能当作“没发生”。
- **身份声明**：消息的 `clientMessageId`（§2）以及 Slash 产生消息的声明（§6.1）。

已知缺口。实施时补 Host；补齐前，对应种类只能靠读取权威状态核对：

1. `session.archive`、`session.activate` 等 `DeviceE2ePayload` 请求没有写入 `DeviceView.operations`，
   断线后只能靠目录或会话列表核对。应按 requestId 写入设备私有回执。
2. `device.ready` 的在线列表没有领域版本。账本把新连接的首个 `device.ready` 视为新于 `basis`；
   同一连接内只能依赖增量事件的顺序。
3. ~~两端目前不读取设备作用域的 `operations` 领域~~：OPT-01 起两端在核对时一次性读取（`agent.state.request`，
   `scope: "device"`，`domains: ["operations"]`，不订阅）。读取失败也视为这次读取之后的回复：回执按查不到处理，
   仍以在线列表核对，不让操作停在结果不明。
4. Host 写设备私有回执时把 `ok: true, status: "pending"` 的 `command.result` 记成 `success`
   （`host-service.ts` 的 `settled` 映射），设备回执因此分不清“已受理”和“已成功”。`quit` 不受影响（成功也要等离线），
   `send`（OPT-06）迁移前须在 OPT-H1 改为记 `pending`。
5. 在线列表没有读取请求。同一连接内核对 `quit` 时，以核对读取的回复为时点：同一有序通道上，回复到达时增量维护的在线列表
   已包含 Host 处理这次读取之前发出的全部上下线事件。LAN 与中继切换的瞬间可能乱序，结果只会是多一次
   “关闭会话未确认”提示（安全方向）：随后到达的离线事件仍会让卡片按权威列表消失。

#### 7.7 与现有实现的关系

- 现有的 `PendingSendOutbox` / `PendingSends.kt`、`closingRuntimes`、Android `sessionArchiveRequests`、
  `pendingQueueCancellations`、`submittingInteractions` 和 `pendingActionIds` 都迁为账本中的种类；
  迁移后删除各自的计时与断线代码。
- ADR-0055 的本轮实现保留队列接管后的隐藏恢复副本、使用静态的“已排队 / 未确认”呈现，并去掉 pending 的
  15 秒删除兜底；`send` 种类沿用这些语义。`send` 的迁移等 ADR-0055 的实施合入后再做，避免两边同时改 outbox。
- 两端账本同构：类型、转移、不变量和测试用例一一对应。种类定义集中在 iOS `OperationKinds.swift`、Android `OperationKinds.kt`。
- 平台差异：iOS 的 `HostConnection` 可以切换配对并有 `shutdown()`，两处都让账本全部失效（L7）；Android 的
  `HostConnection` 按配对创建、随配对销毁，账本随之消失，没有对应入口。Android 的 `device.ready` 可能先于握手确认到达，
  因此两端都在“加密通道可用”与“首个经认证的 `device.ready`”中先到的一个开启新的连接代次。

## Verification

- 两端为待确认发送状态机编写纯逻辑单元测试，覆盖：各后端的对应方式（同 id、`clientMessageId`、alias）、
  `replace` 后不复活、重复正文、锚点顺序、队列接管与隐藏、失败 / 未确认 / 兜底删除、Session 切换隔离。
- Host / 协议测试覆盖：Pi 用户消息的认领、Codex 字段、DSH Web 的 `rpcId` 投影、
  Claude transcript 对应关系，以及显示投影复制该字段。
- 相关核心测试、原生构建和隔离模拟器 UI 回归通过。不连接生产 Host，也不操作用户真机。
- 当前工作区有其他未提交改动；只修改本决策涉及的代码。

### 2026-11-01 扩展的验证（待实施）

- **账本不变量测试**（两端用例一一对应）：L1–L11 各有专门用例；另用随机事件序列（回执乱序与重复、断线重连、
  旧版本快照、换电脑、期限到、前置失败）驱动账本，每一步断言：没有超过期限仍停在 `sent` / `accepted` 的操作；
  终态不回退；删除全部操作后叠加结果等于权威状态；没有操作被自动重发。
- **两端状态机单测**（iOS / Android 用例一一对应）：
  - `waiting`：三种前置操作、同会话顺序、附件失败只影响本条、配置 / 启动失败连带、断线不改变、草稿副本恢复；
  - 产生对话的 Slash：App id 精确落地、展开正文替换后身份不变、无声明时兼容兜底；
  - 撤回：`cancelled`、`already_delivered`、`not_cancelable`、断线 / 无回执及重连核对；
  - 归档：拒绝恢复原位、回执后目录仍为旧状态、60 秒重读、断线保持、批量逐张核对；
  - 回答：收起与摘要、敏感输入不回显、拒绝恢复答案、请求失效、未确认与快照核对；
  - 通知：本设备隐藏、快照确认与重新显示、断线保持；
  - 模型 / 思考级别：切换中、确认、规范化、失败连带等待消息、连续选择、断线读回；
  - 启动：立即进入、草稿迁移、等待消息、失败原位、超时、返回首页不取消；
  - 共用：同一对象冲突禁用、换电脑 / 重新配对失效、首页关闭断线保持隐藏。
- **Host / 协议**：`slash.execute` 的 App id 及各后端为 `prompt` / `skill` 产生的用户消息声明 `clientMessageId`；
  ADR-0055 AIN-01 的命令集合对照仍然通过。
- **设备 UI**：两端扩展乐观操作用例，断言结果在回执前呈现、拒绝后回到原位置（坐标容差 ≤ 1pt/dp）、
  阅读锚点和视口不动、正文只出现一次、减少动画路径语义一致。用例名随实施登记到 UI 回归方案 §3.3。
- **手动**：UI 回归方案 R26（列表与面板类操作）、R27（等待前置操作的发送、模型切换与启动）。
- 门禁按 ADR-0051 与 UI 回归方案：两端 L1–L4、C01–C18、V07、V10–V12、V22 专项和 A1–A4；
  未运行或阻塞的项目如实记录，不记为通过。

## Consequences

发送后的气泡立即出现，并从“发送中”平滑变为权威行；所有后端都使用同一条精确对账规则。
代价是协议新增一个可选字段，每个后端都要维护“手机发送 → 原生用户消息”的对应关系。
Claude 只能通过 Host 自己提交的正文建立对应；正文被原生改写时会进入兜底规则，表现为气泡短暂消失后由权威行补上。
待确认发送不跨进程保存，App 被杀时未送达的正文不会恢复。

2026-11-01 扩展后，用户能直接决定结果的操作都在点击时就看到结果，失败在原处恢复，等待不再出现在附件上传、
配置切换和会话启动之前。停止、权限和供应商等误判代价高的操作保持诚实的“处理中”。
代价是：`slash.execute` 要携带 App id，各后端要为 Slash 产生的消息声明对应关系；两端要维护更多同构状态机；
UI 回归要覆盖每个乐观操作的拒绝、无回执和断线路径。所有操作改走同一本账后，断线、期限、作用域和冲突只实现一次，
新增操作只需定义种类；代价是现有的五套跟踪状态要迁移，`send` 的迁移须等 ADR-0055 的 outbox 改动合入。

## 实施结果

### Host 与协议

- `ChatMessageSchema.clientMessageId` 为可选字段；显示投影只为 user 角色复制该字段，没有改动 `projectionVersion`。
- Pi：`PhoneSendClaims` 在调用 `pi.sendUserMessage` 前登记，空闲直发和队列出队两条路径都会登记。
  用户角色的 `message_start` 只认领文本内容完全相同的最早一条登记，开始和结束事件都会标注；
  发送失败时撤销登记。
- Codex：`item/started` 写入 source live 行时仍以原生 item id 为键，同时声明 `clientMessageId`。
  客户端在 source 模式下只读取 checkpoint 的 live 行，不处理生命周期事件，所以这一步不能省略。
  完成后的行继续使用 App id 和 `persistedEntryId`。
  canonical Entry（`#appendEntry`）也声明 `clientMessageId`，`messageId` 仍是 item id。首轮实施漏了这一步：
  用户消息的 `item/started` 和 `item/completed` 几乎同时到达，生产环境的 source 合并窗口
  （`CODEX_SOURCE_COALESCE_MS`）会把两次改动合成一份 patch。live 行在发布前就已退场，手机只看到 item id 的 Entry；
  Android 又不处理 `turn.finished` 的映射，于是本地行和权威行会在整轮回合里并存，直到 §4 兜底收尾。
  Codex 0.165 的 `thread/read` 和 rollout 都保存该 item 的 client id（rollout 写作 `client_id`），
  因此重连后重新读取的 Entry 仍带同一个值，重复完成同一 item 也不会被当成改写。
- DSH Web：用户消息带 `source.rpcId` 时投影为 `clientMessageId`。该值写在原生日志里，重启后读取历史仍然保留。
- Claude：`ClaudeModsBridge.sendCommand` 接受 `user_message` 时登记实际提交的正文。transcript 刷新后，
  只匹配登记之后新增、正文完全相同的用户行；最多登记 16 条，保留 10 分钟。标注结果按条目对象缓存，
  重复同步返回同一个对象，不会让内容变更信号失效。
- DSH ACP（遗留）没有改动 Host。iOS / Android 在 source 模式下都不处理 `turn.finished` 事件，
  因此 ACP 的本地行实际依靠 §4 的兜底规则收尾。生产 DSH 使用 Web 路径。

### 客户端

- iOS 的 `PendingSendOutbox` 和 Android 的 `PendingSends.kt` 是两套同构的纯状态机，
  状态、规则和测试用例一一对应。iOS 每次发布消息前对账；Android 在统一的 `updateState`
  出口对账，因此每次状态变化都会核对。
- 消息回执会更新对应的本地行，不再弹出全局错误横幅。客户端合成的 `cancelled` 视为未确认，不视为失败。
- 输入框在消息写入通道后立即清空；Android 发送键也不再等待回执才解锁。
- 失败行提供“重新发送”“放回输入框”“删除”。重新发送使用新的 App id，并按当前状态选择投递方式：
  空闲时直发；忙时使用 `followUp`；原消息是 `steer` 且后端不是 Claude 时继续使用 `steer`。
- 权威状态版本按 Session 计数：iOS 在快照被接受或完整 patch 应用后加一；
  Android 在同步命令完成或 source 序号推进后加一。

## 其他操作的乐观评估（实施后补充；2026-11-01 由 §5 取代）

下表是 2026-10-30 按原 §5 三个条件（可核对、可恢复、不诱导危险后续操作）得出的结论，保留作历史记录。
现行分级和规则见 §5–§7；其中首页关闭的结论不变。

| 操作 | 结论 | 理由 |
| --- | --- | --- |
| 首页左滑关闭、多选关闭会话 | **本轮实施** | `runtime.offline` 可以核对结果；被拒绝时卡片可以恢复；隐藏卡片不会触发其他操作 |
| 抽屉归档 / 取消归档 | 建议下一步实施 | `session.archive.changed` 可以核对；Android 已跟踪请求和 30 秒超时，iOS 还没有回执跟踪，需要先补上 |
| 撤回排队消息 | 可以实施，但要处理竞态 | 撤回和交付可能同时发生；`already_delivered` 时要恢复并提示消息已进入上下文，不能让用户以为已经撤回 |
| 回答审批 / 交互 | 维持现状 | 已有本地 `submitted` 状态；回答只能生效一次，失败时会恢复 |
| 停止 | 不乐观 | 不能在源端确认前声称 agent 已停止；只显示“停止中” |
| 模型、思考级别、权限 | 不乐观 | 有效设置必须由后端确认（ADR-0031）；先显示新值可能让用户在错误配置下继续发送 |
| Rewind、分支跳转、`/new`、`/fork` | 不乐观 | 这些操作会切换会话或改写可见历史；失败后无法自然恢复阅读位置和草稿 |
| 新建、恢复会话 | 不乐观 | 需要 Host 实际拉起进程；可以显示“启动中”，但不能当成会话已上线 |
| 关闭通知、草稿、附件选择 | 无需处理 | 这些本来就是客户端本地状态 |

### 首页关闭的乐观规则（本轮实施）

- 写入 `/quit` 后，按 Runtime 记录 `closingRuntimes`。首页立即隐藏卡片，并沿滑动方向退场；
  多选关闭同样处理。
- 收到成功回执后继续隐藏，直到 Runtime 离线。成功后 15 秒仍在线，或 60 秒没有回执，就恢复卡片并提示。
- Host 明确拒绝时立即恢复卡片，提示“关闭会话未完成：原因”。通用错误分支不会再用原始错误覆盖这条提示。
- 断线时清空关闭记录：此时结果未知，以重连后 `device.ready` 返回的会话列表为准。
  （2026-11-01 改为 §7.4 L4 与 §7.5 `quit`：断线时保持隐藏，以重连后的首个权威在线列表和设备私有回执核对；仍在线则恢复并提示。已由 OPT-01 实现，`closingRuntimes` 与两端各自的计时代码已删除，见文末“操作账本实施”。）
- Android 在卡片离场后，如果它仍在列表里，会自动回到原位。这一步的延迟属于动画本身，由帧时钟驱动。

## 验证与证据

均在专用模拟器和独立数据上运行；没有连接生产 Host，也没有操作用户真机。

- TS：`npm run typecheck`、变更文件 ESLint 通过。`vitest` 共 1435 项通过、11 项失败；
  失败集中在 5 个 Windows 平台用例文件（`spawner`、`desktop-terminal`、`codex-shim`、`sessions`、`runtime-log`）。
  它们不引用本次改动的模块，断言内容是 Windows 路径和 `powershell.exe`，本次改动 Host 前就已失败。
  新增或扩展的测试覆盖：显示投影字段、Pi 认领、Codex live 行与事件、DSH Web `rpcId`、
  Claude transcript 认领和对象复用。补充修复后新增两项 Codex 测试：生产合并窗口下只发布 canonical Entry、
  `thread/read` 与 rollout 重放保留 client id。撤掉修复后，这两项都会失败。
  Android 新增一项 reducer 测试：只收到 canonical 快照（经 SQLite 读回）也能消掉本地行。
- iOS：**191 项核心测试**通过，其中新增 9 项状态机测试，并按新决策改写了 Store 发送测试。
  专用模拟器“Orbis Optimistic Send”（iPhone 17 / iOS 27.0）上的 UI 回归通过：
  - 乐观发送：Pi 式延迟回执下，气泡立即出现并显示“发送中”；回执后由 entry 行替换，正文只出现一次。
    被拒绝时显示原因，可以放回输入框。
  - 首页关闭：在确认前隐藏；被拒绝后卡片回到原位，并显示带上下文的错误提示。
  - 原有的短滑回弹、长滑关闭、多选关闭、复制 / Rewind、草稿和队列撤回测试也已通过。
  预览参数 `--preview-send=pi|fail`、`--preview-close=slow|fail` 只在 UI 预览中生效。
- Android：**496 项单元测试**通过，Debug APK 和 AndroidTest 编译通过。
  专用 AVD `Orbis_UI_Polish_35`（emulator-5582，因崩溃对话框改用无窗口软件渲染）上
  **9 项设备测试**通过：新增的待确认气泡和乐观关闭测试，以及首页左滑、多选、长会话进入和阅读位置测试。
  第一次运行时，冷启动模拟器上的长会话首次进入为 1005 ms，超过 500 ms 预算；
  热身后的三次完整运行首次进入为 430 / 410 / 126 ms，均通过。冷启动这次只作为环境记录，
  不作为本次改动的性能结论。
- 证据目录 `.artifacts/optimistic-send/`：`ios-ui-send2.xcresult`、`ios-ui-close2.xcresult`、
  `shots-send/`、`shots-close2/`、`ios-core-final.log`、`android-final.log`、`android-device.log`、
  `ts-vitest.log`、`ts-typecheck.log`。

仍待真机验证：在真实 Pi / Claude 会话中确认正文与登记完全一致，确认弱网断线后未确认行的转换，
以及 Claude `/quit` 实际退出所需时间。如果超过 15 秒，卡片会先恢复，进程退出后再消失。

## 2026-11-01 输入生命周期补充

[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md) 细化所有 Agent 状态下的输入准入、去重、队列投递、成功 / 失败及未确认结果。pending 不等于成功；队列等待不等于投递完成；提交可能已执行时须核对，不能自动重发或用 idle 超时静默删除未确认输入。先登记契约再实施，完整验收状态以 ADR-0055 与本轮证据为准。

ADR-0055 的本轮实现保留 Host 队列接管后的隐藏恢复副本，直到精确落地或用户明确撤回 / 删除；队列失败与下线不会丢失正文 / 附件。排队显示“已排队”并可撤回，未确认使用静态状态与核对入口。pending 不触发 15 秒删除兜底，已 delivered 的队列回执不永久钉住本地行。此修订替代上文旧的队列受理即删除本地记录；outbox 仍只在当前 App 进程中保存。

## 2026-11-01 操作账本实施（OPT-00、OPT-01）

工作区 `.claude/worktrees/optimistic-actions`（分支 `feat/optimistic-actions`，基线 `ec5b7af`），未提交。

- **OPT-00 账本核心**：iOS `OperationLedger.swift`、Android `OperationLedger.kt`，纯值、不做 IO、不计时。
  两端各 22 项单测覆盖 L1–L11，另有 5 组固定种子随机序列逐步断言 §7 的六条性质。
  变异检验：把断线规则改成只处理 `sent`，两端均有用例失败。
- **OPT-01 接线与 `quit`**：两端连接层持有账本；断线 / 新连接、命令回执（`command.result`、`runtime.error`、`protocol.error`）、
  在线列表（`device.ready`、`runtime.online` / `runtime.offline`）、设备私有回执读取和统一时钟都作为账本输入。
  首页隐藏卡片 = 未结算的 `quit` 叠加。删除 iOS `closingRuntimes` / `closeFinished`、Android `closingRuntimes` /
  `watchClosingRuntime` 及各自计时。关闭命令不再进入通用的 `runtimeActions` / `pendingCommands` 跟踪。
- **验证**：iOS SwiftPM 全量 260 项通过（含 `QuitLedgerTests` 13 项）；Android 单元全量 583 项通过（含 `QuitLedgerTest` 12 项），
  `assembleDebug`、`assembleDebugAndroidTest` 与 iOS `build-for-testing` 通过。把断线改回“直接恢复卡片”的变异，
  iOS 有 4 项、Android 有 5 项失败。共享池设备上的定向用例：iOS（iPhone 17 / iOS 27.0）
  `testSwipeCloseHidesBeforeConfirmationAndRestoresOnRejection`、`testHomeLongPressSelectsAndClosesOnlyCheckedSessions`、
  `testHomeShortSwipeReboundsAndLongSwipeClosesOnlyThatRuntime`、`testSwipeRightFromLeftSideOpensDirectory` 通过；
  Android（`Orbis_UI_Polish_35`，API 35）`OptimisticActionsInstrumentedTest`（2）、`HomeSwipeCloseInstrumentedTest`、
  `HomeSelectionInstrumentedTest` 通过。证据：`.artifacts/ui-regression/2026-11-01-optimistic-actions/opt-01/`。
- **未完成**：手动 R27 的“关闭后断线再重连”一项未执行；UI 回归全量门禁（L1–L4、C01–C18、A1–A4）归 OPT-10；
  真实 Host 上的断线核对未验证。
