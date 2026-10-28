#requires -Version 7
<#
.SYNOPSIS
    Orbis 内存采样器：验证「手机/ Host 一上线，Pi 的内存就按会话总量的倍数持续上涨」这一猜想。

.DESCRIPTION
    采样很轻（Get-Process + 会话文件增量扫描 + 扩展日志增量扫描），不重启、不改状态、不碰被测进程。

    每条样本除了各进程的 WS/私有内存，还记录验证猜想需要的量：
      * session_mb   —— 当前 Pi 会话文件的总字节数（S）。这是当前实现里每次 sync 都会被
                        重新序列化 + 深拷贝一遍的那份历史，文本和图片都算。
      * image_mb / image_count —— 其中图片 base64 的部分（I）。
      * syncs_per_min —— 手机驱动 session.sync 的实际频率（来自 pi-extension-runtime.log）
      * connected    —— 该样本是否处在 Host/手机在线阶段
      * turn         —— 该 Pi 进程当时是否在跑回合（来自扩展发布的 running/waiting）
      * ratio        —— 该进程 WS / S（判断峰值是不是按会话总量的倍数放大）

    回合在跑的时候自动切到 token 级采样（默认 1 秒），因为回合内的增长与 sync 无关：
    每个 delta 都会把 live 状态重新序列化、深拷贝一遍。

    连上后自动进入密集采样（默认每 2 秒），掉线回落（默认每 10 秒），跑完自动出结论：
    在线/离线斜率对比、峰值÷S 的实测倍数、每次 sync 的实测内存增量与「2×S 起」的预测对比、
    进程消失（疑似 heap OOM）的位置，以及窗口内是否真的观测到 GB 级。

    CSV 与结论写在 <repo>\.scratch\memory-monitor\ 下（.scratch 已 gitignore）。

    怎么用它验证猜想：
      1. -Action Start（后台）或 -Action Watch（前台）。
      2. 打开 Host / 连上手机，保持一段时间（不读图也能看出来）。
      3. -Action Status，看四件事：
         a. 在线阶段斜率 > 0、离线阶段斜率 ≈ 0；
         b. S（会话总量）在这一阶段有没有变——不变也照涨，就是纯按倍数放大；
         c. Pi 峰值 ÷ S 的实测倍数，以及每次 sync 的实测增量 vs 2×S 的预测；
         d. 是否有进程在峰值附近消失（疑似 heap OOM）。
      4. 单独核对某个会话：-Action Inspect -SessionPath <会话文件>。

.EXAMPLE
    # 后台开始；只要 Host/手机上线就开始密集采样，问题复现后回来看结论
    pwsh -File scripts\windows\memory-monitor.ps1 -Action Start

.EXAMPLE
    # 前台盯着（结束时打印结论）
    pwsh -File scripts\windows\memory-monitor.ps1 -Action Watch

.EXAMPLE
    # 采样进行中：状态 + 结论
    pwsh -File scripts\windows\memory-monitor.ps1 -Action Status

.EXAMPLE
    # 事后只看某个 CSV 的结论
    pwsh -File scripts\windows\memory-monitor.ps1 -Action Verify -Csv .scratch\memory-monitor\samples-20261021-201206.csv
