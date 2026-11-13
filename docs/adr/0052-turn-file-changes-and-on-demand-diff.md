# ADR-0052：轮次文件变更概况与按需差异查看

日期：2026-10-30

Status: accepted（2026-10-30 Host / 协议 / 双端初版已实现，实际范围与验证见 §9；真实各后端端到端及真机验收未完成）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)、[ADR-0045](0045-tool-summaries-and-on-demand-content.md)、[ADR-0046](0046-mobile-ui-stability-and-material.md)、[ADR-0048](0048-online-chat-entry-budget.md)。

## Context

轮末展示文件变更概况，详情按需查看；概况、文件切换与阅读保持清楚连贯。

概况与文件清单使用已同步元数据，详情随显式查看按需读取。

ADR-0045 的工具详情与轮次文件净变化分属不同领域，Host 统一形成轮次概况并保留来源。

当前方向是 **Host 保存有明确来源的轮次记录，App 按需查看 diff**。2026-11-01 起接入 Codex / Codex Desktop 的原生文件变更：这两条路径使用原生轮次 tracker 发布的聚合 diff；Pi / Claude / DSH 继续采用 Host 工作区前后快照。结果明确标注实际来源及其覆盖状态。统一分页、持久化与保留策略仍由 Orbis 定义；当前修订及未完成验收见 §9.1。

### §1 后端能力核对

仓库核对基线为 `375078cbbd9d7b3299ade6b24867ec5e8b3c65f1`。本 worktree 从该提交创建，未包含主工作区未提交的其他功能。下表保留**实施前**的上游能力与接入缺口，当前实现见 §9；“上游有字段/路由”不表示已在当前运行进程验证，也不表示覆盖任意写文件途径。

| 后端 / 集成路径 | 已确认的原生能力 | 实施前 Orbis 接入与缺口 | 本方案采用的来源 |
| --- | --- | --- | --- |
| Codex `codex` | app-server 的 `fileChange.changes` 提供 `path/kind/diff`；`turn/diff/updated` 提供该轮 tracker 已记录的最新聚合 unified diff。tracker 基于实际提交的 `apply_patch` 内容增量，不依赖 Git，也不代表工作区全部变更。[S1][S5] | 已接收 `fileChange` item，并转成工具摘要及按需工具内容；尚无 Host 自有的轮次前后版本记录。[R1] 原生通知能否在首笔写入前建立采集屏障需验证。 | Host 快照和统一差异服务；adapter 提供实际轮次边界、已知写入路径及归属。 |
| Codex Desktop `codexDesktop` | 同一 app-server 协议族，但来自 Desktop 所使用的 daemon。[S1] | 与终端路径共用 `CodexRuntime`，是独立 agentKind/连接。Desktop 附着时机、daemon 版本和执行前边界仍待验证。[R1] | 同一 Host 快照服务；电脑端直接开始且无法取得可靠起点时明确标为部分记录。 |
| Pi `pi`，锁定依赖 0.84.4 | `edit` 的结果含 `details.diff` 和标准 `details.patch`；`write` 不返回完整前后差异。扩展提供输入、运行、内部 turn、工具执行事件。[S2] | 已投影工具和 turn 事件，尚无完整轮次文件清单；单次 edit patch 不覆盖 write、shell、扩展自定义工具和多次修改的净结果。[R2] | 同一 Host 快照服务；扩展提供执行前边界、候选路径和工具归属。 |
| Claude Code `claude`，官方 TUI + Mods | Mods 有 `turn.start`、`turn.complete`、`tool.call`。原生 checkpoint 会记录文件编辑工具修改，但官方说明仅由 Bash 修改的文件不一定被跟踪；已查 Mods reference 未提供可直接复用的完整轮次 diff 读取契约。[S3] | 当前 mod/bridge 传递轮次和有界工具参数/结果，未提供文件概况。当前执行前回调顺序还需调整并验证。[R3] | 同一 Host 快照服务；Mods 提供执行前边界、候选路径和工具归属。 |
| DeepSeek Harness `dsh`，默认 Web 路径，0.1.7-rc.1 | **已有轮次概况及按文件读取能力**：`workspace/changes` 事件关联 summary；认证 GET `/api/changes.summary` 和 `/api/changes.diff` 分别返回摘要与指定文件比较。[S4] | 当前 `dsh-web-runtime` 未消费该域；Host 自有采集需验证 Web 运行边界和执行前协调方式。[R4] | 同一 Host 快照服务；首版不新增原生 summary/diff HTTP 读取依赖。 |
| DSH 旧 ACP 路径 | 仓库保留的兼容/测试 adapter 接收工具事件，没有已接入的轮次变更域。[R4] | ADR-0020 的默认路径为 Web，详情失败沿原路径报告。 | 不作为首批交付路径；若仍启用，能力明确为 unavailable，或单独验收 Host 采集。 |

