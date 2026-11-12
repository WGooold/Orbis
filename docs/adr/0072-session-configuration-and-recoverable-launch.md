# ADR-0072：会话配置与可恢复的乐观启动

日期：2026-11-10

Status: accepted（主路径已实现；自动验证与后端能力边界见下文；未部署，待用户验证）

关联：ADR-0031、0049、0051、0055、0058、0061、0064、0070。

## 问题

新建卡片只选择 Agent 与工作目录，创建请求不携带模型、思考深度或权限。运行中的配置修改又被通用写操作门禁阻挡，无法提前设置后续请求。进程上线、配置保存和原生配置确认属于不同事实；仅按上线释放首句会使默认配置抢先执行。丢失启动回执后重新创建请求也可能重复创建会话。

## 决策

### 配置作用域与来源

新建卡片显示模型、该模型支持的思考深度和权限入口，使用现有选择面板。Host 按后端、供应商配置身份与绝对工作目录返回原生默认值、可用选项及已保存偏好。未知、不支持和跟随原生默认分别表示。App 提交不透明选项，Host 校验和原子持久化后返回版本；偏好只影响随后新建的会话。

运行中允许提交当前会话的后续配置。后续所选值、保存进度和原生确认分开处理，模型变化时重算深度选项。当前请求使用的值由原生请求事实确认。后端能够原生更新时直接调用并核对，后端没有可验证的修改接口时明确显示能力限制。配置修改与历史回退、重载、关闭分别准入。权限按原生实际生效边界确认，单次工具审批保持独立，不能把配置成功当成某次审批的回答。

S52／SC76（r55）：Android Codex 顶栏运行中显示绑定原生 turn ID 的实际模型与深度，空闲显示确认的所选值。正常运行不加前缀；保存中、未确认、修改失败在标题行独立标记，仅确认所选配置与本轮不同才显示“下轮已设”。入口使用共用选择弹层分别显示本轮与下轮，修改保持输入草稿；改回原值清除差异标记。窄屏大字体优先显示模型与深度，Agent 与运行状态保留图标及无障碍描述。Host 依据已接受的原生 turn/start 参数或该 turn 的原生 turn_context 提供可选 currentTurn 事实；缺失、断线或身份不匹配显示未确认，保持 18／19 旧端所选字段语义。模型切换时将明确不受支持的深度调整到新模型支持的默认值。

### 新建时序

1. App 为一次启动建立稳定身份，保存配置快照和首句恢复副本，立即进入聊天页并显示启动中与本地首句。
2. 配置保存与启动按版本建立依赖；Host 在任何原生副作用前持久记录本次启动的设备、身份、参数指纹和不可变配置快照。
3. 优先带配置创建；原生需要会话身份时先创建空会话，登记返回的身份，再应用模型、深度与权限并核对。
4. Host 记录就绪结果并返回精确会话身份及本次配置确认。Runtime 上线可以提前呈现，首句必须等待本次配置确认。App 与 Host 的发送准入共同维护此条件。
5. 首句沿既有消息身份与 outbox 提交，配置失败保留原会话、输入和重试入口。空输入启动使用相同配置确认条件。

### 中断与恢复

配置和启动操作按身份及参数指纹去重。重复请求读取原结果或继续同一操作；同身份异参拒绝。启动操作持久保存原生会话身份及阶段，回执丢失后按启动身份查询。恢复配置使用原生读取或幂等 setter 对同一会话核对并确认；超时表示未确认，不能自动使用默认值或新建另一个会话。原生创建已执行、返回身份尚未持久记录时若无法精确找回，保留未知并阻止自动重建。Android SC73 的结果不明页提供显式“结束等待”，确认后解除本地阻塞并将首句还原到新建草稿；同时清理该启动占位会话的等待发送展示和发送账本操作，释放容量，保留其他会话的发送；提示原终端可能仍在启动及再次创建可能产生另一会话。

