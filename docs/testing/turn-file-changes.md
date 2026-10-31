# 轮次文件审阅验证记录

日期：2026-10-30。关联 [ADR-0052](../adr/0052-turn-file-changes-and-on-demand-diff.md)、[UI 基线 S21 / M13 / V19](../adr/0051-ui-style-motion-and-visual-stability-freeze.md)。

工作树：`/Users/wgooold/Documents/orbis-turn-file-changes`；分支 `codex/adr-turn-file-changes`；初版基线 `375078cbbd9d7b3299ade6b24867ec5e8b3c65f1`，功能提交 `cf7d635`。后续合并纳入主线 `ee6f7c8`，保留固定 LAN / Relay、首页、消息对账与 Codex 生命周期更新。未部署或修改运行中的用户 Host。下文 `.artifacts/` 路径均相对此工作树，仅为本机保留的证据，不纳入 Git。

## 初版工作树已验证范围

Host 核心测试覆盖净变化、既有脏文件、部分采集不伪造增删、非 Git、特殊内容、固定历史、断点读取、范围隔离、持久化与过期回收。协议使用 strict schema，元数据拒绝正文及超预算页面。coordinator 与 adapter 测试覆盖真实分派前基线、受控轮次归并、缺失起点、超时释放、下一轮提前开始及 canonical 锚点。

`host-service.test.ts` 的加密集成用例通过本机真实 Host、Relay 和设备通道，使用模拟 Claude HTTP 生命周期触发文件写入。断言轮前脏内容作为基线，元数据没有 diff 正文，未请求时没有详情事件，用户读取后只得到指定文件，后续工作区再修改也不改变旧轮差异。这是协议与存储集成，未调用真实模型。

| 检查 | 结果 | 本机证据 |
| --- | --- | --- |
| TypeScript 全量类型检查 | 最终代码通过 | `.artifacts/turn-file-changes/host-final-full-check.log` |
| 初次完整 Node 测试 | 148 文件，1,462 通过、12 失败、5 跳过；见下方逐项处理，不能记为全绿 | `.artifacts/turn-file-changes/host-full-check.log` |
| 最终完整 Node 测试 | 148 文件，1,468 通过、11 失败、5 跳过；失败集合与下方基线完全一致，本次新增 / 相关用例通过 | `.artifacts/turn-file-changes/host-final-full-check.log` |
| Host 最后生命周期 / 集成定向检查 | 6 文件、207 项通过；包括关闭顺序修复、Codex、Claude、loopback、coordinator 和加密集成 | `.artifacts/turn-file-changes/host-final-integration.log` |
| Host 资源 / 租约加强 | 3 文件、30 项通过；fsmonitor marker 正反对照、全局 / 设备 / viewer 并发、取消占位、租约续读和真实内容过期 | `.artifacts/turn-file-changes/core-hardening-tests.log` |
| 修改的 TypeScript ESLint | 通过 | `.artifacts/turn-file-changes/modified-typescript-lint.log` |
| Claude 插件静态校验 / testing kit | 本机 CLI 2.1.314 的 `plugin validate --strict` 通过，8 项模拟测试通过；不是模型端到端 | `.artifacts/turn-file-changes/claude-plugin-test.log` |
| iOS 状态与核心测试 | 摘要 revision 修复后 4 suites、78 项通过 | `.artifacts/turn-file-changes/ios-summary-revision-core-tests.log` |
| iOS 最终租约 / 缓存回归 | 13 项通过；同 cursor 仅重开一次、真实过期停止、3 文件 LRU / 8 MiB 硬上限、超限页不追加 | `.artifacts/turn-file-changes/ios-detail-recovery-cache-tests.log` |
| iOS Debug simulator 构建 / 包内依赖 | 通过；设备使用该构建的 fixture，后续纯模型改动未重跑 UI | `.artifacts/turn-file-changes/ios-validation.json` |
| iOS 设备 UI | 2 项通过 | `.artifacts/turn-file-changes/ios-review-ui-final2.xcresult` |
| Android JVM | 506 项通过，包括最初 11 项文件审阅测试；最终租约恢复、长目录 basename / 无后缀中间省略修复后 14 项定向测试通过 | `.artifacts/android-turn-file-changes/validation-summary.json` |
| Android Debug / AndroidTest 构建 | 通过；包对应 revision / 预览合并修复，后续模型改动以最终证据为准 | 同上 |
| Android 设备 UI | 3 项通过；测试发生在最后纯模型修复之前 | 同上记录的 device log、screenshots |

