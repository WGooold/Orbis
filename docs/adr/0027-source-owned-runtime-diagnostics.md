# ADR-0027：源端拥有聊天诊断的生命周期

日期：2026-10-10

Status: accepted

后续统一方案见 [ADR-0028：Host 统一通知生命周期](0028-host-notification-lifecycle.md)（proposed）。本 ADR 记录 Codex 单条诊断的专项方案；ADR-0028 采纳并完成适配后，将以独立通知集合替代本文的 `live.diagnostics.error` 传输，保留原生恢复语义与回合归属要求。当前不得据此宣称各后端通知已完成统一适配。

关联：[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0026](0026-host-selected-session-sync.md)。

## 问题

Codex 的 `error` 通知同时承载自动重试提示与最终失败，原生字段 `willRetry` 和 `turnId` 标明二者的语义及所属回合。Orbis 原先只发送错误文字，APP 将它存成 `runtimeError`，仅通过旧 `turn.started` 清除。启用源端复制后该生命周期事件不能绕过版本门槛，因此成功恢复输出或后续回合也可能一直显示 `Reconnecting...`。

对本机 Codex 桌面版 `26.1002.7124.0` 的只读核对确认：客户端保留原生 `willRetry` 与回合归属，将重试错误投影为 `stream-error`，连续重连尝试更新同一展示项；只有 `willRetry=false` 才进入 `latestTurnError` 与 `system-error`。这证明重连提示不应被当作永久失败。APP 顶部提示仍沿用现有展示位置。

## 决定

诊断属于 Agent backend 的当前 Session 状态。`live.diagnostics` 表示源端拥有诊断；它的 `error` 明确为对象或 `null`。对象携带 `message`、`willRetry` 和可选原生 `turnId`。未提供 `diagnostics` 表示该源端不拥有诊断复制，例如尚未实现源端复制的后端；这不是按对端版本协商的降级路径。

Codex backend 每次诊断变化都推进源端版本，并通过与正文相同的 `session.patch` 和 checkpoint 发送完整诊断状态：

- 自动重试保持最新尝试提示；同一回合恢复助手正文或开始后续非用户 item 时清除。
- 回合成功完成或被打断时清除重试提示；最终失败替换重试提示，并保留到下一回合开始。
- 新回合开始或原生历史核对确认回合已切换时清除旧回合诊断；核对发现漏收的最终失败时恢复该失败。
- 其他回合的迟到报错或输出不能替换或清除当前回合诊断；用量、目录与普通运行状态刷新不证明重试已恢复。
- Windows 沙箱修复成功通过相同状态通道清除诊断。

APP 在应用源端状态的同一版本门槛内更新顶部提示。明确的 `null` 清除；未知、缺口与旧版本不能提前清除，历史分页不能改写当前诊断。建立诊断复制归属后，无命令关联的旧 `runtime.error` 通知不能再次覆盖版本化状态。关联 `session.sync` 的失败继续由独立同步任务错误处理。

不使用 APP 本地倒计时猜测错误何时失效。清除通知丢失时，后续 checkpoint 或状态核对恢复相同结果。

## 验证

Host 单测覆盖重连尝试更新、正文及 item 恢复、成功与打断、同文字从重试变为最终失败、迟到回合与原生历史恢复。APP reducer 单测覆盖 runtime 隔离、源端版本缺口与旧 patch、checkpoint 清除，以及迟到的无版本报错不能复活已清除提示。
