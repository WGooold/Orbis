# ADR-0032：Host 统一管理完整 Agent 状态模型

日期：2026-10-13

2026-10-27：[ADR-0045](0045-tool-summaries-and-on-demand-content.md) 调整工具域载荷：Registry 保存库存描述符、标准摘要和内容引用；完整工具参数与输出在 producer/原生来源，按设备私有范围读取，不内联在共享 Agent 状态中。Host 仍为统一入口，App 使用通用投影。

Status: accepted（架构决定已确认；实现与运行环境迁移尚未完成）

关联：[ADR-0019](0019-host-provider-management.md)、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0027](0027-source-owned-runtime-diagnostics.md)、[ADR-0028](0028-host-notification-lifecycle.md)、[ADR-0029](0029-session-read-operation-state-machine.md)、[ADR-0030](0030-multi-host-mobile-connections.md)、[ADR-0031](0031-host-permission-management.md)、[ADR-0008](0008-drop-backward-compatibility.md)。

审计依据：[状态与架构报告](../architecture/agent-state-architecture.html)、[36 个状态模块清单](../architecture/agent-state-audit.json)。报告记录的是本决定之前的工作树现状，目标图是本决定的设计参考，不代表代码已迁移。

验收登记：[Agent 状态模型验收清单](../architecture/agent-state-acceptance.md)——36 个模块的模型归属、作用域与迁移状态，随实施更新。

## Context

当前 Pi、Codex 和 DeepSeek Harness 已接入统一的 AgentBackend 端口与部分协议。Codex 具有终端和桌面两路接入，因此当前 agentKind 为 pi、codex、codexDesktop、dsh。

统一端口尚未形成统一状态管理：

- 聊天 head、live 消息、工具和回合由各 source adapter 持有；Host 通用层主要关联请求、拼装目录并转发事件。
- 运行、重试、压缩、队列、交互、模型、上下文和能力分散在后端库存、元数据和 App reducer 中。共同事件结构不保证完整当前状态可以重取。
- 通知已有 Host NotificationStore，权限已有通用展示和更新契约；这些已完成的子域应纳入同一逻辑模型。
- 供应商完整配置由 Host 管理，手机有简化列表和切换；用量、健康度、路由与认证摘要尚未形成共同的可同步状态。
- 诊断记录分散在 Pi 本地日志与 Host 桌面日志中，缺少统一记录范围、游标和 App 恢复入口。
- App 仍解释 Pi 消息形状、压缩节点和部分后端身份，并处理旧消息/回合/工具生命周期分支。新增后端或修正原生语义仍可能要求修改手机业务代码。

用户确认目标为：多个 Agent 后端统一到一套 Agent 模型，由 Host 管理模型，App 同步 Host 模型状态。需要统一的领域必须全部纳入，而不是只收口通知或增加一层事件转发包装。

## Decision

### 1. Host 模型是 Orbis 客户端的统一状态入口

Host 建立 AgentStateRegistry，保存和管理全部已接入会话的标准化当前投影。App 和 Host 桌面客户端通过同一模型读取领域状态；桌面额外权限由视图权限决定，不建立另一套状态事实。

一个 AgentState 表示一个后端会话的逻辑状态实例，一套 schema 支持多个实例和多个后端。身份、目录、聊天、实时内容、执行、队列、交互、权限、模型、上下文、能力、供应商绑定、产物与记录均在模型内有明确位置。共享的供应商、工作区和 Host 操作可以引用 HostState 子域；通过引用能够按统一读取契约取得相应状态。

“纳入 Host 模型”必须同时满足：

1. 有标准化、带作用域和可用性声明的领域契约。
2. Host 有该领域的当前投影及唯一写入归属，能够读取、核对和重建；当前状态不能仅存在于一次转发事件中。
3. 首次连接、重连、前台核对及明确重试均能取得基线，变更通过版本化更新同步。
4. App 展示和操作依据来自这个模型，不另从原生事件、日志文字或后端专属分支推导同一业务事实。

仅把 backend 对象挂在 Registry、查询时原样转发 native payload、统一事件名字，或在 App 增加一份平行 AgentState，都不满足本决定。

### 2. 原生权威、适配归一和 Host 管理分层