DSH 原生能力有三个已确认的限制。以下解释统一 Host 口径的原因，**不作为当前 Orbis 快照接口的限制或依赖**：[S4]

1. summary 文件项只有路径、行数及 binary/oversized 标记，**没有新增/修改/删除/重命名枚举和前后存在性**；文本 diff 才有 `before/after`。Host 自有清单直接根据捕获的前后版本计算这些字段，不靠预取原生 diff 或正负行数推断类型。
2. 默认最多列出 500 个文件，`total` 可以大于已列出的数量，原接口没有后续文件列表分页。Host 自有清单采用自己的预算与分页，不继承此原生上限。
3. 摘要和比较随原生 Session 在服务进程中的生命周期存在；服务重启/Session disposal 后可能只剩日志事件。无 Git 时仅覆盖文件工具路径，Git 路径也会计入该时间窗的外部修改；不能宣称无限历史保留或严格 Agent 因果归属。

初版选择“Host 自有轮次前后版本 + 同一差异引擎”。2026-11-01 的 §9.1 取代其中 Codex 两条路径的数据源；上表保留初版决策背景，不能据其“Host 快照”列推断 Codex 当前采集行为。

## Decision

### §2 定义轮次与统计口径

顶层助手轮次使用稳定身份，以已确认起点和终点的净变化统计文件；原生工具归属与工作区时间窗观察分别声明，覆盖限制随结果保存。

工作区快照只把已确认变化的文件计入概况和清单。扫描截断造成的单侧缺席或文件读取失败不构成变更证据，仍以 partial / reasons 保留采集缺口；双侧已捕获的真实变化继续展示。实现和扫描截断回归见 [TurnFileChangeService](../../packages/host/src/turn-file-change-service.ts) 及[测试](../../packages/host/src/turn-file-change-service.test.ts)。

### §3 Host 统一采集、保存和计算

Host 统一管理轮次、冻结版本、差异计算与保留。Codex 使用已接收的原生轮次 diff，其他后端保存有界起止快照；来源缺失按 partial / unavailable 表达。读取固定版本，采集和比较保持工作区原状并受预算约束。

实现入口为 TurnChangeCoordinator 与 TurnFileChangeService；首版文本比较使用固定依赖 jsdiff 9.0.0 的 diffLines。DSH 原生 summary / diff 尚未接入。

### §4 同步契约：概况与清单只含元数据

changes 域与聊天轮末引用同步概况，文件清单按固定版本分页；详情由独立读取服务管理。显示归属、来源 revision、完整性和本地应用水位各自明确，轮末审阅随所属分支和稳定锚点交接。

| 对象 | 必需信息 | 规则 |
| --- | --- | --- |
| `TurnChangeSummary` | 轮次、变更集、版本和显示锚点，状态、统计及 manifestRef | collecting/finalizing/ready/unavailable；coverage、scope、attribution、reasons 独立表达，未知数量为 null |
| `FileChangeMetadata` | fileId、排序、显示路径、变更类型、文件类型、行数及 detailRef | 元数据描述已知文件事实，binary / oversized 的行数为未知 |
| `ChangeManifestPage` | 变更集身份、固定 `manifestVersion`、有界文件项、总数/已记录数、`nextCursor`、完整性 | 页属于同一版本；超限/来源截断有明确原因。只有覆盖完整的固定版本才能按缺席删除旧项。 |
| `FileDiffReference` | 变更集、文件、固定 contentVersion、格式及保留范围 | 引用 Host 冻结版本，读取由独立服务验证与管理 |

