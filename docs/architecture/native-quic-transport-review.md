# 原生 QUIC：库能力与现有业务复核

日期：2026-11-04。对应 [ADR-0065](../adr/0065-native-quic-relay-transport.md) / R67。本文保留设计复核时的事实、约束和待办，表中“待实施”为当时状态；三流与双端切换后续已实施，当前验证与未通过门禁统一见 [实施 tickets](../agents/native-quic-tickets.md)，历史单流结果不转记为三流通过。

同日追加[历史传输 ADR 与故障约束](native-quic-transport-lessons.md)：区分仍有效规则与已替代方案，补充三层压力与 Q11–Q13。随后按用户要求收窄范围：以 [ADR-0065 §3、§7–§8](../adr/0065-native-quic-relay-transport.md) 的可互换 adapter、受控重连、既有业务契约和验收为准；不预设新增信用协议或端到端 epoch 格式。

## 1. 查证范围与来源

审阅固定依赖 `github.com/quic-go/quic-go v0.65.0`，不是凭较旧版本的 API 印象判断。Go 模块代理记录标签提交为 `aa265c3fc6489e3bfa8071b333be95e0e887a51d`、发布时间为 `2026-11-03T01:11:49Z`。官方标签的 `send_stream.go`、`framer.go`、`interface.go` 与本机模块缓存逐字节一致。

