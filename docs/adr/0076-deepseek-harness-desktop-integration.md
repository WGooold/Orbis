# ADR-0076：DeepSeek Harness Desktop 独立接入

日期：2026-11-12

Status: accepted（2026-11-13 已实现：Host 接入、协议协商、App 入口与 Host 界面引导通过自动验证；真实 Desktop、设备与用户验收待完成；未部署）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0070](0070-unified-design-and-interaction.md)（HOST-GUIDE-01）、[ADR-0075](0075-host-confirmed-exit-and-update.md)。

## 问题与结论

Orbis 当前的 `dsh` 对应 DeepSeek Harness Web。Windows 只安装 DeepSeek Harness Desktop、未注册其可选 CLI 时，现有 CLI 检测找不到它，符合当前实现的覆盖范围，属于 Desktop 支持缺口。注册 `dsh.cmd` 可以让命令被发现，但仍不等于连接 Desktop；当前协议库定位也无法从该启动器取得可用包入口。[F01–F03]

Desktop 与 Web 共享后端实现，Desktop 自己拥有后端进程、profile、认证和生命周期。已有 Web 传输及会话映射有复用价值；完整接入还需要安装发现、Desktop 实例接入、匹配版本的协议加载及跨端路由，不能仅靠增加一个搜索目录完成。[F04–F06]

采用与 `codex` / `codexDesktop` 相同的产品分路：保留 `dsh` 为 Web，规划独立的 `dshDesktop`。各入口读取和操作所连接原生实例的会话，Orbis 不复制、迁移或对账 Web 与 Desktop 的历史。原生共享数据与两条接入的身份分别处理。[F07–F09]

## 调查版本与证据

上游为 `deepseek-ai/deepseek-harness`。本次固定源码提交 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，并对照预发布 tag `dsh-v0.2.2-rc.2` 的提交 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`，发布记录时间为 `2026-11-11T11:33:06Z`。这些版本是本次调查范围，不代表所有安装版本的行为。

证据保存在 [dsh-desktop-assessment-20261112](../../.artifacts/dsh-desktop-assessment-20261112/)：

- [sources.json](../../.artifacts/dsh-desktop-assessment-20261112/sources.json)：100 份官方文档与源码的固定提交 URL、Git blob SHA-1、SHA-256 和字节数；114 个证据快照文件均按同一 Git tree 校验，存放在 `upstream/`、`interface-upstream/`。
- [接口源码快照](../../.artifacts/dsh-desktop-assessment-20261112/interface-upstream/)：为本次依赖清单补充的 session、workspace、Remote、Gateway、Desktop 启动与 Electron shell 源码，同样由固定 Git tree 校验。
- [interface-inventory.json](../../.artifacts/dsh-desktop-assessment-20261112/interface-inventory.json)：从 Orbis 当前 DSH Web runtime 静态提取实际调用的 unary 与 stream 接口；不代表 DSH 的全部可选 Remote namespace。
- [release-comparison.json](../../.artifacts/dsh-desktop-assessment-20261112/release-comparison.json)：6 个关键启动 / 认证文件的逐字节对照；更广的源码范围见下一项。
- [release-source-comparison.json](../../.artifacts/dsh-desktop-assessment-20261112/release-source-comparison.json)：对照主干与 `dsh-v0.2.2-rc.2`，本次涉及的 100 个唯一官方源码 Git blob 全部一致（字节相同）。
- [orbis-sources.json](../../.artifacts/dsh-desktop-assessment-20261112/orbis-sources.json)：本机 Orbis 源码快照、对应 HEAD 及工作区差异标记。共享工作区可能有其他任务修改，具体证据以文件哈希为准。
- [discovery-fixtures.json](../../.artifacts/dsh-desktop-assessment-20261112/discovery-fixtures.json)：4 个隔离发现探针结果；使用官方 Windows 启动器原文和合成安装布局。
- [verification.json](../../.artifacts/dsh-desktop-assessment-20261112/verification.json)：证据完整性、文档静态检查及执行边界；`tools/` 保留探针和证据整理工具副本。

### 已确认事实

| ID | 事实与影响 | 官方依据 / Orbis 代码 |
| --- | --- | --- |
| F01 | Desktop 安装后的 CLI 注册是可选操作；Windows 通过管理命令对话框注册到当前用户 PATH。没有 `dsh` 命令不能推出没有 Desktop。 | [Desktop README L64–68][up-desktop-cli]；[本地原文](../../.artifacts/dsh-desktop-assessment-20261112/upstream/apps/desktop/README.zh.md) |
| F02 | 内置 `resources/runtime/cli/bin/dsh.cmd` 运行普通 CLI，不打开 Desktop。它通过 Electron RunAsNode 执行 `app.asar` 内的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`。 | [运行时说明 L136–146][up-desktop-runtime]、[Windows 启动器][up-shim] |
| F03 | Orbis 检测 PATH 和常用 CLI 安装目录，未枚举 Desktop 安装。包定位识别普通 `@deepseek-ai/dsh` 包；当前 Desktop 启动器可被发现，但得不到 `packageEntry`。Web client 与历史解码器依赖该入口加载协议库。 | [agent-command.ts](../../packages/host/src/agent-command.ts) 的 `cliSearchDirs` / `resolveAgentPackage`；[dsh-client.ts](../../packages/host/src/dsh-client.ts)；[dsh-web-client.ts](../../packages/host/src/dsh-web-client.ts) 的 `loadDshWebProtocol`；[dsh-web-history.ts](../../packages/host/src/dsh-web-history.ts) |
| F04 | Desktop 使用共享 Web 应用，后端以 `desktop` profile 在 `127.0.0.1` 的系统分配端口启动；普通 CLI 拒绝启动这个 profile。将 Web 的参数改为 `--profile desktop` 不是有效接入。 | [Desktop Host L19–43][up-host]、[CLI 限制 L83–86][up-cli-profile] |
| F05 | Desktop Host 经 IPC 发出带启动令牌的 URL；Electron 用它换取 Cookie，转发请求时附加认证。当前实现不在 Electron session 中保存该 Cookie，还会清理旧版残留。扫描端口或读取 Cookie 数据库不是已证实的接入路径。 | [Host ready L135–136][up-ready]、[认证函数 L43–49][up-auth]、[Desktop 架构说明 L40][up-desktop-architecture] |
| F06 | 官方提供 `/connect?token=...&interactions=answer\|none`，返回 API Cookie 和 Mux 地址，API Peer 有独立生命周期。它仍要求合法启动令牌。已有 Web bundle 默认打印认证 URL，Desktop 子进程 stdout 也转发给主进程；因此不能断言令牌只存在于私有 IPC。 | [Connection 文档 L41–53][up-connection]、[printUrl 配置 L202–206][up-print-config]、[URL 输出 L218–231][up-print]、[stdout 转发 L210–228][up-stdout] |
| F07 | Desktop 与 CLI 共享同一 `DSH_HOME` 下受支持的产品数据，执行包和 profile 状态独立。默认会话根路径为 `dshHomePath('sessions')`，不能根据 profile 名称断言历史目录不互通。Desktop 的 `%APPDATA%` UI 设置目录独立于此主目录。 | [数据归属 L123][up-ownership]、[持久化配置 L138–141][up-sessions]、[home 路径定义][up-home]、[UI 设置 L297][up-settings] |
| F08 | 持久化支持读取冷会话；`agentAvailable` / `running` 表示当前后端实例的运行态。单会话写锁排除其他进程写入，Windows 使用命名内核信号量。共享磁盘数据不能等同于跨进程实时执行状态互通。 | [会话列表实现 L124–188][up-list]、[单写者说明 L168][up-writer]、[writer-held 处理][up-writer-error] |
| F09 | Orbis 当前仅使用显式 `ORBIS_DSH_WEB_URL` 或本机 `cache/orbis-web.json`，自动启动的是 Web profile，默认端口 3080；没有 Desktop 安装或端点生命周期。`AgentKind` 等 schema 是固定枚举。 | [dsh-web-service.ts](../../packages/host/src/dsh-web-service.ts)；[dsh-runtime.ts](../../packages/host/src/dsh-runtime.ts) 的 `create` / `connectExisting`；[agent-state.ts](../../packages/protocol/src/agent-state.ts)、[host-model-domains.ts](../../packages/protocol/src/host-model-domains.ts)、[session-configuration.ts](../../packages/protocol/src/session-configuration.ts) |
| F10 | Desktop project manager 使用 `PROFILE_TEMPLATES.web` 作为其 profile bundle 模板，模板包含 `dsh-base` 与 `dsh-web-app`。Desktop 的不同主要在 profile 参数和 Electron 壳，不是单独的 Session Remote 实现。 | [Profile 模板 L10–16][up-profile-bundles]、[Desktop 选择 Web 模板 L28–32][up-desktop-template] |
| F11 | Gateway unary RPC 为逐方法 HTTP POST；所有 Remote stream 共用 `/api/remote.mux`，事件 source 为 `$events`，结果端点为 `$events/result`。另有 API 客户端 `/connect` 令牌交换，可请求 `interactions=answer` 并创建绑定到 API socket 生命周期的 owner Peer。 | [Gateway 协议常量][up-gateway-protocol]、[Remote transport][up-connection-transport]、[API Peer 认证 L49–53][up-connection] |
| F12 | Desktop 启动 Host 时用 `desktop` profile、`127.0.0.1`、端口 0；ready URL 经子进程 IPC 交给 Electron main。启动子进程 stdout 同时 pipe 到 Electron main stdout。 | [Desktop Host 启动参数 L19–43][up-host]、[ready URL L135–136][up-ready]、[Desktop child stdout L210–228][up-stdout] |
| F13 | Orbis 当前 DSH Web 适配器调用的具体 unary / stream Remote 名称来自其运行时代码；Server Controller 提供 Session list/create/history/follow、Workspace 注册/归档/follow 与 model/projection 等对应方法。 | [当前调用点](../../packages/host/src/dsh-web-runtime.ts)、[Session Remote L281–630][up-session-api]、[Workspace Remote L90–206][up-workspace-api] |
| F14 | Desktop main 收到 Electron 页面请求后向 Desktop Host 转发 HTTP，并为 loopback WebSocket 验证 app Origin、精确主机并注入其 Host Cookie。 | [HTTP / WS 转发 L797–856][up-shell-forward]、[请求转发实现 L97–130][up-web-forward] |
| F15 | Desktop 的文件、剪贴板、快捷键、窗口、更新等 preload IPC 是独立于 Remote API 的 shell 频道；产品 preload 只给 Desktop 主 frame 提供 API，main 校验调用方来源。 | [IPC 声明 L12–42][up-desktop-ipc]、[preload API L16–128][up-preload-app]、[sender 校验][up-ipc-guard] |
| F16 | DSH Remote event allowlist 明确暴露 `approval/request`、`user-questions/request` 等 waterfall；用户问题 wait 是一个 Session Agent 定址的 Remote stream；权限 preset catalog 与 skills/list 分别由独立 Remote namespace 提供。 | [转发事件表 L27–58][up-events]、[wait stream L169–221][up-user-question-api]、[permission catalog L288–292][up-permission-api]、[skills list L24–38][up-skills-api] |

