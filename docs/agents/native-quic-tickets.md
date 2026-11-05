# 原生 QUIC 实施 tickets（ADR-0065 / R67）

工作树：`orbis-native-quic`；分支：`feat/native-quic`；基点：`df02972350e00ee4330b311831626b71c8035678`。2026-11-04 开始按 ticket 实施。本文件是本地实施记录，未创建远端 issue。

设计依据：[ADR-0065](../adr/0065-native-quic-relay-transport.md)、[传输源码复核](../architecture/native-quic-transport-review.md)、[历史传输故障](../architecture/native-quic-transport-lessons.md)。原功能验收以[回归矩阵](../testing/native-quic-functional-regression.md)和 [R67](../testing/ui-regression.md) 为准；传输测试、构建成功和设备验收分别记录。

## 顺序与状态

| Ticket | 交付范围 | 依赖 | 当前状态 |
| --- | --- | --- | --- |
| NQ-00 | 整理既有 v1 候选及原功能基点 | — | 已有代码与证据，非最终三流验收 |
| NQ-01 | 双端传输共用接口、ws/quic/auto 选择与强制模式失败语义 | NQ-00 | 代码与自动验证通过；设备门禁待 NQ-08 |
| NQ-02 | 每 Host 模式存储、Relay 专属生命周期及受控切换 | NQ-01 | 已实现；生命周期与真实 Apple 切换自动验证通过 |
| NQ-03 | v2 三流 wire、Go 独立 writer 与原生优先级 | NQ-01 | 已实现；真实 QUIC / E2E / race 验证通过 |
| NQ-04 | Android 三流接入与逐流写入 | NQ-03 | 已实现；JVM / AAR / App 构建通过，JNI 共享 API 35 设备专项通过 |
| NQ-05 | Apple 同连接三流接入与互通验证 | NQ-03 | 已实现；本机及 iOS SE App 内真实 Network.framework 三流 / 加密业务专项通过 |
| NQ-06 | HS3 / Host bootstrap 因果屏障与重握手旧队列隔离 | NQ-02、NQ-04、NQ-05 | 已实现；旧队列先复现后修复、bootstrap / 高水位测试通过 |
| NQ-07 | 原功能全套及切换中业务回归 | NQ-02、NQ-06 | 本机与双端同设备自动对照完成，无新增失败；已有失败与完整组合故障门禁未完成 |
| NQ-08 | 压力、弱网 / 快网对照与双端设备门禁 | NQ-07 | 有界队列 / 四连接慢读 / 30 秒超时恢复及双端原生专项通过；线路、完整压力与人工门禁待验 |
| NQ-09 | Relay 双角色 QUIC 接入、Host 发现与多设备隔离 | NQ-03 | 已实现；Go race 45 个测试事件、Node 双角色 / 归属 / 多设备专项通过 |
| NQ-10 | Host 原生 QUIC helper、逐 lane IPC、切换 / 配置 / 打包 | NQ-09 | 已实现；macOS 完整 runtime 包内默认 helper 切换通过，4 个目标交叉构建；Windows / Linux Host 实机与安装器未验收 |
| NQ-11 | Host / 手机四种传输组合与任一侧切换的原功能回归 | NQ-10 | 本机四列各 104/104；Node 全套 1727 通过 / 0 失败 / 5 原跳过；完整真机 / UI 门禁仍独立未验收 |
| NQ-12 | 两段公网均参与的完整链路测速及报告 | NQ-11 | 30/30 次五轮交错尝试与报告完成；加压控制可用性改善，未证明吞吐提速，QUIC 下载五轮排空超时；真实手机 / Q12 / 发布门禁未通过或未验收 |

## NQ-00：保存原功能基点

- 已实现 Node 同设备认证接替、单流 Go sidecar 与双端候选、测试夹具。
- 原 `host-service.test.ts` 保留原断言 / 超时，WS 与真实 QUIC 各 54/54；全 Node 与同依赖基点逐用例比较无新增失败，原有 2 失败 / 5 跳过保留。
- 证据：`.artifacts/quic-review/functional-summary.md`。单流、参考手机和 Agent 替身的结果不替代原生移动端、真实 Agent、运行中切换或三流验收。

