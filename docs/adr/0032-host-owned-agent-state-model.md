# ADR-0032：Host 统一管理完整 Agent 状态模型

日期：2026-10-13

2026-10-27：[ADR-0045](0045-tool-summaries-and-on-demand-content.md) 调整工具域载荷：Registry 保存库存描述符、标准摘要和内容引用；完整工具参数与输出在 producer/原生来源，按设备私有范围读取，不内联在共享 Agent 状态中。Host 仍为统一入口，App 使用通用投影。

Status: accepted（架构决定已确认；实现与运行环境迁移尚未完成）

关联：[ADR-0019](0019-host-provider-management.md)、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0028](0028-host-notification-lifecycle.md)、[ADR-0029](0029-session-read-operation-state-machine.md)、[ADR-0030](0030-multi-host-mobile-connections.md)、[ADR-0031](0031-host-permission-management.md)、[ADR-0064](0064-protocol-compatibility.md)。

实现与回归：[统一状态测试](../../packages/protocol/src/agent-state.test.ts)、[Host 事实模型测试](../../packages/host/src/agent-state-facts.test.ts)。

验收登记：[Agent 状态模型验收清单](../../packages/protocol/src/agent-state.test.ts)——36 个模块的模型归属、作用域与迁移状态，随实施更新。

## Context

当前 Pi、Codex 和 DeepSeek Harness 已接入统一的 AgentBackend 端口与部分协议。Codex 具有终端和桌面两路接入，因此当前 agentKind 为 pi、codex、codexDesktop、dsh。

统一端口尚未形成统一状态管理：

- 聊天 head、live 消息、工具和回合由各 source adapter 持有；Host 通用层主要关联请求、拼装目录并转发事件。
- 运行、重试、压缩、队列、交互、模型、上下文和能力分散在后端库存、元数据和 App reducer 中。共同事件结构不保证完整当前状态可以重取。
- 通知已有 Host NotificationStore，权限已有通用展示和更新契约；这些已完成的子域应纳入同一逻辑模型。
- 供应商完整配置由 Host 管理，手机有简化列表和切换；用量、健康度、路由与认证摘要尚未形成共同的可同步状态。
- 诊断记录分散在 Pi 本地日志与 Host 桌面日志中，缺少统一记录范围、游标和 App 恢复入口。
- App 仍解释 Pi 消息形状、压缩节点和部分后端身份，并处理旧消息/回合/工具生命周期分支。新增后端或修正原生语义仍可能要求修改手机业务代码。

多个 Agent 后端统一到一套由 Host 管理的模型，App 同步该模型；共享业务领域统一纳入模型。

## Decision

### 1. Host 模型是 Orbis 客户端的统一状态入口

Host 管理标准化 Agent 状态模型，客户端从同一模型读取共享领域和提交操作；状态具有明确来源、唯一归属与可恢复投影。

### 2. 原生权威、适配归一和 Host 管理分层

原生 Agent 持有业务与持久历史权威，适配层解释并归一事实，Host 管理投影与同步，客户端呈现标准模型。

| 层 | 责任与权威 |
| --- | --- |
| 原生 Agent | 执行会话、工具与队列，保存原生持久历史，确认模型、权限、审批及实际操作结果 |
| Agent backend / Pi 扩展 | 读取原生事实，确认身份、语义和完整性，输出标准化库存、变更及历史显示投影；保留断线恢复所需 source 状态 |
| Host AgentStateRegistry | 验证来源，事务接收标准事实，保存有界当前投影，关联共享服务与设备视图，发布状态、范围读取和恢复基线 |
| Host 领域服务 | 管理通知生命周期、供应商配置与用量/健康度、工作区、文件、操作与诊断记录；作为 HostState 子域接入同一模型入口 |
| App / 桌面 UI | 镜像已接受状态，提交显式操作，处理缓存、输入和展示；不解释后端原生业务语义 |
| Relay | 转发既有端到端加密 Envelope，不拥有 Agent 模型或解密其内容 |

### 3. 模型层级与身份

Host、Agent、Session 与在线 Runtime 按各自身份和生命周期建模；在线路由与持久会话分别表达。

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

### 4. 统一模型的领域覆盖

共享领域统一纳入模型，分别声明来源、版本、完整性、可用性与能力；字段和接入状态以协议及生产者实现为准。

