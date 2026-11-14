# ADR-0075：Host 确认退出与更新前后台收尾

日期：2026-11-12

Status: accepted（已实现；macOS 自动验证完成；Windows 验证、发布与用户验收待完成）

关联：ADR-0014、0020、0022、0051、0058、0064。

## 问题

桌面 Host 原先只向 Node 核心发送排队执行的 shutdown，并在 UI 线程等待最多 45 秒。超时后的强制结束只针对直接子进程。DeepSeek Web 被设计为独立常驻，Codex 桌面桥接也独立于 Host 窗口存活；这些进程可能继续使用 Host 安装目录中的运行时。退出窗口、暂停连接、退出应用和允许覆盖安装缺少统一的确认及收尾条件。

## 决策

| 场景 ID | 行为 |
| --- | --- |
| HOST-EXIT-01 | 托盘退出、原生 Quit（含 Cmd+Q）和无托盘时关闭窗口先显示确认。提示手机断开、相关后台关闭和任务中断；取消保持运行。有关托盘时关闭窗口仍沿用隐藏到托盘。 |
| HOST-EXIT-02 | 确认后默认关闭 Host 核心及已确认归属的后台，包括 Orbis 管理的 DSH Web；Codex 桌面桥接见 HOST-EXIT-06。独立收尾进程负责等待、升级终止与退出核验，UI 保持响应。 |
| HOST-EXIT-03 | 同时识别此前保留的 version-1 DSH 记录；读取旧记录时核验服务、命令与监听进程归属。 |
| HOST-EXIT-04 | 进程身份由 PID、创建时间和可执行路径共同确定。核心进程还须匹配直接父进程和脚本；每次发信号前重新核对身份。保留已采集的后代身份以应对父进程先退出，不按 node / codex 名称批量清理。 |
| HOST-EXIT-05 | 收尾验证成功后将退出许可暴露给 QML，窗口关闭不再进入托盘隐藏或确认流程。排队关闭窗口和托盘，并结束应用事件循环；已确认的退出不再重新请求平台 Quit。取消和收尾失败不授予退出许可。 |
| HOST-EXIT-06 | Codex 桌面桥接沿用 Codex 桌面端的生命周期：退出和更新都不停止它，也不核验它的端点记录；Host 再次开始连接后按端点记录重新接入。收尾失败时 Host 窗口回到前台显示原因。 |
| HOST-UPDATE-01 | 应用内 Host 更新先确认中断影响，再下载和校验；成功收尾后才打开安装包。重复点击只执行一次；下载、校验、收尾或启动安装包失败均保持可见失败状态。下载期间仍可请求退出。 |
| HOST-UPDATE-02 | Windows 安装器通过 `--prepare-update` 请求已有 Host 展示确认。取消或失败暂停安装。应用内已收尾的更新传递专用参数，避免二次确认，并在安装完成后重新打开 Host。 |
| HOST-LIVE-01 | 运行中的 Host 不再要求先手动暂停：常规设置中的启动参数（电脑名称、中继、预启动开关、DSH 启动链接）、Agent 安装 / 批量更新和 DSH Server 重启由 Host 自行暂停、执行并恢复连接；终端接入开关与登录启动仍即时生效。操作按钮写明“并重新连接”，有在线会话时确认页显示会暂时断开的会话数。 |
| HOST-LIVE-02 | 退出期间完成的变更不再自动恢复连接。启动入口在改写运行意图前核对退出状态；收尾失败后，原先暂停的 Host 保持可由用户重新启动。 |

暂停连接继续只释放 Host 的连接及适配器，不等同于退出。显式配置的外部 DSH URL 与独立终端沿用所属启动器的生命周期。若收尾期间 Orbis 管理的后台被重新启动，报告失败并要求关闭该应用后重试。DSH 的管理范围沿用同一 `DSH_HOME` 下的 Orbis 服务记录。

