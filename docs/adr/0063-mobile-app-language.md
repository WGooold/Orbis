# ADR-0063：移动端中英文与系统语言

日期：2026-11-04

Status: accepted（全 App 范围；实施与设备验收分别记录）

## 规则

应用拥有的界面模板统一支持简体中文与英文，正文及领域身份保持原文。语言按本机偏好即时呈现，跟随系统为默认，未匹配时使用英文；切换维护现有导航、连接与阅读状态。

双端共用模板与参数清单，已知 Host 文案按完整模板映射，未知内容沿用来源。布局通过自然换行和共用控件适应语言与字体，协议操作继续使用原身份。

## 影响与验证

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 2026-11-04 实施记录（验证中）

[根部测试约束](../../AGENTS.md#测试)；[LocalizationTests.swift](../../ios/Orbis/Tests/LocalizationTests.swift)；[orbis](../../android/app/src/test/java/com/orbising/orbis)。
