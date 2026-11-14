# ADR-0064：从协议 18 起维持兼容

日期：2026-11-04（Asia/Taipei）

修订：2026-11-05（Asia/Taipei），旧 App 兼容由 Relay＋Host 承担。

Status: accepted（第一阶段 Android 已合并，第二阶段 Relay 18 / 19 外层兼容已部署；第三阶段 Relay＋Host 保留旧 App 的决策已确认，Host 18 / 19 双向业务适配已实现，设备 / 跨平台与真实旧包门禁未验收）

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)、[ADR-0062](0062-claude-background-agents-and-session-activity.md)。版本与能力按实际实现协商，认证、E2E、身份及回执保持原契约。Relay 的认证与密文路由见 [ADR-0009](0009-remove-computer-to-phone-push.md)。

## Context

Claude 后台子任务提交 `20a9898` 将共享协议、Android 和 iOS 从 18 升至 19。后续本地 App 包继承了 19，而线上 Relay 与已安装 Host 仍为 18。精确版本校验使分批安装直接断连；两个不同协议的 Android 包仍共用 0.1.53 / versionCode 54，进一步妨碍识别。

2026-11-04 起，最低兼容基线为协议 18；兼容设计依据正式规范，并以已部署旧实现验证互通。

2026-11-05，手机 App 0.1.53 显示“电脑端拒绝了请求 / Orbis 协议版本不兼容”。现场 Mac Host 0.1.14 的内置协议为 18，已连接 Relay；Relay `8601e6508523` 的 18 / 19 外层入口正常，手机–Host 业务兼容仍有缺口。分批升级采用 Relay＋Host 方案，保留现有 App。0.1.53 曾存在不同协议构建，旧包互通证据按包来源与哈希区分。

## 依据与适用边界

