# ADR-0035：会话状态 reconcile 与同步增量提交

日期：2026-10-21

2026-10-22：[ADR-0039](0039-content-change-signals.md) 把本文 §12 的"修订号优先于内容哈希"扩展到 Host 权威模型层、App 投影层与 DSH 显示索引：entries 边界冻结 + 引用存储、条目级内容派生修订号、投影按行依赖复用。

Status: accepted（2026-10-22：增量提交、输出预算与 DSH 原生日志增量读取已实现；终端按追加帧读取，Web 沿用游标分页。运行中的 Host / Pi 更新经授权重启后生效）

2026-10-22 溯源：本文修的这套“按全量重算”写法由 [ADR-0024](0024-recoverable-session-state-sync.md) 一次性引入（commit `15b9b23`，2026-10-10「feat(sync): recover Pi and DSH state and unify protocol 12 updates」，52 个文件）；ADR-0026 / 0032 沿用该机制，但都没有再审视它的成本。

关联：[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0034](0034-image-content-references.md)

## Context

现象：手机连上 Host 之后，Pi 读图开始，内存疯狂上涨，随后整机卡死。

根因不在 Pi 本体，而在扩展的同步路径把「一次 sync」定义成了「把整段历史重新比较、重新拷贝一遍」，而这个成本与历史里图片的 base64 成正比。

### 当前实现

1. 每次 `session.sync` 都**强制**核对：[`syncSession`](../../packages/pi-extension/src/index.ts) 里 `reconcileSource(ctx, true)`，两条路径都在 pi 的事件循环里同步执行。
2. [`RecoverableSessionSource.reconcile`](../../packages/protocol/src/session-source.ts) 无条件做两件整段历史的活：
   - `entries.some(entry => JSON.stringify(old) !== JSON.stringify(entry))` —— 每条 Entry 两遍 `JSON.stringify`；
   - `this.#entries = new Map(entries.map(entry => [entry.entryId, structuredClone(entry)]))` —— 整段历史深拷贝一遍（含所有 base64）。
   两者都**与内容是否变化无关**。
3. 同一条路还会被两处额外触发：15s 的运行状态节拍（`index.ts` 的 `startStatusReconcile`）和每轮的 `message.started` / `message.finished` / `turn.finished` / `tool.finished`（`publishSessionEvent` 的 force 参数）。
4. 手机侧调度允许 2 路并发 + preview/catchup/history 分页（[SessionSyncTasks.kt](../../android/app/src/main/java/com/orbising/orbis/SessionSyncTasks.kt)），实际是秒级多次 sync。

### 实测（仓库 `dist` + 真实 Entry 形状，本机 Node 22，单次 = 一次 sync 的 `reconcile` + `sessionGraphFromEntries`）

| 会话里的截图 | 单次 sync | 常驻 heap / RSS |
| --- | --- | --- |
| 0 张（纯文本） | **0.8ms** | 12MB / 74MB |
| 13 张，12MB base64 | 43ms | 24MB / 88MB |
| 73 张，72MB base64 | **~400ms（同步阻塞）** | 220MB / 283MB |

- 用户本机确实存在这种会话：`~/.pi/agent/sessions/` 下 `--D--mcc-hmd-emotion--` 有一条 **73 张图 / 71.9MB**，`--D--orbis--` 下另有 48 张 / 18.9MB、58 张、69 张的会话（2026-10-21 统计，42 条会话含图片）。
- 400ms 不是排队等待，是**同步阻塞**：TUI 输入、后续命令、其他设备的请求全部排队，于是"卡死"；同期 V8 在数百 MB 的分配里来回 GC，于是"内存疯狂上涨"。
- 单条 Entry 超 1MB 时另有一个硬失败：`SESSION_SYNC_MAX_BYTES = 1MB` 会抛 `session_entry_too_large`（[session-sync.ts](../../packages/protocol/src/session-sync.ts)），真实截图 0.7–1.7MB，翻历史到那张图必然失败——这条由 ADR-0034 的裁剪解决，但不该靠"碰巧不超"来工作。

### 回合运行期间是另一条路径（与 sync 无关）

