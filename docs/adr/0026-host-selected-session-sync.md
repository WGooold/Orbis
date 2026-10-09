# ADR-0026：由源端选择会话同步响应

日期：2026-10-10

Status: accepted

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0008](0008-drop-backward-compatibility.md)。

## Context

聊天页进入前台及每 15 秒刷新时，都请求 `preview(maxEntries=30)`。源端选择当前分支末尾一页并附带 checkpoint，即使 APP 已经成功应用相同版本，仍重复传输完整历史和 live 正文。`knownLeafId` 仅用于 catchup；preview 不核对接收端进度。

只比较最新 Entry ID 不够：running 时正文、工具和 turn 可以变化而历史 head 不变。只比较收到的最高 seq 也不够：乱序 patch 可能尚未应用，或者数据库写入失败。轻量核对不能破坏 ADR-0024 的丢包恢复和 ADR-0025 的 epoch 权威边界。

## Decision

### 1. APP 报告已应用事实，源端决定内容

保留 `session.sync` 三个范围。preview 可携带 `knownState={epoch, seq, head}`，表示 APP 已在当前 Session 成功持久化相关 Entries，并完整应用该版本的 head/live。它不是 metadata 宣告的版本、收到的最高 seq，也不是整条历史覆盖证明。

只有 source ready、完整显示基线存在、没有待恢复缺口且历史 head 在当前 epoch 的缓存中时，APP 才发送 knownState。首次加载、进程重启尚未建立 live 基线、unknown、缓冲缺口、缓存缺失和显式重试均不提供该事实。逻辑任务创建时固定 knownState；重试不能改参数。

已经拥有可用 applied 基线时，周期核对直接请求源端，不重复读取、解密本地同一 tail；首次显示与缺口恢复仍使用现有本地优先加载。

`maxEntries=30` 继续作为页面预算，不能再当作每次必须下载的内容量。通用 Host 负责路由、关联及背压，Agent backend 使用共享选择算法确定实际范围，不新增 Host 聊天数据库。

### 2. preview 的四种明确响应

响应携带 `selection`，源端按以下规则选择：

- `unchanged`：同 epoch、同 seq、同 head，并且源端 checkpoint ready 且 head/live inventory 完整。只传版本和检查点，不传 Entries、timing 或 live 正文。它只能确认已有基线，不能建立新基线或修复缺口。
- `state`：同 epoch 的已应用 head 未变化，但 seq 增长。返回完整当前 checkpoint/live，不传旧历史。
- `delta`：同 epoch、seq 增长，已应用 head 是当前分支的祖先，缺失的连续后缀能装入一个页面。只返回该后缀及完整当前 checkpoint/live；`mode=append`。
- `snapshot`：没有可信已应用基线、epoch 变化、head 不在当前分支、源端未就绪/不完整，或者缺失后缀超过页面预算。返回有界最新 tail 与明确完整性的 checkpoint，沿用既有恢复及缺口分页机制。

缺失后缀超预算时不假报 delta 已完整补齐；恢复快照先显示最新有界范围，缺失祖先继续由现有 history/catchup 固定边界分页补齐。所有响应继续遵守 Entry 数、256 KiB 正常预算及 1 MiB 单 Entry 硬限制。history/catchup 仍只补历史缓存，不移动 head/live。

同 epoch 的历史演进必须是纯追加；已提交节点的正文、parent 或顺序修正遵守 ADR-0025，切换 epoch。否则“head 不变时只传 live”的判断无法恢复被修正的旧节点。

源端不能证明完整当前状态时，不得返回 unchanged/state/delta。尚未提供 source checkpoint 的 Pi/DSH 后端继续返回明确 snapshot；这是原生可恢复状态尚未实现的边界，不以 head 相同伪造版本一致。共享选择器可在后端具备 checkpoint 后直接使用上述决策。

### 3. 原生核对、事务和迟到响应保持有效

Codex preview 仍在规定间隔核对原生历史/运行态，然后才选择响应；不能因为客户端报告相同版本就跳过原生核对，导致桌面 revert 永久不可见。

state/delta/snapshot 仍共用持久化入口：归属、范围、source、epoch 和结构校验成功，SQLite 事务提交后，才能发布完整状态。delta 不得让未接受 epoch 的节点越过握手边界。

unchanged 必须匹配请求固定的 knownState，且当前 APP 仍在同 epoch、ready、已应用至少该版本。它只完成对应任务，不写库、不重投影、不改变滚动位置或旧历史边界。期间到达的更新 patch 保留；期间出现的版本缺口、unknown 或 epoch 切换继续恢复，不能被旧 unchanged 清除。

APP 显式重试强制完整恢复；普通周期核对允许条件响应。断线后如同一进程仍保有完整已应用基线，可以条件核对；源端重启产生新 epoch 时自动走 snapshot。响应丢失仍使用现有稳定任务 ID 和有界退避重试。

### 4. 协议与实施边界

协议升级到 11，按 ADR-0008 拒绝新旧混跑并保留更新提示。Relay 不参与选择，不读取会话语义；部署仍需独立授权。此决定替代 ADR-0013/0024 中 preview 每次固定携带有界 tail 的要求，其余权威、范围、持久化及传输约束保留。

## Verification

- 无变化时 Entries/live 正文传输为零；大 live 正文不因 unchanged 占用页面预算。
- 同 head 的正文/工具/完成变化返回 state；丢结束事件也可恢复。
- 少量纯追加只发送缺失后缀；分支改变、新 epoch、超预算、未 ready 和未知 inventory 均安全恢复。
- 未来/缺口 patch、SQLite 失败、重启未建立基线不能被报告为已应用版本。
- 请求后新 patch、缺口、回退或换会话，迟到 unchanged 不清除更新或待恢复状态。
- retry 使用固定 knownState，参数改变复用任务 ID 被 Host 拒绝。
- history/catchup、running sync 和原生 revert 核对原有测试继续通过。

### 实施与验证记录（2026-10-10）

- 已完成协议 11、共享响应选择器、Host 任务参数固定、RuntimeBridge 转发及 Android 已应用基线/事务接入。Codex 使用条件响应；Pi/DSH 当前仍返回明确 snapshot，未宣称获得相同的带宽优化。
- Windows workspace build、typecheck、lint 通过；`npm test -- --maxWorkers=2` 全量通过 85 个文件、837 项测试。覆盖相同版本确认、live 变化、纯追加、预算回退、固定重试参数及先核对 Codex 原生历史再确认 unchanged。
- Android Windows 构建完成，368 项单测通过；模拟器上 36 项真实 SQLite instrumentation 测试通过，其中 5 项验证条件响应。覆盖 unchanged 不写库、delta 事务提交、过期请求/unknown 边界拒绝写入及断链 delta 不推进版本。模拟器和构建 daemon 已关闭，占用已释放。
- 以构建后的选择器和每条 1,000 字符的合成 Entry 测量响应 JSON：30 条 snapshot 为 33,907 bytes，unchanged 为 420 bytes，空 live 的 state 为 478 bytes，3 条 delta 为 3,825 bytes。这是合成数据的序列化大小，不代表实际加密网络流量。
- 最新 App APK 与测试 APK、校验清单和设备测试日志存于 `.artifacts/app/`，构建 ID 为 `9600b73d-3bc2-45a8-bca2-337db524f2d4`。本次未替换或重启用户 Host，未 push 或部署 Relay；协议 11 需 Host/APP/Relay 协调升级后才能在用户环境生效。Codex 原生核对已通过测试桩验证，真实桌面 GUI 跨端手动验收尚待进行。
