<#
.SYNOPSIS
  起一个隔离的 Orbis Host（自己的状态目录、LAN 端口和本机 Relay 身份），供模拟器上的 App 联调。

.DESCRIPTION
  不会碰用户正在使用的那台 Host（它跑在 .artifacts\host，且是本机 DSH Web 的父进程）。
  状态、日志、PID 全部落在 rig 目录下；启动前会拒绝重复启动，并在超时前等它打出「已就绪」。

.PARAMETER RigRoot
  rig 目录，默认 <repo>\.scratch\isolated-host。

.PARAMETER LanPort
  LAN 直连端口，默认 42131（用户 Host 用 42130，刻意错开）。

.PARAMETER RelayUrl
  本机 Relay 地址，默认 ws://127.0.0.1:8787（由 scripts\windows\relay.ps1 提供）。

.PARAMETER Dsh
  启用 DeepSeek Harness 后端（默认关）。Pi 后端总是启用。

.PARAMETER Codex
  启用 Codex 后端（默认关；需要已全局安装 codex-cli）。

.PARAMETER ReadyTimeoutSeconds
  等待「已就绪」的超时，默认 60 秒。

.EXAMPLE
  pwsh -File docs\testing\isolated-host\start-isolated-host.ps1 -Dsh
#>
[CmdletBinding()]
param(
    [string]$RigRoot,
    [int]$LanPort = 42131,
    [string]$RelayUrl = 'ws://127.0.0.1:8787',
    [switch]$Dsh,
    [switch]$Codex,
    [int]$ReadyTimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $RigRoot) { $RigRoot = Join-Path $repo '.scratch\isolated-host' }
$stateDir = Join-Path $RigRoot 'state'
$logDir = Join-Path $RigRoot 'logs'
$pidFile = Join-Path $logDir 'host.pid'
$outLog = Join-Path $logDir 'host.out.log'
$errLog = Join-Path $logDir 'host.err.log'
$entry = Join-Path $repo 'packages\host\dist\cli.js'

if (-not (Test-Path -LiteralPath $entry)) { throw "找不到 $entry：先在本工作树运行 npm run build。" }

# 本机 Relay 的运行时凭据：Host 必须用它才能连上本地 Relay。
$envFile = Join-Path $repo 'data\local-relay.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    throw "缺少 $envFile：先运行 scripts\windows\relay.ps1 -Action Start -Port 8787。"
}
$credential = (Get-Content -LiteralPath $envFile | Where-Object { $_ -like 'PI_REMOTE_RUNTIME_CREDENTIAL=*' } | Select-Object -First 1)
if (-not $credential) { throw "$envFile 里没有 PI_REMOTE_RUNTIME_CREDENTIAL。" }
$credential = ($credential -split '=', 2)[1].Trim()

New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null

# 同一个 rig 只能有一个常驻 Host：重复启动只会互踢。
if (Test-Path -LiteralPath $pidFile) {
    $existing = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($existing -match '^\d+$' -and (Get-Process -Id ([int]$existing) -ErrorAction SilentlyContinue)) {
        throw "rig Host 已在运行（PID $existing）。先运行 stop-isolated-host.ps1。"
    }
    Remove-Item -LiteralPath $pidFile -Force
}
if (Get-NetTCPConnection -LocalPort $LanPort -State Listen -ErrorAction SilentlyContinue) {
    throw "LAN 端口 $LanPort 已被占用，换一个 -LanPort。"
}

$savedRelay = $env:PI_REMOTE_RELAY_URL
$savedLan = $env:PI_REMOTE_LAN_PORT
$savedCredential = $env:PI_REMOTE_RUNTIME_CREDENTIAL
try {
    $env:PI_REMOTE_RELAY_URL = $RelayUrl
    $env:PI_REMOTE_LAN_PORT = "$LanPort"
    $env:PI_REMOTE_RUNTIME_CREDENTIAL = $credential
    $arguments = @($entry, 'host', '--state-dir', $stateDir)
    if ($Dsh) { $arguments += '--dsh' }
    if ($Codex) { $arguments += '--codex' }
    # 不开 -NoNewWindow：子进程若继承调用方的 stdio 管道，调用方会一直等到它退出（实测踩过）。
    $process = Start-Process -FilePath 'node' -ArgumentList $arguments -WorkingDirectory $repo -PassThru `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $process.Id | Set-Content -LiteralPath $pidFile -Encoding ascii

    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
    do {
        Start-Sleep -Seconds 2
        if ($process.HasExited) { throw "rig Host 退出（code=$($process.ExitCode)），看 $errLog。" }
        $ready = (Test-Path -LiteralPath $outLog) -and ((Get-Content -LiteralPath $outLog -Raw) -match '已就绪')
    } while (-not $ready -and (Get-Date) -lt $deadline)
    if (-not $ready) { throw "等 $ReadyTimeoutSeconds 秒还没看到「已就绪」，看 $outLog / $errLog。" }

    Write-Output "rig Host 已就绪"
    Write-Output "  PID        $($process.Id)"
    Write-Output "  状态目录   $stateDir"
    Write-Output "  Relay      $RelayUrl"
    Write-Output "  LAN 端口   $LanPort"
    Write-Output "  日志       $outLog"
    Write-Output "  提示：配对与常驻互斥——先 pair，再 host；需要配对窗口时先 stop。"
} finally {
    $env:PI_REMOTE_RELAY_URL = $savedRelay
    $env:PI_REMOTE_LAN_PORT = $savedLan
    $env:PI_REMOTE_RUNTIME_CREDENTIAL = $savedCredential
}
