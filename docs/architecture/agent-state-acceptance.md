# Agent 状态模型验收清单（ADR-0032）

这份清单是 [ADR-0032](../adr/0032-host-owned-agent-state-model.md) 的验收登记表：36 个状态模块逐项对应到统一模型的归属、作用域与迁移状态。ADR 要求在 Agent 子域完成后仍然保留这份登记，避免「先接了通知就宣布完整模型完成」。

作用域与版本：

- **HostState**：Host 级共享领域（`HostStateDomain`），按 `hostId` 记版本。
- **AgentState**：会话级领域（`AgentStateDomain`），按 `(hostId, agentKind, sessionId)` 记版本。
- **DeviceView**：某一配对设备的过滤视图（`DeviceStateDomain`：通知关闭、私有回执、传输任务）。它在 Registry 里是独立作用域：Host 持有，但不向其他设备广播，也不重新定义共享事实。
- **AppLocalState**：设备本地状态，**保留在 App**，不进入共享模型。

每个领域都用同一 envelope：`modelEpoch` / `revision` / `availability` / `completeness` / `source` / `checkedAt` / `value`。`modelEpoch` 与通知协议的 `hostEpoch` 是两件事，不得互相代替。

当前状态口径（第 1 批完成时）：

- `模型已定义`＝ schema 与 Registry 已存在，但**没有**接入真实来源，客户端读不到。
- `已有实现，待接入`＝该域在 Host 或 adapter 已有一份可用实现，只是还没有写进统一模型。
- `保留本地`＝ADR 已定边界，不迁移。

## 01–24：纳入 Host 统一模型

| 模块 | 目标归属 | 现状 |
| --- | --- | --- |
| 01 身份与运行元数据 | AgentState.identity / availability | 模型已定义；adapter 已有 metadata |
| 02 后端可用性与桌面接入 | HostState.backends；AgentState.availability | 模型已定义；Host 已有 readiness 聚合 |
| 03 会话目录与归档 | HostState.catalog | 模型已定义；缺逐后端完整性 |
| 04 聊天历史与 canonical Entries | AgentState.history | 模型已定义；历史仍在 source/adapter |
| 05 会话分支与当前 head | AgentState.history | 模型已定义；缺统一 displayEntries |
| 06 实时消息与流式正文 | AgentState.live.messages | 模型已定义；live 在 source adapter |
| 07 回合身份与计时 | AgentState.execution.turn | 模型已定义；分散在 source 与 App |
| 08 工具调用与执行结果 | AgentState.live.tools | 模型已定义；工具库存在 source |
| 09 运行与等待状态 | AgentState.execution | 模型已定义；DSH 缺 waiting 投影 |
| 10 重试与上下文压缩 | AgentState.execution.retry / compaction | 模型已定义；无共同字段 |
| 11 交互请求与审批 | AgentState.interactions | 模型已定义；Host 只存请求 ID |
| 12 消息队列与投递状态 | AgentState.delivery.queue | 模型已定义；真队列仍分后端 |
| 13 命令关联与执行回执 | HostState.operations；DeviceView | 模型已定义；Host 已有有界账本 |
| 14 权限摘要与可编辑设置 | AgentState.permissions | 模型已定义；已有 opaque 契约，待接入 |
| 15 模型与思考级别 | AgentState.model | 模型已定义；选项仍挂在 commands |
| 16 上下文与 tokens | AgentState.context | 模型已定义；DSH usage 未见赋值 |
| 17 能力与资源 | AgentState.capabilities / resources | 模型已定义；资源库存在各后端 |
| 18 通知生产者事实 | adapter 事实 → AgentState.notifications | 已有实现，待接入 |
| 19 Host 通知生命周期 | AgentState.notifications；DeviceView | 已有实现，待接入 |
| 20 供应商手机摘要 | HostState.providers | 已有实现，待接入；缺领域版本 |
| 21 完整配置与认证绑定 | HostState.providers | 已有实现，待接入；秘密留 Host |
| 22 用量、健康度与路由 | HostState.providers | 已有实现，待接入；手机摘要缺字段 |
| 23 诊断日志与实时记录 | HostState.diagnostics；AgentState.records | 模型已定义；缺统一记录与游标 |
| 24 文件产物与会话附件 | AgentState.artifacts；HostState.files | 模型已定义；缺 artifact inventory |

## 25–30：Host 领域服务（逐项登记，含双侧状态）

| 模块 | 目标归属 | 现状 |
| --- | --- | --- |
| 25 工作区与 Git 分支 | HostState.workspaces；AgentState.workspaceRef | 已有实现，待接入 |
| 26 会话激活与电脑侧操作 | HostState.operations | 已有实现，待接入 |
| 27 同步任务与背压 | HostState.operations | 已有实现，待接入 |
| 28 Host 身份、配对与设备 | HostState.identity / connections | 已有实现，待接入；不导出凭据 |
| 29 连接、路径、加密与序号 | **双侧**：HostState.connections 只发布摘要与传输 sequence；App 仍持有 socket / path / handshake / e2eReady / 密钥 / 重放水位（AppLocalState.transport） | 已有实现，待接入摘要 |
| 30 安装、桌面与服务生命周期 | HostState.management | 已有实现，待接入 |

模块 29 不是 Host 单方权威：Host 摘要不能代替本端握手判定，Relay 转发路径也不等于已确认的端到端可用。

## 31–36：保留在 AppLocalState

| 模块 | 保留原因 |
| --- | --- |
| 31 App 缓存、应用水位与恢复 | 反映某一设备已成功应用的版本；后端事实权威仍在来源 |
| 32 App 读取操作与请求重试 | 逻辑读取目标、反馈与网络尝试属于设备；不等于远端 running |
| 33 上传下载与持久前缀 | 手机磁盘前缀由 App 权威，Host 只确认 durable 前缀 |
| 34 App 发件箱与提交反馈 | 未确认提交必须能在源端 live 为空时独立显示 |
| 35 多 Host 连接与当前选择 | 设备侧连接与当前界面选择；每 Host 模型仍来自各自 Host |
| 36 草稿、别名、视图与偏好 | 本地编辑与展示，不是共享 Agent 事实 |

## 第 1 批（issue #5）交付与未交付

已交付：

- `packages/protocol/src/agent-state.ts`：Agent 身份（`AgentKey`）、设备身份与设备视图领域（`DeviceKey` / `DeviceStateDomain`）、操作与记录身份、Agent/Host 领域枚举、来源与领域 envelope、缺席证明规则。
- `packages/host/src/agent-state-registry.ts`：单写者 Registry——来源登记与冲突拒绝、`modelEpoch` 迟到拒绝、换代次必须完整基线、`ready`+`complete` 才允许缺席删除、部分清单合并、未知保留最后已知值、内容不变不推进版本、先提交再发布、值预算与条目上限、按已应用版本的基线读取、会话/设备作用域终结与隔离。

未交付（留给后续 ticket）：把任何真实来源写进 Registry、协议消息与版本升级、App/桌面改为模型消费者、历史 displayEntries 归一、供应商公共投影、持久诊断记录。因此本批次**不改变**任何运行时行为，也不需要重启 Host。

## 回归要求

改动 Registry 或 envelope 时必须保持：

- 未校验来源、部分清单、过期结果都不能删除有效状态；`unknown` / `unavailable` 是显式状态。
- 心跳、历史页请求与其他设备回执不推进源端内容版本。
- 提交路径里不发起原生 RPC、文件 IO 或网络探测。
- Registry 不保存全量聊天历史。
