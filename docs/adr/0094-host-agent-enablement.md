# ADR-0094：Host 统一管理 Agent 启用

日期：2026-11-19

状态：桌面 Host、iOS／Android 与十种 Agent 的启停实现已接入；通过定向自动验证，未部署，待用户安装验收。

## HOST-AGENT-01｜设置与默认值

在桌面 **Host → 你的 Agent → 启用 Agent** 及 iOS／Android **所选 Host 的设置 → Agent** 提供逐项开关。Node Host 核心在本机状态目录持久化启用意愿，是唯一事实来源；桌面桥与配对 App 调用同一个写入入口。App 只修改所选 Host 的启用状态，不编辑原生安装、凭据、Gateway 参数或供应商配置。新装和新增来源默认全部关闭；开启零项仍可启动、配对和连接 Host。Relay 不保存设置，各 Host 独立管理。

**启用、已安装／已配置、可启动、已连接是不同状态。** 安装或配置不等于启用；启用不等于预启动，也不自动启动原生桌面应用。现有预启动、终端接入、供应商和权限选项保留为从属设置，不再决定总开关。外部配置（包括环境变量）可提供连接参数，但不覆盖已保存的关闭意愿。

升级只迁移一次：逐项保留可证明的既有接入，例如已配置的 OpenClaw、显式开启的 Kimi、已显式开启的预启动／终端接入。仅检测到安装、存在供应商配置、曾被旧 Host 默认公告，均不算启用证据；已有明确关闭决定优先。没有证据的来源关闭，原配置保留供用户开启后复用。持久化完成前不启动适配器；读取失败应提示错误，不回退到全开。CLI Host 也使用同一状态文件和生命周期；运行期间通过已配对 App 修改，不从第二个进程改写该文件。旧 CLI 标志只参与首次启用迁移；Codex 与 DeepSeek 的预启动在对应总开关开启时才执行。

## HOST-AGENT-02｜各来源的设置、启动与停用

| 来源 | 开启后显示的从属设置与动作 | 关闭时 Host 停止的工作 |
| --- | --- | --- |
| Pi (`pi`) | CLI 安装／修复、Pi 供应商设置、终端启动与扩展连接 | 停止 Pi 连接接纳、订阅和新建／恢复入口；不卸载扩展，不结束用户终端 |
| Codex 终端 (`codex`) | CLI 版本／修复、终端接入、预启动、供应商及通用配置 | 跳过 app-server 预启动、恢复和终端接入；已有 shim 不得借此重启 Orbis 接入，Codex 原生命令仍可用 |
| Codex Desktop (`codexDesktop`) | 桌面接入状态、打开／重试 | 停止桌面监测、自动附着、刷新以及包装器接入；不退出 Desktop，不影响 Codex 终端 |
| DeepSeek 终端 (`dsh`) | CLI 安装／修复、供应商设置、Web 后端准备状态 | 跳过 Web 后端预启动、自动恢复和重连；不关闭共享原生 Web 服务 |
| DeepSeek Desktop (`dshDesktop`) | 桌面接入状态、由 Orbis 打开／重试 | 停止桌面检测、附着与恢复，取消待完成的打开；不退出 Desktop，不影响 DeepSeek 终端 |
| Claude Code (`claude`) | CLI 版本、终端接入、插件接入状态及供应商设置 | 跳过插件／Hook 登记，拒绝已有接入点发来的会话注册与事件；不卸载插件，不终止原生 TUI |
| Hermes Agent (`hermes`) | Gateway profile、连接状态及按需接入 | 跳过发现与按需连接，释放 Orbis 连接；不关闭原生 Gateway、不改 profile |
| Kimi Code (`kimiCode`) | Web／Desktop 来源、接入状态；保留原生 Web 地址／主目录参数 | 不发现、不探测、不连接所选原生服务；不启停 Web 或 Desktop |
| OpenCode (`opencode`) | 共享服务接入状态 | 停止发现、事件订阅和会话请求；不启动或停止共享服务 |
| OpenClaw (`openclaw`) | Gateway 地址、令牌、连接／重试状态 | 断开 Orbis 客户端并停止重连；不清空地址或令牌，不改变 Gateway。移除配置是独立操作 |

