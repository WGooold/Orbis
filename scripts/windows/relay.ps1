[CmdletBinding()]
param(
    [ValidateSet("Start", "Stop", "Restart", "Status")]
    [string]$Action = "Start",
    [int]$Port = 8787,
    [string]$HostAddress = "0.0.0.0",
    [string]$RelayHost,
    [string]$StateFile,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$data = Join-Path $root "data"
$envFile = Join-Path $data "local-relay.env"
$pidFile = Join-Path $data "relay.pid"
$stdoutFile = Join-Path $data "relay.stdout.log"
$stderrFile = Join-Path $data "relay.stderr.log"
$entryPoint = "packages\relay\dist\main.js"
$launcherScript = "scripts\windows\relay-launcher.mjs"

function New-RandomSecret {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes)
}

function Ensure-LocalEnvironment {
    New-Item -ItemType Directory -Path $data -Force | Out-Null

    if (-not (Test-Path $envFile)) {
        @(
            "PI_REMOTE_RUNTIME_CREDENTIAL=$(New-RandomSecret)",
            "PI_REMOTE_ADMIN_TOKEN=$(New-RandomSecret)",
            "HOST=$HostAddress",
            "PORT=$Port"
        ) | Set-Content -Path $envFile -Encoding ascii
        Write-Host "已生成本地 Relay 密钥：$envFile"
    }

    foreach ($line in Get-Content -Path $envFile) {
        if ($line -match '^\s*([^#=\s]+)\s*=\s*(.*)\s*$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2])
        }
    }

    if ([string]::IsNullOrWhiteSpace($env:PI_REMOTE_RUNTIME_CREDENTIAL) -or
        [string]::IsNullOrWhiteSpace($env:PI_REMOTE_ADMIN_TOKEN)) {
        throw "缺少 PI_REMOTE_RUNTIME_CREDENTIAL 或 PI_REMOTE_ADMIN_TOKEN：$envFile"
    }

    $env:HOST = $HostAddress
    $env:PORT = [string]$Port
    if ([string]::IsNullOrWhiteSpace($StateFile)) {
        $StateFile = Join-Path $data "relay-state.json"
    }
    $env:PI_REMOTE_STATE_FILE = $StateFile
}

function Get-RecordedRelayProcess {
    if (-not (Test-Path $pidFile)) { return $null }

    try {
        $rawRecord = Get-Content -Raw -Path $pidFile
        $record = $rawRecord | ConvertFrom-Json
        $recordedPid = if ($record -is [int] -or $record -is [long]) { [int]$record } else { [int]$record.pid }
    } catch {
        $recordedPid = 0
    }
    if ($recordedPid -le 0) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return $null
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue
    if (-not $process) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        return $null
    }

    $commandLine = [string]$process.CommandLine
    if ($commandLine -notmatch "packages[\\/]relay[\\/]dist[\\/]main\.js") {
        throw "PID 文件 $pidFile 指向的进程不是 Orbis Relay，已拒绝操作（PID $recordedPid）。"
    }
    return $process
}

function Test-PrivateIPv4([string]$Address) {
    $parts = $Address.Split('.')
    if ($parts.Count -ne 4) { return $false }
    $octets = $parts | ForEach-Object {
        $value = 0
        [int]::TryParse($_, [ref]$value) | Out-Null
        $value
    }
    if ($octets.Count -ne 4 -or ($octets | Where-Object { $_ -lt 0 -or $_ -gt 255 })) { return $false }
    return $octets[0] -eq 10 -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168) -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 169 -and $octets[1] -eq 254)
}

