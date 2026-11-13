# ADR-0079：Codex VS Code 独立接入

日期：2026-11-12

Status: proposed（独立来源身份已提议；进程接入和线程归属均未验证，连接器未实现）

关联：[ADR-0021](0021-codex-terminal-host-attachment.md)、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0076](0076-deepseek-harness-desktop-integration.md)。

## 问题与结论

Orbis 当前的 `codex` 接入自有终端 app-server，`codexDesktop` 接入 Codex Desktop 自己启动的 app-server。Codex VS Code 扩展是第三条运行入口：它在扩展目录携带 Codex CLI，私有启动 app-server 并通过 stdio 收发协议。默认安装不要求 PATH 中有 npm 或官方独立安装的 Codex CLI，所以仅检查全局命令无法识别这条入口。[F01–F04]

VS Code 扩展没有向 Orbis 公布 app-server 地址或端点描述文件。独立再启动一份 Codex CLI / app-server 不能接管 VS Code 当前进程；即使两边读到同一 `CODEX_HOME`、列出同一批原生线程，也不能据此认定共享在线事件、审批状态或写者。接入目标应是 VS Code 扩展实际启动的那一份 app-server。[F03、F05]

提议增加独立的 `codexVsCode` 来源身份，区分终端、Desktop 与 VS Code 三条 Orbis 路由。它仍是同一个 Codex 产品：保留原生 `CODEX_HOME` 与 Codex 的会话共享行为，不复制、迁移或在 Orbis 内同步历史。但当前证据不能用 `threads.source = vscode` 或 `sourceKinds: ["vscode"]` 唯一筛出 VS Code 的线程；Desktop 及其他走普通 `codex app-server` 的入口也可能写入该来源。只有连接到扩展实际启动的 app-server，并能证明线程与该入口的关系，才可提供独立的 VS Code 在线目录与历史入口。[F05–F08、F10、F11]

目前唯一发现的扩展进程入口是 `chatgpt.cliExecutable`。该设置在所检查包中标为 development-only、application scope、restricted，并警告手动覆盖可能令扩展部分功能失效。官方 app-server 文档还将 TCP WebSocket 监听标为 experimental / unsupported。故包装该设置是候选原型，不是当前可承诺的生产接口；未完成目标平台和扩展版本验证前，不自动改写用户 VS Code 配置或宣称已支持。[F03、F04、F09]

## 调查范围与证据

本机保留的 Marketplace Gallery 查询于 2026-11-12 取得 `openai.chatgpt` Windows x64 包 `26.51106.51428`，包标记为 prerelease，Marketplace 更新于 2026-11-11。其 VSIX 哈希与 Gallery 声明一致；包内 manifest、扩展代码、README 与 runtime manifest 已抽取并逐文件留哈希。证据及提取限制见 [取证元数据](../../.artifacts/codex-vscode-assessment-20261112/evidence.json) 和 [官方文档抓取记录](../../.artifacts/codex-vscode-assessment-20261112/official-docs.json)。这是单一 Windows 预发布包的静态快照，不代表其他平台或版本行为。[F01]

