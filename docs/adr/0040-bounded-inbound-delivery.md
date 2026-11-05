# ADR-0040：有界入站投递与源端恢复

日期：2026-10-23

Status: accepted（2026-10-23 实现 §1–§7，全部在设备侧；线上协议、Host 与 Relay 均不改）

关联：[ADR-0005](0005-receiver-driven-range-download.md)、[ADR-0010](0010-write-layer-slicing.md)、[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0035](0035-incremental-session-reconcile.md) §15、[ADR-0037](0037-session-sync-transaction-contract.md)

## Context

2026-10-23 在真机（Redmi 2407FRK8EC，Android 16，`com.orbising.orbis`）上复现并量化了「会话用起来很卡」：

- 堆转储（`am dumpheap`，转换后 91MB）里 **5,238 个 `InboundFrameLanes$InteractiveFrame` 同时存活**，payload 合计 **22,056,150 字符**（UTF-16 约 42MB），占当时 62MB 存活堆的 68%；单帧最大 190,661 字符，4,505 帧超过 1KB。它们按 32 个一组挂在通道的 `Object[64]` 分段上，也就是**已入队、未被消费**。
- 同一天应用发生 5 次 `OutOfMemoryError`（16:53、18:44、18:58、19:02、19:05），堆上限 256MB；19:10:44 进程被 SIGKILL，退出时 PSS 1.2GB。
- 生产端：ADR-0035 §15 已在同一台设备上测到入站 **96 帧/秒**；该 ADR 给 Pi 扩展加了 100ms 合并窗口，但 **DSH 的运行时没有传 `coalesceMs`**，流式期间每个增量仍然是一条 `session.patch`。
- 消费端：单协程串行处理（`HostConnection.kt:1501`），每帧 `session.snapshot` 要做 SQLite 事务（探针 `persist_end` 20–52ms）再跑 reducer（`snapshot_applied` 30–86ms）。
- 队列没有上界：`InboundFrameLanes` 的 `interactive` 是 `Channel.UNLIMITED`（`InboundFrameLanes.kt:21`），生产者用 `trySend`（第 46 行），**永远不会失败**。

结论：接收侧没有任何内存上界。生产速率一旦高于消费速率，队列就单调增长到 OOM；ADR-0013 §5 只约束了 Host 侧的准入与预算，接收侧缺了对称的一半。

## Decision

### §1 按协议通道分类

入站按已认证的 hdr.ch 分类：ctl 承载控制与执行事实，msg 承载可恢复会话数据，bulk 承载按范围重读的文件分片。握手和配对使用控制面。

参考：[ADR-0010](0010-write-layer-slicing.md)。

### §2 每条面各自的「未取走」预算（帧数 + 载荷量），取走即归还

| 面 | 帧数上限 | 载荷上限 | 载荷计量 |
|---|---|---|---|
| `ctl` | 4,096 | 4,194,304 | `payload.length`（UTF-16 字符） |
| `msg` | 256 | 4,194,304 | `payload.length` |
| `bulk` | 64 | 16,777,216 | `ByteArray.size` |

`ctl` 的帧数上限在 2026-10-23 从 512 提到 4,096：DSH 会话的 `runtime.status` + `runtime.metadata`
每来一个原生事件就发一对，实测约 40 帧/秒，512 帧只够约 12 秒。一次大快照投影（`agent.state.snapshot`
700–900KB）就可能让消费侧停十几秒，把「消费慢」直接顶成「控制面溢出」。

预算只约束**本机内存**，与 Host/Relay 的准入、字节预算无关，也不改线上协议；出站调度与本机入站预算分别约束。

### §3 `msg` 溢出保留最新内容

msg 溢出时淘汰旧帧、保留新状态，记录本地背压并触发来源恢复。

### §4 丢弃后按源端恢复

消费者观察丢帧后，对当前可见会话发起既有范围同步；恢复按 3 秒限频合并。

### §5 `ctl` 溢出的可观察恢复

ctl 溢出遵守内存上界，记录 inbound.overflow 并对可见会话重新核对控制与交互事实；链路生命周期由 socket 与健康检查决定。

### §6 `bulk` 溢出丢最旧一片

bulk 分片按 runtimeId、transferId 和 offset 寻址，由接收方范围调度器恢复缺失分片。

### §7 既有协议与验证

本机入站预算作用于已解密、重组后的应用载荷，保持既有协议、E2E、出站准入与路由职责。

## Consequences

- Java 堆里入站帧的上界从「无界」变成约 26MiB 原始载荷（文本按 UTF-16 计入字符串时约 2 倍）；5,238 帧/42MB 的形态不可能再出现。
- 丢帧后最多 3 秒的显示落后，之后由一次源端同步补齐；`knownState`/`applied` 语义不变（ADR-0037 §4）。
- `msg` 里非会话面的响应（`agent.state` 非 execution 页、诊断页）也可能被丢；它们本来就有请求超时与手动刷新，最坏是状态页短暂显示「没有回音」，不是错误。
- `ctl` 溢出不再断链：丢最旧 + 记日志 + 3 秒内补一次源端同步。可见性是日志与重同步，不是「断开重连」。
- 2026-10-23 起 `ctl` 帧数预算 4,096：按 DSH 实测约 40 帧/秒的控制帧率，它容忍约 100 秒的消费停顿，载荷预算仍是内存的硬上界。
- 队列预算与 Host 的 6MB/8 槽预算相互独立；接收侧先到上限时表现为丢帧 + 重同步，而不是进程退出。

## Verification

[测试规则](../../AGENTS.md#测试)；[InboundFrameLanesTest.kt](../../android/app/src/test/java/com/orbising/orbis/InboundFrameLanesTest.kt)；[原始证据](../../.artifacts/)。