退出过程先在独立进程采集身份与树关系，再通知核心正常保存、断连。正常退出等待为 10 秒，之后对确认归属的存活进程执行分阶段终止并核验。桌面控制器另有 60 秒收尾期限；超时只显示失败，不进入安装。旧记录的 PID 已失效但端口仍被占用，或收尾期间出现新后台记录，均暂停退出 / 安装并保留记录，要求关闭对应应用后重试。强制终止可能中断在途任务；已有历史、激活、配对和配置不由收尾程序删除。部分收尾失败后只重启核心供诊断与重试，连接由用户显式恢复。

Host 更新的哈希与文件提交移到后台线程，使用独立临时目录和原子文件提交。确认弹窗复用 `SoftDialog`、`SoftDialogButtons` 与现有动效。macOS 应用内更新完成收尾后打开 DMG，仍由用户拖入 Applications；手动下载的 DMG 先通过 Host 的退出确认完成收尾。

本次不改变 Relay / App 线协议或自动更新 Agent 的语义。Agent 安装的暂停由 HOST-LIVE-01 自动处理，安装确认继续适用。系统强制结束、应用崩溃、独立终端生命周期和完整安装事务回滚不属于本次已验证保证；安装器的文件占用检测继续保留。

## 实现

- [HostController](../../packages/windows-host/src/HostController.cpp)：确认入口、异步收尾、更新验证与失败恢复。
- [main.cpp](../../packages/windows-host/src/main.cpp)、[ExitGuard](../../packages/windows-host/src/ExitGuard.h)：托盘 / 原生退出保护、单实例安装器请求及应答。
- [Main.qml](../../packages/windows-host/src/qml/Main.qml)：退出、应用内更新、外部安装器确认和收尾进度。
- [desktop-shutdown.ts](../../packages/host/src/desktop-shutdown.ts)、[owned-processes.ts](../../packages/host/src/owned-processes.ts)：独立收尾协议、旧记录识别、进程树与身份核验。
- [OrbisHost.iss](../../packages/windows-host/installer/OrbisHost.iss)：安装前请求与应用内更新后的重新启动。

## 已执行验证

证据目录：[`.artifacts/host-exit-update-20261112/`](../../.artifacts/host-exit-update-20261112/)。测试使用隔离数据和合成进程，没有退出、更新或终止本机真实 Host、DSH 或 Codex 会话。

| 验证 | 实际结果与证据 |
| --- | --- |
| 退出 / 更新相关 Node 回归 | 8 文件，92 通过、2 个 Windows 专属用例跳过；[targeted-complete.log](../../.artifacts/host-exit-update-20261112/targeted-complete.log)。覆盖真实挂起进程、脱离父进程的后代、无关进程保留、PID 复用、其他 Host、Windows 路径拼写、旧 DSH / Codex 记录与历史保留，以及失效 PID 对应存活端口、收尾期间替换 / 首次登记后台。 |
| 全量 Node 回归 | 首次完整执行 202 文件，2167 通过、4 失败、9 跳过；[原始结果](../../.artifacts/host-exit-update-20261112/vitest-all.log)。后续新增的身份、端口和并发登记用例已由定向回归覆盖。全量结果不记为通过。 |
| 全量失败复核 | 4 项失败集中在 `macos-terminal.test.ts`、`codex-terminal-macos.test.ts`、`desktop-terminal.test.ts`，仍期待原启动参数；工作树其他修改加入了 `check_for_update_on_startup=false` 和 Claude 启动环境。原断言未修改；同环境仅执行这三个文件仍为 4 失败 / 19 通过，见 [复核](../../.artifacts/host-exit-update-20261112/unrelated-failures-confirmation.log)。 |
| TypeScript / lint | 运行时构建、测试类型检查和本次新增 TS 文件 ESLint 通过；[构建](../../.artifacts/host-exit-update-20261112/runtime-build-complete/)、[类型检查](../../.artifacts/host-exit-update-20261112/types-complete.log)、[ESLint](../../.artifacts/host-exit-update-20261112/lint-complete.log)。 |
| macOS 原生构建 / CTest | Qt 6.8.3 构建通过，8 组 CTest 全部通过；[最终原生构建](../../.artifacts/host-exit-update-20261112/build-quit-regression/)、[native-tests-verify](../../.artifacts/host-exit-update-20261112/native-tests-verify/)。`HostExitTest.cpp` 覆盖确认前不执行、异步完成、重复确认、收尾失败 / 超时、原生 Quit、下载失败、校验失败、安装器启动失败、成功更新顺序及下载时退出请求。 |
| 真实收尾子进程协议 | 最终编译的 `desktop-shutdown.js` 对隔离挂起核心完成 ready → proceed → done，核心经升级终止退出，辅助进程退出 0，所属进程已清理；[协议证据](../../.artifacts/host-exit-update-20261112/protocol-complete/shutdown-protocol.json)。 |
| 首轮 QML 窗口 / 安装器 IPC | 当时隔离 smoke 退出 0，三个确认弹窗可展示和取消，安装器取消返回 20；[结果](../../.artifacts/host-exit-update-20261112/smoke-complete/result.json)。但 smoke 绕过 `ExitGuard`，且没有断言退出许可、窗口关闭与托盘移除，**不足以证明实际退出流程正确**。原截图、结果和清理证据保留；原生退出结论由下方 HOST-EXIT-05 回归替代。 |

