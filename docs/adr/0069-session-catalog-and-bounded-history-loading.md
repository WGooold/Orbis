# ADR-0069：会话目录与有界历史加载

日期：2026-11-07（Asia/Taipei）

Status: proposed（规则已记录；FT-G11 / FT-G12 待实现、自动验证、部署及用户验证）

关联：[ADR-0067](0067-host-app-field-transport-rules.md)、[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0029](0029-session-read-operation-state-machine.md)、[ADR-0037](0037-session-sync-transaction-contract.md)、[ADR-0064](0064-protocol-compatibility.md)。

## 1. 范围与状态

- 本 ADR 只规定会话目录和会话历史的网络读取、变化推送、缓存、恢复与确认；适用于全部后端、Android 和 iOS。
- 第 2 节记录实施前基线；第 3–8 节规定目标行为及默认参数。目标参数进入经过协商的新表示后生效，当前发布包继续遵守已有契约。
- FT-G11 实施目录规则 SC-01–SC-07；FT-G12 实施历史规则 SH-01–SH-09。字段装载继续执行 ADR-0067，本文细化这两类数据的触发和范围。
- `KiB = 1024 bytes`；实测中的 `KB = 1000 bytes`。目标包预算指最终字段投影、正文复用之后，包含业务路由 envelope 的 UTF-8 JSON 明文字节；加密、信封、分片、TLS 和重传的线路字节单独计量。
- 条目数指 canonical Entry 数，包含工具及其他非消息节点；条目数、屏幕消息数、回合数分别统计。

## 2. 实施前规则与基线

| 项目 | 当前条件、大小与行为 | 实现指针 |
| --- | --- | --- |
| 目录定期对账 | Android 在 RESUMED 时立即核对，随后每次等待 15 秒再核对；遍历全部连接的 Host。相同兴趣在距上次请求不足 14 秒时合并。iOS 目录链路由连接、回前台、手动刷新及兴趣变化等事件触发，没有同样的 15 秒目录定时器。 | [Android 入口](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)、[多 Host 调度](../../android/app/src/main/java/com/orbising/orbis/RemoteViewModel.kt)、[兴趣去重](../../android/app/src/main/java/com/orbising/orbis/ModelInterests.kt)、[iOS 目录](../../ios/Orbis/Orbis/HostState.swift)、[前台恢复](../../ios/Orbis/Orbis/ContentView.swift) |
| 目录读取入口 | `agent.state.request(scope=host, domains 包含 catalog, subscribe=true)` 携带本地领域版本。Android 在连接建立、归档变化、刷新等路径还会请求 `session.list`；iOS 在尚未收到模型目录时保留该回退。 | [Android](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)、[iOS](../../ios/Orbis/Orbis/OrbisStore.swift) |
| Host 目录聚合 | 读取 catalog 时调用 `readHostRange()`；缓存有效期 5 秒，并发读取合并。部分后端变动只使缓存失效，等待后续读取重新聚合；5 秒是本机缓存有效期。 | [Host](../../packages/host/src/host-service.ts) |
| 目录对账应答 | `known` 的 modelEpoch / revision 相同则返回 `unchanged`；不同或缺少 known 时返回整个 catalog 领域 value。主动订阅更新另行计算 compact-v2 增量，差分小于原 value 的 80% 时使用。 | [读取应答](../../packages/host/src/agent-state-snapshot.ts)、[订阅更新](../../packages/host/src/agent-state-subscriptions.ts) |
| 目录页 | 公共目录投影最多 2,000 条、192 KiB；首页模型最多承载 28 KiB 目录 value。范围页默认 100 条、最多 200 条，value 最多 28 KiB；两端当前收到 cursor 后会连续取完剩余页。 | [目录库存与页](../../packages/host/src/host-state-facts.ts)、[协议](../../packages/protocol/src/agent-state.ts)、[Android](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)、[iOS](../../ios/Orbis/Orbis/HostState.swift) |
| 历史首屏与翻页 | preview 默认最多 30 条；两端主动历史页最多 30 条。Android catchup 请求 30 条，iOS catchup 请求 128 条。普通页预算 512 KiB，计算包含 4 KiB wrapper 预留；单条导致超页预算时可放宽至完整响应 1 MiB 硬上限。 | [选择与预算](../../packages/protocol/src/session-sync.ts)、[Android](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)、[iOS](../../ios/Orbis/Orbis/OrbisStore.swift) |
| 历史条件核对 | preview 支持 knownState。可信的同代完整基线下：同 head / seq 返回 unchanged；同 head 且 seq 前进返回 state；能容纳的新增后缀返回 delta；其他情况返回有界尾页 snapshot。 | [选择器](../../packages/protocol/src/session-sync.ts)、[契约用例](../../packages/protocol/src/session-sync-selection.test.ts) |
| 周期性聊天核对 | Android 当前聊天在前台进入时及每次等待 15 秒后调用 refreshRuntime，读取已有源端基线或补缓存缺口。iOS 已有基线核对由打开、恢复、来源或 head 变化等路径触发；聊天页的 15 秒循环读取工作分支。 | [Android 调度](../../android/app/src/main/java/com/orbising/orbis/RemoteViewModel.kt)、[Android 聊天](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt)、[iOS Store](../../ios/Orbis/Orbis/OrbisStore.swift)、[iOS 聊天](../../ios/Orbis/Orbis/ChatView.swift) |
| 自动历史补齐 | 首屏或范围页提交后继续检查到目标叶的连续覆盖。Android 的 verified_depth 从根向子节点推进，冷缓存会继续补祖先；未选中的 Runtime 也可启动 catchup。iOS coverage 同样检查祖先链及显示覆盖。 | [Android 补齐](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)、[覆盖规划](../../android/app/src/main/java/com/orbising/orbis/SessionGraphStore.kt)、[iOS 覆盖](../../ios/Orbis/Orbis/SessionHistoryStorage.swift) |
| 历史正文与确认 | 新表示已经支持包内相同长正文复用、live 基准差分及公开条目投影；历史范围页仍携带其 entries / display。设备完成归属校验与落库提交后回 applied ACK；socket 写完单独记为 delivered。 | [正文复用](../../packages/host/src/session-wire-content.ts)、[条目投影](../../packages/host/src/device-message-projection.ts)、[协调者](../../packages/host/src/session-sync-tasks.ts) |
| 原条目详情 | 用户明确查看 / 复制完整条目时发 `session.entry.request`；Host 按准确 Session / Entry 查找，原条目 JSON 超过 1 MiB 返回 session_entry_too_large，该检查未计 envelope。iOS 预览等待 20 秒；Android 已缓存 fullEntries 时复用。 | [Host 详情入口](../../packages/host/src/host-service.ts)、[Android](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)、[iOS](../../ios/Orbis/Orbis/OrbisStore.swift) |

