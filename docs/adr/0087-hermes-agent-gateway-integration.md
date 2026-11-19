# ADR-0087：Hermes Agent Gateway 接入

日期：2026-11-19

Status: proposed（采用 Hermes 官方 TUI Gateway 作为自定义 Host 的原型路线；Host 与客户端入口已实现，发版源码兼容验证通过；真实 Gateway、设备与发布门禁待验收）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)、[ADR-0056](0056-agent-startup-readiness-and-consent.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0072](0072-session-configuration-and-recoverable-launch.md)、[ADR-0077](0077-cli-host-and-headless-validation.md)。

## 问题与结论

现有 Hermes 图标和宣传素材不表示产品已接入。Hermes 的官方集成指南区分 ACP、TUI Gateway JSON-RPC 与 HTTP API：IDE 编辑器集成用 ACP；自定义 Desktop / Web / TUI host 若需要原生 session、stream、审批与控制面，推荐 TUI Gateway。Orbis 是自定义 Host，因此原型应使用 TUI Gateway，而非把 ACP 当成唯一或首选接入面。[H01–H04]

Hermes 的 session、历史和 turn 由所选 Gateway profile 持有；CLI、桌面、ACP、Messaging 与自定义 Host 都是接入面，不应各自另造一份执行与历史。新增独立 `AgentKind` `hermes`，Host 作为本机 Gateway 的客户端，复用用户已有 profile 与原生 session。会话是否由 Orbis 创建不改变它仍是 Hermes 的同一个原生会话；若 Gateway 授权的本机目录 API 返回其他 Hermes surface 的会话，Orbis 可将其作为 Hermes 历史呈现与恢复，不将来源标签当权限或所有权证明。[H02–H06]

首选路径是 `hermes gateway attach --json` 获取官方 Gateway attachment 信息，再用 Hermes 提供的 Gateway client / 已文档化 JSON-RPC 能力连接共享 Gateway；具体可用方法与能力先读 `runtime.describe`，按实际运行时 feature 协商。优先复用同 profile 的既有 Gateway，不能绕过 Gateway 直接写 SQLite，也不能另启另一套 profile 后声称已接入用户现有会话。[H03–H07]

本 ADR 的上游行为基线固定为 NousResearch/hermes-agent v0.23.2（2026-11-16 发布；源码提交 `ae2a81ccc00e9b7c06301523e5bb09608397149c`）。其他版本的能力需另行实测，不从该固定版本外推。[H01]

## 调查范围与证据

