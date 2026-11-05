# ADR-0055：所有 Agent 状态下的用户输入与处理结果

日期：2026-11-01

Status: accepted（契约已确定，实现与验收状态分别记录）

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0031](0031-host-permission-management.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)、[ADR-0029](0029-session-read-operation-state-machine.md)、[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)、[UI 回归](../../AGENTS.md#测试)。

受影响 feature：V05、V09–V10、V12、V16–V18；关联 S16–S17、V03、V07，沿用既有视觉与交互基线。

## Context

Codex 压缩期间发送可能一直显示“发送中”。隔离协议夹具确认三个代码缺口：独立压缩没有参与发送准入；只有压缩完成和 idle、没有 turn/completed 时队列不补跑；队列先报 delivered，启动失败又没有对应 rejected。正常 turn/completed 则可以继续投递。夹具证明分支存在，尚不能代替用户故障的真实事件序列。

所有已声明输入通过统一的拥有者、准入和结果模型处理，原生能力决定执行、排队、拒绝或待核对。

## Decision

### 1. 范围与输入全集

各后端按已声明能力处理输入，协议类型、拥有者与结果完整对应；独立 Host 服务和本地操作由各自入口管理。

| 输入组 | 当前判别值 / 内容 | 唯一拥有者与成功证据 |
| --- | --- | --- |
| I01 对话 | `user_message`：纯文本、文本加附件、附件输入生成的正文；无 delivery、followUp、steer | 后端队列 / 原生提交；源端用户消息及 clientMessageId / 原生声明映射才证明落地 |
| I02 撤回 | `user_message.cancel` | 队列拥有者；确认未投递并删除，或 already_delivered / not_cancelable |
| I03 Slash | `slash.execute`：只读查询、模型 / 思考 / 权限配置、压缩、历史改写 / 会话切换、产生提示的 skill / template、退出及扩展命令 | 后端当前已声明的命令目录；原生执行结果与必要配置 / 会话确认 |
| I04 权限 | `permissions.update` | 后端校验 opaque setting / option 并确认会话配置 |
| I05 停止 | `stop` | 当前执行拥有者；原生中断确认、已结束或明确不可取消 |
| I06 交互 | `interaction.respond`：确认、选项、问卷、自由文本、取消 | 请求拥有者；校验 Host / Session / generation / request / extension / 期限 / 答案结构并取得处理结果 |
| I07 历史读取 | `session.sync`、`session.entry.request` | SessionSyncTasks / conversation state；带范围和身份的成功或失败 |
| I08 读取确认 | `session.snapshot.ack` | SessionSyncTasks 幂等消费 applied / rejected |
| I09 工具读取 | `session.tools.open`、`session.tools.read`、`session.tool.content.read`、`session.tool.content.cancel` | 工具库存 / 读取服务；opened / page / read.failed；取消仅结束自己的读取 |
| I10 文件审阅 | `session.changes.list`、`session.changes.read`、`session.change.detail.read`、`session.change.detail.cancel` | TurnFileChangeService 管理 summaries / page / failed 与读取取消 |
| I11 文件传输 | `file.download`、`artifact.download`、`artifact.cancel` | HostDownloadService；offer / 进度 / 完成 / 失败 / 取消，按设备私有任务隔离 |

### 2. 状态按正交事实表达

传输、归属、执行、活动和输入分别表达原生事实，组合状态按统一准入顺序求值。后台任务库存与主回合分别管理，未知活动通过来源核对恢复。

| 维度 | 状态全集 / 来源 |
| --- | --- |
| 传输 | 未配对、未加密就绪、在线、断线、重连；App / DeviceLink |
| 归属 | 没有 Session、在线绑定、替换中、已关闭 / 归档 / 下线；Host 与后端 |
| 执行 | idle、running、waiting_local_interaction；unknown / unavailable 表达来源可用性 |
| 活动 | 启动中、压缩中、重试 / 退避、停止中、历史核对 / 恢复中、配置更新、供应商切换、关闭中；各有操作 / 回合 / 条目身份 |
| 输入 | 新建、受理、排队、提交源端、已落地、拒绝、撤回、不可撤回、结果未知、已失效 |

参考：[ADR-0062](0062-claude-background-agents-and-session-activity.md)。

### 3. 准入优先级（先匹配先处理）

准入依次核验身份、幂等性、连接、目标、能力与互斥，控制和读取按其拥有者优先处理；容量通过明确背压管理。

| 编号 | 准入原则 |
| --- | --- |
| G01 | 写入前完成身份、结构和输入校验。 |
| G02 | 重复操作按原身份幂等核对。 |
| G03 | 本地写入失败保留输入与原因。 |
| G04 | 已发送操作按执行证据结算。 |
| G05 | 读取、确认和传输由各自拥有者处理。 |
| G06 | 操作绑定有效目标与后端。 |
| G07 | 原生调用依据已声明能力。 |
| G08 | 控制操作按目标优先处理。 |
| G09 | 冲突写入服从领域互斥。 |
| G10 | 来源恢复期间维护写入屏障。 |
| G11 | 执行前复核归属与准入。 |

### 4. 完整状态 × 输入矩阵

组合状态与输入使用统一准入模型，所有结果进入 §6 的生命周期；具体组合与判定以测试源码为准。独立压缩的 idle 输入由 Host 队列暂存。

### 5. 后端能力与 Slash 子路径

backend 按已发布命令目录解释读取、配置、历史、退出和对话输入，按原生能力确定准入和成功证据。附件与正文完整提交，独立传输沿用自身生命周期。

| 后端 | 消息 / 队列 | steer / stop | 不支持时 |
| --- | --- | --- | --- |
| Pi | 扩展持有待投递输入；isIdle 与压缩 / 队列 / 启动保留位共同判断；原生可执行后逐条投递 | 保持原生 abort + 队列语义，停止和压缩完成要触发核对 / 调度 | 明确 unsupported / not_cancelable |
| Codex / Codex Desktop | 适配器队列与独立压缩暂存，串行启动 | steer 使用原生中断和优先调度，异步问题独立归属 | 失败与未知按 §6 结算 |
| Claude Mods | 插件在原生可提交时串行消费 Host 队列 | steer 返回 claude_steer_unsupported；stop 等待原生中断 | 按原生受理事实结算 |
| DSH Web | 原生 queue / steer；以 requestId 及 queue item 关联人类输入 | 原生 cancel；审批独立通道 | 保留原生拒绝与未确认原因 |
| DSH ACP | idle 直发；followUp / steer 返回能力限制 | cancel 按原生中断确认 | 保留输入与失败原因 |

### 6. 生命周期与所有结果路径

命令受理、队列投递、模型执行和消息落地分别确认；回执按操作身份幂等重放，未知结果通过证据核对，用户重试建立新身份。

当前普通回执预算为 60 秒，确定回执保留至少 5 分钟、上限 4096；在途和未确认记录按容量准入。跨 Host 重启的 exactly-once 保证尚未提供。

| 编号 | 结果原则 |
| --- | --- |
| P01 | 本地失败保留输入与附件。 |
| P02 | 明确拒绝返回原因及恢复入口。 |
| P03 | 队列受理持续呈现排队状态。 |
| P04 | 原生提交与消息落地分别确认。 |
| P05 | 提交前失败释放保留位并继续调度。 |
| P06 | 提交后未知保留身份并核对。 |
| P07 | 撤回按队列拥有者的结果结算。 |
| P08 | 回合结束核对所属活动和后续队列。 |
| P09 | 重复与迟到结果按操作身份处理。 |
| P10 | 目标结束按提交阶段收尾。 |
| P11 | 权威证据推进真实结果。 |
| P12 | 核对未果保持可见并提供核对入口。 |

### 7. 串行、恢复与隔离

每 Session 的写调度由单一拥有者串行管理，异步结果按目标与代次核验。回合、压缩及恢复事实驱动后续调度，连接恢复重建认证与订阅，业务结果继续按原身份核对。

2026-11-05 DSH 后端桥接恢复（ADR-0020 / ADR-0056）：自动恢复重建已有服务的认证连接与目录订阅，显式激活负责服务准备及原生会话操作；二者串行复用准备过程。暂停和代次失效按所属生命周期收尾，业务结果继续按 P06 / P12 核对。

### 8. 显示与现有 ADR 的修订

界面以明确的发送、排队、未确认和失败状态反馈结果，输入恢复副本保存到精确落地或明确撤回。共用 outbox 与操作账本维护稳定身份、阅读位置和原位恢复，配置确认与主回合串行契约继续适用。

## Verification

[测试规则](../../AGENTS.md#测试)；[ConfigLedgerTest.kt](../../android/app/src/test/java/com/orbising/orbis/ConfigLedgerTest.kt)；[ConfigComposerInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/ConfigComposerInstrumentedTest.kt)；[原始证据](../../.artifacts/)。

## Consequences

每一种输入都有责任边界与可观察终点。压缩等活动不再是发送状态机之外的孤立显示，原生不支持或结果未知也不会被无限等待掩盖。代价是需要统一去重和回执预算、适配器调度互斥、可恢复的投递结果以及跨状态回归；后续演进同步维护准入模型与相关验证。
