# ADR-0097：共享 Agent 的退出视图、重连与回到首页

日期：2026-11-24

Status: proposed（先以 Orbis 的 Codex Desktop 实现确定行为基线；四个适配器按各自可确认的原生信号接入）

关联：[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0086](0086-kimi-code-native-web-integration.md)、[ADR-0087](0087-hermes-agent-gateway-integration.md)、[ADR-0089](0089-openclaw-gateway-integration.md)、[ADR-0091](0091-opencode-shared-service-integration.md)、[ADR-0096](0096-codex-desktop-launcher-supervision.md)。

## Codex Desktop 的实际路径

Orbis Host 接的是桌面应用正在使用的 App Server，不是另启一套 Codex 会话。需要分开看三层：**桌面端点已连接**不等于**某个原生会话已附着**；其中已附着的会话才会进入 **App 首页在线列表**。

| 用户或原生动作 | Orbis 当前的路径 | App 上的结果 |
| --- | --- | --- |
| 桌面版在 Host 之前或之后打开，或桌面后端端点更换 | [`CodexDesktopLifecycle`](../../packages/host/src/codex-desktop-lifecycle.ts) 定期探测已有端点（默认 2 s）；核验后接同一个 App Server。`CodexRuntime` 启动即查 `thread/loaded/list`，随后每 2 s 重查；未附着线程的 `thread/started`、`thread/status/changed`、`turn/started` 可提前唤起同一次对账。 | 不扫历史使全部会话上线。已加载且活跃的普通会话可出现；首次看到的已加载空闲会话只有已进入原生目录或确有回合时才出现，空白草稿、子 Agent、临时或归档会话不出现。 |
| 手机从首页退出某个视图 | `#quitThread` 先回成功，按 `thread.turnInProgress` 在 `#desktopSuppressed` 标记 `active` 或 `idle`，再卸载 Orbis runtime；等已发出的 `thread/resume` 收敛后，仅对 Host 连接发 `thread/unsubscribe`。不发 `turn/interrupt`、不归档，不替用户拒绝原生审批。 | 首页少一个入口；电脑继续，历史仍在目录。当前退订和 `runtime.offline` 属于 Host，共用该 Host 的 App 会收到，**不是按设备隐藏**。 |
| 手机切网、重开 App 或重新握手 | [`HostService`](../../packages/host/src/host-service.ts) 在认证 `device.ready` 中按 `directoryEntries()` 提供当前在线列表；App 随后补状态/历史。该握手不负责 `thread/resume`，也不清理 Host 的抑制状态。 | 已附着的卡片恢复。用户之前主动退出的卡片不会因手机重连复活。 |
| 手机从目录点开原会话 | 显式 `session.activate` 路由到该桌面 App Server 的同一 `threadId`，使用 `thread/resume`；成功才解除抑制，即使现在空闲也能出现。 | 立即重新获得这条会话的控制入口；不新建、不发送首句、不重跑旧输入。 |
| 退出后继续在电脑使用这条会话 | 同一个仍加载的线程，`active` 抑制先等原生确认 `idle`；已为 `idle` 时，下一次 `thread/read` 确认 `active` 才解除抑制。原生线程从加载清单移除时清掉旧抑制；以后重新加载仍走正常发现。通知只促使重查，不代表订阅成功。 | 旧回合的输出、完成、线程仍在加载或刷新都不会立即弹回；有新工作才自动回来。若忙→闲→忙在观察空档内且没有证据，当前 Codex 实现需要等下一次可观察转换或用户显式打开。 |

