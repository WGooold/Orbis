# ADR-0099：Antigravity CLI 的 App 客户端接入

日期：2026-11-27 · 状态：AGY-16 在独立 worktree 实现桌面端官方 CLI 登录、四种认证与订阅配额投影；未部署。真实 Google 登录、真实配额读取与用户验收待验证。

历史：2026-11-19 的 ACP 草案（原编号 0090，`f13aab5`）及 AGY-01–03（末端 `028936f`）保存在本地 `archive/agy-acp-20261119`。主线的 ADR-0090 已用于 Linux Headless Host；此 ADR 取代 AGY 旧方案，不改变 Linux ADR。

关联：[Host Agent state](0032-host-owned-agent-state-model.md)、[乐观操作](0049-optimistic-send-and-source-reconciliation.md)、[交互状态](0055-agent-input-lifecycle-and-state-coverage.md)、[协议兼容](0064-protocol-compatibility.md)、[目录与历史](0069-session-catalog-and-bounded-history-loading.md)、[可恢复启动](0072-session-configuration-and-recoverable-launch.md)、[Agent 启停](0094-host-agent-enablement.md)、[Codex 启动](0095-codex-unified-catalog-and-launch-modes.md)。

## 选择与边界

Orbis App 是交互界面。Host 启动本机官方 `agy acp` 子进程，通过 ACP v1 stdio 接入；Relay 继续传输 Orbis 加密消息。手机不直接连接 Google 或 ACP，Host 不开终端、不做镜像、不附着 Antigravity 桌面/TUI 已运行的会话，也不读取私有数据库或包装 `agy -p`。

验证基线沿用 [`agy 1.5.17`][release] 与 [`ACP v1`][schema]。发布记录与隔离握手分别确认版本和能力；不能从版本推断登录、模型或回放已可用。[官方 ACP][acp] 是本机子进程入口。AGY-16 按用户明确产品需求复用官方 CLI 登录，不自行实现 Google OAuth；此工程决策不构成对 Google 条款、订阅资格或第三方接入合规性的判断，相关条款需由产品方另行确认。

### AGY-11｜Host 所有权与启用边界

- Host 进程须经本机策略授权。桌面 Host 的 Agent 页即使 AGY 未启用也提供本机设置入口；手机不能保存凭据，也不能在 Host 未配置认证时远程启用该 Agent。无头 Host 保留显式环境 Key 接入。
- CLI 从 Host 登录环境的 PATH、平台官方安装位置或绝对 `ORBIS_AGY_ENTRY` 发现。要求 `agy >= 1.5.17`、ACP v1、`session/list`/`load` 能力及与所选认证方式相符的原生认证声明；任一检查失败都不发布 ready。
- `agy-acp` 使用 Host 独占 profile 和 owner lock；`--gemini-dir`、`GEMINI_HOME`、缓存、临时目录均限定在该 profile。API Key 只由 Host 受限子进程环境提供，不进入 argv、ACP 请求、Relay/App、Host JSON 配置、诊断或日志。OAuth token 保留在 CLI 自己的实例 profile，不进 Orbis 凭据槽。ACP 输出先按 Key/token 脱敏再解析，原生 stderr 不进入 Host 日志。
- 桌面设置先验证所选认证，再保存 API Key 到 macOS Keychain／Windows DPAPI，或通过 CLI 登录写入隔离的 OAuth profile；失败时保留原认证。重启后状态不向 App 暴露凭据；环境变量模式只读。没有系统 Key 凭据后端时不回退到明文文件。
- 用户完成本机验证后再启用 Agent；ACP ready 时手机才可新建。真实推理仍由 Google 和所选模型决定；认证成功或空 `session/list` 不证明某一次模型调用已成功。
- 2026-11-25 的 API-only 决定由 AGY-16 修订；本 ADR 不声称登录或订阅用量已获任何外部条款批准。启动不安装 CLI、不改全局权限或绕过限制。请求 `--sandbox` 并保留原生权限规则，不把该参数宣称为所有平台已验证的沙盒保证。

