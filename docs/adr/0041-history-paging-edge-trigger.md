# ADR-0041：历史分页只由「进入顶部区域」的边沿触发

日期：2026-10-23

Status: accepted（2026-10-23 实现 §1–§4；在线会话与离线历史页共用）

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md) §4、[ADR-0037](0037-session-sync-transaction-contract.md) §5、[ADR-0040](0040-bounded-inbound-delivery.md)

## Context

历史分页现在是「视口在顶部就加载下一頁」的电平触发（[HistoryPaging.kt](../../android/app/src/main/java/com/orbising/orbis/HistoryPaging.kt)）：

- `historyPagingRequests` 用 `snapshotFlow { firstVisibleIndex() to anchorPending() }`，过滤 `index <= 1 && !pending`。
- 它被放在 `LaunchedEffect(runtimeId, sessionId, historyState?.hasOlder, historyRead?.operationId, historyRead?.phase, initialPositioned)` 里。`historyRead.operationId`/`phase` 每完成一页就变 → effect 重启 → `snapshotFlow` **重新发出当前值**（首帧）；只要视口仍在 `index <= 1`，就再请求一页。

于是「停在顶部」不再是一次用户动作，而是一个循环：一页 30 条 entry 落库、投影、产生一次 `session.snapshot`，紧接着请求下一页。现场日志里连续出现 `range=history` 的 `[DEBUG-history] start`（18:54:19.620 / 20.013 / 20.330，中间还夹着同一会话的 catchup），与这条路径一致。

这与 ADR-0037 §5 的判定冲突：历史分页是**用户动作**，失败要立刻可见、可重试；自动续页把用户停在顶部变成了无人监督的连续下载，并且每一页都会推高接收侧队列与 SQLite 写入（ADR-0040 的预算因此更容易被撞到）。

原实现想解决的是另一个问题：「一页 prepend 之后锚点释放，但首行没有移动，分页就停住」。该情形只在**页面短到撑不满视口**时出现；把它推广成「只要在顶部就继续」是这次循环的来源。

## Decision

### §1 按上滑边沿触发

历史分页由视口进入顶部区域的边沿触发，离开后重新武装；当前实现阈值为 firstVisibleIndex 从大于 1 进入小于等于 1。

### §2 每页沿用独立手势

后续分页由新的用户边沿或显式加载操作触发。

### §3 在观察流内判断准入

读取流内部观察最新准入状态，订阅生命周期绑定会话身份与初次定位状态。

### §4 失败仍然可见、可重试

读取失败保留错误与显式重试入口，沿用既有操作生命周期。

### §5 顶部提供显式加载入口

存在更早历史时提供加载入口，展示读取状态与恢复操作；按钮和边沿共用同一读取入口。

## Consequences

- 停在顶部不再产生请求；`range=history` 的次数与用户上滑的次数同阶，而不是与停留时长同阶。
- 每次上滑仍只加载一页（30 条），行为对用户可见、可预期。
- 当前页短到撑不满视口或用户已在顶部时，不会自动补页；顶部显式入口仍允许用户继续加载。

## Verification

[测试规则](../../AGENTS.md#测试)；[HistoryPagingTest.kt](../../android/app/src/test/java/com/orbising/orbis/HistoryPagingTest.kt)；[原始证据](../../.artifacts/)。