Claude 配置启动在开窗前按设备与启动记录持久保存预定原生 UUID，通过 `--session-id` 创建。插件继续使用既有 `launchId`／`sessionId` 握手，初次确认与迟到恢复均核对预定 UUID；同进程切换会话、断线或 Host 重启后仍只认原身份。预定身份不代表已创建，不作为就绪结果发送给 App。旧记录若既无已确认身份又无预定身份，则保留未知；已确认的旧记录继续按原会话恢复。实现见 `SessionConfigurationStore`、`ClaudeBackend`、`ClaudeModsBridge`、`TerminalClaudeLauncher`。Host 发起的 Claude 启动按 ADR-0073 无条件跳过 bypass 首次风险提示，通过单次临时 settings 传入 `skipDangerousModePermissionPrompt=true`，权限模式按所选配置执行。

App 在写入前保存启动与消息恢复信息，重开后先核对；未确认的消息不自动重发。旧连接或旧配置版本不能释放新操作的依赖。离开启动页后保持后台执行和不拉回页面的既有语义。Host 停止、配置清单变化和供应商切换后重新校验身份及选项。创建前的最终拒绝也持久保存，同身份迟到请求不能在稍后转为新建；App 保留被拒绝首句，重新选择配置前先处理原输入。

### 后端执行

| 后端 | 新建 | 运行中更新及边界 |
| --- | --- | --- |
| Codex 终端／桌面 | `thread/start` 传模型、`config.model_reasoning_effort`、沙箱、审批及处理者；返回有效设置 | `thread/settings/update` 支持活动 turn；模型／深度保留 ADR-0061 的下一轮覆盖和原生逐字段对账；权限等待有效设置确认 |
| DeepSeek Web | 创建空会话，`session/selectModel`，权限原生命令，读取投影 | 原生区分 `modelSelection.lastUsed`／`next`；权限执行并核对投影，实际工具生效边界由原生决定 |
| DeepSeek ACP | 当前版本只在 `session/new` 后返回清单；卡片提示先开空会话，原生会话中选择模型与深度 | 使用 `session/set_config_option` 返回的配置确认；没有权限选项时显示能力限制 |
| Pi | 原生 `--model provider/id`／`--thinking`，上线核对；清单读取保留供应商扩展 | 使用扩展原生 setter；通用沙箱／审批配置不由 Orbis 推断 |
| Claude Code | 原生 `--model`／`--effort`／`--permission-mode`；同参数初始化核对权限，TUI 桥接确认模型及深度选择 | 模型走 `config.set`，深度通过原生 `turn.step` 对下一 turn 应用；当前 turn 保留深度。`config.permissionMode` 只修改启动默认值，当前会话权限维持只读提示 |

### 协议与交互

新增能力独立声明后启用，保持协议 18／19 和旧创建路径。旧 Host 明确显示不支持新建配置；已选择的新功能不能被静默丢弃。用户界面保持乐观呈现与原位失败恢复，权限摘要以确认事实为准。

iOS 仅将带有匹配配置请求身份的协议错误归到配置操作；缺少身份的命令错误继续交由既有命令与关闭账本处理。发版全套回归保留首次失败于 `.artifacts/release-prep-20261110/ios-testflight-first-failure.log`，修复由 `LaunchLedgerTests` 的身份回归及既有 `StoreTests`、`QuitLedgerTests` 验证。

功能 S51／SC73：新建配置、配置确认后的首句放行、运行中后续配置、同身份启动恢复。相关实现及最小充分回归分别记录。

Claude 启动准备及 Android 结束等待回归：`claude-startup.test.ts`、`claude-launcher.test.ts`、`agent-backend.test.ts`、`host-service.test.ts`、`LaunchLedgerTest` 与 `OptimisticPresentationInstrumentedTest.uncertainLaunchCanOnlyBeAbandonedAfterConfirmation`。运行终端提示页、自动验证和 APK 审计见 `.artifacts/claude-launch-unresolved-20261112/verification.json`；其中首次风险提示拦截属于历史实现，当前按 ADR-0073 无条件跳过。Host 源码已编译，未替换运行中的 Host；Android 已构建，未安装，待用户验证。

