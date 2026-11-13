# ADR-0081：Host 启动阻塞与界面反馈

日期：2026-11-13

Status: accepted（第 2 节全部场景已实现并自动验证；第 8 节记录对首轮提交的审查与修正；Windows 构建、安装与用户验收待完成）

关联：[ADR-0020](0020-deepseek-harness-shared-web-backend.md)（DSH 共享 Web 服务）、[ADR-0021](0021-codex-terminal-host-attachment.md)（SC75 终端服务端包来源与准备）、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)（Claude Code 插件登记）、[ADR-0058](0058-shared-interaction-motion.md)、[ADR-0070](0070-unified-design-and-interaction.md)（HOST-GUIDE-01 / HOST-ACTIVITY-01）、[ADR-0075](0075-host-confirmed-exit-and-update.md)（HOST-LIVE-01 暂停恢复）、[ADR-0079](0079-codex-vscode-integration.md)。

## 1. 问题

现场症状是手机连不上、Host 界面停在「正在准备」。根因不是连接失败，而是**启动顺序**：SC75 之后，`DesktopRuntime.#connect()` 在建立 `HostService` 和连接 Relay 之前就 `await CodexAppServer.create()`。该方法在首次运行或任何一次 Codex CLI 版本变化后，要先从 GitHub Release 取与所选 CLI 版本完全匹配的官方 `codex-app-server` 包（aarch64-darwin 为 133 MB gz / 327 MB 解包），再校验、解包、跑 `--version` 与 `--help`。这段下载（API 30 s + 资产 180 s 超时）全部发生在中继连接之前，期间手机侧看不到这台电脑，界面也没有任何进度。

顺带暴露出第二类问题，并且与第一类是同一个机制：Host 里**正常的等待**普遍只体现为一个 `busy` 布尔量。按钮失去强调色、点击没有反馈，用户无法区分「在工作」和「卡死」；其中两处文案还是错的——内核仍在启动时概览显示「已暂停」，Agent 页把任何 `busy` 都说成「正在检测 Agent…」。

审计同一条启动链还找出另外六处「正常等待排在关键路径上」或「等待缺少说明」（第 5 节）：Claude 插件登记、全局串行的命令队列、DSH 先于中继启动、`initialize` 里的可选工作、UI 线程上的钥匙串读取、DSH Server 重启只有一行文案。第二轮按同一原则全部处理：**手机能连上之前只做必须做的事，其余后台进行并逐项上报。**

## 2. 决策

