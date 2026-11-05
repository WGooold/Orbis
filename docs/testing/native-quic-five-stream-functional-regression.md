# 五流功能回归（NQ-14 / R67）

日期：2026-11-05（Asia/Taipei）。依据 [ADR-0065 §11](../adr/0065-native-quic-relay-transport.md#11-history--catchup--bulk-独立五流2026-11-05)。用户明确此次不再测速，仅验证功能；不执行公网或吞吐 / 延迟对照，不沿用旧数字作为五流结论。

五流保持 ctl / 实时 msg，新增独立 history、catchup，顺序 history > catchup > bulk；preview 留 msg，文件 / 详情留 bulk。显式 background 与已认证的 E2E 能力共同控制启用；基础 HS1 不变，旧端、WS 与 LAN 保留原契约。

| 层次 | 功能断言与覆盖 |
| --- | --- |
| 协议 / 加密 | 五通道槽位唯一，旧三槽位不变；跨流提前到达不毒化其他流高水位；重复密文仍丢弃；篡改通道 / 能力 MAC / 接受标识失败；新旧 Host / App 四组合握手保持共同能力，HS1 原样 |
| 原生 Go / IPC | v2 三流和 v3 五流同服务，Host / device 固定角色，错 lane 拒绝；每流 FIFO，父进程 EOF / 取消关闭全部泵；旧密文退休覆盖两条新流；总历史预算不扩大 |
| Host 业务 | 请求不可变 range 决定 history/catchup，preview / LAN 保持；原 session.snapshot / applied ACK、pending / 操作身份、进展与路径丢失收尾；四种 Host / device WS/QUIC 组合的原业务套件 |
| 手机消费 | msg > history > catchup > bulk，history/catchup 共用原 session 消费预算；淘汰触发 session 恢复；二进制 offset 恢复保留；先 live 后历史不改变来源提交与阅读锚点 |
| Apple 实际互通 | v2/v3 × auto/quic 实际 Network.framework ↔ Go；原加密配对、消息、文件、重握手、WS↔QUIC 与 LAN 保持，同时验证 history / catchup 分片内容 |
| Android JNI / App | 新旧 JNI 五/三流，证书与取消，完整 JVM、Debug / AndroidTest 构建；同共享 API 35 上原全量 UI 与基线逐项比较 |
| 原功能 / UI | Node 原全量、Swift 原全量、Android JVM 原全量保留；双端同设备基线 / 候选 L3，无新增失败或缺失原用例；既有失败、完整 L4 / 人工 / 真机仍单列，不能当全部通过 |

主要用例：`history-streams.test.ts`、DeviceLink 的五流投递 / 失联、原 HostService range/applied 及业务套件；`five_streams_test.go`、原 Go 传输与 hostipc 套件；双端 Protocol / InboundFrameLanes、Apple RelayQUICInterop / RelayQUICBusiness、Android RelayQuicInstrumentedTest。不会删除、跳过或放宽旧断言来凑通过。

发现仅在显式 `ORBIS_RELAY_QUIC_HISTORY_STREAMS=1` 且新 adapter 已部署后声明 v3；旧 v2 字段继续保留。默认 WS/shared 不变。此次只在隔离夹具中启用，不部署用户 Relay / Host、不安装用户手机。

证据根：`.artifacts/quic-five-streams/20261105/`；设备索引保存于 `.artifacts/ui-regression/`。源码 / 包 hash、失败集合、原始日志和资源 cleanup 独立记录。测试完成与实际手机停更消失分别判定。逐层结果与中间失败见[五流结果报告](native-quic-five-stream-results-20261105.md)。
