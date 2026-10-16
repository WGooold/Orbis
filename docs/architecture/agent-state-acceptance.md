# Agent 状态模型验收清单（ADR-0032）

这份清单是 [ADR-0032](../adr/0032-host-owned-agent-state-model.md) 的验收登记表：36 个状态模块逐项对应到统一模型的归属、作用域与迁移状态。ADR 要求在 Agent 子域完成后仍然保留这份登记，避免「先接了通知就宣布完整模型完成」。

## 交接：现在在哪、下一步做什么

> 给接手的人或新会话。完成 issue #12 与 #11 后可以删掉这一节。

**当前位置（第 27 批为止；全部未 push，工作树干净）**

- 统一模型：36 个模块里 **13 个已接入真实事实**（03 目录、09–19 的 Host 侧投影、20 的「当前供应商 + 自己是否正在切换」、23 诊断记录）。下面这段「状态」写于第 2 批前后，仍然成立，只是不再是最新。
- **诊断记录（模块 23）已闭环**：有界 journal + 落盘（跨重启读回、落盘失败计入缺口）→ `HostState.diagnostics` 目录 → `diagnostics.request` / `diagnostics.page` 分页 → App 状态页读目录与一页记录。游标朝**更新**方向走（第 25 批修过一处说反的文案）。
- **App 已消费三个领域**：`diagnostics`、`catalog`（这份会话列表读全了吗、哪个后端为什么没读全）、`providers`（切换进行中——带外切换手机本来看不见）。
- **矩阵**：第 2 项（Host 重建）**通过**；第 6 项（多 Host 隔离）**部分通过**（配对/设备身份/目录不串台，「通知关闭」未构造）；第 1、3、4、5 项未跑，逐项原因与前置见第 21 批的运行手册。
- **HEAD 已验证**（`6cc8bd0`）：`npm run check` = 107 文件 / 1095 测试全过；`:app:testDebugUnitTest` = 46 类 / 422 项全过。接手时先跑这两条确认基线没坏。

**下一步（按代价从低到高）**

1. **矩阵第 5 项（设备重开）**：夹具 Host + instrumented test，不需要真实会话、不拉真 agent 进程；跑前先 `npm run build`（夹具读 `packages/*/dist`）。
2. **矩阵第 3/4 项**：需要一个**活着的、不属于用户的**会话——Pi 历史来自运行中的 Pi，会话文件本身不是历史来源（第 21 批）；两条路是在 rig 里新建会话，或改用夹具 Host。
3. **矩阵第 1 项（版本不匹配）**：需要一个用 `dcafa43`（协议 12）构建的旧 APK；**动代码版本之前先取得用户确认**。
4. ``**#8 的 `profiles`/`authenticated`**：……在用户选定之前不要实现`` **已解决（第 28、29 批）**：`profiles` 与 `current` 由 `refreshProviderFacts()` 独占写入、写前必读；App 也显示了清单。剩下的 `authenticated`（要 profile 的 `authBinding` 与账号列表）与用量（要供应商自己报配额）**不在 `ProviderManager.list()` 的返回值里**，要接得先给这条读取补事实，属于新的工作项。
5. **#9 其余写入点**：传输/审批/恢复——先有可触发的失败钩子，否则只能写出不可测的记录。
6. **#10 更大的领域**：`workspaces` / `operations` / `connections` 在 Host 侧还没有发布事实，得先在 Host 侧接进来。

**状态（2026-10-15，代码侧 #11/#12 已完成，全部未 push，工作树干净）**