`message_update`（每个流式 token）都会走一次 `sessionSource.transaction`（[index.ts](../../packages/pi-extension/src/index.ts)），而 `transaction()` 在 depth 0 时前后各算一次 `#fingerprint()`，`#flush()` 还要调 `snapshot()`（`structuredClone` live 状态）并 `JSON.stringify(patch)`。这三步都按 **live 字节数**计价，而 live tools 里保留着工具结果的深拷贝（`observe` 的 `structuredClone(detail)`），其中包括 `read` 一张截图的 ~1MB base64（Pi 上限 4.5MB），直到该 toolResult 落盘并被 reconcile 清掉。

实测（1MB live 工具结果 + 300 个 delta）：**6.78ms/token**；空 live 时 **0.31ms/token**（22×）。整回合是 O(token × live) = O(n²)，并且每个 token 还会发布一份完整 `session.patch`——即使没有任何 sync。

### 打开 App 加载聊天记录：页数 × 全量重算

App 的 `historyPageSize` 是 30 条（[HostConnection.kt](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)），每翻一页发一次 `session.sync`，而 `syncSession` 每接一次都做完整一轮：强制 reconcile（全历史两遍 `JSON.stringify` + 一遍 `structuredClone`）→ `sessionEntriesFromEntries` 重建全部条目 → `selectSessionSyncSnapshot` 对**全部条目**建 `byId` 并跑一遍 `projectDisplayEntries`，然后只取其中一页。

于是加载一次历史的总成本是 **O(页数 × S) = O(S² / 每页条数)**，与每一页只有多少条无关。实测（本仓 `scripts/perf/session-memory-stress.mjs --scene pages`，纯文本会话，每页 30 条）：

| S | 条目数 | 页数 | Pi 侧总耗时 | 峰值 heap | 累计分配 |
| --- | --- | --- | --- | --- | --- |
| 10MB | 4,280 | 143 | 8.1s | 263MB | 2.9–5.7GB |
| 30MB | 12,840 | 428 | **70.7s** | 617MB | **26–51GB** |

这就是“打开 App 加载聊天记录，内存疯狂上涨然后 OOM”的形状：加载一次历史要付几十 GB 的分配，而且**与读不读图无关**——图片只是把 S 抬高。

### 发件队列的内存放大（2026-10-22 现场复现）

用户环境实测：Host 拉起的 Pi（`--session …\--D--mcc-hmd-emotion--\…jsonl -e …\pi-extension\dist\index.js`）在会话文件 3.6MB / 281 条 / 21 张图、**会话文件停止写入**的情况下，RSS 从 2.6GB 涨到 4.1GB（≈45MB/s），CPU 只有个位数，随后进程消失。同期宿主日志里 20 次 `ECONNREFUSED 127.0.0.1:1`、11 次 sync，Host 诊断里 1018 条 “Rejected conversation transaction; source baseline required”。

隔离实验（`scripts/perf/session-memory-stress.mjs --scene sendqueue`）：让对端在 `runtime.ready` 之后停止读取，扩展连续 publish 1MB 事件——**RSS 线性涨到 643MB，而 V8 heap 稳定在 13MB**。也就是说内存不在会话模型里，而在 `ws` 的 outbound buffer：`publish` 只看 `readyState`，从不看 `bufferedAmount`，对端一慢（Host 正在对每个事件做 `JSON.stringify` 计量与 `structuredClone`）就无限排队。

### 这套写法是谁引入的（ADR-0024，commit `15b9b23`）

`structuredClone`、`#fingerprint`、每次 sync 的 `reconcileSource(ctx, true)` 三样东西出自**同一个提交**，也就是 ADR-0024 的落地。它当时的取舍是明确写过的：

- **克隆 = 快照隔离。** 协议承诺“手机拿到的这份响应不会被后续修改污染”（`session-source.test.ts` 里那条 “Captured response cannot mutate after commit”）。所以那是刻意的防御，不是顺手复制。
- **强制核对 = 不用过期状态回答。** Pi 的扩展 API 只给整份 `getEntries()`，没有条目级版本号也没有变更通知；扩展手上只有自己存的那份副本，于是只能做通用 diff（`JSON.stringify`），`#fingerprint` 是同一思路用在事务边界上。这是 API 形状逼出来的实现。
- **当时没有成本模型。** 会话是文本量级，协议只给了每页 256KB / 单条 1MB 的字节预算。图片后来以 base64 进入 Pi 会话——**代码一行没改，单价从 KB 变成 MB**。测试只断言行为（恢复正确、快照不可变），不断言成本，所以这次退化一路都是绿的。
- ADR-0026（Host 选中 sync）和 ADR-0032（Host 拥有模型）都在这套机制上继续叠，没有回头审视“每次按全量付费”。

