# ADR-0052：轮次文件变更概况与按需差异查看

日期：2026-10-30

Status: accepted（2026-10-30 用户授权实施；Host / 协议 / 双端初版已实现，实际范围与验证见 §9；真实各后端端到端及真机验收未完成）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)、[ADR-0045](0045-tool-summaries-and-on-demand-content.md)、[ADR-0046](0046-mobile-ui-stability-and-material.md)、[ADR-0047](0047-deferred-chat-disclosure-content.md)、[ADR-0048](0048-online-chat-entry-budget.md)。

## Context

App 需要在每轮助手工作末尾显示文件增删改概况：先看到文件名、变更类型和增删行数，再通过“查看详情”打开独立页面，左右滑动查看同轮的其他文件。长文件名只能省略中间，保留开头和扩展名；切换文件必须有跟手和落位动效。

概况必须只依赖已同步的元数据。打开会话、显示概况、展开文件清单和构建相邻页面均不能下载 diff 或文件正文；详情只在用户实际查看某个文件时读取。否则一个包含大量文件的轮次会把桌面端的本地读取成本变成手机端的流量和首屏负担。

现有 ADR-0045 已将工具摘要与原文分离，但“某次工具的参数/结果”不等于“本轮各文件的最终变化”：同一文件可能经过多次 edit、write 或 shell 修改，也可能改完后恢复。不能让 App 下载全部工具内容、解析后端格式再自己汇总。

当前方向是 **Host 统一保存本轮前后文件版本、计算元数据和提供按需 diff，App 实现类似 Git 审阅的显示效果**。各后端提供轮次生命周期和候选路径；现有原生 diff 能力保留为调研记录，不作为本功能的默认数据源。统一口径和保留周期由 Orbis 自己定义。

### §1 后端能力核对

仓库核对基线为 `375078cbbd9d7b3299ade6b24867ec5e8b3c65f1`。本 worktree 从该提交创建，未包含主工作区未提交的其他功能。下表保留**实施前**的上游能力与接入缺口，当前实现见 §9；“上游有字段/路由”不表示已在当前运行进程验证，也不表示覆盖任意写文件途径。

| 后端 / 集成路径 | 已确认的原生能力 | 实施前 Orbis 接入与缺口 | 本方案采用的来源 |
| --- | --- | --- | --- |
| Codex `codex` | app-server 的 `fileChange.changes` 提供 `path/kind/diff`；`turn/diff/updated` 提供该轮 tracker 已记录的最新聚合 unified diff。tracker 基于实际提交的 `apply_patch` 内容增量，不依赖 Git，也不代表工作区全部变更。[S1][S5] | 已接收 `fileChange` item，并转成工具摘要及按需工具内容；尚无 Host 自有的轮次前后版本记录。[R1] 原生通知能否在首笔写入前建立采集屏障需验证。 | Host 快照和统一差异服务；adapter 提供实际轮次边界、已知写入路径及归属。 |
| Codex Desktop `codexDesktop` | 同一 app-server 协议族，但来自 Desktop 所使用的 daemon。[S1] | 与终端路径共用 `CodexRuntime`，是独立 agentKind/连接。Desktop 附着时机、daemon 版本和执行前边界必须单独验证。[R1] | 同一 Host 快照服务；电脑端直接开始且无法取得可靠起点时明确标为部分记录。 |
| Pi `pi`，锁定依赖 0.84.4 | `edit` 的结果含 `details.diff` 和标准 `details.patch`；`write` 不返回完整前后差异。扩展提供输入、运行、内部 turn、工具执行事件。[S2] | 已投影工具和 turn 事件，尚无完整轮次文件清单；单次 edit patch 不覆盖 write、shell、扩展自定义工具和多次修改的净结果。[R2] | 同一 Host 快照服务；扩展提供执行前边界、候选路径和工具归属。 |
| Claude Code `claude`，官方 TUI + Mods | Mods 有 `turn.start`、`turn.complete`、`tool.call`。原生 checkpoint 会记录文件编辑工具修改，但官方说明仅由 Bash 修改的文件不一定被跟踪；已查 Mods reference 未提供可直接复用的完整轮次 diff 读取契约。[S3] | 当前 mod/bridge 传递轮次和有界工具参数/结果，未提供文件概况。当前执行前回调顺序还需调整并验证。[R3] | 同一 Host 快照服务；Mods 提供执行前边界、候选路径和工具归属。 |
| DeepSeek Harness `dsh`，默认 Web 路径，0.1.7-rc.1 | **已有轮次概况及按文件读取能力**：`workspace/changes` 事件关联 summary；认证 GET `/api/changes.summary` 和 `/api/changes.diff` 分别返回摘要与指定文件比较。[S4] | 当前 `dsh-web-runtime` 未消费该域；Host 自有采集需验证 Web 运行边界和执行前协调方式。[R4] | 同一 Host 快照服务；首版不新增原生 summary/diff HTTP 读取依赖。 |
| DSH 旧 ACP 路径 | 仓库保留的兼容/测试 adapter 接收工具事件，没有已接入的轮次变更域。[R4] | ADR-0020 已将默认路径改为 Web，禁止因 Web 详情失败自动切换 ACP。 | 不作为首批交付路径；若仍启用，能力明确为 unavailable，或单独验收 Host 采集。 |

