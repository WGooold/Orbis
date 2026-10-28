<#
.SYNOPSIS
  给隔离 Host 开一个配对窗口，并把配对载荷按一行 JSON 打到 stdout（可以按模拟器视角改写 relayUrl）。

.DESCRIPTION
  对应 node packages/host/dist/cli.js pair。与常驻 Host 在**同一个状态目录**里互斥：先停 host 再配对。
  配对码由本机 Relay 签发，需要管理员令牌（data\local-relay.env 的 ORBIS_ADMIN_TOKEN），
  少了它就是 HTTP 401——这是实测踩过的坑。

  脚本把 pair 的输出写进 <rig>\logs\pair.out.log，等载荷那一行出现就打到 stdout，然后继续等
  进程结束（配对成功或窗口过期）。在后台作业里跑时，载荷会立刻出现在作业输出里，窗口保持开着。

.PARAMETER AdvertiseRelayUrl
  改写载荷里的 relayUrl。模拟器访问宿主机 loopback 用 10.0.2.2，所以本机 Relay 通常写成
  ws://10.0.2.2:8787：隔离 Host 自己仍连 127.0.0.1，二维码/载荷里必须是模拟器视角的地址。

.PARAMETER LanPort
  载荷里广播的 LAN 端口，必须与 start-isolated-host.ps1 用的一致（默认 42131）。

.EXAMPLE
  pwsh -File docs\testing\isolated-host\pair-isolated-host.ps1 -AdvertiseRelayUrl ws://10.0.2.2:8787
#>
[CmdletBinding()]
param(
    [string]$RigRoot,
    [string]$RelayUrl = 'ws://127.0.0.1:8787',
    [string]$AdvertiseRelayUrl,
    [int]$LanPort = 42131,
    [int]$PayloadTimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $RigRoot) { $RigRoot = Join-Path $repo '.scratch\isolated-host' }
$stateDir = Join-Path $RigRoot 'state'
$logDir = Join-Path $RigRoot 'logs'
$outLog = Join-Path $logDir 'pair.out.log'
$errLog = Join-Path $logDir 'pair.err.log'
$pidFile = Join-Path $logDir 'pair.pid'
$entry = Join-Path $repo 'packages\host\dist\cli.js'
$envFile = Join-Path $repo 'data\local-relay.env'

if (-not (Test-Path -LiteralPath $envFile)) { throw "缺少 $envFile：先运行 scripts\windows\relay.ps1 -Action Start -Port 8787。" }
function Read-EnvValue([string]$name) {
    $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
    if (-not $line) { throw "$envFile 里没有 $name。" }
    return ($line -split '=', 2)[1].Trim()
}
New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null
if (Test-Path -LiteralPath $outLog) { Remove-Item -LiteralPath $outLog -Force }

$saved = @{}
foreach ($name in 'ORBIS_RELAY_URL', 'ORBIS_LAN_PORT', 'ORBIS_RUNTIME_CREDENTIAL', 'ORBIS_ADMIN_TOKEN') {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
}
try {
    $env:ORBIS_RELAY_URL = $RelayUrl
    $env:ORBIS_LAN_PORT = "$LanPort"
    $env:ORBIS_RUNTIME_CREDENTIAL = Read-EnvValue 'ORBIS_RUNTIME_CREDENTIAL'
    # 配对码由 Relay 签发：没有管理员令牌就是 HTTP 401。
    $env:ORBIS_ADMIN_TOKEN = Read-EnvValue 'ORBIS_ADMIN_TOKEN'
    $process = Start-Process -FilePath 'node' -ArgumentList @($entry, 'pair', '--state-dir', $stateDir, '--print-payload') `
        -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    $process.Id | Set-Content -LiteralPath $pidFile -Encoding ascii

    $deadline = (Get-Date).AddSeconds($PayloadTimeoutSeconds)
    $payload = $null
    do {
        Start-Sleep -Milliseconds 500
        if (Test-Path -LiteralPath $outLog) {
            $payload = (Get-Content -LiteralPath $outLog | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -First 1)
        }
        if (-not $payload -and $process.HasExited) { throw "pair 提前退出（code=$($process.ExitCode)），看 $errLog。" }
    } while (-not $payload -and (Get-Date) -lt $deadline)
    if (-not $payload) { throw "等 $PayloadTimeoutSeconds 秒还没拿到配对载荷，看 $outLog / $errLog。" }

    if ($AdvertiseRelayUrl) {
        $record = $payload | ConvertFrom-Json
        $record.relayUrl = $AdvertiseRelayUrl
        $payload = $record | ConvertTo-Json -Compress
    }
    Write-Output $payload
    Write-Output "# pair 仍在运行（PID $($process.Id)），配对窗口开着；配对成功或窗口过期后它自己退出。"
    Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
    Write-Output "# pair 已退出。"
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
}
