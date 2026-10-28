# Claude Code 接入 ticket 草稿

这些条目对应 [ADR-0033](../adr/0033-claude-code-tui-mods-integration.md) 的实施拆分。仓库规定 GitHub Issues 是 canonical tracker；本文件只保存创建远程 Issue 前的本地草稿，不包含凭据、设备身份或未脱敏日志。

## CC-01：安装、认证和版本握手

**Expected behavior**

已加载 Orbis bridge 的 Claude Code 官方 TUI 能向 Host 报告 Claude 版本、bridge 版本、原生 Session 身份、连接代次和已验证能力。Host 只接受当前本机认证通道，版本或能力不满足时报告明确原因。

**Actual behavior**

当前已实现 Mods loopback 的 `hello`/`poll`/`event` 入口、Hook runtime 注册以及 `claude:<session_id>` runtime 身份。握手会校验 bridge 版本、Claude 最低版本、实例/session 身份和必需能力，并为每次握手生成 generation；仍没有 bridge 安装/升级流程。

**Reproducible example**

在 Claude Code v2.1.310 中加载 bridge，调用认证的 `POST /v1/claude/mods/hello`，Host 返回 runtimeId、generation 和能力集合；低版本、错误 bridge 版本、缺失能力和错误 payload 会被拒绝。

**Acceptance criteria**

- bridge 启动时完成认证握手并报告实例身份、版本和 generation。
- Host 对版本不足、认证失败、mod 禁用和能力缺失分别返回稳定错误。
- reload、重连或 Session 切换会产生新 generation；旧 generation 的命令不会作用于新实例。
- v2.1.310 真实 TUI、插件校验和目标构建类型声明均有记录。

**Evidence and boundary**

ADR-0033 §2、§5；`ClaudeModsBridge`、loopback 和插件校验已通过，v2.1.310 真实 TUI 已验证 Mods 加载及运行，但安装/升级流程和最低版本 v2.1.287 实测仍未完成。

## CC-02：PermissionRequest 与 AskUserQuestion 生命周期

**Expected behavior**

工具审批和 `AskUserQuestion` 由同一个 Hook 请求进入 Host，手机回答后以 Claude 官方结构化 Hook 输出返回给原生调用。并发、超时、取消、Host 断开、重连、本地/远程竞答和重复回答都产生可核对的最终状态。

**Actual behavior**

Host 已实现 `/v1/claude/hook`、`PermissionRequest` 的 `allow/deny`、`PreToolUse` 的 `updatedInput.answers` 及 fail-closed 超时/断开处理。`allowNotes` 输入会显式拒绝，因为当前 Claude Hook 输出没有对应的 notes 字段。真实 TUI 闭环尚未验收。

**Reproducible example**

向 `/v1/claude/hook` 提交 `PermissionRequest` 或 `AskUserQuestion` JSON；Host 会发出 `interaction.requested`，再用 `interaction.respond` 返回结构化结果。`allowNotes: true` 的问题返回 `invalid_hook`。

**Acceptance criteria**

- 同一请求只能由仍有效的原生 Hook 调用接受一次；重复回答返回 `already_delivered`，过期、取消、冲突和旧 generation 有明确失败码。
- 权限请求返回 Claude `PermissionRequest` 的 `allow/deny`；问卷返回 `PreToolUse` 的 `updatedInput.questions` 与 `answers`。
- 不使用键盘输入、屏幕抓取或默认批准。
- 在 v2.1.310 真实 TUI 中验证本地回答、手机回答、竞答、超时、断开和迟到回答的原生最终结果。

**Evidence and boundary**

官方 Hooks 文档契约已记录在 ADR-0033 §4；当前 bridge 和 Host 测试通过，真实 TUI Hook 消费闭环仍是未验证边界。

## CC-03：消息、回合和工具事件归一化

**Expected behavior**

电脑 TUI 和手机产生的用户消息、assistant 流式内容、工具调用、工具结果、回合开始/结束和错误都进入统一 RuntimeEvent，并保留稳定消息、工具和回合身份。

**Actual behavior**

当前 Mods bridge 已归一化 `session.append`、回合开始/结束、流式 text/thinking、工具开始/结束和 runtime status；Hook 交互事件也进入统一 RuntimeEvent。历史基线、模型主动工具调用和完整 source sync 仍未实现。

**Reproducible example**

在 v2.1.310 TUI 中提交一个会调用工具的 prompt；当前 Host 可接收 Mods 事件，但本轮真实供应商测试没有完成模型主动工具调用闭环。

**Acceptance criteria**

- 文本、thinking、tool call 和 tool result 映射到统一事件，live 内容到 canonical 内容不重复。
- 工具事件保留原生调用身份并能与对应审批请求关联。
- 事件外发有界、断线可恢复，溢出明确报告 gap。
- 至少完成一个真实工具调用和中途加入流式回合的 v2.1.310 验收。

**Evidence and boundary**

ADR-0033 §3、§5；当前 Mods 探针验证了提交消息、观察回合和停止，但模型主动工具调用与完整事件同步未通过验收。

## CC-04：Host 状态模型和 App 投影

**Expected behavior**

Claude runtime 通过 Agent Registry、版本化 Session sync、displayEntries、capabilities 和 interaction snapshot 对手机呈现，App 不解析 Claude 原生 payload。

**Actual behavior**

当前 Claude backend 能提供 runtime metadata 和交互事件，但 `catalog`、历史、capabilities、snapshot/reconnect 和完整 provider 状态仍为空或未实现。

