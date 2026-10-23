# ADR-0035：会话状态 reconcile 增量提交，同步路径不再全量深拷贝

日期：2026-10-21

2026-10-22：[ADR-0039](0039-content-change-signals.md) 把本文 §12 的"修订号优先于内容哈希"扩展到 Host 权威模型层、App 投影层与 DSH 显示索引：entries 边界冻结 + 引用存储、条目级内容派生修订号、投影按行依赖复用。

Status: accepted（2026-10-22 实现 §1/§2/§3/§7/§8/§9/§10/§12/§13/§15 与 §11 的 2/3 项；§11-1 的"DSH 增量读原生日志"仍受 DSH 持久化 API 限制；运行中的 Host/Pi 需另行授权才重启生效）

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
4. 手机侧调度允许 2 路并发 + preview/catchup/history 分页（[SessionSyncTasks.kt](../../android/app/src/main/java/dev/pi/remote/SessionSyncTasks.kt)），实际是秒级多次 sync。

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

App 的 `historyPageSize` 是 30 条（[HostConnection.kt](../../android/app/src/main/java/dev/pi/remote/HostConnection.kt)），每翻一页发一次 `session.sync`，而 `syncSession` 每接一次都做完整一轮：强制 reconcile（全历史两遍 `JSON.stringify` + 一遍 `structuredClone`）→ `sessionEntriesFromEntries` 重建全部条目 → `selectSessionSyncSnapshot` 对**全部条目**建 `byId` 并跑一遍 `projectDisplayEntries`，然后只取其中一页。

于是加载一次历史的总成本是 **O(页数 × S) = O(S² / 每页条数)**，与每一页只有多少条无关。实测（本仓 `scripts/perf/session-memory-stress.mjs --scene pages`，纯文本会话，每页 30 条）：

| S | 条目数 | 页数 | Pi 侧总耗时 | 峰值 heap | 累计分配 |
| --- | --- | --- | --- | --- | --- |
| 10MB | 4,280 | 143 | 8.1s | 263MB | 2.9–5.7GB |
| 30MB | 12,840 | 428 | **70.7s** | 617MB | **26–51GB** |

这就是“打开 App 加载聊天记录，内存疯狂上涨然后 OOM”的形状：加载一次历史要付几十 GB 的分配，而且**与读不读图无关**——图片只是把 S 抬高。

### 压垮进程的不是会话数据，而是发件队列（2026-10-22 现场复现）

用户环境实测：Host 拉起的 Pi（`--session …\--D--mcc-hmd-emotion--\…jsonl -e …\pi-extension\dist\index.js`）在会话文件 3.6MB / 281 条 / 21 张图、**会话文件停止写入**的情况下，RSS 从 2.6GB 涨到 4.1GB（≈45MB/s），CPU 只有个位数，随后进程消失。同期宿主日志里 20 次 `ECONNREFUSED 127.0.0.1:1`、11 次 sync，Host 诊断里 1018 条 “Rejected conversation transaction; source baseline required”。

隔离实验（`scripts/perf/session-memory-stress.mjs --scene sendqueue`）：让对端在 `runtime.ready` 之后停止读取，扩展连续 publish 1MB 事件——**RSS 线性涨到 643MB，而 V8 heap 稳定在 13MB**。也就是说内存不在会话模型里，而在 `ws` 的 outbound buffer：`publish` 只看 `readyState`，从不看 `bufferedAmount`，对端一慢（Host 正在对每个事件做 `JSON.stringify` 计量与 `structuredClone`）就无限排队。

### 这套写法是谁引入的（ADR-0024，commit `15b9b23`）

`structuredClone`、`#fingerprint`、每次 sync 的 `reconcileSource(ctx, true)` 三样东西出自**同一个提交**，也就是 ADR-0024 的落地。它当时的取舍是明确写过的：

- **克隆 = 快照隔离。** 协议承诺“手机拿到的这份响应不会被后续修改污染”（`session-source.test.ts` 里那条 “Captured response cannot mutate after commit”）。所以那是刻意的防御，不是顺手复制。
- **强制核对 = 不用过期状态回答。** Pi 的扩展 API 只给整份 `getEntries()`，没有条目级版本号也没有变更通知；扩展手上只有自己存的那份副本，于是只能做通用 diff（`JSON.stringify`），`#fingerprint` 是同一思路用在事务边界上。这是 API 形状逼出来的实现。
- **当时没有成本模型。** 会话是文本量级，协议只给了每页 256KB / 单条 1MB 的字节预算。图片后来以 base64 进入 Pi 会话——**代码一行没改，单价从 KB 变成 MB**。测试只断言行为（恢复正确、快照不可变），不断言成本，所以这次退化一路都是绿的。
- ADR-0026（Host 选中 sync）和 ADR-0032（Host 拥有模型）都在这套机制上继续叠，没有回头审视“每次按全量付费”。