参考：[ADR-0064](0064-protocol-compatibility.md)。

### §5 详情只由用户查看触发

详情按当前选中文件显式读取，固定变更集、内容版本与范围，使用服务端 UTF-8 cursor 续页。查看器按生命周期取消和复用有界缓存，迟到响应按身份隔离，读取仅面向请求设备。

设备私有接口为 session.changes.list/read 和 session.change.detail.read/cancel，readId 为 null 时打开。Android 缓存限本次查看器，iOS 可在同会话重开已缓存范围；未缓存内容需连接。

### §6 App 展示与动效

轮末概况复用紧凑工具块，文件名保留识别片段与扩展名，未知统计按实际覆盖呈现。详情即时打开并维护固定文件清单，通过共用横向切换与标题区关闭交互阅读；选中文件落位后调度内容，系统减少动画沿用统一降级。

### §7 生命周期、预算与访问边界

采集、存储、清单和详情按独立预算及所有权管理，读取经过设备与 Session 归属验证。超限和来源缺口随 coverage / reasons 与详情状态呈现，资源上限及保留策略见下表与实现。

| 资源 | 初始预算 / 策略 |
| --- | --- |
| 聊天内嵌概况 | 最多 4 个文件；生成预览时按 8 KiB 收缩，完整 summary schema 硬上限 12 KiB，为来源 ID / coverage 更正留空间。 |
| 元数据页 | 文件页至多 100 项，摘要列表页至多 128 轮，完整响应 JSON ≤60 KiB；每轮清单最多 20,000 文件 / 24 MiB（包含比较记录），差异索引另限 8 MiB。截断会标为 partial，fileCount 是实际记录数量。 |
| Host 基线采集 | 20,000 条目 / 256 MiB 读取量 / 4 MiB 路径 JSON，单文件 2 MiB；扫描及边界等待各 2 秒，未完成采集最多 32 轮。覆盖按实际完成情况表达。 |
| Host 私有保留 | 元数据最多 64 MiB / 512 轮 / 30 天；去重内容最多 512 MiB / 7 天。活跃采集、比较和读取租约受保护，预算不足的新内容为 not-captured。清理只触及私有记录和 blob。 |
| 差异计算 | 2 个 worker；每文件 100 ms、20,000 edit length；worker 墙钟 1 秒、old generation 96 MiB；每侧 100,000 换行。每轮调度 10 秒，超限返回 busy / too-large，未知行数为 null。 |
| 详情页与并发 | 每页原文 ≤48 KiB，完整 JSON ≤60 KiB；iOS 请求 32 KiB，Android 请求 48 KiB。每查看器 1、每设备 2、Host 全局 4 个实际在途详情任务，超额 busy；取消后正在收尾的 I/O 仍占名额。 |
| 本地详情读取 | 捕获 blob 每侧 ≤2 MiB；单文件 unified diff 有界分页，渲染缓存 ≤16 MiB；取消按读取任务生命周期收尾。 |
| 读取租约与 App 缓存 | 30 秒空闲租约只结束 GC 保护；身份绑定有界保留（全局 256 / 每设备 64），同身份可续读旧 readId。绑定丢失时客户端同 cursor 清 readId 重开一次，真正内容过期则停止。Android 每文件 2 MiB、查看器总计 8 MiB，非当前文件按首次访问顺序淘汰；iOS 最多 12 个已访问文件、正文合计 8 MiB，按最近访问淘汰。缓存为内存，不保证杀进程后离线恢复。 |

### §8 实施顺序与验收

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

### §9 初版实现、接入与剩余验收

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

### §9.1 2026-11-01：Codex / Codex Desktop 原生轮次记录（验证中）

Codex / Codex Desktop 已改用原生轮次记录；Pi / Claude / DSH、SQL 及已冻结快照沿用原来源。当前修订取代初版的 Codex 起止快照数据源。

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。

