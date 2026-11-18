# ADR-0085：OpenCode 共享服务接入

日期：2026-11-19

Status: accepted（接入边界已定；实现与真实服务验收按 OPENCODE-02–06 分 ticket 完成）

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0076](0076-deepseek-harness-desktop-integration.md)、[ADR-0084](0084-zcode-cli-integration.md)。

## 问题与结论

Orbis 需要通过 Host 查看并操作 OpenCode 会话。OpenCode V2 默认由同一用户级共享服务持有会话、配置、权限和工具执行；本地 CLI 客户端连接该服务。OpenCode 也提供 `--standalone` 私有服务和 ACP 入口，但 ACP 当前实现会启动自己的 standalone 服务。若 Orbis 再启动一套 OpenCode 服务并连接同一默认数据库，可能出现两个服务同时驱动同一会话；没有证据证明这种方式具备 session 级单写者互斥。[F01–F04]

采用**共享服务接入**：新增独立 `agentKind: "opencode"`，Host 通过官方 `@opencode/client` Promise 网络客户端发现并连接当前用户已经运行的共享服务；只调用固定 `@opencode/client` 版本暴露的标准 API；首版明确接受官方文档标注为 experimental 的 `/api/event` 实时事件订阅，并按预览功能管理。除此之外不调用 `client.experimental.*`。Host 不启动、停止或重启 OpenCode 服务，不运行 `opencode acp`，不直接读写 OpenCode 数据库。共享服务不存在、版本不兼容或认证失败时，backend 报告不可用，不另起进程或回退到独立数据库。[F01–F06]

Host 将 OpenCode API 事件与按需读取的 session/message 数据映射到既有 Agent state；OpenCode 原生存储仍是历史和执行权威，手机只消费 Orbis 协议。OpenCode 事件流是 volatile 的；断线或溢出后，Host 必须重新读取会话状态并恢复订阅，不能把事件流当作可重放日志。[F05]

## 调查范围与证据

核对日期：2026-11-19。官方文档当前标记为 OpenCode docs V2（latest）。npm registry 当日 `@opencode/client` latest 为 `2.3.2`；此版本只作为客户端包调查基线，不代表已验证的 OpenCode CLI 支持范围。

