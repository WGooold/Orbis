# ADR-0050：仅保留 LAN / Relay，固定局域网优先

日期：2026-10-30

Status: accepted（代码实施与本机验证完成；发布验收待执行）

关联：[ADR-0064](0064-protocol-compatibility.md)、[ADR-0015](0015-relay-website-and-operator-console.md)、[部署指南](../deployment.md)、[ADR-0030](0030-multi-host-mobile-connections.md)、[ADR-0032](0032-host-owned-agent-state-model.md)。

## Context

连接契约需要统一为清晰、稳定的两种路径：局域网直连与中继。设置页的连接排序及逐 Host 下发会增加设备间行为差异，产品决定采用固定选路规则。

本次决定约束协议、Host、Android、iOS、桌面显示、配置、依赖、构建和部署文档，避免各端提供不同的连接契约。

## Decision

### 1. 仅支持 LAN 与 Relay

Host ↔ Device 的 Path 集合为 `lan | relay`。Host 连接摘要只发布这两种路径，最多两条。

优先级固定为 `["lan", "relay"]`，不提供用户或配置覆盖入口。Host 从已完成握手且可用的路径中选择 LAN，否则使用 Relay，并通过 `device.path` 通知设备；`rttMs` 是 Host 对路径测得的加密 ping 往返时间，只在设置页展示当前生效路径的最近公告样本，不参与换路决策。尚无样本时由设置页显示“暂不可用”（S23 / UI-07）。

2026-11-01 / r25：取代原先“只有多路径才采样”的实现，任一已完成加密握手的可用路径都按两秒节拍发送加密 ping；使用单调时钟计算 RTT，30 秒以上的回声样本丢弃，过期探针定期移除。只有当前活动路径的样本经 `device.path.rttMs` 发给手机。探针与回声复用 ctl 队列，保持同通道序号顺序；RTT 公告与换路回调分开，不清理会话同步、文件读取或订阅。手机断开连接时清空展示样本。

- LAN 未就绪时可先使用 Relay；LAN 就绪后立即切换至 LAN。
- LAN 中断时回落到可用的 Relay；LAN 恢复后立即切回。
- Relay 中断时，已有效的 LAN 继续使用；两条路径均不可用时显示离线。
- 每台 Host 的连接、加密会话、状态、重连和传输任务独立。

Relay 连接成功与端到端可用分别判断。现有发现与配对流程继续适用，本决定不新增离线配对或跨网段发现保证。

### 2. 完全删除可配置的优先级

删除 Android、iOS 设置页的排序入口、状态与事件，以及偏好存储、归一化、保存、握手后重发和多 Host 广播逻辑。

Host 不保存设备偏好，不暴露动态排序接口。旧安装保存的值停止读取和写回，不迁移为两项偏好；旧值即使是 Relay 优先，升级后仍固定 LAN 优先。无需清 App 数据或重新配对。

删除 `device.pathPreference` 的生产、解析、分派和设备偏好表。未知控制载荷按通用未知载荷处理，不能影响选路；非法路径公告不得改变当前状态或被映射为其他有效路径。

### 3. 保留共同传输契约

保留 DeviceLink、Envelope、E2E 握手、重放保护、分道序号、切片、背压和有界收发队列。
路径切换不重置配对信任、Session 身份、同步事务或文件持久化进度；失败与恢复遵守既有规则。

Relay 只转发不透明密文，Agent backend 与本机 loopback 的职责不变。管理台停用与撤销仅控制 Relay，不自动撤销 Host 配对或终止 LAN。

配置只保留实际使用的连接字段。已失效字段不再读取，保存时不再写回；保留 Relay 地址、LAN 端口、凭据与身份，不重建配对存储。

依赖、锁文件、项目引用、分发清单、许可证声明与实际产物保持一致。删除不再参与 LAN / Relay 的专用实现、依赖、配置与脚本，不保留隐藏开关或空实现。

### 4. 统一协议版本与发布

本路由清理初次实施于协议 16。当前发布按 [ADR-0064](0064-protocol-compatibility.md) 保持协议 18 起的基础互通，不能以删除旧路由为由要求已部署移动端同步升级。Relay 与 LAN 分别验证认证、共同格式和功能能力。

保留身份与配对材料，升级后按连接生命周期重新握手；不因更换路由清历史缓存或重新配对。部署与回滚遵循 [部署指南](../deployment.md)，线上网络设施调整另行记录。

## Consequences

连接与故障矩阵统一为 LAN / Relay。无可用 LAN 时，远程业务依赖 Relay；Relay 不可用且 LAN 不可达时无法远程连接。

Relay 的带宽成本、延迟、并发与文件吞吐需要实际验证；不得用放宽队列上限掩盖容量不足。安装包体积、构建耗时和耗电变化以实测为准。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 实施与验证记录

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。

## 2026-11-04 原生 QUIC 补充

[ADR-0065](0065-native-quic-relay-transport.md) 在移动端 Relay 路径内增加 QUIC 与认证前 WS 回退。逻辑路径仍只有 LAN / Relay；LAN 优先、端到端探测及原设置不变，不把 QUIC 传输 ready 当成 E2E ready。首版 Host ↔ Relay 仍用 WS。实施和设备门禁分别记录，专项 R67。
