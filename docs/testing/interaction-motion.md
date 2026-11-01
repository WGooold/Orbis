# 统一交互动效验证记录

日期：2026-11-01。工作树 `codex/interaction-motion`；基线 `8e259bb`；先行设计提交 `0fcb8f3`。决策见 [ADR-0058](../adr/0058-shared-interaction-motion.md)，执行项见 [MOT ticket](../agents/interaction-motion-tickets.md)。

## 当前结论

共用组件和32组业务入口已接入，尚未完成验收。Android最终全量154项4失败、iOS全量69项8失败均未超出同设备同配置基线；但iOS最近提问的阅读锚点、工具展开和其他受影响基线失败仍存在，不能关单。专项通过不替代完整手动 C01–C18 / R32–R39 / A1–A4；首次失败、修复及复测证据全部保留。

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
| SC19–21 | 下载/设置/历史/刷新/返回/搜索/删除等共用按钮接角色反馈 | 只动画图形；稳定命中槽；禁用无反馈 |
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

完整 C01–C18、A1–A4、R32–R39 的逐场景人工帧审阅仍未完成。iOS最近提问、工具展开、审批与目录等受影响既有失败仍阻塞对应验收；不能只因失败集合等于基线就豁免。Android真实系统边缘指示器与IME/弹层组合仍需真实手势检查（当前中帧用dispatcher注入进度）。iOS17兼容设备缺口、真实隔离Host、真机触觉、VoiceOver/TalkBack全流程另外保留。iOS新增双侧边缘增强按用户补充暂不交付，原返回保留。
