<#
.SYNOPSIS
Serialized Android build wrapper for this machine.

.DESCRIPTION
Agents must not wait out a build inside one foreground tool call: a killed caller
leaves the wrapper half-dead and, before 2026-10-19, leaked the machine resource
lease so every later build waited silently for up to two hours. Use:

  pwsh -File scripts\windows\android-build.ps1 -Background :app:testDebugUnitTest
  pwsh -File scripts\windows\android-build.ps1 -Status     # prints pid/state/exit code + tail
  pwsh -File scripts\windows\android-build.ps1 -Status > $null; $LASTEXITCODE  # build result

A foreground run still works but prints a heartbeat while it waits for the build
mutex or the machine lease. A lease left by a dead pid is taken over (with a log
line) instead of blocking the next task.

.EXAMPLE
pwsh -File scripts\windows\android-build.ps1 -InstallSerial emulator-5556 -LaunchActivity :app:assembleDebug --console=plain
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]] $GradleArgs,

    [switch] $StopDaemons,

    [switch] $StopOnly,

    [ValidatePattern('^[A-Za-z0-9._:-]+$')]
    [string] $InstallSerial,

    [switch] $LaunchActivity,

    [ValidateRange(1, 120)]
    [int] $AcquireTimeoutMinutes = 120,

    [ValidateRange(1, 60)]
    [int] $MemoryPollSeconds = 15,

    # 长构建不要在调用方的前台等待：先 -Background 立刻返回，再 -Status 轮询。
    [switch] $Background,

    [switch] $Status,

    # -Background 内部使用；子进程带着它跑真正的构建。
    [switch] $DetachedChild,

    [ValidateRange(5, 120)]
    [int] $HeartbeatSeconds = 15
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$android = Join-Path $repo 'android'
$gradlew = Join-Path $android 'gradlew.bat'
$leaseDir = if ($env:ORBIS_ANDROID_LEASE_DIR) { $env:ORBIS_ANDROID_LEASE_DIR } elseif (Test-Path 'D:\android-emulators') { 'D:\android-emulators\leases' } else { Join-Path $env:LOCALAPPDATA 'Orbis\android-leases' }
$metadataPath = Join-Path $leaseDir 'android-build.json'
$resourcePath = Join-Path $leaseDir 'resource-operation.json'
$installScript = Join-Path $repo 'scripts\windows\android-install.ps1'
$mutexName = 'PiRemote.AndroidBuild'
$owner = [guid]::NewGuid().ToString()
$buildId = [guid]::NewGuid().ToString()
# 运行记录与日志放在 .scratch 下：它们是过程材料，不是交付产物。
$runDir = Join-Path $repo '.scratch\android-build'
$runStatePath = Join-Path $runDir 'current.json'

if ($StopOnly -and $GradleArgs -and $GradleArgs.Count -gt 0) {
    throw '-StopOnly cannot be combined with Gradle task arguments.'
}
if ($LaunchActivity -and -not $InstallSerial) {
    throw '-LaunchActivity requires -InstallSerial.'
}
if ($StopOnly -and $InstallSerial) {
    throw '-StopOnly cannot be combined with -InstallSerial.'
}
if (-not $StopOnly -and (-not $GradleArgs -or $GradleArgs.Count -eq 0)) {
    $GradleArgs = @(':app:assembleDebug', '--console=plain')
}
if ($GradleArgs -contains '--parallel' -or $GradleArgs -contains '--stop') {
    throw 'Use the build wrapper for serialized builds; --parallel and --stop are not build arguments.'
}
if (-not (Test-Path $gradlew)) {
    throw "Gradle wrapper not found: $gradlew"
}
if ($env:GRADLE_USER_HOME) {
    throw 'GRADLE_USER_HOME is set. Use the shared default Gradle user home so compatible daemons can be reused.'
}
if ($Background -and $DetachedChild) {
    throw '-Background and -DetachedChild cannot be combined.'
}
if ($Background -and ($Status -or $StopOnly)) {
    throw '-Background cannot be combined with -Status or -StopOnly.'
}

