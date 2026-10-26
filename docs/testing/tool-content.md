# 工具内容设备验收

验证 [ADR-0045](../adr/0045-tool-summaries-and-on-demand-content.md) 的 Android 加密链路和缓存迁移。来源为合成数据，使用真实 DeviceLink、Host 库存/读取服务、Android RelayClient、reducer、Keystore 和 SQLite；不连接真实后端，不读取用户会话，不启动或停止用户 Host。

## 准备

1. 在当前工作树使用 Windows Node，运行 `npm run build`。确认 `node -p "process.execPath"` 为 Windows 路径。
2. 依 `D:\android-emulators\README.md` 原子取得独立设备占用与资源操作占用。优先在未启动模拟器时构建；每 30 秒内记录内存，低于 1.5 GiB 停止本次设备测试并关闭自己的模拟器。
3. 后台构建，单独轮询；不要直接调用 Gradle：

```powershell
pwsh -File scripts/windows/android-build.ps1 -Background -StopDaemons :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest --console=plain
pwsh -File scripts/windows/android-build.ps1 -Status
```

4. 构建成功后，按占用规则启动自己的模拟器、完成 boot 后释放资源操作占用；使用安装脚本安装两个最新 APK（示例 serial 必须属于本任务）：

```powershell
pwsh -File scripts/windows/android-install.ps1 -Serial emulator-5554 -Apk android/app/build/outputs/apk/debug/app-debug.apk
pwsh -File scripts/windows/android-install.ps1 -Serial emulator-5554 -Apk android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
```

## 执行

在独立工具会话运行 fixture；它只监听 127.0.0.1，输出动态端口，固定 PSK 是公开测试材料。每次测试使用新进程，计数器不能沿用上次失败的记录。第三参数可以指定未占用端口。

```powershell
node scripts/tool-content-fixture.mjs .scratch/tool-content-device
```

把输出端口填入 `$fixturePort`，另一个 PowerShell 执行：

```powershell
$fixturePort = 49842 # 替换为 fixture.ready 的端口
$adbPath = Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
& $adbPath -s emulator-5554 shell am instrument -w -r `
  -e class com.orbising.orbis.ToolContentInstrumentedTest,com.orbising.orbis.SessionGraphStoreInstrumentedTest,com.orbising.orbis.SessionSyncSelectionInstrumentedTest `
  -e toolFixturePort $fixturePort `
  com.orbising.orbis.test/androidx.test.runner.AndroidJUnitRunner
```

不能用 adb 退出码判断测试成功，必须有 `OK (40 tests)` 且无 `FAILURES`；未传端口时四后端链路测试会跳过，不能算通过。测试使用隔离 Application、临时凭据、SQLite 目录和 ViewModelStore；结束清理自己的目录，不清现有 App 数据。

测试检查四种 agentKind 各 200 项摘要分两页取得，打开详情前没有原文请求；32 KiB 私有页不改变 conversation；Pi 10 MiB 导出、取消后删除未完成文件、关闭后停止请求、详情队列有界；工具投影升级回滚和重开 store、配对身份保留。两个缓存回归类另检查来源换代、祖先 coverage、事务回滚和条件同步。

## 收尾和证据

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$fixturePort/shutdown"
```

fixture 会释放内容 store 并写 `stats.json`。`detailRequests`/`cancels` 为请求数，`inventoryPages` 为设备读取的库存页数，`wireBytes` 为完整加密 v2.frame JSON 字节，`peakDetailQueue` 为保守封装预算下的排队峰值。测试数据和密钥固定且公开，不把真实日志/身份写入文档或 issue。

保存当前 APK、来源 manifest、SHA-256、测试结论和统计到 `.artifacts/app/`，清理旧最终产物；Host 最终结果只放 `.artifacts/host/`。关闭自己占用的模拟器，确认 adb serial 与对应 AVD 进程均退出，停止自己的监控进程，再核验 owner 并释放设备占用。不能只删除 lease 留下模拟器。

真实外部后端和 Host/App 配对联动另按[隔离 Host 测试台](isolated-host/README.md) 执行，本 fixture 不替代该范围的生产环境验收。
