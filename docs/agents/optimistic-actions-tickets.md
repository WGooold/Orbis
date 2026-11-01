# 用户操作乐观显示实施 ticket（ADR-0049 §5–§7，ADR-0051 r27）

这些条目追踪 [ADR-0049 §5–§7](../adr/0049-optimistic-send-and-source-reconciliation.md) 与 [ADR-0051 r27](../adr/0051-ui-style-motion-and-visual-stability-freeze.md)（V22，V07、V10–V12 修订）的实施与验收。
仓库规定 GitHub Issues 是 canonical tracker；本文件只保存本地状态，尚未创建 issue。

工作区：`.claude/worktrees/optimistic-actions`，分支 `feat/optimistic-actions`，基线 `main` `ec5b7af`。

## 实施状态

| ticket | 状态 | 剩余 |
| --- | --- | --- |
| OPT-00 | 已实现，测试通过（两端各 22 项；变异检验两端均失败） | — |
| OPT-H1 | 已实现，测试通过（host-service 47 项，含归档 / 启动的成功与失败回执） | — |
| OPT-01 | 已实现；单元、构建与定向设备用例通过（2026-11-01） | 手动 R27 关闭断线项未执行；全量门禁归 OPT-10 |
| OPT-02 | 已实现，单元测试通过（两端各 8 项） | 设备专项见 OPT-10 |
| OPT-03 | 已实现，单元测试通过（两端各 9 项；成功回执后叠加保持到目录体现） | 设备专项见 OPT-10 |
| OPT-04 | 已实现，单元测试通过（两端各 10 项；`cancelled` 不再显示） | §6.3 实施修订已写入 ADR；设备专项见 OPT-10 |
| OPT-05 | 已实现，单元测试通过（两端各 9 项） | 设备专项见 OPT-10 |
| OPT-06 | 已实现 `waiting`（附件、顺序、V17 副本），单元测试通过（两端各 6 项） | 结算仍由 ADR-0055 outbox 负责（ADR-0049 §7.7）；附件缩略图未做，状态行写明附件名 |
| OPT-07 | 已实现，单元测试通过（两端各 7 项） | 设备专项见 OPT-10 |
| OPT-08 | 已实现，单元测试通过（两端各 6 项） | Android 启动页暂不显示缓存历史（ADR-0049 §7.7）；设备专项见 OPT-10 |
| OPT-09 | 已实现：协议 `messageId`、Codex skill 声明、两端本地气泡（两端各 4 项） | Claude 用户命令、DSH Web skill、Pi 暂走 §4 兼容兜底 |
| OPT-10 | 自动门禁完成：两端全量失败集合不超出同设备基线 | 人工 C01–C18、R26 / R27、A1–A4 与真实 Host 未执行，见文末“OPT-10 记录” |

## 交接须知（所有 ticket 通用）

### 总览

所有乐观操作走同一本**操作账本**（ADR-0049 §7）。OPT-00 建账本核心；之后每张 ticket 只给账本加一个种类（§7.5），
并删除该操作原有的计时、断线和跟踪代码。

