# 统一交互动效验证记录

日期：2026-11-01。工作树 `codex/interaction-motion`；基线 `8e259bb`；先行设计提交 `0fcb8f3`。决策见 [ADR-0058](../adr/0058-shared-interaction-motion.md)，执行项见 [MOT ticket](../agents/interaction-motion-tickets.md)。

## 当前结论

共用组件和32组业务入口已接入，尚未完成验收。Android最终全量154项4失败、iOS全量69项8失败均未超出同设备同配置基线；但iOS最近提问的阅读锚点、工具展开和其他受影响基线失败仍存在，不能关单。专项通过不替代完整手动 C01–C18 / R33–R40 / A1–A4；首次失败、修复及复测证据全部保留。

证据根：`.artifacts/ui-regression/20261101-interaction-motion/`。共享池只使用登记的 iPhone 17、iPhone SE 3、iPad Air 11-inch (M4) 和 API 35 AVD；每次运行独占设备并在退出后释放，构建复用工作树固定目录与 build lease。iOS 17 兼容设备、真实 Host、真机触觉及完整 VoiceOver/TalkBack 未验收。

## 入口覆盖审计

“接入”只表示调用了共用实现，不表示该场景的所有外观与帧门禁已通过。系统/原生边界按 ADR 保留。

| 场景 | 接入与审计结果 | 重点验证 |
| --- | --- | --- |
| SC01–02 | 首页单卡关闭、批量关闭保留不可操作退场副本；选择触点与顶栏合拢 | 完全离屏后收拢、拒绝恢复、红灰状态、一次提交 |
| SC03 | 目录在线/离线/搜索/归档卡接 SelectionFill/Toolbar；搜索和关闭退出选择 | 原行几何、搜索后旧操作不可达 |
| SC04 | 下载卡长按、逐项选择、删除确认接同一选择层 | 传输状态和原生分享不被吞掉 |
| SC05 | 遗留供应商页接同一组件，只作现有页面/夹具覆盖 | 不恢复已移除入口 |
| SC06 | 首页电脑单层菜单接锚点面板 | 当前电脑、红点、切换隔离 |
| SC07 | 目录电脑菜单根/二级清单接同一菜单栈 | 形状先变、内容后翻、逐层返回 |
| SC08 | 目录 Agent/provider 筛选接菜单栈 | Android 原条件分支二级页已迁入共用栈；重入/搜索/归档保持 |
| SC09 | 历史/分支筛选接锚点面板 | 历史页状态和滚动保留 |
| SC10 | 设置供应商切换接锚点面板及图标反馈 | 仍等待真实供应商确认；可点击性 |
| SC11–12 | 当前、历史预览、离线用户气泡共用上方长按栏 | 原生文字选区、复制全文、Rewind确认与可用性 |
| SC13 | 本地 pending 气泡共用复制；恢复/重试/队列状态仍在原区域 | 不产生不存在的 Rewind；不把排队当已发送 |
| SC14–16 | 接受的发送通过准确 outbox id 启动飞行；文本/附件/运行中/重试沿用同一提交入口 | 未准入不飞、非跟随兜底、控制类Slash不伪造用户行 |
| SC17 | 最近提问保留离场快照并从右上出入 | 现有源身份、通知优先及阅读锚点断言不放宽 |
| SC18 | 回到最新按钮接图标反馈，原显隐与跟随语义不变 | 点击才恢复跟随 |
| SC19–21 | 下载/设置/历史/刷新/返回/搜索/删除等共用按钮接r43统一轻压 | 只动画图形；稳定命中槽；禁用无反馈 |
| SC22 | 发送/停止/附件/权限与交互工作区接共享反馈 | 原准入、触觉、审批语义保持 |
| SC23 | 消息/代码/路径/全文/工具复制保留 M05；重复激活反馈 | 2.5秒复位和重置计时 |
| SC24 | 新建/文件夹/分支/远程文件浏览中的行图标接父动作激活 | 不给静态状态图标播放假反馈 |
| SC25 | 文件差异与工具展开保留已有旋转，其他动作接共享反馈 | 不叠加两次旋转；文件Pager优先 |
| SC26 | 通知/错误/问卷/配对动作接共享按钮；手动配对折叠入口补接 | 安全配对与系统模态优先 |
| SC27 | 配额币保留专用翻面 | 不叠加通用缩放 |
| SC28–30 | Android整页接系统左右边缘进度；iOS保留原右滑返回，新增双侧增强暂不交付 | 真实来源、取消恢复、一次返回；IME/选择/菜单先处理 |
| SC31–32 | Sheet/Dialog/系统选择器保留原生手势；内部图标使用共享按钮 | 根首页不退出；不为差异正文新增横滑/下拉退出 |

## 已落地自动用例