测试源码：[desktop-shutdown.test.ts](../../packages/host/src/desktop-shutdown.test.ts)、[HostExitTest.cpp](../../packages/windows-host/src/tests/HostExitTest.cpp) 及上述相关生命周期用例。共享探针为 `~/.orbis/tools/ui-regression/host-shutdown-probe.py`、`host-confirmation-smoke.py`，参数见 `--help`。构建和原生运行均使用共享构建租约；清理与释放结果保存在各证据子目录。

## HOST-EXIT-05：清理完成后的主程序退出修复

原 `Main.qml.onClosing` 无条件拒绝窗口关闭，即使控制器已经授予退出许可，也会重新进入隐藏 / 请求退出分支。新增回归直接执行该实际 QML 处理器，修复前有托盘、无托盘两项均失败：[首次失败证据](../../.artifacts/host-exit-native-quit-20261112/window-before-fix/run.log)。隔离 Cocoa 主进程流程未稳定复现全部现场症状；该窗口拒绝关闭缺陷已被确定复现，不能把它写成对现场全部原因的证明。

最终退出改为 `exitReady` 后排队关闭窗口、移除托盘并调用 `QCoreApplication::exit(0)`。首次用户 Quit 仍由统一确认拦截；不使用 smoke 特例放行。测试最终必须同时记录 `exitApproved=true`、`bridgeReady=false`、`windowVisible=false`、`trayVisible=false` 以及主进程退出 0，缺少证据或超时均失败。分别通过原生 Quit 与真实托盘 QAction 入口运行；自动化调用原生退出请求，物理键盘 ⌘Q 与用户安装验证仍需手动验收。

| 修复验证 | 实际结果与证据 |
| --- | --- |
| 原生构建与全部 CTest | 当前工作树 9 组全部通过，包含 `approvedWindowClose` 两项以及原有取消、收尾失败、超时和安装失败测试；[构建](../../.artifacts/host-exit-native-quit-20261112/build-final/)、[CTest](../../.artifacts/host-exit-native-quit-20261112/ctest-fixed/run.log)。 |
| macOS Cocoa 原生 Quit | 实际窗口取消三种确认后确认退出，最终四项状态符合断言、进程退出 0，安装器 IPC 取消返回 20；[结果](../../.artifacts/host-exit-native-quit-20261112/cocoa-native-fixed/result.json)、[所属进程无残留、租约已释放](../../.artifacts/host-exit-native-quit-20261112/cocoa-native-fixed-lease/cleanup.json)。 |
| macOS Cocoa 托盘 QAction | 独立执行托盘动作的取消和确认退出，最终四项状态符合断言、进程退出 0；[结果](../../.artifacts/host-exit-native-quit-20261112/cocoa-tray-fixed/result.json)、[所属进程无残留、租约已释放](../../.artifacts/host-exit-native-quit-20261112/cocoa-tray-fixed-lease/cleanup.json)。 |

