# UI 基线 r15 实施 ticket 草稿

这些条目追踪 [ADR-0046](../adr/0046-mobile-ui-stability-and-material.md) 与 [ADR-0051 r15](../adr/0051-ui-style-motion-and-visual-stability-freeze.md) 的实施与验收。仓库规定 GitHub Issues 是 canonical tracker；本文件只保存本地状态和创建远程 Issue 前的草稿，不包含凭据、设备身份或未脱敏日志。

## 实施状态（2026-10-31，已合入 `main`，ADR-0051 r23）

| ticket | 状态 | 剩余 |
| --- | --- | --- |
| UI-01 | 两端已实现；iOS 单元与顺序 / 减少动画 UI 定向用例、Android 设备顺序用例通过 | iOS 全量与 R01–R02 手动录屏 |
| UI-02 | Android Pi 2026-11-01 补齐连续更新与原子交接；564 项单元（新增 11）、A1–A4 各 11 项设备（新增 2）通过；六次真实工具调用的 7,105 帧无转录回落。Codex r19 真实输出通过 | 本次全量在允许的冷启动复测后剩余 11 项既有失败；7 个 opt-in 其中真实 Pi 已单独补跑。完整 L4 / C01–C18、iOS 与 Claude 真实输出仍未验收，见 `.artifacts/ui-regression/20261101-pi-tool-continuity/summary.md` |
| UI-03 | Android 首页 / 目录自动用例包含在当前全量中并通过；iOS 首页 / 目录定向用例通过 | 当前 iOS 全量；C01–C18、R05–R07 手动拖动 / 惯性验证 |
| UI-04 | 两端已实现；Android 当前全量相关用例通过，iOS 已有定向设备结果 | C08–C13 / R08–R10 手动回归 |
| UI-05 | r23 修订 Android 下拉旋转与回位曲线；r33 iOS 改为原生一次回弹，338 核心 / 构建与首页手势及 A1–A4 下拉专项通过，同设备前后回弹源帧已查看 | iOS 全量 75 / 82，6 项基线失败、1 项上传间歇失败复跑通过；完整 C01–C18 / 真机体感未验收。Android 本轮未改未测，既有设备缺口保留；见 `.artifacts/ui-regression/20261102-ios-refresh-rebound/summary.md` |
| UI-06 | Android 当前全量通过；iOS 聊天、历史、减少动画 3 项定向设备用例通过 | 完整 L4 帧审阅与 R15–R16 手动检查；A4 减少动画视觉复核 |

本轮证据见 `.artifacts/ui-regression/20261030-r15-completion/summary.md`。Android API 35 全量 131 项中 4 项失败，与 127 项 Android 基线的 4 个失败用例相同；当前 56 项 iOS UI 全量未运行，旧 46 项 iOS 基线的 7 项失败不能代替当前版本对比。Mac 处于锁定状态，用户选择暂不解锁，因此手动门禁未执行。

M15 r21 证据见 `.artifacts/ui-regression/20261031-0315-m15-list-pull/`；r22 回弹修复证据见 `.artifacts/ui-regression/20261031-1240-m15-refresh-recovery/`；r23 旋转 / 曲线修复证据见 `.artifacts/ui-regression/20261031-1335-m15-smooth-release/`。r23 的 L1 / L2 构建通过；API 35 设备当时由其他任务独占，未安装测试包，L3 / L4 和手动回归未运行。r33 iOS 结果见上表及本轮证据，专项通过不等于完整验收。

## 交接须知（所有 ticket 通用）

### 总览

| ticket | 内容 | 平台 | 依赖 | 规模估计 | 可拆 PR |
| --- | --- | --- | --- | --- | --- |
| UI-01 | 流式正文按顺序逐字揭示 | 两端 | 无 | 中：两端各一个时钟，Android 还要把时钟提升到消息级 | 单 PR，或两端各一个 |
| UI-02 | 跟随时闪屏：先定位，再修 | 两端，先 Android | 隔离 Host 或回放夹具 | 大：定位与修复各占一半 | 定位记录与修复分两个 PR |
| UI-03 | 首页 / 目录视口稳定 | Android 为主，iOS 核验 | 无 | 中 | 单 PR |
| UI-04 | 设置页、唯一配对入口、页面转场、历史页下载按钮 | 两端 | 无 | 大 | 4A+4B 一个 PR，4C 一个 PR |
| UI-05 | Android 首页下拉刷新 | Android | 建议在 UI-03 之后 | 小 | 单 PR |
| UI-06 | 下载飞入下载按钮（聊天 + 历史页） | 两端 | UI-04 的 4C | 中 | 单 PR |

可以并行的组合：UI-01、UI-02、UI-03 互不依赖；UI-04 与它们只在回归时有交集。建议顺序：先做 UI-02 的定位阶段（需要隔离 Host 和真实输出，耗时最长）；UI-03 → UI-05（同在 Android 首页列表，下拉刷新依赖视口规则）；UI-01；UI-04；UI-06。

### 必读

1. [ADR-0051](../adr/0051-ui-style-motion-and-visual-stability-freeze.md)：UI 冻结基线。先读 §1，再读本 ticket 涉及的 ID，以及标“r15 待实施”的行。
2. [ADR-0046](../adr/0046-mobile-ui-stability-and-material.md)：本批需求的决策原文。ticket 与 ADR 冲突时以 ADR 为准，并在 ticket 中记录。
3. [UI 回归方案](../testing/ui-regression.md)：完成前必须执行的门禁（§1）、命令（§3.1）、核心冒烟（§4.2）、r15 专项（§4.6）和新用例（§5.1）。
4. 仓库根目录的 `AGENTS.md` / `CLAUDE.md`：本机开发指南，git 忽略，只存在于维护者那台 Mac 上。在该机器上工作时必须遵守其中的共享模拟器池（合计最多 10 台、独占锁、不新建设备）、固定构建目录与构建租约、产物保留规则。在其他机器上工作时，不受该机器设备池约束，但仍要满足回归方案的层级与证据要求。

