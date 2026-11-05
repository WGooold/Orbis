# ADR-0023: Codex 原地回退与跨端历史刷新

日期：2026-10-07

2026-10-10：[ADR-0025](0025-native-history-authority-and-versioned-caches.md) 替代本文第 6、8.1 节及验收项中的同 ID 永久不可变、旧缓存冲突必须拒绝的决定。原生权威重建可以修正缓存，并通过缓存代次隔离旧数据；确定性生成、协调和客户端刷新边界保留。

Status: accepted（设计已采纳；实施分阶段进行，本 ADR 不代表全部流程已经实现）

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0021](0021-codex-terminal-host-attachment.md)、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0024](0024-recoverable-session-state-sync.md)。实施跟踪：[Issue #1](https://github.com/WGooold/Orbis/issues/1)（源端一致性）、[Issue #4](https://github.com/WGooold/Orbis/issues/4)（桌面/TUI 刷新）。桌面接入以 ADR-0022 中 2026-10-05 的 wrapper 替代决定为准。

## Context

手机对 Codex 历史执行 `/tree` 后，后端历史已经回退，但桌面 GUI 仍显示回退前的消息。反方向，桌面或 TUI 回退后，手机也可能保留旧历史，或同步时出现 `session_sync_backend_failed:canonical_entry_conflict`。

这里存在三个独立状态：app-server 持久化的 thread 历史、Orbis Codex Agent backend 的历史投影，以及 GUI/TUI 的内存 transcript。`thread/revert` 更新前两者中的权威源，不会自动让所有客户端丢弃内存画面。广播送达、文件已写入和客户端重新加载是不同的完成条件。

当前 Orbis 的 `/tree` 已调用原生 `thread/revert`，成功后通过 `thread/turns/list`（`itemsView: "full"`）重建本端历史。通知处理尚无外部 `thread/reverted` 的历史重建流程。当前重放还会参考旧内存中的 parent 和顺序；这不能证明 Host 重启后仍会生成相同 canonical Entry。

因此，本决定分别处理回退后的历史协调和客户端刷新。`canonical_entry_conflict` 表示相同 Entry ID 的表示不一致，需要独立检查 parent、type、timestamp、data 及生成顺序；归档或重开客户端不能替代这项检查。

### 已有证据与适用范围

- Codex app-server 0.160.1 的独立双客户端实验确认：订阅客户端能收到 `thread/reverted`，随后读取保留历史能得到回退后的 turns。
- 同版本源码中，`thread/revert` 关闭旧运行态、修改持久化历史并重新加载，同时保留订阅。回复中的 `turns` 为空，保留历史需另行 hydrate。这意味着再次卸载服务端运行态本身不能解决前端 transcript 的失效问题。
- TUI 的外部 `ThreadReverted` 通知不重建主 transcript；自身发起 rewind 时则另有本地截断流程。不能把自身回退的表现当作跨客户端通知的表现。
- 检查 Windows Codex 桌面版 `26.930.7945.0` 的 bundle：外部 archive 通知会移除 conversation、turn、流式缓冲和 resume 缓存；unarchive 恢复列表与元数据；重新打开 thread 进入正常 resume/hydration 流程。
- 用户已手测桌面“归档、撤销归档、重新打开”后正确显示回退历史。该结果验证当前桌面版本的可行性；完整 Orbis 自动刷新流程、TUI 自动重开及故障补偿尚未验证。

源码核对范围为 [Codex 仓库](https://github.com/openai/codex) 的 `codex-rs/app-server/src/request_processors/thread_processor.rs`、`codex-rs/tui/src/chatwidget/protocol.rs` 和 `codex-rs/tui/src/app/event_dispatch.rs`；API 语义参见 [App Server 文档](https://developers.openai.com/codex/app-server)。桌面缓存行为来自上述安装版本的 `handleThreadArchived`、conversation eviction 和 resume hook 检查，并非公开 API 对 GUI 刷新的长期保证。

## Decision

### 1. `/tree` 保持原地 revert 的语义

回退沿用原生 thread 身份与 beforeTurnId 语义。用户消息定位到其所在轮并回填输入，助手回复定位到下一轮；可见历史以原生回退后的分支为准。

### 2. 回退、历史重建、客户端刷新分别完成

原生回退、确定性历史重建和客户端重新加载分别确认，以协调代次隔离过期工作。并发原生变化进入同一核对流程。

### 3. 外部回退进入同一历史协调流程

电脑端和手机端回退共用原生历史协调入口，恢复后原子提交历史与实时状态。

### 4. TUI 通过受管理实例重开刷新

受管理 TUI 通过原实例的受控重开刷新历史，按实例归属确认启动、终止与恢复。

### 5. 桌面通过临时 archive/unarchive/open 刷新

桌面刷新使用受控的 archive / unarchive / open 生命周期，副作用前持久记录归属与恢复阶段。执行前核验范围和空闲条件，按实际阶段补偿；未知结果先查询，无法确认时保留待处理状态。

### 6. 保留 canonical Entry 契约

canonical Entry 由原生事实确定性重建，统一校验身份和图结构；原始不可变规则的版本化修订见 ADR-0025。

### 7. 按版本验证兼容方案

兼容实现以实际原生版本与能力为依据，分别取得历史读取、回退和客户端重载证据。

### 8. Codex 源端一致性是跨端同步的前置条件

ADR-0024 的 checkpoint、patch 和 running sync 只能复制 Codex adapter 已经确定的状态，不能修复源端历史重建的不确定性。因此实现顺序固定为：确定性 canonical 重建 → 每 thread 的协调代次 → 内部和外部 revert 统一入口 → checkpoint/patch → APP running sync。

#### 8.1 确定性 canonical 重建

原生 item 身份、顺序和父链决定 canonical 图。旧表示通过显式、可回滚的缓存迁移修正，并保留原始数据。

2026-10-09 实机确认：thread/resume 可生成 item-1/2/3 等合成 ID，而 thread/turns/list(itemsView=full) 返回原生 UUID。canonical 统一从 full turns 确定性重建，订阅与缓冲通知按协调代次交接；旧 rollout 仅用于原生保留 turn 骨架的兼容范围。

#### 8.2 每 thread 的协调代次和串行提交

每个 thread 使用独立协调代次和串行提交边界；异步结果提交前核对归属，回退与恢复共用这一边界。

#### 8.3 内部与外部回退使用同一个入口

内部命令与外部原生变化进入同一重建流程，原子交接历史与实时投影。

#### 8.4 与 ADR-0024 的边界

历史修正遵循 ADR-0024 的版本化恢复契约，来源事实与各客户端缓存按职责分别维护。

## 实施拆分

1. 将 replay/history projection 提取为可重复测试的确定性构建步骤，并处理旧 canonical 表示的迁移边界（Issue #1）。
2. 引入 per-thread reconcile generation，统一保护 revert、resume、attach 和历史读取的异步提交（Issue #1）。
3. 将内部 revert、外部 `thread/reverted` 和重连后的权威核对接入同一协调器（Issue #1）。
4. 在源端协调完成后，为受管理的桌面 GUI/TUI 实例实现可恢复的刷新阶段和失败补偿（Issue #4）。
5. 为 Codex adapter 提供 ADR-0024 所需的 checkpoint、live inventory、`sourceReady` 和状态版本（Issue #2）。
6. APP 完成 epoch 隔离、checkpoint/patch reducer 后，才解除 running sync guard（Issue #3）。

源端与刷新由本 ADR 管理，跨端恢复由 ADR-0024 管理；实施以 canonical 确定性与来源协调为前提。

### 2026-10-09 Windows 桌面刷新接入

手机 `/tree` 原生回退和历史协调成功后，Windows 桌面 backend 已调用刷新协调器，执行专用 `thread/archive`、`thread/unarchive`、恢复本 backend 的 `thread/resume` 订阅及 `codex://threads/<id>?hostId=local` 重开。临时归档、关闭通知和 loaded-list 缺席受到保护，不移除手机的逻辑 Session；恢复时作废并重新取得 rollout 路径。回退结果与刷新失败分开报告，刷新恢复不会再次调用 `thread/revert`。最后一轮助手回复的 no-op、外部原生回退通知均不触发自动刷新。

包装器提供带随机凭据的回环控制端点，记录本次 archive/unarchive RPC 的 pending/applied/unknown 结果及 GUI 自身请求；Host 的 journal 在副作用前落盘。Host 重连复用同一个包装器实例的操作证据，恢复订阅或未完成阶段；结果未知时只查询，不重发 archive。包装器实例变化、用户并发归档/新 turn、来源版本变化时停止自动补偿并报告待人工确认。GUI 重新读取 history/items 的响应确已交付，才确认数据重新加载；这不是像素绘制证明，单独的 resume 或协议链接成功不算 GUI hydration。

GUI 重开时的 `thread/queue/list` 是只读查询，不属于用户并发操作，也不提供历史加载完成的证据；只有实际队列修改、turn 操作及归档等生命周期修改才能使本次刷新失效。2026-10-10 修复此前把所有 `thread/queue/*` 都判为修改操作、导致桌面已重开却向 APP 误报手动归档的问题。

2026-11-03 刷新回执显示修复（V06、V12、V16–V18，验证中）：`awaiting_confirmation` 表示归档、恢复订阅及重开请求已完成，仍待 GUI 自身的历史读取证据；使用信息级条件通知“历史已回退，正在等待桌面历史加载确认”，不提示刷新失败或要求再次手动归档。收到本次操作的 hydration 证据后只清除对应通知；`recovery_pending`、`manual_required` 及异常继续保留原有恢复提示。命令回执仍只确认已完成的原生回退，不把 open / resume 或等待态当成 GUI 加载成功，不再次 revert。Host 自动用例覆盖延迟确认、确认后的精确清除及真实恢复问题；双端设备、手动与真实 GUI 门禁单独登记，未跑不得记为通过。

首版自动刷新仅支持已经核对缓存清理和本地路由的 Windows 桌面版本 `26.930.7945`、`26.1002.7124`，且目标必须没有原生派生子 threads。兼容检查使用 GUI 的 `initialize.clientInfo.version`；2026-10-09 实机确认安装包 `26.1002.7124.0` 实际上报 `26.1002.52244`，不能用安装包版本号替代协议版本，否则已验证版本也会在 archive 前被拒绝。执行前及包装器提交前分别用显式全部 sourceKinds、ancestorThreadId 查询活动和归档子树；任何派生 thread、未知状态、排队工作、审批或不兼容版本均保留已完成回退并提示手动重开，不执行自动 archive。完整 subtree 补偿和 TUI 生产 driver 仍待实现，通用协调器及 journal 不代表它们已接入。

已通过真实 Codex CLI `0.162.0` 的隔离双客户端实验：本地测试 provider 生成两轮，回退后保留一轮，GUI 协议客户端接收 archive/unarchive、重新加载 paginated turns/items，恢复完成。该实验验证实际原生协议及 driver，不替代真实桌面 GUI 画面验收。已有运行中的旧包装器需关闭后重新打开 Codex 桌面版才加载新增控制端点；Host 也需更新后重启。

## Alternatives

- 只广播 `thread/reverted`：已验证广播可送达，但当前客户端主 transcript 不因此重建。
- 只 unsubscribe/resume 或重载 app-server：订阅归属和服务端运行态不等于 GUI/TUI 的内存画面；不保证 frontend hydration。
- fork 成新 thread：改变原地回退语义和 Session 身份，属于用户显式 `/fork` 的另一项操作。
- 重启整个桌面应用或 Host：影响其他会话；本问题有目标 thread 的刷新路径。
- 清缓存、忽略 parent 差异或后到版本覆盖：违背 ADR-0013，掩盖 canonical 表示不稳定。

## Consequences

原生历史、手机视图和电脑画面的完成状态变得明确，手机回退和桌面/TUI 回退共用历史协调规则。代价是桌面刷新会短暂改变归档与导航状态，终端刷新会打断对应 TUI 的界面，因此需要可靠的实例归属、通知归并和失败补偿。

历史协调与客户端刷新沿用 ADR-0013、0021、0022 的所有权边界；同步范围与 running sync 由 ADR-0024 管理。

## Verification（未来实施验收）

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。
