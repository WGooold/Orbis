# ADR-0067：Host 与 App 的逐字段传输规则

日期：2026-11-06（Asia/Taipei）

Status: proposed

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0037](0037-session-sync-transaction-contract.md)、[ADR-0045](0045-tool-summaries-and-on-demand-content.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0052](0052-turn-file-changes-and-on-demand-diff.md)、[ADR-0060](0060-mobile-relay-history-performance.md)、[ADR-0061](0061-codex-selection-and-native-settings-reconciliation.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0065](0065-native-quic-relay-transport.md)。

## 1. 规则适用与字段判定

1. 本 ADR 规定 Host→App 的业务 JSON、领域 `value`、文件二进制及其传输外层，并规定相关 App→Host 请求、回执、配对与握手字段。Pi、Codex、Codex Desktop、DSH、Claude 在 Host 出口使用同一组规则；原生后端的事实采集与执行仍由各适配器拥有。
2. 字段表描述目标行为。改变字段形状、必填性、事务语义或接收端解释时，按 FT-13 启用独立能力；已有协议 18 / 19 的合法收发继续使用其契约。
3. 每个字段同时具有“何时发送”和“怎样装载”两个决定。结构表的默认规则决定整个对象的发送条件；字段规则决定保留、缓存、增量、引用、推导、按需读取或省略。字段保留身份不等于独立广播身份。
4. 引用对象沿字段表继续展开；`[]` 表示数组元素，`{*}` 只表示 schema 明确允许的动态键。联合类型按 `type` / `kind` 区分，枚举值与准确调用值原样保留。
5. 父对象为 Host 内部、兼容事件或按需内容时，子字段继承该发送限制；子字段的身份、版本、完整性、结果和决策约束继续有效。FT-08 只删除菜单说明；审批、问题、权限风险和错误的必要文案按 FT-18 / FT-10 保留。
6. 未采样字段仍按规则表确定行为；样本不足只影响体积和频率结论。`null`、字段缺席、空集合、未知、不可用、部分与完整分别保留各自含义。
7. 认证及后端生产者入口保留其完整输入契约；字段拆分、引用和按需装载作用于 Host→App 的目标投影。Host 内部仍持有完成原生核对和执行所需的事实。

会话目录与历史的具体请求条件、60 秒核对、字节预算及有界缓存预留见 [ADR-0069](0069-session-catalog-and-bounded-history-loading.md)。该 ADR 区分实施前基线与 FT-G11 / FT-G12 分组实施规则；G01–G10 的既有实现记录继续按原证据解释。

字段名与嵌套结构以[协议入口](../../packages/protocol/src/index.ts)、[领域模型](../../packages/protocol/src/agent-state.ts)、[Host 领域](../../packages/protocol/src/host-model-domains.ts)、[工具](../../packages/protocol/src/tool-activity.ts)、[通知](../../packages/protocol/src/notifications.ts)、[文件变更](../../packages/protocol/src/turn-file-changes.ts)为准；新增字段按 FT-19 同步登记。

## 2. 字段规则

### FT-01：身份、作用域与关联

- Host、设备、Agent 类型、Session、Runtime、消息、条目、工具、请求、操作、文件和读取身份保持准确且有界，禁止截短或按展示名称猜测目标。
- 缓存键包含事实所属 Host、Agent / Session / Runtime、来源代次和表示版本；同一目录确实相同时才共享其内容。工作目录相同本身不足以证明 MCP、技能、权限或模型选项相同。
- 新表示可以把重复身份提升到包级作用域或注册为引用；跨包引用必须能解析并核对代次。缺引用时补读，不能回退为同名对象。
- 请求、响应和终态沿用原关联身份；重复请求核对原结果。传输重试、重新选路和恢复读取不创建第二次业务副作用。

### FT-02：目录、静态元数据与选项缓存

- 名称、命令词表、模型和权限选项、工作区、后端版本等按内容版本缓存；首次需要、缓存缺失、明确失效或真实内容变化时发送。
- 包级发送目录版本和必要作用域；已应用同版本时只返回未变化确认。核对时间、读请求、状态心跳、历史增长不单独推进目录版本。
- 小清单允许一次发送；达到 FT-05 字节预算后分页。选项值、稳定身份和必要显示名称完整保留，禁止靠截断目录使调用目标消失。
- 默认值、选项集合和当前选择分别核对；更换模型只使实际依赖它的思考档位选项失效。

### FT-03：当前状态按内容变化发布

- 执行阶段、可用性、当前模型、权限、连接等只向需要它的订阅者发布内容变化；首次建立或丢失基线时发送对应快照。
- 相同版本不携带重复 `value`。核对时间或计数器刷新不触发无关领域发布；未知→已确认、离线、权限变化和错误变化属于真实变化。
- 普通可替换状态允许在分配线上版本和 AEAD 序号之前合并；终态、操作结果、审批出现 / 撤销以及原子交接按 FT-04 / FT-10 / FT-18 保留。
- 运行时长可由已确认开始时间在 App 内推进；Host 确认的最终耗时与终态及时发送。

### FT-04：有基准的增量与事务

- 文本、集合和任务按稳定 ID 发布新增、替换和显式删除；增量携带来源代次、基准版本和提交版本。接收方只从实际已应用基准提交，缺口按对应作用域恢复。
- 流式文本携带块身份、基准内容版本及有效范围；新增后缀、改写、结束和取消各自明确。相同前缀不随每次输出重发，内容改写不伪装为追加。
- immutable 历史节点按内容身份发送一次；修订或来源更换按既有规则重建。live→历史、用户消息身份对应、head / display / 工具引用和执行事实在同一逻辑提交点交接。
- 合并只能发生在形成依赖之前；已经发布的 `baseSeq` 链不能丢中间帧后继续发送原增量。改发覆盖状态时建立合法恢复基线。
- 集合部分页缺席不表示删除。删除按 ID、有效完整快照或已确认的窗口淘汰表达。

### FT-05：按范围读取与分页

- 历史、历史树、会话目录、工具库存、文件列表和诊断按当前页面 / 用户请求读取。游标绑定作用域、固定快照和内容版本，失效返回关联错误并重开读取。
- 新表示普通页默认目标 32 KiB JSON 明文、单页上限 64 KiB；已有类别更小的约束优先，例如 diff 正文 48 KiB、工具 / changes 的预留及完整页限制。兼容分支使用已发布预算。
- 页同时受字节和条数限制；单条过大改发完整身份、必要摘要与 FT-06 引用。不能把半条结构冒充完整条目，也不能静默跳过条目。
- 保留游标、范围、边界、覆盖、总数可信度、截断和下一页标记；稳定排序与当前选择沿用准确身份。历史窗口外父节点仍可引用，窗口起点不伪装成根。

### FT-06：正文与详情按需装载

- 工具参数 / 输出 / 结果、原生条目详情、完整 diff、文件内容、长诊断和长权限详情仅在对应视图需要或明确请求时读取。聊天当前可见正文属于必要展示内容，由聊天订阅取得。
- 详情引用绑定来源、内容版本、读取身份和有效范围；接收方保留取消、到期、缺口、截断、原始字节数和不可恢复状态。
- 切页或关闭查看器时撤销该读取兴趣并取消未发出的无用工作。已确认副作用和终态继续进入其原账本。
- 原始结构可在明确详情读取中作为有界 JSON / 文本内容返回；跨网络的描述符使用登记字段，避免把任意原生对象直接装进共享状态。

### FT-07：单份内容与版本化引用

- 同一作用域、内容身份和版本的正文、目录、工具摘要、附件描述符和工作区元数据只装载一份；其他出现位置携带可解析引用。
- 聊天采用 Host 解释好的显示语义；canonical 图保留身份、父子关系、必要原生类型和显示 / 正文引用，`entries` 与 `display` 共享正文。原生条目完整数据走 FT-06。
- 相同 `displayId/entryId/messageId`、包级 Agent 身份等在新表示中可复用同一值，省略规则和重建规则由协商表示明确声明；不能因字符串碰巧相同合并不同实体。
- live 与落盘消息通过明确映射交接；引用不能改变乐观消息对应、折叠、阅读锚点、压缩窗口、错误状态或复制文本。
- `model`、provider 绑定、默认 provider 和实际请求路由有不同语义时保留各自事实，只共享相同的元数据内容。

### FT-08：菜单只传准确目标、名称与必要输入

- 命令、技能、MCP 的 `description`、菜单选项的 `description`、参数 `hint` 以及同义说明全部省略；完整工具 schema、技能路径、执行映射和说明保存在 Host。
- 保留精确命令名或等价稳定目标引用、必要分类、输入类型和必填性。选项保留准确 `value` 与识别目标所需名称；名称等于值时由新表示明确复用。
- `argumentKind/argumentRequired` 与 `argument.kind/required` 只保留一份；重复 `hint` 删除。`optionCount` 仅作为分页清单的可信计数；重复嵌入的大选项表改为版本化引用。
- 历史树、fork / resume 的动态清单从命令词表分离，打开选择器时按 FT-05 读取。新增历史节点只更新树版本 / 当前位置，不更新稳定命令目录。
- 调用由 App 提交精确目标、目录版本、选中值或输入和操作身份；Host 在原作用域核验目标、当前选项及执行准入，再交后端执行。失效返回关联错误并更新目录，名称相近的目标不能替代执行。
- MCP 目标区分服务器与工具，技能目标由 Host 绑定具体技能来源。文本 / JSON 输入及错误仍在 Host 校验；App 保留必要输入入口。

### FT-09：确定性派生字段

- 只省略能由同一已确认事实、同一表示版本和明确算法重建的值；未知输入保持未知。计数不由不完整清单的长度冒充。
- `percent` 在已确认与后端相同的 token / window 语义下由 App 按既定精度计算；来源百分比具有独立含义时保留该来源值及其更新。不能混用累计 token 与当前上下文 token。
- 当前时长由开始时间派生，最终 `durationMs` 保留 Host 事实；路径名、显示名、role、父子关系和完整性不能靠猜测重建。
- 目录总数、分页总数、覆盖边界与诊断缺口是独立事实，保留其确认状态。

### FT-10：操作、回执、结果与错误

- `accepted/pending`、后端成功、失败、取消、不可取消、已投递、身份冲突和未确认分别表达；只有匹配原操作的业务确认才能记成功。
- 结果定向发送相关设备，并由有界账本支持重连核对。即时结果与状态账本共享结果内容；只有接收端已能按同一契约完成关联时才移除重复表示。
- 一次性结果、取消结果和错误不能按“只留最新状态”覆盖。超时先核对原操作，禁止以重复执行代替结果恢复。
- 保留必要错误码、操作 / 请求关联、短原因和重试条件；长输出、堆栈与任意结果对象通过详情引用读取。
- 新会话 / Runtime 身份、历史位置与编辑原文属于完成原操作所需结果。身份及时回传，原文随结果取得、复用同版本正文或由该操作自动补取；接收方核对来源后回填，不能因结果详情化丢失切换目标或改用旧原文。

### FT-11：Host 私有与原生输入

- 私钥、PSK、会话密钥、原生凭据、执行映射、技能文件路径、原始配置、内部生产者消息和完整原生日志保存在其拥有者。
- 原生工具事件的 `arguments/partialResult/result` 仅进入 Host 工具生产者；手机共享状态使用摘要与详情引用。显式工具详情可按 FT-06 返回其授权内容。
- `session.tools.produced`、`notification.source`、`tool.activity` 在 Host 消费并归入对应权威；它们的生产者正文不作为第二份 App 事件广播。
- 开放原生 `data` 的未登记键留在 Host；必需的聊天正文、图结构或新业务字段先登记投影与规则，再经对应契约发布。记录动态键不是默认透传授权。

### FT-12：版本、质量、覆盖与新鲜度

- `modelEpoch`、来源 epoch / revision、`baseSeq/seq`、checkpoint、`projectionVersion`、complete / partial / unknown、availability、missing、truncated 和显式删除按其原语义保留。
- App 的已应用版本由本地事务提交推进，收到、解码、展示预告和 socket 写完不推进它；ACK 在实际应用或拒绝之后按原同步身份发回。
- 缺席、`null`、空清单、未读取、不支持和读取失败分别处理；只有有效完整清单支持按缺席删除，投影完整与原生库存完整分别表达。
- `checkedAt` 等新鲜度随有效应答携带，单独刷新不推高内容版本或广播整域。源重建、离线及核对失败明确撤回确定性并保留可用的旧显示。

### FT-13：按设备能力保持兼容

- 协议 18 为持续互通基线，已发布 19 按 ADR-0064 保留；路由版本、业务格式、内容表示和功能能力分别管理。
- 可选菜单说明可在现有合法格式中省略。移除必填字段、把正文换引用、选项改分页、集合改增量或改变 ACK / 事务均由真实能力启用，旧 strict schema 使用原格式。
- 每台设备在同一事实下只采用一个业务权威。已确认消费领域模型 / 聊天事务的设备关闭对应旧事件；旧端需要的菜单、正文与事件由兼容投影继续提供。
- 模型读取只核对所需事实，更新已提交模型；不连带重发整份菜单、交互、队列和 metadata。原生事实恢复可以发生，外发仍经过内容变化与订阅规则。
- 未知业务操作返回关联错误；版本 / 能力协商与重连均不重复执行业务操作。

### FT-14：认证、加密、路由与传输字段

- 配对、握手、公钥、nonce、MAC、认证身份、Envelope 版本、路由头、channel、序号及片段信息按既有格式完整验证；原认证 credential 只用于其认证通道，禁止进入共享业务投影和日志。
- 消息与信封身份、业务来源版本、通知代次各自保留，禁止互相替代。AEAD nonce 和密钥维持原派生及唯一性。
- Relay 搬运合法完整密文及已协商的片段，不解析或改写业务字段；扩展通道、压缩或二进制表示只有在实际能力协商后启用。
- 压缩如启用，在加密前执行并绑定表示版本，限制压缩前后大小和资源；文件等已压缩内容按实际收益处理。字段精简不得借压缩省略语义。

### FT-15：诊断、计量与频率

- 全字段统计记录 backend / 消息 / 领域 / 字段路径、出现次数、非空次数、均值、P95、最大值、总字节、相同内容重复量和发送原因；首次基线、变化、主动范围读取、恢复分别统计。
- 字节采用 UTF-8 序列化大小；父字段含子字段的大小与不重叠的自身开销分别记录，不能重复相加。JSON 明文、加密外层、二进制、分片与实际网络字节分开核算。
- 消息总量计数保持轻量；逐字段计量按有界样本执行，避免每次 token 更新都重序列化全部状态。正文和凭据不写入计量结果，重复判断使用有界摘要。
- 诊断、全设备统计、路由明细和内部计数只在对应视图订阅或读取；计量自身不能触发所有会话的 `records` 和首页连带更新。

### FT-16：订阅、取消、优先级与背压

- 首页只订阅轻量身份、执行与待处理交互，以及必要 Host 状态；聊天增加当前会话显示、投递、模型和上下文；菜单、选项、历史树、工具、diff、文件和管理领域按对应视图需要取得。
- 多视图共享按身份 / 版本索引的缓存，按兴趣合并订阅；页面释放其兴趣，后台保留仍需的交互、通知、运行摘要和操作结果。
- 高优先级消息只装必要控制和结果；大目录、历史、详情、文件使用对应受控通道及分页。沿用已协商的 ctl / msg / history / catchup / bulk，支持分段续传并保持公平调度。
- 控制元数据目标不超过 4 KiB；必要审批 / 问题正文超出时完整关联装载并计量，保证用户取得全部决策信息后再响应。
- 预算同时限制帧、在途字节和队列；可替换状态在业务版本和加密序号分配之前合并。已封帧数据按既有重试与路径失败语义处理，禁止任意丢弃。
- 超时记录请求、会话、领域、排队 / 发送 / 接收 / 应用阶段；过期视图请求终止自身等待，不能将已撤销请求的迟到失败写入新请求。

### FT-17：文件身份、范围与持久确认

- 文件名称、大小、类型、内容版本、sha256、transfer / upload ID、偏移、长度和已持久接收位置按实际用途保留。以确认落盘的范围续传，以接收方校验确认完成。
- 同一内容描述符按 FT-07 复用；共享列表不携带文件正文。上传完成所需的准确 Host 路径保留为附件提交目标；普通附件优先按 artifact ID 读取，原生路径按明确操作需要返回。
- 二进制块按已授权范围发送，重复块按原偏移核对；结束、失败、取消和校验结果及时关联。进度是 FT-03 合并状态，不代替持久确认和流控。
- 二进制头的 magic、版本、kind、长度、保留位、编码、offset 和实际 payload 长度保持完整校验；兼容转换保持真实文件字节。

### FT-18：交互决策与敏感输入

- 审批、选题、问卷和输入保留请求身份、问题 / 标题、必要描述、准确选项值、名称、参数摘要、风险 / 禁用原因、约束、过期、取消、提交状态和响应身份。
- 这些说明属于用户决策内容；菜单 FT-08 的删除规则不扩展到审批、权限风险和错误。相同选项模板可缓存，当前请求依赖与有效值仍须核对。
- 密码等 secret 输入只在认证加密业务请求中提交原目标，使用临时内存，不进入共享领域、持久缓存或日志。响应结果继续按 FT-10 对账。
- 待处理请求的出现、撤回和有效性及时发布；部分库存或来源未知不能默认为已取消。对已失效请求提交返回关联结果。

### FT-19：字段登记与完整覆盖

- 每个新增或改义字段同时登记：精确路径 / 可展开类型、拥有者、发送触发、装载规则、版本作用域、大小预算、接收用途和兼容方式；未登记字段不能进入新表示默认出口。
- 对象与数组继续展开至标量、准确引用、固定枚举或明确规定的开放负载；`value/data/result/options` 等开放容器执行第 4 节的逐分支规则。
- 静态核对遍历全部消息分支、32 个领域及共享结构；每个 schema 属性必须能解析到有效规则。字段增加、引用断裂、规则缺失或分类冲突均作为覆盖失败。
- Host 直接序列化、手写解析或在共享 union 外处理的消息同样登记到字段表；出口新增消息不能仅因参数为 `object` 而绕过覆盖。供应商、LAN、Git 和命令结果的本机扩展字段按本节同等核对。
- 行为验证覆盖精确目标、同名目标、过期选项、来源换代、增量缺口、重复请求、应用后 ACK、分页、取消、文件续传和真实旧格式。实现、部署、自动验证与用户验收分别记录。

## 3. 领域与开放负载规则

字段表中的 `AgentStateDomainSnapshot.value` 按 scope / domain 选择本表；每个领域继续引用第 5 节的结构字段。领域 envelope 全部执行 FT-01 / FT-12，不因内容尚未测量而省略。

