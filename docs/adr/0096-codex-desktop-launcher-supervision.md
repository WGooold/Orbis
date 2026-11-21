# ADR-0096：Codex 桌面版启动器的 CLI 解析、进程监管与遗留回收

日期：2026-11-21

状态：代码实现与本机自动验证已完成；部署、Windows 实机验收与用户验收待完成。

关联：[ADR-0022](0022-codex-desktop-daemon-attachment.md)（本 ADR 替代其 2026-10-28 修订中的 macOS CLI 查找规则，以及包装器进程生命周期的实现约定；接入方式、端点模式、Windows 包内 CLI 匹配与恢复规则保留）、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0095](0095-codex-unified-catalog-and-launch-modes.md)。

## 背景

2026-11-21 本机出现两个故障，证据在 `.artifacts/codex-desktop-launcher-20261121/`。

1. **找不到 CLI（exit 127）。** Codex 桌面版 26.1117.41037（codex-cli 0.171.0-alpha.13）改由嵌套在包内的 helper 拉起 CLI：`ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/158.0.8127.37/Helpers/Codex (Aperitif).app`。旧包装器把父进程可执行文件上推两级当作应用包，拼出的 `…/Codex (Aperitif).app/Contents/Resources/codex-cli/bin/codex` 不存在；随后退回 PATH 里的 `codex`，GUI 环境没有它，spawn ENOENT，最终 127。GUI 若从带有 Orbis 托管 CLI 的终端环境启动，同一退路会改用版本不同的终端 CLI（本机观察到 0.169.0 服务 26.1117 GUI）。
2. **重启后会话被锁。** 一个 2026-11-19 由包装器拉起的 `codex app-server --listen ws://127.0.0.1:52641` 在旧 GUI 退出后成为孤儿（PPID 1），持有 `~/.codex/thread-writer-locks/<thread>.lock` 与该会话 rollout，并继续无人可见地执行回合；新 GUI 的后端恢复该会话时报 `thread … already has an active writer`（-32600）。Host 重启后按端点正确接入了新后端，冲突来自孤儿。核实结果：`--listen` 模式下 app-server 忽略 stdin EOF，只在收到信号时退出；GUI 停止传输时对 launcher 发 SIGTERM，有客户端连接时 SIGTERM 也立即生效。孤儿的成因是包装器自身在没有转发信号的路径上退出（未处理的写管道错误等会绕过收尾）。旧实现中，被 SIGKILL 或崩溃的包装器不会留下任何可供回收的线索。

## 决策

### CODEX-DESKTOP-RESOLVE-01｜只运行发起启动的那个桌面版自带的 CLI

- macOS 以包标识 `com.openai.codex` 认定安装包，不依据路径形状。沿包装器的进程祖先链逐级检查，取每个可执行文件所在的最外层 Codex 包；helper 嵌套多深、父进程换成哪个 helper，都落到同一个应用包。
- 包内 CLI 以 `Contents/Resources/codex-cli/codex-package.json` 的 `entrypoint` 为准，其后依次是清单出现前的 `bin/codex` 与 `CodexCLI.app/Contents/MacOS/codex`。候选必须解析到包内、是可执行文件、且不指回 Orbis launcher。
- 桌面版路径不再退回 PATH 或终端 CLI。显式 `ORBIS_CODEX_REAL` 仍可用于开发与隔离测试。Windows 继续按 ADR-0022 2026-11-14 修订的包内 CLI 与官方副本哈希匹配。
- 只有祖先链中确认为 Codex 桌面版（或显式覆盖）的常驻 `app-server` 调用才建立桥接并发布端点；其它也读取 `CODEX_CLI_PATH` 的调用方原样透传，Host 不会把它们的后端当作桌面版接入。
- 启动策略查询仍只读、可换候选重试；其它命令启动后不重放；某候选在监听前以 126/127 退出视为无法执行，换下一个候选；桥接建立失败则以同一 CLI 原生 stdio 继续。

### CODEX-DESKTOP-SUPERVISION-01｜后端不得比它的桥接活得久

