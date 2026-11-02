# ADR-0055：所有 Agent 状态下的用户输入与处理结果

日期：2026-11-01

Status: accepted（契约已确定，按本文开始实施；未完成的实现和验收不得记为通过）

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0031](0031-host-permission-management.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)、[ADR-0029](0029-session-read-operation-state-machine.md)、[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)、[UI 回归](../testing/ui-regression.md)。

受影响 feature：V05、V09–V10、V12、V16–V18；关联 S16–S17、V03、V07。不新增视觉 feature 编号，不改变布局、滚动、消息身份或既有动效。

## Context

Codex 压缩期间发送可能一直显示“发送中”。隔离协议夹具确认三个代码缺口：独立压缩没有参与发送准入；只有压缩完成和 idle、没有 turn/completed 时队列不补跑；队列先报 delivered，启动失败又没有对应 rejected。正常 turn/completed 则可以继续投递。夹具证明分支存在，尚不能代替用户故障的真实事件序列。

只补一个 compaction 判断不能解决启动、审批、重试、停止、重连和关闭时的同类问题。本文要求所有已声明输入均有拥有者、准入判定、执行或排队路径和结果。处理可以是执行、排队、明确拒绝或待核对，不要求后端在任意状态都能执行任意操作。

## Decision

### 1. 范围与输入全集

覆盖 pi、codex、codexDesktop、claude、dsh（Web 与仍存在的 ACP 路径）。各后端保持原生能力边界；能力不支持必须明确拒绝，不用另一种操作冒充。

下表穷举当前 `RuntimeCommand` 的 20 个判别值。实现必须用类型穷尽检查和与协议 schema 的集合对照，新增判别值未登记时测试失败。无效或未来未知类型由认证协议入口拒绝，不进入后端。

| 输入组 | 当前判别值 / 内容 | 唯一拥有者与成功证据 |
| --- | --- | --- |
| I01 对话 | `user_message`：纯文本、文本加附件、附件输入生成的正文；无 delivery、followUp、steer | 后端队列 / 原生提交；源端用户消息及 clientMessageId / 原生声明映射才证明落地 |
| I02 撤回 | `user_message.cancel` | 队列拥有者；确认未投递并删除，或 already_delivered / not_cancelable |
| I03 Slash | `slash.execute`：只读查询、模型 / 思考 / 权限配置、压缩、历史改写 / 会话切换、产生提示的 skill / template、退出及扩展命令 | 后端当前已声明的命令目录；原生执行结果与必要配置 / 会话确认 |
| I04 权限 | `permissions.update` | 后端 opaque setting / option 校验和源端确认；不能代替单次审批 |
| I05 停止 | `stop` | 当前执行拥有者；原生中断确认、已结束或明确不可取消 |
| I06 交互 | `interaction.respond`：确认、选项、问卷、自由文本、取消 | 请求拥有者；校验 Host / Session / generation / request / extension / 期限 / 答案结构并取得处理结果 |
| I07 历史读取 | `session.sync`、`session.entry.request` | SessionSyncTasks / conversation state；带范围和身份的成功或失败 |
| I08 读取确认 | `session.snapshot.ack` | SessionSyncTasks；幂等消费 applied / rejected，不产生递归 ACK |
| I09 工具读取 | `session.tools.open`、`session.tools.read`、`session.tool.content.read`、`session.tool.content.cancel` | 工具库存 / 读取服务；opened / page / read.failed；取消仅结束自己的读取 |
| I10 文件审阅 | `session.changes.list`、`session.changes.read`、`session.change.detail.read`、`session.change.detail.cancel` | TurnFileChangeService；对应 summaries / page / failed，取消不作用于 Agent 执行 |
| I11 文件传输 | `file.download`、`artifact.download`、`artifact.cancel` | HostDownloadService；offer / 进度 / 完成 / 失败 / 取消，按设备私有任务隔离 |

配对、切换电脑、创建 / 激活 / 归档会话、供应商操作、上传、目录浏览、诊断和模型范围读取属于 `DeviceE2ePayload` 的 Host 服务请求，不伪装成 RuntimeCommand。它们继续由各自带 requestId / transferId 的操作拥有者处理；Agent 忙碌不应阻塞独立的 Host 读取或传输。会改变同一 Session / provider 的操作必须遵守下面的互斥、身份和未知结果规则。App 本地草稿、搜索、复制、选择、展开和导航不等待 Agent。

