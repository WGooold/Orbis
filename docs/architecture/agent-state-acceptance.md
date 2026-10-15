# Agent 状态模型验收清单（ADR-0032）

这份清单是 [ADR-0032](../adr/0032-host-owned-agent-state-model.md) 的验收登记表：36 个状态模块逐项对应到统一模型的归属、作用域与迁移状态。ADR 要求在 Agent 子域完成后仍然保留这份登记，避免「先接了通知就宣布完整模型完成」。

## 交接：现在在哪、下一步做什么

> 给接手的人或新会话。完成 issue #12 与 #11 后可以删掉这一节。

**状态（2026-10-14，代码侧 #11/#12 已完成，全部未 push，工作树干净）**

- 统一模型：36 个模块里 10 个已接入真实事实（03 目录、09–19 的 Host 侧投影，外加权限、命令回执、通知引用）。
- 显示投影：契约（`DisplayEntry`/`DisplayBatch` + 窗口起点 `windowStart` + 渲染锚点 `anchor`）→ 三个适配层产出 → 每页/每批随 canonical 范围同行 → **App 消费**，这条链已经打通。App 侧已删除全部原生解释（`PiMessageProjection`、压缩裁剪、`stopReason` 判定、`custom_message` 拼装）。
- 条目与显示结果在本地**同一笔事务**里落盘，提交后按盘上那份读回（来源修正条目时显示行随之修正）；`projectionVersion` 换代即整段作废该会话缓存，包括上一版 App 留下的「只有条目、没有解释」的旧缓存。
- 协议已硬升到 **13**（issue #11 的代码部分）：两端常量同步，且本来就没有兼容旁路。
- 未完成：**实机验收**——issue #12 的三种显示场景，以及 issue #11 的跨端恢复验收矩阵（第 10 批那张表，6 项全未跑）。

**下一步**

1. **实机核对（issue #12 验收项，尚未做）**：三种情况——压缩后重载、失败回合、自定义消息带产物。要点：
   - App 现在**必须**由发 `display` 的 Host 服务；用户当前运行中的 Host 仍是旧代码（不发 display），所以要跑真实会话必须先获得重启授权。
   - 不需要授权也能做的一半：`scripts/session-sync-fixture.mjs` + `SessionSyncSlowLinkInstrumentedTest`（真加密链路 + 真 SQLite + 真 ChatScreen，夹具用真实协议函数产出 display）。跑之前先 `npm run build`（夹具读 `packages/*/dist`）。
2. **issue #11**：硬升 `PROTOCOL_VERSION`，删掉旧路径与双写。
3. 两项都完成后删掉这一节。

**硬约束（踩过或明确写死的）**

- Kotlin 改动必须经 `scripts/windows/android-build.ps1` 构建 + `android/app/src/test` 单测通过才能提交；不要在未编译的情况下入库。设备测试（`src/androidTest`）走同一个脚本，单测与设备测试共用 `android/app/src/sharedTest` 里的夹具（两个源集互相看不见对方）。
- 不要直接跑 `gradlew`（绕过构建锁）；模拟器一实例一持有者，用完必须关闭。
- 三个后端都已供 `display`，所以客户端是**一次切换**，没有按后端灰度。
- push、发版、重启 Host 都需要单独授权；本分支至今未 push。

作用域与版本：

- **HostState**：Host 级共享领域（`HostStateDomain`），按 `hostId` 记版本。
- **AgentState**：会话级领域（`AgentStateDomain`），按 `(hostId, agentKind, sessionId)` 记版本。
- **DeviceView**：某一配对设备的过滤视图（`DeviceStateDomain`：通知关闭、私有回执、传输任务）。它在 Registry 里是独立作用域：Host 持有，但不向其他设备广播，也不重新定义共享事实。
- **AppLocalState**：设备本地状态，**保留在 App**，不进入共享模型。

每个领域都用同一 envelope：`modelEpoch` / `revision` / `availability` / `completeness` / `source` / `checkedAt` / `value`。`modelEpoch` 与通知协议的 `hostEpoch` 是两件事，不得互相代替。

当前状态口径：

- `模型已定义`＝ schema 与 Registry 已存在，但**没有**接入真实来源。
- `已接入事实`＝适配层已经把真实事件归一成领域事实写进 Registry；客户端协议尚未接入（那是 issue #10）。
- `已有实现，待接入`＝该域在 Host 或 adapter 已有一份可用实现，只是还没有写进统一模型。
- `保留本地`＝ADR 已定边界，不迁移。