每个 `AgentKind` 独立管理。共享配置、凭据、连接或历史按实际所有权保留；关闭其中一项不应让另一来源掉线。新增来源须先登记默认值、设置项、后台任务、启动入口、资源所有权及显示规则，再接入 Host。

## HOST-AGENT-03｜执行与显示由同一策略驱动

- **执行门禁**：Host 核心在创建适配器、排队执行和提交结果前检查启用状态，覆盖启动、自动检测／轮询、安装／更新／修复入口、外部注册、恢复重连、打开、新建、订阅、请求路由与配置写入。不能只在 UI 隐藏。关闭后可在桌面或配对 App 的设置里重新开启；不自动探测关闭项来填补状态。
- **运行时切换**：开启只安排该来源的准备工作；Host 已暂停时只保存，恢复后生效。关闭立即拒绝新操作，取消该来源的待启动、订阅与重试，丢弃旧一代回调，再释放 Orbis 自有资源；不重启整个 Host，不断开其它 Agent，不把关闭转换成对原生回合的停止命令。若关闭会中断 Orbis 对进行中工作的观察，在发起修改的界面确认后执行，由 Host 在应用时复核。未交付的输入不得伪报已发送，也不得在重新开启后静默重放。
- **Host 显示**：设置清单始终能找到所有来源，关闭项只显示开关和「未启用」；开启项按现有状态显示未安装、待配置、可启动、已连接或错误。概览、状态提示、安装／更新批处理、快捷入口及专属操作卡只列已启用来源。共享的供应商入口不因同族的另一来源关闭而消失。无启用项时从概览提供去设置的入口。
- **配对设备**：业务数据继续复用现有协议投影。Host 先按启用策略筛选，再按现有设备能力投影；`agents` 与 `launchableAgents` 均受限制，后续公告、状态、目录、分页与通知一致。未启用来源暂不对外展示，已存会话、历史和标识不删除；重新开启后按原标识同步。切换后使受影响的订阅、目录基线及旧游标失效，用现有刷新／重握手机制对账；即使旧设备仍缓存入口，Host 也拒绝过期请求且不隐式启动。注册帧与后续更新都按 [ADR-0064](0064-protocol-compatibility.md) 验证。

## HOST-AGENT-04｜App 修改与 Host 对账

- **读取**：配对 App 在连上支持此能力的 Host 后获取设置快照，包含 Host 修订号、来源 ID、显示名称和启用值；接入状态走独立投影。设置列表可显示未启用项，但不会借设置快照把它们纳入会话入口。离线可显示上次同步结果并标明未连接；不接受离线编辑，不跨 Host 复用快照。
- **修改**：App 通过现有配对加密连接发出单项请求，携带来源、目标值、请求 ID 和已知修订号。Host 验证配对授权、来源与修订号，串行持久化后返回当前权威快照，并通知其它已协商的配对设备及本机 UI。保存失败保持原值；并发冲突返回 Host 当前结果，不静默覆盖；重复请求不重复应用。确认和写入之间状态变化时，Host 重新判定是否仍可执行。
- **显示与恢复**：提交期间显示待确认，不把本地点击当成成功。以 Host 回执或更新后的权威快照对账；忽略旧修订、已切换 Host 的回包，以及旧连接的迟到结果。回执丢失或重连时先读快照，不自动重放。启用值保存成功但接入失败时保持「已启用」，单独显示接入错误。桌面改动也按同样规则推送给 App。
- **兼容**：在现有配对握手内单独协商管理能力；不向旧端发送新增管理帧。新 App 连旧 Host 时不提供可写开关；旧 App 连新 Host 时仍使用既有 Agent 公告。Relay 仅转发加密消息，不解释设置或参与冲突处理。

## HOST-AGENT-05｜扩展契约与验证

