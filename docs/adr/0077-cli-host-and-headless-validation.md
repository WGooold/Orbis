# ADR-0077：CLI Host 产品化与无头运行验证

日期：2026-11-12（Asia/Taipei）

Status: proposed（源码调研完成；方案待实施验证，未实现、未打包、未部署，待用户验证）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0021](0021-codex-terminal-host-attachment.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)、[ADR-0056](0056-agent-startup-readiness-and-consent.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0072](0072-session-configuration-and-recoverable-launch.md)、[ADR-0075](0075-host-confirmed-exit-and-update.md)。

## 问题与结论

现有 TypeScript Host 已有 `host`、`pair`、`devices` 命令，Qt 桌面端也通过 Node 子进程运行相同的底层 Host 服务。但通用 CLI 尚缺首次激活、运行中管理、完整启动策略与独立发行链路；各 Agent 的无头实现和验证程度也不同。CLI 产品化是中等规模的工作，单独增加压缩包不能构成可交付版本。[F01–F08]

需要分别定义两层能力：

- **CLI Host**：Host 自身没有 Qt 窗口，通过命令行配置、运行和管理。它仍可能要求 Agent 打开本机终端。
- **无头 Agent**：在没有桌面会话、终端窗口和交互式 stdin 的机器上，由手机完成会话操作。它还依赖原生认证、启动、审批、历史恢复与进程生命周期。

本提案先验证无桌面 Linux 上的前台 CLI Host，优先核实 Pi RPC 与 DSH Web；Codex 终端后端单独验证关闭开窗后的完整语义，Claude 无头接入另立决策。通过验证的后端才能进入支持清单。Linux Qt 桌面版、其他操作系统 CLI 包与服务安装分别交付、分别验收。

## 调查范围与证据

本次依据 Orbis 提交 `622c596fa39dc712b40e800cad6da425580fe782` 的本机源码、测试源码、构建工作流及一份已有 Linux CI 报告。没有调查上游最新版本，也没有运行真实 Agent、调用模型、连接线上 Relay 或读取用户凭据。

本次证据：[`.artifacts/cli-host-assessment-20261112/`](../../.artifacts/cli-host-assessment-20261112/)。`source-inventory.json` 保存源码及既有证据的哈希和提交归属；`verification.json` 保存文档静态检查、历史 JUnit 摘要与执行边界。代码行为以所列函数实现为准，测试文件存在不等于本轮执行通过。

### Host 入口与管理差异