| 家族 | Android | iOS |
| --- | --- | --- |
| 纯几何 | `InteractionMotionTest` 两项：边角覆盖、先右后上/左侧目标/端点 | `MotionGeometryTests` 两项，对应断言 |
| 关闭 | 原 `HomeSwipeCloseInstrumentedTest`、`OptimisticActionsInstrumentedTest` 保留并验证恢复 | 原首页关闭与拒绝恢复用例保留 |
| 选择 | `InteractionMotionInstrumentedTest.selectionStartsAtTheTouchAndReversesWithoutMovingTheCard`；原首页/目录/下载多选 | 原首页/目录/下载多选；`testDrawerSelectionClearsOnCancelSearchAndClose` |
| 菜单 | `menuChangesItsContainerBeforeSlidingToTheChildAndBack`；`SessionProviderFilterInstrumentedTest` | `testComputerSubmenuReturnsWithinOneAnchoredPanel`；设置供应商原用例 |
| 消息操作 | `nativeTextLongPressOpensTheSameMessageActionsAboveTheBubble`；乐观操作原业务断言 | `testUserMessageCopyAndRewind`、`testOptimisticSendReconcilesAndRejectedSendRestores` |
| 发送 | `sendFlightUsesTheAcceptedIdentityAndNeverLandsQueuedOrReadingMessages`：准确目标、去重复、最多3、非跟随/队列兜底、离页清理 | `testSendFlightMovesRightThenUpAndHandsOffTheSameMessage`：注入0.25/0.65/1阶段；`testSendFlightWithReducedMotionKeepsTheMessageAndNoOverlay` |
| 最近提问 | `reminderEntersFromUpperRightAndRetainsItsContentDuringReverseExit`；原4项 reminder | 原2项 question reminder 保留；方向帧需人工审阅 |
| 图标 | `iconActivationChangesTheGlyphWithoutChangingItsHitTarget` | 原复制/下载/配额/按钮用例；细粒度图形帧仍需审阅 |
| 边缘返回 | `predictiveBackOnBothEdgesCancelsOrCommitsOnlyOnePage`；原 SwipeBack/Pages/History | `testOptionalEdgeBackKeepsExistingIOSNavigation`验证右侧向内不新触发返回、原右滑取消/完成；原嵌套/添加电脑/下载返回 |
| 减少动画 | `InteractionReducedMotionInstrumentedTest` 使用实际系统三项动画缩放并在finally恢复；不按假设跳过 | 新发送 reduced 用例；原右滑返回正常/减少动画两路径；既有减少动画用例 |

Android 中间帧使用 Compose 可控时钟和 `captureToImage` 等待绘制，每个 Popup 根分别保存。不能用未同步的系统截图替代中帧证据。iOS 发送通过 Debug 启动参数注入固定进度，仅测试构建显示不可见的几何探针，Release 无测试入口。起点/终点、重复/失效和业务结果仍走生产组件。

## 执行记录

构建序号仅为本任务日志轮次，不是 App 发布版本。Android最终代码为build-13；iOS最终代码为build-17。iOS build-16的滚动锚点试验未改善失败，已撤回，build-17恢复原滚动定位行为；测试断言未放宽。

| 轮次 | 结果 | 证据 |
| --- | --- | --- |
| 改动前 Android | JVM/构建通过；146设备用例，5失败；7项既有外部夹具 assumption，不能算通过 | `baseline-android-build.log`、`baseline-android-ui-4.log` |
| 改动前 iOS | 236核心用例1失败；65 UI用例8失败 | `baseline-ios-build.log`、`baseline-ios-ui.xcresult` |
| Android最终构建 | 572项JVM通过，Debug App / AndroidTest构建通过 | `motion-android-build-13.log` |
| Android最终全量 | 154项，4失败，7项既有外部夹具 assumption；失败属于基线名单 | `android-full-6.log` |
| Android定向 | 14/14；动效中帧8/8 | `android-targeted-4.log`、`android-motion-frames-1.log` |
| Android深色+字体1.5 | 20/20，最终代码；组件夹具可能自带白色底板，不作为整页深色证明 | `android-dark-large-2.log` |
| Android实际减少动画 | 19/19，系统三项动画缩放为0，最终代码，结束恢复原设置 | `android-reduced-3.log` |
| Swift当前 | 238核心用例，1项与基线相同的文件传输帧头失败 | `motion-swift-tests-2.log` |
| iOS最终构建 | Simulator App / UI Test构建通过；源码、plist、scheme和包依赖单独检查通过 | `motion-ios-build-17.log`、`final-source-checks.log` |
| iOS全量 | build-15：69项8失败，与基线名单相同；最终新增图标接入另做对应页面复测 | `ios-full-2.xcresult` |
| iOS发送/菜单/消息操作 | build-15：4/4，准确路径、语义去重、复制/Rewind、拒绝恢复、二级菜单 | `ios-targeted-9.xcresult` |
| iOS滚动试验 | build-16：8项3失败；两个reminder仍偏移30/60pt，工具展开仍不可触达；撤回该试验 | `ios-targeted-10.xcresult` |
| iOS最终小屏大字 | SE3、375pt、系统Accessibility XXXL，10/10；含原返回正常/减少动画路径 | `ios-final-se-2.xcresult`、同名mp4 |
| iOS最终iPad | 菜单/发送/复制Rewind/下载/设置/供应商切换6/6 | `ios-final-ipad.xcresult` |

Android最终4失败：

- `CodexPermissionsInstrumentedTest.freeTextQuestionCanBeAnsweredWithoutSelectingADummyOption`
- `DshInstrumentedTest.selectsDeepSeekAndCreatesSessionInChosenDirectory`
- `QuestionnaireInstrumentedTest.editingAndRestoringTheFormPreservesDraftsUntilOneExplicitSubmission`
- `SessionHostOwnershipInstrumentedTest.missingAndStaleHostnamesStayTogetherAndCreationRequiresPairedConnection`