## NQ-01：共用传输入口与选择

- Android / iOS 在 Relay socket 边界定义模式、实际承载、消息 / 回调及发送 / 关闭接口；业务接收、认证和 E2E 不依赖 SDK 的 WebSocket 类型。
- `ws` 跳过发现与 QUIC；`quic` 必须安全发现并完成 QUIC ready，失败明确返回，不静默打开 WS；`auto` 只允许认证前回退。ready 以后断线交给原重连，不重放操作。
- 保留现有业务 JSON、分片、加密、LAN 与调用顺序。此 ticket 不宣称完成运行中切换；准备失败与正式连接失败在 NQ-02 接线。
- 验收：两端选择矩阵、只有胜出路径 ready、取消后的迟到回调无效、发送接受不冒充业务确认；两端原单元套件及构建，原 HostService WS / QUIC 功能套件。映射 Q01–Q04 / Q14。
- 2026-11-04 实施：双端 `RelaySocketConnection` 隔离 SDK WebSocket 类型；Android `connect(..., relayMode)`、iOS `RelayTransport(relayMode:)` 接入模式，`relayTransportKind` 独立报告实际承载。v1 保留单流，lane 由原 hdr.ch 传入；此处不更改业务分类 / 调度。
- 自动结果：Android JVM 690/690（0 跳过），Debug App / instrumentation 包构建通过；Swift 核心 365/365（含 Apple ↔ Go auto/quic 两种模式）及 iOS Simulator App 构建 / bundle 校验通过。原 HostService 54 项在 WS / QUIC 各 54/54（0 跳过）。证据：`.artifacts/quic-review/nq01-summary.md`、`nq01-cleanup.json`。没有借用设备，L3/L4、人工 / 现场及 NQ-02 的交接仍未完成。

## NQ-02：Relay 专属生命周期与切换

- 以稳定 Host 身份保存期望模式，单独公开实际承载、准备 / 交接阶段和切换错误；先提供内部 API，不新增设置 UI。
- 从 Android `openRelay/relayDown`、iOS `openSocket/socketClosed/resetChannel` 提取 Relay-only 生命周期；不调用会关闭 LAN 的顶层 connect/disconnect。
- A 服务时 B 只做未认证准备；B 失败保留 A。最后一次请求才可冻结 A、撤销 generation、关闭并等待本地任务退出，再让 B 认证 / E2E / bootstrap。切至 auto 保留健康承载。
- 验收：双向循环、快速改选、同模式幂等、候选超时 / 失败、旧接收 / 写完成 / close 回调、认证失败、LAN / 其他 Host 不受影响；已接受命令保持 unknown、不自动重放。映射 Q03 / Q05 / Q14。

## NQ-03：三流 wire 与 Go

- 在实现前写明不同于 v1 的 ALPN / 版本，三个 bidi stream 一一对应 ctl/msg/bulk；角色唯一，超额 / 重复 / 未知流拒绝。
- quic-go 固定 v0.65.0，各流独立 FIFO writer，原生 priority 为 ctl `(0,false)`、msg `(3,true)`、bulk `(7,true)`；保留 WS 汇聚 mux 与业务准入。
- 验收：真实 TLS / QUIC，逐通道有序、防重放、部分读写、预算、取消 join；暂停 bulk reader 时 ctl 仍可完成（连接信用充足）；不能通过三个独立连接伪装多流。映射 Q01 / Q02 / Q07–Q09 / Q13。

## NQ-04 / NQ-05：平台三流

- Android gomobile 暴露逐流读写，撤销跨流的单写协程；iOS 使用同一 NWConnectionGroup 的 streams，撤销跨流 isSending，保留逐 channel 顺序。
- Apple 上行优先级以公开 API 与真实互通结果为准；不把 relativePriority 自动等同于 quic-go urgency。若 API 不能实现需记录实际限制，不能悄悄更换设计。
- 验收：真实平台 SDK ↔ Go 三流、JNI / Apple group、后台与取消、流信用及内存回收；平台原有单元 / 构建和设备专项。映射 Q07–Q10。

