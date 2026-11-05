# 原生 QUIC：历史传输 ADR 与故障约束

日期：2026-11-04。对应 [ADR-0065](../adr/0065-native-quic-relay-transport.md) / R67；接续[库能力与业务复核](native-quic-transport-review.md)。本文保留设计阶段的文档及源码审查，当时没有重跑历史实验或实施三流方案；后续实施与当前验证状态见 [实施 tickets](../agents/native-quic-tickets.md)。下表的数值是各 ADR 当时记录的现场 / 实验结果，不是本次 QUIC 性能结论。

## 1. 故障、后续决定与本次约束

| 历史记录 | 踩过的坑 | 当前有效约束及对 QUIC 的影响 | 回归归属 |
| --- | --- | --- | --- |
| [0005](../adr/0005-receiver-driven-range-download.md)、[0012](../adr/0012-receiver-driven-upload.md)、[0012](../adr/0012-receiver-driven-upload.md) | 下载丢一块却重发整个 16 MiB 窗口，出现下载时聊天停更；旧上传忽略 send(false) 后推进游标，Host 仍为零字节；done 与迟到重传竞争，成功变失败；大上传堵住 pong 导致断线。 | 下载继续按设备 durableOffset、缺失范围和有界窗口恢复；上传继续由 Host 发 file.upload.read，每条上传一块在途，写链完成后才能再拉，最终校验由 Host 决定。QUIC 的可靠投递不证明落盘或业务完成；不能恢复旧 push / credit / upload.done，也不能把上传描述成下载的 1–8 MiB 窗口。单块、检查间隔和 RTT 仍可能约束上传速度，须单独测量。 | Q05、Q11、Q12 |
| [0010](../adr/0010-write-layer-slicing.md)、[0010](../adr/0010-write-layer-slicing.md) | 1 MiB 明文约变成 1.34 MiB 信封，一次写入跨过水位；8 KiB 切片后，64 KiB 水位配 10ms 轮询又把快 LAN 下载从 66.7 降到 6.40 MiB/s，改 drain 复查为 1ms 后为 63.98 MiB/s。 | 优先级必须作用于实际出口，保留跨 WS 段的切片。Go 三流使用独立 writer 与原生优先级，不复制定时轮询调度器；现存 WS 段仍须测量。小缓冲不自动意味着低延迟，过小窗口或固定节拍会损失快网吞吐。该 ADR 的 WS 水位延迟公式不是 QUIC 延迟保证。 | Q08、Q09、Q12 |
| [0064](../adr/0064-protocol-compatibility.md)、[0009](../adr/0009-remove-computer-to-phone-push.md)、[0050](../adr/0050-fixed-lan-relay-routing.md) | feature 声明无人读取，旧 Relay 丢掉 hdr.ch，schema 静默 strip；多格式排序使 runtime 事件静默丢失。旧 Relay 还曾承担明文事件和主动文件推送。 | 业务 protocolVersion 硬门槛、字段语义和 E2E 不降级。QUIC 不可用时认证前回退到同一业务协议的 WSS，区别于恢复旧业务格式。三流采用独立 transport version / ALPN；不能让 v1 单流和三流靠猜测互通。Relay 不获得文件、命令或会话事务的解释权。 | Q02、Q03、Q07 |
| [0011](../adr/0011-nonce-slot-and-high-watermark.md) | ctl / bulk 的计数都从 1 开始却共用 nonce 槽，发生同 key/nonce 加密不同明文；严格 last+1 又让丢一帧毒化整条道。 | nonce 使用 channel 槽位加 n，ch 进入 AAD；接收使用已认证高水位。不能按文件或 runtime 拆出共享同一 channel 计数域的并行流，否则先到 n=12 会使后到 n=11 被丢。重复发送相同密文与重新执行用户命令不是一回事。 | Q07、Q10 |
| [0013](../adr/0013-bounded-session-sync-and-shared-tree-ingestion.md)、[0037](../adr/0037-session-sync-transaction-contract.md)、[0037](../adr/0037-session-sync-transaction-contract.md) | 8 秒超时换新 ID 反复下载，出现 GB 级队列；改成稳定 ID 后静默去重又导致永久等待；busy 写成会话失败闸门后，直到 App 重启都不再同步。固定 20 秒杀任务方案被否决。 | 保留稳定事务及不可变参数、可观察 pending、按真实进展续租、有限终态和资源释放；busy 不能停掉整会话。对支持 ACK 的事务，socket 写完和 QUIC ACK 均不能代替设备 SQLite applied；首个有效终态不被迟到回执 / 回调反转。未确认同步允许有界重派，已 applied 不重派。 | Q11 |
| [0035](../adr/0035-incremental-session-reconcile.md)、[0039](../adr/0039-content-change-signals.md)、[0044](../adr/0044-bounded-codex-live-publish.md) | 未变历史反复深拷贝 / 序列化；慢读时 ws 缓冲上涨而 V8 heap 看起来稳定；逐 token 发送累计 live。另有跳过超预算 patch 却推进 seq、读版本前未 flush 合并窗口，以及超过 256 条待提交批次永久滞留的修复记录。 | 保留来源合并、只在实际发布时推进 source seq、读版本前 flush，以及超预算原子批次的显式基线恢复。QUIC 提速不能替代源头减量或消费优化；成本观测包含 RSS / 外部缓冲，不仅看应用队列长度。不得在密文适配器里合并或删除有依赖 patch。 | Q11、Q12、Q13 |
| [0040 §5、§7](../adr/0040-bounded-inbound-delivery.md)、[0020 §4](../adr/0020-deepseek-harness-shared-web-backend.md) | 手机上积压 5,238 帧、约 42 MiB UTF-16 payload 并发生 OOM；ctl 溢出即关闭链路，使打开会话约 12 秒后断线，随后重连 / 重同步 / 再断线。 | 已解密、已完整重组的消费队列有预算，按原规则丢最旧、计数和限频恢复，不因普通消费溢出断线。该规则不授权 Go / Relay 丢任意密文片；优先级也不能使 SQLite 或 reducer 无限提速。 | Q09、Q13 |
| [0020](../adr/0020-deepseek-harness-shared-web-backend.md)、[0044](../adr/0044-bounded-codex-live-publish.md) | 手机离开 LAN 后旧路径仍积压约 259 MB、队首等待 193 秒；另一次两条 Codex 的 patch 队列约 392.1 MB。同步预算有界，但普通 msg 没受同样限制，先把同步恢复堵死。 | Host 继续在 seal 前按通道准入、来源合并和诊断；普通队列准入失败按 0044 摘除路径并恢复。与手机消费溢出不关闭是不同层次，不能相互覆盖。QUIC adapter 要贯通上游背压并核算所有连接总内存；不能把积压搬到 Node / Go 就认为已修复。固定 LAN 优先不改成 RTT 竞赛。 | Q09、Q13 |
| [0038](../adr/0038-wire-payload-truncation.md)、[0045](../adr/0045-tool-summaries-and-on-demand-content.md) | 上游 1 MiB 输出加 JSON 外壳变 1.12 MiB，越过整个响应的 1 MiB 上限；只提高单条上限会吃掉活动任务预留，并使弱网重组期限成为新瓶颈。工具参数、输出还曾在多份 live 中重复携带。 | 按完整 JSON、密文、切片头和累计量记账；不独立扩大某个上限。工具摘要 / 库存继续有界，详情按需走 bulk，详情不成为聊天 applied 的依赖。保持已有内容投影与语义，不借传输改动重新裁剪正文。历史页与 live 同属 msg，三流不能隔离二者。 | Q09、Q11、Q12 |
| [0024](../adr/0024-recoverable-session-state-sync.md)、[0026](../adr/0026-host-selected-session-sync.md)、[0029](../adr/0029-session-read-operation-state-machine.md)、[0030](../adr/0030-multi-host-mobile-connections.md) | ctl 的 idle 提前到达会干扰较晚的消息映射；外层 sequence 混有其他设备定向消息，跳号不等于本会话丢状态；本地历史读完却因 loading 被别处清除而遭拒。 | transport generation、E2E epoch/n、source epoch/seq、工具库存 revision、操作身份各管各的。高优先级 ctl 不得越过业务版本条件清 head/live，完整 applied 仍要满足来源及库存依赖。连接和预算按 Host 隔离，读取操作拥有者不被流回调替代；源 epoch 不因普通网络重连无故刷新。 | Q10、Q11 |
| [0049 §7](../adr/0049-optimistic-send-and-source-reconciliation.md)、[0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md) | 已发送后断线可能是“已执行、回执丢失”；把 pending、发送完成或超时当成功 / 未执行，会制造重复操作或误删输入。这里是现有契约风险，不宣称本轮复现。 | 保留同 opId 事实、终态单调和因果晚于操作的读取证据。QUIC ACK 不结算操作；ready 后故障不切到 WSS 重发命令。未确认保留、核对，不因重握手清成成功 / 失败，也不以较新推送代替有因果关系的反向证据。 | Q03、Q10、Q11 |
| [0048](../adr/0048-online-chat-entry-budget.md)、[0060](../adr/0060-mobile-relay-history-performance.md) | 进入页面重复同步、全量覆盖检查 / 排版和主线程解密会表现为“网络卡”；删掉入场动画的优化后来被明确撤销。 | 分开测网络等待、解码 / 消费、SQLite 和 UI；保留 worker 独占 / 旧代次隔离及阅读行为。传输回环通过不等于真机不卡，提速也不授权删动效、历史或逐字呈现。 | Q05、Q06、Q12 |