| scope / domain | value 结构及明确行为 |
| --- | --- |
| agent / identity | `RuntimeMetadata` 加 `hostId/agentKind/sessionId`；稳定身份 FT-01/FT-02，动态状态、模型、上下文、权限分别引用对应领域 FT-07；工作区走 workspaceRef。 |
| agent / availability | `connected/runtimeId/reason`；连接变化 FT-03，身份 FT-01，必要原因 FT-10。 |
| agent / history | `source/head/headCompleteness/displayVersion`；来源 / head / 显示版本 FT-12，正文与图页 FT-05/FT-07。 |
| agent / live | `SessionLiveState`；FT-04，恢复基线 FT-12，正文与工具引用 FT-07。 |
| agent / tools | `ToolInventoryReference`；版本和读取入口 FT-07/FT-12，库存页 FT-05，详情 FT-06。 |
| agent / changes | `latestChangeSetId/reviewTurnId/manifestVersion/state`；身份与版本 FT-01/FT-12，变化 FT-03，summary / files / diff 分别 FT-03/FT-05/FT-06。 |
| agent / execution | `AgentExecutionState`；及时状态 FT-03，任务集合 FT-04，回合身份与终态 FT-01/FT-10/FT-12。 |
| agent / delivery | `{queueId: AgentDeliveryItem}`；动态键 FT-01，条目 FT-04，正文首次 / 编辑 FT-07，状态与结果 FT-10。 |
| agent / interactions | `{requestId: AgentInteractionItem}`；动态键 FT-01，库存增删 FT-04，全部决策字段 FT-18。 |
| agent / permissions | `AgentPermissionsState`；当前值 FT-03，选项 FT-02/FT-08，必要风险 FT-18，长详情 FT-06。 |
| agent / model | `AgentModelState`；当前值 FT-03，名称引用 FT-02/FT-07，原生确认沿用 ADR-0061。 |
| agent / context | `AgentContextState`；FT-03，确定性百分比 FT-09，未知 FT-12。 |
| agent / capabilities | `{commandName: AgentCapabilityItem}`；键 / 目标准确 FT-01，目录 FT-02，说明删除 FT-08，动态选项 FT-05。 |
| agent / resources | `{commandName: RuntimeSlashCommand}`（compact-v1 为 `AgentCapabilityReference`）；与 capabilities 同一目录 FT-07，独立资源以稳定 ID / 版本读取 FT-05/FT-06，菜单字段 FT-08。 |
| agent / notifications | `AgentNotificationsState`；引用与计数 FT-07/FT-12，相关条件 FT-03，正文仅 NotificationSnapshot 一份。 |
| agent / artifacts | `{artifactId: RemoteArtifact + messageId}`；键和消息身份 FT-01，描述符 FT-07/FT-17，内容 FT-06，窗口删除 FT-04/FT-12。 |
| agent / records | `scope/domain/agentKind/sessionId/modelEpoch/revision`；查询作用域 FT-01，诊断入口 FT-07/FT-15，按诊断兴趣核对，日志追加不向每个会话扩散广播。 |
| agent / providerBinding | `provider/modelId`；准确绑定 FT-01/FT-03，重复模型元数据 FT-07，默认配置与当前绑定分别保留。 |
| agent / workspaceRef | `workspaceId/cwd`；workspaceId FT-01/FT-07，cwd 引用 Host workspace FT-02/FT-07，首次缺引用时补读。 |
| host / identity | `HostIdentityState`；FT-01/FT-02。 |
| host / backends | `HostBackendsState`；可用状态 FT-03，静态能力 FT-02，接入原因 FT-10。 |
| host / catalog | `HostCatalogState`；数量 / 覆盖 / 快照 FT-12，目录条目 FT-05，当前 provider 引用 FT-07。 |
| host / providers | `HostProvidersState`；当前选择 FT-03，profiles FT-02/FT-05，用量 / 健康 / 路由在对应视图 FT-15/FT-16。 |
| host / workspaces | `HostWorkspacesState`；工作区目录 FT-02/FT-05，Git 变化 FT-03，跨会话引用 FT-07。 |
| host / files | `HostFilesState`；文件页 FT-05，描述符 FT-07/FT-17，内容 FT-06。 |
| host / operations | `HostOperationsState`；相关操作结果 FT-10，集合 FT-04，全局统计 FT-15/FT-16。 |
| host / diagnostics | `HostDiagnosticsState`；摘要 FT-15，记录 FT-05，缺口 FT-12。 |
| host / connections | `HostConnectionsState`；相关路径变化 FT-03，全设备统计 FT-15/FT-16。 |
| host / management | `HostManagementState`；版本 FT-02，生命周期 FT-03，管理页兴趣 FT-16。 |
| device / notifications | 设备私有通知视图 / `NotificationSnapshot`；FT-01/FT-04/FT-10/FT-18，完整性与删除 FT-12，仅发本设备。 |
| device / operations | `{operationId: AgentOperationItem}`；FT-01/FT-04/FT-10，重连核对原结果，显式淘汰 FT-12。 |
| device / transfers | `DeviceTransfersState`；描述符 FT-07/FT-17，进度 FT-03，未完成库存 FT-04/FT-12，仅发本设备。 |

## 4. 开放容器、二进制与认证字段的展开规则

| 路径 | 规则 | 明确行为 |
| --- | --- | --- |
| `AgentStateDomainSnapshot.value` | FT-07/FT-12/FT-19 | 逐项执行第 3 节全部 32 个 scope/domain 分支。 |
| `AgentCapabilityItem.argument` | FT-02/FT-05/FT-08 | 展开 `RuntimeSlashCommandArgument`；与顶层 argumentKind / argumentRequired 复用一份。 |
| `AgentInteractionItem.options[]` | FT-18 | 按 InteractionRequest 的 select / multi-select 选项展开 value / label / description。 |
| `AgentInteractionItem.questions[]` | FT-18 | 展开 `QuestionnaireQuestion`。 |
| `RemoteSessionEntry.data.message` | FT-04/FT-07 | 必要正文展开 `ChatMessage` / `RemoteContent`；原生 role 与 thinking 字段由 Host 投影，线上共享单份正文。 |
| `RemoteSessionEntry.data.summary` | FT-05/FT-07 | 压缩 / 分支摘要作为单份显示正文；沿用窗口、锚点与原生来源身份。 |
| `RemoteSessionEntry.data.{*}` 其余原生键 | FT-06/FT-11 | 完整原生数据留在 Host，显式条目详情可按版本读取；默认历史 / live 不透传任意键。 |
| `DiagnosticRecord.detail.{*}` | FT-05/FT-15 | 在诊断页返回 schema 限定的短标量键值；不含正文、凭据或脚本。 |
| `command.result.result` | FT-06/FT-07/FT-10 | 已登记字段展开 KnownCommandResult，必要身份与编辑原文按原操作取得；其余对象登记为有界详情，原格式消费者按 FT-13 适配。 |
| `command.result.result.sessionId/runtimeId/leafId` | FT-01/FT-10 | 切换会话、Runtime 与历史位置的准确结果，及时关联原操作。 |
| `command.result.result.editorText` | FT-01/FT-07/FT-10 | 完整编辑原文，复用或自动补读同版本内容，确认后回填输入框。 |
| `command.result.result.provider/modelId/level/sessionName/cwd/isIdle` | FT-03/FT-07/FT-10 | 原操作确认的小结果；与对应领域共享事实，不能用旧缓存替代确认。 |
| `command.result.result.copied/compacted/reloaded/shutdown/command/accepted` | FT-01/FT-10 | 动作结果与目标关联；accepted 只表示受理，不当作执行成功。 |
| `command.result.result.{*}` 其他返回键 | FT-06/FT-11/FT-19 | 留在原操作的 Host 结果中，显式详情读取；新的即时业务字段先登记。 |
| `tool_call.arguments`、`tool.started.arguments`、`tool.updated.partialResult`、`tool.finished.result`、`SessionLiveTool.detail` | FT-06/FT-11 | Host 工具生产者消费；共享事件不透传原始工具体，显式详情读取受原作用域约束。 |
| `InteractionResponse` 中 value / values / answers / other / notes | FT-01/FT-10/FT-18 | 原样提交对应请求，保留值类型、选项身份、约束与敏感输入语义。 |
| `slash.execute.args`、`user_message.text`、`user_message.attachments[]` | FT-01/FT-10 | 文本 / JSON / 附件目标完整提交到 Host 校验；附件路径沿用上传完成的准确目标。 |
| ArtifactChunkFrame `runtimeId/transferId/offset/data` | FT-01/FT-17 | 上传 / 下载共用范围身份；data 为请求范围原字节。 |
| Artifact 二进制头 `magic/protocolVersion/kind/runtimeIdLength/transferIdLength/reserved/offset/payloadLength` | FT-14/FT-17 | 字节顺序、长度和边界按既有 24 字节头校验，保留位按原布局处理。 |
| `HandshakeHello.type/ePubD` | FT-14 | HS1 临时公钥按原认证格式发送。 |
| `HandshakeAcceptBody.type/ePubH/macH/historyStreams/historyMac` | FT-14 | HS2 公钥、MAC 与扩展能力认证保持绑定。 |
| `HandshakeConfirmBody.type/macD/historyStreams` | FT-14 | HS3 确认和能力选择保持原握手代次。 |
| `PairRequestBody.type/devicePub/deviceId/nonceD/macD` | FT-14 | 配对公开字段按原认证格式验证。 |
| `PairAcceptBody.type/hostId/nonceH/macH` | FT-14 | 配对回执保留身份与 MAC。 |
| `SessionKeys.kHostToDevice/kDeviceToHost`、`pskRoot`、私钥 | FT-11 | 本机持有，不作为网络负载发送。 |
| `SessionKeys.historyStreams` | FT-14 | 本机保存认证协商结果，线上仅使用既定握手声明。 |
| `LoopbackDescriptor.version/url/token/hostId/pid` | FT-11 | 本机发现与准入数据，不进入 Host→App 字段。 |
| ping 的随机字节载荷 | FT-14/FT-15 | 只用于原路径的探针关联和 RTT，回声保持原载荷；本地 sentAt / pending 表不广播。 |

供应商、LAN 与 Git 的手写业务入口同时适用逐字段表；其结构来自 [provider-messages](../../packages/host/src/provider-messages.ts)、[Host 出口](../../packages/host/src/host-service.ts)、[LAN 发现](../../packages/host/src/lan-server.ts)、[Git 查询](../../packages/host/src/git-branch.ts)。命令结果的登记字段同时核对 [Pi 命令](../../packages/pi-extension/src/slash-commands.ts)及各 Host 后端的返回。

## 5. 消息与共享结构的逐字段归类

<!-- field-rules:start -->

字段路径以结构名为前缀；结构的默认规则确定发送触发，字段规则确定装载。相同结构在不同消息中复用时同时继承父消息限制。`H` 为下行消息，`E` 为 runtime 事件，`U` 为上行请求，`C` 为 runtime 命令，`A` 为认证 / 生产者入口，`S` 为共用结构。

### 5.1 消息分支索引

| 协议入口 | 消息分支 | 字段结构 |
| --- | --- | --- |
| `RuntimeWireEventSchema` | `session.changes.summaries` | `E:session.changes.summaries` |
| `RuntimeWireEventSchema` | `session.changes.updated` | `E:session.changes.updated` |
| `RuntimeWireEventSchema` | `session.changes.page` | `E:session.changes.page` |
| `RuntimeWireEventSchema` | `session.change.detail.page` | `E:session.change.detail.page` |
| `RuntimeWireEventSchema` | `session.changes.failed` | `E:session.changes.failed` |
| `RuntimeWireEventSchema` | `tool.activity` | `E:tool.activity` |
| `RuntimeWireEventSchema` | `session.tool.content.page` | `E:session.tool.content.page` |
| `RuntimeWireEventSchema` | `session.tool.read.failed` | `E:session.tool.read.failed` |
| `RuntimeWireEventSchema` | `session.tools.page` | `E:session.tools.page` |
| `RuntimeWireEventSchema` | `session.tools.patch` | `E:session.tools.patch` |
| `RuntimeWireEventSchema` | `session.tools.changed` | `E:session.tools.changed` |
| `RuntimeWireEventSchema` | `session.tools.produced` | `E:session.tools.produced` |
| `RuntimeWireEventSchema` | `session.tools.opened` | `E:session.tools.opened` |
| `RuntimeWireEventSchema` | `delivery.snapshot` | `E:delivery.snapshot` |
| `RuntimeWireEventSchema` | `execution.tasks` | `E:execution.tasks` |
| `RuntimeWireEventSchema` | `execution.activity` | `E:execution.activity` |
| `RuntimeWireEventSchema` | `notification.source` | `E:notification.source` |
| `RuntimeWireEventSchema` | `runtime.status` | `E:runtime.status` |
| `RuntimeWireEventSchema` | `runtime.metadata` | `E:runtime.metadata` |
| `RuntimeWireEventSchema` | `runtime.capabilities` | `E:runtime.capabilities` |
| `RuntimeWireEventSchema` | `session.catalog` | `E:session.catalog` |
| `RuntimeWireEventSchema` | `message.queued` | `E:message.queued` |
| `RuntimeWireEventSchema` | `session.sync.pending` | `E:session.sync.pending` |
| `RuntimeWireEventSchema` | `session.entry.result` | `E:session.entry.result` |
| `RuntimeWireEventSchema` | `session.snapshot` | `E:session.snapshot` |
| `RuntimeWireEventSchema` | `session.patch` | `E:session.patch` |
| `RuntimeWireEventSchema` | `message.started` | `E:message.started` |
| `RuntimeWireEventSchema` | `message.delta` | `E:message.delta` |
| `RuntimeWireEventSchema` | `message.finished` | `E:message.finished` |
| `RuntimeWireEventSchema` | `turn.started` | `E:turn.started` |
| `RuntimeWireEventSchema` | `turn.finished` | `E:turn.finished` |
| `RuntimeWireEventSchema` | `tool.started` | `E:tool.started` |
| `RuntimeWireEventSchema` | `tool.updated` | `E:tool.updated` |
| `RuntimeWireEventSchema` | `tool.finished` | `E:tool.finished` |
| `RuntimeWireEventSchema` | `interaction.requested` | `E:interaction.requested` |
| `RuntimeWireEventSchema` | `interaction.snapshot` | `E:interaction.snapshot` |
| `RuntimeWireEventSchema` | `interaction.resolved` | `E:interaction.resolved` |
| `RuntimeWireEventSchema` | `interaction.cancelled` | `E:interaction.cancelled` |
| `RuntimeWireEventSchema` | `local_interaction.required` | `E:local_interaction.required` |
| `RuntimeWireEventSchema` | `command.result` | `E:command.result` |
| `RuntimeWireEventSchema` | `artifact.started` | `E:artifact.started` |
| `RuntimeWireEventSchema` | `artifact.failed` | `E:artifact.failed` |
| `RuntimeWireEventSchema` | `runtime.error` | `E:runtime.error` |
| `RuntimeCommandSchema` | `session.changes.list` | `C:session.changes.list` |
| `RuntimeCommandSchema` | `session.changes.read` | `C:session.changes.read` |
| `RuntimeCommandSchema` | `session.change.detail.read` | `C:session.change.detail.read` |
| `RuntimeCommandSchema` | `session.change.detail.cancel` | `C:session.change.detail.cancel` |
| `RuntimeCommandSchema` | `session.tool.content.read` | `C:session.tool.content.read` |
| `RuntimeCommandSchema` | `session.tool.content.cancel` | `C:session.tool.content.cancel` |
| `RuntimeCommandSchema` | `session.tools.read` | `C:session.tools.read` |
| `RuntimeCommandSchema` | `session.tools.open` | `C:session.tools.open` |
| `RuntimeCommandSchema` | `file.download` | `C:file.download` |
| `RuntimeCommandSchema` | `artifact.download` | `C:artifact.download` |
| `RuntimeCommandSchema` | `artifact.cancel` | `C:artifact.cancel` |
| `RuntimeCommandSchema` | `session.sync` | `C:session.sync` |
| `RuntimeCommandSchema` | `session.snapshot.ack` | `C:session.snapshot.ack` |
| `RuntimeCommandSchema` | `session.entry.request` | `C:session.entry.request` |
| `RuntimeCommandSchema` | `user_message` | `C:user_message` |
| `RuntimeCommandSchema` | `user_message.cancel` | `C:user_message.cancel` |
| `RuntimeCommandSchema` | `slash.execute` | `C:slash.execute` |
| `RuntimeCommandSchema` | `permissions.update` | `C:permissions.update` |
| `RuntimeCommandSchema` | `stop` | `C:stop` |
| `RuntimeCommandSchema` | `interaction.respond` | `C:interaction.respond` |
| `RelayToDeviceMessageSchema` | `transport.fields.page` | `H:transport.fields.page` |
| `RelayToDeviceMessageSchema` | `agent.menu.options.page` | `H:agent.menu.options.page` |
| `RelayToDeviceMessageSchema` | `notification.snapshot` | `H:notification.snapshot` |
| `RelayToDeviceMessageSchema` | `device.ready` | `H:device.ready` |
| `RelayToDeviceMessageSchema` | `device.path` | `H:device.path` |
| `RelayToDeviceMessageSchema` | `runtime.online` | `H:runtime.online` |
| `RelayToDeviceMessageSchema` | `runtime.offline` | `H:runtime.offline` |
| `RelayToDeviceMessageSchema` | `artifact.read.failed` | `H:artifact.read.failed` |
| `RelayToDeviceMessageSchema` | `file.upload.ready` | `H:file.upload.ready` |
| `RelayToDeviceMessageSchema` | `file.upload.read` | `H:file.upload.read` |
| `RelayToDeviceMessageSchema` | `file.upload.progress` | `H:file.upload.progress` |
| `RelayToDeviceMessageSchema` | `file.upload.finished` | `H:file.upload.finished` |
| `RelayToDeviceMessageSchema` | `file.upload.failed` | `H:file.upload.failed` |
| `RelayToDeviceMessageSchema` | `host.online` | `H:host.online` |
| `RelayToDeviceMessageSchema` | `host.offline` | `H:host.offline` |
| `RelayToDeviceMessageSchema` | `runtime.event` | `H:runtime.event` |
| `RelayToDeviceMessageSchema` | `agent.state.snapshot` | `H:agent.state.snapshot` |
| `RelayToDeviceMessageSchema` | `agent.state.range.page` | `H:agent.state.range.page` |
| `RelayToDeviceMessageSchema` | `diagnostics.page` | `H:diagnostics.page` |
| `RelayToDeviceMessageSchema` | `session.archive.changed` | `H:session.archive.changed` |
| `RelayToDeviceMessageSchema` | `session.list.result` | `H:session.list.result` |
| `RelayToDeviceMessageSchema` | `session.browse.result` | `H:session.browse.result` |
| `RelayToDeviceMessageSchema` | `session.activated` | `H:session.activated` |
| `RelayToDeviceMessageSchema` | `protocol.error` | `H:protocol.error` |
| `RelayToDeviceMessageSchema` | `v2.frame` | `S:V2Frame` |
| `DeviceE2ePayloadSchema` | `transport.fields.read` | `U:transport.fields.read` |
| `DeviceE2ePayloadSchema` | `agent.menu.options.read` | `U:agent.menu.options.read` |
| `DeviceE2ePayloadSchema` | `notification.sync` | `U:notification.sync` |
| `DeviceE2ePayloadSchema` | `notification.dismiss` | `U:notification.dismiss` |
| `DeviceE2ePayloadSchema` | `device.version.report` | `U:device.version.report` |
| `DeviceE2ePayloadSchema` | `runtime.command` | `U:runtime.command` |
| `DeviceE2ePayloadSchema` | `session.list` | `U:session.list` |
| `DeviceE2ePayloadSchema` | `session.archive` | `U:session.archive` |
| `DeviceE2ePayloadSchema` | `session.browse` | `U:session.browse` |
| `DeviceE2ePayloadSchema` | `session.activate` | `U:session.activate` |
| `DeviceE2ePayloadSchema` | `agent.state.request` | `U:agent.state.request` |
| `DeviceE2ePayloadSchema` | `agent.state.range.request` | `U:agent.state.range.request` |
| `DeviceE2ePayloadSchema` | `diagnostics.request` | `U:diagnostics.request` |
| `DeviceE2ePayloadSchema` | `artifact.read` | `U:artifact.read` |
| `DeviceE2ePayloadSchema` | `artifact.done` | `U:artifact.done` |
| `DeviceE2ePayloadSchema` | `file.upload.init` | `U:file.upload.init` |
| `DeviceE2ePayloadSchema` | `file.upload.cancel` | `U:file.upload.cancel` |
| `RuntimeClientMessageSchema` | `runtime.authenticate` | `A:runtime.authenticate` |
| `RuntimeClientMessageSchema` | `runtime.event` | `A:runtime.event` |
| `RuntimeClientMessageSchema` | `v2.frame` | `S:V2Frame` |
| `DeviceClientMessageSchema` | `device.authenticate` | `A:device.authenticate` |
| `DeviceClientMessageSchema` | `v2.frame` | `S:V2Frame` |
| `Host handwritten egress / request parsers` | `provider.result` | `H:provider.result` |
| `Host handwritten egress / request parsers` | `provider.subscription.result` | `H:provider.subscription.result` |
| `Host handwritten egress / request parsers` | `provider.changed` | `H:provider.changed` |
| `Host handwritten egress / request parsers` | `host.lan` | `H:host.lan` |
| `Host handwritten egress / request parsers` | `runtime.git` | `H:runtime.git` |
| `Host handwritten egress / request parsers` | `provider.list` | `U:provider.list` |
| `Host handwritten egress / request parsers` | `provider.switch` | `U:provider.switch` |
| `Host handwritten egress / request parsers` | `provider.subscription` | `U:provider.subscription` |
| `Host handwritten egress / request parsers` | `host.lan.request` | `U:host.lan.request` |
| `Host handwritten egress / request parsers` | `runtime.git.request` | `U:runtime.git.request` |