- **设置目录**：在 [Host 启用框架](../../packages/host/src/agent-enablement.ts) 登记来源和名称。目录用 `Record<AgentKind, …>` 穷尽校验；新增会话来源漏登记时编译失败。默认值统一为关闭，不另造该来源的默认开关；降级读写不抹掉未知来源的选择。
- **生命周期**：在 Host 的组合入口为来源登记 `start(lease)` 和 `stop()`，复用按来源串行的生命周期调度。`start` 只准备 Orbis 管辖的资源；异步启动、外部事件与结果投影在挂载或发布前验证当前租约。`stop` 释放部分启动和完整启动的 Orbis 资源；会话路由仍走原有适配器协议。
- **通用设置协议**：[启用契约](../../packages/protocol/src/agent-enablement.ts) 管理来源使用稳定字符串 ID，客户端可按快照渲染新行，无需为每个新来源造一个开关或消息。Host 写入时只接受已登记来源。会话和运行时消息仍保留严格 `AgentKind` 与既有能力协商，能管理开关不代表能解析该来源的会话。

第一阶段在 [HostService](../../packages/host/src/host-service.ts) 接入配对加密读写、提交后广播和能力协商，并以 OpenClaw 接入启停、目录投影和旧请求拒绝。隔离配置显式注入同一控制器；未注入时不公告能力，保留既有行为。试点只允许修改已登记生命周期的来源，不把其余来源的开关呈现为已可用。现已覆盖所有登记来源。旧格式只接收原有公告；能解析设置不等于能接收新 Agent 的会话数据。

本阶段验证见 [`host-protocol-compatibility.test.ts`](../../packages/host/src/host-protocol-compatibility.test.ts) 与 [隔离验证日志](../../.artifacts/agent-enablement-stage1/verification.log)：合成 Gateway，实际配对加密通道和隔离 Relay；验证默认不连接、启用连接、冲突回读、Host 修改推送、关闭断开、越过开关的旧入口被拒绝。未使用发布安装包或设备。

现有接点：[桌面设置与 Agent 卡](../../packages/windows-host/src/qml/Main.qml)、[桌面命令桥](../../packages/host/src/desktop-bridge.ts)、[适配器生命周期](../../packages/host/src/desktop-runtime.ts)、[Host 服务与对外公告](../../packages/host/src/host-service.ts)、[设备可见性投影](../../packages/host/src/device-agent-visibility.ts)。保留 [ADR-0056](0056-agent-startup-readiness-and-consent.md) 和 [ADR-0081](0081-host-startup-blocking-and-feedback.md) 的就绪、启动同意与后台准备规则。

自动化覆盖：新装全关仍可配对；只开一项时仅该项准备、显示并可启动；逐项断言关闭时不启动、不探测、不附着或重连；迁移不误开、新来源默认关闭；关闭与在途启动竞争；暂停下更改、重启读回、保存失败；共享资源不误停；旧端连接、切换后的目录／缓存对账、重连及拒绝旧入口。App 同步另覆盖桌面与两端 App 双向收敛、并发冲突、重复请求、丢回执与重连、跨 Host 切换、旧端降级。正对照使用同一来源开启时的既有功能，不把原生服务离线当作停用证据。

用户验收：待有候选包后在隔离 Host 上安装，验证新装、升级、桌面与配对 App 逐项开关及同步以及两组终端／桌面来源独立工作；实现、自动验证、部署和用户验收分别记录。

## HOST-AGENT-06｜桌面写入接入

桌面正常模式由 `DesktopRuntime` 持有单个设置控制器，启动时将同一实例交给 `HostService`。Qt「你的 Agent」按 Host 返回的目录显示开关，点击后保持原值，应用 Host 回执或更新快照；旧修订不回写。Host 暂停时也可保存设置。OpenClaw 的启用与移除连接配置为独立操作；已有有效连接配置只在首次迁移时导入。QA 模式仍不接入正式 Gateway。