基线额外的 `ChatEntryInstrumentedTest.cachedLongConversationEntryAndReentry` 在最终全量通过。7项 assumption 需要 Claude历史、同步、真实历史、Windows夹具及工具捕获参数，未配置外部夹具，保持原有跳过事实。早期 `android-reduced-1b` 21项1失败：旧 `SwipeBackPages` 用例要求看到动画中帧，与系统动画关闭不兼容；用例未删除、未放宽，正常全量仍运行，新减少动画用例另外验证直接切换及一次返回。该失败记录保留。

iOS全量8失败与改动前一致：

- `testAddComputerPageReboundsAndSwipesBack`：短拖路径点中扫码入口，进入扫描Sheet后未回首页。
- `testApprovalOverlayKeepsComposerStableWhileSubmitting`：审批提交时composer位置断言。
- `testDrawerCollapseShrinksContentWithoutAnotherDrag`：目录折叠立即收缩断言。
- `testLongTranscriptAppearsAndToolExpansionKeepsItsPositionWithoutDragging`：展开工具后标题移到顶栏下，不可触达。
- `testPageScreenshotsInBothAppearances`：页面图库中断，不能据此宣称全部页面双外观通过。
- `testQuestionReminderAppearsWhileReadingAndLocatesTheOriginalWithoutFollowing`：刷新后阅读锚点30pt偏移。
- `testQuestionReminderTracksNewSourceQuestionsWithoutMovingTheReader`：源问题更新后阅读锚点60pt偏移。
- `testToolExportAndInteractionDraftSwitching`：工具导出后的交互工作区切换断言。

Swift失败为 `FileTransferTests.binaryHeaderMatchesNodeAndRejectsMalformedFrames`（line17）。`check-ios.sh`在该既有失败停止；后续源码/配置/包检查单独执行并记录，不能把整个脚本记为通过。本任务未修改传输协议。

iOS早期全量 `ios-full-1` 的新增失败定位后已修复：消息修饰器只作用于用户行、菜单测量不抢焦点、菜单滚动从顶部、装饰飞行Canvas无重复可访问性文本、长按栏留出原生选区菜单空间。`ios-final-se` 在会话中断时停止，仅保留部分结果；确认进程退出、设备Shutdown和owner后释放本任务锁，以 `ios-final-se-2` 重新运行。

## 画面审阅与证据有效性

- 亲自审阅 iOS `ios-full-1` 全部113张、`ios-targeted-9` 13张及 `ios-full-2` 全部128张附件。最终全量的16张联系表及逐图索引为 `ios-full-2-review-*`。确认菜单完整、消息栏与系统选区菜单错开、发送先右后上且真实消息只保留一个语义节点；工具展开和配对手势问题仍保留。
- 亲自审阅 Android `android-full-5` 本轮新生成179张PNG、最终 `android-full-6` 中28张动效相关图、最终深色大字41张图。联系表与索引为 `android-fresh5-review-*`、`android-full-6-review-*`、`android-dark-large-2-review-*`。选择触点扩散、菜单尺寸与二级侧入、消息选区操作组合、提示方向、页面缩小及来源露出已有受控中帧证据。
- Android每轮pull包含设备原有截图。通过运行前后mtime/size清单筛选本轮更新文件，旧图库截图不计入本轮；Popup根截图可能只含锚点，以同步的display截图核对浮层。旧文件中两张损坏的home-loading debug PNG未作有效证据。
- 最终SE全部23张和iPad全部17张附件已审阅，宽/窄屏消息栏均可操作。SE最终录屏 `ios-final-se-2.mp4` 按60fps抽取首页关闭、选择和目录菜单片段，并审阅联系表的85个抽样帧：短拖回弹，红灰过渡后左向离屏再收拢；首选/后续选择触点扩散，线段转叉，双图标合拢；菜单从按钮展开且二级进退方向相反。60fps抽帧是采样频率，不是性能达标声明，完整未抽样帧仍保留。
- 自动测试与受控帧不能证明全部真实手势流畅、60fps或触觉体感。全部C/R逐场景状态和缺口见证据根 `manual-checklist.md`；未检查的矩阵保持未运行。

## 未验收范围

完整 C01–C18、A1–A4、R33–R40 的逐场景人工帧审阅仍未完成。iOS最近提问、工具展开、审批与目录等受影响既有失败仍阻塞对应验收；不能只因失败集合等于基线就豁免。Android真实系统边缘指示器与IME/弹层组合仍需真实手势检查（当前中帧用dispatcher注入进度）。iOS17兼容设备缺口、真实隔离Host、真机触觉、VoiceOver/TalkBack全流程另外保留。iOS新增双侧边缘增强按用户补充暂不交付，原返回保留。

## 2026-11-01 合并主线核对

在隔离工作树将动效提交 `1d7795e` 与主线 `e4df87a` 合并。主线原生文件审阅与 DeepSeek / Codex Desktop 按需启动行为保留；代码自动合并，人工复核交叠的页面 / UI 用例。为避免编号冲突，动效改登记 r31 / R33–R40，旧证据 r30 / R32–R39 按此对应；主线启动仍为 r30 / R32。合并后 iOS UI 用例共 71 项，既有 69 项运行记录不改写。