| 审计模块 | Host 模型归属 | 状态范围 |
| --- | --- | --- |
| 01 身份与元数据 | AgentState.identity / availability | hostId、agentKind、sessionId、runtime 绑定、名称、工作目录、主机及来源身份；路由改变不改写会话身份 |
| 02 后端可用性 | HostState.backends；AgentState.availability | ready、launchable、接入状态和原因、来源连接与核对状态；电脑安装/版本摘要通过 management 引用 |
| 03 目录与归档 | HostState.catalog | 会话摘要、归档、历史 provider 归属；按后端记录目录版本、读取结果和覆盖完整性，失败不当作完整空目录 |
| 04 聊天历史 | AgentState.history | canonical 身份与 parent 链、来源版本、标准 displayEntries、分页范围/游标和覆盖事实；历史更正受版本门槛约束 |
| 05 分支与 head | AgentState.history | 当前 head、完整性、分支/范围身份与后端支持的导航或派生操作；Git 分支另属 workspace |
| 06 实时消息 | AgentState.live.messages | 完整累计正文、角色/内容块、finished、contentComplete、canonical 映射及完整库存；结束但未持久化的消息仍可恢复 |
| 07 回合与计时 | AgentState.execution.turn / timing | 回合身份、开始时间、已确认结束/耗时及对应消息；设备计算展示 elapsed 不改变事实 |
| 08 工具 | AgentState.live.tools；history 引用 | 调用身份、所属回合/消息、输入、部分输出、结果、执行阶段与失败；结果提交与 live 移除一致 |
| 09 运行与等待 | AgentState.execution | idle/running/waiting 等共同阶段、等待原因与请求引用、来源确认状态，包括 DSH 审批等待 |
| 10 重试与压缩 | AgentState.execution.retry / compaction | 是否支持、当前阶段、所属回合/操作、已知尝试/恢复/失败事实；不以日志文案或普通 idle 推断恢复；移动端在 compaction.phase=running 时于现有状态槽显示“压缩中”，等待确认优先，执行 phase 不变（ADR-0051 r6） |
| 11 交互与审批 | AgentState.interactions | 完整可回答请求库存、类型/问题/选项、期限、阻塞性、状态及明确结束；回答提交反馈属于 DeviceView |
| 12 消息队列 | AgentState.delivery.queue | 操作身份、steer/followUp、权威投递状态、取消能力和结果；队列执行仍由原生后端负责 |
| 13 命令与操作回执 | HostState.operations / DeviceView | 已接受、执行、取消、成功、失败、结果未知及回执保留范围；共享操作与设备私有结果分开 |
| 14 权限 | AgentState.permissions | 复用 permissionManagement 摘要、opaque 设置/选项、不可用原因、确认版本；诊断 raw 权限保留电脑侧适当视图 |
| 15 模型与思考级别 | AgentState.model | 当前实际模型/provider、显示名、thinking/effort、支持选项与变更状态，供统一配置入口使用 |
| 16 上下文与 tokens | AgentState.context | 当前占用、窗口、百分比、来源与未知状态；与累计账单用量区分，DSH 缺事实时明确 unknown |
| 17 能力与资源 | AgentState.capabilities / resources | 支持操作、参数/选项、不可用原因，已加载或可用 skills/prompts/MCP/扩展及可核对状态；后端差异由能力表达 |
| 18 通知来源 | adapter 事实接口；AgentState.notifications | 来源代次/版本、库存完整性、条件和一次结果；来源恢复语义由 adapter 确认 |
| 19 通知投影 | AgentState.notifications / DeviceView | 复用 NotificationStore 身份、版本、期限、核对状态、移除与设备关闭；不新建平行通知权威 |
| 20 手机供应商摘要 | HostState.providers.publicSummary | 已保存 id、名称、enabled、mode、默认标记、选择/变更状态；增加可重取的领域版本 |
| 21 配置与认证绑定 | HostState.providers.private；公开认证摘要 | 配置、journal、绑定、认证状态和变更结果；AgentState.providerBinding 引用实际绑定，秘密不跨到 App |
| 22 用量、健康度与路由 | HostState.providers.usage / health / routing | 用量结果/更新时间/查询错误、健康事实/探测时间、circuit 与 failover、实际 route/provider、进行中请求绑定 |
| 23 实时诊断记录 | HostState.diagnostics；AgentState.recordsRef | 标准记录、作用域、来源、级别、时间、记录身份、持久范围、游标/缺口、保留策略和读取状态 |
| 24 产物与附件 | AgentState.artifacts；HostState.files | 文件身份、元数据、来源消息/工具引用和可用性；路径附件输入与下载任务不伪装成已完成产物 |

### 5. 聊天显示归一与有界历史

适配层生成 displayEntries，Host 管理有界当前状态与历史页；原生历史保持持久权威，历史范围与当前显示分别提交。

### 6. 所有来源先写模型，再发布变化

来源变化经归属和结构校验，在模型提交后发布版本化投影；正常推送与客户端恢复共享入口。

### 7. 按领域同步，同一模型入口

领域通过同一入口独立同步，保留来源水位和版本；模型聚合代次使用独立身份，完整性按实际事实声明。

参考：[ADR-0064](0064-protocol-compatibility.md)。

### 8. 供应商、命令回执与记录的作用域