## 01–24：纳入 Host 统一模型

| 模块 | 目标归属 | 现状 |
| --- | --- | --- |
| 01 身份与运行元数据 | AgentState.identity / availability | 模型已定义；adapter 已有 metadata |
| 02 后端可用性与桌面接入 | HostState.backends；AgentState.availability | 模型已定义；Host 已有 readiness 聚合 |
| 03 会话目录与归档 | HostState.catalog | **已接入事实**：逐后端读取结果、失败原因与截断标记；任一后端没读全就是 partial，不冒充完整空目录 |
| 04 聊天历史与 canonical Entries | AgentState.history | **已接入事实**：`projectDisplayEntries` 产出标准 ChatMessage（文本/思考/工具调用/产物/摘要），App 直接渲染，不再解释原生形状；未知条目保留身份与原因 |
| 05 会话分支与当前 head | AgentState.history | **已接入事实**：路径重建、压缩裁剪与摘要渲染位置都在产出方判定（批次带窗口起点与渲染锚点），App 只负责分支与 head；缺父/成环/找不到叶子如实报告 |
| 06 实时消息与流式正文 | AgentState.live.messages | 模型已定义；live 在 source adapter |
| 07 回合身份与计时 | AgentState.execution.turn | 模型已定义；分散在 source 与 App |
| 08 工具调用与执行结果 | AgentState.live.tools | 模型已定义；工具库存在 source |
| 09 运行与等待状态 | AgentState.execution | **已接入事实**：状态 + 待回答交互共同决定 waiting；DSH 审批等待因此有了统一投影 |
| 10 重试与上下文压缩 | AgentState.execution.retry / compaction | **部分接入**：字段已在模型里，但仍显式 `unavailable`——等适配层提供真实阶段 |
| 11 交互请求与审批 | AgentState.interactions | **已接入事实**：`snapshot` 是完整清单，回答/取消按 id 显式删除 |
| 12 消息队列与投递状态 | AgentState.delivery.queue | **已接入事实**：只有部分清单（后端没有队列快照事件），因此不能当基线 |
| 13 命令关联与执行回执 | HostState.operations；DeviceView | **已接入事实**：受理先记 accepted，后端结果覆盖同一条；回执按设备作用域、有界淘汰并按 id 显式删除 |
| 14 权限摘要与可编辑设置 | AgentState.permissions | **已接入事实**：raw 权限 + opaque management；缺 management 不等于权限更宽，离线保留最后已知值 |
| 15 模型与思考级别 | AgentState.model | **已接入事实**：metadata 没报就是整个领域 unknown；选项明细仍走 commands |
| 16 上下文与 tokens | AgentState.context | **已接入事实**：缺事实为 unknown，不假报已支持 |
| 17 能力与资源 | AgentState.capabilities / resources | **已接入事实**：命令菜单按完整清单替换；资源（skills/prompts/MCP）仍归各后端 |
| 18 通知生产者事实 | adapter 事实 → AgentState.notifications | 已有实现（NotificationStore 消费来源事实）；模型侧只记引用 |
| 19 Host 通知生命周期 | AgentState.notifications；DeviceView | **已接入引用**：Store 仍是唯一权威，模型发布 hostEpoch / revision / 条数 / 条件 code / 核对程度 |
| 20 供应商手机摘要 | HostState.providers | **已接入事实**：设备请求目录时把同一次读取到的「当前 provider」写进模型；profile 清单/认证绑定/切换进行中与用量没有事实，记 `null`/`unknown`，不补默认值 |
| 21 完整配置与认证绑定 | HostState.providers | 已有实现，待接入；秘密留 Host |
| 22 用量、健康度与路由 | HostState.providers | 已有实现，待接入；手机摘要缺字段 |
| 23 诊断日志与实时记录 | HostState.diagnostics；AgentState.records | **记录与游标已定义**：`DiagnosticRecord`/`DiagnosticPage` + 有界 `DiagnosticJournal`（条数+保留窗口淘汰、游标分页、缺口如实报告）；待接真实来源与持久化 |
| 24 文件产物与会话附件 | AgentState.artifacts；HostState.files | 模型已定义；缺 artifact inventory |

## 25–30：Host 领域服务（逐项登记，含双侧状态）