function Get-PreferredLanAddress {
    if (-not [string]::IsNullOrWhiteSpace($RelayHost)) { return $RelayHost.Trim() }
    try {
        # Prefer an RFC1918 address on an interface with a default gateway. This avoids
        # selecting an APIPA/link-local 169.254.x.x address when DHCP also provided a
        # usable 192.168.x.x, 10.x.x.x, or 172.16-31.x.x address.
        $addresses = Get-NetIPConfiguration -ErrorAction Stop |
            Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
            ForEach-Object { $_.IPv4Address } |
            Where-Object {
                $_.IPAddress -and
                $_.IPAddress -notmatch '^169\.254\.' -and
                (Test-PrivateIPv4 $_.IPAddress)
            } |
            Select-Object -ExpandProperty IPAddress
        if ($addresses) { return @($addresses)[0] }

        $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object {
                $_.IPAddress -and
                $_.IPAddress -notmatch '^169\.254\.' -and
                (Test-PrivateIPv4 $_.IPAddress)
            } |
            Select-Object -ExpandProperty IPAddress
        if ($addresses) { return @($addresses)[0] }

        # A link-local address is only a last resort. It is usually not reachable
        # from a phone, so users can use -RelayHost to select the correct interface.
        $linkLocal = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -match '^169\\.254\\.' } |
            Select-Object -ExpandProperty IPAddress
        if ($linkLocal) { return @($linkLocal)[0] }
    } catch {
        # Network cmdlets are unavailable on some older PowerShell environments.
    }
    return "127.0.0.1"
}

function Show-Status {
    $process = Get-RecordedRelayProcess
    if ($process) {
        Write-Host "Relay 正在运行：PID $($process.ProcessId)"
        Write-Host "地址：ws://localhost:$Port"
        Write-Host "日志：$stdoutFile"
        return 0
    }
    Write-Host "Relay 未运行。"
    return 1
}

function Stop-Relay {
    $process = Get-RecordedRelayProcess
    if (-not $process) {
        Write-Host "Relay 未运行。"
        return
    }

    Write-Host "正在关闭 Relay（PID $($process.ProcessId)）..."
    Stop-Process -Id ([int]$process.ProcessId) -Force
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Relay 已关闭。"
}

function Start-Relay {
    $existing = Get-RecordedRelayProcess
    if ($existing) {
        Write-Host "Relay 已在运行：PID $($existing.ProcessId)"
        Write-Host "如需重启：.\scripts\windows\relay.ps1 -Action Restart"
        return
    }

    Ensure-LocalEnvironment

    if (-not $SkipBuild) {
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
        Write-Host "正在构建 Relay..."
        Push-Location $root
        try {
            & $npm.Source run build
            $buildExitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($buildExitCode -ne 0) { throw "npm run build 失败，Relay 未启动。" }
    }

    $entryPointPath = Join-Path $root $entryPoint
    if (-not (Test-Path $entryPointPath)) {
        throw "找不到 $entryPointPath。请先运行 npm run build，或不要使用 -SkipBuild。"
    }

    Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command node -ErrorAction Stop }

    $launcherPath = Join-Path $root $launcherScript
    $launcherOutput = & $node.Source $launcherPath $root $entryPoint $stdoutFile $stderrFile
    if ($LASTEXITCODE -ne 0) { throw "Relay 启动器执行失败。" }
    $relayPid = [int]([string]$launcherOutput).Trim()

    @{ pid = $relayPid; startedAt = (Get-Date).ToString("o"); entryPoint = $entryPoint } |
        ConvertTo-Json | Set-Content -Path $pidFile -Encoding ascii

    Start-Sleep -Milliseconds 500
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $relayPid" -ErrorAction SilentlyContinue
    if (-not $process) {
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        $errorText = if (Test-Path $stderrFile) { Get-Content -Raw $stderrFile } else { "" }
        throw "Relay 启动失败。$errorText"
    }

    Write-Host "Relay 已启动：PID $relayPid"
    Write-Host "本机地址：ws://127.0.0.1:$Port"
    Write-Host ("局域网地址：ws://{0}:{1}" -f (Get-PreferredLanAddress), $Port)
    Write-Host "日志：$stdoutFile / $stderrFile"
}

switch ($Action) {
    "Start" { Start-Relay }
    "Stop" { Stop-Relay }
    "Restart" { Stop-Relay; Start-Relay }
    "Status" { exit (Show-Status) }
}