实现：[`desktop-runtime.ts`](../../packages/host/src/desktop-runtime.ts)、[`HostController.cpp`](../../packages/windows-host/src/HostController.cpp)、[`Main.qml`](../../packages/windows-host/src/qml/Main.qml)。验证：桌面单元测试及本机 macOS Qt 构建和 [控制器回归](../../.artifacts/agent-enablement-desktop/test.log)；首次测试编译因使用仅 smoke 构建提供的入口失败，改用实际 reducer 后通过。未验证 Windows 安装、iOS 或 Android UI，用户验收待完成。

## HOST-AGENT-07｜移动设置与 Gateway 接入

iOS／Android 按 Host 返回的目录渲染开关，仅在配对握手回显管理能力后读取快照。写入期间保留原值；回执、广播按版本接收，断开后清理请求，不重放写入。桌面、iOS、Android 共用一份 Host 设置。Hermes／Kimi Code 与 OpenClaw 复用同一生命周期调度：按来源启动发现或连接，关闭撤销旧租约并释放 Orbis 连接。首次迁移导入曾显式开启的 Kimi；未有证据的 Hermes 默认关闭。

验证：[Node 定向回归](../../.artifacts/agent-enablement-mobile/node.log)、[Swift 定向回归](../../.artifacts/agent-enablement-mobile/swift.log)、[Android 定向回归](../../.artifacts/agent-enablement-mobile/android.log)、[无签名 iOS 模拟器构建](../../.artifacts/agent-enablement-mobile/ios.log)。iOS 首次构建暴露界面直接访问聚合 Store 而非所选 Host，改用 `activeConnection` 后构建成功。没有启动模拟器或使用真机，尚未验证实际交互。

## HOST-AGENT-08｜DeepSeek 两路独立接入

DeepSeek 终端保留旧预启动偏好，仅当总开关也开启时生效；已明确开启的旧预启动设置首次导入。关闭终端撤销自动恢复、清除连接并阻止本地启动和配置修改，不停止原生 Web 服务。Desktop 使用独立生命周期和连接；关闭取消待完成的打开、停止检测，不退出原生桌面应用。Host 停用投影对未协商管理能力的旧 App 也生效；设备能力与停用独立，目录投影只枚举当前 Host 策略下的能力组合。

验证：[`desktop-runtime.test.ts`](../../packages/host/src/desktop-runtime.test.ts)、[`device-agent-visibility.test.ts`](../../packages/host/src/device-agent-visibility.test.ts)、[59 项回归及类型检查](../../.artifacts/agent-enablement-dsh/final.log)。[首次回归](../../.artifacts/agent-enablement-dsh/first.log)保留 4 项旧用例缺少显式启用前置条件的证据；补齐设置后通过原断言。联动使用隔离 Relay 与合成原生连接，待设备／用户验收。


## HOST-AGENT-09｜Pi、Codex 两路与 Claude Code

Pi 与 Claude 的原生桥在接纳和接收请求时核对策略；停用只撤销 Orbis 的连接及等待，Claude Hook 回到原生交互路径。Codex 终端与桌面使用独立生命周期，只有共享供应商配置及路由按两路的共同需求保留。会话新建与恢复在异步预检后、进入原生启动或创建前按来源租约复核。已经发到原生端的请求按已知回执及启动台账核对，不因停用或重新启用而重复发起。已封装的传输帧维持序号连续，目录与模型按新的设备视图修订重新对账。

实现：[原生桥及启停注册](../../packages/host/src/host-service.ts)、[适配器启动契约](../../packages/host/src/agent-backend.ts)、[CLI Host 组合](../../packages/host/src/cli.ts)。新增来源检查清单：添加 `AgentKind`、Host 目录行和生命周期注册；复用启动租约、设备投影及设置协议；补充关闭与开启正对照。只在会话协议不兼容时新增会话能力协商，设置 UI 不增加专用开关。