| 模块 | 目标归属 | 现状 |
| --- | --- | --- |
| 25 工作区与 Git 分支 | HostState.workspaces；AgentState.workspaceRef | 已有实现，待接入 |
| 26 会话激活与电脑侧操作 | HostState.operations | 已有实现，待接入 |
| 27 同步任务与背压 | HostState.operations | 已有实现，待接入 |
| 28 Host 身份、配对与设备 | HostState.identity / connections | 已有实现，待接入；不导出凭据 |
| 29 连接、路径、加密与序号 | **双侧**：HostState.connections 只发布摘要与传输 sequence；App 仍持有 socket / path / handshake / e2eReady / 密钥 / 重放水位（AppLocalState.transport） | 已有实现，待接入摘要 |
| 30 安装、桌面与服务生命周期 | HostState.management | 已有实现，待接入 |

模块 29 不是 Host 单方权威：Host 摘要不能代替本端握手判定，Relay 转发路径也不等于已确认的端到端可用。

## 31–36：保留在 AppLocalState

| 模块 | 保留原因 |
| --- | --- |
| 31 App 缓存、应用水位与恢复 | 反映某一设备已成功应用的版本；后端事实权威仍在来源 |
| 32 App 读取操作与请求重试 | 逻辑读取目标、反馈与网络尝试属于设备；不等于远端 running |
| 33 上传下载与持久前缀 | 手机磁盘前缀由 App 权威，Host 只确认 durable 前缀 |
| 34 App 发件箱与提交反馈 | 未确认提交必须能在源端 live 为空时独立显示 |
| 35 多 Host 连接与当前选择 | 设备侧连接与当前界面选择；每 Host 模型仍来自各自 Host |
| 36 草稿、别名、视图与偏好 | 本地编辑与展示，不是共享 Agent 事实 |

## 第 1 批（issue #5）交付与未交付

已交付：

- `packages/protocol/src/agent-state.ts`：Agent 身份（`AgentKey`）、设备身份与设备视图领域（`DeviceKey` / `DeviceStateDomain`）、操作与记录身份、Agent/Host 领域枚举、来源与领域 envelope、缺席证明规则。
- `packages/host/src/agent-state-registry.ts`：单写者 Registry——来源登记与冲突拒绝、`modelEpoch` 迟到拒绝、换代次必须完整基线、`ready`+`complete` 才允许缺席删除、部分清单合并、未知保留最后已知值、内容不变不推进版本、先提交再发布、值预算与条目上限、按已应用版本的基线读取、会话/设备作用域终结与隔离。

未交付（留给后续 ticket）：把任何真实来源写进 Registry、协议消息与版本升级、App/桌面改为模型消费者、历史 displayEntries 归一、供应商公共投影、持久诊断记录。因此本批次**不改变**任何运行时行为，也不需要重启 Host。

## 第 2 批（issue #6）交付与未交付

已交付——适配层事实接入（[agent-state-facts.ts](../../packages/host/src/agent-state-facts.ts)）：

- 把已有的 runtime 事件归一成领域事实交给 Registry：`execution`、`delivery`、`interactions`、`model`、`context`、`capabilities`。
- Host 在事件转发前先记录事实（[host-service.ts](../../packages/host/src/host-service.ts) 的 `#publishRuntimeEvent`），记录失败不影响转发；离线时把已知领域标成待核对并保留最后已知值。
- 会话身份用 `(agentKind, sessionId)`，runtimeId 只是可更换的路由身份：重新接入换新代次，旧连接的回调被丢弃。
- 重新接入后没有收到新事实的集合领域保持待核对，不用「本地累加器为空」冒充「后端说没有了」。
- 整体仍是**只写不读**：没有任何协议消息、App 或桌面行为依赖这些投影。

未交付：

- 03 目录逐后端完整性、18/19 通知来源、23 诊断记录仍在既有实现里，未并入模型（通知已有独立 Store，按 ADR 复用即可）。
- 04–08 历史与 live 正文继续由 source adapter 的版本化复制负责（ADR-0024/0025），模型只记引用，不重复正文。
- 已知边界：队列没有完整清单事件，重新接入前观察到的条目要等会话结束（`forget`）或后端提供完整清单才会消失；模型里以 `completeness: partial` 如实表达。
- 协议层读取（App/桌面消费模型）留给 issue #10；供应商公共投影与持久诊断记录分别留给 #8、#9。

## 第 3 批（issue #6 续）交付与未交付

已交付：

