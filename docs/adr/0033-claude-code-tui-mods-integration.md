# ADR-0033：通过 Claude Code Mods 双向接入官方 TUI

日期：2026-10-14

Status: accepted（接入方向已确认；Host/插件已对齐其他后端的主要能力并在 v2.1.312 真实 TUI 验证，v2.1.287 最低版本、Windows 终端启动和手机实机界面尚未验收）

关联：[ADR-0003](0003-runtime-owned-slash-command-menu.md)、[ADR-0021](0021-codex-terminal-host-attachment.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0031](0031-host-permission-management.md)、[ADR-0032](0032-host-owned-agent-state-model.md)。

## Context

电脑官方 TUI 与 Orbis 手机共同操作同一个原生运行实例，双端同步 Agent 领域事实与操作结果。

Claude Code 已公开 Mods：通过插件加载 JavaScript/TypeScript 函数，在 Claude Code 内部观察、改写或处理原生事件，并调用 Mods API。这为官方 TUI 内的 bridge 提供了公开扩展路径，但 Mods 本身不是现成的远程控制协议，也不自动保证完整状态恢复或原生交互竞答。

## Verified facts and sources

以下上游事实核对于 2026-10-14；2026-10-26 的较新版本验证另见下文。发布日期、文档接口与 Orbis 兼容性分别记录。