#>
[CmdletBinding()]
param(
    [ValidateSet('Start', 'Status', 'Stop', 'Report', 'Verify', 'Inspect', 'Watch', 'Sample')]
    [string] $Action = 'Status',

    # 手机 serial；缺省按 adb devices 取第一台。设备不可达时只采 PC。
    [ValidatePattern('^[A-Za-z0-9._:-]*$')]
    [string] $Serial = '',

    [ValidateRange(1, 300)] [int] $IntervalSeconds = 10,
    # 判定「手机在拉 sync」的时间窗。
    [ValidateRange(10, 3600)] [int] $ConnectWindowSeconds = 90,
    # 判定「Host 已连上 Pi」的时间窗：bridge.transport.connected 是一次性事件，窗口要长。
    [ValidateRange(60, 86400)] [int] $LinkWindowSeconds = 900,
    # 上线后的密集采样间隔。验证峰值必须比 sync 周期更密，默认 2 秒。
    [ValidateRange(1, 60)] [int] $ConnectedIntervalSeconds = 2,
    # 正在跑回合时的采样间隔。回合里每个 token 都会走一遍 live 状态，必须比它更密。
    [ValidateRange(1, 60)] [int] $TurnIntervalSeconds = 1,
    [ValidateRange(1, 1440)] [int] $DurationMinutes = 60,
    [string] $Package = 'com.orbising.orbis',

    # 只跟踪最近 modified 的若干个 Pi 会话文件（默认 3）。
    [ValidateRange(1, 20)] [int] $WatchSessionFiles = 3,
    # 超过这么久没写过的会话文件才需要靠「记得上次是谁」来继续跟踪。
    [ValidateRange(30, 86400)] [int] $ActiveSessionWindowSeconds = 300,
    # Pi 会话根；缺省 %USERPROFILE%\.pi\agent\sessions
    [string[]] $SessionRoot = @(),
    # 显式指定 pi-extension-runtime.log（自动发现失败时用）。
    [string[]] $PiLog = @(),
    # 不依赖日志，强制把每个样本标成上线（用于手工复现）。
    [switch] $ForceConnected,

    # Inspect 用：直接对指定会话文件统计。
    [string[]] $SessionPath = @(),

    # Report / Verify 用；缺省用最近一次采样文件。
    [string] $Csv = '',
    # 判定「疑似泄漏」的阈值（MB/分钟）。
    [ValidateRange(1, 10000)] [int] $WarnMegabytesPerMinute = 20,
    # 报告里保留的行数上限（只影响打印）。
    [ValidateRange(1, 100)] [int] $Top = 12
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# 结论里全是中文：控制台按 UTF-8 输出，避免 -File 调用时变成乱码。
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$workDir = Join-Path $repo '.scratch\memory-monitor'
$statePath = Join-Path $workDir 'state.json'

$Header = @(
    'sampledAt', 'source', 'pid', 'tag', 'ws_mb', 'priv_mb', 'free_gb',
    'rss_kb', 'pss_kb', 'dalvik_kb', 'native_kb', 'name',
    'connected', 'turn', 'syncs_per_min', 'session_mb', 'image_mb', 'image_count', 'ratio', 'session'
) -join ','

# 单次 sync 至少会为这份历史分配多少：reconcile 里两遍 JSON.stringify（旧/新）+ 一遍
# structuredClone，接近 3×S；这里给一个保守区间用于对照。
$SyncAllocLowFactor = 2.0
$SyncAllocHighFactor = 4.0

# ── 进程标签 / adb ──────────────────────────────────────────────────────────

function Resolve-Adb {
    if ($env:ANDROID_HOME -and (Test-Path (Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'))) {
        return (Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe')
    }
    foreach ($candidate in @('D:\android-sdk\platform-tools\adb.exe', 'D:\agent\platform-tools-latest-windows\platform-tools\adb.exe')) {
        if (Test-Path $candidate) { return $candidate }
    }
    $cmd = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Resolve-Serial([string] $Requested, [string] $Adb) {
    if (-not $Adb -or -not (Test-Path $Adb)) { return '' }
    if ($Requested) { return $Requested }
    try {
        $lines = & $Adb devices 2>$null | Select-Object -Skip 1
        foreach ($line in $lines) {
            $parts = ($line -replace '\s+', ' ').Trim().Split(' ')
            if ($parts.Count -ge 2 -and $parts[1] -eq 'device') { return $parts[0] }
        }
    } catch { }
    return ''
}

# 只用标签记录「这是什么东西」，命令行正文不入库。
function Get-ProcessTag([string] $Name, [string] $CommandLine) {
    $base = [IO.Path]::GetFileNameWithoutExtension($Name)
    if ($base -ne 'node') { return $base }
    if (-not $CommandLine) { return 'node' }
    if ($CommandLine -match 'pi-coding-agent.*bundle[\\/]cli\.js') { return 'pi-cli' }
    if ($CommandLine -match 'packages[\\/]host[\\/]dist') { return 'orbis-host-node' }
    if ($CommandLine -match '@deepseek-ai[\\/]dsh') { return 'dsh-web' }
    if ($CommandLine -match 'codex.*app-server') { return 'codex-app-server' }
    if ($CommandLine -match 'vitest') { return 'vitest' }
    if ($CommandLine -match 'Orbis') { return 'orbis-node' }
    return 'node-other'
}

function Get-AndroidSample([string] $Adb, [string] $Target, [string] $Pkg) {
    $row = [ordered]@{ pid = ''; pss_kb = ''; dalvik_kb = ''; native_kb = '' }
    if (-not $Adb -or -not $Target) { return $row }
    try { $raw = & $Adb -s $Target shell dumpsys meminfo $Pkg 2>$null } catch { return $row }
    if (-not $raw) { return $row }
    $text = ($raw -join "`n")
    if ($text -match 'No process found') { return $row }
    if ($text -match '\*\* MEMINFO in pid (\d+)') { $row.pid = $Matches[1] }
    if ($text -match 'TOTAL PSS:\s+(\d+)') { $row.pss_kb = $Matches[1] }
    elseif ($text -match '(?m)^\s*TOTAL\s+(\d+)') { $row.pss_kb = $Matches[1] }
    if ($text -match '(?m)^\s*Dalvik Heap\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)') { $row.dalvik_kb = $Matches[1] }
    if ($text -match '(?m)^\s*Native Heap\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)') { $row.native_kb = $Matches[1] }
    return $row
}

# ── 增量读文件（日志 / 会话共用） ────────────────────────────────────────────

# 返回自上次读取以来新增的文本。单次最多 32MB，并且只在最后一个换行处切断——
# 一行可能是一条 1.7MB 的图片 entry，从中间截断会让它被永久漏计。
function Read-FileDelta([string] $Path, [hashtable] $Offsets) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $info = [IO.FileInfo]::new($Path)
    $offset = 0
    if ($Offsets.ContainsKey($Path)) { $offset = [int64] $Offsets[$Path] }
    if ($info.Length -lt $offset) { $offset = 0 }
    if ($info.Length -eq $offset) { return '' }
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        [void] $stream.Seek($offset, [IO.SeekOrigin]::Begin)
        $remaining = $info.Length - $offset
        $buffer = New-Object byte[] ([int] [math]::Min($remaining, 32MB))
        $read = $stream.Read($buffer, 0, $buffer.Length)
        $text = [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        $consumed = $read
        if ($offset + $read -lt $info.Length) {
            $cut = $text.LastIndexOf("`n")
            if ($cut -lt 0) { return '' }
            $text = $text.Substring(0, $cut + 1)
            $consumed = [Text.Encoding]::UTF8.GetByteCount($text)
        }
        $Offsets[$Path] = $offset + $consumed
        return $text
    } catch {
        return ''
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

# ── 会话文件：总量 S 与其中的图片字节 I ──────────────────────────────────────

# 会话目录名 ←→ cwd 的编码：`--D--orbis--` ←→ `D:\orbis`。
function ConvertFrom-SessionSlug([string] $Slug) {
    $body = $Slug.Trim('-')
    $parts = @($body -split '--' | Where-Object { $_ -ne '' })
    if ($parts.Count -eq 0) { return $null }
    $head = $parts[0]
    if ($head -match '^[A-Za-z]$') {
        $rest = if ($parts.Count -gt 1) { ($parts[1..($parts.Count - 1)] -join '\') } else { '' }
        return ('{0}:\{1}' -f $head, $rest)
    }
    if ($head -eq 'mnt' -and $parts.Count -gt 1) { return ('/' + ($parts -join '/')) }
    return $null
}

function Get-SessionRoots {
    $roots = [Collections.Generic.List[string]]::new()
    foreach ($root in $SessionRoot) { if ($root) { $roots.Add($root) } }
    if ($roots.Count -eq 0) { $roots.Add((Join-Path $HOME '.pi\agent\sessions')) }
    return @($roots | Where-Object { Test-Path -LiteralPath $_ })
}

# 一旦发现就记住：空闲时文件不再被写，但它仍然是「当前会话」，S 不能因此归零。
$script:KnownSessions = @{}
function Get-ActiveSessionFiles {
    $since = (Get-Date).AddSeconds(-1 * $ActiveSessionWindowSeconds)
    foreach ($root in (Get-SessionRoots)) {
        foreach ($dir in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            $newest = Get-ChildItem -LiteralPath $dir.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if (-not $newest -or $newest.LastWriteTime -lt $since) { continue }
            $script:KnownSessions[$newest.FullName] = [pscustomobject]@{
                Path = $newest.FullName
                Slug = $dir.Name
                Cwd  = (ConvertFrom-SessionSlug $dir.Name)
                LastWriteTime = $newest.LastWriteTime
                Size = $newest.Length
            }
        }
    }
    foreach ($key in @($script:KnownSessions.Keys)) {
        $session = $script:KnownSessions[$key]
        $info = [IO.FileInfo]::new($key)
        if (-not $info.Exists) { $script:KnownSessions.Remove($key); continue }
        $session.LastWriteTime = $info.LastWriteTime
        $session.Size = $info.Length
    }
    if ($script:KnownSessions.Count -eq 0) {
        # 什么都没发现（刚启动 / 长时间空闲）：取最新的一个会话文件，
        # 否则 S 会一直显示 0，看起来像「没有历史」。
        foreach ($root in (Get-SessionRoots)) {
            $newest = Get-ChildItem -LiteralPath $root -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if (-not $newest) { continue }
            $slug = Split-Path -Leaf (Split-Path -Parent $newest.FullName)
            $script:KnownSessions[$newest.FullName] = [pscustomobject]@{
                Path = $newest.FullName; Slug = $slug; Cwd = (ConvertFrom-SessionSlug $slug)
                LastWriteTime = $newest.LastWriteTime; Size = $newest.Length
            }
        }
    }
    return @($script:KnownSessions.Values | Sort-Object LastWriteTime -Descending | Select-Object -First $WatchSessionFiles)
}

# 增量统计图片部分；会话总量直接取文件长度（它就是每次 sync 要处理的那份历史）。
$script:ImageState = @{}
function Update-SessionImages {
    $results = [Collections.Generic.List[object]]::new()
    foreach ($file in (@(Get-ActiveSessionFiles))) {
        if (-not $script:ImageState.ContainsKey($file.Path)) {
            $script:ImageState[$file.Path] = @{ Offset = [int64] 0; Bytes = [int64] 0; Count = [int64] 0 }
        }
        $state = $script:ImageState[$file.Path]
        $delta = Read-FileDelta $file.Path $state
        if ($delta -and [regex]::IsMatch($delta, '"type"\s*:\s*"image"')) {
            foreach ($match in [regex]::Matches($delta, '"type"\s*:\s*"image"[^{}]*?"data"\s*:\s*"([A-Za-z0-9+/=]*)"')) {
                $state.Bytes += $match.Groups[1].Value.Length
                $state.Count += 1
            }
        }
        $results.Add([pscustomobject]@{
                Path  = $file.Path
                Name  = (Split-Path -Leaf (Split-Path -Parent $file.Path)) + '/' + (Split-Path -Leaf $file.Path)
                Size  = $file.Size
                Bytes = $state.Bytes
                Count = $state.Count
            })
    }
    return $results
}

# ── 上线判定：解析 pi-extension-runtime.log ─────────────────────────────────

$script:LogOffsets = @{}
$script:SyncTimes = [Collections.Generic.List[datetime]]::new()
$script:LinkTimes = [Collections.Generic.List[datetime]]::new()
# pid -> 最近一次 runtime.status（"running" / "waiting" / "idle"）。回合状态由扩展自己发布，
# 不依赖 Host 是否连着。
$script:TurnState = @{}
$script:PiLogCache = @{ At = [datetime]::MinValue; Paths = @() }
$script:KnownLogs = [Collections.Generic.List[string]]::new()

function Resolve-PiLogs {
    # 日志路径每 30 秒重算一次；已发现的日志始终保留（空闲时会话文件不再被写，重算可能找不到）。
    if (((Get-Date) - $script:PiLogCache.At).TotalSeconds -lt 30 -and $script:PiLogCache.Paths.Count -gt 0) {
        return $script:PiLogCache.Paths
    }
    $logs = [Collections.Generic.List[string]]::new()
    foreach ($known in $script:KnownLogs) { if (Test-Path -LiteralPath $known) { $logs.Add($known) } }
    foreach ($path in $PiLog) { if ($path -and (Test-Path -LiteralPath $path)) { $logs.Add($path) } }
    if ($logs.Count -eq 0) {
        # 会话 slug 能还原出 Pi 的 cwd，扩展就是把日志写进 <cwd>\data 的。
        $candidateRoots = [Collections.Generic.List[string]]::new()
        foreach ($file in (@(Get-ActiveSessionFiles))) {
            if ($file.Cwd) {
                $candidateRoots.Add($file.Cwd)
                $candidateRoots.Add((Join-Path $file.Cwd 'data'))
            }
        }
        $candidateRoots.Add((Join-Path $HOME '.orbis\logs'))
        $candidateRoots.Add((Join-Path $HOME '.pi\agent'))
        $candidateRoots.Add((Join-Path $HOME '.pi\agent\data'))
        $candidateRoots.Add($repo)
        $candidateRoots.Add((Join-Path $repo 'data'))
        foreach ($root in $candidateRoots) {
            foreach ($path in @((Join-Path $root 'pi-extension-runtime.log'), (Join-Path $root 'data\pi-extension-runtime.log'))) {
                if (Test-Path -LiteralPath $path) { $logs.Add($path) }
            }
        }
    }
    $resolved = @($logs | Select-Object -Unique)
    foreach ($path in $resolved) { if (-not $script:KnownLogs.Contains($path)) { $script:KnownLogs.Add($path) } }
    $script:PiLogCache = @{ At = (Get-Date); Paths = $resolved }
    return $resolved
}

function Update-SyncTimes {
    foreach ($path in (Resolve-PiLogs)) {
        $delta = Read-FileDelta $path $script:LogOffsets
        if (-not $delta) { continue }
        $wanted = $delta.Contains('session_sync.request') -or $delta.Contains('bridge.transport.connected') -or
            $delta.Contains('runtime.status.published')
        if (-not $wanted) { continue }
        foreach ($line in ($delta -split "`n")) {
            if ($line.Contains('"bridge.session_sync.request"')) {
                if ($line -notmatch '"timestamp"\s*:\s*"([^"]+)"') { continue }
                try { $script:SyncTimes.Add(([datetimeoffset]::Parse($Matches[1])).LocalDateTime) } catch { }
            } elseif ($line.Contains('"bridge.transport.connected"')) {
                if ($line -notmatch '"timestamp"\s*:\s*"([^"]+)"') { continue }
                try { $script:LinkTimes.Add(([datetimeoffset]::Parse($Matches[1])).LocalDateTime) } catch { }
            } elseif ($line.Contains('"runtime.status.published"')) {
                if ($line -notmatch '"pid"\s*:\s*(\d+)') { continue }
                # 不要用 $pid：PowerShell 里 $PID 是只读自动变量，赋值会抛异常。
                $processId = [int] $Matches[1]
                if ($line -match '"status"\s*:\s*"([a-z_]+)"') { $script:TurnState[$processId] = $Matches[1] }
            }
        }
    }
    $cutoff = (Get-Date).AddMinutes(-5)
    while ($script:SyncTimes.Count -gt 0 -and $script:SyncTimes[0] -lt $cutoff) { $script:SyncTimes.RemoveAt(0) }
    $linkCutoff = (Get-Date).AddSeconds(-1 * $LinkWindowSeconds)
    while ($script:LinkTimes.Count -gt 0 -and $script:LinkTimes[0] -lt $linkCutoff) { $script:LinkTimes.RemoveAt(0) }
}

# 扩展报告的 running / waiting 就是有没有回合在跑。
function Test-PidTurn([int] $ProcessId) {
    $status = if ($script:TurnState.ContainsKey($ProcessId)) { $script:TurnState[$ProcessId] } else { $null }
    return $status -eq 'running' -or $status -eq 'waiting'
}

function Test-TurnRunning {
    foreach ($key in @($script:TurnState.Keys)) { if (Test-PidTurn $key) { return $true } }
    return $false
}

function Get-SyncsPerMinute {
    if ($script:SyncTimes.Count -eq 0) { return 0 }
    $cutoff = (Get-Date).AddMinutes(-1)
    return [math]::Round(@($script:SyncTimes | Where-Object { $_ -ge $cutoff }).Count, 1)
}

function Test-Connected {
    if ($ForceConnected) { return $true }
    $syncCutoff = (Get-Date).AddSeconds(-1 * $ConnectWindowSeconds)
    if (@($script:SyncTimes | Where-Object { $_ -ge $syncCutoff }).Count -gt 0) { return $true }
    # Host 已连上但这一分钟没 sync：也算「在线」，否则连上 Host 的静默增长会被当成离线。
    $linkCutoff = (Get-Date).AddSeconds(-1 * $LinkWindowSeconds)
    return (@($script:LinkTimes | Where-Object { $_ -ge $linkCutoff }).Count -gt 0)
}

# ── 采样 ─────────────────────────────────────────────────────────────────────

function Write-Sample([string] $CsvPath) {
    $adb = Resolve-Adb
    $target = Resolve-Serial $Serial $adb
    $stamp = (Get-Date).ToString('o')
    $freeGb = ''
    try { $freeGb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 2) } catch { }

    Update-SyncTimes
    $connected = Test-Connected
    $syncsPerMinute = Get-SyncsPerMinute
    $sessions = @(Update-SessionImages)
    $primary = if ($sessions.Count -gt 0) { $sessions[0] } else { $null }
    $sessionMb = if ($primary) { [math]::Round($primary.Size / 1MB) } else { 0 }
    $imageMb = if ($primary) { [math]::Round($primary.Bytes / 1MB) } else { 0 }
    $imageCount = if ($primary) { $primary.Count } else { 0 }
    $sessionName = if ($primary) { $primary.Name } else { '' }

    $rows = [Collections.Generic.List[string]]::new()
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='OrbisHost.exe' or Name='pi.exe'" -ErrorAction SilentlyContinue)
    foreach ($proc in $procs) {
        $live = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
        if (-not $live) { continue }
        $tag = Get-ProcessTag $proc.Name ($proc.CommandLine ?? '')
        $wsMb = [math]::Round($live.WorkingSet64 / 1MB)
        $ratio = if ($sessionMb -ge 1 -and $tag -eq 'pi-cli') { [math]::Round($wsMb / $sessionMb, 2) } else { '' }
        $turn = if (Test-PidTurn ([int] $proc.ProcessId)) { 1 } else { 0 }
        $rows.Add((@(
            $stamp, 'pc', $proc.ProcessId, $tag, $wsMb,
            [math]::Round($live.PrivateMemorySize64 / 1MB), $freeGb, '', '', '', '',
            ($proc.Name -replace ',', ' '),
            ($(if ($connected) { 1 } else { 0 })), $turn, $syncsPerMinute, $sessionMb, $imageMb, $imageCount, $ratio,
            ($sessionName -replace ',', ' ')
        ) -join ','))
    }

    $android = Get-AndroidSample $adb $target $Package
    $rows.Add((@(
        $stamp, 'android',
        ($(if ($android.pid) { $android.pid } else { '-' })),
        ($(if ($android.pid) { 'app' } else { 'app-not-running' })),
        '', '', $freeGb, '', $android.pss_kb, $android.dalvik_kb, $android.native_kb, $Package,
        ($(if ($connected) { 1 } else { 0 })), 0, $syncsPerMinute, $sessionMb, $imageMb, $imageCount, '',
        ($sessionName -replace ',', ' ')
    ) -join ','))

    Add-Content -LiteralPath $CsvPath -Value $rows -Encoding utf8
}

$script:SampleFailures = 0
function Invoke-Sampler([string] $CsvPath) {
    $script:SampleFailures = 0
    $deadline = (Get-Date).AddMinutes($DurationMinutes)
    Set-Content -LiteralPath $CsvPath -Value $Header -Encoding utf8
    $last = $false
    $lastTurn = $false
    while ((Get-Date) -lt $deadline) {
        try { Write-Sample $CsvPath }
        catch {
            $script:SampleFailures += 1
            if ($script:SampleFailures -eq 1 -or $script:SampleFailures % 30 -eq 0) {
                Write-Host ("采样失败（第 {0} 次）：{1}" -f $script:SampleFailures, $_.Exception.Message)
            }
        }
        $connected = Test-Connected
        $turn = Test-TurnRunning
        if ($connected -ne $last) {
            $note = if ($connected) { 'Host/手机上线，进入密集采样' } else { '掉线，回落为稀疏采样' }
            Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $note)
            $last = $connected
        }
        if ($turn -ne $lastTurn) {
            $note = if ($turn) { '回合开始，按 token 级间隔采样' } else { '回合结束，回落采样' }
            Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $note)
            $lastTurn = $turn
        }
        $sleep = if ($turn) { $TurnIntervalSeconds } elseif ($connected) { $ConnectedIntervalSeconds } else { $IntervalSeconds }
        Start-Sleep -Seconds $sleep
    }
    try { Write-Sample $CsvPath } catch { $script:SampleFailures += 1 }
    if ($script:SampleFailures -gt 0) {
        Write-Host ("注意：本轮有 {0} 次采样失败，CSV 里可能没有数据。" -f $script:SampleFailures)
    }
    $verdict = Join-Path (Split-Path -Parent $CsvPath) (('verdict-{0}.txt' -f [IO.Path]::GetFileNameWithoutExtension($CsvPath)))
    try {
        Show-Verdict $CsvPath | Out-String | Set-Content -LiteralPath $verdict -Encoding utf8
        Write-Host ("结论已写入：{0}" -f $verdict)
    } catch { }
}

# ── 结论 ─────────────────────────────────────────────────────────────────────

function Read-Samples([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { throw "没有找到采样文件：$Path" }
    $rows = Import-Csv -LiteralPath $Path
    $headers = @($rows | Select-Object -First 1 | ForEach-Object { $_.PSObject.Properties.Name })
    $hasEvidence = $headers -contains 'session_mb'
    foreach ($row in $rows) {
        [pscustomobject]@{
            At = [datetime]::Parse($row.sampledAt)
            Source = $row.source
            Pid = $row.pid
            Tag = $row.tag
            WsMb = if ($row.ws_mb) { [double]$row.ws_mb } else { $null }
            PrivMb = if ($row.priv_mb) { [double]$row.priv_mb } else { $null }
            FreeGb = if ($row.free_gb) { [double]$row.free_gb } else { $null }
            PssKb = if ($row.pss_kb) { [double]$row.pss_kb } else { $null }
            DalvikKb = if ($row.dalvik_kb) { [double]$row.dalvik_kb } else { $null }
            NativeKb = if ($row.native_kb) { [double]$row.native_kb } else { $null }
            Connected = $hasEvidence -and ($row.connected -eq '1')
            Turn = $hasEvidence -and ($row.turn -eq '1')
            SyncsPerMinute = if ($hasEvidence -and $row.syncs_per_min) { [double]$row.syncs_per_min } else { $null }
            SessionMb = if ($hasEvidence -and $row.session_mb) { [double]$row.session_mb } else { $null }
            ImageMb = if ($hasEvidence -and $row.image_mb) { [double]$row.image_mb } else { $null }
            ImageCount = if ($hasEvidence -and $row.image_count) { [double]$row.image_count } else { $null }
            Ratio = if ($hasEvidence -and $row.ratio) { [double]$row.ratio } else { $null }
            Session = if ($hasEvidence) { $row.session } else { '' }
            HasEvidence = $hasEvidence
        }
    }
}

function Get-Slope([object[]] $Rows, [bool] $Connected) {
    $filtered = @($Rows | Where-Object { $_.Connected -eq $Connected } | Sort-Object At)
    if ($filtered.Count -lt 2) { return $null }
    $minutes = [math]::Max(((New-TimeSpan -Start $filtered[0].At -End $filtered[-1].At).TotalMinutes), 1 / 60)
    return [pscustomobject]@{
        Samples = $filtered.Count
        Start = $filtered[0].WsMb
        End = $filtered[-1].WsMb
        Peak = ($filtered | Measure-Object -Property WsMb -Maximum).Maximum
        MbPerMinute = [math]::Round(($filtered[-1].WsMb - $filtered[0].WsMb) / $minutes, 1)
        MaxJump = [math]::Round((@($filtered | Select-Object -Skip 1 | ForEach-Object -Begin { $prev = $filtered[0].WsMb } -Process {
            $d = $_.WsMb - $prev; $prev = $_.WsMb; $d } | Measure-Object -Maximum).Maximum), 1)
    }
}

# 回合中 / 在线空闲 / 离线 三段的斜率。回合中的增长与 sync 无关（token 级 live 状态），
# 必须单独算出来，否则会被在线阶段的混合斜率盖住。
function Get-TurnSlope([object[]] $Rows) {
    $filtered = @($Rows | Where-Object { $_.Turn } | Sort-Object At)
    if ($filtered.Count -lt 2) { return $null }
    $seconds = [math]::Max(((New-TimeSpan -Start $filtered[0].At -End $filtered[-1].At).TotalSeconds), 1)
    $maxJump = 0
    for ($i = 1; $i -lt $filtered.Count; $i++) {
        $maxJump = [math]::Max($maxJump, $filtered[$i].WsMb - $filtered[$i - 1].WsMb)
    }
    return [pscustomobject]@{
        Samples = $filtered.Count
        Seconds = [math]::Round($seconds)
        Start = $filtered[0].WsMb
        End = $filtered[-1].WsMb
        Peak = ($filtered | Measure-Object -Property WsMb -Maximum).Maximum
        MbPerMinute = [math]::Round(($filtered[-1].WsMb - $filtered[0].WsMb) / ($seconds / 60), 1)
        MbPerSecond = [math]::Round(($filtered[-1].WsMb - $filtered[0].WsMb) / $seconds, 1)
        MaxJump = [math]::Round($maxJump, 1)
    }
}

function Show-Verdict([string] $Path) {
    $samples = @(Read-Samples $Path)
    if ($samples.Count -eq 0) { throw "采样文件是空的：$Path" }
    $first = ($samples | Measure-Object -Property At -Minimum).Minimum
    $last = ($samples | Measure-Object -Property At -Maximum).Maximum
    $minutes = [math]::Max(((New-TimeSpan -Start $first -End $last).TotalMinutes), 1 / 60)
    $pc = @($samples | Where-Object { $_.Source -eq 'pc' -and $null -ne $_.WsMb })
    $online = @($pc | Where-Object { $_.Connected })

    Write-Host ("采样窗口：{0:MM-dd HH:mm:ss} → {1:HH:mm:ss}（{2:N1} 分钟），共 {3} 行；在线样本 {4} 行" -f
        $first, $last, $minutes, $samples.Count, $online.Count)
    if (-not $samples[0].HasEvidence) {
        Write-Host '这份 CSV 是旧版脚本采的（没有 session_mb / syncs_per_min 列），无法验证猜想；用 -Action Start 重采。'
        return
    }
    if ($online.Count -eq 0) {
        Write-Host '窗口内没有检测到 Host 连接或手机 session.sync：先 Start，再打开 Host / 连手机复现。'
        return
    }

    # 1) 会话总量 S 与其中的图片部分
    $sRows = @($online | Where-Object { $null -ne $_.SessionMb } | Sort-Object At)
    $sFirst = $sRows[0]
    $sLast = $sRows[-1]
    $sMax = ($sRows | Sort-Object SessionMb -Descending)[0]
    Write-Host ("`n会话总量 S：{0:N0}MB → {1:N0}MB（峰值 {2:N0}MB），其中图片 {3:N0}MB / {4:N0} 张（{5}）" -f
        $sFirst.SessionMb, $sLast.SessionMb, $sMax.SessionMb, $sMax.ImageMb, $sMax.ImageCount, $sMax.Session)
    if ($sLast.SessionMb -eq $sFirst.SessionMb) {
        Write-Host '  → S 在窗口内没有变化：如果内存仍然上涨，涨的就是「按 S 的倍数重复分配」，与新增内容无关。'
    }

    # 2) sync 频率
    $sync = @($online | Where-Object { $null -ne $_.SyncsPerMinute })
    if ($sync.Count -gt 0) {
        $syncPeak = ($sync | Measure-Object -Property SyncsPerMinute -Maximum).Maximum
        $syncAvg = [math]::Round((($sync | Measure-Object -Property SyncsPerMinute -Average).Average), 1)
        Write-Host ("sync 频率：平均 {0}/分钟，峰值 {1}/分钟" -f $syncAvg, $syncPeak)
    }

    # 3) 每个进程：上线斜率 vs 离线斜率、峰值、峰值/S
    Write-Host "`n进程                                上线斜率      离线斜率      峰值    峰值/S"
    $groups = $pc | Group-Object { '{0}#{1}' -f $_.Tag, $_.Pid }
    foreach ($group in ($groups | Sort-Object { ($_.Group | Measure-Object -Property WsMb -Maximum).Maximum } -Descending)) {
        $rows = @($group.Group | Sort-Object At)
        $on = Get-Slope $rows $true
        $off = Get-Slope $rows $false
        if (-not $on) { continue }
        $peakRow = ($rows | Sort-Object WsMb -Descending)[0]
        $peak = [math]::Round($peakRow.WsMb)
        $sAtPeak = if ($null -ne $peakRow.SessionMb -and $peakRow.SessionMb -ge 1) { [math]::Round($peak / $peakRow.SessionMb, 1) } else { $null }
        Write-Host ("{0,-34} {1,8} MB/分 {2,10} MB/分 {3,8} MB {4,8}" -f
            ('{0}#{1}' -f $peakRow.Tag, $peakRow.Pid),
            $(if ($on) { $on.MbPerMinute } else { '-' }),
            $(if ($off) { $off.MbPerMinute } else { '   -' }),
            $peak,
            $(if ($null -ne $sAtPeak) { 'x' + $sAtPeak } else { '-' }))
    }

    # 3) 回合中：与 sync 无关的 token 级增长
    $turnAny = @($pc | Where-Object { $_.Turn })
    if ($turnAny.Count -gt 0) {
        Write-Host ("`n回合期间（扩展发布 running/waiting，token 级采样）：{0} 行样本" -f $turnAny.Count)
        Write-Host '进程                                回合中斜率  回合中峰值跳变  同步次数' 
        foreach ($group in ($turnAny | Group-Object { '{0}#{1}' -f $_.Tag, $_.Pid } | Sort-Object { ($_.Group | Measure-Object -Property WsMb -Maximum).Maximum } -Descending)) {
            $rows = @($group.Group | Sort-Object At)
            $t = Get-TurnSlope $rows
            if (-not $t) { continue }
            $syncs = ($rows | Where-Object { $null -ne $_.SyncsPerMinute } | Measure-Object -Property SyncsPerMinute -Average).Average
            Write-Host ("{0,-34} {1,8} MB/s {2,12} MB {3,10}" -f
                $group.Name, $t.MbPerSecond, $t.MaxJump, $(if ($null -ne $syncs) { [math]::Round($syncs, 1).ToString() + '/分' } else { '-' }))
            if ($t.MbPerSecond -ge 1) {
                Write-Host '  [支持] 回合内每秒涨 ≥1MB：增长来自 token 级 live 状态重算，不是 sync 频率。'
            }
        }
        # 与同进程的「在线空闲」「离线」对比
        Write-Host "`n分段斜率对比（MB/分钟）："
        foreach ($group in ($groups | Where-Object { $_.Group[0].Tag -eq 'pi-cli' })) {
            $rows = @($group.Group | Sort-Object At)
            $t = Get-TurnSlope $rows
            $idleOnline = @($rows | Where-Object { $_.Connected -and -not $_.Turn })
            $offline = @($rows | Where-Object { -not $_.Connected })
            $oi = if ($idleOnline.Count -ge 2) { Get-Slope $idleOnline $true } else { $null }
            $off = if ($offline.Count -ge 2) { Get-Slope $offline $false } else { $null }
            Write-Host ("  {0,-32} 回合中 {1,8}  在线空闲 {2,8}  离线 {3,8}" -f
                $group.Name,
                $(if ($t) { $t.MbPerMinute } else { '   -' }),
                $(if ($oi) { $oi.MbPerMinute } else { '   -' }),
                $(if ($off) { $off.MbPerMinute } else { '   -' }))
        }
    } else {
        Write-Host "`n回合期间：窗口内没有采到 running/waiting 样本（采样器可能在回合结束后才启动）。"
    }

    # 4) 每次 sync 的实测内存增量 vs 预测（2×S 起）
    $piOnline = @($online | Where-Object { $_.Tag -eq 'pi-cli' })
    if ($piOnline.Count -ge 2 -and $sync.Count -gt 0) {
        $piGroups = $piOnline | Group-Object { '{0}#{1}' -f $_.Tag, $_.Pid }
        foreach ($group in $piGroups) {
            $rows = @($group.Group | Sort-Object At)
            $span = [math]::Max(((New-TimeSpan -Start $rows[0].At -End $rows[-1].At).TotalMinutes), 1 / 60)
            $delta = $rows[-1].WsMb - $rows[0].WsMb
            $avgSyncs = ($rows | Where-Object { $null -ne $_.SyncsPerMinute } | Measure-Object -Property SyncsPerMinute -Average).Average
            $sAvg = ($rows | Where-Object { $null -ne $_.SessionMb } | Measure-Object -Property SessionMb -Average).Average
            if ($null -eq $avgSyncs -or $avgSyncs -le 0) { continue }
            $syncsInWindow = [math]::Max([math]::Round($avgSyncs * $span, 1), 1)
            $perSync = [math]::Round($delta / $syncsInWindow, 1)
            $perSyncRatio = [math]::Round($perSync / [math]::Max($sAvg, 1), 1)
            Write-Host ("`n每次 sync 的实测 WS 增量：{0}MB（窗口内约 {1} 次 sync，S≈{2:N0}MB ⇒ {3}×S）" -f $perSync, $syncsInWindow, $sAvg, $perSyncRatio)
            Write-Host ("  预测（reconcile 两遍 JSON.stringify + 一遍 structuredClone）：{0:N0}–{1:N0}MB/次" -f
                ($sAvg * $SyncAllocLowFactor), ($sAvg * $SyncAllocHighFactor))
            if ($perSyncRatio -ge 1 -and $perSyncRatio -le 12) {
                Write-Host '  [支持] 每次 sync 的增量与「按会话总量整体重算」同量级。'
            } else {
                Write-Host '  [不支持/证据不足] 增量与 2–4×S 的预测不同量级，需要换解释。'
            }
        }
    }

    # 5) 进程消失 = 疑似 OOM
    $vanished = @()
    foreach ($group in $groups) {
        $rows = @($group.Group | Sort-Object At)
        $endGap = ($last - $rows[-1].At).TotalSeconds
        if ($endGap -lt 30) { continue }
        if ($rows[-1].Tag -notin @('pi-cli', 'orbis-host-node')) { continue }
        $vanished += [pscustomobject]@{
            Key = $group.Name; Last = $rows[-1].At; Ws = [math]::Round($rows[-1].WsMb)
            S = $rows[-1].SessionMb; Syncs = $rows[-1].SyncsPerMinute; GoneSeconds = [math]::Round($endGap)
        }
    }

    # 6) 判断
    Write-Host "`n判断："
    $connectedRise = $false
    $idleFlat = $false
    foreach ($group in ($groups | Where-Object { $_.Group[0].Tag -eq 'pi-cli' })) {
        $rows = @($group.Group | Sort-Object At)
        $on = Get-Slope $rows $true
        $off = Get-Slope $rows $false
        if ($on -and $on.MbPerMinute -ge 5) { $connectedRise = $true }
        if ($off -and [math]::Abs($off.MbPerMinute) -lt 5) { $idleFlat = $true }
    }
    Write-Host ("  [{0}] Pi 只在上线阶段持续增长（离线斜率接近 0）" -f
        ($(if ($connectedRise -and $idleFlat) { '支持' } elseif ($connectedRise) { '部分支持' } else { '不支持' })))
    $piPeakRow = $null
    $piGroups = @($groups | Where-Object { $_.Group[0].Tag -eq 'pi-cli' })
    if ($piGroups.Count -gt 0) { $piPeakRow = ($piGroups | ForEach-Object { $_.Group } | Sort-Object WsMb -Descending)[0] }
    if ($piPeakRow -and $piPeakRow.SessionMb -ge 1) {
        # 基线（Node/TUI 常驻）远大于 S 时，直接相除没有意义：先减掉本窗口见过的最小值。
        $piBaseline = ($piGroups | ForEach-Object { $_.Group } | Measure-Object -Property WsMb -Minimum).Minimum
        $excess = $piPeakRow.WsMb - $piBaseline
        Write-Host ("  [观察] Pi 峰值 {0:N0}MB（基线 {1:N0}MB，超出 {2:N0}MB）/ 当时 S {3:N0}MB" -f
            $piPeakRow.WsMb, $piBaseline, $excess, $piPeakRow.SessionMb)
        if ($piPeakRow.SessionMb -lt 10) {
            Write-Host '  [不适用] S 小于 10MB：此时峰值由 Node/TUI 基线主导，比值不能用来判定同步成本。'
        } else {
            $excessRatio = [math]::Round($excess / $piPeakRow.SessionMb, 1)
            Write-Host ("  [观察] 超出部分 / S = {0}×（实现在 sync/回合里整段重算，预期 1–6）" -f $excessRatio)
            Write-Host ("  [{0}] 峰值按会话总量的倍数放大" -f
                ($(if ($excessRatio -ge 1 -and $excessRatio -le 12) { '支持' } else { '证据不足' })))
        }
    }
    if ($vanished.Count -gt 0) {
        Write-Host '  [支持] 有进程在采样中途消失（疑似 heap OOM / 被系统杀掉）：'
        foreach ($v in $vanished) {
            Write-Host ("         {0} 最后样本 {1:HH:mm:ss} WS={2}MB S={3}MB sync={4}/分，之后 {5}s 无样本" -f
                $v.Key, $v.Last, $v.Ws, $v.S, $v.Syncs, $v.GoneSeconds)
        }
    } else {
        Write-Host '  [证据不足] 窗口内没有进程消失，还没复现 OOM。'
    }
    $globalPeak = ($pc | Measure-Object -Property WsMb -Maximum).Maximum
    if ($globalPeak -ge 2048) {
        Write-Host ("  [支持] 窗口内观测到 GB 级：峰值 {0:N0}MB" -f $globalPeak)
    } else {
        Write-Host ("  [证据不足] 窗口内峰值只有 {0:N0}MB，还没到几个 GB" -f $globalPeak)
    }
    Write-Host "`n提示：S 取当前 Pi 会话文件的总字节数是下界（不含 live 工具结果、Host 侧副本与 TUI 自身）。"
}

function Show-Report([string] $Path) {
    $samples = @(Read-Samples $Path)
    if ($samples.Count -eq 0) { throw "采样文件是空的：$Path" }
    $first = ($samples | Measure-Object -Property At -Minimum).Minimum
    $last = ($samples | Measure-Object -Property At -Maximum).Maximum
    $minutes = [math]::Max(((New-TimeSpan -Start $first -End $last).TotalMinutes), 1 / 60)
    Write-Host ("采样：{0} 行，{1:HH:mm:ss} → {2:HH:mm:ss}（{3:N1} 分钟），文件 {4}" -f
        $samples.Count, $first, $last, $minutes, $Path)

    $free = $samples | Where-Object { $null -ne $_.FreeGb }
    if ($free) {
        $firstFree = ($free | Select-Object -First 1).FreeGb
        $lastFree = ($free | Select-Object -Last 1).FreeGb
        Write-Host ("PC 可用物理内存：{0:N2} GB → {1:N2} GB（{2:N0} MB/分钟）" -f
            $firstFree, $lastFree, (($lastFree - $firstFree) * 1024 / $minutes))
    }

    $groups = $samples | Where-Object { $_.Source -eq 'pc' -and $null -ne $_.WsMb } |
        Group-Object { '{0}#{1}' -f $_.Tag, $_.Pid }
    $report = foreach ($group in $groups) {
        $ordered = $group.Group | Sort-Object At
        $startValue = $ordered[0].WsMb
        $endValue = $ordered[-1].WsMb
        [pscustomobject]@{
            类型 = $ordered[-1].Tag
            Pid = $ordered[-1].Pid
            采样数 = $ordered.Count
            起始MB = [math]::Round($startValue)
            峰值MB = [math]::Round(($ordered | Measure-Object -Property WsMb -Maximum).Maximum)
            当前MB = [math]::Round($endValue)
            增长MB = [math]::Round($endValue - $startValue)
            'MB/分钟' = [math]::Round(($endValue - $startValue) / $minutes, 1)
        }
    }

    $androidRows = @($samples | Where-Object { $_.Source -eq 'android' })
    if ($androidRows.Count -gt 0) {
        $alive = @($androidRows | Where-Object { $null -ne $_.PssKb })
        if ($alive.Count -gt 0) {
            $appStart = $alive[0]
            $appEnd = $alive[-1]
            $report += [pscustomobject]@{
                类型 = 'android-app'
                Pid = $appEnd.Pid
                采样数 = $alive.Count
                起始MB = [math]::Round($appStart.PssKb / 1024)
                峰值MB = [math]::Round((($alive | Measure-Object -Property PssKb -Maximum).Maximum) / 1024)
                当前MB = [math]::Round($appEnd.PssKb / 1024)
                增长MB = [math]::Round(($appEnd.PssKb - $appStart.PssKb) / 1024)
                'MB/分钟' = [math]::Round((($appEnd.PssKb - $appStart.PssKb) / 1024) / $minutes, 1)
            }
        }
    }

    $sorted = @($report | Sort-Object -Property '增长MB' -Descending)
    $sorted | Select-Object -First $Top | Format-Table -AutoSize | Out-String | Write-Host
    $leaks = @($sorted | Where-Object { $_.'MB/分钟' -ge $WarnMegabytesPerMinute })
    if ($leaks.Count -gt 0) {
        Write-Host '疑似泄漏（超过阈值）：'
        foreach ($leak in $leaks) {
            Write-Host ("  {0} pid={1}  {2} MB/分钟，共涨 {3} MB" -f $leak.类型, $leak.Pid, $leak.'MB/分钟', $leak.增长MB)
        }
    } else {
        Write-Host ("没有进程超过 {0} MB/分钟" -f $WarnMegabytesPerMinute)
    }
}

function Get-State {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
}

function Get-LatestCsv {
    if ($Csv) { return $(if ([IO.Path]::IsPathRooted($Csv)) { $Csv } else { Join-Path $repo $Csv }) }
    $state = Get-State
    if ($state -and $state.csv) { return $state.csv }
    $latest = Get-ChildItem -LiteralPath $workDir -Filter 'samples-*.csv' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw '没有可分析的采样文件。' }
    return $latest.FullName
}

# 直接量某个会话文件：总量 S 与图片部分 I。
function Show-SessionImages([string[]] $Paths) {
    if ($Paths.Count -eq 0) { $Paths = @(Get-ActiveSessionFiles | ForEach-Object { $_.Path }) }
    foreach ($raw in $Paths) {
        $path = if ([IO.Path]::IsPathRooted($raw)) { $raw } else { Join-Path $repo $raw }
        if (-not (Test-Path -LiteralPath $path)) { Write-Host ("跳过（不存在）：{0}" -f $path); continue }
        $text = Get-Content -LiteralPath $path -Raw
        [int64] $bytes = 0
        [int64] $count = 0
        foreach ($match in [regex]::Matches($text, '"type"\s*:\s*"image"[^{}]*?"data"\s*:\s*"([A-Za-z0-9+/=]*)"')) {
            $bytes += $match.Groups[1].Value.Length
            $count += 1
        }
        $size = ([IO.FileInfo]::new($path)).Length
        Write-Host ("S={0,8:N1} MB  图片={1,8:N1} MB / {2,4} 张  {3}" -f ($size / 1MB), ($bytes / 1MB), $count, $path)
    }
}

switch ($Action) {
    'Sample' {
        if (-not (Test-Path $workDir)) { New-Item -ItemType Directory -Path $workDir -Force | Out-Null }
        $csvPath = if ($Csv) { $Csv } else { Join-Path $workDir ("samples-{0}.csv" -f (Get-Date -Format 'yyyyMMdd-HHmmss')) }
        Invoke-Sampler $csvPath
    }
    'Start' {
        if (-not (Test-Path $workDir)) { New-Item -ItemType Directory -Path $workDir -Force | Out-Null }
        $existing = Get-State
        if ($existing -and (Get-Process -Id $existing.samplerPid -ErrorAction SilentlyContinue)) {
            throw ("采样器已在运行（pid {0}，文件 {1}）。先 -Action Stop。" -f $existing.samplerPid, $existing.csv)
        }
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $csvPath = Join-Path $workDir ("samples-$stamp.csv")
        $argv = @('-NoProfile', '-File', $PSCommandPath, '-Action', 'Sample', '-Csv', $csvPath,
            '-IntervalSeconds', $IntervalSeconds, '-ConnectedIntervalSeconds', $ConnectedIntervalSeconds,
            '-TurnIntervalSeconds', $TurnIntervalSeconds,
            '-ConnectWindowSeconds', $ConnectWindowSeconds, '-LinkWindowSeconds', $LinkWindowSeconds,
            '-ActiveSessionWindowSeconds', $ActiveSessionWindowSeconds, '-WatchSessionFiles', $WatchSessionFiles,
            '-DurationMinutes', $DurationMinutes, '-Package', $Package)
        if ($Serial) { $argv += @('-Serial', $Serial) }
        if ($ForceConnected) { $argv += '-ForceConnected' }
        foreach ($root in $SessionRoot) { if ($root) { $argv += @('-SessionRoot', $root) } }
        foreach ($log in $PiLog) { if ($log) { $argv += @('-PiLog', $log) } }
        $proc = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $argv -WindowStyle Hidden -PassThru
        [pscustomobject]@{
            samplerPid = $proc.Id
            csv = $csvPath
            intervalSeconds = $IntervalSeconds
            connectedIntervalSeconds = $ConnectedIntervalSeconds
            durationMinutes = $DurationMinutes
            serial = (Resolve-Serial $Serial (Resolve-Adb))
            startedAt = (Get-Date).ToString('o')
        } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
        Write-Host ("采样已启动：pid {0}；离线每 {1}s、上线每 {2}s，最多 {3} 分钟" -f
            $proc.Id, $IntervalSeconds, $ConnectedIntervalSeconds, $DurationMinutes)
        Write-Host ("文件：{0}" -f $csvPath)
        Write-Host '现在打开 Host / 连手机复现；之后执行：pwsh -File scripts\windows\memory-monitor.ps1 -Action Status'
    }
    'Watch' {
        if (-not (Test-Path $workDir)) { New-Item -ItemType Directory -Path $workDir -Force | Out-Null }
        $csvPath = if ($Csv) { $Csv } else { Join-Path $workDir ("samples-{0}.csv" -f (Get-Date -Format 'yyyyMMdd-HHmmss')) }
        Write-Host ("前台采样中（Ctrl+C 结束并打印结论）：{0}" -f $csvPath)
        Invoke-Sampler $csvPath
        Show-Verdict $csvPath
    }
    'Status' {
        $state = Get-State
        if (-not $state) { Write-Host '没有采样记录（先 -Action Start）。'; break }
        $live = Get-Process -Id $state.samplerPid -ErrorAction SilentlyContinue
        Write-Host ("采样器 pid {0}：{1}" -f $state.samplerPid, ($(if ($live) { '运行中' } else { '已结束' })))
        Write-Host ("文件：{0}" -f $state.csv)
        if ($state.csv -and (Test-Path $state.csv)) {
            $count = (Get-Content -LiteralPath $state.csv | Measure-Object -Line).Lines - 1
            Write-Host ("已采样 {0} 行" -f [math]::Max($count, 0))
            if ($count -gt 0) { Show-Verdict $state.csv }
        } else {
            Write-Host '采样文件还没生成（采样器刚启动时会出现）。'
        }
    }
    'Stop' {
        $state = Get-State
        if (-not $state) { Write-Host '没有采样记录。'; break }
        $live = Get-Process -Id $state.samplerPid -ErrorAction SilentlyContinue
        if ($live) { Stop-Process -Id $state.samplerPid -Force }
        Write-Host ("采样已停止：pid {0}" -f $state.samplerPid)
        if ($state.csv -and (Test-Path $state.csv)) { Show-Verdict $state.csv }
    }
    'Report' { Show-Report (Get-LatestCsv) }
    'Verify' { Show-Verdict (Get-LatestCsv) }
    'Inspect' {
        # 从非 PowerShell 调用（-File）时数组会以逗号分隔的单个字符串传入。
        Show-SessionImages @($SessionPath | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
    }
}