### 代码与夹具入口

- 源码判断基于 `main` `d4e7305`，行号会漂移，以符号名为准；尚未在设备上复现，实施时须先复现。
- iOS：UI 测试在 `ios/Orbis/UITests/OrbisUITests.swift`，通过 `launch(_ screen:dark:arguments:)` 打开预览。预览数据和场景在 `ios/Orbis/Orbis/PreviewSupport.swift`，页面路由在 `ContentView.init`（`--preview-screen=`）。新场景在这两处添加。可用参数：`--preview-dark`、`--preview-reduce-motion`、`--preview-hosts=2`、`-UIPreferredContentSizeCategoryName UICTContentSizeCategoryAccessibilityXXXL`。截图用 `capture(_:app:)` 作为附件保留。
- Android：设备测试在 `android/app/src/androidTest/java/com/orbising/orbis/`。首页夹具见 `HomeFixture.kt`。转场测试写法参考 `SwipeBackInstrumentedTest`，视口与拖动 / 惯性写法参考 `ChatViewportInstrumentedTest`，明暗与字体缩放参考 `HomeLoadingInstrumentedTest`。纯逻辑放 `android/app/src/test/`。
- 协议级回放夹具：`scripts/session-sync-fixture.mjs`（`DisplayScenariosInstrumentedTest`、`SessionSyncSlowLinkInstrumentedTest` 使用）按线上协议发送合成会话，App 走真实加密链路。UI-01 的分批流式和 UI-02 的事件回放都优先在这里加场景，不要在 UI 层伪造状态。
- 命令：见回归方案 §3.1（`bash scripts/check-ios.sh`、`./gradlew testDebugUnitTest assembleDebug assembleDebugAndroidTest`、`xcodebuild test`、`adb -s <serial> shell am instrument`）。

### 完成定义（每个 ticket 都适用）

- [ ] 规则涉及两端的，两端都实现；ADR 写明的平台差异除外。
- [ ] 回归方案 §5.1 中本 ticket 的新用例已写好且通过；被改写的既有用例只更新入口、角色或标题，不放宽断言。
- [ ] 按回归方案 §1 跑完受影响平台的 L1–L4 全量、C01–C18、本 ticket 的 R 项，以及要求的外观矩阵；失败集合与基线比较；结果按 §6 存档。
- [ ] ADR-0051：去掉相关行的“**r15 待实施**”标记；参数按实测终值回写；更新 §2 的“已交付 N 项”；在修订记录中加一行，写明本次 ID、验证结果、未运行项和证据路径。只有本 ticket 涉及的条目才去标记。
- [ ] 回归方案：§3.3 映射加入新用例，§5.1 中对应行标为已落地；手动清单按实际实现修正。
- [ ] 若在维护者的 Mac 上工作：同步更新根目录 `AGENTS.md` 与 `CLAUDE.md` 的基线版本与摘要（两份保持一致）。
- [ ] PR 描述包含：受影响 ID、截图 / 帧证据（A1、A2，必要时 A3、A4）、回归 summary、未运行与真实环境未验收的范围。

### 不确定时

- 规则在实现中做不到或与现有行为冲突时，不要自行降级或绕过。先在 ticket 中记录原因与证据，再找维护者确认，确认后修订 ADR-0046 / ADR-0051。
- 性能优化不能删动画、重置阅读位置或改变消息身份（ADR-0051 §1）。
- 需要真实模型调用（会消耗维护者账号额度）或连接维护者自己的 Host 时，先征得同意。默认用回放夹具和隔离 Host。

一键执行全量回归的脚本依赖本机环境，作为本机工具维护，不在本文件和 GitHub Issues 中跟踪。

---

## UI-01：流式正文按顺序逐字揭示

**ID / 平台**：M04（修订）；iOS、Android。

**Expected behavior**

每条流式消息只有一个揭示游标，正文、标题、列表、引用、代码块都按渲染顺序依次开始渐显。任一帧中正在渐显的字素都是游标前的一段连续区间，不会出现“前面还没出完、后面已经出现”的情况。新批次排在未揭示尾部之后。积压超过 450ms 时提高推进速度（同一帧可依次开始多个相邻字素），但不跳序、不并行。单字 120ms、模糊 6pt/dp、基础间隔 30ms 保持不变。

**Actual behavior**

- iOS `RevealClock`（`ios/Orbis/Orbis/ChatView.swift:842`）：每次 `observe` 都在“现在”追加一个 `Mark`；字素延迟按“与最近 Mark 的距离 × 30ms，封顶 450ms”计算。新批次的第一个字立即开始，上一批的尾部还在等待或渐显，两段因此同时动；一批超过 15 个字素时，第 16 个以后全部在 450ms 处一起出现。
- Android `GlyphRevealClock.observe`（`android/app/src/main/java/com/orbising/orbis/StreamingText.kt:40`）：同样每批序号从 0 开始，`(ordinal * 30).coerceAtMost(450)`，问题相同。
- Android 还为每个 Markdown 段落、代码块各建一个时钟（`StreamingMarkdownText` 中 `remember(streaming) { GlyphRevealClock(text.text) }`，`StreamingText.kt:72`；调用处 `MarkdownText.kt:144`、`:244`）。流式中新出现的段落以挂载时的全文为基线，整段直接显示，并与上一段尾部并行。iOS 已是消息级时钟加各行 `base` 偏移（`MarkdownMessage`，`ChatView.swift:945`），没有这个问题。

**Reproducible example**

1. 在隔离 Host 或回放夹具中，让助手以每 40–80ms 一批、每批 5–40 个字素的节奏输出三段文本（含一个列表和一个代码块）。
2. 60fps 录屏后逐帧查看：当前实现中，相邻两批的渐显区间会重叠；大批到达时后半段同时出现；Android 新段落首帧整段可见。

**建议实现**