- **模块 14 权限**：`AgentState.permissions` 取 metadata 的 raw 权限与 opaque `management`。没有 `management` 只表示后端没提供编辑界面（ADR-0031），不是「权限更宽」；metadata 没报权限时整个领域 unknown，离线保留最后已知值。
- **模块 13 命令回执**：新增 [device-view-facts.ts](../../packages/host/src/device-view-facts.ts)，把 Host 受理与后端结果写进 **DeviceView.operations**——只对发起设备可见，按 operationId 覆盖同一条，每台设备最多 256 条并按最旧淘汰（淘汰用显式按 id 删除同步，不靠缺席推断）；设备被撤销时终结该视图。
- Registry 增加集合条目键不能为空白的身份校验。
- 两个重型 Host 测试（device-link 背压、artifact 续传）显式声明 30s 超时：整机并行跑测试时 10s 上限偶发不够，断言未改。

未交付（issue #6 剩余）：

- 模块 10 重试/压缩的真实阶段仍显式 `unavailable`，需要各适配层提供事实。
- 模块 03 目录的逐后端完整性、模块 18/19 通知在模型里的归属引用尚未接入；通知继续由既有 NotificationStore 独立拥有（ADR-0028），接入时只做引用与摘要，不复制权威。

## 第 4 批（issue #6 续）交付与未交付

已交付——模块 18/19 通知的模型归属：

- `NotificationStore.summary()` 发布**引用摘要**：`hostEpoch`、`revision`、`sessionId`、`activeCount`、条件 `code`/`severity`、`complete`、`verification`。刻意不含正文——条目、期限与设备关闭仍由 Store 唯一拥有（ADR-0028），模型不复制第二份权威。
- 模型里的通知写者是 `host:notifications`（producer `host`），与后端适配器来源分开，因此同一个会话里两个写者互不冲突。
- Host 的通知投影一变化（apply / dismiss / expire / outcome / end / attach）就刷新摘要；身份还没建立时不补写，等 metadata 到达时带上当时的摘要。
- 来源代次用固定 id 而不是通知的 `hostEpoch`：Host 重建时整份模型本来就换代次，不能把「通知代次」误当成来源重建而要求重新基线。

未交付：模块 03 目录的逐后端完整性（见第 5 批），模块 10 重试/压缩的真实阶段（需要适配层事实）。

## 第 5 批（issue #6 收尾：目录完整性）

已交付——模块 03 聚合目录的逐后端完整性：

- 新增 [host-state-facts.ts](../../packages/host/src/host-state-facts.ts) 写入 `HostState.catalog`：每个后端的 `kind` / `ready` / `sessions` / `complete` / `elapsedMs` / `error`，加上总数与截断标记。
- 只要有一个后端没就绪、读取失败，或聚合结果被 2,000 条上限截断，整个目录就是 `partial`。于是「某个后端这次没读到」在模型里不会退化成「那个后端没有会话」。
- 目录缓存命中时不会重复提交；内容没变时 Registry 本来就不推进版本。

issue #6 的 Host 侧范围到此完成。剩下的只有模块 10 重试/压缩的真实阶段：那必须由各适配层提供事实，Host 不能从 idle 或日志文案推断。

## 第 6 批（issue #7：Host 侧显示投影、页缓存与范围入口）

已交付——[display-entries.ts](../../packages/host/src/display-entries.ts)：

- `projectDisplayEntries(entries, leafId)` 把 canonical 条目投影成客户端可直接渲染的结果，语义与今天 Android 的实现逐条对齐：角色映射（toolResult/tool → tool、bashExecution → system、custom → custom）、正文块（文本/思考/工具调用的两种历史命名）、压缩裁剪（`firstKeptEntryId` 指不到就只保留压缩点及之后）、失败回填（`remoteFailure` 优先，缺失时回退 provider 文案且不重复追加）、自定义消息的显示开关与产物引用、分支摘要、以及原生事件忽略名单。
- 两处有意的改进：不可显示的条目**不再被静默丢弃**，而是带 `nativeType` 与原因（`unknown_native_type` / `not_rendered` / `missing_content`）留在结果里；结果带 `projectionVersion`，投影语义变化时消费方据此失效显示缓存。
- 路径不完整时如实报告：`leaf_not_found` / `missing_parent` / `cycle_detected`，不假装历史完整。
- 纯函数，不写模型、不发消息、**不改 App**：协议接入与 App 迁移留给 issue #10。