- [发布记录 v0.23.2](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.2)
- [Programmatic Integration 文档（固定提交）](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/website/docs/developer-guide/programmatic-integration.md)
- [Gateway Local Sessions 文档（固定提交）](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/website/docs/developer-guide/gateway-local-sessions.md)
- [ACP Host Integration 文档（固定提交）](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/website/docs/user-guide/features/acp.md)
- 上游实现：[TUI Gateway](https://github.com/NousResearch/hermes-agent/tree/ae2a81ccc00e9b7c06301523e5bb09608397149c/tui_gateway)、[Gateway client](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/hermes_cli/gateway_client.py)、[共享 session store](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/hermes_cli/gateway_session_store.py)、[ACP server](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/acp_adapter/gateway_server.py)。
- Orbis 参考边界：[AgentBackend](../../packages/host/src/agent-backend.ts)、[旧 DSH ACP transport](../../packages/host/src/dsh-client.ts)、[旧 DSH ACP runtime](../../packages/host/src/dsh-runtime.ts)、[AgentKind schema](../../packages/protocol/src/agent-kind.ts)。

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
| HERMES-02 | Hermes CLI 发现、`gateway ensure --json`、本机 ticket bootstrap、profile 身份绑定与 `runtime.describe` 能力协商 | 首批对照本机 v0.22.5 的公开 ensure 命令和 runtime protocol 1；ticket / WS 使用隔离 fixture，不连接用户 Gateway。协议版本不符即拒绝。 |
| HERMES-03 | Orbis-compatible Hermes AgentBackend：session catalog、new/resume、prompt、stream/history、cancel、native result state | backend 纯逻辑及 Gateway RPC fixture 测试。 |
| HERMES-04 | Orbis 已支持的工具事件、交互/审批、模型/会话配置映射 | 只映射现有 Orbis command/event/config 语义，补充对应 Host 测试。 |
| HERMES-05 | Host 生命周期、安装/可用性、launchable/supported Agent 能力、AgentKind 与跨端 Hermes UI | 新枚举/feature 先过新旧协议兼容测试；平台 UI 按现有 Agent 路径接入。 |
| HERMES-06 | 端到端兼容、打包/安装验证、使用说明与 ADR 状态更新 | 自动验证、用户安装验收、发布状态分别记录。 |

Ticket 合并前分别审查并提交；没有可配置 issue tracker 的工作树中，`HERMES-01` 等 ID 用于本地 ticket / commit 关联，不声称已在远程看板登记。

## 决策

### 1. 来源身份与能力协商

新增 `AgentKind = "hermes"`，作为 Hermes Agent 独立来源。设备能力使用新的 `DEVICE_FEATURE_HERMES = "agent.hermes"`；只有声明该能力的 App 才接收 `hermes` 枚举、目录与命令。依 ADR-0064 同时适配注册帧和后续更新，旧 App 不得收到未知 AgentKind。所有新交互场景使用新 ID。

Host 仅在命令发现、Gateway attach、profile 身份校验与 `runtime.describe` 握手通过后报告后端可用。未知方法、未公布的 session source 或配置能力都按 unsupported 处理，不静默退化到 ACP、直接 API 或另一个 Agent。旧版与后续版本需按能力而非只按字符串版本分支。

### 2. Gateway 连接与执行所有权

- v1 仅接入 Host 所在机器的用户默认 Hermes profile。先验证 profile 身份；远程 endpoint、profile 不匹配、工作目录不属于该 Host 的情况默认拒绝或保持不可用，避免在另一台机器上执行文件工具却显示为本机操作。
- 首批已验证本机 Hermes v0.22.5 的公开 `hermes gateway ensure --json --timeout` 命令。Host 只在需要 Hermes 后端时调用 ensure；它可启动该 profile 的 Gateway，不在纯目录/状态读取时隐式启动。之后从 ensure 返回的 endpoint/control home 走同 profile 的本机 session-ticket 控制通道，再用 canonical Gateway WebSocket 协议连接；逐项验证 protocol、profile、instance、authority epoch 与 `runtime.describe`。控制通道与 JSON-RPC contract 均独立封装、版本锁定及 fixture 测试；未知 wire 版本、路径权限不安全、profile 或 instance 不匹配时 fail closed。若后续 Hermes 版本以 `gateway attach --json` 替代 ensure，需增加并验证独立 CLI adapter，不猜测或拼接远程 URL。ticket、token、credential 不写日志或发往 App。
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

- 文本 prompt、stream、reasoning、工具摘要、终态和取消按 Hermes Gateway 实际能力映射到 Orbis 既有 RuntimeEvent / AgentState。未验证的图片输入、原始工具正文、文件 diff 和 steer 不开放。事件序号、回放边界、重复帧和断线重连须保持幂等。
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
| HERMES-DISC-01 | macOS、Windows、Linux 覆盖 CLI 发现、支持版本的 `gateway ensure --json` 输出、本机 ticket / 命名管道或 Unix socket、owner 不可用、不同 Hermes 安装和用户显式路径；不自动安装、更新或修改 profile。 |
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

本 ADR 采用 TUI Gateway 为自定义 Host 的主路线，并以 Orbis 已有 AgentBackend / RuntimeCommand / RuntimeEvent 能力为首阶段边界。当前开发机只执行了 `hermes --version` 与 `hermes gateway ensure --help`（观察到 Hermes Agent v0.22.5；安装源码 commit `bf0203a794`）；没有执行 ensure、没有启动/连接 Gateway、没有读取或修改 profile/session。

- HERMES-01–03：transport、CLI/bootstrap、live/stored 目录、create/resume、文本 prompt、interrupt/cancel、历史快照与回放。v0.22.5 canonical 目录无 cwd 与游标：冷记录 cwd 为空，恢复后取 `info.cwd`，单 scope 满 200 条时保留覆盖不完整，且不推断归档为空。
- HERMES-04：统一 `AgentKind`、工具摘要库存、允许本次／拒绝、澄清选项及模型配置。历史以 `row_id` 和 `tool_call_id` 对账，运行中快照从同代次的可验证回放恢复工具摘要；截断时不宣称完整，工具原始输入、输出与进度正文不发布。会话内模型修改带原生 revision/generation，回读一致才成功；延期或结果未知时不重发，也不依据旧模型快照解锁发送。思考深度仅回显，不公开未验证的权限、深度或永久授权操作。
- 自动验证：[后端 fixture](../../packages/host/src/hermes-agent-backend.test.ts)，[HERMES-04 定向测试证据](../../.artifacts/hermes/h04-tests.txt)（6 文件、60 项通过），TypeScript 类型、定向 ESLint 与 `git diff --check` 通过。源码对照本机 v0.22.5 `bf0203a794` 的 `gateway/session_controls.py`、`gateway/session_mutations.py`、`gateway/session_deferred_pick.py`，不是实际 Gateway 联动。
- HERMES-05：CLI／桌面 Host 后台发现 Hermes，只有点名的目录、配置或激活请求才连接；停止只关闭 Orbis socket。`agent.hermes` 与 `agent.dshDesktop` 独立，按设备投影启动公告、运行时、请求、目录游标、Host 快照和推送；不在无设备协商的 Live Activity 旁路公告。iOS／Android 进入既有新建与目录筛选，Windows Host 总览只显示状态，不提供安装器。归档继续不可用。
- 自动验证：[Host E2E fixture](../../packages/host/src/host-service.test.ts)（91 项通过）、[定向测试](../../.artifacts/hermes/h05-unit-final.txt)（69 项通过）及 [Swift Store 回归](../../.artifacts/hermes/h05-swift/run.log)（2 项通过）。实际 Gateway 联动、已发布客户端互通、Android／Windows 原生构建、打包、部署和用户验收不在这些结果内。

### HERMES-06 兼容验证

- **Host／Relay**：以 `v0.1.22`（`11c7a227`）原始源码独立构建。候选 Host 经发版 Relay 完成 E2E 配对、会话目录、恢复、发一条合成消息、重握手与降级隔离；对照为候选 Host／Relay。同一设备能力声明向发版 Host 发出时，重连前后均只返回原有 Agent 和目录。[发版对照](../../.artifacts/hermes/h06-old-node-send-final.txt)（2 项通过）、[候选回归](../../.artifacts/hermes/h06-candidate-node.txt)（136 项通过，1 项发版专属测试按设计跳过）。复现测试见 `host-service.test.ts`，将独立发版运行 `npm ci && npm run build` 后的根目录传给 `ORBIS_HERMES_COMPAT_RELEASE_ROOT`。首次仅运行 `tsc` 缺少 Relay web 构建产物，失败证据保留在 `.artifacts/hermes/h06-old-node.txt`。
- **移动端**：候选 Host 的混合目录投影以 `v0.1.22` 原始 iOS parser 和 `android-v0.1.60`（`20cf37fc`）原始 Android reducer 回放，均接受过滤后的 112 条、22 个续页；iOS 负对照拒绝未过滤的 Hermes 页。[iOS 证据](../../.artifacts/hermes/h06-old-ios/release-app-compat.json)、[Android 证据](../../.artifacts/hermes/h06-old-android/test-result.xml)。候选 Swift Store 2 项、Android 目录 21 项通过。这是发版源码对照，不是已安装包、生产 Relay 或完整真机互通。
- **待用户验证**：候选安装包就绪后，用支持 Gateway 的 Hermes CLI 启动电脑端 Host，手机在现有新建入口选择 Hermes，选工作目录并发送文本；从会话目录恢复同一会话，确认历史、工具摘要和单次审批；重连后确认未重复发送。还未运行实际 Hermes Gateway 联动、Windows 安装包、设备安装或部署，本次未操作用户 Hermes profile。
