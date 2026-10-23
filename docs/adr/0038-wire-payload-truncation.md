# ADR-0038：超长文本按线路投影截断（存储保留原文）

日期：2026-10-22

Status: accepted（2026-10-22 实现 §1–§7：`packages/protocol/src/wire-truncate.ts` 在 `prepareSessionSync` 与 `RecoverableSessionSource.#flush` 两个出口做确定性截断；内容块带 `truncated: true` + `originalBytes`，文本里同时保留"…（已截断，原始 N 字节）"以便任何只读 `text` 的渲染路径也能看见。§8 的"取全文"入口未做）

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0034](0034-image-content-references.md)、[ADR-0035](0035-incremental-session-reconcile.md)、[ADR-0037](0037-session-sync-transaction-contract.md)

## Context

ADR-0037 解决的是"同步事务没有终止"。本文解决另一件独立的事：**单条 Entry 的载荷超过快照上限时，这次同步必然失败**，与事务能否终止无关。

### 触发条件（代码事实）

`session-sync.ts` 组装页时的判断顺序是：

```ts
const size = bytes(nextSnapshot);                                   // JSON 长度 + wrapper
if (size > SESSION_SYNC_PAGE_BYTES && selected.length > 0) break;    // 256KB：把大条目挤出页外
if (size > SESSION_SYNC_MAX_BYTES) throw new Error("session_entry_too_large");  // 1MB：只在页首时到这一步
```

因此：

- 普通大条目会被 256KB 规则挤到页外，不报错；
- 只有**这一页的第一条就是这个大条目**时才会走到 1MB 判断；
- 单条 Entry 自身序列化后 > 1MB → `session_entry_too_large`。

后果分两档：

| 场景 | 结果 | 能否恢复 |
|---|---|---|
| 大条目正是 head | preview 反复失败（被包成 `session_sync_backend_failed`） | 下一条新 Entry 出现即恢复 |
| 大条目在历史中间 | 翻页到它时页首触发，重试完全相同 | **不能**：没有任何跳过该条目的机制 |

### 实测（本机三后端，2026-10-22）

| 后端 | 语料 | 最大单条 | >1MB |
|---|---|---|---|
| Pi | 96,653 条 Entry（剥离内联媒体后） | 304 KB | 0 |
| DSH | 29,505 个事件（zstd 多帧解压后） | 368 KB（且 `tool/ptc-dispatch` 不进 Entry） | 0 |
| Codex | 212,562 行 rollout | 纯文本 4.47 MB | 79 处，涉及 25/410 会话（6.1%） |

Codex 侧另有直接证据：连接桌面版 app-server（`ws://127.0.0.1:56578`）调用 `thread/turns/list`（`itemsView: "full"`）实测某线程 829 个 item，

- 命令输出字段 `aggregatedOutput` 最大**正好 1024KB**（app-server 的 `outputBytesCap` 默认上限，见 `docs/codex-app-server-protocol.md:800/803`）；
- 但 item 的完整 JSON 达到 **1.12MB**（还包含 command、cwd、退出码等）；
- 该线程 >512KB 4 个、>1MB 2 个。

也就是说这是**两个 1MB 上限错位**：Codex 的 cap 管命令输出抓取，我们的 cap 管整个快照，中间夹着条目其它字段。被 Codex 刚好 cap 到 1MB 的输出必然越过我们的闸门。

同时确认：未 materialize 的老线程，`thread/turns/list` 只返回 `userMessage`/`reasoning`/`agentMessage`，不含工具项（实测某线程 7 turns、总响应 0.01MB，尽管其 rollout 里有 4.37MB 的工具输出）。所以不能用 rollout 文件推断 RPC 内容。

### 考虑过的另一种修法：提高上限

把 `SESSION_SYNC_MAX_BYTES` 从 1MB 提到 2MB 能覆盖实测的 1.12MB，不丢信息。但它不是改一个数：

- `RESERVED_BYTES = sessionSyncWireBytes(SESSION_SYNC_MAX_BYTES)`，而 1MB 明文 ≈ 2 倍 wire（base64 1.33× + 每 8KB 片 4096B 头）。提到 2MB 后每个活跃任务预留 ≈4.0MB；
- 派发闸门是 `active 预留之和 + RESERVED > SESSION_SYNC_WIRE_LIMIT_BYTES(6MB)`，两个活跃需要 8MB → **第二个任务永远派发不出去，`MAX_ACTIVE` 静默从 2 降到 1**；
- 单条 delivery 占 4MB wire，8 个投递槽与 6MB 预算里塞不下第二条大快照；
- 接收端重组上限是 **60 秒**（`piece.ts:57`）：2MB 明文 ≈4MB wire，要求持续 >550kbps，低于这个速率的链路会让大快照**永远重组不成功**，而发送侧仍在按正常流程重试。

要提上限就必须整组改（上限 2MB + 每设备预算 12–16MB + 重组超时 180s + Host 在飞内存上限约 32MB）。这是可选方案，本文选择不采用，理由见 §7。

## Decision

### §1 截断是线路投影，不是存储

被截断的只是"发给设备的载荷"。以下一律来自原文，不受截断影响：

- `entryId`、`parentId`、`messageId`、`role`、`timestamp`、`toolCallId`、`isError`；
- 源端指纹、修订号（ADR-0025、ADR-0035 §12）、`SessionSyncPreparer` 缓存键；
- 缓存事务的归属与覆盖判断（ADR-0013 §2、§3）。

违反这一条会制造比原问题更难查的故障：超过阈值之后的尾部变化在 Host 侧看起来"没变"，于是不产生新快照或新 patch，App 永远显示旧内容且日志无异常。

