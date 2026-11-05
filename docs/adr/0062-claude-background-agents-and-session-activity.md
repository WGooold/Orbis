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

## Consequences

主回合可接收输入与后台仍有工作可以同时准确展示。代价是维护独立任务库存及未知状态，而不再用一个 busy 布尔代表全部执行。后续其他后端具备可靠任务来源时可复用同一投影与展示，仍由各自适配器定义控制能力。


## 实施与验证记录（2026-11-03）

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。
