# ADR-0056：所有 Agent 的启动准备与首次授权

日期：2026-11-01

Status: accepted（用户授权实施；实现与验收结果随本任务更新，未完成项不记为交付）

## 问题

从 App 选择目录并启动 Agent 后，原生终端可能停在项目信任、插件许可、初始化或认证步骤；连接尚未建立，运行时交互转发也尚未可用。Claude 已实际复现，Pi 的项目资源信任同样发生在 session_start 之前。仅修改 Claude 项目信任不能代表其他 Agent 已覆盖。

## 决策

### 1. 统一边界

- 覆盖 Pi TUI / RPC、Codex TUI / app-server / Desktop、Claude TUI、DeepSeek ACP / Web；包括新建、恢复和桌面工作台入口。扫描目录、发现已有会话、后台同步不触发授权。
- 用户选择具体目录并点击启动，授权该次启动加载该目录的原生项目配置及 Orbis 自有集成。优先使用原生、进程级参数；必须持久化时只写所选项目并保留其他配置。不得给根目录、主目录或全部未来项目登记全局信任。
- 项目授权不等同于运行中工具审批、第三方插件安装、MCP OAuth、账号登录、组织策略豁免或操作系统授权。这些步骤若原生提供公开交互接口，应经已有交互路径回答；缺少接口时准确报告缺口，不假造批准记录、不用键盘注入或取消 sandbox 填补。
- 不能把“成功启动进程”“写入信任”“打开窗口”当作 Agent 已就绪。既有原生 hello / initialize / session 响应仍是权威；拒绝、初始化失败和超时要有明确原因，不留下无限等待。
- 保留当前权限模式、工具审批和 sandbox。禁止通过统一加 `--dangerously-skip-permissions` / `--yolo` / `approval=never` 实现无首次阻塞。

### 2. 各后端契约

| 后端 | 项目授权 | 其他首次步骤 / 成功证据 |
| --- | --- | --- |
| Pi | 用户发起启动使用公开 `--approve`，仅本进程有效，TUI/RPC 一致 | Orbis 扩展通过显式 `-e` 加载；账号/MCP OAuth 保留原生授权，loopback ready 后才连接成功 |
| Codex | 使用公开项目 trust_level 配置，限定所选目录；remote TUI 通过 app-server 配置接口处理相同配置上下文 | app-server initialize / thread 响应为准；Desktop 既有账号和组织策略不可冒认，工具交互沿用已有转发 |
| Claude | 沿用 ADR-0033 §14 的项目级信任；启动参数固定实际配置目录；对本次项目 `.mcp.json` 中具名服务器传临时 `enabledMcpjsonServers`，保留显式拒绝 | 启动前读取原生 `auth status --json`，缺登录直接失败；明确的桌面 setup 入口仍允许原生登录。插件禁用 / 已识别管理策略直接报告；其他未知初始化仅能按 hello 截止时间报错 |
| DeepSeek ACP / Web | 通过公开服务 / session API 创建恢复，原生协议入口没有终端目录信任页 | initialize、服务认证和 session 返回为准；工具 / 问卷通过已有 interaction 转发；拒绝或配置缺失明确失败 |

#### 2.1 App 请求会话时按需启动后端

- `device.ready.agents` 只表示现在已经握手就绪；`launchableAgents` 表示 Host 能在会话请求时启动或接入。新建页按后者允许选择，不要求用户先在桌面设置中预启动后端。
- 用户请求新建或恢复时，Host 先复用已就绪连接；未就绪时才确保对应后端、等待原生握手，再执行会话操作。并发请求共用同一次后端准备；进程启动 / 窗口打开本身不算成功。
- DeepSeek Web 通过服务描述复用已运行服务，没有可用服务时 Host 才启动本机 DSH Web，再接入并创建会话。Codex Desktop 已接入时直接控制；否则 Host 打开 GUI 并等待 app-server 端点与握手后再创建会话。
- `orbis host --dsh` 与桌面 Host 的 DeepSeek 预启动设置只控制启动时是否提前准备，不再决定 App 是否能发起 DSH 会话。`--codex` 只控制 Codex 终端后端；Codex Desktop 按自身安装 / 接入状态独立提供。
- 2026-11-05 补齐已有 DeepSeek Web 服务自动恢复接口：桌面与 CLI Host 启动后立即探测，每次完成后 2 秒再查；只认证当前显式 endpoint 或同 home 的有效 descriptor，不启动缺席服务、不写凭据、不新建 / 重放会话。已就绪桥接复用；连接终止后重新读取服务与认证信息。与 App 显式启动共用在途准备，空探测 / 探测失败不吞掉 App 请求；暂停时关闭入口并等待、清理迟到客户端。会话发现与冷历史边界按 ADR-0020；源码验证与设备门禁分别记录。
- 未安装、配置缺失、接入失败或等待超时都通过会话失败回执说明；Host 不先把会话显示为已连接，也不自动重复创建会话。`launchableAgents` 仅在本机组件可用时包含对应类型。

