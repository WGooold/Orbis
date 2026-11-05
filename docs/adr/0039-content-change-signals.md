# ADR-0039：内容变更信号前移（冻结、修订号、增量指纹）

日期：2026-10-22

Status: accepted（2026-10-22 实现 §2/§3/§4/§5/§6，§5 已由既有显示缓存满足并加测试固定：

- §2：`AgentConversationState` 以**冻结的引用**保存 entries 与 display 行，`event.live` 仍深拷贝（有测试证明 live 未冻结、可原地 push）。
- §3：**已实现（Host 侧）**。`AgentConversationState` 按对象身份缓存内容派生摘要（SHA-256 前 22 位），
  同内容重发得到同一修订号，比较从 O(字节) 降到 O(1)；未采用全局源序号（重发会误判为改写）。
  后端若将来直接提供内容派生的修订号，替换缓存来源即可，契约不变——因此本 ADR 不再有外部依赖。
- §4：条目字节数在首次接收时测一次并缓存（`WeakMap`），当前状态的字节总数由"已缓存条目和 + 很小的外壳序列化"重算——等价于替换时的"总字节 - 旧 + 新"，不会只加不减。
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
| `agent-conversation-state.ts:146` | `JSON.stringify(previous) !== JSON.stringify(entry)` 则拒绝事件 | 同一 `entryId` 沿用不可变内容校验（ADR-0013） |
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

### §1 来源提供内容变更信号

内容生产者给出变更信号，下游消费已确认的修订与依赖。

### §2 entries 边界冻结 + 引用存储；live 继续克隆

Entry 在接收边界深冻结并按引用存储；可变 live 保持深拷贝隔离。其他实现以等价的内容校验保障权威状态。

### §3 内容派生的条目修订号

Entry 修订号由自身内容确定，同内容产生同值。当前 Host 使用 SHA-256 前 22 位 base64url，并通过 WeakMap 按对象缓存。

### §4 字节账目

Host 测量并缓存条目字节，替换时按旧值扣减、新值增加维护总账。

### §5 App 投影按行依赖复用

每行声明完整输入依赖，遍历核验后重算变化行，其余复用原对象；工具配对与临时行合并纳入依赖。

### §6 DSH 显示索引的增量指纹

DSH 按原生 seq 复用对象与指纹，由实际条目替换触发失效；来源代次或日志结构变化时重建。

### §7 职责与引用边界

变更信号、字节核算和投影依赖分别由其拥有者维护，引用复用建立在已验证的不可变边界上。

## Consequences

### 每条最容易写错的地方

| 条目 | 最容易写错 | 后果 |
|---|---|---|
| §2 | 把 freeze 用在 live 上 | DSH 流式累加当场抛错，整轮输出丢失 |
| §3 | 修订号用错语义 | 合法重发被判违规 → 条目永远进不了模型 |
| §4 | 替换时漏减旧字节 | 累计虚高 → 永久 `ready=false` → 每次都全量快照 |
| §5 | 依赖集漏掉工具配对/临时行合并 | UI 永久停在旧内容或出现重复行 |
| §6 | 指纹只看长度/seq | 同长度内容替换检测不到，比现在的无条件失效更差 |

### 验证入口

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

### 前置依赖与顺序

实施先确认各后端的对象所有权，再按字节核算、增量索引、冻结、修订号和投影复用推进。Codex 嵌套对象的 alias 曾为待确认点，当前实现状态见文首。

### 与其它 ADR 的关系

- ADR-0037 管"事务能否结束"，本文管"结束得多贵"。两者独立，但先做 0037 收益更大。
- ADR-0035 §12 已确立"修订号优先于内容哈希"，本文把它扩展到 Host 模型层、App 投影层与 DSH 显示索引三处。
- ADR-0032 的权威模型依赖 §2、§3、§4 三条约束同时成立；只做其中一条会让模型出现静默分叉或不必要的全量回退。

## 验证

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。
