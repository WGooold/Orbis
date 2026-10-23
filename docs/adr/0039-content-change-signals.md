# ADR-0039：内容变更信号前移（冻结、修订号、增量指纹）

日期：2026-10-22

Status: accepted（2026-10-22 实现 §2/§3/§5/§6，§5 已由既有显示缓存满足并加测试固定：

- §2：`AgentConversationState` 以**冻结的引用**保存 entries 与 display 行，`event.live` 仍深拷贝（有测试证明 live 未冻结、可原地 push）。
- §3：**已实现（Host 侧）**。`AgentConversationState` 按对象身份缓存内容派生摘要（SHA-256 前 22 位），
  同内容重发得到同一修订号，比较从 O(字节) 降到 O(1)；未采用全局源序号（重发会误判为改写）。
  后端若将来直接提供内容派生的修订号，替换缓存来源即可，契约不变——因此本 ADR 不再有外部依赖。
- §4：字节账目沿用现有 `next.bytes - old.bytes`（替换时加减成对）。
- §5：App 的显示行对象由 `display[entryId]` 缓存并在投影中按引用复用（有测试断言同一行是同一对象）；剩余差异只是列表分配，不做 early-exit。
- §6：DSH `#refresh` 用"同 seq 是否产出新对象"判断替换，未替换时不 `invalidate()`。

「前置依赖」第 1 条（Codex `data.message` 是否内嵌原始 item）由 §2 的冻结直接给出答案：冻结后任何原地改写都会抛错，因此不需要再单独排查 alias。）

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0035](0035-incremental-session-reconcile.md)、[ADR-0037](0037-session-sync-transaction-contract.md)

## Context

ADR-0037 解决"一次同步事务怎么结束"。本文处理另一类问题：即使事务都能正确结束，同步路径上仍有几处工作与内容总量成正比，而且每次事件、每次 patch、每次 sync 都要重做一遍。

三处的共同点不是"写错了"，而是**为了正确性而放弃性能**：因为拿不到"内容变了没有"这个信号，只能在下游重新算。

| 位置 | 现在的做法 | 它保护的正确性 |
|---|---|---|
| `agent-conversation-state.ts:147` | `byId.set(entryId, structuredClone(entry))` | 权威模型不 alias adapter 的对象 |
| `agent-conversation-state.ts:146` | `JSON.stringify(previous) !== JSON.stringify(entry)` 则拒绝事件 | 同一 `entryId` 内容被改写必须被拒（ADR-0013 的不可变约束） |
| `agent-conversation-state.ts:69/77/80` | `size(value)` = 序列化长度，用于 `maxPageBytes` / `maxCurrentBytes` | 模型内存有界 |
| `RemoteState.kt:1393` | 每次 patch 都 `projectSessionGraph(graph.copy(cursor = head))` | 回退/替换/乱序时显示仍等于权威路径 |
| `dsh-runtime.ts:449` | 每次 sync 无条件 `preparer.invalidate()`；`:444` 用 `>=` | DSH 没有内容修订号，"同长度内容变化"无法被缓存键发现 |

代价的量级：`prepareSessionSync` 实测 200 条 0.16ms、1000 条 0.56ms、3000 条 1.55ms（D3）；D1 与 D2 目前**没有单独测量**，本文不为它们编数字。

## 本次查证的结论

改写前必须先确认"条目不可变"这个前提是否成立，因为冻结只在前提成立时安全。查证结果：

### entries：没有任何原地改写

搜索 `packages/host/src`、`packages/protocol/src`、`packages/pi-extension/src` 未发现对 entry 或其 `data`/`detail` 的字段赋值。所有变更都是整表替换或换新对象：

| 位置 | 做法 |
|---|---|
| `codex-runtime.ts:3595-3622` | 每次新建 entry；同 ID 已存在时用 `isDeepStrictEqual` 比较，不一致则标记 `nativeSourceDirty` 并重读原生历史，不原地打补丁 |
| `codex-runtime.ts:1514`、`:3677` | `thread.entries = prior.entries` / `patch.entries = committed`（换引用） |
| `dsh-runtime.ts:448`、`dsh-web-runtime.ts:676/680/765` | `session.entries = ...`（整表替换） |
| `pi-adapter.ts:389-406` | 投影对象按原生 Entry 缓存在 WeakMap，只在 `entryId`/`timestamp` 变化时重建 |

