# ADR-0043：运行中的轮次不降级 checkpoint，历史基线不能因为「本轮起点不在有界窗口里」被清空

日期：2026-10-23

Status: accepted（2026-10-23 实现；Host 单元测试 `packages/host/src/dsh-web-runtime.test.ts` 覆盖「有界 tail 不含本轮 turn/start」的 preview）

关联：[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0035](0035-incremental-session-reconcile.md)、[ADR-0040](0040-bounded-inbound-delivery.md)

## Context

2026-10-23 真机（Redmi 2407FRK8EC / `com.orbising.orbis` 0.1.51）现场：DSH 会话一旦开始输出，聊天页前面的历史整段消失，只剩本轮 live 卡片（`思考`、工具卡），顶部同时出现 `电脑端拒绝了请求 (session_sync_model_rejected)` 与 `聊天记录加载失败`；退出会话重进，历史又完整加载一次。

采样到的证据：

- logcat（`PiRemote.ReloadTrace`）：DSH 与两个 codex runtime 各自每约 2 秒发一次 `session.sync range=preview`，交替收到 `session_sync_model_rejected` 与 `session_sync_busy_or_unavailable`。
- Host 诊断日志（`C:\Users\25892\.pi-remote\diagnostics.ndjson`）：`category=recovery` 942 条 `Rejected session snapshot; source baseline required`；`category=transport.queue` 显示 `path=lan` 的非 bulk 队列积压 **259,372,506 字节 / 22,280 片**，队首帧已等待 **193,834 ms**，其中 `session.patch`（codex runtime）169MB、`capabilities` 快照 20MB。任何 `session.sync` 响应都会在 `DeviceLink.sendSessionSnapshot` 的 `message_byte_limit` 检查处被拒。
- `dumpsys meminfo`：PSS 627MB、`GL mtrack` 73MB（此时手机在 5G，Host 的 `lan` 路径已成僵尸）。

机制（代码位置）：

1. [`dsh-web-runtime.ts`](../../packages/host/src/dsh-web-runtime.ts) 的 `#followFrame` 每次 `session/follow` 快照后计算
   `complete = !session.running || currentTurnCovered`，而 `currentTurnCovered` 只看**这一页有界 tail 的 events**里有没有本轮的 `turn/start`。
   一个长轮次（现场该轮已 60+ 步、日志 3.7MB）的起点早已滚出 tail，于是 `complete=false`。
2. [`session-source.ts`](../../packages/protocol/src/session-source.ts) 的 `snapshot()` 把 `complete` 同时写进
   `checkpoint.inventoryComplete` 与 `live.complete`，并把 `source.ready` 保留为 true。
3. Host [`agent-conversation-state.ts`](../../packages/host/src/agent-conversation-state.ts) 的 `accept()` 见到 `inventoryComplete=false`
   就把 `ready` 判成 false，并把 **canonical 换成空**（`canonical = ready ? ... : { entries: [], timings: [] }`），
   `source.ready=false` 之后 `recover()` 直接拒绝服务——历史在 Host 侧也没了。
4. 手机 [`SessionSnapshotIngestion.kt`](../../android/app/src/main/java/dev/pi/remote/SessionSnapshotIngestion.kt) 的
   `contiguousSourcePatches` 要求 `patch.live.complete`，于是**运行期间任何 patch 都应用不上**；
   [`RemoteState.kt`](../../android/app/src/main/java/dev/pi/remote/RemoteState.kt) 的 `sourceReadyCheckpoint`
   同样要求 `inventoryComplete && live.complete`，于是 preview 也不投影，只把 `isChatSyncing` 置 true 并 2 秒后重发。
5. 新 epoch 的 `ready=false` 握手 patch（Host 重启、`reconcile` 判定条目被改写）会把 `messages` 清空；
   随后本该救场的 preview 在 (3)(4) 下既拿不到也不投影，画面就一直停在「只剩 live 卡片」。

ADR-0024 §已知限制 已经写下「DSH 有界历史：原生 follow tail 不保证覆盖 running turn 的起点」，
§129 也要求 `inventoryComplete=false` 时**只更新列出的对象、保留未列为 unknown**。
把整份 checkpoint 降级成非基线、把 canonical 清空，是对这条要求的违反，不是它的实现。

## Decision

### §1 有界 tail 缺本轮 `turn/start` 不影响 live 清单完整性

`#followFrame` 的成功路径固定 `setAvailability(true, true)`。理由：

- live 正文来自 `assistantStream` 的**完整前缀**（`#followFrame` 逐 chunk 重放 `attempt.stream`），不依赖 tail 是否包含 `turn/start`；
- 后续事件按 `seq` 顺序应用，出现缺口时 `#applyNativeEvent` 会把 availability 置为 false 并走 `#checkSource` 重新核对；
- `turn/start` 只提供本轮的身份与开始时间，缺它时 `live.turn` 为 null 而 `running` 由会话元数据承担，不会把历史判成空闲。

真正的未知边界仍然只由这两条路径声明：`#checkSource` 超时 / 失败（`setAvailability(false, false)`）与 `#resyncAll`（连接被替换）。
这两条路径的语义不变。

### §2 结论边界

- 本 ADR 只改「什么时候允许把 checkpoint 当基线」，**不改** `accept()` 的基线建立条件，也不改客户端的 epoch 握手规则。
- 若将来 DSH 的 follow tail 需要真的有界到无法承载 live 前缀，必须先把 live 正文改成独立预算的载荷，
  再谈把 `complete` 降级；不能靠「把基线判死」来表达「这一页不全」。

### §3 已知遗留

- Host `accept()` 在 `ready=false` 时仍会把 canonical 换成空；这次没有改，因为旧内容在 `source.ready=false` 期间不可服务，
  记录在案以免下次误判为「历史被删」。
- 僵尸路径：手机离开局域网后，Host 的 `lan` 出站队列无上限增长（本次 259MB），且选路器不会因为「队首帧等待 193 秒」判死该路径。
  这是独立问题，另开 ADR（非 bulk 队列的字节与等待预算 + 停滞路径摘除）。

## Verification

- `packages/host/src/dsh-web-runtime.test.ts` 新增用例「keeps a ready baseline when the running turn started before the bounded follow tail」：
  构造 `running=true`、tail 从轮次中间开始的 follow 快照，断言 preview 的 `live.complete`、`checkpoint.inventoryComplete` 为 true，
  `AgentConversationState.accept` 接受且 `hasBaseline` 成立。把 `setAvailability` 改回 `!session.running` 时该用例失败（实测）。
- 全量 Host 测试见本次提交记录。