| ticket | 内容 | ADR | 受影响 ID | 平台 | 依赖 | 规模 |
| --- | --- | --- | --- | --- | --- | --- |
| OPT-00 | 账本核心：阶段、不变量、种类策略，不接线 | §7.1–§7.4 | — | 两端 | 无 | 大 |
| OPT-H1 | Host：`session.archive` / `session.activate` 写设备私有回执 | §7.6 缺口 1 | — | Host | 无 | 小 |
| OPT-01 | 账本接线 + `quit`（首页关闭）迁移 | §7.4 L4、§7.5 | V11 | 两端 | OPT-00 | 中 |
| OPT-02 | `dismiss`：关闭通知 | §6.6 | V22（关联 V06） | 两端 | OPT-01 | 小 |
| OPT-03 | `archive`：归档 / 取消归档（含多选） | §6.4 | V22（关联 S15、V21） | 两端 | OPT-01；OPT-H1 可选 | 中 |
| OPT-04 | `queueCancel`：撤回排队消息 | §6.3 | V22（关联 V10） | 两端 | OPT-01 | 中 |
| OPT-05 | `respond`：回答审批 / 问卷 | §6.5 | V22、V07（关联 V06、V16–V17） | 两端 | OPT-01 | 中 |
| OPT-06 | `send` 迁移 + `waiting`（附件上传中发送） | §6.1–§6.2 | V10（关联 S09、V17） | 两端 | OPT-01；ADR-0055 outbox 合入 | 大 |
| OPT-07 | `config`：模型 / 思考级别 | §6.7 | V12、V10（关联 V05） | 两端 | OPT-06 | 大 |
| OPT-08 | `launch`：新建 / 恢复立即进入 | §6.8 | V12、V10（关联 M07、M14、V13、V17） | 两端 | OPT-06；OPT-H1 可选 | 大 |
| OPT-09 | prompt / skill Slash 作为 `send` | §6.1 | V10（关联 V09） | 协议、Host、两端 | OPT-06 | 大 |
| OPT-10 | 回归门禁与 ADR 收尾 | Verification | 全部 | 两端 | 全部 | 中 |

建议顺序：OPT-00 → OPT-01 → OPT-02 → OPT-03 → OPT-04 → OPT-05；OPT-H1 可与之并行。
OPT-06 起依赖 ADR-0055 在主工作区的 outbox 改动，合入后再做。

### 必读

1. [ADR-0049](../adr/0049-optimistic-send-and-source-reconciliation.md) §5–§7：本批决策原文，§7 是账本模型。ticket 与 ADR 冲突时以 ADR 为准，并在 ticket 中记录。
2. [ADR-0055](../adr/0055-agent-input-lifecycle-and-state-coverage.md)：准入、回执、未确认语义。乐观只改变显示时机，不改变准入。
3. [ADR-0032](../adr/0032-host-owned-agent-state-model.md)：版本化领域、设备私有回执 `DeviceView.operations`。
4. [ADR-0051](../adr/0051-ui-style-motion-and-visual-stability-freeze.md) §1、V07、V10–V12、V22：实施并验收前，现有行为按原规则保持。
5. [UI 回归方案](../testing/ui-regression.md) §1、§3.3、§4.2、§4.11（R26 / R27）、§5。
6. 根目录 `AGENTS.md` / `CLAUDE.md`（git 忽略，仅维护者 Mac）：共享模拟器池、构建租约、固定构建目录与证据保留。

### 与并行工作的关系

主工作区正在实施 ADR-0055（`runtime-command-lifecycle.ts`、两端 `PendingSends`、`OrbisStore.swift`、`RemoteState.kt`、`HostConnection.kt` 等，尚未提交）。它也在改 outbox：队列接管后保留隐藏恢复副本、去掉 pending 的 15 秒删除兜底。为降低冲突：

- 账本核心放在独立文件（iOS `OperationLedger.swift`、Android `OperationLedger.kt`），Store / Connection 只做接线。
- `send` 种类的迁移（OPT-06）等 ADR-0055 的 outbox 改动合入后再做，按它的语义迁移。
- 合并时以 ADR-0055 的回执实现为准调整接线。

### 完成定义（每个 ticket 都适用）

- [ ] 两端都实现；ADR 写明的平台差异除外。
- [ ] 两端同构：类型、转移、不变量和单测用例一一对应，名称尽量一致。
- [ ] 迁移的操作删除原有的计时、断线和跟踪代码，只保留种类定义与呈现。
- [ ] 设备 UI 用例断言结果在回执前呈现、拒绝后回到原位置（≤ 1pt/dp）、阅读锚点与视口不动；既有用例不放宽断言。
- [ ] 回归方案 §3.3 映射加入实际用例名。
- [ ] 单个 ticket 至少跑通 L1（单元）、L2（构建）和受影响类的定向设备用例；OPT-10 统一执行完整门禁。
- [ ] 本文件“实施状态”如实更新：已实现 / 测试通过 / 未运行 / 阻塞。

## OPT-00 账本核心