投影层是否深拷贝（决定冻结会不会连带冻结 adapter 自己的对象）：

| 后端 | 构造方式 | 结论 |
|---|---|---|
| Pi | `safeValue()`（`safe-value.ts:23-46`）递归重建对象与数组 | 深拷贝，冻结安全 |
| DSH | `dshContent()` 新建 content；entry 的 `data.message` 是新对象 | 深拷贝，冻结安全 |
| Codex | `data: { message: { ...part.message, timestamp: 0 } }` | 浅拷贝；`part.message` 由 `toolCallMessage`/`itemToMessage` 新建，但内部是否嵌原始 item 的嵌套对象**尚未确认** |

### live：确实原地改写

```ts
// dsh-runtime.ts:376-384
let message = session.streamed.get(update.messageId);
message.content.push({ type: contentType, text: content.text });

// dsh-web-runtime.ts:920/927/929
else message.content.push({ type: "text", text });

// protocol/session-source.ts:222
block.text = (block.text ?? "") + event.delta;
```

这些 message 对象按引用传给了 `upsertMessage`（`dsh-runtime.ts:351`），也就是 `#messages` 里存的就是 adapter 正在改的对象。目前靠 `snapshot()` 的 `structuredClone`（`session-source.ts:395`）和 `agent-conversation-state` 对 `event.live` 的克隆保护。

### 一条既有隐患

`pi-adapter.ts` 的 `ENTRY_PROJECTIONS` 只用 `entryId + timestamp` 判断缓存是否有效。如果 Pi 某天原地改写一条 entry 的内容而这两个字段不变，缓存会静默返回旧投影——今天没有任何东西能发现。

## Decision

### §1 内容变更信号必须在内容产生处给出

"内容有没有变"由产生内容的组件回答，下游只消费结论，不再重新计算。这是本文三节共同的原则，也是 ADR-0035 §12 选择修订号而非内容哈希的同一条理由。

### §2 entries 边界冻结 + 引用存储；live 继续克隆

- Host 收到 entry 后**深冻结**并保留引用，不再 `structuredClone`。深冻结替代克隆承担"adapter 不得改写权威状态"的职责，并把静默错误变成显式错误。
- **禁止**对 `event.live` 使用冻结或引用存储。live 是原地累加的（上文三处证据），冻结会直接打断 DSH/DSH-Web 的流式累加；live 必须继续深拷贝。
- 若实现选择不做深冻结，则必须保留**内容哈希**比较。浅冻结不足以发现 `entry.data.message.content[i].text` 的变化。

### §3 条目修订号必须内容派生

- 冻结后，entry 不可变，因此"同 `entryId` 内容被改写"只能通过修订号发现。
- 修订号必须**每条 entry 内容派生**，且同一内容重发必须得到同一值。
- **禁止**用全局源序号（例如 Codex 的 `sourceSeq`）当 entry 修订号：同一 entry 重发时全局序号可能变化，会被误判为不可变违规并使事件被拒绝，结果是该条目永远进不了模型。

**实现（2026-10-22，Host 侧）**：`AgentConversationState` 为每条 entry 计算 SHA-256 前 22 位（base64url），按**对象身份**缓存在 `WeakMap` 里——冻结后的条目是不可变引用，所以同一对象只算一次，比较是 O(1)。这满足本节的三条要求（内容派生、同内容同值、不用全局序号），而且比"后端上报修订号"更难写错：后端上报的是**它认为**的修订号，一旦与内容不符，被拒的是合法条目。

因此本节不再阻塞在"Pi/DSH 提供修订号"上；后端若将来直接给内容派生值，替换缓存来源即可，契约不变。

### §4 字节账目

- 每个 entry 的 `byteLength` 由 Host 在首次接收时测量一次并缓存，**不信任** adapter 上报值（低估会破坏内存上界，高估会让模型长期 `ready=false`）。
- 替换 entry 时必须同时 `总字节 - 旧 + 新`，不得只加不减；漏减会让累计值虚高，最终超过 `maxCurrentBytes` 并永久退回全量快照。

### §5 App 投影按行依赖复用

