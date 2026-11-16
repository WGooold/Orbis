# ADR-0062：Claude 后台子任务与主会话活动

日期：2026-11-03

Status: accepted（Host、Mod 与双端已接入；设备与真实原生联动门禁未完成，尚未验收）

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)、[ADR-0058](0058-shared-interaction-motion.md)。新增 S26；修订 S17–S20、V05、V12、V16–V18，关联 M03、M06、M10、M20、V01–V03、V21。回归 R61，动效 SC45 / MOT-24。

## Context

故障现象：Claude 子代理进入 App 普通会话列表、无法关闭，并且持续输出却显示空闲。Claude 可以在主回合已结束、composer 可接收下一次输入时继续运行后台子代理；因此仅过滤独立卡片或把主回合强制改成 running 都不完整。

当前插件只将无 agentId 的 turn.start / turn.complete 投影为主回合，工具事件却没有保留子代理归属；实时 hello 也没有区分交互 TUI 与非交互执行。Codex / Codex Desktop 与 DeepSeek 已在目录和实时发现排除内部子代理，这个可见会话边界可沿用，执行状态采集不能照搬。

2026-11-03 核对官方 [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)、[生成类型说明](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build)及本机 Claude Code 2.1.317 的公开生成声明：`$.agent.list()` 返回本 Session 的子代理 / teammate，字段包括 id、description、type、status、parentId；状态有 pending / running / waiting / idle / completed / failed / killed。spawn 不是完整生命周期，恢复已有子代理不一定再触发它。独立终端 pane 的 teammate 状态来自 roster，进程消失可能不刷新，不能据此证明仍在运行或已经终止。API 核对不是原生端到端验收。

## Decision

### 1. 三类事实分开

主回合 phase、子任务库存与会话展示分别表达事实，输入由主回合和能力准入，汇总状态由已确认库存派生。后台能力按实际 Host / Mod 支持发布，协议兼容按 ADR-0064。

任务库存包含 availability、items 与 truncated，以 Host / Session / bridge generation / task id 归属；插件 0.1.6 / bridge 4 使用 agent.list。

参考：[ADR-0064](0064-protocol-compatibility.md)。

### 2. 采集、恢复与身份

agent.list 提供完整库存，按会话和代次串行核对，内容变化驱动发布；失败保留上次清单并声明未知。普通 Runtime 对应交互会话，子执行与 Hook 审批按原生身份归属。

### 3. 双端展示

首页和目录汇总主会话活动，聊天通过紧凑子任务区呈现稳定任务身份与已知父子关系。展示复用共用材质、折叠和降级机制，后台更新维护阅读与输入状态。首版提供任务状态，只读子 transcript 能力尚未实现。

### 4. 控制范围与关闭

控制按原生已验证范围发布，主回合发送与停止遵循自身 phase。关闭能力由完整任务库存和进程身份核验决定，App 按当前能力启用入口，Host 最终核对。首版任务只读，按 task id 取消的完整回执尚未验证。

### 5. 验证与交付边界

原生联动、Host 适配与双端展示分别记录验证状态，沿用根部测试规则。实现、设备门禁、人工验收和部署各自保留证据。

证据：[后台任务回归](../../.artifacts/ui-regression/20261103-claude-background-agents/)。

## 2026-11-07 跨 Agent 统一（S33 / SC52）

跨 Agent 的共同模型、精简字段、部分 / 失联库存与双端提示见 [ADR-0068](0068-unified-subagent-inventory-and-app-hints.md)（S33 / SC52）。Claude 的原生采集、进程身份与完整库存规则继续沿用本 ADR；原生联动和用户验收状态分别保留。

## 2026-11-16 后台命令与监听（S60 / SC108）

`agent.list` 只含子代理与 teammate；后台 Bash、Monitor、workflow 不在其中，Claude Code 2.1.325 的 Mods 也没有可随时读取的任务清单（`background_tasks_changed` / `get_task_output` 属 SDK 控制协议，TUI 插件不可用）。协议与 schema 不变：这类任务作为 `execution.tasks` 的普通条目下发，`kind` 为 `shell`、`monitor` 或原生类型名。

- 插件 0.1.12 维护本会话的后台工作账本，与 `agent.list` 合并后仍由唯一的 `tasks.snapshot` 发送；同一 id 以 `agent.list` 为准，原生清单中的 `subagent` 条目不进入账本。
- 原生事实：Bash 结果记录的 `backgroundTaskId`（含 Ctrl+B 与超时转后台）、Monitor 结果的 `taskId` 加入运行中条目；TaskStop 结果的 `task_id` 标记已停止；`Stop` / `SubagentStop` 输入的 `background_tasks` 为本会话完整在途清单，到达时替换账本，已结束任务由此移除。任务通知行没有结构化状态，不解析其文本。
- 标题取工具的 `description`，不下发命令行；未传描述时原生清单的 `description` 回退为完整命令（含其中的凭据），此时保留已知标题或留空。子代理发起的任务以其 agentId 作父身份。原生状态不在既有枚举内时记为 `unknown`。
- Stop 输入缺少 `background_tasks` 的 Claude Code 不上报后台命令，避免无法结束的条目永久阻止关闭。
- 关闭准入不变：清单中有运行中的后台命令或监听时不允许远程关闭；远程关闭会结束 Claude 进程及其后台命令。
- 双端呈现区分两类：`kind` 为 `shell` / `monitor` 的是后台命令，其余为子代理。任务区标题按类别计数（仅一类时为“子代理 N 项”或“后台命令 N 项”），两类并存时展开区先列子代理、再列主会话的后台命令，并显示分组名；子代理发起的命令挂在该子代理下。类型标签本地化为“命令 / 监听”，不重复标题。只剩后台命令在运行时，会话状态为静止状态点与“空闲 · N 个后台命令”，跳动的工作中状态只表示主回合或子代理；Android 任务行的状态点同样只对子代理跳动。清单不完整、待核对与关闭限制等跨类别提示使用“后台任务”。
- 已知边界：任务结束到下一次 Stop 之间仍显示运行中；Claude 会为任务通知开启新回合，通常随之核对。通知回合被中断时，状态保留到下一回合结束。

原生行为以本机 Claude Code 2.1.325 一次性非交互会话核对（隔离目录、合成任务，不连接 Host），记录见 `.artifacts/claude-background-shells-20261116/`。实现见 [register.ts](../../packages/claude-mod/src/register.ts)、[Models.swift](../../ios/Orbis/Orbis/Models.swift)、[ChatComposerView.swift](../../ios/Orbis/Orbis/ChatComposerView.swift)、[RemoteState.kt](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt) 与 [BackgroundTasks.kt](../../android/app/src/main/java/com/orbising/orbis/BackgroundTasks.kt)，回归见 [background-work.test.ts](../../packages/claude-mod/tests/background-work.test.ts)、[BackgroundTasksTests.swift](../../ios/Orbis/Tests/BackgroundTasksTests.swift)、[BackgroundTasksTest.kt](../../android/app/src/test/java/com/orbising/orbis/BackgroundTasksTest.kt)。交互 TUI 联动、设备验证与用户验收分别记录，尚未完成。

## Consequences

主回合可接收输入与后台仍有工作可以同时准确展示。代价是维护独立任务库存及未知状态，而不再用一个 busy 布尔代表全部执行。后续其他后端具备可靠任务来源时可复用同一投影与展示，仍由各自适配器定义控制能力。


## 实施与验证记录（2026-11-03）

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。
