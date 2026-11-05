# 手机请求型下载改为接收方驱动的范围请求

**Status:** accepted

已配对设备可按电脑路径请求 Host / runtime 账户可读取的普通文件，不维护路径、类型或大小 capability allowlist。配对凭据因此包含文件读取权；配对认证、设备撤销、TLS 与操作系统账户隔离仍是权限边界。Host 就地读盘，Relay 只转发端到端密文，不持久化文件。手机完成 SHA-256 校验后才发布文件。

## Context

原机制是「发送方推 + 累积 ACK」：Host 一次灌 16 个 1 MiB 分片（`ARTIFACT_WINDOW_SIZE = 16`），设备把**连续落盘前缀**作为 `artifact.ack` 回给 Host；Host 等不到 ack 就**重发整窗**。

三个结构性错配：

1. **定速的人不持有 durable 状态。** `.part` 的长度、设备的磁盘速度、内存余量都只有设备知道，但「一次发多少」由 Host 决定。
2. **ACK 超时重发整窗。** 实际丢的常常是一个 1 MiB 分片（中继背压丢帧、路径抖动），代价却是重发 16 MiB，进一步顶高中继缓冲。
3. **下载与交互共用一条通道。** 16 MiB 突发把几百字节的 `session.sync` 响应堵在后面（队头阻塞），中继背压还会把整条设备连接关掉。现场表现是「下载一开，聊天记录一直不刷新」。

根因是驱动权放错了位置：进度事实（`.part` 长度）在接收方，限速却不归接收方。

另一个事实决定了协议形态：下载分片虽然经由 Relay，但内容是端到端加密的 `v2.frame`，Relay 只按 `hdr.to` 路由、不解析内容。所以新增控制消息不需要 Relay 改动。

## Decision

下载采用接收方驱动的范围请求与流水线，完成判定由接收方负责；协议演进遵循 [ADR-0064](0064-protocol-compatibility.md)。

- 设备以 `artifact.read { transferId, requestId, offset, length }` 请求一块数据；Host 读盘响应，失败返回 `artifact.read.failed`。
- 设备完成摘要校验后发送 `artifact.done`，取消使用 `artifact.cancel`；Host 据此释放传输上下文。
- Host 保存设备、文件和取消状态，并支持幂等范围读取；接收方以持久前缀管理窗口、超时重读与交互让路。
- 单次响应沿请求的入站路径完成。Relay 的加密路由边界见 [ADR-0009](0009-remove-computer-to-phone-push.md)。

`PullScheduler` 的窗口满足 `highestIssued - durableOffset ≤ window`，采用 AIMD 和实测 BDP 调整；存在交互流量时使用单块窗口。

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
- 接收方调度器与持久化须保持一致，协议 18 起的旧端互通按 ADR-0064 验证。
- Relay 只路由 E2E 信封，不参与范围选择、落盘或完成判定。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。
