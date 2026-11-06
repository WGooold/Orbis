# ADR-0044：Codex live patch 合并与普通出站队列有界化

日期：2026-10-23

2026-10-27：[ADR-0045](0045-tool-summaries-and-on-demand-content.md) 将工具内容移出共享 live：工具原文字节追加不再要求重发聊天 patch，库存引用与摘要独立分页/修订。本文的来源合并、普通出站预算及封帧后完整有序交付规则继续适用；工具详情另用有界 bulk 队列。

状态：accepted

关联：[ADR-0010](0010-write-layer-slicing.md)、[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0035](0035-incremental-session-reconcile.md)、[ADR-0037](0037-session-sync-transaction-contract.md)

## Context

用户可观察到：Codex 会话状态长时间不更新，重启 App 后才恢复；同时设备频繁出现 `sync busy`、`sync unavailable`，Host 进程内存曾累计约 209 MiB 以上甚至数百 MiB。

现场诊断记录在 `C:\Users\25892\.orbis\diagnostics.ndjson`。一次队列压力样本中，两个 Codex 会话的 `runtime.event/session.patch` 约占 392.1 MB，5 秒内入队约 35.8 MB、写出约 12.1 MB；DSH 约 5.7 MB。`sync busy` 发生在 `DeviceLink.sendSessionSnapshot()` 的 12 MiB 同步准入限制处，但普通 `msg` 没有相同的总字节上限，因此普通 patch 会继续堆积并挤压后续同步。

引入时间可以由 Git 历史确认：commit `ad9925b`（2026-10-08 14:49:45 +0800，`feat(sync): add Codex source checkpoints and versioned live patches`）首次把 Codex 的 `sourceSeq`、live 状态和完整累计 `session.patch` 接到 Host 事件出口。此后每次 `#setLiveMessage` / `#setLiveTool` 都会触发 `#touchSource`，发布包含完整 live 状态的 patch。

已有 ADR 没有覆盖这个组合问题：

- ADR-0024 解决版本化 checkpoint、epoch/seq 和丢事件后的恢复契约，但没有限制 Host 普通 `msg` 队列。
- ADR-0035 §15 规定 100ms 流式合并和“只有实际发布才推进 seq”，但其 `RecoverableSessionSource` 路径不包含 CodexRuntime 自己维护的 live 状态。
- ADR-0010 规定 `ctl` 优先、`bulk` 水位、写入切片和不丢已封装帧；普通 `msg` / `ctl` 保持不丢，因此没有普通非 bulk 队列容量上限。
- ADR-0037 只规定同步事务在背压时如何重试和结束，不能阻止普通 patch 先把队列填满。

## Decision

### 1. Codex live patch 采用单独的 100ms 合并窗口

Codex live 更新按 100ms 窗口合并，实际发布时推进 sourceSeq；同步读取前 flush 待发布状态。

CODEX-LIVE-01（2026-11-06）：已验证来源仍在输出、原生历史确认同一轮运行中但暂缺当前消息时，周期核对与重新激活保留实时正文并消费缓冲通知，待完整历史再重建。消息完成、新轮次与显式回退沿用权威替换；首个 delta 补建消息时同步登记原生条目身份。

### 2. 每条路径采用有界出站队列

每条路径按封装后的字节核算有界队列，普通消息与 bulk 各自保留预算。当前 msg 为 32 MiB、ctl 为 4 MiB，bulk 使用原独立上限。

### 3. 封帧前处理超载

封帧前完成通道准入与预算预留，已封密文按原顺序投递；路径失效与新握手边界负责旧会话清理。同步响应保留自身事务与 12 MiB 线路预算。

### 4. 普通队列溢出触发路径恢复

准入失败记录归因并使该路径进入恢复，其他可用路径继续服务；重新握手后按既有同步契约重建基线。

### 5. 可归因的诊断记录

诊断记录有界的路径、通道、来源和队列元数据，区分准入、写入与应用阶段；压力采样沿用 5 秒限频和八个来源分组上限。

## Consequences

- 正常局域网链路上，Codex patch 只保留 100ms 内的最后状态，减少完整 live patch 的发布次数。
- 慢客户端或停止读取时，普通队列最多占用每路径 36 MiB 的应用层预算。
- 队列溢出会使该路径重新握手，短暂产生一次恢复延迟；这是为了保持 E2E 序号、source epoch/seq 和可恢复 sync 的一致性。
- `sync busy` 仍可能在同步事务并发数、同步 wire 预算或路径确实不可用时出现，但不再由普通 `session.patch` 无限积压制造。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

CODEX-LIVE-01 实现与回归见 [codex-runtime.ts](../../packages/host/src/codex-runtime.ts)、[codex-runtime.test.ts](../../packages/host/src/codex-runtime.test.ts)，合成复现、自动检查和资源释放证据见 [verification.json](../../.artifacts/codex-stream-continuity-20261106/verification.json)。代码修复与自动验证完成；未部署，Android 真机待用户验证。