- 两端把时钟改为“排队调度”：维护 `nextStart`（最后一个已排期字素的开始时间）。新批次的第 k 个字素开始时间为 `max(now, nextStart) + k × interval`。若积压的完成时间超过 `now + 450ms`，把 `interval` 压缩为“剩余时间 ÷ 积压字素数”，最小可到 0（同一帧依次开始）。开始时间保持单调。
- Android：把时钟提升到消息级，通过 `CompositionLocal` 下发，各块按在整条消息渲染文本中的起始偏移计算自己的字素区间（对齐 iOS 的 `base`）。只在消息首次挂载或 `streaming` 由 false 变 true 时建立基线；块级挂载不再建立基线。保持“同时活动 ≤ 128 个字素”的上限，超限时把最早的已开始字素直接落定，不能跳过未开始的。
  - 块偏移的一种做法：在消息级（`MessageBlocks` 提供 `LocalStreamingText` 处，`MainActivity.kt:3453` 附近）对正文先做一次与 `MarkdownBlocks` 相同顺序的遍历，得到每个可揭示块（段落、标题、列表项、引用内段落、代码块）按文档顺序的渲染文本长度，前缀和即该块的 `base`。块以遍历序号（AST 路径）为 key 读取自己的 `base`，再用 `base + 块内偏移` 向消息级时钟查询进度。遍历结果按正文缓存，不能每帧重算。
  - 消息级时钟只维护一份“已知总长度”和排期；各块的 `drawWithContent` 只读，不写入时钟，避免重组顺序影响排期。
  - 表格单元格、图片 alt 等不参与揭示，直接显示，与 iOS 的 `MarkdownRow` 种类保持一致。若两端范围不同，在 ADR-0051 M04 中登记。
- 非前缀续写（`!text.startsWith(previous)`）时立即全部落定。消息结束（`streamingMessageIds` 移除）时，剩余积压按压缩节奏在 450ms 内揭示完，不瞬间跳出。iOS 17、减少动画和 Android `areAnimatorsEnabled() == false` 时直接显示。
- 顺带核对：Android `drawWithContent` 使用的 `layout` 是上一次 `onTextLayout` 的结果，新文本的第一帧可能用旧布局算裁切框，造成字形闪一下。如经录屏确认，一并修复（例如布局与文本不一致时这一帧不做裁切，或不绘制新字素）。

**Acceptance criteria**

- 单元测试（两端）：多批交错到达时开始时间单调；任一时刻活动区间连续；积压在 450ms 内开始揭示完；跨块共享游标；非前缀续写立即落定；结束时剩余积压在 450ms 内完成；Android 活动字素不超过 128。
- 设备测试：按帧采样已绘制字素的位置，后面的字素不早于前面的字素出现；减少动画路径直接显示；选择、复制、链接点击和辅助功能文本不变。
- 手动 R01、R02 通过，并附 60fps 帧序列（A1、A2、A4）。
- 渐显期间布局尺寸与阅读锚点不变，C05 通过。

**回归测试**

新增：iOS `RevealClockTests`、`testStreamingRevealAdvancesInOrderAcrossBlocks`；Android `GlyphRevealClockTest`、`StreamingRevealInstrumentedTest`。需跑的既有用例：Android `UiPolishInstrumentedTest#revealKeepsEmojiAndCombiningCharactersTogether`、`ChatViewportInstrumentedTest`（全部），iOS 聊天视口三项，以及全量。

**范围外**

不改单字 120ms、模糊 6、间隔 30ms、积压上限 450ms 这些基础参数；不给历史文字、非流式消息或用户消息加动画；iOS 17 不补渐显；不改 Markdown 解析与排版。

**风险与待确认**

- 压缩后的推进在大批量到达时看起来像“快速擦除”，属预期，参数以帧序列复核。
- iOS 的偏移按 UTF-16 计算，表情和组合字符必须按字素整体揭示（Android 已有对应用例，iOS 需补）。

---

## UI-02：跟随视角时的闪屏——先用真实输出定位，再保证工具呈现连续

**ID / 平台**：V20（新增），关联 V01–V03、V09、M03；先 Android，iOS 同样核验。

**Expected behavior**

跟随模式下，助手执行工具的全过程（开始、输出增长、归入消息、取得 id、结果或摘要到达、完成）不出现视口跳动、空白帧或整屏闪烁。工具从出现到完成都是同一张紧凑卡片，状态和摘要在卡片内原地更新。

**Actual behavior（待验证的候选原因）**

用户推测的路径在 Android 源码中存在：

1. 尚未归入消息的运行中工具被渲染成列表末尾单独的 `ToolCard` 行（`orphanToolActivities`，`MessagePresentation.kt:185`；`items(orphanTools, ...)`，`MainActivity.kt:2158`）。卡片正文是最多 2000 字符的等宽原文（`ToolCard`，`MainActivity.kt:3704`），随输出增高。工具归入消息或完成后，这一行被移除，工具改以消息内 56dp 的 `CompactDisclosure` 出现，末尾高度会大起大落。

其他可能原因也必须逐一排除或确认：

2. 工具块的 key 在取得 `toolCallId` 前后从 `"${messageId}:$index:${type}"` 变为 id（`MainActivity.kt:3515`），导致重组时丢失状态、重新测量；iOS 用 `ForEach(..., id: \.offset)`（`ChatView.swift:668`）。
3. 摘要到达时，从 `CompactDisclosure` 换成 `ToolSummaryDisclosure`（Android `CollapsedTool`，`MainActivity.kt:3618`；iOS `ChatView.swift:676`），两者高度不同。
4. 流式 live 消息被 canonical 消息替换时，消息或轮次身份变化，整张助手卡重建（V09）。
5. 跟随滚动实现：内容高度变化与“滚到底”之间存在一帧差，或者内容临时变短后又恢复，误触发了跟随状态切换（V03）。
6. 字形渐显使用过期布局（见 UI-01 最后一条）。
7. 通知横幅、状态槽或审批面板在同一时刻插拔。