集成检查：Swift 239 项通过；Android 573 项 JVM 测试、App / AndroidTest 构建通过；iOS App / UITest 构建通过；76 项 feature、32 场景、10 张 MOT ticket 与引用检查通过。Android 首次以不可执行的 wrapper 启动、第二次用 JDK 25 均未运行测试；改以 `sh gradlew` 和已安装 JDK 21 后通过，首轮日志保留。证据见 `.artifacts/merge-back/20261101-main/`。本次没有重跑设备全量 / 人工验收，原失败与 MOT-10 未完成状态保留。

## 2026-11-02 — r35 交互细化

工作树 `codex/interaction-motion-refinement`，基点 `8ab14b6`；先行设计提交 `f415a2c`。本轮覆盖用户的 11 项补充，对应 SC33–SC43 / MOT-11–21 / R45–R55，feature 总数 79，已交付计数仍为 67。代码接入与设备验收分开记录；完整手动门禁尚未完成。

证据根 `.artifacts/ui-regression/20261102-motion-refinement/`；同基点核对位于独立 `interaction-motion-r32-baseline/orbis` 工作树的同名证据目录。只复用共享池 API 35、iPhone SE 3、iPhone 17；每轮均取得设备锁和固定构建目录租约，结束恢复设备设置。池内 iPad 初期被其他任务占用，释放后补跑本轮宽屏专项；不能将旧轮 iPad 结果计作本轮验收。

### 场景、代码与自动验证映射

| 专项 | 接入与验证入口 | 证据和边界 |
| --- | --- | --- |
| R45 / SC33 | Android `SwipeBackLayer` / `InteractionMotion.edgeShift`；`InteractionMotionTest`、`predictiveBackOnBothEdgesCancelsOrCommitsOnlyOnePage` | 缩小至 0.92、双侧至少 8dp 缝隙、真实底页遮罩、右向离屏中帧与单次返回已验证；系统箭头与 IME / 弹层组合仍待真实手势检查。iOS 保留原右滑，不交付新增双边缘手势 |
| R46 / SC34 | 双端 `MotionText`；连接 / 会话状态、卡片标题、筛选与选择计数；Android `discreteLabelsKeepOnlyTheLiveAccessibilityValueDuringTheirFade`；Qt `MotionTextTest` | 160ms 淡变与首次出现；Android 只暴露当前文本及其布局语义。输入中 / 流式正文 / 秒表保留专用行为，不套离散文本动画 |
| R47 / SC35 | 双端共用按下 / 松开驱动；Android `physicalPressShowsFeedbackBeforeDispatchAndCancellationDoesNotClick` | r35旧规则为短按补峰值，r43改为松手立即复位；业务请求立即发出。旧组件中帧通过，不据此宣称所有快速嵌套导航来源的完整周期均已人工验收 |
| R48 / SC36 | Android `collectionMotion`、iOS `SessionDrawerView` 筛选事务；既有 provider filter / directory viewport 用例 | Android 稳定 key 的增删 / 位移动效同时覆盖目录更新，保留原视口补偿；iOS 保留列表与分组身份，仅搜索变化更新叶子 hit bounds；SE 目录更新专项复测通过，折叠 / 搜索选择既有失败仍保留 |
| R49 / SC37 | `OrbisPressedGlyph` / `rememberGlyphProgress` 的旋转角色 | r35旧目标为整圈往返与轻震，r43已由统一80ms轻压 / 160ms即时复位替代；删除附加轻震，旧证据保留；新版双端设备门禁待验证 |
| R50 / SC38 | 首页 / 目录 / 下载 / 遗留供应商选择入口 | 每次选中 / 取消一次触觉；Android `HomeSelectionInstrumentedTest` 改为新需求的逐项次数断言，保留仅关闭所选等业务断言；无变化的重复长按不叠加 |
| R51 / SC39 | Host `Motion.js` / `MotionText.qml` / 稳定侧栏槽 | 数字 220ms 上下滚动、凹凸表面交叉过渡；Qt 5 项测试、macOS 普通 / 减少动画实际窗口 smoke 与中帧通过；Windows 未构建 / 未运行 |
| R52 / SC40 | 双端按 requestId 的新建卡片与导航交接 | Android `newSessionCardRisesBeforeHandingOffExactlyOnce`；iOS 新建失败 / 重试和启动中输入用例；iOS 实际录屏确认底部追加后进聊天。换电脑 / 打开其他页面取消跟随，不撤销已受理请求 |
| R53 / SC41 | Android 页级 `MessageActionState`，iOS `OrbisMessageActionScope` | 原顶栏固定槽替换为复制 / Rewind；隐藏组不可点击与不可访问；保留原生选区、pending 状态及 Rewind 确认。发送落地长按回归已修复并在 iPad、SE 复测通过，见下方 |
| R54 / SC42 | 双端 `ChatQuestionReminder` 和真实用户滚动方向 | 单行省略；距底部超过三行且最后操作朝历史方向，沿用源问题不可见等原条件；Android 新增向最新反向滚动隐藏用例通过；iOS 既有提醒锚点失败未放宽 |
| R55 / SC43 | 双端 `homeCardIsCurrent` | 后台同步不禁用仍有当前身份的有效卡；保持加密连接与 runtime / session / Agent 匹配。Android 单元和实际点击、iOS 核心和实际点击进聊天通过 |

### 执行结果