- [display-page-cache.ts](../../packages/host/src/display-page-cache.ts)：有界显示页缓存与范围索引。有效性判据是`sourceEpoch`（不是 revision——同一代次里新内容改写的只是 live，更旧的范围没变），页数/单页条数/总字节三个上限，命中刷新 LRU，head 变化重置该会话覆盖范围；范围索引记录「已缓存到的最旧条目」与「是否已到分支起点」，只有带 `beforeEntryId` 的页才会把最旧边界往前推。

- [display-range-service.ts](../../packages/host/src/display-range-service.ts)：统一显示范围入口，把「缓存 → provider 查原生历史 → 归一 → 校验 → 入缓存 → 返回」串成一条路径。provider 是留给协议层（#10）的缝；同一窗口的并发请求合并成一次查询；provider 失败返回 `unavailable` 而不是空历史，也不污染缓存；来源没自报代次时照常返回投影但明确不缓存。`observeSource` 让 Host 在处理来源复制时告知当前代次，缓存因此不必先问 adapter。

issue #7 未交付部分：把 provider 接到真实 adapter（协议与来源查询）、App 停止解释原生形状。

## 第 7 批（issue #10 服务端一半：模型读取协议）

已交付：

- 协议新增 `agent.state.request` / `agent.state.snapshot`（负载定义在 `agent-state.ts`，线上消息由 index.ts 补 `protocolVersion`）。应答带每个领域自己的 envelope、`modelEpoch`、`missing`（`no_state` / `unknown_domain`）与 `truncated`：点名要却没有状态的领域、以及超出字节预算被截断的情况，都必须由 Host 说出来。
- Host 在设备载荷分派里同步应答：按 `scope`（host / agent / device）或 `runtimeId` / `sessionId+agentKind` 解析作用域，读的是 Registry 里**已提交**的当前投影，不查后端、不占本机资源。作用域解析不出来时明确回错，而不是回空快照。
- 设备视图按发起设备取，客户端不能指定别的设备。

未交付（issue #10 剩余）：App 与桌面改为消费这些消息、显示范围请求接到真实 adapter、协议硬版本升级（issue #11）。

## 第 8 批（issue #10：显示投影上协议）

已交付——**最终形态的契约**（不是双读中间态）：

- 协议新增 `DisplayEntry` / `DisplayBatch`，并作为**可选字段挂在 `session.snapshot` 与 `session.patch` 上**：适配层对本次条目给出的显示投影与 canonical 范围绑定同一来源版本，跟着同一份消息到达，不额外往返。
- `projectionVersion` 随批次下发：显示语义变化时客户端必须重建显示缓存，而不是继续用旧表示。
- `toDisplayBatch` 只在路径 `complete` 时才产出批次：半截的「完整样子」会覆盖客户端已有的正确内容，比不给更糟。

未交付（同一方向的后续批次）：三个适配层实际产出 `display`、App 改为渲染 `display.entries` 并删除原生解释（`PiMessageProjection`、压缩裁剪、stopReason 判定）、协议硬版本升级。

## 第 9 批（issue #12：App 消费显示投影）

已交付——App 侧（`android/app/src/main/java/dev/pi/remote/`）：

- **契约补齐**（协议 `ad5b156`）：批次带 `windowStart`（显示窗口起点——路径上比它更旧的条目已被历史改写覆盖，客户端据此作废旧显示内容），压缩摘要带 `anchor: "head"`（渲染在窗口顶部，而不是它在路径里的位置）。`selectSessionSyncSnapshot` 给**每一页**附上该页自己的显示结果：一次投影、多页共用，空页不发。显示投影接受「已验证的原生边界」，有界读取的分支不再因为「更旧的还没读进来」被判成缺父而整段不发。
- **App 落盘与消费**：新增 [DisplayProjection.kt](../../android/app/src/main/java/dev/pi/remote/DisplayProjection.kt)（`DisplayEntry` / `DisplayBatch` / 窗口裁剪 / 锚点排序）与两张表 `session_display_entries` / `session_display_windows`（库版本 8）。条目与显示结果在同一笔事务里提交；提交后按**盘上那份**读回（来源修正条目时，被顶掉的那一行显示结果不写、保留盘上原值），因此渲染正文与已提交历史永远同源。
- **删除原生解释**：`PiMessageProjection`、`toChatMessage`、正文块解释、`firstKeptEntryId` 压缩裁剪、`stopReason`/`errorMessage`/`remoteFailure` 失败判定与回填、`custom_message` 的 display 开关与产物拼装全部删除。`projectSessionGraph` 现在只做「走路径 → 按窗口裁剪 → 取显示行 → 按锚点排序」。
- **版本换代**：`projectionVersion` 与本机不同即整段作废该会话缓存（含上一版 App 留下的「有条目、没解释」的旧缓存），下一次同步重新拿；版本不匹配时投影如实报「请更新 App」，而不是渲染成一片空白。
- 不可显示的条目保留身份与原因（`undisplayable` + `unknown_native_type` / `not_rendered` / `missing_content`），只是没有可渲染正文。

