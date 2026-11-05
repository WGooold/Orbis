# 聊天与后台历史隔离试验

日期：2026-11-04（Asia/Taipei）。依据 ADR-0065 §10 / NQ-13，属于 D6 的第一步。当前状态：试验实现与两段公网对照完成，原功能回归及验收缺口见[结果报告](native-quic-chat-history-results-20261104.md)；默认关闭，手机现场 / 发布未验收。

## 决策与对照

第一步保持三条可靠流：`ctl` 保留命令、回执和已有 execution 状态；`msg` 保留首屏 preview、live、手动 history 分页、目录及一般状态；仅请求范围为 catchup 的 snapshot 可在显式 `relayHistoryMode=background` 下走 `bulk`。它与低频文件 / 工具详情暂时共用，不能称为新增第四条专用流。默认 shared 保留原分类；LAN 不变，WS 能处理相同 wire，但不能提供跨 QUIC stream 的丢包隔离。

传输准入同时核对真实逐 lane backlog：只有 QUIC 可用逐 lane 在途量，WS 继续按共享 socket backlog。不会取消总队列 / 每 lane / 同步预算；Write 仍不是 applied。历史消费溢出必须触发已有同步恢复，不按文件丢片静默忽略。兼容采用已有 ch=bulk、k=data、原 snapshot / pending / ACK 格式，不新增 nonce 槽位、不降低防重放、不重放命令；旧端的消费 / 现场兼容仍须分别验证。

## 测试先登记

| 层次 | 基线 / 候选与必须断言 |
| --- | --- |
| 分类与配置 | shared 默认原样；background 只改 Relay 的 catchup；preview / 手动 history / LAN 保持 msg；非法配置拒绝；环境优先于持久配置 |
| 真实 E2E + 队列 | 固定阻塞历史 lane，提交 live、preview 和 execution 状态。shared 下 live / preview 排在历史后；background 下先收到并认证交互帧，再放开历史并验证全文 / 逐 lane FIFO / 无重放误判 / 完整进展回调 |
| 同步事务 | 请求范围来自 Host 已登记的不可变参数，不由响应猜测；history 完成写入仍等待 applied ACK；ACK 丢失、路径摘除与重新握手沿用原租约和恢复；名额 / 12 MiB 预算不放宽 |
| 真实 QUIC | 暂停 bulk reader，验证 msg 与 ctl 继续到达；再排空 history，核对内容。另做 shared 的同 msg 排队对照。隔离夹具不代替公网与手机 |
| 双端消费 | bulk data 仍为 JSON，msg 优先消费；bulk 队列淘汰历史 data 必须报告 session overflow，二进制丢片仍走原 offset 恢复；保留原预算和超大单快照规则 |
| 原功能 | Node 原全套、四种 Host/手机 WS/QUIC 组合的既有业务；Swift / Android 单元。受影响设备 L1–L4、C01–C18、R67、A1–A4 独立记录，不以单测提升门禁 |

受控计量记录完整计划 / 完成数、live / 状态 / preview 到达时间、历史排空时间、失败与队列剩余；注入的等待单独标明。只证明排队隔离，不把人为暂停的差额报告为公网提速。公网和实际手机比较按 D6 交错执行，报告首屏 / 状态 p95、最长停更时间、3 / 10 / 30 秒停顿次数和自动恢复，无数据不报效果百分比。

## 发布 / 回退

不部署用户 Host / Relay 或安装手机；默认 WS、shared 保持。只通过现有 Host 配置或环境显式启用 background；回退 shared 影响之后封帧的 snapshot，已封帧消息继续按其原 lane FIFO 完成，不能搬迁旧密文。未跑 / 失败 / 设备占用和现场缺口公开保留。

证据根：`.artifacts/quic-chat-history/20261104/`。每次命令结果、候选源 hash、测试摘要及资源清理独立保存。

补充准入约束：后台历史与文件共用 bulk，文件占满时只拒绝尚未封帧的历史请求，不摘除健康聊天路径。该边界需以修复前失败 / 修复后通过的定向测试留证。


## D6a：两段公网的 msg 延迟对照（实施前登记）

补充独立的历史形状负载：Host 端生成有界 256 KiB 校验块，封成诊断 JSON `data` 帧，shared 放 msg，background 放 bulk；4 MiB 应用在途预算、原 E2E / piece / 生产 HostRelayClient / helper / Relay 均保留。每 100 ms 从参考客户端的 ctl 发出交互探针，Host 在 msg 回复，分别比较 WSS/WSS、QUIC/QUIC，三轮交错，两种 history mode 顺序也交错。预热 5 秒、固定 20 秒、最多 60 秒排空；保留所有未回复 / 不完整窗口。先跑本机冒烟，失败不混入正式样本。

这是网络及应用队列隔离对照：诊断 JSON 不是可直接交给 App 的 session.snapshot，预派生临时 E2E 密钥不包含业务握手。原 HostService 真 snapshot / ACK 与双端存储分别测试，本列不能替代真实 Agent / 手机 / SQLite / 显示 p95，也不把测量场景名 download 解释为文件功能。

使用与已有公网诊断相同真正 Relay IP、独立端口 / TLS 根 / 身份和临时容器；不修改生产、Hysteria 或全局 UDP 配置。CPU quota / UDP 缓冲仍原样记录，当前 iOS 模拟器负载是客户端性能环境限制。比较主指标为 msg 探针 p95 / p99、3 / 10 / 30 秒停顿数量及未完成数；字节吞吐只作背景信息，不外推为用户聊天提速比例。

2026-11-04 试验后收窄：初版候选也把 history 分页归入低优先级；公网背景字节速率并未显示统一收益。按 ADR-0029 的读取语义，手动 history 属于前台需求，最终仅 catchup 走 bulk，preview / history / live 保留 msg。诊断 JSON 表示后台补齐形状，不代表手动分页或 App 完整同步；原样本和初版测试记录保留。