## NQ-06：因果与旧队列

- 在原投递和重连边界保证 HS3 先到 Host、经认证的 Host bootstrap 先于业务消费；提前到的其他流只允许有界等待。
- 测 host.online / HS1 时既有上下游队列、piece 与旧密文，不把本地 generation 当成上游 E2E epoch。先复现后作最小修复，不预设新的业务协议。
- 验收：HS3 / 上传、bootstrap / msg 竞争；重复握手、旧片迟到、换 Host、LAN↔Relay；原 nonce、高水位、分片限制、来源 epoch/seq 保持。映射 Q07 / Q10 / Q11。

## NQ-07：原功能回归

- 复用原 suite，在基点 WS、候选 WS、候选 QUIC 与切换四列核对：配对 / 撤销、目录、输入 / 回执、流式回复、同步 / 历史、工具 / diff、上传 / 下载 hash、设置 / 权限、通知、Agent 接线、多 Host 与 LAN。
- 切换注入覆盖命令已接受但回执未到、snapshot 已发送未 applied、上传正在写 / 下载补洞和阅读中。保留原 opId、消息身份、pending/unknown、终态与阅读锚点。
- 验收不得删除、跳过、放宽旧断言或超时；同配置基点比较失败集合，报告既有失败。映射 Q04 / Q05 / Q10 / Q11 / Q14。

## NQ-08：性能与发布门禁

- 按 ADR §8 的固定流量 / 丢包 / RTT / 带宽测试收益与退化；分别记录 Node / Go / 手机积压、RSS、心跳、超时、重传与取消回收。未达门槛不发布 auto 默认优先 QUIC。
- 双端共享池自动 L1–L4、人工 C01–C18 / A1–A4、R67；同手机真实 WS / 同机 Hysteria / QUIC 对照单独记录。阻塞与未跑不能写为通过。
- 构建租约、单台设备、80% 内存准入与 cleanup/owner/真实状态核验遵循本机入口；只释放本任务资源。映射 Q05 / Q06 / Q09 / Q12 / Q13。

## 交付约束

业务语义和既有 UI 基线不变，关联 S18 / S23、V05、V09–V12、V16–V18、V22。每个 ticket 完成实现后先记录自动证据，再单列设备 / 现场缺口；全部发布门禁完成前 ADR-0065 / R67 持续标记验证中。不部署生产、不修改用户配对或安装到用户手机。

## 2026-11-04 重启前本机候选记录

以下保留重启前结论与原始证据；当前设备状态和续跑结果以文末重启后记录为准。

代码落在原 worktree / 分支，未部署、未改用户配对、未安装用户手机。NQ-01～NQ-06 实施完成；NQ-07 / NQ-08 不能将本机通过折算为完整发布验收。候选默认 **ws**，已保存偏好继续生效；显式 quic / auto 和按 Host 切换 API 可用，未新增 UI。