**实机核对已完成**（emulator-5554，`DisplayScenariosInstrumentedTest`：`tests=1 failures=0 skipped=0`，14.2s）：

- 会话由 `scripts/session-sync-fixture.mjs --rich` 提供（真加密链路 + 真 SQLite + 真显示投影），三种形态逐条断言：压缩裁掉的旧条目不渲染、摘要按 `anchor=head` 渲染在窗口顶部、保留段与之后照旧；失败回合 `isError=true` 且文案来自产出方的 `remoteFailure`；自定义消息带 `report.pdf` 产物块。
- 落盘侧：7 条 canonical 条目、**只有窗口内的 5 行显示结果**、窗口起点为保留段第一条——「条目与显示行同源」在设备上成立。

协议硬版本升级见第 10 批。

已知边界：**会话树**（`/tree`，[HistoryTree.kt](../../android/app/src/main/java/dev/pi/remote/HistoryTree.kt)）仍按后端给出的 `role` / `entryType` 分类节点。树要显示**不在显示窗口里**的条目（系统事件、被压缩掉的节点、细节行），显示投影刻意不含它们，所以树的分类属于模块 05 的另一半，留给后续批次。

## 第 10 批（issue #11：协议硬版本与跨端恢复验收）

已交付：

- `PROTOCOL_VERSION` 12 → **13**（`packages/protocol/src/index.ts` 与 App 侧 `RelayClient.kt` 同步）。
  13 的含义：客户端改为消费 Host 的显示投影（`display` 的窗口起点与渲染锚点），App 不再解释原生形状。
- **没有兼容旁路可删**：所有入站校验本来就是精确匹配（`!== PROTOCOL_VERSION` 直接拒绝，见
  `packages/protocol/src/index.ts`、`relay-client.ts`、`lan-server.ts`、`provider-messages.ts`）。
  所以这次升版是断代：两端必须一起更新，旧版本客户端连不上新 Host，反之亦然。
- 修掉一处写死的旧值：`agent-state-snapshot.test.ts` 断言 `protocolVersion` 用常量而不是字面量 12。

**跨端恢复验收矩阵**（issue #11 的另一半：必须逐项在设备上跑过才算数，目前**未跑**）：

| # | 场景 | 怎么造 | 通过标准 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 版本不匹配 | 用 `dcafa43`（协议 12）构建 App，连 13 的隔离测试台 | 明确拒绝并提示版本不一致，不静默降级、不进半连接状态 | 单测已覆盖两端精确保守；**设备级未跑** |
| 2 | Host 重建 | 重启 Host（新 source epoch / 新 modelEpoch） | App 按代次重建：旧代次的迟到回调被丢弃，不冒充新代次已确认事实 | 未跑 |
| 3 | 断线重连 | 断开 Relay（或关 LAN），恢复后重连 | 按 source epoch/seq 续传；缺口走恢复基线；`unchanged` 不被当成内容变化 | 未跑 |
| 4 | 历史改写（revert/压缩） | 会话内回退分支、触发压缩 | 显示窗口与 head 一起更新，旧显示行被作废而不是继续渲染 | 未跑 |
| 5 | 设备重开 | 杀掉 App 再打开 | 从 SQLite 恢复：条目与显示行同源（盘上那份），标题/树标签一致 | 未跑 |
| 6 | 多 Host 隔离 | 同时连用户 Host 与隔离测试台 | 两台的设备回执、通知关闭、配对互不串台 | 未跑 |

跑法见 [docs/testing/isolated-host/README.md](../testing/isolated-host/README.md)（隔离 Host 测试台：独立进程、独立状态目录、本机 Relay，不碰用户正在使用的 Host）。