| ID | 已核对事实 | 证据 |
| --- | --- | --- |
| F01 | 官方 Gallery 返回 `openai.chatgpt` `26.51106.51428`、Windows x64、pre-release；VSIX SHA-256 匹配 Gallery。runtime manifest 固定随包 Codex CLI 为 `0.167.0-alpha.4.1`，包含 CLI、exec server、resources 和 path 目录。 | [evidence.json](../../.artifacts/codex-vscode-assessment-20261112/evidence.json)、[VSIX manifest](../../.artifacts/codex-vscode-assessment-20261112/extension.vsixmanifest)、[codex-package.json](../../.artifacts/codex-vscode-assessment-20261112/extension/bin/windows-x86_64/codex-package.json) |
| F02 | 扩展可执行文件选择逻辑先读 `chatgpt.cliExecutable`；为空时按扩展 URI 和平台解析器使用扩展自带的 `bin/.../codex.exe`。启动环境还把扩展平台目录加入 PATH，并保留扩展宿主环境。 | [extension.js](../../.artifacts/codex-vscode-assessment-20261112/extension/out/extension.js) `binary_path_resolver`、`child_process_launcher` |
| F03 | 扩展运行 `codex app-server`，参数含两个功能配置项及 `--analytics-default-enabled`，通过 stdin/stdout/stderr 管道与 JSONL app-server 双向收发；扩展发送 `initialize` 与 `initialized`。抽取代码未发现 `--listen`、Orbis 端点文件或向外发布的 app-server 端点。 | 同上 `app_server_start`、`initialize_request`；[Codex App Server 文档](https://developers.openai.com/codex/app-server/) |
| F04 | `chatgpt.cliExecutable` 描述为开发用途，类型允许字符串或 null，scope 为 application 且 restricted；说明警告手动指定可能令部分扩展功能失效。 | [package.json](../../.artifacts/codex-vscode-assessment-20261112/extension/package.json) `chatgpt.cliExecutable` |
| F05 | 官方 app-server 是 Codex IDE 等 rich client 使用的 thread / turn 接口，提供持久线程、事件流和审批交互。`thread/list` 的 `sourceKinds` 按线程来源筛选；省略或空值默认只列 `cli`、`vscode`，这是宽泛来源类别，不是客户端产品身份过滤器。 | [Codex App Server 文档](https://developers.openai.com/codex/app-server/)；[当前官方文档摘要与哈希](../../.artifacts/codex-vscode-assessment-20261112/official-docs.json) |
| F06 | 官方文档列出的 app-server 默认传输为 JSONL stdio；还列 Unix socket WebSocket 握手。`ws://IP:PORT` 传输被标为 experimental / unsupported。 | 同 F05。不要把 Orbis 现有的 loopback WebSocket 包装器误称为官方稳定扩展接口。 |
| F07 | Orbis 自有终端 app-server 使用 standalone `codex-app-server --session-source cli`。普通 `codex app-server` 默认使用 `vscode` source；Codex Desktop 也通过 CLI 启动 app-server，因此 `vscode` 不能区分 Desktop 与 VS Code 扩展。线程来源可过滤，但不是运行中进程的端点发现、客户端身份或线程所有权证明。 | [codex-daemon.ts](../../packages/host/src/codex-daemon.ts)；[codex-session-source-native.test.ts](../../packages/host/src/codex-session-source-native.test.ts)；[ADR-0022](0022-codex-desktop-daemon-attachment.md)；[官方 app-server 启动参数](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/main.rs) |
| F08 | VS Code 启动环境继承用户 `CODEX_HOME`，必要时在 remote host 上解析 shell 环境；原生线程 ID 可能跨入口相同。Orbis 现有 Desktop 路径另加 `codex-desktop:` 会话命名空间并跟踪 writer / loaded 状态。 | [extension.js](../../.artifacts/codex-vscode-assessment-20261112/extension/out/extension.js) `child_process_launcher`；[ADR-0022](0022-codex-desktop-daemon-attachment.md)；[codex-runtime.ts](../../packages/host/src/codex-runtime.ts) |
| F09 | 扩展还声明了仅 macOS 启用的 ChatGPT 桌面应用 “Work with VS Code” Unix socket bridge，处理编辑器内容、选区、行高亮、替换等操作；工作区不受信任时只允许 `ping`。它不提供 app-server thread/history 连接。 | [extension.js](../../.artifacts/codex-vscode-assessment-20261112/extension/out/extension.js) `desktop_bridge_*`；[readme.md](../../.artifacts/codex-vscode-assessment-20261112/extension/readme.md) |
| F10 | 扩展初始化时通过连接级 `initialize.clientInfo` 发送客户端元数据。所查 Windows 包按宿主编辑器名称生成 `name`；官方文档示例使用 `codex_vscode`，并说明 `clientInfo.name` 用于 OpenAI Compliance Logs Platform。文档没有把它定义为持久线程来源或 thread/list 过滤字段，因此不能用它分类历史线程。 | [extension.js](../../.artifacts/codex-vscode-assessment-20261112/extension/out/extension.js) `initialize_request`、`gf`；[Codex App Server 文档](https://developers.openai.com/codex/app-server/#initialization)；[当前官方文档摘要与哈希](../../.artifacts/codex-vscode-assessment-20261112/official-docs.json) |
| F11 | 官方协议将 `thread/loaded/list` 定义为返回当前 app-server 内存中已加载的 thread ID。它能反映该 server 进程的 loaded 集合；文档没有定义它为发起客户端身份或完整历史来源。 | [Codex App Server 文档](https://developers.openai.com/codex/app-server/#list-loaded-threads)；[当前官方文档摘要与哈希](../../.artifacts/codex-vscode-assessment-20261112/official-docs.json) |

官方 Codex IDE 页面把 VS Code 与兼容编辑器列为扩展使用入口，但没有提供让外部 Host 发现或接管扩展私有 app-server 的接口。[Codex IDE 文档](https://developers.openai.com/codex/ide/)

## 与现有 Codex 路由的关系

| 路由 | app-server 所有者 | Orbis 当前接法 | 线程来源与含义 |
| --- | --- | --- | --- |
| `codex` | Orbis Host | Host 自己启动 standalone server，供终端 TUI 与 Host 共用。 | Host 启动参数固定 `cli`；终端源和在线 runtime 由这条后端持有。 |
| `codexDesktop` | Codex Desktop | Desktop 私有启动 CLI；Orbis 包装 CLI 调用后接入同一个进程。 | 普通 `codex app-server` 默认写入 `vscode` source；Desktop 与终端拥有不同 runtime / Orbis ID，但 source 不能唯一表示 Desktop。 |
| `codexVsCode`（提议） | VS Code Codex 扩展 | 需要把扩展启动的 app-server 交给可验证的本机桥接，并连接同一进程。 | 端点可标识 app-server 进程归属；`vscode` source 与 `clientInfo.name` 均不能单独证明某条历史线程归属于 VS Code。独立目录只收录经验证的线程关联。 |

三个入口底层均为 Codex app-server / 原生会话体系，VS Code 并非一套新的模型后端。应复用 Codex RPC、历史解码、工具活动及权限映射；安装发现、实际 app-server 所有权、连接生命周期、身份路由与用户配置则独立处理。官方文档将 `thread/loaded/list` 定义为当前 app-server 内存中已加载的线程，可作为该进程当前运行集合的候选证据；它不等于客户端身份，也不覆盖完整历史目录。`codexVsCode` 只表示 Orbis 的来源路由，不代表另建一份 `CODEX_HOME` 或另一套历史库。[F05–F08、F10、F11]

## 提议的接入决策

| 场景 ID | 应有行为 |
| --- | --- |
| CODEX-VSCODE-01 | VS Code 为独立来源身份 `codexVsCode`，不复用 `codexDesktop` 名称或 `codex` 终端路由。状态、在线目录和命令都指向正确来源。 |
| CODEX-VSCODE-02 | 仅当 Host 连到扩展实际启动的 app-server 并通过 `initialize`、线程 API 握手后，才发布 attached / ready；只发现 VSIX 或 CLI 文件不能算接入。 |
| CODEX-VSCODE-03 | 候选包装桥应选择扩展当前安装版本随包 CLI，透明保留扩展 argv、stdio、PATH、`CODEX_HOME`、认证和工作区环境，只拦截常驻 `app-server` 调用；登录、版本查询及其他调用须原样透传。任何桥接故障都应让扩展继续使用原 CLI，并把 Orbis 状态标为未接入。 |
| CODEX-VSCODE-04 | 为 Orbis 选择独立、当前用户可访问的本地端点；优先验证官方 Unix socket transport。若只能使用 `ws://127.0.0.1`，须按 CLI / 扩展精确版本标记为实验性依赖，不作为未经验证的普遍支持承诺。端点文件只含必要连接信息，不记录认证材料或消息内容。 |
| CODEX-VSCODE-05 | 不得把 `sourceKinds: ["vscode"]` 当作 VS Code 专属目录过滤器。Catalog 只收录有进程 / 请求关联证据的线程；可评估所连接 server 的 `thread/loaded/list` 用于当前 loaded 集合，但其线程归属语义须实测。未能分类的历史线程不得自动归入 VS Code。线程操作沿用所连接 app-server 的原生权限、模型、认证、writer 与 loaded 生命周期。 |
| CODEX-VSCODE-06 | 原生 Codex 文件与配置按 Codex 自身语义共享；Orbis 不复制或同步其他入口历史，也不为了隔离而改写 `CODEX_HOME`。Orbis 可维护轻量线程归属账本，但不得把它扩展成第二份聊天历史库。仅对已证明关联的线程使用独立 Orbis 命名空间；相同原生 thread ID 在不同后端间的路由必须明确，不能从 source 值推导。 |
| CODEX-VSCODE-07 | `chatgpt.cliExecutable` 的设置管理必须显式授权、保留原值并支持条件恢复；不静默覆盖用户已有 CLI 自定义项。安装、扩展更新、Host 更新、卸载与恢复分别记录结果。 |
| CODEX-VSCODE-08 | 新 `agentKind` 和 attach 状态采用对端能力协商。旧 App 不得收到不认识的 `codexVsCode` 枚举或相关状态；按 ADR-0064 验证注册、后续更新、会话目录、命令、重连与回退。 |
| CODEX-VSCODE-09 | Host 暂停只释放自己的连接和监控；VS Code、扩展及扩展拥有的 app-server 生命周期仍归 VS Code。Host 不按进程名关闭或重启 VS Code / Codex。 |
| CODEX-VSCODE-10 | VS Code 与 Codex Desktop / CLI 同时工作时，保留原生线程占用结果。连接与 session source 相同不能绕开单写者锁；实时 turn、审批、断线恢复须以正在运行的同一 app-server 验证。 |

实施时参考 [codex-desktop-wrapper.ts](../../packages/host/src/codex-desktop-wrapper.ts)、[codex-desktop-launcher.ts](../../packages/host/src/codex-desktop-launcher.ts)、[codex-desktop-lifecycle.ts](../../packages/host/src/codex-desktop-lifecycle.ts) 的透明透传与端点所有权，但不能直接复用其 Desktop CLI 发现、`codex-desktop` endpoint、线程前缀或“所有 external server 都是 Desktop”的假设；当前 [CodexRuntime](../../packages/host/src/codex-runtime.ts) 将 external app-server 归为 `codexDesktop`，接入前需抽出显式来源类型。

新来源需要更新协议 `AgentKind`、Host backend 状态及会话路由，并在 iOS / Android / Windows Host 界面补齐识别、选择、目录筛选、显示名称和错误状态。设备能力必须先握手协商，再向新版客户端发送新枚举；旧版本保持已有 Codex CLI / Desktop 行为。供应商配置不直接复用终端管理写入；VS Code app-server 返回的原生 provider / settings 才是已连接状态的事实。

## 风险与验证门槛

本次只完成包和文档静态调查，没有在 Windows/macOS/Linux 上安装 VS Code 扩展、修改设置、启动 wrapper、连接真实 app-server 或操作 Codex 会话。Marketplace 证据只有 Windows x64 的 prerelease，不足以确认 Stable、Insiders、Cursor、macOS、Linux 或后续版本行为。[F01] `vscode` source 的非唯一性已由 ADR-0022 与 app-server 启动参数证据确认；如何在不误收 Desktop / CLI 线程的前提下建立稳定线程归属账本，仍是接入阻断项。[F07、F10、F11]

在宣布实施前，至少需要以下原型证据：

| 验证 ID | 验证目标 |
| --- | --- |
| CODEX-VSCODE-DISC-01 | 各目标平台发现 stable / insiders 扩展、版本及随包 runtime；自定义 extensions-dir、多个安装和升级后选择正确匹配项。 |
| CODEX-VSCODE-CONFIG-01 | 目标版本能否通过 `chatgpt.cliExecutable` 稳定启动透明包装器；核实 app-scope / restricted 设置写入方式、VS Code 重载需求、原值恢复及用户自定义 CLI 冲突。 |
| CODEX-VSCODE-ATTACH-01 | Windows 与 macOS 至少各完成一次同一进程桥接，验证官方可用 transport、second-client initialize、请求 / 通知并发、连接重试、端点身份及桥损坏时扩展原样工作。 |
| CODEX-VSCODE-SOURCE-01 | 分别通过 VS Code 扩展、Codex Desktop、Orbis 已连接 server 和 standalone CLI 创建 / 恢复线程；核查 rollout header、native SQLite `threads.source`、`sourceKinds` 结果及所连接 server 的 `thread/loaded/list`。验证 `initialize.clientInfo` 的值是否持久化到线程记录；同时验证透明桥是否能可靠关联扩展发出的 start / resume 请求及返回的 thread ID。 |
| CODEX-VSCODE-SESSION-01 | 同一 app-server 下新建 / 恢复、历史、流式 turn、取消、审批、工具、归档和断线恢复；验证 `thread/loaded/list` 与 persisted `source` 的区别，并用 Desktop / CLI 同时操作同一 thread 验证 writer 拒绝及 Orbis 路由归属。 |
| CODEX-VSCODE-VERSION-01 | 至少一个稳定正式扩展版本做同版正对照；扩展升级后绑定匹配 CLI / schema，失败时断开 Orbis 而不阻止原扩展运行。 |
| CODEX-VSCODE-COMPAT-01 | 按 ADR-0064 使用最近发版的真实 Host / Relay / App 验证新旧端互通、重连与回退；确认旧 App 从未接收新枚举。 |

若包装启动入口或可用的本地多客户端 transport 不能通过上述门槛，停止该连接路线，保留“未接入”状态；不要退化为另启动一份 server 后声称接管 VS Code。当前 ADR 只登记独立来源与候选接入边界，不构成已支持、已实现或已发布的承诺。