DSH 原生能力有三个已确认的限制。以下解释统一 Host 口径的原因，**不作为当前 Orbis 快照接口的限制或依赖**：[S4]

1. summary 文件项只有路径、行数及 binary/oversized 标记，**没有新增/修改/删除/重命名枚举和前后存在性**；文本 diff 才有 `before/after`。Host 自有清单直接根据捕获的前后版本计算这些字段，不靠预取原生 diff 或正负行数推断类型。
2. 默认最多列出 500 个文件，`total` 可以大于已列出的数量，原接口没有后续文件列表分页。Host 自有清单采用自己的预算与分页，不继承此原生上限。
3. 摘要和比较随原生 Session 在服务进程中的生命周期存在；服务重启/Session disposal 后可能只剩日志事件。无 Git 时仅覆盖文件工具路径，Git 路径也会计入该时间窗的外部修改；不能宣称无限历史保留或严格 Agent 因果归属。

当前修订选择“Host 自有轮次前后版本 + 同一差异引擎”。后端能力仍用于说明可否建立可靠执行边界、捕获哪些路径和确认工具归属；轮次摘要、覆盖范围与历史保留由 Host 统一声明。后文保留的 Codex 细节是调研档案，不再作为当前实现模板。

## Decision

### §2 定义轮次与统计口径

- “本轮”是用户可见的一轮顶层助手工作，包含其连续模型步骤和工具调用；从来源确认接受请求开始，到完成、失败或取消后相关写操作结束。不是整个 Session、相对 Git HEAD 的累计差异，也不是每次工具调用。
- adapter 产出稳定 `reviewTurnId`，关联原生轮次、用户 Entry 和最终显示锚点；缺少原生稳定 ID 时持久化与已接受顶层输入的映射，不用连接 ID 或每次加载新生成的随机值。Pi 内部 `turn_start/turn_end` 不直接各生成一张概况卡；需结合顶层输入与运行/settled 事件映射。新 follow-up 请求形成新轮次，steer 是否仍属本轮由原生来源确认。重试、压缩和重连不得重复建卡。[S2]
- 以本轮基线和终点的**净变化**计数：修改多次合成一项，新增后删除且最终不存在不计，原样恢复不计；删除后重新创建且内容变化记为修改。不能累加各次 patch 的 `+/-`。重命名有可靠证据时保留前后路径；否则作为删除和新增，不猜测配对。
- 整轮失败或取消仍可能留下真实修改，必须展示；被拒绝的提议不能当成已修改，失败工具的部分落盘也不能直接丢弃。运行结束后可短暂显示“正在统计”，不能为了凑清单拖延最终回复。
- 子 Agent 的文件变化仅在有父轮次关联或同一已声明工作区采集范围时纳入，避免重复计数。未确认的子任务/并发写入保留覆盖限制，不凭 cwd 相同认定属于该轮。
- 工作区前后比较只能证明时间窗变化。原生工具归属与工作区观察分别标记为 `native-tool`、`workspace-window` 或 `ambiguous`；同目录其他 Session、编辑器和用户同时修改时，显示“含同期工作区修改，归属未确认”。不将全部文件声称为“助手修改”。

### §3 Host 统一采集、保存和计算

增加 Host `TurnChangeCoordinator` 和 `TurnFileChangeService`。adapter 归一顶层轮次的开始、结束与显示锚点；Host 独立保存前后版本、识别净变化、计算元数据并提供详情。所有后端使用相同的比较算法、分页和保留策略。下文保留完整设计要求，已实现范围及路径补录等未完成部分以 §9 为准。

**前后版本是本功能的数据源。** 首版不接入 Codex 聚合 diff 或 DSH 原生 summary/diff 作为替代读路径；这些原生能力的差异不决定 App 行为。缺失起点时保留 partial/unavailable，不用原生 patch、当前文件或上轮终点补造一个完整的本轮基线。

Host 采集按以下流程工作：