两个平台的设备测试均使用共享池中已登记设备和独占租约，没有创建新设备。iOS 为 iPhone SE（UDID `49A56E76-943A-420D-8E61-4EF31C4CFA42`），Android 为 `Orbis_UI_Polish_35` / `emulator-5554`。构建目录沿用 `ios/Orbis/build/DerivedData`、`ios/Orbis/.build`、`android/app/build`，执行前取得对应 build lease。

iOS UI 覆盖明暗、系统 XXXL 设置、强制减少动画路径、首尾边界、取消拖动、落位后请求、缓存返回及二进制状态。XXXL 沿用既有固定文字 token，不代表新增全局 Dynamic Type 支持。Android 覆盖概况零详情请求、取消拖动、落位选择、纵向阅读位置恢复、深色与 1.6 字体缩放。两端截图均已复核；这些 fixture 测试没有覆盖真实 Host 网络、真实后端或者 VoiceOver / TalkBack 全流程。

## 完整 Node 测试中的失败核对

新增关闭等待使 `HostService.stop()` 在设置 provider 发布关闭标记前出现异步让步，导致 `host-shared-model.test.ts` 的迟到 provider 发布用例失败。已把关闭标记与 generation 更新移到第一个 await 之前；该文件及相关 207 项定向测试通过。

其余 11 项已在指定基线独立归档中复现，完整失败名称集合相同。5 份测试源码与基线及当前工作树逐字节一致，未修改这些测试或相关产品实现：

| 文件 | 失败数 | 主要表现 |
| --- | ---: | --- |
| `packages/pi-extension/src/runtime-log.test.ts` | 1 | Windows 相对日志路径在 darwin 下按本机路径处理 |
| `packages/host/src/codex-shim.test.ts` | 1 | Windows 带空格路径的 shell 设置预期 |
| `packages/host/src/desktop-terminal.test.ts` | 4 | PowerShell / Windows Terminal 预期与 macOS 启动器不同 |
| `packages/host/src/sessions.test.ts` | 1 | Windows 目录路径与会话归属预期 |
| `packages/host/src/spawner.test.ts` | 4 | Windows `SESSIONNAME` / `wt.exe` 环境预期 |

基线定向结果：49 项中 38 通过、11 失败。环境为 macOS 27.2（26B123）darwin/arm64、Node 22.23.2、Vitest 4.1.11、Vite 8.2.2、TypeScript 5.9.3；复用本工作树依赖，未重新安装或编译基线。证据为 `.artifacts/turn-file-changes/host-base-selected-report.md`、`host-base-selected-comparison.json`、`host-base-selected-check.log` 及源码 SHA-256 清单。临时基线源码和夹具已在确认没有运行引用后清理，固定 Vite 缓存和验证日志保留。

## 纳入主线后的合并验证

2026-10-30，在功能提交 `cf7d635` 上整合主线 `ee6f7c8`，协议统一为 17。合并保留主线的两路径固定选路、首页加载 / 同步呈现、供应商及配额、乐观发送对账、Claude 历史与 Codex 压缩生命周期；没有恢复 P2P 或连接排序。ADR-0051 在 r13 基础上只追加 S21 / M13 / V19，更新为 r14 / 63 项，本机两个指南同步且保持忽略。

| 范围 | 合并代码验证结果 | 本机证据 |
| --- | --- | --- |
| TypeScript | `npm run typecheck` 全量类型检查通过 | 本次工具执行 exit 0，无独立日志 |
| Node 全量 | 149 文件，1,523 通过、7 失败、5 跳过；失败集合在目标主线源码中独立复现，本次合并无新增失败 | `.artifacts/turn-file-changes/main-merge-node-tests.log`、`main-merge-baseline-failures.log` |
| TypeScript lint | 相对 main 的 26 个变更 TypeScript 文件全部通过 | `.artifacts/turn-file-changes/main-merge-lint.log` |
| Android | 完整 534 项 JVM 通过；应用及 instrumentation Kotlin 源码编译通过，未重建 APK 或重跑设备 UI | `.artifacts/android-turn-file-changes/main-merge-validation.json` |
| iOS | 完整 213 项核心测试 / 18 suites、generic Simulator Debug 构建及包依赖检查通过；未重复设备 UI | `.artifacts/turn-file-changes/ios-main-merge-validation.json` 及同前缀日志 |
| 文档与规则 | 相对链接、63 项唯一 ID、原有 main 60 项规则保留、两个本机指南一致及忽略检查通过 | `.artifacts/turn-file-changes/merge-docs-check.json` |