2026-11-07 的运行中计量显示：目录对账包约 72 KB，采样的 sessions 数组平均约 70.5 KB；一次 20 秒窗口内 Codex `session.snapshot / range` 有 13 次发送尝试，平均约 59.3 KB。`range` 计量合并 history 和 catchup，不能据此判定为 13 次全历史重发。以上是工作负载样本，未作为目标上限或优化收益。证据：[字段与线路口径](../../.artifacts/live-field-traffic-20261107/summary.json)、[字段采样](../../.artifacts/live-field-traffic-20261107/wire-window/after.json)。

## 3. 共用预算与请求准入

| 参数 | 新表示默认规则 |
| --- | --- |
| 目录 / 历史页 | 目标 32 KiB，硬上限 64 KiB；条数与字节数先到者决定页边界。 |
| 读取请求、版本确认、ACK、pending 与关联错误 | 目标不超过 2 KiB，硬上限 8 KiB；准确身份、范围和必要错误保留。长详情使用有版本的内容引用。 |
| 目录页 value | 目标不超过 28 KiB JSON；保留完整 Host envelope 后目标包不超过 32 KiB。 |
| 目录页条数 | 默认 100，最多 200；32 KiB 包目标优先。 |
| 历史页条数 | 首屏、用户翻页和自动预留每页默认最多 30；64 KiB 包上限优先。 |
| 目录 / 当前聊天的兜底核对 | 前台且当前需要该数据时，距最近有效核对至少 60 秒；后台暂停定期核对。 |
| 单目录请求并发 | 同一 Host、快照、过滤范围最多 1 个在途读取；相同需求合并。 |
| 历史客户端并发 | 同一会话的同一固定范围最多 1 个读取；每 Host 最多 2 个历史读取在途，自动预留最多占 1 个。 |
| 自动预留 | 额外最多 60 条；每轮累计响应 JSON 明文最多 128 KiB、最多 4 个响应页；任一上限先到即停止。重传响应计入同一轮预算。 |