### 2. 状态是正交事实，不能用一个 busy 布尔覆盖

| 维度 | 状态全集 / 来源 |
| --- | --- |
| 传输 | 未配对、未加密就绪、在线、断线、重连；App / DeviceLink |
| 归属 | 没有 Session、在线绑定、替换中、已关闭 / 归档 / 下线；Host 与后端 |
| 执行 | idle、running、waiting_local_interaction；未知 / unavailable 是可用性，不能伪造 idle |
| 活动 | 启动中、压缩中、重试 / 退避、停止中、历史核对 / 恢复中、配置更新、供应商切换、关闭中；各有操作 / 回合 / 条目身份 |
| 输入 | 新建、受理、排队、提交源端、已落地、拒绝、撤回、不可撤回、结果未知、已失效 |

工具执行 / thinking / 输出流属于 running 的子活动；并行子 Agent 不结束主回合。自动压缩可在 running 内，也可有独立压缩而 execution 为 idle。压缩显示优先级沿用 V05：等待确认优先，显示不改写执行 phase。

所有组合按 §3 的优先级和 §4 的矩阵求值，因此不遗漏“重连 + 压缩 + 审批”等组合。新原生活动无法解释时进入未知并触发核对，不按 idle 放行写操作。

### 3. 准入优先级（先匹配先处理）

| 顺序 | 条件 | 处理 |
| --- | --- | --- |
| G01 | 身份 / 认证 / schema / 长度 / 附件结构非法 | 写入前拒绝；保留草稿；不给源端副作用 |
| G02 | 同 operation 身份重复 | 同设备、同目标、同内容重放已有回执或 pending，绝不再次执行；异内容 / 异设备冲突明确失败 |
| G03 | App 通道尚未写入 | 本地失败，保留输入；不创建已发送假象 |
| G04 | 已发送后断线、Host / 后端重启、目标代次变化 | 尚未执行可确认拒绝；可能执行的一律 unconfirmed 并核对，不自动重新提交 |
| G05 | 专用读取 / ACK / 传输 / 本地输入 | 路由到表中拥有者；不被 Agent 的普通 busy 阻塞；各自范围 / 版本仍须校验 |
| G06 | Runtime 不存在、已关闭、归档、未绑定或后端不可用 | runtime_offline / session_not_found / 明确不可用；绝不落到另一个会话 |
| G07 | 能力或命令 / 参数不支持 | unsupported_command / option unavailable；不调用未声明原生能力 |
| G08 | interaction / cancel / stop | 校验其目标并优先处理；不能排在它所解除的等待之后 |
| G09 | provider 切换 / 关闭 / 历史改写 / 配置互斥正在进行 | 新写操作明确拒绝 busy / switching；不能入一个永远无法继续的队列 |
| G10 | 历史来源恢复中或执行事实未知 | 新写操作拒绝 state_unavailable，允许核对和目标明确的控制操作；已受理输入保留并核对。已有显式本机历史操作之后提交的输入，可沿既有串行写车道等待该操作及其 hydrate 完成，执行前再次检查目标，不越过历史屏障 |
| G11 | 已知执行 / 活动 | 按 §4、§5 执行或排队；执行时再次校验同一归属和互斥条件 |

不得通过轮询日志文字、正文相似度或本地动画推断成功。缓冲区 / 队列 / 回执容量满时明确 backpressure / queue_full；不得静默淘汰仍待处理的输入。

### 4. 完整状态 × 输入矩阵

记号：E=当前可执行并跟踪结果；Q=只受理为可见队列、等待原生可执行；R=明确拒绝并给出原因；T=按目标身份执行控制；V=执行专用读取 / 校验契约；U=可能已执行，转未确认并核对。所有 E/Q/T/V 都必须经过 §6 的成功 / 失败路径。

