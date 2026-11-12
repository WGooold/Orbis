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
| HOST-EXIT-02 | 确认后默认关闭 Host 核心及已确认归属的后台，包括 Orbis 管理的 DSH Web 和当前状态目录登记的 Codex 桌面桥接。独立收尾进程负责等待、升级终止与退出核验，UI 保持响应。 |
| HOST-EXIT-03 | 同时识别此前保留的 version-1 DSH 记录和 schema-1 Codex 桥接记录；读取旧记录时核验服务、命令与监听进程归属。 |
| HOST-EXIT-04 | 进程身份由 PID、创建时间和可执行路径共同确定。核心进程还须匹配直接父进程和脚本；每次发信号前重新核对身份。保留已采集的后代身份以应对父进程先退出，不按 node / codex 名称批量清理。 |
| HOST-UPDATE-01 | 应用内 Host 更新先确认中断影响，再下载和校验；成功收尾后才打开安装包。重复点击只执行一次；下载、校验、收尾或启动安装包失败均保持可见失败状态。下载期间仍可请求退出。 |
| HOST-UPDATE-02 | Windows 安装器通过 `--prepare-update` 请求已有 Host 展示确认。取消或失败暂停安装。应用内已收尾的更新传递专用参数，避免二次确认，并在安装完成后重新打开 Host。 |

暂停连接继续只释放 Host 的连接及适配器，不等同于退出。显式配置的外部 DSH URL 与独立终端沿用所属启动器的生命周期。Codex 桌面桥接停止后，桌面端需要重新打开；若外部应用在收尾期间重新启动后台，报告失败并要求关闭该应用后重试。DSH 的管理范围沿用同一 `DSH_HOME` 下的 Orbis 服务记录。

退出过程先在独立进程采集身份与树关系，再通知核心正常保存、断连。正常退出等待为 10 秒，之后对确认归属的存活进程执行分阶段终止并核验。桌面控制器另有 60 秒收尾期限；超时只显示失败，不进入安装。旧记录的 PID 已失效但端口仍被占用，或收尾期间出现新后台记录，均暂停退出 / 安装并保留记录，要求关闭对应应用后重试。强制终止可能中断在途任务；已有历史、激活、配对和配置不由收尾程序删除。部分收尾失败后只重启核心供诊断与重试，连接由用户显式恢复。

Host 更新的哈希与文件提交移到后台线程，使用独立临时目录和原子文件提交。确认弹窗复用 `SoftDialog`、`SoftDialogButtons` 与现有动效。macOS 应用内更新完成收尾后打开 DMG，仍由用户拖入 Applications；手动下载的 DMG 先通过 Host 的退出确认完成收尾。

本次不改变 Relay / App 线协议或自动更新 Agent 的语义。Agent 安装原有的暂停连接与安装确认继续适用。系统强制结束、应用崩溃、独立终端生命周期和完整安装事务回滚不属于本次已验证保证；安装器的文件占用检测继续保留。

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
| 实际 QML 窗口 / 安装器 IPC | 隔离 smoke 退出 0，依次展示并取消三个确认弹窗，最后确认退出并完成真实收尾和原生 Quit；第二个 Host 进程通过 `--prepare-update` 发出请求，取消后退出码 20。截图检查无截断 / 重叠；[结果](../../.artifacts/host-exit-update-20261112/smoke-complete/result.json)、[退出](../../.artifacts/host-exit-update-20261112/smoke-complete/preview.png.exit.png)、[更新](../../.artifacts/host-exit-update-20261112/smoke-complete/preview.png.update.png)、[安装器](../../.artifacts/host-exit-update-20261112/smoke-complete/preview.png.installer.png)、[无残留与租约释放](../../.artifacts/host-exit-update-20261112/smoke-complete-lease/cleanup.json)。 |