### 三个后端的适用面（不是只有 Pi）

| 缺陷/能力 | Pi（独立进程） | DSH / DSH Web（Host 内） | Codex（Host 内） |
| --- | --- | --- | --- |
| 每次 sync 全量 reconcile | ✅ 强制；本 ADR §3 已去掉 | ⚠️ `dsh-runtime.ts` 的 `#refresh()` **每次 sync 重读整份原生日志**再 `reconcile`（未改）；`dsh-web-runtime.ts` 只在 preview 时 `#checkSource`，history 页不 reconcile | ❌ 不自带 `RecoverableSessionSource`，thread 状态由自己增量维护 |
| 每页重建全部投影 | ✅ §8 已接 `prepare` 缓存 | ⚠️ 仍走一次性包装（prepare + select 每页重来） | ⚠️ 同上 |
| 图片 base64 进模型 | ✅ ADR-0034 已裁 | ❌ 早已是占位文本（`dsh-history.ts` 的 `[图片：…]`） | ⚠️ 用户消息只取文本；**工具结果仍整份 `resultText` stringify**（ADR-0034 §5，未改） |
| 发件队列无上界 | ✅ §9 已加背压（4GB OOM 的唯一来源） | ❌ 走 Host 的 `outbound-mux.ts`（水位 + 封帧前丢弃） | ❌ 同上 |
| 会话库列表每次连接重扫 | ✅ §10 已加 TTL 缓存 | 不适用（同一 Host 进程共用一份扩展实例） | 不适用 |

一句话：**“每页 O(S)”是三家共享的；“每 sync 强制 reconcile”Pi 和 DSH 各有版本；“发件无上界”只有 Pi——因为只有 Pi 是独立进程 + 裸 `ws`。**

## Decision

1. **reconcile 只在变化时付成本。** 源端按 Entry 维护 `(entryId, fingerprint)`；`fingerprint` 在**摄取时**算一次（新增/修正时），之后比较指纹，不再每次 sync 对全历史跑 `JSON.stringify`。
2. **未变化的 Entry 复用已有对象，不 clone。** 这要求适配层的约定：Entry 视为不可变，内容被修正时必须换一个新对象（三个后端都满足）。 `#entries` 改成增量更新：新 Entry 与 corrected Entry 才 `structuredClone` 入表，其余保持原引用；`#committed` 只装本事务真正新增的 Entry。这条同时把 `snapshot()` / `#fingerprint()` 的成本压到 live 集合本身。
3. **`session.sync` 不再无条件 force。** 常规 sync 只在 leaf 或 source seq 变化时核对；强制核对只留给显式的恢复/核对入口（source 未 ready、`knownState` 触发的恢复、`session_tree` / `session_compact` 这种原生状态改写后的确认）。
4. **事件路径同规则。** live tools/messages 的保留同样受预算约束（ADR-0034 §4）：工具结果里的内联二进制不得在 live 状态里长期驻留，也不得整份进入 `execution` 事件。
5. **权威内容不在同步层临时裁剪。** 条目体积由生产者在 canonical 投影处定（ADR-0034），同步层不做"这一页先少给一点"的隐式改写——同一 Entry ID 在不同路径上出现不同内容会破坏 ADR-0025 的缓存身份。因此 `session_entry_too_large` 保留为**异常**，但必须带诊断（entryId、字节数、agentKind），且正常截图不得触发。
6. **epoch / seq 语义不变。** corrected / removed / 断链仍然换 epoch 并重新建立基线（ADR-0024 §2）；本 ADR 只改变"怎么发现变化"和"要不要拷贝"，不松动恢复契约。
7. **live 状态按增量计价，不按 token 全量重算。** 指纹只覆盖本事务真正改动的部分；`#flush()` 只发布变化（正文 delta 已有 `message.delta` 通道，不需要每个 token 再发完整 live 快照）；live 工具结果在进入 live 状态时就按 ADR-0034 §4 裁剪，原件不驻留。本条已按 §12 用**修订号**实现，不再对正文做内容哈希。
8. **发件队列必须有上界，溢出后以新基线恢复。** `publish` 在 `bufferedAmount` 超过水位（默认 8MB）后**丢帧而不是排队**，排空到低水位（2MB）时回调扩展：扩展把 source 换成新 epoch 并重发权威基线（`reestablish()`）。丢掉的那段 seq 链本来就会让 Host 拒绝并要求恢复（见上文的 1018 条诊断），重发基线是既有路径，不引入新的恢复语义。
9. **会话库列表按 TTL 缓存，不按连接次数重扫。** `SessionManager.listAll()` 会逐行解析整个会话库（本机 179 文件 / 517MB → 2.0s、峰值 205MB），而它挂在每一次 transport 连上和每一次 `session_info_changed` / `session_tree`。改为进程内缓存（TTL 60s、并发合并、rename/tree 显式失效）：连接抖动不再触发整库扫描。
10. **历史分页是 O(页)，不是 O(S)。** `history` 请求不改变任何状态，因此：不 reconcile、不重建 `sessionEntriesFromEntries`、不对全部条目重跑 `projectDisplayEntries`；摄取一次、投影按来源版本缓存，每页只做路径切片与页内序列化。缓存失效的判据只能是 ADR-0025 的来源版本（epoch/seq/leaf/projectionVersion），不能靠“再算一遍看看变没变”。三个后端共用 `SessionSyncPreparer`：key = 来源 epoch + 条目数 + leaf + `historyBoundaryParentId` + 调用方给的改写信号（Codex 用 `sourceSeq`），条目集被原地改写时由适配层显式 `invalidate()`。