1. **确定范围与前置屏障。** 从来源确认真实 cwd/工作区标识，复用已登记工作区，不修改用户分支或工作树。Pi/Claude 在经验证的执行前回调等待一次有界基线采集；工具写入前可补录此前未纳入范围的路径。现有 Claude `turn.start` 在 `next()` 之后通知 Host，不能直接作为可靠前置屏障。[R3] 新回调要保证 `next()` 只执行一次，采集失败不重放工具。
2. **保存实际起点。** 在 Host 私有内容存储中保存范围内文件存在性、类型、内容引用/摘要。Git 用于确定工作树边界、枚举跟踪及非忽略文件、识别 worktree；比较对象仍是当时磁盘内容，包含本轮前已有的 staged、unstaged、untracked 状态。不能用 `git diff HEAD`、两份 numstat 相减、`stash/reset/checkout` 或改写用户 index 来实现。
3. **覆盖执行途径。** Git 范围内有界起止扫描覆盖 shell 写入和文件工具写入，watcher 只提示候选变化、不充当旧内容备份。非 Git 目录采用同一有界文件清单/内容快照；忽略文件、范围外文件优先由明确的写工具路径在执行前捕获。中途首次捕获的路径注明观察起点，无法排除此前的写入时只报告局部覆盖；只看到工具结束事件或当前文件时，不能恢复删除文件的旧内容。
4. **结束核对并冻结。** 本轮已知写操作结束后，在下一轮写入前取得有界终点快照，再异步比较并冻结清单和两侧内容引用。保存成功后发布元数据；之后新轮次继续修改文件，不得改变旧轮详情。执行前/轮次间屏障均受采集预算限制，超时取消剩余采集并释放等待；后台写操作未结束、下轮已提前写入、快照期间文件持续变化或无法保持起止边界时降为 partial，并报告原因，不无限等待 Agent 或重放它的操作。
5. **独立恢复。** Host 采集的基线、终点和 manifest 写入私有持久存储并原子发布。已冻结内容在 Host 重启后仍按本地保留策略读取；中途重启不能从当前磁盘补造缺失起点，未完成采集显式转为 unavailable/partial。

原生仅推送 `turn/started` 等事后通知，不保证 Host 扫描早于第一笔写入。App 发起的立即执行请求可在实际分派前建立基线；排队/follow-up 请求必须在即将执行时建立基线，不能使用入队时的快照而混入前一轮修改。电脑端直接启动、运行中附着、Host 掉线期间的轮次若无可靠起点，则显示“仅记录接入后的变更”或不可用。事件接收时间和上轮终点均不自动证明本轮起点；两轮间的用户编辑也需要被排除。

默认范围排除 `.git` 内部、已知构建缓存和忽略的非源码目录，不递归进入子模块、嵌套仓库、符号链接目标或其他 worktree；显式文件工具路径按来源和权限单独纳入。子模块/链接自身作为特殊类型展示。非 Git 大目录也必须受扫描预算限制。任何排除、范围外 shell 修改、远程/容器路径不能映射、不可读文件或超限均体现在 coverage/reasons；“范围内完整”不等于整台机器完整。

直接采集原始文件字节，不运行仓库配置的外部 diff、textconv、Git clean/smudge filter 或 hook。这样既不改动用户仓库，也避免把格式转换后的内容当成实际修改。UTF-8 文本使用一致的行差异算法，保留 CRLF、末尾换行差异和“无末尾换行”标记；无法可靠解码、二进制、符号链接、子模块及超大文件仍有元数据，但不伪造文本行数。

Host 逻辑存储包含 `TurnRecord`（身份、起止边界、范围和完整性）、`SnapshotManifest`（路径到存在性/类型/内容摘要的映射）、`ContentBlob`（按内容去重的不可变字节）和 `FileComparison`（前后 blob、比较版本、变更类型、行数及差异段索引）。相同且已经核验的内容复用 blob；扫描的文件尺寸/mtime 只作提示，不能代替内容一致性证明。每轮有自己的 manifest，不反复复制整套工作树或构建缓存；起止核对仍受扫描 I/O 预算约束。

文件比较使用成熟的文本差异库，Host 自己实现轮次、版本、资源限额和服务契约。首版采用 Node `diff`（jsdiff）**9.0.0** 的 `diffLines`，作为 Host 直接依赖固定版本；使用行增删索引生成三行上下文的 unified diff，选项保留空白、CRLF、BOM 和末尾换行。[S9]单个 worker 内执行有界比较并校验结果，防止超大/极端文本阻塞 Host 事件循环；终止或超预算返回明确状态。首版只读审阅，不增加应用补丁、丢弃改动、暂存或回滚操作。

轮次结束先从两侧版本识别 A/M/D、计算增删行数并生成轻量差异段索引，再发布概况；同一比较结果用于行数与详情，不能各用一套算法。用户点开时才将该文件的索引和固定版本内容组织成三行上下文的 unified diff 并分页返回，必要时在 Host 有界缓存。**按需是手机详情传输和展示按需，不是点击前 Host 完全不做差异计算**；否则清单无法预先具有可靠行数。后续版本无论怎样修改工作区，旧轮次都读取已冻结内容。

### §4 同步契约：概况与清单只含元数据

新增 Agent state 的 `changes` 域，属于 ADR-0032 的统一模型；Host 文件内容存储只被引用，不进入 Registry。聊天显示投影携带稳定轮次引用及 `placement: turn-end` 的锚点，清单由独立分页域取得，不往原生历史写伪造消息，也不改写既有 canonical Entry。

拟议模型如下，正式字段由 Protocol strict schema 定义：