| 层 | 责任与权威 |
| --- | --- |
| 原生 Agent | 执行会话、工具与队列，保存原生持久历史，确认模型、权限、审批及实际操作结果 |
| Agent backend / Pi 扩展 | 读取原生事实，确认身份、语义和完整性，输出标准化库存、变更及历史显示投影；保留断线恢复所需 source 状态 |
| Host AgentStateRegistry | 验证来源，事务接收标准事实，保存有界当前投影，关联共享服务与设备视图，发布状态、范围读取和恢复基线 |
| Host 领域服务 | 管理通知生命周期、供应商配置与用量/健康度、工作区、文件、操作与诊断记录；作为 HostState 子域接入同一模型入口 |
| App / 桌面 UI | 镜像已接受状态，提交显式操作，处理缓存、输入和展示；不解释后端原生业务语义 |
| Relay | 转发既有端到端加密 Envelope，不拥有 Agent 模型或解密其内容 |

Host 统一管理投影，不接管原生执行器。Pi extension/runtime bridge 的 source 仍须在 Pi→Host 断线期间保存可恢复状态；不能因 Host 增加 Registry 而删除它。Codex/DSH 的 adapter 即使在 Host 进程中，也通过同一事实接入边界写模型。

原生事件名、stopReason、compaction、revert、fork、审批设置和错误恢复规则由适配层解释。Host 通用管理层不按 agentKind 或错误文字硬编码这些规则；App 只对统一 schema 做通用显示投影。

### 3. 模型层级与身份

以下名称定义职责与逻辑结构；最终线上消息命名和序列化格式在协议实施阶段确定，不能据此声称已有对应接口。

~~~text
HostState
├─ identity / devices / connections / management
├─ backends / catalog
├─ providers
│  ├─ private configuration / credentials / authentication
│  └─ publicSummary / usage / health / routing
├─ workspaces / files / operations / diagnostics
└─ agents[agentKey]: AgentState
   ├─ identity / availability
   ├─ history { source, head, ranges, displayEntriesRef }
   ├─ live { messages, tools }
   ├─ execution { phase, turn, timing, waiting, retry, compaction }
   ├─ delivery { queue }
   ├─ interactions / permissions
   ├─ model / context / capabilities / resources
   ├─ notifications
   ├─ providerBinding / workspaceRef
   └─ artifacts / recordsRef

DeviceView[deviceId]
├─ notification dismissal / private command receipts
└─ device operations / transfer projection

AppLocalState
├─ pairings / activeHost / selection
├─ mirror / cache / applied versions / read operations
├─ outbox / local transfer files and schedulers
├─ transport { socket, path, handshake, e2eReady, replay watermark }
└─ drafts / aliases / viewport / preferences
~~~

Agent 身份包含 hostId、agentKind、sessionId。runtimeId 是可更换的在线路由身份，不能代替会话身份；无在线 runtime 的历史会话仍能在 catalog/history 中查询。会话未创建时，启动操作属于 HostState.operations，不生成工作目录占位会话。

Codex 终端和桌面接入可能指向同一原生 Session，adapter 和 Host 必须明确原生会话引用、接入归属与去重规则；不能让两个来源竞争写同一库存，也不能依靠 App 从 runtimeId 前缀判断归属。

设备操作身份包含 hostId、deviceId、operationId。缓存、下载任务、记录游标、目录项和异步结果均保留 Host 作用域；两台 Host 的同名 Session、runtime 或文件不会共享任务键、部分文件或覆盖彼此投影。

### 4. 必须统一的全部领域

下表对应审计清单中的 01–24 模块。已符合的子契约也纳入模型；尚不支持的能力必须明确不可用或未知，不能省略模块后宣称覆盖完成。