## 验证与完成状态

2026-11-12 未提交改动审查发现的两项回归已修复：Claude 迟到恢复按持久预定原生身份核对，Android 结束等待同时释放发送账本。对应回归见 `claude-mods-bridge.test.ts`、`agent-backend.test.ts`、`session-configuration-store.test.ts`、`host-service.test.ts` 与 `LaunchLedgerTest`。隔离 Host／Relay 的实际重启、旧插件握手、会话切换及同会话重连通过；Claude 2.1.318／2.1.322 的原生隔离 TUI 均报告预定 UUID，并继续无条件跳过首次 bypass 提示。首次失败、修复前快照及修复后证据分别保留于 `.artifacts/native-cli-startup-review-20261112/verification-before-fixes.json`、`verification.json` 与 `fixes/`。Windows 所需验证见 ADR-0073「Windows 待验证」。

本机隔离原生验证、初次失败与未完成边界见 `.artifacts/new-session-launch-settings-20261110/verification.json` 及 `runtime-updates/verification.json`。Codex 两类 app-server 活动 turn 更新、Pi RPC 活动请求更新通过；DeepSeek Web 活动 turn 的选择及权限投影已确认，下一次模型请求探针尚有失败，保留原断言。Claude 原生 CLI 启动参数与首个本地请求已核对；隔离 TUI 的 `config.permissionMode` 修改只影响默认值，计划模式的原生 `tool.check` 不变；`settings.read()` 的文件深度与启动深度不同，不能用它确认 `--effort`。深度改为桥接到原生 `turn.step` 并以插件回归确认当前／下一 turn。TUI 探针初次失败与后续有效证据保存在 `implementation/native*`，插件验证见 `implementation/claude-mod-tests-final.log`。

实现、构建、断线／重复／重启自动验证、部署和设备安装验收分别记录；待用户验证。

实现指针：协议 `packages/protocol/src/session-configuration.ts`；Host `session-configuration-store.ts`、`host-service.ts` 及各后端适配器；Android `SessionConfiguration.kt`、`SessionDraft.kt`、`HostConnection.kt`；iOS `Models.swift`、`SessionViews.swift`、`OrbisStore.swift`。S51／SC73 使用基线 r54。

S52／SC76 实现：Host `codex-turn-configuration.ts`、`codex-runtime.ts`、`agent-state-facts.ts`；Android `SessionModelConfiguration.kt`、`AgentModelProjection.kt`、`OperationKinds.kt`、`MainActivity.kt`。针对回合身份、运行中修改、断线、失败和弹层草稿保持的测试见 `codex-turn-configuration.test.ts`、`SessionModelPresentationTest.kt`、`SessionModelConfigurationInstrumentedTest.kt`。自动验证、首次失败、部署与验收边界分别保存在 `.artifacts/android-turn-configuration-20261111/verification.json`；尚未部署，待用户验证。

S52／SC76 配套验证：已安装 Host 缺少 `currentTurnConfiguration`，新版 Android 在活动会话持续显示未确认；源码测试不能替代已安装包核对。两种 Codex 原生程序的隔离中途接入、运行中修改与完成清除，经生产适配器和 compact-v2 分帧验证；实际消息作为 `CodexTurnWireTest` 的固定输入验证 Android 双顺序接收及 unchanged 重连。新 Host 包的模块指纹、包内复测和旧安装差异见 `.artifacts/android-turn-configuration-20261111/running-unconfirmed/verification.json`；包已构建，未替换运行中的 Host，待用户验证。

自动验证指针：`implementation/node-final.json`、`final-launch-recovery-2.json`、`swift-final/run.log`、`android-final-2/`、`ios-app-final/`、`claude-model-regression-final.log`。回归源码为 `session-configuration-store.test.ts`、`session-configuration-probe.test.ts`、`host-service.test.ts` 的 configured launch 用例、双端 `LaunchLedger`、`ConfigLedger`、运行时权限用例，以及 Claude 插件 `reconnect.test.ts`。最终计数、源码指纹与构建状态统一见 `implementation/verification.json`。

