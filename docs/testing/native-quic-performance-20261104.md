# 原生 QUIC / WSS 性能对照：2026-11-04

关联：[ADR-0065](../adr/0065-native-quic-relay-transport.md)、[NQ-08](../agents/native-quic-tickets.md)、[原功能回归](native-quic-functional-regression.md)。本报告测量本机 Relay 传输实现的吞吐与控制响应，不代替真实手机公网、Hysteria 2 对照或原项目功能回归。

## 结果

**已停止，非全链路实测报告。** 用户要求改测真实公网、并将 Host↔Relay 纳入 QUIC 后，本轮单侧回环测量于 2026-11-04 主动中止。`summary.json` 的 `valid:false` 保留；仅有 idle / download 的五轮完整数据，upload 未完成，不给出综合性能结论。两段公网改造和五轮测量现已完成，结果见[完整公网报告](native-quic-public-performance-20261104.md)，本报告不移记为新测试通过。

## 测试路径与配置

```text
共同 Host 侧：合成负载 → 原 E2eChannel → 原 fragmentEnvelope → 原 OutboundChannelMux
             → Host WS → 生产 Node Relay
WSS 下行：   Node Relay → loopback WS → Go HTTPS reverse proxy → TLS 1.3 WSS → Go 参考客户端
QUIC 下行：  Node Relay → loopback WS → 生产 Go Serve → QUIC v2 三流 → Go MultiClient
上行：       以上路径反向；Host 解密、重组及逐字节校验成功后回 ACK
```

两种承载共用同一份工作树、Node Relay、Host 加密 / 切片 / mux 源码、客户端加解密和计量逻辑。WSS 使用 Gorilla WebSocket，QUIC 使用生产 `DialMulti / ReadLane / WriteLane / Serve / ConfigMulti`；未使用带额外缓冲的 `business-bridge`。WSS 的 HTTPS 反向代理模拟服务端 TLS 终止，和 QUIC sidecar 一样保留一段 loopback WS。Host 与 Relay 在同一 Node 进程，客户端、TLS 代理 / QUIC adapter 在同一 Go 进程；这是本地集成性能夹具，不是完整生产部署拓扑。

- 硬件 / 软件：Apple M6、12 逻辑核、16 GiB RAM；Darwin arm64；Node 22.23.2、Go 1.27.3、quic-go 0.65.0、Gorilla WebSocket 1.5.3。完整系统标识与源码哈希见 evidence 中的 `provenance.json`。
- 网络：全部使用 `127.0.0.1`，IPv4；没有配置 RTT、带宽上限或丢包。使用临时同类型 ECDSA 证书、TLS 1.3、真实证书校验；不改系统信任。WSS 不启用压缩；QUIC 使用 ALPN `orbis-relay-v2`，同连接 ctl/msg/bulk 三流及生产窗口 / 原生 priority。
- 载荷：每块 1 MiB，符合原 `ARTIFACT_CHUNK_BYTES`；块头 8 字节为严格递增计数，其余为随机数据。AES-256-GCM 双向独立临时密钥，保留原 nonce / AAD / 每 channel 序号及 8 KiB ciphertext 分片。接收端验证 AEAD、分片序号、块序号和全部载荷字节；计量排除 8 字节计数、AEAD tag、base64、JSON、分片、TLS / QUIC 开销。
- 业务边界：下载固定 4 MiB 在途，取原 PullScheduler 的初始窗口；上传每次一块在途，匹配原单文件上传限制。窗口 ACK 是夹具内的接收校验回执；没有真实 HostService 文件读写、手机 SQLite、UI、文件最终落盘 / SHA 校验、原自适应窗口或重试。预置临时方向密钥以隔离稳态性能，不测配对 / E2E 握手耗时。
- 场景：idle（仅控制探针）、download（持续 Host→客户端 bulk）、upload（持续客户端→Host bulk）。每种协议每场景 5 轮，按 WSS/QUIC、QUIC/WSS 交错。idle 预热 2 秒、测 10 秒；上下行各预热 10 秒、测 60 秒。正式性能二进制不带 race；单独的 race 短跑用于检查夹具并发。
- 控制探针：每 100 ms 一个加密 ctl 请求 / 响应，采用同一端单调时钟；RTT 从计划发出时刻到解密响应完成，包含本地发送等待，不只计 socket 往返。每轮保存全部应发探针；超时、未发送、缺失回复都计失败，不以删除慢样本优化 p95。p50 / p95 / p99 使用 nearest-rank，然后取 5 轮各自分位数的中位数；最慢值为全部正式样本最大值。
- 吞吐：下载按测量窗口内成功解密并校验的有效字节计；上传按该窗口内客户端收到 Host 校验 ACK 的有效字节计。报告 5 轮吞吐中位数及范围；Mbit/s = 有效字节 × 8 / 秒 / 1,000,000，MB/s = Mbit/s / 8，使用十进制单位。预热及结束 drain 不计入吞吐；结束时须确认所有在途块收到并核验。

