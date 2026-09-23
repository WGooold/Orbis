# 手机请求型下载改为接收方驱动的范围请求

**Status:** accepted

取代 [ADR-0002](./0002-open-command-and-file-download.md) 中「16 帧滑动窗口 + 累计 `receivedOffset` ACK」所描述的**手机请求型下载**传输机制。ADR-0002 的权限边界（设备凭据 = Pi 命令调用权 + runtime 账户文件读取权）与 Pi 主动推送（`artifact.push.*`）**不变**。

## Context

原机制是「发送方推 + 累积 ACK」：Host 一次灌 16 个 1 MiB 分片（`ARTIFACT_WINDOW_SIZE = 16`），设备把**连续落盘前缀**作为 `artifact.ack` 回给 Host；Host 等不到 ack 就**重发整窗**。

三个结构性错配：

1. **定速的人不持有 durable 状态。** `.part` 的长度、设备的磁盘速度、内存余量都只有设备知道，但「一次发多少」由 Host 决定。
2. **ACK 超时重发整窗。** 实际丢的常常是一个 1 MiB 分片（中继背压丢帧、路径抖动），代价却是重发 16 MiB，进一步顶高中继缓冲。
3. **下载与交互共用一条通道。** 16 MiB 突发把几百字节的 `session.sync` 响应堵在后面（队头阻塞），中继背压还会把整条设备连接关掉。现场表现是「下载一开，聊天记录一直不刷新」。

根因是驱动权放错了位置：进度事实（`.part` 长度）在接收方，限速却不归接收方。

另一个事实决定了协议形态：下载分片虽然经由 Relay，但内容是端到端加密的 `v2.frame`，Relay 只按 `hdr.to` 路由、不解析内容。所以新增控制消息不需要 Relay 改动。

## Decision

手机请求型下载改为**接收方驱动的范围请求（pull-range）+ 流水线**：

- **协商**：下载命令带可选 `mode`（缺省 `stream`）。Host 在 `artifact.started` 回 `mode:"pull"` 才表示按范围应答；缺失即回退到旧的收流 + ACK。设备只在看到 `mode:"pull"` 时进入 pull 状态机。
- **协议**：设备发 `artifact.read { transferId, requestId, offset, length }`（长度 ≤ 1 chunk），Host 只按范围读盘回一个既有格式的分片帧；读不了回 `artifact.read.failed`。设备完成并校验 sha256 后发 `artifact.done`，Host 据此释放上下文。取消复用既有 `artifact.cancel` 命令。**pull 路径上没有 `artifact.ack`，Host 也不发 `artifact.finished`**——完成判定在接收方。
- **发送方无状态**：Host 侧每条传输只保留 `{deviceId, artifact, path, cancelled}`，没有窗口、没有 ack、没有重试计数；同一 `read` 幂等重读重发。
- **接收方调度**（`PullScheduler`）：进度唯一权威是 `durableOffset`（`.part` 连续前缀）；`highestIssued - durableOffset ≤ window` 恒成立；超时**只重请求丢失的那一个 chunk**；窗口用 AIMD 调整并由实测 BDP 定增长上限；有交互流量在途时把窗口压到 1 chunk（交互让路）。
- **回程路径固定**：一次 `read` 的响应在收到该请求的那条路径上发完，跨路径不拆开一次响应。
- **推送不动**：`artifact.push.*` 与 Relay 的持久化推送保持原样。**（该推送已在 [ADR-0009](./0009-remove-computer-to-phone-push.md) 中整条删除。）**

## Consequences

### Positive

- 在途字节由设备决定且有界（默认 4 MiB、上限 8 MiB），天然小于 Relay 的 64 MiB 背压阈值，基本不再触发背压断连。
- 丢包只补 1 MiB，不再有「整窗 16 MiB 重发」的放大。
- 断线/换路径/进程重启后的续传是无状态的：`read(offset = .part 长度)`。
- 设备可主动暂停发放新请求给交互流量让路——这是 push 模型做不到的，也是「下载一开聊天不刷新」的根治手段。
- Host 的下载实现从「窗口状态机」退化成「按范围读盘」。

### Trade-offs

- 协议消息变多、更碎（每 chunk 一个 `read`，约 150 字节 / 1 MiB，可忽略），且控制逻辑从发送方搬到接收方。
- 调度器（窗口/RTO/乱序/重传）成为接收方必须正确实现的组件；它现在是纯逻辑 + 注入时钟的深模块，由单测覆盖。
- 引入了回退矩阵（旧设备×新 Host、新设备×旧 Host），必须两组都保真。
- 中继侧的 `transferRoutes` / 原始二进制分片路径对本机制不参与（分片是 E2E `v2.frame`），但仍是旧明文 runtime 路径的一部分，未清理。**（该路径已在 [ADR-0009](./0009-remove-computer-to-phone-push.md) 中随主动推送整条删除——中继现在只搬 JSON 帧，这条「未清理项」已不存在。）**

## Verification

- `PullScheduler` 注入时钟单测：窗口有界、只补洞、乱序不重复请求、AIMD 收缩与增长、交互让路、完成判定。
- Host 端到端（真 Relay + 真 Host + 假设备）：只请求 `[2,6)` 就只回该段；越界回 `read.failed`；`done` 后同 transferId 的 `read` 不再回帧。
- Reducer 单测：`artifact.started` 带 `mode:"pull"` 进入 pull，缺失时 `transferMode == null` 回退；`artifact.read.failed` 按 transferId 标失败。
- 指标（待 ticket 04 实测）：88 MB 下完并校验 sha256；期间 `session.sync` P95 不超过空闲基线的 2 倍；中继 `bufferedAmount` 峰值 < 16 MiB；丢一片时重传字节 ≈ 1 MiB。**（其中「P95 ≤ 空闲基线 2 倍」已被 [ADR-0010](./0010-write-layer-slicing.md) 更正为绝对上界 `(水位 + 一件) / 带宽`——下载本来就在占满链路，控制帧必须与已交给 socket 的字节共用同一条管道，相对空闲基线的倍数没有上界。）**