| 对象 | 必需信息 | 规则 |
| --- | --- | --- |
| `TurnChangeSummary` | `AgentKey`、`reviewTurnId`、`changeSetId`、`sourceEpoch/revision`、显示锚点；`state`、轮次结果；文件数量、各类型数量、行数汇总；`manifestRef` | `state` 为 collecting/finalizing/ready/unavailable。coverage、scope、attribution、reasons 独立表达；未知数量用 null，绝不填 0。总行数不全时注明“已统计部分”。 |
| `FileChangeMetadata` | 不透明 `fileId`、排序号、显示路径/文件名、可选旧路径；`changeKind`；`fileKind`；增删行数；可选前后字节数；`detailRef` 与详情能力 | `changeKind` 为 added/modified/deleted/renamed/type-changed/unknown。binary/oversized 的行数未知；内容、patch、预览片段、base64、机器内部快照路径均禁止出现。 |
| `ChangeManifestPage` | 变更集身份、固定 `manifestVersion`、有界文件项、总数/已记录数、`nextCursor`、完整性 | 页属于同一版本；超限/来源截断有明确原因。只有覆盖完整的固定版本才能按缺席删除旧项。 |
| `FileDiffReference` | 变更集、文件、固定 `contentVersion`、差异格式/算法版本；是否支持读取及保留范围 | 对应 Host 已冻结的前后内容；locator 不是电脑文件路径、读取租约或任意下载权限。历史引用稳定；缓存是否命中、有效期和瞬时可用性不写入不可变历史身份。 |

具体同步规则：

- 当前已选择会话的轮次结束后，同步概况和首批文件元数据；常见小清单可一次完整同步。大清单固定版本分页，展开/滚动按需加载更多**元数据**，不等待详情才能画行。后台会话仅保留有界变化通知，不向所有设备广播无限历史清单。
- 打开历史时只获取当前聊天窗口对应的概况；历史分页带入相关引用，不扫描全 Session 下载全部变更集。概况晚到时只更新对应轮末卡片，遵守 ADR-0046/0048 的阅读锚点与末尾跟随规则。
- 已结束轮次仍可能收到来源更正，用同一逻辑轮次的新 revision 发布，不增加重复卡片。当前查看器固定旧版本；若仍可读则保持不动并提示有更新，用户刷新时整体换版本。不能将新清单和旧详情混用。
- 回退、分叉和压缩后的卡片归属遵循来源确认的历史分支、显示窗口和锚点。旧轮记录可以按保留策略留存，但不能挂到新分支的同名文件或新一轮回复下；锚点尚未确认时保留待关联状态，不让 App 猜最近一条助手消息。
- 元数据域的 epoch/revision、清单完整性及本地已应用水位独立管理。缺页只说明文件清单尚未完整，**不阻塞聊天正文的 applied baseline**；文件详情从不成为聊天历史 coverage 的依赖。这与 ADR-0045 为实时工具库存定义的依赖不同，是独立的轮末审阅附件。
- 遵守 [ADR-0008](0008-drop-backward-compatibility.md)：实施时同步更新协议版本、Host、Pi/Claude bridge 和双端 App；原生能力差异通过明确状态表达，不创建一套静默兼容旧 Orbis 客户端的详情旁路。

### §5 详情只由用户查看触发

设备私有协议为 `session.changes.list/read`（轮次摘要及文件元数据分页）与 `session.change.detail.read/cancel`（单文件详情，`readId: null` 表示打开）。复用 ADR-0045 的读取租约、背压和有界调度实现，但详情 locator 是文件变更集身份，不借用某个工具调用 ID。Relay 继续只转发端到端加密载荷。

1. 点击“查看详情”或某个文件行，传入 `AgentKey + changeSetId + manifestVersion + fileId`；Host 校验已配对设备及所属关系，返回该文件的首个范围。默认统一 diff，包括旧/新行号、上下文、增删标记；新增/删除以不存在的一侧比较，重命名显示前后路径。
2. 一次 open 固定 `contentVersion/readId` 和读取上界。后续 read 携带同一身份及不透明 cursor，响应包括 `requestId/viewerId`、格式、范围、下一 cursor、`eof` 与缺口。幂等读取不得因磁盘现状变化而换内容。
3. 首批格式采用固定版本 unified diff 的 UTF-8 范围；两端允许跨页的 hunk/行拼接，使用服务端 cursor，不能以 Swift 字符数/Kotlin 字符串长度推导字节偏移。超长行也有界分片，不能为等待换行无限缓存。binary、too-large、unsupported、not-captured、expired、version-mismatch、busy 等分别呈现，空字符串不代表读取成功。
4. 只有当前选中文件触发网络读取；向下滚动再取它的后续范围。默认**不预取前后文件、不后台下载全轮、不因 Pager 创建邻页或手指经过邻页就请求详情**。尚未停稳的新页面只显示元数据和占位。
5. 切换文件、关闭详情、切换 Host/Session 或 App 进入后台时取消当前等待及后续调度；取消只影响读取，不停止 Agent。快速连续滑动合并到最终选中项，迟到响应严格按 viewer/file/version 隔离，不能替换当前页。
6. 已读页按 Host、Session、变更集、文件和内容版本缓存在 App 内存；滑回已读文件复用缓存及纵向阅读位置。缓存淘汰后再看才重读。初版 Android 缓存仅在本次查看器内有效，关闭、后台或断连即释放，不支持离线重开；iOS 可在同会话内重开已缓存范围，未缓存内容仍需连接。两端均不把未读相邻文件当作无变化，不承诺杀进程后的离线恢复。
7. Host 只从该变更集已保存的版本和差异索引读取范围，不在用户点击时重新扫描当前工作区或调用原生后端获取另一份结果。读取和序列化均执行接收/输出限额，手机只收到所请求文件的所请求范围。

