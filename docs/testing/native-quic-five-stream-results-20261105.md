# 五流功能回归结果（NQ-14 / R67）

日期：2026-11-05（Asia/Taipei）。依据 [ADR-0065 §11](../adr/0065-native-quic-relay-transport.md#11-history--catchup--bulk-独立五流2026-11-05) 和[功能回归方案](native-quic-five-stream-functional-regression.md)。工作树 `orbis-native-quic`，分支 `feat/native-quic`，基点 `df02972350e00ee4330b311831626b71c8035678`。本轮只验证功能，没有执行性能、公网测速或 Hysteria 对照。

五流实现与传输 / 加密 / 原业务专项通过，Android 原功能无新增失败。iOS 完整 88 项对照首次存在 3 项候选额外失败，原样复核后两版结果一致，未复现候选独有失败；仍保留首次差异及未知根因，不能宣称整个项目功能零问题或完整 UI 门禁全过。设备与本任务进程 / 租约已独立核验释放。

## 1. 实现与兼容边界

Host↔Relay↔移动端已接通 ctl / msg / history / catchup / bulk 五条可靠有序流，顺序为 ctl > msg > history > catchup > bulk。Go 发送端使用原生流优先级；各流仍共享连接拥塞与流控，不承诺消除所有等待。

五流使用显式 v3 ALPN 和认证后的 E2E 能力接受；v2 三流、旧握手、旧 nonce 槽位和防重放规则继续保留。history / catchup 追加独立槽位和序号，共用原会话预算；Host 同步预算、事务名额、业务 applied / ACK、用户操作身份和阅读锚点保持。iOS 后续待消费事件同样维持通道顺序，避免再次合并到单一 FIFO。

默认 WS / shared 保持。五流需显式 background、Relay 发现声明及端点共同接受；旧端或未协商时沿用共同能力。LAN 不启用扩展。只在隔离夹具和共享模拟器中测试，没有部署生产服务或安装用户手机。

本报告记录的分支快照当时尚未包含主工作树 r44–r48 的 UI 和协议兼容改动；本轮比较同一已保存分支基线与候选，不能作为主工作树最新版本的合并验收。主工作树 R65 / R66 已有其他用途，本专项活动回归号迁至 R67，ADR-0065 不变；历史原始证据中的旧编号保持。

后续合入主分支的冲突处理、版本引导修正与独立验证见[主分支集成报告](native-quic-main-integration-20261105.md)，不以本报告旧分支结果代替。

## 2. 最终自动功能结果

证据根为 `.artifacts/quic-five-streams/20261105/`；双端设备与资源索引归入 `.artifacts/ui-regression/20261105-quic-five-streams/`。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| Node 原全量 | 1755 通过、0 失败、5 原跳过，共 1760 项 | `node-regression-final.json` |
| Host / 参考设备四种 WS/QUIC 组合，background | 各 93/93，共 372/372；含原业务、同步 snapshot / applied ACK、文件 / 详情与切换 | `matrix-summary-final.json`、四组 `*-five-streams-final.json` |
| Go 全套 race | 55 个含子用例测试事件通过，0 失败 / 跳过 | `go-regression-final/run.log`、`core-summary.json` |
| Swift 核心 / 实际 Apple↔Go QUIC | 374 项、39 suites 全部通过；v2/v3 × auto/quic 与原加密业务 / 切换 / LAN | `swift-complete/run.log` |
| Android JVM | 697/697，0 失败 / 跳过 | `android-build-complete/run.log`、JUnit XML |
| 保存的旧模块真实互通 | 旧 device＋新 Host、新 device＋旧 Host 2/2；HS1 原字段、旧 schema、原三通道与防重放通过 | `legacy-contract.json`、`legacy-contract.mjs` |
| 构建 / 静态检查 | Android App / AndroidTest 与 JNI、iOS build-for-testing、最终 TypeScript 检查和改动 TS lint 通过 | `android-build-complete/`、`ios-build-complete/`、`typecheck-last/` |

<!-- five-stream-device-results:start -->
| 设备验证 | 本轮实际结果 | 证据 |
| --- | --- | --- |
| Android API 35 / A1 原全量 | 基线 170 通过 / 6 失败 / 5 条件未满足；候选 172 / 6 / 5，无新增失败、无缺失原用例，原用例状态一致且六项失败详情完全一致 | `android-comparison/comparison.json`、两版 `full.json` / 日志 |
| Android 实际 JNI | 三流 / 五流各 1/1，均在上述候选全量中实际运行 | 候选 `full.json` 的两项 `RelayQuicInstrumentedTest` |
| Android rich / slow-sync | 两版 rich 均 1/1；slow-sync 均 0/2，原断言均为 `expected:<7> but was:<15>` | `android-comparison/{baseline,candidate}/` |
| Android 原隔离配对 | 两版各 1/1，使用隔离存储，不写入用户配对 | `android-pairing-comparison/comparison.json` |
| iOS 原 SE / iOS 27.0 首次全量 | 基线只完成 5 项通过后中断，候选未运行；不计为完整对照 | `ios-session-2/`、`ios-comparison/baseline-owner/run.log` |
| iOS 固定备用 SE / iOS 27.0 原全量 | 基线 83 通过 / 5 失败 / 0 跳过；候选 80 / 8 / 0，88 项均齐全，首次存在 3 项额外失败；共同五项断言和数值相同 | `ios-session-3/`、`ios-comparison-2/failure-comparison.json`、两版 summary / tests / xcresult |
| iOS 首次差异原样复核 | 两版均 2/3，目录选择均以相同详情失败；配额和横拖两项在两版均通过。按原 ID 合并补测后两版各 82 通过 / 6 失败，无候选独有失败；首次完整差异保留 | `ios-new-failure-recheck/failure-comparison.json`、两版 xcresult / summary / tests |
| iOS App 内三流 / 五流专项 | 原两项三流、新增两项五流共 4/4 实际通过，无跳过；五流含 history/catchup 完整分片正文、加密消息 / 文件、重握手、切换与 LAN | `ios-native/summary.json`、`tests.json`、`native.xcresult`、`ios-post-full-session/` |

iOS 原共享 SE `49A56E76-943A-420D-8E61-4EF31C4CFA42` 于本轮被持久隔离：反复发生系统 PosterBoard / PRPosterDescriptor 崩溃，设备池要求诊断并记录显式离线恢复后才可再次启动。本任务未移除保护或再次启动该设备；中断记录为 signal 15，不能据此断言是 QUIC 或本次改动导致。后续通过共享入口固定借用池内另一台 SE `E6309176-0CB6-4CC8-86B4-589F59EF9B26`，在该设备上重跑两版；原设备的部分结果不用于比较。原始中断与隔离证据见 `ios-quarantine-observed.json`。Swift 核心中的真实 Apple↔Go v2/v3 互通已经通过，但不能替代 iOS App 内设备和 UI 全量。

iOS 全量的五项共同失败为目录收起、目录更新时滚动位置、长历史工具展开和两项最近提问定位。候选首次额外失败为 `testCompactQuotaCardsAndTransparentSwitch`（等待 64% 超时）、`testDrawerSelectionClearsOnCancelSearchAndClose`（原行不可点击）和 `testSwipeRightFromLeftSideOpensDirectory`（取消横拖后左滑关闭断言）。不改产品源码、原断言或超时，在同设备按候选→基线复核相同三项，两版均只有目录选择以相同元素 / 几何 / 文案失败。配额和横拖的差异未在复核中重复，不能宣称已经定位根因或修复；复核结果不覆盖第一次完整运行。相关页面、预览配额响应和原测试源码均与基线字节一致，见 `ios-preview-failure-source-comparison.json`。

Android 六项既有失败分别涉及 Codex 自由文本权限回答、DeepSeek 按需新建显示、图标反馈、轻压反馈、问卷草稿和 Host 归属；完整名称、断言与原始 stack 见 `full.json`。慢同步两项另列，条件未满足项也不计通过。原 52 个 Android 和 1 个 iOS UI 测试源码均与保存基线字节一致，没有删除或放宽旧用例；见 `original-device-tests-integrity.json`。

Android 将 rich、慢同步与隔离配对补测按用例 ID 覆盖原条件未满足结果后，去重为基线 **172 通过 / 8 失败 / 2 条件未满足**，候选 **174 / 8 / 2**，所有原用例状态一致，无新增失败、无缺失；新增两个 JNI 用例通过。两项剩余条件未满足仍未验证，不记全部功能验收通过。详见 `final-results.json`。

原全量使用默认 WS / preview / 隔离 fixture，不能冒充四种承载组合的完整 UI 矩阵。Android 抽查四组历史 / 返回 / 工具连续性截图：Codex 历史与历史页返回两组文件字节一致；工具阅读位置和旧内容一致，状态栏时间不同。Claude 重开历史的正文标识与工具状态存在，但视口位置和文件变化横条采样不同；原因未确定，不能认定逐像素等价或归因于本改动。见 `visual-review/review.json`。完整 L4 / 人工门禁未完成。
<!-- five-stream-device-results:end -->

## 3. 回归覆盖与中间失败

新用例覆盖能力组合 / MAC 篡改、独立 nonce / 高水位、跨流先到与重复密文、未协商通道拒绝、v2/v3 角色与 FIFO、历史总预算、握手退休、IPC 父进程结束和所有泵退出。Host 保留原 range 分类 / 同步提交 / pending / 路径丢失契约；双端保留消息投影、applied、历史消费与溢出恢复。四种承载组合覆盖完整原业务，不将纯 echo 视作业务回归。

原始失败均保留，最终结果不会覆盖它们：

- 初次 Go 调用缺少 PATH 中的工具，之后固定本机 Go；两次五流测试分别暴露残留 v2 判断和 device v3 路由遗漏，已修复并由最终全套覆盖。Swift 首次 fixture 路径错误，改用实际构建夹具后完整通过。
- Node 初次全量发现旧三流 prepare 调用被额外传入 `streamVersion:2`。恢复旧调用 `{}`，仅 v3 传扩展参数；保留旧断言，最终全量通过。
- `go-complete/` 中两项原控制流用例曾超时：`TestMultiSlowReadersKeepControlProgressAcrossConnections` 和 `TestMultiStalledBulkDeadlineClosesPathAndAllowsReconnect`。未放宽断言或超时，原样定向复核和最终完整 race 均通过；根因未确定，不能宣称已经修复或归因于负载。
- `quic-ws-five-streams-complete.json` 曾为 92/93：原参考设备把合法异步 `device.path` RTT 通知当作 provider 回复。参考设备新增 `receiveReply(requestId)`，仍使用原总 5 秒期限，保留 requestId、业务内容和隐私断言，校验并处理允许的异步通知。最终四组合和 Node 全量再次通过。
- Android 首次仅到安装阶段，被共享模拟器已有较高 versionCode 拒绝，未运行任何测试。调试安装加 `-d`，保留数据与原基线 / 候选；第一次失败和其清理记录单独保留。
- 中断前两个排队进程未取得设备或构建租约，也未运行设备测试；恢复后另建证据目录重新排队。共享池另一已结束任务因 emulator 退出而保留设置保护，先通过共用 `recover` 核验恢复六项原设置并关闭，再允许测试继续。

## 4. 验收范围

上述通过说明对应的自动功能检查未发现失败；它不等于所有现有项目问题已经消失。设备既有失败、条件未满足的用例、完整 L4 / C01–C18 / A1–A4、真实手机 / Agent / SQLite 现场与长期压力分别登记，未执行不记通过。本轮不提供五流提速数值，不将先前三流试验数字用于五流结论。

<!-- five-stream-final-audit:start -->
最终源码 / 包哈希及回退基线保留于 `source-and-packages.json`，逐层结果在 `final-results.json`，原证据通过 `.artifacts/ui-regression/20261105-quic-five-streams/evidence` 索引，不搬移或覆盖。产品源码在核心回归之后没有变化；后续仅补 iOS App 内 v3 用例与结果文档。Android / iOS 测试使用的包哈希与当前构建产物另有核对。

文档 L0 检查 feature ID 唯一、本分支 80 项与已交付 67 项保持、双指南一致、相对链接和 diff 空白；没有新增坏链。`ui-regression.md` 原有的忽略产物 `20261102-session-sync-rejected/summary.md` 在本树缺失，单列为既有坏链，不伪造产物或记整份文档链接全过。详见 `final-l0.json`。

Android 两轮有效设备运行均恢复原六项设置，私有 ADB / emulator 退出，端口与租约释放，见 `android-cleanup-audit.json`。iOS appearance 逐项恢复原 light，两台使用过的 SE 均确认 Shutdown；原故障 SE 的隔离记录继续保留。首次被中断的基线与后续完整基线 / 候选、补测结束时均遇到 Xcode 辅助进程延迟退出；保留初次 cleanup-required，待原进程身份退出、构建目录无命令 / 打开文件引用后，在共享全程 flock / registry 维护互斥内按原 owner 定向释放。证据为 `own-build-recovery/`、`completed-ios-build-recovery/`、`post-full-build-recovery/` 及对应 owner 的 `cleanup-audit.json`。等待构建租约而主动结束的专项未运行用例，之后在独立有效会话实际完成 4/4。

最终 `cleanup-audit.json` 核验 1258 个已记录进程身份均已退出，本任务全部设备、私有端口、构建与维护租约释放；共享队列无 holder / blocker，持久 flock 文件保留。未终止其他任务、改动生产服务或安装用户真机。原始错误 / 中断 / 延迟清理记录全部保留，不以外层退出 0 代替用例结果或资源核验。
<!-- five-stream-final-audit:end -->