| 验证层 | 当前结果 | 证据 |
| --- | --- | --- |
| Go / QUIC / 原 Host E2E | race 27 顶层测试通过，含 v1 对照、v2、WS↔QUIC 交接、四连接各 6 MiB 慢读期间 ctl 进展、最终 ctl 不被其他 lane 的 FIN 截断、取消 join 和共享预算归还；无测试用例跳过 | `.artifacts/quic-review/nq-final-go.jsonl` |
| 原 Node 全套 | 1718 项：1711 通过、2 失败、5 跳过；基点原 1701 项状态完全一致，新增 17 项均通过 | `nq07-node-all.json`、`nq07-baseline-comparison.json` |
| 原 HostService | 原 54 项断言 / 超时保持，新增 3 项业务交接；候选 WS 57/57（包含在默认全套中），v2 QUIC 57/57 | `nq07-host-quic.json`；完整默认报告中的 host-service suite |
| Android | 693/693，0 跳过；App、instrumentation 包和三流 JNI AAR 构建通过 | `.artifacts/ui-regression/20261104-native-quic/nq-final3-android.log`、JUnit XML |
| Swift / Apple | 370/370，0 跳过；真实 Apple↔Go 三流、加密大消息 / 二进制、WS→QUIC→WS→QUIC、同连接重握手、LAN 保持；Simulator App 构建 / bundle 校验通过 | `nq-final4-ios.log`、`nq07-apple-business.log` |
| 历史故障修复 | 原 WS/LAN 行为保留；Host HS2 后旧片复现为 35 帧，提前重置后仅 HS2；Node / Go 旧队列分别复现并清理；Apple 新会话旧 AEAD 不推进高水位，首个有效帧后严格认证 | `nq06-before.log` / `nq06-node-before.log` / `nq06-go-before.log`（均预期失败），`nq06-final.log`、Go / Swift 最终结果 |
| 设备 | 共享入口拒绝准入：`provider-well-shadow-standard-full` / PID 15532 的 Android 锁阻塞全机单台池；未占用设备 / ADB 端口 | `nq08-device-admission.log`、Android 入口 result / cleanup |

Node 两项既有失败是 macOS Codex launcher argv / explicit CLI fallback；五项既有跳过完整列于对照 JSON。Go 的 cmd/mobile 两个 package 无独立测试文件，其编译与 JNI 构建通过，不能将 package 的 no-test-files 计作测试用例跳过或 JNI 设备通过。

仍未验收：Android JNI 实际运行、双端 L3/L4 和同设备基点、C01–C18 / A1–A4、完整 Q11/Q14 的切换中事务 / 文件故障组合、Q12 固定 RTT / 丢包 / 带宽五轮对照、Q13 Node / Go / 手机 RSS 与长期压力、Q06 同手机 WS / 同机 Hysteria / QUIC。Mac 本机回环和慢读专项不满足这些条件，未修改全机防火墙 / 网络整形来伪造隔离实验。设备锁由外部任务持有，未删除或抢占。

补充的 3 项真实 HostService + 参考手机交接已在 WS 重连 / QUIC→WS→QUIC 通过：已受理未确认命令不重复分发、待回答交互终态、snapshot 未 applied 后恢复、上传持久前缀与在途 read、下载缺失范围及最终 SHA-256。实际双端存储失败、正在写盘瞬间切换及 UI 阅读场景仍归未完成门禁。

源码、包哈希、最终 L0 / 回归与清理汇总：`.artifacts/quic-review/nq-final-summary.md`、`nq-final-results.json`、`nq-final-cleanup.json`、`nq-final-l0.json`。中间失败和取消日志保留，只有最终对应候选的通过结果用于上表。所有构建租约与本任务子进程须核验释放，外部 owner 保持。

## 2026-11-04 重启后续跑

当时本专项改为 ADR-0064 / R64；本轮因主工作树协议兼容占用该号，活动入口再迁至 ADR-0065 / R67。历史 evidence 中的 ADR-0063 / R62、ADR-0064 / R64 均保留原始文件。原 Android 遗留会话经共享入口按原设置恢复并关闭；六项设置逐项核对，设备 / ADB / 原 owner 租约已释放。Android JNI 实际设备专项 1/1 通过。新增 `TestMultiStalledBulkDeadlineClosesPathAndAllowsReconnect` 使用真实 30 秒写期限，ctl 在 bulk 阻塞期间继续进展，随后显式关闭路径、退出上游并完成 12 次显式重新连接；Go 全套 race 28 顶层 / 38 含子用例通过，0 失败 / 跳过。iOS 新增 App 内 `OrbisTransport` 测试 scheme，使用生产 adapter，隔离临时 TLS fixture 与 preview 宿主，不改系统信任或用户配对；构建及共享 iOS SE 专项 2/2 通过，另覆盖加密业务 WS→QUIC→WS→QUIC、重新握手与 LAN 保持。