第 1 项的两端拒绝本来就有单测兜底：App 侧 `RelayReducerTest` 用 `PROTOCOL_VERSION - 1` 断言拒绝；Host/Relay 侧的 `relay-client.ts`、`lan-server.ts`、`provider-messages.ts` 都是精确匹配。设备级那一跑要的是「旧版客户端连新版 Host 会被明确拒绝」，做法是拿升版前那个提交构建 App。

顺带在设备上看到一条现状（不是验收项，但**卡住整个矩阵**）：这台模拟器上的 App 只有**遗留凭据**（`wgooold.cn`，域名已解析不了），没有有效配对，启动后停在配对页并如实重试失败——它没有假装已连接。

要把矩阵跑下去，设备上必须先有一个「连得上的 Host」。已试过并失败的路径：给配对测试加「写进 App 真实存储」的开关，结果在 instrumentation 进程里构造**真实 App** 的 `RemoteViewModel` 会挂住（真实存储里的遗留配对让初始化阻塞，6 分钟无结果），已中止并回退该改动。下次的三条可行路径：

1. 先取得用户对清空这台模拟器 App 数据的授权（`pm clear` / 卸载目前被禁止），再按测试台说明书配对；
2. 不构造 ViewModel，只把配对写进真实存储（`HostPairingStore` / `CredentialStore` / `E2eIdentityStore`），再用 adb 启动 App 观察；
3. 用第二台模拟器实例（干净数据）跑矩阵。

第 3–6 项都依赖这一步先完成。

## 第 11 批（issue #8 第一刀：Host 供应商公共投影）

已交付：

- 协议 `HostProviderSummary` / `HostProvidersState`（`HostState.providers`，模块 20–22 的共同投影）：每个后端给出 `current`、profile 展示列表、`authenticated`、`switching` 与 `usage{availability,detail}`。
  **没有 baseUrl、密钥或脚本内容**——秘密留在 Host；拿不到事实的字段显式 `unknown`，不用 0 或空值冒充已确认。
- `HostStateFacts.providers()` 写进 Registry（producer `host:providers`，与目录各自的 sourceId 分开）；没有摘要时领域 availability 是 `unknown`，而不是「这台电脑没有供应商」。
- 4 条单测：写入与核对时点、空清单是 unknown、用量缺失保留 unknown、内容不变不推进版本。

未交付：profile 清单、切换进行中状态、用量/健康度这些字段还需要真实来源（供应商命令出口本身只报名字），以及模块 21/22 的完整字段。

**已接线**：host-service 回 `session.list.result` 时写同一份事实（模型投影与设备命令的返回值来自同一次读取）；`profiles` / `authenticated` / `switching` 在该调用点没有事实，协议里因此是 `nullable`，写 `null` 而不是猜。

## 第 12 批（issue #9 第一刀：有界诊断记录与游标）

已交付：

- 协议 `DiagnosticRecord` / `DiagnosticPage`（模块 23）：身份（scope / agentKind / sessionId）、类别、严重度、短文本、小键值 `detail` 与时点；**正文、凭据、脚本不进记录**。
- Host [diagnostic-journal.ts](../../packages/host/src/diagnostic-journal.ts)：有界记录（条数上限 + 保留窗口，超出即淘汰并计入 `dropped`）、不透明游标分页、**游标落后于保留窗口时置 `truncated`**（不拿「翻不到」冒充「本来没有」）、按类别/严重度/会话过滤（被过滤的记录也越过游标，下一页不会原地打转）、会话结束按作用域清理。
- 5 条单测覆盖上述语义。

**已接线**：HostService 持有 journal，并在两条已有失败路径上写入——目录逐后端拉取失败（`category=catalog`，error）、读取当前 provider 失败（`category=provider`，warning）。`recordDiagnostic()` 自己吞掉异常：诊断是旁路，它的失败不能冒泡给业务；`readDiagnostics()` 提供游标读（供后续协议出口）。

未交付：其余写入点（传输/审批/恢复/供应商切换）、**持久化**（当前仅在内存中有界，进程重启即丢）、跨设备读取协议（`agent.state.request` 的 records 域）。

## 回归要求

改动 Registry 或 envelope 时必须保持：

- 未校验来源、部分清单、过期结果都不能删除有效状态；`unknown` / `unavailable` 是显式状态。
- 心跳、历史页请求与其他设备回执不推进源端内容版本。
- 提交路径里不发起原生 RPC、文件 IO 或网络探测。
- Registry 不保存全量聊天历史。