**Reproducible example（定位方法）**

1. 在本机起一个隔离 Host：独立进程、独立状态目录、本机 Relay、错开端口。不得使用维护者正在运行的 Host（状态目录 `~/.orbis`、LAN 端口 42130）、生产 Relay 或真实会话。仓库只有 Windows 脚本（[isolated-host](../testing/isolated-host/README.md)、`scripts/windows/relay.ps1`）。下面是按这些脚本翻译的 macOS 步骤，**未在 macOS 上实测**，首次执行时先对照脚本核对参数和环境变量：

   ```sh
   npm run build                                   # Host / Relay 从 packages/*/dist 运行
   RIG=.scratch/isolated-host-mac                  # .scratch/ 已被 git 忽略
   mkdir -p $RIG/state $RIG/workspace $RIG/sessions $RIG/logs
   export ORBIS_RUNTIME_CREDENTIAL=$(openssl rand -hex 24) ORBIS_ADMIN_TOKEN=$(openssl rand -hex 24)
   # 本机 Relay（入口与环境变量见 relay.ps1）
   PORT=8787 ORBIS_STATE_FILE=$RIG/relay-state.json node packages/relay/dist/main.js > $RIG/logs/relay.log 2>&1 &
   export ORBIS_RELAY_URL=ws://127.0.0.1:8787 ORBIS_LAN_PORT=42131
   # 配对：与 host 在同一状态目录互斥，配对完成后自行退出；只把载荷那一行打到 stdout
   node packages/host/dist/cli.js pair --state-dir $RIG/state --print-payload
   # 常驻 Host；--sessions-root 只列 RIG 内的 Pi 会话，不扫 ~/.pi/agent/sessions
   node packages/host/dist/cli.js host --state-dir $RIG/state --sessions-root $RIG/sessions > $RIG/logs/host.log 2>&1 &
   ```

   - iOS 模拟器与 Mac 共用网络，载荷中的 `ws://127.0.0.1:8787` 可直接使用，在配对页粘贴载荷即可。Android 模拟器要把载荷中的 `relayUrl` 改成 `ws://10.0.2.2:8787`；`IsolatedHostPairingInstrumentedTest` 支持用 base64 传入载荷。
   - 启动成功的标志见 isolated-host README（`relay connected`、`hostId=… 已就绪`）。
   - 在 App 中以 `$RIG/workspace` 为目录新建 Pi、Codex、Claude 会话，分别跑一个长工具（如 `sleep 2; for i in $(seq 1 200); do echo $i; done`）。这会用维护者本机的 agent 配置和账号发起真实模型调用，开始前先征得同意。Codex / Claude 的会话目录可能仍会列出维护者的真实会话，只能打开自己新建的那个。
   - 收尾：停止 Host 与 Relay 进程，保留 `$RIG/logs` 作为证据；不要动 `~/.orbis`。
2. 同时采集三份时间线：
   - Host → App 事件：工具开始 / 更新 / 结束、消息开始 / 更新 / 结束，以及 `toolCallId`、`messageId`、到达时间。在 Debug 构建中加临时日志或复用现有 probe。
   - App 每帧投影：列表行 key、类型、测量高度、首个可见项 / 偏移、末尾到视口距离、`following`。
   - 60fps 录屏。
3. 找出闪屏帧，对齐到同一时刻的事件和投影变化，判断属于上述哪一类，或是新原因。把事件序列保存为回放夹具（脱敏，不含真实路径、凭据和会话正文）。做法：在 `scripts/session-sync-fixture.mjs` 中仿照 `--rich` 加一个场景，按原始时间间隔重放；之后的修复验证和设备测试都用这个场景，不再依赖真实模型。
   - 每帧投影日志只放在 Debug 构建中，默认关闭，不进入 Release。可参考已有的 Debug 探针写法：Android `HistoryLoadProbe.kt`，iOS `ChatEntryProbe`（`ContentView.swift` 中 `#if DEBUG` 部分）。

**建议实现（以定位结论为准）**

- 若确认是原因 1：运行中但尚未归入消息的工具，以与消息内相同的紧凑卡片形态渲染，使用 `toolCallId` 作为 key；归入消息时把该卡视为同一身份迁入（或在投影层把它挂到即将到来的消息位置），不再“移除一行 + 在别处插入一行”。运行中原文只在用户展开或打开详情时显示（ADR-0045 的按需原则）。
- 若是原因 2 或 3：key 统一用稳定身份（没有 id 时用 Host 提供的临时身份，取得 id 后建立映射）；摘要到达只换卡片内部内容，外层容器和最小高度不变。
- 若是原因 5：修正跟随的帧时序，在同一帧完成测量与到底；临时变短不得改变 `following`。
- 每个被排除的假设都在 ticket 中写明证据（帧号、事件）。

**Acceptance criteria**

- 有一份基于真实输出的定位记录：时间线、闪屏帧、结论；列出被排除的候选及理由。
- 用录制的事件序列回放：工具行 key 从首帧到完成不变；跟随时每帧末尾到视口距离为 0；没有空白帧；高度只按“卡片内摘要更新”变化。
- 手动 R03、R04 在 Pi、Codex、Claude 三种后端上通过，两端各至少一种附 60fps 帧证据。
- `ChatViewportInstrumentedTest#toolAndThinkingStayExpandedWhenOutputAndCanonicalResultArrive`、`#repeatedToolCommitsKeepTheReadingPositionInsideALongAssistantCard` 以及 iOS 视口用例保持通过。

**回归测试**

新增：Android `ToolContinuityInstrumentedTest`（回放夹具）、`MessagePresentationTest` 中工具归入 / 身份用例；iOS `testRunningToolKeepsIdentityWhileFollowing`。需跑的既有用例：`ChatViewportInstrumentedTest`、`ToolPanelInstrumentedTest`、`ToolContentInstrumentedTest`、`ClaudeHistoryInstrumentedTest`、`DeferredDisclosureInstrumentedTest`，以及全量。

