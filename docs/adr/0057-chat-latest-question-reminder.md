# ADR-0057：上翻阅读时提醒最近提问

日期：2026-11-01

Status: accepted（交互已确定；代码与回归同步实施，完整设备门禁完成前不记为验收通过）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) S24；S10、S13、S17、V01–V04、V06、V09、V17–V18；[ADR-0046](0046-mobile-ui-stability-and-material.md) §1、§3；[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)；[测试规则](../../AGENTS.md#测试)。

## Context

长回复中上翻查阅时，原提问经常已经离开屏幕。用户需要就近找回自己最近问了什么，同时保留阅读位置和完整消息。

## Decision

最近提问以当前分支的稳定源消息为引用，在主动上翻阅读时提供就近定位。提示复用覆盖层与共用动效，按阅读状态、通知优先级和会话生命周期管理；定位保留原消息身份、阅读位置与分页语义。

## Verification

[测试规则](../../AGENTS.md#测试)；[ChatQuestionTest.kt](../../android/app/src/test/java/com/orbising/orbis/ChatQuestionTest.kt)；[ChatQuestionTests.swift](../../ios/Orbis/Tests/ChatQuestionTests.swift)；[ChatQuestionReminderInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/ChatQuestionReminderInstrumentedTest.kt)；[原始证据](../../.artifacts/)。

## 2026-11-01 / r31 共用动效修订（已接入，验证中）

[ADR-0058](0058-shared-interaction-motion.md) 统一菜单、选择工具栏、图标反馈、最近提问右上出入及边缘返回。本文先前的导航来源、提示条件、阅读稳定和业务判定保持；对应动效参数以该修订为目标，未完成双端门禁不记为验收通过。实施与测试映射见 [MOT ticket](0058-shared-interaction-motion.md)。

## 2026-11-02 / r35 交互补充（已接入，验证中）

r35 修订：提示改为一行；出现还须最近一次用户滚动朝更早内容，向最新方向滚动即收起。三行指离底部的像素距离对应三行，其他身份 / 通知优先 / 定位规则保持。详见 [ADR-0058](0058-shared-interaction-motion.md)；双端门禁未完成前不记为验收。