## 可以和不可以得出的结论

本机结果可用于衡量当前 adapter / 加密 / JSON / 分片 / Relay 转发路径在该硬件上的处理能力，以及这份负载下 ctl 与 bulk 的竞争。多流和原生优先级一起参与测试，没有做独立禁用优先级的因果对照；不能把全部差异归因于 `SetPriority`。

本报告不测原生 Android / Apple 客户端的完整开销；尤其 Apple 上行由 Network.framework 调度，不能套用 Go 上行数字。回环带宽不等于公网或手机网速，控制探针也不等于聊天首字时间、Agent 推理时间或文件落盘完成时间。没有测消息流 `msg` 的历史同步吞吐。

ADR 的 Q12 仍要求 RTT 5 ms / 100 Mbit/s、RTT 100 ms / 50 Mbit/s 的同手机快网对照，以及 RTT 100 ms / 10 Mbit/s / 双向 1% 随机丢包收益门槛；这些条件此次没有实现。没有把 TCP 字节代理暂停称为丢包，没有修改全机防火墙 / 网络。Q06 的同手机、同服务器、同时间段 WS / Hysteria 2 / 原生 QUIC 对照也仍未完成。默认 WS 保持。

## 复跑与原始证据

在依赖已安装的仓库根目录执行，输出目录必须不存在；入口会编译 TypeScript 与无 race Go 夹具，先检查本机共享资源工具的内存准入（可用时），保存版本 / 源码哈希、逐轮原始 JSON、每秒进程 RSS 与退出审计：

```sh
python3 scripts/run-native-quic-perf.py \
  --node /absolute/path/to/node \
  --go /absolute/path/to/go \
  --output .artifacts/quic-perf/new-run
```

短跑可显式传 `--rounds 1 --warmup 1s --duration 3s --idle-duration 1s`，不能与正式结果混用。运行器：[run-native-quic-perf.py](../../scripts/run-native-quic-perf.py)；Node 夹具：[perf-relay.mjs](../../native/relayquic/testdata/perf-relay.mjs)；原生夹具：[main.go](../../native/relayquic/testdata/perf/main.go)。

正式证据目录为 `.artifacts/quic-perf/20261104-report/`。`raw.jsonl` 保存全部正式探针 / 逐轮吞吐，`summary.json` 保存聚合及有效性判定，`provenance.json` 保存源码和工具链，`resources.jsonl` 保存采样，`run.log` 保存开始 / 结束，`cleanup.json` 与后续审计记录退出情况。初始短跑与 race 短跑另存于 `.artifacts/quic-perf/`；早期 `20261104-formal/` 在 idle 阶段中止，以修正上传窗口，不计入正式结果，保留取消和清理证据。

## 验证与资源清理

中止后已核验本轮观察到的全部进程退出，`cleanup.json` 为 `released:true`，共享队列无本任务占用。本轮不启动模拟器，不申请移动端构建租约，不修改用户账号或生产服务。