11. **§1/§2/§10 的规则对三个后端同等适用（2026-10-22 已落地）。**
    - **Codex**：`resultText` 先过 `stripInlineMedia` 再把工具结果序列化进正文（§ ADR-0034 §5）；sync 走 `SessionSyncPreparer`，失效信号用后端已有的 `sourceSeq`，并在条目追加/重置/回滚三处显式 `invalidate()`。
    - **DSH（终端）**：`dshEntries` 增加按原生 `seq` 的条目缓存，刷新时复用已有对象——这是 §1/§2 里“引用相等即没变”能成立的前提；sync 走 `SessionSyncPreparer`。
    - **DSH Web**：sync 走 `SessionSyncPreparer`（带它的 `historyBoundaryParentId`），在页面合并、快照替换与增量追加处 `invalidate()`。
    - **仍未做**：DSH 终端适配层每次 sync 仍调用 `#history.read()` 读回整份原生日志（它的持久化 API 只给整份 log）。条目对象不再重建、不再重算指纹；2026-10-22 追加**单飞**（并发 sync 共享同一次读取），少了一层重复读，但 O(S) 的读与解析还在；要根治需要 DSH 提供带游标的读取。

12. **live 的变更检测用条目修订号，不用内容哈希（2026-10-22 已实现）。** 落地前的过渡实现是“每条 live 算一次内容哈希”，每个 token 仍要扫一遍正文（实测 1MB 正文 1.14ms/token、20KB 0.026ms/token，回合仍是 O(n²)，只是常数比旧实现小 3–10 倍）。现在：每个 live 条目维护单调递增的 `rev`（写入该条目时 +1），`#liveToken()` 只拼 `id:rev` 与标量字段，比较成本 O(条目数)、**每 token 零字节扫描**。
    **收益要说准**：它只消掉“比较”那一次扫描（实测 60KB 正文摊到 300 个 token 约 0.03ms/token）。回合内真正的大头在 `#flush()`：`snapshot()` 的 `structuredClone(live)`（1MB 工具结果 → 0.33ms）+ `JSON.stringify(patch)`（1.25ms），而且这份 patch 因为超过 256KB 预算会被整份丢弃——见 §13。两条都落地后实测：**1MB live 的 300 个 delta 总计 1ms（≈0.00ms/token，对照修复前 6.78ms/token）**；20KB live 为 0.07ms/token。
    代价与边界：
    - 语义从"**内容**变了没"变成"**写过**没"。写了又改回同一内容的事务会被判成变了，多推一次 seq；客户端因此多做一次 preview，**不会拿到错误数据**（误判方向是安全的：多发 ≠ 漏发）。
    - 现行的标量级净效果抑制仍然成立：DSH 每次 sync「先清 live 再补回来」动的是 `complete` 等标量，不产生新的条目修订，因此仍不推进 seq（`dsh-web-runtime.test.ts` 里那条 `selection: "unchanged"` 用例必须继续通过）。
    - `replaceLive()` 保留现有的精确 JSON 比较（每回合一次，频率低），用于"整份 live 覆盖但内容未变"的场景；它写入时给所有条目分配新 `rev`。
    - 条目被移除时连同 `rev` 一起删除；不能复用旧 `rev`，否则"删除后又加回同 id"会被误判为没变。
    - 验收：同一份历史 / 同一回放在 `--scene turn` 下每 token 耗时不随正文大小增长；DSH 的全部现有用例通过；新增一条"净效果为零（仅标量翻转）的事务不推进 seq"的不变量用例。

