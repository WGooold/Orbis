# ADR-0033：通过 Claude Code Mods 双向接入官方 TUI

日期：2026-10-14

Status: accepted（接入方向已确认；Host/插件已对齐其他后端的主要能力并在 v2.1.312 真实 TUI 验证，v2.1.287 最低版本、Windows 终端启动和手机实机界面尚未验收）

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

本 ADR 覆盖 CLI/TUI 接入，Desktop、IDE 聊天面板及 headless SDK 不属于首版支持范围。已运行但未加载 bridge 的 TUI 不自动宣称可控；安装、启用或重新加载插件使用官方支持方式，并尊重组织策略。按 2026-10-29 的产品要求，安装 Host 默认自动登记插件，用户可在设置中关闭。

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

只有手机的明确回答产生 `allow` / `deny`（手机取消问卷返回 `deny`）。Host 不可达、没有设备在线、超时、断开或 Host 退出时，Hook 返回空输出、不做决定，由 Claude Code 原生权限对话框或问题界面继续处理；这不是自动批准，也避免本地用户在手机缺席时被锁死或被统一拒绝。Host 交互超时（570 秒）短于插件脚本请求超时（590 秒）和 Hook 超时（600 秒），保证手机看到的 `expiresAt` 准确。Hook bridge 只在有待答交互时发布 runtime，长期在线状态由 Mods bridge 决定；交互结束后恢复 Mods 报告的运行状态。

当前 bridge 不向手机转发 `allowNotes: true` 的问题（交由原生界面作答），因为 Claude Hook 的 `updatedInput.answers` 只能表达每个问题的字符串答案，不能安全保留独立 notes；该缺口必须在兼容性 ticket 中保留，不能静默丢弃字段。

官方 Channels 可作为另一种有 Anthropic 认证前提的工具审批 relay，不覆盖 `AskUserQuestion`。Agent SDK 的 `canUseTool` 可等待用户回答审批和 `AskUserQuestion`，但只控制 SDK 自己创建/管理的执行，不能附着到现有官方 TUI。尚未通过上述 Hook 的当前 TUI 运行测试前，ADR 只确认官方契约存在，不宣称 Orbis 已支持远程审批或问卷作答。

只有请求仍在当前原生实例中有效，回答才允许提交。本地与远程竞答必须由原生请求生命周期最终裁决；本地缓存只能减少重复，不能证明跨重启恰好执行一次。迟到、重复及已取消的回答返回明确结果或结果未知。

若目标版本无法满足原生交互同步，须记录具体缺口并提升版本或修订方案；不以屏幕抓取、按键注入或默认批准填补后宣称完整支持。

### 5. 通道、安全与恢复边界

bridge 只连接已验证的本机 Host 认证端点，不向 LAN/Relay 暴露 Mods API 或通用命令执行入口。复用 Host 的设备认证、加密与私有操作回执；手机不能提供任意进程 argv、脚本或目的 URL，也不能把聊天操作变为直接机器控制。

mod 无普通 Node.js 网络/定时器 API；通道实现须基于目标版本允许的 `$.http`、`$.clock` 等公开接口，或经验证的本机 helper。不能假定原生 WebSocket 或无限长请求可用。事件外发有界排队、批处理和背压，不让手机断线阻塞正常 TUI；超过预算明确记录 gap，并核对来源基线。

来源库存、版本与代次必须可核对。新连接或 reload 后先确认实例和当前 Session，再恢复历史/live/执行/交互等基线；不从日志文字、屏幕 spinner、心跳或旧持久快照复活当前状态。不承诺失去原生确认后的自动重发或跨 Host 重启恰好一次执行。

Host 退出只断开 bridge，不结束用户 TUI。按 2026-10-29 用户明确要求，安装 Host 时默认登记 Orbis 插件；macOS 拖拽安装与便携包在首次打开应用时登记，无需 Relay 激活。电脑没有 Claude Code 时跳过，后续打开 Host 时重试；明确关闭的设置在更新时保留。此安装授权不包含升级 Claude Code、终止已有会话、重启 Host、push 或发版。

### 6. 纳入统一 Host 模型，不新增客户端原生分支

按 ADR-0032 完成 Claude 所需的来源 → Registry → 版本化同步 → App 镜像纵向链路；显式身份、统一 displayEntries、执行、交互、权限及能力必须从模型读取，不能只转发 Mods payload。其余领域明确 unknown/unavailable。

原生 Session 仍是持久历史权威，Host 只保存有界当前投影与页缓存。正式协议变更按 ADR-0032 硬版本切换，Host/App 配套更新。Relay 保持密文转发，不承担 Claude 会话语义。

### 7. 实施记录（2026-10-29）

