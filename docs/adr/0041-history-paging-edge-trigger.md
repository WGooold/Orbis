# ADR-0041：历史分页只由「进入顶部区域」的边沿触发

日期：2026-10-23

Status: accepted（2026-10-23 实现 §1–§4；在线会话与离线历史页共用）

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md) §4、[ADR-0036](0036-sync-backpressure-is-not-failure.md) §2、[ADR-0040](0040-bounded-inbound-delivery.md)

## Context

历史分页现在是「视口在顶部就加载下一頁」的电平触发（[HistoryPaging.kt](../android/app/src/main/java/dev/pi/remote/HistoryPaging.kt)）：

- `historyPagingRequests` 用 `snapshotFlow { firstVisibleIndex() to anchorPending() }`，过滤 `index <= 1 && !pending`。
- 它被放在 `LaunchedEffect(runtimeId, sessionId, historyState?.hasOlder, historyRead?.operationId, historyRead?.phase, initialPositioned)` 里。`historyRead.operationId`/`phase` 每完成一页就变 → effect 重启 → `snapshotFlow` **重新发出当前值**（首帧）；只要视口仍在 `index <= 1`，就再请求一页。

于是「停在顶部」不再是一次用户动作，而是一个循环：一页 30 条 entry 落库、投影、产生一次 `session.snapshot`，紧接着请求下一页。现场日志里连续出现 `range=history` 的 `[DEBUG-history] start`（18:54:19.620 / 20.013 / 20.330，中间还夹着同一会话的 catchup），与这条路径一致。

这与 ADR-0036 §2 的判定冲突：历史分页是**用户动作**，失败要立刻可见、可重试；自动续页把用户停在顶部变成了无人监督的连续下载，并且每一页都会推高接收侧队列与 SQLite 写入（ADR-0040 的预算因此更容易被撞到）。

原实现想解决的是另一个问题：「一页 prepend 之后锚点释放，但首行没有移动，分页就停住」。该情形只在**页面短到撑不满视口**时出现；把它推广成「只要在顶部就继续」是这次循环的来源。

## Decision

### §1 触发条件是边沿，不是电平

只有视口从 `firstVisibleIndex > 1` **进入** `<= 1` 时触发一次。触发后必须离开顶部区域（`> 1`）才会重新武装；在同一位置反复重组、锚点释放、`hasOlder` 变化都不再触发。

### §2 一页完成后不自动续页

即使视口仍停在顶部，也必须等下一次「进入顶部区域」的边沿。用户想继续加载就再向上滑一次；这与 ADR-0036 §2 的「用户动作」语义一致。

### §3 阻断条件放在流内部，不作为 `LaunchedEffect` 的 key

`hasOlder == false`、历史读取进行中、锚点未释放、上一次读取失败，都用 `rememberUpdatedState` 在流内部读到最新值；`LaunchedEffect` 只以 `runtimeId`/`sessionId`/`initialPositioned` 为 key。key 变化会重启 `snapshotFlow` 并重放首帧，这正是电平触发循环的另一半。

### §4 失败仍然可见、可重试

读取失败不自动重试，保持现有的「失败卡片 + 重试按钮」（ADR-0036 §2）。边沿触发不改变失败语义。

## Consequences

- 停在顶部不再产生请求；`range=history` 的次数与用户上滑的次数同阶，而不是与停留时长同阶。
- 每次上滑仍只加载一页（30 条），行为对用户可见、可预期。
- 极端情形：页短到撑不满视口时，用户无法再上滑，因而不会自动补页。这是刻意取舍：由后续「列表不可滚动且 `hasOlder`」的显式入口解决，不在本 ADR 里用自动续页兜底。

## Verification

- 单测（`HistoryPagingTest`）：同一 index 的重复通知不触发；离开顶部再进入触发；加载中/无更多/失败时不触发；首次组合不触发。
- 设备：停在顶部 10 秒，`range=history` 不增加；每上滑一次最多一页；流式输出期间入站队列不出现持续积压（与 ADR-0040 的验证共测）。