| 检查 | 实际结果 | 证据文件 |
| --- | --- | --- |
| Android L1 / L2 | 669 JVM 用例通过；App / AndroidTest 构建通过 | `android-build*.log`；最终包 `motion-packages/manifest-build11.json` |
| Swift L1 | 335 项通过 | `swift-tests-final.log` |
| iOS L2 | build11 通过，临时诊断代码已移除；App-local 运行库依赖检查通过 | `ios-build11.log`；包 `motion-packages/Orbis-simulator-debug-build11.zip` |
| Host Qt | 5/5 通过，最终 macOS 普通 / 减少动画 smoke 均 exit 0 | `host-final-checks.log`、`host-final-checks2.log`、`host-motion5*`、`host-motion-reduced3*` |
| Node | 类型检查通过；完整测试 1649 通过、2 失败、5 skip；两个 launcher 失败在同基点复现 | `host-baseline-launcher.log` 及本轮 Node 日志 |
| Android 全量 | 168 项：156 通过、5 失败、7 外部夹具 assumption | `android-full-2.log` |
| Android 同基点核对 | 14 项中相同 5 项失败 | 基线 `baseline-android-failures2.log` |
| Android A2 + A3 | 深色、font_scale=1.5，28 项中 1 项视口失败，同设备同配置基线也失败 | `android-dark-large2.log`；基线 `baseline-android-dark.log` |
| Android A4 | 实际三项系统动画缩放为 0，19/19；运行后恢复设置 | `android-reduced.log` |
| Android 最终专项 | build11：动效 / 首页加载点击 / 选择 / 状态布局 / 目录视口 18/18 | `android-final-header-home.log` |
| iOS SE 全量 | build8：79 项中 8 项失败，71 项通过；保留失败附件 | `ios-full-se-1.xcresult` |
| iOS 同基点核对 | 同 SE 的 8 项中 6 项失败；目录更新和发送落地长按通过 | 基线 `baseline-se-failures2.xcresult` |
| iOS 静态消息 / 同步点击 | 复制→退出→再次长按→Rewind，以及同步时实际点击打开聊天，2/2 | `message-se-4.xcresult` |
| iOS 目录更新复测 | 同 SE，目录更新保持锚点通过；发送落地长按仍失败 | `message-debug-se.xcresult` |
| iOS 较大屏长按 | iPhone 17，发送落地长按及拒绝恢复 1/1 | `message-debug-iphone.xcresult` |
| iOS iPad 宽屏 | 首轮 5 项 4 通过 / 1 长按失败；修复后长按 / 再次长按 / 两项阅读锚点 4/4 | `ipad-targeted-1.xcresult`、`ipad-final-1.xcresult` |
| iOS 最终 SE 专项 | build11：13/13；消息两种长按、同步点击、目录更新 / 归档、首页 / 下载多选、菜单、新建 / 启动中输入、原返回及明暗 / XXXL / 减少动画矩阵 | `se-final-1.xcresult`；45 张附件及 `se-final-1-review-01`–`06` |

Android 5 项全量失败为：`ChatEntryInstrumentedTest.cachedLongConversationEntryAndReentry` 的 500ms 预算、`CodexPermissionsInstrumentedTest` 自由输入 RequestFocus、`DshInstrumentedTest` 创建按钮未显示、`QuestionnaireInstrumentedTest` RequestFocus、`SessionHostOwnershipInstrumentedTest` 电脑切换断言。深色大字额外失败为 `SessionDrawerViewportInstrumentedTest.sessionsWithinTheExpandedDirectoryRetainTheirReadingAnchor`，未找到“再显示 11 个会话”。均以本次同基点同设备复现记录为依据，不能用历史名单替代实跑。

iOS SE 同基点复现的 6 项为：添加电脑返回、目录折叠、搜索后清除选择、长对话工具展开、两项最近提问提醒。原阅读锚点和可触达性断言保持；仍影响对应 feature 验收。目录更新第一次超时后专项通过。发送落地长按是本轮新增回归，不能列为基线失败。iPad 日志复现：被动窗口观察器收到 down 后，原生选区 / 键盘切换使其未执行回调。保留行内 simultaneous long press，并由不拦截手势的窗口观察器补足已选中文字上的再次长按；同消息选择去重，避免双触觉。build11 在 iPad 复测两条长按和两条阅读稳定用例通过，SE 发送落地长按也通过；首轮失败证据保留。

早期 Android `android-full-1` 的文本布局语义失败已通过共用 MotionText 转发 GetTextLayoutResult 修复；haptic 次数按新需求更新。ADB 37 在 instrumentation 启动前崩溃，换已有 ADB 36 后运行；`android-dark-large` 曾传入不存在的类而产生初始化失败，正确类名的第二轮另存。Node launcher 两项失败分别为 10 秒超时、PATH 已安装 CLI 使“缺少 CLI”预期退出码不同。首轮错误、复测和基线都保留。

### 画面证据和未完成门禁

已审阅 iOS 最终 SE 专项 45 张 PNG，以及全量 173 张 PNG（`ios-image-index.json`、`ios-review-00`–`10`），以及 Android 全量本轮更新图片中的 133 张（`android-review-index.json`、`android-review-00`–`08`，不重复计算未改配额翻面帧）。Android 按截图运行前后 mtime / size 清单排除设备旧文件；组件根画面与 display 图联合判断，系统剪贴板预览不是 App 新浮层。