ADR-0049 §7.1–§7.4。纯逻辑，不接 UI、不做 IO。

- 类型：`Operation`（opId、kind、target、effect、basis、connection、sentRead、prerequisites、group、phase、deadline、detail）与种类策略（成功回执是否即落地；受理后期限及到期结果；结果不明规则：拒绝或保持未确认；是否有设备私有回执）。
- 输入：创建、写入通道、回执、断线、新连接、权威状态已应用（附带领域序号、是否完整、读取序号、连接代次；证据由调用方按种类判定）、设备私有回执、前置完成 / 失败、作用域失效、时钟。
- 输出：账本新状态与事件（落地、拒绝、转结果不明、失效、需要核对、可以写入通道）。
- 不变量 L1–L11 各有用例；另用固定种子的随机事件序列驱动账本，每步断言：
  1. 超过期限的操作不会停在 `sent` / `accepted`；
  2. 终态不回退；
  3. 删除全部操作后叠加结果等于权威状态；
  4. 没有操作被自动重发；
  5. 反向证据只来自因果晚于操作的来源；
  6. `waiting` 不越过同组的前一条。
- 文件：iOS `ios/Orbis/Orbis/OperationLedger.swift` + `ios/Orbis/Tests/OperationLedgerTests.swift`；Android `.../OperationLedger.kt` + `.../test/.../OperationLedgerTest.kt`。

## OPT-H1 Host：设备请求写入设备私有回执

ADR-0049 §7.6 缺口 1。

- `session.archive`、`session.activate` 受理时按 requestId 写 `DeviceView.operations` 的 accepted，结果（`session.archive.changed` / `session.activated` / `protocol.error`）写 settled。`runtimeId` 字段对 Host 级请求使用 Host 身份并在 schema 注释中说明，或扩展 schema 允许缺省。
- `command.result` 的 `ok: true, status: "pending"` 现在被记成设备回执 `success`（ADR-0049 §7.6 缺口 4），改为记 `pending`；
  `send` 迁移（OPT-06）前必须完成。
- 测试：`device-view-facts.test.ts`、`host-service.test.ts` 覆盖受理、成功、失败、pending、上限淘汰与设备隔离。

## OPT-01 账本接线 + `quit`

ADR-0049 §7.4 L4、§7.5 `quit`；V11 r27 修订。

- 接线：两端 `HostConnection` 持有账本；维护连接代次与读取序号；把命令回执、`device.ready`、`runtime.online` / `runtime.offline` 接成账本输入；新连接后读取设备作用域 `operations` 领域，供 L5 核对；统一计时。
- `quit`：叠加为隐藏首页卡片。断线时保持隐藏，新连接首个在线列表仍在线 → 恢复并提示“关闭会话未确认：会话仍在运行”；成功后 15 秒仍在线 → 恢复（原规则）。换电脑 / 取消配对失效。
- 删除 `closingRuntimes` 原有的计时与断线代码（iOS `closeFinished` 计时、Android `watchClosingRuntime`）。
- 测试：两端 Store / reducer 单测（断线保持隐藏、重连仍在线则恢复、重连已离线则删除、设备回执 success 后进入 15 秒规则、换电脑失效）；设备扩展 iOS `testSwipeCloseHidesBeforeConfirmationAndRestoresOnRejection`、Android `OptimisticActionsInstrumentedTest`。手动 R27 最后一项。

实施记录（2026-11-01）：
- 种类定义集中在 iOS `OperationKinds.swift`、Android `OperationKinds.kt`（Android 另含 reducer 与 `HostConnection` 共用的纯状态转换）。
  新增种类时在这里加 payload、策略、证据和提示，再在连接层把入口接到账本。
- 同一连接内的核对读取：设备作用域 `operations`；回复到达时连同增量在线列表核对（ADR-0049 §7.6 缺口 5）。
- 测试：iOS `QuitLedgerTests`（13）、Android `QuitLedgerTest`（12；Android 没有 `shutdown`，见 ADR-0049 §7.7），
  Android `PendingSendsTest` 关闭用例改为账本语义；`OptimisticActionsInstrumentedTest` 改为经账本隐藏 / 恢复。