13. **超预算的 patch 在构造之前就跳过，不先克隆再丢弃（2026-10-22 已实现）。** 落地前 `#flush()` 的顺序是：`snapshot()` 深拷贝整份 live → `JSON.stringify(patch)` 量字节 → 发现超过 `SESSION_SYNC_PAGE_BYTES` 就 `return`，什么都不发。这次构造完全白付：实测 live 里有一个 1MB 工具结果时，**每个 token 白付 1.57ms**（clone 0.33 + stringify 1.25），而 patch 一定被丢弃。现在：写入条目时顺手维护它的字节数（`#messageBytes` / `#toolBytes`，与 §12 的修订号同一处更新），`#flush()` 先用 O(条目数) 的下界对预算做预判；超预算就直接跳过构造，继续依赖 `session.sync` 的 checkpoint/preview 恢复（与旧行为一致，只是不再白付构造）。
    **跳过时必须不推进 seq。** Host 的 `AgentConversationState` 要求 `baseSeq === 上一版 seq`；旧实现的 `#seq++` 在“跳过不发布”的路径上照样执行，于是留下一个客户端永远看不到的版本号，之后**每一条** patch 都被拒绝（现场表现：Host 诊断里每秒两条 `Rejected conversation transaction; source baseline required`，永不恢复）。现在版本只在真正发布时推进；精确字节检查才判超的那一次会回滚 `#seq`。
    边界：估算必须是**上界**（宁可少发一次 patch，也不能发出一个"看起来完整但被截断"的 patch）；低估只会退回今天的行为（构造后才丢弃），不会出错。

14. **Host 拒绝增量时，扩展重发新 epoch 基线；其它 resync 不换 epoch（2026-10-22 已实现）。** Host 在拒绝一条 patch 之后只发 `runtime.resync` 带原因：只有 `model_baseline_required` 表示它丢了基线，此时扩展必须 `reestablish()`（新 epoch + `ready:false` 帧 + 权威基线）；`device_reconnected` / `notification_sync` / `model_reconcile` / 首次连接只补发元数据。不加区分地对所有 resync 换 epoch 会让客户端每次重连都白刷一遍历史。
    验证：`runtime-bridge` 的 resync 原因必须原样交给 interaction port（有用例）；扩展只在 `model_baseline_required` 上重建基线。

15. **流式 patch 按窗口合并，客户端读版本前必须 flush（2026-10-22 已实现）。** 服务端算得再便宜，也架不住**发布频率**：现场在真机（Redmi 2407FRK8EC）上测到入站 `v2.frame` **96 帧/秒**（5s/479 帧），手机主线程 207% CPU、Graphics 455MB、每 2 秒一次 GC（释放 70–107MB）、滚动时 Choreographer 连续 `Skipped 33–58 frames`、legacy janky 39%、p99 450ms。原因不是单帧重，而是**每来一条 patch，`ChatScreen` 就用 `remember(conversation.revision)` 把整段会话重新投影一遍**（`buildConversationPresentation` / `buildChatListItems` 都是 O(消息数) 的全量构造）。
    做法：`RecoverableSessionSource` 增加可选 `coalesceMs`（默认 0 = 原行为，测试不受影响），Pi 扩展设 100ms：一个窗口内多次状态变化只发一条 patch，`seq` 仍然只在真正发布时前进，序列保持连续。
    **配套的不变量**：合并窗口会把"版本号最终值"推迟到窗口结束，所以任何要在响应里携带 `source.seq` 的路径必须先 `flushPending()`（`syncSession` 已加；`reestablish()` 会先 flush 再换 epoch）。否则客户端拿到的 `knownState` 在 100ms 后失效，sync 永远回不了 `unchanged`——这条在实现时被集成测试抓到过。
    客户端侧同批做了一件轻量修复：入站大帧的诊断日志从"每帧一行"改成每 2 秒一行带计数（原来 5s 内 450 行 `Log.i`）。更彻底的做法（增量投影 / UI 侧限频）仍未做。

