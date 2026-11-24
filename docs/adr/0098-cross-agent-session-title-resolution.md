# ADR-0098：跨 Agent 会话标题的获取、保留与兜底

日期：2026-11-25

状态：代码实现及本轮定向自动验证已完成；最近发布版本兼容核验与用户验收待完成。

关联：[ADR-0032](0032-explicit-unknowns-and-failure-coverage.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0069](0069-session-catalog-and-bounded-history-loading.md)、[ADR-0095](0095-codex-unified-catalog-and-launch-modes.md)。

## 背景

会话标题不是 Agent 名称，也不是 session ID。Host 目录、在线 runtime、手机本地目录缓存和已同步聊天历史分别持有不同粒度的事实；各 Adapter 对原生标题的支持也不同。现状存在以下问题：

- `AgentSessionSummary.name` 和 `RuntimeMetadata.sessionName` 虽已分别承载目录标题和在线标题，但没有共同的缺失／清除语义。
- App 重连或收到不完整目录时，缺少标题可能被当作空标题覆盖已有的持久化值；iOS 和 Android 的目录合并策略及回退顺序也不完全一致。
- 活跃目录行可能在合并时覆盖同一会话已获得的标题，例如 DSH ACP 的活动会话合并。
- UI 有时要等聊天历史抵达才能从用户消息推导显示名称。该推导是展示兜底，不应代替重取原生标题。
- `runtime.name` 是 `Codex`、`Claude Code` 等 Agent 品牌名称，不是会话标题；`cwd`、项目目录名和最近一条用户消息也不能冒充原生标题。

## 决策

### TITLE-01｜统一字段职责

- `AgentSessionSummary.name` 表示 Agent 原生目录报告的会话标题。
- `RuntimeMetadata.sessionName` 表示当前会话 runtime 最近确认的 Agent 原生标题。
- 非空值承载原生标题；`firstMessage` 只承载首条用户消息预览。运行时的 `name` 继续表示 Agent 品牌，不进入会话标题候选。
- Agent 若不支持原生会话标题，或某次读取没有返回标题，应省略字段，不生成空串、session ID、工作目录名或模型名作为假标题。
- `sessionName: ""` 和目录 `name: ""` 是兼容现有可选字符串字段的明确清除标记，仅在原生接口明确报告清除时发送；不支持清除的 Agent 永不发送空串。

### TITLE-02｜名称状态与合并

- 非空原生标题是正向确认：更新 runtime 和目录中的已知标题。
- 目录响应缺字段、读取失败、覆盖不完整、旧 Host／旧 Agent 不支持标题，均表示“本次未知”，不得删除先前已确认的标题或消息预览。
- `sessionName`／`name` 缺省或读取失败表示“未提供／未知”；接收端保留同一 Host、同一 sessionId 最近一次非空确认标题。
- 原生更新协议若对标题字段提供了明确的 `null` 清除（例如 Codex `thread/name/updated`、DeepSeek Web 已排序 title projection），Host 将其归一成对应可选字符串字段的空串标记。此标记只清除原生标题候选，不清除首条用户消息；显示立即回落到首条用户消息／预览，再到 sessionId。源快照中**字段缺失**仍是未知，不能清除。无明确清除语义的 list 空值按未知处理。
- 标题合并必须绑定同一 Host 与同一 sessionId；不得跨 Host、同名会话或仅 cwd 相同的会话借用标题。

### TITLE-03｜所有 Agent 共用的显示优先级

对同一 sessionId，iOS、Android、Host 目录及运行卡片按以下顺序解析：

1. **当前 runtime 最近确认的原生标题状态**（非空 `sessionName` 为标题；显式空串表示跳过任何旧原生标题并进入内容兜底）。在线且状态属于同一会话时优先。
2. **Host 原生会话目录标题**（`AgentSessionSummary.name`），优先使用本次完整目录读到的值；暂时缺失时保留本机最近一次确认的值。显式空串清除标记优先于所有旧标题缓存。
3. **本机保存的已确认原生标题**，只作为 Host 暂时离线或返回不完整数据时的保留值；永不覆盖较新的在线／目录原生标题。
4. **首条用户消息**，绝不取最近一条消息：先用目录提供的 `firstMessage` 预览；没有预览时，从已验证历史取首条非空用户文本；再没有时从当前 runtime 已收到的对话取首条用户文本。
5. **sessionId**，作为最后一个稳定、可复制和可区分的占位显示。

