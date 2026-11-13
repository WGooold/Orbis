# ADR-0081：Host 启动阻塞与界面反馈

日期：2026-11-13

Status: accepted（两处改动已实现并自动验证；本文第 5 节的其余阻塞点**未改动**；Windows 构建、安装与用户验收待完成）

关联：[ADR-0021](0021-codex-terminal-host-attachment.md)（SC75 终端服务端包来源与准备）、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0058](0058-shared-interaction-motion.md)、[ADR-0070](0070-unified-design-and-interaction.md)（HOST-GUIDE-01 / HOST-ACTIVITY-01）、[ADR-0075](0075-host-confirmed-exit-and-update.md)（HOST-LIVE-01 暂停恢复）、[ADR-0079](0079-codex-vscode-integration.md)。

## 1. 问题

现场症状是手机连不上、Host 界面停在「正在准备」。根因不是连接失败，而是**启动顺序**：SC75 之后，`DesktopRuntime.#connect()` 在建立 `HostService` 和连接 Relay 之前就 `await CodexAppServer.create()`。该方法在首次运行或任何一次 Codex CLI 版本变化后，要先从 GitHub Release 取与所选 CLI 版本完全匹配的官方 `codex-app-server` 包（aarch64-darwin 为 133 MB gz / 327 MB 解包），再校验、解包、跑 `--version` 与 `--help`。这段下载（API 30 s + 资产 180 s 超时）全部发生在中继连接之前，期间手机侧看不到这台电脑，界面也没有任何进度。

顺带暴露出第二类问题，并且与第一类是同一个机制：Host 里**正常的等待**普遍只体现为一个 `busy` 布尔量。按钮失去强调色、点击没有反馈，用户无法区分「在工作」和「卡死」；其中两处文案还是错的——内核仍在启动时概览显示「已暂停」，Agent 页把任何 `busy` 都说成「正在检测 Agent…」。

## 2. 决策

| 场景 ID | 行为 |
| --- | --- |
| HOST-PREP-01 | 终端 Codex 后端的准备（含官方服务端包的下载与校验）不再位于中继连接的关键路径。启动顺序改为：建服务 → 连中继（手机即可用）→ 后台准备 Codex → 握手成功后热挂。 |
| HOST-PREP-02 | 准备过程上报 `codexTerminal` 事件：`preparing`（带真实字节进度）、`ready`、`error`。`stop()` 取消在途下载：不发布半成品、不遗留 `.tmp-*`、不留孤儿进程。 |
| HOST-PREP-03 | 失败只上报，**不回退**到 `vscode` 来源的 CLI 入口；来源语义与 ADR-0021 SC75 保持一致，只是就绪时间不再等于可用时间。 |
| HOST-ACTIVITY-01 | 每个桥命令登记一条可读说明，界面展示最靠前的一条；请求结束即清除，内核退出时整体清空。概览连接卡显示旋转指示与该文案，连接 / 添加手机 / 检查更新按钮按操作进入 loading。 |
| HOST-ACTIVITY-02 | `connectionBlockReason` 与 `startHost()` 的每个守卫一一对应，按钮禁用时用 ToolTip 说明原因（核心启动中 / 读取激活信息 / 切换中继 / 未激活 / 安装 Agent）。内核未就绪时状态文本为「正在启动 Host 核心」，不再是「已暂停」。 |
| HOST-ACTIVITY-03 | Agent 页原先写死的「正在检测 Agent…」改为读取同一份活动说明；检测进行中 Agent 行显示「检测中」而不是上一轮结论。Host 在 Claude 探测前先发 `claudeStatus{detecting:true}`，Claude 行在检测完成前显示「检测中」，不再把「还没测完」显示成「尚未安装」。 |

「已在运行」不算阻塞：`m_desiredRunning` 为真时连接按钮仍可用，用于暂停。Codex 终端准备的失败不影响已连上的手机，也不改变 `state`。

## 3. 实现

