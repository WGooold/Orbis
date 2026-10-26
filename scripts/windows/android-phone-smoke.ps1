<#
.SYNOPSIS
Build, install and run isolated Android regression tests on one USB phone.
.EXAMPLE
pwsh -File scripts/windows/android-phone-smoke.ps1 -Serial N78PZ5UCDIRCGQ8P
.DESCRIPTION
Uses the Android build/install wrappers and an atomic device lease. No uninstall,
pm clear, pairing replacement or user Host restart. Results replace .artifacts/app.
The default tests use synthetic UI state and separate database directories; they
do not test the phone's existing pairing against a production Host.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9._:-]+$')] [string] $Serial,
    [ValidatePattern('^[A-Za-z0-9_.$#,]+$')]
    [string] $TestClass = 'com.orbising.orbis.SessionGraphStoreInstrumentedTest,com.orbising.orbis.SessionSyncSelectionInstrumentedTest,com.orbising.orbis.DshInstrumentedTest',
    [ValidateRange(30, 900)] [int] $TimeoutSeconds = 300,
    [switch] $ValidateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$package = 'com.orbising.orbis'
$runner = "$package.test/androidx.test.runner.AndroidJUnitRunner"
$output = Join-Path $repo '.artifacts\app'
$leaseDir = if ($env:ORBIS_ANDROID_LEASE_DIR) { $env:ORBIS_ANDROID_LEASE_DIR } elseif (Test-Path 'D:\android-emulators') { 'D:\android-emulators\leases' } else { Join-Path $env:LOCALAPPDATA 'Orbis\android-leases' }
$owner = [guid]::NewGuid().ToString()
$leasePath = Join-Path $leaseDir "$Serial.json"
$leaseHeld = $false
$evidenceReady = $false
$testProcess = $null
$buildPid = 0
$runStarted = [DateTime]::UtcNow
$result = [ordered]@{ runId=$owner; serial=$Serial; testClass=$TestClass; passed=$false; startedUtc=$runStarted.ToString('o') }

