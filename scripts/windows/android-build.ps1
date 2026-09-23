[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]] $GradleArgs,

    [switch] $StopDaemons,

    [switch] $StopOnly,

    [ValidatePattern('^emulator-\d+$')]
    [string] $InstallSerial,

    [switch] $LaunchActivity,

    [ValidateRange(1, 120)]
    [int] $AcquireTimeoutMinutes = 120,

    [ValidateRange(1, 60)]
    [int] $MemoryPollSeconds = 15
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

function Enter-ResourceLease {
    $deadline = (Get-Date).AddMinutes($AcquireTimeoutMinutes)
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
            if (-not $reportedWait) {
                Write-Output "Waiting for the machine resource lease: $resourcePath"
                $reportedWait = $true
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
    try {
        $acquired = $mutex.WaitOne([TimeSpan]::FromMinutes($AcquireTimeoutMinutes))
    } catch [Threading.AbandonedMutexException] {
        $acquired = $true
        Write-Warning 'The previous build wrapper exited unexpectedly; taking the released build mutex.'
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
            & $gradlew -p $android @GradleArgs
            $exitCode = $LASTEXITCODE
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
