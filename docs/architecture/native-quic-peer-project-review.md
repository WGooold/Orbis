# 原生 QUIC：成熟项目对照与当前性能诊断

日期：2026-11-04。关联 [ADR-0065](../adr/0065-native-quic-relay-transport.md)、[完整公网报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-public-performance-20261104.md)、[原生传输回归](../../native/relayquic)。本轮只做源码复核、只读现场检查和本地计量验证，不修改生产服务或业务协议。

## 结论与证据级别

当前最明确的偏差，是用上游 quic-go 默认 Reno 的三流替换，期待复现 Hysteria 的弱网表现；此前虽记录了 Reno 的差异，却没有把拥塞算法对照和分层诊断作为公网测速的前置条件。另一个确定的问题在性能诊断：仅有业务整块吞吐和控制 RTT，没有底层连续字节基线、拥塞 / 流控证据，不能判定 0.14–0.28 Mbit/s 的根因。

Reno 与 Hysteria / TUIC 的差异已经查实，但**尚未证明 Reno 是本线路低吞吐的唯一或主要原因**。三条可靠流、保留原 E2E / 应用回执、复用业务的方向有依据；不应在没有分层证据时重写业务、去掉 E2E、改为不可靠 DATAGRAM，或把全部帧改成独立 stream。

## 1. 查了哪些项目

源码均以固定提交下载，文件和 SHA-256 保存在 `.artifacts/quic-review/peer-projects-20261104/`，不只参考 README。服务器上只读确认的 Hysteria binary 为 **v2.13.0**，commit `ca8fbd874fd6ca82413948de6dc5924405e103e1`，依赖 `github.com/apernet/quic-go v0.63.1-0.20261004180939-a10df75c260c`；另复核 Hysteria master `fb25dc852ebbc70658e67889f411887a82b7c281`（2026-10-27）、sing-quic `7e0a5869a5f49ed0a685143345dfda0448bbc708`（2026-10-20）、Syncthing `b34734376128492fa4e1b01412193de033e20613`（2026-11-02）。

| 项目 | 实际做法 | 对 Orbis 的启示 |
| --- | --- | --- |
| Hysteria 2 v2.13.0 | 使用 apernet/quic-go 分支；带宽协商决定 Brutal 或配置的控制器，未指定自适应类型时为 BBR。每个 TCP 代理连接使用一个 QUIC stream，之后连续读写；服务端快路径双向 `io.Copy`。默认每流接收窗口 8 MiB、连接 20 MiB。 | 性能来自具体控制器、pacing、流控和连续供给的组合；单独换成 QUIC 不等价。TCP 代理数据也用可靠 stream，不要求改为 DATAGRAM。 |
| sing-box 的 TUIC 实现（sing-quic） | 使用 sagernet/quic-go 分支；支持 cubic / new_reno / bbr，缺省 cubic。每个代理 TCP 连接开一个 stream，`Read/Write` 直接委托流。 | 拥塞算法是显式选项，且依赖库分支能力。独立代理连接可以分流，不代表共享一个 E2E 序号域的业务消息可以任意分流。 |
| Syncthing | 使用上游 quic-go；拨号后开一个 stream，包装成既有传输连接并保留 TLS 身份校验。配置重点为 idle / keepalive，未在这一层引入 Hysteria 控制器。 | 以 QUIC 替换原 socket、复用业务本身是合理实现；QUIC 应用没有统一的“每条消息开一条流”要求，也不保证一定快于 TCP。 |

固定源码入口：