验证证据： [Node 类型检查及 404 项定向回归](../../.artifacts/agent-enablement-all/node-verified.log)，覆盖双设备广播、重连及撤销、冲突、Pi/Claude 原生桥隔离、刚停用的启动门禁；用 `v0.1.24`、`android-v0.1.60` 源码中的协议验证旧端公告，并以 [v0.1.24 Host 源码构建](../../.artifacts/agent-enablement-all/old-host-compat.log) 验证无管理能力时仍能握手与读取目录。另有 [Qt macOS 构建](../../.artifacts/agent-enablement-all/qt-final.log)、[21 项控制器通过](../../.artifacts/agent-enablement-all/qt-recheck.log)、[Swift 5 项](../../.artifacts/agent-enablement-all/swift.log)、[iOS 无签名模拟器构建](../../.artifacts/agent-enablement-all/ios.log) 及 [Android 定向单元测试](../../.artifacts/agent-enablement-all/android.log)。未以构建或合成 Peer 代替实际安装及交互验收；未部署。


## HOST-AGENT-10｜主线接入验证

OpenCode 只在当前启用租约内创建连接监视器和会话适配器。停用撤销订阅和重试；重新启用新建连接代次，不复用已关闭的连接或重发历史操作。会话能力仍按 `agent.opencode` 单独协商。Kimi Code 的 Web／Desktop 是同一个会话来源的两种互斥接入方式，保留来源选择，去掉旧的重复启用控件；显式的旧桌面关闭在首次迁移时优先于继承配置。Linux 保留无头启动策略，不启用桌面发现或原生窗口。

本轮自动证据：[Node 和隔离 OpenCode 加密往返](../../.artifacts/agent-enablement-all/node-integration-final.log)、[桌面控制器](../../.artifacts/agent-enablement-all/qt-integration-final.log)、[Swift 定向回归](../../.artifacts/agent-enablement-all/swift-integration/run.log)、[iOS 模拟器构建](../../.artifacts/agent-enablement-all/ios-integration/run.log)、[Android 定向回归](../../.artifacts/agent-enablement-all/android-integration-final/build.log)。待同一 QA Case 的新候选安装验收；未部署。

## HOST-AGENT-11｜停用后的旧入口与后台任务

收到 Host 的启用快照后，App 新建页、目录筛选和导入目标立即使用该快照，不等下一份业务目录。已确认全部关闭与没有管理能力是不同状态；旧 Host 保留原入口规则。目录投影视图以启用集合区分，含已知来源的停用缓存行暂不展示，无法归类的旧条目不据此删除。已有草稿和历史保留；重新启用后可按原标识使用。App 在发送新建、恢复及新导入请求前检查当前策略；已发送的导入仍可查询原回执，不重复启动或投递。

桌面供应商用量轮询和手动查询复用 Agent 启用代次；停用后不再请求，旧代次的用量结果不回填。Codex 终端与 Desktop 仍可共享供应商设置，只要任一来源保持启用即可。

验证：[Node 类型检查及 64 项定向回归](../../.artifacts/agent-enablement-all/node-policy-delivery.log)、[Swift 14 项](../../.artifacts/agent-enablement-all/swift-policy-delivery/run.log)、[Android 23 项](../../.artifacts/agent-enablement-all/android-policy-delivery-final/build.log)、[iOS 无签名模拟器构建](../../.artifacts/agent-enablement-all/ios-policy-delivery/run.log)。未操作测试设备，仍待候选包安装与双向同步验收。

扩展回归：旧安装、更新与终端用例在隔离状态中显式启用被测来源，原业务断言不变；另验证新装状态不会发现或安装停用来源。本机 Codex 环境变量不再进入合成 launcher。保留[首次扩大回归](../../.artifacts/agent-enablement-all/candidate-98a7c544-regression.log)及[本地主线对照](../../.artifacts/agent-enablement-all/expanded-main-sync-baseline.log)，同步远端主线已有的会话基线、溢出用例和 lint 修复后，[Lint、类型检查、构建与 2543 项回归通过](../../.artifacts/agent-enablement-all/expanded-core-clean.log)。22 项由现有平台条件跳过。此轮未改移动端源码，安装与交互仍由 QA 验收。

[桌面桥端到端回归](../../.artifacts/agent-enablement-all/desktop-bridge-wire-candidate.log)运行 Qt 使用的实际 Node JSON 桥与隔离 Relay：两个合成配对客户端验证电脑启用后广播到两端、手机停用后回推电脑与另一端、旧修订不能覆盖，以及电脑暂停时保存、恢复后手机读回。此证据覆盖协议和实际进程接线，不代替平台 UI 安装验收。

