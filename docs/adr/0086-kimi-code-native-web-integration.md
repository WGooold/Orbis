# ADR-0086：Kimi Code 接入原生 Web 会话

日期：2026-11-19

Status: accepted（适配已实现；隔离链路自动验证通过；移动端安装、浏览器 UI 与发布验收待完成）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0045](0045-tool-summaries-and-on-demand-content.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0067](0067-host-app-field-transport-rules.md)、[ADR-0072](0072-session-configuration-and-recoverable-launch.md)、[ADR-0081](0081-host-startup-blocking-and-feedback.md)。

## 背景与方案选择

目标是在 Android / iOS 上续聊 Kimi Code 的**同一个原生 Web 会话**，同时保留电脑端原来的使用方式。验证基线是 2026-11-17 发布的 [`@moonshot-ai/kimi-code@2.6.3`][release]（源码 `b0de2fbd2de04d87689225aafd3912e5d193b62d`）；Server API 仍属 Beta，兼容范围按真实版本和契约验证，不从版本号推断。

| 方案 | 取舍 |
| --- | --- |
| `kimi web` 的 REST + WebSocket | 首选。[Server API][api] 提供目录、认证和分页；[会话流][conversation] 复用原生 `turn_id`、`item_id`、时间和交互身份。让 Orbis 与浏览器订阅同一服务，无需复制历史或另起一套执行。 |
| `kimi acp` | [官方 ACP][acp] 可用，但另启进程；`session/load` 回放上下文片段，工具 turn ID 在回放时重新生成，不能代替 Web 的稳定历史与实时订阅。不作自动回退。 |
| 解析私有存储、抓取终端、转发模型 API 或使用 Kimi 的云端 Remote Control | 不作为本接入路径。Orbis 复用本机的 Agent 会话，不把模型或终端输出当作会话协议，也不增加外部中继依赖。 |

## 决策

### 1. Host 认证接入所选的本机服务

Host 本地启用后，按配置的 Kimi 数据根和可选显式回环地址选择一个服务。默认数据根沿用 `KIMI_CODE_HOME` / `~/.kimi-code`。版本化读取[官方实例登记][instances]，只使用它提供候选端口和身份；对有效且未过期的登记，仍需在认证后的 `/api/v1/meta` 核对产品版本、能力、启动时间和受支持的 API 契约。Kimi 2.6.3 的登记 `server_id` 与 `/meta.server_id` 是两个不同作用域、不能直接比较；使用登记版本与 `/meta.server_version` 精确相同且启动时间相差不超过 10 秒来绑定本次监听，两个不透明 ID 分别保留，不互相充当会话身份。只接受字面回环地址，拒绝重定向、无认证实例和不匹配的启动身份；找不到或有多个匹配而未指定时不自动选。诊断区分未启用、未运行、未授权、歧义和版本不支持，不把探针失败写成「没有会话」。

REST / WS 使用本机的 Bearer 凭据，限定 Host 内部使用，不写入日志、请求回执、App 或 Relay。探测、连接和重连在 Host 启动关键路径之外，使用独立超时、字节预算和有限退避；默认禁用，用户通过 `orbis host --kimi-code` 或 `ORBIS_KIMI_CODE_ENABLED=1` 明确启用，可用 `KIMI_CODE_HOME` 和 `ORBIS_KIMI_CODE_ENDPOINT` 指定数据根和唯一实例。桌面 Host 同样读取环境变量或 Host 状态目录 `config.json`，QA 桌面 Host 不继承正式 Kimi 配置。停止 Host、取消接入或断线仅解除已建立的连接；不发送 `shutdown` / `takeover`，不释放原生锁、改变工作区信任或接管 TUI。首版只连接已有服务；KIMI-12 增加按需启动，不代为安装或登录。

### 2. 目录、激活与会话身份

Kimi 作为独立 `AgentBackend`（`agentKind: "kimiCode"`）接入 Host。`sessionId` / `runtimeId` 使用专属命名空间；会话身份绑定原生数据源与 Session ID，不使用 PID、端口或进程 `server_id`。服务重启更换连接代次，不能更换已确认的会话身份；数据根变更不能误接旧缓存。

目录、状态和归档 / 恢复以[原生 REST][sessions] 为准。用真实原生 `cwd`、标题、时间和不透明分页游标更新，忽略原生的占位消息数等不具备业务意义的字段。不排序猜 Session、不全量扫描磁盘；分页超限或失败时保留已知目录并声明不完整。恢复按精确 Session ID 原地订阅，归档与恢复以原生结果和目录刷新对账。

