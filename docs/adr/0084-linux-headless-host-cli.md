# ADR-0084：Linux 无头 Host CLI 与 Agent 适配

日期：2026-11-19（America/Los_Angeles）

Status: accepted（开始实施；尚未完成 Linux 构建、打包、部署及手机端验收）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0021](0021-codex-terminal-host-attachment.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)、[ADR-0056](0056-agent-startup-readiness-and-consent.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0072](0072-session-configuration-and-recoverable-launch.md)、[ADR-0075](0075-host-confirmed-exit-and-update.md)、[ADR-0077](0077-cli-host-and-headless-validation.md)、[ADR-0078](0078-linux-desktop-host.md)。

## 问题与目标

现有 Host CLI 能启动 Host、打印配对二维码和列出设备，但不是已发布的独立命令，也没有完整覆盖 Linux 首次配置、常驻管理和 Agent 后端组合。Pi、Codex、Claude 与 DeepSeek 系列后端的启动入口和无头语义并不一致；CLI Host 进程能在 Linux 运行，不代表手机可以在无桌面服务器上创建并控制所有 Agent 会话。[F01–F04]

目标是在没有 X11 / Wayland、桌面终端或交互式 stdin 的 Linux 服务器上运行 Orbis Host。用户以现有 Orbis 手机 App 配对、浏览会话、创建或恢复会话，并使用所有适用于服务器的 Agent 后端。Host 仍通过现有 Relay、LAN、HostService 与移动端协议工作；CLI 是部署和生命周期入口，不另造一套手机协议或会话语义。

本 ADR 将“所有 Agent”限定为 Host 当前注册的 AgentKind 中可在服务器进程内启动或接入的后端。`codexDesktop` 和 `dshDesktop` 代表独立桌面产品，不能在没有该产品桌面进程时伪装成 CLI Agent；无头 Host 必须准确报告其不可用。其它 AgentKind 的无头支持须逐项落实并验证，不因现有共享 Agent 接口而自动视作已支持。

## 源码现状

基于当前 worktree 基线 `8b087de9` 的本机源码检查；本 ADR 阶段没有执行 Linux 构建、启动真实 Agent、调用模型、连接线上 Relay、操作设备或读取用户凭据。既有 CLI 调研详见 ADR-0077，本次结论只记录与 Linux 无头交付直接相关的事实：

| ID | 已确认事实 | 代码依据与影响 |
| --- | --- | --- |
| F01 | Host 命令实现位于 `packages/host/src/cli.ts`，目前包为 private、未声明可安装 `bin`；CLI 组合与桌面运行时组合不同。 | [packages/host/package.json](../../packages/host/package.json)、[cli.ts](../../packages/host/src/cli.ts)。新增命令入口须复用 Host 核心，不应继续复制桌面装配逻辑。 |
| F02 | AgentKind 当前包含 `pi`、`codex`、`codexDesktop`、`dsh`、`claude`、`dshDesktop`。Pi 的 `SessionSpawner` 已有 RPC 无头路径；Codex 有 app-server，但部分开窗开关与协议 `spawnMode` 回执不一致。 | [agent-state.ts](../../packages/protocol/src/agent-state.ts)、[spawner.ts](../../packages/host/src/spawner.ts)、[codex-runtime.ts](../../packages/host/src/codex-runtime.ts)。新建与恢复必须报告实际启动模式。 |
| F03 | Claude 后端以 TUI + Mods / Hook 接入为核心，Linux 没有可用的官方终端开窗路径或现成的无头启动后端。 | [agent-backend.ts](../../packages/host/src/agent-backend.ts)、[claude-launcher.ts](../../packages/host/src/claude-launcher.ts)。不能把 TUI 启动失败当作支持无头，也不能用一次性输出替代手机端可持续控制的会话。 |
| F04 | DSH CLI / Web、Codex Desktop 和 DSH Desktop 具有不同的进程所有权及停机语义；CLI 当前仅按选项预启部分后端，同时仍探测桌面集成。 | [dsh-runtime.ts](../../packages/host/src/dsh-runtime.ts)、[dsh-web-runtime.ts](../../packages/host/src/dsh-web-runtime.ts)、[cli.ts](../../packages/host/src/cli.ts)。必须明确每个后端由 Host 启动、接入还是仅报告不可用，并按所有权收尾。 |

