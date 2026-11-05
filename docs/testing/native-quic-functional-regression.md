# 原生 QUIC：原项目功能回归

日期：2026-11-04。关联 [ADR-0065](../adr/0065-native-quic-relay-transport.md)、[UI 回归 R67](ui-regression.md#r65-原生-quic-中继adr-00642026-11-04)。目标：加入 QUIC、保留 WS、切换两种承载后，原有功能、结果、恢复行为及显示不退化。

## 1. 同一功能、同一断言、不同传输

| 执行列 | 版本 / 路径 | 必须证明 |
| --- | --- | --- |
| 基点 WS | 本分支基点 `df02972350e00ee4330b311831626b71c8035678` | 原项目功能与失败集合；失败须在同条件基点重现，不能仅按改动文件猜测 |
| 候选 WS | 新版强制走 WS | 新增 QUIC 及共用生命周期没有破坏原 WS 功能 |
| 候选 QUIC | 新版强制走 QUIC，失败不能退回 WS | 同一业务流程和原断言通过；同时记录实际路径，避免测到回退后的 WS |
| 候选切换 | WS→QUIC、QUIC→WS；有工作进行时切换 | 正在进行的业务按原语义完成 / 恢复；无重复执行、丢状态、假成功、跨 Host 串扰 |

普通纯逻辑单元无需按模式重复；它们仍运行全套以保护状态机。业务集成和真实 App 流程需要按上述传输列执行，不能把只在内存中调用 reducer 的单元测试写成 QUIC 端到端覆盖。增加的网络专项 Q01–Q04 / Q07–Q10 为定位问题提供证据，不能代替下表的原功能验收。

## 2. 原功能与现有用例入口

下面的名称是已有套件入口，不表示每一个列出的场景都已在 QUIC / 切换下跑过。每行需分别记录执行列、平台、具体用例名、实际路径和结果；空白、未实现、fixture 未覆盖或设备受阻都不能记通过。

| 原功能 | 必须保持的业务结果，含切换中的检查 | 原有自动入口 / 手动入口 |
| --- | --- | --- |
| 配对、设备身份与撤销 | 原配对成功 / 失败规则、E2E 身份、撤销失效不变；重连不重新配对，不接受旧凭据或将传输 ready 当业务 ready | `host-service.test.ts` 配对 / 撤销 / 重握手；`e2e/pairing`；iOS `RelayTransportTests`；Android `RelayPairingTest`、`IsolatedHostPairingInstrumentedTest`；C01/C17 |
| 首页目录、Agent 能力和执行状态 | 首次完整目录、在线状态、能力 / Slash 菜单、重连重播不丢；Pi、Codex 终端 / Desktop、Claude、DSH 的原身份不混合 | `host-service.test.ts`、`device-view-facts`、各 Agent runtime / bridge 测试；iOS `HomeRuntimeLoadingTests`、`AgentStateTests`；Android `HomePresentationTest`、`AgentModelConsumerTest`；C01/C03/C17/C18 |
| 输入、流式回复与操作对账 | 输入发送一次；原队列、等待附件 / 选型、审批、停止、失败和未知结果保持；回执丢失不自动重新执行，不因切换清掉草稿或已显示消息 | `host-service` 命令 / 事件、`codex-async-input`、`codex-approval-lifecycle`；双端 `PendingSend(s)`、`WaitingSend`、`OperationLedger`、`RespondLedger`、`QueueCancelLedger`；Android `OptimisticActionsInstrumentedTest`，iOS 原乐观操作 UI；C05/C06/C08/C17 |
| 历史、同步、分页和恢复 | 原消息身份、source 版本、live→历史交接、缓存读和补洞保持；SQLite applied 后才能 ACK；断线 / 切换不永久 busy，不重复全量灌入，不把较早 ctl 当成正文已应用 | `host-service` 定向 snapshot / ACK；`session-sync-tasks`、`protocol/session-source` / `session-sync`；iOS `SessionHistoryTests` / `StoreTests`；Android `SessionSyncTasksTest`、`SessionSourceRecoveryTest`、`SessionSyncSlowLinkInstrumentedTest` / `LiveHistoryReloadInstrumentedTest`；C05/C11/C17 |
| 工具摘要、详情与轮次文件审阅 | 摘要连续、正文按需分页、只取选中文件 diff；取消 / 重连 / 切换不把旧详情贴到新会话，也不使详情成为正文 applied 的额外依赖 | `host-service` 工具库存 / 详情与 frozen diff；`codex-tool-content-reader` / `codex-turn-file-changes`；双端 `ToolContent`、`TurnFileChanges`；C07/C14 |
| 文件浏览、下载、上传和附件 | 下载只补缺失范围、暂停 / 继续 / 取消、最终字节 / hash 正确；上传继续由 Host 拉取，错误偏移 / 写入失败 / hash 失败如实处理；切换不能把已完成标成失败、上传两遍或提前发附件消息 | `host-service` 文件浏览 / 范围下载 / 上传落地；`artifact-download` / `artifact-upload`；iOS `FileTransferTests`；Android `PullSchedulerTest`、`PullDownloadsTest`、`ArtifactUploadStoreTest` / `ArtifactDownloadStoreTest`；C13、原上传失败恢复 UI |
| 设置、模型 / effort、权限、供应商和配额 | 原选型 / 权限身份及确认机制、繁忙时允许 / 禁止操作规则不变；切换中未确认的操作继续对账，来源设置不被旧响应覆盖；凭据不进入手机结果 | `host-service` provider / quota / busy；`permission-management`、`codex-permission-settings`；双端 `ConfigLedger`、Android `RuntimePermissionsTest` / `CodexPermissionsInstrumentedTest`；C12 |
| 新建 / 恢复会话、历史操作和退出 | 原按需启动、路由、归档 / 恢复、分支 / 回退、退出的真实结果与失败恢复保持；换承载不额外启动原生进程或重复历史改写 | `host-service` session.activate / 多 Agent 接线；`spawner`、`session-archive`、`codex-rewind`、desktop lifecycle；双端 `LaunchLedger` / `ArchiveLedger` / `QuitLedger`；C09/C11 |
| 通知、审批和问卷 | 原未决状态和设备隔离保持；回复 / 关闭的确认单调，断线恢复不重复通知，不丢交互草稿 | `host-service` notification / dismiss；`notification-store`、`codex-interactions`、`dsh-user-questions`；双端 `Notifications` / `DismissLedger` / `RespondLedger`，Android问卷专项；C08/C18 |
| LAN、Relay、多 Host、前后台 | LAN 仍优先；LAN 断开按原规则回 Relay，切 Relay 承载不关 LAN；其他 Host 继续工作，旧回调不能覆盖新 Host；前后台 / Host 重启恢复原目录与订阅 | `host-service` LAN 优先 / 拔 LAN / Host 重连；`relay-client`、`device-link`；iOS `MultiHostTests` / `RelayTransportTests`；Android `LanConnectionTest` / `SessionHostOwnershipTest`；C17/C18 |
| 显示、阅读与交互 | 已有布局 / 手势 / 动效、阅读锚点、逐字显示、工具展开、键盘、缓存页面不因传输变化退化；已有失败仍按同设备基点判定 | 原双端 L1–L4 全套；C01–C18、A1–A4、R67 和受影响 ID。静态 preview 仅证明显示，不能证明真实 QUIC 收包 / 切换 |

## 3. 业务测试如何接到 QUIC

复用 [HostService 原端到端套件](../../packages/host/src/host-service.test.ts)，参考手机与 Host 各自选择 [测试传输适配](../../packages/host/src/fixtures/relay-business-transport.ts)。原配对、独立 E2E 推导、HostService、后台替身、文件系统、业务结果断言和超时保持；跨流受理回执的测试处理见下方最终记录。

- `ORBIS_TEST_RELAY_TRANSPORT=ws`：原参考手机直接连原 Node Relay。
- `ORBIS_TEST_RELAY_TRANSPORT=quic`：参考手机经本机测试 WS API 桥，所有手机 Relay 帧经过真实 Go QUIC client → 本机真实 QUIC server → 原 Node Relay。Host 不经过此 WS API 桥，LAN 不变。
- `ORBIS_TEST_HOST_TRANSPORT=quic`：真实 `HostRelayClient` 通过生产 Go helper / 逐 lane IPC 连接独立的 Host QUIC 接入端，必须配置 `ORBIS_TEST_QUIC_HELPER`。其余模式为 WS；四列为 Host/手机 WS/WS、QUIC/WS、WS/QUIC、QUIC/QUIC，不把单侧结果转记为双侧。
- QUIC 模式缺少 `ORBIS_TEST_QUIC_BRIDGE`、TLS / 建连 / wire 失败即失败，不能回退成 WS。桥使用独立临时证书和信任根、loopback 端口，无生产账号；退出等待泵与进程结束，清理失败报告失败。
- 该本机 WS API 桥仅供复用原业务套件；额外本机缓冲不用于吞吐 / 背压 / 丢包性能判定，也不模拟 Android/iOS 系统网络栈。三流、实际 App 和运行中切换仍须各自验证。

```sh
# native/relayquic 下先构建测试适配器，可用本机固定 Go 工具链
go build -race -o ../../.artifacts/quic-review/business-bridge ./testdata/business-bridge

# 仓库根目录，运行同一原有套件，两次均保留原断言
ORBIS_TEST_RELAY_TRANSPORT=ws npm test -- packages/host/src/host-service.test.ts --maxWorkers=2
ORBIS_TEST_RELAY_TRANSPORT=quic ORBIS_TEST_QUIC_BRIDGE="$PWD/.artifacts/quic-review/business-bridge" npm test -- packages/host/src/host-service.test.ts --maxWorkers=2

# 完整 QUIC 列；另将两个模式分别改为 ws 复跑其余三列
ORBIS_TEST_HOST_TRANSPORT=quic ORBIS_TEST_RELAY_TRANSPORT=quic \
ORBIS_TEST_QUIC_HELPER="$PWD/.artifacts/quic-review/host-native/bin/orbis-quic-client" \
ORBIS_TEST_QUIC_BRIDGE="$PWD/.artifacts/quic-review/business-bridge" \
npm test -- packages/host/src/host-service.test.ts --maxWorkers=1
```

同时按原项目执行 Node 默认全套、双端单元 / 构建 / UI 全套；默认 Node 不含 `claude plugin test` 专用套件，必须明确该边界。不能把通过数量相加成“全项目功能已覆盖”。Android / iOS 设备只用本机共用入口、构建租约和同设备基点；本机缺设备 / 夹具时记阻塞及确切功能缺口。

## 4. 通过标准与记录

1. 受影响旧功能用例全部通过，新增失败集合为空；未受影响的既有失败必须提供同配置基点复现。即便基点也失败，受影响功能仍不能记验收通过。
2. WS / QUIC 保留同一业务断言、超时和数据规模；切换至少覆盖输入已接受未确认、流式回复、同步待 applied、上传 / 下载进行中、待回答交互、LAN 正常和另一 Host 有活动。
3. 设备结果包含实际安装包、设备 / 配置、真实传输路径和截图 / 日志；丢包 / 性能另判，不能靠性能改善豁免功能回归。
4. 每份结果明确“底层专项”“既有业务套件”“手机端到端 / UI”“真实 Agent / 现场”覆盖哪一层；未跑、跳过、失败、阻塞与通过分别列出。

当前执行记录保存 `.artifacts/quic-review/functional-summary.md`；旧 `replacement-summary.md` 的 183 项是定向覆盖，原 Go 契约测试是底层专项，均不能独立证明原项目功能全部正常。[NQ-01](../agents/native-quic-tickets.md) 新增双端首次连接 ws/quic/auto API；模式选择专项只验证准备与失败语义，原功能继续跑全套。每 Host 持久化、运行中切换控制器和三流现已实现，完整设备 / 现场回归状态仍为**未通过验收**。

2026-11-04 v2 候选：原 Node 全套 1718 项（1711 通过、2 基点已有失败、5 原跳过），原 1701 项逐用例状态保持，新增 17 项通过；HostService 原 54 项在 WS / v2 QUIC 均通过。Android 原套件加切换 / bootstrap 共 693 项、Swift 原套件加三流 / 切换 / 旧密文共 370 项通过。新增 Apple 真实 SDK 夹具覆盖原配对后加密消息 / 二进制、WS→QUIC→WS→QUIC、重握手及 LAN 保持。该夹具仍使用隔离 Host 替身，不覆盖真实 Agent、手机 SQLite 故障或全量 UI。完整 Q11/Q14 组合、设备和现场缺口见 [tickets](../agents/native-quic-tickets.md)；不能将这些通过数量相加为全项目 / 全门禁通过。

同日补齐参考手机运行中交接：新增 3 项 HostService 回归在 WS 重连和 QUIC→WS→QUIC 各通过，Host suite 当前两列均为 57/57（原 54 项断言 / 超时保留）。覆盖已受理未回执命令不重复分发、待回答交互的终态身份、snapshot 未收到 applied 后同身份重新读取、上传持久前缀及在途 read、下载保持 transferId 并只补缺失范围，最终 SHA-256 一致。夹具按原协议分片大上传，并核对 v2 ALPN；参考手机交接不替代双端生产控制器、真实 SQLite 写失败和 UI 阅读测试。证据为 `nq07-host-quic.json` / `nq07-node-all.json`；定向调试中的筛选跳过不作为全套结果。

2026-11-04 重启后设备续跑范围：Android / iOS 原套件保持原默认 WS、preview 与隔离 fixture 入口；这组全量对照验证新增 adapter 没有破坏既有行为，不等于整套 UI 都经 QUIC 执行。实际 QUIC 另由 Android JNI 与 iOS App 内 `OrbisTransport` 专项验证；iOS 2/2 通过，包含加密业务、双向切换、重握手和 LAN 保持。原 53 个设备测试源码逐文件哈希与基点一致，iOS 测试选择 / 启动参数一致。Android 的 rich / slow-sync 与独立配对夹具补测分别记录；当前结果和剩余失败见 tickets 与 `.artifacts/ui-regression/20261104-native-quic-reboot/`。完整真实 App QUIC 业务矩阵仍未据此验收。

续跑完成：Android 基点 / 候选 full 为 169/7/5 与 171/6/5，rich 与配对补测各 1/1，slow-sync 两版各 0/2；去重后 **171/9/2 与 173/8/2**（通过/失败/assumption）。配对补测两端移动包使用同一个候选 HostService / Relay 版本及各自独立新实例，不修改真实配对存储。iOS SE 同设备同配置原 88 项两版均 **83/5/0**。新增失败和缺失原用例均为空；两项 Android 真实环境测试、完整移动存储 / 写盘失败组合及人工 / 线路门禁仍未完成。失败详情和完整用例清单见 `results.json`，不能以这次对照删除或放宽既有失败。


## 2026-11-04 全链路最终本机验证（NQ-09～NQ-11）

实现覆盖 Host 与手机两段：Host 使用生产原生 helper / 独立三 lane IPC，Relay 使用双 ALPN 固定路由，两端可独立选择 WS / QUIC。原业务、E2E、LAN 优先、文件恢复与未知操作不重放保持。四组合最新证据为 `.artifacts/quic-review/full-chain-final-v2/summary.json`，每列 **104 通过 / 0 失败 / 0 跳过**，包括 HostService 60 项、HostRelayClient 7 项、准备预算 3 项、配置 3 项、发现 10 项、Relay 替代 / 多设备 6 项和 mux 15 项。数量中包含纯逻辑 / 错误分支，不等于每项都有双段网络流量。

HostService 原 TCP 断链用例在 Host=WS 列保持 TCP 故障；在 Host=QUIC 列仅重启独立 Host QUIC 接入端，Node Relay 与手机原连接保持。两列均验证自动重连、同手机连接重新握手、业务消息恢复，原超时不变。任一侧切换的 6 项业务测试覆盖已受理未确认命令、待回答交互、未 applied snapshot、上传持久前缀、下载补洞 / SHA-256；不冒充真实手机 SQLite / 文件写失败测试。

一次原 Codex 新会话用例在手机 QUIC 列失败并定向重现（2/5，WS 0/5）：ctl `command.result` 合法先于 msg `session.snapshot` 到达，原四消息读取额度把受理回执误当快照占位。测试现在单独严格校验唯一 `new-thread-sync` 的成功受理回执；仍保留四个业务帧上限、原超时、快照完整内容 / source 身份断言，不把受理当 applied，不增加生产跨流排序屏障。修改前原始失败保存在 `full-chain-final/`；最终四列均通过。这是明确记录的跨流测试适配，不能再声称全部测试读取逻辑逐字未变。

Node 默认全套 **1732 项：1727 通过、0 失败、5 原跳过**（`full-chain-node-all-final.json`），原 Codex launcher 两项此次通过，没有删用例或改变它们的断言。Go race **45 个测试事件（含子用例），0 失败 / 跳过**（`full-chain-go-race-final-v2.jsonl`），设置了 `ORBIS_TEST_NODE`，真实 Node 子用例已执行。首次最终 Go 运行因 clean 后漏拷 Relay web 静态资源而失败，补齐正常 build 步骤后全套通过，失败日志保留；没有修改断言。

TypeScript 生产 / 测试检查及改动 JS/TS lint 通过。macOS arm64 完整 runtime 包包含 51 个 JS runtime packages、helper、Go / 依赖许可和 inventory；从包内 Host 模块按默认相对路径启动 helper，并完成 QUIC→WS→QUIC（`full-chain-package-smoke.json`）。darwin/amd64、windows/amd64、linux/amd64 helper 另已交叉构建；Windows / Linux Host 实机与完整 DMG / 安装器未验收。移动端既有同设备对照结果保持，不将本次 Node / Go 结果转记为完整真机、UI、人工或长期容量验收。
