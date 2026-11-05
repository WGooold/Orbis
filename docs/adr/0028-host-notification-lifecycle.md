# ADR-0028：Host 统一通知生命周期

日期：2026-10-10

Status: accepted（协议 12 的实现已接入；验证与运行环境生效情况见第 12 节）

2026-10-13：[ADR-0032](0032-host-owned-agent-state-model.md) 决定将现有 NotificationStore 纳入统一 Agent/Host 模型，复用本文唯一通知权威、独立版本、来源恢复与设备关闭规则，不建立平行通知库存；模型整合尚待实现。

关联：[ADR-0064](0064-protocol-compatibility.md)、[ADR-0023](0023-codex-revert-and-client-refresh.md)、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0026](0026-host-selected-session-sync.md)。

## 问题与现状

APP 聊天页顶部的错误文字可能一直存在，例如 Codex 已恢复输出，`Reconnecting...` 仍未消失。检查当前实现后，这不是一个错误文案的问题，而是通知缺少身份、归属、恢复依据和可重取的当前集合：

- `runtime.error` 只有文字、`recoverable` 和可选 `commandId`。`recoverable` 不能说明正在自动重试，也不能说明何时恢复。
- APP 的单个 `runtimeError` 槽位把重试、最终失败、沙箱、配置和桌面刷新错误相互覆盖。清除其中一种错误也可能清除另一种。
- `interactionNotice` 同样混合完成、取消、超时、提交失败和渲染失败；部分结果一直留到下一次交互。
- Pi 的元数据、能力和目录读取，DSH 的恢复与目录读取，缺少按操作归属的解除事件。DSH 创建分支成功也使用错误通道。
- 只补一次解除事件不能解决断线期间漏收解除、Host 重建、APP 重开和迟到通知复活。

早期单槽位方案通过 `live.diagnostics.error` 复制 Codex 诊断。本 ADR 保留原生恢复语义，以独立通知集合替代单槽位；`live.diagnostics` 和 APP 的远端 `runtimeError` 已移除。

对本机 Codex 桌面版 `26.1002.7124.0` 的只读核对提供了专项依据：客户端区分自动重试的 `stream-error` 与最终失败的 `system-error` / `latestTurnError`，合并连续重连尝试；`model/rerouted` 投影为会话条目。这是该版本的行为证据，不是所有通知都可以按同一个倒计时清除的依据。

## 1. 职责边界

来源确认原生含义与恢复事实，Host 管理通知当前投影和同步，App 展示并提交具名操作；各层按认证归属完成职责。

| 层 | 负责 | 恢复事实由谁确认 |
| --- | --- | --- |
| Codex、Pi、DSH 适配层 | 读取原生字段；确定通知代码、身份与归属；报告当前通知集合和生命周期事实；排除过期原生回调 | 对应适配层；例如 Codex 的同回合输出、原生完成状态、沙箱 readiness、桌面刷新 operation 结果 |
| Host 通知中间层 | 验证来源与归属；幂等更新；按准确身份结束；执行明示的期限；保存当前投影；向设备同步完整集合 | 使用适配层提供的事实；Host 自己拥有的操作则由对应 Host 服务确认 |
| APP | 校验 Host 代次、通知版本和会话归属；展示多条当前通知；提交显式操作；管理手机本地任务的提示 | 不根据文字、普通 `idle`、任意新消息或本地等待时间猜测远端恢复 |
| Relay | 转发现有加密 Envelope | 不读取通知，不执行通知逻辑 |

## 2. 通知模型、身份与归属

通知使用稳定来源身份、明确归属和单调版本；生产者与受众由 Host 认证路由确定，更新与解除按准确身份执行。

| 字段 | 决定 |
| --- | --- |
| `notificationId` | Host 为一个来源身份分配的稳定通知 ID；在该次 occurrence 内保持不变，不按文案生成 |
| 来源 runtime、`producerEpoch`、来源 `revision` | runtime 来自 Host 认证路由；生产者实例代次和标准化状态版本来自 `notification.source`，Host 保存为独立 `sourceRevision` |
| `code`、`occurrenceId` | 适配层定义的稳定问题代码及本次发生身份；同一次重连尝试更新同一项，恢复后再次发生使用新 occurrence |
| 快照归属与 `scope` | 快照外层携带 `runtimeId`、`sessionId`；单项 scope 携带原生 `turnId`、`requestId`、`operationId`、`commandId`，身份绑定所属领域 |
| Host 内部 `deviceId` | 未设置表示会话共享；命令提交失败按发起设备定向。受众由 Host 认证与命令账本确定，不向来源开放自选设备字段 |
| `severity` | `info` / `warning` / `error`；按真实语义与生命周期分别表达 |
| `message` | 展示文字；不参与去重、清除或分类 |
| `lifecycle` | `condition` 或 `outcome`，见下一节 |
| `expiresAt` | 仅 outcome 可有；由 Host 从明示的展示期限计算，不依赖手机时钟决定远端状态 |
| `verification` | `confirmed` 或 `unknown`；来源断开或尚未完成重新核对时明确未知，不伪造已恢复 |
| `createdAt`、`updatedAt` | 诊断与展示排序使用，不替代来源版本 |