## 决策

### 运行形态

1. Linux CLI 以前台进程作为唯一 Host 实例入口，支持无 TTY 启动并处理 SIGINT / SIGTERM；systemd 等进程管理器可直接托管前台命令。首阶段不做 GUI、不要求调用 CLI 的操作者提供 TTY，也不实现安装向导或自守护进程；个别原生 Agent 若只支持交互式 CLI，可由 Host 为该 Agent 单独拥有受控 PTY，不能依赖服务器桌面窗口。
2. CLI 命令具备稳定的参数、退出码和 stdout / stderr 分工。交互式配对可显示终端二维码；非交互部署提供脚本可消费的配对载荷输出。所有日志和诊断写 stderr，机器输出写 stdout；凭据、二维码载荷和 token 不进入普通日志或 argv。
3. Host 激活凭据由显式配置 / 环境注入或当前用户私有状态文件提供。若落盘，创建目录与文件时限制为当前用户访问并采用原子写入；不宣称普通文件等同于钥匙串加密。密钥不得通过命令行参数传递。
4. 默认状态目录按 Linux 用户隔离，支持显式 `--state-dir`；并发启动必须拒绝共享相同 Host 身份，配对、撤销与状态查询不得通过第二个 Host 实例争抢 Relay 身份。
5. Linux 安装包 / 归档携带匹配架构的 Node 运行时和 Host 生产依赖，提供清晰版本与校验信息。首发架构以实际构建和目标机验证为准；不把当前开发机 `node_modules` 或交叉编译产物视作可发布包。系统服务 unit、升级和自动回滚另行验证。

### Agent 能力

无头 Host 将后端显式分为“可启动 / 可接入 / 不适用 / 不可用”，向手机发布真实就绪与原因。手机创建、恢复时继续遵守 ADR-0056 / ADR-0072 的启动确认和首句仅一次语义；`auto` 在服务器环境选择可用无头模式，显式 `tui` 不得静默降级为无头。

| AgentKind | 无头目标 |
| --- | --- |
| `pi` | 使用 RPC / stdio 控制，不依赖终端窗口；覆盖新建、恢复、输入、事件、审批、历史和有序退出。 |
| `codex` | 以 app-server 作为可持续控制通道；`headless` 回执必须与真实进程形态一致，覆盖认证、sandbox、配置、输入、审批、会话恢复和退出。 |
| `claude` | Linux 首阶段通过 Host 拥有的 tmux PTY 启动官方交互式 CLI，由现有 Mods / Hook 桥接手机；Host 与操作者无需 GUI / TTY。无 tmux、Claude 登录或插件握手失败时如实报告不可用。一次性 `-p` 输出不视为等价实现。 |
| `dsh` | 支持 Host 可拥有的 CLI / ACP / Web 服务模式；区分 Host 启动的服务与用户预先运行的服务，停止 Host 时只关闭归属明确的进程。 |
| `codexDesktop` | 仅接入实际存在并可连接的桌面产品进程；无头服务器没有该进程时报告不适用，不尝试打开桌面应用。 |
| `dshDesktop` | 仅接入实际存在并可连接的桌面产品进程；无头服务器没有该进程时报告不适用，不尝试打开桌面应用。 |

后端能力及原因通过现有 Host 状态 / 诊断路径表达。若需新增协议字段，按 ADR-0064 验证旧 Host、旧 Relay 和旧 App 的解析、注册帧、后续更新、重连及回退；不以相同协议版本号或可选字段为兼容证明。

### 实现边界

- 先抽取可由 CLI 与桌面共同使用的 Host 服务组合 / 生命周期入口，再让 CLI 注入 Linux 无桌面运行策略；不另建平行 HostService。
- Agent 适配器必须保留原生 Agent 的身份、历史、配置确认、权限 / 问卷交互和工具语义。缺少上游能力时如实报告，不静默吞掉请求或合成成功回执。
- Linux 路径不得调用 Qt、桌面终端启动器、浏览器自动开窗或图形凭据服务；Agent 私有 PTY 不能暴露为桌面窗口。确需外部用户界面的流程必须有 CLI / 手机可完成的替代方式，否则声明为阻塞能力。
- 首阶段不改变 Relay 身份模型、加密传输、移动端会话模型或现有 Windows / macOS 启动行为；共享抽象变更需用原有桌面测试做回归。