实现：[`agy-auth.ts`](../../packages/host/src/agy-auth.ts)、[`agy-client.ts`](../../packages/host/src/agy-client.ts)、[`acp-client.ts`](../../packages/host/src/acp-client.ts)、[`desktop-runtime.ts`](../../packages/host/src/desktop-runtime.ts)、[`CredentialStore`](../../packages/windows-host/src/CredentialStore.cpp)、[`HostController`](../../packages/windows-host/src/HostController.cpp)、[`agent-enablement.ts`](../../packages/host/src/agent-enablement.ts)、[`host-service.ts`](../../packages/host/src/host-service.ts)。

### AGY-12｜目录、生命周期和交互

| Codex CLI 对照 | AGY 行为 |
| --- | --- |
| 目录和恢复 | `agy` 独立 kind，`agy:<原生 ID>` 是目录及控制身份。只读、限时分页 `session/list`；分页不完整保留已确认行，不把失败当空目录。显式恢复用 `session/load` 读取 ACP 回放，连接代次变化时重建历史 epoch。`session/resume` 不回放，不用它替换历史读取。只显示回放提供的内容，不补造时间或原生条目 ID。 |
| 新建和首句 | 复用现有 `session.launch` / 启动账本，native ID 确认后才通知 App；首句只在匹配的启动已就绪时发送。没有 native ID 的模糊创建只保留未知结果，不自动重建；有原生会话 ID 则按原会话恢复。AGY 不开 TUI。 |
| 发送、停止、排队 | 走 `session/prompt`、`session/cancel`。一个会话同一时刻只提交一个原生 prompt；忙时支持后续排队、撤回以及先停止再立即发送。同一提交 ID 不发第二次；持久 spent 标记只防重，不是送达证明。未确认的回合不继续派发挂起队列。附件沿用 Host 已落地的路径提示，不请求客户端文件能力。 |
| 权限、问题和工具 | 默认通过 App 现有交互卡确认原生一次性权限选项，会话工具审批模式见 AGY-17；取消、超时、关闭或断线清理待确认。支持有界、平坦的必填字符串／枚举／布尔 ACP 表单；不代理 URL、敏感输入或未知请求。流式文本、思考、标题、上下文用量及有界工具摘要按实际 ACP 更新投影；不把任意参数、工具输出或诊断正文放进共享事件。 |
| 模型与深度 | 从原生会话 `configOptions` 生成会话内选择器，只发该会话实际提供的选项；`session/set_config_option` 的结果需要原生读回。新建前无安全可读的模型目录，使用原生默认，不为取目录新建占位会话；App 固定携带的空权限容器不算已选配置。没有实际执行配置事实时不宣称「本轮使用」。 |
| 关闭、历史与不支持项 | 若协商 `session/close`，用运行代次确认并关闭确切会话，历史仍可重新打开。AGY 不提供归档、删除、原生文件差异、原始工具展开、跨会话并行子任务或其它没有验证清楚的原生功能；不把 `/quit`、关闭、回滚或归档互相替代。 |

实现与断言：[`agy-runtime.ts`](../../packages/host/src/agy-runtime.ts)、[`agy-runtime.test.ts`](../../packages/host/src/agy-runtime.test.ts)、[`agy-approval.ts`](../../packages/host/src/agy-approval.ts)、[`agy-elicitation.test.ts`](../../packages/host/src/agy-elicitation.test.ts)、[`agy-submission-fence.test.ts`](../../packages/host/src/agy-submission-fence.test.ts)。

### AGY-13｜App 和桌面入口

iOS／Android 在配对 Host 确认能力后才允许新建与恢复；复用 Agent 拨盘、目录、草稿、历史、模型设置、交互和关闭确认。桌面 Agent 页只用于本机启用、显示接入状态或后台重试，不提供终端入口。旧 Host 不公告 `agent.agy`，新 App 不向它声明或发起 AGY 操作。没有该能力的设备看不到 AGY 启用项、运行态、目录、启动记录或诊断；先过滤再构造目录计数、工作区、分页和增量。换连接或失去能力不重用旧投影；协议版本不变。

实现：[`OrbisStore.swift`](../../ios/Orbis/Orbis/OrbisStore.swift)、[`HostConnection.kt`](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)、[`Main.qml`](../../packages/windows-host/src/qml/Main.qml)。测试：[`LaunchLedgerTests.swift`](../../ios/Orbis/Tests/LaunchLedgerTests.swift)、[`AgyIntegrationTest.kt`](../../android/app/src/test/java/com/orbising/orbis/AgyIntegrationTest.kt)、[`OverviewRowHoverTest.cpp`](../../packages/windows-host/src/tests/OverviewRowHoverTest.cpp)。