function Start-Adb([string[]] $Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $script:adb
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8; $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    foreach ($argument in (@('-s', $Serial) + $Arguments)) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    $null = $process.Start()
    return $process
}
function Invoke-Adb([string[]] $Arguments) {
    $process = Start-Adb $Arguments
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw "adb timeout: $($Arguments[0])" }
        $text = $stdout.GetAwaiter().GetResult(); $errorText = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "adb $($Arguments[0]) failed ($($process.ExitCode)): $errorText" }
        return $text
    } finally { $process.Dispose() }
}
function ConvertFrom-InstrumentationOutput([string] $Text, [double] $ElapsedSeconds) {
    $cases = [Collections.Generic.List[object]]::new(); $fields = @{}; $lastKey = ''; $expected = 0
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -match '^INSTRUMENTATION_STATUS: ([^=]+)=(.*)$') {
            $lastKey = $Matches[1]; $fields[$lastKey] = $Matches[2]
            if ($lastKey -eq 'numtests') { $expected = [int]$Matches[2] }
        } elseif ($line -match '^INSTRUMENTATION_STATUS_CODE: (-?\d+)\s*$') {
            $code = [int]$Matches[1]
            if ($code -in @(0,-1,-2,-3,-4) -and $fields.ContainsKey('class') -and $fields.ContainsKey('test')) {
                $cases.Add([pscustomobject]@{class=$fields['class'];name=$fields['test'];code=$code;stack=$fields['stack']})
            }
            $fields=@{}; $lastKey=''
        } elseif ($lastKey -eq 'stack' -and $line -notmatch '^INSTRUMENTATION_') { $fields['stack'] += "`n$line" }
    }
    $failures = @($cases | Where-Object code -eq -2).Count; $errors = @($cases | Where-Object code -eq -1).Count
    $skipped = @($cases | Where-Object { $_.code -in @(-3,-4) }).Count
    $unique = @($cases | ForEach-Object { "$($_.class)#$($_.name)" } | Sort-Object -Unique).Count
    $summaryCount = if ($Text -match '(?m)^OK \((\d+) tests?\)\s*$') { [int]$Matches[1] } else { 0 }
    $complete = $expected -gt 0 -and $cases.Count -eq $expected -and $unique -eq $expected -and $summaryCount -eq $expected -and
        $Text -match '(?m)^INSTRUMENTATION_CODE: -1\s*$'
    $doc = [Xml.XmlDocument]::new(); $suite = $doc.CreateElement('testsuite'); $null = $doc.AppendChild($suite)
    $suite.SetAttribute('name','Orbis USB phone'); $suite.SetAttribute('tests',[string]$cases.Count)
    $suite.SetAttribute('failures',[string]$failures); $suite.SetAttribute('errors',[string]($errors + $(if($complete){0}else{1})))
    $suite.SetAttribute('skipped',[string]$skipped); $suite.SetAttribute('time',$ElapsedSeconds.ToString('F3',[Globalization.CultureInfo]::InvariantCulture))
    foreach ($case in $cases) {
        $node=$doc.CreateElement('testcase'); $node.SetAttribute('classname',$case.class); $node.SetAttribute('name',$case.name)
        $null=$suite.AppendChild($node)
        $kind = switch ($case.code) { -1 {'error'} -2 {'failure'} -3 {'skipped'} -4 {'skipped'} default {$null} }
        if ($kind) { $detail=$doc.CreateElement($kind); $detail.InnerText=[string]$case.stack; $null=$node.AppendChild($detail) }
    }
    if (-not $complete) {
        $node=$doc.CreateElement('testcase'); $node.SetAttribute('name','instrumentation-completion')
        $detail=$doc.CreateElement('error'); $detail.InnerText='Missing or unsuccessful runner completion; see instrumentation.log.'
        $null=$node.AppendChild($detail); $null=$suite.AppendChild($node)
        $suite.SetAttribute('tests',[string]($cases.Count+1))
    }
    return [pscustomobject]@{tests=$cases.Count;failures=$failures;errors=$errors;skipped=$skipped;complete=$complete;xml=$doc.OuterXml}
}
function Save-InstrumentationXml([string] $Text, [double] $ElapsedSeconds) {
    $parsed = ConvertFrom-InstrumentationOutput $Text $ElapsedSeconds
    [IO.File]::WriteAllText((Join-Path $output 'test-results.xml'), $parsed.xml)
    return [pscustomobject]@{tests=$parsed.tests;failures=$parsed.failures;errors=$parsed.errors;skipped=$parsed.skipped;complete=$parsed.complete}
}
function Test-InstrumentationParser {
    $status = @'
INSTRUMENTATION_STATUS: class=com.orbising.orbis.ParserFixture
INSTRUMENTATION_STATUS: test=sample
INSTRUMENTATION_STATUS: numtests=1
'@
    $success = "$status`nINSTRUMENTATION_STATUS_CODE: 0`nOK (1 test)`nINSTRUMENTATION_CODE: -1`n"
    $fixtures = @(
        @{name='success';text=$success;tests=1;failures=0;errors=0;skipped=0;complete=$true},
        @{name='failure';text="$status`nINSTRUMENTATION_STATUS: stack=AssertionError: fixture`n  at Fixture.run(Fixture.kt:1)`nINSTRUMENTATION_STATUS_CODE: -2`nFAILURES!!!`nINSTRUMENTATION_CODE: -1`n";tests=1;failures=1;errors=0;skipped=0;complete=$false},
        @{name='skipped';text="$status`nINSTRUMENTATION_STATUS_CODE: -3`nOK (1 test)`nINSTRUMENTATION_CODE: -1`n";tests=1;failures=0;errors=0;skipped=1;complete=$true},
        @{name='crash';text="INSTRUMENTATION_RESULT: shortMsg=Process crashed.`nINSTRUMENTATION_CODE: 0`n";tests=0;failures=0;errors=0;skipped=0;complete=$false},
        @{name='truncated';text="$status`nINSTRUMENTATION_STATUS_CODE: 0`n";tests=1;failures=0;errors=0;skipped=0;complete=$false},
        @{name='duplicate';text=(($success + $success) -replace 'numtests=1','numtests=2' -replace 'OK \(1 test\)','OK (2 tests)');tests=2;failures=0;errors=0;skipped=0;complete=$false}
    )
    foreach ($fixture in $fixtures) {
        $parsed = ConvertFrom-InstrumentationOutput $fixture.text 1.25
        foreach ($field in @('tests','failures','errors','skipped','complete')) {
            if ($parsed.$field -ne $fixture[$field]) { throw "Parser fixture $($fixture.name): unexpected $field." }
        }
        $xml = [xml]$parsed.xml
        $expectedXmlTests = $fixture.tests + $(if ($fixture.complete) { 0 } else { 1 })
        if ([int]$xml.testsuite.tests -ne $expectedXmlTests) { throw "Parser fixture $($fixture.name): invalid JUnit count." }
        if ($fixture.name -eq 'failure' -and $xml.testsuite.testcase[0].failure -notmatch 'at Fixture.run') { throw 'Multiline failure detail was lost.' }
    }
    Write-Output "PASS: $($fixtures.Count) instrumentation parser fixtures; no device or build required."
}
function Copy-Apk([string] $Source, [string] $Name) {
    $manifest = Get-Content -LiteralPath "$Source.orbis-build.json" -Raw | ConvertFrom-Json
    if ([IO.Path]::GetFullPath($manifest.worktree).TrimEnd('\') -ne [IO.Path]::GetFullPath($repo).TrimEnd('\')) { throw 'APK belongs to another worktree.' }
    if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'APK build checksum mismatch.' }
    $destination = Join-Path $output $Name
    Copy-Item -LiteralPath $Source -Destination $destination
    $manifest.artifactPath = $destination
    [IO.File]::WriteAllText("$destination.orbis-build.json", ($manifest | ConvertTo-Json -Depth 6))
    return $destination
}
if ($ValidateOnly) {
    # Exercise result parsing without adb, builds or filesystem mutations.
    Test-InstrumentationParser
    exit 0
}
if (-not $Serial) { throw '-Serial is required. Use adb devices -l to identify the USB phone.' }
if (-not $env:ANDROID_HOME -or $env:ANDROID_HOME -ne $env:ANDROID_SDK_ROOT) { throw 'ANDROID_HOME and ANDROID_SDK_ROOT must name the same Windows SDK.' }
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
if (-not (Test-Path -LiteralPath $adb)) { throw "Windows adb is missing: $adb" }
if ((Invoke-Adb @('get-state')).Trim() -ne 'device') { throw 'The selected phone is not connected and authorized.' }
if ((Invoke-Adb @('shell','getprop','sys.boot_completed')).Trim() -ne '1') { throw 'The selected phone has not finished booting.' }
$buildScript=Join-Path $repo 'scripts\windows\android-build.ps1'
$runState=Join-Path $repo '.scratch\android-build\current.json'
$shell=(Get-Process -Id $PID).Path
[IO.Directory]::CreateDirectory($leaseDir) | Out-Null
try {
    $stream = [IO.File]::Open($leasePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $bytes=[Text.Encoding]::UTF8.GetBytes(([ordered]@{owner=$owner;task='android-phone-smoke';worktree=$repo;serial=$Serial;pid=$PID;shellPid=$PID;acquiredUtc=$runStarted.ToString('o')} | ConvertTo-Json))
        $stream.Write($bytes,0,$bytes.Length); $stream.Flush(); $leaseHeld=$true
    } finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $runState) {
        $prior=Get-Content -LiteralPath $runState -Raw | ConvertFrom-Json
        if (Get-Process -Id ([int]$prior.pid) -ErrorAction SilentlyContinue) { throw 'Another background build is already recorded in this worktree; wait for it before testing.' }
    }
    # Delete only the verified final App artifact directory, after acquiring this device.
    if ([IO.Path]::GetFullPath($output) -ne [IO.Path]::GetFullPath((Join-Path $repo '.artifacts\app'))) { throw 'Unexpected artifact path.' }
    if (Test-Path -LiteralPath $output) {
        if ((Get-Item -LiteralPath $output).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Artifact directory must not be a link or junction.' }
        Remove-Item -LiteralPath $output -Recurse -Force
    }
    New-Item -ItemType Directory -Path $output | Out-Null
    $evidenceReady = $true
    $result.model=(Invoke-Adb @('shell','getprop','ro.product.model')).Trim()
    $result.android=(Invoke-Adb @('shell','getprop','ro.build.version.release')).Trim()
    $result.sdk=(Invoke-Adb @('shell','getprop','ro.build.version.sdk')).Trim()
    $result.commit=(& git -C $repo rev-parse HEAD).Trim()
    $result.dirty=@(& git -C $repo status --porcelain).Count -gt 0
    & $shell -NoProfile -File $buildScript -Background :app:assembleDebug :app:assembleDebugAndroidTest --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the serialized Android build.' }
    $build=Get-Content -LiteralPath $runState -Raw | ConvertFrom-Json; $buildPid=[int]$build.pid
    do {
        & $shell -NoProfile -File $buildScript -Status
        $build=Get-Content -LiteralPath $runState -Raw | ConvertFrom-Json
        if ([int]$build.pid -ne $buildPid) { throw 'Build state was replaced by another task; do not infer a result from its logs.' }
        if ($null -eq $build.exitCode) { Start-Sleep -Seconds 15 }
    } while ($null -eq $build.exitCode)
    Copy-Item -LiteralPath $build.log -Destination (Join-Path $output 'build.log')
    if ($build.err -and (Test-Path $build.err)) { Copy-Item -LiteralPath $build.err -Destination (Join-Path $output 'build-errors.log') }
    if ([int]$build.exitCode -ne 0) { throw "Android build failed ($($build.exitCode))." }
    $appApk=Copy-Apk (Join-Path $repo 'android\app\build\outputs\apk\debug\app-debug.apk') 'app-debug.apk'
    $testApk=Copy-Apk (Join-Path $repo 'android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk') 'app-debug-androidTest.apk'
    $appManifest=Get-Content -LiteralPath "$appApk.orbis-build.json" -Raw | ConvertFrom-Json
    $testManifest=Get-Content -LiteralPath "$testApk.orbis-build.json" -Raw | ConvertFrom-Json
    if ($appManifest.buildId -ne $testManifest.buildId -or [DateTimeOffset]::Parse($appManifest.builtUtc) -lt $runStarted) { throw 'App and test APKs are not from this build run.' }
    $result.buildId=$appManifest.buildId
    [IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), "$($appManifest.sha256)  app-debug.apk`n$($testManifest.sha256)  app-debug-androidTest.apk`n")
    & (Join-Path $repo 'scripts\windows\android-install.ps1') -Serial $Serial -Apk $appApk
    & (Join-Path $repo 'scripts\windows\android-install.ps1') -Serial $Serial -Apk $testApk
    $testStart=(Invoke-Adb @('shell','date','+%m-%d %H:%M:%S.000')).Trim()
    $testProcess=Start-Adb @('shell','am','instrument','-w','-r','-e','class',$TestClass,$runner)
    $stdout=$testProcess.StandardOutput.ReadToEndAsync(); $stderr=$testProcess.StandardError.ReadToEndAsync()
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while (-not $testProcess.WaitForExit(1000)) {
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw "Instrumentation exceeded $TimeoutSeconds seconds; no pass verdict." }
        if ([int]$timer.Elapsed.TotalSeconds % 15 -eq 0) {
            $free=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB
            Write-Host ('PHONE_TEST_SECONDS={0:N0} FREE_GB={1:N2}' -f $timer.Elapsed.TotalSeconds,$free)
            if ($free -lt 1.5) { throw 'INCONCLUSIVE: stopped phone instrumentation for physical memory pressure.' }
        }
    }
    $text=$stdout.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $output 'instrumentation.log'),$text)
    [IO.File]::WriteAllText((Join-Path $output 'instrumentation-errors.log'),$stderr.GetAwaiter().GetResult())
    $result.tests=Save-InstrumentationXml $text $timer.Elapsed.TotalSeconds
    $result.passed=$testProcess.ExitCode -eq 0 -and $result.tests.complete -and $result.tests.failures -eq 0 -and $result.tests.errors -eq 0 -and $result.tests.skipped -eq 0
    if (-not $result.passed) { throw 'Phone tests failed, were skipped, or did not finish; read test-results.xml and instrumentation.log.' }
    Write-Output "PASS: $($result.tests.tests) tests on $Serial. Evidence: $output"
} catch {
    $result.error=$_.Exception.Message
    throw
} finally {
    if ($testProcess) {
        if (-not $testProcess.HasExited) {
            $testProcess.Kill(); $testProcess.WaitForExit()
            # Only the test runner target belongs to this run; do not touch the computer Host.
            try { Invoke-Adb @('shell','am','force-stop',$package) | Out-Null } catch { Write-Warning 'Could not stop this instrumentation target.' }
            try { [IO.File]::WriteAllText((Join-Path $output 'instrumentation.log'),$stdout.GetAwaiter().GetResult()) } catch {}
        }
        $logPath=Join-Path $output 'instrumentation.log'
        if (-not (Test-Path (Join-Path $output 'test-results.xml')) -and (Test-Path $logPath)) {
            $result.tests=Save-InstrumentationXml ([IO.File]::ReadAllText($logPath)) $timer.Elapsed.TotalSeconds
        }
        $testProcess.Dispose()
    }
    if ($evidenceReady) {
        try {
            $crashArgs=@('logcat','-b','crash','-d','-v','threadtime')
            if (Get-Variable testStart -ErrorAction SilentlyContinue) { $crashArgs+=@('-T',$testStart) }
            [IO.File]::WriteAllText((Join-Path $output 'crash.log'),(Invoke-Adb $crashArgs))
            [IO.File]::WriteAllText((Join-Path $output 'meminfo.txt'),(Invoke-Adb @('shell','dumpsys','meminfo',$package)))
            $remote="/sdcard/orbis-phone-smoke-$owner.png"
            Invoke-Adb @('shell','screencap','-p',$remote) | Out-Null
            Invoke-Adb @('pull',$remote,(Join-Path $output 'screen.png')) | Out-Null
            Invoke-Adb @('shell','rm',$remote) | Out-Null
        } catch { Write-Warning "Could not collect all phone evidence: $($_.Exception.Message)" }
        $result.finishedUtc=[DateTime]::UtcNow.ToString('o')
        [IO.File]::WriteAllText((Join-Path $output 'phone-smoke.json'),($result | ConvertTo-Json -Depth 8))
    }
    if ($leaseHeld) {
        if ($buildPid -gt 0 -and (Get-Process -Id $buildPid -ErrorAction SilentlyContinue)) {
            Write-Warning "Build PID $buildPid is still alive; retaining the device lease until it exits: $leasePath"
        } else {
            $lease=Get-Content -LiteralPath $leasePath -Raw | ConvertFrom-Json
            if ($lease.owner -ne $owner) { throw 'Device lease ownership changed; refusing to remove it.' }
            Remove-Item -LiteralPath $leasePath
        }
    }
}