双端同设备对照完成，原 53 个设备测试源码和 iOS 原测试选择保持。Android API 35 原基线 / 候选完整自动套件分别 169/7/5 与 171/6/5（通过/失败/assumption）；rich fixture 两版各 1/1、独立原配对用例两版各 1/1，slow-sync 两版各 0/2 且断言相同。补测按用例去重后为基线 **171/9/2**、候选 **173/8/2**，新增失败及缺失原用例为空；两项真实环境 assumption 仍未执行。iOS SE / iOS 27.0 原套件两版均 **83/5/0**，88 项原用例齐全、五项失败断言与数值相同。原套件使用默认 WS / preview / 隔离 fixture，不计为完整 QUIC UI 业务矩阵；已有失败不记通过。截图审阅边界见两端 visual-review 记录，完整 L4 / C01–C18 / A1–A4 仍未验收。

同步消除 Xcode RelaySocket 对象 ID 与主工作树 Localization 对象 ID 的冲突，仅重命名两个项目标识；项目解析、无编号冲突检查及 `OrbisTransport` 构建通过，重建 App 内全部 12 个文件哈希与设备测试包一致。没有合并主工作树 r44–r46，也没有修改业务逻辑。设备、私有 ADB、夹具与构建进程、租约均已核验释放；Xcode 三次延迟退出的辅助进程保留原 cleanup-required 记录及后续定向释放证据。当前汇总、原始失败、包哈希和最终清理见 `.artifacts/ui-regression/20261104-native-quic-reboot/summary.md`、`results.json`、`source-and-packages.json`、`cleanup-audit.json`。Q06/Q12、完整 Q11/Q13/Q14、真实 Agent / 手机与 iOS 17 仍未验收，默认 WS。


## 整链路实现与本机验收