新建仅使用在电脑上验证过的绝对目录和显式 `environment_id: "local"`。使用 ADR-0072 启动账本，提交前记录一个不含用户身份的 launch 标记并写到原生 Session metadata；回执丢失时先按标记严格对账，证据不足就停在「未确认」，不重复创建或发送首句。区分已创建、已订阅且可发送和已执行；原生模型配置就绪也不代表已核实供应商凭据。该入口只支持已连接的 headless / auto 语义，不另开终端；明确要求 `tui` 时返回不支持。恢复前通过原生 `/environment` 核对主 Agent 的环境绑定。已知非本机环境不纳入首版；无法确认绑定时不开放写命令或把其路径接入 Host 本机文件服务。

### 3. 原生历史、实时消息和交互

- **历史与实时。** 以 WS `turns` 基线与 REST 有界历史页为准，按原生 `turn_id` / `item_id` 合并；`ordinal` 只用于排序和翻页。每次重订阅或接到新的 `turns` 时废弃旧代分页与被替换范围，`turns.removed` 或重置不得复活已撤销条目。订阅成功但未收到基线不是已同步；`turns.failed`、未知更新和截断保留明确的质量状态。`status: ended` 不是成功，结果按 `outcome` / `end_reason` 映射。复用 `RecoverableSessionSource`、`SessionSyncPreparer`、共用展示和工具摘要；工具正文只在可证实对应原生条目时按需读取。
- **输入与停止。** 对本次输入分配并保存绑定 Session 的原生 `prompt_id`，以原生 `prompt_ids` 核对 App 乐观气泡；同文消息不是同一提交，原生合并多项也不能只核销一个。明确区分请求发出、原生受理、排队、进入 turn 和回合结束。原生去重仅覆盖同一服务代次内尚保有的记录，跨重启或超出窗口先对账、不自动重发；停止只针对主回合，等目标 turn 的终态确认，不清空原生队列。首版不开放主动插话或排队入口，仍需呈现浏览器并发产生的真实排队状态。
- **工具审批与提问。** 使用原生 `interaction` 的 Session、Agent 与交互 ID，投影到既有手机交互组件。只提交原生已提供且本端能安全、准确表示的动作和答案；不自动批准、放宽模式或代填问题。由原生结束帧确认交互结果；网页先回答、原生超时和重连缺席分别结束旧卡，不能归到另一条会话。模型与思考仅展示原生可证实的所选配置，不用所选值推断本轮模型。

首版不扩展到运行中的独立 TUI、原生进程管理、远程执行环境、供应商设置、主动插话、子 Agent 控制或附件 / 文件差异能力。App 继续使用已有组件和真实能力显示，不显示没有实现且未经验证的入口。

### 4. 兼容与回退

在端到端通道协商 `agent.kimiCode`；App 只在 Host 宣告可接收 `device.features` 后声明。保持现有协议号和 Relay 外层路由格式。未声明的设备在初始化、后续更新和重连一律收不到 Kimi kind 或其目录、runtime、状态、诊断、通知及私有回执；Host 还需拒绝未协商的 Kimi 请求。目录快照、查询分页、游标和 compact 基线属于同一投影视图，不能在 Kimi / DeepSeek Desktop 不同能力组合间混用。新 App 连接旧 Host 不显示 Kimi；旧 App 连接新 Host 保留既有 Agent 与缓存语义。Kimi 连接失败不影响 Pi、Codex、Claude 或 DeepSeek。只有完成 `KIMI-03`–`05` 和门禁后，才启用面向设备的注册和更新。

## 实施顺序与验收边界