## Consequences and verification

- 带图的会话从 O(全历史字节) 回到 O(变化量)：73 张图的会话单次 sync 从 ~400ms 回到 1ms 量级；纯文本长会话也同样受益（大文本历史此前是同一形状的成本）。
- 回合内的成本从 O(token × live) 降到 O(token)：读图之后的后续输出不再为那份 base64 反复付钱；不再每个 token 发一份完整 live 快照。
- 加载聊天历史从 O(S²/每页条数) 回到 O(页)：30MB 会话翻完 428 页实测 **70.7s → 1.1s**，单页 165ms → 2.6ms，峰值 heap 617MB → 191MB（`--scene pages`）。
- 发件侧：同样 400 × 1MB 打到「不读的对端」，RSS 增长 **417MB → 13MB**（`--scene sendqueue`）。
- 会话库列表：单次扫描成本不变（2.0s / 205MB 峰值），但同一进程内从「每次连上都扫」变成「每 60s 最多一次 + 显式失效」，连接抖动不再重复付这笔钱。
- 状态语义不变：同一份历史反复 sync 不产生新 epoch，内容真变了才产生 corrected。
- 风险点：指纹必须覆盖所有会改变线上表示的字段（`parentId`、`type`、`timestamp`、`data`）；漏字段的表现是"手机不刷新"，因此指纹计算要以整条 Entry 为输入，只在算法上避免重复序列化，不能改用抽样判据。
- 回合内的比较成本由 §12 消掉（60KB 正文 ≈ 0.03ms/token）；**更大的那块是 §13 的"白构造 patch"**：live 里有一个 1MB 工具结果时每 token 白付 1.57ms（clone 0.33 + stringify 1.25），而 patch 必被丢弃。两条都做完，长回合的每 token 成本才真正与 live 体积无关。
- 在此之前，长正文回合的成本仍随"正文长度 × token 数"增长，只是系数已经小了 3–10 倍。
- 按后端分列（2026-10-22 状态）：
  - **Pi**：§1/§2/§3/§7/§8/§9/§10 全部实现；canonical Entry 与 live 工具结果已按 ADR-0034 裁剪。
  - **DSH / DSH Web**：增量 `reconcile`、`prepare`/`select` 拆分、显示索引已随 protocol 生效；`dsh-runtime.ts` 的“每次 sync 重读整份原生日志”和“每页重新 prepare”仍未改（文本量级，风险低）。
  - **Codex**：增量 `reconcile` 与显示索引已生效，但它不经过 `RecoverableSessionSource`，本来就只在中继历史时付全量投影；`resultText` 内联 base64 的问题仍在（ADR-0034 §5）。
- 需要的验证（实现时补齐）：
  - 同一份历史连续 sync 两次：第二次不 clone、不递增 seq、响应与第一次一致（除 syncId）；
  - 同一 Entry ID 内容被修正：仍换 epoch 并按 ADR-0024 重建基线；
  - 带 73 张图的会话：单次 sync 回到毫秒级，且事件循环不被单次调用卡住；
  - 超大 Entry 的失败路径带诊断，且普通截图不再命中；
  - live 工具结果的内联载荷在落盘后不再驻留；
  - 含 1MB live 工具结果的回合：每个 delta 的耗时不随 live 字节数增长（对照 0.31ms/token 基线），且不因回合变长而超线性；
  - 分页：同一会话翻完全部页，总耗时随页数线性、每页耗时与 S 无关（`scripts/perf/session-memory-stress.mjs --scene pages --session-mb 30`），且来源版本未变时命中缓存不重算；
  - DSH / Codex 接 §10 缓存后：同一条长历史翻页的每页耗时不再随 S 增长（当前仍会）；
  - Codex 工具结果含图：正文不出现 base64（ADR-0034 §5 落地后补）；
  - §12/§13：`--scene turn` 实测 1MB live = 0.00ms/token、20KB = 0.07ms/token，与体积无关；“净效果为零（仅标量翻转）的事务不推进 seq”与“超预算 live 不发 truncated patch”各有独立用例。