- 目录读取与历史读取要求原配对 Host 的认证加密链路可用；离线时展示既有缓存并保留其覆盖 / 新鲜度状态。
- 同一请求先登记归属、固定范围和预算，再进入调度；合并请求继续使用原操作，网络重试继续使用原事务身份。
- 64 KiB 页上限在最终序列化出口核验。正文超过本页剩余预算时保留完整身份、必要展示片段及准确内容引用，按需补取全文；字段的摘要、截断和完整原文状态明确区分。
- 自动预留请求向 Host 约束本轮剩余字节和条目额度；额度不足时返回可继续边界或停止。条数参数本身不能证明字节有界。
- 有效核对指准确匹配的版本确认或已校验提交的来源变化；普通路径心跳和未应用的广播只更新自己的状态。周期尝试开始后，下一次周期准入时间取“最近有效核对后 60 秒”和“最近周期尝试开始后 60 秒”的较晚者；手动读取及真实缺口由各自事件触发。
- 调度顺序为当前状态恢复、用户主动翻页、目录可见页、自动历史预留；实际分片继续遵守既有通道顺序、控制优先与背压契约。

## 4. 会话目录规则

### SC-01：读取范围与业务权威

- 当前选中 Host 的首页只取得首页需要的目录页、活动会话及总数 / 分组摘要；非当前 Host 保留名称、连接和待确认事实，目录在切换到该 Host 后按需核对。
- 同一设备对同一 Host 选定一个目录权威。已采用模型目录时复用 catalog 版本、页与增量；`session.list` 仅服务未支持模型目录的兼容路径。
- 首次无缓存读取必要第一页；同作用域缓存存在时先显示缓存，再按 SC-02 核对。目录条目缓存按准确 agentKind / sessionId 区分。
- 后续页由实际目录视图、滚动或查询需要触发；nextCursor 表示可继续读取。目录未展开时停止无需求的剩余页下载。
- 搜索、筛选和分组保持既有全局语义；需要尚未缓存的条目时向 Host 读取匹配范围及其版本化总数。该查询能力与分页格式一起协商，结果覆盖由 Host 确认。

### SC-02：请求触发与频率

| 事件 | 发起条件 | 网络行为 |
| --- | --- | --- |
| 首次连接 / 切换 Host | 所需目录缓存或可信版本缺失 | 读取目录版本和必要第一页，建立订阅。 |
| 同代重连 / 回前台 | 订阅需恢复，或距有效核对已满 60 秒 | 携带已提交版本核对；同一次前台恢复的需求合并。 |
| 前台兜底 | 当前 Host 的目录被首页或目录视图需要，且距最近有效核对满 60 秒 | 请求 catalog 版本，不连带刷新其他领域或历史正文。 |
| 打开目录 / 滚动 | 可见范围缺页，或用户进入下一页 | 先读缓存，缺页再沿当前固定快照取页。 |
| 手动刷新 | 用户明确触发 | 合并已有读取，主动核对来源；继续携带已应用版本，由 Host 决定返回 unchanged、差异或恢复页。 |
| 新建 / 归档 / 恢复 / 重命名完成 | 原操作结果已确认且影响目录 | 更新相关条目并通知所需订阅者；操作结果和目录更新分别按原身份确认。 |
| 后端目录事实变化 | 该 Host 存在相关读取兴趣 | 失效后调度重新聚合并发布真实内容变化，按 SC-03 合并。 |
| 核对时间、心跳或相同元数据 | 内容版本相同 | 复用缓存；保持最近有效核对事实。 |

- 有效核对时间在版本确认或相关变化应用后推进；周期尝试的失败间隔继续遵守第 3 节准入时间。未回复请求由原超时 / 重试拥有者处理，后续定时 tick 合并到原请求。
- 目录视图关闭后释放其后续页和查询兴趣；首页所需摘要及操作结果继续由各自兴趣持有。

### SC-03：来源聚合与变化发布