在本次查阅的 Desktop 文档、启动入口和连接实现中，未发现供外部客户端自动读取的稳定实例描述文件契约。上述结论没有通过 Windows 已安装应用验证，不能据此承诺任意 Desktop 版本均可自动接入。

## Orbis 所需接口及 Web / Desktop 关系

本节的“接口清单”范围是 Orbis 当前 DSH Web runtime 实际使用、接入 Desktop 时要保持语义的接口，不是 DSH 产品内所有可选 API。上游 `PROFILE_TEMPLATES.web` 使用 `dsh-base` 与 `dsh-web-app`；Desktop 的 project manager 直接以该 Web profile bundle 作为 Desktop profile 模板。Desktop 因而是“共享的 Web 应用 / Remote API + Electron 本机壳与启动器”，不是另一套 session API。[F10–F12]

### Orbis 当前使用的 Remote 方法

| 用途 | Orbis 需要的接口 | 在接入中的作用 |
| --- | --- | --- |
| 发现与历史 | `session/list`、`session/page`、`session/follow` | 列出会话、读取有界历史、打开运行态和后续事件流。当前 Host 用 `session/page`；上游已标记 deprecated，保留兼容既有 Web consumer，后续接入应验证其支持版本，并评估改为 `session/events`。 |
| Workspace 和归档 | `workspace/create`、`workspace/follow`、`workspace/archiveSession`、`workspace/unarchiveSession` | 先将工作目录绑定为 Workspace，再创建 / 恢复 Session；读取 Workspace、归档与顺序状态。 |
| 生命周期与输入 | `session/create`、`session/prompt`、`session/cancel`、`session/updateQueue`、`session/fork`、`session/rename` | 创建或恢复、发送 / 排队 / steer、取消活动轮次、修改队列、派生会话和改名。 |
| 原生状态与选项 | `session/control`、`session/projections`、`session/modelCatalog`、`session/selectModel`、`permissionPresets/catalog`、`skills/list`、`commands/execute` | 取得状态 baseline 与增量、历史投影、模型与权限目录，选择模型、列出 skills，及执行权限命令。 |
| 用户等待 / 交互 | `userQuestions/attachWait`；Gateway `$events` 中的 `approval/request`、`user-questions/request` 和 `$events/result` | 保持问题等待订阅；把需要用户决策的 waterfall 显示给 Orbis，并将结果或取消回复给同一 Remote event。 |