**交付物**

1. 定位记录（可作为第一个 PR，或写入 `docs/testing/` 下的验证记录）：时间线、闪屏帧、结论，以及被排除的候选和理由。
2. 回放夹具场景。
3. 修复与测试。

**范围外**

不改聊天视口的其他规则（V01–V04 的阈值与锚点逻辑）；不在列表里实时流式展示工具原文；在定位证明问题出在 Host 投影之前，不改 Host 协议。

**风险与待确认**

- 若改动 Host 的工具事件或投影，属于“会改变显示的协议修复”，需两端回归，并修订 ADR-0045 / 0049 的相关段落。
- 运行中不再展示原文，用户可能想实时看输出：保留卡片内“查看输出”入口（打开详情并跟随），不在列表里展开大块原文。

---

## UI-03：首页与目录列表增删、重排时视口不被挤走

**ID / 平台**：V21（新增），关联 V18、M15；Android 首页为已知问题，Android 目录与 iOS 首页 / 目录需逐一核验。

**Expected behavior**

- 停在顶部（首项顶边距视口顶 ≤ 8dp）时，新会话或重新排到第一的会话出现在顶部且可见，视口保持在顶部。
- 已向下滚动时，视口内第一张完整可见卡片的屏幕位置不变；如果这张卡自己被排到别处，则保持原像素偏移，不跟着跳走。
- 拖动和惯性中不重新定位；卡片换位只有放置动画。

**Actual behavior**

Android 首页 `LazyColumn` 未显式传入状态，按首个可见项的 key 保持位置（`MainActivity.kt:707`），列表按会话 `modifiedAt` 倒序（`HomePresentation.kt:75`）。
- 在顶部时插入新卡：视口仍跟着原首卡，新卡落在视口上方，看不见。
- 原首卡因活动被排到别处：视口跟着它跳过去。
首页还有 `key = "status"` / `"empty"` 的临时项。目录抽屉（`SessionDrawer.kt`）同样按最近修改排序，需核验。iOS 首页使用 `ScrollView + LazyVStack`，行为不同，需实测。

**Reproducible example**

1. Android 池内 API 35，首页有 8 个会话，停在顶部；让第 5 个会话产生活动（`modifiedAt` 更新），或新建一个会话：新首卡不可见，或视口发生跳动。
2. 向下滚动半屏，让当前视口首卡产生活动：视口跟着它跳回顶部区域。

**建议实现**

- 首页与目录持有显式 `LazyListState`。在发布新快照的前一帧记录锚点：是否在顶部、首张完整可见卡片的 key 及其屏幕偏移。快照应用后：
  - 原本在顶部：`requestScrollToItem(0, 0)`，不打断用户手势；
  - 锚卡仍在且只因上方插入 / 删除而移动：保持 Compose 默认行为（key 跟随）；
  - 锚卡自身被重排走：按原索引和像素偏移恢复（位置保持）。
- 用户正在拖动或惯性滚动时，暂缓应用重定位，在手势结束时结算（复用聊天视口的拖动 / 惯性判定，见 `ChatViewportInstrumentedTest` 的做法）。
- iOS 若复现同类问题，用 `ScrollPosition` 和稳定 id 实现同样的规则；未复现则在结果中记录“已核验无此问题”及证据。

**Acceptance criteria**

- 设备测试：顶部时插入 / 重排后，首项索引为 0 且偏移为 0；滚动后首张完整卡片的屏幕 y 不变（≤ 1dp）；锚卡被移走时像素偏移不变；拖动中发生变化不打断手势、不跳位。
- 与左滑关闭、多选、乐观关闭及恢复（V11）、首版快照发布（S18）、会话替换（`HomeLoadingInstrumentedTest`）共存。
- 手动 R05–R07 通过（A1、A2、A3）。

**回归测试**

新增：Android `HomeViewportInstrumentedTest`、`HomeViewportAnchorTest`（锚点决策的纯函数单测），以及目录同类用例；iOS `testHomeViewportStaysWhenSessionsReorder`。需跑的既有用例：首页 5 个类、`SessionDrawerLayoutInstrumentedTest`、`SessionArchiveSelectionInstrumentedTest`、iOS 首页 / 目录全部用例，以及全量。

**范围外**

不加“有新会话”之类的提示（S16 简洁文案优先，需要时另开需求）；不改排序规则（仍按会话 `modifiedAt` 倒序）；不改左滑关闭、多选和乐观关闭的行为。

---

## UI-04：设置页、唯一配对入口与设置 / 下载页转场

2026-10-31 r24：转场范围按 [ADR-0054](../adr/0054-shared-full-page-navigation.md) 推广为所有下一级整页，覆盖添加电脑、Android 离线历史、聊天→历史→下载等任意深度；统一导航容器维护来源归属和状态，移除逐页手势白名单。根配对 / 模态 / 抽屉边界保留，遗留供应商页不恢复入口。下文 Actual behavior 为 r15 调查快照，不能覆盖当前决策。新增 `PageNavigationInstrumentedTest`、iOS 两项设备用例及 R20–R22，证据见 `.artifacts/ui-regression/20261031-page-navigation/summary.md`；全量与手动门禁按实际结果记录。

**ID / 平台**：S22、M14（新增），S18、S19（修订）；iOS、Android。

### 4A 设置页结构

**Expected behavior**

