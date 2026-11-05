# ADR-0045：工具活动只同步摘要，完整参数与输出按需读取

日期：2026-10-27

状态：accepted（2026-10-27 已完成协议、四种后端、Host 与 Android 接入；构建和验收范围见实施记录。各运行环境的升级状态须单独核对）

实施跟踪：[ticket 依赖与验收记录](../../packages/host/src/tool-content-service.test.ts)，GitHub #16–#24。接受决策不代表生产运行路径已完成切换。

关联：[ADR-0005](0005-receiver-driven-range-download.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0034](0034-image-content-references.md)、[ADR-0035](0035-incremental-session-reconcile.md)、[ADR-0038](0038-wire-payload-truncation.md)、[ADR-0044](0044-bounded-codex-live-publish.md)

## Context

### 实施前已确认的实现与问题

以下记录本决定之前的代码行为；本地新实现已替换工具载荷路径，具体符号和验证见[实施记录](../../packages/host/src/tool-content-service.test.ts)。

1. Codex 的 `liveMessages` 和 `liveTools` 分别保存工具调用消息和工具状态，`#liveCheckpoint` 将两者完整放入 `session.patch`。参数可能同时出现在消息的 `tool_call.arguments` 和工具的 `detail.arguments`；输出增量累计到 `detail.output`。对应实现为 [`codex-runtime.ts`](../../packages/host/src/codex-runtime.ts) 的 `#handleNotification`、`#liveCheckpoint`、`#publishSourcePatch`。
2. Codex `#completeItem` 按原始 item 顺序提交历史。前序 item 未完成时，后续已完成工具仍属于 live。该规则保证实时构造与历史重建的顺序和 parent 一致，但完整参数与结果因此可能长期留在每份 live checkpoint 中。
3. 通用同步选择器在没有加入历史 Entry 时就测量 snapshot；超过正常页预算会报 `session_metadata_too_large`。当前源码的正常页预算是 512 KiB，单响应硬上限是 1 MiB；见 [`session-sync.ts`](../../packages/protocol/src/session-sync.ts) 的 `SESSION_SYNC_PAGE_BYTES`、`SESSION_SYNC_MAX_BYTES` 和 `selectPreparedSessionSync`。Registry 默认单值上限也是 1 MiB，超限返回 `value_too_large` 并拒绝提交；见 [`agent-state-registry.ts`](../../packages/host/src/agent-state-registry.ts)。两者是不同检查点。
4. App 已将工具结果合并到工具调用卡片，默认折叠，展开后才展示参数与结果；折叠不减少同步字节。见 [`MessagePresentation.kt`](../../android/app/src/main/java/com/orbising/orbis/MessagePresentation.kt) 的 `buildConversationPresentation` 和 [`MainActivity.kt`](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt) 的 `CollapsedTool`。
5. 现有 `session.entry.request` 从 Host 当前会话状态读取整条 Entry，一次返回完整响应；没有单条内容分页，也不能读取尚未提交的 live 工具。超过 1 MiB 返回 `session_entry_too_large`。见 [`host-service.ts`](../../packages/host/src/host-service.ts) 中该命令的分支。
6. `toolResultForItem` 尚未读取 Codex 的 `aggregatedOutput`，但 ADR-0038 的原生实测记录确认存在该字段。结果采集不完整是独立缺陷；仅补字段会增加当前同步载荷，不能替代本设计。

上述事实说明：工具的执行事实、聊天显示摘要和完整内容目前混在同一同步载荷中。需要改变数据归属和读取契约，而不是继续依靠默认折叠、增加快照上限或缩短输出前缀。

### 已做实验及其证明范围

2026-10-26，在主工作树使用真实 `CodexRuntime` 与同步实现、模拟 app-server 通知做了五类控制实验。测试文件是主工作树当时未提交的 `packages/host/src/codex-live-size.test.ts`，不在本 ADR worktree 的提交基线内；以下为实验记录，不是用户原故障的现场统计。

| 模拟场景 | live JSON UTF-8 字节 | 结果 |
| --- | ---: | --- |
| 16 个顺序完成的工具，每个输出 80 KiB | 峰值 82,397 | preview 成功，工具逐个提交后移出 live |
| 前序消息未完成，8 个后续工具已完成，每个结果 80 KiB | 659,047 | `session_metadata_too_large` |
| 单工具累计 600 KiB 输出 | 614,886 | `session_metadata_too_large` |
| 单助手消息累计 600 KiB 正文 | 614,655 | `session_metadata_too_large` |
| 单 MCP 工具的结构化参数在消息与工具状态中各存一份 | 621,327 | `session_metadata_too_large` |

实验证明工具数量、单项输出和重复参数都可以独立制造超大 live；也证明只处理工具不能解决超长助手正文。没有证据确定上述哪一种就是最初故障的实际触发条件，不将这些数字作为生产带宽节省比例。

## Decision

### §1 分离工具摘要、内容引用和原始内容

各后端在内容产生处形成统一摘要与引用，原生 Agent 持有完整内容；Host 模型保存有界投影，设备按需读取原文。