Node 剩余失败为 `codex-shim` 1 项、`desktop-terminal` 4 项、`sessions` 1 项、`runtime-log` 1 项，均为本机 macOS 下的既有 Windows 路径 / 平台预期。原先 `spawner` 的 4 项失败已随主线跨平台实现更新消失；不要再把初版 11 项失败数量用于合并版本。

合并验证继续使用本工作树固定构建目录和独占 build lease，没有新建或使用模拟器。初版设备 UI 证据仍保留，但不能代表协议 17 合并版本已完成设备或真实后端验收。

## 交付与剩余边界

Android 保留包为 `.artifacts/android-turn-file-changes/packages/app-debug.apk` 和测试 APK；它们仍为初版协议 16，未包含最后租约恢复和文件名修复。iOS 固定 DerivedData 中的 App 已按协议 17 合并代码重建，原已通过 UI 验证的 App 保留在 `.artifacts/turn-file-changes/ios-main-merge-rollback/Orbis.app` 并核对原哈希。各包哈希、来源和验证范围见对应 validation JSON；合并版尚无设备 UI 验收，不能把旧包结果当作最终源码的设备结果。早先失败 / 重试的 iOS `.xcresult` 和诊断截图继续保留；不能仅凭后来的局部成功删除尚有诊断价值的记录。

- 合并后协议统一升级至 17（主线 16 已用于两路径断代），Claude bridge 升至 2、插件包 0.1.3；尚未安装到真实用户设备或发布 Host 包。
- DSH Web 与未协调的电脑端启动明确为 partial；没有工具执行前的忽略 / 范围外路径补录。移动文件没有可靠来源证据时为删除 + 新增。
- 快照只证明已声明工作区的时间窗净变化，无法排除所有用户 / 其他进程并发写入；不宣称所有文件都是助手修改。
- 真实 Pi / Codex terminal / Desktop / Claude / DSH 模型轮次、真实手机网络、100 文件带宽 / 时延测量、多设备并发压力和完整无障碍操作尚未验收。
- 缓存是内存缓存。Android 关闭查看器、后台或断连会释放详情，文件间切换保留阅读位置；iOS 保留当前会话内已访问的有界内容。没有实现杀进程后的离线持久 diff。

本记录区分代码实现、模拟后端集成、设备 UI fixture 和真实后端验收，不把其中一类的通过扩展到另一类。

## 2026-10-31 r20：Codex 锚点、轮末位置、概况重做与查看器关闭策略

产物目录：`.artifacts/ui-regression/20261031-0340-turn-diff-review/`（日志、`.xcresult`、两端截图、对照组日志）。

- **问题证据。** 本机 Host 私有记录（`~/.orbis/turn-file-changes/records`）中多条 Codex Desktop 轮次的 `anchorEntryId` 为 `exec-*`、`call_*`、`rs_*`，对照同轮 rollout，最终 `final_answer` 在其后。旧逻辑在 `turn/completed` 时只查已提交 Entry，而最终正文可能仍在 `completedItems` 中排在未提交条目之后；App 又把卡片放在锚点所在的 4 条消息虚拟行之后，卡片因此落在回合中段。
- **Host。** `codex-runtime.test.ts` 新增“最终正文排在未提交条目之后”用例：旧逻辑实测得到 `rs-1`，新逻辑得到 `final-answer`。Codex runtime / coordinator / service / diff / protocol 共 196 项通过。
- **iOS。** Swift `TurnFileChangesTests` / `PresentationTests` 37 项通过（含续行标记与最大行号断言）。设备（池内 iPhone 17 / iOS 27，`19EC6DD0…`）：`testTurnFileReviewLoadsOnlySelectedFilesAndRetainsCache`（新增概况几何：标题行在回复之后、文件行单行 ≤44pt 且有序、二进制短状态）、`testTurnFileReviewDarkAppearance`、新增 `testTurnFileReviewOnlyHeaderPullCloses` 通过。对照组：去掉 `interactiveDismissDisabled` 后新用例在第二次正文快速下滑时因查看器被关闭而失败。全量 58 项 6 项失败（审批浮层、目录折叠 / 选择、长转录工具展开、页面截图、工具导出），把本次 5 个 iOS 文件恢复到 `HEAD` 重建后同 6 项以相同断言失败，失败集合与基线一致。
- **Android。** API 37 AVD 因 Espresso 反射 `InputManager.getInstance` 不存在而所有设备用例无法运行，不作为结果；改用池内 `Orbis_UI_Polish_35`。`TurnFileChangesInstrumentedTest` 4 项通过（新增 `diffScrollNeverClosesViewerButHeaderPullDoes`，概况用例新增标题行 / 单行行高 ≤48dp / 顺序断言）。对照组：去掉正文的嵌套滚动与纵向拖动消费后，新用例 `onClose` 被调用 2 次而失败。全量 133 项 6 项失败：`CodexPermissions` 自由文本、`Dsh` 新建、`Questionnaire`、`SessionHostOwnership` 为回归方案登记的既有失败；`HomeViewport` 两项下拉用例属于并行进行中的 M15（r21）首页改动，不涉及本次文件，未在基线上复跑。JVM 单元测试通过。
- **未完成（首轮）。** 手动回归 C01–C18、A1–A4 与 C14 新步骤未执行；真实 Codex Desktop / TUI 轮次在修复后的锚点尚未在真机端到端复核；已持久化的旧错锚记录不回写，依靠 App 按整轮末行放置显示在回合末尾。