- 首页右上角只有两个图标按钮：下载、设置（齿轮）。规格与现有顶栏图标按钮相同。删除“更多操作”菜单。点齿轮直接进入设置页。
- 连接胶囊保留，继续显示连接方式、加密以及“正在同步 / 同步失败”；失败时，胶囊旁的重试按钮保留。但胶囊不再响应点击，不进入设置页，辅助功能语义从按钮改为状态文本（读屏读出当前状态）。
- 设置页（原连接状态页）标题为“设置”，分区自上而下：
  1. Agent 供应商：现有卡片、配额币、透明切换，规则不变；
  2. 当前连接：连接状态、方式、加密；Android 的 `statusAdvice` 诊断提示卡放在此区上方；
  3. 配对信息：只读。
  删除 iOS 现有的“已配对电脑”切换区；Android 本来就没有。切换电脑只在首页电脑行和侧边栏底部电脑菜单中进行。顶栏保留重新连接图标。
- 旧设置页和连接优先级：已在 `0ab4bc3`（r13 / ADR-0050）删除。本 ticket 只核对没有残留：入口、文案、`rememberSaveable` 状态、预览参数、测试、文档、深链。用户手机上若仍看到旧设置页，先确认安装的是否为旧包。

**Actual behavior**

- iOS 首页 `trailing` 是下载按钮加 `OrbisMenuIconButton("更多操作")`，含连接状态、添加电脑、取消配对当前电脑（`ContentView.swift:443`）。胶囊包在 `Button(action: onStatus)` 中（`ContentView.swift:457`）。`ConnectionStatusView` 的分区顺序是：已配对电脑（多台时）→ 当前连接 → Agent 供应商 → 配对信息（`StatusViews.swift:3`，已配对电脑区从第 17 行起）。
- Android 首页 `actions` 是 `DownloadStatusButton` 加 `MoreVert` 菜单，菜单项相同（`MainActivity.kt:647`）。胶囊外层是 `Box(Modifier.clip(CircleShape).clickable(onClick = onOpenStatus).testTag("home-connection-status"))`（`MainActivity.kt:693`）。`StatusScreen` 的顺序是：诊断提示 → 当前连接 → Agent 供应商 → 配对信息（`MainActivity.kt:2802`）。

### 4B 唯一配对入口

**Expected behavior**

添加电脑和取消配对只在“侧边栏底部电脑行 → 菜单”中提供；菜单包含切换电脑、添加电脑、取消配对当前电脑（仍需二次确认）。其他入口全部删除。首次未配对时的引导配对页保留，不算入口。

**Actual behavior / 需要删改的位置**

- iOS：首页“更多操作”的添加 / 取消配对；首页电脑切换菜单 `hostSwitchMenuItems` 末尾的“添加电脑”（`ContentView.swift:768`，首页与目录共用，需要参数化，让首页不带“添加电脑”）；目录底部 `hostSelector` 旁单独的省略号“当前电脑操作”（`SessionViews.swift:338`），要并入电脑行菜单。
- Android：首页“更多操作”的两项；`HomeHostSwitcher` 菜单的“添加电脑”（`MainActivity.kt:2684` 起，菜单项约在 2730 行）。`DrawerHostSwitcher`（`SessionDrawer.kt:534`）已是目标形态，保留。
- 文案：Android `"配对不完整：请在主界面点「取消配对」……"`（`MainActivity.kt:2996`）；两端 provider 不匹配提示“请在连接状态页切换到 …”（`OrbisStore.swift:1345`、`SessionProviderFilter.kt:43`）；iOS 目录筛选菜单和对话框中的“连接状态与供应商”（`SessionViews.swift:191`、`:320`）。改为指向“设置”或“侧边栏底部电脑菜单”。
- 保留但改名的排障入口：目录筛选菜单项和 provider 不匹配对话框按钮，文字改为“设置”，点击后进入设置页。Android 需核对对应位置（`SessionDrawer.kt` 的筛选菜单与不匹配提示），保持两端一致。

### 4C 设置页 / 下载页的转场，以及聊天、历史页的下载入口

**Expected behavior**

- 设置页与首页下载页：Android 按 M07 从右侧滑入，入场可被右滑接管；iOS 沿用原生 push 入场。两端页面内右滑按 M08 返回首页（跟手、约 0.15s 速度预测、过三分之一返回、0.18 阻力、取消回弹，底层首页 `scaleX 0.975 / scaleY 1.008`、遮罩 0.34）。返回后首页立即可点。设置页内的供应商二级页返回设置页。
- “历史与分支”页顶栏新增下载按钮：与聊天页同款，带角标，位于筛选按钮旁（iOS）或 `TopAppBar` 的 actions 中（Android）。UI-06 的飞入动效以它为目标。
- 聊天页和历史页的下载按钮单独处理：打开的下载页同样从右侧滑入，在页面内右滑返回。右滑时露出的底层和返回目标都是来源页（原聊天 / 原历史页），不是首页。来源页保持原实例，阅读锚点、跟随、草稿、展开状态、搜索词和消息身份都不变；底层不另建第二个 `ChatView` / `ChatScreen` / 历史页。首页、聊天、历史三个下载入口的返回目标互不串扰。

**Actual behavior**

- iOS：`NavigationStack` 隐藏导航栏后系统侧滑失效，`SwipeBackModifier` 只对 `.chat` 启用，底层固定为首页（`ContentView.swift:61`）。聊天中点下载会 push `.downloads` 到 `[.chat, .downloads]`（`ContentView.swift:48`）。如果直接对 `.downloads` 启用现有修饰器，右滑时露出的是首页而不是聊天，并且返回目标错误。历史页为 `[.chat, .history]`，顶栏只有筛选按钮（`HistoryBranchView.swift:29`）。
- Android：`AllDownloadsScreen` 与 `StatusScreen` 是 `RemoteApp` 的 `when` 分支，整页替换首页，没有入场动画，也没有右滑（`MainActivity.kt:382`、`:396`）；切换分支时首页组合被销毁。聊天内下载页是 `ChatScreen` 内 `if (downloadManagerOpen) { AllDownloadsScreen(...); return }`（`MainActivity.kt:1652`），聊天正文因此离开组合。历史页同样以 `if (historyOpen) { HistoryTreePage(...); return }` 替换聊天（`MainActivity.kt:1626`），其 `TopAppBar` 没有 actions（`HistoryTreePage.kt:147`）。

