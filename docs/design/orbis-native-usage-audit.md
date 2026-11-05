# Orbis 原生使用路径审计：Agent、供应商、后端、启动与恢复

审计日期：2026-11-05。范围：Android / iOS 当前源码及相关 ADR，只读核对；未运行构建、模拟器、真机或真实账号请求。本文件汇总供应商、启动、主页、目录、电脑入口与 standalone 映射；聊天细节另见配套审计。代码存在、规范接受和设备验收是不同事实。

## 1. 先区分五个对象

| 对象 | 用户可理解的含义 | 原生事实与约束 |
| --- | --- | --- |
| 电脑 / Host | 任务实际运行在哪台电脑 | 配置、目录、Session、Runtime 和请求结果都属于具体 Host。 |
| Agent 类型 / 运行入口 | 使用哪个 Agent，以及从哪条接入路径运行 | 新建页为 Pi、Codex 终端、Codex 桌面版、DeepSeek、Claude Code，内部分别是 `pi`、`codex`、`codexDesktop`、`dsh`、`claude`。Codex 的终端与桌面版共享产品名但接入归属不同。 |
| provider profile | 电脑为一个 Agent 保存的一套供应商配置 | profile 有独立 `id`、`kind`、名称、启用状态、exclusive/additive 模式；API Key、OAuth、URL、原生配置正文留 Host。会话 Agent 类型由独立身份确定。 |
| backend / Runtime | Host 如何接入原生 Agent，以及当前会话的在线控制连接 | backend 实现准备、目录、激活、命令路由；Runtime 是可更换的在线路由身份，一个后台进程可承载多个会话。既有历史 Session 可没有在线 Runtime。 |
| model / native provider | 当前会话实际使用/下一轮选择的模型，以及原生 API 路由标识 | 原生 `modelProvider`（如 `openai`）与 Host 自己的 profile ID 不同。历史 provider、Host 当前默认、当前 Session 模型、代理单次请求路由也不相等。 |

