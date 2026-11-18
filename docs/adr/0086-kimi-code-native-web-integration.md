# ADR-0086：Kimi Code 接入原生 Web 会话

日期：2026-11-19

Status: proposed（已完成原生服务探针；Orbis 适配、构建、部署和用户验收未执行）

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

Host 本地启用后，按配置的 Kimi 数据根和可选显式回环地址选择一个服务。默认数据根沿用 `KIMI_CODE_HOME` / `~/.kimi-code`。版本化读取[官方实例登记][instances]，只使用它提供候选端口和身份；对有效且未过期的登记，仍需在认证后的 `/api/v1/meta` 核对 `server_id`、能力和受支持的 API 契约。只接受字面回环地址，拒绝重定向、无认证实例和不匹配的身份；找不到或有多个匹配而未指定时不自动选。诊断区分未启用、未运行、未授权、歧义和版本不支持，不把探针失败写成「没有会话」。

REST / WS 使用本机的 Bearer 凭据，限定 Host 内部使用，不写入日志、请求回执、App 或 Relay。探测、连接和重连在 Host 启动关键路径之外，使用独立超时、字节预算和有限退避。Host 停止、取消接入或断线只解除订阅、关闭自己的连接；不启动第二个 `kimi web`，不发送 `shutdown` / `takeover`，不释放原生锁、改变工作区信任或接管 TUI。首版要求用户先用 Kimi 官方方式安装、登录（或配置模型）并开启本机 Web 服务。

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
| `KIMI-01` | 只读发现已运行的原生服务，验证 REST / WS 认证、版本、身份、断线及断开所有权。 | — |
| `KIMI-02` | 接入 AgentBackend 的目录、恢复、新建、归档与 launch 对账；在能力门禁完成前不对设备注册。 | `KIMI-01` |
| `KIMI-03` | 有界历史及实时正文、工具摘要、源重置、基线与分页核对。 | `KIMI-02` |
| `KIMI-04` | 首句和后续消息的身份对账、真实排队、原生主回合停止。 | `KIMI-03` |
| `KIMI-05` | 原生工具审批与问答的请求、回执、重连与多端竞态。 | `KIMI-03` |
| `KIMI-06` | Host / App 能力门禁与兼容投影；先完成协议验证再向 App 开放。 | `KIMI-02`；对外开放待 `KIMI-03`–`05` 完成 |
| `KIMI-07` | Android 使用原有目录、草稿、会话与交互组件接入。 | `KIMI-03`–`06` |
| `KIMI-08` | iOS 使用原有目录、草稿、会话与交互组件接入。 | `KIMI-03`–`06` |
| `KIMI-09` | 原生服务、浏览器与移动端闭环；用实际发布旧版本验证互通和回退，分别记录构建、自动验证、部署与人工验收。 | `KIMI-07`、`KIMI-08` |

## 已有证据与未完成项

- 在 macOS arm64 / Node `22.23.2` 下，以独立 `KIMI_CODE_HOME`、隔离目录和本机合成模型启动真实 Kimi Code `2.6.3`。已观察：健康探针与认证边界、OpenAPI / AsyncAPI 可读取、新建与查回 metadata、两个原生 WS 订阅者收到同一回合、相同 `prompt_id` 重提交只调用一次合成模型、REST 历史与 WS 重订阅的条目身份一致、归档 / 恢复。无生产账号、会话、外部模型或 Orbis Relay 参与。
- 第一轮探针将结束状态错断言为 `completed`，实测为 `status: ended`、`outcome: completed`。双订阅探针第一次在一个 WS 尚未关闭时，服务未在 4 秒内退出；关闭两个测试订阅后复测通过。保留首轮和复核记录。证据在 [`.artifacts/kimi-code-adaptation-20261119/verification.json`](../../.artifacts/kimi-code-adaptation-20261119/verification.json)（本机）。
- 适配实现、双端构建、已发布 App / Host / Relay 对照、其他平台、真实网页 UI、真实问答及用户安装验收均未执行。候选包验收走共享 QA；固定版本、安装方法、独立环境与结果在对应 ticket 记录，不以本探针充当发布或用户验收。

[release]: https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.6.3
[api]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/docs/en/reference/server-api.md
[conversation]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/docs/en/reference/server-api-conversation.md
[sessions]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/docs/en/reference/server-api-sessions.md
[acp]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/docs/en/reference/kimi-acp.md
[instances]: https://github.com/MoonshotAI/kimi-code/blob/b0de2fbd2de04d87689225aafd3912e5d193b62d/packages/kap-server/src/instanceRegistry.ts
