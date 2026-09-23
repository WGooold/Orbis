[CmdletBinding(SupportsShouldProcess)]
param(
    [int]$ProcessId,
    [string]$WorkingDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [int]$WaitSeconds = 10
)

$ErrorActionPreference = "Stop"

function Find-PiProcesses {
    # Pi is normally a Node process running pi-coding-agent's CLI bundle.
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -match '^(node|pi)(\.exe)?$' -and
        [string]$_.CommandLine -match '(?i)(@earendil-works[\\/]pi-coding-agent[\\/].*[\\/]cli\.js|[\\/]pi-coding-agent[\\/].*[\\/]cli\.js)'
    }
}

function Get-ProcessArguments([string]$CommandLine) {
    # Remove the executable token and keep the remaining command line intact so
    # quoted paths and Pi options are preserved when the process is restarted.
    if ($CommandLine -match '^\s*"[^"]+"\s*(.*)$') {
        return $Matches[1]
    }
    if ($CommandLine -match '^\s*\S+\s*(.*)$') {
        return $Matches[1]
    }
    return ""
}

if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
    throw "Pi 工作目录不存在：$WorkingDirectory"
}
$WorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).Path

$piProcess = $null
if ($ProcessId -gt 0) {
    $piProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $piProcess) {
        throw "找不到 PID 为 $ProcessId 的进程。"
    }
    if ([string]$piProcess.CommandLine -notmatch '(?i)(@earendil-works[\\/]pi-coding-agent[\\/].*[\\/]cli\.js|[\\/]pi-coding-agent[\\/].*[\\/]cli\.js)') {
        throw "PID $ProcessId 不是 Pi 进程，已拒绝关闭。"
    }
} else {
    $piProcesses = @(Find-PiProcesses)
    if ($piProcesses.Count -gt 1) {
        $details = $piProcesses | ForEach-Object { "PID $($_.ProcessId): $($_.CommandLine)" }
        throw ("检测到多个 Pi 进程，请使用 -ProcessId 指定要重启的窗口：`n" + ($details -join "`n"))
    }
    if ($piProcesses.Count -eq 1) {
        $piProcess = $piProcesses[0]
    }
}

$executable = $null
$arguments = ""
if ($piProcess) {
    $executable = [string]$piProcess.ExecutablePath
    if ([string]::IsNullOrWhiteSpace($executable)) {
        $executable = (Get-Command node.exe -ErrorAction Stop).Source
    }
    $arguments = Get-ProcessArguments ([string]$piProcess.CommandLine)
    Write-Host "将关闭 Pi：PID $($piProcess.ProcessId)" -ForegroundColor Yellow
} else {
    $piCommand = Get-Command pi.cmd, pi.exe, pi -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $piCommand) {
        throw "没有找到正在运行的 Pi，也找不到 pi 命令。请先安装 Pi，或使用 -ProcessId 指定进程。"
    }
    $executable = $piCommand.Source
    Write-Host "没有检测到正在运行的 Pi，将直接启动：$executable" -ForegroundColor Yellow
}

if ($piProcess) {
    if ($PSCmdlet.ShouldProcess("Pi PID $($piProcess.ProcessId)", "关闭")) {
        Stop-Process -Id ([int]$piProcess.ProcessId) -Force

        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        do {
            Start-Sleep -Milliseconds 200
            $stillRunning = Get-Process -Id ([int]$piProcess.ProcessId) -ErrorAction SilentlyContinue
        } while ($stillRunning -and (Get-Date) -lt $deadline)

        if ($stillRunning) {
            throw "Pi 进程未能在 $WaitSeconds 秒内退出。"
        }
        Write-Host "Pi 已关闭。" -ForegroundColor Green
    }
}

if ($PSCmdlet.ShouldProcess("$executable $arguments", "重新启动")) {
    $startParameters = @{
        FilePath         = $executable
        WorkingDirectory = $WorkingDirectory
        WindowStyle      = "Normal"
    }
    if (-not [string]::IsNullOrWhiteSpace($arguments)) {
        $startParameters.ArgumentList = $arguments
    }
    $newProcess = Start-Process @startParameters -PassThru
    Write-Host "Pi 已重新启动：PID $($newProcess.Id)" -ForegroundColor Green
    Write-Host "工作目录：$WorkingDirectory"
    Write-Host "请等待 Pi 连接 Relay 后，再在 Android 输入 /。"
}