| 场景 ID | 行为 |
| --- | --- |
| HOST-PREP-01 | 终端 Codex 后端的准备（含官方服务端包的下载与校验）不再位于中继连接的关键路径。启动顺序改为：建服务 → 连中继（手机即可用）→ 后台准备 Codex → 握手成功后热挂。 |
| HOST-PREP-02 | 准备过程上报 `preparation{kind:"codex"}` 事件：`preparing`（带真实字节进度）、`ready`、`error`。`stop()` 取消在途下载与之后的解包、发布：不发布半成品、不遗留 `.tmp-*`、不留孤儿进程。加入他人准备的调用方在对方被取消时重新准备，不把别人的取消当成自己的失败。 |
| HOST-PREP-03 | 失败只上报，**不回退**到 `vscode` 来源的 CLI 入口；来源语义与 ADR-0021 SC75 保持一致，只是就绪时间不再等于可用时间。 |
| HOST-PREP-04 | Claude Code 插件的自动登记（最多 4 个 `claude` 子命令，各 60 s）在后台进行，不再挡 `initialize` 应答和 `start` 连中继；以 `preparation{kind:"claude"}` 上报，失败只提示。登记可取消：关闭 Host 或在设置里关闭集成时终止在途子命令；设置里开启时等待在途登记而不是重复执行。Host 打开的 Claude Code（电脑端打开或手机发起）先等在途登记结束，避免同一 TUI 既带一次性 `--plugin-dir` 又加载刚装好的插件。 |
| HOST-PREP-05 | DeepSeek Web 后端的预启动（本地服务锁最长 60 s、Web 握手 15 s）移到中继连上之后，经 `HostService` 的 DSH 槽位进行，与自动恢复、手机按需启动共用一次连接。`HostService.start()` 先 `relay.start()`，再在后台做 DSH 会话发现，发现完成后重新发布目录；暂停不再等待在途的 DSH 启动（在途接入在服务关闭后自行停止）。以 `preparation{kind:"dsh"}` 上报；失败只提示，手机打开 DeepSeek 时仍会按需启动。 |
| HOST-PREP-06 | `initialize` 只保留登录环境（PATH）采纳——之后的检测和启动都依赖它；本地路由启动（绑端口、改写 Codex 配置，无时间上限）改为后台，失败仍写入日志。终端 Codex 后端与 Host 打开的 Codex 先等路由完成，因为它们读取路由改写的配置。 |
| HOST-LANE-01 | 桥命令按通道调度（[desktop-command-lanes.ts](../../packages/host/src/desktop-command-lanes.ts)）：`start` / `pair` / `cancelPair` 为连接通道，`detect` / `state.*` / `provider.check` / `provider.models` 为后台通道，两者互不等待；`stop` / `shutdown` 不等在途的 `start`（`shutdown` 仍等后台命令写完文件）；其余命令独占，等此前全部命令并被之后的命令等待，HOST-LIVE-01 的「暂停 → 改动 → 恢复」顺序因此不变。暂停越过在途 `start` 时，`start` 在标记运行前放弃，标记之后由既有的作废机制收尾。Qt 侧：`afterQueuedCommands` 等此前**所有**请求结束而不再假设按序应答；`detect` 不再计入 `busy`；新增 `activityKinds`，按钮按自己的那一项进入 loading；连接卡优先显示连接类操作。 |
| HOST-ACTIVITY-01 | 每个桥命令登记一条可读说明，界面展示最靠前的一条（连接类优先）；请求结束即清除，内核退出时整体清空。概览连接卡显示旋转指示与该文案，连接 / 添加手机 / 检查更新按钮按操作进入 loading。 |
| HOST-ACTIVITY-02 | `connectionBlockReason` 与 `startHost()` 的每个守卫一一对应，按钮禁用时用 ToolTip 说明原因（核心启动中 / 读取激活信息 / 等待系统授权 / 切换中继 / 未激活 / 安装 Agent）。内核未就绪时状态文本为「正在启动 Host 核心」，内核已退出则为「需要处理」（原因见消息），不再是「已暂停」。 |
| HOST-ACTIVITY-03 | Agent 页原先写死的「正在检测 Agent…」改为读取同一份活动说明；检测进行中 Agent 行显示「检测中」而不是上一轮结论。Host 在 Claude 探测前先发 `claudeStatus{detecting:true}`，找到可执行文件但版本未读回时仍为 `detecting:true`，Claude 行在检测完成前显示「检测中」，不显示「尚未安装」或「需升级」。 |
| HOST-ACTIVITY-04 | DSH Server 重启分阶段上报 `dshServer{stage}`：等待另一个启动者的锁、停止、启动、连接、应用供应商配置；Host 把在途重启的活动文案替换为当前阶段，重启按钮进入 loading。不做百分比：锁等待与进程启动没有可度量的进度。 |
| HOST-ACTIVITY-05 | 激活凭据的首次读取从 UI 线程（构造函数）移到凭据工作线程。读取期间不显示激活卡、连接按钮说明「正在读取激活信息」；macOS 上超过 1.5 s 仍未返回（钥匙串锁定或应用重签名后的授权框）改为「正在等待系统授权」，并并入 `connectionBlockReason`。依赖已保存 Relay 与 Host ID 的初始化步骤（Relay 地址迁移、身份校验、恢复激活、自动连接）等读取完成再执行。 |

「已在运行」不算阻塞：`m_desiredRunning` 为真时连接按钮仍可用，用于暂停。后台准备（Codex / Claude / DSH）的失败不影响已连上的手机，也不改变 `state`。暂停清除 Codex 与 DSH 的准备状态；Claude 插件登记属于 Host 核心本身，暂停不清除，内核退出时清除。

## 3. 实现