- Host 保留 5 秒来源缓存和并发聚合合并；这个 TTL 只约束本机来源读取。
- 相关后端通知触发 250 ms 合并窗口，首个待处理变化最迟 1 秒安排聚合；已有聚合期间的新变化保留下一代失效标记。
- 目录内容版本由条目、有效排序、覆盖与可用性决定。读取耗时、核对时间和重复通知复用原内容版本。
- 订阅推送及显式对账统一按客户端实际已应用版本决定内容：相同版本返回 unchanged；有可用差异时返回按稳定身份的新增、修改、显式删除；差异不可用时返回有界恢复页及新快照身份。
- 差异使用准确基准，且相对等价完整必要范围至少节省 20% 时采用；差异页与恢复页都受 64 KiB 上限约束，分段期间保留其固定版本及未完成覆盖。
- 当前 compact-v2 的 JSON 差分只覆盖订阅推送；FT-G11 同时补齐显式对账的差异 / 范围恢复与实际应用版本确认。Host 在缺少接收端基准时提供恢复入口。

### SC-04：分页、完整性与失效

- 游标固定绑定 Host、modelEpoch、目录内容版本、snapshotId、排序、查询条件与页位置；同一结果只拼接同快照的页。
- 游标失效或 snapshot_changed 时终止原页链、核对最新目录并读取当前需要的页；自动恢复最多一次，继续失败保留旧显示与明确重试入口。
- `totalSessions`、后端完整性、当前已加载条数、truncated、nextCursor 分别表达。部分页缺席保留旧条目，确认删除使用准确身份或有效完整覆盖。
- 排序变化通过目录版本和稳定身份更新当前列表；已显示的阅读位置保持原条目归属。

### SC-05：目录字段装载

| 字段 | 发送与缓存行为 |
| --- | --- |
| `modelEpoch/revision/snapshotId`、请求身份 | 随目录确认或页携带；绑定缓存、差异和游标。 |
| `totalSessions/backends/complete/truncated/offset/nextCursor` | 随相应版本的确认、摘要或页携带；保留实际确认的覆盖与计数。 |
| `sessions[].agentKind/sessionId` | 每个条目保留准确目标；只在该页首次装载、条目变化或恢复时发送。 |
| `name/firstMessage` | 保留当前标题及搜索需要的公开信息，按内容版本装载一份；完整聊天正文走历史范围或明确详情读取。 |
| `cwd/hostname/modelProvider` | 保留列表、分组和准确定位所需值；新表示复用已解析的同版本元数据引用。 |
| `createdAt/modifiedAt/messageCount/archived` | 真实值变化才更新对应条目；列表时长等可派生值在 App 计算。 |
| `currentProviders` | 复用相同 Host 的已确认 provider 事实；目录读取只取得其必要引用或缺失基线。 |
| `checkedAt/backends[].elapsedMs/error` | 核对与来源状态随相关应答携带；耗时单独变化保留原目录内容版本，失败保留部分库存及原因。 |

### SC-06：超时与重试

- 目录版本读取和页读取每次等待 20 秒；同一固定读取参数重试最多 1 次，间隔至少 5 秒。单次逻辑目录读取总等待最多 60 秒，阶段通知更新进展并受该截止时间约束。
- 失败仅结束本次目录读取；继续展示已有目录及未确认状态，下一次明确刷新或满 60 秒的核对可重新发起。
- 相同页重试沿用固定快照和范围；已应用结果幂等合并。旧 Host、旧请求或旧查询的迟到结果只在仍有效的归属内提交。

### SC-07：目录规则的实施边界

- 条件读取、差异、范围恢复、按视图分页和全局查询共同保持原列表的标题、搜索、分组、归档及准确会话选择。
- 新格式支持与客户端实际应用版本确认就绪后启用 64 KiB 页、目录差异及引用；原客户端继续消费原目录格式和完整性语义。

## 5. 会话历史缓存窗口

### SH-01：窗口与默认预留范围

- 当前聊天首屏从当前阅读位置或当前叶附近取得最多 30 条；已有缓存优先，首次网络读取使用有界 preview 建立当前 head / live 基线。
- 在首屏之外向更早方向自动预留最多 60 条。新打开且无缓存的聊天，初始目标至多为首屏 30 条加预留 60 条；字节、页数与实际历史终点可使条目数更少。
- 每轮自动预留同时受额外 60 条、累计 128 KiB 响应 JSON、最多 4 个响应页约束。已提交缓存计入可用范围；实际重新下载和重传计入本轮字节 / 页数成本。
- 预留只服务当前可见聊天。已有旧历史保留原缓存身份和离线用途；本窗口参数约束自动下载范围，既有磁盘保留策略独立执行。
- 停止边界保留真实 parentId、最早缓存条目、hasOlder 和来源版本；达到缓存窗口即完成本轮预留，窗口外历史保持“尚未读取”。