- **历史权威**：Host 直接读取原生 transcript（`<CLAUDE_CONFIG_DIR 或 ~/.claude>/projects/*/<sessionId>.jsonl`），按 `uuid` / `parentUuid` 投影为标准条目，经 `RecoverableSessionSource` + `SessionSyncPreparer` 回答 `session.sync`，与 DSH 后端同一路径。`isMeta`、侧链（子 Agent）、附件、系统行不进主路径，但仍参与父链解析；多块 `tool_result` 拆成独立条目；空 thinking（仅签名）不显示；压缩摘要投影为 `compaction`。bridge 的 `session.append` 只通告行身份，正文以磁盘行为准，不从文本推断身份。`$.session.messages()` 在 v2.1.312 的测试环境无法取得返回形状，未采用。
- **实时内容**：`turn.step` 流式输出与工具事件进入会话源的 live 状态；回合结束后等待本回合通告的行全部落盘（上限 3 秒）再撤下流式副本，避免与 canonical 行重复。
- **插件登记**：安装 Host 默认调用 Claude 自己的 `claude plugin marketplace add <插件目录>` 与 `claude plugin install orbis-host-session-link@orbis-host --scope user`；Windows 安装器直接登记，macOS 拖拽安装与便携包在首次打开 Host 时登记。插件目录同时是本地 marketplace，Claude 原地加载，应用更新后重新打开 Host 时重新指向，不依赖 Relay 激活。未安装 Claude Code 时跳过；安装后重开 Host 会重试。设置“让终端里运行的 Claude Code 连接 Orbis”默认开启，关闭时 `uninstall` 并移除 marketplace，更新保留显式关闭。Windows 卸载器也移除插件；macOS 删除应用前可先关闭此项。原登记命令在 v2.1.312 隔离配置下实测通过。
- **客户端**：iOS / Android 新增 `claude` 身份（名称、配色、中性图形标记）、目录筛选；Claude 会话不提供附件入口，运行中发送直接按 follow-up 提交，不提供 Steer；新建会话列表不含 Claude（Host 的 `launchableAgents` 也排除它）。
- **仍未验收**：见 §8 末尾。

### 8. 对齐其他后端（2026-10-29）

依据目标构建（v2.1.312）加载插件后生成的类型声明，补齐 Pi/DSH 已有而 Claude 缺少的能力；每项只用公开接口，做不到的明确标为不可用。

- **会话目录与归档**：Host 扫描 `<config>/projects/<project>/<sessionId>.jsonl`（子 Agent 记录在更深一层，不算会话），每个文件只读头 64 KiB、尾 32 KiB，取目录、首条用户消息与标题（`custom-title` 优先于 `ai-title`）；按大小与修改时间缓存。Claude 没有归档，Host 把已归档会话 ID 记在自己的 `claude-archive.json`，不移动、不改写记录；在线会话拒绝归档。
- **从手机打开会话**：只能打开官方 TUI，不提供无界面执行（那等于 Agent SDK 后端，见“Alternatives not selected”）。macOS 用 Terminal.app 运行 Host 写入的一次性脚本，Windows 用 Windows Terminal，缺失时用控制台；其他系统报告不可用。脚本带 `ORBIS_CLAUDE_LAUNCH_ID`，插件在 hello 中回报，Host 据此确认打开的就是这个 TUI；60 秒未连上则如实报告（目录信任提示、版本）。用户未安装插件时只为这个 TUI 传 `--plugin-dir`，已安装时不传，避免同一进程跑两个 bridge。`launchableAgents` 只在能打开终端且找到 `claude` 时包含 Claude。
- **斜杠命令、模型、思考强度**：插件用 `$.command.list()` 上报命令；Host 隐藏会打开 TUI 面板、操作终端或账号、离开会话或计费的内置命令，其余（含技能与自定义命令）以可选参数提供给手机，经 `$.command.run` 执行，输出随回执返回。模型用 `/config` 的 `model` 行（`$.config.list()` 的选项、`$.config.set` 修改）；思考强度走 `/effort`。
- **运行时元数据**：模型（`$.session.model()`，显示名取自 `/model` 的说明）、上下文用量（`$.session.usage()`）、思考强度（设置中的 `effortLevel`）、标题；权限模式读自记录里的 `permission-mode` 行，只读展示——`$.config` 的 `permissionMode` 是“新会话默认值”，不能改当前会话，Mods 也没有切换接口。
- **工具卡片**：与 Pi/DSH 共用 ADR-0045 的工具摘要/库存/按需读取；正文从原生记录按 `tool_use_id` 读取。共享摘要函数补上 Claude 的 `Bash`、`file_path`、`Grep`/`Glob`。工具库存页必须带 `claude:<sessionId>` 作为 runtimeId（与会话 ID 不同）。
- **记录投影**：斜杠命令行显示为 `/name args`，本地命令输出与 `!` shell 运行显示为系统行，去掉 Claude 的标签与 ANSI 控制符。
- **压缩、附件**：`session.compact` 前后上报压缩活动；附件与 Codex/DSH 一样以“附件路径”追加到消息正文。
- **交互竞答（v2.1.312 实测）**：`PermissionRequest` Hook 等待手机期间，电脑上的原生对话框同时显示；电脑先回答后，插件上报的 `tool.finished`（按工具名与参数匹配 Hook 的 `tool_input`）或回合结束让 Host 关闭手机卡片并标为电脑端完成。`AskUserQuestion` 的 `PreToolUse` Hook 在等待期间会挡住原生问题界面，所以插件在状态行提示并注册 `/orbis-local`（`immediate`，回合中也能运行），把待答交互交回原生界面。插件转发工具参数前剔除 `agentId`、`requestMeta`、`consent` 等引擎保留字段。
- **可见的失败**：Host 拒绝 hello（版本、能力、bridge 版本）时写入诊断（同一原因十分钟一次）；插件在 TUI 状态行显示原因，并在 60 秒内不再重试。
- **v2.1.312 真实 TUI 验证**（`--plugin-dir`、Haiku，经真实 loopback HTTP 与 Host 桥）：握手与状态上报；手机消息产生真实回复并进入历史；手机批准权限；电脑先批准后手机卡片关闭；手机回答 AskUserQuestion；`/orbis-local` 收回问题后在电脑作答；停止运行中的回合；启动脚本新建会话、退出后出现在目录、再恢复并带回历史（脚本在伪终端中执行，未实际弹出 Terminal 窗口）。
- **仍未验收**：v2.1.287 最低版本；Windows 终端启动；Terminal.app 实际开窗；手机 App 实机界面；子 Agent 工具调用与本地停止后的竞答。当前会话权限模式不能从手机切换，运行中只能排队（没有 Steer），手机不能做 `/clear`、`/resume`、`/rewind` 之类改变会话或打开面板的操作。