| 对象 | 归属与用途 | 默认是否同步 |
| --- | --- | --- |
| 工具摘要 | Host Agent state model 中的执行事实及历史显示投影 | 是，受条目、页和库存预算限制 |
| 内容引用 | 定位当前 Session 中某次调用的参数、输出或最终结果 | 是，只包含身份和可用性描述 |
| 原始内容 | 原生持久历史；必要时由生产者保留的有界临时内容存储 | 否，设备显式读取时返回范围 |

### §2 聊天展示工具摘要

工具活动按来源顺序嵌入助手轮次，默认展示紧凑摘要和已确认状态。详情按需读取，审批与问题沿用独立交互模型。

### §3 摘要字段与确定性

工具以持久领域身份关联消息、轮次和内容引用，摘要由原生事实确定性生成，并受 UTF-8 预算约束。字段与算法见 [tool-activity.ts](../../packages/protocol/src/tool-activity.ts)。

### §4 完整内容的来源与生命周期

adapter 统一读取原生持久内容和 producer 的有界临时内容，按实际来源声明可用范围、版本与缺口。存储、查找和取消均服从资源预算及所有权；参数和生命周期以实现为准。

当前默认存储预算为单工具 16 MiB、producer 64 MiB / 256 个部分，生产更新后保留 10 分钟；读取租约 30 秒。Codex 首批读取使用 full turns 整页 RPC，本地响应预算在接收与解析后检查，上游仍返回整页。

### §5 有界且完整的工具库存

工具摘要库存按固定来源版本分页，增量按连续 revision 应用；跨域依赖由来源事务确认。来源和接收端各自维护有界库存及恢复基线，完整性覆盖已声明的摘要与引用。

checkpoint 通过 live.toolInventory 引用库存，session.tools.open/read 提供固定页；大批变更通过 session.tools.changed 触发基线读取。默认单会话 4096 项 / 8 MiB，全 Host 16384 项 / 32 MiB，快照租约 30 秒。

### §6 详情读取按设备、内容版本与范围关联

session.tool.content.read 按设备、Session、locator、内容部分及固定读取版本关联范围。读取保持 UTF-8 坐标、幂等与明确覆盖，追加、替换、结束和缺口分别表达；响应回到请求设备。

### §7 用户打开详情后才跟随输出

详情、跟随、复制全部与导出由显式查看操作调度，按查看器生命周期释放读取与缓存。离线展示已缓存范围，导出按固定读取版本逐页写入并支持取消。

首批查看器缓存为 2 MiB，导出上限为 64 MiB。

### §8 初始传输预算与背压

工具摘要、库存与详情分别记账，共用现有传输背压；准入同时核验业务载荷和完整 envelope。初始参数见下表，后续取值以实现为准。

| 项目 | 上限或规则 |
| --- | --- |
| 单工具摘要的完整 JSON UTF-8 大小 | 4 KiB，含完整关联身份 |
| checkpoint/patch 中的工具数据 | 库存引用，摘要独立分页 |
| 单份工具库存页或原子增量 | 128 项且业务 JSON 不超过 60 KiB；完整运行时响应不超过 64 KiB |
| 单详情响应 | 业务 JSON 不超过 60 KiB，完整响应 64 KiB，含转义和元数据；App 请求原文上限 32 KiB |
| 每设备详情读取并发 | 2；单查看器最多一个在途范围请求 |
| 详情响应等待发送字节 | 每设备 256 KiB，采用保守的密文及分片封装估算；封帧前准入 |
| 当前摘要/输出通知 | 来源合并发布；库存 revision 随摘要字段推进，聊天 source seq 随聊天事实推进 |

### §9 live 转历史仍是一笔来源事务

工具历史摘要、显示引用、head、live 移除和工具域依赖在来源事务中原子交接。执行结束、历史确认与内容可读分别由各自的原生事实确认。

### §10 投影版本与旧缓存迁移

投影变化通过 source epoch 与缓存事务迁移，保留设备身份及本地输入，迁移失败完整回滚。初次引入为协议 15、显示投影 3、工具摘要投影 1；后续兼容按 ADR-0064。

### §11 与既有决定的关系及范围

本决定调整工具载荷的投影与读取范围，既有来源权威、恢复、事务和背压契约继续适用。超长助手正文、思考和其他 live 库存仍可能超预算，生产升级与真实后端验收状态单独记录。

来源权威与原子恢复沿用 ADR-0024 / ADR-0025 / ADR-0032；媒体引用沿用 ADR-0034；文本预算、来源合并与背压沿用 ADR-0035 / ADR-0038 / ADR-0044。工具详情复用 ADR-0005 / ADR-0013 / ADR-0037 的范围、归属和租约原则，由独立读取生命周期管理。

## Consequences

- 默认工具同步大小由摘要与引用数量决定，不再随工具输出的累计字节增长；详情开启时仍会消耗与实际读取内容相应的带宽。
- App 日常聊天以正文和工具执行摘要为主；查看原始输出多一次显式操作和读取延迟，离线只能查看已缓存部分。
- Host/producer 增加内容索引、临时存储、范围读取、库存分页和版本管理成本，但不新增无限期的全量聊天数据库。
- 原生内容缺失、上游截断和临时存储淘汰会限制可恢复范围，模型与界面按实际来源呈现完整性。
- 历史投影和协议协调升级，运行环境的升级及验收状态分别记录。

## Implementation and verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。