### SH-02：预留启动、补充与停止

| 事件 | 条件与行为 |
| --- | --- |
| 首屏提交 | 当前聊天可见、链路可用、预留不足且有更早历史时，启动一次有预算的更早范围读取。 |
| 用户向上滚动 | 可见窗口进入已预留范围、前方可用条目少于 30 且本地缓存不足时，以新的可见边界为锚补充，目标仍为额外 60 条。 |
| 窗口内缺口 | 只修复当前可见范围及该轮预留目标内的缺口。 |
| 预留额度耗尽 / 到历史终点 | 结算本轮预留并停止；保留是否还有更早内容。 |
| 回复继续生成、周期核对、来源 head 前进 | 更新当前 live / head 和真实新增后缀；沿用本轮预留额度。 |
| 重新进入同一窗口 / 相同事件重放 | 复用该作用域已缓存范围及已消耗额度；新请求 ID 本身不创建预留额度。 |
| 切换聊天、分支或 Host / 退后台 | 撤销旧窗口预留需求，停止新增页；当前新窗口按准确身份重新判定范围。 |
| 背压、错误或响应未推进边界 | 暂停该轮预留并释放等待状态；恢复仍受原范围和剩余额度约束。 |

- 自动预留只由首屏就绪或真实阅读窗口推进产生需求。它按“当前锚点向前的有界范围”读取，保留所有窗口外父引用。
- 新一轮补充绑定新的真实可见边界；首屏重绘、定时器、网络重连、重试或 live 增长继续复用原窗口记录。
- 每个新预留页确认已落库且边界推进后才计划下一页；相同边界回包按幂等确认结束，反复不推进时关联失败。

### SH-03：窗口覆盖与来源基线

- 分别记录节点存在、窗口内 canonical / display 连续覆盖、来源已应用 head / seq，以及从根到叶的全历史覆盖。
- 窗口覆盖证明包含 Host / Agent / Session、来源代次、显示表示版本、固定目标叶、窗口最早条目及其真实 parentId；校验窗口内部父链、显示依赖、重复身份和循环后提交。
- 根起算的 verified_depth 或全祖先 coverage 继续表示全历史覆盖；当前窗口是否可用由独立窗口覆盖决定。
- 窗口之外的缺失祖先保留为外部引用。窗口内部缺口、来源换代、非法引用和数据冲突由其读取拥有者恢复。
- `knownState` 只从实际完成来源事务的 head / seq 生成。缓存了一段历史或收到了 runtime 元数据，都只更新各自事实。
- 历史预留、用户向前翻页只推进相应缓存范围；当前 head / live 由可信 preview / patch 事务推进。

## 6. 会话历史请求与响应

### SH-04：请求条件

`session.sync` 与 ACK 通过现有 Runtime 命令 envelope 路由，精确绑定 Host、Runtime、Agent、Session、读取操作、来源 / 分支代次及连接代次。

