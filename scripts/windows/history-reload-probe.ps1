[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [ValidatePattern('^[A-Za-z0-9._:-]+$')] [string] $Serial,
    [string] $LeaseOwner,
    # Exact online runtime-card titles. Used in memory only, never included in evidence.
    [ValidateCount(1, 4)] [string[]] $SessionTitles,
    [ValidateRange(1, 10)] [int] $Reloads = 3,
    [ValidateRange(1, 10)] [int] $Pages = 2,
    [ValidateRange(100, 60000)] [int] $MaxCachedLoadMs = 3000,
    [ValidateRange(5, 180)] [int] $TimeoutSeconds = 45,
    [ValidateRange(60, 1800)] [int] $TotalTimeoutSeconds = 180,
    [switch] $ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$package = 'com.orbising.orbis'
$activity = "$package/dev.pi.remote.MainActivity"
$evidence = Join-Path $repo '.artifacts\app'
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$leaseDir = if ($env:ORBIS_ANDROID_LEASE_DIR) { $env:ORBIS_ANDROID_LEASE_DIR } elseif (Test-Path 'D:\android-emulators') { 'D:\android-emulators\leases' } else { Join-Path $env:LOCALAPPDATA 'Orbis\android-leases' }
$leasePath = Join-Path $leaseDir "$Serial.json"
$results = [Collections.Generic.List[object]]::new()
$probeClock = $null
$probeFinishing = $false
$lastMemorySample = -15
$runId = [guid]::NewGuid().ToString()

function Invoke-Adb([string[]] $Arguments) {
    if (-not $script:probeFinishing -and $null -ne $script:probeClock -and
        $script:probeClock.Elapsed.TotalSeconds -ge $TotalTimeoutSeconds) {
        throw 'INCONCLUSIVE: UI probe total deadline reached; no more device actions will be scheduled.'
    }
    if (-not $script:probeFinishing -and $null -ne $script:probeClock -and
        $script:probeClock.Elapsed.TotalSeconds - $script:lastMemorySample -ge 15) {
        $script:lastMemorySample = $script:probeClock.Elapsed.TotalSeconds
        $free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB
        Write-Host ('UI_PROBE_SECONDS={0:N0} FREE_GB={1:N2}' -f $script:lastMemorySample, $free)
        if ($free -lt 1.5) { throw 'INCONCLUSIVE: stopped device probe for physical memory pressure.' }
    }
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
    $layout = [xml]$dump.Substring($xmlStart, $xmlEnd + '</hierarchy>'.Length - $xmlStart)
    if (@($layout.SelectNodes('//node') | Where-Object { $_.text -like '*Session 范围加载失败：limit_reached*' }).Count -gt 0) {
        throw 'REPRODUCED_LIMIT_REACHED_UI_ERROR: a bounded page was displayed as a Session range failure.'
    }
    return $layout
}
function Tap-Node($Node) {
    if ($Node.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { throw 'Invalid UI bounds' }
    $x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
    $y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
    Invoke-Adb @('shell', 'input', 'tap', "$x", "$y") | Out-Null
}
function Read-OnlineHome {
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $layout = Read-Layout
        $directoryFilter = @($layout.SelectNodes('//node') | Where-Object { $_.'content-desc' -like '筛选会话：*' })
        $open = @($layout.SelectNodes('//node') | Where-Object { $_.'content-desc' -eq '打开会话目录' })
        if ($open.Count -eq 1 -and $directoryFilter.Count -eq 0) { return $layout }
        Invoke-Adb @('shell', 'input', 'keyevent', '4') | Out-Null
        Start-Sleep -Milliseconds 700
    }
    throw 'INCONCLUSIVE: online runtime home was not reached; no arbitrary control was tapped.'
}
function Find-OnlineSessions {
    $titles = [Collections.Generic.List[string]]::new()
    for ($page = 0; $page -lt 4; $page++) {
        $layout = Read-OnlineHome
        $beforeCount = $titles.Count
        foreach ($alias in @($layout.SelectNodes('//node') | Where-Object { $_.'content-desc' -eq '修改会话别名' })) {
            $row = $alias.ParentNode
            while ($row.Name -eq 'node' -and $null -ne $row.ParentNode) {
                $texts = @($row.SelectNodes('.//node') | Where-Object { $_.text } | ForEach-Object { [string]$_.text })
                if ($row.clickable -eq 'true' -and @($texts | Where-Object { $_ -in @('Codex','Codex 终端','Codex 桌面版') }).Count -gt 0) { break }
                $row = $row.ParentNode
            }
            if ($row.Name -ne 'node' -or $row.clickable -ne 'true') { continue }
            $texts = @($row.SelectNodes('.//node') | Where-Object { $_.text } | ForEach-Object { [string]$_.text })
            if (@($texts | Where-Object { $_ -in @('Codex','Codex 终端','Codex 桌面版') }).Count -eq 0) { continue }
            if ($texts.Count -gt 0 -and -not $titles.Contains($texts[0])) { $titles.Add($texts[0]) }
        }
        if ($page -gt 0 -and $titles.Count -eq $beforeCount) { break }
        $viewport = Get-ChatViewport
        Invoke-Adb @('shell', 'input', 'swipe', "$($viewport[0])", "$($viewport[2])", "$($viewport[0])", "$($viewport[1])", '250') | Out-Null
        Start-Sleep -Milliseconds 700
    }
    if ($titles.Count -eq 0) { throw 'INCONCLUSIVE: no verifiable Codex runtime card visible; no offline row was activated.' }
    Write-Host "VERIFIED_ONLINE_CODEX_ROWS=$($titles.Count)"
    return @($titles.ToArray() | Select-Object -First 3)
}
function Open-Session([string] $Title) {
    # Runtime home cards invoke only selectRuntime. Unlike catalog rows they cannot activate
    # an offline backend; the alias control proves we are in the runtime-only card surface.
    $nodes = @()
    for ($page = 0; $page -lt 4; $page++) {
        $layout = Read-OnlineHome
        $nodes = @($layout.SelectNodes('//node') | Where-Object { $_.text -eq $Title })
        if ($nodes.Count -gt 0) { break }
        $viewport = Get-ChatViewport
        Invoke-Adb @('shell', 'input', 'swipe', "$($viewport[0])", "$($viewport[2])", "$($viewport[0])", "$($viewport[1])", '250') | Out-Null
        Start-Sleep -Milliseconds 700
    }
    if ($nodes.Count -ne 1) { throw 'Runtime title is not uniquely visible; no arbitrary row was tapped.' }
    $row = $nodes[0]
    while ($row.Name -eq 'node' -and $row.clickable -ne 'true' -and $null -ne $row.ParentNode) { $row = $row.ParentNode }
    $aliases = @($row.SelectNodes('.//node') | Where-Object { $_.'content-desc' -eq '修改会话别名' })
    if ($row.Name -ne 'node' -or $row.clickable -ne 'true' -or $aliases.Count -ne 1) { throw 'Not a verified runtime-only card; refusing to activate a session.' }
    # Capture before selection: Compose may start and finish cached pages before
    # Open-Session's initial settling delay or the next Measure-Page call returns.
    $script:roundTraces = @{}
    foreach ($record in @(Read-Probe)) { $script:roundTraces[$record.trace] = $true }
    Tap-Node $nodes[0]
    Start-Sleep -Seconds 5
}
function Restart-App {
    # Intentional process restart, not pm clear: pairing, SQLite and drafts remain intact.
    Invoke-Adb @('shell', 'am', 'force-stop', $package) | Out-Null
    $stopped = (Invoke-Adb @('shell', 'ps', '-A', '-o', 'NAME')).Trim() -split "`n"
    if (@($stopped | Where-Object { $_.Trim() -eq $package }).Count -gt 0) {
        throw 'Process did not stop; this is not a verified process-reopen run.'
    }
    Invoke-Adb @('shell', 'am', 'start', '-n', $activity) | Out-Null
    Start-Sleep -Seconds 5
}
function Get-ChatViewport {
    $layout = Read-Layout
    $scroll = @($layout.SelectNodes('//node') | Where-Object { $_.scrollable -eq 'true' })
    $node = $scroll | Sort-Object { if ($_.bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { ([int]$Matches[4] - [int]$Matches[2]) * ([int]$Matches[3] - [int]$Matches[1]) } else { 0 } } -Descending | Select-Object -First 1
    if ($null -eq $node) { $node = $layout.SelectSingleNode('/hierarchy/node') }
    if ($null -eq $node -or $node.bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { throw 'Cannot determine chat viewport' }
    $left = [int]$Matches[1]; $top = [int]$Matches[2]
    $width = [int]$Matches[3] - $left; $height = [int]$Matches[4] - $top
    return @(($left + [int]($width * 0.5)), ($top + [int]($height * 0.18)), ($top + [int]($height * 0.85)))
}
function Swipe-Older([int[]] $Viewport) {
    Invoke-Adb @('shell', 'input', 'swipe', "$($Viewport[0])", "$($Viewport[1])", "$($Viewport[0])", "$($Viewport[2])", '120') | Out-Null
}
function Measure-Page([int] $SessionNumber, [int] $Round, [int] $Page) {
    $existing = $script:roundTraces
    $viewport = Get-ChatViewport
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $start = $null; $end = $null; $records = @(); $swipes = 0
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
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
        if ($null -eq $start) { Swipe-Older $viewport; $swipes++ }
        Start-Sleep -Milliseconds 300
    }
    if ($null -ne $start) { $script:roundTraces[$start.trace] = $true }
    # Validate the visible UI after observing completion as well as before gestures.
    $null = Read-Layout
    $trace = if ($null -eq $start) { @() } else { @($records | Where-Object { $_.trace -eq $start.trace }) }
    $lock = $trace | Where-Object { $_.stage -eq 'lock_acquired' } | Select-Object -First 1
    $worker = $trace | Where-Object { $_.stage -eq 'worker_started' } | Select-Object -First 1
    $readBegin = $trace | Where-Object { $_.stage -eq 'cache_read_begin' } | Select-Object -First 1
    $readEnd = $trace | Where-Object { $_.stage -eq 'cache_read_end' } | Select-Object -First 1
    $source = if ($null -eq $end) { 'timeout' } elseif ($end.stage -in @('local_completed', 'local_exhausted')) { 'local' } elseif ($end.stage -eq 'snapshot_applied') { 'remote' } else { $end.stage }
    $result = [ordered]@{
        runId = $runId
        sessionNumber = $SessionNumber; round = $Round; page = $Page
        kind = if ($null -ne $start) { $start.kind } else { $null }
        session = if ($null -ne $start) { $start.session } else { $null }
        boundary = if ($null -ne $start) { $start.boundary } else { $null }
        leaf = if ($null -ne $start) { $start.leaf } else { $null }
        epoch = if ($null -ne $start) { $start.epoch } else { $null }
        source = $source
        elapsedMs = if ($source -eq 'local') { [long]$end.elapsedMs } else { $null }
        observationMs = [long]$timer.ElapsedMilliseconds
        additionalSwipes = $swipes
        processRestartVerified = $true
        lockWaitMs = if ($null -ne $lock -and $null -ne $worker) { [long]$lock.elapsedMs - [long]$worker.elapsedMs } else { $null }
        cacheReadMs = if ($null -ne $readEnd -and $null -ne $readBegin) { [long]$readEnd.elapsedMs - [long]$readBegin.elapsedMs } else { $null }
        verdict = 'INCONCLUSIVE'
    }
    if ($null -ne $start -and $start.kind -notin @('codex', 'codexDesktop', 'pi')) { throw 'Unexpected backend selected' }
    if ($Round -gt 0) {
        $warm = @($results | Where-Object { $_.round -eq 0 -and $_.session -eq $result.session -and $_.boundary -eq $result.boundary -and $_.leaf -eq $result.leaf -and $_.epoch -eq $result.epoch -and $_.source -in @('local', 'remote') })
        if ($warm.Count -gt 0) {
            $result.verdict = if ($source -eq 'local' -and $result.elapsedMs -le $MaxCachedLoadMs) { 'PASS' } else { 'FAIL' }
        }
    }
    $results.Add([pscustomobject]$result)
    # Checkpoint per page; an interrupted shell must not leave an old run's results
    # looking like the latest evidence.
    $results.ToArray() | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $evidence 'history-probe-results.json')
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
[IO.File]::WriteAllText((Join-Path $evidence 'history-probe-results.json'), '[]')
$probeClock = [Diagnostics.Stopwatch]::StartNew()
try {
    Invoke-Adb @('shell', 'setprop', 'log.tag.OrbisHistory', 'DEBUG') | Out-Null
    if (-not $SessionTitles -or $SessionTitles.Count -eq 0) {
        Restart-App
        $SessionTitles = @(Find-OnlineSessions)
    }
    for ($session = 0; $session -lt $SessionTitles.Count; $session++) {
        for ($round = 0; $round -le $Reloads; $round++) {
            # Return to the runtime home before stopping so every measured selection
            # starts from a fresh window, not a wider auto-restored in-memory page.
            $null = Read-OnlineHome
            Restart-App
            Open-Session $SessionTitles[$session]
            # Exercise a real gesture even when short cached projections have already
            # auto-paged. Completed operations remain observable through roundTraces.
            Swipe-Older (Get-ChatViewport)
            for ($page = 1; $page -le $Pages; $page++) {
                $source = Measure-Page ($session + 1) $round $page
                if ($source -notin @('local', 'remote')) { break }
            }
        }
    }
} finally {
    $probeFinishing = $true
    try {
        $results.ToArray() | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $evidence 'history-probe-results.json')
        # Persist ONLY our content-free diagnostic records, never generic logcat or UI XML.
        @(Read-Probe | Where-Object { -not $initialTraces.ContainsKey($_.trace) }) | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $evidence 'history-probe-traces.json')
    } finally {
        $restore = if ($oldLevel) { $oldLevel } else { '""' }
        Invoke-Adb @('shell', 'setprop', 'log.tag.OrbisHistory', $restore) | Out-Null
        Invoke-Adb @('shell', 'am', 'start', '-n', $activity) | Out-Null
    }
}
$failures = @($results | Where-Object { $_.verdict -eq 'FAIL' })
$checked = @($results | Where-Object { $_.verdict -eq 'PASS' })
$sessionKeys = @($results | Where-Object { $_.round -eq 0 -and $null -ne $_.session } | Select-Object -ExpandProperty session -Unique)
if ($failures.Count -gt 0) { throw "History reload regression reproduced: $($failures.Count) cached page(s) slow, missing, or fetched remotely. See .artifacts/app/history-probe-results.json" }
if ($checked.Count -eq 0 -or $sessionKeys.Count -ne $SessionTitles.Count -or @($results | Where-Object { $_.round -gt 0 -and $_.verdict -eq 'INCONCLUSIVE' }).Count -gt 0) { throw 'INCONCLUSIVE: no verified same-boundary cached reload, a session was not reached, or history changed during the run. This is NOT a pass.' }
Write-Output "PASS: $($checked.Count) same-boundary cached reloads completed locally within ${MaxCachedLoadMs}ms"
