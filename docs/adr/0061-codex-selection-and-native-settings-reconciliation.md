# ADR-0061：Codex 下一轮选型与原生设置快照分开对账

日期：2026-11-03

Status: accepted（决策与实现已接入；完整设备 / 手动验收分别记录，未验收不记为交付；未部署）

关联：[ADR-0021](0021-codex-terminal-host-attachment.md)（终端接入）、[ADR-0031](0031-host-permission-management.md)（权限管理）、[ADR-0049 §6.7](0049-optimistic-send-and-source-reconciliation.md#67-模型与思考级别条件乐观)、[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)（V05、V12、V17–V18）、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)（输入生命周期）、[ADR-0058](0058-shared-interaction-motion.md) SC16（配置反馈）。验证映射见 [UI 回归](../testing/ui-regression.md) R27 / R56。

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

| 项目 | 结果与边界 |
| --- | --- |
| 修复前新增回归 | 16 项中 13 过、3 失败，覆盖权限通知、resume 和首次订阅覆盖本地选择 |
| 修复后适配器专项 | **188 / 188 通过**，包括既有 `codex-runtime.test.ts` |
| 真实 PTY：电脑首次输入 | 首次原生请求为 Sol；手机下一轮选型在首次订阅和权限更新后保留为 Astra / high，实际后续请求为 Astra |
| 真实 PTY：手机首次输入 | 首次输入前选择未发出原生设置 RPC；首条及后续手机请求均为 Astra，权限更新后仍为 Astra / high |
| 模型请求隔离 | 全部进入本地 Responses 假服务，真实模型请求数为 0 |
| 类型检查 / 修改文件 lint | 通过 |
| Node 全量 | 1701 项：1694 过、2 失败、5 条件未运行。2 项 macOS launcher 的源码与当次 HEAD 一致，整类复测同样失败，不能写成全量全过 |
| Android 单元 / 构建 | 首次共享工作树为 681 项、0 失败；恢复后的隔离基线 / 候选各 **677 / 677**，两包构建通过。两次源码范围不同，不合并计数 |
| iOS 核心 / 构建 | 恢复后的隔离基线 / 候选各 **351 / 351**，Debug 与测试包构建通过 |
| Android 设备 | 共用入口先后借用两台空闲 API 35，模拟器均在启动时退出 **-11**，没有进入安装 / instrumentation；新会话设备与端口锁正常释放，不记 L3 / L4 通过 |
| iOS 设备 / 截图 / 手动 | 首次全量受掉盘中断；恢复后 SE 基线仅完成 50 项（44 过 / 6 失败），随后测试驱动等待 crash-log 收集，系统重启后进程退出；候选全量未开始，无法比较失败集合。另借 iPhone 17 查看 9 张预览图，仅局部静态核对；C01–C18、真实 App R27 / R56 与完整 A1–A4 未完成 |
| 部署 | 未部署，未操作用户正在使用的 Host |

永久回归入口为 `packages/host/src/codex-permission-settings.test.ts`、`packages/host/src/codex-terminal-sync.test.ts` 及既有 `codex-runtime.test.ts`。测试须继续检查四类权限、实际下一轮请求、首次输入前不发设置 RPC、首次物化与订阅、普通 resume、电脑端真实改变、模型 / effort 独立交接和 null effort。

App 侧沿用 iOS `testModelSwitchShowsTheChoiceWithItsMarkWithoutMovingTheHeader`、Android `ConfigComposerInstrumentedTest` / `CodexPermissionsInstrumentedTest` 等现有用例。R27 / R56 手动补查“切模型 / effort → 改权限 → 继续提问”、电脑首条 / 手机首条输入和电脑端真实切模；夹具 UI 测试不能替代真实原生链路。

## 存储恢复与验证记录

首次双端回归期间，`/Volumes/WD1TB` 从挂载表消失。该次 Android / iOS 全量日志均不完整，原始记录保留在 `.artifacts/ui-regression/20261103-codex-permission-model/`，未将中断计为通过。内置盘临时备份已复制回同目录的 `internal-recovery-backup/`。

2026-11-03 继续任务时，外接盘已挂载。对 `codex-runtime.ts`、`codex-permission-settings.test.ts`、`codex-terminal-sync.test.ts` 核对 SHA-256，三者与断连前保存记录完全一致，修复和新增测试均保留；随后为本决策补上中文注释和正式 ADR 引用。未重复套用备份补丁，也未改动并行任务的代码。

旧 Android 会话的独占锁仍保留：其注册模拟器端口被占用，原私有 ADB 服务已不可用，不能仅凭监督进程退出或锁龄回收。继续测试从固定池借用其他已确认空闲的 API 35 设备，经共用入口完成设备 / ADB 生命周期。后续设备、截图、手动验证的结果与未覆盖项见 [UI 回归 §6](../testing/ui-regression.md#6-结果记录) 和上述证据目录的 `summary.md`；源码或原生专项通过不能替代全部门禁。

恢复后以 `3bdb968` 建立独立基线 / 候选工作树，候选只叠加本次 Host 选型修复与两份回归文件，排除共享工作树其他任务的源码改动。两端移动源码哈希相同，但仍执行设备门禁；该事实不作为免测理由。构建来源与包哈希见 `resumed-validation/build-products.json`。

Android 首轮 `Orbis_UI_Polish_35` 与固定重试 `Orbis_UI_Regression_35_3` 都在启动阶段退出 -11，日志有 QEMU 线程无响应；入口的两份 `cleanup.json` 均无清理错误、私有 ADB 已停止、设备 / 端口锁已释放。没有重建或擦除设备，也没有绕过共用入口。

iPhone 17 上保存并查看首页和模型配置前后预览图，覆盖浅色 / 深色及 XXXL / 减少动画启动参数；XXXL 图没有满足 375pt 窄屏要求，静态图也不能证明手势或动效全过程。手动预览设备已恢复 Shutdown 并释放自己的锁。完整逐项范围见 `resumed-validation/manual-checklist.md`。

恢复后的 iOS SE 基线全量在完成 50 项后停在模型切换用例开始位置；采样显示测试驱动等待 `XCTCrashLogTracker.waitForPendingCrashlogs`，截图仍是上一项的长工具输出，不能记为模型切换用例已执行。随后电脑重启，原监督进程、Xcode 与本任务 App / test runner 均已退出，设备为 Shutdown。未完成 `.xcresult` 缺少 `Info.plist`，工具不能导出完整结果；保留原始目录、日志、采样和截图。准确结果见 `resumed-validation/ios-interrupted-result.json`，不能据此宣称候选失败集合未扩大。

按重启后新增的本机规则，`resource_guard.py check` 返回内存 **83.5% ≥ 80%**、拒绝启动；后续快照为 84.4%。没有再启动模拟器或构建。核对 owner / PID、Shutdown 状态与构建目录无打开引用后，在 registry 独占锁下只释放本轮 5 个残留租约；没有按锁龄回收、终止其他任务或处理旧 Android 锁。证据见 `post-reboot-memory.json` 与 `post-reboot-cleanup.json`。后续补验须用新的 `ios-simulator.py` / Android 共用入口及内存检查，当前完整 UI 门禁仍未通过。
