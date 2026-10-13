# ADR-0028：Host 统一通知生命周期

日期：2026-10-10

Status: accepted（协议 12 的实现已接入；验证与运行环境生效情况见第 12 节）

2026-10-13：[ADR-0032](0032-host-owned-agent-state-model.md) 决定将现有 NotificationStore 纳入统一 Agent/Host 模型，复用本文唯一通知权威、独立版本、来源恢复与设备关闭规则，不建立平行通知库存；模型整合尚待实现。

关联：[ADR-0008](0008-drop-backward-compatibility.md)、[ADR-0023](0023-codex-revert-and-client-refresh.md)、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0027](0027-source-owned-runtime-diagnostics.md)。

## 问题与现状

APP 聊天页顶部的错误文字可能一直存在，例如 Codex 已恢复输出，`Reconnecting...` 仍未消失。检查当前实现后，这不是一个错误文案的问题，而是通知缺少身份、归属、恢复依据和可重取的当前集合：

- `runtime.error` 只有文字、`recoverable` 和可选 `commandId`。`recoverable` 不能说明正在自动重试，也不能说明何时恢复。
- APP 的单个 `runtimeError` 槽位把重试、最终失败、沙箱、配置和桌面刷新错误相互覆盖。清除其中一种错误也可能清除另一种。
- `interactionNotice` 同样混合完成、取消、超时、提交失败和渲染失败；部分结果一直留到下一次交互。
- Pi 的元数据、能力和目录读取，DSH 的恢复与目录读取，缺少按操作归属的解除事件。DSH 创建分支成功也使用错误通道。
- 只补一次解除事件不能解决断线期间漏收解除、Host 重建、APP 重开和迟到通知复活。

ADR-0027 的专项方案为 Codex 保留了原生 `willRetry`、`turnId`，并通过 `live.diagnostics.error` 复制单条诊断。本 ADR 保留原生恢复语义，以独立通知集合替代单槽位；`live.diagnostics` 和 APP 的远端 `runtimeError` 已移除。

对本机 Codex 桌面版 `26.1002.7124.0` 的只读核对提供了专项依据：客户端区分自动重试的 `stream-error` 与最终失败的 `system-error` / `latestTurnError`，合并连续重连尝试；`model/rerouted` 投影为会话条目。这是该版本的行为证据，不是所有通知都可以按同一个倒计时清除的依据。

## 1. 职责边界

采用 Host 内的共享通知中间层。中间层管理通知记录的创建、更新、结束、期限、版本和同步；Agent backend / Pi RuntimeBridge 提供标准化的来源事实。

| 层 | 负责 | 恢复事实由谁确认 |
| --- | --- | --- |
| Codex、Pi、DSH 适配层 | 读取原生字段；确定通知代码、身份与归属；报告当前通知集合和生命周期事实；排除过期原生回调 | 对应适配层；例如 Codex 的同回合输出、原生完成状态、沙箱 readiness、桌面刷新 operation 结果 |
| Host 通知中间层 | 验证来源与归属；幂等更新；按准确身份结束；执行明示的期限；保存当前投影；向设备同步完整集合 | 使用适配层提供的事实；Host 自己拥有的操作则由对应 Host 服务确认 |
| APP | 校验 Host 代次、通知版本和会话归属；展示多条当前通知；提交显式操作；管理手机本地任务的提示 | 不根据文字、普通 `idle`、任意新消息或本地等待时间猜测远端恢复 |
| Relay | 转发现有加密 Envelope | 不读取通知，不执行通知逻辑 |

这保留 `CONTEXT.md` 和 ADR-0026 的边界：通用 Host 不解释 Agent 的业务语义。Codex 恢复条件仍属于 Codex backend；将所有原生事件名称和文字匹配集中到 `host-service.ts` 不符合本决定。

Host 获得的是独立的当前通知投影，不增加聊天历史数据库，也不接管交互请求、队列、传输或 Session 的执行器。所有后端使用同一标准化接口；APP 不通过 `agentKind` 选择清除规则。

## 2. 通知模型、身份与归属

以下是已实现的契约。生产者身份与设备受众由 Host 的认证路由确定，不允许载荷自选身份。