**建议实现**

- Android：把设置页、首页下载页并入与聊天相同的叠层结构：首页常驻于同一组合位置，上层为 `SwipeBackLayer(open = …)`，承载设置、下载或聊天之一。不要用新的 `when` 分支销毁首页（保持 V13）。聊天和历史页打开的下载页，改为在来源页之上再叠一层 `SwipeBackLayer`，`underlay` 为来源页本身（同一实例，不重建），返回时只关闭这一层。不能再用“提前 return 替换来源页”的方式。
- iOS：给 `.status` / `.downloads` 启用右滑，底层按栈判断：栈底是首页就显示首页；`[.chat, .downloads]` 或 `[.chat, .history, .downloads]` 时，底层须是现有的来源页实例。可选方案有：(a) 为这一层恢复系统交互式 pop，露出真实的来源页；(b) 自定义容器保留来源页实例。不能再实例化一个 `ChatView` 或历史页当底层。选型以能否保持来源页状态和 M08 的手感为准，并在 ticket 中记录取舍。
- 手势：从屏幕左缘起手时，与 M09 目录抽屉的关系明确（这些页面不打开抽屉）；页面内的横向滚动控件（代码块、文件 Pager、下载列表横滑）优先消费横向拖动。

**Acceptance criteria**

- 两端右上角只有下载、齿轮两个按钮；点胶囊不跳转，胶囊仍显示状态，失败重试可用；设置页分区为供应商 → 当前连接 → 配对信息，且没有已配对电脑区；排障入口文字为“设置”；在 UI 树中，除侧边栏电脑菜单外找不到“添加电脑”“取消配对”节点；首次配对引导不受影响；取消配对后的状态清理（草稿、选择、页面栈）与现有行为一致。
- 设置页、首页下载页的入场、取消回弹、返回首页、返回后立即可点，与聊天转场一致；减少动画直接切换。
- 从聊天或历史页进入的下载页滑入；右滑时底层为来源页；返回来源页后锚点、草稿、展开状态、搜索词不变（截图前后坐标比较）；首页下载入口返回首页。
- 手动 R08–R13、R16 通过（A1、A2、A3、A4）；C04、C12、C13、C17 不回归。

**回归测试**

新增：Android `SettingsEntryInstrumentedTest`，并扩展 `SwipeBackInstrumentedTest`（设置 / 下载入场、取消、返回、聊天和历史页内下载返回来源页）；iOS `testSettingsPageOrderAndSingleHostMenu`、`testSettingsAndDownloadsSwipeBack`、`testChatDownloadsReturnToSameChat`、`testHistoryDownloadsReturnToHistory`。

需改写的既有用例：
- 胶囊不再是按钮：iOS `testHomePublishesCompleteSnapshotsWithoutReturningToLoading` 中的 `app.buttons["home-connection-pill"]`（`OrbisUITests.swift:201`），以及首页状态胶囊相关的断言；Android `HomeLoadingInstrumentedTest` 中的 `home-connection-status`。
- 入口与标题：iOS `testBasicConnectionStatusAndDirectoryProviderMismatch`（对话框按钮与页面标题）、`testPageScreenshotsInBothAppearances`（`status` 期望标题）、`testFixedRoutingAndStatusProviderSwitch`、`testCompactQuotaCardsAndTransparentSwitch`；Android `StatusScreenTest`、`SubscriptionQuotaInstrumentedTest`、`ProviderSelectionInstrumentedTest`。

改写只能更新入口、角色和标题，不能放宽原有的位置与状态断言。

**范围外**

不恢复旧设置页或连接优先级；不改供应商卡、配额币和切换菜单的视觉与交互（S19）；不改配对流程本身（扫码、粘贴载荷、首次引导页）；不改下载页内部的卡片交互（S20）；连接胶囊的状态表达不变（S18）。

**已确认的决策（2026-10-30）**

1. 连接胶囊只显示状态，不再进入设置页；进设置只靠右上角齿轮。
2. 目录筛选菜单和 provider 不匹配对话框的入口保留，改名为“设置”。
3. 聊天页和历史页内的下载页同样滑入、右滑返回，返回来源页。
4. 两端设置页都去掉“已配对电脑”切换区。

---

## UI-05：Android 首页下拉刷新

**ID / 平台**：M15（Android 部分），关联 S18、V18、V21；Android。iOS 已有，需核对一致性。

**Expected behavior**

- 首页会话列表在顶部时下拉触发刷新，逻辑与失败重试相同：已连接时刷新会话目录、Host 模型和全部 Runtime 模型；未就绪时重连（`HostConnection.refreshHome`，`HostConnection.kt:323`）。
- 指示器在请求发出后收起；进度和失败仍由连接胶囊或列表空态表达，不新增状态行。刷新期间保留上一版完整快照与视口。
- 多选、左滑关闭和抽屉拖动期间不触发。只有首版快照前（列表为加载 / 失败空态）时也允许下拉，等同于点“重新加载 / 重新连接”。

**Actual behavior**

Android r16 已添加 Material3 下拉标识和刷新请求，但列表内容没有随手指向下位移；用户反馈 iOS 原生刷新会带动整个列表。iOS 为 `.refreshable { store.refresh() }`（`ContentView.swift:514`）。

**建议实现**

保留现有 Material3 `pullToRefresh` 手势状态，在 `LazyColumn` 上按 `state.distanceFraction × PullToRefreshDefaults.PositionalThreshold`（默认 80dp）应用图层 y 位移，使列表与 iOS 一样随手指下移。图层位移不能改变列表测量尺寸或滚动锚点；请求发出后列表与指示器回到原位，刷新进度仍由现有连接胶囊 / 列表空态表达。验证时覆盖卡片竖拖、多选、左滑关闭、右滑打开抽屉和抽屉拖动，确保方向判定互不抢占。

**Acceptance criteria**