| 状态（通过 §3 后） | 普通消息 | followUp | steer | 撤回队列 | Slash / 配置 | 停止 | 交互回答 | 读取 / 传输 / ACK |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| idle，无活动 | E | E（无需强制入队） | E（无需中断） | T | E，按命令类别 | T：无执行则 not_cancelable | T：仅仍有效请求 | V |
| 回合启动 / 捕获屏障 | R busy | Q | Q，等待当前启动归属后控制 | T，未提交可撤回 | 查询 E；写 R busy | T / not_cancelable | T | V |
| running（含 thinking / 工具 / 子 Agent） | R busy | Q | 后端支持则 T+Q / 原生 steer，否则 R | T | 查询 E；写按 §5 | T | T | V |
| waiting_local_interaction | R busy | Q | 支持则 T+Q，不能冒充回答 | T | 查询 E；写 R busy | T，清理所属请求 | T：校验后提交 | V |
| 独立压缩，execution=idle | Q，Host 声明真实队列 | Q | Q；没有可取消回合不伪造中断 | T | 查询 E；其他写 R busy | 原生支持则 T，否则 not_cancelable | T | V |
| running 内自动压缩 | R busy | Q | 原生支持则 T+Q，否则 R | T | 查询 E；写 R busy | T | T | V |
| 原生重试 / 退避 | R busy | Q | 支持则 T+Q，否则 R | T | 查询 E；写 R busy | T | T | V |
| 停止处理中 | R busy | Q，等待确切停止结论 | 支持则 Q，不重复中断 | T | 查询 E；写 R busy | 同一停止重放；其他明确 pending / busy | T，已取消则拒绝 | V |
| 历史核对 / 恢复 | R state_unavailable | R state_unavailable | R state_unavailable | T / U | 查询 E；写 R | T，仅目标已知 | T，仅请求有效 | V |
| 配置 / provider / 分支 / 会话替换 | R busy | R busy | R busy | T / U | 查询 E；冲突写 R | T，仅当前代次 | T，仅当前代次 | V，旧版本失效 |
| 关闭中 | R closing | R closing | R closing | 未提交则取消，其余 U | 仅退出结果重放，其余 R | T / not_cancelable | R stale / cancelled | V；无有效范围则失败 |
| offline / closed / archived | R offline | R offline | R offline | 已知未执行可取消，否则 U | R offline | not_cancelable | R stale / offline | 有已确认缓存则 V，否则明确失败 |
| 断线 / 重连，已发出 | U | U | U | U | U | U | U | 由范围读取 / 传输拥有者恢复，不能假成功 |
| 执行或原生活动未知 | R state_unavailable | R state_unavailable | R state_unavailable | T / U | 查询 E；写 R | T，仅有目标身份 | T，仅请求有效 | V，触发核对 |

无 delivery 的 busy 消息继续明确拒绝，保持用户已选择的投递语义；独立压缩的 idle 是唯一新增自动暂存场景，因为 App 依据真实 execution=idle 正常发送。Host 公开同一 App messageId 的队列记录，使客户端知道输入正在等待。客户端不根据“压缩中”文字自行改协议。

### 5. 后端能力与 Slash 子路径

| 后端 | 消息 / 队列 | steer / stop | 不支持时 |
| --- | --- | --- | --- |
| Pi | 扩展持有待投递输入；isIdle 与压缩 / 队列 / 启动保留位共同判断；原生可执行后逐条投递 | 保持原生 abort + 队列语义，停止和压缩完成要触发核对 / 调度 | 明确 unsupported / not_cancelable |
| Codex / Codex Desktop | 适配器队列，包含独立压缩暂存；启动保留位保证一次仅一条 | 既有 steer=中断+优先下一条；异步问题原生 steer 保持独立归属 | 没有回合不虚构 turnId；失败或未知按 §6 |
| Claude Mods | Host 保留命令，插件在主回合、压缩和已有提交保留位均空闲后串行提交 | 不支持 steer，明确 claude_steer_unsupported；stop 等主回合中断事实 | 不借 prompt.submit 等待 idle 冒充立即投递 |
| DSH Web | 原生 queue / steer，使用 requestId / queue item 身份和原生队列核对；只投影 `source.kind=user` 或旧版未声明来源的用户输入，权限变化、子代理 / 后台完成、插件和自动目标上下文仍由 DSH 消费，不进入用户队列、不结算 App 发送身份；未知显式来源同样排除 | 原生 cancel；审批独立通道 | 原生拒绝 / 不可确认须保留原因 |
| DSH ACP | 只支持 idle 直发；无原生队列时 followUp / steer 明确失败 | 原生 cancel，不能把 RPC 写入当中断完成 | 明确说明能力限制，保留可重发输入 |

Slash 准入由后端解释已发布目录：只读查询可以执行；权限、压缩、历史改写 / 新会话 / 切换在忙碌或冲突时明确拒绝；模型 / effort 默认同样要求 idle，但 DSH Web 原生已支持带规范化确认的下一轮选型，保持运行中更新下一轮配置的路径，不改变当前请求。会话名称是独立元数据更新，后端原生支持时可运行中执行；skill / template 等产生对话的命令只能 idle 执行，除非后端发布并实现了明确排队能力；退出走独立关闭操作。无法分类的扩展写命令保守要求 idle。命令不在目录或参数无效时立即失败。可查询不代表可修改；配置成功必须先发布原生确认值。