| 请求 / 事件 | 允许触发的条件 | 大小与响应行为 |
| --- | --- | --- |
| `session.sync(range=preview)`：首次 / 打开 | 当前聊天缺少可信 head / live 基线，或需核对其来源版本 | 带已提交 knownState；最多 30 条，按 SH-05 选择 unchanged / state / delta / snapshot。 |
| `preview`：同代重连 / 回前台 | 订阅丢失、存在明确来源缺口，或距有效核对满 60 秒 | 缓存先显示，合并相同恢复需求；条件读取当前窗口。 |
| `preview`：前台兜底 | 当前聊天可见、链路可用、无同目标在途恢复且距有效核对满 60 秒 | 核对来源版本；相同版本只回确认。 |
| `preview`：明确手动重试 | 用户刷新或重试当前读取 | 主动核对来源，继续携带合法 knownState；恢复 current head / live，不扩大旧历史窗口。 |
| `session.sync(range=history)`：用户翻页 | 用户到达更早边界，且本地缺少该页 canonical / display 数据 | 固定 targetLeafId / beforeEntryId，最多 30 条；先本地后网络；每次用户需求只取对应页。 |
| 更早范围读取：自动预留 | 满足 SH-01 / SH-02 且本轮仍有额度 | 从当前最早已缓存边界向更早方向取得有界页，并在 SH-01 上限停止。 |
| `session.sync(range=catchup)`：缺口修复 | 已知固定窗口内有真实缺口，且已知的祖先范围足以界定该修复 | 请求该窗口内缺失片段，最多 30 条；按固定目标推进，不因窗口外祖先缺失产生根方向补齐。 |
| `session.patch`：正常更新 | 当前聊天持有该来源订阅，且有连续 source / baseSeq 的真实变化 | 发送新增节点 / 显示依赖 / live 差分，64 KiB 预算优先；超预算恢复有界基线。 |
| 来源序号缺口、分支变化或压缩窗口变化 | 当前实际应用基准不能合法接收下一变化 | 合并为一次当前窗口恢复；保留旧显示至新基线提交，按新来源与分支身份结算旧任务。 |
| `session.entry.request`：原条目详情 | 用户明确打开原文 / 原生详情，缓存缺少同版本完整内容 | 只读准确 entryId；长内容采用按需详情页 / 引用，普通历史页不携带原生完整体。 |
| `session.snapshot.ack` | 对应响应已校验并持久提交，或被明确拒绝 | 回原 syncId 的 applied / rejected；按控制包预算，重复应用幂等重发 ACK。 |

- 未打开会话只维持目录、执行、交互及通知等既有事实；历史正文在打开、明确读取或相关恢复时取得。
- 用户手动翻到很早的位置可以读取更早历史；每次读取和每轮自动预留继续有界，保留当前位置与阅读锚点。
- 原条目详情按当前查看器每次读取一页，离开查看器释放后续需求；等待 20 秒后结束本次读取，用户显式重试时复用准确内容版本与已有页。
- 当前根方向 catchup 的无 knownLeafId 行为继续服务旧表示；新窗口中冷缓存的预留采用更早范围页。窗口边界及剩余字节约束需在独立能力和 schema 中明确后启用。

### SH-05：preview 的内容选择

| 已应用基线与来源 | 选择 | 正文行为 |
| --- | --- | --- |
| 同 epoch、同 head、同 seq，且来源确认完整 | unchanged | 仅版本 / checkpoint 确认，省略旧 entries、display、turnTimings 与 live 正文。 |
| 同 epoch、同 head、seq 前进 | state | 只取得当前变化状态及依赖；已应用 live 基准可用时使用差分。 |
| 同 epoch、head 为已应用 head 的后继，差异在页预算内 | delta | 只发送已应用 head 之后的新增节点、显示与依赖；与 live→历史交接原子提交。 |
| 新增后缀超过单页但仍属于需要的固定范围 | 有界差异页或窗口恢复 | 每页 64 KiB 内，按固定范围和覆盖推进；是否完成用真实范围标记表达。 |
| 无合法基线、来源换代、回退、分支分歧或来源尚未确认 | snapshot / 明确不可用状态 | 取得最多 30 条的当前尾窗和必要 head / live；窗口外覆盖保持未读取。 |

- 同一个 head ID 可以有不同 live / seq；内容抑制依据实际已应用来源版本及完整性。
- entries / display / live 的同内容按 ADR-0067 FT-07 复用；跨包引用按实际应用的内容身份与版本解析，缺引用只补相关正文或当前基线。
- 完整恢复表示当前所需窗口与来源状态完整；全历史是否到根使用独立覆盖事实。

### SH-06：历史字段装载