- 包装器的所有结束路径汇入同一个幂等收尾：GUI 的 SIGTERM/SIGHUP/SIGINT、stdin 结束或出错、stdout 写失败（EPIPE）、WebSocket 断开、后端自行退出、包装器内部异常。收尾依次撤回端点、断开连接、对后端 SIGTERM，超时升级为 SIGKILL，确认退出后释放租约。后端自行退出时以其退出码结束包装器，GUI 据此重建传输。
- 进程 `exit` 钩子同步 SIGKILL 仍在运行的后端，覆盖未经收尾的退出（含未捕获异常）。建桥期间收到终止信号时，直接结束尚未投入使用的后端并退出，不再改走原生 stdio。
- 桥接启动后端时写入租约 `codex-desktop-backends/<instanceId>.json`（后端 PID、桥接 PID、监听地址），并在后端环境中带上本 Host 端点路径与实例标记。
- 端点描述保持 schema 1，新增可选 `instanceId`。发布为原子替换；撤回只在文件仍指向本桥接时进行，迟退的旧桥接不会删除继任者的端点；被删除的端点会重新发布，但不覆盖更新的存活桥接。Host 只接受桥接与后端均存活、且写于本次开机之后的端点。

### CODEX-DESKTOP-REAP-01｜遗留后端的回收

- 判定为遗留后端的依据只有三类：租约中后端存活、其桥接已不是它的父进程（Windows 以创建时间排除 PID 复用），且命令行确在监听租约地址；上一份端点描述中同样条件成立的后端（覆盖未写租约的旧版包装器）；macOS 上已被 launchd 收养（PPID 1）、命令行为 `app-server --listen ws://127.0.0.1:*`、且环境中带有本 Host 端点路径的进程（覆盖既无租约、端点也已被覆盖的旧版孤儿）。桥接仍是父进程的后端、PID 复用、其它 Host 或用户自行启动的进程一律不动；每次发信号前重新核对进程身份。
- 回收时机：包装器启动新后端之前；Host 首次探测、端点变化或消失时立即执行，此外每 60 秒一次，单飞执行。Windows 仅在存在租约或上一份端点已失效时才读取进程表。
- 遗留后端上仍在运行的回合会被中断，与原生 GUI 退出时结束其 app-server 的语义一致；会话及其历史保留，可在当前后端继续。

### CODEX-DESKTOP-LAUNCH-02｜Host 打开桌面版

- Host 只有一个打开入口：能准备并登记包装器时经包装器打开，否则以原生方式打开并记录未接入原因；打开 Codex 不依赖 Orbis 是否可用。cli Host 与桌面 Host 共用同一套接线（端点、恢复记录、刷新桥、打开、回收）。
- macOS 不再生成转发脚本：launcher 直接执行安装目录中的 node 与包装器，并带上 Host 端点路径；旧版转发脚本在重新暂存时删除。Orbis 运行时缺失时，launcher 按同一规则（祖先链最外层 Codex 包、清单入口优先）执行桌面版自带 CLI。Host 自身若从 Codex 终端继承了包装器变量，不会把已暂存的文件当作来源。
- 恢复记录保持原文件与 phase 名称。`native`／`failed` 只由通过的只读预检或就绪的桥接清除，原生打开不会把它降级为 `unattached`。macOS 运行检测按包标识识别主进程，安装位置不同也能识别。
- 以原生方式打开时记录具体原因：包装器缺失、入口无法登记（含被其他程序占用的值）、准备失败及其错误。桌面版在运行却没有端点时，Host 依次给出：wrapper 正在启动（继续等待）、入口被他人占用、入口未登记、桌面版早于入口登记打开。Codex 已在运行时，打开请求只在 wrapper 正在启动时等待满时长，否则数秒内给出原因。
- 包装器入口只依赖 Node 内置模块，按需加载实现。实现无法加载，或实现在未启动任何 CLI 前失败时，macOS 以 launcher 的原生模式运行发起者自带的 CLI，本次不接入并记录原因；只有原生模式也找不到 CLI 才暂停入口并以 127 结束。Codex 弹窗只显示 stderr 最后一段，因此最后一行总是先写下一步、再写原因。

### CODEX-DESKTOP-WRITER-01｜会话被另一个写入者占用