## AGENT-DIAL-01｜跨端 Agent 拨盘与停用复核

将移动端设置入口收敛为按 Host 选择的 Agent 拨盘。管理能力已协商时，转盘目录、启用数与写入均来自该 Host 的版本化快照；旧 Host 则按其 `agents`／`launchableAgents` 公告筛选，二者都未知时保留旧目录回退，不将“未知”误作“没有”。转动浏览不写远端；插销写入先显示原有事实，只有对应 Host 回执确认后才改变状态，离线缓存只供浏览，不重放操作。停用前由 Host 对运行会话复核；批量停用作为同一修订的一次原子写入提交，过期复核与迟到回执不能覆盖较新的快照。

`agent.enablement.review.v1` 是显式协商的协议扩展，用于安全复核令牌与范围绑定；不是“完全不新增协议帧”。旧端不协商此能力时继续使用既有兼容路径。界面行为服从实际策略与 Host 回执；原型中的动画或乐观状态不得替代复核。

桌面概览安装动作区分已安装、明确未安装与未知：未知显示检测状态且不触发安装。移动端旧端目录筛选与原型的固定列表不同，是为遵循 Host 能力公告。

本机自动验证（2026-11-23）：[Node 类型检查与 65 项定向回归](../../.artifacts/agent-dial-20261123/node-dial.log)、[Android 9 项状态／几何回归](../../.artifacts/agent-dial-20261123/android-final/run.log)、[Android 插桩源码编译](../../.artifacts/agent-dial-20261123/android-instrumented-compile/run.log)、[Swift 9 项旧端目录、回执与几何回归](../../.artifacts/agent-dial-20261123/ios-state/run.log)、Qt [`provider-model`](../../.artifacts/agent-dial-20261123/qt-provider-model.log) 与 [`host-live-change`](../../.artifacts/agent-dial-20261123/qt-host-live-change.log) 定向测试。尚未做原型与原生界面的同尺寸截图对比，未部署、未安装，待用户安装及视觉交互验收。

## AGENT-DIAL-02｜双端原型对齐与桌面 Agent 设置内聚

对照 [`orbis-agent-dial.html`](../design/orbis-agent-dial.html) 收敛桌面端与移动端的剩余视觉、交互及设置归属缺口：

1. **桌面双栏宽度解耦与供应商卡片布局稳定**：Agent 页双栏 `RowLayout` 左栏固定列宽，右栏 `agentDetail` 与各 `providerCard` 的 `contentWidth` 自顶向下绑定 `availableWidth`，并用单一内容容器包裹拖放层与表单列，避免 `QQuickPane` 多子项 `childrenRect` 将当前宽度回传为 `implicitWidth` 而在 `QQuickWindowPrivate::polishItems()` 中触发左右栏无限重排死循环。
2. **桌面 Agent 从属设置迁入 Agent 页**：将原位于全局「设置」页的所有 Agent 相关配置（Codex 预启动与终端 PATH 修复、DeepSeek Harness 预启动与 DeepSeek Web 启动链接、Kimi Code Web／桌面版来源切换及说明、Pi 终端扩展接入与 `pi` 终端命令安装／移除、Claude Code 终端插件接入）全部迁入 Agent 页右栏对应 Agent 的「接入」区就地配置并应用；涉及运行中 Host 启动参数的修改仍通过既有暂停—重连链路生效。全局「设置」页仅保留外观、登录启动、电脑名称、中继服务器与 Host 自身更新，移除 Agent 详情页跳转全局设置的「接入设置」入口。
3. **桌面概览页对齐**：
   - 更新提示条移入概览流内，采用凹陷槽表面、左侧琥珀色 `info` 图标、单「查看」入口与关闭钮。
   - 首次引导条封装为独立 `Card`，5 等分步骤采用 18×18 凹陷圆孔与步间 2px 连接线，已完成步点亮 8×8 绿点，当前步带 2px `accent` 外环与加粗文案。
   - 链路卡设备列表改为 32px 紧凑胶囊标签，含 6×6 在线／离线状态点及连接路径或离线时间。
   - 概览 Agent 行右侧状态区按「会话气泡与计数 → 语义色状态词 → 状态圆点 → 112px 动作按钮」排列，正在安装的进度条内嵌于对应 Agent 行下方。
