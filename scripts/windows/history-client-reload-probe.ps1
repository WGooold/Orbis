[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [ValidatePattern('^[A-Za-z0-9._:-]+$')] [string] $Serial,
    [string] $LeaseOwner,
    [ValidateRange(95, 180)] [int] $TimeoutSeconds = 120,
    [switch] $ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$evidence = Join-Path $repo '.artifacts\app'
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$leaseDir = if ($env:ORBIS_ANDROID_LEASE_DIR) { $env:ORBIS_ANDROID_LEASE_DIR } elseif (Test-Path 'D:\android-emulators') { 'D:\android-emulators\leases' } else { Join-Path $env:LOCALAPPDATA 'Orbis\android-leases' }
$package = 'com.orbising.orbis'
$runId = [guid]::NewGuid().ToString()

function Start-Adb([string[]] $Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $adb
    $info.Arguments = (@('-s', $Serial) + $Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $null = $process.Start()
    return $process
}
function Invoke-Adb([string[]] $Arguments) {
    $process = Start-Adb $Arguments
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            $process.Kill(); $process.WaitForExit()
            throw "adb operation timed out: $($Arguments[0])"
        }
        $output = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "adb operation failed: $($Arguments[0]) (exit $($process.ExitCode))" }
        return $output
    } finally { $process.Dispose() }
}
function Assert-Lease {
    $path = Join-Path $leaseDir "$Serial.json"
    if (-not (Test-Path $path)) { throw 'Acquire the device lease before running this opt-in probe.' }
    $lease = [IO.File]::ReadAllText($path) | ConvertFrom-Json
    if (-not $LeaseOwner -or $lease.owner -ne $LeaseOwner -or $lease.serial -ne $Serial -or
        [IO.Path]::GetFullPath($lease.worktree).TrimEnd('\') -ne [IO.Path]::GetFullPath($repo).TrimEnd('\')) {
        throw 'Device lease does not belong to this task/worktree.'
    }
}
if ($ValidateOnly) { Write-Output 'Client reload probe script loaded successfully'; exit 0 }
if (-not (Test-Path $adb)) { throw 'Windows Android SDK / adb.exe is missing.' }
Assert-Lease
if ((Invoke-Adb @('get-state')).Trim() -ne 'device') { throw 'Device is not authorized/ready.' }
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$oldLevel = (Invoke-Adb @('shell', 'getprop', 'log.tag.OrbisHistory')).Trim()
$process = $null
try {
    $free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB
    if ($free -lt 1.5) { throw 'INCONCLUSIVE: insufficient physical memory for device validation.' }
    Invoke-Adb @('shell', 'am', 'force-stop', $package) | Out-Null
    Invoke-Adb @('shell', 'setprop', 'log.tag.OrbisHistory', 'DEBUG') | Out-Null
    $process = Start-Adb @('shell', 'am', 'instrument', '-w', '-e', 'liveHistory', 'true',
        '-e', 'historyRunId', $runId, '-e', 'class', 'dev.pi.remote.LiveHistoryReloadInstrumentedTest',
        'com.orbising.orbis.test/androidx.test.runner.AndroidJUnitRunner')
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (-not $process.WaitForExit(1000)) {
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            throw 'INCONCLUSIVE: client probe deadline; this is not an App regression verdict.'
        }
        if ([int]$timer.Elapsed.TotalSeconds % 15 -eq 0) {
            $free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB
            Write-Host ('CLIENT_PROBE_SECONDS={0:N0} FREE_GB={1:N2}' -f $timer.Elapsed.TotalSeconds, $free)
            if ($free -lt 1.5) { throw 'INCONCLUSIVE: stopped device probe for physical memory pressure.' }
        }
    }
    $output = $stdout.GetAwaiter().GetResult()
    $errors = $stderr.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $evidence 'live-history-reload.log'), $output)
    [IO.File]::WriteAllText((Join-Path $evidence 'live-history-reload-errors.log'), $errors)
    # Never let an old successful JSON on the phone masquerade as this run's result.
    $text = Invoke-Adb @('exec-out', 'cat', "/sdcard/Android/data/$package/files/live-history-reload.json")
    $records = @($text | ConvertFrom-Json)
    $catalog = @($records | Where-Object { $_.PSObject.Properties.Name -contains 'stage' -and $_.stage -eq 'catalog' })
    if ($catalog.Count -ne 1 -or $catalog[0].runId -ne $runId) {
        throw 'INCONCLUSIVE: no evidence with this run identity; check instrumentation output.'
    }
    [IO.File]::WriteAllText((Join-Path $evidence 'live-history-reload.json'), $text)
    $pages = @($records | Where-Object { $_.PSObject.Properties.Name -contains 'round' })
    $cached = @($pages | Where-Object { $_.sameCachedBoundary })
    Write-Host "PAGES=$($pages.Count) SAME_BOUNDARY_COMPARISONS=$($cached.Count)"
    if ($process.ExitCode -ne 0 -or $output -notmatch 'OK \(1 test\)' -or $cached.Count -eq 0) {
        throw 'Client probe did not pass; read current-run output and do not treat adb exit 0 as success.'
    }
    Write-Output "PASS: $($cached.Count) current-run same-window cached client reloads; process/UI reopening is a separate probe."
} finally {
    if ($null -ne $process) {
        if (-not $process.HasExited) {
            # Only the authorized phone App, never the Host or another task's processes.
            Invoke-Adb @('shell', 'am', 'force-stop', $package) | Out-Null
            if (-not $process.WaitForExit(5000)) { $process.Kill(); $process.WaitForExit() }
        }
        [IO.File]::WriteAllText((Join-Path $evidence 'live-history-reload.log'), $stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $evidence 'live-history-reload-errors.log'), $stderr.GetAwaiter().GetResult())
        $process.Dispose()
        # The watchdog file is optional. Save it only if it belongs to this invocation.
        try {
            $waitText = Invoke-Adb @('exec-out', 'cat', "/sdcard/Android/data/$package/files/live-history-wait.json")
            $wait = $waitText | ConvertFrom-Json
            if ($wait.runId -eq $runId) { [IO.File]::WriteAllText((Join-Path $evidence 'live-history-wait.json'), $waitText) }
        } catch { Write-Verbose 'No current-run watchdog evidence.' }
    }
    try {
        $restore = if ($oldLevel) { $oldLevel } else { '""' }
        Invoke-Adb @('shell', 'setprop', 'log.tag.OrbisHistory', $restore) | Out-Null
        Invoke-Adb @('shell', 'am', 'start', '-n', "$package/dev.pi.remote.MainActivity") | Out-Null
    } finally {
        # The caller owns the lease and simulator lifecycle; this script never steals/releases it.
        Write-Host "Evidence: $evidence"
    }
}