- 设备定向：见 UI 回归方案 §3.3“已实施部分”。证据 `.artifacts/ui-regression/2026-11-01-optimistic-actions/opt-01/`。

## OPT-02 `dismiss`

ADR-0049 §6.6。

- 叠加为隐藏横幅；证据为 `removedNotificationIds` 或关闭后发起的通知读取的回复（两端现有的关闭后同步即是这次读取）。回复仍含该通知时重新显示，不另弹错误；断线保持隐藏。只影响本设备。
- 入口：iOS `Notifications.swift` `dismiss`；Android `HostConnection.dismissNotification`。
- 测试：两端单测；设备扩展 iOS `testQueueCancellationNotificationsAndRuntimeFacts` 通知部分、Android `NotificationsInstrumentedTest`。

## OPT-03 `archive`

ADR-0049 §6.4。

- 叠加为卡片移到目标列表（每张卡片一条操作）；落地为目录归档状态等于目标值或同 requestId 的 `session.archive.changed`；拒绝为同 requestId 的 `protocol.error`；结果不明为新连接首个完整目录仍为旧状态 → 恢复并提示。Android 30 秒超时与 `sessionArchiveRequests` 删除，改用账本期限。归档中的卡片禁用关闭 / 归档 / 恢复（L9）。
- 入口：iOS `HostConnection.archive(_:archived:)`、`SessionViews.swift`；Android `HostConnection.setSessionArchived`、`SessionDrawer.kt`。
- 测试：两端单测（立即移动、拒绝回原位、回执后目录仍旧状态、断线保持、批量逐张核对、冲突禁用）；设备扩展 iOS `testDrawerLongPressArchivesAndRestoresOnlyCheckedSessions`、Android `SessionArchiveSelectionInstrumentedTest`，按 V21 断言视口。

## OPT-04 `queueCancel`

ADR-0049 §6.3。

- 叠加为隐藏队列项；`already_delivered` 不放回，就近提示“撤回未完成：消息已交给 Agent”；其他失败回原位；结果不明时队列项仍在 → 恢复并标“撤回未确认”，核对前不能再撤回。
- 入口：iOS `pendingQueueCancellations` / `queueCommands` 与队列面板；Android `HostConnection.cancelQueuedMessage`。
- 测试：两端单测四种结局与重连核对；设备扩展 iOS `testQueueCancellationNotificationsAndRuntimeFacts`、Android `OptimisticActionsInstrumentedTest`。

## OPT-05 `respond`

ADR-0049 §6.5，V07。

- 叠加为面板收起、原位短状态摘要（自由文本与敏感输入只显示“已提交”）；落地为回执成功或交互快照中请求已不存在；拒绝且请求仍有效 → 面板回原位并保留答案；结果不明 → 以交互快照恢复面板或显示“已处理”。
- 入口：iOS `HostConnection.respond`、`submittingInteractions`、`InteractionView.swift`；Android `HostConnection.respond`、交互工作区与 `QuestionnaireDialog.kt`。
- 测试：两端单测；设备改写 iOS `testApprovalOverlayKeepsComposerStableWhileSubmitting`（保留 composer 不位移的断言）、Android `InteractionWorkspaceInstrumentedTest` / `QuestionnaireInstrumentedTest`。

## OPT-06 `send` 迁移 + `waiting`

ADR-0049 §6.1–§6.2，V10。等 ADR-0055 的 outbox 改动合入后开始。

- 把 `PendingSendOutbox` / `PendingSends.kt` 迁为 `send` 种类，沿用 ADR-0055 的隐藏恢复副本与静态“已排队 / 未确认”呈现。
- 新增 `waiting`：附件未传完时点发送，立即创建气泡（附件缩略图、文件名与进度）并清空输入，上传完成后写入通道；同会话按创建顺序提交；上传失败 / 取消只影响本条；写入通道前按 V17 保存草稿副本。
- 测试：两端账本与 Store 单测；设备扩展 iOS `testOptimisticSendReconcilesAndRejectedSendRestores`、Android `OptimisticActionsInstrumentedTest`。手动 R27 附件项。