| 文件 | 改动 |
| --- | --- |
| [desktop-command-lanes.ts](../../packages/host/src/desktop-command-lanes.ts) | 新增：命令分类与四类通道调度（HOST-LANE-01） |
| [desktop-bridge.ts](../../packages/host/src/desktop-bridge.ts) | 由单条 Promise 队列改为按通道排入；`claudeIntegration` 改走 `configureClaudeIntegration` |
| [desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts) | 首轮：移除 `#connect` 中的阻塞创建，新增 `#prepareCodex` / `#stopCodex` / `#codexPrepare`，`codexLaunch` 惰性接入，`#detectClaude` 先发 `detecting`。第二轮：`#ensureClaudeIntegration` 后台化并可取消，`configureClaudeIntegration`、`#claudeLauncher`（启动前等在途登记）；`#routing` 后台路由；`#prepareDsh`；`#lifecycleGeneration` 让暂停越过在途 `start`；`restartDshServer` 上报阶段；`codexLaunch` 说明未启用 / 准备中 / 未就绪 |
| [host-service.ts](../../packages/host/src/host-service.ts) | 首轮：`attachCodexRuntime` / `detachCodexRuntime`。第二轮：`relay.start()` 之后后台 `#startDshBackend`，各 kind 的自动恢复在其预启动结束后开始；`prepareDshRuntime`；`stop()` 不再等待在途 DSH 启动 |
| [codex-terminal-server.ts](../../packages/host/src/codex-terminal-server.ts) | 首轮：`signal` 取消与 `onProgress` 上报（按 1 MB 粒度）。第二轮：共享准备记录发起方的 `signal`，被他人取消时重新准备；加入方可以只放弃等待；Release API 请求与解包、发布前同样检查取消 |
| [claude-integration-install.ts](../../packages/host/src/claude-integration-install.ts) | `signal`：在途 `claude plugin` 子命令随之终止，取消后不再执行下一步 |
| [dsh-web-service.ts](../../packages/host/src/dsh-web-service.ts) | `onStage`：锁被占用时报 `waiting`，重启时报 `stopping` / `starting` |
| [HostController.h](../../packages/windows-host/src/HostController.h) / [.cpp](../../packages/windows-host/src/HostController.cpp) | `activity`（连接类优先）、`activityKinds`、`connectionBlockReason`、`claudeDetecting`、`preparations`（`codexTerminal` 由其派生）、`credentialsLoading`、`awaitingSystemAuthorization`；`afterQueuedCommands` 等此前全部请求；`detect` 为后台请求；`loadStoredActivation` / `afterStoredActivation`；`beginActivationIO` / `endActivationIO` |
| [Main.qml](../../packages/windows-host/src/qml/Main.qml) | 概览活动行与按钮 loading（读 `activityKinds`）、连接原因 ToolTip、状态文本（读取激活信息 / 等待系统授权 / 内核退出）、Agent / Claude 三态、Codex / Claude / DSH 准备状态、Claude 登记失败提示、读取激活信息期间隐藏激活卡 |

界面表现：准备期间对应 Agent 行显示「正在准备」（Codex 下载时为「准备中 N%」并显示字节进度条），失败给出后果说明（「Codex 终端接入未就绪，Codex 会话暂时不可用」「Claude Code 插件未登记，终端里运行的 Claude Code 暂时不会连接 Orbis」），准备完成即隐藏。DSH 准备失败只写日志：手机打开 DeepSeek 时会按需重试。

## 4. 与既有决定的关系

- **ADR-0021 SC75**：来源判定（版本匹配的独立 `codex-app-server` + `--session-source`）不变，只把「准备何时发生」从连接前改为连接后。ADR-0021 的 2026-11-13 修订记录了这一改动及第二轮的事件名与取消修正。
- **ADR-0075 HOST-LIVE-01**：暂停恢复语义不变。「暂停 → 改动 → 恢复」中的改动命令是独占命令，仍排在暂停之后、恢复之前；新增的取消点挂在同一次 `#dispose()` 与 `#desired` 判定上，被放弃的准备不会把后端挂到新服务。
- **ADR-0033**：插件仍只通过 Claude Code 自己的插件命令登记；变化只在何时执行和可取消。Host 打开的 Claude Code 在插件未登记时仍按原逻辑一次性带 `--plugin-dir`。
- **ADR-0020**：DSH Web 服务的发现、锁和外部地址规则不变；预启动改由服务的 DSH 槽位发起。
- **ADR-0070**：界面约定记在 ADR-0070 的同日条目里；本文不重复视觉规范。
- **ADR-0079**：`--session-source` 仍是独立二进制的参数；`codex app-server` 子命令与 `codex remote-control` 依旧硬编码 `vscode`，本文不改变这一事实。

## 5. 首轮审计出的阻塞点及处理