## 2. 不能照抄的旧结论

- 0005 的 pull/stream 协商、0007 的 channels 协商由 0008 的硬协议门槛替代；0005 / 0006 里 Relay 原始二进制路由和主动推送由 0009 删除。0008 的“当时仅一个用户”是历史背景，不作为当前用户规模事实。
- 0006 的上传 push / credit / done 由 0012 替代；下载与上传虽都由接收方驱动，当前窗口与完成协议不同。
- 0007、0010 及部分源码注释中的“序号空洞永久毒化通道”由 0011 高水位语义替代；Relay 注释“ch 不进 AAD”也已过时。继续保留封帧前准入、不任意丢密文的投递契约，但理由不能继续用已删除的 sequence_gap 错误。
- 0010 已把 msg 水位改为 64 KiB；不要恢复旧 1 MiB，也不要把 WS 的水位公式移植为 QUIC 性能保证。0005 的“负载 p95 ≤ 空闲两倍”已被 0010 明确撤回。
- 0036 §7 的固定 20 秒截止方案被否决，§8 冷却是过渡；正式事务生命周期以 0037 为准。0037 中 sent / applied、ACK 能力兼容和首次有效终态的后续修订须一起读，不能只摘旧表格的“已 sent 即 committed”。
- 0038 的 256 KiB 普通页、6 MiB 同步预算、2 活动任务是旧参数，0013 §6 后来调整到 512 KiB、12 MiB、4 活动任务；单响应 1 MiB 不变。0038 的工具全文默认截断由 0045 摘要 / 引用 / 按需详情替代。
- 0040 标题及 §1 的“ctl 不丢”不能覆盖同文 §5 的后续决定：消费队列 ctl 溢出丢最旧、记录并恢复，明确不再因此断线。0044 的 Host 封帧前拒绝 / 路径摘除继续有效。

