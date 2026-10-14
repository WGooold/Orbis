# Agent 状态模型验收清单（ADR-0032）

这份清单是 [ADR-0032](../adr/0032-host-owned-agent-state-model.md) 的验收登记表：36 个状态模块逐项对应到统一模型的归属、作用域与迁移状态。ADR 要求在 Agent 子域完成后仍然保留这份登记，避免「先接了通知就宣布完整模型完成」。

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
| 04 聊天历史与 canonical Entries | AgentState.history | **Host 侧投影已实现**：`projectDisplayEntries` 产出标准 ChatMessage（文本/思考/工具调用/产物/摘要）；未知条目保留身份与原因 |
| 05 会话分支与当前 head | AgentState.history | **Host 侧投影已实现**：路径重建与压缩裁剪在 Host 判定，缺父/成环/找不到叶子如实报告；App 仍用旧投影 |
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
| 20 供应商手机摘要 | HostState.providers | 已有实现，待接入；缺领域版本 |
| 21 完整配置与认证绑定 | HostState.providers | 已有实现，待接入；秘密留 Host |
| 22 用量、健康度与路由 | HostState.providers | 已有实现，待接入；手机摘要缺字段 |
| 23 诊断日志与实时记录 | HostState.diagnostics；AgentState.records | 模型已定义；缺统一记录与游标 |
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

## 回归要求

改动 Registry 或 envelope 时必须保持：

- 未校验来源、部分清单、过期结果都不能删除有效状态；`unknown` / `unavailable` 是显式状态。
- 心跳、历史页请求与其他设备回执不推进源端内容版本。
- 提交路径里不发起原生 RPC、文件 IO 或网络探测。
- Registry 不保存全量聊天历史。
