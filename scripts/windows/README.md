# Windows Host 构建与打包

在 Windows PowerShell 中运行。下面的相对路径命令以仓库根目录 `D:\orbis` 为当前目录。

## Codex 空会话回归

[根部测试约束](../../AGENTS.md#测试)；[test-codex-empty-history.mjs](../test-codex-empty-history.mjs)。

## DSH 断线恢复回归

[根部测试约束](../../AGENTS.md#测试)；[test-dsh-web-reconnect.mjs](../test-dsh-web-reconnect.mjs)。

## USB 手机回归

[根部测试约束](../../AGENTS.md#测试)；[android-phone-smoke.ps1](android-phone-smoke.ps1)。

## 生成可运行包和 ZIP

```powershell
.\scripts\windows\windows-host-build.ps1 -Package
```

脚本会构建 TypeScript 后端和 Qt 界面、执行原生测试、收集运行时依赖，再运行打包后的冒烟测试。成功后产物位于：

- `.artifacts\host\OrbisHost\OrbisHost.exe`：可运行的 Host。
- `.artifacts\host\OrbisHost-0.1.11-windows-x64.zip`：便携包。
- ZIP 同目录的 `.sha256` 文件：校验值。

文件名中的版本号以脚本定义为准。`.artifacts\host` 为每次重建的输出目录，长期产物另行保留。

也可以在任意目录使用绝对路径：

```powershell
& 'D:\orbis\scripts\windows\windows-host-build.ps1' -Package
```

## 重新打包并重启本机 Host

```powershell
.\scripts\windows\host-rebuild.ps1
```

脚本先列出将关闭的 Host 和相关子进程，确认后停止进程、重新打包，成功后启动新版 Host。此操作会中断 Host 连接及相关运行会话。

已明确决定执行本次中断时，可以跳过交互确认：

```powershell
.\scripts\windows\host-rebuild.ps1 -Yes
```

只停止旧 Host 并重新打包，成功后不启动：

```powershell
.\scripts\windows\host-rebuild.ps1 -NoStart
```

`host-rebuild.ps1` 会处理其他安装目录中的 OrbisHost，以避免新版本启动时只激活旧进程。执行前请核对脚本列出的进程。

打包前按报错 PID 的可执行路径与命令行定位占用产物的服务，定向结束所属进程。DSH Server 为持久后台，退出 Host 后仍可能持有包内 Node。

如果当前对话运行于需要停止的 DSH Server，请从独立的本机 PowerShell 窗口执行操作，避免页面断开后失去操作入口。Host 重建脚本不保证重启 DSH Server；完成后可从 Host 打开 DeepSeek Harness，按需启动服务。

## 同时生成安装程序

需要已安装 Inno Setup，并传入本机 `ISCC.exe` 的实际路径：

```powershell
.\scripts\windows\windows-host-build.ps1 -Package -InnoCompiler 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
```

成功后还会在 `.artifacts\host` 生成 `OrbisHost-0.1.11-windows-x64-setup.exe` 及其 `.sha256` 校验文件。不传 `-InnoCompiler` 时只生成可运行目录和 ZIP。

## 工具链与可选参数

使用 Windows Node.js、npm、CMake、Ninja，以及相互匹配的 Qt / MinGW。先在仓库根目录安装依赖：

```powershell
npm ci
node -p "process.execPath"
```

Node 路径应为 Windows 路径。默认工具链位置：

- Qt：`D:\Qt\6.8.3\mingw_64`
- MinGW：`D:\Qt\Tools\mingw1310_64`

需要更换路径时：

```powershell
.\scripts\windows\windows-host-build.ps1 -Package `
    -QtRoot 'D:\Qt\6.8.3\mingw_64' `
    -CompilerRoot 'D:\Qt\Tools\mingw1310_64'
```

`host-rebuild.ps1` 也支持 `-QtRoot` 和 `-CompilerRoot`。打包脚本另支持 `-DefaultRelay`，默认值为 `wss://orbising.com/relay`。

`-Package` 生成可运行产物；普通模式执行构建和测试后清理中间目录与最终输出。