## OPT-07 `config`

ADR-0049 §6.7，V12、V10。

- 叠加为选择器与顶栏显示所选值加“切换中”；落地为 model 域确认值；确认前发出的消息依赖它（`waiting`）；失败回到确认值，依赖它的消息一起拒绝（操作“按当前配置发送 / 放回输入框 / 删除”）；连续选择只提交最新一次；顶栏槽位按 V05。
- 测试：两端单测；设备扩展顶栏几何断言与新增切换用例（iOS `testRefreshKeepsHeaderTextAndTruncationStable` 等、Android `ComposerSessionInfoInstrumentedTest` / `ChatStatusLayoutInstrumentedTest`）。手动 R27 模型项。

## OPT-08 `launch`

ADR-0049 §6.8，V12、V10。

- 叠加为立即进入聊天页并显示“启动中”（恢复时先显示缓存历史）；草稿先归属启动请求，Session ID 确认后迁移；启动中发出的消息依赖它；失败在聊天页原位显示原因与“重试 / 返回”；返回首页不取消启动。新建面板仍为 Sheet（ADR-0054）。
- 入口：iOS `activate` / `createSession` / `activateTarget`、`OrbisPageStack`；Android `activateSession` / `createSession` / `activateTarget`、`OrbisPageHost`。
- 测试：两端单测；设备新增启动中进入与失败用例，保留 R20–R22 导航断言。手动 R27 启动项。

## OPT-09 prompt / skill Slash

ADR-0049 §6.1，V10。

- 协议 `slash.execute` 增加可选 `messageId`；`source` 为 `prompt` / `skill` 的命令执行时携带，按 `send` 种类显示本地气泡。各后端为产生的用户消息声明 `clientMessageId`，暂不能声明时走兼容兜底。准入按 ADR-0055 §5。
- 测试：协议 schema 与 ADR-0055 AIN-01 集合对照；各后端声明单测；两端账本单测；设备扩展乐观发送用例。手动 R27 Slash 项。

## OPT-10 回归门禁与 ADR 收尾

- 两端 L1–L4 全量、C01–C18、R26 / R27、V07、V10–V12、V22 专项与 A1–A4，按回归方案 §1、§6 执行并存档到 `.artifacts/ui-regression/<日期>-optimistic-actions/`；失败集合与同设备、同配置基线比较。
- ADR-0051：验收通过的条目去掉“r27 待实施”，更新 §2 已交付计数与修订记录；ADR-0049 状态行更新；回归方案 §3.3 写入实际用例名；同步两份本机指南。
- 未运行、阻塞与真实环境未验收的范围如实记录。

### OPT-10 记录（2026-11-01）

- 已完成：两端单元与构建；两端设备全量（iOS 67 项、Android 151 项），失败与 main `e4df87a` 同设备重跑对照，均不超出基线；
  新增 iOS 4 项、Android 5 项设备用例；Android A2–A4（夜间、字体 1.5、关闭动画）专项通过；截图审阅修正 iOS 启动页标题（占位 id）；ADR-0049 实施记录、ADR-0051 r31、回归方案 §3.3 / §4.11 / §6、`docs/README.md`。
- 修正的旧用例（不放宽）：iOS 审批与交互草稿的预览夹具（`interactions` 领域）；Android
  `SessionArchiveSelectionInstrumentedTest#busyPendingAndDisconnectedSelectionsCannotBeArchived` 改为在已归档列表断言冲突入口禁用。
- 未完成：C01–C18、R26 / R27 人工逐项、A1–A4，真实 Host 上的断线 / 回执核对（本机隔离 Host 只有 Windows 脚本）；
  Android 恢复会话启动页的缓存历史（ADR-0049 §7.7）。不记为验收通过。
- 合并：两份本机指南（`CLAUDE.md` / `AGENTS.md`）的基线版本在合入 main 时同步为 r31。