Android 动效证据包含双侧边缘压缩 / 右向退出、选中触点扩散、一级形变后子菜单进入、顶栏消息动作、离散文字中帧、新建卡片中帧与快速按压。iOS `targeted-ios-1.mp4` 的 113.5s 首页三卡、113.75s 末尾新卡、115s 聊天页面，抽帧 `new-card-sequence/` 与 `new-card-middle/`。Host `host-motion5*` / `host-motion-reduced3*` 记录数字中帧、侧栏切页与减少动画终态。iPad 首轮及修复后 19 张 PNG 已审阅（`ipad-targeted-1-contact.jpg`、`ipad-final-1-contact.jpg`）：消息页顶操作与原生选区共存，宽屏菜单和启动失败状态可见。这些证据不等于全入口流畅度或完整 C / R / A 通过。

MOT-11–21 保持“已接入，验证中”。完整 C01–C18、R45–R55 的四外观逐入口人工检查、快速导航来源完整按压周期、iOS 17、iPad A5 全入口、Windows Host、真实隔离 Host、真机触觉 / 系统音效 / VoiceOver / TalkBack 尚未验收。不得删除或放宽现有失败用例，也不得把排队、仅构建或单个专项通过记作完整验收。

L0 编号与引用：79 个 feature、43 组场景、21 张 MOT ticket、158 个相对路径 / 锚点检查通过，本机 AGENTS / CLAUDE 一致。源码检查、最终包 / 同基点回退包哈希、源文件清单与手动未验收项分别保存在证据根的 `source-checks-final.json`、`motion-packages/delivery-manifest.json`、`source-manifest.json`、`manual-checklist.md`。本任务设备 / 构建租约已释放；未合并或推送本轮 r35。

2026-11-02 合并编号映射：主线已使用 r33（iOS 下拉回弹）、r34（雾蓝外观）和 R41–R44，本专题分支原 r33 / R41–R51 合并后登记为 r35 / R45–R55。既有 `.artifacts/ui-regression/20261102-motion-refinement/` 证据中的原编号保持不改，按此映射查证；feature / SC / MOT 编号不变，未验收状态不变。

### 2026-11-02 合并校验

主线 `d3627ab` 已纳入动效分支；合并代码及 r35 编号以 `fbfd3ad` 校验。Android 669 项 JVM、Debug / AndroidTest 构建、Swift 335 项、iOS build-for-testing 与包内依赖检查通过；Host 类型检查及 `agent-backend` / `host-service` 67 项通过。L0 的 79 个 feature、43 个场景、21 张 ticket 与 169 个相对链接检查通过；主工作区另有未提交 S25 外观，叠加后为 80 个 feature，相关修改继续保持未提交。合并准备、保留补丁及校验日志见 `.artifacts/merge-back/20261102-motion-r35/`。

此次只追加集成编译、单元与文档检查，未重跑设备全量或人工 C / R / A；原验证记录、失败及未验收状态保持。r35 / R45–R55 的重编号不改写旧证据，不将其他任务的未提交修改纳入动效提交。

## 2026-11-03 — r36 发送原位展开

用户要求输入消息从下方滑入后，以同一气泡展开成完整消息，滑动起步快、后段慢且稳定。M17 / MOT-06 / SC14–SC16 / R37 已接入两端共用实现：70ms右移、210ms上移、160ms右下角锚定展开，各段使用单次cubic ease-out。飞行层保留真实正文、附件和材质，受理时即抑制目标重复绘制，完成后一次交接。保留未跟随、队列、目标不可见的兜底；取消飞行不注销仍挂载行的落点。

证据根 `.artifacts/ui-regression/20261103-send-unfold/`。基线为任务开始时快照，8个当时干净的发送相关源码 / 测试恢复至 `f24de19`；保留已有R57等改动。共享工作区随后有配额、输入和Host并行修改，因此后续整包不是只改变发送动效的受控对照；最新iOS专项改用 `verification/` 冻结快照。具体源文件与产物以清单为准，不能把这些结果外推到之后的工作区。

### 已完成检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Swift / Android L1 | 347 / 673项通过；新增端点、逐段单调减速、展开锚点和长文完整高度断言 | `logs/candidate-swift-022537.log`、`logs/final-android-build-022910.log` |
| 双端L2 | App / 测试包构建通过；iOS源码、plist、scheme与包依赖检查通过 | `packages/final/`、`packages/verified/ios/`、`logs/verified-ios-targeted-video-030211.log` |
| Android同设备全量 | 基线170项：159过、4失败、7外部夹具assumption；候选171项：160过、相同4失败、相同7assumption | `android-final-comparison.json`；对应 `android-retry-*` 原始结果 |
| Android A2 / A3发送专项 | 深色、字体1.5各2 / 2；身份 / 队列 / 阅读兜底、取消后再次发送、正文和附件块绘制末帧一致 | `android-retry-20261102T183433Z/`、`android-dark-unfold-review.jpg`、`android-large-unfold-review.jpg` |
| iOS最终发送专项 | SE3 / 375pt / iOS27，4 / 4；正常时钟与固定阶段、长消息A1–A3、减少动画A4、上传中发送与提交 | `verified-ios-targeted-video-030028.xcresult`、`verified-ios-targeted-summary.json` |
| iOS基线全量 | iPhone17 / iOS27，83项：74过、9失败 | `baseline-ios-full-021600.xcresult`、同名summary JSON |
| iOS候选全量 | 同一iPhone17，85项：76过、9失败；发送、长文、附件与减少动画通过，3个失败名称不在基线集合 | `final-ios-full-025001.xcresult`、`ios-full-comparison.json` |