| 字段 | 决定 |
| --- | --- |
| `notificationId` | Host 为一个来源身份分配的稳定通知 ID；在该次 occurrence 内保持不变，不按文案生成 |
| 来源 runtime、`producerEpoch`、来源 `revision` | runtime 来自 Host 认证路由；生产者实例代次和标准化状态版本来自 `notification.source`，Host 保存为独立 `sourceRevision` |
| `code`、`occurrenceId` | 适配层定义的稳定问题代码及本次发生身份；同一次重连尝试更新同一项，恢复后再次发生使用新 occurrence |
| 快照归属与 `scope` | 快照外层携带 `runtimeId`、`sessionId`；单项 scope 携带原生 `turnId`、`requestId`、`operationId`、`commandId`。身份字段不能跨归属复用 |
| Host 内部 `deviceId` | 未设置表示会话共享；命令提交失败按发起设备定向。受众由 Host 认证与命令账本确定，不向来源开放自选设备字段 |
| `severity` | `info` / `warning` / `error`；与生命周期分开，信息不能因为使用现有错误入口而显示成故障 |
| `message` | 展示文字；不参与去重、清除或分类 |
| `lifecycle` | `condition` 或 `outcome`，见下一节 |
| `expiresAt` | 仅 outcome 可有；由 Host 从明示的展示期限计算，不依赖手机时钟决定远端状态 |
| `verification` | `confirmed` 或 `unknown`；来源断开或尚未完成重新核对时明确未知，不伪造已恢复 |
| `createdAt`、`updatedAt` | 诊断与展示排序使用，不替代来源版本 |

一个活动通知的来源键为 `(runtimeId, sessionId, producerEpoch, scope, code, occurrenceId)`。同一来源键的新版本更新同一项；不同回合、请求或操作互不覆盖。关联字段必须使用原生身份或 Host 已确认的操作身份，不能按消息文字或列表位置猜测。读取类单例 condition 可以复用操作键；完整集合确认缺席后，Host 会删除原通知，下次出现时分配新 notificationId，并重新显示。

生产者代次由 Host 在接入或适配层重建时绑定。任意通知载荷不能自行宣布新代次并覆盖当前来源。适配层的异步读取必须带协调代次；旧读取即使更晚完成，也不能分配更大的版本重新成为当前事实。

## 3. 生命周期与用户关闭

### 持续状态：condition

表示仍存在的情况，例如同回合自动重试、沙箱未就绪、桌面刷新待恢复、目录读取不可用。

正常状态转换为 `active → resolved`；归属结束或新的已确认状态替代它时，可分别记录 `owner_ended` 或 `superseded`。只有生产者的明确恢复事实或该归属的完整权威集合可以结束它。condition 没有通用 TTL。

自动重试转成最终失败时，适配层在一个变更批次内结束重试条件、创建该回合的失败结果；不能短暂显示两个互相矛盾的状态。对一个沙箱问题的恢复只能结束该沙箱身份，不能执行“清空 runtime 所有错误”。

### 已发生结果：outcome

表示已经发生的结果，例如交互完成、取消、超时、创建分支成功，以及一次命令或配置加载报告。

结果自身不等待“恢复”。Host 统一维护展示期限，过期转换为 `expired` 并发布新集合。完成 / 取消 / 成功信息默认展示 8 秒，警告与错误结果默认展示 30 秒；重复投递不延长期限，适配层可以为有明确产品依据的类型注册其他策略。

回合最终失败采用明确的回合策略：保留到下一回合或当前分支切换，所属失败仍留在历史结果中；普通输出不会清除最终失败。策略由适配层报告归属结束事实，Host 不根据任意 `turn.started` 推断原生回合是否已切换。

没有原生解除或核对能力的警告，必须说明是“本次操作报告的结果”，按 outcome 展示，不能假装成可验证的持续健康状态。需要用户处理的持续问题只有在具备可核对的状态依据时才注册为 condition。

### 关闭不等于恢复

用户关闭展示项只影响该设备对该 occurrence 的展示，不结束共享 condition，也不完成命令或审批。新的 occurrence 会重新显示。关闭操作带通知身份并校验设备权限；另一设备的展示不受影响。

当前交互请求是否阻塞、是否可回答，继续由交互请求状态决定；关闭一条通知不能绕过审批。通知从当前集合移除也不能删除历史中的工具、消息、队列或命令结果。