- 统一模型：36 个模块里 10 个已接入真实事实（03 目录、09–19 的 Host 侧投影，外加权限、命令回执、通知引用）。
- 显示投影：契约（`DisplayEntry`/`DisplayBatch` + 窗口起点 `windowStart` + 渲染锚点 `anchor`）→ 三个适配层产出 → 每页/每批随 canonical 范围同行 → **App 消费**，这条链已经打通。App 侧已删除全部原生解释（`PiMessageProjection`、压缩裁剪、`stopReason` 判定、`custom_message` 拼装）。
- 条目与显示结果在本地**同一笔事务**里落盘，提交后按盘上那份读回（来源修正条目时显示行随之修正）；`projectionVersion` 换代即整段作废该会话缓存，包括上一版 App 留下的「只有条目、没有解释」的旧缓存。
- 协议已硬升到 **13**（issue #11 的代码部分）：两端常量同步，且本来就没有兼容旁路。
- 未完成：**实机验收**——issue #12 的三种显示场景（第 9 批已在 emulator-5554 跑过一次，见该批记录），以及 issue #11 的跨端恢复验收矩阵（第 10 批那张表，6 项全未跑）。第 17 批已把矩阵的前置条件打通：设备端现在有一台连得上的隔离 Host，且不需要用户授权就能重来。
- 同时推进的 issue #9：诊断记录已跨重启读回（第 13 批），目录与记录都已在协议上可读（第 14、15 批）；issue #10 从 App 侧开了一刀——连接后读一次 Host 作用域的 `diagnostics`，并有 7 条单测锁住「缺席有原因 / 坏消息整份拒绝 / 整份替换」（第 16 批）。其余写入点、记录分页的界面、其余领域的客户端消费与模块 21/22 的字段仍是空的。

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
| 03 会话目录与归档 | HostState.catalog | **已接入事实，App 已消费完整性**：逐后端读取结果、失败原因与截断标记；任一后端没读全就是 partial，不冒充完整空目录；App 状态页显示「读全 / 部分（哪个后端、为什么）」（第 23 批） |
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
| 20 供应商手机摘要 | HostState.providers | **已接入事实，单一写者**：只有 `refreshProviderFacts()` 写这个领域（第 28 批），它在供应商读取/切换后、或客户端点名 `providers` 域时现读一次 pi/codex/dsh，写下 `current`、真读到的 `profiles` 清单与 `switching`（未在切换是 `null` 未核对）；`authenticated` 与用量这次读取里没有依据，记 `null`/`unknown`，不补默认值 |
| 21 完整配置与认证绑定 | HostState.providers | 已有实现，待接入；秘密留 Host |
| 22 用量、健康度与路由 | HostState.providers | 已有实现，待接入；手机摘要缺字段 |
| 23 诊断日志与实时记录 | HostState.diagnostics；AgentState.records | **两端闭环**：`DiagnosticRecord`/`DiagnosticPage` + 有界 `DiagnosticJournal`（条数+保留窗口淘汰、游标分页、缺口如实报告），跨重启读回、落盘失败计入缺口；`HostState.diagnostics` 给目录，`diagnostics.request` → `diagnostics.page` 取记录本身；App 连接后读目录（第 16 批）、按需读记录并在状态页显示最近一条（第 18 批）；待接其余写入点、更早页的界面与其余领域 |
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
| 2 | Host 重建 | 重启 Host（新 source epoch / 新 modelEpoch） | App 按代次重建：旧代次的迟到回调被丢弃，不冒充新代次已确认事实 | **已跑，通过**（第 19 批）：App 自动重连、重新握手、重发 `session.list` 与 `agent.state.request`（同一 requestId 两边对上）；迟到回调那一半由 Registry 单测覆盖 |
| 3 | 断线重连 | 断开 Relay（或关 LAN），恢复后重连 | 按 source epoch/seq 续传；缺口走恢复基线；`unchanged` 不被当成内容变化 | 未跑（前置已就绪：测试台可只服务合成会话，见第 20 批；合成会话还缺历史内容） |
| 4 | 历史改写（revert/压缩） | 会话内回退分支、触发压缩 | 显示窗口与 head 一起更新，旧显示行被作废而不是继续渲染 | 未跑 |
| 5 | 设备重开 | 杀掉 App 再打开 | 从 SQLite 恢复：条目与显示行同源（盘上那份），标题/树标签一致 | **落盘侧已跑，通过**（第 31 批）：换一个 store 实例读回来，条目/显示行/窗口起点/投影版本都在；**进程级重启（真杀 App 再打开）仍未跑** |
| 6 | 多 Host 隔离 | 同时连两台 Host | 两台的设备回执、通知关闭、配对互不串台 | **已跑（部分）**（第 22 批）：用两台隔离 rig 验了配对、设备身份与目录互不串台；「通知关闭」未单独构造，仍算未覆盖 |

跑法见 [docs/testing/isolated-host/README.md](../testing/isolated-host/README.md)（隔离 Host 测试台：独立进程、独立状态目录、本机 Relay，不碰用户正在使用的 Host）。

第 1 项的两端拒绝本来就有单测兜底：App 侧 `RelayReducerTest` 用 `PROTOCOL_VERSION - 1` 断言拒绝；Host/Relay 侧的 `relay-client.ts`、`lan-server.ts`、`provider-messages.ts` 都是精确匹配。设备级那一跑要的是「旧版客户端连新版 Host 会被明确拒绝」，做法是拿升版前那个提交构建 App。

顺带在设备上看到一条现状（不是验收项，但**卡住整个矩阵**）：这台模拟器上的 App 只有**遗留凭据**（`wgooold.cn`，域名已解析不了），没有有效配对，启动后停在配对页并如实重试失败——它没有假装已连接。

要把矩阵跑下去，设备上必须先有一个「连得上的 Host」。已试过并失败的路径：给配对测试加「写进 App 真实存储」的开关，结果在 instrumentation 进程里构造**真实 App** 的 `RemoteViewModel` 会挂住（真实存储里的遗留配对让初始化阻塞，6 分钟无结果），已中止并回退该改动。下次的三条可行路径：

1. 先取得用户对清空这台模拟器 App 数据的授权（`pm clear` / 卸载目前被禁止），再按测试台说明书配对；
2. 不构造 ViewModel，只把配对写进真实存储（`HostPairingStore` / `CredentialStore` / `E2eIdentityStore`），再用 adb 启动 App 观察；
3. 用第二台模拟器实例（干净数据）跑矩阵。

第 3–6 项都依赖这一步先完成。

**已解决（2026-10-15，路线 3）**：在实例 2 上带 `pairIntoRealStorage=true` 一次跑通，真实 App 已连上隔离测试台并发出模型读取（第 17 批有证据）。矩阵本身仍未跑，但前置条件已经不需要用户授权就能满足。

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

未交付：其余写入点（传输/审批/恢复/供应商切换）、跨设备读取协议（`agent.state.request` 的 records 域）。

## 第 13 批（issue #9 第二刀：记录落盘）

已交付：