详情响应只发给请求设备，不进共享聊天状态、metadata snapshot、历史 Entry、工具摘要或其他设备的读取流。未打开查看器时，该轮 Host→App 的详情字节数必须为 **0**；Host 本地采集和统计所需读取另行计量。

### §6 App 展示与动效

**轮末概况。** iOS/Android 同一交互：轮末紧凑卡片显示“3 个文件 · 新增 1 / 修改 1 / 删除 1 · +24 −9”，下方默认最多 4 行文件元数据，并有“查看详情”按钮。点击行直接定位该文件，按钮定位第一项；“展开全部文件”只展开/分页元数据。没有变化且采集范围完整时显示“本轮无文件变更”；采集失败、历史缺失不能显示这个成功空态。partial、归属不明、未知行数、详情过期有短状态说明。

**文件名中间省略。** 文件名单独一行，目录可作次要行；按实际可用宽度保留文件名开头和扩展名，例如 `ConversationPresen…Tests.swift`，禁止变成 `ConversationPresentationTes…`。先识别 basename 和后缀，再对中间的 grapheme cluster 做省略，复合后缀如 `.d.ts`、`.test.ts`、`.tar.gz` 作为整体保留；无扩展名保留前后识别片段，`.gitignore` 等点文件不能被误判为只有扩展名。路径本身不在协议层截断，也不作为 UI 省略后的身份。极窄屏/超大字体无法同时保留首段与后缀时，缩减目录、换行或给文件名独立可横向查看区域，不改为末尾省略。无障碍标签、长按复制路径和详情标题展开提供全名，重命名前后路径遵循同一规则。

**弹出的详情页面。** 点击后立即展示全屏 sheet/modal（两端沿用各自导航样式），标题区显示文件名、变更类型、`2 / 5` 和关闭按钮；内容区在加载期间保留该文件元数据，不等待网络再打开页面。正文纵向滚动统一 diff，默认长行换行。左右滑动切换同一固定清单中的前后文件，也提供前一项/后一项按钮与无障碍动作。到未取得的清单边界时只先取元数据；来源本身截断时显示“其余文件未记录”，不展示虚假的可翻页占位。

**动效是交互契约。** 当前页和相邻页容器随手指水平平移；松手后根据距离/速度落位或弹簧回弹，首尾边界有受限回弹，左右切换方向一致。动画由本地状态驱动，加载中、失败和离线页都能平滑切换。邻页可以预建轻量外壳，但不得提前构建 diff 正文、做语法高亮或发详情请求。只在选中项落位后开始读取，已缓存内容可直接绘制；快速反向滑动不闪错文件、不重复请求。

横向分页手势与正文纵向滚动方向锁定；默认换行避免代码横向滚动抢手势。若以后提供“不换行”，需单独规定代码区域与文件分页的手势优先级，不能让同一次拖拽同时滚代码和切文件。modal 通过明确关闭/平台关闭动作离开，不把右滑换文件当作退出会话。遵守系统减少动态效果设置，切为短淡入或即时切换；保留按钮导航和阅读位置。语法高亮仅处理当前已读可见内容，不阻塞转场。

### §7 生命周期、预算与访问边界

以下为初版实际预算（2026-10-30）。采集、清单或内容超限分别通过 coverage/reasons、未知行数及 detail 状态表达，不能把未记录内容当作零变化。资源上限是代码约束，不代表已测得性能收益。

| 资源 | 初始预算 / 策略 |
| --- | --- |
| 聊天内嵌概况 | 最多 4 个文件；生成预览时按 8 KiB 收缩，完整 summary schema 硬上限 12 KiB，为来源 ID / coverage 更正留空间。 |
| 元数据页 | 文件页至多 100 项，摘要列表页至多 128 轮，完整响应 JSON ≤60 KiB；每轮清单最多 20,000 文件 / 24 MiB（包含比较记录），差异索引另限 8 MiB。截断会标为 partial，fileCount 是实际记录数量。 |
| Host 基线采集 | 一次最多 20,000 条目 / 256 MiB 读取量 / 4 MiB 路径 JSON，单文件最多保存 2 MiB；扫描预算 2 秒，未完成采集最多 32 轮。执行前与结束屏障至多等待 2 秒，释放等待后只能声明 partial；已发出的文件系统操作收尾不能充当完整边界。 |
| Host 私有保留 | 元数据最多 64 MiB / 512 轮 / 30 天；去重内容最多 512 MiB / 7 天。活跃采集、比较和读取租约受保护，预算不足的新内容为 not-captured。清理只触及私有记录和 blob。 |
| 差异计算 | 最多 2 个比较 worker；每文件算法 100 ms、20,000 edit length，worker 默认墙钟 1 秒、old generation 96 MiB；每侧超过 100,000 换行视为 too-large。每轮 10 秒调度预算，超时 / 索引超限为 busy，未知行数保持 null，不输出伪精确替换。 |
| 详情页与并发 | 每页原文 ≤48 KiB，完整 JSON ≤60 KiB；iOS 请求 32 KiB，Android 请求 48 KiB。每查看器 1、每设备 2、Host 全局 4 个实际在途详情任务，超额 busy；取消后正在收尾的 I/O 仍占名额。 |
| 本地详情读取 | 只读取已捕获的每侧 ≤2 MiB blob；生成单文件 unified diff 后有界分页，Host 渲染缓存 ≤16 MiB。取消撤销响应和后续调度，不宣称能强制取消操作系统已发出的文件读取。 |
| 读取租约与 App 缓存 | 30 秒空闲租约只结束 GC 保护；身份绑定有界保留（全局 256 / 每设备 64），同身份可续读旧 readId。绑定丢失时客户端同 cursor 清 readId 重开一次，真正内容过期则停止。Android 每文件 2 MiB、查看器总计 8 MiB，非当前文件按首次访问顺序淘汰；iOS 最多 12 个已访问文件、正文合计 8 MiB，按最近访问淘汰。缓存为内存，不保证杀进程后离线恢复。 |