附件不增加独立发送车道：未上传完成不提交；已上传路径与消息正文一起受理、排队和失败；不能先投递正文再悄悄丢附件。仅取消读取 / 下载不取消 Agent；停止 Agent 不清空无关传输。

### 6. 生命周期与所有结果路径

命令受理、消息投递、模型执行、历史落地是四个不同事实。`pending` 必须保留 pending，不能写成设备操作 success；队列 accepted 只证明队列受理；`delivered` 只在原生提交确认后发布。消息落地仍用 ADR-0049 的精确身份对应。

| 路径 | 触发 / 证据 | 必须结果 |
| --- | --- | --- |
| P01 本地未写入 | 无加密连接、校验失败、写入拒绝 | 保留输入和附件；明确本地原因 |
| P02 源端明确拒绝 | busy、不支持、容量、参数、权限 / 认证、原生拒绝 | 命令 failure；队列对应 rejected；可重发 / 恢复草稿 |
| P03 受理为队列 | 排队记录存在 | 命令受理结果与 queue accepted；持续可见、可撤回，不能显示为已落地 |
| P04 原生确认提交 | 原生 RPC / 消息身份确认 | 对应 delivered；保留 App id；再以 canonical / live 精确对账 |
| P05 提交前失败 | 捕获 / 参数校验 / 明确未执行错误 | rejected + 失败原因；释放启动位并处理下一项，不能遗失后续队列 |
| P06 提交后结果不明 | 超时、连接丢失、进程退出、来源不完整 | `unconfirmed`；保存关联并主动核对；不自动重发、不伪报未执行 |
| P07 撤回成功 / 竞态 | 队列拥有者确认未提交 / 已提交 | cancelled，或 already_delivered / not_cancelable；不能先删后声称撤回 |
| P08 模型执行结束 | 完成、中断、最终失败 / 原生确认 idle | 只结束所属回合；核对压缩、交互与队列；恢复下一项调度 |
| P09 重复 / 迟到 | 相同操作 / 旧 generation、turn、item | 重放当前结果或忽略过期回调；不能覆盖新操作，也不能再次执行 |
| P10 目标结束 / 替换 | 关闭、归档、会话切换、Host / 后端代次替换 | 未提交队列明确拒绝 / 取消，已提交未知；释放自己的资源，旧回调隔离 |
| P11 核对完成 | 精确消息 / queue / 原生操作证据 | 更新到真实结果；未知可以被证据确认，确定终态不能被普通 pending 回退 |
| P12 核对仍不能确认 | 有界核对结束、来源始终不可用 | 可见“未确认 / 待核对”与原因及显式核对入口；结束无限转圈，不自动重新执行 |

回执入口负责同设备+目标+commandId 的有界去重和回执重放；不得因重复请求延长原操作期限。后端异常必须被捕获并路由到发起设备。普通命令未得到终态时，Host 以独立的 60 秒回执预算转 unconfirmed；原生长回合可继续执行，不因该预算中断。后端已确认队列受理后命令可以结束，队列等待时间不以 60 秒伪造成投递失败。队列中仍有进展的长回合可等待，但当前原因必须可取；回合 / 压缩终结事件和已验证原生核对结果都要触发重新调度。未知结果只允许查询证据，自动重投递禁止。

确定回执至少保留 5 分钟、上限 4096；在途和未确认记录不得静默淘汰，满时拒绝新输入。同一个 App messageId 不得通过新 commandId 再次提交；同一 commandId 的合法重复重放原回执，重新发送必须同时生成新消息与命令身份。已确认消息身份及原生幂等保证范围之外，不承诺跨 Host 重启的 exactly-once；重启后通过历史 / 队列核对避免重复。App 在未确认状态不开放直接自动重发，已落地消息仍能精确消除本地行。

### 7. 串行、恢复与隔离

每 Session 的写调度只有一个拥有者，IO 不在模型写锁内执行。先保留启动 / 提交位再调用原生；任何 await 之后重新检查 Session 对象、generation、当前活动和目标身份。队列同一次只取一项；失败释放自己的保留位，不清别的回合状态。

