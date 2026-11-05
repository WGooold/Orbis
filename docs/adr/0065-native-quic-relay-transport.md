# ADR-0065：Host—Relay—移动端原生 QUIC 与 WebSocket 切换

日期：2026-11-04

Status: accepted（用户授权先写 ADR 再实施；代码、设备门禁、真实线路收益分别验收）

编号修订：2026-11-04 主工作树 ADR-0064 / R64 已用于协议兼容，本专项迁至 ADR-0065 / R65；2026-11-05 主工作树 r47 / r48 已使用 R65（侧边栏）和 R66（消息菜单），本专项活动回归号再迁至 **R67**，ADR-0065 不变。既有 `.artifacts` 中 ADR-0063 / R62、ADR-0064 / R64、ADR-0065 / R65 均为本专项当时编号，原始证据不改写。不能为拆流破坏已部署 18 / 19 的基础格式；主工作树 ADR-0064 的 Relay＋Host 兼容实施与发布另行验收，本分支不冒充已合入。

**2026-11-04 用户扩大范围：整个 Host ↔ Relay ↔ 手机链路均须支持 QUIC，不再只替换手机侧。最新决策为 §9；此前“首版 Host 保持 WS”的描述与单侧结果仅保留为历史阶段。** 两段公网承载可独立选择 ws/quic/auto，全 QUIC 模式两段都必须实际为 QUIC；默认 WS 及业务 / E2E 契约不变。先补 ADR，再实施 NQ-09～NQ-12，未实现部分不记通过。

2026-11-04 当前决策：在现有 Relay 路径下提供可互换的 WS / QUIC adapter；首次连接和运行中切换使用同一选择入口，详见 §3。QUIC 按现有 ctl/msg/bulk 拆为三流并使用 Go 原生优先级，详见 §6。§8 给出原业务契约、适用优势与量化验收。当前 v2 三流、双端运行中切换和每 Host 模式存储已实现；代码自动验证、设备及线路收益分别登记，尚未发布。

范围修订：保留历史故障回归与现有资源护栏，但撤回“新增 Node↔Go 信用协议、全链路预算重构、端到端 epoch 格式是替换 WS 的统一前置条件”。先复用现有协议和恢复入口，仅对测试证实的传输边界差异做必要修改。历史依据见[原生传输回归](../../native/relayquic)，实施范围以本文为准。

NQ-00～NQ-08 的实施依次覆盖共用接口与选择、Relay-only 切换、三流与平台接入、因果屏障、原功能回归、性能与设备门禁。NQ-01～NQ-06 已接入；NQ-07 保存原功能基点与候选对照；NQ-08 仍有设备、完整压力与现场门禁，证据与缺口见 [原功能回归记录](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-functional-regression.md)。

基点：`df02972350e00ee4330b311831626b71c8035678`，独立工作树 `orbis-native-quic` / `feat/native-quic`。主工作树 ADR-0062 / r44、ADR-0063 / R62 / r45 多语言及 R63 / r46 回复卡片增长不纳入本分支。为避免合并编号冲突，本专项于重启续跑时由 ADR-0063 / R62 改为 ADR-0064 / R64，随后改为 ADR-0065 / R65，本轮活动回归号改为 R67；历史提交与证据保留原号，不改写原始结果。