## Alternatives and consequences

- **所有后端无差别使用原生 diff**：统计范围、字段、失效条件和 shell 覆盖各异，不采用。§9.1 仅接入 Codex 两条路径，并显式标明文件工具范围。
- **自行编写基础差异算法**：本项目需要掌握的是轮次采集、历史版本和按需服务；基础文本比较优先复用成熟库，避免额外维护算法边界。
- **将全部 diff 随轮次同步**：手机不用再请求，但流量随完整变更体积增长，违背按需要求，也重新引入 ADR-0045 已处理的共享状态膨胀。
- **App 下载工具结果后汇总**：重复后端语义、多次修改易重复计数，仍需传输全部原文；不采用。
- **每轮结束执行 `git diff HEAD`**：不能排除用户原有改动、不能冻结历史，还漏掉未跟踪/非 Git 文件；不采用。
- **仅记录工具路径或仅用 watcher**：可以做候选集，不能保证前后内容、shell 覆盖和最终净变化；作为局部证据而非完整统计。
- **滑动前自动预取邻文件**：可能更快显示下一页，但用户未查看也产生详情流量；首版禁用，轻量页面外壳和已读缓存负责动效连续性。

方案将带宽成本限制为元数据及用户实际查看的内容，换取所有后端一致的统计、渲染契约和保留策略。代价是 Host 需要承担有界采集、差异计算和历史内容存储；可靠的轮次前后边界仍须逐个 backend 验证。无法精确归属外部并发修改，也不能恢复从未捕获或已淘汰的旧内容；这些限制进入模型和界面。

## 调研档案

### A.1 Codex 官方源码的实际实现

2026-10-30 补充核对官方开源仓库 `openai/codex` 的提交 `582a8812e023b08cbf10b4603ac41644b8d99261`；同时读取 `rust-v0.154.0` tag 的 `turn_diff_tracker.rs`，两份文件字节相同，SHA-256 为 `743fbb96d27381a68d59f3ed49c7fd0d6e2fccc448a20579a7aa3d850fb3dda1`。这是源码核对，没有运行上游测试，也不证明用户当前 Desktop 所带二进制恰好为该版本。[S5]

1. **记录实际修改，不扫描整仓库。** `apply-patch/src/lib.rs` 在文件操作成功后产生 `AppliedPatchDelta`：新增含新内容及被覆盖内容，删除含旧内容，修改含旧/新内容和可选移动路径。后续 hunk 失败时仍返回此前实际提交的增量；无法精确描述时 `exact` 为 false。tracker 处理这些提交结果，而非仅记录模型提议的 patch。[S5]
2. **轮次内保存起点与最新结果。** `TurnDiffTracker` 用 `baseline_by_path` 保存该文件首次受跟踪修改前的内容，`current_by_path` 保存最新已提交内容；多次修改合并成净文本差异。它不为每个文件在轮次刚开始就读取快照，也不再次读取当前工作区来生成结果。`session/turn.rs` 在一次用户可见工作轮次内复用同一 tracker，覆盖其中多个模型步骤。[S5]
3. **Git 格式不是 Git 执行。** `render_diff` 调用 Rust `similar::TextDiff::diff_lines`，上下文半径 3 行、计算预算 100 ms；自行生成 `diff --git`、`index`、`/dev/null` 等头部及 Git blob SHA-1。代码路径没有调用 `git diff`、创建提交或要求存在 `.git`。按文件内容 revision 缓存已渲染差异，重复编辑仅重新计算变化文件。[S5]
4. **发布的是聚合正文。** `tools/events.rs` 更新 tracker 后发送 `EventMsg::TurnDiff`，app-server 的 `handle_turn_diff` 将它映射为 `turn/diff/updated { threadId, turnId, diff }`；`diff` 是该轮当前聚合的完整字符串，不是文件元数据或按文件分页。Orbis 仍需在 Host 拆分、保存并计算清单，然后只向手机发送元数据及被请求的单文件范围。[S5]
5. **不能将聚合文本当作全量文件事实。** 该 tracker 消费 `apply_patch` 已提交增量；shell 中可识别的 `apply_patch` 可以被截获到同一路径，任意 Python、sed、编译器或 MCP 写文件并不因此自动进入 tracker。首次受跟踪修改前发生的其他写入也不会凭空成为本轮起点；首次修改后的 shell-only 更新不会使 tracker 自动重读最新文件。[S5]
6. **空 diff 和重命名有额外语义。** 上游测试 `pure_rename_yields_no_diff` 明确断言只改路径、内容不变时不产生聚合文本；`left_content == right_content` 会提前返回。`exact == false` 会 invalidate 整个 tracker，原先已有 diff 时事件层可发空字符串清除。因此空 diff 可能是净文本变化为零，也可能是记录失效；只凭空字符串无法证明“本轮没有文件变更”。文件类型/移动元数据和来源完整性必须另外核对。[S5]