| 场景 | 交付边界 | 依赖 |
| --- | --- | --- |
| [`KIMI-01` (#48)](https://github.com/WGooold/Orbis/issues/48) | 只读发现已运行的原生服务，验证 REST / WS 认证、版本、身份、断线及断开所有权。 | — |
| [`KIMI-02` (#49)](https://github.com/WGooold/Orbis/issues/49) | 接入 AgentBackend 的目录、恢复、新建、归档与 launch 对账；在能力门禁完成前不对设备注册。 | `KIMI-01` |
| [`KIMI-03` (#50)](https://github.com/WGooold/Orbis/issues/50) | 有界历史及实时正文、工具摘要、源重置、基线与分页核对。 | `KIMI-02` |
| [`KIMI-04` (#51)](https://github.com/WGooold/Orbis/issues/51) | 首句和后续消息的身份对账、真实排队、原生主回合停止。 | `KIMI-03` |
| [`KIMI-05` (#52)](https://github.com/WGooold/Orbis/issues/52) | 原生工具审批与问答的请求、回执、重连与多端竞态。 | `KIMI-03` |
| [`KIMI-06` (#53)](https://github.com/WGooold/Orbis/issues/53) | Host / App 能力门禁与兼容投影；先完成协议验证再向 App 开放。 | `KIMI-02`；对外开放待 `KIMI-03`–`05` 完成 |
| [`KIMI-07` (#54)](https://github.com/WGooold/Orbis/issues/54) | Android 使用原有目录、草稿、会话与交互组件接入。 | `KIMI-03`–`06` |
| [`KIMI-08` (#55)](https://github.com/WGooold/Orbis/issues/55) | iOS 使用原有目录、草稿、会话与交互组件接入。 | `KIMI-03`–`06` |
| [`KIMI-09` (#56)](https://github.com/WGooold/Orbis/issues/56) | 原生服务、浏览器与移动端闭环；用实际发布旧版本验证互通和回退，分别记录构建、自动验证、部署与人工验收。 | `KIMI-07`、`KIMI-08` |

## 验证与交付状态

- **实现。** Host 的入口是 [`cli.ts`](../../packages/host/src/cli.ts) 与 [`desktop-runtime.ts`](../../packages/host/src/desktop-runtime.ts)。原生适配见 [`kimi-runtime.ts`](../../packages/host/src/kimi-runtime.ts)、[`kimi-input.ts`](../../packages/host/src/kimi-input.ts)、[`kimi-interactions.ts`](../../packages/host/src/kimi-interactions.ts)，能力门禁见 [`device-agent-visibility.ts`](../../packages/host/src/device-agent-visibility.ts)。移动端复用目录、启动、草稿和交互组件。
- **自动验证。** [Host 加密链路测试](../../packages/host/src/host-service.test.ts) 使用 macOS arm64、真实 Kimi Code 2.6.3、隔离 HOME、合成本机模型、真实 Host / Relay 和参考客户端。当前 Relay 与 2026-11-18 发布的 Relay `20cf37fcb59e41c02e017fda7798e91bff870119` 均通过：配置、新建及恢复同一会话、发消息、审批拒绝、历史和重连、未协商隔离、精确停止及后继队列继续执行。另在旧 Windows Host `v0.1.22` 发布包的原始 JS runtime 上验证回退：同身份重连、无 Kimi 能力、旧目录仍可读取、独立 Kimi 账本不变。这不是 Windows GUI、发布版 App 或 QUIC 的实测。
- **原生验证。** 真实 Kimi 与第二个原生 WS 客户端验证了同回合订阅、审批允许／拒绝、问答多选与自由文本、另一端先答、归档／恢复及进程重启后的身份。探针首轮的终态断言错误、订阅退出超时、目录字段与索引时序差异、审批工具时间更新及联调夹具失败均保留在本机证据索引 [`.artifacts/kimi-code-adaptation-20261119/verification.json`](../../.artifacts/kimi-code-adaptation-20261119/verification.json)。
- **构建。** Android Debug APK 与本地签名的 iOS arm64 模拟器包已构建，未安装；移动端定向测试分别通过 38 项和 24 项。候选哈希、首次失败和复测记录见证据索引。未部署生产，未提交 TestFlight。
- **待验收。** 浏览器 UI 与 Android / iOS 安装闭环、实际发布版 App 的互通矩阵仍待确认，不以参考客户端或本地构建代替。共享 QA 服务当前不可用，未创建或领取本轮 Case；恢复后按 #56 绑定候选和隔离环境，由用户领取验证。

[release]: https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.6.3
[api]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/docs/en/reference/server-api.md
[conversation]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/docs/en/reference/server-api-conversation.md
[sessions]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/docs/en/reference/server-api-sessions.md
[acp]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/docs/en/reference/kimi-acp.md
[instances]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/kap-server/src/instanceRegistry.ts

## KIMI-10：桌面图形界面（[#58](https://github.com/WGooold/Orbis/issues/58)）

在 Host「设置 → 常规」复用现有开关与应用按钮。保存显式选择后，运行中的 Host 按既有流程重连；暂停的 Host 不自动启动。首次未选择时继承原有本地配置；图形界面的显式选择仅覆盖桌面运行，不改 CLI 配置。共享 QA 构建不展示生产接入开关。

连接状态来自当前适配器，不从开关、安装状态或 Relay 连接推断。只显示短状态，启动说明放在按需提示中，不要求粘贴凭据。移动端继续按协商能力显示原有选择器和会话组件。

已实现。macOS Qt 构建、定向测试与最小窗口设置渲染通过；证据见 `verification.json` 中的 `desktopUi`。Windows 安装与手动验收待完成，未部署。

## KIMI-11：Kimi Code Desktop 内嵌服务（[#59](https://github.com/WGooold/Orbis/issues/59)）

保留独立 Web 路径；桌面模式直接接官方 Kimi Code 应用自己的服务，不另启 `kimi web`，不使用 Browser MCP，不包装或改写桌面应用，也不调用 `takeover`。两个模式均可选择，每个 Host 对同一数据根只接一种来源；共享数据目录不是共享运行状态。切换来源必须显式操作，不做跨来源回退。

先验证 macOS arm64 Desktop 1.3.7（内嵌 2.6.2）的实例登记 PID、应用签名和 API 契约，再复用会话、输入和交互适配。非已验证桌面平台不宣告支持。验收区分原生桌面服务上的链路验证与桌面／手机 UI 验收。

Host 设置在「常规 → 接入 Kimi Code」选择 Web／桌面版；CLI 用 `ORBIS_KIMI_CODE_SOURCE=desktop orbis host --kimi-code`，未配置来源仍走 Web。桌面服务只接受同一注册 PID 的签名应用和实际监听地址。桌面会话与 Web 会话使用不同的 Orbis ID 前缀，避免跨来源误恢复或发送；现有 Web ID 保持不变。两者复用原有 `agent.kimiCode` 协商及移动端界面。

**验证。** 官方桌面包与 Web 服务分别通过实际加密链路：从原生端新建并暂停在审批中的同一会话，可由参考设备续接、拒绝审批，原生订阅者收到终态；另验证 Orbis 新建、历史、重连、精确停止且不清除后续原生队列。Desktop 另通过发布版 Relay 与旧 Host JS runtime 回退；macOS Qt 的来源选择与最小窗口渲染通过。Node 全量 2,576 通过、19 跳过；首轮继承本机 Codex wrapper 配置引起的两项失败保留，隔离该配置后复跑通过。证据：`.artifacts/kimi-desktop-discovery/verification.json`。未部署；Kimi 窗口实际操作、手机安装及用户验收仍待完成。

**Windows x64 补充（2026-11-27）。** 支持官方 Kimi Code Desktop 1.5.1（内嵌服务 2.8.1）。从当前用户的安装登记定位 EXE，校验 Authenticode 签名、签名证书与 `app.asar`，附接时确认登记 PID 的 EXE、用户 SID、启动时间和回环监听地址。通过认证后校验 `/meta` 产品、协议和两份 API 文档 SHA-256；只对该契约使用 v1 会话目录、原生分页 token、`activity` 和 Desktop `session` 事件，模型从主 Agent 帧读取。Web 2.6.3 与 macOS Desktop 2.6.2 保留原有契约。

**Windows 验证。** 实际桌面服务上验证了已运行实例发现、认证、列目录、续接、Orbis 新建及标记恢复、一条模型回复、归档、还原及重新加载非空历史。使用独立的 Orbis 适配器状态目录，未重启现用 Host；Windows 冷启动、手机链路及桌面 UI 手动验收不在这次实测范围内。

## KIMI-12：从 Host 或手机按需启动

启用后，Host 的被动探测、目录读取和启动回执回读不启动 Kimi。Host 的「启动」按钮、已协商设备在有效工作目录请求新会话配置或新建，以及选中同数据源的历史会话，可按需启动。`launchableAgents` 表示可以发起启动，`agents` 仍只在认证、契约验证与 WS 握手完成后公告；沿用 `agent.kimiCode`，不扩展协议。

先复用可认证的所选实例；认证失败、契约不符、实例歧义、显式回环地址或桌面自定义数据根不触发备用进程。Web 使用已安装的兼容 CLI 在回环后台运行 `kimi web --host 127.0.0.1 --no-open`，丢弃含凭据的原生启动输出。桌面模式只打开已验证签名和版本的官方 macOS arm64 应用，不抢焦点或切到 Web。一个 Host 内的请求合并为一次启动；停用时撤销启动权限，只清理尚未交付的自产 Web 子进程。已接入的服务继续由用户使用。首次安装、登录或模型配置仍由 Kimi 完成。

**验证与交付。** 实现见 [`kimi-launch.ts`](../../packages/host/src/kimi-launch.ts)、[`kimi-runtime.ts`](../../packages/host/src/kimi-runtime.ts)；冷起并发、拒绝、复用和加密请求回归见 `kimi-web-client.test.ts`、`host-service.test.ts`；Host 按钮与状态覆盖见 `OverviewRowHoverTest.cpp`。隔离启动官方 Web 2.6.3，验证先新建、退出 Orbis 后复用、重启原生进程后恢复同一会话；macOS Qt 构建和既有总览回归通过。证据与首轮失败见 [`.artifacts/kimi-demand-launch-20261124/verification.json`](../../.artifacts/kimi-demand-launch-20261124/verification.json)。未部署；真实 Desktop 窗口和手机安装待用户验证。
