# ADR-0068：Host 统一子代理库存与 App 状态提示

日期：2026-11-07

Status: accepted（S33 / SC52 已实现；自动验证与部署、设备测试、用户验收分别记录，未部署、未验收）

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0062](0062-claude-background-agents-and-session-activity.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0067](0067-host-app-field-transport-rules.md)。

## Context

Claude 已有独立于主回合的后台任务库存；Codex / Desktop 与 DSH 此前主要过滤子代理会话，没有把已确认的子代理事实统一投影给 App。不同原生来源的覆盖范围不一致：协作工具完成不等于子代理完成，线程空闲或目录缺席也不能证明任务结束。App 不应解析后端日志、重复实现原生生命周期或接收完整委派描述。

## Decision

### 1. Host 负责归一化，复用现有协议

所有适配器向同一个 `execution.tasks` / execution-domain tasks 投影，公共实现负责身份去重、稳定排序、显示上限与库存合并。后端仅解释其原生身份、父子关系和状态，不增加按 Agent 分支的 App 任务模型。

沿用协议 19 的既有 schema，不新增字段、枚举或版本；协议 18 继续使用原有事件过滤与 execution-domain 降级路径。未提供可靠来源时保留未知，不用工具名称、输出文本或主回合状态合成子代理任务。

### 2. 下发内容只满足显示

| 范围 | 内容 |
| --- | --- |
| 库存 | `availability`、`items`、`truncated`；最多 256 项 |
| 任务 | `id`、可选 `parentId`、`title`、`kind`、`status` |
| 显示字符串 | 标题最多 80 个 UTF-16 代码单元，类型最多 48 个；身份不截短 |

公共投影显式构造任务字段，剥离额外原生属性。标题使用短显示名，不承载委派指令、完整描述、结果或正文；通用状态与提示文案在 App 本地生成。不发送原始 prompt、输出、原生状态对象、模型或推理配置。

### 3. 完整、部分与最后已知库存分别表达

- `ready` 且未截断：完整快照，替换库存并允许移除缺席身份。
- `unknown` 且 `truncated=true`：部分事实，更新本次已知身份并保留未见项；不声明完整覆盖。
- `unknown` 且 `truncated=false`：失联或读取失败，保留最后清单但撤回当前确定性。

到达显示上限时优先保留本次更新项。来源替换或失联后，部分恢复只确认本次重新观察到的任务，未重新核对的保留项为未知。明确的后续原生事实可以改变状态；旧历史回放不能覆盖已观察到的同一原生条目状态。

### 4. 各后端只投影可靠事实

| 后端 | 来源与边界 |
| --- | --- |
| Claude | 沿用 Mods `agent.list` 的完整库存与代次核对，复用公共合并逻辑。 |
| Codex / Desktop | 共用原生协作条目、子代理活动条目及带父身份的子线程记录；这些是部分事实。SC83 在原生祖先过滤能力已证实后核对完整后代目录。协作调用自己的完成状态不作为子代理终态。 |
| DSH Web | 使用原生目录中带 `origin=subagent` 与父身份的子会话记录；运行 / 空闲是已知线程事实，不推断完成，消失后保留为未知。 |
| Pi 或无来源后端 | 接受相同模型；没有可靠子代理清单时保持未知，不把通用工具调用当作子代理。 |

子代理不进入普通会话目录，也不被重新接管成独立交互会话；已知嵌套关系归入其主会话。Codex 历史投影遵循既有原生读取代次提交，重连、后台退出与新设备接入分别撤回或重播库存。

### 5. App 使用统一的精简提示

双端复用现有任务折叠区与稳定任务身份，显示短标题、状态和已知父子关系；首页 / 目录汇总已知活动。部分清单显示“不完整”，失联清单显示“待核对 / 最后已知”；首次未知且没有任务的空清单不显示多余告警。

主回合 phase、输入 / 停止准入与子代理活动分别表达。子代理库存不把主回合强制改为 running；未观察到任务的空库存不覆盖后端原有关闭能力。有已知任务时沿用既有库存安全检查与原生 capability 的共同准入。任务区保持只读，本次不增加子 transcript、按任务取消或模型选择操作。

2026-11-12，SC82（S33 / M06 / M10）：iOS 首页长按多选与左滑反馈独立于关闭准入。受限卡片左滑显示“暂不可关闭”与锁，达到关闭距离后回弹并按任务活动、清单不完整或状态待核对说明原因；批量关闭仅提交可关闭项，未提交项保持选中。实际关闭继续由 App 与 Host 核对。共用选择填色移至文字下方，保持卡片内容可见。实现见 [ContentView.swift](../../ios/Orbis/Orbis/ContentView.swift)、[Models.swift](../../ios/Orbis/Orbis/Models.swift)、[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift) 与 [OrbisStore.swift](../../ios/Orbis/Orbis/OrbisStore.swift)；回归见 [BackgroundTasksTests.swift](../../ios/Orbis/Tests/BackgroundTasksTests.swift)、[QuitLedgerTests.swift](../../ios/Orbis/Tests/QuitLedgerTests.swift) 和 [OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)。30 项核心测试、4 项手势 UI 测试及修正选择填色后的 4 项共用选择 UI 测试通过；文字被覆盖的首次像素断言失败与修复后截图保留在[验证记录](../../.artifacts/ios-subagent-card-gestures-20261112/verification.json)。后续 SC83／SC84 的构建、安装和验收状态见下方记录。