| 审计模块 | Host 模型归属 | 必须保存或可统一读取的状态 |
| --- | --- | --- |
| 01 身份与元数据 | AgentState.identity / availability | hostId、agentKind、sessionId、runtime 绑定、名称、工作目录、主机及来源身份；路由改变不改写会话身份 |
| 02 后端可用性 | HostState.backends；AgentState.availability | ready、launchable、接入状态和原因、来源连接与核对状态；电脑安装/版本摘要通过 management 引用 |
| 03 目录与归档 | HostState.catalog | 会话摘要、归档、历史 provider 归属；按后端记录目录版本、读取结果和覆盖完整性，失败不当作完整空目录 |
| 04 聊天历史 | AgentState.history | canonical 身份与 parent 链、来源版本、标准 displayEntries、分页范围/游标和覆盖事实；历史更正受版本门槛约束 |
| 05 分支与 head | AgentState.history | 当前 head、完整性、分支/范围身份与后端支持的导航或派生操作；Git 分支另属 workspace |
| 06 实时消息 | AgentState.live.messages | 完整累计正文、角色/内容块、finished、contentComplete、canonical 映射及完整库存；结束但未持久化的消息仍可恢复 |
| 07 回合与计时 | AgentState.execution.turn / timing | 回合身份、开始时间、已确认结束/耗时及对应消息；设备计算展示 elapsed 不改变事实 |
| 08 工具 | AgentState.live.tools；history 引用 | 调用身份、所属回合/消息、输入、部分输出、结果、执行阶段与失败；结果提交与 live 移除一致 |
| 09 运行与等待 | AgentState.execution | idle/running/waiting 等共同阶段、等待原因与请求引用、来源确认状态；DSH 审批等待必须接入 |
| 10 重试与压缩 | AgentState.execution.retry / compaction | 是否支持、当前阶段、所属回合/操作、已知尝试/恢复/失败事实；不以日志文案或普通 idle 推断恢复 |
| 11 交互与审批 | AgentState.interactions | 完整可回答请求库存、类型/问题/选项、期限、阻塞性、状态及明确结束；回答提交反馈属于 DeviceView |
| 12 消息队列 | AgentState.delivery.queue | 操作身份、steer/followUp、权威投递状态、取消能力和结果；队列执行仍由原生后端负责 |
| 13 命令与操作回执 | HostState.operations / DeviceView | 已接受、执行、取消、成功、失败、结果未知及回执保留范围；共享操作与设备私有结果分开 |
| 14 权限 | AgentState.permissions | 复用 permissionManagement 摘要、opaque 设置/选项、不可用原因、确认版本；诊断 raw 权限保留电脑侧适当视图 |
| 15 模型与思考级别 | AgentState.model | 当前实际模型/provider、显示名、thinking/effort、支持选项与变更状态；选项不能仅藏在 Slash 菜单中 |
| 16 上下文与 tokens | AgentState.context | 当前占用、窗口、百分比、来源与未知状态；与累计账单用量区分，DSH 缺事实时明确 unknown |
| 17 能力与资源 | AgentState.capabilities / resources | 支持操作、参数/选项、不可用原因，已加载或可用 skills/prompts/MCP/扩展及可核对状态；后端差异由能力表达 |
| 18 通知来源 | adapter 事实接口；AgentState.notifications | 来源代次/版本、库存完整性、条件和一次结果；来源恢复语义由 adapter 确认 |
| 19 通知投影 | AgentState.notifications / DeviceView | 复用 NotificationStore 身份、版本、期限、核对状态、移除与设备关闭；不新建平行通知权威 |
| 20 手机供应商摘要 | HostState.providers.publicSummary | 已保存 id、名称、enabled、mode、默认标记、选择/变更状态；增加可重取的领域版本 |
| 21 配置与认证绑定 | HostState.providers.private；公开认证摘要 | 配置、journal、绑定、认证状态和变更结果；AgentState.providerBinding 引用实际绑定，秘密不跨到 App |
| 22 用量、健康度与路由 | HostState.providers.usage / health / routing | 用量结果/更新时间/查询错误、健康事实/探测时间、circuit 与 failover、实际 route/provider、进行中请求绑定 |
| 23 实时诊断记录 | HostState.diagnostics；AgentState.recordsRef | 标准记录、作用域、来源、级别、时间、记录身份、持久范围、游标/缺口、保留策略和读取状态 |
| 24 产物与附件 | AgentState.artifacts；HostState.files | 文件身份、元数据、来源消息/工具引用和可用性；路径附件输入与下载任务不伪装成已完成产物 |

目录、实时库存、运行、交互、队列、模型、权限和能力均必须能取得 Host 的当前基线。无变化核对仍验证来源有效性；只是打开页面或收到一条 metadata 不构成完整基线。

### 5. 聊天显示归一与有界历史

adapter 将原生历史解释为共同 displayEntries，明确消息角色、内容块、工具关联、摘要、失败和显示属性。原生 Entry 的 ID、parent、type、数据引用与版本仍保留供树结构、缓存和诊断使用；手机不再解释 Pi compaction、firstKeptEntryId、native stopReason 或原生 tool-call 形状。

显示投影与 canonical 范围绑定同一已验证来源版本；投影算法或原生修正改变同 ID 表示时，必须明确失效/重建其显示缓存，不能用旧显示行否决来源。未知原生内容保留身份和可显示的通用占位/摘要或明确不可显示原因，不静默假报历史完整。