| ID | 已确认事实 | 代码依据与影响 |
| --- | --- | --- |
| F01 | CLI 仅提供 `host`、`pair`、`devices`；包清单为 `private: true`，没有 `bin`。 | [cli.ts](../../packages/host/src/cli.ts) 的 `main`；[package.json](../../packages/host/package.json)。已有开发入口，尚无独立安装后的命令契约。 |
| F02 | CLI 从配置或环境读取 Relay 与 runtime credential，没有注册或激活命令。桌面端在 Qt 中取得注册策略、验证码及 Host 绑定凭据。 | [config.ts](../../packages/host/src/config.ts) 的 `loadHostConfig`；[HostController.cpp](../../packages/windows-host/src/HostController.cpp) 的 `requestCode`、`activate`、`activateWithoutEmail`、`saveActivation`。首次安装不能沿用桌面已激活的假设。 |
| F03 | CLI `pair` 发现同状态目录的 Host 后会拒绝执行；桌面端在正在运行的 Host 上打开配对窗口。CLI 撤销设备只改磁盘并提示重启；桌面端可即时断开设备。 | [cli.ts](../../packages/host/src/cli.ts) 的 `runPair`、`runDevices`；[desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts) 的 `pair`、`revoke`。缺少连接常驻实例的控制入口。 |
| F04 | 配对实现优先使用显式 admin token，否则使用 Host credential。 | [host-service.ts](../../packages/host/src/host-service.ts) 的 `openPairingWindow`；[registration.ts](../../packages/relay/src/registration.ts)。普通 CLI 激活应复用 Host 专属凭据；`config.ts` 中“缺 adminToken 无法 pair”的注释不代表当前实现。 |
| F05 | CLI 和桌面运行时分别组装后端与生命周期；桌面路径另有检测、托管安装、插件登记、供应商管理、启动重试与失效凭据反馈。 | [cli.ts](../../packages/host/src/cli.ts) 的 `runHost`；[desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts) 的 `start`、`#connect`、`detect`；[desktop-bridge.ts](../../packages/host/src/desktop-bridge.ts)。直接扩大 CLI 的独立逻辑会继续增加行为差异。 |
| F06 | CLI 在服务启动后才等待 SIGINT / SIGTERM，退出调用各 runtime 的 `stop`；桌面完整退出另有独立收尾协议。Pi 无头进程保持 stdin 管道，DSH Web 则是持久后台，连接句柄的 `stop` 不关闭该服务。 | [cli.ts](../../packages/host/src/cli.ts) 的 `runHost`、`waitForSignal`；[spawner.ts](../../packages/host/src/spawner.ts) 的 `activate`；[dsh-web-service.ts](../../packages/host/src/dsh-web-service.ts) 的 `handle`；[desktop-shutdown.ts](../../packages/host/src/desktop-shutdown.ts)。CLI 的启动中断、退出超时及进程回收尚需专项实测，不能直接套用桌面通过结果。 |
| F07 | 打包脚本已经收集 Host、Pi 扩展、Claude 插件、Node/npm 和 QUIC helper；Node 与依赖来自当前构建环境，Go helper 可单独选择目标。 | [package-host-runtime.mjs](../../scripts/package-host-runtime.mjs)、[build-host-quic.mjs](../../scripts/build-host-quic.mjs)。仅设置 `GOOS=linux` 不会把其余运行时转成 Linux 产物。 |
| F08 | 发布工作流和官网下载暂存规则只接入现有 Windows / macOS Host 产物。Linux Qt 凭据存储也尚未实现。 | [client-release.yml](../../.github/workflows/client-release.yml)、[prepare-host-downloads.py](../../deploy/prepare-host-downloads.py)、[CredentialStore.cpp](../../packages/windows-host/src/CredentialStore.cpp)。CLI 需独立产物类型、平台归属与保留规则；Linux GUI 是另一项适配工作。 |

### Agent 无头能力

| 后端 | 当前实现 | 验证缺口与候选范围 |
| --- | --- | --- |
| Pi | `SessionSpawner` 支持显式 `headless`，使用 `--mode rpc` 与 Orbis 扩展；缺省是 `tui`，Linux 无开窗入口时显式 `tui` 报错。 | 优先验证候选。已有真实 Pi 注册证据，但缺少通用 CLI 的首句、工具审批、恢复、Host 重启及完整退出验收。[spawner.ts](../../packages/host/src/spawner.ts)、[agent-backend.ts](../../packages/host/src/agent-backend.ts) |
| Codex 终端后端 | 使用独立 app-server；`ORBIS_CODEX_HEAD=0` 会跳过开窗和窗口看门狗，服务包解析已有 Linux 目标。激活回执仍按终端后端报告 `tui`，不随该开关变为 `headless`。 | 有实现基础，但环境开关不是完整产品能力。需核对模式回执、认证、sandbox、配置确认、审批、会话归属及后台恢复；不能以 app-server 握手成功作为完成。[codex-runtime.ts](../../packages/host/src/codex-runtime.ts) 的 `#activateInner`、`#openHeadWindow`；[codex-terminal-server.ts](../../packages/host/src/codex-terminal-server.ts) |
| Claude Code | `TerminalClaudeLauncher` 连接官方 TUI；自动开窗仅实现 Windows / macOS，其他平台返回不可用，没有无头 fallback。 | 当前不承诺手机在无桌面环境中新建 / 恢复 Claude。手动终端接入与无头启动分开验证；新后端须独立调查原生协议及 Mods / hooks 适用性。[claude-launcher.ts](../../packages/host/src/claude-launcher.ts)、[ADR-0033](0033-claude-code-tui-mods-integration.md) |
| DeepSeek Harness Web | `DshRuntime.create` 创建 / 复用认证 Web 服务，`connectExisting` 只连接既有服务；会话由原生 API 管理，不要求打开浏览器。 | 优先验证候选。核对目标安装版本、首次认证、端口占用、服务重启、原生会话写锁及外部服务保留。[dsh-runtime.ts](../../packages/host/src/dsh-runtime.ts)、[dsh-web-service.ts](../../packages/host/src/dsh-web-service.ts) |
| Codex Desktop / DSH Desktop | Desktop 表示原生桌面应用入口。Codex Desktop 的 `spawnMode: headless` 表示没有额外 TUI；DSH Desktop 仍为独立提案。 | 不据字段名称把 Desktop 列为无桌面服务器能力。[codex-daemon.ts](../../packages/host/src/codex-daemon.ts) 的 `isDesktopAppServer`；[ADR-0076](0076-deepseek-harness-desktop-integration.md) |