表中除 event source 外，四个 Remote stream 方法均由 Gateway mux 打开；完整调用集合及本机提取来源见 [接口清单](../../.artifacts/dsh-desktop-assessment-20261112/interface-inventory.json) 和 [dsh-web-runtime.ts](../../packages/host/src/dsh-web-runtime.ts)。普通浏览器方式以 `GET /?token=...` 换 Cookie，unary 为 `POST /api/{Remote 方法}`，流载体为 `WebSocket /api/remote.mux`。mux 上的 `$events` 用同一 Gateway 代际推送广播与 waterfall，响应走 `/api/$events/result`；Remote stream 自己的 `open` / `item` / `end` / `error` 由版本匹配的 Gateway stream protocol 解码。官方还提供 `GET /connect?token=...&interactions=answer` 作为 API 专用认证方式：它签发独立 owner Peer 和 API Cookie，并将该 Peer 生命周期绑到 mux socket。未来 Desktop 入口优先原型验证 API Peer，可避免借用 Electron 主窗口的浏览器 Peer；但现有 Orbis Web client 使用根路径浏览器 Cookie 流程，尚不支持此 API Peer 生命周期。[F11、F13、F16]

Desktop 主窗口的 `dsh-app://app` 静态页面由应用包提供；Desktop 主进程把受控的 HTTP 请求转发到自己的 loopback Host，并附加启动时取得的认证 Cookie。WebSocket 另校验应用来源及目标端口，再改写为 Host Origin 并加 Cookie。Orbis 接 Desktop 时应连接同一 Web Host Remote API，并自行作为独立 API Peer；它不应把 Electron 页面源、浏览器 Cookie jar 或 preload 暴露对象当成 Agent API。[F12、F14]

Electron preload / main-process IPC 是另一组 shell 私有接口，涵盖文件保存与剪贴板、目录选择、拖拽、快捷键、窗口 / Platform view、本地化、设备信息和更新等。其 channel 在 Desktop 源码声明，并校验 `dsh-app://app` 主 frame 的发送方；它们不是上述 Session Remote endpoints，也没有面向独立 Orbis Host 的公开连接契约。除确需且有等效 Remote API 的文件能力外，不将这些私有 IPC 纳入 Desktop session 接入。[F15]

| 维度 | DSH Web | DSH Desktop | 对 Orbis 的含义 |
| --- | --- | --- | --- |
| 后端 bundle / Remote schema | `web` profile：`dsh-base` + `dsh-web-app`。 | `desktop` profile 由 Desktop 初始化，但 bundle 模板复用 `web` profile。 | 表中需要的 session、workspace、model、permission 和 event 方法共用同一组 API 实现；仍按实际 Desktop 安装版本加载与校验 schema。 |
| 启动与监听 | Web 通常由 `dsh --profile web` 启动；Orbis 服务使用 3080，也允许完整认证 URL 或服务记录。 | Electron 启动专属 `desktop` profile，绑定 `127.0.0.1` 和系统分配端口，并独占 Desktop profile lock。CLI 禁止直接启动该 profile。 | 不要把 Web 的启动命令改成 `--profile desktop`。需识别或启动真正的 Desktop 所有者并读取它当前端点；不能静态假定 3080。 |
| 端点交付 | Web 启动输出认证 URL；Orbis 目前通过 `ORBIS_DSH_WEB_URL` 或自有 descriptor 找到实例。 | Desktop Host 通过私有 Node IPC 把 ready URL 交给 Electron main；Electron 立即换取 Cookie 并在内存持有。Desktop Host 子进程也将 stdout 管道转发给 Electron main；Web bundle 默认打印 `dsh web: <authenticatedUrl>`。 | Desktop URL token 可能经 stdout 到达，但 Windows 打包 GUI 进程的管道捕获与单实例转发行为未实测。已运行实例没有被源码证明的外部 descriptor，因此不能假设能靠端口扫描重取令牌。 |
| 认证与请求载体 | 启动 token 换 authority 专属签名 Cookie；HTTP unary 与 WS mux 直接携带 Cookie。 | Electron 通过同一启动 token 换 Cookie，自己代理 HTTP / WS；Electron 默认 cookie store 不持有此 Host Cookie。 | 如果可靠取得该 Desktop 实例当前的认证 URL，现有 DSH Web client transport 基本形状可直连其 loopback Remote API；端点取得与匹配版本协议库是两个独立前置条件。凭据须按秘密处理。 |
| 会话数据及运行状态 | 持久会话写入 `DSH_HOME` 下 session store；Web 进程拥有自己的内存 Agent 与 Gateway generation。 | 同一 `DSH_HOME` 使用相同持久化 Session store；Desktop 进程 / Gateway generation 独立，且可能因单写者锁看到另一个运行实例占用。 | 有共同磁盘历史不等于运行流、审批或 writer 状态跨进程同步；两入口分开路由，不复制历史，也不误报另一进程运行态为已连接。 |
| 额外本机接口 | 浏览器页面自身能力。 | 增加 Electron preload / IPC 和应用更新、窗口、系统文件能力。 | Desktop 专有 shell IPC 不属于 Orbis 所需 Remote API，不复用、不依赖。 |
| 协议代码来源 | Orbis 当前从选定 CLI 包加载 Gateway / Connection schema 和 assistant-stream decoder。 | Desktop wrapper 的 `dsh.cmd` 将 Electron RunAsNode 指向 `app.asar` 内的 private Desktop CLI host；普通 Node launcher 搜索不能解析其 owning `@deepseek-ai/dsh` package entry。 | 需为 Desktop 实例取得精确版本的协议定义 / decoder，或验证受控桥接方案；不能从 PATH 后面随便挑 npm dsh 包代替。 |

因此，**Web 与 Desktop 的业务 Remote API 大体相同，启动、端点交付、认证持有者、壳层转发和协议库可定位性不同**。最可复用的是已认证 Remote transport、会话映射及历史投影；不能直接复用的是“如何找到实例”和“如何证明所加载协议版本匹配”。

### Codex VS Code 对照（独立产品，不属于 DSH 接入）

