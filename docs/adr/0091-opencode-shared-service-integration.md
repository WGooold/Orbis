# ADR-0091：OpenCode 共享服务接入

日期：2026-11-19

Status: accepted（接入已实现；已通过隔离的 Windows 原生服务测试，App 端到端验收待完成）

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0076](0076-deepseek-harness-desktop-integration.md)、[ADR-0090](0090-zcode-cli-integration.md)。

## 问题与结论

Orbis 需要通过 Host 查看并操作 OpenCode 会话。OpenCode V2 默认由同一用户级共享服务持有会话、配置、权限和工具执行；本地 CLI 客户端连接该服务。OpenCode 也提供 `--standalone` 私有服务和 ACP 入口，但 ACP 当前实现会启动自己的 standalone 服务。若 Orbis 再启动一套 OpenCode 服务并连接同一默认数据库，可能出现两个服务同时驱动同一会话；没有证据证明这种方式具备 session 级单写者互斥。[F01–F04]

采用**共享服务接入**：新增独立 `agentKind: "opencode"`，Host 通过官方 `@opencode/client` Promise 网络客户端发现并连接当前用户已经运行的共享服务；只调用固定 `@opencode/client` 版本暴露的标准 API；首版明确接受官方文档标注为 experimental 的 `/api/event` 实时事件订阅，并按预览功能管理。除此之外不调用 `client.experimental.*`。Host 不启动、停止或重启 OpenCode 服务，不运行 `opencode acp`，不直接读写 OpenCode 数据库。共享服务不存在、版本不兼容或认证失败时，backend 报告不可用，不另起进程或回退到独立数据库。[F01–F06]

Host 将 OpenCode API 事件与按需读取的 session/message 数据映射到既有 Agent state；OpenCode 原生存储仍是历史和执行权威，手机只消费 Orbis 协议。OpenCode 事件流是 volatile 的；断线或溢出后，Host 必须重新读取会话状态并恢复订阅，不能把事件流当作可重放日志。[F05]

## 调查范围与证据

核对日期：2026-11-19。调查基于 OpenCode V2 文档与源码。首版实现和验收只针对 `@opencode/client@2.3.2` 与 OpenCode 服务端 `2.3.2`，不推断相邻版本兼容。