4. **桌面 Agent 双栏页对齐**：
   - 左轨每行使用 36×36 凹陷圆孔承载图标，Codex／DeepSeek 的终端与桌面双生项均带 15×15 凸起圆形右下角标（终端 `>_`／显示器），去掉行首多余 `▸` 与重复 `StatusDot`，副标题拼接运行中会话数；多选达 2 项及以上时在页头右侧展示批量操作胶囊条。
   - 右栏详情头部采用 52×52 凹陷圆盘与 76×38 大号插销；未启用态居中留白展示「未启用」与主启用按钮，并在底部为 Codex／DeepSeek 提供共用供应商的孪生互跳胶囊。
   - 供应商列表置于凹陷容器内，头部显示配置总数，每行展示当前三角／候选项圆点、名称与官方／已保存副标题、当前项行内 5 小时／7 天迷你配额条及底部「+ 添加供应商」行；无运行中会话时切换供应商直接生效，仅在存在运行中会话时提示确认。运行中会话列表置于凹陷容器并带 8×8 绿点。
5. **移动端（Android／iOS）轮盘页对齐**：
   - 内环与插销栓头：已启用 Agent 图标右上角绘制 7×7 状态点；Codex／DeepSeek 终端与桌面版在环上及滑入插销栓头时均带 14×14 凸起圆形右下角标（终端 `>_`／显示器）；插销槽右端插孔在通电时点亮 `1.5px` 品牌色圈，拖拽越过阈值时插销槽点亮 `2px` 品牌色外框；补齐断电反向退光与准备／安装态循环流光弧。
   - 铭牌与事实区：`未安装`／`待配置` 状态词旁提供低干扰 `info` 按钮弹出提示气泡；铭牌副标题行展示运行中会话数、外部变更提示或错误原因；拖拽停用有运行中会话的 Agent 时显示「松手后确认停用」；底部事实区在有运行中会话且未展开配额时以凹陷容器展示带 8px 绿点的会话标题列表（最多 2 条及剩余计数）。

实现与验证指针：

- 桌面端：[`Main.qml`](../../packages/windows-host/src/qml/Main.qml)、[`AgentLatch.qml`](../../packages/windows-host/src/qml/AgentLatch.qml)、[`Symbols.js`](../../packages/windows-host/src/qml/Symbols.js)、[`HostController.h`](../../packages/windows-host/src/HostController.h)、[`HostController.cpp`](../../packages/windows-host/src/HostController.cpp)、[`main.cpp`](../../packages/windows-host/src/main.cpp) 及 [`OverviewRowHoverTest.cpp`](../../packages/windows-host/src/tests/OverviewRowHoverTest.cpp)（验证 Agent 页双栏点击「供应商配置」零位移、Agent 接入设置就地展示、双生胶囊互跳及 Kimi Smoke 检查）。
- 移动端：Android [`OrbisSymbols.kt`](../../android/app/src/main/java/com/orbising/orbis/OrbisSymbols.kt)、[`AgentDialState.kt`](../../android/app/src/main/java/com/orbising/orbis/AgentDialState.kt)、[`ProviderDialScreen.kt`](../../android/app/src/main/java/com/orbising/orbis/ProviderDialScreen.kt)、[`AgentDialStateTest.kt`](../../android/app/src/test/java/com/orbising/orbis/AgentDialStateTest.kt)；iOS [`ProviderDialGeometry.swift`](../../ios/Orbis/Orbis/ProviderDialGeometry.swift)、[`StatusViews.swift`](../../ios/Orbis/Orbis/StatusViews.swift)、[`ProviderDialGeometryTests.swift`](../../ios/Orbis/Tests/ProviderDialGeometryTests.swift)。