显示结果随 canonical 范围同行：提交批次与历史页各自携带**该范围**的显示行，客户端按 entryId 增量更新，不为显示多走一次往返。批次声明显示窗口起点（路径上比它更旧的条目已被历史改写覆盖）与逐条渲染锚点（窗口顶部／canonical 原位），因此「压缩裁到哪里、摘要排在哪」是产出方说出来的事实，客户端不必自己判断。路径不完整时不附带批次——半截的「完整样子」会覆盖客户端已有的正确内容，比不发更糟。

客户端只消费显示结果，不再解释原生形状：本地存储把条目与显示行放在同一笔事务里，提交后按同一份来源读回（来源修正条目时，被顶掉的那条显示行保留盘上原值）；投影版本变化即整段作废该会话的显示缓存，既不用旧表示继续渲染，也不用旧显示行否决来源。

Host 保存当前 head、可恢复 live、必要的最新历史范围/索引和有界显示页缓存。旧历史按统一范围入口读取，由 adapter 查询原生历史并归一，再由 Host 验证、纳入页缓存并返回。它们不是绕过模型的原生直通回复。

原生历史继续是持久权威；本决定不要求导入全部历史形成第二份永久 Host 聊天数据库。live、canonical 提交、映射和 head 仍按同一 source 事务更新。history/catchup 只补固定历史范围，不清 live、不移动当前 head，也不能删除页外数据。

### 6. 所有来源先写模型，再发布变化

Host 为每个领域建立明确的来源与单写者。适配器标准化 snapshot/transaction，Host 完成来源、身份、代次、版本、结构和预算校验后，原子提交当前投影，再通知订阅者。UI、异步回调与传输分发不能直接改领域状态。

完整库存与部分结果区别处理：只有同一有效来源、准确作用域的完整库存可以通过缺席删除；未知、不完整、超时和读取失败保留最后已知值并标明待核对。显式删除/结束事实也必须具备身份和版本，不能通配清空所有问题或所有请求。

影响多个相关域的原生事务作为一个 Host 模型提交，例如回合失败与重试解除、权限确认与命令成功、队列 delivered 与对应消息提交。来自独立来源的通知期限、供应商健康度等不能伪造为同一原生采集时点；模型通过依赖版本/引用和完整性声明避免混合展示矛盾状态。

单写者串行判定状态，不在锁内执行原生 RPC、文件 IO 或网络探测。读取按来源合并、使用协调代次过滤旧结果；背压、范围预算、库存上限和缓存淘汰条件必须在实现中显式配置并验证。

### 7. 按领域同步，同一模型入口

Host 模型具有认证生命周期的模型代次和聚合发布 revision；各领域保留自身版本与来源水位。模型代次不得复用通知协议中已有的 `hostEpoch` 字段名（它是 ADR-0028 的设备级通知代次），实施时使用独立名称，例如 `modelEpoch`。source epoch/seq、通知 hostEpoch/revision、模型代次/revision 与传输 sequence 的含义不合并，也不凭 Host 聚合版本宣布原生状态已确认。

App 可以订阅域集合、读取当前快照、按已应用版本核对及读取固定范围。首版可复用现有分域消息，但它们必须从已提交的 Host 模型产生；领域独立传输不等于存在第二套权威状态。

- 完整快照允许跳版本重建该域；增量必须匹配已应用 base revision，缺口恢复该域基线。
- 原生更正/source 重建需要来源握手；Host 重建需要认证确认新的模型代次（不与通知 hostEpoch 混用）；代次字符串不按大小比较，迟到旧响应不能切回旧代次。
- 版本只在实质状态/可用性变化时推进。心跳、历史页请求和其他设备回执不冒充源端内容变化。
- 多页或分块快照通过固定 snapshot 身份、捕获版本、范围与完整性关联；未完整接受前不宣布当前基线已应用。
- App 在 Entries 和显示页缓存事务成功后，才推进依赖它们的 head/live 和 applied 基线；缓存失败不能仅以 UI 收到消息声明成功。
- 通知独立恢复，聊天 unchanged 不代表通知/供应商/队列未变。某个领域失败不阻塞其他领域，也不清其已确认数据。

Host 是 App 的恢复入口。若当前投影足以恢复，直接返回；若来源未知或缺所需范围，Host 合并并调度 adapter 核对，保留 ADR-0026 的来源版本、条件响应选择和有界预算。App 不直接要求 native backend 修复业务状态。

### 8. 供应商、命令回执与记录的作用域