| 字段 | 发送与缓存行为 |
| --- | --- |
| `runtimeId/sessionId/syncId/commandId/requestId` | 随原事务保留准确作用域与关联；重试复用固定身份。 |
| `range/targetLeafId/beforeEntryId/knownLeafId/maxEntries` | 绑定准确读取范围；knownLeafId 只用于已核实的缺口范围，窗口外引用保持原值。 |
| `knownState.epoch/seq/head` | 仅在 preview 携带实际已提交的来源基线；历史页缓存进度单独保存。 |
| `source/checkpoint/baseSeq/seq/selection` | 提交、差分和恢复依据；同版本确认保留最小必要版本信息。 |
| `entries[].entryId/parentId/type/timestamp` | 在需要的窗口中保留原节点身份、真实关系和必要原生语义；缓存以来源代次和条目身份去重。 |
| `entries[].data`、`display.entries` | 使用已登记公开投影和同版本正文引用；正文首次需要或真实修订时装载，详情单独读取。 |
| `display.windowStart`、显示版本 | 表示来源声明的显示 / 压缩语义；客户端缓存的预留边界单独记录。 |
| `live/messages/tools` | 当前可见聊天按有效基准增量；恢复发送当前所需完整 live 及必要工具引用。 |
| `turnTimings` | 本页实际相关的时序事实或确认后的变化；已知旧历史 timing 复用缓存。 |
| `mode/cursor/hasOlder/complete/rangeStatus/headCompleteness` | 分别保留范围合并方向、继续边界、是否更早可读及来源质量；窗口完成使用独立明确语义。 |
| `sharedContent/references/liveDelta` | 按准确作用域、来源和表示版本解析后一次提交；包预算包含引用本身。 |
| `pending/leaseMs/result/error` | 原读取拥有者处理进展、确认与终态；错误按受影响范围结算。 |

## 7. 生命周期、重试与兼容

### SH-07：读取归属与缓存提交

- 首屏、来源核对、用户历史页、自动预留与缺口修复各有自己的读取操作和等待状态；首屏在当前窗口可用时完成。
- 预留页先落缓存；显示范围由真实可见窗口及用户翻页需求推进，阅读锚点绑定原条目与读取操作。
- 页面关闭或窗口被替代后撤销未发送需求。已封帧的数据遵守原传输顺序；收到的迟到响应仅在原作用域、来源和缓存版本仍合法时缓存并确认，当前新页面由自己的读取拥有者发布。
- 新边界语义与持久窗口覆盖一起实现；源端完整性、客户端窗口覆盖、全历史覆盖和 UI 等待各自保留。

### SH-08：有界重试与背压

- 历史事务沿用 ADR-0037：总共最多 4 次尝试，重试间隔依次至少 30 / 30 / 60 秒，复用同一 commandId / syncId / 范围。
- Host processing 无进展租约 120 秒、sending 无进展租约 60 秒、支持 ACK 的设备在 delivered 后等待确认 30 秒；pending 携带当前阶段与租约。
- 客户端基础耗尽窗口 150 秒，pending 依原有规则有界延长，最多处理 10 次延期通知；事务关联最多保留 300 秒，并以实际租约和明确终态结束等待。
- 同一事务在处理、发送或等待确认时，周期核对与相同缺口需求合并到原操作；已经 applied 的内容可幂等确认。
- 自动预留的重试同时受本轮剩余字节 / 页数预算约束；耗尽时暂停预留，保留已提交缓存及更早可读边界。
- 原事务的请求字节额度保持固定。重试前为同一额度再次预留本轮成本；剩余额度不足时暂停该自动事务，以已提交范围结算本轮，后续真实阅读需求另行登记。
- 队列背压保留当前用户读取与控制回执的调度机会。失败只结算对应范围，后续恢复入口仍使用准确来源和读取身份。

### SH-09：新旧格式

- 目录新页 / 差异 / 查询与历史窗口覆盖 / 剩余字节预算分别通过明确能力协商启用；`compact-v2` 本身只证明当前已经定义的领域差分和共享正文支持。
- 新能力的精确请求、字段、边界与确认语义实施时登记到协议 schema 及 ADR-0067 字段表，保留旧 strict schema 的合法收发。
- 已协商设备在一个作用域内使用一种目录及历史业务权威；旧格式继续采用原字段、预算、根覆盖与恢复契约。
- 全部后端共用 Host 出口的触发、预算与覆盖规则；后端原生事实采集和本机保存独立于 App 的缓存窗口。

## 8. 协商字段与实施登记

### 8.1 历史窗口字段

| 消息 / 字段 | 规则与行为 |
| --- | --- |
| `session.history.capabilities.request.type/protocolVersion/requestId` | SH-09：认证后每次连接探测一次；准确关联应答，旧 Host 拒绝或不应答时保持用户主动翻页。 |
| `session.history.capabilities.type/protocolVersion/requestId/format/maxPageBytes` | SH-09：`format=v1` 且 `maxPageBytes=65536` 确认预算与可见兴趣能力。 |
| `session.history.interest.type/protocolVersion/requestId/runtimeId/sessionId` | SH-02 / SH-06：每设备保留一个可见聊天目标；两个目标字段同时为 null 表示关闭。相同目标去重，关闭和切换立即替换。 |
| `session.history.interest.result.type/protocolVersion/requestId/accepted` | SH-06 / SH-09：准确回执，拒绝后释放客户端去重状态以便重新登记。已协商设备关闭或目标不匹配时停止正文推送；未协商旧设备保持原广播。 |
| `session.sync.historyWindow.format/maxBytes/maxDeliveries` | SH-01 / SH-08 / SH-09：仅固定 `targetLeafId + beforeEntryId` 的 history 可用。Host 校验最终 envelope 不超过剩余额度，单事务投递次数固定；转发旧 adapter 前移除此 Host 参数。 |

