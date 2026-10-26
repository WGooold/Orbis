# ADR-0044：Codex live patch 合并与普通出站队列有界化

日期：2026-10-23

状态：accepted

关联：[ADR-0007](0007-channel-multiplexed-delivery.md)、[ADR-0010](0010-write-layer-slicing.md)、[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0035](0035-incremental-session-reconcile.md)、[ADR-0036](0036-sync-backpressure-is-not-failure.md)、[ADR-0037](0037-session-sync-transaction-contract.md)

## Context

用户可观察到：Codex 会话状态长时间不更新，重启 App 后才恢复；同时设备频繁出现 `sync busy`、`sync unavailable`，Host 进程内存曾累计约 209 MiB 以上甚至数百 MiB。

现场诊断记录在 `C:\Users\25892\.orbis\diagnostics.ndjson`。一次队列压力样本中，两个 Codex 会话的 `runtime.event/session.patch` 约占 392.1 MB，5 秒内入队约 35.8 MB、写出约 12.1 MB；DSH 约 5.7 MB。`sync busy` 发生在 `DeviceLink.sendSessionSnapshot()` 的 12 MiB 同步准入限制处，但普通 `msg` 没有相同的总字节上限，因此普通 patch 会继续堆积并挤压后续同步。

引入时间可以由 Git 历史确认：commit `ad9925b`（2026-10-08 14:49:45 +0800，`feat(sync): add Codex source checkpoints and versioned live patches`）首次把 Codex 的 `sourceSeq`、live 状态和完整累计 `session.patch` 接到 Host 事件出口。此后每次 `#setLiveMessage` / `#setLiveTool` 都会触发 `#touchSource`，发布包含完整 live 状态的 patch。

已有 ADR 没有覆盖这个组合问题：

- ADR-0024 解决版本化 checkpoint、epoch/seq 和丢事件后的恢复契约，但没有限制 Host 普通 `msg` 队列。
- ADR-0035 §15 规定 100ms 流式合并和“只有实际发布才推进 seq”，但其 `RecoverableSessionSource` 路径不包含 CodexRuntime 自己维护的 live 状态。
- ADR-0007 和 ADR-0010 规定 `ctl` 优先、`bulk` 水位、写入切片和不丢已封装帧；普通 `msg` / `ctl` 保持不丢，因此没有普通非 bulk 队列容量上限。
- ADR-0036 和 ADR-0037 只规定同步事务在背压时如何重试和结束，不能阻止普通 patch 先把队列填满。

## Decision

### 1. Codex live patch 采用单独的 100ms 合并窗口

Codex 的 live 更新在 `CodexRuntime.#touchSource` 内合并，默认窗口为 100ms。窗口内的多次 message/tool 更新只保留一次待发布状态；只有 `#flushSourcePatch` 真正发布时才递增 `sourceSeq`。读取 `session.sync` 版本前必须取消定时器并 flush，避免同步响应引用尚未发布的版本。

这延续 ADR-0035 §15 的版本语义，但明确把 CodexRuntime 纳入该规则。合并只降低发布速率，不替代队列上限。

### 2. 每条路径的普通出站队列必须有界

`OutboundChannelMux` 对每条路径分别记账并限制：

- `msg` 等待队列默认 32 MiB；
- `ctl` 等待队列默认 4 MiB；
- `bulk` 继续使用既有独立上限。

这些是应用层等待队列预算，不改变 socket 的 `bufferedAmount` 水位，也不把 `bulk` 预算挪给普通消息。预算按封装后的线上字节估算，诊断按 runtime、session 和 event type 归因。

### 3. 超载必须在 seal 之前处理

调用方在 `DeviceLink.#sendSealed` 封装 E2E 信封、消耗 nonce 和发送序号之前，先向对应 mux 查询该 channel 是否有空间。没有空间时返回拒绝并记录原因，不调用 `seal()`。`sendSessionSnapshot` 继续保留自身的同步并发和 12 MiB wire 预算，并使用同一条普通 `msg` 准入检查。

`OutboundChannelMux.enqueue()` 不负责丢弃已经封好的帧。写入失败的帧仍按 ADR-0007/0010 在队首重试；只有路径会话已经失效、确认新 E2E 会话时才清理旧队列。

### 4. 普通队列溢出触发路径恢复

普通非 bulk 准入失败表示该路径无法在当前队列预算内继续承载有序业务帧。`DeviceLink` 记录带 path、channel、source 和字节数的诊断，并摘除该路径，让选路器切换到其他路径；没有其他路径时保持不可用，等待下一次握手。旧会话的已封装帧只在路径会话失效/新握手边界清理，不在正常排队过程中静默删除。

重新握手后，Host 重播 runtime 目录和能力；设备按现有 `session.sync` 恢复协议重新获取当前 checkpoint。Codex 的 epoch/seq、Host 的 `AgentConversationState` 基线校验和设备端 source patch gap 恢复规则不变。这样不会伪造连续 seq，也不会把丢失的 patch 当作已交付。

### 5. 诊断必须留下可归因记录

每 5 秒最多记录一份队列压力样本，包含总队列字节、普通/ bulk 字节、socket backlog、窗口内入队/写出字节、写错误、最老帧等待时间，以及最多八个来源分组。普通队列准入拒绝另记 path、channel、payloadBytes、queuedBytes 和 source 元数据。日志只保存路由和计数信息，不保存 live 内容。

## Consequences

- 正常局域网链路上，Codex patch 只保留 100ms 内的最后状态，减少完整 live patch 的发布次数。
- 慢客户端或停止读取时，普通队列最多占用每路径 36 MiB 的应用层预算，不能再无限增长到数百 MiB。
- 队列溢出会使该路径重新握手，短暂产生一次恢复延迟；这是为了保持 E2E 序号、source epoch/seq 和可恢复 sync 的一致性。
- `sync busy` 仍可能在同步事务并发数、同步 wire 预算或路径确实不可用时出现，但不再由普通 `session.patch` 无限积压制造。

## Verification

必须覆盖以下行为：

1. Codex 在 100ms 内的 burst live 更新只发布一个递增 seq 的 patch；同步请求会先 flush pending patch。
2. `msg` 和 `ctl` 队列分别受预算限制；预算不足时不会调用 `seal()`，不会推进 E2E 序号，也不会进入 mux。
3. 已封装帧不会因普通队列达到预算而被静默丢弃；写失败仍按队首重试。
4. 普通队列准入拒绝会记录有来源的诊断并摘除路径；新握手后可以通过现有 `session.sync` 恢复当前 Codex checkpoint。
5. 双 Codex 会话、慢客户端、停止读取、控制帧可达性和重连恢复测试通过；`sync busy` 诊断能区分 `message_byte_limit`、`sync_byte_limit`、`delivery_limit` 与 `path_unavailable`。
