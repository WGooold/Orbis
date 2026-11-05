# ADR-0061：Codex 下一轮选型与原生设置快照分开对账

日期：2026-11-03

Status: accepted（决策与实现已接入；完整设备 / 手动验收分别记录，未验收不记为交付；未部署）

关联：[ADR-0021](0021-codex-terminal-host-attachment.md)（终端接入）、[ADR-0031](0031-host-permission-management.md)（权限管理）、[ADR-0049 §6.7](0049-optimistic-send-and-source-reconciliation.md#67-模型与思考级别条件乐观)、[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)（V05、V12、V17–V18）、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)（输入生命周期）、[ADR-0058](0058-shared-interaction-motion.md) SC16（配置反馈）。验证映射见 [UI 回归](../../AGENTS.md#测试) R27 / R56。

## 背景与问题

用户在 Android App 中把 Codex 的默认 `gpt-6.1-sol` 切到 `gpt-6-astra`，随后调整当前会话权限，模型又显示为 Sol。

原实现将 App 的模型 / effort 选择保存在 Host 会话内，随后通过 `turn/start.model` / `turn/start.effort` 提交。原生权限更新返回的是完整 `thread/settings/updated.threadSettings`，其中可以重复携带尚未变化的原生模型与 effort。Host 收到通知后无条件写入同一组会话字段，把用户已选的下一轮值覆盖成旧原生值。因此问题会影响下一次实际请求，不能仅在 App 上保留显示文字。

## 首次输入前的实测约束

对本机选中的 Codex CLI **0.166.0**，使用独立 `CODEX_HOME`、工作目录、app-server、真实 PTY 和本地 Responses 假服务进行验证，没有使用用户的真实会话或模型服务。

| 阶段 / 接口 | 观察结果 | 约束 |
| --- | --- | --- |
| TUI 打开，尚未输入 | 广播空线程，`thread/loaded/list` 已能列出它 | 线程已被创建，不代表 rollout 已物化或 Host 已订阅 |
| 首次输入前 `thread/resume` | `no rollout found for thread id` | Host 暂时不能加入线程订阅 |
| 首次输入前 `thread/turns/list` | `not materialized yet; ... unavailable before first user message` | 尚未物化，按后续原生事件恢复 |
| 未订阅 Host 的 `thread/settings/update` | RPC 返回成功，但观察到的设置确认通知为 0 | 写入受理与确认通知是不同事实 |
| 真实首次输入后 | 能恢复 / 订阅并读取有效设置 | 沿用现有状态广播与窗口观察器重试 |

首次输入前的选型保留下一轮覆盖，订阅按原生物化进度建立，原生设置确认与 RPC 受理分别核对。

## 决策

### 1. 分开保存选型和原生观测

ThreadState 分别保存下一轮选型、显式覆盖与最近原生观测，以会话为作用域；既有 model / thinking 选择在下次 turn/start 生效。

| 字段 | 含义 |
| --- | --- |
| `model` / `effort` | 当前对 App 发布并用于下一次 `turn/start` 的值 |
| `modelOverride` / `effortOverride` | 用户通过 App 明确选择、尚未交回原生来源的下一轮覆盖 |
| `nativeModel` / `nativeEffort` | 最近一次实际观察到的原生值，用于识别完整快照中的重复字段；从未观察到时保持未知 |

### 2. 按字段交接原生事实

模型和 effort 独立对账，原生确认所选值或实际变化时交回该字段；完整快照的重复值保留显式覆盖。所有原生设置入口共用归一化函数。

| 新原生值与已知状态 | 处理 |
| --- | --- |
| 等于本地所选值 | 原生已体现选择，清除该字段覆盖，交回原生来源 |
| 与已知上次原生值不同 | 接受真实原生变化，清除该字段覆盖，继续同步电脑端配置 |
| 首次观察原生值，且不同于本地覆盖 | 建立原生基线，保留本地覆盖 |
| 与上次原生值相同，且不同于本地覆盖 | 更新原生观测，保留显式的本地下一轮覆盖 |
| effort 明确为 `null` | 作为原生重置参与对账，不把它当作字段缺席 |
| 字段缺席 | 不生成默认事实，也不清除既有选择 |

### 3. 权限操作保持原范围

权限操作在当前 setting 的范围内提交 patch，并以匹配的原生权限事实确认结果。模型选型与权限各自维护来源和生命周期。

### 4. UI 与交互基线

本修复恢复 V05、V12、V17–V18 的配置保持规则，沿用 ADR-0058 SC16 反馈与现有 App 账本、发送前置和动效。

## 其他方案与取舍

- 一律调用原生设置更新并等待通知：首次输入前 Host 未订阅，实测无法得到所依赖的确认，故不采用。
- 忽略通知中的所有模型 / effort：会阻断电脑端真实配置变化，故不采用。
- 永久让本地覆盖优先：同样会屏蔽原生变化，故在原生确认或已观察到的实际变化时交还该字段。
- 在权限写入中顺便重写模型 / effort：扩大权限操作的写入范围，混合两个操作的来源与结果，不作为本次修复。

原生通知目前没有在本次验证中可用的独立用户选型身份。同值快照本身不能证明电脑端发生了新的切模操作；本决策不从值相同推断新的用户意图。若原生以后提供操作身份或可用的配置版本，应优先用其改进因果对账。Host 重启时本地覆盖的持久化语义保持原状，本次不承诺跨进程保留。

## 验证与实际完成范围

[测试规则](../../AGENTS.md#测试)；[codex-runtime.test.ts](../../packages/host/src/codex-runtime.test.ts)；[codex-terminal-sync.test.ts](../../packages/host/src/codex-terminal-sync.test.ts)；[ConfigComposerInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/ConfigComposerInstrumentedTest.kt)；[codex-permission-settings.test.ts](../../packages/host/src/codex-permission-settings.test.ts)；[CodexPermissionsInstrumentedTest.kt](../../android/app/src/androidTest/java/com/orbising/orbis/CodexPermissionsInstrumentedTest.kt)；[原始证据](../../.artifacts/)。

## 存储恢复与验证记录

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。