## 3. 当前适配器还缺什么

源码核对入口：[OutboundChannelMux](../../packages/protocol/src/outbound-mux.ts)、[DeviceLink](../../packages/host/src/device-link.ts)、[Relay](../../packages/relay/src/index.ts)、[Go queue](../../native/relayquic/queue.go)、[Go server](../../native/relayquic/server.go)、[上传接收者](../../packages/host/src/artifact-upload.ts)、[Android 入站](../../android/app/src/main/java/com/orbising/orbis/InboundFrameLanes.kt)、[iOS 入站](../../ios/Orbis/Orbis/WebSocketTransport.swift)。

1. **预算必须能传回生产者。** OutboundChannelMux.hasRoom 是封帧前检查；enqueue 本身继续接受已封帧。Host DeviceLink 执行该检查，Node Relay 的 send 直接 enqueue，bulk 越界只报警。因此“复用 mux”不等于 Node 有硬性总内存上限。Go 快速读 loopback 后，Node 的 bufferedAmount 只表示本机交付，无法证明公网在前进。
2. **停读单条 WS 不能解决全部背压。** 停在 bulk 上可能挡住其后 ctl 和 WS ping/pong。以原 WS 作基线测 Q13，保留现有准入 / mux，限制 adapter 自身的队列 / 连接 / 窗口；若新增积压失控，修复对应边界。不预设新增 Node→Go 信用协议，也不靠无限缓存或持续断线通过验收。
3. **密文紧急护栏与日常背压分开。** 当前 Go queue 满后 server 关闭连接，错误还将格式非法和超预算合为一类。它只能作为未发布 v1 的紧急保护，尚不能证明长期过载时有进展。最终方案须区分非法帧、容量拒绝、无进展超时和正常等待；耗尽护栏时允许明确使该路径失效并按既有规则恢复，但不得把反复重连当作稳定流控。不能向 Go 移植 0040 的解密后丢帧。
4. **总量包含所有阶段。** 原候选 4/32/64 MiB 合计 100 MiB；128 个连接触顶仅这一层就约 12.5 GiB，不能直接作为部署配置。适配器必须计入在写帧、窗口及连接数，测试记录 Node / Go RSS 与资源释放；保留 Host / 手机原预算，不把全链路预算重构列为替换 WS 的先决条件。
5. **四种“进展”分别观测。** 已准入 / loopback 已写 / 公网传输进展 / 业务应用或文件写入不是同一事实。沿用 Host 同步租约及应用 ACK，不擅自重定义它们；增加适配器侧队列年龄、各层字节和拒绝原因以定位真正停滞处。诊断只记身份及计数，不记正文、密钥或凭据。

