param(
    [string]$QtRoot = 'D:\Qt\6.8.3\mingw_64',
    [string]$CompilerRoot = 'D:\Qt\Tools\mingw1310_64',
    [string]$DefaultRelay = 'wss://orbising.com/relay',
    [switch]$Package,
    [string]$InnoCompiler
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$buildDir = Join-Path $repoRoot '.artifacts\windows-host-build'
$savedPath = $env:Path
try {
    $env:Path = "$CompilerRoot\bin;$QtRoot\bin;$savedPath"
    if (!(Test-Path -LiteralPath "$QtRoot\bin\windeployqt.exe")) { throw 'Qt 6.8.3 is missing. Run windows-host-setup.ps1 first.' }
    if (!(Test-Path -LiteralPath "$CompilerRoot\bin\g++.exe")) { throw 'Matching MinGW 13.1 toolchain is missing.' }
    $ninja = (Get-Command ninja.exe -ErrorAction Stop).Source
    Push-Location $repoRoot
    try {
        node -p 'process.execPath'
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Host build failed' }
        cmake -S packages/windows-host -B $buildDir -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_PREFIX_PATH=$QtRoot" "-DCMAKE_CXX_COMPILER=$CompilerRoot/bin/g++.exe" "-DCMAKE_MAKE_PROGRAM=$ninja" "-DORBIS_DEFAULT_RELAY=$DefaultRelay"
        if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed' }
        cmake --build $buildDir --parallel 2
        if ($LASTEXITCODE -ne 0) { throw 'Qt build failed' }
        ctest --test-dir $buildDir --output-on-failure
        if ($LASTEXITCODE -ne 0) { throw 'Native tests failed' }
        if ($Package) {
            # Fresh directory per packaging run: no stale dependency can silently survive an upgrade.
            $releaseRoot = Join-Path $repoRoot ('.artifacts\windows-host\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
            $stage = Join-Path $releaseRoot 'OrbisHost'
            New-Item -ItemType Directory -Path $stage -Force | Out-Null
            Copy-Item -LiteralPath "$buildDir\OrbisHost.exe" -Destination $stage
            & "$QtRoot\bin\windeployqt.exe" --release --compiler-runtime --no-translations --verbose 0 --qmldir "$repoRoot\packages\windows-host\src\qml" "$stage\OrbisHost.exe"
            if ($LASTEXITCODE -ne 0) { throw 'Qt deployment failed' }
            node scripts/package-host-runtime.mjs "$stage\runtime"
            if ($LASTEXITCODE -ne 0) { throw 'Runtime packaging failed' }
            Copy-Item -LiteralPath "$repoRoot\LICENSE" -Destination $stage
            Copy-Item -LiteralPath "$repoRoot\packages\windows-host\README.md" -Destination "$stage\README.md"
            Copy-Item -LiteralPath "$repoRoot\packages\windows-host\THIRD-PARTY-NOTICES.md" -Destination $stage
            Copy-Item -LiteralPath "$repoRoot\packages\windows-host\licenses" -Destination "$stage\licenses" -Recurse
            Copy-Item -LiteralPath "$CompilerRoot\licenses" -Destination "$stage\licenses\mingw" -Recurse
            $smokeDir = Join-Path $releaseRoot 'smoke'
            New-Item -ItemType Directory -Path $smokeDir -Force | Out-Null
            # Remove development tooling from PATH when checking the portable package.
            $env:Path = "$env:SystemRoot\System32;$env:SystemRoot"
            $testProcess = Start-Process -FilePath "$stage\OrbisHost.exe" -ArgumentList '--smoke-test','--data-dir',('"' + $smokeDir + '"'),'--screenshot',('"' + $releaseRoot + '\preview.png"') -WindowStyle Hidden -PassThru -Wait -RedirectStandardError "$smokeDir\qml.log"
            $env:Path = "$CompilerRoot\bin;$QtRoot\bin;$savedPath"
            if ($testProcess.ExitCode -ne 0) { throw "Packaged app smoke test failed: $($testProcess.ExitCode). See $smokeDir" }
            $archive = Join-Path $releaseRoot 'OrbisHost-0.1.2-windows-x64.zip'
            Compress-Archive -LiteralPath $stage -DestinationPath $archive
            (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + (Split-Path -Leaf $archive) | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
            if ($InnoCompiler) {
                # Inno's file reader still encounters MAX_PATH with nested npm packages.
                # A temporary drive alias shortens source paths without changing the payload.
                $installerDrive = $null
                try {
                    foreach ($letter in 90..68) {
                        $candidate = ([char]$letter).ToString() + ':'
                        if (Test-Path -LiteralPath ($candidate + '\')) { continue }
                        & "$env:SystemRoot\System32\subst.exe" $candidate $stage
                        if ($LASTEXITCODE -eq 0) { $installerDrive = $candidate; break }
                    }
                    if (!$installerDrive) { throw 'No drive letter available for installer staging' }
                    & $InnoCompiler '/Qp' "/DStageDir=$installerDrive" "/DOutputDir=$releaseRoot" "$repoRoot\packages\windows-host\installer\OrbisHost.iss"
                    if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
                } finally {
                    if ($installerDrive) { & "$env:SystemRoot\System32\subst.exe" $installerDrive /D }
                }
                $installer = Join-Path $releaseRoot 'OrbisHost-0.1.2-windows-x64-setup.exe'
                (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + (Split-Path -Leaf $installer) | Set-Content -LiteralPath "$installer.sha256" -Encoding ascii
            }
            Write-Output "Portable release: $archive"
            Write-Output "Executable: $stage\OrbisHost.exe"
        }
    } finally { Pop-Location }
} finally { $env:Path = $savedPath }
