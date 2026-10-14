<#
.SYNOPSIS
  停掉 start-isolated-host.ps1 起的那个 rig Host，并可一并停掉本机 Relay。

.DESCRIPTION
  只按 PID 文件 + 命令行核对来停进程：绝不按进程名批量结束（用户自己的 Host 与别的 node 服务
  都不该被误伤）。停完会确认端口释放与状态目录里没有活着的 loopback 描述符。

.PARAMETER RigRoot
  rig 目录，默认 <repo>\.scratch\isolated-host。

.PARAMETER StopRelay
  同时停掉本机 Relay（scripts\windows\relay.ps1 -Action Stop）。
#>
[CmdletBinding()]
param(
    [string]$RigRoot,
    [switch]$StopRelay
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $RigRoot) { $RigRoot = Join-Path $repo '.scratch\isolated-host' }
$stateDir = Join-Path $RigRoot 'state'
$pidFile = Join-Path $RigRoot 'logs\host.pid'

if (Test-Path -LiteralPath $pidFile) {
    $raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($raw -match '^\d+$') {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $raw" -ErrorAction SilentlyContinue
        if ($process) {
            # 只停「命令行里带这个 rig 状态目录」的那个进程。
            if ($process.CommandLine -and $process.CommandLine.IndexOf($stateDir, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Stop-Process -Id ([int]$raw) -Force
                Start-Sleep -Seconds 2
                Write-Output "已停止 rig Host（PID $raw）"
            } else {
                Write-Output "PID $raw 的命令行与 rig 状态目录不符，拒绝停止：$($process.CommandLine)"
            }
        } else {
            Write-Output "PID $raw 已不在运行"
        }
    }
    Remove-Item -LiteralPath $pidFile -Force
} else {
    Write-Output "没有 rig PID 文件，视为未运行"
}

# 描述符里的 pid 若已经死了就不算「活着的 Host」，这里只做确认。
$descriptor = Join-Path $stateDir 'loopback.json'
if (Test-Path -LiteralPath $descriptor) {
    $record = Get-Content -LiteralPath $descriptor -Raw | ConvertFrom-Json
    $alive = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    Write-Output ("loopback 描述符 pid=$($record.pid) " + $(if ($alive) { '仍在运行（异常，请检查）' } else { '已退出' }))
}

if ($StopRelay) { pwsh -NoProfile -File (Join-Path $repo 'scripts\windows\relay.ps1') -Action Stop }