- 恢复会话遇到 `thread … already has an active writer` 时，桌面后端先立即回收一次遗留后端，回收到则重试一次；仍被占用（或没有可回收的）时返回 `session_busy`，提示会话正被终端里的 codex、另一个 Codex 窗口或仍在运行的旧后端使用，请先在那里结束或关闭后重试。不抢占、不关闭仍有父进程的写入者。

## 时序与路径

下表覆盖本 ADR 承诺的启动与退出组合；“提示”是用户在 Codex 弹窗、Host 界面或手机上看到的内容。

| 时序／路径 | 行为 | 提示 | 测试 |
| --- | --- | --- | --- |
| 先开 Host，再从程序坞／Orbis 打开 Codex | 包装器发布端点，Host 2 秒内接入 | 已接入 | 桥接、生命周期 |
| Codex 已（经包装器）在运行，Host 启动或重启 | 读端点接入同一后端；首次探测回收遗留后端 | 已接入 | 生命周期、回收 |
| Codex 以未接入方式在运行（入口登记前打开、入口被占用、接入被暂停） | 不重启 Codex；打开请求数秒内返回 | 具体原因 +“完全退出 Codex 后从 Orbis 打开”或“移除他人设置” | 生命周期、诊断 |
| 包装器正在建桥（端点尚未发布） | Host 显示正在接入并继续等待 | “正在启动 Orbis 接入，请稍候” | 生命周期、诊断 |
| 包装器缺失、入口无法登记、暂存失败 | 原生打开 Codex | 记录具体原因 | 启动 |
| 找不到可用 CLI（含上游改布局） | 先原生模式；仍无则暂停入口、127 | Codex 弹窗最后一行与 Host 均给出“退出后从程序坞重开” | 包装器、macOS 解析 |
| 包装器实现无法加载 | 原生模式运行 Codex 自带 CLI | “包装器无法加载，请重新安装 Orbis Host” | 包装器（编译产物） |
| 桥接建立失败 | 同一 CLI 原生 stdio | “已改用原生连接，未接入” | 包装器、桥接 |
| GUI 正常退出 / 更新重启 / 重启传输 | SIGTERM → 收尾，旧端点不覆盖新端点 | — | 桥接（进程级） |
| GUI 在建桥期间结束传输 | 立即结束未投入使用的后端 | — | 桥接（进程级） |
| GUI 崩溃或被强制退出 | stdin 结束 → 收尾 | — | 桥接（进程级） |
| GUI 先关闭管道（EPIPE） | 不崩溃，收尾 | — | 桥接（进程级） |
| 后端崩溃或自行退出 | 包装器以其退出码结束，GUI 重建传输，Host 重接 | Codex 自身提示 | 桥接 |
| 后端不响应 SIGTERM | 宽限后 SIGKILL | — | 桥接、回收 |
| 包装器被 SIGKILL / 原生崩溃 | 后端成孤儿；下次启动前或 Host 回收 | 若期间恢复会话：先回收再重试，否则 `session_busy` 提示 | 桥接（进程级）、回收、运行时 |
| Host 退出、崩溃或暂停 | 不影响 Codex 与后端；重启后重接 | — | 生命周期 |
| 重启电脑 | 旧端点按开机时间作废；旧租约在回收时清理 | — | 端点 |
| Orbis 升级时 Codex 仍运行旧包装器 | 新 Host 读取旧端点；旧孤儿按端点或环境标记回收 | — | 回收 |
| 会话被其他写入者占用 | 回收一次并重试；不抢占有主写入者 | 指明占用者类型与处理方法 | 运行时 |

不覆盖：同一 Host 状态目录下同时运行两份 Codex（两者共享原生写锁，按最新端点接入）；Windows 上包装器实现无法加载时仍为 127 加明确提示（原生 launcher 没有原生模式）。

## 兼容

- 新 Host 读取旧包装器写下的 schema 1 端点与恢复记录；旧 Host 读取新端点时忽略 `instanceId`。Windows 原生 launcher、暂存布局与安装器修复流程不变。
- Host 升级而桌面版仍运行旧包装器时，旧后端由端点描述或 macOS 环境标记回收；桌面版需重开一次才能用上新包装器。

## 验证与交付