### 5.2 字段结构

开放负载的展开由第 3、4 节补足；`unknown` 本身不赋予透传行为。字段名对应当前源码逻辑字段，移除 / 引用 / 推导作用于协商后的目标表示。

每个结构首行给出默认触发与源码类型；其后结构列留空的行沿用该结构。同一行列出的字段逐个执行同一决定。补充列为空时直接执行规则正文；引用结构继续展开。

#### H 类结构

| 结构 | 字段 | 规则 | 补充 / 展开结构 |
| --- | --- | --- | --- |
| `H:transport.fields.page` | 默认 | `FT-01/FT-05/FT-12/FT-15/FT-16` | 显式字段计量分页；固定快照、采样统计口径与发送总数分别返回，不包含内容或凭据。 源码：`TransportFieldsPageSchema`。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`snapshotId` | `FT-01` |  |
| | `offset`、`nextCursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `totalRows`、`startedAt`、`observedAt`、`sampledMessages`、`sampledBytes`、`skippedSamples` | `FT-01/FT-05/FT-12/FT-15/FT-16` |  |
| | `rows` | `FT-01/FT-05/FT-12/FT-15/FT-16` |  展开：`S:TransportFieldRow`。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:agent.menu.options.page` | 默认 | `FT-01/FT-05/FT-08/FT-12/FT-16` | 选择器打开时读取固定目录的有界页；关闭取消本地等待，旧游标与迟到页不能应用。 源码：`MenuOptionsPageSchema`。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `commandName`、`catalogId` | `FT-01/FT-05/FT-08/FT-12/FT-16` |  |
| | `options` | `FT-01/FT-05/FT-08/FT-12/FT-16` |  展开：`S:RuntimeSlashCommandOption`。 |
| | `nextCursor`、`totalCount` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:notification.snapshot` | 默认 | `FT-04/FT-12/FT-18` | 设备私有通知权威，重连核对基线，正文单份。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `hostEpoch`、`revision`、`complete`、`verification`、`removedNotificationIds` | `FT-12` |  |
| | `runtimeId`、`sessionId` | `FT-01` |  |
| | `notifications` | `FT-04/FT-12/FT-18` |  展开：`S:ActiveNotification`。 |
| `H:device.ready` | 默认 | `FT-01/FT-13/FT-14` | 认证后的必要引导，状态正文复用已协商权威。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `modelEpoch`、`notificationEpoch` | `FT-12` |  |
| | `deviceId` | `FT-01` |  |
| | `runtimes` | `FT-01/FT-07/FT-13` | 必要引导种子，避免重复装载完整模型 / 权限 / 菜单。 展开：`S:RuntimeMetadata`。 |
| | `agents`、`launchableAgents` | `FT-01/FT-13/FT-14` |  |
| | `codexDesktop` | `FT-01/FT-13/FT-14` |  展开：`S:CodexDesktopAttach`。 |
| `H:device.path` | 默认 | `FT-03/FT-13` | 生命周期 / 路径变化发布，重复 metadata 复用。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `path` | `FT-03/FT-13` |  |
| | `rttMs` | `FT-12/FT-15` | 随有效核对 / 诊断装载，单独变化不广播整个业务域。 |
| `H:runtime.online` | 默认 | `FT-03/FT-13` | 生命周期 / 路径变化发布，重复 metadata 复用。 |
| | `type` | `FT-01/FT-13` |  |
| | `runtime` | `FT-03/FT-13` |  展开：`S:RuntimeMetadata`。 |
| `H:runtime.offline` | 默认 | `FT-03/FT-13` | 生命周期 / 路径变化发布，重复 metadata 复用。 |
| | `type` | `FT-01/FT-13` |  |
| | `runtimeId` | `FT-01` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:artifact.read.failed` | 默认 | `FT-10` | 向相关请求 / 操作发送关联结果。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `transferId`、`requestId` | `FT-01` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:file.upload.ready` | 默认 | `FT-10/FT-17` | 响应原上传身份 / 范围；完成与失败及时发送。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`uploadId` | `FT-01` |  |
| | `chunkSize`、`receivedBytes` | `FT-01/FT-17` | 文件身份 / 范围 / 校验 / 持久位置，不能用展示进度替代。 |
| `H:file.upload.read` | 默认 | `FT-10/FT-17` | 响应原上传身份 / 范围；完成与失败及时发送。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `uploadId` | `FT-01` |  |
| | `offset` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `length` | `FT-01/FT-17` | 文件身份 / 范围 / 校验 / 持久位置，不能用展示进度替代。 |
| `H:file.upload.progress` | 默认 | `FT-03/FT-17` | 合并展示进度，保留持久确认。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `uploadId` | `FT-01` |  |
| | `receivedBytes` | `FT-01/FT-17` | 文件身份 / 范围 / 校验 / 持久位置，不能用展示进度替代。 |
| `H:file.upload.finished` | 默认 | `FT-10/FT-17` | 响应原上传身份 / 范围；完成与失败及时发送。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `uploadId` | `FT-01` |  |
| | `path` | `FT-10/FT-17` |  |
| | `fileName`、`size`、`sha256`、`mimeType` | `FT-01/FT-17` | 文件身份 / 范围 / 校验 / 持久位置，不能用展示进度替代。 |
| `H:file.upload.failed` | 默认 | `FT-10/FT-17` | 响应原上传身份 / 范围；完成与失败及时发送。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`uploadId` | `FT-01` |  |
| | `code`、`message` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:host.online` | 默认 | `FT-03/FT-13` | 生命周期 / 路径变化发布，重复 metadata 复用。 |
| | `type` | `FT-01/FT-13` |  |
| | `hostId` | `FT-01` |  |
| `H:host.offline` | 默认 | `FT-03/FT-13` | 生命周期 / 路径变化发布，重复 metadata 复用。 |
| | `type` | `FT-01/FT-13` |  |
| | `hostId` | `FT-01` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:runtime.event` | 默认 | `FT-10` | 向相关请求 / 操作发送关联结果。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `runtimeId` | `FT-01` |  |
| | `sequence` | `FT-01/FT-12/FT-14` | 保留本通道传输顺序，与业务 source 版本分开。 |
| | `sharedContent` | `FT-01/FT-04/FT-07/FT-12/FT-13` | 只向已选择 compact-v2 的设备发送 shared-v1；旧表示保留原单条事件。 展开：`S:SharedSessionContent`。 |
| | `event` | `FT-10` |  展开：`E:session.changes.summaries`、`E:session.changes.updated`、`E:session.changes.page`、`E:session.change.detail.page`、`E:session.changes.failed`、`E:tool.activity`、`E:session.tool.content.page`、`E:session.tool.read.failed`、`E:session.tools.page`、`E:session.tools.patch`、`E:session.tools.changed`、`E:session.tools.produced`、`E:session.tools.opened`、`E:delivery.snapshot`、`E:execution.tasks`、`E:execution.activity`、`E:notification.source`、`E:runtime.status`、`E:runtime.metadata`、`E:runtime.capabilities`、`E:session.catalog`、`E:message.queued`、`E:session.sync.pending`、`E:session.entry.result`、`E:session.snapshot`、`E:session.patch`、`E:message.started`、`E:message.delta`、`E:message.finished`、`E:turn.started`、`E:turn.finished`、`E:tool.started`、`E:tool.updated`、`E:tool.finished`、`E:interaction.requested`、`E:interaction.snapshot`、`E:interaction.resolved`、`E:interaction.cancelled`、`E:local_interaction.required`、`E:command.result`、`E:artifact.started`、`E:artifact.failed`、`E:runtime.error`。 |
| `H:agent.state.snapshot` | 默认 | `FT-03/FT-12/FT-16` | 点名读取 / 订阅，内容变化发布，已知版本返回 unchanged。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `stateFormat` | `FT-01/FT-12/FT-13` | 显式选择 / 确认 compact-v1 或 compact-v2；表示版本隔离，旧 Host 关联拒绝后逐级降级重读。 |
| | `scope`、`update` | `FT-03/FT-12/FT-16` |  |
| | `modelEpoch`、`truncated`、`unchanged` | `FT-12` |  |
| | `domains` | `FT-03/FT-12/FT-16` |  展开：`S:AgentStateDomainSnapshot`。 |
| | `missing` | `FT-12` |  展开：`H:agent.state.snapshot.missing[]`。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:agent.state.snapshot.missing[]` | 默认 | `FT-10` | 向相关请求 / 操作发送关联结果。 |
| | `domain` | `FT-10` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:agent.state.range.page` | 默认 | `FT-05/FT-16` | 范围与视图驱动，不随普通状态刷新重发清单。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `scope`、`domain` | `FT-05/FT-16` |  |
| | `page` | `FT-05/FT-16` |  展开：`S:HostCatalogRange`。 |
| `H:diagnostics.page` | 默认 | `FT-05/FT-16` | 范围与视图驱动，不随普通状态刷新重发清单。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `page` | `FT-05/FT-16` |  展开：`S:DiagnosticPage`。 |
| `H:session.archive.changed` | 默认 | `FT-10` | 向相关请求 / 操作发送关联结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `archived` | `FT-10` |  |
| `H:session.list.result` | 默认 | `FT-05/FT-16` | 范围与视图驱动，不随普通状态刷新重发清单。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `sessions` | `FT-05/FT-16` |  展开：`S:AgentCatalogSession`。 |
| | `currentProviders` | `FT-05/FT-16` |  展开：`H:session.list.result.currentProviders[]`。 |
| `H:session.list.result.currentProviders[]` | 默认 | `FT-10` | 向相关请求 / 操作发送关联结果。 |
| | `agentKind` | `FT-01` |  |
| | `provider` | `FT-10` |  |
| `H:session.browse.result` | 默认 | `FT-05/FT-16` | 范围与视图驱动，不随普通状态刷新重发清单。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `path`、`parent` | `FT-05/FT-16` |  |
| | `entries` | `FT-05/FT-16` |  展开：`S:BrowseEntry`。 |
| `H:session.activated` | 默认 | `FT-10` | 向相关请求 / 操作发送关联结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `spawnMode` | `FT-10` |  |
| | `pid` | `FT-06/FT-15` | 进程诊断按需读取；激活结果以原会话身份确认。 |
| `H:protocol.error` | 默认 | `FT-10` | 向相关请求 / 操作发送关联结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `code`、`message` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| | `commandId`、`requestId` | `FT-01` |  |
| `H:provider.result` | 默认 | `FT-02/FT-05/FT-10/FT-13` | 原请求的目录 / 切换结果，复用 providers 权威，必要 notice 保留。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `kind`、`id` | `FT-01/FT-10` | 精确后端 / 供应商目标，回执关联原查询或切换。 |
| | `providers` | `FT-02/FT-05/FT-10/FT-13` |  展开：`S:ProviderResultItem`。 |
| | `notice` | `FT-10/FT-18` | 保留切换生效范围与必要后续动作，不作为菜单描述删除。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:provider.subscription.result` | 默认 | `FT-10/FT-15` | 相关配额查询回执，未知与错误明确。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `kind`、`id` | `FT-01/FT-10` | 精确后端 / 供应商目标，回执关联原查询或切换。 |
| | `quota` | `FT-10/FT-15` |  展开：`S:SubscriptionQuota`。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `H:provider.changed` | 默认 | `FT-03/FT-07/FT-13` | 只通知对应后端目录 / 当前选择失效，避免重发全目录。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `kind` | `FT-01/FT-10` | 精确后端 / 供应商目标，回执关联原查询或切换。 |
| `H:host.lan` | 默认 | `FT-02/FT-14` | 认证后的地址发现，只返回当前端点并按变化缓存。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `endpoints` | `FT-02/FT-14` |  展开：`S:LanEndpoint`。 |
| `H:runtime.git` | 默认 | `FT-02/FT-03/FT-07/FT-13` | 原 Runtime / 工作区查询回执，复用 Host workspace 的 Git 事实。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`sessionId` | `FT-01` |  |
| | `cwd` | `FT-01/FT-07` | 绑定请求时的准确工作区，结果到达前核对 Session 未切换。 |
| | `branch`、`commit` | `FT-02/FT-03/FT-07/FT-13` |  |

#### E 类结构

| 结构 | 字段 | 规则 | 补充 / 展开结构 |
| --- | --- | --- | --- |
| `E:session.changes.summaries` | 默认 | `FT-05/FT-06` | 只响应相关范围 / 详情读取，固定版本并可取消。 源码：`TurnChangesSummariesSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `summaries` | `FT-05/FT-06` |  展开：`S:TurnChangeSummary`。 |
| | `nextCursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `E:session.changes.updated` | 默认 | `FT-04/FT-16` | 仅向对应库存 / 修改视图的订阅者发布变化。 源码：`TurnChangesUpdatedSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `summary` | `FT-04/FT-16` |  展开：`S:TurnChangeSummary`。 |
| `E:session.changes.page` | 默认 | `FT-05/FT-06` | 只响应相关范围 / 详情读取，固定版本并可取消。 源码：`TurnChangesPageSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`changeSetId` | `FT-01` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `manifestVersion` | `FT-12` |  |
| | `files` | `FT-05/FT-06` |  展开：`S:FileChangeMetadata`。 |
| | `totalCount`、`nextCursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `E:session.change.detail.page` | 默认 | `FT-05/FT-06` | 只响应相关范围 / 详情读取，固定版本并可取消。 源码：`FileChangeDetailPageSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`changeSetId`、`fileId`、`viewerId`、`readId` | `FT-01` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `manifestVersion`、`contentVersion` | `FT-12` |  |
| | `text` | `FT-04/FT-07` | 正文只装载一份；按来源基准增量或所请求历史页取得。 |
| | `nextCursor`、`eof` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `E:session.changes.failed` | 默认 | `FT-10` | 相关设备及时取得真实结果、错误或等待阶段。 源码：`TurnChangesFailedSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `E:tool.activity` | 默认 | `FT-11` | Host 生产者消费，手机读取对应权威摘要或详情。 |
| | `type` | `FT-01/FT-13` |  |
| | `summary` | `FT-11` |  展开：`S:ToolSummary`。 |
| `E:session.tool.content.page` | 默认 | `FT-05/FT-06` | 只响应相关范围 / 详情读取，固定版本并可取消。 源码：`ToolContentPageSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `locator` | `FT-05/FT-06` |  展开：`S:ToolContentLocator`。 |
| | `read` | `FT-05/FT-06` |  展开：`S:ToolContentReadIdentity`。 |
| | `format`、`representation` | `FT-05/FT-06` |  |
| | `fromOffset`、`throughOffset`、`availableFromOffset`、`availableThroughOffset`、`observedThroughOffset`、`nextCursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `contentFinal` | `FT-12` |  |
| | `text` | `FT-04/FT-07` | 正文只装载一份；按来源基准增量或所请求历史页取得。 |
| | `gaps` | `FT-12` |  展开：`S:ToolContentGap`。 |
| `E:session.tool.read.failed` | 默认 | `FT-10` | 相关设备及时取得真实结果、错误或等待阶段。 源码：`ToolReadFailureSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `reason`、`retryAfterMs` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| | `gaps` | `FT-12` |  展开：`S:ToolContentGap`。 |
| `E:session.tools.page` | 默认 | `FT-05/FT-06` | 只响应相关范围 / 详情读取，固定版本并可取消。 源码：`ToolInventoryPageSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `snapshot` | `FT-05/FT-06` |  展开：`S:ToolInventorySnapshot`。 |
| | `startIndex`、`endIndex`、`nextCursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `tools` | `FT-05/FT-06` |  展开：`S:ToolSummary`。 |
| `E:session.tools.patch` | 默认 | `FT-04/FT-16` | 仅向对应库存 / 修改视图的订阅者发布变化。 源码：`ToolInventoryPatchSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `runtimeId` | `FT-01` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `version` | `FT-01/FT-13` |  展开：`S:ToolInventoryVersion`。 |
| | `baseRevision` | `FT-12` |  |
| | `source` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:ToolSourceDependency`。 |
| | `upserts` | `FT-04/FT-12` | 按准确 ID 和有效基准增删，部分页缺席不表示删除。 展开：`S:ToolSummary`。 |
| | `removes` | `FT-04/FT-12` | 按准确 ID 和有效基准增删，部分页缺席不表示删除。 |
| `E:session.tools.changed` | 默认 | `FT-04/FT-16` | 仅向对应库存 / 修改视图的订阅者发布变化。 源码：`ToolInventoryChangedSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `runtimeId` | `FT-01` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `version` | `FT-01/FT-13` |  展开：`S:ToolInventoryVersion`。 |
| | `source` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:ToolSourceDependency`。 |
| `E:session.tools.produced` | 默认 | `FT-11` | Host 生产者消费，手机读取对应权威摘要或详情。 源码：`ToolInventoryProducedSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `reference` | `FT-11` |  展开：`S:ToolInventoryReference`。 |
| | `page` | `FT-11` |  展开：`E:session.tools.page`。 |
| `E:session.tools.opened` | 默认 | `FT-01/FT-05/FT-12` | 向请求设备打开固定库存快照。 源码：`ToolInventoryOpenedSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `snapshot` | `FT-01/FT-05/FT-12` |  展开：`S:ToolInventorySnapshot`。 |
| `E:delivery.snapshot` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `items` | `FT-13` |  展开：`S:AgentDeliveryItem`。 |
| | `complete` | `FT-12` |  |
| `E:execution.tasks` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `tasks` | `FT-13` |  展开：`S:AgentTaskInventory`。 |
| `E:execution.activity` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `retry`、`compaction` | `FT-13` |  展开：`S:AgentActivity{1}`。 |
| `E:notification.source` | 默认 | `FT-11` | Host 生产者消费，手机读取对应权威摘要或详情。 源码：`NotificationSourceEventSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `producerEpoch`、`revision`、`complete` | `FT-12` |  |
| | `sessionId` | `FT-01` |  |
| | `notifications`、`outcomes` | `FT-11` |  展开：`S:NotificationInput`。 |
| `E:runtime.status` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `status` | `FT-13` |  |
| `E:runtime.metadata` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `metadata` | `FT-13` |  展开：`S:RuntimeMetadata`。 |
| `E:runtime.capabilities` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `capabilities` | `FT-13` |  展开：`S:RuntimeCapabilities`。 |
| `E:session.catalog` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `sessions` | `FT-13` |  展开：`S:SessionCatalogEntry`。 |
| `E:message.queued` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `queueId` | `FT-01` |  |
| | `text` | `FT-04/FT-07/FT-10` | 正文首次 / 编辑发送；状态变化引用原队列正文。 |
| | `delivery`、`state` | `FT-13` |  |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `E:session.sync.pending` | 默认 | `FT-10` | 相关设备及时取得真实结果、错误或等待阶段。 |
| | `type` | `FT-01/FT-13` |  |
| | `commandId` | `FT-01` |  |
| | `syncId`、`stage`、`leaseMs` | `FT-10` |  |
| `E:session.entry.result` | 默认 | `FT-05/FT-06` | 只响应相关范围 / 详情读取，固定版本并可取消。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`entryId` | `FT-01` |  |
| | `entry` | `FT-05/FT-06` |  展开：`S:RemoteSessionEntry`。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `E:session.snapshot` | 默认 | `FT-05/FT-07/FT-12` | 同一来源提交共享正文，恢复与增量保持基准。 |
| | `type` | `FT-01/FT-13` |  |
| | `sessionId`、`targetLeafId`、`beforeEntryId` | `FT-01` |  |
| | `syncId`、`mode` | `FT-05/FT-07/FT-12` |  |
| | `cursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 展开：`S:SessionBranchCursor`。 |
| | `entries` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:RemoteSessionEntry`。 |
| | `turnTimings` | `FT-05/FT-07/FT-12` |  展开：`S:RuntimeTurnTiming`。 |
| | `range`、`hasOlder` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `complete`、`rangeStatus`、`selection` | `FT-12` |  |
| | `source` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:SessionSourceEpoch`。 |
| | `checkpoint` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:SessionCheckpoint`。 |
| | `live` | `FT-05/FT-07/FT-12` |  展开：`S:SessionLiveState`。 |
| | `display` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:DisplayBatch`。 |
| `E:session.patch` | 默认 | `FT-04/FT-07/FT-12` | 同一来源提交共享正文，恢复与增量保持基准。 源码：`SessionPatchSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `sessionId`、`checkpointId` | `FT-01` |  |
| | `source` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:SessionSourceEpoch`。 |
| | `baseSeq`、`seq`、`headCompleteness` | `FT-12` |  |
| | `head` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:SessionBranchCursor`。 |
| | `live` | `FT-04/FT-07/FT-12` |  展开：`S:SessionLiveState`。 |
| | `entries` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:RemoteSessionEntry`。 |
| | `display` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:DisplayBatch`。 |
| `E:message.started` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `message` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 展开：`S:ChatMessage`。 |
| | `queueId` | `FT-01` |  |
| `E:message.delta` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `messageId` | `FT-01` |  |
| | `contentType`、`contentIndex` | `FT-13` |  |
| | `delta` | `FT-04/FT-12/FT-13` | compact-v2 的 value 重建指令；value 为 null 占位，实际提交后推进领域版本。 |
| `E:message.finished` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `message` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 展开：`S:ChatMessage`。 |
| | `queueId` | `FT-01` |  |
| `E:turn.started` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `turnId`、`startedAt`、`turnIndex` | `FT-13` |  |
| `E:turn.finished` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-01/FT-13` |  |
| | `outcome`、`turnId`、`startedAt`、`turnIndex` | `FT-13` |  |
| | `durationMs` | `FT-03/FT-09/FT-10` | 运行中按开始时间显示，最终耗时保留来源确认。 |
| | `messageId`、`persistedMessageId` | `FT-01` |  |
| | `persistedMessages` | `FT-13` |  展开：`E:turn.finished.persistedMessages[]`。 |
| `E:turn.finished.persistedMessages[]` | 默认 | `FT-01/FT-04/FT-07` | 消息与条目精确对应，原子交接。 |
| | `messageId`、`entryId` | `FT-01` |  |
| `E:tool.started` | 默认 | `FT-11` | Host 生产者消费，手机读取对应权威摘要或详情。 |
| | `type` | `FT-01/FT-13` |  |
| | `toolCallId` | `FT-01` |  |
| | `toolName` | `FT-11` |  |
| | `arguments` | `FT-06/FT-11` | 原始工具体留在 Host，显式详情读取。 |
| `E:tool.updated` | 默认 | `FT-11` | Host 生产者消费，手机读取对应权威摘要或详情。 |
| | `type` | `FT-01/FT-13` |  |
| | `toolCallId` | `FT-01` |  |
| | `toolName` | `FT-11` |  |
| | `partialResult` | `FT-06/FT-11` | 原始工具体留在 Host，显式详情读取。 |
| `E:tool.finished` | 默认 | `FT-11` | Host 生产者消费，手机读取对应权威摘要或详情。 |
| | `type` | `FT-01/FT-13` |  |
| | `toolCallId` | `FT-01` |  |
| | `toolName`、`isError` | `FT-11` |  |
| | `result` | `FT-06/FT-11` | 工具结果只经详情读取，事件在 Host 消费。 |
| `E:interaction.requested` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `request` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 展开：`S:InteractionRequest{confirm}`、`S:InteractionRequest{select}`、`S:InteractionRequest{multi-select}`、`S:InteractionRequest{input}`、`S:InteractionRequest{questionnaire}`。 |
| `E:interaction.snapshot` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `requests` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 展开：`S:InteractionRequest{confirm}`、`S:InteractionRequest{select}`、`S:InteractionRequest{multi-select}`、`S:InteractionRequest{input}`、`S:InteractionRequest{questionnaire}`。 |
| `E:interaction.resolved` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type`、`source` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `requestId` | `FT-01/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `E:interaction.cancelled` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type`、`reason` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `requestId` | `FT-01/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `E:local_interaction.required` | 默认 | `FT-13` | 按设备业务权威输出；已接入对应模型 / 聊天事务的设备关闭同义旧事件。 |
| | `type`、`kind` | `FT-01/FT-13` |  |
| | `title` | `FT-13` |  |
| `E:command.result` | 默认 | `FT-10` | 相关设备及时取得真实结果、错误或等待阶段。 |
| | `type` | `FT-01/FT-13` |  |
| | `commandId` | `FT-01` |  |
| | `ok`、`status` | `FT-10` |  |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| | `result` | `FT-06/FT-07/FT-10` | 先展开 KnownCommandResult，必要小结果及时取得；其余原始对象以原操作详情引用读取。 |
| `E:artifact.started` | 默认 | `FT-10/FT-17` | 文件操作定向响应并保持范围、身份和结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `commandId`、`transferId` | `FT-01` |  |
| | `offset` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `artifact` | `FT-10/FT-17` |  展开：`S:RemoteArtifact`。 |
| `E:artifact.failed` | 默认 | `FT-10` | 相关设备及时取得真实结果、错误或等待阶段。 |
| | `type` | `FT-01/FT-13` |  |
| | `artifactId`、`transferId` | `FT-01` |  |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `E:runtime.error` | 默认 | `FT-10` | 相关设备及时取得真实结果、错误或等待阶段。 |
| | `type` | `FT-01/FT-13` |  |
| | `message`、`recoverable` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| | `commandId` | `FT-01` |  |