- [diagnostic-journal-file-store.ts](../../packages/host/src/diagnostic-journal-file-store.ts)：一行一条 JSON 的 `diagnostics.ndjson`（状态目录内）。追加便宜，写一半被杀进程只留一行残句而不会毁掉整份文件；读盘时**坏行只丢那一行**；重写走临时文件 + 原子替换，替换失败会清掉临时文件。
- [diagnostic-journal.ts](../../packages/host/src/diagnostic-journal.ts) 增加持久化钩子（`load` / `append` / `rewrite`）：构造时读回上一次运行留下的记录，淘汰或按会话清理时**整体重写**盘上那份，其余情况只追加——盘上不会出现比内存更旧、更长的版本。
- 落盘是旁路：`load` / `append` / `rewrite` 失败都不冒泡，失败次数进 `stats().persistFailures`；读盘失败也不会让 Host 起不来。
- host-service 在构造函数里按状态目录建 journal，因此记录跨重启保留：重启后「上一轮为什么连不上」仍然读得到。
- 新增 8 条单测：重启读回、淘汰重写、按会话清理重写、落盘失败只记缺口、读盘失败不影响构造，以及文件层的往返、替换不留旧尾巴、残句与坏行只丢一行。

## 第 14 批（issue #9 第三刀：诊断目录上模型）

已交付：

- 协议 `HostDiagnosticsState`（`HostState.diagnostics`，模块 23 的读取侧）：当前窗口条数、被淘汰条数、落盘失败次数与窗口起止时点。**记录本身不进快照**——那是游标分页读的，塞进控制帧只会造出一份会过期的副本。
- `HostStateFacts.diagnostics()`：空 journal 是**事实**（这台电脑现在没有记录），所以 availability 是 `ready` 而不是 `unknown`；淘汰过或落盘失败过就是 `partial`，客户端据此知道手里那份不是全部历史。
- host-service 在三条时机刷新这份目录：进程启动（重启后立刻能看到上一轮留下的记录数）、每次 `recordDiagnostic`（记录与目录一起变）、每次读页（读取本身会触发淘汰）。
- 新增 11 条测试：目录写入与核对时点、空记录是 ready+complete、缺口即 partial、计数不变不推进版本，快照里按 `agent.state.request` 读得到（含 completeness 透传），以及真 HostService + 真状态目录的端到端——记一条即刷新目录、重启后仍报得出上一轮的条数。

协议版本不变：`HostState.diagnostics` 本来就在领域枚举里，`value` 对协议层是不透明的，没有新增消息类型。

## 第 15 批（issue #9 第四刀：记录的分页读取上协议）

已交付：

- 协议 `DiagnosticsRequestSchema` → `DiagnosticsPageMessageSchema`：请求带 `requestId`、不透明游标、`limit` 与类别/严重度/会话过滤，应答回带同一个 `requestId` 与一整页（含 `nextCursor` 与 `truncated`）。严重度枚举抽成 `DiagnosticSeveritySchema`，记录与请求共用一份，不各写一遍。
- Host 在设备载荷分派里同步应答：读的是内存 + 盘上那份，不查后端；读页本身会触发淘汰，因此顺手把 `HostState.diagnostics` 目录对齐（第 14 批的投影）。
- [diagnostic-page-message.ts](../../packages/host/src/diagnostic-page-message.ts)：把「读出来的一页」包成线上消息的纯函数，于是游标、缺口与协议版本都能单独断言，不必为验证一个字段形状去起一台设备。
- 新增 5 条测试：请求/应答严格 schema 与 `limit` 边界、记录不许出现自由字段（塞正文即被拒），以及构造出的消息必须能过协议联合体本身（只断言字段名会漏掉「发了但收不下」），空页与缺口标记照原样回带。

协议版本不变：这是**新增**消息类型，老客户端永远不会发它，现有消息的形状没有改动。

未交付：客户端（App / 桌面）实际消费这两条消息属于 issue #10；其余写入点（传输/审批/恢复/供应商切换）仍未接线。

## 第 16 批（issue #10 第一刀：App 消费统一模型）

已交付——Android 侧（`android/app/src/main/java/dev/pi/remote/`）：

- [AgentModelState.kt](../../android/app/src/main/java/dev/pi/remote/AgentModelState.kt)：`agent.state.snapshot` 的客户端表示，把三条纪律写进类型：**整份替换**（同一身份的重复读取顶掉旧的，不做字段级合并）、**缺席有原因**（`missing` 区分 `no_state` 与 `unknown_domain`，「领域表里没有它」不等于「它是空的」）、**截断如实说**（`truncated` 那份不能当基线）。领域缺 envelope 字段时**整份拒绝**并记错误——两端对协议理解不一致时，留半份模型比什么都不留更糟。
- `RemoteState` 新增 `agentStateSnapshots` / `agentStateRequests`；reducer 把 `agent.state.snapshot` 收进允许集合（此前未知类型会被当成「不支持的中继消息」直接弹错，所以这一步是消费的前提）。
- 连接建立后自动读一次 Host 作用域的 `diagnostics`（`refreshHostModel()`）：诊断目录是客户端**只能**由模型拿到的事实——条数、保留窗口与缺口，以前 App 无从判断自己看到的是不是全部。请求与应答走设备级 E2E 载荷，与 `session.list` 同一条密文通道。
- 10 条单测（`AgentModelStateTest`）：envelope 落库、缺席原因、截断标记、明确回错不当成空模型、坏消息整份拒绝、整份替换、协议版本不匹配仍被拒绝，以及状态页口径。
- **状态页可见**：状态页新增「电脑端诊断记录」一行（`diagnosticDirectoryView()`），把模型说的话翻成人话——「尚未读取」「电脑没有报这个领域」「读取失败」「2 条记录（已淘汰 1 条）」。有缺口就显示缺口，负载缺条数就明确报错，**不画成 0 条**；它与状态页原有的「原始事件」（本机日志）是两件事，标签上也分开。

