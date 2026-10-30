# ADR-0049：发送消息的乐观显示与源端对账

日期：2026-10-30

Status: accepted（先记录决策，再实施；两端与 Host 已实施，隔离模拟器回归通过，真机待复测）

关联：[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0035](0035-incremental-session-reconcile.md)、[ADR-0046](0046-mobile-ui-stability-and-material.md)

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

## Decision

### 1. 待确认发送是客户端本地状态，不是源端事实

- 发送时在当前 Host 连接下创建一条**待确认发送**（pending send），字段为 App id、`commandId`、正文、
  附件路径、`delivery`、Session ID、创建时的锚点消息和状态。它属于 ADR-0032 的客户端本地 outbox，
  不写入历史缓存或 applied baseline，也不参与 source epoch、分页和覆盖判断。
- 待确认发送与权威记录分开存放，只在发布界面时叠加。`replace` 快照、分页补入、alias 退场、
  epoch 更换都只修改权威记录，不会误删或复制本地行。
- 所有状态都只对当前 Host 和该 Session 可见。按 Session ID 而不是 Runtime ID 归属，
  这样 Runtime 重新上线后仍能找到这条记录。进程退出后不恢复：已送达的消息会随同步出现，
  未送达的正文不会恢复。

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
  - `sending`：已经写入加密通道，尚未收到结果；
  - `accepted`：收到 `ok = true` 的 `pending` 或 `success`；
  - `failed`：Host 明确拒绝，包括 `failure`、`runtime_busy`、`message_id_conflict` 和队列 `rejected`；
  - `unconfirmed`：断线、Host 离线或 Runtime 离线导致客户端合成 `cancelled`。此时命令可能已经送达。
  `sending` / `accepted` 只显示轻量的发送中标记，不另起提示行（ADR-0046 §3）。
  `failed` / `unconfirmed` 在气泡下方显示原因和操作。
- 发送成功后，输入框和附件立即清空；没有写入通道时保留输入，并且不创建本地记录。

### 4. 兜底规则：源端始终为准

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

### 5. 其他乐观操作

先完成消息发送，再逐项评估其他操作。只有同时满足以下条件的操作才能乐观显示：

- 结果可以从源端状态核对；
- 失败时可以把界面恢复到原状态；
- 先显示结果不会诱导用户继续执行依赖该结果的危险操作。

评估结论记在本 ADR 的实施后补充中。

## Verification

- 两端为待确认发送状态机编写纯逻辑单元测试，覆盖：各后端的对应方式（同 id、`clientMessageId`、alias）、
  `replace` 后不复活、重复正文、锚点顺序、队列接管与隐藏、失败 / 未确认 / 兜底删除、Session 切换隔离。
- Host / 协议测试覆盖：Pi 用户消息的认领、Codex 字段、DSH Web 的 `rpcId` 投影、
  Claude transcript 对应关系，以及显示投影复制该字段。
- 相关核心测试、原生构建和隔离模拟器 UI 回归通过。不连接生产 Host，也不操作用户真机。
- 当前工作区有其他未提交改动；只修改本决策涉及的代码。

## Consequences

发送后的气泡立即出现，并从“发送中”平滑变为权威行；所有后端都使用同一条精确对账规则。
代价是协议新增一个可选字段，每个后端都要维护“手机发送 → 原生用户消息”的对应关系。
Claude 只能通过 Host 自己提交的正文建立对应；正文被原生改写时会进入兜底规则，表现为气泡短暂消失后由权威行补上。
待确认发送不跨进程保存，App 被杀时未送达的正文不会恢复。

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

## 其他操作的乐观评估（实施后补充）

按 Decision §5 的三个条件（可核对、可恢复、不诱导危险后续操作）逐项判断：

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