| # | 位置 | 原状 | 处理 |
| --- | --- | --- | --- |
| 1 | `#ensureClaudeIntegration` → `claude-integration-install.ts` | 4 个 `claude` 子命令（各 60 s）在 `initialize` 应答前和连中继前各跑一次 | HOST-PREP-04 |
| 2 | `desktop-bridge.ts` 命令队列 | 全局串行，`detect`（约 25 s）排在 `start` 前面 | HOST-LANE-01。初始化回调的 `detectAgents(true)` → `startHost()` 顺序保留，二者现在并行 |
| 3 | `host-service.ts` `start()` 与 `#connect` | DSH 预启动与会话发现都在 `relay.start()` 之前 | HOST-PREP-05 |
| 4 | `desktop-runtime.ts` `initialize()` | 登录环境、路由启动、Claude 登记都在 Qt 置 `m_bridgeReady` 之前 | HOST-PREP-04 / 06；登录环境采纳按原判断保留在前 |
| 5 | `CredentialStore` 首次读取 | 构造函数里在 UI 线程同步读钥匙串，可能等授权框 | HOST-ACTIVITY-05。其余凭据读写此前已在凭据工作线程 |
| 6 | `restartDshServer` | 锁等待最长 60 s，只有一行文案 | HOST-ACTIVITY-04 |
| 7 | `restoreActivation` / `renameDevice` / `revoke` | 已有活动文案 | 不再单独处理 |

补充审计：Relay 服务端（`packages/relay/src/index.ts`）在 `listen()` 之前只读取本地文件（Web 资源、推送令牌、设备状态、管理与带宽记录），没有网络等待，不改动。移动端冷启动仍未审计，不在本文范围。

## 6. 已执行验证

证据目录：首轮 [`.artifacts/host-activity-20261113/`](../../.artifacts/host-activity-20261113/) 与 [`.artifacts/codex-terminal-async-prep-20261113/`](../../.artifacts/codex-terminal-async-prep-20261113/)；第二轮 [`.artifacts/host-startup-blocking-20261113/`](../../.artifacts/host-startup-blocking-20261113/verification.md)。

第二轮（全部在本机 macOS 执行）：

| 验证 | 实际结果 |
| --- | --- |
| `npm run typecheck`（`tsc -b` + `tsconfig.tests.json`） | 通过。首轮提交后的 `main` 两项均失败，见第 8 节 |
| `npx eslint packages/host/src` | 通过 |
| `desktop-command-lanes.test.ts`（新增） | 6 通过：检测中仍可连接；暂停越过在途连接而下一次连接等暂停；独占改动对两条通道有序；暂停等独占、退出等后台；失败不阻断后续 |
| `desktop-runtime.test.ts` | 28 通过。新增：插件登记在途时 `initialize` 应答且中继连上、关闭 Host 取消登记；设置开关先取消自动登记、开关成功后清除上次自动登记的失败；暂停取消尚未标记运行的连接、握手中暂停 2 s 内返回；路由未完成时可初始化而 Codex 等路由。改写：HOST-LIVE-01 恢复用例按 DSH 连中继后预启动的新顺序断言，并要求暂停不等在途 DSH。补充：Claude 版本读取中仍为 `detecting:true` |
| `codex-terminal-server.test.ts` | 25 通过。新增：他人取消的共享准备会重新准备；加入方可只放弃等待 |
| `host-service.test.ts` | 83 通过。新增：DSH 会话发现挂起时中继照常连上、暂停 2 s 内返回 |
| `dsh-web-service.test.ts` / `desktop-installation.test.ts` | 18 通过 2 跳过 / 19 通过。新增锁等待阶段；重启阶段事件 |
| 反向对照 | 上述新增的 Node 用例在改动前实现上全部失败（超时或断言失败），在改动后通过 |
| `vitest run packages/host/src` | 1781 通过、9 跳过；`codex-tool-runtime.test.ts` 2 项失败，在本工作树改动前的 `main` 上同样失败，原断言保留 |
| Qt 6.8.3 构建（含 QML 编译）与 `ctest` | 10/10，连续三次通过。`HostLiveChangeTest` 新增：凭据读取不阻塞构造且在 macOS 显示等待系统授权；乱序应答时续作等全部更早请求；后台检测不进 `busy`、连接类活动优先、按 kind 的准备状态与暂停清理；DSH 重启阶段文案；内核退出不是「正在启动」。`HostActivationTest` 中依赖构造即读出凭据的用例改为先等读取完成 |
| `--smoke-test` `--smoke-guide` / `--smoke-agents` / `--smoke-compact` / `--smoke-appearance`（隔离数据目录，真实桥） | 均退出 0，`bridgeReady:true`，日志无 QML 错误 |