验证：`scripts/windows/android-build.ps1 :app:testDebugUnitTest` = **46 类 / 411 项全过**；`:app:compileDebugAndroidTestKotlin` 通过（设备测试源集跟着新字段一起编译）。

未交付：`diagnostics.page` 的分页读取在 App 侧未接线（状态页只显示目录，不含记录本身）；其余领域（catalog / providers / workspaces…）仍走各自的老路径。

## 第 17 批（issue #11：验收矩阵的前置条件打通）

矩阵一直卡在同一件事上：设备端没有一台「连得上的 Host」。这一批把路线 3（第二台干净实例）跑通了。

**做成了什么**

- 实例 2（~Pi_Remote_API_35_2~ / ~emulator-5556~）按占用协议取用；本机 Relay 起在 8787，隔离 Host 用独立状态目录运行（LAN 42131，与用户 Host 的 42130 分开）。
- 配对测试带 ~pairIntoRealStorage=true~ 一次通过（25 秒，**没有**上一批那种 6 分钟挂起）：~com.orbising.orbis/files/hosts/pairings.json~ 里 ~activeHostId~ 就是隔离 Host（用 ~run-as~ 读盘核对过，不是只看测试结论）。
- 真实 App 连上了隔离 Host：App 侧 ~socket.connect relay=ws://10.0.2.2:8787~ → ~e2e.hs.confirmed hostId=8509e449…~ → ~in type=device.ready~；Host 侧收到该设备（~21a2547ae91d3a33…~）的 ~session.list~（169 条）。
- 顺带在真机上验证了第 16 批：App 收到 ~device.ready~ 之后自动发出 ~agent.state.request~（~out path=lan type=agent.state.request sent=true~）——模型读取在真 Host 面前确实会发出去。

**踩到的坑（下次别再踩）**

- ~applicationId = com.orbising.orbis~，而 ~namespace = dev.pi.remote~：模拟器上**同时装着**一个旧包 ~dev.pi.remote~。启动 ~dev.pi.remote~ 看到的是旧 App（停在配对页），从它查存储当然也查不到配对。**设备验证一律用 ~com.orbising.orbis~；~dev.pi.remote~ 是遗留包，未经授权不卸载。**
- 隔离测试台的 ~pair~ 与常驻 ~host~ 在同一状态目录里互斥：Host 活着时再开配对窗口会直接退出（~code=2~，错误日志写得很清楚）。要重新配对先 ~stop-isolated-host.ps1~。
- 资源占用要按顺序放：拿到 ~resource-operation~ 启模拟器后，模拟器开机完成就必须释放，否则下一次 Android 构建会一直等这个占用（实测卡了 8 分钟才反应过来）。

**这一批没有跑矩阵本身**：跑到这里可用内存降到 1.1 GB（低于 1.5 GB 红线），按 ~D:\android-emulators\README.md~ 停机收尾——模拟器已关、rig 与 Relay 已停、占用文件已释放，用户正在使用的 Host 全程未受影响。6 项验收仍是**未跑**，但现在每一项都具备了跑的条件。

## 第 18 批（issue #9/#10：记录的分页读取到客户端）

已交付——Android 侧：

- ~diagnostics.request~ → ~diagnostics.page~ 在 App 侧接通：状态页「读取记录」按钮发一页请求（~limit=50~），请求带时间戳，超过 15 秒没回来就显示「上次读取没有回音」，而不是永远转圈。
- 受理纪律与快照一致：**只接受自己那次请求的应答**（并发或迟到的页会把现场搅乱），记录缺一个字段就**整页拒绝**并显示「读取失败」，不留半页看着像真的记录。
- 状态页显示「最近一条」（Host 的页从最旧一条开始给，所以最近的是列表末尾那条），并带上「还有更早的」「有缺口」两种注记；色调跟那条记录的严重度走。
- 5 条新单测（共 15 条）：页落库与销账、非本次请求的应答丢弃、缺字段整页拒绝、界面口径（读取中 / 没有回音 / 最近一条带注记）、空页如实说空。

验证：~scripts/windows/android-build.ps1 :app:testDebugUnitTest~ = **46 类 / 416 项全过**。

未交付：界面上没有「继续读更早的页」（~nextCursor~ 已经存下来了，但没有按钮）；记录只显示最近一条，没有列表视图。

## 第 19 批（issue #11 验收矩阵第 2 项：Host 重建）——**已跑，通过**

怎么跑：实例 2 + 隔离测试台（状态目录不变，hostId 不变、模型代次与来源代次换代）；App 用第 17 批那套真实配对启动并连上，然后**停掉再起**隔离 Host，全程不碰 App。