#### U 类结构

| 结构 | 字段 | 规则 | 补充 / 展开结构 |
| --- | --- | --- | --- |
| `U:transport.fields.read` | 默认 | `FT-01/FT-05/FT-12/FT-15/FT-16` | 显式字段计量分页；固定快照、采样统计口径与发送总数分别返回，不包含内容或凭据。 源码：`TransportFieldsRequestSchema`。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `cursor`、`limit` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `backend`、`messageType` | `FT-01/FT-05/FT-12/FT-15/FT-16` |  |
| `U:agent.menu.options.read` | 默认 | `FT-01/FT-05/FT-08/FT-12/FT-16` | 选择器打开时读取固定目录的有界页；关闭取消本地等待，旧游标与迟到页不能应用。 源码：`MenuOptionsRequestSchema`。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `commandName`、`catalogId` | `FT-01/FT-05/FT-08/FT-12/FT-16` |  |
| | `cursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `U:notification.sync` | 默认 | `FT-05/FT-16` | 明确读取作用域与范围，取消已释放兴趣。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `runtimeId` | `FT-01` |  |
| `U:notification.dismiss` | 默认 | `FT-01/FT-10` | 精确目标与请求身份提交一次，重试核对原结果。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `hostEpoch` | `FT-12` |  |
| | `runtimeId`、`notificationId` | `FT-01` |  |
| `U:device.version.report` | 默认 | `FT-02/FT-14` | 认证后按连接 / 版本变化报告实际发行身份。 |
| | `type`、`protocolVersion`、`version` | `FT-01/FT-13` |  |
| | `versionCode` | `FT-02/FT-14` |  |
| `U:runtime.command` | 默认 | `FT-01/FT-10` | 精确目标与请求身份提交一次，重试核对原结果。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `runtimeId`、`commandId` | `FT-01` |  |
| | `command` | `FT-01/FT-10` |  展开：`C:session.changes.list`、`C:session.changes.read`、`C:session.change.detail.read`、`C:session.change.detail.cancel`、`C:session.tool.content.read`、`C:session.tool.content.cancel`、`C:session.tools.read`、`C:session.tools.open`、`C:file.download`、`C:artifact.download`、`C:artifact.cancel`、`C:session.sync`、`C:session.snapshot.ack`、`C:session.entry.request`、`C:user_message`、`C:user_message.cancel`、`C:slash.execute`、`C:permissions.update`、`C:stop`、`C:interaction.respond`。 |
| `U:session.list` | 默认 | `FT-05/FT-16` | 明确读取作用域与范围，取消已释放兴趣。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| `U:session.archive` | 默认 | `FT-01/FT-10` | 精确目标与请求身份提交一次，重试核对原结果。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `archived` | `FT-01/FT-10` |  |
| `U:session.browse` | 默认 | `FT-05/FT-16` | 明确读取作用域与范围，取消已释放兴趣。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `path` | `FT-05/FT-16` |  |
| `U:session.activate` | 默认 | `FT-01/FT-10` | 精确目标与请求身份提交一次，重试核对原结果。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `target` | `FT-01/FT-10` |  展开：`U:session.activate.target{resume}`、`U:session.activate.target{new}`。 |
| | `spawnMode` | `FT-01/FT-10` |  |
| `U:session.activate.target{resume}` | 默认 | `FT-01/FT-10` | 精确目标与请求身份提交一次，重试核对原结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `sessionId`、`agentKind` | `FT-01` |  |
| `U:session.activate.target{new}` | 默认 | `FT-01/FT-10` | 精确目标与请求身份提交一次，重试核对原结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `agentKind` | `FT-01` |  |
| | `cwd` | `FT-01/FT-10` |  |
| `U:agent.state.request` | 默认 | `FT-12/FT-16` | 只请求实际兴趣与已应用版本，不连带触发整后端外发。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `stateFormat` | `FT-01/FT-12/FT-13` | 显式选择 / 确认 compact-v1 或 compact-v2；表示版本隔离，旧 Host 关联拒绝后逐级降级重读。 |
| | `scope`、`domains`、`subscribe` | `FT-12/FT-16` |  |
| | `known` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`U:agent.state.request.known[]`。 |
| `U:agent.state.request.known[]` | 默认 | `FT-01/FT-10` | 精确目标与请求身份提交一次，重试核对原结果。 |
| | `domain` | `FT-01/FT-10` |  |
| | `modelEpoch`、`revision` | `FT-12` |  |
| `U:agent.state.range.request` | 默认 | `FT-05/FT-16` | 明确读取作用域与范围，取消已释放兴趣。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `scope`、`domain` | `FT-05/FT-16` |  |
| | `cursor`、`limit` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `U:diagnostics.request` | 默认 | `FT-05/FT-16` | 明确读取作用域与范围，取消已释放兴趣。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `cursor`、`limit` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `category`、`severity` | `FT-05/FT-16` |  |
| `U:artifact.read` | 默认 | `FT-05/FT-16` | 明确读取作用域与范围，取消已释放兴趣。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `transferId`、`requestId` | `FT-01` |  |
| | `offset` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `length` | `FT-05/FT-16` |  |
| `U:artifact.done` | 默认 | `FT-10/FT-17` | 按原文件身份提交范围、确认或取消。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `transferId` | `FT-01` |  |
| `U:file.upload.init` | 默认 | `FT-10/FT-17` | 按原文件身份提交范围、确认或取消。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `directory` | `FT-10/FT-17` |  |
| | `fileName`、`size`、`sha256`、`mimeType` | `FT-01/FT-17` | 文件身份 / 范围 / 校验 / 持久位置，不能用展示进度替代。 |
| `U:file.upload.cancel` | 默认 | `FT-10/FT-17` | 按原文件身份提交范围、确认或取消。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `uploadId` | `FT-01` |  |
| `U:provider.list` | 默认 | `FT-01/FT-05/FT-16` | 明确查询相关后端 / Runtime / 端点，已释放兴趣不重复刷新。 |
| | `type`、`protocolVersion`、`kind` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| `U:provider.switch` | 默认 | `FT-01/FT-10` | 精确目标与请求身份提交一次，重试核对原结果。 |
| | `type`、`protocolVersion`、`kind` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `id`、`enabled` | `FT-01/FT-10` |  |
| `U:provider.subscription` | 默认 | `FT-01/FT-05/FT-16` | 明确查询相关后端 / Runtime / 端点，已释放兴趣不重复刷新。 |
| | `type`、`protocolVersion`、`kind` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `id` | `FT-01/FT-05/FT-16` |  |
| `U:host.lan.request` | 默认 | `FT-01/FT-05/FT-16` | 明确查询相关后端 / Runtime / 端点，已释放兴趣不重复刷新。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| `U:runtime.git.request` | 默认 | `FT-01/FT-05/FT-16` | 明确查询相关后端 / Runtime / 端点，已释放兴趣不重复刷新。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `runtimeId`、`requestId` | `FT-01` |  |

#### C 类结构

| 结构 | 字段 | 规则 | 补充 / 展开结构 |
| --- | --- | --- | --- |
| `C:session.changes.list` | 默认 | `FT-05/FT-12/FT-16` | 绑定来源和当前兴趣，按范围读取。 源码：`TurnChangesListRequestSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `entryIds`、`turnIds` | `FT-05/FT-12/FT-16` |  |
| | `cursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `C:session.changes.read` | 默认 | `FT-05/FT-12/FT-16` | 绑定来源和当前兴趣，按范围读取。 源码：`TurnChangesReadRequestSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`changeSetId` | `FT-01` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `manifestVersion` | `FT-12` |  |
| | `cursor`、`maxItems` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `C:session.change.detail.read` | 默认 | `FT-05/FT-12/FT-16` | 绑定来源和当前兴趣，按范围读取。 源码：`FileChangeDetailReadRequestSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`changeSetId`、`fileId`、`viewerId`、`readId` | `FT-01` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `manifestVersion`、`contentVersion` | `FT-12` |  |
| | `cursor`、`maxBytes` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `C:session.change.detail.cancel` | 默认 | `FT-01/FT-10` | 原目标输入 / 取消；Host 校验准入并确认业务结果。 源码：`FileChangeDetailCancelSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`viewerId`、`readId` | `FT-01` |  |
| `C:session.tool.content.read` | 默认 | `FT-05/FT-12/FT-16` | 绑定来源和当前兴趣，按范围读取。 源码：`ToolContentReadRequestSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`viewerId` | `FT-01` |  |
| | `locator` | `FT-05/FT-12/FT-16` |  展开：`S:ToolContentLocator`。 |
| | `read` | `FT-05/FT-12/FT-16` |  展开：`S:ToolContentReadIdentity`。 |
| | `offset`、`maxBytes` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `C:session.tool.content.cancel` | 默认 | `FT-01/FT-10` | 原目标输入 / 取消；Host 校验准入并确认业务结果。 源码：`ToolContentCancelSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`viewerId`、`readId` | `FT-01` |  |
| `C:session.tools.read` | 默认 | `FT-05/FT-12/FT-16` | 绑定来源和当前兴趣，按范围读取。 源码：`ToolInventoryReadRequestSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `snapshot` | `FT-05/FT-12/FT-16` |  展开：`S:ToolInventorySnapshot`。 |
| | `cursor`、`maxItems` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `C:session.tools.open` | 默认 | `FT-05/FT-12/FT-16` | 绑定来源和当前兴趣，按范围读取。 源码：`ToolInventoryOpenRequestSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId` | `FT-01` |  |
| | `reference` | `FT-05/FT-12/FT-16` |  展开：`S:ToolInventoryReference`。 |
| `C:file.download` | 默认 | `FT-01/FT-17` | 文件请求使用精确身份与偏移。 |
| | `type` | `FT-01/FT-13` |  |
| | `path` | `FT-01/FT-17` |  |
| | `offset` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `C:artifact.download` | 默认 | `FT-01/FT-17` | 文件请求使用精确身份与偏移。 |
| | `type` | `FT-01/FT-13` |  |
| | `artifactId` | `FT-01` |  |
| | `offset` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `C:artifact.cancel` | 默认 | `FT-01/FT-17` | 文件请求使用精确身份与偏移。 |
| | `type` | `FT-01/FT-13` |  |
| | `transferId` | `FT-01` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `C:session.sync` | 默认 | `FT-05/FT-12/FT-16` | 绑定来源和当前兴趣，按范围读取。 |
| | `type` | `FT-01/FT-13` |  |
| | `sessionId`、`knownLeafId`、`targetLeafId`、`beforeEntryId` | `FT-01` |  |
| | `syncId` | `FT-05/FT-12/FT-16` |  |
| | `maxEntries`、`range` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `knownState` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:SessionAppliedState`。 |
| `C:session.snapshot.ack` | 默认 | `FT-10/FT-12` | 实际提交或拒绝后按原 syncId 回执。 |
| | `type` | `FT-01/FT-13` |  |
| | `syncId` | `FT-10/FT-12` |  |
| | `result` | `FT-10/FT-12` | 实际提交 applied 或拒绝 rejected，不能用收包替代。 |
| `C:session.entry.request` | 默认 | `FT-05/FT-12/FT-16` | 绑定来源和当前兴趣，按范围读取。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`sessionId`、`entryId` | `FT-01` |  |
| `C:user_message` | 默认 | `FT-01/FT-10` | 原目标输入 / 取消；Host 校验准入并确认业务结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `text` | `FT-01/FT-10` | 用户输入完整提交原目标，Host 校验和执行。 |
| | `messageId` | `FT-01` |  |
| | `delivery`、`attachments` | `FT-01/FT-10` |  |
| `C:user_message.cancel` | 默认 | `FT-01/FT-10` | 原目标输入 / 取消；Host 校验准入并确认业务结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `messageId` | `FT-01` |  |
| `C:slash.execute` | 默认 | `FT-01/FT-10` | 原目标输入 / 取消；Host 校验准入并确认业务结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `name`、`args` | `FT-01/FT-10` |  |
| | `optionCatalogId` | `FT-01/FT-08/FT-10/FT-12/FT-13` | 调用提交已显示目录版本；Host 验证准确目标与版本后移除此本机验证字段再执行。 |
| | `messageId` | `FT-01` |  |
| `C:permissions.update` | 默认 | `FT-01/FT-10` | 原目标输入 / 取消；Host 校验准入并确认业务结果。 |
| | `type` | `FT-01/FT-13` |  |
| | `settingId` | `FT-01` |  |
| | `value` | `FT-01/FT-10` |  |
| `C:stop` | 默认 | `FT-01/FT-10` | 原目标输入 / 取消；Host 校验准入并确认业务结果。 |
| | `type` | `FT-01/FT-13` |  |
| `C:interaction.respond` | 默认 | `FT-10/FT-18` | 原请求内提交准确响应，敏感内容临时持有。 |
| | `type` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `requestId`、`extensionId` | `FT-01/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `response` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 展开：`S:InteractionResponse{confirm}`、`S:InteractionResponse{select}`、`S:InteractionResponse{multi-select}`、`S:InteractionResponse{input}`、`S:InteractionResponse{questionnaire}`、`S:InteractionResponse{cancel}`。 |

#### A 类结构

| 结构 | 字段 | 规则 | 补充 / 展开结构 |
| --- | --- | --- | --- |
| `A:runtime.authenticate` | 默认 | `FT-14` | 仅在原认证 / 本机生产者入口发送，不进入手机共享业务状态。 |
| | `type`、`protocolVersion` | `FT-14` | 保留认证 / 路由 / 序号格式与能力校验。 |
| | `credential` | `FT-14` | 只用于原认证入口，不进入共享业务与日志。 |
| | `role` | `FT-14` |  |
| | `runtime` | `FT-14` |  展开：`S:RuntimeMetadata`。 |
| `A:runtime.event` | 默认 | `FT-14` | 仅在原认证 / 本机生产者入口发送，不进入手机共享业务状态。 |
| | `type`、`protocolVersion`、`sequence` | `FT-14` | 保留认证 / 路由 / 序号格式与能力校验。 |
| | `runtimeId` | `FT-01` |  |
| | `event` | `FT-14` |  展开：`E:session.changes.summaries`、`E:session.changes.updated`、`E:session.changes.page`、`E:session.change.detail.page`、`E:session.changes.failed`、`E:tool.activity`、`E:session.tool.content.page`、`E:session.tool.read.failed`、`E:session.tools.page`、`E:session.tools.patch`、`E:session.tools.changed`、`E:session.tools.produced`、`E:session.tools.opened`、`E:delivery.snapshot`、`E:execution.tasks`、`E:execution.activity`、`E:notification.source`、`E:runtime.status`、`E:runtime.metadata`、`E:runtime.capabilities`、`E:session.catalog`、`E:message.queued`、`E:session.sync.pending`、`E:session.entry.result`、`E:session.snapshot`、`E:session.patch`、`E:message.started`、`E:message.delta`、`E:message.finished`、`E:turn.started`、`E:turn.finished`、`E:tool.started`、`E:tool.updated`、`E:tool.finished`、`E:interaction.requested`、`E:interaction.snapshot`、`E:interaction.resolved`、`E:interaction.cancelled`、`E:local_interaction.required`、`E:command.result`、`E:artifact.started`、`E:artifact.failed`、`E:runtime.error`。 |
| `A:device.authenticate` | 默认 | `FT-14` | 仅在原认证 / 本机生产者入口发送，不进入手机共享业务状态。 |
| | `type`、`protocolVersion` | `FT-14` | 保留认证 / 路由 / 序号格式与能力校验。 |
| | `credential` | `FT-14` | 只用于原认证入口，不进入共享业务与日志。 |

#### S 类结构

| 结构 | 字段 | 规则 | 补充 / 展开结构 |
| --- | --- | --- | --- |
| `S:AgentKey` | 默认 | `FT-01` | 随所属对象装载准确身份，可按作用域引用。 源码：`AgentKeySchema`。 |
| | `hostId`、`agentKind`、`sessionId` | `FT-01` |  |
| `S:TurnChangeSummary` | 默认 | `FT-03/FT-05/FT-12` | 修改摘要随变化，文件页 / diff 按需并绑定版本。 源码：`TurnChangeSummarySchema`。 |
| | `projectionVersion`、`manifestVersion`、`revision`、`coverage` | `FT-12` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `reviewTurnId`、`sourceTurnIds`、`changeSetId`、`anchorEntryId` | `FT-01` |  |
| | `startedAt`、`finishedAt`、`state`、`outcome`、`scope`、`attribution`、`reasons`、`fileCount`、`addedFiles`、`modifiedFiles`、`deletedFiles`、`additions`、`deletions` | `FT-03/FT-05/FT-12` |  |
| | `preview` | `FT-03/FT-05/FT-12` |  展开：`S:FileChangeMetadata`。 |
| `S:FileChangeMetadata` | 默认 | `FT-03/FT-05/FT-12` | 修改摘要随变化，文件页 / diff 按需并绑定版本。 源码：`FileChangeMetadataSchema`。 |
| | `fileId` | `FT-01` |  |
| | `path`、`oldPath`、`changeKind`、`fileKind`、`additions`、`deletions`、`beforeBytes`、`afterBytes`、`detail` | `FT-03/FT-05/FT-12` |  |
| | `contentVersion` | `FT-12` |  |
| `S:ToolSummary` | 默认 | `FT-04/FT-07` | 摘要按内容变化，历史 / live / 库存共享内容。 源码：`ToolSummarySchema`。 |
| | `projectionVersion` | `FT-12` |  |
| | `tool` | `FT-01` |  展开：`S:ToolIdentity`。 |
| | `toolName`、`phase`、`isError`、`turnId`、`order`、`exitCode` | `FT-04/FT-07` |  |
| | `messageId`、`entryId` | `FT-01` |  |
| | `durationMs` | `FT-03/FT-09/FT-10` | 运行中按开始时间显示，最终耗时保留来源确认。 |
| | `inputSummary`、`resultSummary`、`errorSummary` | `FT-04/FT-07` |  展开：`S:ToolSummaryText`。 |
| | `contents` | `FT-04/FT-07` |  展开：`S:ToolContentDescriptor`。 |
| `S:ToolIdentity` | 默认 | `FT-01` | 随所属对象装载准确身份，可按作用域引用。 源码：`ToolIdentitySchema`。 |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `toolCallId` | `FT-01` |  |
| `S:ToolSummaryText` | 默认 | `FT-04/FT-07` | 摘要按内容变化，历史 / live / 库存共享内容。 源码：`ToolSummaryTextSchema`。 |
| | `text` | `FT-05/FT-06/FT-15` | 保留有界摘要 / 诊断；原始内容显式读取。 |
| | `omitted`、`originalBytes` | `FT-12` |  |
| `S:ToolContentDescriptor` | 默认 | `FT-04/FT-07` | 摘要按内容变化，历史 / live / 库存共享内容。 源码：`ToolContentDescriptorSchema`。 |
| | `part`、`format`、`readCapability` | `FT-04/FT-07` |  |
| | `availability` | `FT-12` |  |
| `S:ToolContentLocator` | 默认 | `FT-01/FT-06/FT-12` | 工具详情按查看器、版本和范围读取 / 取消。 源码：`ToolContentLocatorSchema`。 |
| | `projectionVersion` | `FT-12` |  |
| | `tool` | `FT-01` |  展开：`S:ToolIdentity`。 |
| | `part` | `FT-01/FT-06/FT-12` |  |
| `S:ToolContentReadIdentity` | 默认 | `FT-01/FT-06/FT-12` | 工具详情按查看器、版本和范围读取 / 取消。 源码：`ToolContentReadIdentitySchema`。 |
| | `readId` | `FT-01` |  |
| | `contentEpoch` | `FT-12` |  |
| | `throughOffset` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `S:ToolContentGap` | 默认 | `FT-01/FT-06/FT-12` | 工具详情按查看器、版本和范围读取 / 取消。 源码：`ToolContentGapSchema`。 |
| | `fromOffset`、`throughOffset` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:ToolInventorySnapshot` | 默认 | `FT-05/FT-12` | 固定版本的工具摘要库存，按需分页。 源码：`ToolInventorySnapshotSchema`。 |
| | `snapshotId` | `FT-01` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `version` | `FT-12` | 库存 epoch / revision 随对应提交。 展开：`S:ToolInventoryVersion`。 |
| | `source` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:ToolSourceDependency`。 |
| | `totalCount` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `S:ToolInventoryVersion` | 默认 | `FT-07/FT-12` | 引用摘要库存，版本与来源完整保留。 源码：`ToolInventoryVersionSchema`。 |
| | `epoch`、`revision` | `FT-12` |  |
| `S:ToolSourceDependency` | 默认 | `FT-07/FT-12` | 引用摘要库存，版本与来源完整保留。 源码：`ToolSourceDependencySchema`。 |
| | `epoch`、`seq` | `FT-12` |  |
| `S:ToolInventoryReference` | 默认 | `FT-07/FT-12` | 引用摘要库存，版本与来源完整保留。 源码：`ToolInventoryReferenceSchema`。 |
| | `projectionVersion` | `FT-12` |  |
| | `agent` | `FT-01` |  展开：`S:AgentKey`。 |
| | `version` | `FT-12` | 库存 epoch / revision 随对应提交。 展开：`S:ToolInventoryVersion`。 |
| | `source` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:ToolSourceDependency`。 |
| | `totalCount` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `summaryBytes` | `FT-07/FT-12` |  |
| `S:AgentDeliveryItem` | 默认 | `FT-04/FT-10` | 队列按 ID 更新，正文不随每次状态重传。 源码：`AgentDeliveryItemSchema`。 |
| | `queueId` | `FT-01` |  |
| | `text` | `FT-04/FT-07/FT-10` | 正文首次 / 编辑发送；状态变化引用原队列正文。 |
| | `delivery`、`state` | `FT-04/FT-10` |  |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:AgentTaskInventory` | 默认 | `FT-03/FT-04` | 当前运行与子任务变化，终态及时发送。 源码：`AgentTaskInventorySchema`。 |
| | `availability`、`truncated` | `FT-12` |  |
| | `items` | `FT-03/FT-04` |  展开：`S:AgentTask`。 |
| `S:AgentTask` | 默认 | `FT-03/FT-04` | 当前运行与子任务变化，终态及时发送。 源码：`AgentTaskSchema`。 |
| | `id`、`title`、`status` | `FT-03/FT-04` |  |
| | `parentId` | `FT-01` |  |
| | `kind` | `FT-01/FT-13` |  |
| `S:AgentActivity{1}` | 默认 | `FT-03/FT-04` | 当前运行与子任务变化，终态及时发送。 |
| | `phase`、`turnId`、`attempt`、`detail` | `FT-03/FT-04` |  |
| `S:NotificationInput` | 默认 | `FT-04/FT-07/FT-12/FT-18` | 设备私有通知与引用，出现 / 结束 / 删除准确同步。 源码：`NotificationInputSchema`。 |
| | `code`、`severity`、`message`、`lifecycle`、`displayMs` | `FT-01/FT-04/FT-10/FT-18` | 同一通知身份下保留必要正文、严重度、生命周期与有效期；终态不可合并丢失。 |
| | `occurrenceId` | `FT-01` |  |
| | `scope` | `FT-01/FT-04/FT-10/FT-18` | 同一通知身份下保留必要正文、严重度、生命周期与有效期；终态不可合并丢失。 展开：`S:NotificationScope`。 |
| `S:NotificationScope` | 默认 | `FT-01` | 随所属对象装载准确身份，可按作用域引用。 源码：`NotificationScopeSchema`。 |
| | `turnId` | `FT-01` |  |
| | `requestId`、`operationId`、`commandId` | `FT-01` |  |
| `S:RuntimeMetadata` | 默认 | `FT-02/FT-07` | 身份精简，动态事实引用对应领域。 源码：`RuntimeMetadataSchema`。 |
| | `runtimeId`、`sessionId` | `FT-01/FT-02` | 稳定身份 / 名称元数据按版本缓存。 |
| | `name`、`sessionGraphSync`、`hostname`、`sessionName` | `FT-02/FT-07` | 稳定身份 / 名称元数据按版本缓存。 |
| | `cwd` | `FT-03/FT-07/FT-13` | 新表示引用 workspaceRef，兼容分支保留原字段。 |
| | `status` | `FT-03/FT-07/FT-13` | 新表示引用 execution，兼容分支保留原字段。 |
| | `sessionLeafId` | `FT-03/FT-07/FT-13` | 新表示引用 history，兼容分支保留原字段。 |
| | `model` | `FT-03/FT-07/FT-13` | 新表示引用 model，兼容分支保留原字段。 展开：`S:RuntimeModelInfo`。 |
| | `thinkingLevel` | `FT-03/FT-07/FT-13` | 新表示引用 model，兼容分支保留原字段。 |
| | `contextUsage` | `FT-03/FT-07/FT-13` | 新表示引用 context，兼容分支保留原字段。 展开：`S:RuntimeContextUsage`。 |
| | `permissions` | `FT-03/FT-07/FT-13` | 新表示引用 permissions，兼容分支保留原字段。 展开：`S:RuntimePermissions`。 |
| | `permissionManagement` | `FT-03/FT-07/FT-13` | 新表示引用 permissions，兼容分支保留原字段。 展开：`S:PermissionManagement`。 |
| `S:RuntimeModelInfo` | 默认 | `FT-02/FT-03/FT-07` | 当前选择变化发布，目录名称复用。 源码：`RuntimeModelInfoSchema`。 |
| | `provider`、`id` | `FT-02/FT-03/FT-07` |  |
| | `name` | `FT-02/FT-07` | 必要名称按其事实版本复用。 |
| `S:RuntimeContextUsage` | 默认 | `FT-03/FT-09` | 合并真实用量变化，确定性值按明确算法派生。 源码：`RuntimeContextUsageSchema`。 |
| | `tokens`、`contextWindow` | `FT-03/FT-09` |  |
| | `percent` | `FT-03/FT-09/FT-12` | 语义一致时由 tokens/window 派生，否则保留来源百分比。 |
| `S:RuntimePermissions` | 默认 | `FT-02/FT-03/FT-18` | 当前权限与选项分开，风险和禁用原因保持。 源码：`RuntimePermissionsSchema`。 |
| | `sandbox`、`approvalPolicy`、`reviewer`、`networkAccess`、`writableRoots`、`readableRoots`、`profile`、`problem` | `FT-02/FT-03/FT-18` |  |
| `S:PermissionManagement` | 默认 | `FT-02/FT-03/FT-18` | 当前权限与选项分开，风险和禁用原因保持。 源码：`PermissionManagementSchema`。 |
| | `summary`、`tone` | `FT-02/FT-03/FT-18` |  |
| | `details` | `FT-06/FT-18` | 权限视图按需读取，确认所需完整范围必须可取得。 |
| | `settings` | `FT-01/FT-02/FT-08` | 设置 / 选项模板缓存，准确值保留。 展开：`S:PermissionManagement.settings[]`。 |
| `S:PermissionManagement.settings[]` | 默认 | `FT-02/FT-03/FT-18` | 当前权限与选项分开，风险和禁用原因保持。 |
| | `id`、`label` | `FT-01/FT-02/FT-08` | 设置 / 选项模板缓存，准确值保留。 |
| | `currentValue` | `FT-03/FT-18` | 与原生设置独立核对当前选择。 |
| | `disabledReason` | `FT-03/FT-18` | 保留当前不可操作 / 风险原因。 |
| | `options` | `FT-01/FT-02/FT-08` | 设置 / 选项模板缓存，准确值保留。 展开：`S:PermissionManagement.settings[].options[]`。 |
| `S:PermissionManagement.settings[].options[]` | 默认 | `FT-02/FT-03/FT-18` | 当前权限与选项分开，风险和禁用原因保持。 |
| | `value`、`label` | `FT-01/FT-02/FT-08` | 设置 / 选项模板缓存，准确值保留。 |
| | `description` | `FT-08/FT-18` | 菜单选项说明省略；独立风险 / 禁用原因通过决策字段保留。 |
| `S:RuntimeCapabilities` | 默认 | `FT-02/FT-08` | 精简目录按版本缓存；大型选项独立分页。 源码：`RuntimeCapabilitiesSchema`。 |
| | `commands` | `FT-02/FT-08` |  展开：`S:RuntimeSlashCommand`。 |
| `S:RuntimeSlashCommand` | 默认 | `FT-02/FT-08` | 精简目录按版本缓存；大型选项独立分页。 源码：`RuntimeSlashCommandSchema`。 |
| | `name` | `FT-01/FT-02/FT-08` | 准确调用目标 / 选项值，App 原样提交。 |
| | `description` | `FT-08` |  |
| | `source` | `FT-02/FT-08` | 仅保留分类、输入类型与必填性等必要选择信息。 |
| | `argument` | `FT-02/FT-08` | 仅保留分类、输入类型与必填性等必要选择信息。 展开：`S:RuntimeSlashCommandArgument`。 |
| `S:RuntimeSlashCommandArgument` | 默认 | `FT-02/FT-08` | 精简目录按版本缓存；大型选项独立分页。 源码：`RuntimeSlashCommandArgumentSchema`。 |
| | `kind`、`required` | `FT-02/FT-08` | 仅保留分类、输入类型与必填性等必要选择信息。 |
| | `hint` | `FT-08` |  |
| | `options` | `FT-02/FT-05/FT-08` | 小静态选项按版本缓存；树 / 会话动态选项打开时分页。 展开：`S:RuntimeSlashCommandOption`。 |
| | `optionCatalog` | `FT-01/FT-02/FT-05/FT-08/FT-12/FT-13` | compact-v1 中替代大型选项；id 绑定作用域、来源代次和完整内容，count 保留全量计数。 展开：`S:RuntimeSlashCommandArgument.optionCatalog`。 |
| `S:RuntimeSlashCommandOption` | 默认 | `FT-02/FT-08` | 精简目录按版本缓存；大型选项独立分页。 源码：`RuntimeSlashCommandOptionSchema`。 |
| | `value` | `FT-01/FT-02/FT-08` | 准确调用目标 / 选项值，App 原样提交。 |
| | `label` | `FT-02/FT-08` | 必要选项名称；等于 value 时按新表示复用。 |
| | `description` | `FT-08` |  |
| | `tree` | `FT-05/FT-08` | 移出稳定命令目录，归入历史树页。 展开：`S:RuntimeSlashCommandOption.tree`。 |
| `S:RuntimeSlashCommandOption.tree` | 默认 | `FT-02/FT-08` | 精简目录按版本缓存；大型选项独立分页。 |
| | `parentId`、`entryType`、`role`、`label`、`defaultHidden` | `FT-01/FT-05/FT-12` | 只在历史树范围装载；当前位置独立变化，关系准确保留。 |
| | `isCurrent`、`isOnActivePath` | `FT-03/FT-05/FT-12` | 只在历史树范围装载；当前位置独立变化，关系准确保留。 |
| `S:RuntimeSlashCommandArgument.optionCatalog` | 默认 | `FT-02/FT-08` | 精简目录按版本缓存；大型选项独立分页。 |
| | `id`、`count` | `FT-01/FT-02/FT-05/FT-08/FT-12/FT-13` | compact-v1 中替代大型选项；id 绑定作用域、来源代次和完整内容，count 保留全量计数。 |
| `S:SessionCatalogEntry` | 默认 | `FT-02/FT-05/FT-12` | 目录 / 首屏与分页兴趣驱动，版本和覆盖明确。 源码：`SessionCatalogEntrySchema`。 |
| | `sessionId` | `FT-01` |  |
| | `name`、`cwd`、`createdAt`、`modifiedAt`、`messageCount` | `FT-02/FT-05/FT-12` |  |
| | `firstMessage` | `FT-02/FT-05/FT-07` | 只发标题显示所需有界预览；完整原文走聊天读取，旧格式按 FT-13。 |
| `S:RemoteSessionEntry` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 源码：`RemoteSessionEntrySchema`。 |
| | `entryId`、`parentId` | `FT-01` |  |
| | `type` | `FT-01/FT-13` |  |
| | `timestamp` | `FT-04/FT-07/FT-12` |  |
| | `data` | `FT-06/FT-07/FT-11` | 按第 4 节 message / summary / 其余原生键展开。 展开：`S:RemoteSessionEntry.data`。 |
| `S:RemoteSessionEntry.data` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 |
| | `{*}` | `FT-06/FT-07/FT-11` | message / summary 按登记投影展开，其余原生键保留 Host，显式详情读取。 |
| `S:SessionBranchCursor` | 默认 | `FT-01/FT-12` | 随所属提交装载，不跨代次复用。 源码：`SessionBranchCursorSchema`。 |
| | `leafId` | `FT-01` |  |
| `S:RuntimeTurnTiming` | 默认 | `FT-03/FT-07/FT-10` | 时点和最终耗时按所属回合复用。 源码：`RuntimeTurnTimingSchema`。 |
| | `turnId`、`startedAt`、`turnIndex` | `FT-03/FT-07/FT-10` |  |
| | `durationMs` | `FT-03/FT-09/FT-10` | 运行中按开始时间显示，最终耗时保留来源确认。 |
| | `messageId` | `FT-01` |  |
| `S:SessionSourceEpoch` | 默认 | `FT-01/FT-12` | 随所属提交装载，不跨代次复用。 源码：`SessionSourceEpochSchema`。 |
| | `epoch`、`seq`、`ready` | `FT-12` |  |
| `S:SessionCheckpoint` | 默认 | `FT-01/FT-12` | 随所属提交装载，不跨代次复用。 源码：`SessionCheckpointSchema`。 |
| | `checkpointId` | `FT-01` |  |
| | `head` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:SessionBranchCursor`。 |
| | `headCompleteness`、`inventoryComplete` | `FT-12` |  |
| `S:SessionLiveState` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 源码：`SessionLiveStateSchema`。 |
| | `complete` | `FT-12` |  |
| | `turn` | `FT-04/FT-07/FT-12` |  展开：`S:SessionLiveTurn`。 |
| | `messages` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:SessionLiveMessage`。 |
| | `tools` | `FT-07/FT-11/FT-12` | 工具库存以 toolInventory 引用取得；共享 live 不重复嵌入原生工具体 / 全量库存。 展开：`S:SessionLiveTool`。 |
| | `toolInventory` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:ToolInventoryReference`。 |
| `S:SessionLiveTurn` | 默认 | `FT-03/FT-04` | 当前运行与子任务变化，终态及时发送。 源码：`SessionLiveTurnSchema`。 |
| | `turnId`、`startedAt` | `FT-03/FT-04` |  |
| | `durationMs` | `FT-03/FT-09/FT-10` | 运行中按开始时间显示，最终耗时保留来源确认。 |
| `S:SessionLiveMessage` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 源码：`SessionLiveMessageSchema`。 |
| | `message` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 展开：`S:ChatMessage`。 |
| | `finished`、`order` | `FT-04/FT-07/FT-12` |  |
| | `contentComplete` | `FT-12` |  |
| | `persistedEntryId` | `FT-01` |  |
| `S:ChatMessage` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 源码：`ChatMessageSchema`。 |
| | `messageId`、`toolCallId` | `FT-01` |  |
| | `role`、`timestamp`、`toolName`、`isError`、`clientMessageId` | `FT-04/FT-07/FT-12` |  |
| | `content` | `FT-04/FT-07` | 正文只装载一份；按来源基准增量或所请求历史页取得。 展开：`S:RemoteContent{text}`、`S:RemoteContent{thinking}`、`S:RemoteContent{artifact}`、`S:RemoteContent{tool_call}`。 |
| | `toolSummary` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:ToolSummary`。 |
| `S:RemoteContent{text}` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 |
| | `type` | `FT-01/FT-13` |  |
| | `text` | `FT-04/FT-07` | 正文只装载一份；按来源基准增量或所请求历史页取得。 |
| | `truncated`、`originalBytes` | `FT-12` |  |
| `S:RemoteContent{thinking}` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 |
| | `type` | `FT-01/FT-13` |  |
| | `text` | `FT-04/FT-07` | 正文只装载一份；按来源基准增量或所请求历史页取得。 |
| | `truncated`、`originalBytes` | `FT-12` |  |
| `S:RemoteContent{artifact}` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 |
| | `type` | `FT-01/FT-13` |  |
| | `artifact` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:RemoteArtifact`。 |
| `S:RemoteArtifact` | 默认 | `FT-07/FT-17` | 文件描述符共享，内容显式读取。 源码：`RemoteArtifactSchema`。 |
| | `artifactId` | `FT-01` |  |
| | `fileName`、`mimeType`、`size`、`sha256` | `FT-01/FT-17` | 文件身份 / 范围 / 校验 / 持久位置，不能用展示进度替代。 |
| | `path` | `FT-06/FT-17` | 普通附件以 artifactId 读取；准确原生路径仅在明确操作需要时返回。 |
| `S:RemoteContent{tool_call}` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 |
| | `type` | `FT-01/FT-13` |  |
| | `toolCallId` | `FT-01` |  |
| | `toolName` | `FT-04/FT-07/FT-12` |  |
| | `arguments` | `FT-06/FT-11` | 原始工具体留在 Host，显式详情读取。 |
| | `summary` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:ToolSummary`。 |
| `S:SessionLiveTool` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 源码：`SessionLiveToolSchema`。 |
| | `toolCallId` | `FT-01` |  |
| | `toolName`、`state`、`isError` | `FT-04/FT-07/FT-12` |  |
| | `detail` | `FT-06/FT-11` | 原始工具体留在 Host，显式详情读取。 |
| | `summary` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:ToolSummary`。 |
| `S:DisplayBatch` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 源码：`DisplayBatchSchema`。 |
| | `projectionVersion` | `FT-12` |  |
| | `entries` | `FT-04/FT-07/FT-12` | 图、显示与 live 引用同一正文 / 摘要 / 描述符并保持原子提交。 展开：`S:DisplayEntry`。 |
| | `windowStart` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `S:DisplayEntry` | 默认 | `FT-04/FT-07/FT-12` | 正文单份，按来源提交；旧表示由兼容分支装配。 源码：`DisplayEntrySchema`。 |
| | `displayId`、`anchor` | `FT-04/FT-07/FT-12` |  |
| | `entryId` | `FT-01` |  |
| | `nativeType` | `FT-06/FT-07` | 原生类型由图 / 树 / 诊断持有；显示默认共享必要引用。 |
| | `kind` | `FT-01/FT-13` |  |
| | `message` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 展开：`S:ChatMessage`。 |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:InteractionRequest{confirm}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `runtimeId`、`requestId`、`extensionId` | `FT-01/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `title`、`description`、`toolName`、`argumentSummary`、`externalUrl`、`submitted`、`expiresAt`、`kind`、`confirmLabel`、`cancelLabel` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:InteractionRequest{select}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `runtimeId`、`requestId`、`extensionId` | `FT-01/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `title`、`description`、`toolName`、`argumentSummary`、`externalUrl`、`submitted`、`expiresAt`、`kind` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `options` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 展开：`S:InteractionRequest{select}.options[]`。 |
| `S:InteractionRequest{select}.options[]` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `value`、`label`、`description` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:InteractionRequest{multi-select}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `runtimeId`、`requestId`、`extensionId` | `FT-01/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `title`、`description`、`toolName`、`argumentSummary`、`externalUrl`、`submitted`、`expiresAt`、`kind`、`minSelections`、`maxSelections` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `options` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 展开：`S:InteractionRequest{multi-select}.options[]`。 |
| `S:InteractionRequest{multi-select}.options[]` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `value`、`label`、`description` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:InteractionRequest{input}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `runtimeId`、`requestId`、`extensionId` | `FT-01/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `title`、`description`、`toolName`、`argumentSummary`、`externalUrl`、`submitted`、`expiresAt`、`kind`、`placeholder`、`initialValue`、`minLength`、`maxLength`、`secret` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:InteractionRequest{questionnaire}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `runtimeId`、`requestId`、`extensionId` | `FT-01/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `title`、`description`、`toolName`、`argumentSummary`、`externalUrl`、`submitted`、`expiresAt`、`kind` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `questions` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 展开：`S:QuestionnaireQuestion`。 |
| `S:QuestionnaireQuestion` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 源码：`QuestionnaireQuestionSchema`。 |
| | `id`、`header`、`question`、`multiSelect`、`allowOther`、`allowNotes`、`secret` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `options` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 展开：`S:QuestionnaireQuestion.options[]`。 |
| `S:QuestionnaireQuestion.options[]` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `value`、`label`、`description` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:SessionAppliedState` | 默认 | `FT-01/FT-12` | 随所属提交装载，不跨代次复用。 源码：`SessionAppliedStateSchema`。 |
| | `epoch`、`seq` | `FT-12` |  |
| | `head` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:SessionBranchCursor`。 |
| `S:InteractionResponse{confirm}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `kind`、`value` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:InteractionResponse{select}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `kind`、`value` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:InteractionResponse{multi-select}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `kind`、`values` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:InteractionResponse{input}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `kind`、`value` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:InteractionResponse{questionnaire}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `kind` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `answers` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 展开：`S:QuestionnaireAnswer`。 |
| `S:QuestionnaireAnswer` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 源码：`QuestionnaireAnswerSchema`。 |
| | `id`、`values`、`other`、`notes` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:InteractionResponse{cancel}` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 |
| | `kind` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| `S:TransportFieldRow` | 默认 | `FT-01/FT-05/FT-12/FT-15/FT-16` | 显式字段计量分页；固定快照、采样统计口径与发送总数分别返回，不包含内容或凭据。 源码：`TransportFieldRowSchema`。 |
| | `backend`、`messageType`、`path`、`sampleCount`、`nonNullCount`、`meanBytes`、`p95Bytes`、`totalSampleBytes`、`ownSampleBytes`、`repeatedCount`、`repeatedBytes`、`messageCount`、`messageBytes` | `FT-01/FT-05/FT-12/FT-15/FT-16` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| | `maxBytes` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `S:ActiveNotification` | 默认 | `FT-04/FT-07/FT-12/FT-18` | 设备私有通知与引用，出现 / 结束 / 删除准确同步。 源码：`ActiveNotificationSchema`。 |
| | `code`、`severity`、`message`、`lifecycle`、`displayMs`、`createdAt`、`updatedAt`、`expiresAt` | `FT-01/FT-04/FT-10/FT-18` | 同一通知身份下保留必要正文、严重度、生命周期与有效期；终态不可合并丢失。 |
| | `occurrenceId`、`notificationId` | `FT-01` |  |
| | `scope` | `FT-01/FT-04/FT-10/FT-18` | 同一通知身份下保留必要正文、严重度、生命周期与有效期；终态不可合并丢失。 展开：`S:NotificationScope`。 |
| | `producerEpoch`、`verification` | `FT-12` |  |
| `S:CodexDesktopAttach` | 默认 | `FT-03` | 接入状态真实变化发布。 源码：`CodexDesktopAttachSchema`。 |
| | `state` | `FT-03` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:SharedSessionContent` | 默认 | `FT-01/FT-04/FT-07/FT-12/FT-13` | compact-v2 共享正文；引用与 live 增量在历史落盘及投影前完整重建，缺基准恢复。 源码：`SharedSessionContentSchema`。 |
| | `format` | `FT-01/FT-04/FT-07/FT-12/FT-13` | 同事件内准确正文 path / target；liveDelta 绑定同 session、source epoch 与已应用 baseSeq，引用不得猜测。 |
| | `references` | `FT-01/FT-04/FT-07/FT-12/FT-13` | 同事件内准确正文 path / target；liveDelta 绑定同 session、source epoch 与已应用 baseSeq，引用不得猜测。 展开：`S:SharedSessionContent.references[]`。 |
| | `liveDelta` | `FT-01/FT-04/FT-07/FT-12/FT-13` | 同事件内准确正文 path / target；liveDelta 绑定同 session、source epoch 与已应用 baseSeq，引用不得猜测。 展开：`S:StateDelta`。 |
| `S:SharedSessionContent.references[]` | 默认 | `FT-01/FT-04/FT-07/FT-12/FT-13` | compact-v2 共享正文；引用与 live 增量在历史落盘及投影前完整重建，缺基准恢复。 |
| | `path`、`target` | `FT-01/FT-04/FT-07/FT-12/FT-13` | 同事件内准确正文 path / target；liveDelta 绑定同 session、source epoch 与已应用 baseSeq，引用不得猜测。 |
| `S:StateDelta` | 默认 | `FT-01/FT-04/FT-12/FT-13` | compact-v2 的准确基准增量；所有操作先私有重建，整批校验后提交，缺口完整重读。 源码：`StateDeltaSchema`。 |
| | `baseRevision` | `FT-01/FT-04/FT-12/FT-13` | 准确 path、set 值、remove 删除或 splice 范围 / 插入项；value 与 items 使用原领域已登记的子树结构。 |
| | `operations` | `FT-01/FT-04/FT-12/FT-13` | 准确 path、set 值、remove 删除或 splice 范围 / 插入项；value 与 items 使用原领域已登记的子树结构。 展开：`S:StateDelta.operations[]{0}`、`S:StateDelta.operations[]{1}`、`S:StateDelta.operations[]{2}`、`S:StateDelta.operations[]{3}`。 |
| `S:StateDelta.operations[]{0}` | 默认 | `FT-01/FT-04/FT-12/FT-13` | compact-v2 的准确基准增量；所有操作先私有重建，整批校验后提交，缺口完整重读。 |
| | `op`、`path`、`value` | `FT-01/FT-04/FT-12/FT-13` | 准确 path、set 值、remove 删除或 splice 范围 / 插入项；value 与 items 使用原领域已登记的子树结构。 |
| `S:StateDelta.operations[]{1}` | 默认 | `FT-01/FT-04/FT-12/FT-13` | compact-v2 的准确基准增量；所有操作先私有重建，整批校验后提交，缺口完整重读。 |
| | `op`、`path` | `FT-01/FT-04/FT-12/FT-13` | 准确 path、set 值、remove 删除或 splice 范围 / 插入项；value 与 items 使用原领域已登记的子树结构。 |
| `S:StateDelta.operations[]{2}` | 默认 | `FT-01/FT-04/FT-12/FT-13` | compact-v2 的准确基准增量；所有操作先私有重建，整批校验后提交，缺口完整重读。 |
| | `op`、`path`、`index`、`deleteCount`、`items` | `FT-01/FT-04/FT-12/FT-13` | 准确 path、set 值、remove 删除或 splice 范围 / 插入项；value 与 items 使用原领域已登记的子树结构。 |
| `S:StateDelta.operations[]{3}` | 默认 | `FT-01/FT-04/FT-12/FT-13` | compact-v2 的准确基准增量；所有操作先私有重建，整批校验后提交，缺口完整重读。 |
| | `op`、`path`、`text` | `FT-01/FT-04/FT-12/FT-13` | 准确 path、set 值、remove 删除或 splice 范围 / 插入项；value 与 items 使用原领域已登记的子树结构。 |
| `S:AgentStateDomainSnapshot` | 默认 | `FT-01/FT-12` | 随所属提交装载，不跨代次复用。 源码：`AgentStateDomainSnapshotSchema`。 |
| | `domain` | `FT-01/FT-12` |  |
| | `modelEpoch`、`revision`、`availability`、`completeness`、`projectionComplete` | `FT-12` |  |
| | `source` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`S:DomainSource`。 |
| | `checkedAt` | `FT-12/FT-15` | 随有效核对 / 诊断装载，单独变化不广播整个业务域。 |
| | `value` | `FT-07/FT-12/FT-19` | 按第 3 节 scope/domain 的 32 个分支展开。 |
| | `delta` | `FT-04/FT-12/FT-13` | compact-v2 的 value 重建指令；value 为 null 占位，实际提交后推进领域版本。 展开：`S:StateDelta`。 |
| `S:DomainSource` | 默认 | `FT-01/FT-12` | 随所属提交装载，不跨代次复用。 源码：`DomainSourceSchema`。 |
| | `producer`、`sourceId` | `FT-01/FT-12` |  |
| | `sourceEpoch`、`sourceRevision` | `FT-12` |  |
| `S:HostCatalogRange` | 默认 | `FT-02/FT-05/FT-12` | 目录 / 首屏与分页兴趣驱动，版本和覆盖明确。 源码：`HostCatalogRangeSchema`。 |
| | `modelEpoch`、`revision`、`complete`、`truncated` | `FT-12` |  |
| | `snapshotId` | `FT-01` |  |
| | `offset`、`totalSessions`、`nextCursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `sessions` | `FT-02/FT-05/FT-12` |  展开：`S:AgentCatalogSession`。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:AgentCatalogSession` | 默认 | `FT-02/FT-05/FT-12` | 目录 / 首屏与分页兴趣驱动，版本和覆盖明确。 源码：`AgentCatalogSessionSchema`、`AgentSessionSummarySchema`。 |
| | `sessionId`、`agentKind` | `FT-01` |  |
| | `name`、`cwd`、`createdAt`、`modifiedAt`、`messageCount`、`hostname`、`archived`、`modelProvider` | `FT-02/FT-05/FT-12` |  |
| | `firstMessage` | `FT-02/FT-05/FT-07` | 只发标题显示所需有界预览；完整原文走聊天读取，旧格式按 FT-13。 |
| `S:DiagnosticPage` | 默认 | `FT-15/FT-16` | 全局计数 / 诊断按视图取得，相关业务结果单独及时对账。 源码：`DiagnosticPageSchema`。 |
| | `records` | `FT-15/FT-16` |  展开：`S:DiagnosticRecord`。 |
| | `nextCursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `truncated` | `FT-12` |  |
| `S:DiagnosticRecord` | 默认 | `FT-15/FT-16` | 全局计数 / 诊断按视图取得，相关业务结果单独及时对账。 源码：`DiagnosticRecordSchema`。 |
| | `recordId`、`turnId`、`scope`、`category`、`severity`、`at` | `FT-15/FT-16` |  |
| | `producerEpoch` | `FT-12` |  |
| | `hostId`、`operationId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `message` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| | `detail` | `FT-05/FT-15` | 仅诊断页，动态键为 schema 限定的短标量。 展开：`S:DiagnosticRecord.detail`。 |
| `S:DiagnosticRecord.detail` | 默认 | `FT-15/FT-16` | 全局计数 / 诊断按视图取得，相关业务结果单独及时对账。 |
| | `{*}` | `FT-15/FT-16` |  |
| `S:BrowseEntry` | 默认 | `FT-05` | 只在明确目录浏览页装载。 源码：`BrowseEntrySchema`。 |
| | `name`、`isDir`、`hasSessions` | `FT-05` |  |
| `S:V2Frame` | 默认 | `FT-14` | 按已协商传输契约完整装载和验证。 源码：`V2FrameSchema`。 |
| | `type`、`protocolVersion` | `FT-14` | 保留认证 / 路由 / 序号格式与能力校验。 |
| | `envelope` | `FT-14` |  展开：`S:EnvelopeV2`。 |
| `S:EnvelopeV2` | 默认 | `FT-14` | 按已协商传输契约完整装载和验证。 源码：`EnvelopeV2Schema`。 |
| | `v`、`ct` | `FT-14` |  |
| | `hdr` | `FT-14` |  展开：`S:RoutingHeaderV2`。 |
| `S:RoutingHeaderV2` | 默认 | `FT-14` | 按已协商传输契约完整装载和验证。 源码：`RoutingHeaderV2Schema`。 |
| | `k`、`room`、`from`、`to`、`n`、`ch`、`ik`、`mid`、`idx`、`last` | `FT-14` |  |
| `S:AgentCapabilityItem` | 默认 | `FT-02/FT-08` | 精简目录按版本缓存；大型选项独立分页。 源码：`AgentCapabilityItemSchema`。 |
| | `name` | `FT-01/FT-02/FT-08` | 精确调用名称 / 目标，保持命名空间并由 Host 校验。 |
| | `source` | `FT-02/FT-08` | 仅保留区分调用类别所需分类；不是来源版本字段。 |
| | `description`、`hint` | `FT-08` |  |
| | `argumentKind`、`argumentRequired` | `FT-07/FT-08` | 与 argument 内同义字段只保留一份。 |
| | `optionCount` | `FT-05/FT-09/FT-12` | 只用于分页总数，不能由部分页长度推断。 |
| | `argument` | `FT-02/FT-05/FT-08` | 展开 RuntimeSlashCommandArgument；选项独立版本。 |
| `S:AgentCapabilityReference` | 默认 | `FT-02/FT-08` | 精简目录按版本缓存；大型选项独立分页。 源码：`AgentCapabilityReferenceSchema`。 |
| | `name` | `FT-02/FT-08` |  |
| | `source` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 |
| | `capabilityRef` | `FT-01/FT-07/FT-08/FT-13` | compact-v1 资源引用同作用域 capabilities 精确键，复用唯一目录。 |
| `S:AgentContextState` | 默认 | `FT-03/FT-09` | 合并真实用量变化，确定性值按明确算法派生。 源码：`AgentContextStateSchema`。 |
| | `tokens`、`contextWindow` | `FT-03/FT-09` |  |
| | `percent` | `FT-03/FT-09/FT-12` | 语义一致时由 tokens/window 派生，否则保留来源百分比。 |
| `S:AgentExecutionState` | 默认 | `FT-03/FT-04` | 当前运行与子任务变化，终态及时发送。 源码：`AgentExecutionStateSchema`。 |
| | `phase`、`waitingFor` | `FT-03/FT-04` |  |
| | `retry`、`compaction` | `FT-03/FT-04` |  展开：`S:AgentActivity{1}`。 |
| | `tasks` | `FT-03/FT-04` |  展开：`S:AgentTaskInventory`。 |
| | `turn` | `FT-03/FT-04` |  展开：`S:AgentExecutionState.turn`。 |
| `S:AgentExecutionState.turn` | 默认 | `FT-03/FT-04` | 当前运行与子任务变化，终态及时发送。 |
| | `turnId`、`startedAt` | `FT-03/FT-04` |  |
| | `durationMs` | `FT-03/FT-09/FT-10` | 运行中按开始时间显示，最终耗时保留来源确认。 |
| `S:AgentInteractionItem` | 默认 | `FT-18` | 随有效问题或响应装载，库存按 ID 变化。 源码：`AgentInteractionItemSchema`。 |
| | `requestId`、`runtimeId`、`extensionId` | `FT-01/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `kind`、`title`、`description`、`toolName`、`expiresAt`、`blocking`、`submitted`、`argumentSummary`、`externalUrl`、`confirmLabel`、`cancelLabel`、`minSelections`、`maxSelections`、`placeholder`、`initialValue`、`minLength`、`maxLength`、`secret` | `FT-10/FT-18` | 有效问题 / 响应的决策字段，不能按菜单说明删除。 |
| | `options` | `FT-01/FT-18` | 按第 4 节 select / multi-select 展开 value、label、description。 |
| | `questions` | `FT-18` | 按第 4 节展开 QuestionnaireQuestion 的全部字段。 |
| `S:AgentModelState` | 默认 | `FT-02/FT-03/FT-07` | 当前选择变化发布，目录名称复用。 源码：`AgentModelStateSchema`。 |
| | `provider`、`id`、`thinkingLevel` | `FT-02/FT-03/FT-07` |  |
| | `name` | `FT-02/FT-07` | 必要名称按其事实版本复用。 |
| `S:AgentNotificationsState` | 默认 | `FT-04/FT-07/FT-12/FT-18` | 设备私有通知与引用，出现 / 结束 / 删除准确同步。 源码：`AgentNotificationsStateSchema`。 |
| | `hostEpoch`、`revision`、`complete`、`verification` | `FT-12` |  |
| | `sessionId` | `FT-01` |  |
| | `activeCount` | `FT-04/FT-07/FT-12/FT-18` |  |
| | `conditions` | `FT-04/FT-07/FT-12/FT-18` |  展开：`S:AgentNotificationsState.conditions[]`。 |
| `S:AgentNotificationsState.conditions[]` | 默认 | `FT-04/FT-07/FT-12/FT-18` | 设备私有通知与引用，出现 / 结束 / 删除准确同步。 |
| | `code` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| | `severity` | `FT-04/FT-07/FT-12/FT-18` |  |
| `S:AgentOperationItem` | 默认 | `FT-04/FT-10` | 原操作及结果按稳定 ID 核对。 源码：`AgentOperationItemSchema`。 |
| | `operationId`、`runtimeId`、`requestId` | `FT-01` |  |
| | `state`、`at`、`detail` | `FT-04/FT-10` |  |
| `S:AgentPermissionSetting` | 默认 | `FT-02/FT-03/FT-18` | 当前权限与选项分开，风险和禁用原因保持。 源码：`AgentPermissionSettingSchema`。 |
| | `id`、`label` | `FT-01/FT-02/FT-08` | 设置 / 选项模板缓存，准确值保留。 |
| | `currentValue` | `FT-03/FT-18` | 与原生设置独立核对当前选择。 |
| | `disabledReason` | `FT-03/FT-18` | 保留当前不可操作 / 风险原因。 |
| | `options` | `FT-01/FT-02/FT-08` | 设置 / 选项模板缓存，准确值保留。 展开：`S:AgentPermissionSetting.options[]`。 |
| `S:AgentPermissionSetting.options[]` | 默认 | `FT-02/FT-03/FT-18` | 当前权限与选项分开，风险和禁用原因保持。 |
| | `value`、`label` | `FT-01/FT-02/FT-08` | 设置 / 选项模板缓存，准确值保留。 |
| | `description` | `FT-08/FT-18` | 菜单选项说明省略；独立风险 / 禁用原因通过决策字段保留。 |
| `S:AgentPermissionsState` | 默认 | `FT-02/FT-03/FT-18` | 当前权限与选项分开，风险和禁用原因保持。 源码：`AgentPermissionsStateSchema`。 |
| | `sandbox`、`approvalPolicy`、`reviewer`、`networkAccess`、`profile` | `FT-02/FT-03/FT-18` |  |
| | `writableRoots`、`readableRoots` | `FT-06/FT-18` | 权限视图按需读取，确认所需完整范围必须可取得。 |
| | `problem` | `FT-03/FT-18` | 保留当前不可操作 / 风险原因。 |
| | `management` | `FT-02/FT-03/FT-18` |  展开：`S:AgentPermissionsState.management`。 |
| `S:AgentPermissionsState.management` | 默认 | `FT-02/FT-03/FT-18` | 当前权限与选项分开，风险和禁用原因保持。 |
| | `summary`、`tone` | `FT-02/FT-03/FT-18` |  |
| | `details` | `FT-06/FT-18` | 权限视图按需读取，确认所需完整范围必须可取得。 |
| | `settings` | `FT-01/FT-02/FT-08` | 设置 / 选项模板缓存，准确值保留。 展开：`S:AgentPermissionSetting`。 |
| `S:AgentStateRangePage` | 默认 | `FT-05/FT-12/FT-16` | 实际兴趣和已应用版本驱动读取。 源码：`AgentStateRangePageSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `scope`、`domain` | `FT-05/FT-12/FT-16` |  |
| | `page` | `FT-05/FT-12/FT-16` |  展开：`S:HostCatalogRange`。 |
| `S:AgentStateRangeRequest` | 默认 | `FT-05/FT-12/FT-16` | 实际兴趣和已应用版本驱动读取。 源码：`AgentStateRangeRequestSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId` | `FT-01` |  |
| | `scope`、`domain` | `FT-05/FT-12/FT-16` |  |
| | `cursor`、`limit` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| `S:AgentStateRequest` | 默认 | `FT-05/FT-12/FT-16` | 实际兴趣和已应用版本驱动读取。 源码：`AgentStateRequestSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `stateFormat` | `FT-01/FT-12/FT-13` | 显式选择 / 确认 compact-v1 或 compact-v2；表示版本隔离，旧 Host 关联拒绝后逐级降级重读。 |
| | `scope`、`domains`、`subscribe` | `FT-05/FT-12/FT-16` |  |
| | `known` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 展开：`U:agent.state.request.known[]`。 |
| `S:AgentStateSnapshot` | 默认 | `FT-03/FT-12/FT-16` | 分领域发布，已知版本不重发 value。 源码：`AgentStateSnapshotSchema`。 |
| | `type` | `FT-01/FT-13` |  |
| | `requestId`、`runtimeId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `stateFormat` | `FT-01/FT-12/FT-13` | 显式选择 / 确认 compact-v1 或 compact-v2；表示版本隔离，旧 Host 关联拒绝后逐级降级重读。 |
| | `scope`、`update` | `FT-03/FT-12/FT-16` |  |
| | `modelEpoch`、`truncated`、`unchanged` | `FT-12` |  |
| | `domains` | `FT-03/FT-12/FT-16` |  展开：`S:AgentStateDomainSnapshot`。 |
| | `missing` | `FT-12` |  展开：`H:agent.state.snapshot.missing[]`。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:DeviceKey` | 默认 | `FT-01` | 随所属对象装载准确身份，可按作用域引用。 源码：`DeviceKeySchema`。 |
| | `hostId`、`deviceId` | `FT-01` |  |
| `S:DeviceTransferItem` | 默认 | `FT-03/FT-04/FT-17` | 本设备未完成传输，进度合并且持久位置准确。 源码：`DeviceTransferItemSchema`。 |
| | `transferId`、`runtimeId` | `FT-01` |  |
| | `fileName`、`size`、`durableBytes` | `FT-01/FT-17` | 文件身份 / 范围 / 校验 / 持久位置，不能用展示进度替代。 |
| | `state`、`updatedAt` | `FT-03/FT-04/FT-17` |  |
| `S:DeviceTransfersState` | 默认 | `FT-03/FT-04/FT-17` | 本设备未完成传输，进度合并且持久位置准确。 源码：`DeviceTransfersStateSchema`。 |
| | `uploads` | `FT-03/FT-04/FT-17` |  展开：`S:DeviceTransferItem`。 |
| | `receiving` | `FT-03/FT-04/FT-17` |  |
| | `truncated` | `FT-12` |  |
| `S:HostBackendsState` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 源码：`HostBackendsStateSchema`。 |
| | `backends` | `FT-02/FT-03/FT-16` |  展开：`S:HostBackendsState.backends[]`。 |
| | `agents`、`launchableAgents` | `FT-02/FT-03/FT-16` |  |
| | `codexDesktop` | `FT-02/FT-03/FT-16` |  展开：`S:HostBackendsState.codexDesktop`。 |
| `S:HostBackendsState.backends[]` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 |
| | `kind` | `FT-01/FT-13` |  |
| | `ready` | `FT-12` |  |
| | `launchable`、`runtimeCount` | `FT-02/FT-03/FT-16` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:HostBackendsState.codexDesktop` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 |
| | `state` | `FT-02/FT-03/FT-16` |  |
| | `reason` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:HostCatalogBackend` | 默认 | `FT-02/FT-05/FT-12` | 目录 / 首屏与分页兴趣驱动，版本和覆盖明确。 源码：`HostCatalogBackendSchema`。 |
| | `kind` | `FT-01/FT-13` |  |
| | `ready`、`complete` | `FT-12` |  |
| | `sessions` | `FT-02/FT-05/FT-12` |  |
| | `elapsedMs` | `FT-12/FT-15` | 随有效核对 / 诊断装载，单独变化不广播整个业务域。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:HostCatalogState` | 默认 | `FT-02/FT-05/FT-12` | 目录 / 首屏与分页兴趣驱动，版本和覆盖明确。 源码：`HostCatalogStateSchema`。 |
| | `totalSessions`、`nextCursor` | `FT-01/FT-05/FT-12` | 范围、顺序、可信总数与边界完整保留；按字节和条数共同限流。 |
| | `truncated` | `FT-12` |  |
| | `backends` | `FT-02/FT-05/FT-12` |  展开：`S:HostCatalogBackend`。 |
| | `checkedAt` | `FT-12/FT-15` | 随有效核对 / 诊断装载，单独变化不广播整个业务域。 |
| | `sessions` | `FT-02/FT-05/FT-12` |  展开：`S:AgentCatalogSession`。 |
| | `currentProviders` | `FT-02/FT-05/FT-12` |  展开：`S:HostCatalogState.currentProviders[]`。 |
| | `snapshotId` | `FT-01` |  |
| `S:HostCatalogState.currentProviders[]` | 默认 | `FT-02/FT-05/FT-12` | 目录 / 首屏与分页兴趣驱动，版本和覆盖明确。 |
| | `agentKind` | `FT-01` |  |
| | `provider` | `FT-02/FT-05/FT-12` |  |
| `S:HostConnectionsState` | 默认 | `FT-15/FT-16` | 全局计数 / 诊断按视图取得，相关业务结果单独及时对账。 源码：`HostConnectionsStateSchema`。 |
| | `pairedDevices`、`connectedDevices`、`relayState`、`sequenceChannels` | `FT-15/FT-16` |  |
| | `paths` | `FT-15/FT-16` |  展开：`S:HostConnectionsState.paths[]`。 |
| `S:HostConnectionsState.paths[]` | 默认 | `FT-15/FT-16` | 全局计数 / 诊断按视图取得，相关业务结果单独及时对账。 |
| | `kind` | `FT-01/FT-13` |  |
| | `attachedDevices`、`activeDevices` | `FT-15/FT-16` |  |
| `S:HostDiagnosticsState` | 默认 | `FT-15/FT-16` | 全局计数 / 诊断按视图取得，相关业务结果单独及时对账。 源码：`HostDiagnosticsStateSchema`。 |
| | `records`、`dropped`、`persistFailures`、`oldestAt`、`newestAt` | `FT-15/FT-16` |  |
| | `checkedAt` | `FT-12/FT-15` | 随有效核对 / 诊断装载，单独变化不广播整个业务域。 |
| `S:HostFilesState` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 源码：`HostFilesStateSchema`。 |
| | `files` | `FT-02/FT-03/FT-16` |  展开：`S:HostFilesState.files[]`。 |
| | `truncated` | `FT-12` |  |
| `S:HostFilesState.files[]` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 |
| | `fileId`、`runtimeId` | `FT-01` |  |
| | `fileName`、`size`、`mimeType`、`sha256` | `FT-01/FT-17` | 文件身份 / 范围 / 校验 / 持久位置，不能用展示进度替代。 |
| | `availability` | `FT-12` |  |
| `S:HostIdentityState` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 源码：`HostIdentityStateSchema`。 |
| | `hostId` | `FT-01` |  |
| | `hostName` | `FT-02/FT-03/FT-16` |  |
| | `protocolVersion` | `FT-01/FT-13` |  |
| `S:HostManagementState` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 源码：`HostManagementStateSchema`。 |
| | `lifecycle`、`platform`、`nodeVersion` | `FT-02/FT-03/FT-16` |  |
| | `backends` | `FT-02/FT-03/FT-16` |  展开：`S:HostManagementState.backends[]`。 |
| `S:HostManagementState.backends[]` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 |
| | `kind`、`version` | `FT-01/FT-13` |  |
| | `installed` | `FT-02/FT-03/FT-16` |  |
| `S:HostOperationsState` | 默认 | `FT-15/FT-16` | 全局计数 / 诊断按视图取得，相关业务结果单独及时对账。 源码：`HostOperationsStateSchema`。 |
| | `activationsPending`、`commandsPending`、`retentionMs` | `FT-15/FT-16` |  |
| | `sync` | `FT-15/FT-16` |  展开：`S:HostOperationsState.sync`。 |
| | `transfers` | `FT-15/FT-16` |  展开：`S:HostOperationsState.transfers`。 |
| | `items` | `FT-15/FT-16` |  展开：`S:HostSharedOperation`。 |
| | `truncated` | `FT-12` |  |
| `S:HostOperationsState.sync` | 默认 | `FT-15/FT-16` | 全局计数 / 诊断按视图取得，相关业务结果单独及时对账。 |
| | `records`、`pending`、`active`、`reservedBytes` | `FT-15/FT-16` |  |
| `S:HostOperationsState.transfers` | 默认 | `FT-15/FT-16` | 全局计数 / 诊断按视图取得，相关业务结果单独及时对账。 |
| | `uploads`、`downloads` | `FT-15/FT-16` |  |
| `S:HostSharedOperation` | 默认 | `FT-04/FT-10` | 原操作及结果按稳定 ID 核对。 源码：`HostSharedOperationSchema`。 |
| | `operationId`、`agentKind`、`sessionId` | `FT-01` |  |
| | `kind` | `FT-01/FT-13` |  |
| | `state`、`startedAt`、`updatedAt` | `FT-04/FT-10` |  |
| `S:HostProviderAuthentication` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 源码：`HostProviderAuthenticationSchema`。 |
| | `availability` | `FT-12` |  |
| | `method`、`credentialPresent`、`bindingReady`、`verified` | `FT-02/FT-03/FT-15/FT-16` |  |
| `S:HostProviderHealth` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 源码：`HostProviderHealthSchema`。 |
| | `availability` | `FT-12` |  |
| | `circuits` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:HostProviderHealth.circuits[]`。 |
| `S:HostProviderHealth.circuits[]` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 |
| | `providerId`、`state`、`failures`、`lastSuccessAt`、`lastFailureAt` | `FT-02/FT-03/FT-15/FT-16` |  |
| `S:HostProviderRouting` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 源码：`HostProviderRoutingSchema`。 |
| | `availability` | `FT-12` |  |
| | `enabled`、`running`、`failoverEnabled`、`queue`、`activeRequests`、`lastProviderId`、`totalRequests`、`successfulRequests`、`failoverCount` | `FT-02/FT-03/FT-15/FT-16` |  |
| | `requests` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:HostProviderRouting.requests[]`。 |
| `S:HostProviderRouting.requests[]` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 |
| | `requestId` | `FT-01` |  |
| | `providerId`、`startedAt`、`routeProviderIds` | `FT-02/FT-03/FT-15/FT-16` |  |
| `S:HostProvidersState` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 源码：`HostProvidersStateSchema`。 |
| | `providers` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:HostProviderSummary`。 |
| | `checkedAt` | `FT-12/FT-15` | 随有效核对 / 诊断装载，单独变化不广播整个业务域。 |
| `S:HostProviderSummary` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 源码：`HostProviderSummarySchema`。 |
| | `agentKind` | `FT-01` |  |
| | `availability` | `FT-12` |  |
| | `profilesTruncated`、`current`、`modelProvider`、`authenticated`、`switching` | `FT-02/FT-03/FT-15/FT-16` |  |
| | `profiles` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:HostProviderSummary.profiles[]`。 |
| | `usage` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:HostProviderUsage`。 |
| | `authentication` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:HostProviderAuthentication`。 |
| | `health` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:HostProviderHealth`。 |
| | `routing` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:HostProviderRouting`。 |
| `S:HostProviderSummary.profiles[]` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 |
| | `id`、`name`、`enabled`、`globalDefault`、`mode`、`official`、`subscriptionSupported` | `FT-02/FT-03/FT-15/FT-16` |  |
| `S:HostProviderUsage` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 源码：`HostProviderUsageSchema`。 |
| | `availability` | `FT-12` |  |
| | `detail`、`updatedAt`、`attemptedAt` | `FT-02/FT-03/FT-15/FT-16` |  |
| | `rows` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:HostProviderUsage.rows[]`。 |
| | `error` | `FT-10/FT-12` | 保留必要可操作原因与原请求关联；长诊断走详情。 |
| `S:HostProviderUsage.rows[]` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 |
| | `remaining`、`used`、`total` | `FT-02/FT-03/FT-15/FT-16` |  |
| `S:HostWorkspacesState` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 源码：`HostWorkspacesStateSchema`。 |
| | `workspaces` | `FT-02/FT-03/FT-16` |  展开：`S:HostWorkspacesState.workspaces[]`。 |
| | `truncated` | `FT-12` |  |
| `S:HostWorkspacesState.workspaces[]` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 |
| | `workspaceId`、`cwd`、`sessionCount` | `FT-02/FT-03/FT-16` |  |
| | `git` | `FT-02/FT-03/FT-16` |  展开：`S:HostWorkspacesState.workspaces[].git`。 |
| `S:HostWorkspacesState.workspaces[].git` | 默认 | `FT-02/FT-03/FT-16` | 静态元数据缓存，真实变化向需要的视图发布。 |
| | `availability` | `FT-12` |  |
| | `branch`、`repoRoot` | `FT-02/FT-03/FT-16` |  |
| | `head` | `FT-01/FT-12` | 来源、已应用基准与恢复边界完整保留。 |
| `S:NotificationSnapshot` | 默认 | `FT-04/FT-07/FT-12/FT-18` | 设备私有通知与引用，出现 / 结束 / 删除准确同步。 源码：`NotificationSnapshotSchema`。 |
| | `type`、`protocolVersion` | `FT-01/FT-13` |  |
| | `hostEpoch`、`revision`、`complete`、`verification`、`removedNotificationIds` | `FT-12` |  |
| | `runtimeId`、`sessionId` | `FT-01` |  |
| | `notifications` | `FT-04/FT-07/FT-12/FT-18` |  展开：`S:ActiveNotification`。 |
| `S:SubscriptionQuota` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 源码：`SubscriptionQuotaSchema`。 |
| | `checkedAt` | `FT-12/FT-15` | 随有效核对 / 诊断装载，单独变化不广播整个业务域。 |
| | `windows` | `FT-02/FT-03/FT-15/FT-16` |  展开：`S:SubscriptionQuota.windows[]`。 |
| `S:SubscriptionQuota.windows[]` | 默认 | `FT-02/FT-03/FT-15/FT-16` | 供应商配置与状态分开，在对应视图核对并订阅。 |
| | `name`、`remainingPercent`、`resetsAt` | `FT-02/FT-03/FT-15/FT-16` |  |
| `S:ProviderResultItem` | 默认 | `FT-01/FT-02/FT-05` | 仅发送公开供应商身份与选择状态，目录按需并复用。 |
| | `id`、`name`、`enabled`、`mode`、`globalDefault`、`official`、`subscriptionSupported` | `FT-01/FT-02/FT-05` |  |
| | `kind` | `FT-01/FT-13` |  |
| `S:LanEndpoint` | 默认 | `FT-02/FT-14` | 准确主机地址与端口，用于已配对设备的认证发现。 |
| | `host`、`port` | `FT-02/FT-14` |  |
| `S:KnownCommandResult` | 默认 | `FT-01/FT-07/FT-10` | 原操作已登记的小结果，身份和编辑输入所需内容及时到达。 |
| | `provider`、`modelId`、`level`、`sessionName`、`cwd`、`isIdle` | `FT-03/FT-07/FT-10` | 保留原操作已确认值，复用对应领域，不能用旧缓存冒充结果。 |
| | `sessionId`、`runtimeId`、`leafId`、`copied`、`compacted`、`reloaded`、`shutdown`、`command` | `FT-01/FT-10` | 准确目标、位置或原操作确认结果，随原请求及时返回。 |
| | `accepted` | `FT-10` | 只表示已受理，不能据此宣布后端执行成功。 |
| | `editorText` | `FT-01/FT-07/FT-10` | 编辑原文完整取得；可复用同版本正文或自动补取，不能静默省略后回填错误原文。 |

<!-- field-rules:end -->

## 6. 分组实施与回归门槛

按下表顺序完成一组的实现与针对性回归，再进入下一组。每组使用独立场景 ID；测试用途写在对应测试源码，执行结果、首次失败和体积证据保存在 `.artifacts/field-transport-implementation-20261106/`。实现、自动验证、部署和用户验收分别登记。字段表完整覆盖由静态校验保证，行为回归按本组实际改变的契约选择。

| 组 | 字段与行为 | 本组回归门槛 |
| --- | --- | --- |
| G01 菜单投影 | FT-08：所有后端统一从 Host 出口省略命令 / 技能 / MCP 描述、参数 hint、菜单选项说明及权限设置的选项说明；保留现有格式必填字段和准确目标。 | legacy 事件与领域模型均验证，协议 18 / 19 可解码；名称、namespace、选项 value / label、树关系和输入约束不变；原生事实不被修改；审批、问题、风险和错误文案保持；隔离加密链路验证实际出口并比较字节。 |
| G02 按需核对与去重 | FT-02/03/13：模型读请求只核对需要的事实；重复目录不广播，真实变化继续发布；重连保留旧端所需恢复。 | 已知版本读取无重复菜单，原生设置 / 目录真实变化可取得；新增设备和重连仍恢复菜单与交互；并行读取没有串域或漏终态。 |
| G03 页面订阅 | FT-16：首页、聊天和各详情页按实际用途请求领域，退出页面释放兴趣，已应用版本继续对账。 | 首页只等必需领域；打开 / 关闭聊天、菜单和详情后订阅正确增减；后台交互、通知、操作结果和断线恢复正确。 |
| G04 静态与动态事实 | FT-01/02/07/09/12：identity、工作区、目录元数据与动态状态分离；确定性派生及共享引用由协商表示启用。 | 跨 Host / Session / 来源代次隔离，引用缺失自动恢复；动态变化不更新静态目录；当前模型 / provider / 权限分别核对，旧格式完整。 |
| G05 选项与目录范围 | FT-02/05/08/13：动态树 / 会话清单与稳定命令分离，按需分页、缓存、取消；调用提交精确目标，由 Host 验证执行。 | 超长树按字节分页且目标不丢；游标 / 来源失效、过期选项、同名目标和隐藏节点准确处理；两端协商与旧端整表恢复分别验证。 |
| G06 集合增量 | FT-04/12：任务、投递、交互、目录、通知、设备操作等集合使用有基准的增删改及完整恢复。 | 重复 / 缺口 / 乱序按版本处理；部分页不删除；来源换代重建；审批撤销、终态和原操作结果不丢。 |
| G07 聊天正文 | FT-04/07/12/13：entries、display、live 共享单份正文，流式输出用有效基准增量并原子交接到历史。 | 追加 / 改写 / 取消、live 落盘、乐观消息对应、压缩、阅读锚点及应用后 ACK；缺引用 / 缺增量恢复与旧表示均正确。 |
| G08 工具、diff 与文件 | FT-05/06/07/17：库存、摘要、详情和二进制内容各按范围及兴趣传输，原生工具体留在 Host。 | 工具原始内容不进入共享快照；详情版本、分页、取消和缺口可辨；diff 完整性、上传 / 下载续传与持久确认、文件校验正确。 |
| G09 管理与计量 | FT-03/05/12/15/16：provider、工作区、连接、records、诊断及管理领域按兴趣更新；记录消息 / 字段字节和发送频率。 | 普通状态刷新不扩散诊断；按需页有正确边界；计量不含正文或凭据，父子字节不重复相加；采样有界且不重序列化每个 token 的全量状态。 |
| G10 队列与通道 | FT-04/10/14/16：按业务类别限制帧和在途预算，在版本 / 加密序号形成前合并可替换状态，调度保留控制与结果。 | 慢链路和积压下控制可达；终态 / 交互 / 结果无丢失；增量基准、AEAD 序号、分片 / 重试 / 换路及公平调度正确；超时可区分排队与应用阶段。 |
| G11 会话目录读取（分组实施） | [ADR-0069 SC-01–SC-07](0069-session-catalog-and-bounded-history-loading.md)：目录 60 秒条件核对、差异 / 范围恢复、按视图分页与单份目录权威。 | 同版本确认、真实变动、来源失效聚合、查询完整性、快照分页、部分库存、旧格式及两端请求调度。 |
| G12 历史缓存窗口（已实施，待部署验收） | [ADR-0069 SH-01–SH-09](0069-session-catalog-and-bounded-history-loading.md)：首屏最多 30 条、额外自动预留最多 60 条 / 128 KiB / 4 页，按实际阅读扩窗。 | 冷缓存停止、窗口内覆盖、条数 / 字节 / 页数先到即停、滚动扩窗、分支与来源变化、落库后 ACK、背压与旧格式。 |

跨组依赖在启用前完成：G04–G08 的新字段形状依 FT-13 在 Host、Android、iOS 同时实现协商与降级；G10 只合并尚未形成版本依赖的业务对象。各组体积比较使用相同合成输入与范围，节省比例与尚未处理的大字段分别记录。

G02 的恢复依据来源确认，而非可选字段是否有值：已确认来源未提供的模型、上下文、权限及原生不支持的队列继续保持 unknown；重播不能补足的事实由其原生更新 / 读取路径取得。首次库存未确认和来源断开后保留兼容恢复；普通模型读取复用已提交事实，后端的原生核对任务继续运行。

G03 的首页完成条件是 identity / execution / interactions；关闭动作另需 capabilities 中准确的 quit 目标。兼容目录沿用该领域，G05 将大选项移为按需范围。普通聊天增加 delivery / model / context / permissions；resources、artifacts、records 及管理领域由实际读取视图持有兴趣。替换订阅使用当前兴趣集合，已释放领域的旧请求、迟到结果和缓存版本不重新建立兴趣；重新打开时复用已应用版本。Host 首页只订阅 identity / backends / catalog / providers。

G04 以只读请求的 `stateFormat: compact-v1` 明确选择新表示，响应与订阅更新带同名确认。旧 strict Host 按原 requestId 拒绝扩展后，App 仅重读该作用域，移除扩展并清空跨表示 known；未确认新表示的响应同样触发降级。身份、版本和回执继续使用原业务格式 18 / 19。

compact-v1 的 identity 只装载 `hostId/agentKind/runtimeId/sessionId/name/cwd/hostname/sessionName/sessionGraphSync`；status、历史位置、模型、思考、上下文、权限由各自领域拥有。App 将身份与已确认执行状态合并展示。Host 按新表示内容独立推进领域 revision，缓存键含 stateFormat；原生来源换代、质量变化、Host epoch 变化与作用域隔离沿用 FT-01/12。完整原生 / 兼容 metadata 仍由原权威保存。

实现与验证指针：G01 的[出口投影](../../packages/host/src/device-message-projection.ts)、[菜单字段回归](../../packages/host/src/device-message-projection.test.ts)；G02 的[来源确认](../../packages/host/src/agent-state-facts.ts)、[确认 / 恢复回归](../../packages/host/src/agent-state-facts.test.ts)、[Codex 发布](../../packages/host/src/codex-runtime.ts)及[后端回归](../../packages/host/src/codex-runtime.test.ts)。两组的实际加密出口与恢复由 [Host 联动回归](../../packages/host/src/host-service.test.ts)的 `FT-G01/FT-G02` 场景覆盖；[G01 证据](../../.artifacts/field-transport-implementation-20261106/g01-results.json)、[G02 证据](../../.artifacts/field-transport-implementation-20261106/g02-results.json)分别记录实施、自动验证、部署和用户验收状态。

G05 在 compact-v1 中把全部 tree 选项及超过 50 项或 8 KiB 的 select 选项替换为 `optionCatalog{id,count}`；小型静态选项按版本内联。目录 ID 绑定 Host / agent / session、来源代次、命令及完整内容，resources 以 `capabilityRef` 复用同作用域目录。`agent.menu.options.read/page` 只由可见选择器触发，每页最多 200 项、目标 32 KiB、上限 64 KiB，超大单项明确失败；游标绑定目录与位置，来源变化返回 catalog_changed。App 完整组装且核对计数后提交，关闭、超时及新目录使旧页失效。调用携带 `optionCatalogId`，Host 校验当前来源和精确 value 后执行；旧表示保持完整选项与原调用格式。

G05 实现与验证：[Host 目录页](../../packages/host/src/menu-option-catalogs.ts)、[分页与来源回归](../../packages/host/src/menu-option-catalogs.test.ts)、[Android 加载器](../../android/app/src/main/java/com/orbising/orbis/MenuOptionsLoader.kt)、[iOS 加载器](../../ios/Orbis/Orbis/AgentState.swift)、[加密联动](../../packages/host/src/host-service.test.ts)的 FT-G05 场景；[自动验证证据](../../.artifacts/field-transport-implementation-20261106/g05-results.json)。初次连接的旧菜单恢复仍由兼容入口发送，提前选择新表示与关闭旧恢复由 G10 处理。

G06 的 `compact-v2` 明确启用领域增量；首次读取、来源换代、不可用状态、超预算及收益不足时发送完整 value。订阅更新的 `delta.baseRevision` 必须匹配本机已提交版本；路径是准确 JSON 键序列，set 设置原领域子树、remove 显式删除对象键、splice 按准确索引更新有序数组。每批最多 256 操作、路径深度 32；value 为 null 占位，接收端先私有重建并校验全部领域，成功后一次提交与推进版本。重复或旧 revision 不重放；基准缺失、非法路径、来源或代次不同自动完整重读，现有显示保留至恢复。部分来源库存继续保持原完整性语义。App 只对关联的只读格式拒绝降级（agent：v2 → v1 → legacy；host：v2 → legacy），不跨表示复用 known。增量只在比原 value 小至少 20% 时使用；旧客户端始终取得完整领域。

G06 开放字段 `StateDeltaOperation{set}.value` 与 `{splice}.items[]` 按路径复用第 3 节对应领域及第 5 节子树字段规则，不允许未登记原生键进入出口。实现与验证：[差分契约](../../packages/protocol/src/state-delta.ts)、[订阅差分回归](../../packages/host/src/agent-state-subscriptions.test.ts)、[Android 重建](../../android/app/src/main/java/com/orbising/orbis/StateDeltas.kt)、[iOS 重建](../../ios/Orbis/Orbis/HostState.swift)及两端模型用例；FT-G06 加密联动覆盖完整基线、增量和缺口重读。证据保存于 `.artifacts/field-transport-implementation-20261106/g06-results.json`。

G07 在已选择 compact-v2 的设备上启用 `runtime.event.sharedContent`（format 为 shared-v1）；canonical、display、live 的结构和身份保留，同事件内相同且较长的 text / thinking / content / summary 字符串复用首个正文路径，重复位置暂存空串。引用数量最多 512、路径深度 32，仅在引用实际小于原正文时启用。接收端在存储解析、显示投影和应用确认之前恢复全部引用；缺失路径、空引用目标、错误类型与预算超限拒绝整条并按原同步身份恢复，不能将占位正文落盘。

liveDelta 使用同一 source epoch、session 与已应用 baseSeq 重建 live；append 只追加准确文本后缀，改写使用 set，删除 / 落盘使用显式集合编辑或完整 live。Host 与 App 的 live 缓存各限 64 个 Runtime、单项 4 MiB、总计 16 MiB；淘汰后读取完整 checkpoint。App 仅在历史事务与投影成功后推进可用缓存；Host 复用同事件的已编码差分，避免多设备编码推进第二台设备的基准。首次和恢复正文完整取得，旧客户端保持原事件，ACK 仍在实际应用或拒绝后发回。字段展开复用对应领域 / 会话既有正文规则。

G07 验证使用 [Host / Android / iOS 共用线路样本](../../ios/Orbis/Tests/Fixtures/field-transport-session.json)、[Host 正文投影](../../packages/host/src/session-wire-content.test.ts)、两端 SharedSessionContent 用例及既有来源恢复、历史事务、乐观发送、工具依赖与阅读锚点回归；FT-G07 加密联动覆盖实际 checkpoint 与流式更新。证据保存于 `.artifacts/field-transport-implementation-20261106/g07-results.json`。

G08 对 compact-v2 的 ready 来源历史 / patch 执行公开条目投影：message 的 data 只携带 message / remoteFailure；message 内保留 messageId / role / content / timestamp / toolCallId / toolName / toolSummary / isError / clientMessageId，以及原生显示语义需要的 display / stopReason / errorMessage / command / output。正文 text / thinking 块保留内容和截断质量，工具调用只保留准确身份与摘要，附件保留 RemoteArtifact；原生 signature、usage、trace 与未知块留在 Host。compaction 只保留 summary / firstKeptEntryId，branch_summary 保留 summary；custom_message 保留 display / content 及 details.remoteArtifact；其余不可显示原生条目保留图身份与空 data。各字段继续执行 FT-01/04/06/07/11/12/17，firstKeptEntryId 是准确压缩边界 FT-12，remoteFailure / stopReason / errorMessage 是必要错误 FT-10。

来源未确认或未版本化的兼容历史保留原格式；精确 session.entry.result 详情维持完整原生数据。ready 来源按既有 authoritative correction 语义替换旧缓存，不因无关原生元数据省略而改变 entryId、父子关系、时点、显示窗口和应用后 ACK。已登记命令结果继续完整传输，包含 editorText、准确会话 / Runtime / leaf 与确认值；未登记对象键仅保留 Host，必要业务新增先登记。附件 path 当前仍用于本机上传 / 下载身份匹配而保留。工具库存 / 内容、diff 和文件二进制沿用既有范围、版本、取消、持久确认与校验契约。

G08 验证：[公开条目与显示等价](../../packages/host/src/compact-entry-projection.test.ts)、FT-G08 加密联动（默认省略与显式原生详情）、工具库存 / 范围读取、diff / 文件页和上传下载续传用例；证据保存于 `.artifacts/field-transport-implementation-20261106/g08-results.json`。

G09 逐字段计量以最终 UTF-8 JSON 明文为输入：消息数和总字节逐次累计；字段采用首条及每 32 条的有界样本，低频消息至少每秒可采样一次，总扫描预算每分钟 8 MiB、单条 2 MiB、单样本最多 16,384 个节点、字段组最多 8,192。每字段报告样本出现 / 非 null 次数、包含子树的均值 / P95 / 最大 / 总字节、互不重叠的自身开销、相同内容的重复次数与字节；消息总数 / 字节与字段样本口径分别标记，不能把采样总量当完整流量。父对象大小不可与子字段大小相加，自身开销可逐层相加还原整条消息。P95 来自最多 128 个有界分布样本。

字段路径只输出协议登记键与动态键通配符，数组索引归并为 []；不输出正文、凭据、动态目标值和内容摘要，重复判断使用带进程随机盐的私有摘要。backend / 消息类别 / 发送原因和时间窗口分别统计；逐字段扫描不会再次序列化业务对象，也不写诊断日志。`transport.fields.read/page` 是显式诊断读取，每设备一次固定快照、有效期 60 秒，最多 100 行 / 页并受 64 KiB 预算约束，游标绑定设备快照；普通状态更新不附带字段报告。records 的引用仅在明确读取或仍有订阅兴趣的会话上随诊断变化核对，不将日志追加传播到全部会话。

G09 的计量报告快照全局限制为最多 8 份、合计 16,384 行；计量页自身只累计消息数和大小，避免递归采样扩大报告。消息字节表示最终 JSON 明文发送尝试；封帧、分片、重试和实际传输量由既有线路计数单独核对，不能直接把明文字节当成实际网络字节。验证指针：[字段计量](../../packages/host/src/field-traffic-meter.test.ts)、Host 诊断 / 领域用例与 FT-G09 加密联动；证据保存于 `.artifacts/field-transport-implementation-20261106/g09-results.json`。

G10 在握手发送 `device.ready` 与 `device.path` 后，为兼容菜单恢复留出默认 250 ms、有 1 秒上限的 compact 订阅建立时间；设备在目标 Runtime 上订阅 `capabilities` 后，该 Runtime 不再重播 legacy capabilities，未协商的旧客户端仍取得完整菜单。交互 `resync` 仍立即发起。队列准入必须在封帧前按 channel 和预算判定；控制 / 普通消息 / bulk / history / catchup 使用独立通道与预算，`ctl` 优先、`msg` 次之，已封帧即使队列超限也不可静默丢弃或合并。bulk 分片可在封帧前因无预算而延后，由接收端 pull 重试；路径写入失败保留队首重试，耗尽时摘除路径并在新会话恢复。控制结果、交互终态、来源 / 基准版本和正在传输的正文不得用通用队列合并替代。

G10 实现与验证：[握手兼容恢复](../../packages/host/src/host-service.ts)及 FT-G10 compact / legacy 联动回归（[Host 测试](../../packages/host/src/host-service.test.ts)）；[出站队列准入、优先级及密文帧保留](../../packages/protocol/src/outbound-mux.test.ts)；[封帧前 admission、分片、换路与恢复](../../packages/host/src/device-link.test.ts)。记录及重连结果保存于 `.artifacts/field-transport-implementation-20261106/g10-results.json`。


### FT-G12 历史窗口新增字段登记

| 消息 / 字段 | 字段规则 | 行为规则 |
| --- | --- | --- |
| `session.history.capabilities.request` 的 `type/protocolVersion/requestId` | FT-01 / FT-12 / FT-16 | ADR-0069 SH-09；每次认证连接探测一次。 |
| `session.history.capabilities` 的 `type/protocolVersion/requestId/format/maxPageBytes` | FT-01 / FT-12 / FT-16 | SH-09；匹配请求且明确 v1 / 64 KiB 后启用。 |
| `session.history.interest` 的 `type/protocolVersion/requestId/runtimeId/sessionId` | FT-01 / FT-12 / FT-16 | SH-02 / SH-06；准确可见目标或双 null，变化才发送。 |
| `session.history.interest.result` 的 `type/protocolVersion/requestId/accepted` | FT-01 / FT-10 / FT-12 | SH-06 / SH-09；相关请求回执，拒绝释放去重状态。 |
| `session.sync.historyWindow.format/maxBytes/maxDeliveries` | FT-01 / FT-12 / FT-16 | SH-01 / SH-08 / SH-09；固定范围的剩余预算，Host 校验后按旧 adapter schema 转发。 |


### FT-G11 目录查询新增字段登记

| 消息 / 字段 | 字段规则 | 行为规则 |
| --- | --- | --- |
| `session.catalog.capabilities.request` 的 `type/protocolVersion/requestId` | FT-01 / FT-12 / FT-16 | ADR-0069 SC-07；每次认证 ready 协商一次。 |
| `session.catalog.capabilities` 的 `type/protocolVersion/requestId/format` | FT-01 / FT-12 / FT-16 | SC-07；匹配 v1 能力才启用查询。 |
| `session.catalog.query` 的 `type/protocolVersion/requestId/format/cursor/limit` | FT-01 / FT-12 / FT-16 | SC-01 / SC-04 / SC-06；可见需求、固定游标、同身份重试。 |
| 请求及页应答的 `query.text/agentKind/archived/provider/directory` | FT-01 / FT-05 / FT-12 / FT-16 | SC-01 / SC-04；全库存查询，回包准确确认原过滤范围。 |
| `session.catalog.page` 的 `type/protocolVersion/requestId/format` | FT-01 / FT-12 / FT-16 | SC-04 / SC-07；msg 通道，最终 envelope 64 KiB 校验。 |
| `page.modelEpoch/revision/snapshotId/offset/totalSessions/nextCursor/complete/truncated/error` | FT-01 / FT-10 / FT-12 / FT-16 | SC-04 / SC-05 / SC-06；固定版本、覆盖和错误分别解释。 |
| `page.sessions[]` | FT-05 / FT-12 | 全部子字段沿用 Host catalog 目录字段表和 SC-05。 |
| `directoryCount/previewsComplete/page.sessions[].directoryTotal` | FT-12 | SC-01 / SC-05；同版本分组数、预览覆盖及分组会话总数，五条预览之后按准确目录需求加载。 |
| `providers/unknownProvider/providersTruncated` | FT-05 / FT-07 / FT-12 | SC-01 / SC-05；仅第一页按版本装载，后续页复用；条数与 8 KiB 预算先到即止。 |
