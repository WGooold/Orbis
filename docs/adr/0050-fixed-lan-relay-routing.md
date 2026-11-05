# ADR-0050：仅保留 LAN / Relay，固定局域网优先

日期：2026-10-30

Status: accepted（代码实施与本机验证完成；发布验收待执行）

关联：[ADR-0064](0064-protocol-compatibility.md)、[ADR-0015](0015-relay-website-and-operator-console.md)、[部署指南](../deployment.md)、[ADR-0030](0030-multi-host-mobile-connections.md)、[ADR-0032](0032-host-owned-agent-state-model.md)。

## Context

连接契约需要统一为清晰、稳定的两种路径：局域网直连与中继。设置页的连接排序及逐 Host 下发会增加设备间行为差异，产品决定采用固定选路规则。

本次决定约束协议、Host、Android、iOS、桌面显示、配置、依赖、构建和部署文档，避免各端提供不同的连接契约。

## Decision

### 1. 仅支持 LAN 与 Relay

Path 集合固定为 lan / relay，按可用性优先使用已认证 LAN，再使用 Relay；连接、任务与恢复按 Host 独立维护。RTT 作为当前路径的展示事实。

当前探针节拍为 2 秒，回声样本有效范围为 30 秒；探针使用加密 ctl 通道和单调时钟。

### 2. 完全删除可配置的优先级

路由统一采用固定 LAN 优先策略，升级保留配对与身份；配置和协议按当前有效字段读写，旧排序入口随迁移退出。

### 3. 保留共同传输契约

路径切换保持信任、会话身份、同步事务和文件持久进度，沿用 E2E、有界队列与恢复契约；Relay 管理其传输权限，Host 管理配对信任。依赖与分发清单跟随实际产物。

### 4. 统一协议版本与发布

当前发布遵循 ADR-0064 的已部署端兼容要求，LAN 与 Relay 分别取得互通证据；升级保留身份与数据，部署与回滚按部署指南完成。

参考：[ADR-0064](0064-protocol-compatibility.md)；[部署指南](../deployment.md)。

## Consequences

连接与故障矩阵统一为 LAN / Relay。无可用 LAN 时，远程业务依赖 Relay；Relay 不可用且 LAN 不可达时无法远程连接。

Relay 的带宽成本、延迟、并发与文件吞吐需要实际验证，队列容量保持有界。安装包体积、构建耗时和耗电变化以实测为准。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 实施与验证记录

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。

## 2026-11-04 原生 QUIC 补充

[ADR-0065](0065-native-quic-relay-transport.md) 在移动端 Relay 路径内增加 QUIC 与认证前 WS 回退。逻辑路径仍只有 LAN / Relay；LAN 优先、端到端探测及原设置不变，不把 QUIC 传输 ready 当成 E2E ready。首版 Host ↔ Relay 仍用 WS。实施和设备门禁分别记录，专项 R67。