观察到的（App 侧 ~PiRemote.ReloadTrace~，Host 侧 ~host.out.log~，两边 requestId 对得上）：

| 步骤 | 证据 |
| --- | --- |
| 重连 | ~out path=relay type=device.pathPreference~ → ~path.announced path=lan~（Host 侧：~路径 中继 → LAN 直连~） |
| 重新握手 | ~e2e.hs.confirmed hostId=8509e449…~（同一 hostId，宿主进程换了，PID 8992 → 10096） |
| 重建目录 | ~out path=lan type=session.list requestId=405d5124-…~；Host 侧同一 requestId：~收到 session.list（requestId=405d5124-…）~ |
| **重新读模型** | ~out path=lan type=agent.state.request requestId=ca7a5dee-…~——换代次后 App 重新读，而不是继续拿旧代次的事实当已确认 |

证据落在 ~D:\android-emulators\evidence\emulator-5556\<owner>\~：~item2-app-logcat.txt~、~item2-host-after-restart.log~、~item2-before-restart.png~、~item2-after-restart.png~（~<owner>~ = ~0a3671bd-3e20-42ed-8402-6af8f53a2953~）。

**这一项验到哪儿**：验的是「Host 换代次后 App 会重建连接与目录、并重新读取模型」。矩阵里「旧代次的迟到回调被丢弃、不冒充新代次已确认事实」的那一半属于 Registry 的写者纪律，由 ~agent-state-registry~ 的单测覆盖，**这次没有在设备上单独构造迟到回调**。

**顺带记两条操作坑**：

- 装完 App 直接启动会被系统的权限对话框挡住（~GrantPermissionsActivity~ 是 top-most，~pidof~ 为空，看着像「启动失败」）。跑设备验证前先 ~pm grant com.orbising.orbis android.permission.POST_NOTIFICATIONS~（相机同理），或用 UI 点掉。
- 内存到 0.9 GB 时按红线停机：模拟器已关、rig 与 Relay 已停、占用已释放、用户 Host 未受影响。

## 第 20 批（issue #11：让测试台只服务合成会话）

第 3 项（断线重连）第一次尝试时卡在一个安全问题上：测试台上唯一可打开的会话是**用户正在用的那个**（Host 扫真实会话目录，164 条全在列表里）。拿它做断线实验会和用户自己的进程抢同一份会话文件。

这一批把根因去掉：

- ~packages/host/src/cli.ts~ 暴露 ~--sessions-root <路径>~：host 子命令只扫这个目录下的 Pi 会话（默认仍是 ~~/.pi/agent/sessions~）。Host 早就有这个选项，只是一直没有出口。
- ~start-isolated-host.ps1 -ScratchSessions~：把 Pi 会话根指到 ~<rig>\sessions~，并在那里种一个合成会话（首行是会话头 ~{type,id,cwd,name}~）；输出里写明这次是「仅合成会话」还是「真实会话」。

实测（不需要模拟器）：~-ScratchSessions~ 启动的 rig Host 命令行确实是 ~host --state-dir … --sessions-root D:\orbis\.scratch\isolated-host\sessions~；直接调 ~listPiSessions~ 得到**合成 1 条**（~matrix-session @ <rig>\workspace~），而真实根目录是 **164 条**——隔离生效，不是「看起来生效」。

**这一批没有跑第 3 项**：合成会话目前只有会话头，够 App 列出与打开，但还没有历史内容；要跑「按 source epoch/seq 续传」还得先给它补真实形状的消息行，或者在 rig 里新建一个会话。第 3 项仍然记为未跑，但它不再有「会碰到用户会话」的风险。

## 第 21 批（issue #11：矩阵运行手册与第 3 项的真实前置）

第 3 项第二次尝试时搞清楚了一件关键事实：**Pi 的会话历史来自运行中的 Pi**（扩展走 loopback 送出条目），会话文件本身不是 Host 的历史来源。所以「种一个合成会话文件」只能让 App 把它列出来、选中它，**看不到任何聊天记录**——第 20 批的合成会话到此为止。

要跑第 3/4/5 项，必须有一个**活着的、不属于用户的会话**，两条路（都写进了测试台说明书）：

1. 在 App 里于 `<rig>\workspace` 新建会话：Host 拉起真 Pi，产出真会话文件与真运行时；代价是多一个真 agent 进程，且用用户的 Pi 配置。
2. 用夹具 Host（`scripts/session-sync-fixture.mjs`）：按线上协议发合成会话，App 侧走真加密链路 + 真 SQLite；适合验 App 的显示与恢复语义，不适合验 Host 侧的重建/续传。

**矩阵运行手册**（每次照这个顺序，收尾同序）：

| 项 | 前置 | 现在能不能跑 |
| --- | --- | --- |
| 1 版本不匹配 | 需要一个用升版前 `dcafa43`（协议 12）构建的 APK | 不能：要从旧提交构建，动代码版本前需单独确认 |
| 2 Host 重建 | 配对好的 rig + App | **已跑，通过**（第 19 批） |
| 3 断线重连 | 一个活着的会话 | 不能：缺活会话（见上） |
| 4 历史改写 | 一个活着的会话 + 能触发压缩/回退 | 不能：同上 |
| 5 设备重开 | 先打开过会话（缓存才落盘） | 不能：同上 |
| 6 多 Host 隔离 | 两台可达 Host（用两台 rig，不必碰用户 Host） | **已跑（部分）**：第 22 批；余下只差「通知关闭」的跨台验证 |

