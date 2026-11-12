# ADR-0078：Linux 桌面 Host 平台适配与发行

日期：2026-11-12（Asia/Taipei）

Status: proposed（源码调研完成；未实现、未构建、未发布，待用户验证）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)、[ADR-0056](0056-agent-startup-readiness-and-consent.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0073](0073-native-cli-startup-prompts.md)、[ADR-0075](0075-host-confirmed-exit-and-update.md)、[ADR-0077](0077-cli-host-and-headless-validation.md)。

## 问题与结论

Linux 桌面 Host 可以复用现有 Qt/QML 界面、桌面管理流程和 TypeScript Host 核心。它的主要工作集中在凭据、终端 / 浏览器启动、桌面集成、更新及发行环境适配，范围比完整 CLI 产品化更集中。当前仍有明确的功能阻塞；编译出 Qt 可执行文件不能证明安装包可用。

本提案面向已登录图形桌面的 Linux 用户，保留 Pi、Codex、Claude 的原生可见终端交互，以及 DSH Web 工作台。无头 Host 与无头 Agent 沿用 ADR-0077 独立验证；桌面移植不依赖先完成那些流程。

首个候选范围为 **Ubuntu x64、一个明确的桌面环境和终端组合**。具体 Ubuntu 版本、桌面版本、X11 / Wayland 会话及 Qt 插件组合在实施前固定，支持声明以实测组合为准。arm64、其他发行版及桌面环境随后单独验证。

## 调查范围与已确认缺口

本次以 Orbis 提交 `622c596fa39dc712b40e800cad6da425580fe782` 为源码基线，没有执行 Linux 原生构建或运行测试。证据目录：[`.artifacts/linux-desktop-assessment-20261112/`](../../.artifacts/linux-desktop-assessment-20261112/)；`source-inventory.json` 记录所引源码与关联文档的哈希，`verification.json` 记录静态检查及执行边界。

| ID | 当前实现与影响 | 代码指针 |
| --- | --- | --- |
| F01 | 原生界面使用 C++20、Qt 6.8 与 QML，Windows / macOS 已共用同一工程；存在平台条件分支，但本轮没有 Linux 编译通过证据。 | [CMakeLists.txt](../../packages/windows-host/CMakeLists.txt)、[main.cpp](../../packages/windows-host/src/main.cpp) |
| F02 | 激活凭据仅实现 Windows DPAPI 和 macOS Keychain，其他平台保存失败。即使 Linux 窗口能打开，也不能据此完成持久激活。 | [CredentialStore.cpp](../../packages/windows-host/src/CredentialStore.cpp) 的 `save` / `load` |
| F03 | Pi `SessionSpawner` 只识别 Windows / macOS 开窗入口；Codex 默认开窗函数在其他平台抛错；Claude 自动开窗明确只支持 Windows / macOS。 | [spawner.ts](../../packages/host/src/spawner.ts) 的 `buildSpawnPlan` / `activate`；[codex-runtime.ts](../../packages/host/src/codex-runtime.ts) 的 `defaultOpenHeadWindow`；[claude-launcher.ts](../../packages/host/src/claude-launcher.ts) 的 `unavailable` |
| F04 | 桌面快捷入口的 Pi / Codex 与 DSH 浏览器启动在 macOS 分支之后使用 Windows 实现。只修改手机触发的启动器仍会漏掉桌面按钮。 | [desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts) 的 `openAgent` |
| F05 | 登录启动只处理 Windows 注册表和 macOS LaunchAgent，Linux 会继续保存开关并显示成功，缺少真实系统注册。 | [HostController.cpp](../../packages/windows-host/src/HostController.cpp) 的 `setAutoStart` |
| F06 | 更新查询的非 macOS 分支读取 Windows 产物，下载文件名和安装调用也带 Windows 假设；Linux 需要独立平台分支。 | [HostController.cpp](../../packages/windows-host/src/HostController.cpp) 的更新查询、下载和 `m_installLauncher` |
| F07 | 运行时脚本可复用依赖收集，但直接复制构建机的 Node 和已安装依赖；QUIC helper 的目标可独立选择。现有 Host 发布工作流及官网下载暂存规则没有 Linux 类型。 | [package-host-runtime.mjs](../../scripts/package-host-runtime.mjs)、[build-host-quic.mjs](../../scripts/build-host-quic.mjs)、[client-release.yml](../../.github/workflows/client-release.yml)、[prepare-host-downloads.py](../../deploy/prepare-host-downloads.py) |
| F08 | 托管 Agent 目录已有 XDG 路径分支；Pi 的自动集成仍有平台专属流程。Codex Desktop 接入在当前代码中只支持 Windows / macOS。 | [agent-root.ts](../../packages/host/src/agent-root.ts)、[desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts)、[codex-desktop-presence.ts](../../packages/host/src/codex-desktop-presence.ts) 的 `supportsCodexDesktop` |

