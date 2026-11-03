# ADR-0063：移动端原生 QUIC 中继传输与 WebSocket 回退

日期：2026-11-04

Status: accepted（用户授权先写 ADR 再实施；代码、设备门禁、真实线路收益分别验收）

基点：`df02972350e00ee4330b311831626b71c8035678`，独立工作树 `orbis-native-quic` / `feat/native-quic`。主工作树尚未提交的 ADR-0062 / r44 等改动不纳入本分支；合并时保留其编号与规则。

关联：[ADR-0050](0050-fixed-lan-relay-routing.md)、[ADR-0060](0060-mobile-relay-history-performance.md)、[ADR-0007](0007-channel-multiplexed-delivery.md)、[ADR-0011](0011-nonce-slot-and-high-watermark.md)、[ADR-0037](0037-session-sync-transaction-contract.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)。显示约束：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) S18 / S23、V05、V09–V12、V16–V18、V22；验证：[UI 回归](../testing/ui-regression.md) R62。

## Context

用户观察：手机直连 Relay 不稳定；手机通过部署在**同一台 Relay 服务器**的 Hysteria 2 代理访问 Relay 后稳定。该对比支持验证手机到服务器公网段的 QUIC 承载，但尚不能区分拥塞控制、UDP/TCP 路径待遇、地址族、DNS 或连接管理的贡献，不能宣称已证明 QUIC 的收益或承诺复现 Hysteria 2 的效果。

当前 Relay / Host 使用 Node `ws`，Android 使用 OkHttp WebSocket，iOS 使用 URLSessionWebSocketTask。`ctl / msg / bulk` 是应用队列与密码学通道，最终仍共用可靠有序传输。首版只替换移动端 ↔ Relay 公网承载；Host ↔ Relay 与 LAN 保留既有 WS，以隔离本次现场变量。端到端协议、Host 权威状态和同步事务不变。

## Decision

### 1. 实现与边界

- 新增独立 Go 模块 `native/relayquic`：以固定版本的 quic-go 提供原生 QUIC 服务及 Android gomobile 绑定。iOS 直接使用系统 Network.framework 的 QUIC 实现。
- 服务作为与现有 Node Relay 同机的独立进程，终止 QUIC 后仅连接配置好的 loopback WS `/v1/device`。它是 Relay 的传输适配器，不是通用代理；客户端不能指定目标主机、端口或任意 URL。限制连接数、握手时间、首帧和消息长度，双向按写入完成施加背压。
- 客户端直接从 App 建立 QUIC，用户无需运行 VPN、系统代理或 Hysteria 2。首版不移植 Brutal，不宣称连接迁移已验收，不引入 WebTransport、HTTP/3 WebSocket 或不可靠 DATAGRAM。
- 首版每连接一条双向可靠有序流，禁止 0-RTT 业务数据。保留现有发送优先级、分片、每通道 FIFO、nonce 高水位线、E2E 和接收预算。多 QUIC 流须另修订流映射、握手屏障与跨流顺序后实施。

### 2. Wire 与端点

- ALPN 为 `orbis-relay-v1`，TLS 1.3，验证 Relay 域名与系统信任链；不提供生产跳过证书校验开关。QUIC 外层 TLS 不替代 Host ↔ App E2E。
- 一帧为 `uint32BE(UTF-8 字节数) + JSON UTF-8`，上限 2 MiB，0 长度、超长、截断、无效 UTF-8 或非 JSON 对象均关闭。单独的传输版本不修改现有 `protocolVersion` 硬门槛。
- 首帧固定为 `{"type":"transport.open","version":1}`。服务建立本机上游 WS 后回复 `{"type":"transport.ready","version":1}`。只有收到有效 ready 才进入现有 device.authenticate / pair / hs；传输 ready 不表示配对成功、E2E 就绪、目录就绪或操作成功。
- Node Relay 新增 `GET /v1/transports`，返回 `{"version":1,"quic":null}` 或 `{"version":1,"quic":{"port":443,"alpn":"orbis-relay-v1"}}`。仅部署明确配置端口才宣告 QUIC；端点域名固定取原 Relay URL，不接受第三方地址。该入口可经现有 `/relay/` 路径前缀反代。
- App 仅对 HTTPS/WSS Relay 探测该 HTTPS 入口，最多等待 1 秒；本地 HTTP/WS 隔离夹具继续使用 WS。发现不可用 / 无 QUIC 则连接原 WS。宣告中的未知版本、ALPN 或非法端口不作为可用 QUIC。
- TLS 证书、UDP 监听端口、loopback 上游和公开元数据由部署者显式配置；Hysteria 2 若已占用某 UDP 端口则另选空闲端口。TCP 与 UDP 可同号，两个 UDP 服务不得竞争同一地址端口。