每次的设备侧前置（也写进了说明书）：占用协议 → 本机 Relay → 实例 2 → `start-isolated-host.ps1 -ScratchSessions` → 启动 App 前先 `pm grant com.orbising.orbis android.permission.POST_NOTIFICATIONS`（否则权限对话框挡住启动，看着像启动失败）→ 确认 `e2e.hs.confirmed` + `device.ready`。

**这一批没有跑任何矩阵项**：写清楚「哪一项为什么现在跑不了」，比再跑一次第 2 项更有用。下一批按手册从第 6 项（多 Host 隔离）开始。

## 第 22 批（issue #11 验收矩阵第 6 项：多 Host 隔离）——**已跑（部分），通过**

做法：**两台隔离 rig**（不碰用户 Host）——A：~8509e449-…~，LAN 42131；B：~c33605a1-…~，LAN 42132，各自己的状态目录与会话源，共用本机 Relay。App 先与 A 配对（第 17 批），这一批再用配对测试把 B 也写进真实存储（57 秒通过），然后同时连两台。

观察到的：

| 看什么 | 证据 |
| --- | --- |
| 两条独立连接 | App 日志两条 ~socket.connect~、两条 ~e2e.hs.confirmed~，hostId 分别是 ~c33605a1-…~ 与 ~8509e449-…~；两条 ~device.ready~ |
| 设备身份按 Host 分开 | 同一台手机在 A 是设备 ~21a2547ae91d3a33…~，在 B 是 ~c31d22a4678b9229…~——各 Host 有自己的设备记录，不共用身份 |
| 目录不串台 | A 只服务自己的合成会话；B 日志 ~回 session.list.result：1 条~（它自己的那条），没有出现对方的会话 |
| 模型读取按 Host 分开 | ~agent.state.request~ 分别发往两台（LAN 与中继两条路径都出现过） |

证据：~D:\android-emulators\evidence\emulator-5556\<owner>\item6-*~（App 日志、A/B 两台 Host 日志、截图）。

**这一项验到哪儿**：验的是「同时连两台时，配对、设备身份与目录各自独立、不串台」。矩阵里写的「通知关闭」没有单独构造（那需要在一台上产生通知并在另一台上验证收不到）——**仍未覆盖**，不当作已通过。

收尾：两台 rig、Relay、模拟器全部停掉，占用释放；内存 1.4 GB 时按红线停机。

## 第 23 批（issue #10：App 消费第二个领域——目录完整性）

已交付——Android 侧：

- App 读 Host 作用域快照时同时点名 ~catalog~（~refreshHostModel~ 默认领域从 ~[diagnostics]~ 变成 ~[diagnostics, catalog]~）。
- [AgentModelState.kt](../../android/app/src/main/java/dev/pi/remote/AgentModelState.kt) 解析 ~HostCatalogState~（~totalSessions~ / ~truncated~ / 逐后端 ~ready~ / ~sessions~ / ~complete~ / ~error~），并把它翻成界面口径。
- 状态页新增「电脑端会话目录」：读全时是「N 个会话（M 个后端都读全）」，有缺口时是「N 个会话（部分）」并把**是哪个后端、为什么**写在说明里（读取失败 / 未就绪 / 没读全 / 被上限截断）。缺字段、负载不是对象、领域缺席都明确报错——不把「没读到」画成「完整」。
- 这一行回答的是会话列表本身答不出的问题：App 以前**无法知道自己看到的目录是不是读全了**。
- 3 条新单测（共 18 条）：读全、部分（含未就绪与截断两种原因）、还没读到/坏负载。

验证：~scripts/windows/android-build.ps1 :app:testDebugUnitTest~ = **46 类 / 419 项全过**。

未交付：目录里逐后端的会话明细仍走 ~session.list.result~（模型只提供完整性摘要）；说明行的文案没有本地化变体。

## 第 24 批（issue #8：切换进行中的事实）

已交付：

- ~providerSwitchingFact(changingKind, kind)~（[host-state-facts.ts](../../packages/host/src/host-state-facts.ts)）：**只有 Host 自己发起的切换**才是已知事实——正在切换的那个后端记 ~true~，其余记 ~null~（未核对）而不是 ~false~。理由是桌面端可以在带外改配置，「现在没在切换」并不等于「没有切换」。
- 接到 ~session.list~ 那次投影写入（与「当前 provider」同一份事实、同一次读取）：客户端因此知道进行中时路由结论还不作数。
- 1 条单测：匹配的后端是 true，其他（含没有切换）是 null。

验证：~npm run check~ = **107 文件 / 1093 测试全过**。

未交付（模块 20–22 剩下的）：profile 清单与认证绑定仍没有可信来源接进来——~provider.list~ 那次读取确实拿得到（~id/name/enabled/globalDefault~），但 ~session.list~ 会把它覆盖成 ~null~，要接必须先定「最后已知值」的口径与失效时机，这是个设计决定，没有替用户拍板。用量/健康度同理。

## 第 25 批（修第 18 批自己的方向性错误：游标是朝**更新**走的）

