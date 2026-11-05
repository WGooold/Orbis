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
