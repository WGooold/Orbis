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

### 1. Host 只连接已经运行、由用户管理的本机服务

Host 本地启用后，按配置的 Kimi 数据根和可选显式回环地址选择一个服务。默认数据根沿用 `KIMI_CODE_HOME` / `~/.kimi-code`。版本化读取[官方实例登记][instances]，只使用它提供候选端口和身份；对有效且未过期的登记，仍需在认证后的 `/api/v1/meta` 核对产品版本、能力、启动时间和受支持的 API 契约。Kimi 2.6.3 的登记 `server_id` 与 `/meta.server_id` 是两个不同作用域、不能直接比较；使用登记版本与 `/meta.server_version` 精确相同且启动时间相差不超过 10 秒来绑定本次监听，两个不透明 ID 分别保留，不互相充当会话身份。只接受字面回环地址，拒绝重定向、无认证实例和不匹配的启动身份；找不到或有多个匹配而未指定时不自动选。诊断区分未启用、未运行、未授权、歧义和版本不支持，不把探针失败写成「没有会话」。

REST / WS 使用本机的 Bearer 凭据，限定 Host 内部使用，不写入日志、请求回执、App 或 Relay。探测、连接和重连在 Host 启动关键路径之外，使用独立超时、字节预算和有限退避；默认禁用，用户通过 `orbis host --kimi-code` 或 `ORBIS_KIMI_CODE_ENABLED=1` 明确启用，可用 `KIMI_CODE_HOME` 和 `ORBIS_KIMI_CODE_ENDPOINT` 指定数据根和唯一实例。桌面 Host 同样读取环境变量或 Host 状态目录 `config.json` 的 `kimiCodeEnabled`、`kimiCodeHome`、`kimiCodeEndpoint`，重启 Host 生效；不增加管理入口，QA 桌面 Host 不继承正式 Kimi 配置。Host 停止、取消接入或断线只解除订阅、关闭自己的连接；不启动第二个 `kimi web`，不发送 `shutdown` / `takeover`，不释放原生锁、改变工作区信任或接管 TUI。首版要求用户先用 Kimi 官方方式安装、登录（或配置模型）并开启本机 Web 服务。

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
