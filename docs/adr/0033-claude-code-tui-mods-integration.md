# ADR-0033：通过 Claude Code Mods 双向接入官方 TUI

日期：2026-10-14

Status: accepted（接入方向已确认；Hook bridge 已实现阶段性能力，完整兼容性验收及运行环境迁移尚未实现）

关联：[ADR-0001](<0001-pi-runtime-control-boundary.md>)、[ADR-0003](<0003-runtime-owned-slash-command-menu.md>)、[ADR-0021](<0021-codex-terminal-host-attachment.md>)、[ADR-0025](<0025-native-history-authority-and-versioned-caches.md>)、[ADR-0026](<0026-host-selected-session-sync.md>)、[ADR-0031](<0031-host-permission-management.md>)、[ADR-0032](<0032-host-owned-agent-state-model.md>)。

## Context

用户要求的是：电脑保留 Claude Code 官方 TUI，Orbis 手机与这个 TUI 双向操作同一个原生运行实例。电脑提交的消息、回复、工具、运行状态及交互必须同步到手机；手机提交的消息、停止和交互回答必须作用于这个实例，并在电脑上体现原生结果。

另起 Agent SDK 执行器、并发 resume 同一会话、只同步持久历史，均不满足这个要求。Orbis 也不因此成为终端模拟器、远程桌面或通用进程管理器；同步对象是 Agent 领域事实和操作，不是屏幕像素、ANSI 输出或每次按键。

Claude Code 已公开 Mods：通过插件加载 JavaScript/TypeScript 函数，在 Claude Code 内部观察、改写或处理原生事件，并调用 Mods API。这为官方 TUI 内的 bridge 提供了公开扩展路径，但 Mods 本身不是现成的远程控制协议，也不自动保证完整状态恢复或原生交互竞答。

## Verified facts and sources

以下上游事实核对于 2026-10-14；2026-10-26 的最新版部分验证另见下方记录。区分“上游正式发布事实”“当前文档描述的接口”与“Orbis 实际兼容性”，不把三者混为一谈。