此轮只修复原生退出收尾和测试，不修改 Node 进程清理算法；首轮 Node 结果保留，未重复执行全量 Node。测试继续使用隔离状态，没有强制结束真实 Host / Agent 会话。尚未替换用户安装版本；macOS 安装后通过托盘和 ⌘Q 各执行一次取消与确认，并检查 Dock、托盘和活动监视器中的 Host 主进程，**待用户验证**。

## HOST-EXIT-06：Codex 桌面桥接不随 Host 收尾

原设计假设 Codex 桌面桥接停止后需要用户重新打开桌面端，重新拉起只作为偶发情况按失败处理。现场 Codex 桌面端在桥接退出后约 1 秒内重新拉起新的桥接并写入端点记录，收尾核对报“后台已重新启动”，Host 恢复运行并重启核心；只要 Codex 桌面端开着，退出基本必然失败，而停止桥接本身只会中断桌面端任务。现场进程时间线：桥接 10:49:57 由 ChatGPT 重新拉起，Host 核心 10:49:58 由收尾失败路径重启。

桥接在 Windows 上使用暂存到 `%LOCALAPPDATA%\Orbis\wrapper` 的 launcher 与 node，实现脚本从安装目录只读一次，运行时不含原生模块，因此不占用 Host 安装目录；macOS 不受文件占用影响。更新收尾因此同样不处理桥接，安装器的文件占用检测继续保留。旧版 Host 迁移时安装器的手动关闭提示不变。

实现：[desktop-shutdown.ts](../../packages/host/src/desktop-shutdown.ts) 不再采集 Codex 端点记录；[main.cpp](../../packages/windows-host/src/main.cpp) 收尾失败时显示窗口；[Main.qml](../../packages/windows-host/src/qml/Main.qml) 三处确认文案去掉 Codex 桌面桥接。另修正 [codex-desktop-wrapper.ts](../../packages/host/src/codex-desktop-wrapper.ts) 定期重发比较时漏掉末尾换行、导致每 5 秒重写端点文件的问题。

回归：[desktop-shutdown.test.ts](../../packages/host/src/desktop-shutdown.test.ts) 的 Codex 用例在收尾期间替换端点记录，断言原桥接与新桥接均存活、记录保持为新值、收尾成功；修复前该用例以“后台已重新启动”失败（[首次失败证据](../../.artifacts/host-exit-codex-respawn-20261113/before-fix/run.log)）。原 Codex 归属、失效端口、首次登记与替换用例改由 DSH 记录覆盖同一核验逻辑。

| 验证 | 实际结果与证据 |
| --- | --- |
| 收尾 Node 回归 | 13 项通过；[after-fix](../../.artifacts/host-exit-codex-respawn-20261113/after-fix/desktop-shutdown.log)。包装器 4 项、测试类型检查与 ESLint 通过，见同目录。 |
| macOS 安装包 | 以 `7bb384b` 加已安装的 HOST-ACT-13 覆盖文件与本修复构建，未混入工作树其他改动；类型构建、原生构建、打包、签名、架构、内置 smoke 与线协议兼容全部通过；[清单](../../.artifacts/host-exit-codex-respawn-20261113/package/build-manifest.json)。 |
| 本机安装 | 用户先退出 ChatGPT 与旧 Host 后安装到 `/Applications/OrbisHost.app` 并启动，运行中的二进制哈希与候选一致，回退保留为 `/Applications/.OrbisHost-rollback-codex-respawn-20261113.app`；[记录](../../.artifacts/host-exit-codex-respawn-20261113/verification.json)。 |