- Hysteria：[客户端连接与拥塞选择](https://github.com/apernet/hysteria/blob/ca8fbd874fd6ca82413948de6dc5924405e103e1/core/client/client.go)、[拥塞控制器](https://github.com/apernet/hysteria/blob/ca8fbd874fd6ca82413948de6dc5924405e103e1/core/internal/congestion/utils.go)、[窗口缺省](https://github.com/apernet/hysteria/blob/ca8fbd874fd6ca82413948de6dc5924405e103e1/core/client/config.go)、[连续复制](https://github.com/apernet/hysteria/blob/ca8fbd874fd6ca82413948de6dc5924405e103e1/core/server/copy.go)、[测速字节计数](https://github.com/apernet/hysteria/blob/ca8fbd874fd6ca82413948de6dc5924405e103e1/extras/outbounds/speedtest/client.go)。
- TUIC：[控制器选择](https://github.com/SagerNet/sing-quic/blob/7e0a5869a5f49ed0a685143345dfda0448bbc708/tuic/congestion.go)、[客户端流和缺省值](https://github.com/SagerNet/sing-quic/blob/7e0a5869a5f49ed0a685143345dfda0448bbc708/tuic/client.go)。
- Syncthing：[拨号与原协议包装](https://github.com/syncthing/syncthing/blob/b34734376128492fa4e1b01412193de033e20613/lib/connections/quic_dial.go)、[配置与 stream 包装](https://github.com/syncthing/syncthing/blob/b34734376128492fa4e1b01412193de033e20613/lib/connections/quic_misc.go)。

现场 `/etc/hysteria/config.yaml` 未显式设置 bandwidth / congestion / quic / ignoreClientBandwidth；这不能反推手机协商出的控制器，客户端带宽配置和实际协商仍未知。不能把该用户的 Hysteria 效果全部归因于 Brutal，或直接声称它一定在用 BBR。

## 2. 我们与这些项目的具体差异

### 2.1 拥塞控制没有对齐：确定差异，待做因果验证

当前 [go.mod](../../native/relayquic/go.mod) 固定上游 quic-go v0.65.0。源码 `internal/ackhandler/sent_packet_handler.go` 明确以 `NewCubicSender(..., true /* use Reno */)` 初始化；本机依赖文件与该官方标签原文 SHA-256 一致，见 `quic-go-match.json`。类名有 Cubic 不表示实际启用了 Cubic。

[quic-go 官方文档](https://quic-go.net/docs/quic/congestion-control/)说明默认 NewReno、没有公开的运行时控制器配置。Hysteria / sing-quic 的 `SetCongestionControl` 来自各自分支，不能向我们现在的 `quic.Config` 随意加一项 `bbr`。如果后续对照证明值得采用，须单列库分支、许可、升级与跨平台维护成本。

[三流优先级](../../native/relayquic/multistream.go)只选择哪个待发 stream 先使用连接发送额度，不扩大拥塞窗口、不保证带宽。ctl 优先改善已观察到的交互可用性，bulk 不因此获得 Hysteria 式的发送行为。Apple 使用 Network.framework，拥塞控制不是我们这份 Go 配置可统一控制的，Go 参考端结果不能直接外推到 iOS。

### 2.2 原 WS 发送准入仍参与：适配边界需要测量

当前 Host 路径是 `DeviceLink/mux → NativeQuicSocket → 三条本机 IPC → helper → QUIC`；Relay 的两角色仍各经一个同机 WS 与 Node 路由交互。这些都是本机段，**不能直接称为跨公网 TCP-over-TCP，也不能仅凭存在 loopback WS 认定它是主要瓶颈**。

[OutboundChannelMux](../../packages/protocol/src/outbound-mux.ts)仍以合计 `backlog` 配合 64 KiB 水位 / 1 ms 复查决定何时继续提交 msg / bulk；[NativeQuicSocket](../../packages/host/src/relay-socket.ts)将三 lane 的待写量相加，helper 的 writer 完成回执后减账。这样会在数据交给 QUIC 之前继续受应用准入影响，并没有完全委托给独立流调度。

这不是“必须删除旧 mux”的证据：它仍保护已封帧队列与 WS 分支，必须保留有界内存和 FIFO。需要采集每 lane 待写量、writer 耗时和 `notifyDrained` 机会，验证 QUIC 是否因供给不足而空转，再考虑在 adapter 边界提供逐 lane 可写 / 已消化通知。不得直接提高所有水位或取消护栏。

**64 KiB 本地待写水位不等于 64 KiB 网络拥塞窗口。** 回执在本地 Write 完成时释放，QUIC 内部还可有发送中 / 在途数据；不能简单用 `64 KiB / RTT` 断言其吞吐上限。旧注释中的 `水位 / 轮询周期` 也只是特定定时供给模式下的估算，不是当前整链路硬上界。

### 2.3 分片与编码成本：已量化，不能解释全部差距

按当前生产 `E2eChannel` / `fragmentEnvelope` 对 1 MiB 随机块实算：171 个 JSON piece，含 QUIC 应用长度前缀共 **1,435,119 字节**，有效 payload 1,048,568 字节，进入 QUIC 前膨胀约 **36.86%**。每个 IPC data 帧还单独有一个 writer 回执；Relay / adapter 有重复 JSON 解析与内存复制。详细数据见 `orbis-framing-and-budgets.json`。

这些成本值得 profile，但原 WS 和用户通过 Hysteria 转发的 Orbis 也保留原 E2E / JSON。它们不能单独解释“原生 QUIC 未复现 Hysteria”或数百倍速度差，当前资源采样也不足以证明 JSON CPU 饱和。删除业务加密、直接上新二进制协议不属于已证明必要的修复。

### 2.4 流控窗口与 UDP 缓冲：需观测，不盲目调参

当前 v2 每流接收窗口初始 256 KiB / 最大 4 MiB，连接初始 1 MiB / 最大 12 MiB；[配置入口](../../native/relayquic/multistream.go)。小于 Hysteria 的初始值，但 quic-go 会自动调整窗口。

以假设的单段 RTT 300 ms 举例，256 KiB / RTT 约 6.99 Mbit/s，4 MiB / RTT 约 111.85 Mbit/s；这只展示数量级，不能当作实际测速或性能保证。仅凭这些窗口大小解释 0.14 Mbit/s 缺乏证据，需要记录 MAX_DATA / MAX_STREAM_DATA、DATA_BLOCKED / STREAM_DATA_BLOCKED 与读取消费进展。

公网 Relay 的 UDP rmem/wmem max 为 212992 字节，并出现接收缓冲不足提示。quic-go [官方性能指南](https://quic-go.net/docs/quic/optimizations/)强调 UDP 缓冲、批量收发与 GSO 等条件；当前没有 socket drop 计数，不能断言该缓冲就是主要丢包来源。本轮未修改全机 sysctl。

## 3. 已确认的测量缺口

[Hysteria 测速](https://github.com/apernet/hysteria/blob/ca8fbd874fd6ca82413948de6dc5924405e103e1/extras/outbounds/speedtest/client.go)连续按读写字节计数；我们的[业务夹具](../../native/relayquic/testdata/perf/main.go)只在完整 1 MiB 块解密 / 校验或收到 ACK 后计量。

1. **量化太粗**：60 秒每增加一块恰为 0.139809 Mbit/s。原结果 0.14 / 0.28 分别表示窗口内完成一 / 两块，不是证明线路稳定锁在该速率。当前业务 goodput 仍有效，但不应称为带宽上限。
2. **上传单块等待**：一个 1 MiB 块校验 ACK 后才发下一块，不能保证把 QUIC 链路持续喂满。双段合计 RTT 假设 600 ms 时，理想 stop-and-wait 上限约 13.98 Mbit/s；因此它会影响快网，但本身也不足以解释 0.28 Mbit/s。
3. **排空预算与负载不匹配**：最多 4 MiB 已交付在途数据，按已观测 0.139809 Mbit/s 的有效速度估算需约 240 秒，统一 60 秒排空不能验证最慢轮次完整完成。超时必须保留；下次应同时分开报告停止供给、剩余字节和接收进展，再按明确预算验证，不把放宽超时当作性能修复。
4. **没有分层对照和协议归因**：未采原始 TLS / 原始 QUIC 的单段连续吞吐；未记录每一段的实际 RTT、cwnd、bytes-in-flight、重传 / PTO、流控阻塞、UDP drops、每 lane 字节和 writer 阻塞。无法区分公网路径、控制器、source 限制和 adapter。
5. **现场条件不等同于用户体验**：性能参考端与 Host 同在 Mac，直达真正 Relay IP，未经过香港生产入口，也没有同手机 Hysteria 对照。其结果不能验证用户那条路径的改善。

公网报告中所有失败、吞吐和长尾保持，不用本次复核回填为成功。此前“加压控制回复更可用”仍是有效观察；“吞吐没有提速证据”也保持。但“QUIC 带宽就是 17–35 kB/s”或“已证明 QUIC 本身不够快”都不成立。

## 4. 接下来的诊断顺序和判据

| 顺序 | 对照 | 如何据此决定改哪里 |
| --- | --- | --- |
| 1 | 固定同服务器、同路线与测试端：原始 TLS 与原始 QUIC 连续读写，逐秒字节计数；记录实际单段 RTT、丢包 / cwnd / flow control。独立双向，业务校验与线路字节分开。 | 原始 QUIC 也慢且持续 congestion-limited，再优先查路径和控制器；不要先改业务 mux。 |
| 2 | 在同一环境对比原始 QUIC、现有长连接帧 adapter、完整 E2E / 原业务负载，记录每层字节 / 排队 / CPU。保留原上传单块和下载窗口作为业务列，另设连续供给诊断列。 | 原始快而 adapter 慢，修本机桥接、逐 lane 背压和供给；adapter 快而业务慢，查业务窗口 / 落盘 / 消费。 |
| 3 | 仅在相同传输夹具中对比默认 Reno 与可维护的 BBR 实现；有明确带宽参数时再评估 Brutal。包含丢包、低带宽和控制长尾，不能只测峰值。 | 同条件有稳定收益且资源 / 原功能回归通过，才提出控制器实现决策。公开 API 不支持的部分不能写成已实现配置。 |
| 4 | 同物理手机和同服务器：WSS、通过该 Hysteria 服务的 WSS、原生 QUIC；记录两段承载和代理路径。 | 这是判断是否复现用户改善的最终现场证据；Mac / Go 参考端和协议基线不能替代。 |

可直接使用固定 quic-go 的 `Conn.ConnectionStats()` 获取 RTT、拥塞窗口和收发 / 丢失统计，并用 [qlog](https://quic-go.net/docs/quic/qlog/)补充 recovery / 流控事件；不能只设置 `QLOGDIR` 却没有给 `quic.Config.Tracer` 接线。诊断接入隔离夹具，限量保存，不采集生产凭据。

本轮没有改变默认 WS、三流设计、加密格式、回执、applied、文件恢复和未知操作处理，也没有新增 UI / feature / 验收通过项。原完整回归与真实手机 / 长期压力门禁保持原状态。