**Reproducible example**

bridge 注册后 Host agents 快照可见 `claude` backend；断开后重新连接不能恢复已有 Claude 历史或当前回合基线。

**Acceptance criteria**

- Claude runtime 使用统一 AgentKey 和 Session source epoch。
- reconnect、mod reload、`/clear`、`/resume`、压缩和 Session 切换都先重取基线再接收增量。
- 缺失 parent/head 或有界历史读取明确标记 unknown，不报告为完整历史。
- 多 TUI、同 cwd、多设备和多 Host 的 runtime、事件和交互隔离。

**Evidence and boundary**

ADR-0032、ADR-0033 §6；当前只完成在线目录条目和交互事件。

## CC-05：Claude 消息、停止和命令回执

**Expected behavior**

手机消息和停止命令作用于已连接的同一 Claude TUI 实例；Host 以原生接受、开始、完成或停止事实确认命令，不以发送成功或连接断开推断结果。

**Actual behavior**

当前 Claude backend 已处理 `interaction.respond`、通过 Mods `$.prompt.submit` 的 follow-up `user_message` 和通过 `$.turn.abort` 的 `stop`。消息与停止先返回 `pending` 或明确不可执行结果，最终消息/回合事实由 Mods 原生事件确认；steer、附件和 `user_message.cancel` 明确不支持。交互回答的 unknown、stale、conflict 已改为在线 runtime 上的 `command.result` 失败回执。

**Reproducible example**

向已完成握手的 `claude:<session_id>` 发送 follow-up `user_message` 或正在运行回合的 `stop` 会得到 `pending`，随后等待原生 `command.result` 或 `turn.complete`；向不支持 steer/附件的消息、无活动回合的 stop 或已结束交互发送命令会得到明确失败回执。

**Acceptance criteria**

- 以经过版本和能力握手确认的 Mods API 实现消息提交和停止。
- 回执区分 accepted、started、completed、cancelled、not_cancelable、unknown。
- 停止范围（当前工具、子任务和排队 prompt）在目标版本上有实测证据。
- 原生 TUI 不因 Host 断开而结束执行。

**Evidence and boundary**

ADR-0033 §3；Host backend、Mods bridge 单元测试和 v2.1.310 探针已覆盖提交、等待 idle 排队、主回合停止和原生完成确认；真实 Host/App 联动、工具/子任务/队列停止范围和命令重连恢复仍未验收。

## CC-06：历史、reload、reconnect 和 generation

**Expected behavior**

Host 重建或 bridge reload 后能确认同一原生 Session，恢复有界历史和当前 live 状态；旧代次命令和回调不会写入新 Session。

**Actual behavior**

当前 bridge generation 只在进程实例内生成，Hook pending 请求支持 stale generation 判断；没有 Claude 原生历史游标、parent/head、reload 或 reconnect 基线协议。

**Reproducible example**

在存在 pending Hook 时 reload bridge 或切换 `/resume`，当前实现只能关闭旧 pending 请求，不能恢复新的 Session 状态。

**Acceptance criteria**

- 记录 Session identity、generation、source cursor、head completeness 和 live completeness。
- reconnect/reload 后旧回调 fail-closed，新 Session 必须先完成基线。
- `/clear`、`/resume`、分支和压缩后的身份与历史边界均有 v2.1.310 证据。

**Evidence and boundary**

ADR-0033 §3、§5；当前仅有 pending 生命周期和 generation 单元测试。

## CC-07：v2.1.310 真实 TUI 验收

**Expected behavior**

在用户当前供应商配置下，隔离的 Claude Code v2.1.310 官方 TUI 完成消息、回合、工具、审批、问卷、停止、重连和 reload 验收，并保存可复核的脱敏结果。

**Actual behavior**

当前验证报告覆盖 Mods 加载、消息提交、回合观察、停止、基础 clear/resume 和 idle reload；模型主动工具调用、原生交互回答及完整历史恢复尚未通过。

**Reproducible example**

按 `spikes/claude-mods-validation/README.md` 的探针步骤运行 v2.1.310，并逐项记录成功、失败和未验证项目。

**Acceptance criteria**

- 目标版本、供应商配置、bridge 类型声明、插件校验命令和测试结果可复现。
- 每个 ADR-0033 §3/§4 验收项有成功证据或明确缺口。
- 未通过的能力不会在 Host/App 中标记为 ready。

**Evidence and boundary**

验证报告位于 [`spikes/claude-mods-validation/README.md`](../../spikes/claude-mods-validation/README.md)。

## CC-08：最低版本和兼容性清单

**Expected behavior**

Host 发布包明确支持的 Claude Code 版本、bridge 版本和能力集合；升级后若 API、类型或事件契约改变，会阻止错误兼容并给出迁移原因。

**Actual behavior**

ADR-0033 将 CLI/TUI 最低目标设为 v2.1.287，当前仅按用户要求验证 v2.1.310；没有自动生成的版本能力清单和升级检查。

**Reproducible example**

用低于 v2.1.287 的 CLI 或未来不兼容的类型声明加载 bridge，当前没有握手层阻止并报告具体缺口。

**Acceptance criteria**

- 最低版本、已验证版本、生成类型声明、插件校验和已验证能力逐版本记录。
- 版本不足、API 缺失和类型不匹配均 fail-closed。
- 发布说明不把 `>=2.1.287` 宣称为所有未来版本的无条件兼容。

**Evidence and boundary**

ADR-0033 §2；当前 v2.1.310 验证报告是唯一目标版本证据。
