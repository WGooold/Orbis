# ADR-0036：同步准入的背压不是失败——preview 有界重试，历史页保持可见失败

日期：2026-10-22

Status: accepted（2026-10-22 实现 §1–§6、§8，全部在设备侧；§7 是**被否决**的方案，保留原因备查。§8 是**过渡措施**，正式契约见 [ADR-0037](0037-session-sync-transaction-contract.md)）

关联：[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0026](0026-host-selected-session-sync.md)、ADR-0035（待重建）、[ADR-0037](0037-session-sync-transaction-contract.md)

2026-10-22 补充：按 [ADR-0037](0037-session-sync-transaction-contract.md) 的前提，一次 `session.sync` 是跨设备、Host、后端的分布式事务。本文记录的是**协调侧契约落地之前**在设备侧能做的过渡实现：把背压从"失败"里区分出来、让失败标记过期。它不构成契约，§8 的冷却只是兜底。

## Context

现象：Host 一直回 `sync_busy`；最新的消息不再进 APP，运行状态也迟迟加载不出来；**必须重开 APP 才恢复**。

### Host 的准入拒绝（是背压，不是故障）

- `packages/host/src/session-sync-tasks.ts`：每台设备最多 8 个未完成任务（`MAX_PENDING`），超过就 `error(..., "session_sync_busy")`；发送阶段失败回 `session_sync_busy_or_unavailable`。
- `packages/host/src/device-link.ts`：同步快照投递同时最多 8 个槽、字节预算 6MB（`SESSION_SYNC_WIRE_LIMIT_BYTES`），超了直接返回 `false`。
- 这些限制本身是对的：链路只能搬这么多，拒绝比无界排队好（ADR-0035 §9 的背压回收路径依赖它）。

### 设备把它当成了终态故障

- `failSessionSync` 把失败写进 `sessionSyncFailures`。
- `advanceSessionSyncTasks`：`if (task.runtimeId in next.sessionSyncFailures && task.range == "preview") continue`；`queueSessionSync`：`runtimeId in sessionSyncFailures` 直接拒绝。
- 清空点只有三处：用户手动重试（`retrySessionSync`）、切会话/整表重置、重连。

于是：一次队列拥塞 → 该 runtime 的 preview 永久停摆 → "最新消息一直更新不了，必须重开 App"。历史分页的背压则写进 `sessionRangeFailures`，把那个范围钉死。

### 改这个判定必须同时满足两个互相拉扯的约束

1. 需求集合是**按入站消息速率**消费的（`HostConnection` 里每条消息归约后就 `mapNotNull(...)` → `scheduleSessionGraphLoad`），而派发前只检查"该 runtime 没有在飞命令"。所以**"忙就把需求挂回去"= 重试风暴**：流式输出时约 10 次/秒的空请求，全部打在本来已经堵死的链路上。
2. 反过来**"忙就把需求撤掉"= 永久停更**：`sessionSyncRequests` 只在状态变化、回合事件、快照收尾时被加回；会话一安静就再没有任何事件来要同步，画面停在旧快照——和原来的症状一样，只是从"失败"变成"等待"。

这两条是同一处状态的两个方向，任何只做一半的实现都会踩到其中一个，所以写进 ADR 固定下来。

### 真正的问题是"卡住就永远卡住"：设备侧没有任何东西会过期

在这个分布式事务里，终态由 Host 宣布、确认由设备回执；两者都缺失时，设备只剩本地超时一条路，而本地超时又会写成会话级状态。设备侧因此有三处**没有过期机制**的地方，任意一处触发都让这个会话永久停更：

