# ADR-0023: Codex 原地回退与跨端历史刷新

日期：2026-10-07

Status: accepted（设计已采纳；实施分阶段进行，本 ADR 不代表全部流程已经实现）

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0021](0021-codex-terminal-host-attachment.md)、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0024](0024-recoverable-session-state-sync.md)。实施跟踪：[Issue #1](https://github.com/WGooold/Orbis/issues/1)（源端一致性）、[Issue #4](https://github.com/WGooold/Orbis/issues/4)（桌面/TUI 刷新）。桌面接入以 ADR-0022 中 2026-10-05 的 wrapper 替代决定为准。

## Context

手机对 Codex 历史执行 `/tree` 后，后端历史已经回退，但桌面 GUI 仍显示回退前的消息。反方向，桌面或 TUI 回退后，手机也可能保留旧历史，或同步时出现 `session_sync_backend_failed:canonical_entry_conflict`。

这里存在三个独立状态：app-server 持久化的 thread 历史、Orbis Codex Agent backend 的历史投影，以及 GUI/TUI 的内存 transcript。`thread/revert` 更新前两者中的权威源，不会自动让所有客户端丢弃内存画面。广播送达、文件已写入和客户端重新加载是不同的完成条件。

当前 Orbis 的 `/tree` 已调用原生 `thread/revert`，成功后通过 `thread/turns/list`（`itemsView: "full"`）重建本端历史。通知处理尚无外部 `thread/reverted` 的历史重建流程。当前重放还会参考旧内存中的 parent 和顺序；这不能证明 Host 重启后仍会生成相同 canonical Entry。

因此，本决定分别处理回退后的历史协调和客户端刷新。`canonical_entry_conflict` 表示相同 Entry ID 的表示不一致，需要独立检查 parent、type、timestamp、data 及生成顺序；归档或重开客户端不能替代这项检查。

### 已有证据与适用范围

- Codex app-server 0.160.1 的独立双客户端实验确认：订阅客户端能收到 `thread/reverted`，随后读取保留历史能得到回退后的 turns。
- 同版本源码中，`thread/revert` 关闭旧运行态、修改持久化历史并重新加载，同时保留订阅。回复中的 `turns` 为空，保留历史需另行 hydrate。这意味着再次卸载服务端运行态本身不能解决前端 transcript 的失效问题。
- TUI 的外部 `ThreadReverted` 通知不重建主 transcript；自身发起 rewind 时则另有本地截断流程。不能把自身回退的表现当作跨客户端通知的表现。
- 检查 Windows Codex 桌面版 `26.930.7945.0` 的 bundle：外部 archive 通知会移除 conversation、turn、流式缓冲和 resume 缓存；unarchive 恢复列表与元数据；重新打开 thread 进入正常 resume/hydration 流程。
- 用户已手测桌面“归档、撤销归档、重新打开”后正确显示回退历史。该结果验证当前桌面版本的可行性；完整 Orbis 自动刷新流程、TUI 自动重开及故障补偿尚未验证。

源码核对范围为 [Codex 仓库](https://github.com/openai/codex) 的 `codex-rs/app-server/src/request_processors/thread_processor.rs`、`codex-rs/tui/src/chatwidget/protocol.rs` 和 `codex-rs/tui/src/app/event_dispatch.rs`；API 语义参见 [App Server 文档](https://developers.openai.com/codex/app-server)。桌面缓存行为来自上述安装版本的 `handleThreadArchived`、conversation eviction 和 resume hook 检查，并非公开 API 对 GUI 刷新的长期保证。

## Decision

### 1. `/tree` 保持原地 revert 的语义

手机历史动作由 Codex Agent backend 将 Entry 换算成原生 turn 边界，再调用 `thread/revert`：

- 选择用户消息：`beforeTurnId` 为该消息所在 turn，删除这一轮及之后的历史，并将原文返回手机输入框供编辑重发。
- 选择助手回复：`beforeTurnId` 为该回复所在 turn 的下一轮，保留选中回复所在轮；没有下一轮时为 no-op，无需刷新客户端。
- 无法可靠确定 turn 边界时明确失败，不猜测、不按屏幕消息数量截断。

原生 thread ID、Orbis Session ID 和所属 backend 保持不变。桌面仍使用 `codex-desktop:<thread>` 命名空间；终端保持其原身份。回退不隐式 fork，不把桌面会话改接到终端 app-server。

这里回退的是对话历史，不承诺恢复已执行命令造成的文件或其他外部副作用。被回退的旧尾部可以继续留在 Session Tree Cache 中，但不能继续作为原生 thread 的当前历史。

### 2. 回退、历史重建、客户端刷新分别完成

Codex Agent backend 为一次操作分别记录原生回退结果、权威历史重建结果和客户端刷新结果。

1. 在 thread 空闲、没有排队工作或待处理审批时接受回退。按 thread 串行处理 Orbis 的回退与新 turn 请求，防止重复提交。
2. 原生回退成功后，分页读取 `thread/turns/list`（`itemsView: "full"`），重建保留历史及 Entry/turn 边界，并更新当前 leaf、能力菜单和手机视图。
3. 按对应客户端的生命周期执行刷新，使其重新加载保留历史。

回退期间使用视图代次隔离旧 sync 响应和旧回放，处理快照与通知的交叠。对正常恢复阶段的新通知保留缓冲；旧轮次迟到的 item 不得重新接到已回退的当前历史上。本地串行化不能阻止 GUI 或其他原生客户端并发操作；发现新的 turn、回退或手工归档时，重新核对权威状态并停止过期的后续动作，不自动中断用户的新工作。

若回退请求超时而提交结果未知，先核对权威历史，不盲目重发。回退成功后的历史读取或客户端刷新失败，都不把成功回退当作未发生，也不再次执行同一破坏性回退；恢复只重试尚未完成的阶段，并明确报告“历史已回退，刷新失败”或历史仍待确认。

### 3. 外部回退进入同一历史协调流程

Codex Agent backend 处理订阅中的 `thread/reverted`，使桌面/TUI 原生发起的回退也能更新手机的当前历史。

手机命令响应和自身收到的广播可能先后任意到达，必须归并到同一次协调操作，避免重复 revert、重复关窗或循环归档。通知只触发历史读取与视图协调，不转换成新的 `thread/revert` 请求。断线后重新订阅并读取权威历史，不能依赖重连后补发旧通知。

外部发起方可能已完成自己的本地截断，例如 TUI 自身 rewind；不因收到广播就自动重启该发起方。自动客户端刷新首先服务手机发起的回退；其他已确认陈旧的受管理客户端，只有在归属和空闲状态明确时才进入刷新流程。

### 4. TUI 通过受管理实例重开刷新

对可证明由 Orbis 管理、且仍对应目标 thread 的 TUI，采用“关闭对应 TUI、等待退出、以同一 thread 重新打开”的流程。重开使用原 Codex CLI、cwd、app-server endpoint 及适用的启动设置，通过 `codex resume <nativeThreadId> --remote <endpoint>` 加载回退后的历史。

必须有可信的启动登记和实例归属记录，并跟踪 TUI `/new`、`/resume` 后的实际 thread。仅凭进程名、命令行含某个 thread ID 或 endpoint 不足以授权关闭；用户自行运行的 `codex resume <id>` 仍是 ADR-0021 所述的 unmanaged invocation。恢复启动是已有受管理实例的延续，不扩展 shim 对参数化调用的接管范围。

关闭至重开期间保留手机的逻辑 Session 和恢复状态，防止 TUI watchdog 将预期退出当成永久离线并删除订阅。确认旧实例退出后才启动替代实例；重开失败允许单独重试。无法证明归属的 TUI 只协调手机历史，报告电脑端需要手动重开。

### 5. 桌面通过临时 archive/unarchive/open 刷新

桌面 backend 经 ADR-0022 的 wrapper 连接 GUI 使用的同一 app-server，执行专用的 thread 刷新流程：

1. 回退及历史重建成功后，调用 `thread/archive`，让 GUI 收到 archive 通知并清除该 thread 的内存状态。
2. archive 成功后调用 `thread/unarchive`，恢复 thread 的列表与元数据。
3. 通过 `codex://threads/<nativeThreadId>` 重新打开目标 thread；多 Host 场景使用已验证的桌面 `hostId` 路由，不能拿 Orbis Runtime ID 代替它。
4. backend 重新确认 loaded/resume、订阅与权威历史。unarchive 或协议链接发送成功本身不等于 GUI 已完成 hydration。

该流程允许 GUI 导航到被回退的 thread。它只管理 thread 生命周期，不关闭桌面应用、wrapper、app-server 或 Host；ADR-0022 的手机 `/quit` 仍只 detach 手机视图。不得复用带 worktree 清理等额外副作用的 GUI 归档动作，也不得把普通用户归档改成自动恢复。

archive 可能停止运行态、移动 rollout，并级联处理派生子 threads。执行前确认整个受影响 subtree 均空闲、无排队工作和待处理审批，包括原本已归档但后来被 collaboration 重新加载的子 thread。记录目标和子 threads 的原归档状态及可观察的 loaded/订阅状态；仅撤销本次刷新造成的变化，原本已归档的子 thread 保持归档。不能可靠确定影响范围、原状态或空闲条件时，不执行自动归档刷新。与用户手工归档并发且无法区分来源时，停止自动补偿并报告待确认状态，不能强行 unarchive。

在调用 archive 前持久记录 backend、原生 thread 身份、影响范围、原状态、本次刷新归属和操作阶段，使 Host 意外退出后仍可识别未完成流程。重连或启动时先核对权威状态，只恢复可证明由本次操作造成的归档或卸载变化，从未完成阶段继续且不再次 revert。记录损坏、归属证据不足或出现无法区分的用户并发操作时，保留当前状态并报告待确认；完成或明确终止后清理恢复记录。

临时 `thread/archived`、`thread/closed` 和 loaded-list 缺席进入刷新状态，不走当前永久下线/抑制发现路径。保留手机 Session 的关联，恢复后重新确认订阅；因 rollout 移动而缓存的路径必须失效并重新解析。

archive 先卸载运行态再提交持久归档，因此 archive 自身失败或超时也可能已经产生副作用。任何步骤失败或提交结果未知时，先核对实际归档、loaded 和订阅状态，再补偿本次造成的变化；恢复本 backend 的订阅和可确认的加载态，不重启用户任务或接管其他客户端。补偿也失败时明确报告仍被归档或卸载的 thread。重试从已知完成的步骤继续，不再次 revert，不重新归档已经恢复并开始工作的 thread。

### 6. 保留 canonical Entry 契约

本 ADR 补充 ADR-0013，不放宽其不可变节点规则：

- 回退更新原生 thread 的 active prefix/leaf 和当前视图，不以删除手机缓存的旧尾部来实现刷新。
- 保留节点的 ID、parent、type、timestamp、data 在实时完成、历史读取、回退重建及 Host 重启后必须一致。当前依赖旧内存恢复 parent 的做法不是持久稳定性的证明。
- 同 ID 不同表示仍报告冲突。`mode=replace`、archive/unarchive、重连和重开都不授予覆盖 canonical Entry 的权限；同步失败不清空整个 Session。
- 冲突修复需要定位表示差异并遵守 ADR-0013 的确定性映射与显式迁移约束。尚未证明一致时保留旧数据并报告错误，不宣称客户端刷新已修复冲突。

### 7. 按版本验证兼容方案

archive 通知驱动 GUI eviction 是当前桌面版本的兼容方案。Codex 升级后重新验证；无法确认兼容性时，保留回退与手机历史协调，明确报告电脑端需手动重开，不反复尝试归档。

如果上游 GUI/TUI 将来原生支持外部 `thread/reverted` 后重建 transcript，优先采用其原生流程，并在验证后更新本 ADR，移除相应的归档或进程重开补偿。

### 8. Codex 源端一致性是跨端同步的前置条件

ADR-0024 的 checkpoint、patch 和 running sync 只能复制 Codex adapter 已经确定的状态，不能修复源端历史重建的不确定性。因此实现顺序固定为：确定性 canonical 重建 → 每 thread 的协调代次 → 内部和外部 revert 统一入口 → checkpoint/patch → APP running sync。

#### 8.1 确定性 canonical 重建

`thread/turns/list`、resume、rollout 回放以及实时 item 汇合必须从同一份原生历史事实，按确定的 turn/item 顺序生成 Entry。不得从上一次 `ThreadState` 的 parent、顺序、接收时间或请求时间推断当前 Entry。

2026-10-09 实机确认 `thread/resume` 的历史视图会把部分消息 ID 合成为 `item-1/2/3`，而 `thread/turns/list(itemsView=full)` 为同一消息返回原生 UUID/message ID；同一工具 ID 因而可能接在两个不同父节点下。`thread/start/resume/fork` 响应只用于订阅、会话身份和设置，不能作为 canonical Entry 的来源。初次激活、自动接入和 fork 均须完成 full turns hydrate，再按当前协调代次处理缓冲通知；失败期间不能从通知猜测缺失的历史前缀。原生完整历史为空时保持空图，不用可能滞后的 rollout 复活已回退的尾部；旧格式仅在原生保留 turn 骨架无 items 时使用 rollout，且只接受保留 turn 范围内的记录。

对同一个原生 thread，重复读取、Host 重启、回退后重建必须得到相同的 `entryId`、`parentId`、`type`、`timestamp` 和 `data`。同 ID 的不同表示继续报告 `canonical_entry_conflict`，不能通过换 `sourceEpoch`、清空手机缓存或后到版本覆盖来绕过 ADR-0013 的不可变节点约束。

修正 parent/order 算法可能与 APP 已缓存的旧表示冲突。上线前必须选择一次性的 canonical schema/namespace 迁移，或在受控维护流程中重建受影响缓存；不能把旧表示静默转换成新表示，也不能让正常 sync 无限重试同一冲突。迁移完成后仍保留硬冲突检测。

本次选择 Android Session Tree Cache 的数据库版本 5 显式重建：升级时为已有 Session 登记候选，首次确认其 `agentKind=codex` 后，在同一 SQLite 事务中保存旧 Entry、timing、cursor、coverage 和旧格式记录，再清除该 Session 的活动图与游标。原数据保存在同库的迁移记录中，不改写旧 parent/order 来冒充原生事实。Pi/DSH 不执行重建；新建数据库没有候选；普通 conflict 不触发迁移。事务失败保留原图及待迁移标记，已完成标记使重启和重试幂等。APP 同时作废该 Session 的旧内存投影和在途分页，通过 preview 重新取得当前原生状态，并保留配对及待发送消息。后续同 ID 不同表示仍然硬失败。

本次原生 ID 来源修复使用数据库版本 6、格式 `codex-native-item-ids-v2` 再执行一次显式重建。迁移记录主键改为 `(session_id, canonical_format)`，保留 v5 已完成的旧格式原始归档；v5 中已缓存的临时 ID 和父节点关系另存为新格式迁移归档。直接从更早版本升级时，一次事务处理所有待迁移标记，之后不得因旧标记再次清掉已恢复的图。新库及升级后新建的 Session 无迁移候选，Pi/DSH、配对和待发送消息不受影响；失败或过时写入回滚归档、图、timing、游标和 coverage 一整批。

#### 8.2 每 thread 的协调代次和串行提交

每个 Codex thread 维护一个历史协调代次和阶段状态。`thread/revert` 成功后的 turns 读取、外部回退后的 hydrate、resume/attach 重建都必须绑定当前代次；新 revert、新 turn、原生历史变化或确认到的外部操作会使旧读取结果失效。

协调器只允许当前代次提交 `currentHead`、Entry 图和 live 状态。旧读取可以完成并被记录，但不能把旧 item 接回当前历史，也不能重新触发破坏性 revert。读取期间到达的新事件进入有界缓冲，提交后按原生 turn/item 身份重新核对；无法归属当前代次的事件丢弃并触发新的权威读取。

请求超时或结果未知时先核对原生历史，不盲目重发 `thread/revert`。历史读取失败、客户端刷新失败和回退提交失败分别记录，重试从未完成阶段继续，不把已经成功的回退再次执行。

#### 8.3 内部与外部回退使用同一个入口

手机发起的 revert 响应、订阅收到的 `thread/reverted`、resume 后发现的历史变化，都转换成同一种 `reconcile(reason, generation)` 请求。外部通知只触发权威历史读取，不转换成新的 `thread/revert`，也不单独维护第二套 replay 逻辑。

通知重复、响应先到、通知先到、断线后重新订阅和连续回退都必须归并到同一个当前代次。只有确认 thread 仍属于当前 backend、且新状态已经完成确定性重建后，才发布新的历史状态和客户端刷新动作。

#### 8.4 与 ADR-0024 的边界

本节负责让 Codex adapter 产生可信的 `currentHead`、canonical Entries 和可恢复 live 状态；ADR-0024 负责这些状态在 Host、Relay 和 APP 之间的版本化复制、checkpoint 恢复、丢包检测和历史分页隔离。两者之间的交界是 `sourceEpoch + seq + sourceReady`：adapter 未完成原生对账时只能发布 `sourceReady=false`，APP 必须原子进入 `restoring/unknown`，隔离上一 epoch 的 head/live/tools，不能继续显示旧 head 同时应用新 epoch patch。

## 实施拆分

1. 将 replay/history projection 提取为可重复测试的确定性构建步骤，并处理旧 canonical 表示的迁移边界（Issue #1）。
2. 引入 per-thread reconcile generation，统一保护 revert、resume、attach 和历史读取的异步提交（Issue #1）。
3. 将内部 revert、外部 `thread/reverted` 和重连后的权威核对接入同一协调器（Issue #1）。
4. 在源端协调完成后，为受管理的桌面 GUI/TUI 实例实现可恢复的刷新阶段和失败补偿（Issue #4）。
5. 为 Codex adapter 提供 ADR-0024 所需的 checkpoint、live inventory、`sourceReady` 和状态版本（Issue #2）。
6. APP 完成 epoch 隔离、checkpoint/patch reducer 后，才解除 running sync guard（Issue #3）。

第 1～4 项属于本 ADR 的 Codex 源端和客户端刷新；第 5～6 项属于 ADR-0024 的跨端恢复实现。第 1 项未完成前，不得以同步协议或换 epoch 掩盖 `canonical_entry_conflict`。

### 2026-10-09 Windows 桌面刷新接入

手机 `/tree` 原生回退和历史协调成功后，Windows 桌面 backend 已调用刷新协调器，执行专用 `thread/archive`、`thread/unarchive`、恢复本 backend 的 `thread/resume` 订阅及 `codex://threads/<id>?hostId=local` 重开。临时归档、关闭通知和 loaded-list 缺席受到保护，不移除手机的逻辑 Session；恢复时作废并重新取得 rollout 路径。回退结果与刷新失败分开报告，刷新恢复不会再次调用 `thread/revert`。最后一轮助手回复的 no-op、外部原生回退通知均不触发自动刷新。

包装器提供带随机凭据的回环控制端点，记录本次 archive/unarchive RPC 的 pending/applied/unknown 结果及 GUI 自身请求；Host 的 journal 在副作用前落盘。Host 重连复用同一个包装器实例的操作证据，恢复订阅或未完成阶段；结果未知时只查询，不重发 archive。包装器实例变化、用户并发归档/新 turn、来源版本变化时停止自动补偿并报告待人工确认。GUI 重新读取 history/items 的响应确已交付，才确认数据重新加载；这不是像素绘制证明，单独的 resume 或协议链接成功不算 GUI hydration。

GUI 重开时的 `thread/queue/list` 是只读查询，不属于用户并发操作，也不提供历史加载完成的证据；只有实际队列修改、turn 操作及归档等生命周期修改才能使本次刷新失效。2026-10-10 修复此前把所有 `thread/queue/*` 都判为修改操作、导致桌面已重开却向 APP 误报手动归档的问题。

首版自动刷新仅支持已经核对缓存清理和本地路由的 Windows 桌面版本 `26.930.7945`、`26.1002.7124`，且目标必须没有原生派生子 threads。兼容检查使用 GUI 的 `initialize.clientInfo.version`；2026-10-09 实机确认安装包 `26.1002.7124.0` 实际上报 `26.1002.52244`，不能用安装包版本号替代协议版本，否则已验证版本也会在 archive 前被拒绝。执行前及包装器提交前分别用显式全部 sourceKinds、ancestorThreadId 查询活动和归档子树；任何派生 thread、未知状态、排队工作、审批或不兼容版本均保留已完成回退并提示手动重开，不执行自动 archive。完整 subtree 补偿和 TUI 生产 driver 仍待实现，通用协调器及 journal 不代表它们已接入。

已通过真实 Codex CLI `0.162.0` 的隔离双客户端实验：本地测试 provider 生成两轮，回退后保留一轮，GUI 协议客户端接收 archive/unarchive、重新加载 paginated turns/items，恢复完成。该实验验证实际原生协议及 driver，不替代真实桌面 GUI 画面验收。已有运行中的旧包装器需关闭后重新打开 Codex 桌面版才加载新增控制端点；Host 也需更新后重启。

## Alternatives

- 只广播 `thread/reverted`：已验证广播可送达，但当前客户端主 transcript 不因此重建。
- 只 unsubscribe/resume 或重载 app-server：订阅归属和服务端运行态不等于 GUI/TUI 的内存画面；不保证 frontend hydration。
- fork 成新 thread：改变原地回退语义和 Session 身份，属于用户显式 `/fork` 的另一项操作。
- 重启整个桌面应用或 Host：影响其他会话；本问题有目标 thread 的刷新路径。
- 清缓存、忽略 parent 差异或后到版本覆盖：违背 ADR-0013，掩盖 canonical 表示不稳定。

## Consequences

原生历史、手机视图和电脑画面的完成状态变得明确，手机回退和桌面/TUI 回退共用历史协调规则。代价是桌面刷新会短暂改变归档与导航状态，终端刷新会打断对应 TUI 的界面，因此需要可靠的实例归属、通知归并和失败补偿。

本决定与 ADR-0013、0021、0022 没有不可调和的冲突；若实施扩大到关闭 unmanaged TUI、终止桌面进程、改变 `/quit` 或覆盖 canonical Entry，则超出本决定并违反现有边界。同步页大小及 running 状态的一般 sync 策略仍由 ADR-0024 负责。

## Verification（未来实施验收）

- 用户消息和助手回复边界准确；最后一轮回复为 no-op；原生 thread 和 Orbis Session 身份不变。
- 手机回退后，两端加载同一保留历史；桌面/TUI 原生回退后，手机也更新。确认通知收到与 transcript 刷新分别成立。
- 自身广播先于响应、重复通知、连续回退、迟到 item、分页读取交叠和 Host 重连时，不重复 revert，不把旧尾部接回当前历史。
- 保留节点在实时、重放和 Host 重启后的 canonical 表示完全一致；真实冲突仍被拒绝，旧尾部缓存保留且不成为当前 leaf。
- 在干净进程、Host 重启、重复 `thread/turns/list`、resume 和 revert 后，确定性重建产生字节级相同的 Entry 表示；旧 canonical 迁移或受控重建有明确结果。
- revert 读取期间插入新 turn、第二次 revert、重复/迟到 `thread/reverted` 和 Host 重连时，旧协调代次不能提交或复活历史。
- 桌面 archive/unarchive/open 任一步失败、结果未知及补偿失败均可恢复；Host 在各阶段意外退出后可核对未完成流程。子 thread 原归档/loaded 状态、正在工作或已归档但重新加载的 child、手工并发归档和 rollout 路径变化处理正确。
- TUI 仅关闭有可信归属的目标实例；切换 thread 后仍能准确识别；watchdog 不误下线；重开失败不影响其他终端。
- 操作与新 turn、排队任务、审批或外部手工操作竞争时不自动中断新工作；成功回退后的刷新重试不再次回退。
- 使用真实桌面 GUI 和 Windows TUI 验证历史加载与后续消息，而非仅断言 RPC 成功；升级 Codex 后重复相应兼容性验收。