Android4失败为自由文本权限、DeepSeek新建、问卷草稿与电脑归属原用例，完整名称见比较JSON；7条外部夹具未运行不算通过。A3中的绘制对比夹具固定高度220dp，大字下附件示意块受夹具高度约束；末帧一致通过不代表生产附件的大字全流程已验收。

iOS候选失败为添加电脑返回、配额卡、目录折叠、目录更新锚点、目录选择清除、长对话工具展开、模型切换标记及两项最近提问阅读锚点。新增失败名称为 `testCompactQuotaCardsAndTransparentSwitch`、`testDrawerSelectionClearsOnCancelSearchAndClose`、`testModelSwitchShowsTheChoiceWithItsMarkWithoutMovingTheHeader`；基线的缓存入场计时、启动中发送、目录右滑在候选通过。失败数量相同不表示集合未扩大；并行修改与资源负载未被隔离，新增失败来源未定，不归为既有基线失败。全量构建早于最后的遮罩留阴影和正常时钟测试补充，最新完整快照另由4项专项覆盖，未再运行最终快照全量。

Android原运行器在本机共用入口规则新增前执行；之后不再使用它。A2 / A3关闭阶段曾超时，核对本任务进程、端口与owner后完成残留私有ADB和锁清理，见 `cleanup-recovery.json`。最终iOS runner正常执行finally释放；`cleanup-final.json`确认本任务没有残留设备 / 构建租约或进程。当前源码及包、基线回退包哈希保存在 `source-manifest.json` / `package-manifest.json`；未部署。

早期iOS运行保留而不覆盖：Canvas以修饰器内容作symbol时正文空白，改为传递具体气泡视图；长文覆盖页顶时补视口上缘裁切；正式行opacity交接导致原生可选文字再次淡入，改为无动画遮罩，并以动画完成回调交接。`final-send-ios-attachment-video-024312.xcresult` 的上传90%瞬态断言失败（4项中1失败）；最新同一用例通过，首次失败仍保留。原断言未删除或放宽。

### 逐帧审阅与边界

最终iOS19张附件已逐张查看（`ios-verified-review-0`–`2`及索引）；正常时钟录屏完整解码后，365–368秒片段按60fps抽帧，80个变化帧已查看（`verified-live-normal-0`–`3`）。可见同一气泡右移、上移减速、原位展开，交接后位置与文字浓度稳定；键盘保持展开，顶栏未被长文覆盖。60fps为抽样频率，不作设备帧率结论。379–383秒是测试固定在右移末端的下一轮，不能当作正常时钟停顿；按墙钟推算视频位置或输入端seek的旧抽帧不用于时序结论。

iOS候选全量导出188张PNG，已查看 `ios-final-full-overview-08`、`09`、`13`、`15` 的44张概览，包含发送、原生选区、失败恢复、附件外观和启动中发送；其余仅导出，不能记完整L4通过。

Android全量拉取目录的277张可读图片联系表已查看，但包含设备旧图库、gap与tool-capture文件，未完整建立本轮文件归属，不能记为277张本轮L4通过；另有两张0字节debug PNG保留为无效证据。当前发送阶段的root / display截图、最终深色和大字各4张阶段图已查看：紧凑落点、展开、完整投影与正式行一致。

完整C01–C18、R37所有输入 / 快速连发 / 切换 / 中断组合、所有外观的真实页面手动检查、真机流畅度与读屏尚未验收。已执行的自动用例与画面核对不能代替这些门禁。按证据根 `manual-checklist.md` 保留逐项范围，MOT-06维持“r36已接入，验证中”。

## 2026-11-03 / r43 按钮轻压重设计

双端入口`OrbisPressedGlyph` / `rememberGlyphProgress`由单一可取消任务驱动，`GlyphFeedbackState`区分物理按压/释放与无触摸激活；所有共用图标统一轻压，原专属配额/复制/发送语义保持。MOT-08/13/15、R39/R47/R49沿用原编号，旧旋转行为由用户授权替代。新增单元与设备用例及未运行门禁见 `.artifacts/ui-regression/20261103-button-feedback/summary.md`；本次预览仅供设计体验，不计设备验收。

2026-11-03 / r43验证：Swift355/355、Android685/685单元测试，iOS应用及UI测试构建、Android Debug/AndroidTest均通过。网页设计预览在320/736px明暗与减少动画检查通过，已看浅色窄屏及深色截图，但不计原生设备验收。双端共享入口仍被`provider-well-shadow-standard-full`与`Codex permission model preservation`的设备锁阻塞；L3/L4、C01–C18、R39/R47/R49及原生A1–A4未运行，不能比较同设备基点失败集合，保持验证中。证据 `.artifacts/ui-regression/20261103-button-feedback/summary.md`。

## 2026-11-05 / r48 消息菜单与显式文字选择

S08 / S10 / M19、SC11–13 / SC41、MOT-05 / MOT-19 已接入两端：用户正文长按只打开消息旁纵向菜单，页顶栏保持；“选择文字”关闭菜单后进入独立只读原文面板。整条复制共用 M05 的 2.5 秒反馈，Rewind 保持真实能力和原确认。助手选择、附件和消息发送 / 恢复语义保持。专项映射 R36 / R53 / R66，完整设备与人工门禁仍未验收。