| 事实 | 官方来源 | 证据边界 |
| --- | --- | --- |
| CLI v2.1.287 正式加入 Claude Mods；更新说明为 `Added Claude Mods: plugins may now modify deeper behavior` | [v2.1.287 Release](https://github.com/anthropics/claude-code/releases/tag/v2.1.287)、[Release 元数据](https://api.github.com/repos/anthropics/claude-code/releases/tags/v2.1.287) | `published_at` 为 `2026-10-01T18:00:22Z`，即北京时间 2026-10-02 02:00:22；这是 GitHub Release 公开时间，不是最早内测或所有分发渠道的上线时间 |
| 官方要求终端使用 v2.1.287 或更新版本；Desktop 内置 Claude Code 从 v2.1.286 支持 Mods | [Mods overview：Turn mods on or off](https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off)、[Create a mod](https://code.claude.com/docs/en/plugins/mods/create) | Desktop 的起点不能用于降低 CLI/TUI 最低版本；早期存在 function hooks 开关，不据此承诺旧版支持 |
| Mods 可观察提示词、工具和回合，处理命令，读取会话并扩展界面 | [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview)、[Events](https://code.claude.com/docs/en/plugins/mods/events)、[Reference](https://code.claude.com/docs/en/plugins/mods/reference) | 当前 reference 以 v2.1.290 为描述基线，并包含明确标注更高版本的新增项；不能反推所有接口均在 v2.1.287 首发可用 |
| `$.prompt.submit({ text, asUser: true })` 可向当前会话提交用户输入，但等待 idle 后启动回合；`$.turn.abort`、`$.command.run` 等列于公开 API | [API：Start a turn from a background job](https://code.claude.com/docs/en/plugins/mods/api#start-a-turn-from-a-background-job)、[Reference：Mods API methods](https://code.claude.com/docs/en/plugins/mods/reference#mods-api-methods) | 不据此宣称原生 steer、follow-up、工作中队列或任意命令均支持；接口存在不证明停止范围、成功确认或交互完整性 |
| 目标版本加载 mod 后生成的类型声明是该构建的具体接口依据；声明及 API 可随版本变化 | [Create a mod：Get type definitions for your version](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build) | 当前网页和 GitHub 类型副本不能取代目标二进制的声明及运行验证 |
| Channels 是与 Mods 分开的公开 MCP 扩展机制：可向打开的 TUI 注入消息，双向 channel 可提供回复工具；声明 permission capability 后可 relay 工具审批 | [Channels](https://code.claude.com/docs/en/channels)、[Channels reference：Relay permission prompts](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts) | Research Preview；需要 claude.ai 或 Anthropic Console API key，受 Anthropic provider、组织策略和 allowlist 限制。工具审批通过短 `request_id` 与 `allow`/`deny` 回答，本地与远程先回答者生效；不覆盖 project trust、MCP server consent 或 AskUserQuestion。它不是 Mods resolver，也不提供完整 Host 同步协议 |
| 传统 Claude Code Hooks 与 Mods hooks 是两套接口。`PermissionRequest` 可对即将显示的工具权限请求返回 `allow` / `deny`；`PreToolUse` 可拦截 `AskUserQuestion` 并以 `updatedInput.answers` 提交答案 | [Hooks：PermissionRequest](https://code.claude.com/docs/en/hooks#permissionrequest)、[Hooks：PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) | `PermissionRequest` 输入含 `session_id`、`tool_name` 和 `tool_input`，但不含 `tool_use_id`；`PreToolUse` 有 `tool_use_id` 且会对每个工具调用运行。命令 Hook 默认等待上限为 600 秒。外部 UI/Host 可由 hook 进程同步等待并通过结构化 JSON 返回决策/答案；这是文档契约允许的实现方式，尚未在 v2.1.310 本机 TUI 实测。它不提供任意 TUI composer 输入接口 |
| Agent SDK 可枚举本地会话及读取 transcript 消息 | [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)、[TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript#listsessions) | `listSessions()` / `getSessionMessages()` 是 SDK 的 transcript API，不代表 Mods 可读取这些内容，也不证明能附着或控制既有 TUI 的同一实时执行实例 |
| Remote Control 将本机 Claude Code 会话连接到 Claude App / claude.ai | [Remote Control](https://code.claude.com/docs/en/remote-control) | 需要支持的 claude.ai 订阅登录；不支持 API key、非 Anthropic `ANTHROPIC_BASE_URL`、Bedrock、Google Agent Platform 或 Microsoft Foundry。它是官方客户端功能，不是面向 Orbis 的自定义 Host API |
| Mods 以用户权限运行、不受 Claude 的 Bash sandbox 隔离；可接触文件、凭据、进程及网络，但不能改变原生权限提示展示的内容 | [Mods overview：What a mod can reach](https://code.claude.com/docs/en/plugins/mods/overview#what-a-mod-can-reach)、[API：Reach files, processes, and the network](https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network) | bridge 按远程能力契约限定操作范围 |

2026-10-14 制定本 ADR 时未进行目标版本的插件加载、类型检查或真实 TUI 双向操作测试；以上链接只证明上游事实。2026-10-26 验证范围为 v2.1.310，沿用当前供应商配置完成类型检查、插件校验、模拟测试及部分真实 TUI 操作，详见[验证报告与独立探针](0033-claude-code-tui-mods-integration.md)。插件提交及真实回复、等待 idle 的排队、无工具主回合停止、过期停止拒绝、基础 clear/resume 和 idle reload 已观察；模型主动工具调用、原生交互回答及完整历史恢复尚未通过验收。这不是 Host/App 双向接入验收，也不改变 §2 的最低版本要求。官方网页会更新，实施时仍须逐版本记录生成类型和测试结果。

## Decision

### 1. 选择官方 TUI 内的 Mods bridge

官方 TUI 内的 bridge 连接本机认证 Host，同一原生实例承接双端操作。原生 Agent 持有执行与历史权威，backend 归一事实，Host 管理标准投影。Host 默认登记插件，用户可在设置中关闭。

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

### 2. 目标版本与兼容性

最低目标版本为 Claude Code v2.1.287；最低版本和实施版本分别取得兼容性证据。握手按实际版本、实例与已验证能力确认可用性，插件校验、类型检查和真实 TUI 操作分别记录结果。

### 3. 双向操作范围

接入覆盖原生身份、消息、历史、执行、交互、配置与恢复，各项能力按原生语义和验证状态发布。

| 领域 | 原生入口 |
| --- | --- |
| 会话与消息 | bridge 实例、原生 Session、prompt.submit 与 session.append |
| 历史与执行 | session.messages、turn 与 tool 事件、turn.abort |
| 审批与问题 | PermissionRequest / PreToolUse Hook，见 §4 |
| 命令与设置 | command、config、session API，权限契约见 ADR-0031 |
| 恢复 | 原生会话生命周期与来源代次核对 |

### 4. 审批保持原生语义

审批和问题通过官方 Hook 的结构化请求与响应作用于当前原生调用，回答由原生生命周期裁决。手机缺席或结果未知时保留原生处理和核对路径。

PermissionRequest 按 hook 进程关联请求；PreToolUse 处理 AskUserQuestion。当前 notes 类问题交由原生界面回答，远程 Hook 的真实 TUI 兼容性仍待验收。配置超时依次为 Host 570 秒、插件脚本 590 秒、Hook 600 秒。

### 5. 通道、安全与恢复边界

bridge 使用目标版本支持的公开接口连接认证 loopback，通过有界队列与来源核对恢复。Host 管理远程操作范围，TUI 保持自身生命周期。插件按官方安装机制登记，并保留显式设置。

### 6. 纳入统一 Host 模型

Claude 通过来源适配、Registry、版本化同步与 App 镜像接入统一模型；能力未知时明确声明。原生 Session 保持历史权威，协议兼容遵循 ADR-0064，Relay 承担密文路由。

参考：[ADR-0064](0064-protocol-compatibility.md)。

### 7. 实施记录（2026-10-29）

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。

### 8. 对齐其他后端（2026-10-29）

依据目标构建（v2.1.312）加载插件后生成的类型声明，补齐 Pi/DSH 已有而 Claude 缺少的能力；能力依据公开接口与实际兼容性发布。

- **会话目录与归档**：Host 扫描 `<config>/projects/<project>/<sessionId>.jsonl`（子 Agent 记录在更深一层，不算会话），每个文件只读头 64 KiB、尾 32 KiB，取目录、首条用户消息与标题（`custom-title` 优先于 `ai-title`）；按大小与修改时间缓存。Claude 没有归档，Host 把已归档会话 ID 记在自己的 `claude-archive.json`，不移动、不改写记录；在线会话拒绝归档。
- **从手机打开会话**：只能打开官方 TUI，不提供无界面执行（那等于 Agent SDK 后端，见“Alternatives not selected”）。macOS 用 Terminal.app 运行 Host 写入的一次性脚本，Windows 用 Windows Terminal，缺失时用控制台；其他系统报告不可用。脚本带 `ORBIS_CLAUDE_LAUNCH_ID`，插件在 hello 中回报，Host 据此确认打开的就是这个 TUI；60 秒未连上则如实报告（版本、策略或其他启动阻塞）；项目目录信任按 §14 在用户发起启动时处理。用户未安装插件时只为这个 TUI 传 `--plugin-dir`，已安装时不传，避免同一进程跑两个 bridge。`launchableAgents` 只在能打开终端且找到 `claude` 时包含 Claude。
- **斜杠命令、模型、思考强度**：插件用 `$.command.list()` 上报命令；Host 隐藏会打开 TUI 面板、操作终端或账号、离开会话或计费的内置命令，其余（含技能与自定义命令）以可选参数提供给手机，经 `$.command.run` 执行，输出随回执返回。模型用 `/config` 的 `model` 行（`$.config.list()` 的选项、`$.config.set` 修改）；思考强度走 `/effort`。
- **运行时元数据**：模型（`$.session.model()`，显示名取自 `/model` 的说明）、上下文用量（`$.session.usage()`）、思考强度（设置中的 `effortLevel`）、标题；权限模式读自记录里的 `permission-mode` 行，只读展示——`$.config` 的 `permissionMode` 是“新会话默认值”，不能改当前会话，Mods 也没有切换接口。
- **工具卡片**：与 Pi/DSH 共用 ADR-0045 的工具摘要/库存/按需读取；正文从原生记录按 `tool_use_id` 读取。共享摘要函数补上 Claude 的 `Bash`、`file_path`、`Grep`/`Glob`。工具库存页的 runtimeId 为 `claude:<sessionId>`。
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
- 握手串行化；请求绑定握手时的端点，结果按连接代次隔离。新代次重新发送会话状态，拒绝握手的退避只约束对应的端点与 token。Host 未启动、发现文件暂缺或正在重连时，在 Claude 状态行给出提示。
- 插件版本提升到 `0.1.1`。Claude 的重复 `plugin install` 不刷新已安装缓存，所以 Host 登记流程追加官方 `plugin update`，确保随 Host 更新的修复进入插件缓存；明确关闭仍保持关闭。已打开的旧版插件需要执行一次 `/reload-plugins` 或重启 Claude Code。
- 回归覆盖 Host 换端口 / token、发现文件暂缺、临时 HTTP 故障、握手拒绝、认证失效、过期代次与未完成命令隔离。原版不能通过新增重启用例；修复版通过官方插件测试。另以同一插件模块和真实、认证的 loopback HTTP 服务验证连续两次 Host 重建，不调用模型。

### 12. 运行中 follow-up 延后调用提交 API（2026-10-31）

- 故障现象：Claude 正运行时在 App 再发消息，聊天停在该消息并持续显示“发送中”。代码核对发现插件立即调用等待 idle 的 `$.prompt.submit`，同批多条消息还会并发进入该 API。Host 本来就会立即返回 `pending`，增加同类回执不能解决这个调用时机问题。
- 插件 `0.1.4` 将运行中的手机消息留在 Host 现有、有界且绑定 generation 的命令队列中；插件继续轮询、传递工具事件与处理停止。只在主回合结束、Host 完成轮末快照的 HTTP 确认之后，由下一次轮询提交。原生 `turn.start` 到达前也至多保留一个尚未返回的用户提交。子 Agent 完成不放行主回合的 follow-up；新 Host 不会收到旧代次留下的消息。
- 原生提交结果决定最终成功 / 失败；发送与对账沿用 ADR-0049 和 ADR-0051 V10 / V12 / V17。Steer 与可撤回能力仍未提供。
- Claude Code `2.1.314` 官方 `plugin test` 共 13 项通过（新增 5 项），覆盖忙时不调用提交 API、串行提交、停止与工具事件、子 Agent、轮末捕获屏障和代次隔离。前两个新增场景在修复前失败。插件 validate、目标构建生成声明的类型检查、仓库 TypeScript 检查和修改文件 lint 通过；相关 Host 5 个测试文件共 59 项通过。
- 证据目录：`.artifacts/ui-regression/20261031-claude-busy-send/`。以上是官方插件测试环境与 Host 单测，尚未复现 / 证明真实 TUI 的事件调度阻塞；真实模型、App 联动、两端设备全量与手动回归未验收。未重启或更新用户正在使用的 Host / Claude。

### 13. 模型回复的步骤身份与原子历史交接（2026-10-31）

- 修复流式 `${turnId}:${stepIndex}` 与原生 UUID 没有关联，导致同一正文同时存在于 live 与 canonical 的缺陷；同时修复轮末重放消息、旧轮异步清理误删新轮，以及迟到结束改变当前轮状态的问题。恢复 ADR-0051 V09 / V17 / V18，未新增 feature 或调整 UI 参数；工具呈现仍遵守 V20。
- 插件 `0.1.5` / bridge `3` 增加 `turn.step.identity` 能力、`turn.step.row`（写入前预留 UUID）与 `turn.step.finished`（步骤完整 UUID 集合）。只归属主循环 `door=response` 的 assistant 行，子 Agent、用户、工具结果不混入。一个步骤可对应多条持久行，不按正文、时间或数组位置推断身份。已核对 Claude Code `2.1.314` 的生成声明：`session.append.uuid` 是 pinned 稳定身份；下一主步骤或主回合结束是前一步追加集合的确认边界。
- 预留先于 `next(event)`，Host 暂缓发布该行及其后代，避免并发 sync 提前读到历史副本；在全部声明 UUID 落盘后，复用 `RecoverableSessionSource.reconcile` 的显式 mapping，在同一次事务中发布整组历史并撤下对应流式消息。多个步骤按顺序交接；空 / 签名隐藏的响应无需伪造可见行。步骤交接完成后释放适配器正文缓存，并按已完成身份处理迟到事件。
- 结束清理在第一次 await 前捕获本轮消息身份，仅撤下该集合；已报告但磁盘迟到的步骤在 3 秒等待到期后继续保留 live，后续 refresh 再交接。重复 start 不清空缓存；旧 turn.complete 不结束新轮。UUID 预留确认丢失时重新握手核对，旧流式步骤保留原 generation 归属。
- Host 与插件配套更新，bridge 3 提供所需身份事件，bridge 2 返回不兼容。已打开的旧插件需要执行官方 `/reload-plugins`。本任务没有更新或重启用户正在运行的 Host / Claude。
- 回归：`claude-transcript.test.ts`、`claude-mods-bridge.test.ts` 覆盖多 UUID、写入晚于边界、每帧无双份、跨轮清理、迟到 chunk / finish、重复 start 与旧 complete、超过等待期仍保留已声明步骤；官方插件测试覆盖主 / 子步骤隔离、下一请求和主回合结束的顺序。两端设备及手动验证、实际计数与限制见 `.artifacts/ui-regression/20261031-claude-output-identity/summary.md`；R18 对应真实联动检查，不把模拟通过扩大为设备验收。

### 14. 从 App 启动时登记所选项目的信任（2026-11-01）

- 从 App 启动 Claude 时，所选项目的启动准备包含目录级信任。两个真实 TUI 均停在 workspace trust 对话框，尚未执行插件 `session.start`；Host loopback 正常监听。App 启动操作授权所选项目，启动准备据此登记目录级信任。
- 采用官方 [Permissions / workspace trust](https://code.claude.com/docs/en/permissions.md#what-runs-before-you-trust-a-folder) 公开的 `projects["<path>"].hasTrustDialogAccepted=true`；默认文件为 `~/.claude.json`，显式 `CLAUDE_CONFIG_DIR` 下为该目录的 `.claude.json`，位置依据 [Claude directory](https://code.claude.com/docs/en/claude-directory.md)。这是项目内容信任，不修改工具权限模式、工具 allowlist、MCP 审批或 Mods 策略，不传 `--dangerously-skip-permissions`，不模拟按键。
- 路径先 realpath；仓库子目录使用 Git 根，linked worktree 使用主 checkout，嵌套仓库保留独立身份；清理继承的 `GIT_*`，Git 解析失败时停止启动。非仓库使用所选目录，不持久授权主目录或磁盘根目录。自定义配置目录同时传入一次性脚本，避免记录和 TUI 实际读取的配置不一致。
- 只合并目标项目的信任字段，保留未知字段、账号、MCP 与其他项目；已信任时不重写。Orbis 并发写入串行化，原子替换前复读检测原生进程修改并有限重试；损坏 JSON、错误结构或占用时报错且不开终端。此检测不宣称对不遵循 Orbis 锁的外部写入提供跨进程 CAS。现有配置符号链接保留。
- 关联 ADR-0051 V12、V17–V18：信任记录和终端启动均不冒充连接成功，仍等待真实 hello 才完成 App 的会话操作。未改手机画面、动画或状态投影。
- 验证：Host 六个相关测试文件 57 项通过，修改文件 strict TypeScript 与 ESLint 通过。Claude Code 2.1.316 + 已安装 Host / 插件 0.1.3 的真实 Terminal.app 启动进入原生 composer；`6418ae26-073b-4296-8109-9fefe5bd7c0e` 经 Host 返回 `stale_generation` 确认已登记（故意提供无效代次，不消费命令或延长租约）。修改后的启动器另在新建嵌套 Git 仓库中真实开窗，直接进入 composer，测试会话 `aca5bc3f-f271-40dc-8eb5-6290478a772a` 同样经 Host 确认登记；测试会话随后结束。只使用这些结果验证项目授权与连接，不据此声称 bridge 3 输出身份已交付。
- 证据：`.artifacts/ui-regression/20261101-claude-workspace-trust/`。Windows 真终端、双端 App L1–L4 / C01–C18 / A1–A4 尚未执行；未替换或重启当前 Host，通用启动器修改尚需随 Host 包交付。

### 15. 跨 Agent 启动准备扩展（2026-11-01）

[ADR-0056](0056-agent-startup-readiness-and-consent.md) 承接 §14，并扩展到 Pi / Codex / DeepSeek。Claude 增加具名项目 MCP 的本次临时授权（明确拒绝不覆盖）、登录状态预检、已识别插件 / 管理策略阻塞、启动失败取消等待及私有 settings 文件清理。目录信任函数本身仍只写 `hasTrustDialogAccepted`，不改变工具权限；MCP 的范围扩展由独立启动设置负责。桌面 setup 保留原生登录入口，手机账号授权 / OAuth / onboarding 的完整交互尚未实现。测试映射为 R29（目录信任；早期误用 R19）和 R30（跨 Agent）；实现文件、原生证据和未完成平台见 ADR-0056，不将源码完成写成安装包交付。

### 16. 首页交互基线独立发布（2026-11-02）

- 修复已打开 Claude 会话时首页连接胶囊长时间显示“同步失败”的初始化缺口：`announce` 原先只重播元数据与命令，完整 `interaction.snapshot` 直到 `session.sync` 完成才发布；首次统一状态读取因此得到 unknown 的交互领域，恢复依赖后续历史同步。
- `ClaudeBackend.announce` 对在线 Mods / Hook runtime 立即发布 Hook bridge 持有的完整待答清单，包括明确的空清单；新设备握手、首页读取 / 重试与历史同步完成共用此入口。离线 runtime 不发布空清单，已有审批保持原身份及等待状态。历史尚未读完不影响首页需要的 identity / execution / interactions；历史、发送与审批完成仍按原有权威回执确认。
- 恢复 ADR-0051 S18 / V16 / V18 的既有约束，不增加 feature、不调整 UI / 动效参数；ADR-0058 无新增交互家族或 MOT 参数。Host 适配器三场景在修改前均失败；修改后与加密设备通道首次读取回归通过。双端设备与完整门禁结果登记到 [测试规则](../../AGENTS.md#测试) 和 `.artifacts/ui-regression/20261102-claude-home-sync/`，未完成项不记为验收通过。需要随 Host 更新生效。

### 17. 长会话 resume 后历史停更（2026-11-03）

真实运行 Host 的只读加密探针确认：Claude 原生追加正常，Host preview 的 head / seq 却停留在恢复前；指定最新 head 时返回 `session_sync_model_rejected`。根因和共用 source 修复按 [ADR-0035 §17](0035-incremental-session-reconcile.md#17-超预算-canonical-批次转为-checkpoint-恢复2026-11-03)：首次恢复超过 256 条 canonical 条目时，经 unknown 边界和有界 checkpoint 收敛。此故障不依赖 Claude 的额度确认页，也不要求重新执行已收到的手机消息。

恢复 V09–V10、V16–V18 的既有同步契约；不改变 §13 的步骤身份和原子交接，不新增交互动效。`claude-transcript.test.ts` 覆盖 1,055 条恢复、继续追加与 Host 重开预览；`claude-history-fixture.mjs` 增加可选长前缀，既有 Android 真实加密 / 缓存 / 重连用例复用同一断言。验证、设备门禁与部署状态见 [测试规则](../../AGENTS.md#测试) 和 `.artifacts/ui-regression/20261103-claude-resume-sync/summary.md`。

### 18. macOS 启动脚本执行确认（2026-11-03，源码验证 / 未部署）

现场两次新建都生成了私有 `.command`，系统 `open` 已投递给 Terminal，但脚本仍存在且没有新增 Claude 进程；Host 在 60 秒后记录 `session.activate=failed`。未取得 Terminal 窗口内容，不能把原因定为登录、插件、权限提示或系统故障。原 Claude 进程与最新历史仍正常。

macOS 启动器等待 `open` 的退出结果（15 秒上限），再等待脚本在真实 TTY 执行后的私有回执（10 秒上限）。没有回执时清理本次脚本 / 临时设置并明确说明“Terminal 未确认执行 Claude Code 启动脚本”，取消相应 bridge 等待；回执仅证明脚本已运行，连接成功仍只认原生 hello。Windows 路径与 Codex 原有错误文案保持；不自动重试、不回答系统提示、不终止既有 TUI。

关联 V12、V16–V18 / R29–R30，沿用现有启动页与错误恢复，不新增交互或动效参数。单测、设备未跑项及现场限制见 [测试规则](../../AGENTS.md#测试) 和 `.artifacts/ui-regression/20261103-claude-resume-sync/launch-followup.md`；此补丁尚未部署，不能声明用户新建故障已修复。

### 19. 主回合与后台子任务（2026-11-03）

按 [ADR-0062](0062-claude-background-agents-and-session-activity.md) 实施独立任务库存、汇总活动与能力门禁。主回合 idle 不代表后台没有任务；仅过滤普通会话列表不足以修复。`agent.list()` 为库存来源，主回合结束不清任务，未知库存不冒充空闲；非交互子执行不发布普通会话。S26 / R61 的设备与真实隔离 TUI 门禁待完成。

### 19. 同一原生实例重新握手时保留流式来源（2026-11-06）

CLAUDE-LIVE-01：同一 instance、Session、配置目录和工作目录重新握手时，Host 保留实时来源、活动步骤、UUID 预留及完成身份；HTTP generation 重新分配，旧命令结果按原规则终结为未知。来源回调按历史拥有者核对，新连接通过可选 `resumed` 回执转接当前步骤，旧代次与其他原生实例继续隔离。内置插件版本为 0.1.7；该转接依赖 Host 明确确认保留了内存来源，完整 Host 进程重建仍按原生历史恢复。

实现与回归见 [claude-mods-bridge.ts](../../packages/host/src/claude-mods-bridge.ts)、[claude-mods-bridge.test.ts](../../packages/host/src/claude-mods-bridge.test.ts)、[register.ts](../../packages/claude-mod/src/register.ts)、[reconnect.test.ts](../../packages/claude-mod/tests/reconnect.test.ts)。自动结果与合成复现证据见 [verification.json](../../.artifacts/backend-stream-fix-20261106/verification.json)。尚未部署；更新 Host 及内置插件后，Android 真机待用户验证。

## Alternatives not selected

- **Agent SDK 执行后端**：适合独立管理会话，但不能替代附着到用户正在操作的 TUI；不作为自动回退。
- **并发 resume / 只读 transcript**：历史相同不证明运行实例相同；只读原生历史可辅助核对，但不能作为操作通道。
- **Channels 或普通 MCP 单独接入**：Channels 官方支持向运行中的 TUI 推送消息、双向回复及有条件的工具审批 relay；它仍不提供完整历史、运行态、停止和 Orbis Host/App 同步契约。Remote Control 是 Anthropic 官方 App 的远程客户端能力，不用其未公开的内部协议构造 Orbis 客户端。
- **终端屏幕抓取、按键注入或修改 Claude 二进制**：不作为主方案或能力缺失时的隐式回退。

## Verification and consequences

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。
