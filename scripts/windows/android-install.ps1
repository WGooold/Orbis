[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^emulator-\d+$')]
    [string] $Serial,

    [Parameter(Mandatory = $true)]
    [string] $Apk,

    [switch] $StartActivity,

    [ValidateRange(1, 10)]
    [int] $AcquireTimeoutMinutes = 2
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$leaseDir = if ($env:ORBIS_ANDROID_LEASE_DIR) { $env:ORBIS_ANDROID_LEASE_DIR } elseif (Test-Path 'D:\android-emulators') { 'D:\android-emulators\leases' } else { Join-Path $env:LOCALAPPDATA 'Orbis\android-leases' }
$leasePath = Join-Path $leaseDir "$Serial.json"
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$deviceMutex = [Threading.Mutex]::new($false, "PiRemote.AndroidDevice.$Serial")
$acquired = $false

function Normalize-Path([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Read-Json([string]$Path) {
    if (-not (Test-Path $Path)) { throw "Required metadata file is missing: $Path" }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

try {
    if (-not (Test-Path $adb)) { throw "adb not found: $adb" }
    $apkPath = (Resolve-Path -LiteralPath $Apk -ErrorAction Stop).Path
    $manifestPath = "$apkPath.pi-remote-build.json"
    $manifest = Read-Json $manifestPath
    $lease = Read-Json $leasePath

    if ((Normalize-Path $manifest.worktree) -ne (Normalize-Path $repo)) {
        throw "APK was built by another worktree: $($manifest.worktree)"
    }
    if ((Normalize-Path $manifest.artifactPath) -ne (Normalize-Path $apkPath)) {
        throw 'APK path does not match its build manifest.'
    }
    if ((Get-FileHash $apkPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256.ToLowerInvariant()) {
        throw 'APK checksum does not match its build manifest; refusing to install a changed artifact.'
    }
    if ((Normalize-Path $lease.worktree) -ne (Normalize-Path $repo)) {
        throw "Device $Serial is owned by another worktree: $($lease.worktree)"
    }
    if ($lease.serial -and $lease.serial -ne $Serial) {
        throw "Device lease serial mismatch: expected $Serial, recorded $($lease.serial)"
    }

    $acquired = $deviceMutex.WaitOne([TimeSpan]::FromMinutes($AcquireTimeoutMinutes))
    if (-not $acquired) { throw "Timed out waiting for the device install slot: $Serial" }

    # Re-read ownership after waiting so an old lease cannot authorize a changed device.
    $lease = Read-Json $leasePath
    if ((Normalize-Path $lease.worktree) -ne (Normalize-Path $repo)) {
        throw "Device $Serial ownership changed while waiting."
    }
    $state = (& $adb -s $Serial get-state 2>$null).Trim()
    if ($state -ne 'device') { throw "adb device is not ready: $Serial ($state)" }
    $boot = (& $adb -s $Serial shell getprop sys.boot_completed).Trim()
    if ($boot -ne '1') { throw "Android has not completed boot on $Serial (sys.boot_completed=$boot)" }

    & $adb -s $Serial install -r $apkPath
    if ($LASTEXITCODE -ne 0) { throw "APK install failed with exit code $LASTEXITCODE." }
    if ($StartActivity) {
        & $adb -s $Serial shell am start -n dev.pi.remote/.MainActivity
        if ($LASTEXITCODE -ne 0) { throw "Activity launch failed with exit code $LASTEXITCODE." }
    }
    Write-Output "Installed build $($manifest.buildId) on $Serial from $apkPath"
} finally {
    if ($acquired) { $deviceMutex.ReleaseMutex() }
    $deviceMutex.Dispose()
}
