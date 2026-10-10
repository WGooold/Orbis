[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [ValidatePattern('^[A-Za-z0-9._:-]+$')] [string] $Serial,
    [string] $LeaseOwner,
    # Exact visible sidebar titles. Used in memory only, never included in evidence.
    [Parameter(Mandatory = $true)] [ValidateCount(1, 4)] [string[]] $SessionTitles,
    [ValidateRange(1, 10)] [int] $Reloads = 3,
    [ValidateRange(1, 10)] [int] $Pages = 2,
    [ValidateRange(100, 60000)] [int] $MaxCachedLoadMs = 3000,
    [ValidateRange(5, 180)] [int] $TimeoutSeconds = 45,
    [switch] $ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$package = 'com.orbising.orbis'
$activity = "$package/dev.pi.remote.MainActivity"
$evidence = Join-Path $repo '.artifacts\app'
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$leaseDir = if ($env:ORBIS_ANDROID_LEASE_DIR) { $env:ORBIS_ANDROID_LEASE_DIR } else { 'D:\android-emulators\leases' }
$leasePath = Join-Path $leaseDir "$Serial.json"
$results = [Collections.Generic.List[object]]::new()

function Invoke-Adb([string[]] $Arguments) {
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
    try {
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            $process.WaitForExit()
            throw "adb operation timed out: $($Arguments[0])"
        }
        $output = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "adb operation failed: $($Arguments[0]) (exit $($process.ExitCode))" }
        return $output
    } finally { $process.Dispose() }
}
function Read-Probe {
    $text = Invoke-Adb @('logcat', '-d', '-v', 'raw', '-s', 'OrbisHistory:D', '*:S')
    $records = [Collections.Generic.List[object]]::new()
    foreach ($line in ($text -split "`n")) {
        if ($line -notmatch '\[DEBUG-history\] trace=') { continue }
        $record = @{}
        foreach ($match in [regex]::Matches($line, '(\w+)=([^\s]+)')) {
            $record[$match.Groups[1].Value] = $match.Groups[2].Value
        }
        $records.Add($record)
    }
    return $records.ToArray()
}
function Read-Layout {
    # UI XML can contain conversation text: parse only in memory, never save or print it.
    $dump = Invoke-Adb @('exec-out', 'uiautomator', 'dump', '/dev/tty')
    $xmlStart = $dump.IndexOf('<?xml')
    $xmlEnd = $dump.LastIndexOf('</hierarchy>')
    if ($xmlStart -lt 0 -or $xmlEnd -lt $xmlStart) { throw 'Cannot read UI hierarchy; unlock the phone.' }
    return [xml]$dump.Substring($xmlStart, $xmlEnd + '</hierarchy>'.Length - $xmlStart)
}
function Tap-Node($Node) {
    if ($Node.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { throw 'Invalid UI bounds' }
    $x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
    $y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
    Invoke-Adb @('shell', 'input', 'tap', "$x", "$y") | Out-Null
}
function Open-Session([string] $Title) {
    $layout = Read-Layout
    $open = @($layout.SelectNodes('//node') | Where-Object { $_.'content-desc' -eq '打开会话目录' })
    if ($open.Count -eq 0) {
        Invoke-Adb @('shell', 'input', 'keyevent', '4') | Out-Null
        Start-Sleep -Milliseconds 700
        $layout = Read-Layout
        $open = @($layout.SelectNodes('//node') | Where-Object { $_.'content-desc' -eq '打开会话目录' })
    }
    if ($open.Count -eq 1) { Tap-Node $open[0]; Start-Sleep -Milliseconds 700 }
    $layout = Read-Layout
    $nodes = @($layout.SelectNodes('//node') | Where-Object { $_.text -eq $Title })
    if ($nodes.Count -ne 1) { throw 'Session title is not uniquely visible in the sidebar; expand its directory or use a unique alias. No arbitrary row was tapped.' }
    # Refuse offline history / activation: test only an already-online Codex or Pi row.
    $row = $nodes[0]
    while ($null -ne $row.ParentNode -and $row.Name -eq 'node' -and $row.clickable -ne 'true') { $row = $row.ParentNode }
    $online = @($row.SelectNodes('.//node') | Where-Object { $_.text -eq '在线' })
    if ($row.Name -ne 'node' -or $online.Count -eq 0) { throw 'Selected row is not verifiably online; refusing to activate a session.' }
    Tap-Node $nodes[0]
    Start-Sleep -Seconds 5
}
function Restart-App {
    # Intentional process restart, not pm clear: pairing, SQLite and drafts remain intact.
    Invoke-Adb @('shell', 'am', 'force-stop', $package) | Out-Null
    Invoke-Adb @('shell', 'am', 'start', '-n', $activity) | Out-Null
    Start-Sleep -Seconds 5
}
function Swipe-Older {
    $layout = Read-Layout
    $node = $layout.SelectSingleNode('/hierarchy/node')
    if ($null -eq $node -or $node.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { throw 'Cannot determine app viewport' }
    $left = [int]$Matches[1]; $top = [int]$Matches[2]
    $width = [int]$Matches[3] - $left; $height = [int]$Matches[4] - $top
    $x = $left + [int]($width * 0.5)
    $from = $top + [int]($height * 0.3); $to = $top + [int]($height * 0.72)
    Invoke-Adb @('shell', 'input', 'swipe', "$x", "$from", "$x", "$to", '250') | Out-Null
}
function Measure-Page([int] $SessionNumber, [int] $Round, [int] $Page) {
    $before = @(Read-Probe)
    $existing = @{}; foreach ($record in $before) { $existing[$record.trace] = $true }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $start = $null; $end = $null; $records = @()
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if ($null -eq $start) { Swipe-Older }
        Start-Sleep -Milliseconds 300
        $records = @(Read-Probe)
        $newStarts = @($records | Where-Object {
            $_.stage -eq 'start' -and $_.range -eq 'history' -and -not $existing.ContainsKey($_.trace)
        })
        if ($null -eq $start -and $newStarts.Count -gt 0) {
            # Snapshot traces also have range=history; paging worker traces have worker_started.
            $start = $newStarts | Where-Object {
                $candidate = $_.trace
                @($records | Where-Object { $_.trace -eq $candidate -and $_.stage -eq 'worker_started' }).Count -gt 0
            } | Select-Object -First 1
        }
        if ($null -ne $start) {
            $end = $records | Where-Object {
                $_.trace -eq $start.trace -and $_.stage -in @('local_completed', 'local_exhausted', 'cache_rebuilt')
            } | Select-Object -First 1
            if ($null -eq $end) {
                $end = $records | Where-Object { $_.stage -eq 'snapshot_applied' -and $_.accepted -eq 'true' -and $_.loading -eq 'false' -and $_.error -eq 'false' } | Where-Object {
                    $snapshotId = $_.trace
                    @($records | Where-Object { $_.trace -eq $snapshotId -and $_.stage -eq 'start' -and $_.session -eq $start.session -and $_.boundary -eq $start.boundary }).Count -gt 0 -and -not $existing.ContainsKey($snapshotId)
                } | Select-Object -First 1
            }
            if ($null -ne $end) { break }
        }
    }
    $trace = if ($null -eq $start) { @() } else { @($records | Where-Object { $_.trace -eq $start.trace }) }
    $lock = $trace | Where-Object { $_.stage -eq 'lock_acquired' } | Select-Object -First 1
    $worker = $trace | Where-Object { $_.stage -eq 'worker_started' } | Select-Object -First 1
    $readBegin = $trace | Where-Object { $_.stage -eq 'cache_read_begin' } | Select-Object -First 1
    $readEnd = $trace | Where-Object { $_.stage -eq 'cache_read_end' } | Select-Object -First 1
    $source = if ($null -eq $end) { 'timeout' } elseif ($end.stage -eq 'local_completed') { 'local' } elseif ($end.stage -eq 'snapshot_applied') { 'remote' } else { $end.stage }
    $result = [ordered]@{
        sessionNumber = $SessionNumber; round = $Round; page = $Page
        kind = if ($null -ne $start) { $start.kind } else { $null }
        session = if ($null -ne $start) { $start.session } else { $null }
        boundary = if ($null -ne $start) { $start.boundary } else { $null }
        source = $source
        elapsedMs = if ($source -eq 'local') { [long]$end.elapsedMs } else { $null }
        observationMs = [long]$timer.ElapsedMilliseconds
        lockWaitMs = if ($null -ne $lock -and $null -ne $worker) { [long]$lock.elapsedMs - [long]$worker.elapsedMs } else { $null }
        cacheReadMs = if ($null -ne $readEnd -and $null -ne $readBegin) { [long]$readEnd.elapsedMs - [long]$readBegin.elapsedMs } else { $null }
        verdict = 'INCONCLUSIVE'
    }
    if ($null -ne $start -and $start.kind -notin @('codex', 'codexDesktop', 'pi')) { throw 'Unexpected backend selected' }
    if ($Round -gt 0) {
        $warm = @($results | Where-Object { $_.round -eq 0 -and $_.session -eq $result.session -and $_.boundary -eq $result.boundary -and $_.source -in @('local', 'remote') })
        if ($warm.Count -gt 0) {
            $result.verdict = if ($source -eq 'local' -and $result.elapsedMs -le $MaxCachedLoadMs) { 'PASS' } else { 'FAIL' }
        }
    }
    $results.Add([pscustomobject]$result)
    Write-Host ("session={0} round={1} page={2} source={3} lockMs={4} readMs={5} verdict={6}" -f $SessionNumber, $Round, $Page, $source, $result.lockWaitMs, $result.cacheReadMs, $result.verdict)
    return $source
}

if ($ValidateOnly) { Write-Output 'History probe script loaded successfully'; exit 0 }
if (-not (Test-Path $adb)) { throw 'Windows Android SDK / adb.exe is missing' }
if (-not (Test-Path $leasePath)) { throw 'Acquire an explicit device lease before running the probe' }
$lease = Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json
if (-not $LeaseOwner -or $lease.owner -ne $LeaseOwner -or [IO.Path]::GetFullPath($lease.worktree).TrimEnd('\') -ne [IO.Path]::GetFullPath($repo).TrimEnd('\') -or $lease.serial -ne $Serial) { throw 'Device lease belongs to a different task/worktree; supply the exact LeaseOwner' }
if ((Invoke-Adb @('get-state')).Trim() -ne 'device') { throw 'Device is not authorized/ready' }
$oldLevel = (Invoke-Adb @('shell', 'getprop', 'log.tag.OrbisHistory')).Trim()
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$initialTraces = @{}; foreach ($record in @(Read-Probe)) { $initialTraces[$record.trace] = $true }
try {
    Invoke-Adb @('shell', 'setprop', 'log.tag.OrbisHistory', 'DEBUG') | Out-Null
    for ($session = 0; $session -lt $SessionTitles.Count; $session++) {
        for ($round = 0; $round -le $Reloads; $round++) {
            Restart-App
            Open-Session $SessionTitles[$session]
            for ($page = 1; $page -le $Pages; $page++) {
                $source = Measure-Page ($session + 1) $round $page
                if ($source -notin @('local', 'remote')) { break }
            }
        }
    }
} finally {
    try {
        $results.ToArray() | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $evidence 'history-probe-results.json')
        # Persist ONLY our content-free diagnostic records, never generic logcat or UI XML.
        @(Read-Probe | Where-Object { -not $initialTraces.ContainsKey($_.trace) }) | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $evidence 'history-probe-traces.json')
    } finally {
        $restore = if ($oldLevel) { $oldLevel } else { '""' }
        Invoke-Adb @('shell', 'setprop', 'log.tag.OrbisHistory', $restore) | Out-Null
    }
}
$failures = @($results | Where-Object { $_.verdict -eq 'FAIL' })
$checked = @($results | Where-Object { $_.verdict -eq 'PASS' })
$sessionKeys = @($results | Where-Object { $_.round -eq 0 -and $null -ne $_.session } | Select-Object -ExpandProperty session -Unique)
if ($failures.Count -gt 0) { throw "History reload regression reproduced: $($failures.Count) cached page(s) slow, missing, or fetched remotely. See .artifacts/app/history-probe-results.json" }
if ($checked.Count -eq 0 -or $sessionKeys.Count -ne $SessionTitles.Count -or @($results | Where-Object { $_.round -gt 0 -and $_.verdict -eq 'INCONCLUSIVE' }).Count -gt 0) { throw 'INCONCLUSIVE: no verified same-boundary cached reload, a session was not reached, or history changed during the run. This is NOT a pass.' }
Write-Output "PASS: $($checked.Count) same-boundary cached reloads completed locally within ${MaxCachedLoadMs}ms"
