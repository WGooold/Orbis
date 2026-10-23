# ADR-0040：入站投递有界——会话面可丢，控制面不丢

日期：2026-10-23

Status: accepted（2026-10-23 实现 §1–§7，全部在设备侧；线上协议、Host 与 Relay 均不改）

关联：[ADR-0005](0005-receiver-driven-range-download.md)、[ADR-0007](0007-channel-multiplexed-delivery.md)、[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0035](0035-incremental-session-reconcile.md) §15、[ADR-0036](0036-sync-backpressure-is-not-failure.md)、[ADR-0037](0037-session-sync-transaction-contract.md)

## Context

2026-10-23 在真机（Redmi 2407FRK8EC，Android 16，`com.orbising.orbis`）上复现并量化了「会话用起来很卡」：

- 堆转储（`am dumpheap`，转换后 91MB）里 **5,238 个 `InboundFrameLanes$InteractiveFrame` 同时存活**，payload 合计 **22,056,150 字符**（UTF-16 约 42MB），占当时 62MB 存活堆的 68%；单帧最大 190,661 字符，4,505 帧超过 1KB。它们按 32 个一组挂在通道的 `Object[64]` 分段上，也就是**已入队、未被消费**。
- 同一天应用发生 5 次 `OutOfMemoryError`（16:53、18:44、18:58、19:02、19:05），堆上限 256MB；19:10:44 进程被 SIGKILL，退出时 PSS 1.2GB。
- 生产端：ADR-0035 §15 已在同一台设备上测到入站 **96 帧/秒**；该 ADR 给 Pi 扩展加了 100ms 合并窗口，但 **DSH 的运行时没有传 `coalesceMs`**，流式期间每个增量仍然是一条 `session.patch`。
- 消费端：单协程串行处理（`HostConnection.kt:1501`），每帧 `session.snapshot` 要做 SQLite 事务（探针 `persist_end` 20–52ms）再跑 reducer（`snapshot_applied` 30–86ms）。
- 队列没有上界：`InboundFrameLanes` 的 `interactive` 是 `Channel.UNLIMITED`（`InboundFrameLanes.kt:21`），生产者用 `trySend`（第 46 行），**永远不会失败**。

结论：接收侧没有任何内存上界。生产速率一旦高于消费速率，队列就单调增长到 OOM；ADR-0013 §5 只约束了 Host 侧的准入与预算，接收侧缺了对称的一半。

## Decision

### §1 分类只看协议字段 `hdr.ch`，不看载荷形态

职责沿用 [ADR-0007](0007-channel-multiplexed-delivery.md) 的定义：

- `ctl`：状态、命令结果、交互请求、`agent.state` 的 execution 快照。延迟敏感，**不可丢**。
- `msg`：`session.*` / `message.*` / `turn.*` / `tool.*` 事件、会话目录、非 execution 的 `agent.state` 页、诊断页。体量大，**可丢、可由同步修复**。
- `bulk`：artifact 分片，按偏移幂等，**可丢、由 pull 重传修复**。

没有 `ch` 的老对端按 `ctl`（与 ADR-0007 的协商规则一致）。

### §2 每条面各自的「未取走」预算（帧数 + 载荷量），取走即归还

| 面 | 帧数上限 | 载荷上限 | 载荷计量 |
|---|---|---|---|
| `ctl` | 4,096 | 4,194,304 | `payload.length`（UTF-16 字符） |
| `msg` | 256 | 4,194,304 | `payload.length` |
| `bulk` | 64 | 16,777,216 | `ByteArray.size` |

`ctl` 的帧数上限在 2026-10-23 从 512 提到 4,096：DSH 会话的 `runtime.status` + `runtime.metadata`
每来一个原生事件就发一对，实测约 40 帧/秒，512 帧只够约 12 秒。一次大快照投影（`agent.state.snapshot`
700–900KB）就可能让消费侧停十几秒，把「消费慢」直接顶成「控制面溢出」。

预算只约束**本机内存**，与 Host/Relay 的准入、字节预算无关，也不改线上协议（ADR-0007 §「接收侧」只规定了优先级，没有规定上界）。

### §3 `msg` 溢出丢最旧，保留最新；丢弃不是失败

