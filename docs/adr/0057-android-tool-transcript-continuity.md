# ADR-0057：Android 工具结果乱序时的会话连续性与原子交接

日期：2026-11-01

Status: implemented（Android 修复与专项验证完成；完整 UI 回归门禁及真机验收未完成，不能记为全量验收通过）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) 的 V20、V09、V01–V04、V18；[流式呈现与阅读规则](0046-mobile-ui-stability-and-material.md)；[UI 回归方案](../../AGENTS.md#测试) 的 UI-02、R03 / R04、A1–A4。

## Context

Android 的 Pi 会话会短暂只剩一条工具消息，顶部仍有“加载更多消息”，随后整段记录再次出现。隔离 Host 的真实输出和可控设备回放确认了两条相关路径：

1. 工具结果先于调用它的助手条目到达，结果的父链暂时不完整。原有 `isWaitingForParent(oldLeaf, newLeaf)` 在第一份更新中保留旧画面，但同时推进 `sourceHeadLeafId`。第二份相同 head 更新或其后继条目再以这个源端 head 判断时，会绕过保护并发布孤立结果。可控设备回放中列表从 17 行降至 1 行。
2. 原保护只保留 canonical 行，仍提前移除了尚未完成交接的实时正文和工具行。真实 Pi 六次工具调用中出现 11→9、13→11 的回落，约两帧后恢复。中间修复又暴露出另一种时序：catchup 补齐父条目时先发布 canonical 行并保留实时副本，下一次 checkpoint 再删掉副本，造成先重复、后收缩。

这些证据解释了本次闪屏；没有据此得出 Pi 比 Codex 调用工具更频繁的结论。工具频率也不能作为修复条件。顶部历史入口本身仍遵守 V04，需修复的是会话投影被截断与交接非原子的问题。

## Decision

### 1. 源端进度与显示分支分别记录

在 Android `RuntimeConversation` 中增加 `retainedProjectionLeafId`，记录因缺父而保留的实际显示分支。`sourceHeadLeafId`、源序号和 epoch 继续表示已接收的源端事实，不能以它们前移来证明画面已经完成交接。

判断连续性时使用 `retainedProjectionLeafId ?: sourceHeadLeafId`。重复 head、后继条目、恢复 checkpoint 和后续历史合并必须相对被保留的显示锚点判断，直到确认新分支可完整接续或发生有依据的分支切换。

### 2. 缺父时保留已显示内容，状态事实继续更新

同一源 epoch 内，新 head 因缺父无法连接显示分支时，保留已经显示的 canonical 行、实时正文和实时工具行。完整 live inventory 中暂未列出的行不能在这个阶段提前消失。

保留内容不等于保留旧执行事实：工具状态、轮次状态及实时更新仍按源端数据推进，不能为了画面稳定把已经完成的工具继续显示为运行中。等待期间维持 `isChatSyncing=true`，不发送已经完成应用的确认；沿用现有恢复请求取得缺失条目及完整 checkpoint。

### 3. canonical 与实时内容由完整源状态一次交接

历史 / catchup 页只有 canonical 条目，没有完整实时库存。因此，即使该页刚好补齐缺失父节点，也只沿保留的分支补入历史，不能在这一帧引入新 canonical 内容并留下旧实时副本。处于保留状态时，缓存首屏种子也不能替换现有会话。

只有包含完整源状态和实时库存的 checkpoint / patch 在父链可接续后，才能一次发布新的 canonical 投影并对账实时行，清除 `retainedProjectionLeafId`。交接后内容只保留一份；不能先删实时行再补 canonical 行，也不能先发布两份再清理。对账使用已有消息 / 条目身份，不增加按正文猜测的去重。

### 4. 保留状态有明确边界

- 已确认的 rewind 或分支切换遵守权威分支，不因连续性保护永久保留旧分支消息。
- 源 epoch 切换、未知源边界及缓存重建清理保留锚点；旧锚点不得跨源或跨会话复用。
- 缺失条目长期未到时保持核对语义，依赖现有恢复机制收敛；不把保留画面当成同步完成。

### 5. 范围与取舍

本次恢复既有 V20 / UI-02 约束，不新增 feature ID，不调整 UI 基线版本、视觉 token、工具卡形态、动画或跟随 / 阅读 / 分页参数。修改范围为 Android 会话状态与缓存重建清理；没有修改共享协议、Host 或 iOS 实现。

不采用固定等待、减少工具刷新、隐藏历史入口或渲染层防抖。这些方法不能证明父链完整，也不能保证慢链路、多次更新及历史回补时正确交接。独立保存显示锚点增加少量状态管理，但让“收到哪一步”和“显示哪一步”各自有明确含义。

## Implementation

| 入口 | 职责 |
| --- | --- |
| [RemoteState.kt](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt) | 保留显示锚点；缺父期间保留 canonical / live 内容并接收状态事实；重复更新、历史与缓存路径保护；完整源状态原子交接与重置 |
| [SessionCacheMigration.kt](../../android/app/src/main/java/com/orbising/orbis/SessionCacheMigration.kt) | 缓存重建时清理保留锚点 |
| [ToolContinuityFixture.kt](../../android/app/src/sharedTest/java/com/orbising/orbis/ToolContinuityFixture.kt) | 构造实时正文 / 工具、缺父结果、重复更新、catchup 和最终交接 |
| [SessionToolContinuityTest.kt](../../android/app/src/test/java/com/orbising/orbis/SessionToolContinuityTest.kt) | 11 个单元用例覆盖时序、恢复和重置边界 |
| [ToolContinuityInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/ToolContinuityInstrumentedTest.kt) | 跟随 / 实际滑动进入阅读模式的两项设备回放，断言行身份、几何、数量与分页边界 |
| [ToolContinuityCaptureInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/ToolContinuityCaptureInstrumentedTest.kt) | 真实输出逐帧增加源序号、head、父链和分页状态，便于与原生事件对齐 |

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## Consequences

缺父窗口不再发布孤立结果，也不在历史回补时产生 canonical / live 双份内容。源端事实仍可前进，用户已读内容和分页边界保持连续；完整状态到齐后一次完成交接。

若源端迟迟不提供可接续父链或完整 checkpoint，客户端会继续显示保留内容及核对状态；该恢复依赖仍存在。已知全量失败和未执行门禁继续登记在 [UI 回归证据](../../.artifacts/ui-regression/20261101-pi-tool-continuity/summary.md)，不得把本次提交描述为完整双端验收。