“7 天”是 Host 自有内容的默认保留上限，不受 DSH 等原生 Session 的存活期决定，也不承诺在配额不足时仍能保留满 7 天。淘汰后保留尚未过期的摘要及手机已读缓存，详情明确 unavailable/expired；不能再读当前磁盘或改走某后端原生 diff 来替换旧版本。历史完全没有采集记录时不做事后全仓库推断。元数据保留期结束后的已知引用也应返回 expired，而非空清单。

Host 存储按真实工作区及采集 owner 协调，避免多个 Orbis 观察者反复复制同一基线；这把锁只保护采集存储，不能阻止用户/其他 Agent 修改工作区，亦不构成排他写入证明。缓存和快照保存在 Host 私有状态目录，有 owner、配额、崩溃恢复和可回收记录；不清理源码、用户已有改动或其他任务数据。

所有读取经原有配对和 Session 归属检查，原生服务凭据留在 Host。App 的 fileId 只能引用该变更集已登记的内容，不能传路径绕过定位；Host 解析原生路径时处理 Windows/Unix 分隔符、链接和越界路径，确认物理文件系统映射。远端工具指向 SSH/容器文件系统时，本机同名路径不能作为替代。仓库外的明确写工具路径可展示，但只暴露该已记录内容，不开放目录扫描。此规则不修改既有独立文件下载功能的边界。

### §8 实施顺序与验收

下列步骤保留为完整验收要求；已实现部分、验证证据和剩余缺口见 §9，不将代码级 fixture 等同于真实后端验收。

1. **后端边界探针。** Codex terminal/Desktop 分别验证实际开始/结束、电脑端直接发起、消息排队及中途附着；Pi 验证顶层轮次/内部 turn 与执行前回调；Claude 验证 Mods 回调顺序、异常和当前 TUI 归属；DSH 验证 Web 执行前协调与轮次结束时序。使用隔离 fixture 和可控本地模型，无法取得可靠边界的路径显式报告缺口。
2. **统一域和 Host 采集。** 先实现与后端无关的快照、内容存储、统一差异引擎、`changes` 域和详情服务；用可控写文件 fixture 验证。再按边界能力接入各 adapter，覆盖文件工具、shell 与失败/取消的实际落盘。已有工具详情保持按需语义。
3. **双端 UI。** 落地轮末概况、中间省略、元数据分页、modal 查看器、单文件分页缓存和带动画的左右切换；请求调度与 Pager 的视图创建分开。
4. **端到端与发布。** 验证断线重连、历史重入、多 Host/多设备、多轮并行及限额；再统一升级协议与相关组件。设备测试遵守本机共享模拟器池及构建锁，使用固定已登记设备。

必需验收场景：