- 按住顶部下拉时首卡 y 随手指至少移动 20px；松手后回到原 y（容差 1dp），并且 `refreshHome` 恰好调用一次；不在顶部、多选中、左滑 / 右滑中都不触发刷新；卡片点击与抽屉 / 关闭手势保持工作；断开时触发重连。
- 手动 R14 通过（A1、A2、A3、A4）；C02、C03、C09、C10 不回归。
- 两端行为对照记录：iOS 的触发条件与指示器收起时机一致，或在 ADR-0051 中登记平台差异。

**回归测试**

更新 `HomeViewportInstrumentedTest#pullingAtTheTopMovesTheListAndRestoresItsPositionAfterRefresh`，新增 `darkThemePullMovesAndRestoresTheWholeList`；保留测试对非顶部、多选、刷新调用次数的既有断言，并加拖动位移、松手复位、卡片点击和右滑抽屉 / 左滑关闭覆盖。需跑的既有用例：`HomeLoadingInstrumentedTest`、`HomeNavigationInstrumentedTest`、`HomeSwipeCloseInstrumentedTest`、`HomeSelectionInstrumentedTest`，以及全量。L1–L4 与手动 R14 未完成前，不标为已验收。

**范围外**

不改 iOS 现有实现（对照发现不一致时，在 ADR-0051 登记平台差异，或另开 ticket）；不在目录抽屉中加下拉刷新；不新增状态行或文字提示。

---

## UI-06：聊天页与历史页点击下载时，文件飞入右上角下载按钮

**ID / 平台**：M16（新增），关联 M02、M14、V02–V03、V18；iOS、Android。依赖 UI-04 新增的历史页下载按钮。

**Expected behavior**

在聊天页或“历史与分支”页点击会创建下载任务的入口后，一个文件图标从点击位置飞向同页顶栏的下载按钮，按钮轻弹，角标按实际任务数更新。入口包括：
- 文件产物卡：iOS `ChatView.swift:693`，Android `ArtifactCard`；
- Markdown 文件链接：iOS `MarkdownMessage` 的 `openURL` → `transfers.download(path:)`，Android `MarkdownText` 的 `downloadFile`；
- 历史页里的同类入口：iOS 历史预览复用 `ChatMessageRow`（`HistoryBranchView.swift:105`），Android `HistoryTreePage` 的 `downloadArtifact` / `downloadFile`（`HistoryTreePage.kt:91`）。初始参数见 ADR-0046 §7：28 → 16pt/dp，沿上弯贝塞尔路径飞行 520ms，末 80ms 淡出，按钮 380 / 18 弹簧 1 → 1.12 → 1，同时最多 3 个；减少动画时只 160ms 高亮按钮。

**Actual behavior**

点击后只把任务加入下载列表，并更新角标（Android `DownloadStatusButton`，`MainActivity.kt:2407`）。iOS `FileTransfers.download` 没有返回值（`FileTransfers.swift:258`），调用方无法知道是否真的创建了任务：未连接时只写入错误文案。历史页顶栏目前没有下载按钮，点击下载后页面上看不到任何反馈。

**建议实现**

- 下载 API 返回“是否创建 / 排队了任务”（iOS 返回任务 id 或 nil；Android `downloadFile` / `downloadArtifact` 同理）。只有成功时才起飞。
- 页面级飞行层：做成聊天页与历史页共用的组件。iOS 在 `ChatView` 与历史页顶层的 `overlay` 中各放一个不参与命中测试的 `FlightLayer`；下载按钮用 `anchorPreference` / `onGeometryChange` 上报全局坐标；起点来自点击位置。Android 用页面根部的 `Box` 叠层，按钮用 `onGloballyPositioned` 上报坐标；起点来自 `pointerInput` 记录的按下位置，或卡片的 `boundsInRoot`。
- 拿不到精确点击坐标时（iOS `OpenURLAction` 不带坐标），先用 `SpatialTapGesture` 的同时识别记录最后一次点击位置；仍然拿不到时，用链接所在行或卡片的中心。
- 飞行期间不改变布局、阅读锚点和 `following`；离开聊天、切换会话、进入下载页或进入后台时立即取消；不能在别的页面残留浮层。

**Acceptance criteria**

- 设备测试（聊天页、历史页各一组）：起点接近点击点，终点为本页下载按钮中心（容差 4pt/dp）；未创建任务时不起飞；同时飞行不超过 3 个；减少动画时不飞；飞行期间阅读锚点坐标不变，且飞行层不拦截对下方内容的点击。
- 帧序列复核：路径、缩放、淡出、按钮轻弹（A1、A2），参数终值回写 ADR-0051 M16。
- 手动 R15、R16 通过；C05、C13，以及 UI-04 的聊天 / 历史页下载返回不回归。

**回归测试**

新增：Android `DownloadFlightInstrumentedTest`（含历史页）；iOS `testDownloadFlightStartsAtTapAndEndsAtButton`、`testHistoryDownloadButtonAndFlight`；单元测试覆盖“仅成功创建任务时触发”。需跑的既有用例：`MarkdownInstrumentedTest`、`DownloadFileBrowserInstrumentedTest`、`DisplayScenariosInstrumentedTest`、iOS `testDownloadCardsPauseResumeAndSelectWithoutSideButtons`、`testHistoryPreviewAndNavigation`，以及全量。

**范围外**

只在聊天页和历史页起飞；首页、下载页和文件浏览器里发起的下载不飞。不改下载任务语义、下载页卡片和角标计数规则。历史页下载按钮本身及其返回导航在 UI-04 的 4C 中实现。

**风险**

- 弹簧轻弹会改变按钮的视觉尺寸，但不能改变布局尺寸或命中区（用 `scaleEffect` / `graphicsLayer`）。
- iOS 历史预览区限高 160pt（`HistoryBranchView.swift:107`），预览内的下载入口可能部分可见。起点取实际点击位置；拿不到坐标时取入口可见部分的中心，不能取到预览区外。