## 4. 标准化来源接口与丢失恢复

生产者使用共享 `NotificationSource` 维护当前集合，提供两种事实：

1. **当前状态**：来源调用 upsert / resolve / batch；每次变化都发送有版本的完整 `notification.source.notifications`，同时用于首次接入、重连及周期核对。首版没有线上增量 patch。
2. **一次结果**：`notification.source.outcomes` 只携带本次结果，后续 announce 不重播。当前回合最终失败作为无 TTL 的 owner-bound outcome 留在当前集合，由回合归属结束解除。

完整集合中的缺席，只能结束同一生产者的持有型通知，不能删除 Host 尚未到期的一次 outcome。局部集合、核对失败、历史分页和 `complete=false` 不能通过缺席清除通知。首版每一来源事件都是完整集合，版本跳跃可以直接应用；不完整新版本会提升已观察版本，旧成功不能回退核对状态。

短暂 outcome 的发生事实与 condition 的当前状态重播分开。来源重连不能将过去的完成 / 取消重新作为一次新结果发送；已接收 occurrence 在有界去重窗口内只计算一次期限。来源与 Host 每个 runtime 各保存最近 256 个结果回执，Host 命令关联保留 5 分钟、总上限 4096 项，已结束命令不重复发布 outcome。新 Host 首次建立来源集合不重播过去的短暂结果；原生可核对的当前回合失败按回合策略单独恢复。这不是永久的事件去重数据库。

来源层也必须可恢复，不能只把 Host→APP 的最后一段链路做成可靠的：

- Codex backend 将原生通知处理与现有原生历史 / 运行态核对归并，补回漏收的完成和最终失败。正常元数据、用量及目录刷新不是重试恢复依据。
- Pi RuntimeBridge 在发送前保存它自己拥有的活动通知状态；connected / resync 重播完整集合。元数据、capabilities、catalog 成功只解除相应读取操作的失败。
- DSH backend 在原生重连恢复完成及相应读取成功时报告准确解除；重新订阅不等于会话流已恢复。
- Host 自有操作从对应任务状态构造事实，不通过捕捉日志文字构造生命周期。

前台同步周期沿用现有 15 秒调度，来源读取按生产者合并，避免每台手机触发一套重复读取。变更事件负责及时更新，重取负责修复最后一次解除丢失。

若原生系统只发一次警告、不保存也不提供当前状态，协议不能创造恢复事实。适配层应采用 outcome，或者明确保留 `unknown` 并显示核对限制；不能将空回复、超时、重新连接或下一回合统一认定为问题解决。

## 5. Host→APP 的独立同步协议

通知有自己的 Host 代次和集合版本，不占用 Agent Session 的 source seq，不改变 Session 的 head / live / SQLite 入库门槛。正文没有变化时，通知解除仍能同步；聊天 `unchanged` 也不代表通知没有变化。

首版只发布有界完整通知快照，不引入通知 patch 日志：

- `notification.snapshot` 包含 Host 代次、投影归属、单调集合版本、`complete`、来源核对状态和对该设备可见的通知集合。
- 每次创建、实质更新、结束和过期后推送当前快照；无变化或重复输入不推进集合版本。
- 设备握手完成、聊天页进入前台 / 恢复前台时发送或请求当前集合；前台每 15 秒通过 `notification.sync` 独立核对。
- `notification.sync` 由 Host 处理，按设备和 runtime 合并、定向返回并有界重试；它不要求 Agent backend 正常执行聊天命令。不同设备的关闭视图在序列化时过滤，不共享关闭状态。
- 通知使用现有加密 ctl 通道；Relay 不新增通知业务入口。定向回复不会改写其他设备的可见集合。

APP 对同一 Host 代次、同一归属只接受较新的完整集合，首次基线可接受版本零。已接受完整基线后，同版本重投幂等、旧版本丢弃；因每次都是完整集合，通知版本跳跃可以直接恢复，不要求补每一个变更。

新 Host 代次必须通过当前认证握手确认，不能凭迟到事件自行切换。新代次的版本可以重新从零开始；前一代次的 transport 高水位线不能阻止新通知基线应用。APP 切换 Session / runtime 后，响应必须核对原先归属，不能写进新的会话。

