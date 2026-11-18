# ADR-0084：Hermes Agent Gateway 接入

日期：2026-11-19

Status: proposed（采用 Hermes 官方 TUI Gateway 作为自定义 Host 的原型路线；backend、会话映射与跨端兼容尚未实现或验证，不代表已支持、已发布）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)、[ADR-0056](0056-agent-startup-readiness-and-consent.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0072](0072-session-configuration-and-recoverable-launch.md)、[ADR-0077](0077-cli-host-and-headless-validation.md)。

## 问题与结论

Orbis 目前没有 Hermes Agent 执行后端；现有 Hermes 图标和宣传素材不表示产品已接入。Hermes 的官方集成指南区分 ACP、TUI Gateway JSON-RPC 与 HTTP API：IDE 编辑器集成用 ACP；自定义 Desktop / Web / TUI host 若需要原生 session、stream、审批与控制面，推荐 TUI Gateway。Orbis 是自定义 Host，因此原型应使用 TUI Gateway，而非把 ACP 当成唯一或首选接入面。[H01–H04]

Hermes 的 session、历史和 turn 由所选 Gateway profile 持有；CLI、桌面、ACP、Messaging 与自定义 Host 都是接入面，不应各自另造一份执行与历史。新增独立 `AgentKind` `hermes`，Host 作为本机 Gateway 的客户端，复用用户已有 profile 与原生 session。会话是否由 Orbis 创建不改变它仍是 Hermes 的同一个原生会话；若 Gateway 授权的本机目录 API 返回其他 Hermes surface 的会话，Orbis 可将其作为 Hermes 历史呈现与恢复，不将来源标签当权限或所有权证明。[H02–H06]

首选路径是 `hermes gateway attach --json` 获取官方 Gateway attachment 信息，再用 Hermes 提供的 Gateway client / 已文档化 JSON-RPC 能力连接共享 Gateway；具体可用方法与能力先读 `runtime.describe`，按实际运行时 feature 协商。优先复用同 profile 的既有 Gateway，不能绕过 Gateway 直接写 SQLite，也不能另启另一套 profile 后声称已接入用户现有会话。[H03–H07]

本 ADR 的上游行为基线固定为 NousResearch/hermes-agent v0.23.2（2026-11-16 发布；源码提交 `ae2a81ccc00e9b7c06301523e5bb09608397149c`）。其他版本的能力需另行实测，不从该固定版本外推。[H01]

## 调查范围与证据