| 文件 | 改动 |
| --- | --- |
| [codex-terminal-server.ts](../../packages/host/src/codex-terminal-server.ts) | 新增 `signal` 取消与 `onProgress` 上报（按 1 MB 粒度）；下载超时与调用方取消合并 |
| [desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts) | 移除 `#connect` 中的阻塞创建；新增 `#prepareCodex` / `#stopCodex` / `#codexPrepare`；`codexLaunch` 改为惰性接入；`#detectClaude` 先发 `detecting` |
| [host-service.ts](../../packages/host/src/host-service.ts) | 新增 `attachCodexRuntime` / `detachCodexRuntime`，与既有 `attachCodexDesktopRuntime` 对称 |
| [HostController.h](../../packages/windows-host/src/HostController.h) / [.cpp](../../packages/windows-host/src/HostController.cpp) | `activity`、`connectionBlockReason`、`claudeDetecting`、`codexTerminal` 四个属性；每个桥命令登记文案并在结束时移除；内核退出时清空 |
| [Main.qml](../../packages/windows-host/src/qml/Main.qml) | 概览活动行与按钮 loading、连接原因 ToolTip、状态文本修正、Agent / Claude 三态、Codex 终端接入进度 |

`codexTerminal` 的界面表现沿用本轮之前那一次提交：准备期间 Agent 行的 Codex 显示「正在准备 / 准备中 N%」，下载时显示字节进度条，失败给出后果说明（例如「Codex 终端接入未就绪，Codex 会话暂时不可用」），准备完成即隐藏。

## 4. 与既有决定的关系

- **ADR-0021 SC75**：来源判定（版本匹配的独立 `codex-app-server` + `--session-source`）不变，只把「准备何时发生」从连接前改为连接后。ADR-0021 的 2026-11-13 修订记录了这一改动。
- **ADR-0075 HOST-LIVE-01**：暂停恢复语义不变；新增的取消点挂在同一次 `#dispose()` 上，被放弃的准备不会把后端挂到新服务。
- **ADR-0070**：HOST-ACTIVITY-01 的界面约定记在 ADR-0070 的同日条目里；本文不重复视觉规范。
- **ADR-0079**：`--session-source` 仍是独立二进制的参数；`codex app-server` 子命令与 `codex remote-control` 依旧硬编码 `vscode`，本文不改变这一事实。

## 5. 审计出、但本次**没有改动**的阻塞点

按对用户的实际影响排序。这些都不是 bug 级错误，而是「正常等待却缺少说明」或「正常行为被排在关键路径上」。

| # | 位置 | 现状 | 为什么本次不改 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | `desktop-runtime.ts` `start()` → `#ensureClaudeIntegration` → `claude-integration-install.ts` | Claude 插件登记运行 4 个 `claude` 子命令（版本检查 / marketplace add / install / update），每个 60 s 超时，最坏约 240 s，全部在连中继之前 | 涉及「Claude 插件是否必须在使用前登记」的产品判断；后台化后需要处理"登记完成前 Claude Code 尚未带插件"的时间窗 | 与 Codex 同样处理：移出连接路径 + 事件上报；失败只提示 |
| 2 | `desktop-bridge.ts` 命令队列 | 队列全局串行，`detect`（每个 Agent `--version` 10 s + npm dist-tags 15 s，三个并行约 25 s）排在 `start` 前面；Qt 侧 `initialize` 回调先发 `detectAgents(true)` 再 `startHost()` | 串行是刻意的（避免并发改写配置与身份）。按 method 分流需要明确哪些命令可以并行，属于服务端并发模型变更 | 让 `start` / `stop` / `pair` 走独立通道，其余保持串行 |
| 3 | `host-service.ts` `start()` | `DSH runtime.start()` 在 `relay.start()` 之前（DSH Web 握手 15 s，起本地服务锁 60 s） | 需要确认 DSH 会话发现与中继公告的依赖方向；属启动顺序调整，与 Codex 同模式但影响面更大 | 与 HOST-PREP-01 相同的模式：连上 Relay 后再挂 DSH |
| 4 | `desktop-runtime.ts` `initialize()` | `adoptLoginShellEnvironment`（10 s 超时）、`providers.startRouting()`（无上限）、`#ensureClaudeIntegration` 都在 Qt 置 `m_bridgeReady` 之前 | 登录环境必须在任何 Agent 检测之前就位；路由需要绑端口，失败要能被 Host 看到 | 只把「可选集成」与「路由启动」改为后台，PATH 采纳保留在启动前 |
| 5 | `CredentialStore.cpp` | macOS 钥匙串 `SecItemCopyMatching` 无超时；钥匙串锁定或应用重签名后可能弹窗等待用户 | 属系统授权交互，程序侧无法在保持安全性的前提下给超时 | 界面提示「等待系统授权」，并把这一状态并入 `connectionBlockReason` |
| 6 | `HostController::restartDshServer` | 锁等待最长 60 s，只有一行 `setMessage` | 本轮活动文案已覆盖它（`正在重启 DSH Server`），但没有百分比 | 视需要复用下载式进度条 |
| 7 | `restoreActivation` / `renameDevice` / `revoke` | 命令期间按钮变灰，结果只体现在 message | 现在有活动文案（`正在保存设备变更`、`正在读取激活信息`），已不再是「静默」 | 不再单独处理 |