证据：Android 新建选项 [MainActivity.kt:1192–1204](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L1192-L1204)；iOS [SessionViews.swift:527–535](../../ios/Orbis/Orbis/SessionViews.swift#L527-L535)；profile 类型 [provider-manager.ts:22–29](../../packages/host/src/provider-manager.ts#L22-L29)；backend 契约 [agent-backend.ts:49–77](../../packages/host/src/agent-backend.ts#L49-L77)；Runtime 与 Session 分开保存 [Models.swift:84–96](../../ios/Orbis/Orbis/Models.swift#L84-L96)、[Models.swift:184–196](../../ios/Orbis/Orbis/Models.swift#L184-L196)；身份和路由边界 [ADR-0032](../adr/0032-host-owned-agent-state-model.md#3-模型层级与身份)；不同 provider 事实的边界 [ADR-0032](../adr/0032-host-owned-agent-state-model.md#8-供应商命令回执与记录的作用域)。Android 还明确注释 `currentProviders` 保存原生键、绝不是 Host profile IDs：[RemoteState.kt:510–515](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt#L510-L515)。

原版新建页没有供用户自由组合的“Agent × backend × provider × model”四个下拉框。Codex 两种入口以两个选项呈现；Pi TUI/RPC、DeepSeek ACP/Web 等协议由 Host 安装/配置/接入决定，普通手机创建请求默认携带 `spawnMode=tui`，新建目标只发 `agentKind` 与 `cwd`。手机入口以当前发布的选项为准。证据：[HostConnection.kt:562–595](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L562-L595)、[OrbisStore.swift:1096–1118](../../ios/Orbis/Orbis/OrbisStore.swift#L1096-L1118)。

## 2. 当前设置页：选定 Agent 内的配置

实际路径：选好电脑 → 设置 → “Agent 供应商” → 该 Agent 行的“切换” → 点击该 Agent 已保存的配置。两端设置都依次显示 Pi、Codex、Claude Code、DeepSeek 四行；没有独立 Codex Desktop provider 组。菜单勾号是实际 `enabled`，exclusive 配置已启用时不可再次点击；Pi additive 的已启用项仍可点击以移除启用。当前主路径点击菜单项便提交，并没有第二层确认弹窗。

证据：Android [MainActivity.kt:3116–3141](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L3116-L3141)、[AgentStatusProviderCard.kt:43–54](../../android/app/src/main/java/com/orbising/orbis/AgentStatusProviderCard.kt#L43-L54)、[AgentStatusProviderCard.kt:117–135](../../android/app/src/main/java/com/orbising/orbis/AgentStatusProviderCard.kt#L117-L135)；iOS [StatusViews.swift:21–25](../../ios/Orbis/Orbis/StatusViews.swift#L21-L25)、[StatusViews.swift:131–145](../../ios/Orbis/Orbis/StatusViews.swift#L131-L145)。协议严格只接受四类 Agent 的 `provider.list / provider.switch / provider.subscription`，不接受任意额外字段：[provider-messages.ts:4–20](../../packages/host/src/provider-messages.ts#L4-L20)。

切换不是乐观成功：手机保存请求、等待 Host 回执及供应商领域刷新；断线、Host 改变、清单变化、读取中、其他切换中或配额查询中限制操作。操作超时显示“请刷新以确认实际状态”，没有自动重试。Android 切换 90 秒期限、配额 45 秒；iOS 相同。证据：[AgentProviders.kt:47–49](../../android/app/src/main/java/com/orbising/orbis/AgentProviders.kt#L47-L49)、[HostConnection.kt:638–714](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L638-L714)、[HostState.swift:274–307](../../ios/Orbis/Orbis/HostState.swift#L274-L307)、[HostState.swift:360–375](../../ios/Orbis/Orbis/HostState.swift#L360-L375)。Host 清单不可用、截断或格式错误时呈现“未读取 / 未就绪”；Android [AgentModelProjection.kt:185–205](../../android/app/src/main/java/com/orbising/orbis/AgentModelProjection.kt#L185-L205)。

### 各 Agent 的切换含义

| Agent | 可做 | 限制和后果 |
| --- | --- | --- |
| Pi | 同时启用多张 profile；每张独立添加/移出原生 providers 节点 | 移除启用不会删除 Host 卡片，也不改认证或默认模型。移除全局默认后需在 Pi 内重新选择模型。已运行 Pi 需重开再用 `/model`。 |
| Codex | 在保存的 exclusive profile 间切换 | 通常写原生配置并重启自有 backend，已有 Session 要重新打开。工作中、队列、审批、权限更新、激活中会拒绝。已连接 Codex Desktop 共享后端时，即使空闲也拒绝，须先结束桌面版接入。 |
| Claude Code | 在保存的 exclusive profile 间切换 | Host 检查任一 Claude Runtime `running` 或存在待回答权限请求即拒绝。成功写配置；当前进程不自动换配置，需要重开会话。项目配置、启动参数与外部环境仍遵循 Claude 自身优先级。 |
| DeepSeek Harness | 在保存的 exclusive profile 间切换 | ACP/Web 后端自行确认，Web 切换时检查 App 会话及原生浏览器会话均无运行任务/审批/激活；等待配置热重载及原生凭据应用，以原生热加载完成确认。 |

Pi 原生只修改对应 providers 节点：[provider-manager.ts:574–577](../../packages/host/src/provider-manager.ts#L574-L577)；手机明确说明 Host 卡片仍保留与默认模型后果：[HostState.swift:80–84](../../ios/Orbis/Orbis/HostState.swift#L80-L84)、[MainActivity.kt:3348–3353](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L3348-L3353)。Pi 的 auth/default 边界：[ADR-0019](../adr/0019-host-provider-management.md#decision)。

Claude 运行限制的实际检查：[host-service.ts:1050–1063](../../packages/host/src/host-service.ts#L1050-L1063)；写配置路径 [provider-manager.ts:599–602](../../packages/host/src/provider-manager.ts#L599-L602)；重开提示 [provider-messages.ts:22–24](../../packages/host/src/provider-messages.ts#L22-L24)。这里“有任一 running 或待权限”是所读代码的明确条件，后台任务切换门禁的完整性仍待单独确认。

Codex 运行/桌面限制与重载：[codex-runtime.ts:631–649](../../packages/host/src/codex-runtime.ts#L631-L649)。例外：Host 已启用本地代理路由且从代理切到代理时，可以不重启、让后续请求用新路由；进行中请求保留开始时快照，官方 OAuth 不作为代理 failover 选项。该例外适用于本地代理路由：[ADR-0019](../adr/0019-host-provider-management.md#decision)、[host-service.ts:1079–1084](../../packages/host/src/host-service.ts#L1079-L1084)、[provider-manager.ts:568–572](../../packages/host/src/provider-manager.ts#L568-L572)。

DSH Web 限制与热加载：[dsh-web-runtime.ts:288–298](../../packages/host/src/dsh-web-runtime.ts#L288-L298)。Host “编辑当前 DSH 配置”可走 live reload，即使进行中也由原生验证；这是电脑编辑例外，手机切 profile 仍要求空闲。[host-service.ts:1079–1084](../../packages/host/src/host-service.ts#L1079-L1084)。

所有原生写入都校验外部修改、使用事务日志，写入或 reload 失败尝试回滚；回滚后重载仍失败则明确要求重启 Host，结果按实际重载状态报告：[provider-manager.ts:608–625](../../packages/host/src/provider-manager.ts#L608-L625)。

### 添加、编辑、复制与删除

手机不添加/编辑 API Key、URL、OAuth、CLI 参数、任意原生配置，也不安装 Agent。应引导用户在电脑 Host 的 Agent → 对应 Agent → 供应商配置完成导入/新建/编辑，再回手机刷新。Claude Host 入口有导入当前配置、预设、自定义、编辑、复制、排序、启用。Host 实际 save/switch/remove/copy 入口：[desktop-runtime.ts:875–894](../../packages/host/src/desktop-runtime.ts#L875-L894)。手机可操作边界：[ADR-0019](../adr/0019-host-provider-management.md#decision)、[ADR-0032](../adr/0032-host-owned-agent-state-model.md#8-供应商命令回执与记录的作用域)。

“Pi 从原生配置移除”与“从 Host 删除保存卡片”是两个动作。手机只有前者，发 `provider.switch enabled=false`，并没有 provider.delete。Host 真删除非 Pi 当前激活配置会拒绝，要求先切其他配置；Codex 若还在 failover 队列须先移出队列：[HostConnection.kt:678–706](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L678-L706)、[provider-manager.ts:531–554](../../packages/host/src/provider-manager.ts#L531-L554)。

双端还保留独立“供应商”页代码，有 Agent 分类、启用确认、Pi 长按多选移除、刷新、配额详情；但在检查到的当前正常导航中，Android `AgentProvidersScreen` 只有定义而无调用，iOS `.providers` 仅 debug 预览入栈及 destination 处理，当前设置行内菜单不进入该页。该页面属于保留实现。证据：[MainActivity.kt:3224–3355](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L3224-L3355)、[StatusViews.swift:212–375](../../ios/Orbis/Orbis/StatusViews.swift#L212-L375)、[ContentView.swift:20–26](../../ios/Orbis/Orbis/ContentView.swift#L20-L26)、[ContentView.swift:46–58](../../ios/Orbis/Orbis/ContentView.swift#L46-L58)。

### 订阅配额

当前启用且 Host 声明 `subscriptionSupported` 的 Claude/Codex 官方配置可查询 5 小时和周剩余百分比、重置时间、查询时间；API Key 配置不等于订阅账号，不承诺配额。手机只发 kind + profile ID，Host 重新核验当前实际配置和官方认证。当前订阅配额来源为 Claude / Codex。

设置行正文查询/刷新；没有读数时硬币可查询，有读数后点击硬币翻面切换周期，切换图标独立操作。刷新/失败保留上次读数及错误；断线/换电脑/换 profile 丢弃关联旧查询。证据：[AgentStatusProviderCard.kt:78–110](../../android/app/src/main/java/com/orbising/orbis/AgentStatusProviderCard.kt#L78-L110)、[StatusViews.swift:117–201](../../ios/Orbis/Orbis/StatusViews.swift#L117-L201)、[HostState.swift:310–340](../../ios/Orbis/Orbis/HostState.swift#L310-L340)、[HostState.swift:399–408](../../ios/Orbis/Orbis/HostState.swift#L399-L408)、[provider-manager.ts:314–338](../../packages/host/src/provider-manager.ts#L314-L338)。

## 3. 新建会话实际路径与可用性

1. 在当前电脑的新会话入口进入；从已有目录节点“在这里新建”会预填该目录，跳过目录浏览。
2. 选择 Pi / Codex 终端 / Codex 桌面版 / DeepSeek / Claude Code。
3. 在电脑目录浏览器逐层进入目录，可上一级、刷新、错误后重读；只列目录，有历史的目录排前；选定的是远端 cwd，不是手机文件夹。
4. 点击“在这里新建 {Agent} 会话”；需安全连接、无正在激活请求、路径非空、浏览结束且无错误。创建前模型不在此表单中选择。
5. 进入“启动中”的聊天页。Host 按需准备对应 backend，完成真实原生握手/会话建立后回报；关联 Session 的 Runtime 上线才视为启动落地。
6. 后端公布能力后，在会话内选模型/思考级别；不支持或未读取时明确不可用。

双端路径证据：[MainActivity.kt:1140–1264](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L1140-L1264)、[SessionViews.swift:502–603](../../ios/Orbis/Orbis/SessionViews.swift#L502-L603)；Host 作用域创建 guard [RemoteState.kt:1202–1206](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt#L1202-L1206)；默认有头请求和不静默降级说明 [HostConnection.kt:591–595](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L591-L595)。

`agents` 表示已就绪，`launchableAgents` 表示 Host 可在请求时启动/接入，二者分别呈现。DSH/Codex Desktop 可未预启动但可新建；Host 先复用现有 ready 连接，否则确保后端并等握手。DeepSeek/桌面版未安装、启动失败、接入失败、握手超时都明确返回失败；Codex 终端仍有 Host 未启用的失败分支。证据：[ADR-0056](../adr/0056-agent-startup-readiness-and-consent.md#21-app-请求会话时按需启动后端)、[host-service.ts:1228–1256](../../packages/host/src/host-service.ts#L1228-L1256)、[host-service.ts:2130–2181](../../packages/host/src/host-service.ts#L2130-L2181)。

代码/规范和平台差异：ADR 要求新建按 launchable 判断；iOS 统一用 `launchableAgents ?? supportedAgents ?? [pi,codex]`，所有 Agent 都按 allowed 列表禁用。Android Pi 始终可选，Codex 用 supportedAgents（未知允许），Desktop/Claude 要明确 launchable，DSH 用 launchable 优先再 supported；不可用选项回退 Pi，按钮本身不再校验 Agent 列表。此处保留 Android 与 iOS 的实现差异。证据：[SessionViews.swift:511–535](../../ios/Orbis/Orbis/SessionViews.swift#L511-L535)、[MainActivity.kt:1150–1163](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L1150-L1163)、[MainActivity.kt:1193–1204](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L1193-L1204)。

### 首次授权与原生权限

点击具体目录并启动，授权所选项目的配置与 Orbis 集成，工具 sandbox 与审批沿用原生管理。Pi 用本进程 `--approve`；Codex 只为所选目录设置项目 trust；Claude 使用项目级信任并预检登录；DSH 通过公开服务/session API。

账号登录/MFA、MCP OAuth、第三方插件授权、系统权限、组织管理策略不等于项目授权。手机没有统一完成所有首次授权的面板；识别得到就明确失败，其余等真实握手或超时，授权通过各自原生入口完成。[ADR-0056](../adr/0056-agent-startup-readiness-and-consent.md#1-统一边界)、[ADR-0056](../adr/0056-agent-startup-readiness-and-consent.md#实施与结果)。

### 启动失败和结果未确认

`session.activated` 是 Host 受理并给 Session 身份；该 Session 的 Runtime 上线才最终落地。手机可以立刻显示临时启动聊天页，这是本地操作占位，不是已成功的远端 Session。恢复时先显示缓存历史；失败/未确认在原位显示原因与“重试 / 返回”，保留草稿。离开启动页不取消后台启动，成功后也不强制把用户拉回来。重试是用户明确新操作，同目标、新 requestId。

证据：Android [OperationKinds.kt:54–65](../../android/app/src/main/java/com/orbising/orbis/OperationKinds.kt#L54-L65)、[OperationKinds.kt:729–779](../../android/app/src/main/java/com/orbising/orbis/OperationKinds.kt#L729-L779)、[HostConnection.kt:613–627](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L613-L627)、[MainActivity.kt:4647–4660](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L4647-L4660)；iOS [OperationKinds.swift:42–50](../../ios/Orbis/Orbis/OperationKinds.swift#L42-L50)、[OrbisStore.swift:1107–1161](../../ios/Orbis/Orbis/OrbisStore.swift#L1107-L1161)、[OrbisStore.swift:1476–1499](../../ios/Orbis/Orbis/OrbisStore.swift#L1476-L1499)。

## 4. 会话内模型、权限与 ADR-0061

模型选择使用当前 Runtime 已公布的 `/model` 和 `/thinking` 能力/选项。Android 在 composer 输入 `/`、选择命令及参数再提交；iOS 也支持 slash，另有“会话信息 → 模型/思考选项”的直接按钮。模型菜单来自当前 Session 的能力投影。

证据：[MainActivity.kt:2517–2568](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2517-L2568)、[HostConnection.kt:1405–1437](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L1405-L1437)、[ChatView.swift:1637–1662](../../ios/Orbis/Orbis/ChatView.swift#L1637-L1662)。模型/effort 可条件乐观显示“切换中”，等待 Host 状态确认；连续选择保留最后意图。[HostConnection.kt:1464–1473](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L1464-L1473)、[OrbisStore.swift:1271–1306](../../ios/Orbis/Orbis/OrbisStore.swift#L1271-L1306)。

会话权限是另一操作：当前 Session 范围，Host 提供 summary/details/tone/opaque setting/options/disabledReason，手机不根据 Agent 名称推断“完全权限”。权限编辑依据 Host 的 permissionManagement 能力；Android 显示“电脑端管理”，展开解释未提供信息，iOS 当前 composer 仅在有 metadata 时显示权限入口，缺失时隐藏入口（这是呈现差异）。工作中、待审批、并发更新时不能应用；改变权限不能代答一条审批，也不能发起模型回合。Android 先选择值再点“应用到当前会话”，iOS 直接点选项提交，均等电脑确认，不乐观勾选成功。缺失呈现证据：[RuntimePermissions.kt:109–135](../../android/app/src/main/java/com/orbising/orbis/RuntimePermissions.kt#L109-L135)、[ChatView.swift:491–501](../../ios/Orbis/Orbis/ChatView.swift#L491-L501)。

证据：[ADR-0031](../adr/0031-host-permission-management.md#decision)、[RuntimePermissions.kt:66–94](../../android/app/src/main/java/com/orbising/orbis/RuntimePermissions.kt#L66-L94)、[RuntimePermissions.kt:168–178](../../android/app/src/main/java/com/orbising/orbis/RuntimePermissions.kt#L168-L178)、[MainActivity.kt:2137–2142](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2137-L2142)、[ChatView.swift:1447–1488](../../ios/Orbis/Orbis/ChatView.swift#L1447-L1488)、[OrbisStore.swift:1558–1562](../../ios/Orbis/Orbis/OrbisStore.swift#L1558-L1562)。

Codex 的 App 下一轮 model/effort 选择与最近原生 settings 快照分别管理，以实际来源变化逐字段对账；null effort 表示重置，字段缺席保留当前值。权限更新保持自身作用范围。

0.166.0 的 thread 在首次输入前可能尚未物化，resume / 历史读取暂时失败。订阅依据原生生命周期恢复，配置完成依据原生设置确认。契约见 [ADR-0061](../adr/0061-codex-selection-and-native-settings-reconciliation.md)，实现见 [codex-runtime.ts:756–782](../../packages/host/src/codex-runtime.ts#L756-L782)。该修复尚未部署，完整设备门禁待完成。

## 5. Codex provider mismatch 与历史恢复

操作路径：目录 → 选择 Codex 类别/当前或全部 provider → 找到历史会话 → 查看缓存，或请求“在电脑继续会话”。恢复保留 Session 的 agentKind、cwd 与历史 provider。

两端 mismatch 条件相同：仅 `agentKind == codex`，历史 modelProvider 与当前原生 provider 都已知且不同。文案：“此会话属于 X，当前使用 Y。请在设置页切换到 X，再打开会话。”未知任一值不生成 mismatch，兼容状态仍为未知。证据：[SessionProviderFilter.kt:38–49](../../android/app/src/main/java/com/orbising/orbis/SessionProviderFilter.kt#L38-L49)、[OrbisStore.swift:1957–1960](../../ios/Orbis/Orbis/OrbisStore.swift#L1957-L1960)。当前原生 provider 来自 Codex config/read 的 `model_provider`，缺省是 `openai`：[codex-runtime.ts:1167–1176](../../packages/host/src/codex-runtime.ts#L1167-L1176)。

筛选包括“当前 provider”“全部 provider”“其他具体 provider”“未知 provider”，只是目录视图过滤，不改配置。两端 Codex Desktop 也有 provider 筛选，但上述 mismatch guard 只覆盖终端 Codex；Desktop 的同等恢复拦截尚未确认。[SessionProviderFilter.kt:14–35](../../android/app/src/main/java/com/orbising/orbis/SessionProviderFilter.kt#L14-L35)、[SessionViews.swift:157–169](../../ios/Orbis/Orbis/SessionViews.swift#L157-L169)。

Android：目录点击已知 mismatch 显示“需要切换 provider”；有缓存时提供“查看只读历史”，另有“知道了”，该弹窗没有直接设置跳转。真正 activate 前仍检查 mismatch；已归档还要求先恢复归档。[SessionDrawer.kt:314–324](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt#L314-L324)、[HostConnection.kt:545–558](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L545-L558)。

iOS：在线行 mismatch 对话框提供“取消 / 设置”，设置目标是当前设置页；无在线 Runtime 的会话优先开缓存，缺缓存则解释“本机尚无缓存”并可请求继续。缓存页明确只读，底部“在电脑继续会话”再走 mismatch 检查。证据：[SessionViews.swift:416–423](../../ios/Orbis/Orbis/SessionViews.swift#L416-L423)、[SessionViews.swift:466–469](../../ios/Orbis/Orbis/SessionViews.swift#L466-L469)、[ContentView.swift:165–177](../../ios/Orbis/Orbis/ContentView.swift#L165-L177)、[ChatView.swift:389–394](../../ios/Orbis/Orbis/ChatView.swift#L389-L394)、[OrbisStore.swift:1085–1093](../../ios/Orbis/Orbis/OrbisStore.swift#L1085-L1093)。

手机向 Host 发恢复时只提供 sessionId 与已知 agentKind，由后端根据记录定位目录。DSH/Desktop 可按需确保后端，再恢复；找不到、无法接入或原生拒绝明确失败。恢复沿用原 Session 身份。[HostConnection.kt:555–558](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt#L555-L558)、[OrbisStore.swift:1091–1093](../../ios/Orbis/Orbis/OrbisStore.swift#L1091-L1093)、[host-service.ts:2167–2207](../../packages/host/src/host-service.ts#L2167-L2207)。

## 6. 重构的表达原则

设计按真实领域对象组织入口，浏览、提交、执行与应用分别反馈，能力和结果以 Host 为准。Pi 呈现独立 additive 启用，其余配置按 exclusive 选择；配置编辑由电脑 Host 管理，历史恢复保留原生归属。

原生平台差异与实施范围以上述调用链为依据，设计稿、源码实现、部署与设备验收分别记录。启动和选型的待验收范围见 [ADR-0056](../adr/0056-agent-startup-readiness-and-consent.md)、[ADR-0061](../adr/0061-codex-selection-and-native-settings-reconciliation.md)。

## 7. 原来的主页、目录与电脑怎么用

用户先在手机扫码配对电脑。二维码属于电脑 Host，手机等待电脑确认；已配对电脑保持各自连接，切换只改变当前展示和操作目标，不会重连其他电脑。主页顶部电脑行可以切换，目录底部电脑菜单还可添加电脑、取消配对。当前主页与目录显示所选电脑。证据：[ADR-0030](../adr/0030-multi-host-mobile-connections.md#修订2026-10-29界面只显示当前-host)、[Android 配对入口](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L523)、[目录电脑菜单](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt#L600)、[iOS 电脑菜单](../../ios/Orbis/Orbis/ContentView.swift#L984)。

主页是这台电脑的已打开 Runtime 列表，点击卡片继续当前会话。首页右上方是下载和设置，左上方打开会话目录。左滑卡片或长按多选可以关闭符合能力条件的 Runtime；关闭结束在线运行实例，持久 Session 仍在目录。后台任务活跃或状态未知时不能关闭；本稿的示例能力只在主回合空闲、无队列时允许关闭。证据：[Android 主页](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L639)、[关闭能力](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt#L109)、[iOS 主页](../../ios/Orbis/Orbis/ContentView.swift#L533)。

目录是所有会话的档案，按真实 cwd 分组，包含未在手机打开过但电脑已报告的记录。目录不是用户创建的抽象“项目”集合。搜索匹配目录与标题；只展开一个目录，默认先展示五条，可以展开较早记录。全局加号先选 Agent 和远端目录，目录旁加号预置该 cwd。证据：[目录身份与范围](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt#L1209)、[展开与五条截断](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt#L281)、[搜索与新建](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt#L328)。

目录筛选包含全部、Pi、Codex 终端、Codex 桌面版、DeepSeek、Claude Code。只有两种 Codex 筛选有下一层 provider 范围：当前、全部、具体原生 provider、未知。筛选不会切换供应商配置。归档开关切换普通目录和归档目录；长按多选后归档或取消归档。在线 Pi/Claude 先关闭；在线 Codex/DSH 空闲时允许归档；连接未就绪不能提交。证据：[筛选菜单](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt#L83)、[provider 范围](../../android/app/src/main/java/com/orbising/orbis/SessionProviderFilter.kt#L14)、[归档限制](../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt#L839)。

## 8. 原来的聊天路径与平台差异

完整操作账本见 [原生聊天使用路径审计](orbis-chat-usage-audit.md)。本次重构特别保留以下关系：

| 用户动作 | 作用对象与结果 |
| --- | --- |
| 返回 | 页面导航，保留运行、草稿与阅读位置 |
| 停止 | 当前主回合，等待原生确认 |
| 关闭 | 在线 Runtime，保留持久历史 |
| 归档 | Session 目录分类 |
| 历史树 | 会话路径预览与显式历史操作 |
| Rewind | 按后端语义移动历史位置 |
| Git 分支 | cwd 的只读 HEAD |
| 审批 | 指定请求的回答 |
| 模型 / 思考 | 当前会话下一轮配置 |
| 供应商应用 | 指定 Agent 的 Host 配置 |
| 删除下载 | 手机任务与本地副本 |

两端历史进入方式不同：Android 普通点击未在线目录记录通常直接恢复；iOS 优先打开本机缓存，再提供“在电脑继续会话”。本稿采用缓存预览后显式继续的路径，并保留行菜单的继续入口。这是本次重构的明确选择，不声称原来两端相同。Android 运行中附件参数传递和纯附件入口也存在源码缺口；本稿演示完整正文/附件关联，未声称已修复原生实现。

## 9. 重构后的对应关系

新稿入口：[独立 mobile HTML](orbis-menu-concept.html)。初始页恢复为运行会话首页；不再一进页面就显示供应商卡组。倾斜卡组位于设置 → Agent 供应商，Agent 顶部切换为四组，卡片内容改为这组 Agent 的电脑配置。

| 原功能 | 新稿位置 / 操作 | 明确变化或简化 |
| --- | --- | --- |
| 当前电脑运行列表 | 首页卡片；长按多选 / 左滑关闭 | 保留当前 Host 隔离；增加首页新建快捷按钮 |
| 目录及标题搜索 | 抽屉彩色目录卡 | 目录名来自 cwd；抽象项目、首页 Agent 筛选移除 |
| 历史 / 归档 / 筛选 | 抽屉行菜单、筛选面板、归档开关 | 预览与继续分离；保留归档限制 |
| 添加/取消电脑配对 | 电脑面板 | 本地扫码/电脑确认演示，不调用真实相机和配对接口 |
| 新建 | Agent 五选项 + 远端文件夹浏览 | 去掉强制会话名称和供应商选择；名称来自首次输入。失败占位不进入正式历史目录，同电脑启动中限制重复新建 |
| provider 切换 | 设置 → Agent → 倾斜配置卡 → 应用 | 原版菜单点选即提交，新稿增加只浏览状态和显式应用；不与会话筛选联动 |
| Pi additive | 各卡独立启用/移除 | 其他配置保持；卡片仍留在 Host 示例清单 |
| 配额 | 当前官方配置下的剩余比例和周期翻转 | 演示查询/周期；不画成真实账号数据或未知零值 |
| 输入/队列/审批/停止 | 聊天 composer、队列行、审批卡 | 模拟回执、错误、核对；不使用网络；详情深度见交付说明 |
| 模型/权限/历史/工具/文件 | composer 与会话操作菜单 | 本地有限能力集合；权限入口不是虚构的通用 /permissions 命令 |
| 离线/失败/未确认 | 设置或会话菜单的演示情境 | 演示状态与产品操作明确分开；未确认不自动重发 |

原有 production feature ID、冻结参数和原生已验收计数未改变。新稿是独立设计探索，真实源端状态及能力仍须在将来原生接入中按对应 ADR 验证。浏览器结果、原生设备结果和源码审计分别记录。