- 溢出时从队首丢到能放下新帧为止，新帧总是入队：被丢的是最陈旧的状态，最新状态优先。
- 丢帧只累计本地计数并打日志，**不得写 `error`、不得写 `sessionSyncFailures`**。这与 ADR-0036 §1 同向：这是背压，不是故障。

### §4 丢弃必须触发一次可见会话的源端重同步

丢帧意味着 `source.seq` 上出现不可见的洞。消费者每轮检查丢帧计数；有丢弃时：

1. 把当前选中的 runtime 重新挂进 `sessionSyncRequests`；
2. 触发一次 `scheduleSessionGraphLoad`，走既有的 catchup/preview 路径（`knownState` 落后时 Host 会回增量或快照，ADR-0026/0037）；
3. 限频 **3 秒**：丢帧风暴不能变成重同步风暴（ADR-0036 Context 约束 1）。

必须主动补一次的原因与 ADR-0036 Context 约束 2 相同：会话安静下来后没有新事件来要同步，不补就永久停在旧快照。

### §5 `ctl` 溢出不静默丢

`ctl` 承载命令结果与交互请求，丢了不能靠 `msg` 面的增量补回来。溢出时仍然丢最旧（内存上界优先）并记录
`inbound.overflow lane=ctl`；消费者按 §4 的同一恢复动作处理：对可见会话补一次源端同步（限频 3 秒）。
Host 的 `session.sync` 响应里带 `interaction.snapshot` 与会话状态，重同步能把这些事实重建出来。

**不再因此断开连接**（2026-10-23 修订）。真机实测：打开 DSH 会话 12 秒后就出现
`inbound.overflow lane=ctl dropped=6`，紧接着 `p2p.ice CLOSED` / `p2p.closed`——一次背压被升级成整条链路中断，
重连后又要从头同步，形成「打开会话 → 断开 → 重连 → 再断开」的循环。内存上界由 §2 的帧数与载荷预算兜住，
控制面丢失的可见性由 `inbound.overflow` 日志与重同步保证；真正断开的判定留给 socket 失败与健康检查。

### §6 `bulk` 溢出丢最旧一片

分片按 `(runtimeId, transferId, offset)` 寻址、由接收方 pull 调度器按 RTO 重传（ADR-0005）。丢一片的代价是一次重传，不需要额外动作。

### §7 不改的东西

- 不改线上协议字段、序号语义与 AEAD 构造；丢的是**已经解密、已经重组完成**的应用层载荷，不碰 `v2.frame` 序号流。
- 不改 Host 的准入与预算（ADR-0013 §5 继续有效），也不改 Relay 的转发职责。
- 不把「提高同步超时上限」当成修复。

## Consequences

- Java 堆里入站帧的上界从「无界」变成约 26MiB 原始载荷（文本按 UTF-16 计入字符串时约 2 倍）；5,238 帧/42MB 的形态不可能再出现。
- 丢帧后最多 3 秒的显示落后，之后由一次源端同步补齐；`knownState`/`applied` 语义不变（ADR-0037 §4）。
- `msg` 里非会话面的响应（`agent.state` 非 execution 页、诊断页）也可能被丢；它们本来就有请求超时与手动刷新，最坏是状态页短暂显示「没有回音」，不是错误。
- `ctl` 溢出不再断链：丢最旧 + 记日志 + 3 秒内补一次源端同步。可见性是日志与重同步，不是「断开重连」。
- 2026-10-23 起 `ctl` 帧数预算 4,096：按 DSH 实测约 40 帧/秒的控制帧率，它容忍约 100 秒的消费停顿，载荷预算仍是内存的硬上界。
- 队列预算与 Host 的 6MB/8 槽预算相互独立；接收侧先到上限时表现为丢帧 + 重同步，而不是进程退出。

## Verification

- 单测（`InboundFrameLanesTest`）：分类只看 channel；`msg` 超预算丢最旧且最新帧仍在；`ctl` 超预算记录丢帧且不进入失败字段；`bulk` 超预算丢片；关闭后 `offer` 返回 false 且不增长；丢帧计数只被消费一次。
- 设备：长会话流式输出 10 分钟不 OOM；`dumpsys meminfo` 的 PSS 不再逼近 1GB；堆转储中 `InteractiveFrame` 数量不超过预算；`inbound.overflow` 出现后 3 秒内必有对应 runtime 的 `session.sync.send`。
