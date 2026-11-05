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
| 首次输入前 `thread/turns/list` | `not materialized yet; ... unavailable before first user message` | 没有历史不能误报成永久会话失败 |
| 未订阅 Host 的 `thread/settings/update` | RPC 返回成功，但观察到的设置确认通知为 0 | 写入受理与确认通知是不同事实，不能将 RPC 成功当作通知已到达 |
| 真实首次输入后 | 能恢复 / 订阅并读取有效设置 | 沿用现有状态广播与窗口观察器重试 |

因此，“把所有选型立刻改为原生设置更新，再等待确认通知”会使首次输入前的选择进入无法确认或超时状态。这不是本次修复可以忽略的兼容分支。不得为了得到订阅而提交一条合成用户消息、强制模型请求或重建会话。

## 决策

### 1. 分开保存选型和原生观测

每个 `ThreadState` 独立保存以下状态，不写全局默认值，也不跨会话复用。

| 字段 | 含义 |
| --- | --- |
| `model` / `effort` | 当前对 App 发布并用于下一次 `turn/start` 的值 |
| `modelOverride` / `effortOverride` | 用户通过 App 明确选择、尚未交回原生来源的下一轮覆盖 |
| `nativeModel` / `nativeEffort` | 最近一次实际观察到的原生值，用于识别完整快照中的重复字段；从未观察到时保持未知 |

保留原有 `/model` / `/thinking` 本地选择路径，不为它们新增首次输入前的 `thread/settings/update`。配置回执继续表示 Host 已接受后续提交所用的选择，不能解释成原生已发出设置确认通知。

### 2. 按字段交接原生事实

模型与 effort 分别对账，不因一个字段变化清除另一个字段的覆盖。先检查是否体现本地所选值，再检查是否相对原生基线改变；两者均不成立时才保留覆盖。

| 新原生值与已知状态 | 处理 |
| --- | --- |
| 等于本地所选值 | 原生已体现选择，清除该字段覆盖，交回原生来源 |
| 与已知上次原生值不同 | 接受真实原生变化，清除该字段覆盖，继续同步电脑端配置 |
| 首次观察原生值，且不同于本地覆盖 | 建立原生基线，保留本地覆盖；首次订阅不能冲掉先前选择 |
| 与上次原生值相同，且不同于本地覆盖 | 更新原生观测，保留显式的本地下一轮覆盖 |
| effort 明确为 `null` | 作为原生重置参与对账，不把它当作字段缺席 |
| 字段缺席 | 不生成默认事实，也不清除既有选择 |

`thread/start` / `thread/resume` 的 `reasoningEffort` 与通知的 `effort` 在一个共用入口归一化。普通恢复、TUI 首次订阅和设置通知调用相同的对账函数，避免只修权限通知而在后续 resume 中再次回退。

### 3. 权限操作保持原范围

权限写入继续只提交当前 setting 对应的权限 patch，保留文件范围等未投影限制，并等待原生 RPC 与匹配的有效权限通知。权限操作不额外改变模型、effort、协作模式、全局默认值或其他会话，也不启动回合。尚未收到权限事实时继续显示未知 / 不可用，不能用全局配置冒充会话确认。

### 4. UI 与交互基线

本修复恢复已有配置保持规则，关联 **V05、V12、V17–V18**，反馈分类沿用 **ADR-0058 SC16**。不新增 feature ID，不修改动效参数、消息身份、发送前置等待或 App 配置账本语义；ADR-0051 的 80 项总数与 67 项已交付计数不因此提高。

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