2026-11-12，SC83（S33）：Codex／Desktop 通过原生 `thread/list` 的互斥过滤拒绝证明祖先过滤能力，再分页读取未归档和已归档后代，核对完整父链以及两次读取的成员一致性。重连重新协商；读取期间的任务变化撤销本次结果，目录缺少已知任务时继续保留部分状态。原生 `idle`／`notLoaded` 不覆盖本次连接已确认的完成状态，活动状态与失联仍撤回终态保证。实现及易错边界见 [codex-task-registry.ts](../../packages/host/src/codex-task-registry.ts)、[codex-task-registry.test.ts](../../packages/host/src/codex-task-registry.test.ts)、[codex-agent-tasks.ts](../../packages/host/src/codex-agent-tasks.ts) 与 [codex-runtime.test.ts](../../packages/host/src/codex-runtime.test.ts)。239 项 Host 定向回归、最近发布版本 v0.1.19 的协议／合并实现互通及重连回退验证通过。新版 Host 本机安装后，指定真实会话读回 4 个 completed 子代理、`availability=ready`、`truncated=false`；读回检查未关闭会话。源码、自动验证、本机安装与待用户验收分别见[汇总](../../.artifacts/ios-session-completeness-20261112/verification.json)。

## Alternatives and consequences

不新增第二套子代理 wire 模型，不向 App 透传原生对象，也不从工具文案猜测生命周期。代价是部分来源会持续显示清单不完整，未知库存不能证明可以安全结束全部子执行；后续完整来源接入仍由适配器提供证据。收益是各后端共享恢复、边界与展示语义，传输内容受控，App 不依赖后端原生结构。

## 实现、验证与交付

- 公共模型与事实：[agent-tasks.ts](../../packages/host/src/agent-tasks.ts)、[agent-state-facts.ts](../../packages/host/src/agent-state-facts.ts)。
- 原生投影：[codex-agent-tasks.ts](../../packages/host/src/codex-agent-tasks.ts)、[codex-runtime.ts](../../packages/host/src/codex-runtime.ts)、[dsh-agent-tasks.ts](../../packages/host/src/dsh-agent-tasks.ts)、[dsh-web-discovery.ts](../../packages/host/src/dsh-web-discovery.ts)、[claude-mods-bridge.ts](../../packages/host/src/claude-mods-bridge.ts)。
- 双端模型与提示：[Models.swift](../../ios/Orbis/Orbis/Models.swift)、[AgentState.swift](../../ios/Orbis/Orbis/AgentState.swift)、[ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift)、[RemoteState.kt](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt)、[AgentModelProjection.kt](../../android/app/src/main/java/com/orbising/orbis/AgentModelProjection.kt)、[BackgroundTasks.kt](../../android/app/src/main/java/com/orbising/orbis/BackgroundTasks.kt)。
- 易错边界与判定见 [公共库存测试](../../packages/host/src/agent-tasks.test.ts)、[Host 事实测试](../../packages/host/src/agent-state-facts.test.ts)、[Codex 投影测试](../../packages/host/src/codex-agent-tasks.test.ts)、[Codex 实时 / 历史测试](../../packages/host/src/codex-runtime.test.ts)、[Desktop 测试](../../packages/host/src/codex-desktop.test.ts)、[DSH 投影测试](../../packages/host/src/dsh-agent-tasks.test.ts)、[DSH 集成测试](../../packages/host/src/dsh-web-runtime.test.ts)、[Swift 模型测试](../../ios/Orbis/Tests/BackgroundTasksTests.swift)、[Android 模型测试](../../android/app/src/test/java/com/orbising/orbis/BackgroundTasksTest.kt)。

原工作区自动验证：[349 项 Host 定向回归](../../.artifacts/unified-subagents-20261107/host-adapters-final.log)、[本次文件严格类型检查配置](../../.artifacts/unified-subagents-20261107/tsconfig.focused.json)、[20 项 Swift 模型回归](../../.artifacts/20261107-generic-subagents/mobile-swift/run.log)，以及[验证汇总](../../.artifacts/unified-subagents-20261107/verification.json)。这些结果对应执行时源码，不替代精确提交内容的复核。

精确提交树已另行隔离验证：[330 项 Host / 协议回归](../../.artifacts/unified-subagents-20261107/commit/candidate-tests.log)、完整 Host 与测试 TypeScript 检查、Swift 语法检查和仅含本次新增词条的双端目录重现均通过，见[提交验证](../../.artifacts/unified-subagents-20261107/commit/candidate-validation.json)。计数与原工作区不同，是因为排除了 26 项无关 Codex 压缩用例并额外运行 7 项协议兼容用例。全源码本地化覆盖检查发现基线既有菜单错误词条缺失，源码与该词条均不属于本次修改，保留[首次日志](../../.artifacts/unified-subagents-20261107/commit/candidate-typecheck.log)，不混入其它文案修复。

原工作区完整 Host 类型检查受并行修改的语法错误阻断，Android 定向测试在供应商页面编译阶段阻断；分别保留[首次并行阻断](../../.artifacts/unified-subagents-20261107/concurrent-typecheck-blocker.txt)与[Android 日志](../../.artifacts/unified-subagents-20261107/mobile-android/build.log)。本次提交不包含这些无关修改。设备用例只补断言、未执行；真实原生 Agent 端到端未验证，尚未打包部署，安装与视觉效果待用户验证。