| ID | 已确认事实 | 依据 |
| --- | --- | --- |
| F01 | OpenCode 默认运行用户级共享后台服务；本机 CLI 客户端连接它，该服务拥有 sessions、configuration、integrations、permissions 和 tool execution。CLI 文档将 `--standalone` 标为私有服务，将 `--server` 标为连接指定服务。 | [CLI：Background service](https://opencode.ai/docs/cli/) |
| F02 | 官方 V2 Promise client 提供 typed session、message、permission、question 和 event 操作。API 文档明确将 `/api/event` 标记为 experimental，且服务端契约声明事件 live-only、断线不重放；首版因此将事件订阅视为精确版本锁定的预览依赖。 | [JavaScript client](https://opencode.ai/docs/build/client/)；[API reference](https://opencode.ai/docs/api) |
| F03 | 官方 ACP 用 `opencode acp` 作为 stdio agent。调查到的 OpenCode 源码实现由 ACP handler 调用 `Standalone.start()`，并通过本地 standalone server 建立 client；它不是连接已运行共享服务的契约。 | [ACP docs](https://opencode.ai/docs/acp/)；[ACP handler](https://github.com/anomalyco/opencode/blob/102efff30e5ecc9cc7a8482abaff20d7245c7291/packages/cli/src/commands/handlers/acp.ts)、[standalone service](https://github.com/anomalyco/opencode/blob/102efff30e5ecc9cc7a8482abaff20d7245c7291/packages/cli/src/services/standalone.ts) |
| F04 | `@opencode/client` 发布 Node Promise client 和 `service` 子路径；官方 service helper 通过 registration file 做本机 service discovery。`discover` 是只读路径；`ensure` 可能启动或替换后台服务，`stop` 会终止后台服务。 | [npm package metadata](https://www.npmjs.com/package/@opencode/client)；[service discovery implementation](https://github.com/anomalyco/opencode/blob/102efff30e5ecc9cc7a8482abaff20d7245c7291/packages/client/src/promise/service.ts) |
| F05 | `/api/event` 是 experimental event-stream route，且按官方 API 契约只提供 live 事件：断线期间事件会丢失，慢消费者可能收到溢出失败；session API 提供重新读取数据的路由。 | [API reference：Event](https://opencode.ai/docs/api)；[JavaScript client](https://opencode.ai/docs/build/client/) |
| F06 | Orbis 设备按 `device.features` 协商功能；既有 ADR-0076 已通过 feature gate 隔离新 Agent kind，防止旧客户端收到其不认识的目录、runtime 或 Agent state。 | [ADR-0064](0064-protocol-compatibility.md)、[ADR-0076](0076-deepseek-harness-desktop-integration.md)、[ADR-0090](0090-zcode-cli-integration.md) |

上述文档和上游源码用于确定接口契约，不是 Orbis 端到端验证结果。Windows 原生服务的实际验证范围见下文。

## 决策

### 1. 独立 backend 身份

新增 `agentKind: "opencode"`，runtime 身份使用可判定归属的 `opencode:` 前缀。该 kind 表示 Host 通过 OpenCode 官方共享服务 API 管理的 OpenCode session，不表示桌面 UI 的专用 attachment，也不增加 `opencodeDesktop`。

### 2. 只连接已运行的共享服务

Host 使用 `@opencode/client` 发布的 Node Promise client，并使用 SDK 公开的 `fallback()`、`Info` 和 `Service.headers()` 读取服务注册、生成认证头。`2.3.2` 的 `Service.discover()` 在向调用者返回 URL 之前就对文件中的 URL 发送带认证头的请求，且未禁止 HTTP 重定向。为保证校验早于网络请求，Host 只读 `Info` 的 `url`、`pid`、`version` 和 `password`，先校验 loopback，再调用 `server.info` 核对 PID 和版本。SDK 请求禁止重定向。Host 不记录、写入或向手机发送注册文件密码。

首版只做只读发现与连接：不得调用会启动、替换、停止服务的 `ensure` / `stop` helper，不启动 `opencode serve` 或 `opencode acp`，不安装或更新 OpenCode。没有可用共享服务时，OpenCode backend 标记 unavailable，并给出用户可自行执行的启动说明；Host 启动和 OpenCode backend 激活均不得中断已有 OpenCode 会话。

### 3. OpenCode 数据与执行仍由其共享服务拥有

所有 session 列表、历史、执行、工具、权限和问题操作都通过官方共享服务 API。Host 不直接读写 OpenCode 数据库，不设置 `OPENCODE_DB`，不复制或迁移用户凭据 / session 数据，不将同一 session 接到第二个 OpenCode server。首版只使用 `@opencode/client` 的标准资源方法，以及官方文档标注为 experimental 的 `event.subscribe`；后者是为实时状态恢复接受的明确例外。其他 experimental 路由和私有 ACP 内部协议不进入首版。

若共享服务不存在、服务发现结果无效、认证失败或服务 API 版本不在经过验证的支持范围内，backend 不可用；不得自动启动独立实例作为 fallback。服务断开时，Host 标记 runtime 离线；重新连接后先通过 session API 重建状态，再发布增量变化。

### 4. Agent state 与客户端兼容

Host 将经过验证的 OpenCode catalog、history、message、tool、execution、permission、question 和 configuration 事实映射到 ADR-0032 的 Agent state。只有有明确原生语义对应的能力才可报告为 supported；未实现或无法确认的能力保持 unavailable / unknown，不伪造 Codex、Pi 或 DSH 语义。

新增设备 feature `agent.opencode`。只有设备本次握手声明该 feature 后，Host 才可向其发送 `agentKind: "opencode"` 的 catalog、runtime、Agent state、provider 和 operation 数据；旧设备视图必须在增量、游标和分页计算前完成过滤。

### 5. 版本、安全与恢复门槛

首版固定 `@opencode/client` 与服务端版本均为 `2.3.2`；运行时通过 `server.info` 验证服务端版本，任何不完全匹配的版本都拒绝连接，不作 semver minor 或 patch 兼容推断。后续扩大支持范围必须先加入对应版本的真实服务验收。所有 API 请求仅连接经过校验的 SDK 服务注册 endpoint，并使用 `Service.headers()` 提供的认证 headers；除非将来另立 ADR 并明确授权，不接受任意 LAN / Internet OpenCode server。

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

## 移动端 UI 补充（#43、#47）

- Android / iOS 的新建面板根据 Host `backends` 投影决定是否显示 OpenCode；收到不可用状态时保留禁用入口并显示具体原因。会话列表保留 OpenCode 筛选；筛选结果为空且服务不可用时，优先说明服务状态。已有会话及历史仍使用 Orbis 的会话列表和聊天页。
- 新建面板复用目录、模型和变体控件；不显示 OpenCode 未提供的持久权限配置。聊天会话配置仅在 Host 提供 `agent` 选项时显示切换 OpenCode Agent 的入口。单次权限请求继续使用通用交互界面，按钮明确标为「允许一次」和「拒绝」。
- 此次补充不扩大 `2.3.2` 的支持范围，不新增工具原始内容读取、持久权限策略或复杂问卷字段。App 设备联调仍为验收项。

## 验证状态

记录于 2026-11-19。以下为本分支的本地结果，不代表正式支持或发布。

| 层次 | 已确认结果 |
| --- | --- |
| 模拟 OpenCode API | [后端回归](../../packages/host/src/opencode-backend.test.ts)覆盖目录与历史分页、事件流断线或溢出后重新读取、工具摘要、消息生命周期、权限批准／拒绝和问卷。[Host 回归](../../packages/host/src/host-service.test.ts)验证未声明 `agent.opencode` 的测试设备看不到 OpenCode 数据、不能执行 OpenCode 命令或收到其 APNs 唤醒；重复命令不会重复执行，回执只发给请求设备。 |
| 实际 SDK + 本地 HTTP 测试服务 | [连接测试](../../packages/host/src/opencode-service-connection.test.ts)使用 `@opencode/client@2.3.2` 验证无效注册地址不发请求、有效 loopback 地址访问 `/api/info` 且不跟随重定向。这不是 OpenCode 原生服务。 |
| Windows 原生 OpenCode `2.3.2` | [隔离测试](../../packages/host/src/opencode-native.test.ts)通过官方 CLI 二进制启动测试专用共享服务，使用 OpenCode 模拟模型模式、不加载用户凭据。验证注册发现与认证、版本与 PID 核对、实时事件订阅、创建／恢复／归档、模型／变体／Agent 修改后读回、发送及历史消息身份关联、停止命令、撤回排队输入和问卷回复。关闭后端与连接再接入时，核对服务 PID 与原生会话 ID 均不变。 |
| Windows Node 构建与回归 | `npm run typecheck`、`npm run build` 通过；包含原生测试的 OpenCode 定向回归（Host / Protocol，6 个测试文件）118 项通过。默认全量 `npm test -- --maxWorkers=2` 为 2547 项通过、39 项跳过（含默认不运行的原生 OpenCode 测试）、2 项失败。失败项为 [Codex Windows 目录联接识别](../../packages/host/src/codex-command.test.ts#L72) 与 [Review Demo 的 Pi 注册](../../scripts/review-demo/portal.test.mjs#L32)，在接入前提交 `312eb281` 上复现了相同断言失败。 |
| Android | Windows 构建脚本执行 `:app:testDebugUnitTest`，925 项通过、9 项跳过；未安装 APK，也未进行设备联调。 |

复跑原生测试：在 Windows 上从 npm 包 `@opencode/cli-windows-x64@2.3.2` 提取 `package/bin/opencode.exe`，将下列路径替换为该测试二进制的绝对路径。未设置 `ORBIS_OPENCODE_TEST_BINARY` 时默认跳过此测试。测试为子进程分配独立的配置、数据、状态和临时目录，仅在 loopback 上监听，并在结束时停止自己的子进程。

```powershell
$env:ORBIS_OPENCODE_TEST_BINARY = 'C:\path\to\package\bin\opencode.exe'
try {
    npm test -- packages/host/src/opencode-native.test.ts
} finally {
    Remove-Item -LiteralPath 'Env:ORBIS_OPENCODE_TEST_BINARY'
}
```

待验收：原生服务上的权限批准／拒绝和事件流溢出恢复（目前仅模拟测试通过）、iOS 编译、Android／iOS 与隔离 Host 的设备联调及真实旧版 App 兼容性。现阶段仍是预览候选，不加入正式支持清单，也不扩大 `2.3.2` 版本范围。