Codex 还有另一套 `/diff` 工作区功能：`tui/src/get_git_diff.rs` 检查仓库并执行 `git diff`，再枚举非忽略的 untracked 文件，通过 `git diff --no-index` 对空侧生成差异。它反映当前工作区相对 index 的状态，与上述按执行结果记录的轮次 diff 是两套入口。[S6] 本次只确认公开 core/TUI/app-server 路径，未确认 Desktop 私有前端审阅面板的内部实现，不能把两者混为同一功能。

实现中的数据结构和调用链进一步记录如下，供后续 adapter 对照，均对应上述固定提交：[S5]

| 阶段 | 具体对象 / 函数 | 行为 |
| --- | --- | --- |
| 实际写入 | `apply_patch_with_options` → `AppliedPatchDelta` | 保存已提交的 Add/Delete/Update，含前后文本、移动目标以及被覆盖的旧内容；补丁失败也保留此前成功的部分。 |
| 文件身份 | `TrackedPath { environment_id, path }` | 不同执行环境中的同名路径分别跟踪，不能只用本机绝对路径作为文件身份。 |
| 起点 / 当前值 | `baseline_by_path` / `current_by_path` | 首次受跟踪写入时取得旧值，后续只替换当前值；新增文件的旧侧不存在，删除文件的当前侧不存在。 |
| 移动关系 | `origin_by_current_path` | 保留当前路径对应的原始路径，用于合并移动链；纯移动的文件事实仍须结合结构化 item。 |
| 差异缓存 | `DiffCacheKey` / `rendered_diffs` | 缓存键包含左右路径及各自内容 revision；未变文件复用结果，变化文件调用 `render_diff`。 |
| 本轮聚合 | `track_delta` → `refresh_unified_diff` | 检查增量的精确性，更新文件状态，按显示路径排序，合并各文件 diff，替换当前聚合字符串。 |
| 对外通知 | `emit_patch_end` → `EventMsg::TurnDiff` → `handle_turn_diff` | app-server 发布 `turn/diff/updated`，携带 thread、turn 和聚合正文；模型步骤完成路径也会发送现存聚合结果。 |

这里的净变化可用一个例子说明：文件首次受跟踪修改前为 A，同轮先改成 B 再改成 C，最终生成 A→C；如果又恢复为 A，则文本差异消失。已经在轮次之前存在于 A 中的未提交修改不会因为相对 Git HEAD 有差异而被再次统计。若本轮在首次受跟踪修改之前还有 shell 写入，则 A 已包含那次写入，其更早状态无法由该 tracker 反推。[S5]

以上最初用于评估原生方案；2026-11-01 §9.1 已采用这条原生轮次通知作为 Codex 的有限来源。上游实现核对仍只证明该固定版本，不自动证明用户当前 Desktop 二进制或全量写入覆盖。

### A.2 打开文件差异后的显示实现与 Desktop 比较范围

差异的**采集、计算、显示**分属三层。生成 Git 格式文本既不等于执行 Git，也不等于由 Git 绘制界面；查看器可以展示来自轮次记录或 Git 工作区比较的内容。

公开 TUI 的显示链路已经核对：[S7]