已有 Linux 审核 Host 的 Pi 无头注册记录见 ADR-0077，它未运行 Qt 桌面、终端开窗或用户安装流程，不作为 Linux 桌面版通过证据。

## 提议决策

以下场景 ID 用于后续实现、验证与验收，本次登记方案。

| 场景 ID | 应有行为 |
| --- | --- |
| LINUX-HOST-01 | 沿用现有桌面工程、共用组件和 Host bridge，复用激活、配对、供应商、设备管理与状态事实；Linux 差异集中到平台适配入口。 |
| LINUX-HOST-02 | Linux 激活凭据具有当前用户作用域，保存成功后才进入已激活状态。凭据后端缺失、锁定、拒绝访问和内容损坏均可恢复，日志不包含凭据。 |
| LINUX-HOST-03 | 共用 Linux 终端启动适配器服务桌面快捷按钮与手机新建 / 恢复，保留工作目录、真实参数、环境、原生会话身份和 TTY。显式开窗失败返回失败；启动就绪沿用原生握手与配置确认。 |
| LINUX-HOST-04 | 浏览器、应用入口、托盘、登录启动和终端集成按实际桌面能力运行，成功状态对应已完成的系统操作。没有托盘时仍提供可见的退出路径。 |
| LINUX-HOST-05 | 平台能力按实际实现报告。Codex 终端后端、Codex Desktop 和 DSH Web / Desktop 分别判断；只有安装发现、启动及接入验证完成的组合才列入支持清单。 |
| LINUX-HOST-06 | Linux 更新按自身平台、架构与发行形式选包，沿用校验、确认、后台收尾和状态保留；更新入口与实际交付能力一致。 |
| LINUX-HOST-07 | 在匹配目标的 Linux 环境构建和打包，携带匹配架构的 Node/npm、QUIC、Qt/QML、必要插件及许可证，记录系统依赖与最低运行环境。 |
| LINUX-HOST-08 | 桌面功能、真实 Agent、发行产物、跨版本互通和用户安装分别验收；构建或自动截图通过仅代表对应检查完成。 |

### 凭据与桌面集成

在 `CredentialStore` 中补 Linux 适配器。优先原型验证所选桌面的用户密钥存储；具体库、服务依赖及锁定恢复方式在实施时确认。存储契约保持保存 / 读取 / 清除、原子替换及旧凭据可恢复；验证用户取消、服务缺失、重新登录和重启。需要其他存储策略时单独明确保护方式，不静默改变已声明的凭据保护语义。

复用 `main.cpp` 的窗口、托盘探测与单实例机制，验证 Linux 下普通关闭、无托盘关闭、重复启动和原生退出。登录启动采用当前用户桌面会话机制，登记、关闭及安装路径变化都需核对实际结果；尚未支持的操作应如实显示不可用。系统减少动效偏好、缩放、输入法、字体和文件选择框纳入目标桌面的验证。

Agent 安装沿用托管目录及原生安装选择，分别核对从应用启动器与终端启动 Host 时的 PATH / 环境解析。Pi 扩展、Claude 插件和 Codex 终端接入各有自己的安装、更新与卸载归属；能从 Host 打开 Agent，不等于用户在任意终端运行该命令都已自动接入。

### Agent 启动与浏览器

首版只为选定的 Linux 终端组合提供已验证适配，入口统一接收 command、argv、cwd 和显式环境。使用可审查的参数传递或私有启动文件，验证空格、中文、单引号及 shell 特殊字符路径。终端启动器返回成功与 Agent 原生握手分别记录，不能用短命启动器的 PID 代替真实会话归属。