供应商 profile 为 Host 共享实体，AgentState 保存显式绑定与实际生效状态。Host 当前默认配置、Session 实际模型 provider、历史会话 provider 和 proxy 单请求 route 是不同事实，切换 profile 不回写旧会话/旧请求的实际 provider。进行中请求继续引用其开始时的不可变路由快照。

App 同步非秘密用量、健康度、认证摘要和路由摘要。凭据、OAuth token、原生配置原文、用量脚本及敏感请求头留 Host 私有管理；统一状态不授予手机新配置编辑、安装或进程管理权限。用量/健康来源不支持、尚未探测、失败保留旧结果均有明确状态和时间，不生成虚假余额或健康判断。

命令回执由 Host 管理设备归属、状态和有界查询窗口。确认丢失后可按原操作身份重取现存结果；窗口已过或来源不能证明时返回结果未知/已超保留范围，不能自动重发或承诺跨重启恰好执行一次。共享审批请求和队列事实可同步，发起设备的提交回执仍按 DeviceView 过滤。

诊断记录是追加数据，采用共同 recordId、producerEpoch、Host/Agent/operation/turn 作用域、时间、level、code 和有界内容。Host 接收经过脱敏/规范化的记录，按有界持久日志管理，并提供范围/游标读取；App 可同步记录目录、读取状态和按需页面。实时聊天仍由 live/history 描述，通知仍由生命周期库存描述，不复制为三套竞争状态。

记录来源断线、队列溢出、Host 重启或保留期淘汰造成不可恢复范围时，返回明确 cursor gap / truncated / unavailable，不能将 best-effort 日志伪装成完整审计链。日志不用于猜运行态、错误恢复或审批完成。存储/读取预算、保留策略和格式迁移属于实现验收项，不保留无限日志。

### 9. 重建、离线与 App 本地状态

模型统一不要求所有当前投影永久落盘。Host 重建时建立新代次，从原生来源和 Host 领域服务重建各域；尚未核对的值明确 unknown。通知继续按 ADR-0028 的有界内存与重播策略；不因新增持久诊断记录而持久重播已到期短暂 outcome。

Host 自有配置/身份沿用现有持久存储；历史页缓存可以淘汰重取；诊断记录在保留窗口内持久；命令回执按明确查询窗口保留。旧持久快照只能作为带来源的最后已知值，不能复活已结束交互、队列、运行态或旧权限。

网络 Path 离线与原生会话结束分开。手机断线不停止 Agent，也不解除通知；backend 暂断标记来源未知；确认 Session/接入结束才按作用域终结模型。重新接入绑定新代次，旧回调不能写新实例。

审计 25–30 对应的 workspace、激活、同步任务、配对/设备、桌面与安装属于 HostState 领域服务；Host 发布可读取摘要、领域版本与作用域，不塞入 Agent 执行状态。文件传输的 Host 任务及设备相关结果挂 HostState/DeviceView。

审计 29（连接、路径、加密与序号）是双侧状态，不是 Host 单方权威：Host 管理连接/路径公开摘要与传输 sequence，App 仍独立持有本端 socket、当前 Path、握手进度、e2eReady、会话密钥状态与重放水位，归属 AppLocalState.transport。Host 摘要不能替代本端握手判定，Relay 转发路径也不等于已确认的端到端可用。

审计 31–36 对应的设备缓存与 applied 水位、读取操作/重试、手机部分文件与前缀、未确认 outbox、当前 Host/Session、草稿/别名/视口/偏好继续留 AppLocalState。App 依然负责版本校验、结构化并发、事务提交和展示，但不能从本地计时、任意消息、队列文字或原生格式推断远端业务事实。

### 10. 与已有 ADR 的关系

| 已有决定 | 本决定的调整与保留 |
| --- | --- |
| ADR-0019 | 保留 Host 配置/凭据权威、事务与手机操作边界；扩展原先手机简化字段集合，增加非秘密用量、健康度、认证和路由摘要，统一由模型发布 |
| ADR-0024 / 0025 | 保留原生历史权威、source 恢复、epoch、canonical 身份和缓存事务；增加 Host 当前投影与统一显示页，替代“只有复制契约共同化、当前投影仅留在各 source”的最终架构边界 |
| ADR-0026 | 将“通用 Host 仅路由、关联及背压”扩展为模型管理与恢复入口；原生核对、选择算法、条件响应和不新增全量历史数据库继续有效 |
| ADR-0027 | 已被 ADR-0028 取代；本决定沿用其源端诊断与回合绑定的语义要求，但记录由 §8 的有界持久诊断记录承载，不恢复 `live.diagnostics`，也不按日志文字推断重试或失败恢复 |
| ADR-0028 | 复用唯一 NotificationStore，保留独立通知版本、来源恢复、设备关闭、期限/预算和短暂 outcome 重建边界；增加 Agent/Host 模型的逻辑归属 |
| ADR-0029 / 0030 | 保留本地读取单写者、多 Host 独立连接与作用域；App 远端数据源改为 Host 模型，必要本地操作不搬到共享状态 |
| ADR-0031 | 复用 opaque 权限契约、原生确认及会话作用域，将 metadata 中的权限展示接入统一模型；审批仍单独表示 |
| ADR-0008 | 实施时升级协议硬版本，移除旧业务状态旁路及双重写入；模型模块不可用是明确业务状态，不是旧协议兼容回退 |