1. **失败闸门没有过期**：`sessionSyncFailures` 只在"同步成功 / 手动重试 / 切会话 / 重连"时被清。而卡死的时候**永远等不到成功**，用户也未必知道要去点重试——于是自锁。写进这个集合的不只是背压：150s 同步超时（`EXHAUST_AFTER_MS` → `failSessionSync`）、`session_sync_backend_failed`、`session_sync_response_too_large`、`session_sync_model_rejected`、`session_sync_expired`、`session_sync_retry_exhausted` 全部走这条路。**这才是"必须重开 App"的根**，不是任何一个具体错误码。
2. **Host 的在飞任务没有死线**：`processing`/`sending` 只有收到快照或失败结果才结束，否则一直占着 `MAX_ACTIVE` 的一个名额和 1MB 预留，直到 `RETAIN_MS = 300s` 过期。两个静默任务就能让这台设备的后续 sync 全部排不上。
3. **设备重试复用同一个 commandId**：重发时用的还是原 `id`。Host 对同一 commandId 在飞/已投递时是**静默返回**，已失败时回 `session_sync_retry_exhausted`。静默返回意味着设备只能等到超时，再落回第 1 条。

### 历史成因（两次方向相反的故障）

- 2026-09-21 之前：APP 等 8 秒即放弃并换新 ID 重请求，Host 不取消已排队响应 → 重复整图、GB 级队列（ADR-0013 Context）。
- ADR-0013 的处置：给每次同步稳定身份、重试复用同一 ID、Host 只回请求设备、队列设上界。它解决了"放弃太早"，但把"重复请求"设计成**静默去重**（终态不送达的来源）。
- 2026-09-23 起：为阻止失败后随事件重复请求，引入 `sessionSyncFailures` 作为闸门；后来该闸门接入 preview 调度 → 反向故障。

两次都不是事务模型错误，而是**事务不完整**：作废判定、终态送达、接收确认缺失，加上把一次失败写成了会话级状态。

## Decision

### §1 背压不进入失败集合

`session_sync_busy`、`session_sync_busy_or_unavailable`、`session_sync_path_unavailable` 归类为**背压**：不得写入 `sessionSyncFailures`，不得写入 `sessionRangeFailures`，不得弹错误横幅。判定只认协议 `code`（`isTransientSessionSyncFailure`），不认中文文案或 `message` 文本。

仍然终态、不得当成背压的：`session_sync_id_conflict`、`session_sync_retry_exhausted`、响应目标不匹配、SQLite 持久化失败、`reduce` 失败。误判方向必须是"多重试一次"，不能是"把真故障悄悄吞掉"。

### §2 瞬时语义只给 preview

`failSessionSync` 的 `transient` 分支只在 `range == "preview"` 生效。

历史分页是用户动作：失败必须立刻可见、可重试。第一版实现把历史页背压也按"被取代"静默收尾，结果是快速滑动时那一页**永远不加载、界面什么都不显示**——这比可见的错误更糟。

### §3 重试必须有界

`MAX_SYNC_BUSY_RETRIES = 3`。背压时撤掉本次请求，只有 `streak <= 3` 且该 runtime `sessionGraphSync` 才把需求挂回去；超过就不再挂。

上限的依据就是 Context 约束 1：需求消费频率等于入站消息频率，无界重挂不叫"重试"，叫自制风暴。

### §4 撤掉需求后必须由时钟侧复活

`runSessionSyncScheduler` 的 1 秒 tick 末尾：对 `sessionSyncBusyStreaks >= MAX_SYNC_BUSY_RETRIES` 的 runtime，每 `SYNC_BUSY_REVIVE_MS = 5000` 重新驱动一次 `scheduleSessionGraphLoad`。

这是 Context 约束 2 的答案：**没有事件也不能永久停更**。5 秒一次空请求在已拥塞链路上是可忽略的量，而且成功一次就自动停止。

### §5 任何一次成功 ack 清零 streak

`command.result ok=true` 的会话同步分支里清掉该 runtime 的 `sessionSyncBusyStreaks`。

否则一次拥塞会长期压低该 runtime 的额度：链路恢复后仍只肯重试 3 次，下一次抖动就退化成 5 秒一轮。

### §6 不改变线上契约

§1–§6、§8 只在设备侧 reducer 状态 + 调度器。Host 的准入参数、协议字段、`seq`/baseline 语义都不动：背压仍由 Host 作为协调者决定，设备只是正确解释它。Host 侧"不再无限期沉默"属于 [ADR-0037](0037-session-sync-transaction-contract.md) §3，不在本文范围。

### §7 被否决：Host 在飞任务死线（记下为什么不做）