Codex 桌面端开着时的真实退出、重新打开 Host 后重新接入，**待用户验证**；Windows 安装目录在桥接运行时可覆盖仍待 Windows 验证。

## HOST-LIVE-01：运行中修改无需手动暂停

控制器在原有串行命令队列上实现“暂停 → 变更 → 恢复”：变更前发送 `stop`，在队列中最后一个请求完成（成功或失败）后恢复；恢复期间状态显示“完成后自动恢复”，连接按钮不可用。中继地址变更会清除激活，此时停在待激活状态。暂停后的 Host 清空在线会话、后端事实，并把手机路径置为离线；运行时在释放服务后重新公告状态。用户显式暂停仍持久化为不自动连接，自动恢复不改写该设置。

暂停可能落在一次重连尝试建后端的过程中。`start` 等待被放弃的尝试收尾后再开始；被放弃的尝试释放它在暂停之后建出的后端，其服务读取的 Codex 桌面版生命周期绑定到本次尝试，暂停后不再抛出未处理的拒绝。

实现：[HostController](../../packages/windows-host/src/HostController.cpp)（`pauseForChange` / `afterQueuedCommands` / `clearRunningFacts`）、[desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts)、[Main.qml](../../packages/windows-host/src/qml/Main.qml) 设置页与安装 / DSH 重启确认。回归：[HostLiveChangeTest.cpp](../../packages/windows-host/src/tests/HostLiveChangeTest.cpp)（真实 node 子进程模拟桥接，核对 `stop → 变更 → start` 顺序、失败后恢复、已暂停时不自动连接、仅连接参数触发重连、中继变更停在待激活、暂停清空运行事实）与 [desktop-runtime.test.ts](../../packages/host/src/desktop-runtime.test.ts) 中按“建后端 / 建服务”两个暂停点参数化的恢复用例。

| 验证 | 实际结果与证据 |
| --- | --- |
| 恢复用例对照 | 原运行时两项均以“Host 已在运行，请先暂停连接”失败；去掉放弃尝试的释放后，“建后端”项残留旧 DSH 后端；改回未绑定的生命周期读取后出现未处理拒绝；修复后两项通过。见 [ts/](../../.artifacts/host-live-config-20261112/ts/)。 |
| 原生变异对照 | 停用暂停后 4 项失败，停用暂停时清空事实后 1 项失败，见 [mutation-no-pause](../../.artifacts/host-live-config-20261112/logs/mutation-no-pause/run.log)、[mutation-no-clear](../../.artifacts/host-live-config-20261112/logs/mutation-no-clear/run.log)。 |
| 当前工作树 | 桌面运行时 21 项通过，类型检查与 ESLint 通过，macOS Qt 6.8.3 构建与 10 组 CTest 全部通过；汇总见 [verification.json](../../.artifacts/host-live-config-20261112/verification.json)。 |

真实 Relay、真实手机与 Windows 上的暂停 / 恢复未执行，**待用户验证**。

2026-11-13 `HOST-LIVE-02`：`HostLiveChangeTest::lateChangeCompletionDuringExitKeepsHostRestartable` 复现变更续作在退出期间把状态置为连接中，但实际启动命令被拒绝，收尾失败后也无法再次启动。`startHost` 增加退出 / 关闭守卫。首次失败保留在 [before/checks/result.json](../../.artifacts/recent-risk-fixes-20261113/native/before/checks/result.json)；修复后激活、退出、运行中变更三组 Qt 回归全部通过，见 [after/checks/tests.txt](../../.artifacts/recent-risk-fixes-20261113/native/after/checks/tests.txt)。验证使用 macOS Qt 6.8.3、隔离桥接进程及 `ORBIS_NO_KEYCHAIN=1`，没有操作真实 Host 或系统激活凭据；Windows 构建和用户验收待完成。