第 18 批（~d06a182~）把 ~nextCursor~ 说成「还有更早的」，状态页那行也叫「最近一条」。**都是反的。**

Host 的 ~DiagnosticJournal.page()~ 从保留窗口里**最旧**一条开始、朝**更新**方向取 ~limit~ 条，~nextCursor~ 指向「比这一页更新的还没读的那些」，为 null 才是追平最新（单测 ~按游标分页读完整个保留窗口~ 本来就是这么断言的，我没照着读）。于是界面上出现两处错话：

- 「还有更早的」应为「还有更新的没读」——把没读的方向说反了；
- 「最近一条」在第一页时根本不成立，它只是**这一页里最新的一条**。

已修：

- App：[AgentModelState.kt](../../android/app/src/main/java/dev/pi/remote/AgentModelState.kt) 的注记改成「还有更新的没读」，KDoc 写清方向；状态页标签改成「最近读到的」，并在只有第一页时不假装那是最近。
- Host：[diagnostic-journal.ts](../../packages/host/src/diagnostic-journal.ts) 的 ~page()~ 注释明确写下**方向**，避免以后有人把它「修」成倒序；新增 1 条单测把方向钉死（m0,m1 → m2 → 追平）。

验证：~npm run check~ = **107 文件 / 1094 测试全过**；~:app:testDebugUnitTest~ = **46 类 / 419 项全过**。

**顺带**：既然第一页是最旧的，App 首次请求改为取满一页（`limit: 500`，Host 的上限），窗口不大时一次就追平最新；追不平仍由界面如实说「还有更新的没读」。

**教训**：消费方（App）的文案必须照着产出方（Host）已写下来的语义抄，而不是照着自己对「诊断日志」的直觉猜——这次的错话本来会被一整条链路原样带到用户面前。

## 第 26 批（issue #10：App 消费第三个领域——供应商切换状态）

已交付——Android 侧：

- 解析 ~HostState.providers~ 的公共摘要（~agentKind~ / ~current~ / ~switching~ / 用量是否 unknown），状态页新增「电脑端供应商」一节：切换状态 + 当前供应商（~codex: custom、dsh: deepseek~）。
- 这一格补的是手机**看不见的那种切换**：手机只知道「我自己发起的那次」，桌面端带外改配置只有 Host 模型知道。
- 文案按事实说：~switching == null~ 是未核对，所以写「**Host 未报告进行中的切换**」——陈述它报了什么，而不是替它断言「现在没有切换」；~true~ 时写「正在切换：codex」。领域缺席、空清单、坏负载、未核对都各有明确说法，不混成一个「无」。
- 4 条新单测（共 422 项）：未报告（含当前供应商明细）、正在切换、缺席与坏负载、空清单与未核对两种不一样的说法。

验证：~scripts/windows/android-build.ps1 :app:testDebugUnitTest~ = **46 类 / 422 项全过**。

未交付：~profiles~/~authenticated~ 仍按第 24 批的结论空着（等口径决定）；用量/健康度在模型里仍是 ~unknown~。

## 第 27 批（issue #9：供应商切换失败写入诊断）

已交付：

- ~HostService.changeProvider~ 的失败分支写入一条诊断记录（~category=provider~、~severity=error~、消息「切换/保存 <kind> 供应商失败」、~detail.reason~ 是错误摘要）。**配置内容与凭据永远不进记录**——记录会被设备读出去。
- 这条写在 ~changeProvider~ 里而不是各调用点：切换与保存、设备发起与后续调用都走这条路，漏一条就少一段现场。
- 1 条新单测（共 3 条）：切换失败既要把错误抛给调用方（业务照旧失败），又要留下记录，同时目录投影的条数跟着更新。

验证：~npm run check~ = **107 文件 / 1095 测试全过**。

写点盘点（模块 23）：已有的四条是目录逐后端拉取失败、读取当前 provider 失败、供应商切换/保存失败，加上进程启动时对齐的目录投影；仍缺的是传输/审批/恢复这几条路径——它们要么埋在内部分支里，要么需要先有可触发的失败钩子。

## 第 28 批（修一处自找的写者冲突：~HostState.providers~ 只留一个写者）

**问题**（由用户追问「为什么一个读取请求要改写 Host 的内容」暴露）：~session.list~ 那条路径为了让模型里的「当前 provider」保持新鲜，顺手把整个 ~HostState.providers~ 写了一遍；它只认识 ~current~ 一栏，而领域写入是**整值替换**，于是把真正读过清单的那条路径写下的 ~profiles~ / ~authenticated~ 冲成了 ~null~。而 ~provider.list~/~provider.switch~ 那条路径**一次都没写过模型**——认识事实的不写，写的不认识，这就是「切完供应商手机看不到新清单」的根因。

已改：