### 3. 选择、失败与恢复

- 每次连接先完成探测，再尝试 QUIC；QUIC 建连及传输 ready 合计最多 1.5 秒，失败后关闭候选再连接 WS。同一代次最多一个通道能取得业务发送权，禁止向两个通道同时认证或发送用户操作。
- 回退只发生在传输 ready 之前；ready 之后的认证失败、协议版本错误、E2E 失败或断线交给现有生命周期，不能隐藏错误或在备用通道自动重发业务。TLS 验证错误仍拒绝该 QUIC 连接；任何 WS 回退继续强制原 WSS 证书验证，不允许降至明文。
- 所有发现 / 建连 / 读写回调绑定连接代次；取消、换 Host、重连及迟到 ready 必须关闭旧资源。关闭必须取消探测与未完成连接，避免僵尸连接抢占同一 deviceId。
- QUIC 服务保持 10 秒传输 keepalive、30 秒 idle timeout；这只判断传输可达，不把 QUIC ACK 或写入完成当业务确认。应用未确认结果按 ADR-0049 / 0055 保持未知并对账，不自动重试。
- LAN 优先顺序不变；QUIC 与 WS 都属于同一逻辑 Relay 路径，不新增“第三条路径”或新的设置。既有延迟展示继续测 Host 端到端往返，不拿 QUIC 握手延迟冒充。

### 4. 资源、发布与可观测性

- Go 服务只记录连接数量、传输选择、错误类别和字节计数；不记录凭据、聊天正文、密钥或首帧原文。上游固定 loopback，禁止通过用户首帧转为开放代理。
- Android AAR 从固定 Go 依赖生成，生成物留在固定 app/build 下，由构建脚本和 Gradle 任务衔接；不提交平台二进制。iOS 无新增第三方运行时。部署服务独立启停，移除宣告即可令后续连接回到 WS。
- 服务优先部署并验证 UDP/TLS，再发布移动端。未经用户另行授权不变更生产服务、配对数据或手机安装。实现授权覆盖本地隔离开发与验证。

## Verification

| ID | 必须验证的结果 |
| --- | --- |
| Q01 | 真实 QUIC 双向转发与原 WS 内容逐字节相同；握手、多个帧、部分读取与多字节 UTF-8 正确；上限前后、零长度、截断、坏 JSON、额外流拒绝；慢读者下预算有界 |
| Q02 | 证书 / 域名错误拒绝；ALPN / 传输版本错误不进入业务；固定 loopback 目标，客户端不能提供任意代理地址；首帧超时、并发上限与取消回收 |
| Q03 | 无宣告、UDP 黑洞、QUIC 失败时在预算内回退；只有获胜通道认证；取消、换 Host 和旧回调不影响新连接；ready 后断线不重放命令 |
| Q04 | 实际 Node Relay + 原生 QUIC + 隔离设备凭据：认证、E2E 转发、协议错误、断开与重连；Host WS 与手机 QUIC 互通；原 WS 全套行为保留 |
| Q05 | 两端配对、目录、聊天、流式输出、上传 / 下载、切 Host、LAN↔Relay、后台 / 恢复、正在发送时断网；来源 ACK 与 pending / unknown / failed 保持，消息身份与阅读锚点不变 |
| Q06 | 同手机、同服务器、同时间窗口对比直连 WS / WS 经同机 Hysteria 2 / 原生 QUIC；报告地址族、网络、RTT、丢包条件、卡顿时长、断线次数、恢复耗时和 p50/p95，不把本机测试当真实线路改善 |

自动阶段执行 Go race / 帧与真实 QUIC 集成、Node Relay 与相关协议 / Host 回归、Swift 核心、Android JVM 与双端构建。设备阶段严格按共享入口与构建租约执行受影响双端 L1–L4、C01–C18、R62 及 A1–A4；同设备同配置比较失败集合，不跳过或放宽既有用例。证据存于 `.artifacts/ui-regression/20261104-native-quic/`。生产手机 / Hysteria 对照未执行时标记未验证。

## 实施与验证记录

- 2026-11-04：创建独立工作树并先登记本 ADR；Q01–Q06 待实施 / 验证。编号 R61 留给主工作树后台子任务，本专项追加 R62。没有完成设备门禁，不增加已交付计数。

## 依据

- RFC 9000（QUIC streams、flow control、connection lifecycle）：https://www.rfc-editor.org/rfc/rfc9000.html
- quic-go 官方文档：https://quic-go.net/docs/
- Apple Network.framework `NWProtocolQUIC`：https://developer.apple.com/documentation/network/nwprotocolquic
- Go Mobile：https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile
- Hysteria 2 协议：https://v2.hysteria.network/docs/developers/Protocol/