| 范围 | 通过条件 |
| --- | --- |
| 统计正确性 | 既有 staged/unstaged/untracked 修改不算成本轮新增；同文件反复修改、改后恢复、创建再删除、删除再创建、rename、取消后部分落盘均符合净变化口径。无变化与无数据明确区分。 |
| 来源缺口 | 所有后端覆盖范围内的 shell-only 修改都由 Host 前后版本识别；原生 diff 为空、截断或不可用不改变这份结果。电脑端直接发起、排队、晚附着、非 Git/忽略路径/不可读/外部并发等均正确声明边界和 coverage，不能展示伪完整结果。 |
| 历史固定 | T1 结束后 T2 再改同文件，打开 T1 仍读 T1；两轮间的用户修改不算入 T2。更正、重连、分页、排序不会混合内容版本；原生 Session 销毁不影响 Host 已保留记录，Host 重启缺基线不事后补造。 |
| 元数据先行 | 在详情接口被故意阻断时，文件名、已知 A/M/D 类型和行数仍可显示；长列表显示部分状态并能继续取元数据；未知类型/行数不通过预取所有 diff 补齐。 |
| 按需流量 | 100 文件、每文件 1 MiB 的 fixture，进入会话/展开文件清单后详情请求数及详情字节数均为 0；打开一个文件只读该文件首范围，滑动落位后才请求目标文件，其他设备收到详情字节为 0。Host 已完成行数计算与手机未收到详情可以同时成立。 |
| 取消与缓存 | 连续快速左右切换、回到缓存文件、关闭/后台、换 Host、超时/重试和迟到响应均不串页；无新增用户查看行为时无后台全量下载；离线显示已缓存范围。 |
| 特殊内容 | Unicode/emoji/超长文件名、同名不同目录、`.d.ts`/`.tar.gz`/点文件、重命名、CRLF/末尾换行、二进制、超大文件和超长单行不会误算、破坏省略或突破内存/页预算。 |
| 动效与性能 | 测试时钟检查拖拽中间帧、正确滑入方向、取消回弹、首尾边界和再次打开；加载/离线/失败页照常可滑。减少动态效果、大字体、VoiceOver/TalkBack 可操作；未查看 diff 的正文构建/高亮次数为 0。 |
| 隔离与资源 | 两台 Host 同名 Session/路径互不命中缓存；无跨会话读取和原生凭据外泄；超限 busy/partial/expired 正确，采集不改用户 index/refs/文件，活跃读取与其他任务存储不会被回收。 |

发布前记录概况到达耗时、单文件首屏耗时、Host 采集 I/O/磁盘峰值和手机传输字节。当前没有性能实测，不预先宣称带宽减少百分比或毫秒收益。

### §9 初版实现、接入与剩余验收

本节记录本次工作树的实际行为，区别前文完整设计要求。实现位于 `codex/adr-turn-file-changes`，基于 `375078cbbd9d7b3299ade6b24867ec5e8b3c65f1`；代码尚未提交或部署。

| 后端 | 已接入的轮次边界 | 当前覆盖结论 |
| --- | --- | --- |
| Codex terminal / Desktop | `CodexRuntime` 在实际 `turn/start` 分派前等待基线；排队输入到真正执行时才采集。终止事件触发终点，使用该 turn 拥有的 canonical assistant Entry 作为锚点。 | Host 分派路径可建立起点；仅观察到电脑端原生 started、运行中附着或下一轮抢先写入时为 partial。真实 Desktop / TUI 的版本与时序尚待验收。 |
| Pi | `before_agent_start` 经认证 loopback HTTP 等待 begin；内部 turn ID 归并；`agent_settled` 在队列继续前等待 finish。客户端 HTTP 5 秒上限，Host 屏障 2 秒。 | shell 与文件工具都由同一范围快照覆盖。缺 begin 的 finish 记录 unavailable，不用终点补造起点。原生异常 / 重连 / 排队仍待实际模型验证。 |
| Claude Mods | bridge **2** 的 `turn.start` 先等 Host 再执行一次 `next()`；complete 后等待终点；transcript 公布真实 Entry 后补齐锚点。 | 拒绝 bridge 1，避免把旧回调顺序当作可靠起点。Host 接口时序、本机 CLI 2.1.314 静态插件校验和 8 项 testing-kit 模拟用例通过；真实 TUI 模型轮次尚未重新验收。 |
| DSH Web | 在恢复层消费之前观察原始 turn 生命周期并保存时间窗快照。 | 尚无执行前屏障，明确 partial；不调用原生 changes.summary / changes.diff 作为替代。旧 ACP 不在本次交付范围。 |

Host 的实现入口为 [coordinator](../../packages/host/src/turn-change-coordinator.ts)、[snapshot](../../packages/host/src/turn-file-change-snapshot.ts)、[service](../../packages/host/src/turn-file-change-service.ts) 和 [diff](../../packages/host/src/turn-file-change-diff.ts)。Git 只枚举工作树范围，比较真实磁盘起止内容；不创建提交、不修改 index/refs。明确禁用 fsmonitor / untracked cache，读取不经过外部 diff、textconv 或 clean/smudge。非 Git 使用排除缓存和嵌套仓库的有界目录扫描。

当前没有“写工具执行前补录忽略 / 仓库外路径”。Git scope 表示跟踪及非忽略文件再扣除固定缓存目录；bounded-directory 表示本次 cwd 内的有界目录。范围外 shell 写入不覆盖，无法映射的远程文件不能用本机同名文件替代。所有结果目前统一 `attribution: workspace-window`，不声称修改由助手独占造成；已知同工作区并发会降级，但无法识别所有外部编辑。可靠 rename 证据尚未接入，所以移动文件显示删除 + 新增。

协议已升为 **16**，Host、Pi extension、Claude mod 与 iOS / Android 应同时升级；Claude 插件包版本升为 **0.1.3**，确保缓存更新能交付 bridge 2；Relay 继续转发加密载荷。正式 strict schema 见 [turn-file-changes.ts](../../packages/protocol/src/turn-file-changes.ts)：`reviewTurnId/sourceTurnIds` 关联来源，`anchorEntryId` 关联真实消息，`changeSetId/manifestVersion/fileId/contentVersion` 固定内容，独立单调 `revision` 拒绝迟到摘要。`changes` Registry 域只持有轻量描述，当前窗口通过 `session.changes.list` 订阅及补齐概况；`read` 取清单，`detail.read/cancel` 为设备私有按需读取。无 canonical 锚点的记录留待关联，不猜最近助手气泡。

