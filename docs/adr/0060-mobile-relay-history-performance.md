# ADR-0060：弱网中继与长会话的 App 性能优化

日期：2026-11-02

Status: accepted（实现与设备验收分别记录）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) r35 的 S08、S10–S11、M03–M05、M07–M08、V01–V05、V09–V10、V13–V20；[ADR-0029](0029-session-read-operation-state-machine.md)、[ADR-0037](0037-session-sync-transaction-contract.md)、[ADR-0039](0039-content-change-signals.md)、[ADR-0040](0040-bounded-inbound-delivery.md)、[ADR-0044](0044-bounded-codex-live-publish.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0058](0058-shared-interaction-motion.md)。验证入口：[测试规则](../../AGENTS.md#测试)。

## Context

问题现象：两端 App 在弱网中继与长会话下存在明显卡顿，iOS 有卡死观察。优化范围为保持既有体验的内部实现。检查基点为 `f24de19`；尚无这次手机现场的调用栈、内存曲线和安装包版本对照，不能把静态热点写成已证明的卡死根因。

已确认的源码成本：

1. iOS Relay / LAN 收包跳到 MainActor 后解析、重组和解密；业务入队又序列化整个事件计量字节。历史 SQLite 已在独立 actor，但接收和投影仍占用 UI actor。
2. iOS 连续 source patch 每次提交后读取历史页，再递归核对祖先 / display 覆盖；即使仅 live 正文改变，历史内容未变也重复这些工作。
3. iOS 消息变化使整个 ChatTranscript 失效；历史行合并 / 查找和工具配对仍有可复用成本。不能把 LazyVStack 或 equatable 行误认为投影已经全部增量化。
4. Android `buildChatListItems` 为每个助手轮次线性寻找可复用的旧轮次；长列表重建最坏为平方级。
5. Android reducer 的多层入口反复解析同一 JSON，部分工具投影先编码为字符串又解析。
6. Host 的版本化 patch 携带完整 live 正文，弱网可能放大排队；生产入口已有 100ms 来源合并、队列上限、分页和恢复，不能重复声称它们尚未实现。

## Decision

### 1. 保持可见行为与正确性

性能优化保持既有视觉、原生文本、阅读跟随、消息身份、原子交接和操作对账。认证、版本、事务、applied 与 ACK 沿用既有拥有者和校验，后台结果提交前核对归属。

### 2. 实施项与顺序

先优化 App 接收消费，再按真实依赖复用缓存与投影；协议成本通过测量独立评估，实施范围由已确认瓶颈决定。

| ID | 优化方向 |
| --- | --- |
| PERF-01 | iOS 入站解码与解密由独立串行 worker 处理。 |
| PERF-02 | iOS 按真实内容依赖复用历史与覆盖缓存。 |
| PERF-03 | iOS 按实际变化更新消息索引与派生投影。 |
| PERF-04 | Android 按稳定消息身份索引并复用轮次。 |
| PERF-05 | Android reducer 共享已解析对象。 |
| PERF-06 | 以链路测量决定剩余协议优化。 |

### 3. 后台处理和缓存

worker 串行拥有解析与解密状态，UI 拥有者提交已认证结果；缓存以实际内容和身份决定失效，事务提交与有界资源共同保证复用正确。

异步 Markdown 解析以最后实际显示的文档作为等待基线，缓存命中也提交该基线及输入版本。完成结果按已显示版本推进，保留能前进的中间结果；正文改写依靠输入版本判断，沿用原生文本布局与现有渐显参数。实现与覆盖见下方 MARKDOWN-LIVE-01 记录。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 实施与验证记录

[根部测试约束](../../AGENTS.md#测试)；[DrawerCatalogWorkerTest.kt](../../android/app/src/test/java/com/orbising/orbis/DrawerCatalogWorkerTest.kt)；[DrawerCatalogBackgroundInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DrawerCatalogBackgroundInstrumentedTest.kt)。

## 2026-11-05：Android 侧边栏滚动（PERF-07，验证中）

侧边栏优化保持既有功能与体验。范围仅 Android 目录内部计算及 LazyColumn 复用；关联 S19、S18、S15、S27、M03、M06、M22、V21，沿用 ADR-0058 SC03 / SC08 / SC36、MOT-14 与 R48 / R57，不增加 feature，不改现有基线参数或已交付计数。

源码检查发现：目录树的 remember 以整份 hosts 为键，无关连接字段或其他电脑更新也会重新分组 / 排序；目录总数、会话集合、选择交集和视口 keys 在父级重组重复分配；离线标题默认扫描所有 runtime，而构树流程已经排除在线身份；目录、会话、更多和间隔共用未分类的 lazy 复用槽。收起目录仍登记零高项，但其 keys / 索引参与现有视口契约，不能直接删掉来换性能。上述是源码成本，尚不认定为手机现场唯一根因。

目录投影按实际领域依赖有界复用，行与视口沿用稳定身份；后台计算、标题解析和缓存水合由统一拥有者管理。

PERF-07 保留目录选择、筛选、归档叠加、语言与标题依赖，统一复用目录投影、可见行及原生列表槽位；输出继续遵守既有阅读与材质基线。

实现与验证见 [DrawerCatalogCacheTest.kt](../../android/app/src/test/java/com/orbising/orbis/DrawerCatalogCacheTest.kt)、[SessionDrawerScrollInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/SessionDrawerScrollInstrumentedTest.kt)。性能结论采用同设备同配置对照，设备与手动结果分别记录。

证据 `.artifacts/ui-regression/20261105-android-drawer-scroll/`；实现、自动结果、帧审阅、手动与真机结论分别记录，未完成门禁不记验收。

PERF-07 执行证据位于 `.artifacts/ui-regression/20261105-android-drawer-scroll/` 的 `summary.md`、`physical/summary.md` 与 `visual-fix/`。模拟器两版全量同7失败/7条件；真机目录整组同一视口定位失败，新增滚动通过；多轮帧指标有改善也有退化，不能认定整体性能稳定提升。

旧对照两版同时含 r47 材质；原包回退对照确认外观恢复后，最终版本保留计算优化及原材质。默认浅色代表场景截图、内影与滚动专项通过；旧帧数据适用于当时版本，原始失败、中断与资源核验保留，完整用户、真实 Host 及真实性能仍未验收。见 [ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)。

### 2026-11-05 PERF-07 补充：Android 目录后台投影与首次缓存水合（验证中）

修复主线程目录构建、过宽失效、标题派生和首次缓存读取。范围 S19，关联 S18 / S15 / S27、M03 / M06 / M22、V17 / V21；沿用 SC03 / SC08 / SC36、MOT-14 与 R48 / R57 / R65，无新增 feature、视觉或动效参数。

[根部测试约束](../../AGENTS.md#测试)；[DrawerCatalogWorkerTest.kt](../../android/app/src/test/java/com/orbising/orbis/DrawerCatalogWorkerTest.kt)；[DrawerCatalogBackgroundInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DrawerCatalogBackgroundInstrumentedTest.kt)。

目录分组、排序、筛选与统计由 `DrawerCatalogWorker` 在 `Dispatchers.Default` 串行处理，按行事实复用目录与标题派生；发布前核对 Host、筛选和捕获的语言，释放失效历史引用。`HostConnection` 先在 IO 中完成目录、下载、上传、迁移及等待草稿水合，再连接；关闭时取消启动任务。保留既有材质、动效和阅读位置。实现见 [DrawerCatalogWorker.kt](../../android/app/src/main/java/com/orbising/orbis/DrawerCatalogWorker.kt)、[DrawerCatalogCache.kt](../../android/app/src/main/java/com/orbising/orbis/DrawerCatalogCache.kt)、[HostCacheStartup.kt](../../android/app/src/main/java/com/orbising/orbis/HostCacheStartup.kt)；证据 `.artifacts/ui-regression/20261105-drawer-background/summary.md`，真机体感待用户验证。

### 原生QUIC与五流隔离（ADR-0065 / R67）

Host↔Relay↔手机两段可分别选择ws/quic/auto，默认WS/shared；显式background且通过能力认证后按ctl > msg > history > catchup > bulk隔离，旧端 / 未协商沿用原三通道，LAN不启用扩展。原Host同步12MiB、Go共享会话32MiB及手机原队列总预算保持，history/catchup不各自扩容；独立序号追加槽位，旧槽位不变。首次ctl只读引导兼容ADR-0064的业务版本绑定；保持消息 / source / applied、未知操作、阅读与文件恢复语义。

本专项功能回归覆盖原配对、目录、消息 / 状态、历史 / 同步、详情 / 文件、LAN、两端承载切换、重连和旧18/19。测试结果及边界见[主分支集成报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-main-integration-20261105.md)、[五流功能报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-five-stream-results-20261105.md)；历史公网测量见该报告引用，不能外推手机卡顿已解决。该阶段证据限于功能回归，完整设备 / 人工与现场验收状态保持待验证。

最终合并版本验证（2026-11-05）：`integrated-final-packages` JVM共748项，747通过、0失败、1既有Host18条件跳过；Debug / AndroidTest / 正式签名Release构建通过。相同池内API35的 `integrated-device` 15/15通过：异步首载 / 显式收起、连续60次正文 / 状态后几何与点击、Host / 搜索隔离、首页加载、侧栏布局、3项阅读视口、3项归档选择、3项provider筛选和960会话滚动。构建后源码哈希未变，版本0.1.54/55，最终APK SHA-256 `fb99707c28485b5b405fdb062e42142f24b554703fc6e79509ba292a1699a02b`；发布签名校验通过、混淆映射保留。四次设备会话设置恢复 / 关闭，所有本任务构建进程与Go / Java / 私有ADB / emulator均退出、端口无监听、租约按owner核验释放；证据 `.artifacts/ui-regression/20261105-drawer-background/final-resource-audit.json`。未执行用户真机体感 / 完整人工 / 真实Host流量门禁，保持待用户验证。

### 2026-11-06：聊天转录滚动（PERF-08，自动回归通过，待真机验收）

聊天列表分组、工具归属、历史图投影和 Markdown 解析不在 UI 绘制路径同步执行。Android 用串行 Default worker 合并可丢弃的派生快照；可见文件概况按 Host / 会话 / 来源代次合并去重、分页且有界，概况请求的构造与加密发送移至 Default。iOS 用独立转录、来源对账与 Markdown 解析 actor 更新行投影，助手轮次复制文本由转录 worker 预计算。两端 Markdown 保留已测量正文，一份正在解析、一份最新等待输入，持续输出不反复取消计算或排队所有中间版本；文档缓存限量。已结束轮次不订阅运行中计时。iOS Relay 与 LAN 的业务 JSON、AEAD 和帧编码使用每连接串行 worker；UI 仍负责受理、顺序排队与发送状态提交，旧连接结果按代次丢弃，异步编码失败触发现有重连对账。历史请求仍由现有 IO / history actor 执行；Host、会话或分支变化时丢弃旧投影。视觉、消息身份和阅读锚点语义不变。

实现与回归见 [ChatPresentationWorker.kt](../../android/app/src/main/java/com/orbising/orbis/ChatPresentationWorker.kt)、[PreparedMarkdown.kt](../../android/app/src/main/java/com/orbising/orbis/PreparedMarkdown.kt)、[ChatViewportInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/ChatViewportInstrumentedTest.kt)、[ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)、[Presentation.swift](../../ios/Orbis/Orbis/Presentation.swift)、[PresentationTests.swift](../../ios/Orbis/Tests/PresentationTests.swift)。本任务证据 `.artifacts/ui-regression/20261106-chat-scroll-performance/`。自动设备结果与后续用户手动体感分别记录；仅源码或模拟器验证不作为真实手机性能验收。

最终源码 Android JVM 25/25、池内设备 11/11 通过，覆盖历史 / 流式 / 持指 / 惯性阅读锚点、表格文件链接和上传附件气泡；Debug / AndroidTest / 正式签名 Release 构建通过，版本 `0.1.54/55`，Release SHA-256 `09aa518bec8c564377537975ceb5049d9f0ed699fadbddc4c19420a8622c326b`，签名及混淆映射保留。iOS 核心与隔离 Relay / LAN 链路 123/123、最终模拟器界面 6/6 通过，覆盖后台计算、来源别名对账、顺序编码、配对重连、拖动追加、工具展开、逐字显示和附件发送；另保留收起状态与英文草稿专项的通过证据。初版正文塌缩跳位和工具展开位置失败均保留原断言与首次证据。Xcode 测试本身成功，包装器因短暂残留 `DTServiceHub` 保留构建租约；随后经归属恢复入口核验进程 / 文件引用消失并释放。最终结果、清理和源码哈希见本任务 `verification.json`。未执行生产 Host / Relay 或真机安装；未测量手机帧率提升。原生文本测量仍由 UI 完成，超长单条正文仍需真实设备验收。

### 2026-11-06 PERF-08 补充：首页与持续生成期间的发布、视口（待用户验证）

沿用 S10–S11 / S18、V01 / V09–V10 / V21。首页标题、排序与卡片事实由两端后台 worker 派生，完整快照保留，聊天正文不是卡片视图的依赖。iOS 历史页合并与来源映射由独立 worker 处理，提交核对 Host、会话、分支、来源和输入代次；实时消息与乐观发送继续按既有身份对账。实现见 [HomePresentation.kt](../../android/app/src/main/java/com/orbising/orbis/HomePresentation.kt)、[OrbisStore.swift](../../ios/Orbis/Orbis/OrbisStore.swift)、[SessionHistory.swift](../../ios/Orbis/Orbis/SessionHistory.swift)。首页阶段证据 `.artifacts/ui-regression/20261106-home-history-publication/`。

iOS 转录与行内容版本由后台计算，相同派生结果复用，UI 使用版本标识比较长轮次；一次被拒绝的发布没有新输入时结束处理，避免同一快照反复计算。滚动保留原有底部尺寸锚点和阅读交互处理。本轮尝试的转录发布时冻结位置策略未通过阅读回归，已撤回；静止阅读时收到新提问的锚点偏移仍待修复，首次失败和原断言保留。实现与断言见 [Presentation.swift](../../ios/Orbis/Orbis/Presentation.swift)、[ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)、[HomeHistoryPublicationTests.swift](../../ios/Orbis/Tests/HomeHistoryPublicationTests.swift)、[ChatViewportInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/ChatViewportInstrumentedTest.kt)、[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。键盘 / 持续生成阶段的自动结果、首次失败、环境限制和资源核验见 `.artifacts/ui-regression/20261106-keyboard-streaming/verification.json`。模拟器和源码结果不能作为现场卡死已消除的证据；真实 iOS 软键盘、真机体感与生产流量仍待用户验证。

Android 前台与聊天页的周期核对在 Default 执行，依次完成后再开始下一轮等待；多 Host 快照聚合与 StateFlow 发布也在 Default，已移除的连接发布前重新核对拥有者。聊天视口 effect 使用后台投影对象作为变更信号，避免以消息集合为键在 Main 深比较正文；入场行的消息身份由投影 worker 预计算。沿用既有读取登记、来源提交、乐观发送和阅读语义。实现见 [RemoteViewModel.kt](../../android/app/src/main/java/com/orbising/orbis/RemoteViewModel.kt)、[ChatPresentationWorker.kt](../../android/app/src/main/java/com/orbising/orbis/ChatPresentationWorker.kt)；覆盖见 [ChatPresentationWorkerTest.kt](../../android/app/src/test/java/com/orbising/orbis/ChatPresentationWorkerTest.kt)。

Android 真机诊断确认安装包 SHA-256 为 `3eaf3302808ce2bdf40f7af0941978b7a573b2cf14cfa19f5c1c5afe2a0fc944`，对应此前聊天滚动构建，尚未包含后续首页 / 历史发布优化。2026-11-06 10:29:38 UTC 系统记录触摸事件等待超过 5 秒的 ANR；当时启用了方法采样，抓栈只得到 ART 等待，无法证明业务阻塞点，也不能排除采样干扰。重启后短暂栈快照中 Main 处于消息队列等待，历史序列化和缓存读取在后台，未再次稳定复现。原始证据、采集限制与设备清理见本任务 `android-physical/` 和 `verification.json`；诊断没有覆盖安装新包或清理数据。

本轮最终 Android 专项单测 40/40、隔离设备回归 15/15 通过，Debug / AndroidTest 构建通过；受测 Debug APK SHA-256 为 `f27e912a9b024470950f598271dfafe47b609dfce8fc685d9613ed94812cee90`。最终 iOS 源码编译通过，核心 110 项及内容版本专项 4 项的证据分别保留；已知阅读锚点失败不计通过。构建、模拟器和真机租约已按拥有者核验释放，最终验证与资源审计见本任务 `verification.json`。真机覆盖安装和体感保持待用户验证。

### PERF-08 实现归纳与 Markdown 缓存发布修复

| 范围 | 已实现的处理 |
| --- | --- |
| 聊天呈现 | Android 后台投影历史图、合并待确认发送、分组轮次并整理工具归属，按稳定身份复用行。两端后台解析 Markdown，等待期间保留已显示正文；iOS 助手轮次的复制文本由转录 worker 预计算。 |
| 首页与历史 | 两端后台派生首页标题、排序与完整卡片；Android 卡片摆脱完整聊天状态依赖；iOS 后台合并历史页与来源映射，提交核对会话及来源归属。 |
| Android 请求与发布 | 可见文件概况按会话合并、去重并有界请求，构造和加密发送移出 Main；周期性模型与聊天核对在 Default 执行；多 Host 快照在 Default 聚合，旧连接提交重新核对拥有者。 |
| 内容变更信号 | Android 视口 effect 使用投影身份，减少正文集合深比较；iOS 用后台行版本比较长轮次，相同转录复用，被拒绝且无新输入的发布结束处理。 |
| iOS 传输 | 每连接串行 worker 处理 Relay / LAN 的业务 JSON、AEAD 与帧编码，提交核对连接代次，发送状态和恢复沿用既有拥有者。 |

MARKDOWN-LIVE-01（S11 / M04 / V09）纳入本轮后台呈现决策，修复提交为 `f19fa86`，关联 [ADR-0046 §4](0046-mobile-ui-stability-and-material.md#4-动画保持内容身份)。旧实现可能先显示缓存文档 B，却仍保留旧文档 A 作为等待基线；输入 C 未命中缓存时退回 A，迟到的 A 解析还可能覆盖 B，造成正文回退、行高变化和渐显重播。

`rememberMarkdownDocument` 在缓存命中时同步保留实际已显示文档及请求版本，后台结果仅在版本不早于已显示版本时发布。比较对象是已显示版本：当 C 仍在等待时，已完成的 B 可以继续前进，避免持续输出期间所有中间结果都被丢弃。文档解析与有界缓存仍由 Default worker 处理；本轮复核保留该修复，实现见 [MarkdownText.kt](../../android/app/src/main/java/com/orbising/orbis/MarkdownText.kt)、[PreparedMarkdown.kt](../../android/app/src/main/java/com/orbising/orbis/PreparedMarkdown.kt)。

三项顺序回归覆盖缓存命中后的等待基线、迟到解析覆盖和中间结果继续发布，见 [MarkdownPresentationInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/MarkdownPresentationInstrumentedTest.kt)；缓存复用 / 超限文档与渐显覆盖见 [MarkdownTest.kt](../../android/app/src/test/java/com/orbising/orbis/MarkdownTest.kt)、[StreamingRevealInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/StreamingRevealInstrumentedTest.kt)。复用既有专项单测 14/14、隔离设备 8/8 的通过证据，缓存回退及中间结果停滞的首次失败保留在 [verification.json](../../.artifacts/codex-typewriter-flicker-20261106/verification.json)。本轮只复核实现、源码哈希和已有证据；真实会话验收仍待用户验证。


### 2026-11-06：按界面事实发布状态（PERF-09，待用户验证）

沿用 S10–S11 / S18–S19、V09 / V13 / V21 及 ADR-0039 / ADR-0049 / ADR-0058。本轮收窄呈现层依赖，保持业务事件、来源事务、读取、跨 Host 路由与乐观操作的既有拥有者。

- Android `HomeUiWorker` 在 Default 发布不含正文、历史图或下载载荷的首页快照；完整聊天状态继续供聊天与业务层使用。首页同步状态与下载数量在后台准备，保留首页消费同一份目录树。非当前电脑仅发布电脑菜单使用的名称、中继连接、端到端加密就绪和待确认事实。
- Android 首页与目录缓存先比较实际标题、在线消息数、元数据和归档叠加，再决定准备行事实。助手正文变化复用已有结果，首次用户消息、同长度标题更正、消息数与归档变化仍失效；同一 Session 的多个 Runtime 分别核对标题。
- Android `ChatRowResourcesWorker` 独立索引下载任务，按行准备附件对应任务及流式消息 ID；下载进度不重建聊天投影，无关任务复用行资源。附件 ID 或路径任一匹配时仍采用原任务顺序中的第一项，重复附件 ID 的不同路径保持独立。
- iOS `OrbisStore` 仅转发当前 Host 的完整变更，后台 Host 按菜单事实决定是否通知。首页和目录使用独立发布器，父级聊天更新通过视图等值边界隔离；连接替换以拥有者身份重新发布。同步就绪判断按元数据版本复用，标题回退的普通正文追加跳过排序。
- iOS 目录标题、归档投影、provider 筛选、分组、排序、视口 keys 与活动索引由 actor 派生。异步结果核对目录与筛选归属，普通正文复用目录，拖动期间保持当前投影，松手后应用最新结果。

实现见 [HomeUiSnapshot.kt](../../android/app/src/main/java/com/orbising/orbis/HomeUiSnapshot.kt)、[HomePresentation.kt](../../android/app/src/main/java/com/orbising/orbis/HomePresentation.kt)、[DrawerCatalogCache.kt](../../android/app/src/main/java/com/orbising/orbis/DrawerCatalogCache.kt)、[ChatRowResources.kt](../../android/app/src/main/java/com/orbising/orbis/ChatRowResources.kt)、[OrbisHub.swift](../../ios/Orbis/Orbis/OrbisHub.swift)、[OrbisStore.swift](../../ios/Orbis/Orbis/OrbisStore.swift)、[Presentation.swift](../../ios/Orbis/Orbis/Presentation.swift)、[SessionViews.swift](../../ios/Orbis/Orbis/SessionViews.swift)。

回归覆盖见 [HomeUiSnapshotTest.kt](../../android/app/src/test/java/com/orbising/orbis/HomeUiSnapshotTest.kt)、[HomePresentationWorkerTest.kt](../../android/app/src/test/java/com/orbising/orbis/HomePresentationWorkerTest.kt)、[DrawerCatalogCacheTest.kt](../../android/app/src/test/java/com/orbising/orbis/DrawerCatalogCacheTest.kt)、[ChatRowResourcesTest.kt](../../android/app/src/test/java/com/orbising/orbis/ChatRowResourcesTest.kt)、[ScreenPublicationTests.swift](../../ios/Orbis/Tests/ScreenPublicationTests.swift)、[MultiHostTests.swift](../../ios/Orbis/Tests/MultiHostTests.swift)。最终源码、构建、自动回归、首次失败及并行改动边界见 [verification.json](../../.artifacts/ui-regression/20261106-narrow-ui-dependencies/verification.json)。自动验证与真机体感分开记录，既有 iOS 阅读锚点失败保持原证据；本轮结果不能视为现场卡死已消除。

验证记录：Android 专项单测 32/32，两个受测快照的设备回归分别为 18/18、9/9；并行聊天分卡合入后，受影响的 3 项行资源 / 投影测试与编译通过。iOS 合并后核心 46/46，受测快照界面 4/4；语言缓存和持续目录发布的最后补充由核心专项与最终编译覆盖。受测包、最终源码及各轮边界分别记录，原始失败保留；真机安装与体感待用户验证。

2026-11-10 S18 / SC72：Android 非当前电脑的菜单快照补回 `e2eReady`，首页与侧边栏切换菜单据各电脑自身的加密连接状态显示在线 / 离线，切换选择保留其他电脑的状态。实现见 `HomeUiSnapshot.kt`，回归见 `HomeUiSnapshotTest.kt`；新增两项用例在修复前失败，修复后连同既有首页发布与目录缓存回归 12/12 通过。首次失败、构建、包校验与安装验收状态见[本次证据](../../.artifacts/android-host-switcher-status-20261110/verification.json)；待用户安装验证。

### 2026-11-14：iOS 整页弹入 / 弹出的主线程占用（PERF-10，待用户验证）

沿用 M14 / ADR-0054 的整页导航与动效参数，保持业务事实、同步与乐观操作的既有拥有者。2026-11-13 起整页过渡由 SwiftUI 在主线程逐帧驱动，主线程任何一段占用都直接丢帧。Time Profiler（`31ee24a`，长会话夹具）显示每次再次进入聊天约 240ms 主线程占用：聊天页 `.task` 订阅 AgentState 后发布，强制在入场前同步排版整页（约 40ms）；返回优先级偏好在每层整页上逐视图合并（约 13ms）；滑入途中会话同步回包触发 store 发布，整树重算约 37ms。另发现返回键路径的既有缺陷：静止页面在同一次更新内被设为移动层并动画偏移，层从未读取过偏移，动画被直接应用，页面不滑出即消失。

- 入场在新层出现后的下一帧开始，页面已建好并画在起点；返回键先以移动层静止画一帧再走同一滑出，拖动中途接管。
- 页面初始化工作经 `orbisTaskAfterArrival` 在入场结束后开始，聊天页的 AgentState 兴趣与工作分支轮询改用它；离开仍取消。
- 页面运动期间 `OrbisStore.holdScreenPublications` 暂缓 Host 发布，静止后合并发布一次；事实不变，运动中新建的页面仍读当前状态。每个运动阶段重新计时，动画阶段上限 1s、手指拖动 5s，防止结束事件丢失时界面冻结。
- 返回优先级改为页面层持有的引用（`OrbisBackPriorityClaim`），只由手势读取；下载页选择仍先消耗右滑。
- 消息锚点改用 `onGeometryChange`；空闲复制反馈清除不再发布；调色板外观改为缓存，默认值变化时失效；`session.snapshot` 的去重指纹与字节预算由内容 worker 准备。
- 评估后未采用：把滑动改为内置 offset / opacity。实验构建中滑动帧仍在主线程渲染（SwiftUI AsyncRenderer 仅 2 次采样），且会失去取消弹簧的逐帧夹取。

实现见 [PageNavigation.swift](../../ios/Orbis/Orbis/PageNavigation.swift)、[OrbisHub.swift](../../ios/Orbis/Orbis/OrbisHub.swift)、[ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)、[InteractionMotion.swift](../../ios/Orbis/Orbis/InteractionMotion.swift)、[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)、[AgentState.swift](../../ios/Orbis/Orbis/AgentState.swift)。回归见 [PageTransitionWorkTests.swift](../../ios/Orbis/Tests/PageTransitionWorkTests.swift)、[CopyFeedbackTests.swift](../../ios/Orbis/Tests/CopyFeedbackTests.swift)，以及 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift) 的 `testPageMotionKeepsFramesDuringChatEntryAndReturn`（应用内显示链接记录每次运动的帧数与长间隔，帧预算仅在 `ORBIS_PERFORMANCE_REGRESSION=1` 的设备基线断言）与 `testDownloadSelectionConsumesBackSwipeBeforeReturning`。

验证（iOS 27.0 模拟器 Orbis iOS Standard 2，Debug；对照为 `9c073a2` 加同一测量探针，条件一致）：

| 运动 | 对照（3 次） | PERF-10（3 次） |
| --- | --- | --- |
| 首次进入滑入 | 8–14 帧，长间隔 3–5，最长 176–286ms | 20–21 帧，长间隔 1，最长 25–105ms |
| 再次进入滑入 | 10–14 帧，长间隔 4–7，最长 49–69ms；起滑 142–219ms | 19–21 帧，长间隔 0–2，最长 17–36ms；起滑 146–175ms |
| 返回键 | 0 帧（未滑出） | 14 帧，长间隔 0 |
| 右滑返回 | 长间隔 3–8，最长 43–54ms | 长间隔 0 / 0 / 7，最长 17 / 17 / 39ms |

Swift 491/491；导航界面回归 18/18，探针用例 3/3。`testChatDownloadsReturnToSameChat` 在对照与本分支同样失败于 `XCTAssertFalse(composer.exists)`（iOS 27 快照列出 SwiftUI 已隐藏子树，见 ADR-0054 2026-11-13），为既有失败，断言保留。未覆盖：真机与渲染服务器合成开销、实时会话持续发布；右滑在第三次迭代两轮均出现长间隔，原因未确认。证据见 [.artifacts/ios-page-transition-perf-20261114](../../.artifacts/ios-page-transition-perf-20261114/) 与基线 [.artifacts/ios-page-transition-jank-20261113](../../.artifacts/ios-page-transition-jank-20261113/)。部署未进行；真机体感待用户验证。

### 2026-11-14：iOS 输入框按键不再触发整个界面重算（PERF-12，真机输入 CPU 仍高，见 PERF-13）

对齐 Android 的两处结构。Android 输入框文本是聊天页的 `remember` 状态，按键只经 `DraftStore` 持久化，不写入 `RemoteState`；外观通过 `LocalOrbisPalette` 在根部提供，只在取值变化时重组。

iOS 原先每次按键有两条全局失效路径：
- **Host 发布。** `saveDraft` 发布 `@Published drafts`，Hub 再通知所有观察 store 的视图。
- **`@AppStorage` 重算。** 同一次按键写入 `UserDefaults.standard`。SwiftUI 的 `@AppStorage` 在任何 defaults 写入时都会重新求值（`UserDefaultObserver.userDefaultsDidChange`，与键无关）。全应用有 79 处 `@AppStorage("orbis.appearance")`，仅用于跟随外观，因此消息行（绕过 `.equatable()`）、侧边栏、根页面都会随之重算。

iPad 常驻侧边栏，根页面保持挂载（M14 / ADR-0054），两条路径叠加。目录缓存、选中电脑、待发副本等其他 defaults 写入同样会触发第二条路径。

改动：
- **按键写入。** `HostConnection.drafts` 不再发布。`editDraft` 处理按键：同步写内存，并合并写回 `orbis.sessionDrafts`（格式与跨 Host 合并不变），不发布。
- **store 发起的写入。** 走 `saveDraft` / `updateDrafts(reload: true)` 并递增已发布的 `draftRevision`。范围：Slash 成功后清除提交的草稿、恢复未发出的消息、启动落地迁移、分支编辑文本、清除电脑数据。
- **聊天页文本状态。** `ChatView` 持有输入文本（会话 key 与 `draftRevision`）；不一致时读取 store，因此切换会话和 store 写入都会替换页面状态。新建会话卡片改用 `editDraft`。每次按键仍重算聊天页，与 Android 在聊天屏幕层读取 `input` 的粒度一致；未变化的转录行由 `.equatable()` 跳过。
- **外观设置。** `OrbisDisplaySettings` 统一读取外观与颜色模式，只在取值变化时发布。`OrbisDisplayPreferences` 在窗口根部、以及由 UIKit 托管的差异页内，以 `\.orbisAppearance`、`\.orbisColorMode` 提供给下层。原有读取改为环境值，设置页直接写 defaults。等值视图不再比较外观：环境变化会直接使依赖它的视图失效，回归见 `testMaterialAppearanceRefreshesMountedHomeCard`。
- **仍保留 `@AppStorage` 的位置。** 仅剩新建会话卡片的 `orbis.lastDraftAgent`，只在卡片打开时挂载。

评估后暂不改动：
- **回复卡片 TimelineView 增高。** M24 要求尺寸与内容快照同批判定；它在非实时输出时暂停，不在输入路径上。
- **持续输出时的 Host 发布。** 隐藏的根页面仍随每次 Host 发布重算；需要按属性观察（`@Observable` 迁移）或根页面发布门控。
- **行内工具摘要。** `ToolSummaryView` / `TruncatedMessageContent` 只读取 `canSend` 与当前 runtime，可改为环境值传入，不需要迁移；尚未处理。
- **每键 defaults 写入。** 仍在主线程合并写入整份草稿字典，约 0.3ms/键；改为后台写需同时调整 store 侧的读改写顺序。

实现见 [OrbisStore.swift](../../ios/Orbis/Orbis/OrbisStore.swift)、[OrbisHub.swift](../../ios/Orbis/Orbis/OrbisHub.swift)、[ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)、[SessionViews.swift](../../ios/Orbis/Orbis/SessionViews.swift)、[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)、[OrbisApp.swift](../../ios/Orbis/Orbis/OrbisApp.swift)、[StatusViews.swift](../../ios/Orbis/Orbis/StatusViews.swift)、[TurnFileChangesView.swift](../../ios/Orbis/Orbis/TurnFileChangesView.swift)。回归见 [StoreTests.swift](../../ios/Orbis/Tests/StoreTests.swift) 的 `keystrokeDraftEditsPersistWithoutPublishingScreens`、`storeOriginatedDraftWritesAdvanceTheComposerRevision`。测量用例为 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift) 的 `testTypingOverLongTranscriptKeepsTheDraft`：DEBUG 参数 `--preview-standard-preferences` 让预览 store 像正式版一样写 `UserDefaults.standard`。

验证（iPad Air 11-inch (M4) 模拟器，iOS 27.0，Debug，长会话夹具，同一段 112 字符连续输入约 1.85s；窗口取键盘输入样本的主簇）：

| 构建 | preferences | 主线程 CPU | 输入期间聊天页以外的 body |
| --- | --- | --- | --- |
| 对照 | 无（预览） | 92% | ContentView、模型提供方页、设置页、侧边栏 |
| 仅草稿改动 | 无 | 51% | 无 |
| 仅草稿改动 | `.standard` | 76% | 消息行、侧边栏、模型提供方页、ContentView、HomeView；`UserDefaultObserver` 24 |
| 草稿 + 根部环境值（`@AppStorage` 根读取） | `.standard` | 69% / 69% / 66% | 无；根部仍随每次写入重算，宿主视图渲染翻倍 |
| 草稿 + `OrbisDisplaySettings` | `.standard` | 66% / 49% | 无 |

- **测量局限。** 92% 的对照未走 defaults 写入，没有正式条件下的修改前数据。同一构建两次运行相差约 17 个百分点。百分比只作量级参考，可靠的结论是哪些视图随按键重算。对照与前两种构建各只测一次。模拟器上未出现多核占用（其他线程 ≤62ms），用户报告的 150% 未复现。
- **单元测试。** 修改前，7 次按键触发连接发布 14 次、Hub 发布 1 次，用例失败；修改后通过。[DisplayPreferenceTests.swift](../../ios/Orbis/Tests/DisplayPreferenceTests.swift) 扫描源码：`@AppStorage` 只允许 `orbis.lastDraftAgent`，HEAD 有 79 处，会失败。连同相关套件共 169/169；Release 配置编译通过。
- **二进制核对。** 对照不含 `editDraft` 符号，各候选含该符号。
- **界面回归（Orbis iOS Standard 2）。** 草稿相关的 `testDraftSurvivesBackNavigationAndSlashRequiresSelection`、上传发送 / 失败恢复、`testDesignAlignmentRootDraftAndExplicitProtocolChoice`、`testMaterialAppearanceSwitchPersistsAcrossLaunches`、`testMaterialAppearanceRefreshesMountedHomeCard`、`testTypingOverLongTranscriptKeepsTheDraft` 通过。`testDraftHardwareReturnAndDesktopOnlySelection`（第 374 行）和 `testSendingWhileTheSessionStartsWaitsAndSubmitsOnceItIsOnline`（两版各 0/3，均止于发送后 1s 等待）在对照版同样失败，为既有失败，断言保留。`testNativeTurnFileReviewShowsSourceAndReadsOnlySelectedDetail`（第 819 行）与 `testTurnFileReviewDarkAppearance`（第 900 行）止于预览变更卡片按钮未出现，撤回本任务源码的对照构建同样失败，为既有失败。

证据见 [.artifacts/ios-composer-draft-20261114](../../.artifacts/ios-composer-draft-20261114/verification.json)。部署未进行；共享测试看板 `orbis-qa` 连接失败，登记待补。iPad 真机输入体感、中文输入法组字、启动中输入后会话上线仍待用户验证。

用户验收：同日真机（iPad Air 11-inch (M2)，Debug 构建含本项）打字时 CPU 仍高，未通过；主要开销在输入框测量，见 PERF-13。

### 2026-11-14：iOS 输入框测量对齐 Android（PERF-13，待实施）

#### 真机实测

条件：iPad Air 11-inch (M2)，iOS 26.6.1；Xcode Debug 构建，含 PERF-12；真实会话中输入中文约 30s，Time Profiler 附加 40s。

- **负载。** 输入期间主线程持续约占满一个核心，其他线程合计 1.3s。
- **热点。** 全程主线程 25.2s，其中 12.3s（49%）在测量输入框：`TextViewAdaptor._overrideSizeThatFits` → `UITextView _intrinsicSizeWithinSize:` → TextKit 2 文本段枚举 → `CTLineEnumerateCaretOffsets` / `CFStringGetRangeOfCharacterClusterAtIndex`，逐字形簇遍历整段草稿。热点在系统框架内，Debug 构建不改变其成本。
- **应用代码。** 4–22s 窗口内应用代码（含 `ChatView.body`）为 227ms / 14,946ms。PERF-12 已去掉的全局重算没有再出现。
- **测量请求的来源。** 采样栈中，输入框测量由内到外经过：
  - 组合栏 `HStack(alignment: .bottom, spacing: 10)` 的宽度分配（`StackLayout.prioritize`），以及底部对齐查询（`explicitAlignment`，出现在前五条调用链中的三条）；
  - 输入区 `VStack(spacing: 0)` 与聊天页 `VStack(spacing: 0)` 的高度分配；
  - 根部 `ZStack`。

代码位置：
- 组合栏：[ChatView.swift:566](../../ios/Orbis/Orbis/ChatView.swift#L566)
- 输入框 `TextField(axis: .vertical)`、`lineLimit(1...6)`、`frame(minHeight: 56)`：同文件第 570–583 行
- 输入区 `composer`：第 514 行
- 聊天页根 `VStack`：第 156 行

#### 推断（待验证）

SwiftUI 按尺寸提议缓存测量结果，每个不同的提议都要重新测量 UITextView。上述各层栈都会以不同的宽或高提议询问输入框，因此一次按键会被测量多次，单次成本随草稿长度增长。采样无法给出调用次数，验证时需要计数。PERF-12 的模拟器测量只输入 112 个英文字符，没有暴露这一点。

#### Android 对照

结构：[MainActivity.kt:2082](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt#L2082) 起，`Scaffold(bottomBar = Surface(imePadding) { Column { …; Row { … } } })`。转录在 Scaffold 内容区，与输入区分开测量。

组合栏 `Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = spacedBy(8.dp))` 位于第 2181 行，依次为：
- 附件按钮
- `OutlinedTextField(Modifier.weight(1f), minLines = 1, maxLines = 5)`（第 2206–2210 行）
- 48dp 发送 / 停止按钮

源码注释写明：输入框承担剩余宽度，按钮贴底对齐。

测量方式（Compose 布局约定，非实测）：
- 每个布局阶段，父布局对每个子项只测量一次。
- `Row` 先测量无权重的按钮，再把剩余宽度作为精确约束（min = max）测量带 `weight(1f)` 的输入框。
- 底部对齐直接使用测量结果，不再询问子项。
- 这条路径上没有固有尺寸查询；`IntrinsicSize` 只出现在 Markdown 表格。

因此 Android 每次布局只测量输入框一次，宽度确定。

#### 对齐要求

1. 输入框在每次布局中只接收一个尺寸提议：宽度为组合栏扣除两侧按钮与间距后的确定值，高度取理想高度（1–6 行，最小 56）。
2. 两侧按钮的测量、组合栏的宽度分配与底部对齐，都不再向输入框发起额外提议或对齐查询。
3. 输入区与聊天页外层的高度分配不传到输入框；输入框高度变化仍正常推动布局。
4. 外观与交互保持 iOS 现状：
   - 按钮贴底，输入框 1–6 行增长，最小高 56；
   - 发送飞行锚点（`orbisAnchor`）、焦点、硬件回车 / Shift+回车 / Esc、Slash 选择、`chat-composer` 标识不变。
5. 其他基于 UITextView 的输入按同一要求核对：
   - 新建会话卡片 `OrbisDraftEditor`（[SessionViews.swift:958](../../ios/Orbis/Orbis/SessionViews.swift#L958)，每次提议都调用 `UITextView.sizeThatFits`）；
   - 交互面板与配对页的纵向 `TextField`（InteractionView.swift:168 / 191 / 201，PairingScannerView.swift:53）。

#### 不在本项

两端组合栏的既有差异沿用各自现状，统一与否另行决定：
- 最大行数：iOS 6 行，Android 5 行；
- 按钮尺寸：iOS 40pt，Android 48dp；
- 间距：iOS 10pt，Android 8dp。

#### 验证

- **调用计数。** DEBUG 计数探针记录每次按键传给输入框的不同提议数与测量次数：修改前应大于 1，修改后每次布局为 1。
- **模拟器。** 预置长中文草稿（数百字）后连续输入，用 Time Profiler 对比 `TextViewAdaptor._overrideSizeThatFits` 的每键占用。
- **界面回归。** 输入框增长、按钮贴底、发送飞行、Slash、硬件键盘相关用例。
- **真机。** 在同一台 iPad 上复测中文输入，由用户验收。

证据见 [.artifacts/ios-device-typing-20261114](../../.artifacts/ios-device-typing-20261114/verification.json)。状态：待实施。
