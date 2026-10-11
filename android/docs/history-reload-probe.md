# Session 历史读取端到端验收

验证有效缓存能否在客户端重建、App 进程重开后用于阅读，以及正常的有界 `limit_reached` 页是否被误报为失败。两种验收不能互相替代：

| 入口 | 实际覆盖 | 不覆盖 |
| --- | --- | --- |
| [`history-client-reload-probe.ps1`](../../scripts/windows/history-client-reload-probe.ps1) + [`LiveHistoryReloadInstrumentedTest`](../app/src/androidTest/java/dev/pi/remote/LiveHistoryReloadInstrumentedTest.kt) | 使用手机已有配对与 SQLite，经真实连接读取已有 Codex；重建 ViewModel/transport；检查操作终态、分页边界、本地缓存耗时、历史远端请求及 `limit_reached` 范围错误 | 真正的进程重开与手势、完整 UI 锚点行为 |
| [`history-reload-probe.ps1`](../../scripts/windows/history-reload-probe.ps1) | force-stop 后确认进程已退出，重开 App、选择在线 Runtime、执行向旧历史的真实手势；观测本地/远端接力与可见错误 | 自动恢复上次窗口（每轮先返回首页）、所有分支/网络故障、未捕获到的瞬时 UI 状态 |

架构契约见 [ADR-0029](../../docs/adr/0029-session-read-operation-state-machine.md)。本说明和脚本永久保留于源码；`.artifacts/app/` 只存最近一次产物，不是历史归档。

## 安全前提

**运行前取得本次设备操作授权**：覆盖安装、instrumentation 和 force-stop 会占用手机前台、短暂中断手机连接。Host 停止/重启、push/发布不包含在授权中。

- 使用 Windows PowerShell、Windows JDK/SDK、项目构建/安装 wrapper；不要用 WSL 的 Android 工具。
- 原有配对、Host 和至少一条 Codex Runtime 必须已经在线。测试不新建/激活后端，不发消息、执行 Slash、回退或归档会话；不能通过点击离线目录行来补测试目标。
- 测试读取真实历史，正常同步可能写入/更新缓存；它不是磁盘只读，也不保证源端 epoch 一直不变。不删除缓存、配对、草稿，不执行 `pm clear`、卸载或模拟器 wipe。
- 先拿设备独占 lease，不能接管其他 owner。构建只用 `scripts/windows/android-build.ps1`；不能删除其他任务的构建锁。
- App 必须可解锁、前台可交互。源端 epoch/head 应尽量稳定；用户继续产生新消息时，跨轮同窗口对照可能无法成立。
- 记录只含哈希标识、状态、计数和时间；UI XML 只在内存解析，不落盘、不打印。不要另外保存通用 logcat、UI XML 或带正文截图作为可分享证据。

## 1. 环境与设备占用

在仓库根目录执行。`$serial` 必须由操作者指定，示例不包含任何固定用户设备或凭据。

```powershell
$ErrorActionPreference = 'Stop'
$env:JAVA_HOME = 'D:\androidstudio\jbr'
# 如环境尚未配置，填入本机 Windows SDK 路径。
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$serial = Read-Host '已获本次授权的 adb serial'
$repo = (Get-Location).Path
$owner = [guid]::NewGuid().ToString()
$leaseDir = if ($env:ORBIS_ANDROID_LEASE_DIR) { $env:ORBIS_ANDROID_LEASE_DIR } elseif (Test-Path 'D:\android-emulators') { 'D:\android-emulators\leases' } else { Join-Path $env:LOCALAPPDATA 'Orbis\android-leases' }
[IO.Directory]::CreateDirectory($leaseDir) | Out-Null
$leasePath = Join-Path $leaseDir "$serial.json"
$record = @{ owner=$owner; task='session-history-e2e'; worktree=$repo;
    serial=$serial; shellPid=$PID; acquiredUtc=[DateTime]::UtcNow.ToString('o') }
$bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json))
$stream = [IO.File]::Open($leasePath, [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() }
finally { $stream.Dispose() }
```