1. `diff_model.rs` 定义用于显示的 `FileChange::Add/Delete/Update`。`PatchHistoryCell` 保存文件变更与 cwd，分别调用 `create_diff_preview_with_links` 和 `create_diff_summary_with_links` 生成紧凑预览与完整显示行；这是文件修改活动的展示入口，不证明它与 Desktop 查看器使用同一组件。
2. `diff_render.rs` 实现文件标题、汇总增删数、移动路径、行号、`+/-` 标记、增删背景、主题适配和按可用宽度换行。Update 使用 `diffy::Patch::from_str` 解析 unified diff 的 hunk，按插入/删除/上下文推进旧、新行号；Add/Delete 从相应内容生成显示行。最终交给 `ratatui` 的文本、布局和绘制组件。
3. 语法高亮通过 Codex 的 `render/highlight.rs` 包装 `syntect` 与 `two_face`；按 hunk 连续处理以保留该块内的词法状态，并对过大输入退回普通文本。这里是 Codex 编排的渲染层和现成库组合；基础 diff、解析、高亮和终端组件并非全部从零实现。

Desktop 需要另外区分**用户当前选择的比较范围**。官方文档于 2026-10-30 说明：review pane 要求项目位于 Git 仓库，默认显示 Unstaged；还可以选 Staged、Commit、Branch 或 Last turn。该面板可以包含用户本人及其他程序的工作区修改，不能笼统理解成仅展示 Codex 的本轮写入。[S8]

| Desktop 选择范围 | 已公开说明的含义 | 本次可确认的实现边界 |
| --- | --- | --- |
| Unstaged / Staged / Commit / Branch | 对应工作区、index、选定提交或基准分支的 Git 状态/差异 | 文档确认 Git 比较语义；具体 Desktop 内部调用和渲染组件未由本次公开资料确认。 |
| Last turn | 最近一轮助手修改；多仓库项目可跨已附加仓库查看 | 公开 core/app-server 已有上节轮次 tracker 和通知；Desktop 怎样映射、补齐与缓存该视图仍需单独证据，不能只凭同名功能断言完全相同。 |

公开实现边界：公开 TUI 确实有 Codex 自己的差异展示层，并复用 `diffy`、`ratatui`、`syntect` 等库；Desktop 的比较范围由官方文档说明，但其具体查看器组件没有在本次核对中得到确认，不能据 TUI 推断为某个 Desktop/Monaco/其他组件。

这些显示资料作为历史调研保留。当前 Orbis 的采集、计算与 UI 契约由本 ADR 的 Decision 定义，首批比较范围固定为“本轮”；如以后增加 Git 工作区审阅，应作为带明确基线的新 scope 表达。

## Evidence

以下公开资料于 2026-10-30 读取；版本固定的源码用于证明该版本的契约，动态文档不替代实施时的版本探针。没有检查私有桌面数据库或逆向原生程序。