上传代码中的 durableBytes 在文件 write 成功后推进，源码明确这表示交给内核，最终另校验 SHA-256；本次不把这一字段扩张成每块 fsync 或断电持久性保证。

## 4. 必补回归与实施顺序

Q01–Q10 保留；在 [ADR-0065](../adr/0065-native-quic-relay-transport.md) / R67 增补以下计划，尚未实施或执行：

| ID | 组合故障与必须结果 |
| --- | --- |
| Q11 | 真实加密链路上的长耗时 / 重复 sync、pending、busy、ACK 丢失及迟到冲突终态；SQLite 失败 / 工具库存未齐不推进 applied；文件拒写、慢盘、只补洞、收尾迟到；ctl 状态抢先不清 live；多 Host 和断线未确认操作不串扰、不自动重发。保留已有协议 / Host / 双端状态机测试，并在三流集成入口补组合覆盖。 |
| Q12 | 同一加密业务夹具对比 WS / QUIC 的快 LAN、高 RTT、1/5/50 Mbit/s 条件；分开记录上传单块等待、下载窗口、msg 内历史与 live 竞争、bulk 内文件与详情竞争、WS 轮询、各层积压 / RSS 与手机消费。不把旧 ADR 数字作为本次阈值或实测；真实手机线路收益仍归 Q06。 |
| Q13 | 分别注入源端封帧前不足、Node / Go 密文积压、手机解密后消费溢出；证明有界准入与总预算、WS 心跳、业务控制及恢复有进展，无周期性重连风暴，密文不静默丢。保留 0044 的明确路径失效恢复、0040 的消费恢复，并在多连接 / 多 Host 下验证隔离和资源回收。 |

先跑原 WS / QUIC v1 的真实 Host 业务契约与连接交接对照，再替换三流 writer / reader，按 Q07–Q10 注入顺序差异，并复用既有恢复入口修复。Q11–Q13 保留为验收，不预设新的业务流控或 epoch 协议。Apple 上行调度、设备和现场门禁继续独立验证，v1 保持未发布；可切换方案以 ADR-0065 §3 为准。

## 5. 分支与证据范围

核对工作树基点的相关 ADR，并只读比较主工作树：0049 新增的是已结算交互反馈的 2.5 秒生命周期；0055 新增的是 ADR-0062 后台任务独立于主回合；0050 的差异是本分支已有 QUIC 补充。没有导入主工作树未提交修改，也没有以旧工作树文档覆盖新规则。合并时仍须保留主工作树这些修订。

历史复核阶段只修改审计 / ADR / 回归文档，L0 保存 `.artifacts/quic-review/history-l0.json`。随后替换 / 切换设计阶段增加真实 WS / QUIC / Host / E2E 对照、服务端认证接替修复及 Q14 部分回归，证据 `.artifacts/quic-review/replacement-summary.md`。不增加 feature 或已交付计数；历史 ADR 中未完成的真机、全量设备和现场性能门禁仍未完成。
