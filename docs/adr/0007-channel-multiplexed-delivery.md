# 出站投递顺序按逻辑 channel 调度

**Status:** accepted

补齐 [ADR-0005](./0005-receiver-driven-range-download.md) 列出的第三个结构性错配（「下载与交互共用一条通道」）。ADR-0005 把**在途量**交给了接收方，但没有解决**同一条 socket 上的投递顺序**——它当时靠「交互让路把窗口压到 1 chunk」间接缓解，控制帧仍然排在那一个分片后面。票 07 加的 `hdr.ch` 只隔离了**序号流**，也不解决它。

## Context

WebSocket 是**单条有序字节流**：后写进去的帧不可能超过先写进去的，`hdr.ch` 写在信封里也改不了这件事。所以「下载一开，所有控制字都不响应」的根因不在序号，在于**分片已经进了 socket**：

- Host 出站 `PathSink` 是即发即忘的 `socket.send`，没有队列、没有背压、没有优先级。
- Relay 转发 `v2.frame` 时同样不看 `bufferedAmount`；二进制分片帧（`artifactChunkFrame`）走 `sendBinary`，护栏是 64 MiB 的 socket 积压——**比任何水位数都大四个数量级**，等于没有。
- Android 入站只有一条 `Channel.UNLIMITED`，文本与分片按到达顺序消费，消费循环被分片占住就刷不了界面。

三处都在同一条字节流上排队，谁也不知道 `ch` 是什么。

## Decision

**把等待队列从 socket 搬到应用层，只让 `bulk` 排队。**

- `OutboundChannelMux`（`@pi-remote/protocol`，传输无关）：`ctl` 绕过水位直接交付；`bulk` 只在 `backlog()`（`ws.bufferedAmount` / `RTCDataChannel.bufferedAmount()`）低于水位（64 KiB）时交付；`msg` 给 1 MiB 水位（会话快照是交互流量，不该被分片饿死）。宿主的每一条路径、Relay 的每一个连接各持一个。
- **水位是延迟预算，不是吞吐旋钮**：写进 socket 的分片收不回来，所以一条控制帧前面最多只剩「水位 + 正在写的那一帧」。吞吐由重试节拍（`pumpIntervalMs`）决定，调高水位换不来吞吐，只会让控制帧多等。
- **绝不丢已封好的信封**：丢一个已封好的信封会推进发送序号却到不了对端，接收侧判 `sequence_gap`，**整条会话报废**。要丢就在**封帧之前**丢——Host 的 `sendBinary` 先问 `hasBulkRoom()`；Relay 对 `v2.frame` 一律不丢，队列超上限退化成「照发」（等价于升级前），只报警一次并打日志。
- **二进制分片帧与文本信封共用同一条队列**：它们本来就共用同一个 socket，分成两条队列优先级就形同虚设。分片帧靠 `(runtimeId, transferId, offset)` 寻址 + 端到端 ack 重传，**没有发送序号，所以丢一帧会自愈**——Relay 对它的处理是「队列排不下就丢这一帧」，护栏判据取「`bulkQueuedBytes` + `socket.bufferedAmount` 合计」，上限沿用原 `maxBinaryBufferedBytes`：中继愿意持有的字节数一字未改，变的只是这些字节待在队列里而不是 socket 里，socket 因此保持排空。
- **协商**：HS1 声明 `channels` 才按 channel 调度，未声明一律当 `ctl`（老对端逐字节不变）。
- **接收侧**：Android `InboundFrameLanes` 两条优先级队列，消费循环每次回头先清空交互面再取一个分片——同样的延迟理由，网络再快也挡不住消费侧自己堵住自己。

## Consequences

### Positive

- 控制帧的等待上界从「链路里积压的几十兆」变成「64 KiB + 一帧」，与下载大小无关。
- `bulk` 等待队列因此可以**有界**（内存护栏），而它不再是链路缓冲的替代品：正常在途量由传输自己的窗口兜住（手机 pull 窗口 4 MiB / 推送 ack 窗口 16 片），所以护栏不该被撞到——撞到就是「有一方在无限灌分片」，`onBulkOverflow` / `relay.bulk.overflow` 是唯一能看见它的地方。
- Relay 的 64 MiB 二进制积压不再意味着控制面停摆，`sendBinary` 的「丢帧不断连」语义保留。

### Trade-offs

- 应用层队列就是「内存变成链路的缓冲」——这正是 `cdc1d80` 翻过车的地方。所以队列必须**有界**且**远大于**传输窗口（缺省 64 MiB；原推导 `ARTIFACT_WINDOW_SIZE * ARTIFACT_CHUNK_BYTES * 4` 里的 `ARTIFACT_WINDOW_SIZE` 已在 [ADR-0009](./0009-remove-computer-to-phone-push.md) 中删除，今天唯一的传输窗口是设备侧 pull 窗口的 1–8 MiB），否则水位一堵就从「延迟重排」变成「系统性丢片」。
- `bulk` 的交付节拍由重试定时器决定（缺省 10 ms，`unref()` 过）；定时器只在队列有货且被水位挡住时才存在，否则每个连接平白多个定时器。
- Relay 不再把分片一把灌进 socket，而是按水位节流交付：链路吞吐不变（保持排空），但 Relay 进程持有的未发字节数上界由「socket 缓冲」变成了「队列上限」。
- 旧明文二进制路径（`transferRoutes`，ADR-0005 Trade-offs 里记的未清理项）现在也走这条队列；它没有序号，因此可丢，这与信封的规则不同，改动这里时必须先分清两类帧。**（该路径已在 [ADR-0009](./0009-remove-computer-to-phone-push.md) 中整条删除：队列里现在只有 JSON 信封一类帧，不再需要区分。）**

## Verification

- `OutboundChannelMux` 单测：`ctl` 越过被水位压住的 `bulk`；`bulk` 留在队列且 FIFO；两条通道的水位**各自独立**（**原写「`msg` 水位更宽」，其缺省值已按 [ADR-0010](./0010-write-layer-slicing.md) 收到与 `bulk` 相同**）；`hasBulkRoom()` 在队列满时拒绝、调用方据此在**封帧之前**丢片；默认不丢已封帧（超上限只告警一次）；`stop()` 后不收帧；`pumpIntervalMs` 非法值退回默认节拍（`NaN` 会被 `setTimeout` 当成 1 ms 空转）。
- Host `DeviceLink` 端到端：慢设备下控制帧越过已排队的 `bulk` 当场出去；队列满时 `sendBinary` 返回 `false` 而不是封了再丢。
- Android `InboundFrameLanes` 单测：交互面优先、分类只看 channel 不看载荷形态。
- 写入层切片（[ADR-0010](./0010-write-layer-slicing.md)）：水位只有在「一次写出的字节数」远小于它时
  才是节拍器。片层把一件压到 8 KiB，`device-link.test.ts` 里那条量化用例钉住「一次写出 < 9 KiB、
  控制帧前面 ≤ 水位 + 一件」——这是下面那条实测的算术前提。
- 待真机实测（票 07 未打勾项）：88 MB 下载期间 `ctl` / `msg` 的 P95 延迟不超过空闲基线的 2 倍——与 ADR-0005 的同一指标共测。**（该判据的写法已被 [ADR-0010](./0010-write-layer-slicing.md) 更正为绝对上界 `(水位 + 一件) / 带宽`：下载本来就在占满链路，控制帧必须与已交给 socket 的字节共用同一条管道，1 Mbit/s 下 532 ms 对空闲基线 ≈0.5 ms 是 1000 倍，永远不可能 ≤2×。）**