### 9. 随 Host 自动安装插件（2026-10-29）

- Windows 安装器使用内置 Node 执行插件登记入口，卸载时执行移除；安装 / 更新读取桌面 `settings.ini`，保留显式关闭。
- macOS 拖拽安装与便携包在桌面 bridge 初始化时登记，尚未激活 Relay 也会执行。缺少 Claude Code 时跳过，登记失败记日志，后续打开 Host 或启动连接时可重试。一个 Host 进程成功登记后不在启动连接时重复执行。
- 桌面集成开关默认开启，主动关闭会卸载插件。原生 smoke 测试显式关闭自动登记，不改动测试者的 Claude 配置。
- 本机验证：TypeScript 类型检查与修改文件 lint 通过；Claude、桌面生命周期与 Pi 安装相关 60 项测试通过；macOS Qt 构建、4 组 CTest 和独立数据目录的原生 smoke 测试通过。
- 使用临时 HOME、配置目录和假 Claude CLI，实际运行编译后的安装入口与具有打包目录结构的桌面 bridge，验证自动安装、关闭保留、卸载、未安装 Claude、命令失败与参数错误。日志在忽略目录 `.scratch/claude-auto-*.log`。
- Windows 构建工作流增加真实安装器 / 卸载器调用假 CLI 的检查，同时核对插件文件入包和 smoke 测试不触发插件登记；本机未执行 Windows 安装器。

### 10. 桌面首页 Claude Code 入口（2026-10-29）

- 概览页新增“打开 Claude Code”，选择工作区后复用 `TerminalClaudeLauncher` 打开官方 TUI；已安装插件直接复用，缺少全局登记时仅为本次启动加载随包插件。
- 初始化与刷新 Agent 检测时独立探测 Claude 原生 CLI，并更新首页按钮和接入数量。Claude 不加入 Pi / Codex / DSH 的 npm 安装、批量更新或供应商管理。
- 工作台按钮随窗口宽度换行，原生 smoke 同时检查五个入口可见、位于窗口内且不相互重叠。

### 11. Host 重启后插件自动重连（2026-10-29）

- 修复插件保留旧 loopback 端口、请求失败后始终重试旧地址的问题。每次轮询重新读取发现文件，端口或 token 改变后使用同一原生 Session / 插件实例重新握手；短暂 HTTP 故障保留同一 Host 的连接代次。
- 握手串行化；请求绑定握手时的端点，旧请求和旧命令结果不能覆盖新连接。新代次重新发送会话状态，拒绝握手的退避只约束对应的端点与 token。Host 未启动、发现文件暂缺或正在重连时，在 Claude 状态行给出提示。
- 插件版本提升到 `0.1.1`。Claude 的重复 `plugin install` 不刷新已安装缓存，所以 Host 登记流程追加官方 `plugin update`，确保随 Host 更新的修复进入插件缓存；明确关闭仍保持关闭。已打开的旧版插件需要执行一次 `/reload-plugins` 或重启 Claude Code。
- 回归覆盖 Host 换端口 / token、发现文件暂缺、临时 HTTP 故障、握手拒绝、认证失效、过期代次与未完成命令隔离。原版不能通过新增重启用例；修复版通过官方插件测试。另以同一插件模块和真实、认证的 loopback HTTP 服务验证连续两次 Host 重建，不调用模型。

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