`complete=false` 只标明核对或资源限制，不能当作空完整集合。APP 保留最后已知投影并提示未知，随后重取。部分集合不能触发缺席删除。Host 已确认的过期、来源解除和设备关闭另带 `removedNotificationIds`，可以在来源未知时结束对应展示；它不是对原生健康的推断。Host 保留最近 256 个移除身份，再合并该设备最多 64 个关闭身份。通知集合自身的版本与现有 runtime ctl / msg transport sequence 分开校验。

通知数据不依赖历史分页或 SQLite 事务提交。历史页无权创建、清除或恢复当前通知；但回合 / 分支有效性必须先由 backend 验证，不能让独立通知通道绕过 ADR-0024 的原生协调代次。

## 6. 重建、离线与资源边界

首版中间层只维护有界当前投影，不新增永久通知历史或持久化通知数据库。Host 重建时产生新 Host 代次，适配层和 Pi 源端重新报告当前集合：

- APP 中前一 Host 代次的通知只能作为“待核对”的旧展示，不能直接当作新代次活动通知。
- 已过期的短暂 outcome 不重播；仍有效且来源可恢复的 condition / 回合失败重新建立基线。
- 来源无法重建的事实明确为未知，不能宣称 Host 内存清空就证明原生无故障。跨进程保留每一次短暂结果不是首版保证。

手机到 Host 的 Path 断线不结束任何源端 condition。来源暂时断开标记对应通知未知；确认 runtime / Session 归属真正结束后，中间层终止其归属的通知。重新激活同一个原生 Session 需要新接入代次和来源集合，旧实例回调不能复活已结束记录。

宿主级问题和指定设备问题不能随任意 Session 离线一起清空。APP 本地“此运行实例已离线”由当前目录状态派生，不重复创建一条永久远端错误。

首版每个 runtime 当前集合上限 64 项，单条文案上限 4 KiB，快照总预算 256 KiB。来源文案按 Unicode 码点截断后构造合法输入，线上超长文案拒绝。生产者注册有限问题代码，重复恢复尝试合并同一 occurrence。Host 总 runtime 投影上限 2048，达到上限只回收已经结束的归属；集合版本使用 Host 全局递增值，重新接入的同名 runtime 不会被 APP 旧投影版本压制。未知来源事件不能自行创建归属。手机投影同样限制为 2048 个。

不能为满足上限静默淘汰未解决 condition 后宣告完整。超限批次拒绝原子提交，标记来源投影不完整、保留最后已知集合，并由 Host 记录拒绝、周期重取。生产者额外记录最多 64 个溢出身份，只有这些身份明确 resolve 或重新进入当前集合后才恢复 complete；再超出该身份预算则保持未知，需重建来源。错误本身不能递归生成通知。

## 7. 通知覆盖与适配表

下表记录代码适配状态。Host / 来源测试、Android reducer 和界面验证各有不同边界；真实 Codex / Pi / DSH 与用户运行环境的验收另列第 12 节。

