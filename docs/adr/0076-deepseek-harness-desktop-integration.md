# ADR-0076：DeepSeek Harness Desktop 独立接入

日期：2026-11-12

Status: accepted（Web / Desktop 分入口与数据边界已确定；接入机制待原型验证，未实现、未部署）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0075](0075-host-confirmed-exit-and-update.md)。

## 问题与结论

Orbis 当前的 `dsh` 对应 DeepSeek Harness Web。Windows 只安装 DeepSeek Harness Desktop、未注册其可选 CLI 时，现有 CLI 检测找不到它，符合当前实现的覆盖范围，属于 Desktop 支持缺口。注册 `dsh.cmd` 可以让命令被发现，但仍不等于连接 Desktop；当前协议库定位也无法从该启动器取得可用包入口。[F01–F03]

Desktop 与 Web 共享后端实现，Desktop 自己拥有后端进程、profile、认证和生命周期。已有 Web 传输及会话映射有复用价值；完整接入还需要安装发现、Desktop 实例接入、匹配版本的协议加载及跨端路由，不能仅靠增加一个搜索目录完成。[F04–F06]

采用与 `codex` / `codexDesktop` 相同的产品分路：保留 `dsh` 为 Web，规划独立的 `dshDesktop`。各入口读取和操作所连接原生实例的会话，Orbis 不复制、迁移或对账 Web 与 Desktop 的历史。原生共享数据与两条接入的身份分别处理。[F07–F09]

## 调查版本与证据

上游为 `deepseek-ai/deepseek-harness`。本次固定源码提交 `e8f7b93a344964de3dca1ace9e72b6e4d6de87cb`，并对照预发布 tag `dsh-v0.2.2-rc.2` 的提交 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`，发布记录时间为 `2026-11-11T11:33:06Z`。这些版本是本次调查范围，不代表所有安装版本的行为。

证据保存在 [dsh-desktop-assessment-20261112](../../.artifacts/dsh-desktop-assessment-20261112/)：

- [sources.json](../../.artifacts/dsh-desktop-assessment-20261112/sources.json)：61 份官方文档与源码的固定提交 URL、Git blob SHA-1、SHA-256 和字节数；原文在 `upstream/`。
- [release-comparison.json](../../.artifacts/dsh-desktop-assessment-20261112/release-comparison.json)：6 个关键文件与预发布提交逐字节相同；仅将这 6 个文件的结论直接延伸至该 tag。
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

在本次查阅的 Desktop 文档、启动入口和连接实现中，未发现供外部客户端自动读取的稳定实例描述文件契约。上述结论没有通过 Windows 已安装应用验证，不能据此承诺任意 Desktop 版本均可自动接入。

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

实现可抽取 DSH Web 的协议传输、消息映射和历史投影共用部分；安装发现、认证端点取得、版本加载、生命周期与后端选择保持独立。参考 [codex-desktop-lifecycle.ts](../../packages/host/src/codex-desktop-lifecycle.ts) 和 [codex-desktop-launcher.ts](../../packages/host/src/codex-desktop-launcher.ts) 的职责划分，不假设 DSH 提供与 Codex 相同的包装入口。

原生同一会话在两条入口中可见时，仍可能因另一个实例持有写锁而无法恢复执行，应保留原生占用结果。是否可见还受实例、主目录、版本及列表过滤影响；当前 Orbis Web catalog 过滤缺少 `cwd`、归档范围不符、subagent 和默认隐藏的 blank 会话，见 [dsh-web-runtime.ts](../../packages/host/src/dsh-web-runtime.ts) 的 `catalog`。尚无用户现场的版本、主目录和列表证据，不能将其历史不可见归因为某一种情况。

## 接入候选与难度

本轮确定产品分路，具体接入机制保留为待验证方案。

| 工作 | 评估 | 依据与待确认点 |
| --- | --- | --- |
| Windows 安装识别 | 低 | 官方安装器记录卸载注册项 `InstallLocation`（[L265][up-install]）；可结合手选路径和实际可执行文件校验。自定义目录、移动安装、多个候选及旧版注册项仍需验证。 |
| 独立入口和身份路由 | 中 | 可参考 Codex 双入口，但涉及协议枚举、Host 状态、App 展示、重连和旧端兼容。 |
| 复用传输及会话映射 | 中 | 共享原生 Remote API 提供基础；仍需验证 Desktop profile 的实际能力、审批、历史解码和设置归属。 |
| 加载匹配协议库 | 中 | 当前 CLI 包解析已证明无法定位 Desktop 包入口。需要验证 ASAR 内运行时、外置依赖与升级后的版本绑定，不能把 Electron 内可用的包路径直接当作 Orbis Node 可导入目录。 |
| 自动取得 Desktop 认证端点 | 中至高，主要不确定项 | 已有启动 URL 和 API 认证机制，但外部发现、已运行实例、Windows 打包 GUI stdout、动态端口及令牌轮换尚无实测。 |

可按以下顺序做最小原型，尚未选定生产机制：

1. **验证启动包装器。** Desktop 采用 Web bundle 模板（[project-manager.ts L31][up-profile-template]），默认配置打印认证 URL，Host 子进程转发 stdout。由此推断可以评估 Orbis 启动应用时捕获 URL 并走官方认证；Windows 已打包 GUI 是否提供可捕获输出、单实例已启动时如何取得端点均待确认。该推断不能作为支持已启动 Desktop 的承诺。
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

这些结果验证发现和包解析，不验证 Windows 命令执行、注册表、Electron、真实 ASAR 或 Desktop 连接。探针未访问真实 DSH 主目录，临时夹具已清理。上游 61 份文件的 Git blob 校验、6 份发布版对照和文档静态检查记录在 [verification.json](../../.artifacts/dsh-desktop-assessment-20261112/verification.json)。

后续原型与实现需分别保留以下证据，当前均未执行：

| 验证 ID | 验证目标 |
| --- | --- |
| DSH-DESKTOP-ATTACH-01 | Windows 只装 Desktop、没有 Node/npm/dsh PATH 时，识别安装并接入其实际后端；包含自定义及中文空格路径。 |
| DSH-DESKTOP-ATTACH-02 | 已运行实例与由 Orbis 启动的实例均可接入；Desktop 关闭、重启、升级和令牌轮换后状态准确，没有第二个 profile 写入者。 |
| DSH-DESKTOP-SESSION-01 | 新建、恢复、读取历史、流式输出、取消与审批操作到达同一 Desktop 实例；Web 同时运行时不串路由，保留原生写锁结果。 |
| DSH-DESKTOP-HISTORY-01 | 相同及不同 `DSH_HOME` 的受控数据下，各入口按原生返回显示；无复制、迁移、跨入口去重或配置改写。 |
| DSH-DESKTOP-VERSION-01 | 真实 Desktop 安装包与其匹配协议库完成同版正对照；与 npm Web 并存、升级及不支持版本下准确处理。 |
| DSH-DESKTOP-COMPAT-01 | 按 ADR-0064 使用最近发版的真实 Host / Relay / App 实现验证新旧互通、重连和回退；未协商的 Desktop 能力不破坏既有连接。 |
| DSH-DESKTOP-LIFECYCLE-01 | Host 暂停、退出、更新与桥接故障释放自身资源，Desktop 原生任务和配置保持正确归属。 |

本轮交付为调查、ADR 和证据归档；未实现接入、未构建或部署客户端。Windows 真机运行及后续产品验收待用户验证。

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