- [Semantic Versioning 2.0.0 §6–8](https://semver.org/#spec-item-6)：区分兼容与破坏性 API 变更。
- [Google AIP-180](https://google.aip.dev/180)：兼容性包含序列化及行为语义。
- [LSP 3.17](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md)及[初始化规则](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/general/initialize.md)：通过已声明能力启用功能。
- [RFC 8446 §4.2.1](https://www.rfc-editor.org/rfc/rfc8446.html#section-4.2.1)：协商双方实际支持的共同版本；本文借鉴协商模式，Orbis 加密实现保持原状。
- [ProtoJSON Wire Safety](https://protobuf.dev/programming-guides/json/#json-wire-safety)：字段扩展性取决于解析规则；Orbis 继续使用自身 JSON schema。
- [JSON-RPC 2.0 §5.1](https://www.jsonrpc.org/specification#response_object)：未知方法以关联错误终结请求。

## Decision

### 1. 以 18 为永久最低共同协议

协议 18 是持续互通基线，新实现保留其已部署格式与语义，并识别已发布 19。产品修订、实际 wire version 与功能能力分别记录。

### 2. 握手协商共同版本，功能独立协商

连接在认证边界选择双方实际实现的共同格式，功能在已有认证通道按能力启用。Relay 路由版本与端到端业务版本分别管理，旧 strict 握手使用其原格式。

### 3. 采用兼容的 schema 演进

schema 保持既有字段语义，按消息类别声明扩展性；影响副作用的新功能在能力确认后发送。未知操作以关联错误终结，状态与二进制布局保持完整验证。

### 4. 一次性迁移与发行

分批发行保留旧端基础互通，当前交付路径更新 Relay＋Host 并保留旧 App。格式探测限于尚未形成业务通道的明确兼容失败，新连接与临时密钥隔离探测；操作结果继续按原身份核对。交付记录源提交、包哈希、格式与实际部署状态。

### 5. UI 与验证边界

兼容修复沿用现有连接、错误和状态反馈，保持消息身份、阅读与动效。实际旧包互通、跨平台设备和人工验收分别记录。

2026-11-08：source `live.turn` 新增可选 `outcome`，保留 18 / 19 版本与既有字段含义，旧移动端忽略未知字段；新端缺失结果时保持未知。该字段只投影原生终态，不改变命令、回执或认证。source 恢复、重复与后端映射回归见 `packages/protocol/src/session-source.test.ts`、`packages/host/src/claude-mods-bridge.test.ts`、`packages/host/src/dsh-web-runtime.test.ts` 和 `packages/pi-extension/src/turn-timing.test.ts`；本轮测试证据保存在 `.artifacts/design-alignment-20261108/source-outcome-tests.log`。

本机 Pi 接入按每条 WebSocket upgrade 的 `X-Orbis-Session-Turn-Outcome` 能力头投影该字段，`runtime.ready` 后生效；旧 Host 缺少能力声明时仅剥除 source `live.turn.outcome`，保留原有命令、正文和工具数据。连接重建重新判断能力。兼容与重连回归见 [transport.test.ts](../../packages/pi-extension/src/transport.test.ts)、[loopback-server.test.ts](../../packages/host/src/loopback-server.test.ts)及[本次证据](../../.artifacts/design-alignment-20261108/source-outcome-gate/)。

2026-11-11，S57／SC81：Pi 的 `currentTurnConfiguration`、`currentTurnConfigurationSupported` 和 `modelSelection` 为同协议号下的新增字段，旧 Host 的严格 metadata schema 会拒绝整条注册或更新消息。Host 在 WebSocket upgrade 声明 `X-Orbis-Runtime-Model-State: 1`；Pi 按每条连接在 `runtime.authenticate.runtime` 与 `runtime.metadata` 统一投影，无声明时仅移除这三个字段。注册前确定可接受的格式，后续事件仍等待原有 `runtime.ready`；本地保留完整事实，重连重新判断能力，既有选择值、身份、命令及用户／工具数据保持原语义。

回归见 [transport.test.ts](../../packages/pi-extension/src/transport.test.ts) 和 [loopback-server.test.ts](../../packages/host/src/loopback-server.test.ts)，覆盖注册、更新、能力缺失／无效、回退重连及原始数据保留。v0.1.15／0.1.16／0.1.17 原始实现的隔离互通、元数据更新、命令与同进程回退证据见 `.artifacts/pi-host-compatibility-fix-20261111/verification.json`；首次缺陷证据保留在 `.artifacts/compatibility-review-20261111/`。自动验证与部署、设备验收分别记录；未部署，待用户验证。

2026-11-14，SC87：Claude 插件在既有 hello 能力列表声明 `configuration.effort.snapshot`，消息字段与 bridge version 4 保持不变。新 Host 仅对声明该能力且同时带顶层 `model` 与 `currentTurnConfiguration` 的完整状态，将缺失 `effort` 解释为清除旧深度；本轮增量帧与旧插件继续沿用缺失字段不更新的语义。旧 Host 忽略新能力并接受既有格式，仍保留其增量清除限制。以 v0.1.19 原始 Host／protocol 源码与候选源码分别回放真实隔离 Claude 元数据，覆盖旧／新插件状态、连续双轮及重连；证据见 `.artifacts/claude-effort-reporting-20261114/compatibility/`。

### 6. Relay＋Host 承担兼容，保留已安装 App（2026-11-05）

Relay 适配认证路由外层，Host 在端到端业务边界按设备格式完整收发，App 沿用其已发布能力。业务适配保持加密、身份、原语义与真实回执；长期演进由 Host 保留旧 App 的基础互通。

Host 0.1.14 需升级至实现本节的兼容版本，0.1.15 已接入适配；真实旧包和完整设备门禁仍待验收。

| 组件 | 兼容责任 | 本次升级范围 |
| --- | --- | --- |
| Relay | 接受已实现的 18 / 19 认证与路由外层，按各 socket 的认证版本回包；完整 Envelope 原样转发 | 已部署外层兼容；后续只补必要的配套变更及回归 |
| Host | 实现旧 App 18 / 19 的接收校验、请求处理、响应 / 状态投影和文件帧序列化；按每台设备、每条路径的业务版本交互 | 兼容实现已接入 Host 0.1.15；本机 macOS arm64 构建通过，Windows 交付与门禁待完成 |
| App | 保留原包、协议行为、配对身份与已有基础功能；新功能只在其能力范围内启用 | 本次不要求更新；0.1.54 的升级路径继续作为可选方案 |

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 第一阶段：Android 兼容当前 18（2026-11-04）

Android 实现已发布 18 / 19 的兼容，当前 `PROTOCOL_VERSION = 19` 保留。本阶段共享 Node、iOS 及线上部署保持原状。

Relay 认证优先使用 18，明确格式不兼容时在业务通道建立前以新连接尝试 19。LAN 优先 18，纯 HS1 超时后可使用新连接与临时密钥尝试 19；MAC 失败按认证失败处理。Relay 外层、Host 业务与 LAN 分别选择格式，业务出口及上传分片沿用相应路径版本和原操作身份。接收层完整校验已实现的 18 / 19 格式。

Android 发行标识为 0.1.54 / versionCode 55，区分此前 0.1.53 的不同协议构建；构建基线包含工作区既有中英文、卡片等修改，逐文件哈希留在证据中。

核心与设备结果、首轮 MockWebServer 清理失败和 runner 错误、源码 / APK 哈希及资源核验见 `.artifacts/ui-regression/20261104-protocol19-compatibility/summary.md`。完整用户、真机与真实模型验收待完成，第三阶段旧 App＋新 Host 互通单独验证。

## 第二阶段：Relay 接受已部署 Host / App 18（2026-11-04）

Relay `b59f99755b86` 的严格协议 19 认证使已安装 Host 0.1.13（实际协议 18）无法重连。修复版本 `8601e6508523` 已部署，接受经完整 schema 和凭据校验的 18 / 19 外层，并将版本绑定至 socket；ready 和路由帧按接收 socket 的认证版本序列化，完整 Envelope 保持原样。

本阶段仅覆盖 Relay 传输外层。既有 Host 18 与 Android 0.1.54 使用各自已实现的 18 E2E 格式，Host / iOS 19 的业务兼容由后续阶段承担。用户 Host、手机包、配对与生产凭据保持原状。

本地 247 项及旧 Host 模块隔离验证保留通过与负对照证据；CI、候选版本门禁、服务器部署标记和公网路径分别核对。候选与公网探针使用随机无效凭据验证版本准入。证据见 `.artifacts/deploy/20261104-relay-protocol18/`，完整 UI、真机及第三阶段业务验收待完成。

## 第三阶段：Relay＋Host 保留旧 App（2026-11-05）

Host 0.1.15 的双向业务适配已在隔离工作树 `codex/host-protocol18-19-compatibility` 实施并合并回 `main`。macOS arm64 预览构建完成；尚未部署或替换用户 Host，手机产品代码保持原状。Windows、macOS x64、完整设备、手动与真实旧包门禁待完成。

### 实现边界

内部使用严格 19 schema，Host 边界完整适配已发布 18 / 19。两版差异为根版本字面量、`execution.tasks` 事件及 execution 状态的可选 `tasks`；业务支持集合独立于 Relay。

已发布 HS1 / HS2 / HS3 没有业务版本字段。Relay 路径完成 MAC 确认后，以首条合法加密请求绑定业务版本，再发送 ready / 状态并执行该请求一次。LAN 保留原始 socket 帧版本，MAC 成功后据此发送首次 ready；版本随握手代次绑定。非法首请求沿入站路径返回带原 ID 的 versionless 错误。

HostDeviceSession 统一出口封帧，18 投影仅适配新增任务字段与事件，并在 AEAD nonce 分配前处理。上传 / 下载二进制按所选格式完整验证与转换；本机 Pi loopback 同样适配 18 注册、事件与命令。身份、原始业务内容及密文路由保持原语义。

兼容测试已接入 Relay 部署和 Host 构建 CI，macOS / Windows 原生构建核对实际打包 runtime 的兼容契约。记录时分支尚未 push，Actions 结果待确认。

### 当前验证记录

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。