- 每行记录其输入依赖：条目内容修订号、与之配对的工具结果修订号、时间戳、排序邻居、可合并的临时行集合。
- 每次 patch 仍扫描全部行（O(n) 指针比较，不分配），只重算依赖变化的行，其余复用同一对象以便 Compose 跳过重组。
- **禁止** early-exit（"遇到第一行没变就停"）：一次 patch 可以在任意位置改变路径。
- 依赖集**必须**包含工具配对与临时行合并两项，否则会出现"工具结果到达后调用行仍显示 running""本地临时行与权威行同时存在"。

### §6 DSH 显示索引的增量指纹

- 指纹基于"本次 `dshEntries` 是否为已存在的 seq 产生了新的 entry 对象"，而不是条目数或最后 seq。`entryCache` 已保证同 seq 复用同一对象，因此"同 seq 产出新对象"就是内容被替换的可靠信号。
- 指纹未变化时**不调用** `invalidate()`；`:444` 的 `>=` 可改回 `>` 配合指纹比较。
- 只对缓存未命中的 seq 计算指纹，已缓存条目复用其结果；否则等于把全量序列化搬到另一个位置。
- 日志长度变短，或会话重新打开（代次变化）时，必须强制重建。

### §7 明确禁止的做法

| 禁止 | 理由 |
|---|---|
| 冻结或引用存储 `event.live` | live 正在被原地累加 |
| 用全局源序号当 entry 修订号 | 会导致合法重发被拒、条目永久丢失 |
| 只做浅冻结 | 漏掉嵌套变更，比现在的序列化比较更弱 |
| 投影复用依赖 early-exit | 会漏掉非尾部变化 |
| 信任 adapter 上报的字节数 | 破坏内存上界 |
| 对全部 seq 计算指纹 | 成本回到原处 |

## Consequences

### 每条最容易写错的地方

| 条目 | 最容易写错 | 后果 |
|---|---|---|
| §2 | 把 freeze 用在 live 上 | DSH 流式累加当场抛错，整轮输出丢失 |
| §3 | 修订号用错语义 | 合法重发被判违规 → 条目永远进不了模型 |
| §4 | 替换时漏减旧字节 | 累计虚高 → 永久 `ready=false` → 每次都全量快照 |
| §5 | 依赖集漏掉工具配对/临时行合并 | UI 永久停在旧内容或出现重复行 |
| §6 | 指纹只看长度/seq | 同长度内容替换检测不到，比现在的无条件失效更差 |

### 必须新增的测试（缺一不算排除 bug）

1. 流式跑一轮（含工具调用与结果）后，断言已入模型的 entry 深度相等且未被修改（`Object.isFrozen` + 内容摘要不变）。
2. 同一 entry 连续重发两次必须都被接受。
3. 同一 entry 替换 100 次后，模型总字节与首次一致。
4. 工具结果晚于调用到达时，调用行必须更新为完成态。
5. 本地临时行收到权威行后必须合并，不得重复。
6. 相同条目数、不同内容时，DSH 显示索引必须重建。
7. 日志长度变短（截断）后必须强制重建索引。

### 前置依赖与顺序

1. Codex 未确认点：entry 的 `data.message` 内部是否嵌原始 item 的嵌套对象。冻结前必须用测试 1 验证；若存在 alias，需先深拷贝该字段。
2. Pi / DSH 提供条目内容修订号：这是 §3 的前提，属于跨后端改动。
3. 实施顺序建议：ADR-0037 的契约先落地（因为重试会放大这里的所有成本），再按 §4 → §6 → §2 → §3 → §5 推进，其中 §5 是 App 侧独立改动。

### 与其它 ADR 的关系

- ADR-0037 管"事务能否结束"，本文管"结束得多贵"。两者独立，但先做 0037 收益更大。
- ADR-0035 §12 已确立"修订号优先于内容哈希"，本文把它扩展到 Host 模型层、App 投影层与 DSH 显示索引三处。
- ADR-0032 的权威模型依赖 §2、§3、§4 三条约束同时成立；只做其中一条会让模型出现静默分叉或不必要的全量回退。

## 验证

- 上述 7 条测试全部实现并通过。
- 回归基线：ADR-0013 的验收条款（延迟超窗、丢包、换路、多设备下不积压；当前聊天能完成或显示可恢复错误）不受影响。
- 性能核对不靠推断：D3 已有实测数字；D1/D2 在实施后必须新增测量（每次事件的模型层开销、每次 patch 的投影开销），并与本文记录对比后再决定是否继续优化。