本次检查官方 Marketplace 上的 `openai.chatgpt` Windows 扩展包 `26.51106.51428`（2026-11-11 更新，Marketplace 标记为 prerelease）。VSIX SHA-256 与 Gallery API 声明值一致，完整校验值和各抽取文件 SHA-256 见 [取证元数据](../../.artifacts/codex-vscode-assessment-20261112/evidence.json)；包内 [extension.js](../../.artifacts/codex-vscode-assessment-20261112/extension/out/extension.js)、VSIX manifest、README 和 runtime manifest 已留存。该版本的 VSIX 元数据声明扩展运行在 workspace host，并将 `bin/windows-x86_64/codex.exe`、exec server 与资源随扩展分发；`codex-package.json` 固定其 CLI 版本为 `0.167.0-alpha.4.1`。默认可执行文件路径位于扩展自己的平台目录。`chatgpt.cliExecutable` 是 development-only 覆盖项，说明明确提醒手动设置可能令部分功能失效。常规 VS Code 安装因此不依赖全局 PATH 中的 npm / irm Codex CLI。

扩展自行启动随包 Codex CLI 的 `app-server` 子进程，以 stdin/stdout 管道按 JSONL 收发 Codex 双向 JSON-RPC-lite 消息，并发送 `initialize` 握手；本次包内启动参数没有 `--listen`，也没有对 Orbis 公布可发现的 Desktop 端点描述文件。官方 App Server 文档将其定义为 IDE 等 rich client 使用的 thread / turn API，涵盖持久化历史、配置与认证、工具执行、流式事件和审批。`thread/list` 的 `sourceKinds` 默认同时包括 `cli` 与 `vscode`，说明列表 API 可按来源类别过滤；这些类别不等同于客户端产品身份，也不表示运行进程或写者归属相同。官方工程文章也说明 IDE 与 Desktop 会随包固定经过测试的 runtime。[openai-app-server-docs][openai-app-server-blog] Codex VS Code 的独立身份与候选桥接路径见 [ADR-0079](0079-codex-vscode-integration.md)；该路径不改变本 ADR 对 DSH Web / Desktop 的接口和会话边界。

扩展另含 macOS 专用的 ChatGPT 桌面应用“Work with VS Code”桥接：注册文件指向本地 Unix domain socket；允许的操作限于编辑器内容、选择区、行高亮和少数编辑器操作，工作区未信任时仅允许 `ping`。这是独立的 IDE 壳层桥，不是 Codex `app-server` thread/history API，也没有证据表明它同步 VS Code 与 Desktop 会话；此路径在 Windows 不启用。[openai-codex-marketplace]

官方 Codex Desktop 应用说明会沿用 CLI 与 IDE 扩展的会话历史和配置。因此 Codex 的参照是共享原生持久数据、区分客户端来源与 runtime / 连接生命周期；它不是独立历史，也不表示 Orbis 要在客户端之间做历史同步。[openai-codex-app-intro] 这不能证明 DSH Desktop 对外采用 Codex App Server，也不改变本 ADR 对 DSH Remote API、端点发现和会话边界的结论。Orbis 接入仍应按 DSH 已证实的接口实现，维持 `dsh` / `dshDesktop` 独立身份，不复制或对账两入口的历史。

## 决策

| 场景 ID | 接入行为 |
| --- | --- |
| DSH-DESKTOP-01 | Desktop 安装发现独立于 CLI。分别表达已安装、运行中、可连接和版本不兼容；仅发现可执行文件不能报告连接成功。 |
| DSH-DESKTOP-02 | Desktop 入口连接 Desktop 自己拥有的后端，完成认证和原生握手后才进入就绪；不以另起 Web 服务替代 Desktop。 |
| DSH-DESKTOP-03 | Web / Desktop 各自拥有 agent kind、会话与 runtime 命名空间、连接及重连状态。相同原生 session ID 不合并路由；具体 wire ID 格式在实现时确定。 |
| DSH-DESKTOP-04 | 会话列表、历史和执行状态由所连接实例提供。保持原生 `DSH_HOME` 及其共享语义，Orbis 不进行跨入口历史同步，也不修改主目录来强制隔离。 |
| DSH-DESKTOP-05 | Desktop 继承其原生模型、权限和供应商设置；接入时不自动套用 Web 的供应商配置写入流程。未来设置编辑以原生 API 能力另行确定。 |
| DSH-DESKTOP-06 | 新 `dshDesktop` 能力按对端实际解析能力协商，注册、状态更新、目录和命令路由统一适配。旧端继续使用既有 Web 入口；不能将未知枚举直接发送给严格 schema。 |
| DSH-DESKTOP-07 | Desktop 应用及后端归其原生启动器所有。Host 断开只释放自己的连接和桥接资源；退出、更新按已确认的资源归属收尾，不据进程名终止 Desktop。 |
| DSH-DESKTOP-08 | 协议校验与历史解码匹配实际连接的 Desktop 版本。PATH 中另一份 npm dsh 的库不能无校验地替代；更新后重新核对并重连。 |
| DSH-DESKTOP-09 | Desktop 只从 Orbis 打开，并按 HOST-GUIDE-01 引导，不加说明文字。Host 概览有「DeepSeek 桌面版」行：状态点 + 悬停短状态，唯一操作「打开」，强调色只跟随当前一步。用户自行打开的实例由用户退出后再由 Orbis 打开；Orbis 不结束它。分档原因均为短状态，手机发起失败时原样显示。 |
| DSH-DESKTOP-10 | 生命周期停止和 Host 打开取消后，各异步发现、原生启动准备与协议连接阶段统一核对所属操作；迟到连接自行释放，探测只发布当前状态，恢复与显式接入共用一次连接。已经启动的 Desktop 继续归原生应用所有。 |

实现可抽取 DSH Web 的协议传输、消息映射和历史投影共用部分；安装发现、认证端点取得、版本加载、生命周期与后端选择保持独立。参考 [codex-desktop-lifecycle.ts](../../packages/host/src/codex-desktop-lifecycle.ts) 和 [codex-desktop-launcher.ts](../../packages/host/src/codex-desktop-launcher.ts) 的职责划分，不假设 DSH 提供与 Codex 相同的包装入口。

原生同一会话在两条入口中可见时，仍可能因另一个实例持有写锁而无法恢复执行，应保留原生占用结果。是否可见还受实例、主目录、版本及列表过滤影响；当前 Orbis Web catalog 过滤缺少 `cwd`、归档范围不符、subagent 和默认隐藏的 blank 会话，见 [dsh-web-runtime.ts](../../packages/host/src/dsh-web-runtime.ts) 的 `catalog`。尚无用户现场的版本、主目录和列表证据，不能将其历史不可见归因为某一种情况。

## 实现（2026-11-13）

选定机制：Orbis 打开的 Desktop 实例 + 官方 API Peer。插件桥接未采用。

