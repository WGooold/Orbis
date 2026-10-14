# ADR-0033：通过 Claude Code Mods 双向接入官方 TUI

日期：2026-10-14

Status: accepted（接入方向已确认；bridge、兼容性验证及运行环境迁移尚未实现）

关联：[ADR-0001](<0001-pi-runtime-control-boundary.md>)、[ADR-0003](<0003-runtime-owned-slash-command-menu.md>)、[ADR-0021](<0021-codex-terminal-host-attachment.md>)、[ADR-0025](<0025-native-history-authority-and-versioned-caches.md>)、[ADR-0026](<0026-host-selected-session-sync.md>)、[ADR-0031](<0031-host-permission-management.md>)、[ADR-0032](<0032-host-owned-agent-state-model.md>)。

## Context

用户要求的是：电脑保留 Claude Code 官方 TUI，Orbis 手机与这个 TUI 双向操作同一个原生运行实例。电脑提交的消息、回复、工具、运行状态及交互必须同步到手机；手机提交的消息、停止和交互回答必须作用于这个实例，并在电脑上体现原生结果。

另起 Agent SDK 执行器、并发 resume 同一会话、只同步持久历史，均不满足这个要求。Orbis 也不因此成为终端模拟器、远程桌面或通用进程管理器；同步对象是 Agent 领域事实和操作，不是屏幕像素、ANSI 输出或每次按键。

Claude Code 已公开 Mods：通过插件加载 JavaScript/TypeScript 函数，在 Claude Code 内部观察、改写或处理原生事件，并调用 Mods API。这为官方 TUI 内的 bridge 提供了公开扩展路径，但 Mods 本身不是现成的远程控制协议，也不自动保证完整状态恢复或原生交互竞答。

## Verified facts and sources

以下事实核对于 2026-10-14。区分“上游正式发布事实”“当前文档描述的接口”与“Orbis 实际兼容性”，不把三者混为一谈。

| 事实 | 官方来源 | 证据边界 |
| --- | --- | --- |
| CLI v2.1.287 正式加入 Claude Mods；更新说明为 `Added Claude Mods: plugins may now modify deeper behavior` | [v2.1.287 Release](<https://github.com/anthropics/claude-code/releases/tag/v2.1.287>)、[Release 元数据](<https://api.github.com/repos/anthropics/claude-code/releases/tags/v2.1.287>) | `published_at` 为 `2026-10-01T18:00:22Z`，即北京时间 2026-10-02 02:00:22；这是 GitHub Release 公开时间，不是最早内测或所有分发渠道的上线时间 |
| 官方要求终端使用 v2.1.287 或更新版本；Desktop 内置 Claude Code 从 v2.1.286 支持 Mods | [Mods overview：Turn mods on or off](<https://code.claude.com/docs/en/plugins/mods/overview#turn-mods-on-or-off>)、[Create a mod](<https://code.claude.com/docs/en/plugins/mods/create>) | Desktop 的起点不能用于降低 CLI/TUI 最低版本；早期存在 function hooks 开关，不据此承诺旧版支持 |
| Mods 可观察提示词、工具和回合，处理命令，读取会话并扩展界面 | [Mods overview](<https://code.claude.com/docs/en/plugins/mods/overview>)、[Events](<https://code.claude.com/docs/en/plugins/mods/events>)、[Reference](<https://code.claude.com/docs/en/plugins/mods/reference>) | 当前 reference 以 v2.1.290 为描述基线，并包含明确标注更高版本的新增项；不能反推所有接口均在 v2.1.287 首发可用 |
| `$.prompt.submit({ text, asUser: true })` 可向当前会话提交用户输入，但等待 idle 后启动回合；`$.turn.abort`、`$.command.run` 等列于公开 API | [API：Start a turn from a background job](<https://code.claude.com/docs/en/plugins/mods/api#start-a-turn-from-a-background-job>)、[Reference：Mods API methods](<https://code.claude.com/docs/en/plugins/mods/reference#mods-api-methods>) | 不据此宣称原生 steer、follow-up、工作中队列或任意命令均支持；接口存在不证明停止范围、成功确认或交互完整性 |
| 目标版本加载 mod 后生成的类型声明是该构建的具体接口依据；声明及 API 可随版本变化 | [Create a mod：Get type definitions for your version](<https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build>) | 当前网页和 GitHub 类型副本不能取代目标二进制的声明及运行验证 |
| Mods 以用户权限运行、不受 Claude 的 Bash sandbox 隔离；可接触文件、凭据、进程及网络，但不能改变原生权限提示展示的内容 | [Mods overview：What a mod can reach](<https://code.claude.com/docs/en/plugins/mods/overview#what-a-mod-can-reach>)、[API：Reach files, processes, and the network](<https://code.claude.com/docs/en/plugins/mods/api#reach-files-processes-and-the-network>) | bridge 必须自行约束远程操作，不把 Mods 的机器权限直接授予手机 |

本 ADR 未进行目标版本的插件加载、类型检查或真实 TUI 双向操作测试；以上链接证明上游事实，不构成 Orbis 兼容性验收记录。官方网页会更新，实施时须记录确切 CLI/bridge 版本、生成类型和测试结果；引用后续接口时补充其版本依据。

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
| 审批与用户问题 | 同步原生待回答请求，允许电脑或手机回答，并确认另端结束；必须验证稳定请求 ID、取消、有效期、竞答和重连恢复。`$.session.authorize` 及问题相关入口只是候选，不据名称推断支持全部原生弹窗 |
| 命令、模型和权限 | 仅发布能原生执行并确认结果的操作。候选为 `$.command`、`$.config`、`$.session`；权限使用 ADR-0031 的 opaque 设置契约，不通过手机解析 CLI 文案或权限模式 |
| 生命周期与恢复 | 覆盖 `/clear`、`/resume`、分支、压缩、mod reload 和连接恢复；旧会话命令及回调不能写入新会话。不能假设每次切换都会再次触发 `session.start` |

双向同步不要求两端共享未提交草稿、光标或相同界面布局。工作中输入必须按原生实际投递语义表达；不能把等待 idle 的 `prompt.submit` 包装成即时打断或 Pi steer。仅实现消息收发的阶段性成果可标实验性部分能力，不得宣布本 ADR 的完整 TUI 接入已完成。

### 4. 审批保持原生语义

优先使用能对既有原生请求回答的公开接口，保持电脑 TUI 的审批及问题操作。不得用 `tool.check` 自动 allow、跳过权限或制造另一套插件审批，冒充原生双端同步；不得因手机掉线、Host 重启或 hook 超时自动批准。

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
- **Channels 或普通 MCP 单独接入**：可用于消息推送/工具集成，不据此证明完整历史、运行态、停止及交互双向同步。
- **官方 Remote Control 的私有协议**：未采用未公开的自定义客户端契约，不依赖逆向其云端链路。
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
