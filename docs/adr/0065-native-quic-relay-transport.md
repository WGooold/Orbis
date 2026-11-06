# ADR-0065：Host—Relay—移动端原生 QUIC 与 WebSocket 切换

日期：2026-11-04

Status: accepted（代码、设备门禁、真实线路收益分别验收）

编号修订：2026-11-04 主工作树 ADR-0064 / R64 已用于协议兼容，本专项迁至 ADR-0065 / R65；2026-11-05 主工作树 r47 / r48 已使用 R65（侧边栏）和 R66（消息菜单），本专项活动回归号再迁至 **R67**，ADR-0065 不变。既有 `.artifacts` 中 ADR-0063 / R62、ADR-0064 / R64、ADR-0065 / R65 均为本专项当时编号，原始证据不改写。拆流沿用已部署 18 / 19 的兼容格式；主工作树集成与发布状态分别记录。

**2026-11-04 全链路范围修订：Host ↔ Relay ↔ 手机的两段公网承载均支持 QUIC。最新决策为 §9；此前“首版 Host 保持 WS”的描述与单侧结果仅保留为历史阶段。** 两段公网承载可独立选择 ws/quic/auto，全 QUIC 模式以两段实际 QUIC 为准；默认 WS 及业务 / E2E 契约不变。实施范围为 NQ-09～NQ-12，各项按实际证据记录状态。

2026-11-04 当前决策：在现有 Relay 路径下提供可互换的 WS / QUIC adapter；首次连接和运行中切换使用同一选择入口，详见 §3。QUIC 按现有 ctl/msg/bulk 拆为三流并使用 Go 原生优先级，详见 §6。§8 给出原业务契约、适用优势与量化验收。当前 v2 三流、双端运行中切换和每 Host 模式存储已实现；代码自动验证、设备及线路收益分别登记，尚未发布。

范围修订：保留历史故障回归与现有资源护栏，但撤回“新增 Node↔Go 信用协议、全链路预算重构、端到端 epoch 格式是替换 WS 的统一前置条件”。先复用现有协议和恢复入口，仅对测试证实的传输边界差异做必要修改。历史依据见[原生传输回归](../../native/relayquic)，实施范围以本文为准。

NQ-00～NQ-08 的实施依次覆盖共用接口与选择、Relay-only 切换、三流与平台接入、因果屏障、原功能回归、性能与设备门禁。NQ-01～NQ-06 已接入；NQ-07 保存原功能基点与候选对照；NQ-08 仍有设备、完整压力与现场门禁，证据与缺口见 [原功能回归记录](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-functional-regression.md)。

基点：`df02972350e00ee4330b311831626b71c8035678`，独立工作树 `orbis-native-quic` / `feat/native-quic`。主工作树 ADR-0062 / r44、ADR-0063 / R62 / r45 多语言及 R63 / r46 回复卡片增长不纳入本分支。为避免合并编号冲突，本专项于重启续跑时由 ADR-0063 / R62 改为 ADR-0064 / R64，随后改为 ADR-0065 / R65，本轮活动回归号改为 R67；历史提交与证据保留原号，不改写原始结果。