| 决策 | 实现 | 代码 |
| --- | --- | --- |
| [DSH-DESKTOP-01](#决策) | 显式路径（`ORBIS_DSH_DESKTOP_PATH`）优先且不回落；Windows 读 `HKCU` / `HKLM` 卸载项中 `DeepSeek Harness*` 的 `InstallLocation`，再查 `%LOCALAPPDATA%\Programs`；macOS 先查 `/Applications`、`~/Applications`，未找到再按应用标识（正式版 `com.deepseek.dsh`、上游本地构建 `com.deepseek.harness`）查 LaunchServices 与 Spotlight，覆盖外置盘等位置；跳过废纸篓，只读副本（安装镜像、App Translocation）排后。候选须有可执行文件和 `app.asar`，归档内须有 `@deepseek-ai/dsh` 与 `dsh-desktop-host`。分档为 unsupported / notInstalled / closed / running / attached / incompatible / error，握手完成才是 attached；incompatible 不列为可启动。 | [dsh-desktop-app.ts](../../packages/host/src/dsh-desktop-app.ts)、[dsh-desktop-lifecycle.ts](../../packages/host/src/dsh-desktop-lifecycle.ts) |
| [DSH-DESKTOP-02](#决策) | Orbis 以 detached 方式直接启动 Desktop 可执行文件，stdout / stderr 写入 Host 状态目录内权限 600 的日志，取 Electron 转发的最新 `dsh web:` URL，用根路径令牌交换确认实例（不建 Peer），再为每个载体经 `/connect?…&interactions=answer` 建独立 owner API Peer。用户自行打开的实例及单实例交接（新进程以 0 退出且无 URL）报告 running；不扫描端口、不读 Cookie、不用私有 IPC。 | [dsh-desktop-app.ts](../../packages/host/src/dsh-desktop-app.ts)、[dsh-web-client.ts](../../packages/host/src/dsh-web-client.ts) `authentication: "api"` |
| [DSH-DESKTOP-03](#决策) | 独立 kind `dshDesktop`，会话 / runtime 前缀 `dsh-desktop:`；Host 内 Web 与 Desktop 各有连接、启动和恢复状态。未带 kind 的恢复按前缀路由，Desktop 不参与无前缀轮询。 | [dsh-web-runtime.ts](../../packages/host/src/dsh-web-runtime.ts) `DshFlavor`、[host-service.ts](../../packages/host/src/host-service.ts) |
| [DSH-DESKTOP-04](#决策) | 目录与历史均来自所连实例的 Remote API，不复制、不同步；同一原生 ID 在两入口各自显示。entryId 仍由原生 ID 推导，按 runtime 隔离。 | 同上 |
| [DSH-DESKTOP-05](#决策) | Desktop 只读 `session/modelCatalog`，不调用 `session/initializeDefaultModel`、`settings/describe` 或凭据写入；供应商管理排除 `dshDesktop`。启动环境去掉 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS` 和 Orbis 私有 DSH 变量。 | [dsh-web-runtime.ts](../../packages/host/src/dsh-web-runtime.ts)、[provider-manager.ts](../../packages/host/src/provider-manager.ts) |
| [DSH-DESKTOP-06](#决策) | Host 在 `device.ready.hostFeatures` 公告 `device.features`，App 回复 `device.features: ["agent.dshDesktop"]`，每次握手重新声明。未声明设备（含全部已发布 App）收到的 device.ready、运行时消息、host 目录 / 后端 / 供应商 / 操作域、目录范围页、会话列表和诊断都不含 Desktop；目录总数和游标按过滤清单计算，过滤视图游标独立。投影在增量计算前完成。新 App 收到不含 `dshDesktop` 键的过滤视图时先声明并等待完整 device.ready，5 秒无回应再应用过滤视图；声明前读过过滤视图的设备，首次完整读取忽略其 `known`。 | [index.ts](../../packages/protocol/src/index.ts)、[dsh-desktop-visibility.ts](../../packages/host/src/dsh-desktop-visibility.ts)、[host-state-facts.ts](../../packages/host/src/host-state-facts.ts)、[agent-state-subscriptions.ts](../../packages/host/src/agent-state-subscriptions.ts)、[OrbisStore.swift](../../ios/Orbis/Orbis/OrbisStore.swift)、[HostConnection.kt](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt) |
| [DSH-DESKTOP-07](#决策) | Host 停止或暂停只关闭自己的 API Peer。Desktop 进程 detached，输出写文件，Host 退出不产生 EPIPE；Host 重启从私有描述文件恢复同一实例。产品代码不终止 Desktop。 | [desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts) |
| [DSH-DESKTOP-08](#决策) | 读取所连 Desktop 的 `app.asar` 并按其 SHA-256 完整性记录校验，沿 Gateway stream protocol、Connection 与 assistant-stream 三个入口的导入图把闭包提取到 `<状态目录>/dsh-desktop-protocol/<归档头指纹>`；加载失败或缺 `/connect` 报告 incompatible。归档变化生成新副本，保留上一份。 | [asar-archive.ts](../../packages/host/src/asar-archive.ts)、[dsh-desktop-protocol.ts](../../packages/host/src/dsh-desktop-protocol.ts) |

| [DSH-DESKTOP-09](#决策) | Host 概览「DeepSeek 桌面版」行（电脑图标，DeepSeek 色）：已接入 / 可按需打开为绿点；`running`（非 Orbis 打开）、`incompatible`、`error` 为警示点，悬停短状态分别为「需由 Orbis 打开」「版本不兼容」「接入失败」。「打开」在下一步为打开 Agent 时与其他行一同强调。点击立即返回，打开在串行命令队列之外执行并以 `dshDesktopOpen`（`opening` / `waiting` / `idle`）事件报告，按钮期间显示加载、悬停「等待退出」：Orbis 打开的实例经单实例交接调到前台；已关闭则由 Orbis 打开；用户自行打开的实例每 2 秒检查一次，至多等待 10 分钟，用户退出后由 Orbis 打开，Host 随即通过恢复接入；暂停时打开的实例在下次启动时接入。同一状态目录的 Orbis 启动全进程共享一次，App 请求与界面打开不会互相覆盖端点记录。诊断页增加「DeepSeek 桌面版接入」卡，诊断导出含该分档。CLI Host 同样接入 Desktop（手机发起时打开），停止时只释放连接。Android 拉起提示不再对 Desktop 会话称“电脑上无窗口”；抽屉筛选显示条件与 iOS 一致（Host 提供或已有桌面版会话）。 | [dsh-desktop-lifecycle.ts](../../packages/host/src/dsh-desktop-lifecycle.ts) `openDshDesktopFromHost`、[dsh-desktop-app.ts](../../packages/host/src/dsh-desktop-app.ts) `launchDshDesktop` / `revealDshDesktop`、[desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts)、[cli.ts](../../packages/host/src/cli.ts)、[host-service.ts](../../packages/host/src/host-service.ts)、[HostController.cpp](../../packages/windows-host/src/HostController.cpp)、[Main.qml](../../packages/windows-host/src/qml/Main.qml)、[MainActivity.kt](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)、[SessionDrawer.kt](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt) |

App 把 `dshDesktop` 作为 DeepSeek 的桌面版本：图标仍为一个，在旁选择网页版 / 桌面版，与 Codex 终端版 / 桌面版一致；会话筛选只在 Host 提供 Desktop 时出现「DeepSeek 桌面版」。未新增说明文案。

DSH-DESKTOP-10（2026-11-14）：[dsh-desktop-lifecycle.ts](../../packages/host/src/dsh-desktop-lifecycle.ts) 在安装、端点、进程、协议与连接返回后检查取消，使用连接复用与探测代次防止迟到结果覆盖 attached；[dsh-desktop-app.ts](../../packages/host/src/dsh-desktop-app.ts) 将取消检查延伸到真正 spawn 前。共享启动的发起者在 spawn 前取消时，仍有效的加入者重新发起自己的启动，普通启动错误照常返回。spawn 后继续记录端点供恢复使用，释放的仅是迟到的 Orbis API Peer。Host 停止先取消 lifecycle，再等待服务收尾，见 ADR-0081 的 HOST-DESKTOP-CANCEL-01。

已知限制：用户自行打开的 Desktop 不能接入，只能由用户退出后从 Orbis 打开（DSH-DESKTOP-09）；Desktop 日志随运行增长，下次由 Orbis 打开时重建；120 秒内未报告 URL（例如首次设置）时报告「等待 DeepSeek 桌面版完成设置」，之后由恢复接入；新 App 首次连接多一次往返；手机端不显示 Desktop 分档，只在发起失败时显示短状态。

接入用户自行打开的 Web / Desktop 的评估（2026-11-13，暂缓）：DSH 每个 Remote 调用都要认证，外部客户端的官方入口只有 `/connect?token=<启动令牌>`，令牌每进程随机生成且只在内存，没有实例登记文件；非 owner 的 remote-access 不能回答审批。可行路径是在 `$DSH_HOME/cordis.patch.yml`（对所有 profile 含 Desktop 生效）插入 Orbis 插件，由其调用公开的 `ctx.connection.authenticatedUrl()` 写出权限 600 的端点描述。隔离原型在 dsh 0.2.1-rc.2 / 0.2.1-rc.5 / 0.2.2-rc.1 上验证了用户自启 Web 可接入、与浏览器并存、HMR 增删、退出清理、模块缺失不阻止启动、非 Web profile 无告警；Desktop 未实测。因需改写用户 DSH 配置而暂缓。证据：[dsh-endpoint-bridge-20261113](../../.artifacts/dsh-endpoint-bridge-20261113/)，探针 `~/.orbis/tools/ui-regression/dsh-endpoint-bridge-probe.mjs`。

## 接入候选与难度（调查记录）

以下为 2026-11-12 调查时的评估，实现采用第 1 项。

| 工作 | 评估 | 依据与待确认点 |
| --- | --- | --- |
| Windows 安装识别 | 低 | 官方安装器记录卸载注册项 `InstallLocation`（[L265][up-install]）；可结合手选路径和实际可执行文件校验。自定义目录、移动安装、多个候选及旧版注册项仍需验证。 |
| 独立入口和身份路由 | 中 | 可参考 Codex 双入口，但涉及协议枚举、Host 状态、App 展示、重连和旧端兼容。 |
| 复用传输及会话映射 | 中 | 共享原生 Remote API 提供基础；仍需验证 Desktop profile 的实际能力、审批、历史解码和设置归属。 |
| 加载匹配协议库 | 中 | 当前 CLI 包解析已证明无法定位 Desktop 包入口。需要验证 ASAR 内运行时、外置依赖与升级后的版本绑定，不能把 Electron 内可用的包路径直接当作 Orbis Node 可导入目录。 |
| 自动取得 Desktop 认证端点 | 中至高，主要不确定项 | 已有启动 URL 和 API 认证机制，但外部发现、已运行实例、Windows 打包 GUI stdout、动态端口及令牌轮换尚无实测。 |

可按以下顺序做最小原型，尚未选定生产机制：

1. **先验证 Desktop 认证接入。** 获取当前 desktop Host 的 ready URL 后，优先用官方 `/connect?token=...&interactions=answer` 建立独立 API Peer，再分别做 unary 与 Mux `$events` / Session 流调用；与复用 Electron 的浏览器 Cookie 作对照。Desktop 采用 Web bundle 模板（[project-manager.ts L31][up-profile-template]），默认配置打印认证 URL，Host 子进程 stdout 转发到 Electron main stdout。由此推断可以评估 Orbis 启动应用时捕获 URL；Windows 已打包 GUI 是否提供可捕获输出、单实例已启动时如何取得端点均待确认。还需在 Desktop 页面保持打开时验证连接代际、重复事件和并发审批不会重复处理。未完成这些验证前，不将 stdout 或 `/connect` 路径当作支持承诺。
2. **评估官方插件桥接。** Desktop 支持通过其内置 CLI 管理插件，但须初始化后退出应用再操作（[L138][up-plugin]）。可研究由插件发布当前用户私有的实例描述并提供连接能力；需要验证官方 Connection API、权限、升级、插件失败恢复与卸载行为。这是备选方案，尚未证明必要或可用。
3. **验证版本匹配。** 对照实际安装包选择可维护的协议加载或桥接方式，确认接入不依赖另一份 npm 安装。单独设置一个 URL 不能解决当前 `packageEntry` 与解码器缺失。

连接凭据按本地私有数据处理，证据及普通诊断日志不保存真实令牌。首次握手、重连和端点替换应确认实例归属，完成后才允许会话操作。

不做跨入口同步减少了范围，但发现 Desktop 与完整接入 Desktop 仍是两项工作。本次没有足够的 Windows 运行证据承诺工期。

## 已执行验证与后续门槛

已在 macOS、Node `v22.23.2` 上执行隔离发现探针，调用当前 Orbis 发现逻辑并传入 `platform: "win32"`；使用合成目录与官方 `dsh.cmd` 原文。结果见 [discovery-fixtures.json](../../.artifacts/dsh-desktop-assessment-20261112/discovery-fixtures.json)，可复现工具副本见 [dsh-desktop-assessment.mjs](../../.artifacts/dsh-desktop-assessment-20261112/tools/dsh-desktop-assessment.mjs)。

| 探针 ID | 结果 |
| --- | --- |
| DSH-DESKTOP-DISC-01 | 通过：只有 Desktop 布局、未注册 PATH，当前 CLI 发现为空。 |
| DSH-DESKTOP-DISC-02 | 通过：注册 Desktop `dsh.cmd` 后能发现 launcher，协议包入口仍为空。 |
| DSH-DESKTOP-DISC-03 | 通过：普通 npm launcher 正对照可以定位同一安装的 dsh 包入口。 |
| DSH-DESKTOP-DISC-04 | 通过：Desktop 在 PATH 首位时，后面的 npm 安装不会为它提供不匹配的协议库。 |

这些结果验证发现和包解析，不验证 Windows 命令执行、注册表、Electron、真实 ASAR 或 Desktop 连接。探针未访问真实 DSH 主目录，临时夹具已清理。上游 100 份唯一源码的 Git blob 校验、与预发布 tag 的全量源码对照、接口清单生成和文档静态检查记录在 [verification.json](../../.artifacts/dsh-desktop-assessment-20261112/verification.json)。

### 实现验证（2026-11-13）

自动验证在 macOS、Node `v22.23.2` 上执行，证据见 [dsh-desktop-implementation-20261113](../../.artifacts/dsh-desktop-implementation-20261113/)；工具在 `~/.orbis/tools/ui-regression/`。均使用隔离 `HOME` / `DSH_HOME`、合成模型和合成会话，未访问真实凭据、Host 或 Relay。

| 验证 ID | 结果 | 证据 |
| --- | --- | --- |
| DSH-DESKTOP-CONNECT-01 | 通过：官方 dsh `0.2.2-rc.2` 隔离实例上 `/connect` 返回 302 与 Cookie；套接字前 HTTP 可用；同一 Cookie 第二个套接字 409；套接字关闭后 HTTP 401；重新交换得到新 Cookie；错误令牌 401。 | [connect-peer-probe.json](../../.artifacts/dsh-desktop-implementation-20261113/connect-peer-probe.json)，`dsh-connect-peer-probe.mjs` |
| DSH-DESKTOP-ATTACH-PROBE | 通过：合成 macOS Desktop 布局（由真实 `0.2.2-rc.2` 生产树打成的 709 MiB 归档，38,846 个文件）配真实后端。完成发现、启动、600 权限日志、Node 开关不外泄、提取 224 个文件 / 2.1 MB / 14 个包、API Peer 接入、合成模型一轮回复和 `dshDesktop` 目录；释放 Peer 后 Desktop 仍在，恢复与再次请求均未重开。 | [attach-probe.json](../../.artifacts/dsh-desktop-implementation-20261113/attach-probe.json)，`dsh-desktop-attach-probe.mjs` |
| DSH-DESKTOP-COMPAT-APP | 通过：`v0.1.19` iOS 目录解析器（标签源码原样编译）接受未声明设备的视图（150 个会话、多页）；未过滤目录被拒，作为负对照。 | [release-app-compat.json](../../.artifacts/dsh-desktop-implementation-20261113/release-app-compat.json)，`dsh-desktop-release-app-compat.mjs` |
| 单元与集成 | 通过：Host / protocol 166 个文件 1,916 项（新增 ASAR、协议闭包、安装与启动、生命周期、API Peer、Desktop flavor、可见性、Host 协商与路由）；iOS 核心 3 项；Android `DshDesktopEntryTest`；iOS App generic Simulator 编译与 Android Debug Kotlin 编译。 | [summary.json](../../.artifacts/dsh-desktop-implementation-20261113/summary.json) |

DSH-DESKTOP-09 自动验证（2026-11-13，macOS、Node `v22.23.2`、Qt 6.8.3），证据见 [dsh-desktop-host-ui-20261113](../../.artifacts/dsh-desktop-host-ui-20261113/)：

| 验证 ID | 结果 | 证据 |
| --- | --- | --- |
| DSH-DESKTOP-OPEN-01 | 通过：界面打开调到前台 Orbis 的实例、打开已关闭实例、等用户退出后再打开、超时或取消时不启动；同一状态目录并发启动只 spawn 一次；调到前台的交接进程不写端点记录；`openAgent` 立即返回，重复点击合并，进度与错误经事件到达。typecheck、ESLint 与相关 10 个文件 221 项通过。 | `logs/ts-focused.log`、`logs/eslint.log` |
| DSH-DESKTOP-OPEN-MUT | 变异对照：去掉共享启动、去掉退出等待、让打开阻塞命令队列，各自使对应测试失败；源文件按哈希恢复。 | `logs/mutations/` |
| DSH-DESKTOP-HOSTUI-01 | 通过：Qt 构建与 10 组 CTest；`--smoke-guide`（标准与最小窗口）在打开一步断言「DeepSeek 桌面版」行强调，`running` 时仍为强调的「打开」，等待时按钮加载，接入后恢复；`--smoke-appearance` 通过；日志无 QML 错误。 | `logs/build/`、`smoke/guide*/`、`smoke/appearance/` |
| DSH-DESKTOP-HOSTUI-SMOKE52 | 既有失败：默认与最小窗口 `--smoke-motion` 在第 4 页侧栏动效采样时进度为 0（退出码 52）。同一时间、同一 runtime 下，上一版构建（`host-live-config-20261112`，不含本次 QML）两次同样失败，判断与本次改动无关，原断言保留。 | `smoke/default*/`、`smoke/compact/`、`smoke/baseline-default*/` |
| DSH-DESKTOP-ANDROID-01 | 通过：Android `DshDesktopEntryTest` 2 项（含 Debug Kotlin 编译），Desktop 入口不再报“电脑上无窗口”。 | `logs/android-unit-2/` |

macOS 按应用标识发现（2026-11-13，macOS 27.2、Node `v22.23.2`），证据见 [dsh-desktop-bundle-discovery-20261113](../../.artifacts/dsh-desktop-bundle-discovery-20261113/)：

| 验证 ID | 结果 | 证据 |
| --- | --- | --- |
| DSH-DESKTOP-DISC-03 | 通过：常用目录外的安装按应用标识找到，跳过废纸篓、可写副本优先，查询失败报告未安装；常用目录有安装时不发起查询。去掉三项行为的变异各自使测试失败。typecheck 与 ESLint 通过。 | `summary.json`、`vitest.log` |
| DSH-DESKTOP-DISC-03-REAL | 通过（只读）：外置盘 `/Volumes/WD1TB/Applications` 上的官方 `0.2.2-rc.2`，已安装的旧 Host 发现为空；本次源码默认发现找到该安装（149 ms）并识别运行中。未启动、未接入、未改动 Host。 | `summary.json`、`real-install-probe.mts` |

DSH-DESKTOP-10 回归（2026-11-13—14）：[生命周期测试](../../packages/host/src/dsh-desktop-lifecycle.test.ts) 与 [启动测试](../../packages/host/src/dsh-desktop-app.test.ts) 覆盖逐阶段取消、迟到 Peer 清理、旧探测、并发复用与 spawn 前取消。DSH / Codex Desktop、共用 Web 接口、Host 暂停恢复等 23 文件共 313 项通过、5 项平台跳过；最初两项取消复现修复后均通过。证据：[all-regression-after.log](../../.artifacts/recent-risk-fixes-20261113/desktop/all-regression-after.log)、[original-repro-focused-after.log](../../.artifacts/recent-risk-fixes-20261113/desktop/original-repro-focused-after.log)。未启动真实 Desktop、未构建或部署候选版本，用户验收待完成。

以下门槛需要真实 Desktop 安装、设备或已发布旧版本运行环境，均未执行：

| 验证 ID | 验证目标 | 当前覆盖 |
| --- | --- | --- |
| DSH-DESKTOP-ATTACH-01 | Windows 只装 Desktop、没有 Node/npm/dsh PATH 时，识别安装并接入其实际后端；包含自定义及中文空格路径。 | 注册表与路径为注入式单元测试；Electron 打包 GUI 重定向 stdout 未实测。 |
| DSH-DESKTOP-ATTACH-02 | 已运行实例与由 Orbis 启动的实例均可接入；Desktop 关闭、重启、升级和令牌轮换后状态准确，没有第二个 profile 写入者。 | 由 Orbis 启动、恢复与复用见合成探针；令牌轮换见单元测试。 |
| DSH-DESKTOP-SESSION-01 | 新建、恢复、读取历史、流式输出、取消与审批操作到达同一 Desktop 实例；Web 同时运行时不串路由，保留原生写锁结果。 | 新建与回复见合成探针；同 ID 分路见 Host 集成测试；审批、取消未在真实 Desktop 上执行。 |
| DSH-DESKTOP-HISTORY-01 | 相同及不同 `DSH_HOME` 的受控数据下，各入口按原生返回显示；无复制、迁移、跨入口去重或配置改写。 | 未执行。 |
| DSH-DESKTOP-VERSION-01 | 真实 Desktop 安装包与其匹配协议库完成同版正对照；与 npm Web 并存、升级及不支持版本下准确处理。 | 合成归档同版正对照；真实安装包未执行。 |
| DSH-DESKTOP-COMPAT-01 | 按 ADR-0064 使用最近发版的真实 Host / Relay / App 实现验证新旧互通、重连和回退；未协商的 Desktop 能力不破坏既有连接。 | 已发布 iOS 目录解析器已核对；真实旧 App / 旧 Host 设备互通未执行。 |
| DSH-DESKTOP-LIFECYCLE-01 | Host 暂停、退出、更新与桥接故障释放自身资源，Desktop 原生任务和配置保持正确归属。 | 释放 Peer 不停 Desktop 见合成探针；Windows 退出与更新未执行。 |
| DSH-DESKTOP-GUIDE-01 | 真实 Desktop 上：自行打开 → 概览警示点与「需由 Orbis 打开」→ 点「打开」等待 → 退出 Desktop → Orbis 打开并接入；Orbis 打开的实例点「打开」调到前台（含 Windows 托盘隐藏窗口）；手机发起时显示短状态。 | 等待、交接与共享启动为注入式测试与合成 smoke；真实 Desktop 与 Windows 托盘行为未执行。 |

未构建安装包、未部署。用户验收需要装有 DeepSeek Harness Desktop 的 Windows 或 macOS 电脑及包含本次修改的候选版本，待用户验证。

2026-11-12 交付为调查、ADR 和证据归档；2026-11-13 实现记录见上文。

[up-desktop-cli]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/README.zh.md#L64-L68
[up-desktop-runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/README.zh.md#L136-L146
[up-shim]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/cli/dsh.cmd
[up-host]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop-host/src/index.ts#L19-L43
[up-cli-profile]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/cli/src/args.ts#L83-L86
[up-ready]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop-host/src/index.ts#L135-L136
[up-auth]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src/web-document.ts#L43-L49
[up-desktop-architecture]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/README.zh.md#L40
[up-connection]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/client/connection/README.zh.md#L41-L53
[up-print-config]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/bundle/web-app/cordis.patch.yml#L202-L206
[up-print]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/bundle/web-app/src/index.ts#L218-L231
[up-stdout]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src/host-process.ts#L210-L228
[up-ownership]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/README.zh.md#L123
[up-sessions]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/bundle/base/cordis.patch.yml#L138-L141
[up-home]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/util/home-paths/src/index.ts
[up-settings]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/README.zh.md#L297
[up-list]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/api/session-controller/src/list.ts#L124-L188
[up-writer]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/session/session-persistence-jsonl/README.zh.md#L168
[up-writer-error]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/api/session-controller/src/agent.ts#L190-L202
[up-install]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/README.zh.md#L265
[up-profile-template]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src/project-manager.ts#L31
[up-plugin]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/README.zh.md#L138
[up-profile-bundles]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/util/official-bundles/src/bundles.ts#L10-L16
[up-desktop-template]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src/project-manager.ts#L28-L32
[up-connection-transport]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/client/connection/README.zh.md#L30-L34
[up-gateway-protocol]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/api/gateway/src/stream-protocol.ts#L7-L13
[up-session-api]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/api/session-controller/src/index.ts#L281-L630
[up-workspace-api]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/api/workspace-controller/src/index.ts#L90-L206
[up-shell-forward]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src/main.ts#L797-L856
[up-web-forward]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src/web-document.ts#L97-L113
[up-desktop-ipc]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src/ipc.ts#L12-L42
[up-preload-app]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src/preload-app.ts#L16-L128
[up-ipc-guard]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src/ipc.ts#L105-L128
[up-events]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/api/remotes/src/remote-events.ts#L27-L58
[up-user-question-api]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/interaction/user-questions/src/index.ts#L169-L221
[up-permission-api]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/interaction/permission-presets/src/index.ts#L288-L292
[up-skills-api]: https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/api/session-controller/src/skill-catalog.ts#L20-L36
[openai-app-server-blog]: https://openai.com/index/unlocking-the-codex-harness/
[openai-app-server-docs]: https://developers.openai.com/codex/app-server
[openai-codex-app-intro]: https://openai.com/index/introducing-the-codex-app/
[openai-codex-marketplace]: https://marketplace.visualstudio.com/items?itemName=OpenAI.chatgpt
