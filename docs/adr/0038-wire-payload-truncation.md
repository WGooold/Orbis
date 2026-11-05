# ADR-0038：超长文本按线路投影截断（存储保留原文）

日期：2026-10-22

2026-10-27：[ADR-0045](0045-tool-summaries-and-on-demand-content.md) 替换工具全文的默认同步路径：producer 在进入共享状态前生成摘要和 locator，完整参数/输出/结果通过独立范围页读取；`session.entry.request` 不承担大工具内容分页。本文关于其他文本的线路截断继续适用，超长助手正文仍可能超过 live 页预算。

Status: accepted（2026-10-22 实现 §1–§7：`packages/protocol/src/wire-truncate.ts` 在 `prepareSessionSync` 与 `RecoverableSessionSource.#flush` 两个出口做确定性截断；内容块带 `truncated: true` + `originalBytes`，文本里同时保留"…（已截断，原始 N 字节）"以便任何只读 `text` 的渲染路径也能看见。§8 的"取全文"入口已实现：设备可用 `session.entry.request{requestId,sessionId,entryId}` 按需取回未截断的原文（只回请求设备；超过单条上限按确定性失败拒绝），App 在会话顶部给出「查看完整内容」入口）

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

### §1 线路投影与原文

截断作用于线路载荷；身份、结构、源版本和缓存归属由完整原文确定。

### §2 两个截断点，共用同一个函数

快照与 patch 共用确定性投影函数和载荷预算。

| 出口 | 位置 | 处理对象 |
|---|---|---|
| `session.patch` | `RecoverableSessionSource.#flush`（`session-source.ts:415-440`），在 `#liveLowerBoundBytes()` 与 `withEntries` 字节判断**之前** | `live` 载荷 + `committed` entries |
| `session.snapshot` | `prepareSessionSync`（`session-sync.ts:66`）组装选中页时，在 `bytes()` 测量**之前** | 选中页的 entries |

### §3 预算与确定性

投影按稳定顺序裁剪文本，并在相同输入下得到相同结果。当前字段预算为 64KB、单条 Entry 预算为 256KB，算法见 [wire-truncate.ts](../../packages/protocol/src/wire-truncate.ts)。

### §4 载荷与结构

文本载荷按字符边界裁剪，结构化参数与身份保持完整。

### §5 截断可见性

展示、复制与导出保留截断事实及原始大小；线路标记为 truncated 与 originalBytes。

### §6 覆盖范围

preview、history、catchup 与 patch 共用载荷投影；超出硬上限的条目按 ADR-0037 返回明确的 target 级失败。

### §7 同步预算

线路投影在既有同步预算内工作，参数见下表。

| 参数 | 值 | 结论 |
|---|---|---|
| `SESSION_SYNC_PAGE_BYTES` | 256KB | 不变（也是单条 Entry 的预算） |
| `SESSION_SYNC_MAX_BYTES` | 1MB | 不变（兜底） |
| `SESSION_SYNC_WIRE_LIMIT_BYTES` | 6MB | 不变 |
| `MAX_ACTIVE` | 2 | 不变 |
| `PIECE_REASSEMBLY_TIMEOUT_MS` | 60s | 不变 |

### §8 幂等、缓存与将来取全文

缓存保存确定性的线路投影，版本与覆盖由源身份裁决。取全文通过独立请求读取原文，演进时同步维护投影版本与缓存兼容性。

## Consequences

### 必然的代价

| 代价 | 说明 |
|---|---|
| 信息丢失 | 超出部分设备永远看不到（除非将来做按需拉取）；对"看大日志 / 看大 diff"的用户是功能退化 |
| 截断提示 | 界面显示截断事实与原始大小 |
| 弱网更稳、强网无收益 | 本方案只降低峰值，不提高吞吐 |
| Pi/DSH 几乎无感 | 实测最大 304KB / 368KB，基本不触发 |

### 曾考虑并放弃的方案

| 方案 | 放弃原因 |
|---|---|
| 提高上限到 2MB（整组调整） | 见 Context：预留翻倍导致 `MAX_ACTIVE` 静默降为 1；60 秒重组超时要求 >550kbps；Host 在飞内存翻倍 |
| Codex-only 的 ref + 按需拉取全文 | 不丢数据，但要新增一条取全文的请求与 App 展开入口，成本远大于截断；留作后续 |
| 什么都不做，只保证失败可见 | 失败本身是永久性的（历史翻不过去），用户无法自行恢复 |

### 需要同步更新

实现和验证随投影契约同步维护；文本裁剪与 ADR-0034 的媒体引用共同保持线路有界、存储完整。

## 验证

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。