关联：[ADR-0050](0050-fixed-lan-relay-routing.md)、[ADR-0060](0060-mobile-relay-history-performance.md)、[ADR-0010](0010-write-layer-slicing.md)、[ADR-0011](0011-nonce-slot-and-high-watermark.md)、[ADR-0037](0037-session-sync-transaction-contract.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)。显示约束：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) S18 / S23、V05、V09–V12、V16–V18、V22；验证：[UI 回归](../../AGENTS.md#测试) R67。

## Context

现场观察：手机直连 Relay 不稳定；手机通过部署在**同一台 Relay 服务器**的 Hysteria 2 代理访问 Relay 后稳定。该对比支持验证手机到服务器公网段的 QUIC 承载，但尚不能区分拥塞控制、UDP/TCP 路径待遇、地址族、DNS 或连接管理的贡献，不能宣称已证明 QUIC 的收益或承诺复现 Hysteria 2 的效果。

当前 Relay / Host 使用 Node `ws`，Android 使用 OkHttp WebSocket，iOS 使用 URLSessionWebSocketTask。`ctl / msg / bulk` 是应用队列与密码学通道，最终仍共用可靠有序传输。首版只替换移动端 ↔ Relay 公网承载；Host ↔ Relay 与 LAN 保留既有 WS，以隔离本次现场变量。端到端协议、Host 权威状态和同步事务不变。

## Decision

### 1. 实现与边界

native/relayquic 通过固定版本 quic-go 提供原生服务与 Android 绑定，iOS 使用 Network.framework。传输适配复用既有 Relay 认证、密文路由和业务模型，以固定上游、有界资源及独立生命周期管理连接。

### 2. Wire 与端点

QUIC 帧以 uint32BE 长度加 UTF-8 JSON 封装既有 Relay 消息，ALPN 区分已实现布局与角色；TLS、发现与固定端点共同验证目标。

### 3. WS / QUIC 可互换与运行中切换

WS / QUIC 共用传输接口，按每 Host 的期望模式准备候选、退休旧连接并完成新认证。切换保持 LAN、其他 Host 与业务事务，认证前回退和已接受操作核对由各自生命周期管理。

| 接口 / 事件 | 职责 |
| --- | --- |
| `prepare(endpoint, attempt)` → transportReady | 建立并确认候选传输 |
| `send(frame, lane, generation)` → accepted / rejected | 按既有 channel 和同流 FIFO 接收本地写入 |
| `onFrame(frame, generation)` / `onClosed(generation, cause)` | 核对连接归属并交接原解析与 E2E |
| `close()` / completion | 幂等取消并等待所属任务结束 |
| `kind` / queuedBytes | 记录实际承载及本地积压 |

| mode | 首次 / 断线后连接 | 已有健康连接时修改模式 |
| --- | --- | --- |
| ws | 直接 WS，不做 QUIC 发现或拨号 | 已为 WS 则无操作；否则准备 WS 候选并交接 |
| quic | 使用 QUIC，准备或连接失败返回对应错误 | 已为 QUIC 则无操作；否则准备 QUIC 候选。准备失败保留旧连接、报告切换失败，actual 仍为原传输 |
| auto（显式选择；尚未启用为发布默认） | 同主机 HTTPS 发现最多 1 秒，QUIC 准备最多 1.5 秒；准备失败销毁候选后连 WSS | 保留当前健康连接，下一次正常重连再按 auto 选择，不定时探测升降级或按 RTT 来回跳 |

### 4. 资源、发布与可观测性

连接、队列、窗口和 worker 按所有权有界管理，取消等待本任务资源退出。发布通过现有部署入口，测量分别记录传输、业务应用、资源与设备验收。

### 5. 单流候选的写入优先级（历史方案；由 §6 修订）

单流 v1 候选在写入前按 ctl、msg、bulk 优先及同类 FIFO 调度；§6 以同连接原生多流承接跨类调度，8 KiB 密文切片和接收预算沿用。此节保留为历史方案。

### 6. 原生优先级与三流设计修订（2026-11-04）

同一 QUIC 连接以 ctl / msg / bulk 可靠双向流承载已认证的对应 channel，每流独立 FIFO 与 writer，使用原生优先级。传输 ready、E2E bootstrap 和业务 applied 分层确认，生命周期与总预算按连接统筹。

v2 ALPN 为 orbis-relay-v2，transport.open / ready 使用 version 2；三流首帧期限 3 秒，手机准备预算按连接模式决定。固定 quic-go v0.65.0 共享拥塞窗口与连接流控，bulk 重传仍可能先于新 ctl。Go / Android 使用原生优先级，Apple 上行采用系统调度；iOS 设备收益仍待验证。

参考：[原生传输实现与回归](../../native/relayquic)。

#### 实施补充：生命周期、bootstrap 与预算

连接拥有者串行处理准备、认证、退休和取消，worker 按 lane 管理，业务在已认证的 Host bootstrap 后开放。旧密文按设备身份在握手边界清理，剩余在途按既有认证与预算规则处理。

Apple 同连接三流实测 ID 为 0、4、8；group 构造使用 isDatagram=true，业务仍为可靠流。Go 默认最多 16 连接、全局待写护栏 128 MiB，逐类 4 / 32 / 64 MiB、16384 帧；该护栏只计待写队列，总 RSS 仍需测量。

### 7. 历史故障对本次设计的约束（2026-11-04）

压力按层处理：Host 封帧前准入，传输管理密文顺序与有界路径，手机按已认证载荷恢复消费。同步、文件和未知操作继续依赖既有业务确认，桥接预算及快慢网成本通过对照测量验证。

参考：[原生传输回归](../../native/relayquic)。

### 8. 替换边界、收益条件与发布标准

传输替换保持既有加密、通道顺序、同步、文件恢复与操作对账，收益按同条件 WS / QUIC 对照验证。功能、资源、吞吐、弱网交互和真实手机结论分别记录，默认策略随已取得的证据演进。

```text
原：Host DeviceLink → HostRelayClient WS → Node Relay → 公网 WSS → 手机原接收 / E2E / 业务
新：Host DeviceLink → HostRelayClient WS → Node Relay → 本机 WS → Go QUIC → 手机 adapter → 同一接收 / E2E / 业务
选择：手机 RelayTransport = WSAdapter | QUICAdapter；LAN 仍是独立且优先的路径
```

传输按已认证 channel 承载同流有序密文，握手、分片和重组保持兼容。同步以 SQLite applied / ACK 确认，文件按持久前缀恢复，业务操作按原身份核对；切换作用于选定 Host 的 Relay 路径。

| 场景 / 层面 | 理论优势与边界 |
| --- | --- |
| 公网丢包，bulk 与 ctl/msg 并发 | 三流减少跨流有序交付等待；Go 原生 priority 让可发送的新 ctl 优先。仍受共享拥塞窗口 / 连接流控限制，bulk 重传可能先于新 ctl |
| bulk 接收流暂时受阻 | 连接仍有信用时其他流可继续；每流独立 writer 才能发挥作用。单流 v1 不能证明这一优势 |
| 当前 TCP 路径待遇较差、UDP 路径较好 | 可能改善，同机 Hysteria 体验是验证线索；需排除 DNS / 地址族 / 拥塞控制差异，不能保证复现 Brutal 速度 |
| 干净快网、单一通道、Host↔Relay 已堵、手机解码 / SQLite 慢 | 不承诺改善；同 msg 的历史/live、同 bulk 的文件/详情仍竞争，增加 sidecar / 发现也可能带来成本 |
| Wi-Fi / 蜂窝切换 | 本轮依靠既有重连恢复；尚未实现平台网络迁移接线，不能将库的 NAT rebinding 能力记成已交付无感切网 |

### 9. 全链路范围修订与 Host 接入（实施前）

Host↔Relay 和 Relay↔手机分别选择承载，Relay 继续执行原认证与密文路由。Host 通过打包的原生 helper 与有界逐 lane IPC 接入，固定角色 ALPN 匹配固定上游；运行中切换按设备隔离旧队列并沿用业务恢复。

Host ALPN 为 orbis-relay-host-v2。显式 quic 的发现 / 原生准备预算为 3 / 5 秒，auto 为 1 / 1.5 秒，认证预算为 10 秒；失败与历史测量保持各自记录。

```text
Host DeviceLink / 既有 E2E / piece / mux
  ↔ HostRelayClient 的 WS 或 QUIC adapter
  ↔ 公网 WSS 或 QUIC（三流、Host 专用 ALPN）
  ↔ Relay Go 接入 / Node 原认证与路由
  ↔ 公网 WSS 或 QUIC（三流、原 device ALPN）
  ↔ 手机 adapter / 既有 E2E / 业务
```

| Ticket | 实施范围 |
| --- | --- |
| NQ-09 | Host ALPN、固定上游、认证与共享预算 |
| NQ-10 | 原生 helper、逐流 IPC、模式选择、切换及打包 |
| NQ-11 | 四种 Host / 手机承载组合的原业务回归 |
| NQ-12 | 完整公网路径的吞吐、业务延迟及资源对照 |

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

同日形成[分层诊断方案](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-layered-diagnostics.md)，再实施隔离 TLS / QUIC 连续字节夹具与业务负载对照。`ORBIS_QUIC_DIAGNOSTICS_FILE` 仅在显式指定路径时启用按秒聚合的传输元数据，缺省不记录，统计不包含正文或凭据；不改变发送调度、窗口、E2E、恢复或默认承载。原 / 流水线负载只属于测试夹具，不能转记为产品上传策略变更。正式结果和清理须独立回查，尚未执行的控制器 / 真手机门禁保持。

分层首轮执行完成：[结果](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-layered-results-20261104.md)保留 D1 的 20/20 原始接收窗口和 D2/D3 的 24/24 双段负载窗口。原负载 QUIC 下载 / 上传中位数约 15.10 / 1.68 Mbit/s，WSS 约 8.81 / 7.55；控制 p95 的场景中位数降低约 62%–95%，吞吐没有一致胜负。独立测试 UDP socket 晚期累计 drops 至少 8184，容器累计 throttling 约 6.46 秒；接收条件、算法和业务供给需进一步单变量对照。20 秒新窗口通过不改写旧 60 秒失败，不等于完整文件 / 真机 / Q12 或发布验收。全部本任务资源已核验释放。

## 10. 先隔离当前聊天与后台历史（2026-11-04）

NQ-13 在显式 relayHistoryMode=background 时把后台 catchup 放入既有 bulk，preview、手动 history、实时聊天及一般状态继续使用 msg；ctl 保持原职责。分类由封帧前的不可变 request.range 决定，接收沿用 JSON、SQLite、applied / ACK 和原溢出恢复。默认 WS/shared，LAN 与旧 wire 保持兼容。

原三流的 bulk 与文件、工具详情共享；源版本依赖、大 preview、拥塞和落库仍可能造成等待。试验以 [NQ-13 方案](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-chat-history-isolation.md) 和[结果报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-chat-history-results-20261104.md) 留证。两段 QUIC 的 msg 探针 p95 中位数 6.022→0.569 秒，后台 goodput 中位数 6.82→1.15 Mbit/s；结果适用于该试验，手机显示、吞吐及发布仍待验收。

## 11. history / catchup / bulk 独立五流（2026-11-05）

五流通过已认证能力在每次 E2E 会话中协商，保持旧端兼容、每流 FIFO、独立序号与统一预算；传输独立到达服从既有业务依赖及 applied 条件。

v3 QUIC ALPN / transport version 保留索引 0/1/2（ctl/msg/bulk），追加 3=history、4=catchup。preview 使用 msg，手动历史使用 history，后台补齐使用 catchup，文件与详情使用 bulk。Go 原生 urgency 为 ctl=0、msg=2、history=3、catchup=5、bulk=7。

加密新增 history=nonce slot 4、catchup=slot 5，原三槽、AAD、HS1 及旧 MAC 格式保持。HS2 声明带方向密钥 MAC 的五流能力，HS3 显式接受；旧端与 LAN 沿用原三通道。relayHistoryMode=background 显式启用，五流缺席时使用 NQ-13 分类。Host 同步总预算仍为 12 MiB，扩展历史通道共享原会话队列预算；手机按 msg、history、catchup、bulk 优先消费，溢出沿用原同步恢复。

NQ-14 的范围为功能回归，旧性能数字仍对应原测量布局。实施、双端设备、既有失败与未执行门禁见[五流结果报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-five-stream-results-20261105.md)。活动专项 R67，默认 WS/shared，用户设备、完整人工、真机收益与生产发布仍待验收。

## 12. 与协议18/19兼容Host集成（2026-11-05）

QUIC 引导沿 ADR-0064 在首个有效加密请求绑定业务版本，再发布相应 Host ready。两端在 ctl 依次发送 HS3 与原有只读 host.lan.request，业务开放以认证后的 Host 状态为准。

Node 旧 18/19、四承载组合及 Android / Apple↔Go 的结果见[主分支集成报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-main-integration-20261105.md)。默认 WS/shared，既有待验收范围保持。

## 13. 共享下行配额（NQ-15，2026-11-06）

30 Mbps 出口采用 Relay 设备下行共享 bulk 配额，默认按编码后 UTF-8 帧限制为 2,000,000 字节/秒、突发 64 KiB；文件有效吞吐约 1.5 MB/s。所有 Host / 设备在一个 Relay 进程内共用配额，等待按帧轮转，socket 积压让出位置；交互通道继续按原优先级发送。已封密文留在原 FIFO 等待，旧端单个大帧完整计账，握手与连接生命周期释放等待位置。配置 `ORBIS_RELAY_BULK_BYTES_PER_SECOND=0` 可恢复不限速。Go 每流最大接收窗口调整为 2 MiB，连接总上限 12 MiB；Apple 调整初始额度，后续窗口仍由系统管理。

实现：[共享配额](../../packages/relay/src/bulk-send-budget.ts)、[Relay 接入](../../packages/relay/src/index.ts)、[出站 mux](../../packages/protocol/src/outbound-mux.ts)、[Go 窗口](../../native/relayquic/multistream.go)、[Apple 配置](../../ios/Orbis/Orbis/RelaySocket.swift)。专项验证复用 [mux 测试](../../packages/protocol/src/outbound-mux.test.ts)、[配额测试](../../packages/relay/src/bulk-send-budget.test.ts)、[真实 Relay 双 Host 测试](../../packages/relay/src/bulk-pacing.test.ts)及既有三流 / 五流回归。本机 Node 60/60、Go race 5/5、TypeScript 构建 / 测试类型检查、lint 与 Apple 语法检查通过；首次 HS2 等待失败、原断言与唤醒修复保留在[验证摘要](../../.artifacts/quic-bandwidth-20261106/verification.json)及同目录日志。生产未部署，真实下载期间的交互与吞吐待用户验证。多进程 Relay、其他服务及非 bulk 流量另有出口占用。
