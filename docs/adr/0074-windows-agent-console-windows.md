# ADR-0074：Windows Agent 终端窗口经系统默认终端打开

日期：2026-11-12

Status: accepted（已实现并通过自动验证；未部署，Windows 实机验收待用户验证）

关联：[ADR-0021](0021-codex-terminal-host-attachment.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)。场景编号 WIN-CONSOLE-01。

## 问题

Windows 用户从手机打开 Claude 时，Windows Terminal 报 `[出现错误 2147942402 (0x80070002) (启动“"cmd.exe /k C:\Users\…\.orbis\tmp\claude-<launchId>.cmd"”时)]`。

Host 以独立参数调用 `wt.exe -w new -d <目录> cmd.exe /k <脚本>`。如果 Windows Terminal 的默认配置文件开启了「以管理员身份运行此配置文件」，而 Terminal 本身没有提权，`TerminalPage::_maybeElevate` 会经 `elevate-shim.exe` 把新标签页转交给提权窗口。转交命令由 `NewTerminalArgs::ToCommandline()` 生成，子命令被整体写成 `-- "<命令>"`。提权窗口因此只解析出一个参数，拼回命令行时又整体加上引号，`CreateProcessW` 把整条命令当作程序名，返回 ERROR_FILE_NOT_FOUND。Windows Terminal 1.18 与当前主干的这段序列化相同。依据：[TerminalPage.cpp](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalApp/TerminalPage.cpp)、[ActionArgs.cpp](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalSettingsModel/ActionArgs.cpp)、[AppCommandlineArgs.cpp](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalApp/AppCommandlineArgs.cpp)、[ConptyConnection.cpp](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalConnection/ConptyConnection.cpp)。该结论来自源码，未在 Windows 上复现。

Pi（`wt.exe -d … powershell -NoProfile -NoExit -EncodedCommand …`）和 Codex 终端后端（`wt.exe -d … powershell -NoProfile -EncodedCommand …`）同样受影响：`-EncodedCommand` 只保证 base64 段不被拆分，多参数命令仍会被整体加引号。`wt.exe` 转交后立即以 0 退出，所以 Pi 激活被报告成功，手机却等不到会话上线；Codex 会话卡片在线但电脑上没有 TUI，看门狗只在见过 TUI 后才下线，`/quit` 报找不到可关闭的进程。

即使能启动，Agent 也会以管理员身份运行，并等待电脑前的 UAC 确认，手机发起的启动无法完成。Windows Terminal 的命令行没有关闭提权的参数。

## 决策