当前 [Android HostConnection](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt) 和 [iOS OrbisStore](../../ios/Orbis/Orbis/OrbisStore.swift) 的正常新建入口默认发送 `tui`，配置式创建也沿用该要求。调试捕获入口的 `headless` 不能代表普通用户已可选无头模式。[SpawnModeSchema](../../packages/protocol/src/index.ts) 已定义 `auto` / `tui` / `headless`，但 [Host 后端状态](../../packages/protocol/src/host-model-domains.ts) 尚未描述每个后端的可用启动模式。

### 已有验证能证明什么

| 证据 | 已覆盖内容 | 不能据此得出的结论 |
| --- | --- | --- |
| [2026-11-06 Linux JUnit](../../.artifacts/server-migration/20261106-to-154/ci-review/review-host-tests-linux/review-host.xml) | 11 项通过：7 项审核环境清理、4 项 portal 用例；其中 1 项启动真实 Pi 并等待本机注册，明确没有调用模型。报告时间为 `2026-11-06T07:39:02Z` 附近。 | 不是本次提交的执行结果，不能证明通用 CLI、真实模型对话、全部 Agent 或用户安装通过。 |
| [portal.test.mjs](../../scripts/review-demo/portal.test.mjs)、[review-host.yml](../../.github/workflows/review-host.yml) | 审核专用环境有独立 Linux CI 入口，直接构造 `HostService` / `SessionSpawner`。 | 没有从正式 CLI 可执行入口走首次激活及常驻管理。 |
| [审核 Host](../../scripts/review-demo/host.mjs) | 专用 `ReviewSpawner` 把请求改为 `headless`，使用固定审核配对和独立退出清理。 | 这些专用策略不能直接变成普通 Host 的模式协商、配对或生命周期保证。 |
| [spawner.test.ts](../../packages/host/src/spawner.test.ts)、[host-service.test.ts](../../packages/host/src/host-service.test.ts) | 存在启动参数、平台分支、管道与服务路由用例；部分 Codex 用例关闭 HEAD 并注入假 app-server。 | mock / 参数断言不能证明真实无头原生进程的认证、工具交互和退出。 |
| [dsh-web-service.test.ts](../../packages/host/src/dsh-web-service.test.ts)、[desktop-shutdown.test.ts](../../packages/host/src/desktop-shutdown.test.ts) | 有可复用的服务归属、重启、外部服务保留及进程回收用例。 | 桌面与合成服务覆盖不能直接算作 CLI 在目标 Linux 发行版上的验收。 |

本次在仓库测试中未找到执行 `packages/host/dist/cli.js` 或导入 `src/cli.ts` 的完整产品流程用例。[host-pair.test.mjs](../../scripts/host-pair.test.mjs) 只检查辅助脚本参数解析。部分 CI 注释仍描述早期 POSIX 自动降级行为，当前模式判断以 `spawner.ts` 为准。

## 提议的产品与架构决策

以下 ID 用于后续实现与测试归属，本次只登记提案。