### AGY-15｜Host 本机 API Key 设置与连接验证（历史实现）

Agent 页可在尚未启用 AGY 时打开设置卡，输入框使用密码遮蔽和禁预测输入；密钥通过 Qt 私有本机桥交给 Host，不进入 App／Relay wire schema。Host 先请求固定官方 Gemini `models.list` endpoint，随后以临时 HOME/Gemini 目录启动 `agy acp --stdio`，走官方 `authenticate(gemini-api-key)`，再要求 `session/list.sessions` 为数组。认证探测进程退出后清理临时目录；会话进程使用独立、跨 Host 重启保留的 profile。只有完整探测成功才将新密钥原子替换进系统凭据存储并允许启用。请求 deadline、凭据拒绝、网络不可用、CLI 缺失／不匹配分别留在本机 UI；错误正文和 Key 不传给 App。

更换失败时旧密钥仍保留。重试会复验现有密钥；移除先删系统凭据，再让私有 Host 桥清除内存密钥并结束/回收当前 AGY ACP generation，不改变已保存的启用偏好。每次 UI 重启后，从 macOS Keychain／Windows DPAPI 读取并重验；只把 `{source, requiredVersion, installed}` 与有限状态投影到 Qt。环境 Key 模式仅显示来源、不可编辑。Linux/其它没有该 Host 凭据后端的平台不落盘、不降级为明文。

实现：[`agy-credential.ts`](../../packages/host/src/agy-credential.ts)、[`agy-client.ts`](../../packages/host/src/agy-client.ts)、[`desktop-runtime.ts`](../../packages/host/src/desktop-runtime.ts)、[`desktop-bridge.ts`](../../packages/host/src/desktop-bridge.ts)、[`desktop-command-lanes.ts`](../../packages/host/src/desktop-command-lanes.ts)、[`CredentialStore`](../../packages/windows-host/src/CredentialStore.cpp)、[`HostController`](../../packages/windows-host/src/HostController.cpp)、[`Main.qml`](../../packages/windows-host/src/qml/Main.qml)。断言覆盖 Google endpoint/认证探测、secret redaction、系统凭据先提交、失败保留旧值、替换、移除、重启读取、远程 enablement 拒绝及 Host 生命周期隔离；主机本地真实 Key 与推理尚未运行。

### AGY-16｜官方 CLI Google 登录与四种认证

AGY-16 覆盖 AGY-11 原 API-only 认证限制。桌面 Host 默认选择 `oauth-personal`；认证和计费边界如下：

| 方式 | 本机凭据来源 | 计费／额度 |
| --- | --- | --- |
| `oauth-personal`（默认） | 官方 `agy acp --login` 完成 Google 账号登录 | 使用账号订阅；Host 可查询 Google Cloud Code 配额摘要 |
| `oauth-business` | ACP 原生 Google 登录 + GCP project/location | Gemini Enterprise 订阅；Host 可查询 Google Cloud Code 配额摘要 |
| `gemini-api-key` | Gemini Developer API Key，Keychain／DPAPI 槽 | API 计费，不显示订阅配额 |
| `agent-platform` | Vertex/Agent Platform API Key，或明确配置 project/location 并使用本机 ADC | API 计费，不显示订阅配额 |