| 通知 / 结果 | 已实现的归属与解除规则 | 代码与验证状态 |
| --- | --- | --- |
| Codex `Reconnecting...` / `willRetry=true` | `codex.turn.retry`；同回合输出 / item、完成 / 打断、原生核对或归属结束解除 | 已迁移独立 condition；Codex 故障与漏收完成单测通过 |
| Codex 回合最终失败 | `codex.turn.failed`；原子替代重试，保留到下一回合 / 分支切换 | 已迁移 owner-bound outcome；同文字语义转换、迟到回合与核对单测通过 |
| Codex Windows sandbox 未配置、需更新、设置失败 | `codex.sandbox`；setup 成功 / 最新 readiness 成功只解除自身 | 已实现；独立恢复单测通过；异步检查使用独立代次；真实 Windows readiness 联调待验收 |
| Codex `configWarning` | `codex.config`；本次配置加载 warning outcome，30 秒 | 已实现；无原生问题解除查询，不承诺配置已修复或跨重启恢复该结果 |
| Codex revert 后桌面 / TUI 刷新待恢复、需手动处理、失败 | `codex.refresh`；有协调器 operation 时持有 condition，complete 精确解除；无法建立 operation 时用 30 秒结果 | 已实现；桌面 hydration 解除只影响刷新、仍保留 sandbox 的测试通过；TUI / 手动完成原生验收待进行 |
| Codex“交互未受理” | `codex.interaction.rejected`；原生 server request ID，30 秒 outcome | 已实现；审批生命周期测试通过 |
| 交互已完成、电脑端完成、取消、超时 | `interaction.result`；Host 观察标准 SDK 请求终态，完成 / 取消 8 秒、超时 30 秒，重复终态不续期 | 已实现；Host 去重 / 过期及 APP 请求终态单测通过；重连请求快照不重播历史结果 |
| 交互回答提交失败 / 结果未知 | `interaction.submit`；request + command，发起设备定向；未知提交继续由请求状态核对 | 已实现；设备隔离单测通过；APP 保留请求行 responseError，移除重复全局弹窗 |
| APP 交互渲染 / 恢复失败 | 本地 request 错误 map；同 request 验证成功 / 结束清除，完整请求快照替换 | 已实现；无关请求不能误清本地错误的 Android 单测通过 |
| Pi transport 错误 | `pi.transport`；连接恢复时解除并重播来源库存；源连接离线标记未知 | 已实现；连接基线重播验证通过；真实 Pi 断连验收待进行 |
| Pi metadata / capabilities / catalog 读取失败 | `pi.metadata` / `pi.capabilities` / `pi.catalog`；各自成功解除，旧异步结果过滤 | 已实现；独立成功、旧能力成功不能解除新失败及来源重播测试通过 |
| DSH Web 重连 / 会话流恢复 | `dsh.recovery`；socket reconnect 不解除，当前 follow 的有效 snapshot 才解除 | 已实现；旧 follow、畸形快照不能解除、有效恢复测试通过 |
| DSH Web skills / model catalog 读取失败 | `dsh.skills` / `dsh.models`；对应读取成功解除，有代次与 Session 对象检查 | 已实现；skills 恢复不清 models 的故障注入测试通过 |
| DSH 创建分支成功 | `dsh.fork`；原生新 Session ID，info outcome，8 秒 | 已迁移；由共享 Host outcome 生命周期处理；真实分支提示验收待进行 |
| 旧 DSH ACP 后台错误 | `dsh.update.failed`；一次后台更新失败的 30 秒 outcome | 仍支持的 ACP 入口已接入；旧 Session 通知回调过滤；原生无可核对健康问题，不使用永久 condition |
| Codex `model/rerouted` | `codex.model.rerouted`；优先 item / turn 原生身份，8 秒 info outcome | 已接入通知；首版没有稳定 canonical Entry 映射，不伪造持久聊天条目，与原设计的历史投影目标有此明确限制 |
| APP 聊天同步失败 / 慢同步 / 显式重试 | 保留本地 SessionSyncTasks，成功 / 取消 / 新重试按原任务收尾 | 沿用独立任务生命周期；Host 先处理定向 sync 错误，不注册会话共享故障 |
| runtime 离线 / 需要本地处理的交互 | 继续从权威目录 / 请求状态派生 | 保留；来源暂失未知与真正 owner ended 分开处理，不创建重复永久通知 |
| 通用命令失败、协议 / 版本错误 | 带 commandId 的结果定向归位；协议、版本、认证错误继续使用连接层可确认提示 | 已接入命令账本；无 commandId 的旧 runtime.error 仅日志记录，不能复活顶部通知 |
| 工具执行失败、消息失败、队列拒绝、传输失败结果 | 保留各自历史行 / 任务结果，通知关闭或过期不改变执行结果 | 原状态路径保留；本次不将失败标为成功、不隐式提交审批 |

表内每个远端来源在适配时必须补齐创建、更新、正常结束、失败结束、迟到过滤和重新同步六个入口。没有恢复依据的来源应记录限制，不能仅因为存在一个 clear handler 就标记为完成。

## 8. 与 ADR-0027 的关系和协议升级

统一通知集合已替代 ADR-0027 的 `live.diagnostics.error` 单槽位传输与 APP `hasSourceDiagnostics` / `runtimeError` 展示权威。保留 ADR-0027 的原生 `willRetry`、turn 归属、恢复依据和迟到过滤要求，改由 Codex 标准化来源接口表达。