环境限制同首轮：本机无屏幕录制权限，未传 `--screenshot`，没有视觉截图。

## 7. 未验证与交付状态

- 实现：已完成（第 2 节全部场景）。部署：未部署，未替换本机正在运行的 Host。自动验证：见第 6 节。用户验收：**待用户验证**。
- 候选安装包（2026-11-13）：由 `ee40d57` 经共享打包入口构建的 `OrbisHost-0.1.19-ee40d57-macos-arm64.dmg`（arm64 Release，ad-hoc 签名、未公证，116926205 字节，SHA-256 `ed5fedf0b16a0d07081491ae248383410357cbb844fb12366e4683d80d0ca0be`），打包 23 个阶段全部通过（含原生测试、打包后冒烟、线协议兼容、dmg 校验），已上传到 Orbis-QA Release `cand-ee40d57` 并下载回读核对哈希。人工回归登记为 QA 提交 `SB-63ec35126593` / 任务 `AT-7c704b3472fb4dc6`（[Orbis-QA #21](https://github.com/WGooold/Orbis-QA/issues/21)），安装步骤见该 Issue 评论。Windows 安装包未构建：候选分支未推送，Windows 节点取不到该提交。
- 真实网络与系统条件未覆盖：133 MB 下载的限速、断网与中途暂停；真实 `claude plugin` 命令耗时；钥匙串锁定时的授权框；DSH 锁被另一个 Host 占用。
- Windows 构建、Windows 安装、真实手机连接与视觉验收**待用户验证**。

安装后建议逐项确认：启动初期读作「正在启动 Host 核心」或「正在读取激活信息」而不是「已暂停」；钥匙串弹授权框时窗口已出现并显示「正在等待系统授权」；Agent 检测进行中「开始连接」「添加手机」仍可用；连接中途点「暂停连接」立即生效；Claude 行先显示「检测中」，首次打开时可短暂显示「正在准备」；开启「预启动 DeepSeek」后手机先连上、DeepSeek 行随后就绪；Codex 升级后手机能立刻连上、Codex 行显示准备百分比；「重启 DSH Server」期间文案随阶段变化。

## 8. 对首轮提交的审查（7c9d761 / 664aa1f / 26ec691）

| 问题 | 后果 | 处理 |
| --- | --- | --- |
| `host-service.ts` 的 `detachCodexRuntime` 把 `undefined` 赋给可选属性 | `tsc -b` 失败，`npm run build` / `npm run typecheck` 不能通过；首轮记录的「类型检查通过」不成立 | 改为 `delete` |
| `codex-terminal-server.test.ts` 的 `fetch` mock 只声明一个参数却用两个 | `tsconfig.tests.json` 类型检查失败 | 改用带 `init` 的泛型签名 |
| 共享准备以目标目录去重，不记录发起方的取消信号 | 暂停后立即恢复时，恢复方加入被暂停方取消的下载，报出准备失败（实为对方的 abort），Codex 直到下次重启不可用 | HOST-PREP-02 第二轮修正，含回归用例 |
| `#detectClaude` 在读版本前发出 `{installed:true, compatible:false}` 且不带 `detecting` | 版本读取期间（可达数秒）Claude 行显示「需升级」，HOST-ACTIVITY-03 只覆盖了查找可执行文件那一瞬 | 中间事件带 `detecting:true`；概览在检测中不把 Claude 标为需修复 |
| `activityFor` 为 `activate` / `requestCode` 登记文案 | 二者不是桥命令（激活走 HTTP），属死代码 | 删除 |
| `activateInstallation` 的活动类型为 `agents` | 切换版本期间所有 Agent 行显示「检测中」 | 改为 `agentVersion` |
| 内核反复崩溃或安装不完整时 `bridgeReady` 永久为假 | 概览一直显示「正在启动 Host 核心」，按钮原因为「Host 核心正在启动」 | 内核已退出时显示「需要处理」与「Host 核心未运行」 |
| `codexLaunch` 恒定存在且固定说「正在准备」 | 未启用或准备失败时日志误报原因（行为仍回退到独立 CLI，无功能错误） | 按未启用 / 准备中 / 未就绪给出原因 |
