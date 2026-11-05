# ADR-0060：弱网中继与长会话的 App 性能优化

日期：2026-11-02

Status: accepted（用户要求先写 ADR 再实施；实现与设备验收分别记录，未验收不记为交付）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) r35 的 S08、S10–S11、M03–M05、M07–M08、V01–V05、V09–V10、V13–V20；[ADR-0029](0029-session-read-operation-state-machine.md)、[ADR-0037](0037-session-sync-transaction-contract.md)、[ADR-0039](0039-content-change-signals.md)、[ADR-0040](0040-bounded-inbound-delivery.md)、[ADR-0044](0044-bounded-codex-live-publish.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0058](0058-shared-interaction-motion.md)。验证入口：[UI 回归方案](../../AGENTS.md#测试) R57。

## Context

用户报告两端 App 在中继连接、网络较差且聊天历史较多时明显卡顿，iOS 经常卡死。要求保持原有 UI 和功能效果，找到并实施内部优化。检查基点为 `f24de19`；尚无这次手机现场的调用栈、内存曲线和安装包版本对照，不能把静态热点写成已证明的卡死根因。

已确认的源码成本：

1. iOS Relay / LAN 收包跳到 MainActor 后解析、重组和解密；业务入队又序列化整个事件计量字节。历史 SQLite 已在独立 actor，但接收和投影仍占用 UI actor。
2. iOS 连续 source patch 每次提交后读取历史页，再递归核对祖先 / display 覆盖；即使仅 live 正文改变，历史内容未变也重复这些工作。
3. iOS 消息变化使整个 ChatTranscript 失效；历史行合并 / 查找和工具配对仍有可复用成本。不能把 LazyVStack 或 equatable 行误认为投影已经全部增量化。
4. Android `buildChatListItems` 为每个助手轮次线性寻找可复用的旧轮次；长列表重建最坏为平方级。
5. Android reducer 的多层入口反复解析同一 JSON，部分工具投影先编码为字符串又解析。
6. Host 的版本化 patch 携带完整 live 正文，弱网可能放大排队；生产入口已有 100ms 来源合并、队列上限、分页和恢复，不能重复声称它们尚未实现。

## Decision

### 1. 不变的可见行为和正确性边界

- 不新增交互或动效家族。遵循 ADR-0058：保持布局、材质、字号、动效参数、逐字呈现、按压反馈、展开 / 复制、导航及原生文本语义。
- 保留全部已加载正文和历史覆盖，不截断消息、不减少历史范围、不通过固定等待或降低呈现频率掩盖卡顿。
- 保留稳定消息身份、工具调用 / 结果配对、live→canonical 原子交接、乐观发送精确对账、读取操作拥有者及真实错误。不能以全局 seq、条数或首个未变行代替完整依赖检查。
- 保留 V01–V04 的像素跟随、阅读锚点、上翻不追新和单次边沿分页；非尾部修正、压缩、分支、重连和切 Host 同样正确。
- 保留加密方向密钥、逐通道序号 / 防重放、握手、路由身份、入队预算及控制优先级。后台结果提交前复核连接代次，旧连接的结果和异常不得影响新连接。
- SQLite 原子提交仍先于 source/applied 推进和 ACK；缓存命中不等于源端确认，不放宽 epoch、版本、分支、缺父、循环或 display 覆盖校验。

### 2. 实施项与顺序

| ID | 决策 | 必须证明的性质 |
| --- | --- | --- |
| PERF-01 | iOS 用独立串行 actor 处理入站外壳解析、重组、认证 / 解密与正文 JSON 解码；MainActor 保留连接生命周期和 UI 状态提交。传递接收时已有的载荷字节数 / 原始数据，消除仅为计量而重编码 | 一条路径最多一个在途解码；接收方向密钥 / 高水位由 worker 独占；发送序号仍只有原发送者；旧代次隔离，预算与控制优先级保持；大包处理中 MainActor 可响应 |
| PERF-02 | iOS 复用内容未变的历史页与已验证覆盖；仅 live/来源 seq 变化时继续持久化事务元数据，避免再次读取同一历史页和遍历祖先 | 缓存有界；canonical / display / timing、epoch、head、window、删除或迁移改变即失效；命中结果反映最新元数据；修正和失败不能污染下次读取 |
| PERF-03 | iOS 对消息索引与聊天派生数据按真实依赖复用，降低同一更新对未变历史的重复扫描和分配；业务事件完整处理，发布可跳过未变化结果 | 工具配对、轮次计时、非尾部更新、pending 交接与分组边界无遗漏；不改逐字时间线和滚动 key |
| PERF-04 | Android 旧轮次按稳定首消息 ID 建索引，再核对消息身份；保留原行对象复用 | 输出与旧算法一致；任意位置内容变化、工具行、无用户分隔的真实轮次和长轮次分段均正确；查找规模线性 |
| PERF-05 | Android reducer 入口只解析一次，内部传递 JsonObject；工具补充直接产生对象，保留对外字符串入口和现有验证 | 不通过再编码 / 再解析传递对象；工具依赖等待、迟到快照、错误和控制帧与原行为一致 |
| PERF-06 | 记录弱网下 live 包大小、吞吐与队列年龄，核对已有来源合并和优先调度；先完成 App 消费端优化 | 本轮不在没有数据的情况下改变 wire 格式、100ms 来源合并参数或丢弃有依赖的 patch。若剩余瓶颈确认为重复传输，再修订本 ADR 明确增量恢复契约后实施 |

以上先实施 PERF-01/02，再实施两端可独立验证的内部算法优化。PERF-06 是本轮验证 / 决策项，不能把候选协议设计写成已经完成的优化。

### 3. 后台处理和缓存

UI 状态仍由原主线程拥有者提交；独立 Task 不自动代表后台工作。worker 不读取或修改 SwiftUI 状态，不跨执行器共享可变解密器 / JSON 容器。只有已经认证且归属正确的结果进入既有投递队列；正文不进入性能日志。

缓存失效使用实际内容和身份边界，不使用全局 seq 作为内容变化信号。允许为简单、可靠的实现保守失效；不允许漏失效。SQLite 页缓存不得随会话数量无界增长，不能缓存数据库连接以外的可变引用。失败事务不得把未提交数据留为下一次可命中的结果。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 实施与验证记录

[根部测试约束](../../AGENTS.md#测试)；[DrawerCatalogWorkerTest.kt](../../android/app/src/test/java/com/orbising/orbis/DrawerCatalogWorkerTest.kt)；[DrawerCatalogBackgroundInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DrawerCatalogBackgroundInstrumentedTest.kt)。

## 2026-11-05：Android 侧边栏滚动（PERF-07，验证中）

用户要求优化侧边栏卡顿且保持全部功能与 UI / UX。范围仅 Android 目录内部计算及 LazyColumn 复用；关联 S19、S18、S15、S27、M03、M06、M22、V21，沿用 ADR-0058 SC03 / SC08 / SC36、MOT-14 与 R48 / R57，不增加 feature，不改现有基线参数或已交付计数。

源码检查发现：目录树的 remember 以整份 hosts 为键，无关连接字段或其他电脑更新也会重新分组 / 排序；目录总数、会话集合、选择交集和视口 keys 在父级重组重复分配；离线标题默认扫描所有 runtime，而构树流程已经排除在线身份；目录、会话、更多和间隔共用未分类的 lazy 复用槽。收起目录仍登记零高项，但其 keys / 索引参与现有视口契约，不能直接删掉来换性能。上述是源码成本，尚不认定为手机现场唯一根因。

实施约束：

- 单实例、有界目录缓存只核对实际输入：配对 Host ID / 名称、sessions、runtimes、sessionGraphs、conversations、ledger 与界面语言；集合按引用核对，依赖变化保守重建。不以条数 / 首条 / 全局 seq 判断等价，不缓存归档可操作性或 runtime 状态。电脑移除时清空，切电脑、改名、历史标题修正、归档叠加和语言变化均失效。
- 将目录可见行与 keys 在相同依赖下复用，并标注目录 / 会话 / 更多 / 间隔的 contentType；保持逐项稳定 key、顺序、索引、原生拖动 / 惯性、冻结更新和阅读锚点。保持收起内容首次延迟挂载及展开后的身份（ADR-0048），共用 OrbisCollapse / collectionMotion 不改。
- 离线行使用已知无 runtime 的标题解析入口，保留 Pi 固定标题、缓存 / 历史 / 首条文本回退。既有在线去重、provider、归档、选择、统计和每目录前 5 条 / 显示更多均保持。

验证映射：DrawerCatalogCacheTest 检查无关状态复用、全部真实依赖失效及旧算法输出等价；CachedHistoryTree / SessionDisplayName / SessionHostOwnership / SessionProviderFilter 保留。SessionDrawerScrollInstrumentedTest 用 80 目录 × 12 会话执行实际拖动、无关更新、末尾展开、更多、点击归属及回顶重开，记录 FrameMetrics 原始样本与浅深截图；同设备同配置优化前后对照，调试模拟器样本不作为真机帧率承诺。按影响复用SessionDrawerViewport / SessionDrawerLayout / SessionProviderFilter / SessionArchive / Selection；手动补查快速展开反转、搜索 / Agent / provider / 已归档、滚动中目录晋升、切 Host / 断线 / 归档失败和语言切换。iOS 与共用动效参数无实现改动。

证据 `.artifacts/ui-regression/20261105-android-drawer-scroll/`；实现、自动结果、帧审阅、手动与真机结论分别记录，未完成门禁不记验收。

PERF-07执行状态统一见UI回归§6与本任务`summary.md`、`physical/summary.md`、`visual-fix/`。模拟器两版全量同7失败/7条件；真机目录整组同一视口定位失败，新增滚动通过；多轮帧指标有改善也有退化，不能认定整体性能稳定提升。

旧对照两版同时含r47材质，不能证明与手机原包一致；用户回退原包确认外观恢复后，保留计算优化并恢复原材质。最终默认浅色代表场景截图 / 内影 / 滚动通过；不继续无关样式矩阵，旧帧数据不外推到恢复阴影后的版本。原始失败、中断与资源核验保留，完整用户 / 真实Host及真实性能未验收。防复发按[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)。


### 2026-11-05 PERF-07 补充：Android 目录后台投影与首次缓存水合（验证中）

修复主线程目录构建、过宽失效、标题派生和首次缓存读取。范围 S19，关联 S18 / S15 / S27、M03 / M06 / M22、V17 / V21；沿用 SC03 / SC08 / SC36、MOT-14 与 R48 / R57 / R65，无新增 feature、视觉或动效参数。

[根部测试约束](../../AGENTS.md#测试)；[DrawerCatalogWorkerTest.kt](../../android/app/src/test/java/com/orbising/orbis/DrawerCatalogWorkerTest.kt)；[DrawerCatalogBackgroundInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/DrawerCatalogBackgroundInstrumentedTest.kt)。

目录分组、排序、筛选与统计由 `DrawerCatalogWorker` 在 `Dispatchers.Default` 串行处理，按行事实复用目录与标题派生；发布前核对 Host、筛选和捕获的语言，释放失效历史引用。`HostConnection` 先在 IO 中完成目录、下载、上传、迁移及等待草稿水合，再连接；关闭时取消启动任务。保留既有材质、动效和阅读位置。实现见 [DrawerCatalogWorker.kt](../../android/app/src/main/java/com/orbising/orbis/DrawerCatalogWorker.kt)、[DrawerCatalogCache.kt](../../android/app/src/main/java/com/orbising/orbis/DrawerCatalogCache.kt)、[HostCacheStartup.kt](../../android/app/src/main/java/com/orbising/orbis/HostCacheStartup.kt)；证据 `.artifacts/ui-regression/20261105-drawer-background/summary.md`，真机体感待用户验证。

### 原生QUIC与五流隔离（ADR-0065 / R67）

Host↔Relay↔手机两段可分别选择ws/quic/auto，默认WS/shared；显式background且通过能力认证后按ctl > msg > history > catchup > bulk隔离，旧端 / 未协商沿用原三通道，LAN不启用扩展。原Host同步12MiB、Go共享会话32MiB及手机原队列总预算保持，history/catchup不各自扩容；独立序号追加槽位，旧槽位不变。首次ctl只读引导兼容ADR-0064的业务版本绑定；保持消息 / source / applied、未知操作、阅读与文件恢复语义。

本专项功能回归覆盖原配对、目录、消息 / 状态、历史 / 同步、详情 / 文件、LAN、两端承载切换、重连和旧18/19。测试结果及边界见[主分支集成报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-main-integration-20261105.md)、[五流功能报告](../../.artifacts/doc-consolidation/20261105-e76ac8711c/reports/native-quic-five-stream-results-20261105.md)；历史公网测量见该报告引用，不能外推手机卡顿已解决。按用户要求本轮不再测速，完整设备 / 人工与现场状态不提升。


最终合并版本验证（2026-11-05）：`integrated-final-packages` JVM共748项，747通过、0失败、1既有Host18条件跳过；Debug / AndroidTest / 正式签名Release构建通过。相同池内API35的 `integrated-device` 15/15通过：异步首载 / 显式收起、连续60次正文 / 状态后几何与点击、Host / 搜索隔离、首页加载、侧栏布局、3项阅读视口、3项归档选择、3项provider筛选和960会话滚动。构建后源码哈希未变，版本0.1.54/55，最终APK SHA-256 `fb99707c28485b5b405fdb062e42142f24b554703fc6e79509ba292a1699a02b`；发布签名校验通过、混淆映射保留。四次设备会话设置恢复 / 关闭，所有本任务构建进程与Go / Java / 私有ADB / emulator均退出、端口无监听、租约按owner核验释放；证据 `.artifacts/ui-regression/20261105-drawer-background/final-resource-audit.json`。未执行用户真机体感 / 完整人工 / 真实Host流量门禁，保持待用户验证。
