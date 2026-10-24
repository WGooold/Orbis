# Windows Host 构建与打包

在 Windows PowerShell 中运行。下面的相对路径命令以仓库根目录 `D:\orbis` 为当前目录。

## DSH 断线恢复回归

```powershell
npm run build
node scripts/test-dsh-web-reconnect.mjs .artifacts/host/dsh-web-reconnect.json
```

脚本启动独立的原生 DSH Web 服务与本机转发服务，验证首次打开、WebSocket 关闭、原生事件流结束和事件流错误之后的再次打开。每次都要求收到可用的历史基线与成功回执，并确认 skills、模型目录及恢复通知已经解除。它不发送用户消息、不调用模型供应商；结束时删除临时 DSH 数据并停止自己的服务。

Host 将 DSH 传输诊断写入默认状态目录的 `diagnostics.ndjson`，分类为 `backend.transport`，记录连接关闭码、关闭原因、事件流结束及重新连接。目录读取错误仍单独记录；连接恢复不等于历史与元数据已经恢复。

DSH 的 WebSocket 帧和 HTTP JSON 响应均有 100 MiB 上限。历史 follow 的消息数不等于事件数，一页可能同时包含大量工具与步骤事件。接收错误会另记 `socket.error`、原始错误码和上限，握手超时会记 `handshake.timeout`；超过硬上限时结束该连接并报告明确失败，不重复重放同一超大基线。`1006` 只表示没有正常关闭帧，不能单凭它认定是网络或大小限制。

## USB 手机回归

```powershell
pwsh -File scripts/windows/android-phone-smoke.ps1 -Serial N78PZ5UCDIRCGQ8P
```

先用 `adb devices -l` 核对 serial，手机需要允许 USB 调试并保持解锁。脚本原子申请设备占用，通过 `android-build.ps1 -Background` 构建并用 `-Status` 轮询，再由 `android-install.ps1` 校验并覆盖安装应用和测试 APK，最后直接运行 instrumentation。它不卸载应用、不清除数据、不替换现有配对，也不停止电脑 Host。

加 `-ValidateOnly` 可在没有手机时运行结果解析自检，覆盖通过、失败、跳过、崩溃、输出截断及重复结果；这不算实机测试通过。

默认执行 `SessionGraphStoreInstrumentedTest`、`SessionSyncSelectionInstrumentedTest` 和 `DshInstrumentedTest`，覆盖 Android 加密数据库、同步事务和 DSH 界面交互。它们使用独立测试数据；这套手机回归与原生 DSH 断线恢复测试分别验证，不能据此宣称已验证用户原有配对的完整链路。可用 `-TestClass` 指定其他测试类，以逗号分隔。

脚本在构建前清空 `.artifacts/app`，只保存这次的 APK、来源及 SHA-256 清单、构建日志、`instrumentation.log`、`test-results.xml`、`phone-smoke.json`、崩溃日志、内存信息和截图。只有 runner 正常结束、逐项结果齐全且没有失败、错误或跳过时才报告通过；ADB 退出码为零本身不算通过。设备未连接或占用不属于当前任务时立即停止。结束后释放自己的设备占用，保留手机应用和数据。

## 生成可运行包和 ZIP

```powershell
.\scripts\windows\windows-host-build.ps1 -Package
```

脚本会构建 TypeScript 后端和 Qt 界面、执行原生测试、收集运行时依赖，再运行打包后的冒烟测试。成功后产物位于：

- `.artifacts\host\OrbisHost\OrbisHost.exe`：可运行的 Host。
- `.artifacts\host\OrbisHost-0.1.11-windows-x64.zip`：便携包。
- ZIP 同目录的 `.sha256` 文件：校验值。

文件名中的版本号以脚本当前定义为准。每次构建会清空 `.artifacts\host`，只保留本次结果；不要把需要保留的文件放在这里。

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

普通打包脚本不会主动关闭 Host。若进程正使用 `.artifacts\host` 中的文件，打包会拒绝继续。DSH Server 是持久后台，即使退出 Host 也可能继续使用包内 Node；遇到“进程正在从产物目录运行”时，应先核对报错 PID 的可执行路径和命令行，再关闭对应服务。不要按 `node.exe` 名称批量结束进程。

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

不要省略 `-Package` 来获取可运行产物：无此参数仅执行构建和测试，结束时会清理中间构建目录，并且仍会清空最终产物目录。