- **[S1] Codex**：[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)，从原 `developers.openai.com/codex/app-server` 重定向；核对 turn notifications、Items 和 fileChange 增量说明。仓库 [0.154.0 协议快照](../../packages/host/src/codex-native-file-review.test.ts) 另列 `item/fileChange/patchUpdated`；官方文档说明旧 `outputDelta` 已不再由当前 app-server 发出，不能以它作为 diff 来源。
- **[S2] Pi 0.84.4**：[edit 类型/实现](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/tools/edit.ts)、[write 实现](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/src/core/tools/write.ts)、[扩展事件文档](https://github.com/earendil-works/pi/blob/v0.84.4/packages/coding-agent/docs/extensions.md)；仓库 package-lock 与本机该依赖版本一致。只证明已检查的内置工具及扩展契约，不推断所有自定义工具。
- **[S3] Claude**：[Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)、[Checkpointing](https://code.claude.com/docs/en/checkpointing)。当前 TUI 集成约束及已验证 CLI 版本见 [ADR-0033](0033-claude-code-tui-mods-integration.md)。
- **[S4] DSH 0.1.7-rc.1**：[workspace-changes 说明与限制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/deliverables/workspace-changes/README.md)、[summary/diff 类型](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/deliverables/workspace-changes/src/types.ts)、[认证路由及参数](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/client/ui-deliverables/src/changes.ts)。核对 tag 对应提交 `46a7f68b0922371ce7144b668b90e377d8e799f4`。DSH 文档中的 Host 指原生服务进程，与 Orbis Host 的生命周期须分开。
- **[S5] Codex 轮次 diff 源码**：固定提交 `582a8812e023b08cbf10b4603ac41644b8d99261` 的 [TurnDiffTracker](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/core/src/turn_diff_tracker.rs)、[tracker 测试](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/core/src/turn_diff_tracker_tests.rs)、[实际提交增量](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/apply-patch/src/lib.rs)、[工具结果和事件发布](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/core/src/tools/events.rs)、[shell 中 apply_patch 的截获](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/core/src/tools/handlers/apply_patch.rs)、[轮次生命周期](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/core/src/session/turn.rs)、[app-server 通知映射](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/app-server/src/bespoke_event_handling.rs)；对照 [rust-v0.154.0 的 tracker](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/turn_diff_tracker.rs)。
- **[S6] Codex 当前工作区 diff 源码**：[get_git_diff.rs](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/tui/src/get_git_diff.rs)，对应 TUI `/diff`，不用于证明 Desktop 私有前端的实现。
- **[S7] Codex TUI 差异显示源码**：同一固定提交的 [diff_model.rs](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/tui/src/diff_model.rs)、[history_cell/patches.rs](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/tui/src/history_cell/patches.rs)、[diff_render.rs](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/tui/src/diff_render.rs)、[render/highlight.rs](https://github.com/openai/codex/blob/582a8812e023b08cbf10b4603ac41644b8d99261/codex-rs/tui/src/render/highlight.rs)。这些文件证明 TUI 的展示模型、预览、差异解析、绘制与高亮路径，不证明 Desktop 内部组件。
- **[S8] Codex Desktop 差异面板行为**：[官方 Code review 文档](https://learn.chatgpt.com/docs/code-review?surface=app) 的 Review in the app、What changes it shows、Review multiple repositories 与 Navigating the review pane；证明 Git 前提和各比较范围的用户语义，不作为私有实现源码证据。
- **[S9] 文本差异库候选**：[jsdiff 官方 README](https://github.com/kpdecker/jsdiff/blob/master/README.md) 的 `diffLines`、结构化 hunk API 与计算上限选项。这里只确定复用成熟文本差异库的方向；最终直接依赖版本、换行/空白选项及字节保持需在实现中固定并验证。
- **[R1] Codex 接入**：[codex-runtime.ts](../../packages/host/src/codex-runtime.ts)、[codex-tool-projection.ts](../../packages/host/src/codex-tool-projection.ts)、[codex-desktop-lifecycle.ts](../../packages/host/src/codex-desktop-lifecycle.ts)。
- **[R2] Pi 接入**：[index.ts](../../packages/pi-extension/src/index.ts)、[pi-adapter.ts](../../packages/pi-extension/src/pi-adapter.ts)、[turn-timing.ts](../../packages/pi-extension/src/turn-timing.ts)。
- **[R3] Claude 接入**：[register.ts](../../packages/claude-mod/src/register.ts)、[claude-mods-bridge.ts](../../packages/host/src/claude-mods-bridge.ts)、[claude-transcript.ts](../../packages/host/src/claude-transcript.ts)。
- **[R4] DSH 接入**：[dsh-web-runtime.ts](../../packages/host/src/dsh-web-runtime.ts)、[dsh-web-history.ts](../../packages/host/src/dsh-web-history.ts)、[dsh-web-client.ts](../../packages/host/src/dsh-web-client.ts)、[dsh-runtime.ts](../../packages/host/src/dsh-runtime.ts)。
- **[R5] 现有统一模型与按需读取**：[agent-state.ts](../../packages/protocol/src/agent-state.ts)、[tool-content-service.ts](../../packages/host/src/tool-content-service.ts)、[display-entries.ts](../../packages/protocol/src/display-entries.ts)。