本机可以缓存标题或派生显示结果作为性能优化，但缓存不得改变上述来源优先级。会话标题解析不等待用户再次输入；聊天历史只在原生标题与其缓存均不可用时提供兜底。

### TITLE-04｜原生读取优先级与读取时机

各 Adapter 尽量按下列链路提供标题；前一来源在该 Agent／版本不可用时才进入后一来源：

1. **原生持久目录接口**：会话列表中 Agent 明确提供的 title/name/displayName。
2. **原生单会话快照／恢复接口**：在会话被选中或恢复时读取该 sessionId 的 title/name；不为全目录每条记录无界地发起详情请求。
3. **原生标题更新事件／订阅**：会话改名、自动命名或目录投影更新后，按该 Agent 的版本／序号规则发布 runtime metadata 和目录失效通知。
4. **只读本地会话头或已验证历史**：仅当 Agent 没有可用原生标题时，提取首条用户消息用于显示兜底；不将其回写成原生 title。
5. **sessionId**。

Codex Desktop 的既有 `thread/list`、`thread/read`、`thread/resume` 和 `thread/name/updated` 按上述 1–3 级使用；恢复响应缺名时保留既有标题，并仅对当前被打开的线程按需调用 `thread/read` 补齐，不对整个目录逐条读取。桌面 loaded-thread 轮询用于会话发现，不等同于标题快照。

| Agent | 原生标题来源（目录／runtime） | 无原生标题时的统一兜底 |
|---|---|---|
| Pi | session 文件首行 `name`；在线 runtime metadata | 首条用户消息 → sessionId |
| Codex / Codex Desktop | `thread/list`；选中／恢复时 `thread/read`、`thread/resume`；`thread/name/updated` | rollout／已同步历史首条用户消息 → sessionId |
| Claude Code | session catalog 中的名称；Hook／Mods runtime title | transcript 首条用户消息 → sessionId |
| DeepSeek Harness ACP | `session/list.title`；活动会话合并不得丢弃同 ID 目录标题 | 历史首条用户消息 → sessionId |
| DeepSeek Web／Desktop | 序列化 title projection／`session/title` 更新 | 会话首条用户消息 → sessionId |
| OpenCode | 原生 `session.list.title` 与 live session title | 首条用户消息 → sessionId |
| OpenClaw | 原生 `displayName`、`derivedTitle`、`label` 中该 Agent 确认的标题 | 首条用户消息 → sessionId |
| Hermes | Gateway `session/list.title` 与 live metadata | `firstMessage`／历史首条用户消息 → sessionId |
| Kimi Code | 原生历史 `meta.title` 与 runtime title 更新事件 | 首条用户消息 → sessionId |

### TITLE-05｜协议兼容及失败边界

- 本决策不增加字段、不改变 sessionId、不改变历史分页，不要求旧 App／Relay 理解新字段。继续使用已有可选 `name`、`sessionName`、`firstMessage`；空字符串标记只用于有明确原生清除语义的来源。旧 App 将其作为空标题忽略，仍按现有消息／ID兜底。
- 对不能证明标题不存在的读取失败、截断目录或未支持版本，保留最后一次确认值并暴露既有目录覆盖／错误状态；不把“不知道”推断成“无标题”。
- 各 Agent Adapter 的接口差异仍由 Host 消化；App 不新增按 agentKind 分支来猜原生 title。

## 验证要求