证据根 `.artifacts/ui-regression/20261105-message-actions/`。基线和候选取自任务开始时的隔离工作区快照，保留当时其他任务的未提交修改；候选随后接入共用复制反馈修订，源码与包哈希分别记录，不能把旧包结果外推为最新工作区验收。L0 为 83 个唯一 ID、双入口一致、相对链接和 1,483 条本地化检查通过。Android 基线 / 候选各 720 项 JVM（719 通过、1 条既有跳过、0 失败），Debug / AndroidTest 构建通过；iOS 基线 374 项、最终候选 378 项核心测试及应用 / UI 测试包构建通过。

iOS SE 首轮两项均失败，原始 xcresult、录屏和原生选区截图保留：测试按元素长按时自动滚动被裁切行，另一个断言错误地要求正常顶栏不在辅助功能树中；改为可见正文坐标和顶栏几何保持。后续运行中，可见坐标辅助函数仍取到了容器的错误框，菜单未出现；随后整个运行被 SIGTERM 中断，xcresult 未封口。最终测试改为以实际正文静态文本定位，不删除或放宽位置断言。首轮录屏可见单一纵向菜单、独立原文面板和仅在面板中的原生选区，但这些局部画面不代表自动用例通过。该 SE 随后因系统 PosterBoard 崩溃被共享池隔离，本任务保留隔离、不重启或清空设备。

安卓真机使用独立包名 `com.orbising.orbis.messageactionstest`，成功安装后测试未取得前台，主动中断；没有完成用例，不计通过。独立包和测试进程已移除，六项原系统设置恢复，私有 ADB / 设备锁核验释放；日常 App 未被覆盖。iOS 中断留下的设备 / 构建锁与 Xcode helper 均完成定向核验清理，原失败和恢复证据分别保留。完整 L3 对照、L4、C01–C18、R66 全矩阵、A1–A4 / iPad 和真实 Host 尚未完成，最终排队 / 运行状态以证据根 `summary.md` 和 `manual-checklist.json` 为准。

后续池内 iPhone 17 的最终消息专项 **2 / 2 通过**（`candidate-ios-targeted5.xcresult`）：菜单互斥、顶栏几何、整条复制 / 重计时、外部点击不透传、关闭 / 重开、显式原文选择、无键盘、返回原阅读位置和 Rewind。两张菜单 / 原生选区截图已审阅。测试子进程直到设备关闭才退出，原运行器因此停止了后续全量；设备 Shutdown、进程 / 打开文件检查及 DerivedData 释放分别记录，后续全量改为在共享入口完成设备关闭后核验构建租约，不放宽清理要求。

Android 首次受影响整类 **11 / 14 通过**（`candidate-android-targeted-normal/result.json`）：消息菜单与身份 / 能力失效用例通过；显式选区用例等待父页面 `TextToolbar` 回调超时，已改为检查独立 Dialog 中实际系统“复制”节点；另两项失败为既有图标激活 / 快速按压的像素断言，须用同设备基线核对，不能先归为旧失败。原失败和实际菜单截图保留；修订后的测试结果单独存放，未完成全量对照前仍不记验收。

最终安卓修订复测与 iOS 全量对照分别排队 600 秒后超时，设备名额由其他任务占用，未取得新用例结果。`android-session5` / `ios-session6` 和 `ios-full6-controller` 已完成清理；`final-resource-audit.json` 确认本任务没有残留进程、设备或构建租约，两台借用 iOS 均为 Shutdown。安卓真机私有端口已由新 owner 正常接续，未清理他人资源。完整门禁继续保留未完成状态。

**iPad 真机补充（2026-11-05）**：使用独立包 `com.orbising.orbis.messageactionstest`，未覆盖日常 App。iPad Air / iPadOS 26.6.1 的首轮 2 / 2 通过只覆盖旧断言；审图发现 SwiftUI `Text` 仅提供整段拷贝 / 分享，不能当作部分选区验证。原文面板改为不可编辑、可选中的原生 `UITextView`，复用字号 / 材质和 20pt 内边距。新增从原生菜单复制再粘贴到隔离输入框、断言非空真子串的用例；控件标识被容器覆盖导致第二轮 7 / 8、第三轮 2 / 4，原失败均保留。移除容器标识后，最终 `ipad-message-4.xcresult` **4 / 4 通过**，覆盖范围复制、无键盘、关闭 / 重开、阅读位置 / 顶栏、复制反馈 / Rewind、深色 / 大字 / 减少动画，以及外部拖动只关闭、滚动取消长按。

第二轮中的电脑子菜单、设置 / 电脑菜单、历史预览、乐观发送 / 拒绝恢复、全文 / 工具参数、键盘上方 Slash 共 6 项关联流程通过；后续修改限定于消息文字选择面板和测试定位，不重复无关用例。原生选区真子串断言不以截图替代。横屏 `app.screenshot()` 的裁切图不计完整视觉证据；最终改用 `XCUIScreen.main`，`ipad-message-4-attachments/` 的 5 张完整菜单 / 明暗选区 / 大字 / 减少动画截图已审阅。iPad 用完即清理独立 App / runner，核对远端路径对应进程为空，保持开机、无系统设置更改，设备与构建租约已释放；见各 `ipad-message-*-session/cleanup.json`、`task-cleanup-verification.json` 和 controller cleanup。安卓复测与最终其他构建状态以证据根 summary 为准；完整 C / R66 / 双端矩阵仍未验收。
