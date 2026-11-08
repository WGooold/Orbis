# ADR-0066：各后端共用聊天卡片展示逻辑

日期：2026-11-06（Asia/Taipei）

Status: accepted（Android / iOS 已实现并提交；定向自动验证通过，设备视觉回归与用户验收待完成）

关联：[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) 的 S31、[ADR-0058](0058-shared-interaction-motion.md) 的 SC50 / MOT-27、[ADR-0046](0046-mobile-ui-stability-and-material.md) 的阅读与流式呈现、[ADR-0045](0045-tool-summaries-and-on-demand-content.md) 的工具摘要、[ADR-0052](0052-turn-file-changes-and-on-demand-diff.md) 的文件变更锚点。

## Context

Pi、DSH、Claude、Codex 及 Codex Desktop 的原生轮次、消息打包和工具事件粒度不同。同样的思考、正文和调用序列，可能集中在一条助手消息中，也可能分散在多条消息中。按原生轮次分卡，再按消息条数切分长卡，会让这些差异直接决定 App 的外框数量与高度，出现 DSH 长卡包含多次调用、Pi 显示多张短卡的差异。

聊天页面需要统一内容分类、卡片边界、工具折叠和复制范围。原生执行身份与计时仍由来源提供，App 使用本地显示投影组织视觉内容。

## Decision

### 1. 双端按有序可见内容分卡

Android 与 iOS 对所有后端采用相同规则：用户消息独立成行；助手卡片按思考、正文、工具的内容步骤组织。工具之后出现新的正文或思考，以及正文之后出现新的思考时，开始下一张卡。错误消息与其他角色消息单独成卡。

思考、正文及其他可见非工具内容共用内容块预算，达到预算后从下一个非工具块开始新卡。预算按内容块计算；一条原生消息可以形成多个显示片段，多条原生消息也可以组成一张卡。原生 turn 标识保留执行与计时用途。具体预算以两端实现常量和共用回归断言为准。

### 2. 工具共用折叠与局部分页

卡片尾部的连续工具调用组成一个工具组。单次调用复用已有工具卡，多次调用默认折叠为数量与执行状态摘要，展开后按固定页增加可见工具。工具结果按原生工具身份关联，详情沿用现有按需读取入口。思考内容复用折叠组件，标题统一为“思考过程”。

工具组可以跨越原生消息边界。正文预算与工具页大小分别控制正文分卡和展开工作量，具体参数保留在实现中。

### 3. 显示片段保持源身份与业务锚点

本地片段保留源消息 ID，使用独立的卡片 ID 参与列表渲染。以工具起始的卡片使用原生工具调用 ID，使实时与持久化表示切换时外框身份保持连续。历史前插时保留已显示卡片的起点。

源消息被拆成多个显示片段时，仅末片段持有该源消息的计时与文件变更锚点，避免重复显示。复制操作覆盖当前视觉卡片中的内容；发送、历史存储、原生执行及协议继续沿用现有语义。

### 4. 展示策略由 App 共用层承担

后端适配继续提供内容与原生事实；Android 和 iOS 各自在共用展示模型中实现上述规则，聊天视图复用既有卡片、折叠、工具详情及回复增高组件。相同的有序内容在初次分组时应得到相同的内容分卡，后续更新保留已有阅读边界。卡片长度随实际内容变化。

## Implementation

实现提交：`91953f11b4ed75b77889c6601bd0d82aa6fbb009`。

| 入口 | 职责 |
| --- | --- |
| [MessagePresentation.kt](../../android/app/src/main/java/com/orbising/orbis/MessagePresentation.kt) | Android 内容分卡、片段身份、完成锚点及正文 / 工具投影 |
| [MainActivity.kt](../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt) | 在线与离线聊天卡片、工具组折叠和局部分页 |
| [Presentation.swift](../../ios/Orbis/Orbis/Presentation.swift) | iOS 内容分卡、片段身份、计时与文件变更归属 |
| [ChatView.swift](../../ios/Orbis/Orbis/ChatView.swift) | iOS 卡片正文、工具组及变更锚点消费 |
| [共用夹具](../../ios/Orbis/Tests/Fixtures/chat-card-layout.json) | 同一内容按整段、分步骤和逐块打包的跨端输入 |
| [UnifiedChatCardTest.kt](../../android/app/src/test/java/com/orbising/orbis/UnifiedChatCardTest.kt) / [UnifiedChatCardTests.swift](../../ios/Orbis/Tests/UnifiedChatCardTests.swift) | 分卡一致性、末片段归属、工具身份与历史前插回归 |

## Verification

提交范围在独立副本中完成验证：Android 定向单元测试 22 项、Swift 展示与统一卡片测试 29 项通过；iOS 通用模拟器目标完整编译通过；1485 项中英文目录与静态差异检查通过。Android 测试复用原生源码哈希一致的既有 QUIC 依赖包。

验证记录、构建结果、依赖哈希、首次失败和资源清理证据见 [verification.json](../../.artifacts/unified-chat-cards-20261106/verification.json) 及[任务证据](../../.artifacts/unified-chat-cards-20261106/)。测试使用合成内容覆盖不同消息打包方式，真实后端与设备视觉效果另行验收。

待用户验证：安装包含上述提交的新 App，在 Pi、DSH、Claude、Codex 与 Codex Desktop 会话检查连续调用、工具组展开与继续加载、复制范围、刷新、重连及历史前插后的阅读位置。实施提交、自动验证与设备安装分别记录；本任务尚未安装或部署。

## Consequences

后端消息打包粒度通过本地显示片段适配，双端维护一套可对照的视觉语义。展示模型需要同时维护源消息身份、卡片身份和完成锚点，后续调整继续使用共用夹具核对两端行为。

正文按内容块设预算，单个超长文本块仍可能形成较高的卡片。多工具组的默认收起与局部分页限制初始展示量；完整工具内容继续由现有详情入口承载。最终视觉效果与用户验收状态以设备证据为准。