Host 服务按领域管理配置、回执与诊断；凭据保留在 Host，客户端获得具名操作和非秘密投影。

### 9. 重建、离线与 App 本地状态

重建与接入核对各领域基线，离线明确来源状态；本地草稿、阅读和待对账操作保持自身拥有者与生命周期。

参考：[ADR-0051 的压缩生命周期记录](0051-ui-style-motion-and-visual-stability-freeze.md)。

### 10. 与已有 ADR 的关系

| 已有决定 | 本决定的调整与保留 |
| --- | --- |
| ADR-0019 | 保留 Host 配置/凭据权威、事务与手机操作边界；扩展原先手机简化字段集合，增加非秘密用量、健康度、认证和路由摘要，统一由模型发布 |
| ADR-0024 / 0025 | 保留原生历史权威、source 恢复、epoch、canonical 身份和缓存事务；增加 Host 当前投影与统一显示页，替代“只有复制契约共同化、当前投影仅留在各 source”的最终架构边界 |
| ADR-0026 | 将“通用 Host 仅路由、关联及背压”扩展为模型管理与恢复入口；原生核对、选择算法、条件响应和不新增全量历史数据库继续有效 |
| ADR-0028 | 复用唯一 NotificationStore，保留独立通知版本、来源恢复、设备关闭、期限/预算和短暂 outcome 重建边界；增加 Agent/Host 模型的逻辑归属 |
| ADR-0029 / 0030 | 保留本地读取单写者、多 Host 独立连接与作用域；App 远端数据源改为 Host 模型，必要本地操作不搬到共享状态 |
| ADR-0031 | 复用 opaque 权限契约、原生确认及会话作用域，将 metadata 中的权限展示接入统一模型；审批仍单独表示 |
| ADR-0064 | 保持协议 18 起的互通、能力门槛与统一模型入口 |

后端原生语义仍隔离在 adapter；这不推翻 Host 不解析原生业务语义的原则。原生状态、Host 公共投影和设备本地状态各自有权威，但客户端只从 Host 统一模型取得远端事实。

## Implementation and acceptance

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 2026-11-01 桌面 Codex 新会话的首次模型核对

首次读取和显式重试统一核对目标会话的当前库存，公共身份与原生 thread ID 由 adapter 映射。Codex Desktop 公共身份带 codex-desktop: 命名空间，Host 经 runtimeIdFor 转为已登记原生 ID 后调用 announce。

本次故障是模型读取把公共 Session ID 直接传给 `announce`，调用静默未命中，`interactions` 持续为 unknown；两端首页按完整快照契约报告同步失败。重新打开 App 会在握手恢复路径用原生 ID 重播，因而暂时恢复。修复覆盖首次读取与重试，iOS / Android 共用该 Host 路径。自动用例、手动 R25 与未完成门禁见 [测试规则](../../AGENTS.md#测试)，证据目录 `.artifacts/ui-regression/20261101-new-session-sync/`；设备与真实桌面 App 仍待验收。

## 2026-11-06 Codex 压缩期间的历史快照滞后

沿用 execution 压缩领域与现有状态槽，新增回归场景 `CODEX-COMPACTION-01`。Codex 0.167.0 在发出 `contextCompaction` 的 `item/started` 后，同一进行中回合的 `thread/turns/list` 仍可能暂缺该条目。普通历史核对及同会话恢复保留已观察的压缩活动与条目身份；完成事件、终态快照及明确回退按既有生命周期结算。

实现与回归：[codex-runtime.ts](../../packages/host/src/codex-runtime.ts)、[codex-runtime.test.ts](../../packages/host/src/codex-runtime.test.ts)。自动验证 220 项、ESLint、完整 TypeScript 检查通过；本机 Codex 0.167.0 配合隔离模拟服务及 Host 模型验证核对前后保持 running、完成后 idle。原始首次失败、旧断言及验证记录保留于 [.artifacts/20261106-codex-compaction/](../../.artifacts/20261106-codex-compaction/)。当前运行 Host 未替换，手机显示待用户验证。

## Consequences

远端领域有一个 Host 管理入口，新增后端的工作集中在适配事实和能力，App 不再扩展原生业务分支。队列、交互、供应商与记录能与聊天和通知一样查询、核对和恢复。

Host 承担投影存储、领域协调、范围缓存与恢复调度，以预算、单写者和代次隔离管理；原生 source 与 Host 投影按各自职责协作。

本决定不会将所有状态变成一个巨大的快照，也不会删除设备本地状态。统一的是完整领域模型、事实接入与客户端读取边界；存储、执行和同步仍按领域职责组织。

## 2026-11-01 输入生命周期补充

输入受理、投递、执行和落地按 [ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md) 分别确认；未知结果保留身份并核对，验收状态以对应证据为准。