- **~session.list~ 不再写 ~HostState.providers~**。它给手机的返回值（~currentProviders~）不变，那条诊断写入点（读 ~currentProvider~ 失败）也保留。
- 新增 ~HostService.refreshProviderFacts()~：**唯一**写这个领域的地方，按 pi/codex/dsh 逐个现读 ~ProviderManager.list(kind)~，写完整摘要（~current~ = 列表里 ~enabled~ 的那个、~profiles~ 是真读到的清单、~switching~ 沿用第 24 批的事实；~authenticated~ 这次读取里没有依据，仍记 ~null~）。某个后端读不到就**那一格记 ~null~ 并留诊断**，不拿上一次的清单冒充这次读到。
- 触发时机两处：供应商读取/切换成功之后；以及 ~agent.state.request~ **点名 ~providers~ 域**时先现读再答（谁要看谁付这次读取的钱）。分派因此改成异步，与 ~session.list~ 一样不阻塞帧处理循环。
- App 侧跟着点名 ~providers~（~refreshHostModel~ 的默认领域加上它）——不点名就会读到「清单里没有这个领域」，这正是这一批要避免的那种「模型说没读过、界面说没有」。

验证：~npm run check~ = **107 文件 / 1097 测试全过**（新增 2 条：没人读时模型里没有这一格、读不到时记 null 并留诊断）；~:app:testDebugUnitTest~ = 46 类 / 422 项全过。

**没动的**：~ProviderManager.list()~ 仍然是「读-改-写」（抢锁 + 对账原生配置 + 原子写盘）。那是有意的设计——原生配置永远有第二个写者（用户手改、桌面端），报清单前必须对账，否则 ~enabled~ 是猜的。要不要把它拆成纯读 + 如实报差异，是另一件事，记在这里备查。

## 第 29 批（issue #10：App 显示可选供应商清单）

接第 28 批：~profiles~ 现在是「真读到的清单」了，App 把它显示出来。

- 状态页「电脑端供应商」新增一行「可选供应商」：~codex: 2 个可选、dsh: 0 个可选~。
- 关键区分：~profiles == null~ 是**这次读取没拿到清单**，空数组是**读了、就是一个可选都没有**——两者文案不同（「清单未读到」vs「0 个可选」），不合并成一个「没有」。
- 2 条新单测：没拿到清单时说「未读到」、拿到清单时说个数（含空数组那一档）。

验证：~:app:testDebugUnitTest~ = **46 类 / 423 项全过**。

至此模块 20–22 的手机摘要里 ~current~ / ~profiles~ / ~switching~ 三格都有真实来源；~authenticated~ 与用量仍是 ~null~/~unknown~——前者要 profile 的 ~authBinding~ 与账号列表，后者要供应商自己报配额，都不在 ~ProviderManager.list()~ 的返回值里。

## 第 30 批（issue #11 矩阵第 5 项：先写测试，**尚未在设备上跑**）

已交付：在既有的设备测试 [SessionGraphStoreInstrumentedTest.kt](../../android/app/src/androidTest/java/dev/pi/remote/SessionGraphStoreInstrumentedTest.kt) 里加了 ~entriesAndDisplayRowsComeBackFromDiskOnAFreshStore~：

- 用夹具条目 + 夹具显示投影写进真 SQLite（同一批），关掉 store；
- 用**新的 store 实例**从同一个目录读回来，断言条目顺序、显示行集合（每个条目都有对应显示行）、~displayWindowStart~ 与 ~displayVersion~ 都还在。

验证：~pwsh -File scripts/windows/android-build.ps1 :app:compileDebugAndroidTestKotlin~ 通过（**只编译，没跑**）。

**已在设备上跑过（第 31 批）**：`emulator-5556`，`Starting 1 tests … Finished 1 tests … BUILD SUCCESSFUL in 24s`，结果 XML：`tests=1 failures=0 errors=0 skipped=0 time=1.182`；证据存在 `D:\android-emulators\evidence\emulator-5556\<owner>\item5-store-restore.xml`。

**诚实的边界仍然成立**：跑的是「同进程内重开 store」，不是真杀进程重启。矩阵第 5 项因此记**落盘侧已跑、通过**，进程级重启（杀 App 再打开、从 SQLite 恢复并渲染）仍未跑。

## 第 31 批（矩阵第 5 项：落盘侧在设备上跑过，通过）

第 30 批写的用例在 ~emulator-5556~ 上跑通了：`Starting 1 tests … Finished 1 tests … BUILD SUCCESSFUL in 24s`，结果 XML ~tests=1 failures=0 errors=0 skipped=0 time=1.182~。

它验的：条目与显示投影**同一批**写进真 SQLite，关掉 store，再用**新实例**从同一目录读回来——条目顺序、显示行集合（每个条目都有对应显示行）、~displayWindowStart~、~displayVersion~ 全部还在。也就是「内容来自盘上那份」。

**仍未覆盖**：真杀进程重启（App 冷启动后从 SQLite 恢复并渲染、标题/树标签一致）。第 5 项因此记「落盘侧已跑」，不记通过。

过程中的两个坑：第一次 ~connectedDebugAndroidTest~ 跑完没有任何结果 XML（UTP 日志是空的），重跑一次就好了——**结果目录里没有 TEST-*.xml 就是没跑成，不要当成通过**；另外跑到后半段可用内存掉到 0.5 GB，按红线立即取证停机。

## 回归要求

改动 Registry 或 envelope 时必须保持：

- 未校验来源、部分清单、过期结果都不能删除有效状态；`unknown` / `unavailable` 是显式状态。
- 心跳、历史页请求与其他设备回执不推进源端内容版本。
- 提交路径里不发起原生 RPC、文件 IO 或网络探测。
- Registry 不保存全量聊天历史。