持久化先于发布；重启后可读取已冻结记录，中途采集转为 unavailable。详情仅引用私有 blob 和比较索引，不重新扫描当前工作区。正文从不进入 summary、共享消息或其他设备的响应。真实加密 Host / Relay / 设备测试已验证：轮前已有脏内容作为起点、概况没有正文、点击前没有详情事件，以及后续磁盘再改不改变旧轮差异。

双端已实现概况、清单分页、文件名中间省略、独立 modal、统一 diff 行号 / 增删色、带动画的原生 Pager。只在落位后读取当前文件；取消拖动及邻页创建没有详情请求。阅读位置、版本隔离、迟到响应、缓存返回和特殊文件状态已有定向测试。实现入口为 [iOS model](../../ios/Orbis/Orbis/TurnFileChanges.swift) / [view](../../ios/Orbis/Orbis/TurnFileChangesView.swift)、[Android model](../../android/app/src/main/java/com/orbising/orbis/TurnFileChanges.kt) / [view](../../android/app/src/main/java/com/orbising/orbis/TurnFileChangeViews.kt)。同步维护 UI 基线 [ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) 的 S21 / M13 / V19。

验证结果和日志见 [轮次文件审阅验证记录](../testing/turn-file-changes.md)。仍待完成真实各 backend / 真机网络端到端、100 文件带宽与时延测量、多设备并发实测、完整 VoiceOver / TalkBack 及异常文件系统压力验收。两端设备测试使用隔离 UI fixture；不能把这些测试或 HTTP 模拟后端等同于真实模型验收。

## Alternatives and consequences

- **各后端原生 diff 优先**：可能减少部分 Host 采集，但统计范围、字段、失效条件和 shell 覆盖各异；当前修订不采用，原生事件仅辅助轮次和路径识别。
- **自行编写基础差异算法**：本项目需要掌握的是轮次采集、历史版本和按需服务；基础文本比较优先复用成熟库，避免额外维护算法边界。
- **将全部 diff 随轮次同步**：手机不用再请求，但流量随完整变更体积增长，违背按需要求，也重新引入 ADR-0045 已处理的共享状态膨胀。
- **App 下载工具结果后汇总**：重复后端语义、多次修改易重复计数，仍需传输全部原文；不采用。
- **每轮结束执行 `git diff HEAD`**：不能排除用户原有改动、不能冻结历史，还漏掉未跟踪/非 Git 文件；不采用。
- **仅记录工具路径或仅用 watcher**：可以做候选集，不能保证前后内容、shell 覆盖和最终净变化；作为局部证据而非完整统计。
- **滑动前自动预取邻文件**：可能更快显示下一页，但用户未查看也产生详情流量；首版禁用，轻量页面外壳和已读缓存负责动效连续性。

方案将带宽成本限制为元数据及用户实际查看的内容，换取所有后端一致的统计、渲染契约和保留策略。代价是 Host 需要承担有界采集、差异计算和历史内容存储；可靠的轮次前后边界仍须逐个 backend 验证。无法精确归属外部并发修改，也不能恢复从未捕获或已淘汰的旧内容；这些限制进入模型和界面。

## 调研档案（保留记录，不作为当前实现模板）

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

以上曾用于评估“接入原生聚合 diff”方案；当前修订选择 Host 自有前后版本，不采用这条原生正文读取链路。源码核对仍保留，用来解释已知原生能力和覆盖差异，不构成当前接口约束。

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

所以“Codex 打开后显示的差异也是自己实现的吗”的可验证回答是：公开 TUI 确实有 Codex 自己的差异展示层，并复用 `diffy`、`ratatui`、`syntect` 等库；Desktop 的比较范围由官方文档说明，但其具体查看器组件没有在本次核对中得到确认，不能据 TUI 推断为某个 Desktop/Monaco/其他组件。

这些显示资料作为历史调研保留。当前 Orbis 的采集、计算与 UI 契约由本 ADR 的 Decision 定义，首批比较范围固定为“本轮”；如以后增加 Git 工作区审阅，应作为带明确基线的新 scope 表达。

## Evidence

以下公开资料于 2026-10-30 读取；版本固定的源码用于证明该版本的契约，动态文档不替代实施时的版本探针。没有检查私有桌面数据库或逆向原生程序。

- **[S1] Codex**：[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)，从原 `developers.openai.com/codex/app-server` 重定向；核对 turn notifications、Items 和 fileChange 增量说明。仓库 [0.154.0 协议快照](../codex-app-server-protocol.md) 另列 `item/fileChange/patchUpdated`；官方文档说明旧 `outputDelta` 已不再由当前 app-server 发出，不能以它作为 diff 来源。
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
