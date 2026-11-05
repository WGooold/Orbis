# ADR-0057：Android 工具结果乱序时的会话连续性与原子交接

日期：2026-11-01

Status: implemented（Android 修复与专项验证完成；完整 UI 回归门禁及真机验收未完成）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) 的 V20、V09、V01–V04、V18；[流式呈现与阅读规则](0046-mobile-ui-stability-and-material.md)；[测试规则](../../AGENTS.md#测试)。

## Context

Android 的 Pi 会话会短暂只剩一条工具消息，顶部仍有“加载更多消息”，随后整段记录再次出现。隔离 Host 的真实输出和可控设备回放确认了两条相关路径：

1. 工具结果先于调用它的助手条目到达，结果的父链暂时不完整。原有 `isWaitingForParent(oldLeaf, newLeaf)` 在第一份更新中保留旧画面，但同时推进 `sourceHeadLeafId`。第二份相同 head 更新或其后继条目再以这个源端 head 判断时，会绕过保护并发布孤立结果。可控设备回放中列表从 17 行降至 1 行。
2. 原保护只保留 canonical 行，仍提前移除了尚未完成交接的实时正文和工具行。真实 Pi 六次工具调用中出现 11→9、13→11 的回落，约两帧后恢复。中间修复又暴露出另一种时序：catchup 补齐父条目时先发布 canonical 行并保留实时副本，下一次 checkpoint 再删掉副本，造成先重复、后收缩。

这些证据解释了本次闪屏；没有据此得出 Pi 比 Codex 调用工具更频繁的结论。工具频率也不能作为修复条件。顶部历史入口本身仍遵守 V04，需修复的是会话投影被截断与交接非原子的问题。

## Decision

### 1. 源端进度与显示分支分别记录

RuntimeConversation 以 retainedProjectionLeafId 记录实际保留的显示分支，以 sourceHeadLeafId 与源版本记录接收进度；连续性核验基于显示锚点。

### 2. 缺父时保留已显示内容，状态事实继续更新

同 epoch 缺父期间保留已确认的 canonical / live 投影，执行与工具状态继续随来源更新。现有恢复入口取得父链和完整 checkpoint，应用确认随完整交接推进。

### 3. canonical 与实时内容由完整源状态一次交接

历史页补充保留分支；父链完整后，由携带完整实时库存的 checkpoint / patch 原子交接 canonical 与 live，并按稳定身份解除保留锚点。

### 4. 保留状态有明确边界

显示锚点随来源代次、Session 和缓存生命周期管理，已确认分支切换按权威历史更新，未完成恢复保持核对状态。

### 5. 范围与取舍

本修复在 Android 会话状态和缓存清理中恢复既有连续性契约，显示锚点明确区分源端接收与画面交接。UI、协议与其他平台沿用既有基线。

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

若源端迟迟不提供可接续父链或完整 checkpoint，客户端会继续显示保留内容及核对状态；该恢复依赖仍存在。已知全量失败和未执行门禁继续登记在 [UI 回归证据](../../.artifacts/ui-regression/20261101-pi-tool-continuity/summary.md)，完整双端验收仍待完成。
