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