| 场景 ID | 应有行为 |
| --- | --- |
| CLI-HOST-01 | CLI 以前台常驻进程为基础；初始化、运行、查询和管理使用明确命令及退出码。服务管理器接管前台进程，服务安装在前台流程验证后加入。 |
| CLI-HOST-02 | 激活使用同一 Relay 策略和 Host 身份，支持要求邮箱验证码及允许直接激活的部署；凭据失效返回可操作状态。激活 HTTP 流程抽为共用逻辑，持久化由运行环境适配。 |
| CLI-HOST-03 | 桌面和 CLI 共用 Host 应用服务层，统一状态、后端准备、供应商、连接重试及收尾；终端开窗、系统凭据、登录启动和界面输出作为适配器注入。 |
| CLI-HOST-04 | 同一状态目录由一个常驻实例拥有；运行中的配对、撤销和状态查询通过当前用户私有的本地控制接口完成。撤销成功表示活跃通道及持久状态均已更新。 |
| CLI-HOST-05 | Host 按后端报告可用启动模式与默认偏好，App 按已协商能力选择模式；显式 `tui` 保持开窗语义，实际启动形态写入回执。新建、恢复、配置式创建使用相同策略。 |
| CLI-HOST-06 | 无头支持按后端分别验收，缺登录、初始化未完成或模式不可用均返回明确结果；原生握手、配置确认及首句发送继续遵循 ADR-0056 / ADR-0072。 |
| CLI-HOST-07 | 启动、运行、停止全程处理取消与信号；按归属清理本次资源，核验进程、端口和落盘状态。连接暂停、Host 退出、后台服务保留 / 关闭分别有明确行为。 |
| CLI-HOST-08 | Linux CLI 包携带匹配架构的运行时、依赖和许可证，按实际构建 / 原生验证结果发布；包版本、源码、校验和、支持后端和回退包可追溯。 |
| CLI-HOST-09 | 用户输出与机器输出分别有契约；机器输出只包含指定结构，日志进入 stderr，凭据与配对材料按敏感数据处理。查询与诊断操作具有明确副作用边界。 |

### 共用核心与命令范围

复用 `HostService`、`ProviderManager`、后端适配器和已有退出工具；从 `DesktopRuntime` 提取应用服务的组合与生命周期，不把整个 `desktop-bridge.ts` 私有 stdin 协议直接当作公开 CLI。抽取时保持桌面行为，并用现有桌面用例作回归对照。

首版命令能力包括：初始化 / 激活、前台运行、状态与诊断、运行中配对、设备列表 / 撤销、停止。具体命名及结构化输出格式在实现阶段固定；现有 `host` / `pair` / `devices` 命令需要兼容或给出明确迁移路径。Agent 安装、供应商编辑及系统服务安装按需后续接入，首版可以使用已安装、已完成原生认证的 Agent，但应能准确报告缺失项。

本地控制接口候选为 Unix domain socket / Windows named pipe，或复用已有 loopback 的受限控制路由；实现前验证可移植性和鉴权。管理权限应独立于 Agent 插件注册凭据，绑定当前用户、Host 身份及状态目录，避免第二个 CLI 进程另起相同 Relay 身份。离线管理仅在确认没有存活所有者后修改状态。

Linux 无桌面凭据存储需独立设计。候选为当前用户私有目录和权限受限文件，或服务管理器注入凭据；文件权限不等于系统钥匙串加密。导入、原子写入、权限失败及轮换需验证，凭据不经 argv 或普通日志输出。桌面加密激活文件不作为跨平台可复制格式。

### 启动模式与旧端

新增模式能力按 ADR-0064 协商并投影到对端可解析的格式，覆盖注册、后续状态、重连和命令；不能仅增加一个可选字段就假定旧端接受。新 App 使用 Host 报告的模式，新 Host 保留旧请求的原语义。旧 App 显式要求 `tui` 而环境只支持无头时返回已有格式可理解的失败；已存在会话的访问单独核对。

不把审核环境的强制改写搬入产品路径。Codex 关闭开窗后仍报告 `tui` 的差异应在模式实现中修正；Desktop 回执与无桌面能力分开表示。Claude 的 SDK、print 或伪终端方案均未在本次调查验证，不能作为已有 TUI 后端的等价替换。

### 生命周期

优先复用已有进程归属与收尾机制，补齐 CLI 与 service manager 的调用入口。Pi 无头进程的 stdin 管道、Codex owned app-server、DSH 持久服务及外部手动启动服务分别核对；停止 Host 连接和结束其拥有的后台服务应可区分，外部服务沿用原有归属。收尾超时返回失败并保留诊断，不提前报告停止完成。