`CreateNew` 失败就停止，不覆盖占用文件。以下构建/验收段放在自己的 `try` 中，最后使用第 5 节 `finally` 收尾。模拟器创建、内存上限和退出规则另见本机 `D:\android-emulators\README.md`；不要为这个测试改变已有配对。

## 2. 构建、保存最新产物与覆盖安装

若本次源码对应的 App 和测试 APK 已安装，可跳过本节。否则**构建前清空** `.artifacts/app/`，保留 `.artifacts/host/`；不要备份旧产物。

```powershell
$target = Join-Path $repo '.artifacts\app'
if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Path $target | Out-Null
& .\scripts\windows\android-build.ps1 -AcquireTimeoutMinutes 2 -StopDaemons `
    :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest --console=plain
if ($LASTEXITCODE -ne 0) { throw '构建失败；不要安装旧 APK' }

# 仅复制本次构建，并为最终路径保留来源、构建 ID 与 SHA-256。
$sources = @(
    'android\app\build\outputs\apk\debug\app-debug.apk',
    'android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
)
$checksums = @()
foreach ($source in $sources) {
    $manifest = [IO.File]::ReadAllText("$repo\$source.pi-remote-build.json") | ConvertFrom-Json
    if ((Get-FileHash $source -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'APK 校验失败' }
    $dest = Join-Path $target (Split-Path $source -Leaf)
    Copy-Item -LiteralPath $source -Destination $dest
    $manifest.artifactPath = $dest
    $manifest | ConvertTo-Json -Depth 5 | Set-Content "$dest.pi-remote-build.json"
    $checksums += "$($manifest.sha256)  $(Split-Path $dest -Leaf)"
}
$checksums | Set-Content (Join-Path $target 'SHA256SUMS.txt')
& .\scripts\windows\android-install.ps1 -Serial $serial -Apk "$target\app-debug.apk"
& .\scripts\windows\android-install.ps1 -Serial $serial -Apk "$target\app-debug-androidTest.apk"
```

安装使用 `-r` 保留数据。不要改掉 `android.injected.androidTest.leaveApksInstalledAfterRun=true`，不要为方便改成卸载重装。失败半成品应清理，不将上一次 APK 当作这次结果。

## 3. 客户端/连接重建验收

```powershell
& .\scripts\windows\history-client-reload-probe.ps1 `
    -Serial $serial -LeaseOwner $owner -TimeoutSeconds 120
```

- 自动选择目录中最多三条**已有在线 Codex**，每条预热两页，再重建三轮、每轮最多两页。
- 对照条件包括 Session、cache epoch、leaf、分页边界及预先存在的缓存行；合法缓存对照要求本地完成且不超过 3000 ms，不产生相应 history 远端请求。
- 读取必须有成功/到底终态且边界推进；逐页检查没有 `limit_reached` 范围失败。某个目标没有任何同窗口缓存对照时为 `INCONCLUSIVE`，不是通过。
- 内部 watchdog 90 秒，外部默认 120 秒。外部超时只停止本任务手机 App/adb 调用并恢复普通 App，不停止 Host。
- runner 传递唯一 `historyRunId`，只接受该次证据。**adb 退出码 0 不代表 JUnit 通过**，必须同时有 `OK (1 test)` 和本次缓存对照记录。
- 直接运行 instrumentation 时，必须显式 `-e liveHistory true`；未开启会跳过测试，不是成功验收。建议使用 runner，以获得外层截止与日志恢复。

## 4. 真正进程重开与 UI 上滑验收

先做短轮次，不要一上来长时间盲等：

```powershell
& .\scripts\windows\history-reload-probe.ps1 `
    -Serial $serial -LeaseOwner $owner -Reloads 1 -Pages 2 `
    -TimeoutSeconds 15 -TotalTimeoutSeconds 180
```

确认短轮次可稳定到达分页边界后再增加 `-Reloads 3`，同时给整轮设置明确预算，例如 `-TotalTimeoutSeconds 360`。`TimeoutSeconds` 是单页预算，`TotalTimeoutSeconds` 包含选择/重开/手势的整轮预算；最后的证据收集与 App 恢复可能另需几个有界 adb 调用。若外部工具也设超时，应大于总预算并预留收尾时间；直接强杀外层 shell 可能跳过 `finally`。

省略 `-SessionTitles` 时，只从 Runtime 首页中带“修改会话别名”控件的在线卡片识别 Codex，不从可能激活后端的历史目录选择。若只想测一条已在线 Runtime，可在自己的终端传精确标题：

```powershell
$titles = @(Read-Host '已在线 Runtime 首页卡片的精确标题')
& .\scripts\windows\history-reload-probe.ps1 `
    -Serial $serial -LeaseOwner $owner -SessionTitles $titles `
    -Reloads 1 -Pages 2 -TimeoutSeconds 15 -TotalTimeoutSeconds 180
```

标题只在内存匹配，不进入证据。自动发现只覆盖有限次滚动内可见的目标，不保证找到每条在线会话。测试会返回 Runtime 首页，改变 App 的“上次选中窗口”导航记录，但不改变源端 Session。

### 判定不可混淆

- **PASS**：重开后确实读取了与预热相同 Session/epoch/leaf/边界的页，本地完成且在预算内；脚本要求被测目标和重开轮次都有合格对照。
- **FAIL**：已经建立有效预热对照，但重开后同窗口页改走远端、超时或过慢；或 UI 直接出现所检查的 `Session 范围加载失败：limit_reached`。
- **INCONCLUSIVE**：没有找到在线目标、源端版本/边界变化、没有触发/捕获到分页起点、某页缺少预热对照或达到整轮预算。不能计为通过，也不能直接等同 App 故障。

自动分页可能在选择等待或上一页观测时已完成；脚本用本轮基线保留它们，不丢弃已完成的 worker。长消息可能需要比单页预算内更多的滑动才能到达列表顶部；没有捕获新起点不等于分页任务卡住。不要通过放宽同窗口条件、清缓存或激活新后端来凑 PASS。

## 5. 证据与必做收尾

当前证据全部在 `.artifacts/app/`，每次同类脚本覆盖自己的最近结果，不创建时间戳归档：

- 客户端：`live-history-reload.log`、`live-history-reload-errors.log`、`live-history-reload.json`；watchdog 触发且身份匹配时保存 `live-history-wait.json`。
- UI：`history-probe-results.json`（每页 checkpoint，含 `runId`）、`history-probe-traces.json`（正常进入收尾时收集）。异常外层中断可能只留下部分结果；不要把旧 trace 文件拼成新运行的证据。
- APK：来源 manifest、SHA-256 清单。只提交脚本、测试和说明，不提交 APK、设备结果或本机凭据。

两脚本均校验 lease、临时启用 `OrbisHistory` 后恢复原标签、恢复普通 App；**它们不释放调用者的 lease、不关闭调用者的模拟器**。务必使用自己的 `finally`：

```powershell
# 放在包住构建/安装/验收的 try { ... } 后面。
finally {
    # 构建失败可能跳过 -StopDaemons；等本次构建真实退出且无其他 owner 后，
    # 使用 android-build.ps1 -StopOnly 清理，不按 java.exe 名称批量结束。
    & $adb -s $serial shell setprop log.tag.OrbisHistory INFO
    & $adb -s $serial shell am start -n com.orbising.orbis/dev.pi.remote.MainActivity
    # 如果是自己启动的模拟器：先 adb -s $serial emu kill，确认 serial 与
    # 对应模拟器进程退出后再释放。实体手机不关机。
    $lease = [IO.File]::ReadAllText($leasePath) | ConvertFrom-Json
    if ($lease.owner -ne $owner) { throw 'lease 已改变，不能释放其他 owner' }
    Remove-Item -LiteralPath $leasePath
}
```

普通脚本已恢复原日志级别；只有外部中断跳过恢复时才需要手动设回 INFO。连不上 adb、无法确认测试已结束或模拟器没有退出时，保留 lease 并报告，不假装完成收尾。

## 只检查脚本可加载，不操作设备

```powershell
& .\scripts\windows\history-client-reload-probe.ps1 -Serial validate-only -ValidateOnly
& .\scripts\windows\history-reload-probe.ps1 -Serial validate-only -ValidateOnly
```

这只验证 PowerShell 加载，不是端到端验收。已记录的本地检查、客户端重建和 UI 部分结果应分别报告；任何一项不能替代另一项。