function Read-RunRecord {
    if (-not (Test-Path -LiteralPath $runStatePath)) { return $null }
    try { return Get-Content -LiteralPath $runStatePath -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-LiveProcess([object]$record) {
    $candidate = 0
    if ($null -eq $record -or -not [int]::TryParse([string]$record.pid, [ref]$candidate) -or $candidate -le 0) { return $null }
    return Get-Process -Id $candidate -ErrorAction SilentlyContinue
}

if ($Status) {
    $record = Read-RunRecord
    if ($null -eq $record) {
        Write-Output "No background build recorded ($runStatePath)."
        exit 0
    }
    $live = Get-LiveProcess $record
    Write-Output ("build pid={0} state={1} started={2} finished={3} exitCode={4}" -f $record.pid,
        $(if ($live) { 'running' } else { 'exited' }), $record.startedUtc,
        $(if ($record.finishedUtc) { $record.finishedUtc } else { '-' }),
        $(if ($null -ne $record.exitCode) { $record.exitCode } else { '-' }))
    Write-Output ("args: {0}" -f (($record.args | ForEach-Object { $_ }) -join ' '))
    Write-Output ("log: {0}" -f $record.log)
    if (Test-Path -LiteralPath $record.log) {
        Write-Output '--- last 25 log lines ---'
        Get-Content -LiteralPath $record.log -Tail 25
    }
    if ($record.err -and (Test-Path -LiteralPath $record.err) -and (Get-Item -LiteralPath $record.err).Length -gt 0) {
        Write-Output '--- last 10 stderr lines ---'
        Get-Content -LiteralPath $record.err -Tail 10
    }
    # 轮询脚本可以直接用退出码判断结果：还在跑是 0，跑完就是构建自己的退出码。
    if (-not $live -and $null -ne $record.exitCode) { exit [int]$record.exitCode }
    exit 0
}

if ($Background) {
    New-Item -ItemType Directory -Path $runDir -Force | Out-Null
    $shell = (Get-Process -Id $PID).Path
    $logPath = Join-Path $runDir ("build-{0}.log" -f $buildId)
    $errPath = Join-Path $runDir ("build-{0}.err" -f $buildId)
    $scriptArg = if ($PSCommandPath -match '\s') { '"' + $PSCommandPath + '"' } else { $PSCommandPath }
    $childArgs = @('-NoProfile', '-File', $scriptArg) + @($GradleArgs) + @('-DetachedChild', '-HeartbeatSeconds', $HeartbeatSeconds,
        '-AcquireTimeoutMinutes', $AcquireTimeoutMinutes, '-MemoryPollSeconds', $MemoryPollSeconds)
    if ($StopDaemons) { $childArgs += '-StopDaemons' }
    if ($InstallSerial) { $childArgs += @('-InstallSerial', $InstallSerial) }
    if ($LaunchActivity) { $childArgs += '-LaunchActivity' }
    $child = Start-Process -FilePath $shell -ArgumentList $childArgs -WorkingDirectory $repo -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $logPath -RedirectStandardError $errPath
    $record = [ordered]@{
        pid = $child.Id
        startedUtc = [DateTime]::UtcNow.ToString('o')
        finishedUtc = $null
        exitCode = $null
        args = $GradleArgs
        log = $logPath
        err = $errPath
        worktree = $repo
    }
    [IO.File]::WriteAllText($runStatePath, ($record | ConvertTo-Json -Depth 4))
    Write-Output ("Background build started pid={0}" -f $child.Id)
    Write-Output ("log: {0}" -f $logPath)
    Write-Output ("poll: pwsh -File '{0}' -Status" -f $PSCommandPath)
    exit 0
}

function Get-FreeMemoryGb {
    # 可用内存只记录、不拦截，但如果连记录都拿不到数，日志里就会出现一个空白的「GB available」——
    # 2026-09-20 真的出现过一次，事后无法判断当时还剩多少内存。宁可留一个显眼错值也要有数。
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        $freeGb = [double]$os.FreePhysicalMemory / 1MB
        if ($freeGb -le 0) { return -1 }
        return $freeGb
    } catch {
        return -1
    }
}

function Normalize-Path([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-InstallLease {
    $path = Join-Path $leaseDir "$InstallSerial.json"
    if (-not (Test-Path $path)) {
        throw "Device lease is missing for $InstallSerial; acquire the device before building."
    }
    $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ((Normalize-Path $record.worktree) -ne (Normalize-Path $repo)) {
        throw "Device $InstallSerial belongs to another worktree: $($record.worktree)"
    }
}

function Write-BuildMetadata([double]$freeMemoryGb) {
    New-Item -ItemType Directory -Path $leaseDir -Force | Out-Null
    $record = [ordered]@{
        owner = $owner
        pid = $PID
        task = if ($env:PI_AGENT_TASK) { $env:PI_AGENT_TASK } else { 'unspecified' }
        worktree = (Get-Location).Path
        args = $GradleArgs
        acquiredUtc = [DateTime]::UtcNow.ToString('o')
        freeMemoryGb = [math]::Round($freeMemoryGb, 2)
    }
    [IO.File]::WriteAllText($metadataPath, ($record | ConvertTo-Json -Depth 4))
}

function Write-BuildManifest {
    $apkPath = Join-Path $android 'app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path $apkPath)) {
        if ($InstallSerial) { throw "Expected APK was not produced: $apkPath" }
        return $null
    }
    $apkPath = (Resolve-Path $apkPath).Path
    $manifestPath = "$apkPath.pi-remote-build.json"
    $record = [ordered]@{
        schema = 1
        buildId = $buildId
        owner = $owner
        worktree = $repo
        artifactPath = $apkPath
        sha256 = (Get-FileHash $apkPath -Algorithm SHA256).Hash.ToLowerInvariant()
        builtUtc = [DateTime]::UtcNow.ToString('o')
        gradleArgs = $GradleArgs
    }
    [IO.File]::WriteAllText($manifestPath, ($record | ConvertTo-Json -Depth 4))
    # A test APK can be installed and exercised after the build daemons exit, which
    # avoids running Gradle and an emulator together on memory-constrained hosts.
    $testApk = Join-Path $android 'app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
    if ((Test-Path $testApk) -and ($GradleArgs -match 'AndroidTest')) {
        $testRecord = [ordered]@{}
        foreach ($key in $record.Keys) { $testRecord[$key] = $record[$key] }
        $testRecord.artifactPath = (Resolve-Path $testApk).Path
        $testRecord.sha256 = (Get-FileHash $testApk -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText("$testApk.pi-remote-build.json", ($testRecord | ConvertTo-Json -Depth 4))
    }
    return [pscustomobject]@{ ArtifactPath = $apkPath; ManifestPath = $manifestPath }
}

function Remove-BuildMetadata {
    if (-not (Test-Path $metadataPath)) { return }
    try {
        $record = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        if ($record.owner -eq $owner) {
            Remove-Item -LiteralPath $metadataPath -Force
        }
    } catch {
        Write-Warning "Could not verify build metadata ownership: $metadataPath"
    }
}

function Get-DeadLeaseRecord([string]$Path) {
    # 记录里写了 pid 却从来没有校验它是否还活着：包装进程被杀时 finally 不会执行，
    # 占用文件就会留下来，下一个构建只能静默等到 120 分钟超时。
    try { $record = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return $null }
    if ($null -eq (Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue)) { return $record }
    return $null
}

function Enter-ResourceLease {
    $deadline = (Get-Date).AddMinutes($AcquireTimeoutMinutes)
    $started = Get-Date
    $reportedWait = $false
    while ((Get-Date) -lt $deadline) {
        try {
            $record = [ordered]@{
                owner = $owner
                pid = $PID
                task = if ($env:PI_AGENT_TASK) { $env:PI_AGENT_TASK } else { 'unspecified' }
                worktree = (Get-Location).Path
                operation = 'android-build'
                acquiredUtc = [DateTime]::UtcNow.ToString('o')
            }
            $bytes = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Depth 4))
            $stream = [IO.File]::Open($resourcePath, [IO.FileMode]::CreateNew,
                [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() }
            finally { $stream.Dispose() }
            return
        } catch [IO.IOException] {
            $dead = Get-DeadLeaseRecord $resourcePath
            if ($null -ne $dead) {
                Write-Output ("Taking over the machine resource lease left by dead PID {0} (task={1}, acquired={2})." -f
                    $dead.pid, $dead.task, $dead.acquiredUtc)
                try { Remove-Item -LiteralPath $resourcePath -Force -ErrorAction Stop } catch {
                    # 另一个等待者先接管了：让下一轮 CreateNew 决定归属。
                }
                continue
            }
            if (-not $reportedWait) {
                $holder = $null
                if (Test-Path -LiteralPath $resourcePath) {
                    try { $holder = Get-Content -LiteralPath $resourcePath -Raw | ConvertFrom-Json } catch { $holder = $null }
                }
                if ($null -ne $holder) {
                    Write-Output ("Waiting for the machine resource lease; holder PID {0} (task={1}, since {2})." -f
                        $holder.pid, $holder.task, $holder.acquiredUtc)
                } else {
                    Write-Output "Waiting for the machine resource lease: $resourcePath"
                }
                $reportedWait = $true
            } else {
                Write-Output ("Still waiting for the machine resource lease ({0:N0}s elapsed)." -f ((Get-Date) - $started).TotalSeconds)
            }
            Start-Sleep -Seconds $MemoryPollSeconds
        }
    }
    throw "Timed out waiting for the machine resource lease ($AcquireTimeoutMinutes minutes)."
}

function Exit-ResourceLease {
    if (-not (Test-Path $resourcePath)) { return }
    $record = Get-Content -LiteralPath $resourcePath -Raw | ConvertFrom-Json
    if ($record.owner -ne $owner) {
        throw 'The machine resource lease belongs to another task; refusing to remove it.'
    }
    Remove-Item -LiteralPath $resourcePath -Force
}

if ($InstallSerial) {
    Assert-InstallLease
}

$mutex = [Threading.Mutex]::new($false, $mutexName)
$acquired = $false
$exitCode = 1
try {
    # 另一个构建正在跑时，WaitOne 会一直静默；按心跳打印持有者，免得看起来像卡死。
    $slotDeadline = (Get-Date).AddMinutes($AcquireTimeoutMinutes)
    $slotStarted = Get-Date
    $slotAnnounced = $false
    while (-not $acquired -and (Get-Date) -lt $slotDeadline) {
        try {
            $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds($HeartbeatSeconds))
        } catch [Threading.AbandonedMutexException] {
            $acquired = $true
            Write-Warning 'The previous build wrapper exited unexpectedly; taking the released build mutex.'
        }
        if ($acquired) { break }
        $holder = $null
        if (Test-Path -LiteralPath $metadataPath) {
            try { $holder = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json } catch { $holder = $null }
        }
        if (-not $slotAnnounced) {
            if ($null -ne $holder) {
                Write-Output ("Waiting for the serialized Android build slot; holder PID {0} (task={1}, since {2})." -f
                    $holder.pid, $holder.task, $holder.acquiredUtc)
            } else {
                Write-Output 'Waiting for the serialized Android build slot.'
            }
            $slotAnnounced = $true
        } else {
            Write-Output ("Still waiting for the build slot ({0:N0}s elapsed)." -f ((Get-Date) - $slotStarted).TotalSeconds)
        }
    }
    if (-not $acquired) {
        throw "Timed out waiting for the serialized Android build slot ($AcquireTimeoutMinutes minutes)."
    }

    Enter-ResourceLease
    # 可用物理内存只记录、不再拦截：本机常态只剩 2–3 GB 可用，这道 ≥4 GB 的门槛会把 Android
    # 构建彻底堵死（2026-09-20 用户要求去掉）。数字仍写进构建元数据和日志，方便事后追查 OOM。
    $freeMemoryGb = Get-FreeMemoryGb
    Write-BuildMetadata $freeMemoryGb
    Write-Output ("Android build slot acquired by PID {0}; {1:N2} GB available." -f $PID, $freeMemoryGb)
    Write-Output ("Gradle args: {0}" -f ($GradleArgs -join ' '))

    if (-not $StopOnly) {
        # Gradle 会把 SDK / AGP 的警告写到 stderr（例如「SDK XML file of version 4 was encountered」）。
        # 在 $ErrorActionPreference = 'Stop' 下，PowerShell 把原生命令的每一条 stderr 记录都变成
        # NativeCommandError 终止错误：构建其实已经成功，脚本却中途退出——连带跳过 Write-BuildManifest，
        # 留下一个 sha256 对不上的陈旧清单（android-install.ps1 会因此拒绝安装）。
        # 构建结论只认退出码，所以这里把 EAP 降到 Continue，调用完立刻恢复。
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            # Gradle 的 daemon 会继承启动它的进程的标准输出。直接 `& $gradlew` 时它握住调用方的
            # 管道，直到空闲退出（10 分钟）才 EOF —— 调用方看起来就是卡死（2026-10-19 实测：
            # 首次构建卡住，复用已存在 daemon 的构建 2 秒返回）。让 cmd 自己打开日志文件，
            # gradle / daemon 继承的是文件而不是管道，包装进程退出后调用方立刻拿到控制权。
            New-Item -ItemType Directory -Path $runDir -Force | Out-Null
            $buildLogPath = Join-Path $runDir ("gradle-{0}.log" -f $buildId)
            $quotedArgs = (($GradleArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
            $buildCommand = 'call "' + $gradlew + '" -p "' + $android + '"' +
                $(if ($quotedArgs) { ' ' + $quotedArgs } else { '' }) +
                ' > "' + $buildLogPath + '" 2>&1'
            Write-Output ("Gradle log: {0}" -f $buildLogPath)
            # 不要用 -Wait：PowerShell 7 的 -Wait 会等整棵进程树，而 Gradle daemon 是 cmd 的孙
            # 进程，要空闲 10 分钟才退出。只等 cmd 本身。
            $buildProcess = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $buildCommand) -NoNewWindow -PassThru
            $buildProcess.WaitForExit()
            $exitCode = $buildProcess.ExitCode
            if (Test-Path -LiteralPath $buildLogPath) { Get-Content -LiteralPath $buildLogPath | Write-Output }
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($exitCode -ne 0) {
            Write-Error "Gradle build failed with exit code $exitCode."
        } else {
            $manifest = Write-BuildManifest
            if ($InstallSerial) {
                & $installScript -Serial $InstallSerial -Apk $manifest.ArtifactPath -StartActivity:$LaunchActivity
                $exitCode = $LASTEXITCODE
            }
        }
    } else {
        $exitCode = 0
    }

    if (($StopDaemons -or $StopOnly) -and $exitCode -eq 0) {
        & $gradlew --stop --console=plain
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Gradle daemon stop returned exit code $LASTEXITCODE."
        }
        $kotlinDaemons = Get-CimInstance Win32_Process | Where-Object {
            $_.CommandLine -match 'org\.jetbrains\.kotlin\.daemon\.KotlinCompileDaemon'
        }
        foreach ($daemon in $kotlinDaemons) {
            Stop-Process -Id $daemon.ProcessId -Force -ErrorAction Stop
            Write-Output "Stopped Kotlin daemon PID $($daemon.ProcessId)."
        }
    }
} finally {
    if ($DetachedChild) {
        # 写在 finally 里：构建失败（Write-Error 是终止错误）也要留下退出码，轮询才看得懂。
        $record = Read-RunRecord
        if ($null -ne $record -and [int]$record.pid -eq $PID) {
            $record.finishedUtc = [DateTime]::UtcNow.ToString('o')
            $record.exitCode = $exitCode
            [IO.File]::WriteAllText($runStatePath, ($record | ConvertTo-Json -Depth 4))
        }
    }
    Remove-BuildMetadata
    if (Test-Path $resourcePath) {
        try { Exit-ResourceLease } catch { Write-Warning $_.Exception.Message }
    }
    if ($acquired) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}

exit $exitCode