补跑触发包含：回合完成 / 中断 / 最终失败、压缩完成 / 失败、原生确认 idle、完整来源核对、启动失败后清理、暂时互斥释放。先验证已知可执行，后取项；压缩结束而回合仍 running 时不提前开新回合；普通 idle 不能冒充压缩完成。只有超时而没有原生事实时不能安全补跑。

所有回执、队列、交互、异步回调和恢复请求携带 Host / device / Session / runtime 绑定与来源代次。另一设备的重复 ID、另一个会话的同文和旧代次结果均不得匹配。停止、退出、取消与提交竞态必须只产生与源端事实相符的结果。

### 8. 显示与现有 ADR 的修订

沿用现有气泡操作区、队列区、错误和恢复入口。发送中只表示仍等待受理 / 落地；Host 已确认排队时显示静态“已排队”并允许撤回，不用发送转圈表达整个排队时长。unconfirmed 显示静态“未确认是否送达”和核对入口，不自动重发。读取 / 导航 / 草稿不因 Agent 忙碌失去响应，状态更新不抢阅读位置。

队列接管显示后，App 仍保留隐藏的本地恢复副本（正文、附件、App id、命令与 Session 归属），直到源端用户消息精确落地或用户明确撤回 / 删除；它不是第二份源端事实，也不进入历史缓存。队列行与聊天行只显示一份。队列失败 / 未确认或后端下线时恢复为可见的失败 / 未确认行，不能因 Host 队列的受理回执丢失唯一输入副本。沿用 ADR-0049 的进程内 outbox 范围；本文不新增 App 进程被杀后的明文草稿持久化，也不承诺两个进程同时硬崩溃后的跨重启 exactly-once。

本 ADR 细化 ADR-0032 模块 10–13、17 和 ADR-0049 §3–4，并替代其“Host 队列受理后立即删除本地记录”为“隐藏恢复副本直到落地 / 明确撤回”：源端结果未知不能被成功受理或经过 15 秒解释成已执行；命令超时不等于投递失败；旧兜底删除只适用于已确认原生受理但缺身份映射的兼容路径，不能删除仍排队或 unconfirmed 的输入。ADR-0031 的配置确认与 ADR-0033 的 Claude 主回合串行提交继续有效，压缩活动加入提交互斥。

## Verification

2026-11-03 I03 Android 配置 composer 修复：ADR-0049 §6.7 的模型 / 思考条件乐观操作由配置账本独占回执；本地受理后释放 composer，成功仍须权威配置确认，失败 / 未确认仍由账本呈现。此类操作不进入下述普通 Slash 的“保留命令并等待通用回执”分支；未写入仍保留草稿。`ConfigComposerInstrumentedTest` 覆盖 Codex / Pi、重复选择、拒绝和未写入；既有 `ConfigLedgerTest` 保留确认前消息等待与断线矩阵。结果见 UI 回归 R27，真实后端未跑不得记为通过。

2026-11-02 Codex 终端激活补充：OS 接受开窗不等于原生 TUI 已启动。macOS 等待真实 TTY 的启动回执，失败按既有 `spawn_failed` 路径呈现；只释放本次新增且未运行 / 未等待审批的订阅，既有或运行中的会话不被开窗失败打断。历史创建来源不替代用户本次选择的终端后端，不通过迁移后端、删除写锁或重发输入修复可见窗口。自动测试映射与 R56 记录见 UI 回归方案，未验收状态保持。

### 必须实现的自动覆盖

| 用例组 | 覆盖 |
| --- | --- |
| AIN-01 协议全集 | 20 个 RuntimeCommand 与输入拥有者登记集合完全相同；类型新增必须补矩阵；未来未知类型明确拒绝 |
| AIN-02 准入矩阵 | §3 全部 G 与 §4 每行×输入组；叠加等待+压缩、启动+停止、重连+旧结果、配置+消息；后端能力差异 |
| AIN-03 回执 | pending 不冒充 success；重复同内容只执行一次、冲突拒绝；throw、未回执、超时、断线、旧代次、迟到结果、容量满 |
| AIN-04 Codex | 独立 / 自动压缩、缺 turn/completed、原生 idle / 历史修复、steer / followUp、启动屏障、连续多条、启动失败、撤回与关闭竞态；终端 / 桌面共用实现 |
| AIN-05 Pi / Claude / DSH | Pi 压缩互斥和投递失败；Claude 主回合 / 独立压缩 / 同批提交与停止；DSH Web 原生 queue 失败、ACP 不支持路径；附件不丢失 |
| AIN-06 双端 outbox | unconfirmed 不自动重发、精确落地仍消除；队列 accepted / rejected / cancelled / delivered；断线与切换隔离；无永久发送中 |
| AIN-07 专用服务 | 读取范围 / 工具 / 差异 / 传输的成功、失败、取消、目标失效及结果私有；Agent busy 不误拦 |