曾按 20s 死线实现过一版（`tick()` 里对 `processing`/`sending` 超时 `#fail(task, "session_sync_timeout")`），已撤回，原因：

1. **慢后端活锁**：真正的慢速 sync（DSH 大日志全量读、Host 在 GC 压力下）超过 20s 就被砍，重试又是同一份昂贵计算，结果是"慢但会成功"变成"永远不成功 + CPU 放大"。
2. **丢弃已完成的工作**：被砍任务的迟到快照在 `handleEvent` 里因为 `task.stage !== "processing"` 被消费掉，白算一遍。
3. **掩盖真因**：`session_sync_timeout` 会把"后端真的挂了"记成"超时"，诊断变难。
4. **它不必要**：Host 只有三个出口（快照 / 失败结果 / `RETAIN_MS` 过期）是代码事实，但**没有运行证据**证明线上真的出现过任务滞留 5 分钟——`[session.sync]` 日志只打到 Host 的 stdout，`diagnostics.ndjson` 里只有 recovery/transport 记录。仅靠代码路径推断不足以改行为。
5. 更关键：即使 Host 槽位被占满，只要 §8 生效，设备侧超时 → 冷却 → 重试，链路能自己回来。

要重启这个方案，先拿到现场：设备日志里 `session.sync.send ... sent=true` 之后没有对应的 `session.snapshot.received`（说明 Host 侧停滞），或 Host stdout 里 `[session.sync] ... elapsedMs=` 出现几十秒量级。

### §8 失败闸门必须会过期

`advanceSessionSyncTasks` 的每个调度节拍检查 `sessionSyncFailures`：连续 `SYNC_FAILURE_COOLDOWN_TICKS = 10` 个节拍（约 10s）后自动清除该运行时的失败标记，并把需求挂回去（`sessionSyncRequests`）。记录失败时把计数归零；全量重置（切会话/重连）处一起清空。

语义变化：`sessionSyncFailures` 从**闩锁**变成**冷却**。UI 上的 `chatSyncError` 仍然显示原因，下一次成功再清掉。

这条对本 ADR 最关键：它把"任何错误码导致永久停更"这个 bug 类一次性关掉，而不是逐个错误码打补丁。§1 的背压分类因此是"少一次无谓重试"的优化，不再是唯一防线。

注意：§8 是**过渡措施**，不是终局。它的副作用是确定性失败（如单条 Entry 超过 1MB）会被反复重试；按 [ADR-0037](0037-session-sync-transaction-contract.md) §5，失败应按类别存在尝试层，会话级字段只用于显示。

## Consequences

好处：

- 背压不再造成永久停更；安静会话最多落后 5 秒后自愈。
- 任何一次失败（超时、后端失败、超大、模型拒绝、过期、重试耗尽）最多让该会话停更约 10 秒，而不是直到重开 App。
- 重试风暴有硬上限：每次拥塞最多 3 次立即重试 + 5 秒一次复活。
- 真故障仍然按原样暴露。

代价：

- `RemoteState` 多一个 `sessionSyncBusyStreaks` 与冷却计数；全量重置处必须一起清空。
- 背压会清掉 `chatSyncError` 并让转圈停下，链路恢复后转圈再出现——视觉上会抖一次。
- 历史分页背压仍是可见失败（用户需再滑一次），这是 §2 的取舍。

残余风险：

- streak 未清零期间，每 5 秒一次空请求。
- 本 ADR 只解决"设备如何解释背压"。Host 侧是否需要给 preview 留出专用额度、是否按链路 RTT 自适应 `historyPageSize`，都还没做。

## 验证

- 单测（`RelayReducerTest`）：preview 背压不记失败且有界重试、超限后撤需求、历史页背压仍留可见失败、成功 ack 清零 streak、失败闸门在冷却后过期并重挂需求。
- 设备侧：`:app:testDebugUnitTest` 与 `:app:assembleDebug` 通过。
- 现场核对方式：Host 日志的 `session_sync_busy`；设备日志 `session.sync.send ... sent=`；两次复活间隔不超过 5 秒，且不出现 10 次/秒的密集请求。