剩余能力边界：ACP 的新建前清单、Claude 当前会话权限写入、Claude 原生默认模型与深度精确展示，以及 DSH Web 切换后的第二次真实模型请求尚未完成端到端验证。Claude 默认值未报告时显示继承并省略参数，模型清单的 `default` 别名不能替代当前配置。无专属权限接口的 Pi／ACP 保留来源说明。设备安装与视觉验收未执行；本轮不宣称这些边界已通过。

Android S51／SC73 回归：新建权限选项在弹层内暂存，显式应用才执行退场提交，避免透明窗口残留拦截触摸。启动恢复记录通过 `ConfiguredLaunchJournal` 在后台串行读写，UI 和状态锁只访问内存快照；启动发送与就绪结果仍等待对应记录落盘。回归源码为 `SessionDraftConfigurationInstrumentedTest`、`ConfiguredLaunchJournalTest` 及既有启动／等待发送／配置账本测试。构建、自动验证与设备环境阻挡记录见 `.artifacts/draft-permission-freeze-20261111/verification.json`；未安装，待用户验证。

Android S51／SC73 工作目录弹层：草稿卡片的目录浏览复用共用面板，面板内导航（「上一级」「重新读取」）不触发退场，只有「使用此目录」按关闭时序提交；否则退场先于面板移除执行，残留的透明窗口吞掉后续触摸，界面看起来卡死。回归为 `BottomSheetInstrumentedTest.draftDirectoryNavigationKeepsTheSheetAlive`，修复前同一用例在 `上一级` 处收不到点击。构建、修复前失败与修复后 13 项设备回归见 `.artifacts/draft-directory-freeze-20261112/`；未安装，待用户验证。

S55／SC79（r57）：两端新建卡片的模型独占一行，思考深度与权限在下一行等宽排列；权限入口使用短名称，完整组合保留在无障碍值及分类面板中，深度优先展示 Host 选项标签。实现见 `SessionDraft.kt`、`SessionViews.swift`，HTML 同步见 `docs/design/session-draft-card-proposal.html`。320dp、中英文放大文字与长权限组合回归见 `SessionDraftConfigurationInstrumentedTest`、`OrbisUITests`；构建、界面验证及交付状态见 `.artifacts/draft-config-layout-20261111/verification.json`，待用户验证。

S56／SC80（r58）：Pi 原生 assistant 消息、Claude 既有 session.state 和 DeepSeek Web 顺序日志的 request/header，统一映射到 S52 的 currentTurn 契约；实际配置按本轮身份核对，Claude 请求序号阻止迟到状态覆盖原生回退。ACP 明确只报告选择值。非 Codex 缺少可匹配本轮事实时显示“所选”，面板使用“当前所选”，不提供无效的事实核对按钮；未知原生深度不借用实时选择值。Pi／Web 的修改可作用于后续模型请求，确认差异标为“后续已设”。Codex 的本轮规则保持 S52。

选中值复用 `SessionConfigurationValues` 的模型与深度字段，通过既有 metadata、model 领域和 Android 投影传递，保留 Pi provider/id、Claude 别名和 DeepSeek JSON 命令编码。Claude effort 复用 submitConfig、配置账本、发送前置等待及重试；权限继续使用原有独立投影和操作。实现见各后端适配器、`SessionModelConfiguration.kt`、`OperationKinds.kt`；回归见相邻适配器测试、`SessionModelPresentationTest`、`ConfigLedgerTest` 和 `SessionModelConfigurationInstrumentedTest`。实现、自动验证、打包与部署边界见 `.artifacts/android-turn-configuration-20261111/cross-agent-fix/verification.json`；未替换正在运行的 Host，待用户验证。