- Orbis 不实现 Google OAuth。`oauth-personal` 使用官方 `agy acp --gemini-dir <profile> --app-data-dir antigravity-acp --login`，过滤显示环境变量，只从 CLI stdout 接受经校验的 Google 登录 URL；用户在浏览器完成授权后把 code 粘贴回 Host。`oauth-business` 使用 ACP 原生 `authenticate`，通过 profile 私有的 `BROWSER` helper 捕获并校验 Google URL，Host UI 提供打开授权页；不把个人 code-flow 混用于 Enterprise。AGY Agent 必须先停用，避免登录进程与运行中的 ACP 同时写 profile。
- 为保留既有 API Key 用户的数据，Key 模式继续使用旧 `stateDir/agy-acp` profile、`~/.gemini` 相对布局和 `orbis-agy` app-data 名称；新认证方式使用 `stateDir/providers/antigravity/<sha256(instanceId)>`，当前单实例身份为 `orbis:agy:default`，目录作为 `GEMINI_HOME`，app-data 为 `antigravity-acp`。Orbis 当前每个 Host 只有一个 AGY 账号槽，不等同于 T3 按多个 provider instance 并存多个账号。个人登录用本地 `SSH_CONNECTION` 标记，引导官方 CLI 将该账号凭据保存在隔离 profile，而不是覆盖共享 OS keyring 项；Enterprise 凭据存储由 CLI 决定。Orbis 不持久化、刷新或跨 profile 转存 OAuth 凭据/code；配额查询会短暂读取 CLI 自有 token 文件或原生 keyring，以内存 access token 直接请求 Google，不把 token/code 放入 Orbis 凭据槽、Host 设置、Relay、日志或诊断。API Key 仍只存系统凭据槽。
- 登录／退出与 ACP 运行共用每 profile 独占 owner lock。退出通过 CLI 公布的 `auth.logout` 能力完成；重启后由 CLI 在原 profile 中验证现有登录。Host 设置仅保存认证方式与非密钥 GCP 参数。
- AGY 子进程仅继承必要的 PATH 和平台变量，清除宿主机 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`、GCP project 等认证／计费环境。只有用户选定 Key 模式才传入对应 Key。Agent Platform 无 Key 模式允许 Google SDK 在本机默认凭据目录发现 ADC，不继承 `GOOGLE_APPLICATION_CREDENTIALS`。
- Google 账号配额从 CLI 自己的 `antigravity-oauth-token` profile 文件读取短期 access token；Enterprise 在 CLI 使用原生 keyring 时只读 `gemini:antigravity` 项。Orbis 不刷新 token、不复制 token、不修改 keyring。Host 调用 `daily-cloudcode-pa.googleapis.com`／`cloudcode-pa.googleapis.com` 的 `v1internal:retrieveUserQuotaSummary`，personal 与 business 分别选择首选端点，合并计量池并保留 Gemini、Argon/Carbon 与 Claude/GPT shared 的 5 小时／weekly 窗口。API Key 与 Agent Platform 返回不支持订阅配额，不会把 API 用量伪装为订阅额度。
- AGY 的 `provider.list`／`provider.subscription` 只在客户端协商 `agent.agy` 后可用；认证方式、订阅支持状态与配额池通过既有 provider/quota 投影传递。旧客户端仍不会因 `device.ready` 收到该 Agent；新版手机 Host Dial 支持查询并按池展示聚合窗口和模型池窗口。旧客户端收到新 quota 中的可选 `pools` 仍可读取原 `windows`。
- 内部 Cloud Code quota API 属于 Google 端点的实测技术调用；本 ADR 不据此推断服务条款许可、稳定性或对外授权。

实现：[`agy-auth.ts`](../../packages/host/src/agy-auth.ts)、[`agy-login.ts`](../../packages/host/src/agy-login.ts)、[`agy-usage.ts`](../../packages/host/src/agy-usage.ts)、[`agy-client.ts`](../../packages/host/src/agy-client.ts)、[`acp-client.ts`](../../packages/host/src/acp-client.ts)、[`provider-messages.ts`](../../packages/host/src/provider-messages.ts)、[`host-service.ts`](../../packages/host/src/host-service.ts)、[`SubscriptionQuotaSchema`](../../packages/protocol/src/subscription-quota.ts)、[`HostController`](../../packages/windows-host/src/HostController.cpp)、[`Main.qml`](../../packages/windows-host/src/qml/Main.qml)、[`HostState.swift`](../../ios/Orbis/Orbis/HostState.swift)、[`AgentProviders.kt`](../../android/app/src/main/java/com/orbising/orbis/AgentProviders.kt)。Fake CLI 与 mock HTTP 覆盖 token 文件／过期、池投影、端点优先级和旧协议聚合兼容；不等价于真实 Google 授权、配额服务或推理。

### AGY-14｜验证与交付

- 同版隔离 Host／Relay／ACP fixture 检查协商、新建、流式消息、历史、密钥更换时的 generation 撤回和同设备能力撤回；另有 ACP 进程 fixture 检查从认证、ready、创建到首条 prompt 的完整顺序及密钥不进入共享文本。夹具不等价于真实模型推理。测试见 [`agy-client.test.ts`](../../packages/host/src/agy-client.test.ts)、[`agy-credential.test.ts`](../../packages/host/src/agy-credential.test.ts)、[`agy-runtime.test.ts`](../../packages/host/src/agy-runtime.test.ts)、[`host-service.test.ts`](../../packages/host/src/host-service.test.ts)。
- 代码验证：本轮完整 `npm test` 为 2,965 通过、22 跳过、9 失败，9 个失败均在 `67a062c` 独立基线复现；AGY 聚焦 Node 文件 [192 项通过、3 项跳过](../../.artifacts/agy-acp-20261125/setup-node-tests-final.log)，最终类型检查、打包和定向 lint 分别记录于 [`setup-node-types-final.log`](../../.artifacts/agy-acp-20261125/setup-node-types-final.log)、[`setup-node-build-final.log`](../../.artifacts/agy-acp-20261125/setup-node-build-final.log)、[`setup-node-lint-final.log`](../../.artifacts/agy-acp-20261125/setup-node-lint-final.log)；临时 ACP profile 清理加固后的补充类型检查、55 项聚焦测试与打包见 [`setup-node-types-hardening.log`](../../.artifacts/agy-acp-20261125/setup-node-types-hardening.log)、[`setup-node-hardening.log`](../../.artifacts/agy-acp-20261125/setup-node-hardening.log)、[`setup-node-build-hardening.log`](../../.artifacts/agy-acp-20261125/setup-node-build-hardening.log)。[iOS Swift](../../.artifacts/agy-acp-20261125/swift-final/run.log) 80 项通过，无签名 Simulator 构建成功；[Android](../../.artifacts/agy-acp-20261125/android-final/run.log) 35 项通过，另有已核验的 [Debug APK](../../.artifacts/agy-acp-20261125/android-debug/artifact-verification.log)；本轮 [Qt/macOS](../../.artifacts/agy-acp-20261125/setup-qt-final-2/run.log) Host live-change、AGY 启动和未启用时设置卡均通过，租约正常释放。旧 Kimi Web UI 断言也在此前 [基线](../../.artifacts/agy-acp-20261125/qt-baseline-kimi/run.log) 失败，未改断言。
- 已发布 Relay `v0.1.24` 的 AGY 加密链路对照仍为通过（[先前证据](../../.artifacts/agy-acp-20261125/relay-release-delivery.log)；本轮重跑见 [`setup-relay-release.log`](../../.artifacts/agy-acp-20261125/setup-relay-release.log)）；不等价于运行旧 iOS／Android 安装包。完整 Node 基准为 2,965 项通过、22 项跳过、9 项失败；在原集成提交 `67a062c` 的独立归档基线中，四个相同测试文件的相同 9 项断言均复现（分别涉及发布站点中点字符、Codex 桌面 CLI 清理、DSH Desktop／OpenClaw 可见性以及两条 Agent Enablement 兼容断言）。对照日志见 [`setup-node-suite.log`](../../.artifacts/agy-acp-20261125/setup-node-suite.log) 和 [`setup-full-baseline.log`](../../.artifacts/agy-acp-20261125/setup-full-baseline.log)；保持失败原样、未改断言。实机 CLI 在无凭据隔离环境确认 `1.5.17`、ACP v1、list/load/close 能力；另证明 ACP 对占位 Key 可报告认证和空会话成功，但官方 Google `models.list` 拒绝该值（[证据](../../.artifacts/agy-acp-20261125/setup-native-auth-proof.log)）。未调用真实模型或使用个人账号。
- [本地证据目录](../../.artifacts/agy-acp-20261125/)保留首次失败、构建租约清理、重跑和对照。本轮 macOS Host 预览包构建和签名完成，但包后 smoke 在必需的 Overview 操作按钮检查上以 exit 44 退出；未将未通过 smoke 的包作为可安装候选。QA 看板需要可拉取的候选提交，本地候选尚未发布到远端。
- 待用户验证：安装未发布的本地候选，通过 Host UI 录入用户自行管理且获授权的 Gemini Developer API Key，检查真实 Key 的官方复验与 Keychain/DPAPI 往返，再跑首次 AGY 会话和首条真实模型响应、审批允许／拒绝、停止／排队、更换／移除、关闭后重开、断线恢复及旧 App 不出现 AGY。当前无真实 API Key，因此调用、配额、模型权限和端到端实际推理仍未验证；Android/iOS Host 设备矩阵也未完成。未签发、未部署；QA 候选受远端分支约束，本工作树不推送未在 origin 的父提交、不登记候选、不代领用户测试。

### AGY-16 本轮验证与待办

- `npm run typecheck` 与 AGY auth/login/client/desktop-runtime 定向 Vitest 在当前工作树执行；HostService 定向套件的两条既有 Codex 目录断言本轮仍失败，未改断言。Qt 6.8.3 构建成功，`HostLiveChangeTest` 的本机 Key／Google 登录用例及 `OverviewRowHoverTest` 的 AGY 设置卡用例通过；租约完成释放。
- `npm run typecheck`、定向 ESLint 与 24 项 AGY／provider-quota Vitest 通过；Qt `HostLiveChangeTest` 的 API Key、个人 Google code 与 Enterprise browser-helper 用例以及设置卡用例通过（[证据](../../.artifacts/antigravity-google-auth/qt-final/run.log)）。iOS `HostStateTests`／`ProviderDialGeometryTests` 36 项通过并完成无签名 Simulator build（[证据](../../.artifacts/antigravity-google-auth/ios-final/run.log)）；Android `SubscriptionQuotaTest`／`AgentDialStateTest` 通过（[证据](../../.artifacts/antigravity-google-auth/android-final/run.log)）。QA build lease 均按归属清理；Xcode 留存的 `ibtoold` 完全退出后已定向恢复残留租约（[恢复记录](../../.artifacts/antigravity-google-auth/ios-final-recovery.json)）。
- 配额按池解析、认证模式 gating、encrypted provider 路由与双端 UI 已有源级覆盖；本轮仍未使用真实 Google 账号／OAuth token／配额服务，真实授权与真实 quota 响应待验证。
- 待用户验证：Host 上停用 AGY 后完成默认 Google 登录，检查取消、退出、Host 重启后的 CLI profile 恢复；查看订阅窗口与池、分别核对 Gemini Enterprise project/location、Gemini API Key、Agent Platform Key/ADC。真实授权、模型响应、Windows DPAPI 和实际手机展示均待验证；不部署、不宣称已验收。

### AGY-17｜当前会话的工具审批模式

- 实现（2026-11-28）：复用 iOS／Android「当前会话权限」和既有 `permissions.update`。默认逐次确认，可切为自动批准编辑或自动批准已识别的工具操作（含命令）。Host 发布生效值；切换影响后续审批，不要求重启 CLI，也不替用户处理已显示的卡片。
- 自动决策只使用原生本次请求唯一的 `allow_once`，不修改 CLI 沙盒配置，也不自动回答提问或原生警告。设置限当前打开的会话：App 重连同一 Host 会话可读回；关闭后重开或 CLI 断开后恢复逐次确认。实现见 [`agy-permissions.ts`](../../packages/host/src/agy-permissions.ts)、[`agy-approval.ts`](../../packages/host/src/agy-approval.ts)、[`agy-runtime.ts`](../../packages/host/src/agy-runtime.ts)。
- 自动验证：[`agy-runtime.test.ts`](../../packages/host/src/agy-runtime.test.ts) 覆盖运行中切换、回退和会话隔离；[`host-service.test.ts`](../../packages/host/src/host-service.test.ts) 在隔离 ACP 下验证同版及 `v0.1.26` Relay 的权限读写、App 重连和能力撤回。证据保留于 [本轮 `.artifacts`](../../.artifacts/agy-session-permissions/)。
- 部署与用户验收：未部署、未替换正在运行的 Host 或 ACP。真实 AGY 调用和手机验收待验证。

[acp]: https://antigravity.google/docs/ide/extensions/acp/
[release]: https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.17
[schema]: https://agentclientprotocol.com/protocol/schema
[models-api]: https://ai.google.dev/api/models