启动期间的信号、重复停止、部分初始化失败、父进程丢失、Host 重启及 PID 复用均是验证场景。服务管理器如何重启、何时保留后台及怎样恢复待发送请求，在前台协议明确后确定。历史、配对、模型设置和待确认操作沿用既有恢复语义。

## 验证顺序与准入条件

测试围绕实际缺陷复用既有用例；新增用例在测试源码中说明用途。工具放在 `~/.orbis/tools/ui-regression/`，结果落入各任务 `.artifacts/`；构建及设备操作使用共享租约。以下均为计划，不是本次执行结果。

| 阶段 | 最小充分验证 | 通过后可做的工作 |
| --- | --- | --- |
| V1：命令和本地控制 | 从真实 CLI 入口启动隔离 Host / Relay，覆盖策略激活、错误验证码、凭据失效、运行中配对、即时撤销、同目录双启动、无效参数、机器输出及无 TTY 执行。补充 `--help` 无副作用和输出脱敏断言；当前 `pair --print-payload` 分支后的 LAN / 成功文本也需纳入输出契约核对。 | 固定 CLI 命令及共享服务接口。 |
| V2：真实无头后端 | 独立 HOME / 状态 / 项目下，移除桌面环境且关闭交互输入，按每个拟支持 Agent 验证启动、认证缺失、配置确认、新建 / 恢复、首句仅一次、历史、工具审批 / 拒绝、问卷、取消、错误终态和断线重连。先做不调用模型的原生握手，再用明确测试账号完成真实交互。 | 按证据形成支持清单，Pi / DSH 优先，Codex 单列结果。 |
| V3：生命周期 | 启动中断、空闲 / 执行中停止、忽略信号的合成子进程、服务重启、持久 DSH / 外部服务、PID 复用；记录进程归属、退出码、端口、文件完整性与遗留资源。 | 接入服务管理器并验证开机启动与恢复。 |
| V4：手机与跨版本 | 新 App 在真实无桌面 Host 上完成模式选择与会话闭环；用执行时最近发布的真实 Host / Relay / App / 插件实现验证新旧互通、重连、受限能力及回退，保留同版正对照和原始失败。 | 宣布具体组合的兼容范围，安排用户安装验收。 |
| V5：发行产物 | 从干净、匹配目标的平台构建；无源码、无全局 Node 的环境解包运行，检查 CPU 架构、依赖 / libc 基线、QUIC 与 WS、权限、许可证、升级 / 回退和状态保留。x64 / arm64 分别验证，不能用交叉编译成功代替执行。 | 发布已验证的平台 / 架构压缩包，并扩展发布与下载保留规则。 |

第一阶段可先验证一个明确的 Linux 发行版和架构，再扩展其他组合。正式发行形式优先评估自带 Node 的压缩包，`npm` 全局安装或单文件可执行文件不是本阶段前提。Windows / macOS 的 CLI 与 Linux Qt GUI 单独进入验证矩阵。

## 工作量与待确认项

运行时收集和 CLI 启动器的补充工作较小；共用应用服务、首次激活、常驻控制、模式协商及生命周期收口是主要的中等工作量。真实无头后端、Linux 环境差异和跨版本验收决定总周期，现有证据不足以给出可靠工期。Claude 新无头后端属于额外设计范围。

实施前需确定首个 Linux 发行版 / 架构、首版后端清单、凭据存储与本地控制机制；这些选择可以在隔离原型中收敛。当前不承诺所有 Agent、全部 Linux 发行版或现有手机包无需变化即可支持。

## 本次交付状态

| 项目 | 状态 |
| --- | --- |
| 源码调查、既有 Linux JUnit 复核、方案与验证顺序 | 已完成；证据见本次目录。 |
| 文档相对链接、场景 ID、源码哈希、差异静态检查 | 结果见 `verification.json`；本轮只执行静态检查。 |
| CLI 功能实现、运行时 / 模型测试、Linux 包构建 | 未执行。 |
| 安装、部署、服务注册与真实环境操作 | 未执行。 |
| 用户安装验收 | 待用户验证；可安装候选包生成后再提供对应安装步骤。 |