### 三个后端的适用范围

| 缺陷/能力 | Pi（独立进程） | DSH / DSH Web（Host 内） | Codex（Host 内） |
| --- | --- | --- | --- |
| 每次 sync 全量 reconcile | ✅ 强制；本 ADR §3 已去掉 | ⚠️ `dsh-runtime.ts` 的 `#refresh()` **每次 sync 重读整份原生日志**再 `reconcile`（未改）；`dsh-web-runtime.ts` 只在 preview 时 `#checkSource`，history 页不 reconcile | ❌ 不自带 `RecoverableSessionSource`，thread 状态由自己增量维护 |
| 每页重建全部投影 | ✅ §8 已接 `prepare` 缓存 | ⚠️ 仍走一次性包装（prepare + select 每页重来） | ⚠️ 同上 |
| 图片 base64 进模型 | ✅ ADR-0034 已裁 | ❌ 早已是占位文本（`dsh-history.ts` 的 `[图片：…]`） | ⚠️ 用户消息只取文本；**工具结果仍整份 `resultText` stringify**（ADR-0034 §5，未改） |
| 发件队列无上界 | ✅ §9 已加背压（4GB OOM 的唯一来源） | ❌ 走 Host 的 `outbound-mux.ts`（水位 + 封帧前丢弃） | ❌ 同上 |
| 会话库列表每次连接重扫 | ✅ §10 已加 TTL 缓存 | 不适用（同一 Host 进程共用一份扩展实例） | 不适用 |

一句话：**“每页 O(S)”是三家共享的；“每 sync 强制 reconcile”Pi 和 DSH 各有版本；“发件无上界”只有 Pi——因为只有 Pi 是独立进程 + 裸 `ws`。**

## Decision

1. 内容摄取时检测变化，变更信号随来源传播。
2. 未变的 Entry 按原生身份复用。
3. 常规同步按来源变化核对状态。
4. 实时路径共用媒体载荷预算。
5. 内容生产者确定 canonical 投影。
6. 来源恢复沿用既有 epoch / seq。
7. live 按实际增量发布。
8. 队列保持有界，超限后恢复基线。
9. 会话目录通过 TTL 缓存复用。
10. 历史按页工作，缓存随源版本失效。
11. Pi、Codex、DSH 与 DSH Web 共享增量核对和分页原则。
12. live 条目以内容修订号标识变化。
13. 构造前核验预算，seq 随实际发布推进。
14. 按 resync 原因选择重建范围。
15. 发布按窗口合并，读取版本前完成 flush。
16. DSH 按已验证日志布局增量读取追加帧，并保留原 API 的恢复路径。

当前合并窗口为 100ms，目录 TTL 为 60 秒，扩展发布高 / 低水位为 8MB / 2MB。DSH 的 Host 侧帧增量测量为：8.7MB 会话、5240 帧、11,978 事件，整份 373ms，追加一帧 7ms，未变 0ms；原生游标 API 尚未接入。

2026-11-08：Pi 回合起止作为具名边界在窗口外显式发布，已完成的原生结果保留到下一回合；普通流式片段继续合并。事务的净变化指纹包含回合结果，后来的空事务保留先前尚未发布的变化，避免同步读取吞掉正文或完成事实。实现与回归：[session-source.ts](../../packages/protocol/src/session-source.ts)、[source 测试](../../packages/protocol/src/session-source.test.ts)、[Pi 集成测试](../../packages/pi-extension/src/session-source.test.ts)；[本次执行证据](../../.artifacts/design-alignment-20261108/source-outcome-recovery-tests.log)。

参考：[ADR-0040](0040-bounded-inbound-delivery.md)。

### 17. 超预算 canonical 批次转为 checkpoint 恢复（2026-11-03）

超预算 canonical 批次建立 unknown 边界并通过有界 checkpoint 收敛；保留原生历史与可恢复状态，正常批次按连续版本原子提交。

## Consequences and verification

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。