## 验证与准入

以下均为实施验收条件，不代表已经通过：

| 阶段 | 最小充分验证 |
| --- | --- |
| V1 CLI 契约 | 从发布入口验证 `--help`、配置校验、前台常驻、机器输出、退出码、无 TTY / stdin、信号收尾、重复实例保护、凭据脱敏及运行中配对 / 撤销。 |
| V2 无头主机 | 在干净 Linux x64 环境清除 `DISPLAY`、`WAYLAND_DISPLAY`，无 GUI 与交互式终端，仅凭 CLI 完成激活 / 配对 / Host 启动；Host 连续运行期间手机可连接、断线重连，状态和会话保持。 |
| V3 Agent 矩阵 | 对每个服务器型 AgentKind 使用隔离 HOME、状态目录和项目，验证缺依赖 / 缺认证、创建 / 恢复、配置确认、首句仅一次、消息 / 事件、权限审批、取消、错误终态、Host 重启和进程归属。Desktop 类型验证其被准确标记为不适用。 |
| V4 移动端闭环 | 使用真实手机 App 连接候选 Host，完成会话目录、新建 / 恢复、输入、审批、状态同步和重连；按 ADR-0064 用近期实际发布版本验证兼容、限制与回退，保留同版正对照。 |
| V5 发行产物 | 在干净目标机解包运行自带运行时归档，核对架构、运行库基线、文件权限、依赖、许可证、版本 / 校验信息和退出清理；确认运行不需要源码仓库、全局 Node、桌面会话或图形库。 |

真实模型调用、线上 Relay、正式发布及用户服务器安装均须另行授权 / 验收；在证据完成前，支持状态标为“待验证”，不宣称已交付。

## 实施 Ticket 拆分

各 ticket 独立验证并单独提交；后续 ticket 只在前置契约稳定后开始。提交信息包含对应 ID。

| Ticket | 范围 | 交付边界 |
| --- | --- | --- |
| `LINUX-HOST-CLI-01` | CLI 产品入口与 Linux 前台 Host 生命周期 | 安装后可调用的命令、无 TTY 启动 / 信号退出、配置与输出契约、避免启动桌面专属集成。 |
| `LINUX-AGENT-HEADLESS-02` | Pi / Codex / DSH 的 Linux 无头模式 | 后端默认与回执准确、没有终端窗口依赖、桌面 Agent 不适用状态明确。 |
| `LINUX-CLAUDE-HEADLESS-03` | Claude Code Linux 无头接入 | Host 托管 PTY、已有 Mods / Hook 桥接、tmux / 插件 / 登录缺失有明确失败。 |
| `MOBILE-SPAWN-AUTO-04` | Android / iOS 启动模式协商 | 普通新建、恢复与配置式创建默认请求 `auto`，保留显式模式及兼容测试。 |
| `LINUX-HOST-PACKAGE-05` | Linux 可部署产物 | 自带匹配 Node 运行时的归档、版本 / 校验及干净机器启动说明。 |
| `LINUX-HOST-VERIFY-06` | Linux 到手机端完整闭环验证 | 隔离 Host / Relay / Agent 验证、跨版本核对与用户手动验收准备；真实部署另行授权。 |

## 当前实施状态

本 ADR 与 ticket 顺序已在提交 `e3ba2ece`（`LINUX-HOST-CLI-00`）记录。`LINUX-HOST-CLI-01` 已实现 CLI bin 声明、Linux 无桌面平台策略、前台启动的信号监听 / 清理，以及桌面专属后端抑制；完成源码构建、定向测试、CLI help 与 npm pack dry-run 核对。证据只证明当前 macOS 开发环境中的编译 / 静态 CLI 入口，不证明 Linux 原生运行、打包部署或手机闭环。Agent 适配、移动端模式、Linux 发行包和完整闭环 ticket 尚未完成；用户安装验收仍待完成。