| 场景 | 判定 | 自动验证 |
| --- | --- | --- |
| CODEX-DESKTOP-RESOLVE-01 | 26.1117 布局（GUI → 嵌套 helper → 包装器）解析到外层包的清单入口；不可执行、越出包、指回 launcher 的入口被跳过；无桌面版祖先时不桥接；不使用 PATH。 | [macOS 解析测试](../../packages/host/src/codex-desktop-macos.test.ts)（含编译的真实 GUI/helper 进程树）、[包装器测试](../../packages/host/src/codex-desktop-wrapper.test.ts)；本机对运行中 26.1117 的只读核对：`resolver-live-26.1117.log` |
| CODEX-DESKTOP-SUPERVISION-01 | SIGTERM、建桥期 SIGTERM、关闭 stdin、GUI 管道断开、后端退出、忽略 SIGTERM 的后端均被结束；端点按实例撤回。 | [桥接测试](../../packages/host/src/codex-desktop-bridge.test.ts)、[端点测试](../../packages/host/src/codex-desktop-endpoint.test.ts)；真实 CLI 0.171.0-alpha.13 隔离运行：`e2e-real-cli-0.171.log` |
| CODEX-DESKTOP-REAP-01 | 包装器被 SIGKILL 后，下一次启动或 Host 回收结束其后端；存活桥接、PID 复用、他人进程不被触碰。 | [回收测试](../../packages/host/src/codex-desktop-backends.test.ts)、[生命周期测试](../../packages/host/src/codex-desktop-lifecycle.test.ts)；本机现场试运行（不发信号）仅认定 2026-11-19 遗留后端：`reaper-dry-run-live.log` |
| CODEX-DESKTOP-LAUNCH-02 | 先登记入口再打开；入口被占用或包装器缺失时原生打开并记录具体原因；取消后不打开；暂停记录跨原生打开保留；运行中无端点给出具体原因且不久等；实现无法加载时原生运行。 | [启动测试](../../packages/host/src/codex-desktop-launcher.test.ts)、[诊断测试](../../packages/host/src/codex-desktop-integration.test.ts)、[生命周期测试](../../packages/host/src/codex-desktop-lifecycle.test.ts)、[包装器测试](../../packages/host/src/codex-desktop-wrapper.test.ts) |
| CODEX-DESKTOP-WRITER-01 | 写锁冲突先回收再重试一次；仍冲突返回 `session_busy` 与可操作提示；其他错误不改写。 | [运行时测试](../../packages/host/src/codex-runtime.test.ts) |

自动验证记录：`.artifacts/codex-desktop-launcher-20261121/`。尚未完成：安装包部署、Windows 实机（原生 launcher 与 AppX）验收、最近发布版本互通核对、用户安装验收。

代码：[codex-desktop-macos.ts](../../packages/host/src/codex-desktop-macos.ts)、[codex-desktop-cli.ts](../../packages/host/src/codex-desktop-cli.ts)、[codex-desktop-wrapper.ts](../../packages/host/src/codex-desktop-wrapper.ts)、[codex-desktop-invocation.ts](../../packages/host/src/codex-desktop-invocation.ts)、[codex-desktop-native-fallback.ts](../../packages/host/src/codex-desktop-native-fallback.ts)、[codex-desktop-bridge.ts](../../packages/host/src/codex-desktop-bridge.ts)、[codex-desktop-backends.ts](../../packages/host/src/codex-desktop-backends.ts)、[codex-desktop-endpoint.ts](../../packages/host/src/codex-desktop-endpoint.ts)、[codex-desktop-launcher.ts](../../packages/host/src/codex-desktop-launcher.ts)、[codex-desktop-integration.ts](../../packages/host/src/codex-desktop-integration.ts)、[codex-desktop-lifecycle.ts](../../packages/host/src/codex-desktop-lifecycle.ts)、[codex-desktop-recovery.ts](../../packages/host/src/codex-desktop-recovery.ts)、[codex-runtime.ts](../../packages/host/src/codex-runtime.ts)（写锁冲突）。

2026-11-21 现场处置：确认身份后对 2026-11-19 遗留后端发送 SIGTERM，其写锁与子进程随之释放。