## Windows 必须补做的验证

以下均未在本机执行，不以 macOS 结果代替。使用 Windows 10 / 11 x64 的隔离用户、隔离 Host 状态和合成会话；保留安装日志、进程身份 / 父子关系、端口、文件哈希、退出码和确认界面截图。

1. **工具链与全部自动回归**：`npx vitest run --maxWorkers=2`、类型检查、原生 CTest，以及 `scripts/windows/windows-host-build.ps1 -Package -InnoCompiler <ISCC.exe>`。不得跳过 Windows 专属 DSH 重启测试；确认打包包含新增两个 JS 模块，Inno 编译成功。
2. **退出各入口与取消**：托盘退出、应用原生 Quit（平台提供时）、无托盘关闭窗口分别显示提示。取消、Esc 不断开手机、不结束任务；重复操作只出现一个有效收尾流程。关闭普通窗口仍隐藏到托盘。确认后必须观察主窗口、托盘图标和 Host EXE 进程全部退出，不能只以后台进程已清理为通过；运行 `HostExitTest::approvedWindowClose` 的两组场景。
3. **真实进程树与文件占用**：核心运行时、DSH npm / pnpm / cmd / PowerShell 启动器以及嵌套子进程全部纳入对应归属核对；正常、忽略退出、核心命令队列卡住分别验证。确认后所属进程退出、监听端口释放、安装目录 EXE / DLL 可替换；无关 Node、外部终端、显式外部 DSH 及 Codex 桌面桥接仍运行，且桥接运行时安装目录同样可替换。额外核对 PowerShell 无监听结果被当作空集合、CIM / 端口查询权限错误被当作失败，不能错误放行或在空端口时阻塞安装。
4. **旧端兼容与同版正对照**：执行时从官网取得最近已发布安装包并记录版本、哈希与架构。用其真实旧 DSH 记录并保持 Codex 桌面端运行，升级到新版，再以新版 → 新版重复同样场景。旧 Host 不认识 `--prepare-update` 时会拒绝该参数；安装器显示手动关闭确认，由用户关闭旧 Host、DSH Web 与 Codex 桌面端。取消不得写安装目录；继续时仍由文件占用检测阻止带占用覆盖。此首轮迁移为手动路径，不能写成自动清理旧 Host 已验收。
5. **应用内更新**：在有活动任务时确认 / 取消，校验后停止后台，再进入安装；成功只重启一次 Host。验证激活、配对、供应商配置及历史保留，Codex Desktop 全程保持运行，新版 Host 启动后重新接入桥接。断网、HTTP 失败、错误 SHA、磁盘写入失败、后台重生、收尾拒绝及安装器启动失败均不能被报告成更新成功。
6. **直接运行安装器**：Host 已开、仅托盘、未开但有旧后台三种状态；`--prepare-update` 的单实例应答和安装器等待均可完成。拒绝 / Esc 返回非零并暂停安装；确认且核验成功才允许覆盖。测试 `--prepare-update` 超时、IPC 断开及重复安装请求，不得留下第二个 Host。
7. **路径、身份与回退**：含空格 / 中文的用户与安装目录、盘符大小写和正反斜杠、已失效 PID、同名无关进程、另一隔离 Host 实例。只处理确认归属的进程；识别不足时暂停并提示。随后安装已验证的上一可用包并检查重新连接，保留回退包及相关证据。

## 交付与验收

实现、自动验证、安装发布与用户验收分别记录。本次只生成本机验证构建，没有安装到 `/Applications`、发布 Windows 安装器或更新官网下载。Windows 结果补齐且全量既有失败解决后再进行发布判断。

用户安装验收：安装后选择托盘“退出 Orbis”，先取消一次，再确认；重新打开后点击“更新 Host”，确认能够提示、收尾并进入安装。Windows 也需直接运行新版安装器验证覆盖流程；macOS 使用更新包拖入 Applications。以上均为**待用户验证**。