适配切换必须一次性移除通知的双重展示入口：不能同时让 `session.patch.live.diagnostics`、无关联 `runtime.error` 和 `notification.snapshot` 写同一顶部状态。`runtime.error` 若保留，只服务带命令关联的原任务失败；Host 在通知入口之前先完成 `session.sync` 的定向关联，不能把一个设备的同步失败广播成全会话故障。

本次由协议 11 升级到协议 12，新增通知契约并移除诊断字段，按 ADR-0008 拒绝新旧组件混跑，保留明确更新提示。

Protocol、Host、Pi RuntimeBridge / extension、APP 同步修改；Relay 只随硬版本门槛协调更新，不获得通知语义。Host 重启、push、Release、上传和部署仍按 AGENTS.md 分别获得本次授权。ADR、代码、测试和本地产物准备不会自动替代这些授权。

## 9. 实施顺序与完成标准

1. 先落地本 ADR 和通知覆盖表，再依用户“开始适配”指令实施。
2. 定义 strict 模型、标准化来源接口、Host 有界 store 和快照同步。先用测试桩验证通用生命周期，不在 Host 核心添加原生语义分支。
3. 接入 Codex：迁移 ADR-0027 专项恢复规则，并补齐 sandbox、config、refresh operation、interaction 和 rerouted；原生核对与通知发布使用同一协调代次。
4. 接入 Pi / DSH：来源当前集合和重播、读取恢复、DSH 订阅恢复、info outcome，以及仍启用的旧入口。
5. APP 改用通知集合；移除远端单槽位权威；将本地任务提示映射到同一展示分类，保留请求、历史和任务本身的状态。
6. 更新 ADR-0027 的替代状态和 `CONTEXT.md` 的已落地术语，运行 Protocol / Host / 来源适配 / APP 验证，再进行真实链路验收。

完整适配的报告应逐行更新覆盖表，区分“设计覆盖”“代码完成”“单测通过”“真实链路已验证”“运行环境已生效”。首版有界内存投影不能被描述为跨 Host 崩溃永久保存所有通知。

## 10. 验证矩阵

| 场景 | 必须验证的结果 |
| --- | --- |
| 重连提示与 sandbox / config / refresh 告警同时存在 | 多项独立展示，重连恢复只结束自己的 condition |
| 相同文字从重试变成最终失败 | 原生语义决定结果，原子替代，不按字符串相等漏掉变更 |
| 连续重试、重复请求终态、重复来源批次 | 同 occurrence 幂等，不无限增长，不延长 outcome 期限 |
| 其他 turn 的输出、迟到报错、旧 refresh operation 成功 | 不结束或复活当前归属的通知 |
| 来源→Host 最后一个 resolve 丢失，随后没有新聊天 | 来源集合核对修复；若原生不可重取，明确未知，不伪报健康 |
| Host→APP 最后一个解除快照丢失 | 前台周期核对 / 重连完整集合清除，正文 unchanged 不阻止修复 |
| 通知快照先于 / 后于 session.patch、ctl / msg 插队 | 两套版本各自安全；不绕过来源分支和回合核验 |
| 新版本快照先到、旧版本晚到；通知 seq 跳跃 | 完整新版本生效，旧版本不回退，无需逐项回放 |
| 来源核对失败、局部列表、资源超限 | 不将缺席当作解除，保留最后已知集合并明确未知 |
| Pi 重连，手机到 Host 始终在线 | 完整来源重播恢复条件状态，不只重播 capabilities |
| DSH socket 已连，但会话流尚未恢复 | 恢复提示继续有效，状态确认后结束 |
| Host 重建、旧高 transport sequence、旧生产者回调 | 握手建立新代次基线，旧序号不压制新基线，旧实例不能复活通知 |
| 原生 revert / 分支切换 / Session 重新激活 | 只结束已经确认失效的归属，当前 sandbox 等独立问题保留 |
| 两台设备，只有一台提交回答失败或关闭提示 | 提交失败与关闭按设备隔离；共享源端故障仍可见 |
| 手机切换会话后收到旧定向快照 | 归位原会话或丢弃，不污染新会话 |
| Host 到期 / 手机时钟偏移 / APP 暂停后恢复 | Host 到期为权威；重取后无过期 outcome，不靠手机猜 condition 恢复 |
| 通知过期、用户关闭、归属结束 | 审批不被隐式提交，失败历史、消息 / 队列 / 传输结果仍保留 |