| 事实 | 官方来源 | 证据边界 |
| --- | --- | --- |
| CLI v2.1.287 正式加入 Claude Mods；更新说明为 `Added Claude Mods: plugins may now modify deeper behavior` | [v2.1.287 Release](<https://github.com/anthropics/claude-code/releases/tag/v2.1.287>)、[Release 元数据](<https://api.github.com/repos/anthropics/claude-code/releases/tags/v2.1.287>) | `published_at` 为 `2026-10-01T18:00:22Z`，即北京时间 2026-10-02 02:00:22；这是 GitHub Release 公开时间，不是最早内测或所有分发渠道的上线时间 |
| 官方要求终端使用 v2.1.287 或更新版本；Desktop 内置 Claude Code 从 v2.1.286 支持 Mods | [Mods overview：Turn mods on or off](<https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off>)、[Create a mod](<https://code.claude.com/docs/en/plugins/mods/create>) | Desktop 的起点不能用于降低 CLI/TUI 最低版本；早期存在 function hooks 开关，不据此承诺旧版支持 |
| Mods 可观察提示词、工具和回合，处理命令，读取会话并扩展界面 | [Mods overview](<https://code.claude.com/docs/en/plugins/mods/overview>)、[Events](<https://code.claude.com/docs/en/plugins/mods/events>)、[Reference](<https://code.claude.com/docs/en/plugins/mods/reference>) | 当前 reference 以 v2.1.290 为描述基线，并包含明确标注更高版本的新增项；不能反推所有接口均在 v2.1.287 首发可用 |
| `$.prompt.submit({ text, asUser: true })` 可向当前会话提交用户输入，但等待 idle 后启动回合；`$.turn.abort`、`$.command.run` 等列于公开 API | [API：Start a turn from a background job](<https://code.claude.com/docs/en/plugins/mods/api#start-a-turn-from-a-background-job>)、[Reference：Mods API methods](<https://code.claude.com/docs/en/plugins/mods/reference#mods-api-methods>) | 不据此宣称原生 steer、follow-up、工作中队列或任意命令均支持；接口存在不证明停止范围、成功确认或交互完整性 |
| 目标版本加载 mod 后生成的类型声明是该构建的具体接口依据；声明及 API 可随版本变化 | [Create a mod：Get type definitions for your version](<https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build>) | 当前网页和 GitHub 类型副本不能取代目标二进制的声明及运行验证 |
| Channels 是与 Mods 分开的公开 MCP 扩展机制：可向打开的 TUI 注入消息，双向 channel 可提供回复工具；声明 permission capability 后可 relay 工具审批 | [Channels](<https://code.claude.com/docs/en/channels>)、[Channels reference：Relay permission prompts](<https://code.claude.com/docs/en/channels-reference#relay-permission-prompts>) | Research Preview；需要 claude.ai 或 Anthropic Console API key，受 Anthropic provider、组织策略和 allowlist 限制。工具审批通过短 `request_id` 与 `allow`/`deny` 回答，本地与远程先回答者生效；不覆盖 project trust、MCP server consent 或 AskUserQuestion。它不是 Mods resolver，也不提供完整 Host 同步协议 |
| 传统 Claude Code Hooks 与 Mods hooks 是两套接口。`PermissionRequest` 可对即将显示的工具权限请求返回 `allow` / `deny`；`PreToolUse` 可拦截 `AskUserQuestion` 并以 `updatedInput.answers` 提交答案 | [Hooks：PermissionRequest](<https://code.claude.com/docs/en/hooks#permissionrequest>)、[Hooks：PreToolUse decision control](<https://code.claude.com/docs/en/hooks#pretooluse-decision-control>) | `PermissionRequest` 输入含 `session_id`、`tool_name` 和 `tool_input`，但不含 `tool_use_id`；`PreToolUse` 有 `tool_use_id` 且会对每个工具调用运行。命令 Hook 默认等待上限为 600 秒。外部 UI/Host 可由 hook 进程同步等待并通过结构化 JSON 返回决策/答案；这是文档契约允许的实现方式，尚未在 v2.1.310 本机 TUI 实测。它不提供任意 TUI composer 输入接口 |
| Agent SDK 可枚举本地会话及读取 transcript 消息 | [Agent SDK sessions](<https://code.claude.com/docs/en/agent-sdk/sessions>)、[TypeScript reference](<https://code.claude.com/docs/en/agent-sdk/typescript#listsessions>) | `listSessions()` / `getSessionMessages()` 是 SDK 的 transcript API，不代表 Mods 可读取这些内容，也不证明能附着或控制既有 TUI 的同一实时执行实例 |
| Remote Control 将本机 Claude Code 会话连接到 Claude App / claude.ai | [Remote Control](<https://code.claude.com/docs/en/remote-control>) | 需要支持的 claude.ai 订阅登录；不支持 API key、非 Anthropic `ANTHROPIC_BASE_URL`、Bedrock、Google Agent Platform 或 Microsoft Foundry。它是官方客户端功能，不是面向 Orbis 的自定义 Host API |
| Mods 以用户权限运行、不受 Claude 的 Bash sandbox 隔离；可接触文件、凭据、进程及网络，但不能改变原生权限提示展示的内容 | [Mods overview：What a mod can reach](<https://code.claude.com/docs/en/plugins/mods/overview#what-a-mod-can-reach>)、[API：Reach files, processes, and the network](<https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network>) | bridge 必须自行约束远程操作，不把 Mods 的机器权限直接授予手机 |

2026-10-14 制定本 ADR 时未进行目标版本的插件加载、类型检查或真实 TUI 双向操作测试；以上链接只证明上游事实。2026-10-26 按用户要求仅验证最新版 v2.1.310，沿用当前供应商配置完成类型检查、插件校验、模拟测试及部分真实 TUI 操作，详见[验证报告与独立探针](../../spikes/claude-mods-validation/README.md)。插件提交及真实回复、等待 idle 的排队、无工具主回合停止、过期停止拒绝、基础 clear/resume 和 idle reload 已观察；模型主动工具调用、原生交互回答及完整历史恢复尚未通过验收。这不是 Host/App 双向接入验收，也不改变 §2 的最低版本要求。官方网页会更新，实施时仍须逐版本记录生成类型和测试结果。

## Decision

### 1. 选择官方 TUI 内的 Mods bridge

建立 Orbis bridge mod，在用户已加载 bridge 的 Claude Code 官方 TUI 内观察原生事实、执行受限的原生操作，并通过经过认证的本机通道连接 Host。Host 的 Claude backend 负责接入归属、原生事实归一和核对；统一模型负责校验、提交及客户端投影。

```text
电脑官方 TUI 输入 ──→ Claude Code 原生会话 / 执行 / 历史
                              ↕
                       Orbis bridge mod
                              ↕ 本机认证通道
                      Host Claude backend
                              ↕
                      Host Agent 状态模型
                              ↕ 既有加密 Paths
                        Orbis 手机客户端
```

两端共享同一个执行实例和会话，不增加第二个执行器。Native Claude Code 继续拥有执行与持久历史的权威；bridge/backend 解释并报告事实；Host 按 ADR-0032 管理标准投影；App 不解释 Claude 原生事件或权限值。

本 ADR 覆盖 CLI/TUI 接入，Desktop、IDE 聊天面板及 headless SDK 不属于首版支持范围。已运行但未加载 bridge 的 TUI 不自动宣称可控；如何安装、启用或重新加载插件须使用官方支持方式，并尊重用户确认和组织策略。

### 2. 必须支持的版本与兼容性门槛

- **CLI/TUI 的最低目标支持版本为 Claude Code v2.1.287。** 低于此版本不开放本接入，不通过早期环境开关、二进制补丁或 SDK 自动回退规避。
- 首版必须对 v2.1.287 和实施时选定的当前正式版本分别完成兼容性验收。`>=2.1.287` 只是必要条件，不是对所有未来版本的无条件兼容承诺。
- Host 与 bridge 握手必须报告实际 Claude Code 版本、bridge 版本、连接代次、原生会话身份及已确认能力。版本不足、mod 被禁用、能力缺失或核对失败时，发布明确不可用原因，不仅依据版本号宣布 ready。
- 实施使用目标构建生成的类型声明，运行 `claude plugin validate`、`claude plugin test`，并完成真实 TUI 测试；静态声明或模拟测试不能代替同实例操作验收。
- 若必要接口只在更高版本可用，须在本 ADR 和兼容性清单中明确提高最低支持版本、记录官方依据及验证结果；不能一边依赖更高版本接口，一边继续声称完整支持 v2.1.287。

### 3. 双向操作的必需范围

首版完整接入必须覆盖以下领域；未验证的能力不得提前发布为可用。

| 领域 | 接入要求与候选公开入口 |
| --- | --- |
| 身份与可用性 | 使用原生 Session 身份和 bridge 实例/代次；正式新增 `agentKind: claude`；AgentKey 仍为 Host、agentKind、Session，runtimeId 仅作在线路由 |
| 双向消息 | 手机通过 `$.prompt.submit` 提交到当前实例；电脑及手机的原生消息通过 `prompt.submit`、`session.append` 等核对与同步。原生接受、开始和完成分开确认，防止回声重复提交 |
| 历史与实时内容 | 用 `turn.step`、`tool.call`、`session.append` 等生成统一显示投影，保留稳定消息/工具身份、live 与 canonical 映射。`$.session.messages()` 的有界结果不能假报为完整持久历史；旧历史读取及 parent/head 必须另行验证 |
| 执行与停止 | 观察 `turn.start` / `turn.complete` 等，手机调用 `$.turn.abort`；以原生结束事实确认效果，不以调用返回或网络断线推断 idle。明确停止是否包含工具、子任务及队列 |
| 审批与用户问题 | Mods API 没有已验证的既有请求 resolver；但独立的传统 Claude Code Hooks 有结构化处理路径。`PermissionRequest` 可在工具权限请求阶段返回 `allow` / `deny`，`PreToolUse` 可拦截 `AskUserQuestion`，等待手机答案后用 `updatedInput.answers` 返回给同一个工具调用，不需要键盘注入。`PermissionRequest` 缺少原生 `tool_use_id`，但每个同步运行的 hook 进程可携带自己生成的关联 ID 等待对应手机答复；需实现并验证并发、取消、超时、重连和本地/远程竞答。命令 Hook 默认超时 600 秒，不适合作为无限期等待。官方 Channels 仍是另一条独立工具审批 relay，具有短 `request_id` 与本地/远程先回答者语义，但受 Anthropic 认证、组织策略和 allowlist 限制；v2.1.310 当前配置实测 `$.session.authorize() !== null` 为 `false`。`$.session.authorize()` 是供 HTTP 使用的凭据句柄，`$.ui.ask` 创建新问题；二者都不是上述 Hook 的回答机制。Hook 结构化响应来自官方文档契约，尚未在 v2.1.310 本机 TUI 实测 |
| 命令、模型和权限 | 仅发布能原生执行并确认结果的操作。候选为 `$.command`、`$.config`、`$.session`；权限使用 ADR-0031 的 opaque 设置契约，不通过手机解析 CLI 文案或权限模式 |
| 生命周期与恢复 | 覆盖 `/clear`、`/resume`、分支、压缩、mod reload 和连接恢复；旧会话命令及回调不能写入新会话。不能假设每次切换都会再次触发 `session.start` |

双向同步不要求两端共享未提交草稿、光标或相同界面布局。工作中输入必须按原生实际投递语义表达；不能把等待 idle 的 `prompt.submit` 包装成即时打断或 Pi steer。仅实现消息收发的阶段性成果可标实验性部分能力，不得宣布本 ADR 的完整 TUI 接入已完成。

### 4. 审批保持原生语义

优先使用公开 Hook 的结构化请求/响应边界。经典 `PermissionRequest` Hook 可把即将发生的工具权限请求发送到 Host，等待明确的手机选择，并对该 hook 调用返回 `allow` 或 `deny`；`PreToolUse` 可将 `AskUserQuestion` 的问题和选项发送到手机，收到答案后对原工具调用返回 `questions` 与 `answers`。这些响应由 Claude Code 消费，不是模拟键盘输入；远程审批/答案 UI、身份关联和传输回执仍由 Orbis 实现。Mods 的 `tool.check`、`$.ui.ask` 与 `$.session.authorize()` 各自不能替代这两个 Hook 契约。

`PermissionRequest` 没有原生 `tool_use_id`，需在每个 hook 进程内生成不可猜测的请求 ID，并将答复限定到该进程和 Session；hook 运行受其配置的超时约束，默认 600 秒。`PreToolUse` 有 `tool_use_id`，但对每个工具调用触发，只有匹配 `AskUserQuestion` 时才按问卷流程处理。远程回答、用户在电脑端作答、Session 取消、Hook 超时或 Host 断开同时发生时必须实测 Claude Code 的最终裁决与另一端状态；不能因掉线、超时或结果不明自动批准。

当前 bridge 对 `allowNotes: true` 的问题 fail-closed，因为 Claude Hook 的 `updatedInput.answers` 只能表达每个问题的字符串答案，不能安全保留独立 notes；该缺口必须在兼容性 ticket 中保留，不能静默丢弃字段。

官方 Channels 可作为另一种有 Anthropic 认证前提的工具审批 relay，不覆盖 `AskUserQuestion`。Agent SDK 的 `canUseTool` 可等待用户回答审批和 `AskUserQuestion`，但只控制 SDK 自己创建/管理的执行，不能附着到现有官方 TUI。尚未通过上述 Hook 的当前 TUI 运行测试前，ADR 只确认官方契约存在，不宣称 Orbis 已支持远程审批或问卷作答。

只有请求仍在当前原生实例中有效，回答才允许提交。本地与远程竞答必须由原生请求生命周期最终裁决；本地缓存只能减少重复，不能证明跨重启恰好执行一次。迟到、重复及已取消的回答返回明确结果或结果未知。

若目标版本无法满足原生交互同步，须记录具体缺口并提升版本或修订方案；不以屏幕抓取、按键注入或默认批准填补后宣称完整支持。

### 5. 通道、安全与恢复边界

bridge 只连接已验证的本机 Host 认证端点，不向 LAN/Relay 暴露 Mods API 或通用命令执行入口。复用 Host 的设备认证、加密与私有操作回执；手机不能提供任意进程 argv、脚本或目的 URL，也不能把聊天操作变为直接机器控制。

mod 无普通 Node.js 网络/定时器 API；通道实现须基于目标版本允许的 `$.http`、`$.clock` 等公开接口，或经验证的本机 helper。不能假定原生 WebSocket 或无限长请求可用。事件外发有界排队、批处理和背压，不让手机断线阻塞正常 TUI；超过预算明确记录 gap，并核对来源基线。

来源库存、版本与代次必须可核对。新连接或 reload 后先确认实例和当前 Session，再恢复历史/live/执行/交互等基线；不从日志文字、屏幕 spinner、心跳或旧持久快照复活当前状态。不承诺失去原生确认后的自动重发或跨 Host 重启恰好一次执行。

Host 退出只断开 bridge，不结束用户 TUI。CLI 升级、插件启用及任何需要中断会话或 Host 的迁移均须单独授权；本 ADR 不授予安装、升级、重启、push 或发版权限。

### 6. 纳入统一 Host 模型，不新增客户端原生分支

按 ADR-0032 完成 Claude 所需的来源 → Registry → 版本化同步 → App 镜像纵向链路；显式身份、统一 displayEntries、执行、交互、权限及能力必须从模型读取，不能只转发 Mods payload。其余领域明确 unknown/unavailable。

原生 Session 仍是持久历史权威，Host 只保存有界当前投影与页缓存。正式协议变更按 ADR-0032 硬版本切换，Host/App 配套更新。Relay 保持密文转发，不承担 Claude 会话语义。

## Alternatives not selected

- **Agent SDK 执行后端**：适合独立管理会话，但不能替代附着到用户正在操作的 TUI；不作为自动回退。
- **并发 resume / 只读 transcript**：历史相同不证明运行实例相同；只读原生历史可辅助核对，但不能作为操作通道。
- **Channels 或普通 MCP 单独接入**：Channels 官方支持向运行中的 TUI 推送消息、双向回复及有条件的工具审批 relay；它仍不提供完整历史、运行态、停止和 Orbis Host/App 同步契约。Remote Control 是 Anthropic 官方 App 的远程客户端能力，不用其未公开的内部协议构造 Orbis 客户端。
- **终端屏幕抓取、按键注入或修改 Claude 二进制**：不作为主方案或能力缺失时的隐式回退。

## Verification and consequences

先在隔离的官方 TUI 中验证 bridge，再进行 Host/App 集成。最低版本及选定当前版本均须记录实际测试结果：

1. 电脑发消息，手机获得原生消息、回复及工具；手机发消息，电脑显示同一 Session 的输入及结果；没有第二个执行实例或重复执行。
2. 中途加入流式回合能恢复已生成内容；live 到 canonical 无重复；有界历史读取不把缺失 parent/head 报完整。
3. 本地和手机分别停止、批准、拒绝或回答问题，两端状态收敛；竞答、重复、取消和迟到回答不误放行。
4. 手机/Host 断线、重连、Host 重建、mod reload、会话切换和压缩后能重取基线；旧代次命令不作用于新 Session，源端执行不因传输断线被结束。
5. 多 TUI、同 cwd、多设备及多 Host 的身份、回执和交互隔离；低版本、策略禁用、能力缺失、外发溢出及来源未知均明确报告。
6. bridge 只使用经验证的原生 API，正常观察不改写用户提示词/工具结果或权限规则；认证失败时不接受远程操作，凭据和未经脱敏的诊断不发送到手机。

本决定选择 Mods 作为 Claude Code 官方 TUI 的接入路径，不宣称上游已经提供完整远程控制服务，也不宣称 Orbis 已完成 Claude 支持。兼容性清单、原生交互缺口、实现状态和实际迁移必须分别记录。