Pi、Codex、Claude 的桌面按钮、手机新建、恢复和配置式创建共用该适配，并沿用 ADR-0056 / ADR-0073 的初始化及首次授权策略。桌面移植不引入新的无头降级。DSH 浏览器入口调用目标环境的浏览器打开机制，保持原有认证和本机服务语义；带认证的工作台 URL 不进入普通日志。

Codex Desktop 的 Linux 支持仍是当前 Orbis 适配器缺口，不能由 Codex 终端版可运行推导；DSH Desktop 延续 [ADR-0076](0076-deepseek-harness-desktop-integration.md) 的独立接入提案。本轮不承诺这些桌面后端可用。

### 包格式与更新

首版优先做可解包运行的目录包，先在无源码、无全局 Node / Qt 开发环境的目标机器核验；`.deb` 或 AppImage 的选择在依赖和桌面集成原型后确定。发布声明明确发行版、架构、桌面、终端及显示会话组合。X11 / Wayland 逐项验证，未执行的组合保持未验证状态。

初期可以交付手动更新路径：先按既有退出确认完成后台收尾，再替换程序，保留身份、激活、配对、Agent 配置及历史。应用内自动安装待对应包格式的更新机制验证后开放；Linux 查询不能选择 Windows 安装器。新增 Linux 发布类型时核对官网清单、校验和、平台保留及回退，不覆盖其他平台最新可用产物。

桌面退出和更新复用 ADR-0075 的资源归属与异步收尾，验证 Linux 进程树、失效 PID、外部手动服务及文件占用。仅确认所属的后台进入清理，原生外部终端和服务按既有归属处理。

## 实施与最小充分验证

| 阶段 | 实施与验证内容 | 证据与通过边界 |
| --- | --- | --- |
| V1：隔离原生构建 | 固定目标 Linux / Qt / Node / Go 版本及架构；编译 Qt 工程并打入当前 Host runtime，执行相关 CTest 与隔离 QML smoke。 | 编译日志、依赖 / 架构清单、smoke 状态和截图；只证明窗口及 bridge 的基础启动。 |
| V2：系统适配 | 凭据保存 / 重启读取 / 清除 / 锁定恢复；终端与浏览器参数；登录启动开关、无托盘退出、单实例；错误平台更新候选的拒绝。 | 优先扩展 [CredentialStoreTest](../../packages/windows-host/src/tests/CredentialStoreTest.cpp)、[StartupSettingsTest](../../packages/windows-host/src/tests/StartupSettingsTest.cpp)、[HostExitTest](../../packages/windows-host/src/tests/HostExitTest.cpp)、[desktop-terminal.test.ts](../../packages/host/src/desktop-terminal.test.ts) 及各启动器用例。 |
| V3：真实业务闭环 | 独立用户数据 / 状态和隔离 Relay 中激活、扫码配对；逐 Agent 检测、安装 / 升级、打开、手机新建 / 恢复、首句、工具审批 / 拒绝、断线重连和退出。桌面按钮和手机入口都覆盖。 | 记录原生 Agent 版本、cwd、TTY、握手、会话身份与进程退出；合成服务测试和真实原生 / 模型结果分别记录。 |
| V4：干净安装与兼容 | 新装、重新登录、Host 更新及回退；核对凭据 / 配对 / 历史保留。按 ADR-0064 使用执行时最近已发布的真实 Host / Relay / App / 插件做跨版本及同版正对照。 | 产物哈希、来源提交、系统依赖、旧包身份、安装日志和回退证据；不以仅同版测试替代旧端兼容。 |
| V5：用户验收 | 提供目标桌面的精简安装步骤，由用户安装验证窗口、配对、Agent 开窗、手机操作和退出。 | 明确标注“待用户验证”，用户确认后才记交付完成。 |

测试细节写在相关源码，工具按任务参数化并复用 `~/.orbis/tools/ui-regression/`；构建及设备操作使用共享租约。原始结果保存到任务 `.artifacts/`，异常资源按归属处理。纯文档阶段仅执行静态检查。

## 本次状态与后续选择

源码缺口、场景和验证门槛已整理。方案为待实施提案，未运行 Linux 构建、原生测试、打包、安装或部署；文档相对链接、场景 ID、源码快照及差异检查结果见本次 `verification.json`。

实施前固定目标系统与桌面 / 终端组合、凭据后端及首版发行形式；通过原型收敛后再估计工期。用户安装验收为待完成状态。CLI 调研继续保留为独立提案，不作为本桌面版本的前置交付条件。