macOS Claude 开窗回执补充（2026-11-03）：按 [ADR-0033 §18](0033-claude-code-tui-mods-integration.md#18-macos-启动脚本执行确认2026-11-03源码验证--未部署)，`open` 进程 spawn / 成功退出都不能单独证明终端脚本已执行；须有真实 TTY 启动回执，再等待原生 hello。未执行 / 超时明确失败并清理本次文件，保留既有会话与系统授权边界；源码验证不代表现场新建恢复。

### 3. 兼容与失败

- 使用目标构建的公开接口与类型，不写猜测字段；版本不支持时明确失败。
- 启动前失败不能遗留新的会话或虚假的 pending 启动登记；恢复不得修改其他会话权限。
- 配置有损坏、写入冲突或策略拒绝时保留原文件并向调用方报错。自定义 HOME / Agent 配置目录需传入实际 TUI，不能写一处读另一处。
- 不自动回答未知的第三方启动对话框。新增 Agent 必须补充本表与测试，否则不能声明首次启动完整支持。

## UI 关系

关联 ADR-0051 V12、V16–V18 和 S16：完成与失败必须真实、作用域隔离。优先复用现有错误回执 / 交互界面；若后续加入启动前审批面板，须单独补协议、两端实现和设备回归。不得把只有 Host 测试通过写成设备门禁通过。

## 验证计划

1. 每种后端新目录启动、恢复、已有信任、显式禁用、配置错误、自定义配置目录。
2. 检查所有生产启动入口；Pi 两种模式、Codex remote 与独立 TUI、Claude 桌面与手机、DSH 两个协议均有对应测试。
3. 核对目标目录、argv、配置字段、调用顺序与握手，确保不改运行中工具审批、不自动批准第三方授权。
4. 真实原生启动 smoke 与移动端完整回归分别记录。构建 / 模拟通过不能替代真实账号、Windows 或设备验证。

## 实施与结果

### 源码实施

- `packages/host/src/agent-startup.ts`：Pi 的公开 `--approve` 接入 TUI / RPC 及桌面入口，只对本进程生效；Codex 独立 TUI 用进程配置，remote TUI 用实际 app-server 的 `config/read` / `config/batchWrite`，仅写所选目录的 `trust_level`。配置写入失败不登记 pending；新建 thread 前先处理需要持久化的授权。
- `claude-startup.ts` / `claude-launcher.ts`：读取当前配置目录、cwd 项目设置、适用的 Git 主 checkout local 设置和文件型 managed settings。正确读取 `pluginConfigs["cc-plugin-sec-default@builtin"].options.allowManagedModsOnly`；对管理范围无法确认的 Orbis mod 保守报错，不豁免策略。`allowManagedHooksOnly` 要求管理配置启用 Orbis 插件。
- 项目 MCP 决策：本次用户启动授权已声明的具名服务器，排除 `disabledMcpjsonServers`；仅用私有临时 settings 文件传递，退出 / 开窗失败清理，不写 `enableAllProjectMcpServers`，不批准 OAuth，不更改工具权限。无项目 MCP 时不附加设置。此行为扩展早期仅处理目录信任的范围。
- Claude 登录预检只读取状态，不输出原生账户详情；明确桌面 setup 保留原生登录 / 初始化入口，手机启动缺登录时不打开等待登录的终端。失败取消 `ClaudeModsBridge` 等待；真实 hello 才完成手机会话启动。
- `dsh-client.ts`：initialize 期间收到无处理器的原生交互请求时拒绝并中止准备，避免仅等到超时。ACP / Web 现有服务认证、session API 及运行中审批继续由原适配器负责。
- `macos-agent-terminal.ts`：桌面 Pi / Codex 使用私有、自删 `.command` 文件和系统 `open`，避免为开终端请求 Apple Events 自动化授权；只写明确允许的非凭据环境字段，不复制全部 Host 环境。

### 验证与交付边界

- 提交前隔离复核：仅导出本次暂存内容，Host / DesktopRuntime / 后端生命周期共 74 项通过、2 项 Windows 条件未运行，lint 通过。该快照与提交前主线 `eafee84` 的独立 `npm run typecheck` 均在 `packages/pi-extension/src/index.ts:514` 报同一个 `RuntimePort.inputState` 缺失错误；完整共享工作树的较早类型检查通过不能代替本次提交快照通过。未把其他任务的 RuntimeBridge 修改并入本提交；日志见 `.artifacts/ui-regression/20261101-agent-on-demand/commit/`。

- App 按需启动专项（r30，手动编号 R32；R31 保留给最近提问提示）：Host / DesktopRuntime 61 项通过，含两类 runtime 已接入时不调用启动回调的加密链路回归；Codex Desktop / DSH Web 生命周期 13 项通过，2 项 Windows 条件用例未运行。类型检查、lint、Android 571 JVM 与 Swift Core 237 项通过。iPhone 17 全量 67 项为 55 通过 / 12 失败，其中新增 DeepSeek 用例因原生合并辅助功能标签定位错误而失败，修正测试定位后新建页整组 2 项通过，覆盖浅色、深色、XXXL 与减少动画。Android 两次设备尝试因 ADB 断开 / 崩溃未得到有效仪器结果；完整 C01–C18、375pt 窄屏及 R32 真后端仍未验收。证据与所有失败保留在 `.artifacts/ui-regression/20261101-agent-on-demand/summary.md`；未部署当前 Host 安装包。
- 相关 Host 自动回归、类型检查和 lint 的最终命令 / 退出码见 `.artifacts/ui-regression/20261101-agent-startup/summary.md`；不得将全工作区并发改动归为本任务。
- Pi 1.4.0 隔离原生 RPC 对照：`--no-approve` 不加载项目 prompt，`--approve` 加载；两次都收到原生响应，未创建持久信任文件。未调用模型。
- Codex 0.165.0 隔离 `CODEX_HOME` 原生 app-server：项目写入返回 `ok`，其他配置未变化；不等同于 TUI / Desktop / Windows 实机验收。
- Claude 2.1.316 在全新嵌套 Git 项目直接进入 composer，具名 MCP fixture 进程确实启动；未手动回答项目 / MCP 确认。证据为 `claude-mcp-terminal.json` 与 `mcp-native-started.json`。会话曾出现在 Host 诊断中，但后续只读 poll 未确认，不能以该次 smoke 声称完整连接门禁通过。较早目录信任真实握手证据仍见 ADR-0033 §14。
- 未完成：Windows 真终端、Codex Desktop 新账号、DSH 真后端各类首次准备、两端 L1–L4 / C01–C18 / A1–A4 与启动专项 R29 / R30。当前 Host 安装包未替换或重启，此处是源码和局部原生验证，不是全平台交付。

### 尚未支持的首次流程

不能声明“所有首次审批均可在手机完成”。账号登录 / MFA、MCP OAuth、Claude 首次 onboarding / 第三方 Mods 自有授权、操作系统授权，以及 MDM / 服务端管理策略的完整有效配置检测，仍缺少统一手机处理接口；现有实现只能对可识别条件提前失败，对其余条件等待真实握手或明确超时。后续若实现登录链接 / 设备码 / 启动前审批面板，必须另补协议、两端交互、敏感状态生命周期与真实设备验收。不得以写入 onboarding 完成标记、demo 模式或模拟确认掩盖缺口。

## 依据

- Pi 随目标安装分发的 `docs/cli.md`、`docs/security.md`：`--approve` 仅信任当前进程项目资源。
- Codex 官方配置参考：<https://developers.openai.com/codex/config-reference/>；公开 app-server 协议与本机目标类型。
- Claude 官方权限 / 插件 / 设置参考与 ADR-0033 §14。
- DeepSeek 本机发行包公开 ACP / Web 类型与现有适配器测试。