### §2 两个截断点，共用同一个函数

| 出口 | 位置 | 处理对象 |
|---|---|---|
| `session.patch` | `RecoverableSessionSource.#flush`（`session-source.ts:415-440`），在 `#liveLowerBoundBytes()` 与 `withEntries` 字节判断**之前** | `live` 载荷 + `committed` entries |
| `session.snapshot` | `prepareSessionSync`（`session-sync.ts:66`）组装选中页时，在 `bytes()` 测量**之前** | 选中页的 entries |

两处必须用同一个函数与同一组预算，否则同一条内容在两个来源里长度不一致，App 会看到工具输出先长后短。

### §3 预算与确定性

- 单字段上限：**64KB**；
- 单条 Entry 上限：**256KB**（等于页预算 `SESSION_SYNC_PAGE_BYTES`，因此一条大条目最多独占一页，不会顶到 1MB 兜底）；
- 算法固定且确定性：按字段路径的字典序遍历字符串值；先截超过 64KB 的字符串，若整条仍超 256KB，再按同一顺序对最长字符串逐次折半，直到满足；
- 同一 Entry 在任何一次投影、任何一页、任何一次重试中必须得到完全相同的结果（ADR-0025 的缓存身份要求）。

### §4 只截载荷，不破坏结构

- 只处理文本载荷：`text`、`thinking`、`tool_call.arguments` 中的字符串值、工具结果文本；
- `arguments` 逐字段截断，**不得整段替换成字符串**（否则工具卡片渲染失效）；
- 按字符边界截断，不得切裂 UTF-8；
- 结构字段、身份字段一律不动（见 §1）。

### §5 截断必须可见

被截断的载荷带标记：`truncated: true` 与 `originalBytes`（字段级截断时给出字段路径列表）。App 必须显示"已截断（原始 N）"，复制/导出也要带上这个事实——否则用户会以为工具只输出了这么多。

### §6 覆盖范围

三条同步路径（preview / history / catchup）与 `session.patch` 全部生效；阈值相同。确定性失败（ADR-0037 §5）仍然保留：若截断后某条仍超过 1MB（例如大量字段累加），按确定性失败处理，**只影响该 target**，且必须可见。

### §7 保持现有上限参数不变

| 参数 | 值 | 结论 |
|---|---|---|
| `SESSION_SYNC_PAGE_BYTES` | 256KB | 不变（也是单条 Entry 的预算） |
| `SESSION_SYNC_MAX_BYTES` | 1MB | 不变（兜底） |
| `SESSION_SYNC_WIRE_LIMIT_BYTES` | 6MB | 不变 |
| `MAX_ACTIVE` | 2 | 不变 |
| `PIECE_REASSEMBLY_TIMEOUT_MS` | 60s | 不变 |

理由：截断把单条稳定在 ≤256KB，页预算与 1MB 兜底都留有余量；提上限则会扩大峰值帧、弱网重组失败风险与 Host 在飞内存，而且只是把失败门槛推后。两者**不叠加**：截断到 256KB 之后，2MB 的上限永远用不满。

### §8 幂等、缓存与将来取全文

- App 的 SQLite 缓存里存的是截断版；因为截断确定性，同一 `entryId` 每次一致，不破坏缓存事务。
- `knownState`、coverage、`unchanged` 判断只依赖 id 与版本，不受截断影响。
- 将来若支持"取全文"，需要把**截断规则版本**纳入缓存 epoch，否则旧缓存无法升级；`truncated`/`originalBytes` 是那时新增请求的入口，不需要返工现有字段。

## Consequences

### 必然的代价

| 代价 | 说明 |
|---|---|
| 信息丢失 | 超出部分设备永远看不到（除非将来做按需拉取）；对"看大日志 / 看大 diff"的用户是功能退化 |
| UI 必须改 | 不显示"已截断"就等于让用户误判工具输出 |
| 弱网更稳、强网无收益 | 本方案只降低峰值，不提高吞吐 |
| Pi/DSH 几乎无感 | 实测最大 304KB / 368KB，基本不触发 |

### 曾考虑并放弃的方案

| 方案 | 放弃原因 |
|---|---|
| 提高上限到 2MB（整组调整） | 见 Context：预留翻倍导致 `MAX_ACTIVE` 静默降为 1；60 秒重组超时要求 >550kbps；Host 在飞内存翻倍 |
| Codex-only 的 ref + 按需拉取全文 | 不丢数据，但要新增一条取全文的请求与 App 展开入口，成本远大于截断；留作后续 |
| 什么都不做，只保证失败可见 | 失败本身是永久性的（历史翻不过去），用户无法自行恢复 |

### 需要同步更新

- 单测：同一 Entry 两次投影结果相同、指纹与修订号不受影响、`arguments` 结构保留、两条出口阈值一致、截断后页内条数不被单条挤成一条。
- 文档：在 ADR-0034（媒体引用）旁注明"文本类超长载荷由 ADR-0038 处理"，两者是同一原则的两条分支：**线路载荷按展示需要裁剪，存储保留原文**。

## 验证

- 用 Codex 实测样本（某线程 829 个 item，最大 1.12MB）回归：截断后该 Entry 能被正常发送，preview 与 history 都不再失败。
- 回归 ADR-0013 的验收条款：不产生重复响应积压，当前聊天能完成或显示可恢复错误。
- 回归 ADR-0035：同一会话的多次 sync 不得因为截断产生"看起来没变"而漏更新（构造尾部变化的用例）。