需要 Host store 和来源适配的故障注入单测、协议拒绝非法归属 / 超限数据测试、Android reducer 测试，以及真实断连 / 重连 / 多设备验证。测试桩通过、APK 构建完成和用户运行的 Host 已加载修复是不同的验证事实，应分别记录。

## 11. 取舍

拒绝“全部通知 N 秒后消失”：它会隐藏尚未恢复的条件，并把手机时间当成远端状态。期限仅用于已发生结果。

拒绝“每个页面 handler 各写 clear”：它仍然缺少独立身份、来源对账和断线恢复，也无法隔离同时发生的问题。

拒绝“Host 用文案或普通运行状态猜恢复”：它越过 backend 的原生语义边界，并会让其他操作的成功误清当前故障。

拒绝同时保留 `live.diagnostics` 和通知中间层两套权威。独立通知快照增加一条小型同步流，但使通知恢复不依赖正文历史、源端 seq 或 APP 入库成功；首版完整集合与有界内存状态控制实现和恢复复杂度。

## 12. 实施与验证记录

2026-10-10，协议 12 的共享模型、Host 中间层、Codex / Pi / DSH 来源适配和 Android 多通知展示已接入。第 7 节逐项记录代码状态与原生限制。来源尚未完成核对时，Host 确认的过期、解除和设备关闭通过 `removedNotificationIds` 单独生效；Android 保留其他未知 condition，避免已结束提示长期挂在顶部。

| 验证 | 本次结果与边界 |
| --- | --- |
| Windows 工具链 | Node 为 `C:\nvm4w\nodejs\node.exe`；Android 使用 Windows JDK、SDK 和串行构建入口 |
| TypeScript / workspace 构建 | `npm run typecheck`、`npm run build` 通过，运行时 dist 已生成 |
| Node 全量测试 | 88 个测试文件、877 项测试通过，包含协议、Host store 和来源故障注入测试 |
| 加密 Relay socket | 真实 socket 与加密 Envelope 测试通过；两台设备的通知关闭视图隔离已覆盖。来源使用测试桩，不代表真实 Agent 产品联调 |
| ESLint / 差异检查 | 本轮修改的通知协议和 Host store 文件 ESLint 通过；`git diff --check` 通过 |
| Android 单测 | 41 个测试文件、379 项测试通过，无失败、错误或跳过 |
| Android Lint | `:app:lintDebug` 通过，0 个错误、25 个警告；完整报告随 APK 保存在 `.artifacts/app/android-lint.xml` |
| Android 构建 | App APK 与测试 APK 已生成并校验 SHA-256；来源清单使用相同 buildId `6e42bae0-ea52-4da8-bea2-c9d20144ce49` |
| Android Compose 界面测试 | 2 项测试已编译：多通知独立恢复 / 精确关闭，以及不完整库存保留未知状态。尚未运行验收，不能记为通过 |
| 真实原生链路 | Codex、Pi、DSH 的相关适配单测及桌面协调器 fixture 通过；真实断连、Windows sandbox readiness、TUI / 手动刷新和分支提示仍待产品联调 |
| 用户运行环境 | 本次未停止、重启或覆盖安装用户 Host，未 push、发版或部署。当前运行环境尚未确认加载本次修复 |

模拟器尝试在安装后记录到 0.93 GB 可用内存，低于本机 1.5 GB 运行停止阈值，因此在 instrumentation 开始前关闭了本任务实例；adb serial、进程退出和占用释放均已确认。最终验证时可用内存约 1.37 GB，未再次启动模拟器，也未操作用户实体设备。

最新本地产物为 `.artifacts/app/app-debug.apk`、`app-debug-androidTest.apk`、对应来源清单、SHA-256 清单和验证记录；目录只保留本次结果。Node 构建结果保留在各 workspace 的生成目录，未覆盖正在使用的 `.artifacts/host/OrbisHost`。

运行环境生效需要 Protocol / Host / Pi extension / APP / Relay 的协议 12 协调更新。Host 更新或重启，以及 push、发版和部署分别遵守本次授权规则；代码、单测及本地 APK 完成不表示这些操作已获授权或已经执行。