重新附着复用 `#adoptDesktopThread` → `#initializeTuiThread` → `thread/resume`，检查回复身份、重建历史与工具/交互状态，再消费附着期间缓冲的更新。抑制是该 `CodexRuntime` 的内存状态；桌面 App Server / Host runtime 被替换并不等于手机重连，当前实现重新按原生 loaded 快照发现，**不承诺跨 Host 重启记忆收起状态**。代码见 [`codex-runtime.ts`](../../packages/host/src/codex-runtime.ts)；已有 [发现、退订竞态、旧回合抑制及新工作回归](../../packages/host/src/codex-desktop.test.ts)。App Server 对加载列表、订阅和 turn 的区分见 [官方协议](https://learn.chatgpt.com/docs/app-server)。

## 决策：按用户意图恢复入口，不把重连当成开会话

- **用户只断网或退出 App：** 不改变附着意图。移动连接只重建投影；原生传输恢复时，先对账并恢复此前已附着、没有被显式退出的同一会话。接受同一原生会话的新订阅代次；不得接到同名/同 key 的另一会话，不重放写入。
- **用户主动点「退出视图」：** 放弃当前 Orbis 入口，不中断回合、队列、审批，不归档、不杀进程。把退出和意外断线分别记账。保持可重新打开的原生目录，且不以普通目录刷新、元数据、旧回合追加输出、旧交互、结束事件或重新握手清除抑制。
- **用户在手机点回原会话：** 不需要等待下一轮，即刻附着同一原生会话。**用户在电脑开始新的原生工作：** 可以自动恢复入口。支持载入态的来源可像 Codex 观察真实重新加载；其余来源不能把「打开了目录或把窗口带到前台」伪装成原生工作。对已退出的会话，只有原生确认闲→忙，或可靠、更新的回合/执行身份能证明有后续工作，才自动附着；不能单凭 `busy` 或收到旧回合中的新审批复活。不要为了探测而 `resume` 冷会话、抢写者或启动服务。若原生不提供足够证据，保持目录可点开，不能宣称与 Codex 全等。
- **停止与归档各走原生接口。** `stop` 不退订；归档是独立持久化操作。DSH 的现有 `/quit` 仍是「先停止，成功才退出」，本 ADR 不改变 DSH；它不是共享后端收起的前提。

### 落点与观察信号

| 来源 | 低成本发现 / 对账 | 附着 / 退出 |
| --- | --- | --- |
| OpenCode 2.3.2 | 同一共享服务的全局 SSE 和 `session.active`，断流后读快照（SSE 不重播）。对退出时未结束的会话忽略同轮增量和交互；用可确认的闲→忙或更新的原生忙起点判定下一轮，单独排除归档和子会话。 | 官方客户端读同一 `sessionID`、历史、交互。退出仅移除单会话跟踪，不关闭全局 SSE；`session.interrupt({sessionID})` 留给停止。 |
| Kimi Code | 同一 Web / Desktop 实例的全局 `event.session.work_changed` 是候选，核对 `main_turn_active` 与原生会话身份；不把与主回合无关的 `busy` 当成新工作。全量历史目录不是在线清单。 | Beta 会话 WS `subscribe`；退出用真正的 `unsubscribe`，避免同连接重复 `subscribe` 时没有新的 `turns` 基线。精确 `prompt_id:abort` 独立。Web 2.6.3 与 Desktop 内嵌 2.6.2 的契约分别核对。 |
| OpenClaw | `sessions.subscribe` 的 `sessions.changed` 加原生 `sessions.list`/`chat.history` 快照；使用准确的原生 `sessionId` 和 `activeRunIds`/`inFlightRun`，同一个 key 被 reset 后不是旧会话。 | `sessions.messages.subscribe` / `sessions.messages.unsubscribe`，保留其他订阅及 catalog；`chat.abort` 独立且绑定确切 `runId`。 |
| Hermes | 同 profile 共享 Gateway 的只读 `session.list({scope:"live"})` 是候选；`stored` 只供显式目录打开。当前 live 行的 `running` 不等于完整状态，缺行或部分快照不证明空闲；只有已验证的活跃转换才自动重新附着。自动探测只能用已有 Gateway 的 `attach`，不能把当前显式入口的 `ensure` 当作后台探针。 | `session.resume` 取现有会话的新订阅和权威快照；用 `session.detach` + 当前 `subscription_id` 退出，不带 `end_reason`。`session.interrupt` 独立且带原生代次。 |

实现时，退出成功回执先于在线列表更新；旧订阅或在途刷新不能让已退出的 runtime 回来。显式或自动重新附着时，`runtime.online` 先于新的能力与完整基线，不能复用已离线的交互缓存。用既有会话身份区分不同来源和原生实例；会话身份不随订阅代次变化。

### 场景与验证边界

- `SHARED-VIEW-01`：电脑开始 A → 手机退出视图 → 同一原生回合与待审批保留，其他会话不受影响；App 重连、旧输出及本轮结束均不恢复 A。
- `SHARED-VIEW-02`：不点目录，在电脑开始下一轮 → A 自动回到首页并对齐当前历史/交互；没有可确认原生信号时，在目录点 A 可恢复同一会话。
- `SHARED-VIEW-03`：未退出时，原生或移动传输断开后恢复原会话；已退出时只恢复传输，不能误当重新激活。覆盖退出、在途回包和显式重开的竞态。
- `SHARED-VIEW-04`：手机显式停止后仍保留入口。归档与旧客户端兼容独立验证。实现、原生联动、部署与用户验收分别记录。

## 协议落点：把「退出视图」作为附着代次操作

这不是把四个原生服务都伪装成 Codex 的 `/quit`。Orbis 只统一用户语义，不统一原生 RPC 名称：

- Host 在 `device.ready.hostFeatures` 声明 `runtime.view-close.v1`；设备在当前握手声明后，才允许消费共享后端的 `orbis-exit-view`。
- 共享后端的 `runtime.capabilities` 为 `orbis-exit-view` 携带必填 `closeGeneration`。手机提交 `session.close` 时同时带 `sessionId` 与该代次；Host 在路由、能力投影和后端执行三处都核对当前附着，过期请求失败。
- 成功顺序固定为：原生退订已确认 → `command.result(success)` → Host 发送 `runtime.offline`。失败或不确定不删除卡片，也不把请求降级成 `/quit`；旧 App 看不到该能力。
- 重新附着生成新的视图代次和能力基线；旧关闭请求不能关闭新附着。移动重连只重建投影，不调用原生 resume，也不清理抑制记录。

Codex Desktop 仍保留已有 `quit` 命令，因为它的 Host 实现负责关闭桌面 TUI 视图；在 Desktop App Server 这条路径上该命令已经是 view-only。四个共享后端则使用新能力，避免把其原生 `interrupt`、`archive` 或 `close` 误当成手机收起卡片。

## 四个适配器的实现边界

| 适配器 | Orbis 退出动作 | 退出后的新工作证据 | 不采用的动作 |
| --- | --- | --- | --- |
| OpenCode | 仅移除该 `sessionID` 的本地跟踪；全局 SSE 保持连接。 | `session.execution.started` / `session.active` 确认闲→忙，或 `time.busy` 严格晚于退出时基线；归档、fork、旧增量和旧交互不会复活。显式打开总是重新读历史、交互和 live。 | 不用 `session.interrupt` 代替退出视图。 |
| Kimi Code | 同一 WS 发送并确认 `unsubscribe(session_id)`，不重复 `subscribe`。 | `event.session.work_changed` 的 `main_turn_active=true` 加原生回读；已在忙时若没有先观察到闲，保持目录可点开，不猜测是下一轮。15 s 有界 running probe 只对已知 idle 的隐藏会话尝试附着。 | 不发送 `prompt_id:abort`；不把 `busy` 或普通目录刷新当作新工作。 |
| OpenClaw | `sessions.messages.unsubscribe(key, subscriptionId, agentId)`；保留全局 `sessions.subscribe` 与 catalog。 | `sessions.changed` 中同一 `key + agent + sessionId` 的精确 `activeRunIds` / `inFlightRun`；空数组只更新为 idle，旧 run ID 不复活，出现新 run ID 才附着。session key 被 reset 成另一 `sessionId` 时清除旧抑制。 | 不用 `chat.abort`；不按相同 key 重新绑定替代会话。 |
| Hermes | `session.detach(session_id, subscription_id)`，不带 `end_reason`；原生 session、FIFO、审批和回合继续由 Gateway 持有。 | 已知 idle 的隐藏会话可由 `session.list({scope:"live"})` 的 running=true 触发有界 `session.resume`；已知 active 只接受更高 `execution_generation` 的 `message.start`。缺行、false、旧 generation 或不完整快照都不证明新工作。 | 不用 `session.interrupt`；后台探测不调用会创建/启动服务的 `ensure`。 |

所有实现都把显式 `session.activate` 视为用户意图：它可以在 idle 时恢复同一原生身份，并在成功后建立新的历史、交互、工具和能力基线。自动探测只处理已经有正向原生证据的会话。

## 当前代码与验证记录（2026-11-24）

已落地：

- [shared-session-view.ts](../../packages/host/src/shared-session-view.ts) 集中定义共享后端判断、`orbis-exit-view` 能力和代次匹配。
- [host-service.ts](../../packages/host/src/host-service.ts)、[protocol index](../../packages/protocol/src/index.ts) 完成协商、投影、旧端过滤、Host 级 offline 顺序和过期代次拒绝。
- [opencode-backend.ts](../../packages/host/src/opencode-backend.ts)、[kimi-runtime.ts](../../packages/host/src/kimi-runtime.ts)、[openclaw-backend.ts](../../packages/host/src/openclaw-backend.ts)、[hermes-agent-backend.ts](../../packages/host/src/hermes-agent-backend.ts) 完成各自原生退订、隐藏状态、显式重开和重连竞态保护。
- Android / iOS 使用同一“退出视图”确认语义；旧客户端未协商 `runtime.view-close.v1` 时不显示共享后端的该入口。

本轮已执行的定向验证：

- OpenCode、OpenClaw、Hermes 后端定向 Vitest：新增退出、显式重开、旧 run 抑制和正向新 run 恢复断言通过。
- Host 定向 Vitest：设备能力协商、能力投影、命令路由与旧握手回退断言通过。
- TypeScript 类型检查通过。

仍未宣称完成：真实四家原生服务的跨版本联动、Android / iOS 安装验收、Windows Host 安装验收、部署和用户验收。`SHARED-VIEW-01`–`04` 的真实验收仍按 AGENTS.md 使用隔离合成会话和共享 QA 流程，不代领测试轮次。