- [发布记录 v0.23.2](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.2)
- [Programmatic Integration 文档（固定提交）](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/website/docs/developer-guide/programmatic-integration.md)
- [Gateway Local Sessions 文档（固定提交）](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/website/docs/developer-guide/gateway-local-sessions.md)
- [ACP Host Integration 文档（固定提交）](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/website/docs/user-guide/features/acp.md)
- 上游实现：[TUI Gateway](https://github.com/NousResearch/hermes-agent/tree/ae2a81ccc00e9b7c06301523e5bb09608397149c/tui_gateway)、[Gateway client](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/hermes_cli/gateway_client.py)、[共享 session store](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/hermes_cli/gateway_session_store.py)、[ACP server](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/acp_adapter/gateway_server.py)。
- Orbis 参考边界：[AgentBackend](../../packages/host/src/agent-backend.ts)、[旧 DSH ACP transport](../../packages/host/src/dsh-client.ts)、[旧 DSH ACP runtime](../../packages/host/src/dsh-runtime.ts)、[AgentKind schema](../../packages/protocol/src/agent-state.ts)。

### 已确认事实

| ID | 事实与影响 | 上游依据 |
| --- | --- | --- |
| H01 | v0.23.2 是本次固定的发布基线；其 tag peeled commit 为 `ae2a81ccc00e9b7c06301523e5bb09608397149c`。结论仅适用于被检查的提交。 | release tag 与固定源码 |
| H02 | 官方集成指南给出三条接入面：ACP 供 IDE；TUI Gateway JSON-RPC 供需细粒度 session、控制和流式事件的自定义 host；HTTP API 供 OpenAI-compatible frontend。它们复用 Hermes agent loop，但请求 / 能力边界不同。 | `website/docs/developer-guide/programmatic-integration.md` |
| H03 | TUI Gateway 支持 stdio 与 WebSocket。文档示例使用 Hermes 的 Node Gateway client，并通过 `hermes gateway attach --json` 获取 attachment 信息；Gateway 另提供 `runtime.describe` 与会话、prompt、事件、审批等 RPC。 | 同 H02；`tui_gateway/`、`hermes_cli/gateway_client.py` |
| H04 | session 创建、列表、恢复、transcript、prompt submit、取消与状态都属于 Gateway 原生接口。session 历史由 Gateway profile 的 SessionDB 管理；官方要求用 Gateway 接口操作，不由前端直接改库。 | `website/docs/developer-guide/gateway-local-sessions.md`、`programmatic-integration.md` |
| H05 | Gateway 是会话状态的 canonical owner；已授权的多个 surface 可连接同一 Gateway、查看或恢复共享历史。彼此独立的 Gateway 进程不因此共享一个安全的并发写者。 | v0.23.2 release notes、`gateway-local-sessions.md` |
| H06 | `session.create` 可携带来源及可选 client attribution。来源会影响该 session 使用的 policy/toolset；client 名称是归因信息，不是认证、授权或安全隔离边界。相关字段与调用能力需要运行时协商。 | `programmatic-integration.md`、`gateway-local-sessions.md` |
| H07 | `runtime.describe` 提供运行时、profile 与能力信息；Gateway method 存在不等于当前 owner 开放该方法。应先协商 `features` / method capability，再决定 UI 与命令，不用方法名猜能力。 | `programmatic-integration.md`、`tui_gateway/` |
| H08 | ACP 是官方 IDE host 路线，提供 stdio ACP server；Hermes ACP 接入 Gateway，并具备 session、历史 replay、streaming 与权限请求。但其会话抽象偏编辑器 host，功能覆盖和目录语义不同于 TUI Gateway。 | `website/docs/user-guide/features/acp.md`、`acp_adapter/gateway_server.py` |
| H09 | Hermes 提供持久 Gateway session history、目录检索 / 恢复、权限审批与多种工具 surface；Host 展示的是本机 Hermes 用户可访问的会话，不应私自复制 transcript 或以 client label 冒充安全隔离。 | `gateway-local-sessions.md`、`programmatic-integration.md` |
| H10 | Orbis 的 DSH ACP 是 DSH 专用协议实现，并通过 DSH 持久化 API读取历史；不能替换命令或类型名后直接用作 Hermes adapter。 | Orbis `dsh-client.ts`、`dsh-runtime.ts`；上游 H03–H08 |

## 当前阶段范围

目标是让 Hermes 后端完整承载 Orbis 已支持的 Agent 使用方式，而不是在 Orbis 重建 Hermes 的全部产品 surface。能力以现有 `AgentBackend`、Protocol / RuntimeCommand / RuntimeEvent、会话目录与聊天交互契约为准：Orbis 已表达的能力须正确映射并验证；Hermes 独有、Orbis 当前没有交互/协议承载的管理能力不新增入口、不暗中触发、不伪造状态。Hermes 工具在会话中自然执行不等于 Orbis 要提供对应的管理 UI。具体映射在实现 ticket 先盘点现有契约，再逐项落地。

首阶段按可独立验证的 ticket 分批提交：

| Ticket | 范围 | 提交边界 |
| --- | --- | --- |
| HERMES-01 | TUI Gateway JSON-RPC/WebSocket transport：request correlation、events、server→client request 与错误/关闭语义 | 纯 transport 与本地 WebSocket fixture；不触及 Gateway 身份、AgentBackend 或 UI。 |
| HERMES-02 | Hermes CLI 发现、Gateway ensure/attach、凭据 ticket 与 profile 身份绑定、`runtime.describe` 能力协商 | 固定已验证版本的 bootstrap contract 与 isolated fixture；不得连接用户 Gateway 做测试。 |
| HERMES-03 | Orbis-compatible Hermes AgentBackend：session catalog、new/resume、prompt、stream/history、cancel、native result state | backend 纯逻辑及 Gateway RPC fixture 测试。 |
| HERMES-04 | Orbis 已支持的工具事件、交互/审批、模型/会话配置映射 | 只映射现有 Orbis command/event/config 语义，补充对应 Host 测试。 |
| HERMES-05 | Host 生命周期、安装/可用性、launchable/supported Agent 能力、AgentKind 与跨端 Hermes UI | 新枚举/feature 先过新旧协议兼容测试；平台 UI 按现有 Agent 路径接入。 |
| HERMES-06 | 端到端兼容、打包/安装验证、使用说明与 ADR 状态更新 | 自动验证、用户安装验收、发布状态分别记录。 |

Ticket 合并前分别审查并提交；没有可配置 issue tracker 的工作树中，`HERMES-01` 等 ID 用于本地 ticket / commit 关联，不声称已在远程看板登记。

## 决策

### 1. 来源身份与能力协商

新增 `AgentKind = "hermes"`，作为 Hermes Agent 独立来源。设备能力使用新的 `DEVICE_FEATURE_HERMES_GATEWAY = "agent.hermes"`（最终常量名可随实现调整，线上值发布后保持稳定）；只有声明该能力的 App 才接收 `hermes` 枚举、目录与命令。依 ADR-0064 同时适配注册帧和后续更新，旧 App 不得收到未知 AgentKind。所有新交互场景使用新 ID。

Host 仅在命令发现、Gateway attach、profile 身份校验与 `runtime.describe` 握手通过后报告后端可用。未知方法、未公布的 session source 或配置能力都按 unsupported 处理，不静默退化到 ACP、直接 API 或另一个 Agent。旧版与后续版本需按能力而非只按字符串版本分支。

### 2. Gateway 连接与执行所有权

- v1 仅接入 Host 所在机器的用户默认 Hermes profile。先验证 profile 身份；远程 endpoint、profile 不匹配、工作目录不属于该 Host 的情况默认拒绝或保持不可用，避免在另一台机器上执行文件工具却显示为本机操作。
- 使用 `hermes gateway attach --json` 与受支持的 Hermes Gateway client；若 SDK 在 Orbis 的 Node 环境不可直接依赖，才在独立模块中实现其文档化 JSON-RPC framing / ticket 流程，并锁定经过验证的 wire contract。ticket、token、credential 不写日志或发往 App。
- 使用同一 profile 当前的 Gateway owner。连接流程可按 Hermes 支持的 attach / start / recover 行为建立连接；Host 不按进程名杀停、更新或重启 Gateway，也不打开 SQLite 作为第二写者。Host 负责自己建立的 transport 生命周期；执行、工具、审批、profile 和 SessionDB 由 Hermes/Gateway 持有。
- `session.create` 的 `source` 从 runtime 公布的允许值中选择，并验证该值对应的 provider/tool/approval policy；不能无条件硬编码自定义 `orbis` source。若 `client` 能力存在，使用稳定的 `orbis` 名称辅助归因；client label 不是权限证明。
- Gateway profile 是会话边界。v1 只呈现当前授权 profile 通过 session APIs 返回的原生会话；同 profile 的 CLI、ACP 或其它 Hermes surface 会话可作为共享 Hermes 历史恢复。用户选择的 profile 变化要重新建立身份与目录映射，禁止跨 profile 静默混合。

### 3. 会话与历史

- 使用 Gateway session APIs 做 list/create/info/transcript/resume/submit/cancel 与事件订阅。方法与字段按 `runtime.describe` 的 capabilities 选用；任何缺失的 archive / fork / model / mode 操作按“不支持”处理。加载历史与 live events 分开投影，不重复插入 transcript。
- `AgentKey` 使用 `(hostId, "hermes", nativeSessionId)`；runtime ID 仅是可更换路由身份。Gateway 原生 transcript 是聊天历史权威，Orbis 仅保留同步游标与自己必须的本地映射，不复制另一份可写 Hermes transcript。
- 创建等可能因断线出现结果不确定的变更，若 Gateway 提供 request ID / idempotency receipt，使用稳定 request ID 查询或重试同一操作；否则标记结果 unknown，不重发一条新 prompt，也不盲目重复创建 session。
- 可使用 `client`、`source` 和最近活动时间辅助来源展示，但不将其当作 access-control。会话对当前 profile 不可见、已删除或权限不足时，显示不可用并保留错误原因，不靠相同 cwd、标题或时间戳猜测替代。
- `session/list` 游标分页、lazy metadata、过期 cursor 和目录状态差异须保留原生语义；Host 不因一页为空就判定 profile 没有 Hermes session。

### 4. 能力、安全与失败语义

- Prompt、文本/图片内容、stream、reasoning、工具活动、文件变化、终态和取消均按 Hermes Gateway 当前公布能力映射到 Orbis 既有 RuntimeEvent / AgentState。事件序号、回放边界、重复帧和断线重连须保持幂等。
- approval / interaction 经既有 `InteractionRequest` 送至用户；拒绝、超时、Host 离线、未知选项及不支持的审批请求都 fail closed。不得自动选择允许、提升到永久 allowlist、启动 `--yolo` 或后台运行交互式 setup。
- Hermes Gateway 所在主机执行文件、终端、MCP、浏览器等工具；这不是 Orbis 沙箱。Orbis UI 明确显示该后端以及工作目录，错误报告不把远端执行说成本机执行。
- 模型、mode、toolset、权限和 provider 状态只通过 Gateway live API / capabilities 读取与变更；只有收到 native confirmation 后才发布成功状态。不直接编辑 Hermes config、凭据或 SessionDB。
- 对 gateway restart、event gap、ticket 过期、profile 更换和 pending mutation 结果不确定制定明确恢复状态。重新验证同一 owner 后才恢复订阅；未知 prompt 不自动重放。单后端故障不阻塞其他 Agent 和 Host。

### 5. 不选方案

| 方案 | 不采用原因 |
| --- | --- |
| 以 ACP 作为 Orbis 主接口 | ACP 是官方 IDE host 接口；Orbis 是需要 session 控制、能力发现、共享目录和 Gateway attribution 的通用自定义 host，官方推荐 TUI Gateway。ACP 可留作兼容/对照，不作为另一条隐式回退路径。 |
| 以 OpenAI-compatible HTTP API 作为唯一接口 | 适合兼容聊天 frontend；不足以单独表达 Hermes session 生命周期、原生权限和完整 Gateway 控制/事件契约。 |
| 直接嵌入 Hermes Python internals | Orbis Host 为 Node 产品；跨语言进程内依赖私有实现会绑死打包、升级与执行生命周期。 |
| 读取或写入 Hermes SQLite | 私有 schema、WAL/锁和 Gateway 写者归 Hermes；越过 API 会破坏会话一致性与升级兼容。 |
| 每个 Orbis 会话启动独立 Hermes profile / Gateway | 形成配置、memory、skills、provider 与历史副本，不是连接用户当前 Hermes owner。 |
| 复用 `DshAcpRuntime` / `DshAcpClient` | DSH 专用协议与历史语义不同，无法代替 Hermes Gateway client。 |

## 实现边界与测试门槛

首阶段仅实现 Hermes backend、Gateway client/transport、能力协商、session 与 event mapping，以及跨端必要 UI。保持 Orbis 共享聊天状态契约；不修改 Hermes 上游、不增加安装器、不复制 transcript、不另建 profile、不宣称工具全集兼容。按 ADR-0064 对最近发版真实 Host / Relay / App 完成新旧互通、重连和回退验证。

| 验证 ID | 验证目标 |
| --- | --- |
| HERMES-DISC-01 | macOS、Windows、Linux 覆盖 CLI 发现、`gateway attach --json` 输出、ACP extra 缺失、owner 不可用、不同 Hermes 安装和用户显式路径；不自动安装、更新或修改 profile。 |
| HERMES-GATEWAY-01 | 对无 owner、既有 owner、attach/start/recover、Gateway 重启与 Host 停止验证：连接同一 profile；Host 只清理所属 socket/process，不误杀共享 Gateway；ticket / profile mismatch fail closed。 |
| HERMES-CAPABILITY-01 | 用 v0.23.2 与至少一个后续正式版本做 `runtime.describe`/feature 对照；未知字段、未知 methods、缺少 capability 不崩溃、不假报可用。 |
| HERMES-OWNERSHIP-01 | 同 profile 中分别由 Orbis、CLI、ACP 创建 session；验证官方 Gateway 目录与 transcript 的共享语义、`client` attribution 可展示但不可授权；另一 profile 的 session 不泄露。 |
| HERMES-SESSION-01 | create/list/info/transcript/resume/submit/cancel、cursor 分页、历史装载、event replay、并发客户端、同 session busy、删档/归档/分支能力缺失及 native result unknown。 |
| HERMES-TRANSPORT-01 | JSON-RPC/WebSocket framing、ticket 过期、请求 ID 对应、乱序、断线、event gap、限额、重连和关闭；确认未知 prompt 不重发，幂等变更只复用原 request ID。 |
| HERMES-INTERACTION-01 | 审批 allow/deny/timeout/离线/未知 option、interactive setup 和 permanent approval；验证拒绝默认、无自动授权并保留真实回执。 |
| HERMES-CONTENT-01 | 验证文本、图片、reasoning、工具开始/完成、文件 diff、终端、MCP、输出截断与隐私标记映射；历史回放不重复入账。 |
| HERMES-CONFIG-01 | 多模型/provider/mode/tool source 对照；仅按运行时真实选项变更，验证变更后的会话配置回读，不写 Hermes 文件。 |
| HERMES-COMPAT-01 | 新 Host + 最近发版真实旧 App / Relay；旧 App 不接收 `hermes`。新版 App + 旧 Host 隐藏入口；重连、回退与版本组合按 ADR-0064 验证。 |
| HERMES-UI-01 | Android、iOS、Windows Host 的来源标识、目录筛选、共享历史、离线/错误/权限态、工作目录提示与无障碍回归。设备回归使用项目共享租约入口。 |

只有核心门槛通过且证据齐备后，才可将 proposed 更新为 accepted/implemented。自动测试、构建部署、设备验证和用户验收分别记录；手动回归待用户安装验证，不以模拟测试替代。

## 当前状态

本 ADR 已将主路线修正为官方推荐的 TUI Gateway，自定义 Host 原型和兼容门槛仍待实施与验证。尚未实现 Hermes backend、AgentKind/设备能力协商、跨端 UI 或 Gateway transport；本机 Hermes 安装、用户配置和真实 session 均未操作。上游 v0.23.2 静态源码调查不证明用户机器安装版本与本次基线一致。
