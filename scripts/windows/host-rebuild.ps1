<#
.SYNOPSIS
  关闭从 .artifacts\host 运行的 Orbis Host（连同它的进程树），重新构建打包，成功后从原目录重新启动。

.DESCRIPTION
  本机测试用的一键流程：杀掉旧 Host → windows-host-build.ps1 -Package → 启动新产物。
  每次运行都会先列出将要关闭的进程并等待确认；上一次的同意不会顺延，构建失败也不会启动任何东西。
  确认按“失败即为否”处理：读不到输入、输入为空、大小写不符都一律取消。

.PARAMETER QtRoot
  Qt 6.8.3 安装目录，默认 D:\Qt\6.8.3\mingw_64。

.PARAMETER CompilerRoot
  配套 MinGW 工具链目录，默认 D:\Qt\Tools\mingw1310_64。

.PARAMETER Yes
  跳过确认提示。只有在你已经明确决定中断当前 Host 时才使用。

.PARAMETER NoStart
  构建成功后不自动启动 Host。

.EXAMPLE
  scripts\windows\host-rebuild.ps1
#>
[CmdletBinding()]
param(
    [string]$QtRoot = 'D:\Qt\6.8.3\mingw_64',
    [string]$CompilerRoot = 'D:\Qt\Tools\mingw1310_64',
    [switch]$Yes,
    [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$releaseRoot = Join-Path $repoRoot '.artifacts\host'
$exe = Join-Path $releaseRoot 'OrbisHost\OrbisHost.exe'

# 只按路径和命令行认这个产物目录里的 Host，绝不按进程名批量结束 node.exe：
# 别的 agent 会话、别的 node 服务都不该被这条脚本误伤。当前 shell 及其祖先也永不列入。
function Test-OwnedByReleaseRoot([object]$ProcessInfo) {
    if ($ProcessInfo.ExecutablePath -and $ProcessInfo.ExecutablePath.StartsWith($releaseRoot, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($ProcessInfo.CommandLine -and $ProcessInfo.CommandLine.IndexOf($releaseRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    return $false
}
function Get-ProtectedIds {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $parents = @{}
    foreach ($item in $all) { $parents[[int]$item.ProcessId] = [int]$item.ParentProcessId }
    $protected = New-Object System.Collections.Generic.HashSet[int]
    [void]$protected.Add($PID)
    $current = $PID
    for ($hop = 0; $hop -lt 32; $hop++) {
        if (-not $parents.ContainsKey($current)) { break }
        $parent = $parents[$current]
        if ($parent -le 4 -or -not $protected.Add($parent)) { break }
        $current = $parent
    }
    return $protected
}
# 返回 Object[]；空集合也返回真正的空数组，不返回 $null，调用方不用再猜。
function Select-ProcessTree([object[]]$Roots, [System.Collections.Generic.HashSet[int]]$Protected) {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $children = @{}
    foreach ($item in $all) {
        $parent = [int]$item.ParentProcessId
        if (-not $children.ContainsKey($parent)) { $children[$parent] = New-Object System.Collections.ArrayList }
        [void]$children[$parent].Add($item)
    }
    $ordered = New-Object System.Collections.ArrayList
    $seen = New-Object System.Collections.Generic.HashSet[int]
    $queue = New-Object System.Collections.Queue
    foreach ($root in @($Roots)) { if ($root) { $queue.Enqueue($root) } }
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $id = [int]$current.ProcessId
        if ($id -le 4 -or $Protected.Contains($id) -or -not $seen.Add($id)) { continue }
        [void]$ordered.Add($current)
        if ($children.ContainsKey($id)) { foreach ($child in $children[$id]) { $queue.Enqueue($child) } }
    }
    return $ordered.ToArray()
}
function Get-HostTargets([System.Collections.Generic.HashSet[int]]$Protected) {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $ownedRoots = @($all | Where-Object { Test-OwnedByReleaseRoot $_ })
    # 同一台机器上另一个安装目录（含开发构建）的 OrbisHost 会占住单实例锁，
    # 让新构建“启动”后只是激活旧进程，所以一并列出、一并关闭。
    $foreignRoots = @($all | Where-Object { $_.Name -eq 'OrbisHost.exe' -and -not (Test-OwnedByReleaseRoot $_) })
    return [pscustomobject]@{
        Owned = @(Select-ProcessTree $ownedRoots $Protected | Where-Object { $_ })
        Foreign = @(Select-ProcessTree $foreignRoots $Protected | Where-Object { $_ })
    }
}
function Merge-Targets([object[]]$First, [object[]]$Second) {
    $flat = New-Object System.Collections.ArrayList
    foreach ($item in (@($First) + @($Second))) { if ($item) { [void]$flat.Add($item) } }
    return @($flat | Sort-Object ProcessId -Unique)
}

$protected = Get-ProtectedIds
$snapshot = Get-HostTargets $protected
$ownedTargets = @($snapshot.Owned | Where-Object { $_ })
$foreignTargets = @($snapshot.Foreign | Where-Object { $_ })
$allTargets = Merge-Targets $ownedTargets $foreignTargets
$ownedIds = @($ownedTargets | ForEach-Object { $_.ProcessId })

Write-Host ""
Write-Host "产物目录：$releaseRoot"
if ($allTargets.Count -eq 0) {
    Write-Host "没有检测到正在运行的 Orbis Host。"
} else {
    Write-Host "将关闭以下进程（含各自的子进程，也就是 Host 的 node 后台和它启动的 Agent）：" -ForegroundColor Yellow
    foreach ($item in $allTargets) {
        $label = if ($item.ExecutablePath) { $item.ExecutablePath } elseif ($item.CommandLine) { $item.CommandLine } else { $item.Name }
        $origin = if ($ownedIds -contains $item.ProcessId) { '' } else { '  [非本产物目录的 Host]' }
        Write-Host ("  {0,-7} {1,-16} {2}{3}" -f $item.ProcessId, $item.Name, $label, $origin)
    }
    if ($foreignTargets.Count -gt 0) {
        Write-Host "注意：列表里有别的安装目录的 OrbisHost；同意即表示一起关闭它们。" -ForegroundColor Yellow
    }
}
if (-not $NoStart) { Write-Host "构建成功后会从 $exe 重新启动 Host。" }

if (-not $Yes) {
    $answer = Read-Host "`n这会中断当前 Host 的连接和它正在跑的会话。继续？(y/N)"
    if ("$answer".Trim().ToLowerInvariant() -notin @('y', 'yes')) { Write-Host "已取消，未做任何改动。"; exit 0 }
}

# 每轮都重新枚举，顺手收掉刚被父进程拉起来的子进程。用 Stop-Process 而不是 taskkill：
# 进程恰好已退出时它只记一条 SilentlyContinue，不会把脚本打断。
$deadline = (Get-Date).AddSeconds(20)
$remaining = $allTargets
while ($true) {
    foreach ($item in @($remaining)) {
        if (-not $item -or $item.ProcessId -le 4) { continue }
        Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    $after = Get-HostTargets $protected
    $remaining = Merge-Targets $after.Owned $after.Foreign
    if ($remaining.Count -eq 0) { break }
    if ((Get-Date) -ge $deadline) {
        Write-Host "以下进程仍未退出，构建会因为文件被占用而失败：" -ForegroundColor Red
        foreach ($item in $remaining) { Write-Host ("  {0,-7} {1}" -f $item.ProcessId, $item.Name) }
        exit 1
    }
}
if ($allTargets.Count -gt 0) { Write-Host "旧 Host 已退出。" -ForegroundColor Green }

Write-Host "`n开始构建：scripts\windows\windows-host-build.ps1 -Package"
$started = Get-Date
try {
    & (Join-Path $PSScriptRoot 'windows-host-build.ps1') -Package -QtRoot $QtRoot -CompilerRoot $CompilerRoot
} catch {
    Write-Host "构建失败：$_" -ForegroundColor Red
    exit 1
}
if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { Write-Host "构建失败（退出码 $LASTEXITCODE）。" -ForegroundColor Red; exit 1 }
if (-not (Test-Path -LiteralPath $exe)) { Write-Host "构建结束但找不到 $exe。" -ForegroundColor Red; exit 1 }
Write-Host ("构建完成，用时 {0:F1} 分钟。" -f ((Get-Date) - $started).TotalMinutes) -ForegroundColor Green

if ($NoStart) { Write-Host "已指定 -NoStart，不自动启动。"; exit 0 }

Start-Process -FilePath $exe -WorkingDirectory (Split-Path -LiteralPath $exe)
$running = $false
$deadline = (Get-Date).AddSeconds(10)
while (-not $running -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $running = @(Get-Process -Name 'OrbisHost' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($releaseRoot, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
}
if ($running) { Write-Host "已重新启动：$exe" -ForegroundColor Green }
else { Write-Host "警告：启动后 10 秒内没有看到 $exe 对应的进程；如果窗口没出现，检查是否有残留的 desktop.lock。" -ForegroundColor Yellow }