尚未审计的部分：

- Relay 服务端启动与连接路径（`packages/relay`）。
- 移动端冷启动（iOS `OrbisStore.swift` 的完整快照发布、Android 对应路径）。两端的连接状态文案已有「正在连接 / 正在建立安全通道 / 正在连接电脑」，不在本次范围内。

## 6. 已执行验证

证据目录：[`.artifacts/host-activity-20261113/`](../../.artifacts/host-activity-20261113/) 与 [`.artifacts/codex-terminal-async-prep-20261113/`](../../.artifacts/codex-terminal-async-prep-20261113/)。

| 验证 | 实际结果与证据 |
| --- | --- |
| TypeScript 类型检查 / ESLint | 通过 |
| `codex-terminal-server.test.ts` | 23 通过，含新增：下载进度单调且以总字节收尾、中止下载不发布且不留目录 |
| `desktop-runtime.test.ts` | 23 通过，含新增：准备失败晚 300 ms 到达时 Relay 仍先达成 `connected`，失败只作为 `codexTerminal error` 上报 |
| `host-service.test.ts` / `codex-daemon` / `codex-terminal-connection` | 82 / 17 通过 |
| `ORBIS_CODEX_NATIVE_TEST=1 codex-session-source-native.test.ts` | 2 通过（真实 app-server、隔离 home、合成会话，确认来源语义未变） |
| `vitest run packages/host/src` | 1766 通过、9 跳过；`codex-tool-runtime.test.ts` 有 2 项失败，**改动前用 `git stash` 去掉本次三个 TS 文件后同样失败**，原断言保留 |
| Qt 6.8.3 构建（含 QML 编译） | 通过 |
| `ctest` | 10/10 通过；新增 `HostLiveChangeTest::activityNamesTheBlockedAction` 逐条覆盖 5 个守卫原因与 `detect` 在途文案 |
| `--smoke-guide`（含自动恢复步骤要求连接按钮不可用） | 退出 0 |
| `--smoke-agents` / `--smoke-compact` / `--smoke-appearance` | 均退出 0 |

环境限制：本机无屏幕录制权限，台架 `grabWindow().save()` 失败（`smoke-result.json` 记录 `screenshotSaved:false`），带 `--screenshot` 的冒烟会以退出码 5 结束；改动前的构建同样无法保存截图。因此本轮以「不传 `--screenshot`」的断言结果作为证据，没有视觉截图。

## 7. 未验证与交付状态

- 真实的 133 MB 下载链路（限速、断网、中途暂停）与界面进度呈现，需要安装包才能观察。
- 首次准备期间手机侧 Codex 条目不可见的窗口长度，取决于网络与磁盘；该时间窗不阻塞其余 Agent。
- 第 5 节列出的 7 处阻塞点全部未改动，其中第 1、2、3 项仍是分钟级或排队级的等待。
- Windows 构建、Windows 安装、真实手机连接与视觉验收**待用户验证**。
- 未部署，未替换本机正在运行的 Host。

安装后建议逐项确认：启动初期是否读作「正在启动 Host 核心」而不是「已暂停」；按钮变灰时能否读到在做什么；Claude 行是否先显示「检测中」；Codex 升级后手机能否立刻连上、Codex 行是否显示准备百分比。