- [QUIC Streams](https://quic-go.net/docs/quic/streams/)：流类型、创建、优先级、关闭和 reset。
- [Flow Control](https://quic-go.net/docs/quic/flowcontrol/)：每流 / 每连接窗口、BDP、自适应与流数额度。
- [Congestion Control](https://quic-go.net/docs/quic/congestion-control/) 和 [Connection Migration](https://quic-go.net/docs/quic/connection-migration/)。
- 固定标签源码：[send_stream.go](https://github.com/quic-go/quic-go/blob/v0.65.0/send_stream.go)、[framer.go](https://github.com/quic-go/quic-go/blob/v0.65.0/framer.go)、[interface.go](https://github.com/quic-go/quic-go/blob/v0.65.0/interface.go)、[receive_stream.go](https://github.com/quic-go/quic-go/blob/v0.65.0/receive_stream.go)、[sent_packet_handler.go](https://github.com/quic-go/quic-go/blob/v0.65.0/internal/ackhandler/sent_packet_handler.go)。
- [RFC 9000 §2.3](https://www.rfc-editor.org/rfc/rfc9000.html#section-2.3)、[RFC 9218](https://www.rfc-editor.org/rfc/rfc9218.html)。
- Apple [WWDC21 / 10094](https://developer.apple.com/videos/play/wwdc2021/10094/) 15:08–17:22、[NWMultiplexGroup](https://developer.apple.com/documentation/network/nwmultiplexgroup)、[relativePriority](https://developer.apple.com/documentation/network/nwconnection/contentcontext/relativepriority)，并对照本机 Xcode 的 Network.swiftinterface。

本次网页原文、摘要和主要来源 SHA-256 保存在 `.artifacts/quic-review/`。浏览工具未返回可引用条目，改用 HTTPS 直接读取官方页面及标签源码；未把第三方文章作为 API 依据。

## 2. quic-go 确实有原生流优先级

`Stream.SetPriority(urgency, incremental)` / `SendStream.SetPriority` 调整**本端发送方向**的流调度。urgency 范围 0–7，越小越先；默认 `(3,true)`。同 urgency 的 incremental 流轮转，non-incremental 流按 stream ID 选择。`incremental` 不表示可靠性，不是权重，也不允许同一流内部插队。只有一条流时，调它的 priority 不能让后来写的 ctl 越过已有 bulk。

RFC 9000 没有规定线上优先级协商，建议实现接受应用提供的流优先级；quic-go 原生 API 使用 RFC 9218 的参数。Orbis 不需要为了使用这个 API 包一层 HTTP/3，也不能假设在 Go 服务端调用一次会改变 Apple 客户端的发送调度。

源码 `framer.AppendStreamFrames` 的顺序是：**先处理待重传的 STREAM 数据（内部按 urgency），再选择新的 STREAM 数据（按 urgency）**。所以新 ctl 不能承诺越过 bulk 重传。QUIC ACK、PATH_CHALLENGE 等传输控制帧也不是应用的 ctl 流。三流仍共享连接拥塞控制、pacing 和连接级 flow control；“独立流”不等于独立带宽或硬实时延迟保障。

`send_stream.go` 还提供 `TryWriteAll`，但它成功时会复制数据并提前占用流和连接发送额度；失败返回 `ErrWouldBlock`，不排入半条数据，也不遵守 write deadline。不断用它灌 bulk 可能先占完连接信用，不宜用它再造一个轮询调度器。首轮采用**每流一个 FIFO writer，各自阻塞 Write**，由 quic-go 选择发哪条流；同流并发 Write 及全连接大锁都不使用。Write 可部分成功后报错，长度前缀帧中断应使当前传输失败，不能重写整条帧造成字节流错位。

## 3. 现有业务实际怎么分类

| 方向 / 业务 | 当前密码学通道 | 核对入口 |
| --- | --- | --- |
| 手机命令、审批回答、取消、应用 ACK、探针回声 | ctl | Android `RelayClient.outboundChannel`；iOS `WebSocketTransport.sendRelay` |
| 手机上传文件分块 | bulk（两端一致） | Android `sendUploadChunk`；iOS `sendBinary` |
| Host 命令结果、runtime 状态 / metadata、交互、设备目录、路径 / 探针 | ctl | `channelForDeviceMessage`、`DeviceLink.#probeOnce` |
| Host 会话快照、session/message/turn/tool 普通事件、一般状态快照 / 范围页、diagnostics.page | msg | `channelForDeviceMessage`、`sendSessionSnapshot` |
| Host 仅 execution 域的 agent.state.snapshot | ctl | `channelForDeviceMessage` 的特例 |
| Host 工具正文页、文件变更详情页 | bulk | `session.tool.content.page` / `session.change.detail.page` 经 `sendToolContent` |
| Host artifact 二进制分块 | bulk | `DeviceLink.sendBinary` |
| device.authenticate、pair、hs、Relay 明文生命周期 / protocol.error | 引导控制（没有加密 ch 的帧也归控制流） | 手机握手入口、Relay `muxChannelOfMessage` |

入口：[Host 分类](../../packages/host/src/host-service.ts)、[DeviceLink](../../packages/host/src/device-link.ts)、[Android](../../android/app/src/main/java/com/orbising/orbis/RelayClient.kt)、[iOS](../../ios/Orbis/Orbis/WebSocketTransport.swift)。此前“Android 出站业务全部 ctl”不正确，上传早已有独立 bulk。

因此三流能隔离文件与控制 / msg，却**不会**隔离同属 msg 的长历史和 live 正文，也不会隔离同属 bulk 的工具详情与文件。实现时不按解密后的业务类型重新分流；若要进一步细分，应另改密码学序号域及业务投递契约。

## 4. 为什么只能先按现有三通道拆流

[E2eChannel.open](../../packages/e2e/src/session.ts) 按 channel 维护已认证的序号高水位 `n`，收到 `n <= last` 就丢弃，不等待乱序补洞。`hdr.ch` 参与 AAD / nonce（[ADR-0011](../adr/0011-nonce-slot-and-high-watermark.md)）；部分旧注释仍称“永久序号空洞”或“ch 不进 AAD”，不得以这些旧注释覆盖当前实现。

同一个 channel 如果按文件、runtime、请求或消息开多条流，后面的 `n=12` 可以先完成认证，随后合法的 `n=11` 会被当成 stale。安全的第一步是一个连接的一个 E2E epoch 内 **ctl / msg / bulk 各一条可靠有序流**。每流按完整帧、piece 原顺序交付；并发读的结果不能在共享 decrypt worker 前重新打乱同一 channel。

8 KiB 的 `ct` 切片继续存在：[piece.ts](../../packages/protocol/src/piece.ts) 的片头关联 `mid/idx/n/ch/ik`，重组仍有条数、32 Mi 字符和 60 秒预算。QUIC 自身分包并不替代跨 WS 段的小写入粒度、应用重组资源限制及密文认证。取消一个下载也不能 reset 共用 bulk 流，否则会连带其他文件和工具详情；继续用现有业务取消 / offset 恢复。

## 5. 握手屏障是三流前的必要实现工作

现有链路依赖的顺序不只是每通道 FIFO：

1. 手机收到 HS2 后产生 HS3；Android 紧接着建立本地 channel 并 flushPending，iOS 也建立 channel、排入 HS3。以前一个 WS 保证后续上传不会在 HS3 前到 Host。独立 bulk 流会打破这一点。发送完成回调或“HS3 已排入 QUIC”不足以作为屏障。
2. Host `HostDeviceSession.handle(hs1)` 立即更换握手并置旧 channel 不可用；`DeviceLink` 当前要到 `confirmed` 才 reset 旧 mux / 重组器。Host 可能还有旧 epoch 的待发密文。
3. `HostService.#handleSessionReady` 在 confirmed 后发送加密 device.ready / 目录、交互快照及 device.path，再触发各后端 announce。独立 msg 不能抢在手机应用完目录前被消费。Relay 自己也发送**明文** device.ready，它不证明 Host E2E 确认。
4. 手机保持 socket 时，host.online 会触发重新握手。旧 bulk 可以迟于新 ctl / 握手到达；只在 App 清 channel 或只清 Go 的待写队列不能清除已经进入 QUIC、Node mux、Host mux 的数据。

设计必须把“传输 ready”“HS3 已有序交到 Host 路径”“手机已认证并应用 Host bootstrap”分开。三流候选使用控制流承载引导消息，并在手机、Go 的业务投递边界设置显式状态机：先缓存 / 限额接收其他流，等对应条件成立才递交，不能靠调度优先级当因果顺序。Go → Node 只有一个 WS writer，必须保证 HS3 排在后续任何 channel 数据之前。

**实现顺序修订**：先以原 WS 和真实 Host / E2E 对照重连与重新 HS1 的行为，再注入三流提前到达、旧分片 / 队列。adapter 使用连接代次隔离本地回调，以引导状态有界暂存提前数据；必要时在现有路径的握手 / 清理入口做局部修复。只有测试证明这些入口不足时才评估协议扩展，不先要求端到端 epoch 标记。单独重建 QUIC 不能证明上游清空，本地 generation 也不能识别 Host 密文 epoch，Q10 必须通过后才发布。当前同 socket 重新 HS1 对照已通过；三流旧队列故障注入尚未完成。

## 6. 应用队列仍保留在哪里

实际下行是 `Host DeviceLink mux → Host WS → Node mux → loopback WS → Go → 手机`。Native QUIC 只替换最后公网一段；Host ↔ Relay 的 TCP 队头阻塞仍存在。

- Go QUIC 出口：每通道一个有界 FIFO + 独立 writer；流之间使用 SetPriority。建议初始值 ctl `(0,false)`、msg `(3,true)`、bulk `(7,true)`，是业务映射而非测得的最优参数；没有额外权重 / 老化 / 带宽保证。
- WS 段：Host / Node 现有优先队列仍需要。Go 把三流汇聚回单个 loopback WS 的方向也需要有界 mux，控制帧不得长期排在 bulk 后面；同通道 FIFO 和握手屏障优先于挑下一帧的策略。
- 手机 QUIC 出口：当前 iOS `drainQueue` 全连接一个 isSending、Android wrapper 一个写协程会让阻塞 bulk 阻止 ctl 进入 QUIC。必须改为逐通道写入，不能只把底层 socket 换成三个流而保留全局串行等待。WS 分支保留原行为。
- 接收处理：并行读流，再按代次和每通道顺序交给现有受预算限制的解码 / 消费入口。保留 [ADR-0060](../adr/0060-mobile-relay-history-performance.md) 的 worker 独占与旧代次隔离，不能并发共享可变 cipher；也不能等待“全局下一帧”重建跨流 HOL。

内存队列、传输流控和业务准入是三个不同层次。Go 候选每连接护栏合计 100 MiB，128 个连接触顶约 12.5 GiB，不能当作合理的部署容量。loopback 被读空也不表示公网进展，Node enqueue 未执行 hasRoom，停读可能将压力移回 Node 并阻挡控制。此次保留源端准入和现有 mux，在适配器内限制连接 / 队列 / 在写帧及窗口，并做 Q13 的 WS 对照测量。新增失控在造成差异的边界修复；撤回“逐通道信用协议 / 全链路预算重构是实施前置条件”的表述。详见[历史复核 §3](native-quic-transport-lessons.md#3-当前适配器还缺什么)。

保留已有源头准入：Host snapshot 最多 32 个活动投递且在封帧前检查字节预算；详情页 64 KiB / 独立 256 KiB 预算；artifact token bucket / bulk 准入。传输层看不到 transferId，不能擅自丢 sealed 帧或自动重放用户命令。已认证后的接收消费队列则按 [ADR-0040](../adr/0040-bounded-inbound-delivery.md) 丢最旧 / 记数 / 补同步，不能混成“所有队列溢出都断线”。

[ADR-0044](../adr/0044-bounded-codex-live-publish.md) 的 Host 封帧前普通队列准入失败 / 路径摘除仍有效；它与 ADR-0040 的解密后消费溢出不关闭不冲突。Go v1 的密文队列满即关闭只是一层紧急护栏，不是已经验证的长期背压方案。新设计既不能搬来手机的丢密文策略，也不能靠反复断线重同步维持日常负载。

## 7. 流控、确认与连接迁移

现有候选 Go 配置每流和每连接都是 64 KiB 初始、256 KiB 最大；它可能压低高 RTT 链路吞吐。以 100 ms RTT 举例，256 KiB/RTT 仅约 21 Mbit/s 的量级。这不是任何链路的实测上限，不能为了低延迟盲目缩小接收窗口。应据 BDP、活跃流数量和总内存预算选择初始 / 最大窗口，连接预算为 ctl 留空间；库没有按 channel 设置独立窗口的公开配置，不能虚构一个 ctl 预留 API。

本端接收窗口限制的是**对方发送**。Go 服务配置主要控制手机上传；Go Android 配置控制 Host 下行；Apple 下行要核对自己的 NWProtocolQUIC.Options 和系统实际窗口。`PullScheduler` 1–8 MiB 的已请求未落盘窗口、QUIC window 和拥塞窗口含义不同，无须数值相等。初始配置和总体预算必须以 Q09 的慢读 / BDP 测试确定，不能直接把 8 MiB 复制成每个连接的预分配。

QUIC Write 返回、QUIC ACK、Host 向原 socket 写完、手机 SQLite applied 是不同事实。[ADR-0037](../adr/0037-session-sync-transaction-contract.md) 的 snapshot ACK 和 [ADR-0049](../adr/0049-optimistic-send-and-source-reconciliation.md) 的操作身份不变；[PullScheduler](../../android/app/src/main/java/com/orbising/orbis/PullScheduler.kt) 仍按 durableOffset / 缺失范围恢复，不能因为 QUIC 可靠就删掉应用恢复。设置 RTT 仍测 Host ↔ App 的 E2E 探针。

`MaxIncomingStreams` 限对端打开的并发流。服务端必须允许三个已注册 bidi 流并拒绝额外角色；客户端不应默认接受服务器任意开流。`Close` 只关闭 bidi 的发送半边；取消需处理两个方向并等待任务结束。启用 `RequireStreamCreditRelease` 后，stream 完成也要应用显式 ReleaseStreamCredit 才能补额度；若后续选择同连接换 epoch，必须覆盖旧流完成 / 释放 / 新流等待。不能用 `MaxIncomingStreams=1` 实现三流。

官方连接迁移文档和固定版本源码提供 `AddPath → Probe → Switch`；NAT rebinding 由库自动处理。Android 当前 `DialAddr` wrapper 没有绑定系统网络切换和新 Transport，不能宣称 Wi-Fi / 蜂窝自动迁移已实现。固定版本 `NewCubicSender(..., true /* use Reno */)` 使用 Reno 模式；它不是 Hysteria Brutal，同机代理体验只能作为 Q06 对照线索。

## 8. Apple 的支持边界

`NWMultiplexGroup` / `NWConnectionGroup` 自 iOS 15 可用，适合当前最低 iOS 17。Apple 官方 WWDC 示例用 `NWConnection(from: group)` 或 `group.extract` 创建同一 tunnel 的流，`newConnectionHandler` 接收入站流；直接创建三个独立 NWConnection 不能当成一个 QUIC 连接的三个流。

`ContentContext.relativePriority` 文档只承诺待发 context 队列内的相对重排（0–1）。目前查到的公开 API 没有证明它等价于 quic-go 的跨流 urgency / incremental；不能标为已支持同样策略，也不先给每个 piece 换 context priority 冒险破坏 FIFO。下行 Go 发送端的 SetPriority 与 Apple 接收端无关，仍可使用。iOS 上行的跨流调度保证需专门互通测试；若达不到需求，再决定采用共享 Go core 或保留有限的上行准入策略，均须记录取舍。

## 9. 必补验证与当前结论

| ID | 必须证明 | 当前状态 |
| --- | --- | --- |
| Q07 | 三流角色绑定、帧顺序、未知 / 重复流、同 channel 不跨流；握手尚未应用时提前到的 msg/bulk 不进入 E2E / reducer | 待实施 |
| Q08 | 三个 writer 独立；新 ctl 可在 bulk reader 停顿时前进；丢包场景记录 bulk 重传先于新 ctl 的限制；WS 汇聚仍保序 / 有界 | 待实施 |
| Q09 | 三端接收窗口 / BDP、bulk 占用连接额度、慢消费者、单连接和总内存预算、取消唤醒、半写帧错误与流信用释放 | 待实施 |
| Q10 | HS3 与上传抢跑、Host bootstrap 与 msg 抢跑、host.online / 重新 HS1、旧上下游队列及旧 piece、LAN↔Relay、Apple group ↔ Go 互通 | 待实施 |
| Q11 | 历史事务故障组合：稳定 sync / pending / ACK / applied、上传写入与下载补洞、控制先到、未知操作和多 Host 隔离 | 待实施 |
| Q12 | 同一业务夹具的快网 / 高 RTT / 限速成本，包含仍存在的 WS 节拍、同 channel 竞争与消费成本 | 待实施 |
| Q13 | 封帧前、密文桥接、解密后三层压力；总预算、WS 心跳、恢复进展与无重连风暴 | 待实施 |

Q01–Q06 保留；旧“额外流拒绝”用例保留为 v1 候选测试，新 wire 按三角色白名单增加用例。长历史与 live 同属 msg、工具详情与文件同属 bulk 的等待必须如实测量；不承诺三流解决这些同通道竞争。

当前方向：现有三密码学通道对应三 QUIC 流，Go 出口使用原生 SetPriority；保留源端业务、WS 汇聚和消费处理。WS / QUIC 共用 RelayTransport 接口，按 ADR-0065 §3 在 Relay 路径内受控重连。三流因果 / 资源门禁、Apple 互通和移动端切换控制器仍待完成；已通过的 v1 真实 Host 对照 / 交接测试见 ADR 实施记录，不能计作这些待办已通过。