| ID | 已确认事实 | 依据 |
| --- | --- | --- |
| F01 | OpenCode 默认运行用户级共享后台服务；本机 CLI 客户端连接它，该服务拥有 sessions、configuration、integrations、permissions 和 tool execution。CLI 文档将 `--standalone` 标为私有服务，将 `--server` 标为连接指定服务。 | [CLI：Background service](https://opencode.ai/docs/cli/) |
| F02 | 官方 V2 Promise client 提供 typed session、message、permission、question 和 event 操作。API 文档明确将 `/api/event` 标记为 experimental，且服务端契约声明事件 live-only、断线不重放；首版因此将事件订阅视为精确版本锁定的预览依赖。 | [JavaScript client](https://opencode.ai/docs/build/client/)；[API reference](https://opencode.ai/docs/api) |
| F03 | 官方 ACP 用 `opencode acp` 作为 stdio agent。调查到的 OpenCode 源码实现由 ACP handler 调用 `Standalone.start()`，并通过本地 standalone server 建立 client；它不是连接已运行共享服务的契约。 | [ACP docs](https://opencode.ai/docs/acp/)；[ACP handler](https://github.com/anomalyco/opencode/blob/102efff30e5ecc9cc7a8482abaff20d7245c7291/packages/cli/src/commands/handlers/acp.ts)、[standalone service](https://github.com/anomalyco/opencode/blob/102efff30e5ecc9cc7a8482abaff20d7245c7291/packages/cli/src/services/standalone.ts) |
| F04 | `@opencode/client` 发布 Node Promise client 和 `service` 子路径；官方 service helper 通过 registration file 做本机 service discovery。`discover` 是只读路径；`ensure` 可能启动或替换后台服务，`stop` 会终止后台服务。 | [npm package metadata](https://www.npmjs.com/package/@opencode/client)；[service discovery implementation](https://github.com/anomalyco/opencode/blob/102efff30e5ecc9cc7a8482abaff20d7245c7291/packages/client/src/promise/service.ts) |
| F05 | `/api/event` 是 experimental event-stream route，且按官方 API 契约只提供 live 事件：断线期间事件会丢失，慢消费者可能收到溢出失败；session API 提供重新读取数据的路由。 | [API reference：Event](https://opencode.ai/docs/api)；[JavaScript client](https://opencode.ai/docs/build/client/) |
| F06 | Orbis 设备按 `device.features` 协商功能；既有 ADR-0076 / ADR-0084 已通过 feature gate 隔离新 Agent kind，防止旧客户端收到其不认识的目录、runtime 或 Agent state。 | [ADR-0064](0064-protocol-compatibility.md)、[ADR-0076](0076-deepseek-harness-desktop-integration.md)、[ADR-0084](0084-zcode-cli-integration.md) |

上述 OpenCode API 与 service helper 行为需在真实支持版本上复核；文档和当前上游源码不是 Orbis 端到端验证结果。当前机器未发现 PATH 中的 `opencode` CLI，故本轮不能声称真实服务联调通过。

## 决策

### 1. 独立 backend 身份

新增 `agentKind: "opencode"`，runtime 身份使用可判定归属的 `opencode:` 前缀。该 kind 表示 Host 通过 OpenCode 官方共享服务 API 管理的 OpenCode session，不表示桌面 UI 的专用 attachment，也不增加 `opencodeDesktop`。

### 2. 只连接已运行的共享服务

Host 使用 `@opencode/client` 发布的 Node Promise client 和 service `discover` helper 获取 endpoint / authentication headers。Host 不自行解析 OpenCode 私有 service registration 文件，不记录或向手机发送 endpoint 密码，也不将其写入日志。

首版只做只读发现与连接：不得调用会启动、替换、停止服务的 `ensure` / `stop` helper，不启动 `opencode serve` 或 `opencode acp`，不安装或更新 OpenCode。没有可用共享服务时，OpenCode backend 标记 unavailable，并给出用户可自行执行的启动说明；Host 启动和 OpenCode backend 激活均不得中断已有 OpenCode 会话。

### 3. OpenCode 数据与执行仍由其共享服务拥有

所有 session 列表、历史、执行、工具、权限和问题操作都通过官方共享服务 API。Host 不直接读写 OpenCode 数据库，不设置 `OPENCODE_DB`，不复制或迁移用户凭据 / session 数据，不将同一 session 接到第二个 OpenCode server。首版只使用 `@opencode/client` 的标准资源方法，以及官方文档标注为 experimental 的 `event.subscribe`；后者是为实时状态恢复接受的明确例外。其他 experimental 路由和私有 ACP 内部协议不进入首版。

若共享服务不存在、服务发现结果无效、认证失败或服务 API 版本不在经过验证的支持范围内，backend 不可用；不得自动启动独立实例作为 fallback。服务断开时，Host 标记 runtime 离线；重新连接后先通过 session API 重建状态，再发布增量变化。

### 4. Agent state 与客户端兼容

Host 将经过验证的 OpenCode catalog、history、message、tool、execution、permission、question 和 configuration 事实映射到 ADR-0032 的 Agent state。只有有明确原生语义对应的能力才可报告为 supported；未实现或无法确认的能力保持 unavailable / unknown，不伪造 Codex、Pi 或 DSH 语义。

新增设备 feature `agent.opencode`。只有设备本次握手声明该 feature 后，Host 才可向其发送 `agentKind: "opencode"` 的 catalog、runtime、Agent state、provider 和 operation 数据；旧设备视图必须在增量、游标和分页计算前完成过滤。

### 5. 版本、安全与恢复门槛

首版固定 `@opencode/client` 与服务端版本均为 `2.3.2`；运行时通过 `server.info` 验证服务端版本，任何不完全匹配的版本都拒绝连接，不作 semver minor 或 patch 兼容推断。后续扩大支持范围必须先加入对应版本的真实服务验收。所有 API 请求仅连接官方 service discovery 返回的本机 endpoint，并使用 discovery helper 提供的认证 headers；除非将来另立 ADR 并明确授权，不接受任意 LAN / Internet OpenCode server。

验证至少覆盖：service 不存在 / 未就绪 / 认证失败 / 版本不兼容；服务发现和 Host 重启不启动或停止 OpenCode 进程；session 列表分页；session 创建 / 恢复；history 与 live event 对齐；SSE 断线、溢出后的重同步；输入、取消、权限与 question 生命周期；密码和原始工具内容不进入共享日志 / App 消息；未声明 `agent.opencode` 的旧客户端完全不可观察到新 kind。

真实 OpenCode service 的端到端验证完成前，功能只能标记为实现候选；自动化 mock/API fixture 通过不能替代真实服务验收。

## 实施 tickets

每个 ticket 使用独立提交，只暂存该 ticket 的文件；不包含同一工作树中其他任务的变更。

| Ticket | 范围 | 完成条件 |
| --- | --- | --- |
| OPENCODE-01 [#42](https://github.com/WGooold/Orbis/issues/42) | 本 ADR、`CONTEXT.md` 领域词汇和文档索引 | 共享服务、单写者边界、版本与无副作用发现决策可复核。 |
| OPENCODE-02 [#43](https://github.com/WGooold/Orbis/issues/43) | Protocol `AgentKind`、Host feature filter、iOS / Android `agent.opencode` 能力声明、kind 识别与 UI 入口 | 新客户端能识别 OpenCode；未声明 feature 的旧客户端不接收 OpenCode runtime、catalog、state 或操作。 |
| OPENCODE-03 [#44](https://github.com/WGooold/Orbis/issues/44) | Host OpenCode service discovery、版本校验、官方 client 封装、不可用 / 离线 / 重连生命周期 | 只读连接已运行服务；所有失败隔离；测试证明 Host 不启动、停止、替换或重启 OpenCode。 |
| OPENCODE-04 [#45](https://github.com/WGooold/Orbis/issues/45) | OpenCode session catalog、history、event stream、Agent state 与断线恢复 | 分页完整；历史和 live state 可一致恢复；volatile event 断线后重新读取，不丢失最终状态。 |
| OPENCODE-05 [#46](https://github.com/WGooold/Orbis/issues/46) | 输入、取消、工具内容、permission / question、模型与 agent configuration 的 Host 命令映射 | 声明的命令各有 API fixture 和生命周期测试；未实现原生能力不暴露在 App。 |
| OPENCODE-06 [#47](https://github.com/WGooold/Orbis/issues/47) | 跨端回归、支持版本说明、真实共享服务验收 | Windows Node 工具链自动验证通过；旧客户端兼容测试通过；真实 OpenCode CLI / service 2.3.2 的实际结果有记录；扩大版本范围须另行验证。 |

## 验证状态

本 ADR 与上游接口静态调查已完成。Host / Protocol / iOS / Android 实现、mock API fixtures、真实 OpenCode service 联调均未执行；不能据此报告 OpenCode 已受支持。