Windows 上手机发起的 Claude、Pi、Codex 终端后端开窗，以及电脑端「打开 Claude Code / Pi / Codex」，统一由 [windows-console.ts](../../packages/host/src/windows-console.ts) 打开窗口，不再直接调用 `wt.exe`。Host 运行隐藏的 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -EncodedCommand <启动脚本>`，启动脚本用 `ProcessStartInfo`（`UseShellExecute = $true`）经 ShellExecute 创建普通控制台窗口。系统默认终端可以再把它交给 Windows Terminal，这类转交不会提权。

程序名、参数行和工作目录以 PowerShell 单引号字面量写入启动脚本，弯单引号同样双写转义；工作目录直接交给 ShellExecute，不经 `Start-Process` 的通配符解析。含换行或 NUL 的输入在启动前拒绝。

窗口内容：

- Claude：`cmd /k ""<启动脚本>""`。cmd 去掉外层引号后，含空格或括号的路径仍然完整；启动失败时窗口保留。
- Pi：`powershell -NoProfile -NoExit -EncodedCommand …`。
- Codex：`powershell -NoProfile -EncodedCommand …`，codex 退出后脚本 `exit 0` 关窗。

窗口继承启动器的环境，Pi 的 `ORBIS_STATE_DIR` 等连接配置随之传入。

启动器退出码为 0 才算窗口已创建，并返回窗口进程 ID（取不到时返回启动器的进程 ID）。失败分别报告「无法打开 Claude Code / Pi / Codex 终端窗口」及启动器的首行错误；电脑端界面保留「无法打开终端界面，请重试」，详情写入 Host 日志。

Windows 总能打开控制台窗口，Pi 的有头启动不再以 PATH 上存在 `wt.exe` 为前提；没有受支持终端入口的系统仍按原规则报错或降级。Pi 的 Windows 窗口带 `-NoExit`，不计入运行数与去重：Pi 退出后窗口仍在，计入会使同一会话无法再拉起。此前记录的 `wt.exe` 进程同样立即退出，实际行为不变。Codex 看门狗与 `/quit` 继续按 TUI 与等待窗口的命令行识别进程，与承载窗口的终端无关。

影响：Windows 10，以及默认终端设为「Windows 控制台主机」的 Windows 11，窗口由控制台主机承载，不再是 Windows Terminal。默认终端为 Windows Terminal 时仍在 Terminal 中打开，可能按 Terminal 的窗口设置以标签页出现。

## 备选方案

- 保留 `wt.exe`，把命令合成单个参数：能避开引号问题，但仍会提权并等待 UAC。
- 保留 `wt.exe`，读取 Windows Terminal 配置判断是否提权：正式版、预览版、便携版的配置位置不同，PATH 上的 `wt.exe` 别名无法对应到具体安装，误判即重现故障。
- 用 `-p` 指定非提权配置文件：无法保证这样的配置文件存在。

## 验证与完成状态

实现：[windows-console.ts](../../packages/host/src/windows-console.ts)、[claude-launcher.ts](../../packages/host/src/claude-launcher.ts)、[spawner.ts](../../packages/host/src/spawner.ts)、[codex-runtime.ts](../../packages/host/src/codex-runtime.ts)、[desktop-runtime.ts](../../packages/host/src/desktop-runtime.ts)。回归：[windows-console.test.ts](../../packages/host/src/windows-console.test.ts)、[claude-launcher.test.ts](../../packages/host/src/claude-launcher.test.ts)、[spawner.test.ts](../../packages/host/src/spawner.test.ts)、[codex-runtime.test.ts](../../packages/host/src/codex-runtime.test.ts)、[desktop-terminal.test.ts](../../packages/host/src/desktop-terminal.test.ts)。

自动验证：类型检查、eslint 与上述 Node 回归通过；本机没有 PowerShell，启动脚本只做逐字断言，ShellExecute、默认终端转交和提权行为未执行。命令、日志与首次失败记录见 [verification.json](../../.artifacts/windows-console-launch-20261112/verification.json)。

未部署，Windows 实机验收待用户验证。

## Windows 待测试项目（待用户验证）

安装：在包含本提交的版本上手动运行 GitHub Actions「Windows Host build」，下载 `OrbisHost-windows-x64`；从托盘退出 Orbis Host 后运行其中的 `*-setup.exe`（按用户安装，无需管理员）。Windows 开发机也可用 `scripts/windows/host-rebuild.ps1` 替换本机测试 Host。手机沿用现有版本，确认 Host 已更新后再测。

环境：

- E1：Windows 11，默认终端为 Windows Terminal；Windows Terminal 的默认配置文件与「默认值」都开启「以管理员身份运行此配置文件」。这是原故障环境。
- E2：同 E1，但关闭以管理员身份运行。
- E3：默认终端为「Windows 控制台主机」，或 Windows 10。
- P：工作目录含空格、括号、单引号和中文，例如 `D:\测试 (1)\it's`。

| 编号 | 环境 | 操作 | 预期 |
|---|---|---|---|
| W1 | E1 | 手机新建 Claude 会话 | 不弹 UAC，不出现 0x80070002；窗口非管理员（控制台标题无「管理员」前缀，Terminal 标签无盾牌图标）；Claude Code 启动并连上，手机显示在线 |
| W2 | E1 | 手机恢复已有 Claude 会话 | 同 W1，显示原会话历史 |
| W3 | E1 | 手机新建 Pi 会话，再恢复一个已有 Pi 会话 | 两次都打开窗口并上线；Pi 退出后窗口保留 |
| W4 | E1 | 手机新建 Codex 会话并发送首条消息 | 窗口打开，首轮后自动接入；手机与电脑两端同步 |
| W5 | E1 | 对 W4 会话从手机执行 `/quit` | 电脑上的 Codex 窗口关闭，手机卡片下线 |
| W6 | E1 | 手机新建 Codex 会话后不发消息，直接 `/quit` | 等待中的窗口被关闭，之后不再自行接入 |
| W7 | E1 | 电脑端 Host 依次「打开 Claude Code」「打开 Pi」「打开 Codex」 | 选择工作区后各自打开窗口，均不弹 UAC |
| W8 | E3 | 重复 W1、W3、W4 | 以控制台主机窗口打开，功能同 E1 |
| W9 | E2 | 重复 W1、W3、W4 | 在 Windows Terminal 中打开，与修复前的正常行为一致 |
| W10 | E1 + P | 在 P 目录分别新建 Claude、Pi、Codex 会话 | 三者的当前目录都是 P，路径未被截断或转义 |
| W11 | E1 | 在电脑上直接关闭 W4 的 Codex 窗口 | 手机卡片在看门狗周期内下线，不留空窗口 |

记录：每项填写通过 / 失败、Host 版本、Windows 与 Windows Terminal 版本；失败时附窗口截图与 Host 日志中「无法打开」所在行，回填到本节。