Host / 协议 / adapter 全量测试、类型检查及变更文件 lint 必须运行。两端 L1–L4、C01–C18、V05/V10/V12/V16–V18 专项和 A1–A4 按 UI 回归方案执行；共享池和构建租约遵循 AGENTS.md。须保留同设备同配置基线，不能将协议夹具当真实 TUI / UI 验收。

新增专项 R24：各 Agent 在 idle、运行、审批等待、压缩、停止、恢复 / 断线时提交文本+附件、followUp / steer、Slash、回答、撤回；逐项观察受理、成功、明确失败和未确认；双端无重复、无永久转圈，失败输入可找回。测试若无法取得兼容设备 / 原生后端，明确记录缺口。

### 实施顺序与验收登记

1. 本文与 ADR-0051 / 回归映射先落盘，再改业务实现。
2. 完成协议输入分类 / 回执生命周期，补齐后端准入和队列的成功、失败与核对路径。
3. 接入双端未确认和恢复语义，补自动与设备用例。
4. 保存证据到 `.artifacts/ui-regression/`，逐项记录已实施 / 测试通过 / 未跑 / 阻塞，不以本 ADR accepted 代表交付完成。

实施中（2026-11-01）：协议输入拥有者与状态准入、Host 私有回执去重 / 重放 / 有界未确认、无效输入的关联失败、Codex 压缩与队列 / 停止 / 关闭路径、Pi 投递与压缩互斥、Claude 主回合与压缩提交互斥、DSH 原生失败 / 未确认、双端排队 / 未确认与恢复副本已实现。Codex 的原生用户消息事实优先于丢失的 RPC 回执，不能把实际落地的消息或所属文件捕获标为提交失败。

补充边界（2026-11-01）：断线、Host 接受状态丢失或队列快照缺项本身不能证明未投递；双端 outbox 保持 unconfirmed，直到有精确消息或原生投递证据，明确撤回才删除隐藏恢复副本。Codex 连续 steer 在 turn 启动 / 停止窗口只作用于其所属 turn，不对下一条排队 turn 重复中断。iOS / Android Slash composer 在明确成功前保留原命令与参数，失败或未确认可直接核对 / 重试，不因通道写入成功而清草稿。

代码回归结果（2026-11-01）：Node 全量 1647 通过 / 5 跳过，类型检查和 lint 通过；定向协议 / Host 生命周期 192 通过、Codex 边界 174 通过、Claude 插件 15 通过；iOS Swift 233 通过、构建通过，iOS 状态专项 3 项通过。Android JVM / APK / AndroidTest 构建通过；Android 输入定向 5 项通过，含 A1–A4 下队列 / 未确认状态定向 3 项通过。iOS 全量 64 项为 58 通过 / 6 失败，失败集合与同设备同配置基线 61 项中的 6 项完全相同；Android 全量 143 项为 137 通过 / 6 失败，基线 138 项有 5 项失败，新增的是 `composerHasNoEmptyNoticeSlotAndKeepsCriticalUsageVisibleWithSlashInput` 截图捕获超时，单独复跑通过，原始失败仍保留。手动核心 C01–C18 尚未完成；Android 无真实隔离 Agent Host，真实 Pi / Codex / Claude / DSH 后端状态矩阵 R24 未执行。详见 `.artifacts/ui-regression/20261101-agent-input-lifecycle/summary.md`；未通过全部门禁前不记为所有状态的完整交付。

上次诊断的 4 项测试仅证明旧行为。本轮证据目录为 `.artifacts/ui-regression/20261101-agent-input-lifecycle/`；代码级与设备门禁持续登记，完整通过结果、失败集合与真实后端缺口以该目录最终 summary 为准。未完成完整门禁前不记为全状态交付。

## Consequences

每一种输入都有责任边界与可观察终点。压缩等活动不再是发送状态机之外的孤立显示，原生不支持或结果未知也不会被无限等待掩盖。代价是需要统一去重和回执预算、适配器调度互斥、可恢复的投递结果以及跨状态回归；未来状态或输入类型必须同步扩展矩阵和测试。