后端原生语义仍隔离在 adapter；这不推翻 Host 不解析原生业务语义的原则。原生状态、Host 公共投影和设备本地状态各自有权威，但客户端只从 Host 统一模型取得远端事实。

## Implementation and acceptance

本 ADR 定义目标与必须覆盖的范围，不宣称已经实现 Registry、共同显示页、日志同步或新协议。实施允许分批迁移，剩余领域必须保留清单与状态，不能以第一批通知或 live 接入宣布完整模型完成。

1. 定义共享模型 schema、Agent/Host/Device 作用域、来源事实接口、领域版本和 Registry 单写者。验收清单必须登记审计 01–24（Agent 与共享域）与 25–30（Host 领域服务）逐项的可读基线、领域版本、作用域和迁移状态，并把 31–36 逐项登记为“保留在 AppLocalState”及理由；不得在 Agent 子域完成后就宣布完整模型完成。
2. 接入三产品/四路 backend、catalog、history/live/execution 与现有通知/权限；完成统一显示页，补 queue/interactions/model/context/capabilities 库存。
3. 接入 Host provider 服务、用量/健康度/认证/路由公共投影、产物、命令回执和有界持久诊断记录；共享引用也有可读基线和版本。
4. App 与桌面改为模型消费者，删除原生业务解释和旧生命周期写入旁路；保留 AppLocalState 及既有事务/读取要求。
5. 完成协议硬版本切换和跨端恢复验收；实际进程升级、部署和设备验证单独记录，不以文档 accepted 代替上线。

必须验证以下行为：

- 任一已支持领域都能从 Host 首次读取、重连和周期核对恢复；未知/不支持有明确表示，App 不需新增后端业务分支。
- 漏、迟、重、乱序的消息/工具完成、队列/审批结束、通知解除与配置确认，最终与 source 当前事实一致；部分库存、过期结果不删除有效状态。
- live→canonical、head 切换、revert/epoch 修正和显示页更新保持事务一致；历史分页不改运行/当前 live，投影变化不被旧缓存阻挡。
- retry/compaction/waiting 与所属回合、交互和通知一致；DSH context 缺事实不假报已支持，Pi 不可编辑权限不补全权限默认值。
- provider 切换、进行中路由、查询失败保留旧用量和恢复后的摘要正确；私有凭据/脚本不会进入 App 消息或日志。
- 两 Host 同名身份、两设备不同回执/通知关闭、重复接入及旧连接回调均隔离；关闭连接取消其 owned 工作，不留旧写入者。
- Host 重建、Pi→Host 与 Host→App 分别断线、换路和客户端重开均按代次恢复；旧快照不成为新代次已确认事实。
- 日志可以按页/游标恢复保留窗口，丢失/淘汰有明确缺口；日志、通知和聊天事实相互独立。
- 对库存、页大小、发送/写入队列、缓存、日志与回执进行预算/压力验证；超限有明确不完整/失败结果，UI 和 Host 不被慢来源阻塞。

## Consequences

远端领域有一个 Host 管理入口，新增后端的工作集中在适配事实和能力，App 不再扩展原生业务分支。队列、交互、供应商与记录能与聊天和通知一样查询、核对和恢复。

Host 将承担更多投影存储、领域协调、范围缓存与恢复调度，必须落实预算、单写者和代次隔离。原生 source 与 Host 投影同时存在是不同层的必要职责；重复实现业务规则或保留 UI 状态旁路会重新制造多权威。

本决定不会将所有状态变成一个巨大的快照，也不会删除设备本地状态。统一的是完整领域模型、事实接入与客户端读取边界；存储、执行和同步仍按领域职责组织。