## 3. 生命周期与用户关闭

### 持续状态：condition

condition 表示持续情况，由来源恢复事实或完整权威集合结束；归属结束和状态替代分别记录，转换在原子批次内完成。

### 已发生结果：outcome

outcome 表示已发生结果，由 Host 管理展示期限；回合失败按回合归属保留。成功 / 取消默认 8 秒，警告 / 错误默认 30 秒，其他策略由明确产品类型定义。

### 关闭与恢复的独立状态

关闭改变该设备对该次 occurrence 的展示。源端状态、命令、交互与历史结果各自维护生命周期；新的 occurrence 重新展示。

## 4. 标准化来源接口与丢失恢复

NotificationSource 发布版本化完整集合与具名结果，接入、重连和周期核对共享恢复入口。部分状态保留未知，结果按 occurrence 有界去重。前台核对沿用 15 秒调度；来源和 Host 各保留 256 个结果回执，命令关联保留 5 分钟、上限 4096 项。

## 5. Host→APP 的独立同步协议

通知通过加密 ctl 通道按独立 Host 代次与集合版本定向同步；App 按当前认证归属应用有效基线，部分状态保留投影并继续核对。移除记录预算为 256 项，设备关闭身份预算为 64 项。

## 6. 重建、离线与资源边界

Host 维护有界当前投影，重建后重新取得认证归属与来源基线；未知来源保留待核对状态，容量超限采用原子拒绝与恢复核对。预算为每 runtime 64 项、文案 4 KiB、快照 256 KiB，Host 与手机各 2048 个 runtime，溢出身份 64 项。

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
| 电脑端完成、取消、超时 | `interaction.result`；Host 观察标准 SDK 请求终态，电脑端完成 / 取消 8 秒、超时 30 秒，重复终态不续期。App 完成（`source=remote`）按 ADR-0049 §6.5 仅保留原位摘要，不生成共享完成横幅；仍消费请求终态身份并转发事件 | Host 加密链路回归覆盖远端成功无横幅、本地完成 / 取消 / 超时各一条、重复终态与重取；双端设备门禁待验收 |
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
| 通用命令失败、协议 / 版本错误 | 带 commandId 的结果定向归位；协议、版本、认证错误继续使用连接层可确认提示 | 已接入命令账本；无 commandId 的旧 runtime.error 仅日志记录 |
| 工具执行失败、消息失败、队列拒绝、传输失败结果 | 保留各自历史行 / 任务结果，通知关闭或过期不改变执行结果 | 原状态路径保留；本次不将失败标为成功、不隐式提交审批 |

通知来源统一维护完整生命周期、恢复依据与可观察结果，接入和验收范围以对应证据为准。

## 8. 单一通知入口与协议演进

展示由通知集合统一驱动，命令和同步失败按原任务定向返回；协议迁移保持已部署端兼容，开发、部署与生效分别记录。

## 9. 实施顺序与完成标准

按共享模型、来源适配与客户端投影完成纵向接入，结合覆盖表验证身份、生命周期与恢复；完成状态以实现和验收证据为准。

## 10. 验证矩阵

[根部测试约束](../../AGENTS.md#测试)；[notification-store.test.ts](../../packages/host/src/notification-store.test.ts)；[NotificationsTests.swift](../../ios/Orbis/Tests/NotificationsTests.swift)。

## 11. 取舍

拒绝“全部通知 N 秒后消失”：它会隐藏尚未恢复的条件，并把手机时间当成远端状态。期限仅用于已发生结果。

拒绝“每个页面 handler 各写 clear”：它仍然缺少独立身份、来源对账和断线恢复，也无法隔离同时发生的问题。

拒绝“Host 用文案或普通运行状态猜恢复”：它越过 backend 的原生语义边界，并会让其他操作的成功误清当前故障。

拒绝同时保留 `live.diagnostics` 和通知中间层两套权威。独立通知快照增加一条小型同步流，但使通知恢复不依赖正文历史、源端 seq 或 APP 入库成功；首版完整集合与有界内存状态控制实现和恢复复杂度。

## 12. 实施与验证记录

[根部测试约束](../../AGENTS.md#测试)；[notification-store.test.ts](../../packages/host/src/notification-store.test.ts)；[NotificationsTests.swift](../../ios/Orbis/Tests/NotificationsTests.swift)。