NQ-09～NQ-11 已实现，最终范围、原始失败、快照跨流回执测试适配、四列 104/104、Node 1727/0/5、Go race 45 事件与包内 helper 验证见[原功能回归最终记录](../testing/native-quic-functional-regression.md#2026-11-04-全链路最终本机验证nq-09nq-11)。Host 显式 QUIC 公网准备预算已按 ADR §9 调整，auto 保留原预算；开发默认 WS。完整设备 / 人工、Windows 安装器、iOS 17、真实手机 / Hysteria 对照和长期压力仍不记验收通过。

## NQ-12：完整公网报告完成

2026-11-04 的[完整公网报告](../testing/native-quic-public-performance-20261104.md)保留全部 30 次尝试：Mac Host→真正 Relay→同 Mac Go 参考端，两段均经过公网，未走生产香港入口。QUIC 下载 / 上传吞吐中位数分别为 0.139809 / 0.279618 Mbit/s，加压控制探针 6000/6000 返回；下载五轮均未在排空预算内完成，第 5 轮控制 p95 12.79 秒。WSS 下载无完整窗口，上传仅 1/5 完成且吞吐同为 0.279618 Mbit/s；不报提速倍数。测量 / 报告工作完成，性能目标、真实手机 / Hysteria、完整文件与长期容量门禁未通过或未验收，默认 WS 保持。

临时容器、端口、owner 防火墙规则、远端目录、私密配置与本机测试进程已独立核验释放；证据 `.artifacts/quic-perf/20261104-public-full-chain/cleanup.json`、`cleanup-audit.json`。其他工作树的设备 owner 保持，生产服务与用户配对未变更。

同日用户要求查其他项目后，完成[成熟实现复核](../architecture/native-quic-peer-project-review.md)：固定源码覆盖服务器实际 Hysteria v2.13.0、sing-quic TUIC 与 Syncthing。确认默认 Reno 不等于 Hysteria 的协商控制器；测量存在整块量化、单块 ACK 供给和分层诊断缺口。记录了原始传输→adapter→业务→同手机的下一轮对照与判据，本轮没有改生产参数、重写业务或把推测记为根因 / 修复通过。

后续按用户指令先登记[分层性能诊断方案](../testing/native-quic-layered-diagnostics.md)，再实施 D0–D3 夹具与真实链路测量。D4 控制器单变量对照须有前序证据和候选，D5 真手机另列；仍不移记为原 Q06/Q12 或发布通过。

D0–D3 本轮完成：[分层结果](../testing/native-quic-layered-results-20261104.md)记录原始传输 20/20、双段原负载 / 流水线 24/24 及 4800/4800 控制回复；新读数不覆盖旧失败。诊断确认测试 Go socket 的接收 drops 与容器 CPU throttling，优先核查接收条件，再做控制器单变量对照；没有修改生产参数或产品业务策略。诊断为显式 opt-in，原功能 / UI 契约保持。本轮临时服务、进程、配置与 native 构建租约已独立核验释放，其他工作树设备 owner 保持。

## NQ-13：当前聊天与后台历史隔离试验

Status: implemented, experimental / validation incomplete。按 ADR-0065 §10 复用 msg/bulk，仅在显式 background 下隔离后台 catchup，首屏 / live / 手动 history 保留 msg，不新增第四条流。已实现可回退的 Host 配置、不可变请求范围分类、逐 QUIC lane 准入、双端 data 溢出恢复和 bulk 满时保留健康聊天路径。

最终 Node 1746 通过 / 0 失败 / 5 原跳过，四种 Host / 手机 WS/QUIC 组合各 92/92；Swift 371/371、Android JVM 694/694，Go race 51 个测试事件通过。受控三轮均确认历史阻塞时 msg / ctl 可继续到达，恢复后历史内容 / FIFO 完整。公网 12/12 窗口、2400/2400 探针完成：两段 QUIC 的交互 msg 探针每轮 p95 中位数 6.022→0.569 秒，后台 goodput 中位数 6.82→1.15 Mbit/s；这些是 Mac 参考端的诊断负载，不能外推手机聊天显示或停更已修复。中间失败、设备对照、全部原始证据和清理结果见[结果报告](../testing/native-quic-chat-history-results-20261104.md)。方案见[聊天历史隔离](../testing/native-quic-chat-history-isolation.md)，真实手机 / Agent / SQLite 显示、完整 L4 / 人工 / 长期和发布门禁仍未完成，默认 WS/shared 不变。

## NQ-14：history > catchup > bulk 五流功能回归

Status: implemented / functional regression recorded; complete UI gate not accepted。依据 ADR-0065 §11，先登记五流 / 能力 / 独立 nonce 与序号，再实现 Host、Relay、Android、iOS。用户明确本轮不再测速，只验证功能回归；不重跑性能或公网 benchmark。原三流与 WS / LAN 保留，五流仅显式 background 且 E2E 接受后启用。新旧协商、原业务、同步 applied/ACK、文件 / 详情、重连与模式切换和双端设备回归分别留证；未跑与既有失败不计通过。证据根 `.artifacts/quic-five-streams/20261105/`。

Node 1755 通过 / 0 失败 / 5 原跳过，四种 Host / 设备承载组合各 93/93；Swift 374/374、Android JVM 697/697，Go race 55 个含子用例事件通过；旧模块新旧互通 2/2。Android 同设备全量、rich / slow-sync、隔离配对补测按 ID 去重后，基线 172 通过 / 8 既有失败 / 2 条件未满足，候选 174 / 8 / 2；原用例结果和失败详情一致，无新增失败或缺失，实际 JNI 三流 / 五流各 1/1。iOS 原 SE 系统崩溃隔离后，在另一固定 SE 同设备跑完两版 88 项：基线 83/5/0，候选 80/8/0；3 项差异原断言 / 超时复核后两版均 2/3，目录选择失败详情相同，按 ID 合并补测后均 82/6/0。首次全量差异及未知根因保留，不宣称全门禁通过。App 内原两项三流和新增两项五流实际 4/4。源码完整性、中间失败、截图边界、包哈希与清理证据见[五流结果报告](../testing/native-quic-five-stream-results-20261105.md)。本任务设备 / 进程 / 端口 / 构建与维护租约已独立核验释放。活动专项 R67；默认 WS/shared 与所有未完成门禁保持。