### r20 手动回归与修正（同日）

清单与证据：同一产物目录下 `manual-checklist.md`、`manual/`（录屏、抽帧联系表、操作日志）。

- **Android 基线复核。** 在干净的 `HEAD a4cac89` 工作树 APK 上跑全量 132 项，失败与本次 133 项完全相同（6 项）；首页两项下拉用例在基线上同样失败（列表松手后停在 620，期望 410），属已提交的 M15 改动本身，与本次无关（`android-baseline-full.log`）。
- **轮末位置补自动用例。** 此前只断言单条回复后的位置，没有覆盖“长回合被拆成 4 条一行”的场景。iOS `changes` 预览改为 5 步回合、锚点在第一步，`testTurnFileReviewLoadsOnlySelectedFilesAndRetainsCache` 断言只有一张卡片且位于最终消息之后；Android 新增 `ChatViewportInstrumentedTest#turnChangeSummaryFollowsTheWholeTurnWhenAnchoredInsideIt`。对照组：恢复旧放置后，iOS 卡片顶 418 < 最终消息底 688、Android 1305 < 1837，均失败。
- **手动回归发现的两处 iOS 问题（已修）。** ① 页面级 presenter 在 `dismiss()` 时立即清空，sheet 滑出期间显示“正在读取文件清单”，属本次引入的回退；改为 `onDismiss` 后清空。② `presentationBackground(.clear)` 在 iOS 27 上画成白色，自绘标题区位移时露出白底，且系统仍对标题区做橡皮筋拖动；改为每次按下时同步设定 `isModalInPresentation`，只有落在标题区才允许系统原生下拉关闭，并让正文滚动优先于 sheet 拖动。正文外非滚动区（底部翻页栏）只有系统小幅弹性回弹、不关闭，已写入 ADR 平台差异。对照组：去掉标题区判定后，正文快速下滑即关闭查看器，用例失败。
- **C14 / A1–A4。** iOS iPhone 17 与 SE（375pt）三项轮次审阅用例通过，深色 + XXXL + 减少动画用例新增“正文快甩不关、标题区长拉关闭”；Android 关闭全部动画缩放后 5 项通过并已恢复设置。录屏逐帧确认：正文到顶只在差异区内回弹，卡片不动；标题区长拉原生跟手关闭，滑出时内容保持。
- **核心冒烟。** 两端 C01–C18 由 UI 测试辅助实际执行并录屏抽帧查看，结果见清单；失败仅为基线既有项。Android 测试时钟快，除 C14 外手势中间帧证据有限，未记为逐帧验收。iOS C03、Android C15 未单独执行，C08 / C18 部分步骤受基线失败的预览 / 夹具限制。
- **iOS 全量（修正后）。** 58 项 7 项失败：首轮的 6 项基线失败，外加首页 `testSwipeRightFromLeftSideOpensDirectory`（目录取消横拖后左滑关闭未生效）。该用例不经过查看器或聊天页；在干净 `HEAD a4cac89` 工作树构建、同一设备交替重跑，基线 9 次失败 4 次，本次构建 11 次失败 6 次，录屏显示失败时左滑手势未被卡片接收，属基线上的间歇失败（r15 基线 2026-10-30 也曾失败）。失败集合因此与同设备基线一致（`ios-ui-full-r20b.log`、`ab-*.log`、`ios-head-swipe-right-*.log`）。Android 主代码自全量后未改，只新增上面的位置用例（通过），未重跑全量。