- 对每个 Adapter 覆盖：原生标题可读、标题缺失、暂时读取失败、标题更新、runtime 与目录标题合并、sessionId 最后兜底。
- 对 Codex Desktop 覆盖：`thread/list` 名称、恢复响应不带名称但保留旧值、按需 `thread/read` 补齐、通知字段缺失不改名、显式 null 清除、不同 thread 不串名。
- 对 iOS 与 Android 使用相同的候选来源顺序和同一组矩阵：runtime 标题 > 目录标题 > 缓存原生标题 > 首条用户消息预览／历史 > sessionId；缺失不擦除，显式清除只清原生标题并落到内容兜底。
- 验证手机重启／重新握手、Host 暂时离线、旧版 Host 省略字段、目录读取部分失败时，本机缓存标题仍可用；新的非空原生标题到达后能覆盖缓存。
- 兼容性按 ADR-0064 使用最近发布 Host／Relay／App 对照；测试自动化通过不代替用户安装验收。

## 实现索引

- Host 采集与持久目录：[`codex-runtime.ts`](../../packages/host/src/codex-runtime.ts)（`thread/list` 更新已附着 runtime；resume 缺名时按目标 thread 补读 `thread/read`；缺字段保留，明确 null 清除）、[`host-state-facts.ts`](../../packages/host/src/host-state-facts.ts)（目录缺标题保留同 Host／同 Agent／同 sessionId 的既知标题）、[`dsh-runtime.ts`](../../packages/host/src/dsh-runtime.ts)（活动 ACP 行保留 list 标题）、[`dsh-web-runtime.ts`](../../packages/host/src/dsh-web-runtime.ts) 与 [`dsh-session-titles.ts`](../../packages/host/src/dsh-session-titles.ts)（按原生序号应用标题、区分缺失与显式清除）。其它适配器继续由各自 catalog/runtime 原生标题字段供数；无标题时不制造 Agent 标题。
- 兼容协议：[`protocol/src/index.ts`](../../packages/protocol/src/index.ts) 接受现有可选 runtime title 的显式空清除标记；[`protocol/src/agent-state.ts`](../../packages/protocol/src/agent-state.ts) 说明目录同一语义，不新增字段或版本。
- Android：[`AgentModelProjection.kt`](../../android/app/src/main/java/com/orbising/orbis/AgentModelProjection.kt)、[`RemoteState.kt`](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt)、[`SessionDisplayName.kt`](../../android/app/src/main/java/com/orbising/orbis/SessionDisplayName.kt)。标题优先级对齐 runtime > Host catalog > 已存目录标题 > 首条用户消息／历史 > ID；空清除标记跳过旧原生标题。
- iOS：[`AgentState.swift`](../../ios/Orbis/Orbis/AgentState.swift)、[`HostCatalog.swift`](../../ios/Orbis/Orbis/HostCatalog.swift)、[`Presentation.swift`](../../ios/Orbis/Orbis/Presentation.swift)，采用同一缺失保留、明确清除及显示优先级。
- 回归用例：[`codex-runtime.test.ts`](../../packages/host/src/codex-runtime.test.ts)、[`dsh-runtime.test.ts`](../../packages/host/src/dsh-runtime.test.ts)、[`dsh-web-runtime.test.ts`](../../packages/host/src/dsh-web-runtime.test.ts)、[`host-state-facts.test.ts`](../../packages/host/src/host-state-facts.test.ts)、[`protocol/src/index.test.ts`](../../packages/protocol/src/index.test.ts)、[`SessionDisplayNameCacheTest.kt`](../../android/app/src/test/java/com/orbising/orbis/SessionDisplayNameCacheTest.kt)、[`PresentationTests.swift`](../../ios/Orbis/Tests/PresentationTests.swift)、[`MainThreadWorkTests.swift`](../../ios/Orbis/Tests/MainThreadWorkTests.swift)。
- 本轮自动证据：Host／协议 357 个定向 Vitest 用例通过，`npm run typecheck`、定向 ESLint 通过；Android `SessionDisplayNameCacheTest` 12 项通过；iOS `PresentationTests|MainThreadWorkTests` 46 项通过。最近发布 Host／Relay／App 互通核验与手动安装验收尚未完成。
