# ADR-0026：由源端选择会话同步响应

日期：2026-10-10

Status: accepted

2026-10-13：[ADR-0032](0032-host-owned-agent-state-model.md) 将通用 Host 的职责从路由、关联和背压扩展到统一模型管理与客户端恢复入口；来源核对、条件响应选择、范围预算与不新增全量聊天数据库继续有效。此为待实施的架构调整。

2026-10-22：[ADR-0037](0037-session-sync-transaction-contract.md) 明确本文"范围预算/背压"被拒时的设备语义：拒绝是重试信号，不是终态失败；Host 的准入参数不动。

2026-10-22：[ADR-0037](0037-session-sync-transaction-contract.md) 为本文的 `unchanged`/`state`/`delta` 选择补上提交语义：设备确认 applied 后记为 committed，ack 丢失后的重试返回 `unchanged`。本文的范围预算与条件响应选择继续有效。

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0064](0064-protocol-compatibility.md)。

## Context

聊天页进入前台及每 15 秒刷新时，都请求 `preview(maxEntries=30)`。源端选择当前分支末尾一页并附带 checkpoint，即使 APP 已经成功应用相同版本，仍重复传输完整历史和 live 正文。`knownLeafId` 仅用于 catchup；preview 不核对接收端进度。

只比较最新 Entry ID 不够：running 时正文、工具和 turn 可以变化而历史 head 不变。只比较收到的最高 seq 也不够：乱序 patch 可能尚未应用，或者数据库写入失败。轻量核对不能破坏 ADR-0024 的丢包恢复和 ADR-0025 的 epoch 权威边界。

## Decision

### 1. APP 报告已应用事实，源端决定内容

APP 以固定的 knownState 报告当前 Session 已持久化、已完整应用的基线；backend 根据来源核对与页面预算选择响应，Host 管理统一模型与背压。首次显示和缺口恢复沿用本地缓存及完整恢复路径。

### 2. preview 的四种明确响应

preview 按可信基线选择 unchanged、state、delta 或 snapshot：分别确认现有版本、更新 checkpoint、补连续后缀或恢复有界基线。来源完整性和已接受代次决定资格，历史范围按页补齐；原生修正通过新 epoch 收敛。

### 3. 原生核对、事务和迟到响应保持有效

条件响应建立在原生核对和事务持久化之上。响应与固定请求及当前状态共同校验，迟到结果按版本归属处理；显式重试恢复完整基线，周期核对复用已应用事实。

### 4. 协议与实施边界

条件响应初次引入于协议 11，后续演进遵循 ADR-0064；源端选择响应，Relay 路由密文，既有权威、范围与持久化契约继续适用。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。