测试源码：[desktop-shutdown.test.ts](../../packages/host/src/desktop-shutdown.test.ts)、[HostExitTest.cpp](../../packages/windows-host/src/tests/HostExitTest.cpp) 及上述相关生命周期用例。共享探针为 `~/.orbis/tools/ui-regression/host-shutdown-probe.py`、`host-confirmation-smoke.py`，参数见 `--help`。构建和原生运行均使用共享构建租约；清理与释放结果保存在各证据子目录。

## Windows 必须补做的验证

以下均未在本机执行，不以 macOS 结果代替。使用 Windows 10 / 11 x64 的隔离用户、隔离 Host 状态和合成会话；保留安装日志、进程身份 / 父子关系、端口、文件哈希、退出码和确认界面截图。

1. **工具链与全部自动回归**：`npx vitest run --maxWorkers=2`、类型检查、原生 CTest，以及 `scripts/windows/windows-host-build.ps1 -Package -InnoCompiler <ISCC.exe>`。不得跳过 Windows 专属 DSH 重启测试；确认打包包含新增两个 JS 模块，Inno 编译成功。
2. **退出各入口与取消**：托盘退出、应用原生 Quit（平台提供时）、无托盘关闭窗口分别显示提示。取消、Esc 不断开手机、不结束任务；重复操作只出现一个有效收尾流程。关闭普通窗口仍隐藏到托盘。
3. **真实进程树与文件占用**：核心运行时、Codex app-server、DSH npm / pnpm / cmd / PowerShell 启动器以及嵌套子进程全部纳入对应归属核对；正常、忽略退出、核心命令队列卡住分别验证。确认后所属进程退出、监听端口释放、安装目录 EXE / DLL 可替换；无关 Node、外部终端及显式外部 DSH 仍运行。额外核对 PowerShell 无监听结果被当作空集合、CIM / 端口查询权限错误被当作失败，不能错误放行或在空端口时阻塞安装。
4. **旧端兼容与同版正对照**：执行时从官网取得最近已发布安装包并记录版本、哈希与架构。用其真实旧 DSH / Codex 桥接记录升级到新版，再以新版 → 新版重复同样场景。旧 Host 不认识 `--prepare-update` 时会拒绝该参数；安装器显示手动关闭确认，由用户关闭旧 Host、DSH Web 与 Codex 桌面端。取消不得写安装目录；继续时仍由文件占用检测阻止带占用覆盖。此首轮迁移为手动路径，不能写成自动清理旧 Host 已验收。
5. **应用内更新**：在有活动任务时确认 / 取消，校验后停止后台，再进入安装；成功只重启一次 Host。验证激活、配对、供应商配置及历史保留，重新打开 Codex Desktop 后桥接恢复。断网、HTTP 失败、错误 SHA、磁盘写入失败、后台重生、收尾拒绝及安装器启动失败均不能被报告成更新成功。
6. **直接运行安装器**：Host 已开、仅托盘、未开但有旧后台三种状态；`--prepare-update` 的单实例应答和安装器等待均可完成。拒绝 / Esc 返回非零并暂停安装；确认且核验成功才允许覆盖。测试 `--prepare-update` 超时、IPC 断开及重复安装请求，不得留下第二个 Host。
7. **路径、身份与回退**：含空格 / 中文的用户与安装目录、盘符大小写和正反斜杠、已失效 PID、同名无关进程、另一隔离 Host 实例。只处理确认归属的进程；识别不足时暂停并提示。随后安装已验证的上一可用包并检查重新连接，保留回退包及相关证据。

## 交付与验收

实现、自动验证、安装发布与用户验收分别记录。本次只生成本机验证构建，没有安装到 `/Applications`、发布 Windows 安装器或更新官网下载。Windows 结果补齐且全量既有失败解决后再进行发布判断。

用户安装验收：安装后选择托盘“退出 Orbis”，先取消一次，再确认；重新打开后点击“更新 Host”，确认能够提示、收尾并进入安装。Windows 也需直接运行新版安装器验证覆盖流程；macOS 使用更新包拖入 Applications。以上均为**待用户验证**。