- 每轮的请求上限为 `min(64 KiB, 128 KiB - 已支出字节)`；不足 8 KiB 停止。可投递次数为剩余页数与“剩余字节 / 本次请求上限”的较小值。
- 收到的成功页计原始 UTF-8 JSON envelope 字节；请求重试而未观测到的响应按该请求固定上限预留成本。失败与撤销结算原事务，重复 ACK 不创建下一页或刷新额度。
- 自动页只落库，用户主动翻页从 SQLite 读取预留页后才推进可见最早边界。到终点、错误、撤销或边界未推进记录本轮已停止；周期 preview、live 与重新进入同一边界复用原额度。

### 8.2 分组验证登记

| 组 | 规则 | 针对性回归范围与实现指针 | 当前状态 |
| --- | --- | --- | --- |
| FT-G11 | SC-01–SC-07 | 已实现 60 秒条件核对、前后台与当前 Host、同版本小确认、缺更差异恢复、28 KiB 固定快照分页、来源变化主动聚合，保留 `session.list` 兼容。对应 [Host 目录](../../packages/host/src/host-state-facts.test.ts)、[差异与淘汰](../../packages/host/src/catalog-reconcile.test.ts)、[Host 加密与分页联动](../../packages/host/src/host-service.test.ts)、[Android 调度](../../android/app/src/test/java/com/orbising/orbis/ReadReconcileScheduleTest.kt)、[iOS 调度](../../ios/Orbis/Tests/ReadReconcileScheduleTests.swift)。定向回归通过；未展开时停止后续页、查询范围请求仍待完成。部署、真实网络与用户验收待完成。 |
| FT-G12 | SH-01–SH-09 | 长会话冷缓存首屏加有界预留、达到条数 / 字节 / 页数任一上限停止、重复事件不补根、真实滚动才扩窗、离线页、窗口内缺口、切分支 / 来源换代、压缩与显示缺口、live 落盘、乱序 / 重复、ACK 丢失、背压、旧端根覆盖兼容。对应 [范围选择](../../packages/protocol/src/session-sync-selection.test.ts)、[Host 事务](../../packages/host/src/session-sync-tasks.test.ts)、[Android 覆盖规划](../../android/app/src/main/java/com/orbising/orbis/SessionGraphStore.kt)、[iOS 历史测试](../../ios/Orbis/Tests/SessionHistoryTests.swift)及两端读取状态机测试。 | 子组 G12.1：32 KiB 目标 / 64 KiB hard page、24 KiB 单条线路投影已实现；Protocol 165 项回归通过。G12.2：Android / iOS 自动根向 catchup 已移除；iOS 首屏与显式历史边界测试、Android 来源恢复测试通过。iOS StoreTests 另有 `homeWaitsForCardFactsAndPersistsIdentityBeforeCatalogArrives` 在基线工作树复现的既有失败。G12.3：已实现额外 60 条 / 128 KiB / 4 页预留、按实际响应和重试预算结算、缓存写入与可见范围分离、60 秒来源核对及可见聊天推送兴趣。能力未确认的旧 Host 保留用户主动翻页。自动验证见本任务 `g12-ios-final/run.log`、`g12-android-final/run.log`、`g12-node-latest.log`、`g12-e2e-latest.log`；既有基线失败保留原证据。部署、用户验证待完成。 |

- 本次文档静态校验与后续实现证据保存于 `.artifacts/catalog-history-rules-20261107/`；文档检查只确认链接、规则覆盖、参数与格式。
- 每组独立实现、完成针对性回归后提交。真实线路测量分别记录 JSON 发送尝试、实际 socket 字节、成功应用范围和完整性；实施收益以相同工作负载对照为准。目录页面按需兴趣及全局查询范围仍需专项实现。