关联：[ADR-0050](0050-fixed-lan-relay-routing.md)、[ADR-0060](0060-mobile-relay-history-performance.md)、[ADR-0010](0010-write-layer-slicing.md)、[ADR-0011](0011-nonce-slot-and-high-watermark.md)、[ADR-0037](0037-session-sync-transaction-contract.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)。显示约束：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) S18 / S23、V05、V09–V12、V16–V18、V22；验证：[UI 回归](../../AGENTS.md#测试) R67。

## Context

用户观察：手机直连 Relay 不稳定；手机通过部署在**同一台 Relay 服务器**的 Hysteria 2 代理访问 Relay 后稳定。该对比支持验证手机到服务器公网段的 QUIC 承载，但尚不能区分拥塞控制、UDP/TCP 路径待遇、地址族、DNS 或连接管理的贡献，不能宣称已证明 QUIC 的收益或承诺复现 Hysteria 2 的效果。

当前 Relay / Host 使用 Node `ws`，Android 使用 OkHttp WebSocket，iOS 使用 URLSessionWebSocketTask。`ctl / msg / bulk` 是应用队列与密码学通道，最终仍共用可靠有序传输。首版只替换移动端 ↔ Relay 公网承载；Host ↔ Relay 与 LAN 保留既有 WS，以隔离本次现场变量。端到端协议、Host 权威状态和同步事务不变。

## Decision

### 1. 实现与边界

- 新增独立 Go 模块 `native/relayquic`：以固定版本的 quic-go 提供原生 QUIC 服务及 Android gomobile 绑定。iOS 直接使用系统 Network.framework 的 QUIC 实现。
- 服务作为与现有 Node Relay 同机的独立进程，终止 QUIC 后仅连接配置好的 loopback WS `/v1/device`。它是 Relay 的传输适配器，不是通用代理；客户端不能指定目标主机、端口或任意 URL。限制连接数、握手时间、首帧和消息长度；写入完成与业务应用分开，端到端背压须满足 §7，不能仅以 loopback 写入完成作为公网进展。
- 客户端直接从 App 建立 QUIC，用户无需运行 VPN、系统代理或 Hysteria 2。首版不移植 Brutal，不宣称连接迁移已验收，不引入 WebTransport、HTTP/3 WebSocket 或不可靠 DATAGRAM。
- 最终方向为每连接按 `ctl / msg / bulk` 映射三条可靠有序流，Go 发送端采用 quic-go 原生优先级，详见 §6。禁止 0-RTT 业务数据；保留每通道 FIFO、分片、高水位、E2E 和接收预算。原单流候选用于功能对照，三流的握手 / bootstrap 顺序必须通过专项测试才能发布。

### 2. Wire 与端点

本节 `orbis-relay-v1` / version 1 保留为**历史单流对照**。生产命令入口现在只接受 §6 的 `orbis-relay-v2`，Node 发现返回 v2 ALPN；v1 实现仅由历史测试夹具使用。两者不猜测兼容，不共享角色握手格式。

- ALPN 为 `orbis-relay-v1`，TLS 1.3，验证 Relay 域名与系统信任链；不提供生产跳过证书校验开关。QUIC 外层 TLS 不替代 Host ↔ App E2E。
- 一帧为 `uint32BE(UTF-8 字节数) + JSON UTF-8`，上限 2 MiB，0 长度、超长、截断、无效 UTF-8 或非 JSON 对象均关闭。单独的传输版本不修改现有 `protocolVersion` 硬门槛。
- 首帧固定为 `{"type":"transport.open","version":1}`。服务建立本机上游 WS 后回复 `{"type":"transport.ready","version":1}`。只有收到有效 ready 才进入现有 device.authenticate / pair / hs；传输 ready 不表示配对成功、E2E 就绪、目录就绪或操作成功。
- Node Relay 新增 `GET /v1/transports`，返回 `{"version":1,"quic":null}` 或 `{"version":1,"quic":{"port":443,"alpn":"orbis-relay-v1"}}`。仅部署明确配置端口才宣告 QUIC；端点域名固定取原 Relay URL，不接受第三方地址。该入口可经现有 `/relay/` 路径前缀反代。
- App 仅对 HTTPS/WSS Relay 探测该 HTTPS 入口，最多等待 1 秒；本地 HTTP/WS 隔离夹具继续使用 WS。发现不可用 / 无 QUIC 则连接原 WS。宣告中的未知版本、ALPN 或非法端口不作为可用 QUIC。
- TLS 证书、UDP 监听端口、loopback 上游和公开元数据由部署者显式配置；Hysteria 2 若已占用某 UDP 端口则另选空闲端口。TCP 与 UDP 可同号，两个 UDP 服务不得竞争同一地址端口。

### 3. WS / QUIC 可互换与运行中切换

**抽象位置**：在 Android `RelayClient`、iOS `WebSocketTransport` 的 Relay socket 边界增加平台各自的传输接口；`HostConnection` 以上继续看到同一条 Relay 路径。NQ-01 实际命名为 `RelaySocketConnection`，避免与 Android 既有 `RelayConnection` 业务状态枚举、iOS 既有 `RelayTransport` 业务类冲突。Android 使用本地 listener / String / ByteArray，iOS 使用本地 `RelayMessage`，SDK WebSocket 类型只在 adapter 内转换。每次新建的连接对象身份绑定本地回调，`start()` 完成未认证准备；发送 lane 来自已有信封 ch。v2 按 lane 独立写入，close/join、每 Host 配置与受控交接已接入；WS 仍使用原串行发送。

| 接口 / 事件 | 契约 |
| --- | --- |
| `prepare(endpoint, attempt)` → transportReady | 只建传输；WS 完成 upgrade，QUIC 完成 transport.ready；不发送凭据、HS1 或任何业务 |
| `send(frame, lane, generation)` → accepted / rejected | lane 来自已有 hdr.ch，引导帧为 ctl；同 lane FIFO。accepted 仅表示本地接收，不能结算操作；部分写失败使当前连接失败，不在新连接重写 |
| `onFrame(frame, generation)` / `onClosed(generation, cause)` | 归属校验后交给原解析 / E2E；旧回调不能影响现任连接。每 lane 有序，接收不要求跨 lane 的总序 |
| `close()` / completion | 幂等取消发现、拨号、读写、timer 并等待本地任务结束；完成不等于远端收到关闭 |
| `kind` / queuedBytes | 诊断当前 ws/quic 与本地积压，不作为业务 ready 或公网交付凭据 |

模式在每个已配对 Host 的连接配置中保存，键用稳定 Host 身份，不保存到 E2E 密钥或业务消息。`setRelayTransportMode(mode)` 是首次连接、设置变化和重连的共用入口；本轮先定义内部 API，不新增设置页 UI。模式是**期望值**，状态同时记录 `actualTransport`、`phase`、`switchError`，避免设置显示 QUIC 却把仍工作的 WS 写成切换成功。

| mode | 首次 / 断线后连接 | 已有健康连接时修改模式 |
| --- | --- | --- |
| ws | 直接 WS，不做 QUIC 发现或拨号 | 已为 WS 则无操作；否则准备 WS 候选并交接 |
| quic | 必须成功使用 QUIC；无宣告、UDP / TLS / 版本失败明确返回错误，不静默回退 | 已为 QUIC 则无操作；否则准备 QUIC 候选。准备失败保留旧连接、报告切换失败，actual 仍为原传输 |
| auto（显式选择；尚未启用为发布默认） | 同主机 HTTPS 发现最多 1 秒，QUIC 准备最多 1.5 秒；准备失败销毁候选后连 WSS | 保留当前健康连接，下一次正常重连再按 auto 选择，不定时探测升降级或按 RTT 来回跳 |

本候选未通过完整设备 / 性能门禁，未保存偏好的 Host 默认使用 **ws**。可显式选择 quic 或 auto；已有已保存模式继续生效。

回退仅限业务认证开始前；明确认证拒绝、业务版本错误、E2E 失败不会被隐藏成“再试 WS”。连接运行后故障走原重连 / 对账，auto 可以为**新连接**重新选择承载，但不能重发上条连接的密文或用户命令。强制模式在后续重连继续生效。回退保持 WSS 证书验证，不降至明文或旧业务协议。

**切换是受控重连，有短暂 Relay 空窗；不是迁移同一 E2E 会话。** 每个 Host 的连接拥有者串行处理以下状态，最多 active + 一个未认证 candidate：

1. `active(A) → preparing(B, attempt)`：A 照常服务，B 只到 transportReady。B 失败 / 取消时关闭 B，A 的 E2E、LAN 和业务都保持。candidate 没有认证权。
2. `preparing → retiring(A)`：确认 attempt 仍是最后请求，冻结 A 的新 Relay 发送，撤销 A 的 generation，再关闭 A；清理 A 的传输队列、重组器和 Relay E2E 状态，不把旧密文搬给 B。已在处理中的 UI / worker 结果按原归属规则隔离。LAN 继续服务，不调用会关闭 LAN 的顶层 disconnect。
3. `retiring → authenticating(B)`：本地 A 任务结束后，只给 B 一次认证权。不能无限等待断网的远端 close；Node 必须在 B 的有效 device.authenticate 到达时，原子移除同 deviceId 的旧连接、停止旧 socket mux、关闭旧 socket。旧连接的迟到上行要检查当前归属并拒绝；旧 close 只能删除自身记录。错误凭据不得摘除当前连接。
4. `authenticating → handshaking → active(B)`：沿用 device.authenticate、HS1/HS2/HS3、Host 加密 bootstrap、目录 / 同步恢复。传输 ready 和 Relay 明文 device.ready 都不能作为切换业务就绪证据；三流发送 / 投递屏障见 §6。旧路径已退休之后若 B 失败，按期望模式重新连接，不复活旧 channel，也不自动回滚重放命令。
5. 任意阶段收到更新请求：只保留最后的 mode，取消未获认证权的候选；已经进入交接的请求在同一拥有者内串行结束 / 取消，再建立最新连接，不同时启动两个认证。相同 mode 请求幂等；改回当前 actual 时取消候选即可。换 Host、撤销配对和退出时取消 active / candidate 及重连 timer，迟到 ready 只能关闭自己。

`attempt` 标识一次候选准备，`generation` 标识实际连接；两者都不冒充 E2E epoch 或来源 source epoch。适配器不持有业务 outbox：从未提交给传输的操作仍由原等待队列决定何时发送；曾被接受、部分写入或可能已执行的操作保持 unknown / unconfirmed，按 ADR-0049 / 0055 对账，不能因更换承载再提交。文件继续按 durableOffset / Host pull 缺口恢复，下载、上传、同步各用原完成依据。

**最小改造入口**：Android 从 `connect()` 内的 openRelay / relayDown 提取 Relay 专属生命周期，保留 LAN、消息 sink 和配对上下文；iOS 从 openSocket / socketClosed / resetChannel 提取同样入口，不能调用会关闭 LAN、清 activePath 的 closeConnection。只清理当前 Relay 的 worker / 队列，不能连带清 LAN 已认证投递。Node 加同设备认证接替和旧连接上行守卫。Host 业务、LAN 排序和文件 / 同步状态机保持；不把 WS/QUIC 加入 LAN>Relay 的路径排名。

QUIC 保持 10 秒传输 keepalive、30 秒 idle timeout；设置延迟继续测 Host 端到端往返，不将握手耗时或 QUIC ACK 当成业务完成。

### 4. 资源、发布与可观测性

- Go 当前通过应用关闭码区分容量 / wire / 写失败并限制共享队列；完整多层字节、队列年龄和 Node / Go RSS 采样仍是 Q13 的发布门禁，不能声称已具备全链路观测。诊断不记录凭据、聊天正文、密钥或首帧原文。上游固定 loopback，禁止通过用户首帧转为开放代理。
- Android AAR 从固定 Go 依赖生成，生成物留在固定 app/build 下，由构建脚本和 Gradle 任务衔接；不提交平台二进制。iOS 无新增第三方运行时。部署服务独立启停，移除宣告即可令后续连接回到 WS。
- 服务优先部署并验证 UDP/TLS，再发布移动端。未经用户另行授权不变更生产服务、配对数据或手机安装。实现授权覆盖本地隔离开发与验证。

### 5. 单流候选的写入优先级（历史方案；由 §6 修订）

以下描述早期 v1 候选代码，仅保留作实施 / 测试记录；不再作为最终 QUIC 出口调度决策。WS 汇聚边界仍需应用 mux，QUIC 三流出口改用原生调度。

- 仍按 ADR-0010 的 `ctl > msg > bulk` 严格优先级；逐通道 FIFO，只重排尚未写入 QUIC 的帧。握手 / 配对与非加密协议控制帧归 `ctl`；密文与 piece 仅读取已有 `hdr.ch`，不解密、不按正文猜优先级。持续高优先级负载可能暂停 bulk；首版不引入权重或老化提升。
- Node → Go 的 loopback WS 水位不能代表公网 QUIC 水位，因此 Go 的 WS 读取与 QUIC 写入分离，在最后一个写入者前重新做三队列调度。单连接仅一个 QUIC writer，在每个现有 piece / JSON 帧写完后重新选择最高优先级；写入阻塞提供背压，不追加无限 FIFO 或定时轮询。
- Go 待写队列沿用现有每类内存护栏：ctl 4 MiB、msg 32 MiB、bulk 64 MiB，并限制总帧数。它们是上限，不是预分配或目标在途量。越界显式关闭该路径，交给既有未知结果 / 重连处理，不静默丢已封帧或重放用户操作。循环读取不能在 bulk 队列满时无限等待而永远读不到后面的 ctl。
- 手机出站沿用现有业务分类：iOS 非 bulk 优先且一次一个 send；Android 普通命令为 ctl，`sendUploadChunk` 已经使用 bulk（更正此前“全部 ctl”的判断）。当前 QUIC 候选仍全局串行写入，三流实现须去掉这个跨流阻塞点；接收侧原优先消费与解码预算保持。
- 8 KiB 密文切片契约保持。QUIC writer 完成不表示对端已收取 / 确认，QUIC 内部、UDP 和网络在途缓冲仍存在；不把原 WS 的 64 KiB 水位公式冒充 QUIC 的已验证延迟上界。单流中已写入的低优先级数据不能被后来的 ctl 超越，多流与发送缓冲调优另行实测。
- Q01 增补三队列优先级、同类 FIFO、队列字节 / 帧数上限、取消唤醒与慢读者下 ctl 超过尚未写入的 bulk；真实网络 p95 仍归 Q06。

### 6. 原生优先级与三流设计修订（2026-11-04）

NQ-03 wire：新增 ALPN `orbis-relay-v2`（业务协议版本不变）。手机在同一连接依次打开三条 bidi stream，每条先发送严格三字段 `{"type":"transport.open","version":2,"lane":"ctl|msg|bulk"}`；服务验证三个角色唯一后才建立 loopback WS，并在每流返回同角色的 `transport.ready`。三流全部 ready 才向业务层宣布传输可用；首帧总准备期限 3 秒，手机整个 QUIC 准备仍为 1.5 秒。每条流沿用 uint32BE 长度 + UTF-8 JSON，角色必须与原 hdr.ch 一致，非加密控制 / hs / pair 只走 ctl。保留 v1 的实现和测试作为对照，v2 宣告不会被 v1 客户端误认为可用；发现协议本身仍 version 1，quic.alpn 指明 v2。

Go v2 每流初始接收窗口 256 KiB、最大 4 MiB，连接初始 1 MiB、最大 12 MiB；独立 writer 与有界按流队列，WS 汇聚仍串行。上述是候选上限，须经过 Q09 / Q12 / Q13 量测，不能以窗口值推导吞吐或延迟保证。连接关闭取消所有 reader/writer 并等待退出；同 channel FIFO 不变，跨 channel 不提供总序。

复核固定版本 quic-go v0.65.0 官方文档和标签源码，并追踪 Host 分类、双端上传、nonce 高水位、HS1–HS3、Host bootstrap、片重组、snapshot ACK、pull 窗口及 WS mux。完整来源、代码入口和未定项见 [原生传输实现与回归](../../native/relayquic)。

- **流映射**：一个连接内由手机打开 ctl / msg / bulk 三条双向流，每条声明唯一角色；同一密码学 channel 不按文件 / runtime / 消息拆流，不并发重排同 channel 的 piece 或解密。未知 / 重复角色拒绝，MaxIncomingStreams 和流信用释放按角色生命周期设计。
- **Go 调度**：每流独立 FIFO writer，使用 `SetPriority`，初始候选 ctl `(0,false)`、msg `(3,true)`、bulk `(7,true)`。数值表达现有相对顺序，不是权重或测得的最优值；不再在一个 QUIC writer 前另造网络调度器。Host / Node WS mux、Go → WS 的汇聚和业务准入保留。Android 已采用三个逐流 IO worker，Apple 已把 isSending 改为逐 lane 在途集合；WS 保持单写入者。
- **能力边界**：固定版本先处理丢失 STREAM 数据，再发新 STREAM 数据；新 ctl 不保证越过 bulk 重传。所有流共享拥塞窗口和连接流控。同属 msg 的历史与 live、同属 bulk 的文件与工具详情仍有竞争。继续保留 8 KiB 密文切片，不把应用 ctl 与 QUIC ACK 等传输控制帧混淆。
- **因果屏障**：transport.ready 不代表 E2E ready。HS3 必须先于所有 channel 的业务到达 Host；手机应用已认证的 Host bootstrap 之前，提前到的 msg/bulk 有界暂存，不进入业务。先用现有 WS 行为作基线，测试 host.online / HS1 时旧队列和分片，再在传输投递 / 重连边界补必要的屏障或清理；不预设新增端到端 epoch 字段。Go → Node 仍为一个 writer，HS3 先行；手机新业务须等待 Host 认证确认，不能只等本地 HS3 写完。重新建 QUIC 本身不能证明上游旧队列已清空，Q10 未通过不能发布三流。
- **资源与业务确认**：重审现有 64/256 KiB 窗口，按三端实际接收方向、BDP 和适配器自身的总量限制选值；不把业务 pull 窗口机械复制成 QUIC 窗口。保留 Host snapshot / detail / artifact 准入以及接收消费溢出恢复。Go 候选 100 MiB/连接不能直接当部署容量，连接数与窗口须通过 Q09/Q13。Write、QUIC ACK、socket 写完均不替代 SQLite applied、snapshot ACK 或操作对账。
- **Apple**：iOS 15+ 的 NWMultiplexGroup / NWConnectionGroup 可承载同连接多流；使用 group 创建流，不能用三个独立拨号代替。公开 ContentContext.relativePriority 文档未证明与 quic-go 跨流 urgency 等价；下行由 Go 原生调度，上行需互通验证后确定原生 API 或替代实现，不能写成已具备同等保证。
- **实施边界**：复用现有分类、分片、加密和消费入口，改动集中在 socket adapter、逐流 writer、Relay 专属生命周期和握手投递边界。原 v1 测试保留；Apple 同连接三流已在本机真实 Network.framework 互通，iOS 设备、上行调度收益与现场门禁仍独立验证。

#### 实施补充：生命周期、bootstrap 与预算

- Android `HostConnection.setRelayTransportMode` 与 iOS 同名方法按 Host 保存模式；`RelayClient` / `RelayTransport` 公开 desiredRelayMode、relayTransportKind、relaySwitchPhase、relaySwitchError。准备、退休、认证和重连共用同一拥有者；旧接收、关闭、写完成不能清理新连接。正常重连也等待本地退休完成。只切 Relay，不关闭 LAN，也不重放已被接受的操作。
- Android cancelAndJoin 等待原生 worker 与 OkHttp 终止通知；Apple cancelAndWait 等待三个 stream、group 和 URLSession 的取消通知。Apple SDK 的 `connection_group.h` 明确禁止 group 启动后替换 state handler，故在启动前安装一次回调并保留取消 latch。真实测试复现了替换 handler 导致关闭等待不结束，修复后退出完成。
- Apple 的 group 使用 `isDatagram = true` 避免预留隐式 stream 0，再抽取三条**可靠双向**流；实测 stream ID 为 0、4、8。业务不使用 DATAGRAM，服务不启用 DATAGRAM。该开关是 group 构造方式，不把业务改为不可靠数据报。Apple 上行采用系统调度，没有将 ContentContext.relativePriority 冒充 SetPriority；Go 服务下行和 Android 上行使用原生优先级。
- QUIC 在 HS2 后仅发送 HS3；直到收到 Host **加密 ctl device.ready** 才开放 msg/bulk 读取及普通发送 / 上传。明文 Relay device.ready 不开启屏障。WS 沿用原时序：iOS 等 HS3 写完成回调成功后才标记安全连接就绪，Android 保留原发送接受后的就绪语义，避免更改既有 LAN 恢复行为。现有消费队列仍先处理 ctl；该屏障不代替 SQLite applied 或业务 ACK。
- 先复现 Host 在 HS2 后继续发旧队列分片，再将 DeviceLink 原有 mux 重置提前至 HS1 有效后的 handshake-reply 边界；confirmed 处的重置仍保留。另用定向测试复现 Node 与 Go 排队旧密文越过 HS2：Node 在已认证 Host 的 hs 边界停止 / 删除该设备旧 mux，Go 在有序 loopback HS2 到达时释放尚未写出的旧队列；已进入 socket / QUIC 的旧密文无法撤回。Apple decoder 仅在 QUIC 新会话、该 lane 首个有效认证帧之前，允许有界忽略 **AEAD 认证失败**（ctl/msg/bulk 各 8/40/72 MiB 编码密文容忍预算；上游排队已在握手边界清理，仅容忍剩余在途，不保证接受任意陈旧流量）；格式错误仍失败，首次有效帧后恢复严格认证失败语义，失败不推进高水位。Android 保留原认证失败处理与高水位规则。未增加业务 epoch 字段。
- Go 默认最多 16 个连接；双向、所有连接共用 **128 MiB 待写队列护栏**，逐类 4/32/64 MiB 和 16384 帧限制仍有效。出队 / 取消准确归还预算，不静默逐片丢弃。共享护栏不含在写帧、QUIC 窗口、Node 缓冲、分配器与 TLS 开销；保守另计每连接最多 8 个 2 MiB 读写帧，以及最大 12 MiB 接收窗口。总 RSS 必须实测，不能把 128 MiB 写成进程内存上限。提高连接上限须重新做 Q13；日常背压不靠反复撞护栏重连。

### 7. 历史故障对本次设计的约束（2026-11-04）

逐项依据、源码入口和旧决定的替代关系见[原生传输回归](../../native/relayquic)。本节补充 §6，并明确 §5 的队列越界关闭只是 v1 候选记录。

- **按层处理压力**：Host 按 ADR-0013 / 0044 在 seal 前准入，普通队列超预算时仍允许明确摘除路径；Go / Relay 持有密文，不擅自丢片、合并业务或重放命令；手机只对已认证、重组完成的载荷执行 ADR-0040 的有界丢弃 / 计数 / 限频恢复，不因此断线。不能用其中一层的规则覆盖另外两层。
- **桥接压力做对照验证**：Node 的 mux.enqueue 并不执行硬性准入，Go 读空 loopback 可能隐藏公网积压，停止单条 WS 读取又可能挡住后续 ctl / ping。保留现有 Host 准入、WS mux 和适配器有界队列，Q13 对照 WS 测积压 / 心跳 / 回收。若出现新增失控，修复造成差异的适配边界；不先引入新的 Node↔Go 信用协议或业务流控协议。容量耗尽可明确使路径失败，但日常负载下重连风暴不通过验收。
- **资源预算限制适配器自身**：限制连接数、待写字节 / 帧数、在写帧和 QUIC 窗口，并验证取消释放；100 MiB/连接不是服务器总体保证。测量 Node / Go RSS 与队列，不用扩大缓存掩盖问题。不重构既有来源 100ms 合并、snapshot / detail / artifact 准入或手机消费预算；若独立发现旧系统问题，另记问题而不扩大本轮目标。
- **保留业务恢复与因果**：下载按 durableOffset 补洞；上传按 Host file.upload.read、每上传一块在途和 writing gate，最终校验 / 完成由接收方决定。同步保留稳定身份、pending、进展租约、有效 applied ACK 及终态单调；可能执行的操作保持 unknown / unconfirmed 并核对。控制流优先不赋予 ctl 状态清除较晚 msg 的 head/live 或提前结算操作的权限；source epoch/seq、E2E 序号与 transport generation 分开。
- **验收包含快网与持续压力**：既测弱网交互，也测快网 / 高 RTT 吞吐、WS 节拍、同通道竞争和消费成本。QUIC 单段连通不能替代旧故障组合回归，更不能用历史 ADR 的数据当本次结果。Q11–Q13 保留为验收，不以新增业务协议作为完成它们的预设手段。

### 8. 替换边界、收益条件与发布标准

```text
原：Host DeviceLink → HostRelayClient WS → Node Relay → 公网 WSS → 手机原接收 / E2E / 业务
新：Host DeviceLink → HostRelayClient WS → Node Relay → 本机 WS → Go QUIC → 手机 adapter → 同一接收 / E2E / 业务
选择：手机 RelayTransport = WSAdapter | QUICAdapter；LAN 仍是独立且优先的路径
```

| 原逻辑与代码依据 | 替换后如何保持 |
| --- | --- |
| `DeviceLink.send / sendBinary / sendToolContent / sendSessionSnapshot`、`channelForDeviceMessage` | 业务分类 / 准入原样；adapter 只读已有 ch，不能重分类加密内容 |
| E2eChannel 每 channel 序号、高水位、方向密钥；8 KiB piece、16 个重组槽、32 Mi 字符、60 秒过期 | 一条 channel 对应一条有序 QUIC 流，序号域 / 分片格式不变；新连接重新握手，旧密文不搬运 |
| snapshot 写完只代表 sent，SQLite applied / ACK 决定应用事实 | QUIC send / ACK 不替代业务 ACK；稳定 syncId、进展租约、终态单调保持 |
| 下载按 durableOffset / 缺口 pull；上传由 Host read 驱动、每任务一块在途、writing gate | 切换后继续原缺口恢复；最终 hash / 完成仍由原接收者决定。上传 write 后推进的 durableBytes 不新增逐块 fsync 承诺 |
| 原操作账本的 pending / unknown、Host 声明的消息身份，来源 epoch/seq | 原状态机对账，不因承载改变生成新 opId 或自动重放；缓存、已加载历史、阅读锚点不清空 |
| LAN>Relay、多 Host 独立状态、端到端探针 | 切换只作用于选定 Host 的 Relay，保持 LAN 和其他 Host；网络握手不冒充应用就绪 |

| 场景 / 层面 | 理论优势与边界 |
| --- | --- |
| 公网丢包，bulk 与 ctl/msg 并发 | 三流减少跨流有序交付等待；Go 原生 priority 让可发送的新 ctl 优先。仍受共享拥塞窗口 / 连接流控限制，bulk 重传可能先于新 ctl |
| bulk 接收流暂时受阻 | 连接仍有信用时其他流可继续；每流独立 writer 才能发挥作用。单流 v1 不能证明这一优势 |
| 当前 TCP 路径待遇较差、UDP 路径较好 | 可能改善，同机 Hysteria 体验是验证线索；需排除 DNS / 地址族 / 拥塞控制差异，不能保证复现 Brutal 速度 |
| 干净快网、单一通道、Host↔Relay 已堵、手机解码 / SQLite 慢 | 不承诺改善；同 msg 的历史/live、同 bulk 的文件/详情仍竞争，增加 sidecar / 发现也可能带来成本 |
| Wi-Fi / 蜂窝切换 | 本轮依靠既有重连恢复；尚未实现平台网络迁移接线，不能将库的 NAT rebinding 能力记成已交付无感切网 |

功能发布门槛：Q01–Q05、Q07–Q11、Q13–Q14 受影响项目全部通过，既有测试不删除 / 放宽；完整双端设备门禁另记。Q12 使用**同一加密业务、相同服务端 / 手机配置**做 WS / QUIC 交错对照：无损快线 RTT 5 ms / 100 Mbit/s 和 RTT 100 ms / 50 Mbit/s，各预热 10 秒、测量 60 秒、各 5 轮，报告应用有效字节吞吐中位数，QUIC 目标不低于 WS 的 90%。模拟 1/5/50 Mbit/s 持续负载检查资源稳定，结束后所有本任务连接 / writer 回收。

收益门槛（目标，尚未测得）：在公网段双向独立随机丢包 1%、RTT 100 ms、10 Mbit/s、大 bulk 连续下载，同时每 100 ms 一次小 ctl 请求 / 响应的固定夹具中，5 轮各 60 秒；以每轮应用 RTT p95 的中位数比较，QUIC 目标比 WS 降低至少 30%，业务内容 / 顺序零错误。记录重传、连接窗口不足及长尾，不用丢掉超时样本改善结果；未完成请求算失败。Q08 另用暂停 bulk reader、连接信用充足的确定性测试证明 ctl 在恢复 bulk 之前完成，不以墙钟性能代替正确性。未达收益门槛不把 auto 默认优先 QUIC 当成发布结果，可保留显式模式供后续验证。Q06 仍需同手机真实线路 WS / 同机 Hysteria / 原生 QUIC 对比，实验室结果不能替代现场结论。

### 9. 全链路范围修订与 Host 接入（实施前）

```text
Host DeviceLink / 既有 E2E / piece / mux
  ↔ HostRelayClient 的 WS 或 QUIC adapter
  ↔ 公网 WSS 或 QUIC（三流、Host 专用 ALPN）
  ↔ Relay Go 接入 / Node 原认证与路由
  ↔ 公网 WSS 或 QUIC（三流、原 device ALPN）
  ↔ 手机 adapter / 既有 E2E / 业务
```

两段公网都可改为 QUIC，Relay 保持零知识转发；不是 Host 与手机绕过 Relay 建立点对点连接。Go 与 Node 的同机接口不作为公网链路：Relay 继续固定 loopback WS，Host 使用按 lane 分离的有界本机 IPC；保留 Node 认证、路由、原 mux 与所有业务，不以改写业务或引入代理 VPN 完成替换。

**Host 与 Relay 接入：**

- 新增 `orbis-relay-host-v2` ALPN，仍使用 version 2 的三流角色握手与原帧格式；设备的 `orbis-relay-v2` 不变。服务器按协商 ALPN 选择配置中固定的 `/v1/runtime` 或 `/v1/device` loopback 上游；客户端不能指定代理 URL。两种角色共用总连接数 / 队列预算，Node 仍验证 runtime / device 凭据和身份。
- 发现响应只有显式启用 Host 接入才增加 `quic.hostAlpn`；Host 只对原 Relay 域名的 HTTPS 发现，验证端口、ALPN 与 TLS。没有 Host 宣告时强制 quic 失败、auto 在认证前回到 WSS；不向旧 device QUIC 服务发送 runtime 凭据。
- 公网短跑已在约 450–675 ms 的双段业务 RTT 下复现强制 QUIC 的 1 秒 HTTPS 发现超时。2026-11-04 修订：显式 `quic` 的发现 / 原生准备预算分别为 3 秒 / 5 秒；`auto` 保持 1 秒 / 1.5 秒以限制回退等待。认证仍为 10 秒，不在认证后回退。此为产品连接策略修订，修改前失败证据保留，正式测量必须标明采用新预算，不能仅在测速夹具中放宽。
- Node Host 继续使用受支持的 Node 运行时，以随安装包生成的 Go helper 复用 quic-go；开发态可指定 helper 路径。helper 不读用户账号配置，不在命令行 / 日志输出凭据、密钥或内容。macOS / Windows / Linux 编译路径统一，发布包包含本机架构 helper 与依赖许可。
- helper 仅监听回环随机端口，stdin 传一次性随机 token 与固定远端配置；三条本机连接分别承载 ctl/msg/bulk，验证 token / 角色后才开放。每 lane 独立读写，避免用单个 stdin 或测试 WS 桥重新制造跨流阻塞。父进程退出、stdin EOF、取消、任一 lane 失败会关闭整条路径并等待所有任务退出。
- IPC 回执只表示该帧已完成本地 QUIC writer 调用，用于释放 Host adapter 的待写字节；不冒充公网送达、业务 ACK 或落盘。每 lane 保留 4/32/64 MiB、16384 帧与总量护栏，字节 / 帧数溢出关闭路径，不能丢弃或跨连接重放密文。既有 DeviceLink 封帧前准入与 8 KiB pieces 保留。

**两段切换与业务恢复：**

- Host 配置 `relayTransport`（ws/quic/auto）以及 `ORBIS_RELAY_TRANSPORT`；HostRelayClient / HostService 提供同一个运行中切换入口，报告期望模式与实际承载。候选只准备传输，准备失败保留现任；最后请求获胜，旧路径本地 close/join 后才给新路径 runtime.authenticate。手机侧既有切换入口保持。
- Host 更换 Relay 承载沿用原 Relay 断开 / 认证 / `host.online` / E2E 重握手：只摘除 Relay，LAN 和本地 Agent / 操作账本 / 文件事务不停止。已接受操作保持原 pending/unknown，不自动重新执行。认证失败之后不能悄悄回 WS。
- Host 一个 Relay 连接服务多台设备。重握手清理只能按原信封 from/to 身份定向退休旧队列；不得因为 A 设备握手清掉 B 设备的密文。Node 的旧 runtime 连接也必须先撤销归属、停止原 mux，再允许替代连接接管；旧上行、迟到 close 不得污染现任。
- 新 Host 三流入口验证 runtime.ready / HS3 / bootstrap 因果、同 channel FIFO 与多设备隔离；沿用原 E2E 序号和业务版本，不增加跨端 epoch / ACK 协议。

**验收：**

| Ticket | 必须交付及验证 |
| --- | --- |
| NQ-09 | Host ALPN / 固定上游、发现、两种身份与总预算；错误 ALPN / 路由 / 凭据不能抢占现任；多设备队列不被误清 |
| NQ-10 | Host 原生 helper / 有界逐 lane IPC / ws-quic-auto / 运行中切换 / 配置与打包；取消、进程退出、慢 lane、无泄漏、认证前回退与最后选择获胜 |
| NQ-11 | 原 HostService / E2E / 文件 / 交互套件按 Host/手机 `WS/WS`、`QUIC/WS`、`WS/QUIC`、`QUIC/QUIC` 四列复跑；任一侧切换、重连、bootstrap、LAN、多设备及未知操作不重放，保留原断言 / 失败基点 |
| NQ-12 | 完整公网路径 Host→Relay→客户端 的双向有效吞吐、端到端加密业务 RTT p50/p95/p99、失败 / 超时 / 恢复，五轮交错；分别记录两段实际承载、Host / Relay / 客户端位置和代理 / 地址族。真实手机与参考客户端分别标注；单侧或回环不计整链路实测 |

Q06/Q12 的弱网与快网门槛继续有效，新增要求两段均实际使用所声明承载。真实线路要先确认部署拓扑、UDP 可达及客户端路径，不能把网站前置反代当作真正 Relay 主机，也不能把本机代理 fake-IP 当作直接公网地址。生产发布仍走已有部署入口；本次先完成本地可审阅实现和测试，不改变用户配对或现有生产服务。

## Verification

[测试规则](../../AGENTS.md#测试)；[host-service.test.ts](../../packages/host/src/host-service.test.ts)；[原始证据](../../.artifacts/)。

## 实施与验证记录

[根部测试约束](../../AGENTS.md#测试)；[relayquic](../../native/relayquic)；[src](../../packages/host/src)；[run-native-quic-perf.py](../../scripts/run-native-quic-perf.py)。

## 依据

- RFC 9000（QUIC streams、flow control、connection lifecycle）：https://www.rfc-editor.org/rfc/rfc9000.html
- quic-go 官方文档：https://quic-go.net/docs/
- Apple Network.framework `NWProtocolQUIC`：https://developer.apple.com/documentation/network/nwprotocolquic
- Go Mobile：https://pkg.go.dev/golang.org/x/mobile/cmd/gomobile
- Hysteria 2 协议：https://v2.hysteria.network/docs/developers/Protocol/

2026-11-04 v2 实施：三流、逐流原生优先级、双端选择 / 切换、bootstrap 与旧队列修复已接入。原业务回归及本机专项见 [原功能回归记录](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-functional-regression.md) 和 `.artifacts/quic-review/nq-final-summary.md`；设备与 Q06/Q12/完整 Q13 保持未验收，默认 WS，未部署生产。

2026-11-04 最终本机回归补充：Swift 370/370（含 WS HS3 写完成就绪回归）、Android 693/693；HostService 原 54 项加 3 项业务交接在 WS / v2 QUIC 各 57/57。交接覆盖未确认命令不重复分发、待回答交互、snapshot 未 applied、上传持久前缀 / 在途 read、下载补洞及 SHA-256。Node 全套 1718 项为 1711 通过 / 2 基点已有失败 / 5 原跳过，原 1701 项状态一致，新增 17 项通过。测试桥只接受并报告 v2，原手机参考实现补原协议分片；没有修改原用例断言或超时。Q11/Q14 的真实移动端存储 / 写盘故障组合和设备 / 现场门禁仍未完成，详见 [原功能回归记录](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-functional-regression.md) 与最终证据。

2026-11-04 重启后验证：Android JNI 共享 API 35 专项 1/1，iOS SE / iOS 27.0 App 宿主 `OrbisTransport` 专项 2/2 通过，覆盖 TLS 域名、auto / quic、三流 Unicode / 256 KiB 帧与取消，以及加密业务双向切换、重握手和 LAN 保持。Go 新增生产 30 秒 bulk 写期限及 12 次显式重连 / 上游释放专项，race 全套 28 顶层 / 38 含子用例通过。双端原功能同设备对照完成：Android 含 rich / slow-sync / 原配对补测并去重后，基线 171 通过 / 9 失败 / 2 assumption，候选 173 / 8 / 2；iOS 原 88 项两版均 83 通过 / 5 失败 / 0 跳过。没有新增失败或缺失原用例；已有失败仍保留。默认 WS / preview 原套件与实际 QUIC 专项分别计证，不据此声称完整 QUIC UI、真实手机或线路收益已验收。Xcode 对象编号冲突已消除，重建 App 文件哈希不变；所有本任务资源已核验释放。证据见 [原功能回归记录](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-functional-regression.md) 及 `.artifacts/ui-regression/20261104-native-quic-reboot/`；完整事务 / 写盘故障、RSS / 长期压力、线路 / 人工和 iOS 17 缺口保持。


2026-11-04 全链路实现 / 本机验证：§9 / NQ-09～NQ-11 已落地，四种 Host/手机组合各 104/104、Node 默认全套 1727 通过 / 0 失败 / 5 原跳过、Go race 含真实 Node 45 测试事件通过，macOS runtime 包内 helper 默认路径 QUIC→WS→QUIC 通过。Host 断链专项在 QUIC 列关闭 / 重开 Host QUIC 接入而保持手机连接。快照测试明确允许 ctl 受理先到、继续要求原快照，不改变协议为跨流全序；初次失败与修订详见[原功能回归](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-functional-regression.md)。双端原自动对照与专项结果保持原覆盖边界，完整真机 / UI / 手动、Windows 安装器、长期压力尚未验收；公网结果独立记录。

2026-11-04 NQ-12 公网测量 / 报告完成：[完整公网报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-public-performance-20261104.md)覆盖 Mac Host→真正 Relay→同 Mac Go 参考端的两段公网，3 场景 × 2 承载 × 5 轮共 30 次尝试全部保留。QUIC 下载 / 上传有效吞吐中位数为 0.139809 / 0.279618 Mbit/s，加压控制探针 6000/6000 最终返回；下载五轮均排空超时，第 5 轮 p95 12.79 秒。WSS 下载无完整窗口，上行仅 1/5 完成且吞吐相同，不能宣称吞吐提速。临时资源已独立核验释放；生产入口、真实手机 / Hysteria、Q12 性能目标、完整文件及长期容量未通过或未验收，默认 WS 与原发布门禁保持。

2026-11-04 成熟项目复核：[Hysteria / TUIC / Syncthing 源码对照](../architecture/native-quic-peer-project-review.md)查实上游 Reno 与 Hysteria 分支控制器的差异，并量化现有编码和整块计量；本机分片 / backlog 不等于网络 cwnd，不能仅凭窗口、JSON 或 loopback WS 判定公网低速根因。先补连续字节基线、每层供给 / 阻塞和 ConnectionStats / qlog，再决定 adapter 或控制器修订；本轮没有修改实现或改写已保留的公网失败。

同日按用户指令先登记[分层诊断方案](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-layered-diagnostics.md)，再实施隔离 TLS / QUIC 连续字节夹具与业务负载对照。`ORBIS_QUIC_DIAGNOSTICS_FILE` 仅在显式指定路径时启用按秒聚合的传输元数据，缺省不记录，统计不包含正文或凭据；不改变发送调度、窗口、E2E、恢复或默认承载。原 / 流水线负载只属于测试夹具，不能转记为产品上传策略变更。正式结果和清理须独立回查，尚未执行的控制器 / 真手机门禁保持。

分层首轮执行完成：[结果](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-layered-results-20261104.md)保留 D1 的 20/20 原始接收窗口和 D2/D3 的 24/24 双段负载窗口。原负载 QUIC 下载 / 上传中位数约 15.10 / 1.68 Mbit/s，WSS 约 8.81 / 7.55；控制 p95 的场景中位数降低约 62%–95%，吞吐没有一致胜负。独立测试 UDP socket 晚期累计 drops 至少 8184，容器累计 throttling 约 6.46 秒；接收条件、算法和业务供给需进一步单变量对照。20 秒新窗口通过不改写旧 60 秒失败，不等于完整文件 / 真机 / Q12 或发布验收。全部本任务资源已核验释放。

## 10. 先隔离当前聊天与后台历史（2026-11-04）

用户授权先拆最影响体验的业务进行试验。第一步复用现有三条流：ctl 保留原有控制 / execution；msg 保留首屏 preview、手动 history 分页、实时聊天、目录 / 一般状态；后台 catchup snapshot 在显式 relayHistoryMode=background 时走已有 bulk。bulk 仍与文件 / 工具详情共享，本轮不宣称第四条专用流或所有业务已独立。缺省 shared、LAN 与已有 wire 保持。

分类发生在 Host 封帧前，以 SessionSyncTasks 保存的不可变 request.range 为准；DeviceLink 仍执行完整同步准入 / 进展回调 / 路径失败收尾。接收端仍走 k=data 的 JSON 与已有 SQLite/applied/ACK，不把 bulk 的文件可丢规则套给历史而静默停更。逐 lane 在途量仅在真实 QUIC adapter 使用；WS 维持共享 backlog，所有总量护栏不变。

本轮不新增加密通道、nonce 槽位、业务字段或版本探测，保持 18 / 19 的原基础格式；不据帧可解析就宣称真实旧 App 现场验收。源版本 / 基线依赖、单个大 preview、连接拥塞和客户端落库停顿仍可能等待，拆流不保证解决全部卡顿。

实施 / 验收按 [NQ-13 试验方案](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-chat-history-isolation.md)。必须有 shared/background 的受控基线对照、同 lane FIFO / 乱序认证、历史消费溢出恢复及原功能回归；真实公网 / 手机独立测，不以下载或 ctl 探针作聊天通过依据。默认 WS/shared，未验收不得发布为新默认。

NQ-13 试验后修订：最终只对后台 catchup 隔离。手动 history 是用户当前读取需求，与 preview / live 一起保留 msg；不能因为与后台补齐同为旧条目就降级。公网诊断 JSON 的背景速率不统一，结果与边界见[试验报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-chat-history-results-20261104.md)，原数据保留。两段 QUIC 的交互 msg 探针 p95 中位数 6.022→0.569 秒，同时后台 goodput 中位数 6.82→1.15 Mbit/s；这支持隔离方向，不构成手机聊天显示、吞吐或发布验收。实验默认关闭。

## 11. history / catchup / bulk 独立五流（2026-11-05）

用户要求继续拆分，优先级为 history > catchup > bulk；此次只做功能回归，不再执行性能对照或公网测速。保留 ctl、实时 msg，增加独立 history / catchup。preview 留在 msg，手动 history 页走 history，后台 catchup 走 catchup，文件 / 工具详情保持 bulk。Go 原生 SetPriority 的 urgency 分别为 ctl=0、msg=2、history=3、catchup=5、bulk=7；没有新增应用层带宽调度器。

使用明确的 v3 QUIC ALPN / transport version 保留旧 v2 三流，索引 0/1/2（ctl/msg/bulk）不变，追加 3=history、4=catchup。Host helper IPC、Relay adapter、Android JNI 与 iOS Network.framework 均贯通五流；旧端 / 旧发现继续三流。各流 FIFO、旧会话退休、bootstrap 与关闭/join 同样覆盖新流。

加密 channel 增加 history=nonce slot 4、catchup=slot 5，保留 ctl/msg/bulk 的槽位、AAD 与序号规则。不能将共享一个加密 channel 的密文分到独立 QUIC 流。基础 HS1 和认证格式原样保留；支持方在 HS2 可选声明五流能力及其方向密钥认证 MAC，新 App 仅在五流 adapter 上验证后通过带认证的 HS3 显式接受。未声明 / 未接受保持旧 MAC 与三通道，不发送扩展请求给未声明的 Host。能力按每次 E2E 会话重新建立，LAN 不启用。旧客户端、旧 Host、旧三流及 WS 的契约回归保留；能力不能代替业务 applied 或导致重发用户命令。

仍由 relayHistoryMode=background 显式启用，shared 默认与 WS 默认保持。五流不可用时使用 NQ-13 原三流分类，不搬迁已封密文。Host 总同步预算 12 MiB 与事务名额不变；扩展历史通道共用原会话类队列总预算，不靠增加通道扩大累计历史内存。手机将 history / catchup 分别排在 msg 之后、bulk 之前，淘汰 JSON 仍触发原 session overflow 恢复。源版本依赖、SQLite/applied、阅读锚点与消息身份不变；独立到达不允许越过业务提交条件。

验收：新旧端能力与 MAC / nonce / 防重放、五流角色与 FIFO、Host 两侧 IPC、同步 preview/history/catchup + applied/ACK、详情及文件、路径丢失 / 重握手 / WS↔QUIC / LAN 保持和原业务全量；双端核心、构建与同设备原 UI 套件对照。中间失败及既有失败如实保留。此次不新增性能门槛，不使用此前测量承诺五流收益，不部署或安装用户设备。按 NQ-14 留证，未执行的人工 / 真机与发布门禁不计通过。

实施与功能证据见[五流结果报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-five-stream-results-20261105.md)；活动专项 R67，历史证据编号保持原值。核心自动通过与双端设备、既有失败、未执行门禁分别记录。

## 12. 与协议18/19兼容Host集成（2026-11-05）

ADR-0064要求首个有效加密请求绑定Relay业务版本，再发布版本相关ready。QUIC双端因此在同一ctl流依次发送HS3与原有只读host.lan.request，明确携带当前业务版本；其余业务仍等认证后Host ready，不把Relay明文ready当成功。该引导不重放业务命令、不引入新字段或改变旧协议。Node旧18/19与四承载组合、Android引导明文 / 版本和真实Apple↔Go覆盖此顺序，结果见[主分支集成报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-main-integration-20261105.md)。默认WS/shared与既有未验收状态保持。
