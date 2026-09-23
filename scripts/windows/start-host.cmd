@echo off
rem Start the resident Host (Orbis) in its own minimized window.
rem
rem Why not from an AI session or a background task: a process started by a session or a
rem background job is reaped when that session/job ends, and a second session may taskkill
rem it (both use the same runtime credential and kick each other offline; the phone then
rem shows "waiting for encrypted handshake" / "target instance is offline" over and over).
rem Run this file by double-clicking it or from your own terminal: the Host then hangs on
rem THIS window and does not depend on any session.
rem
rem Closing that minimized window stops the Host. Logs are appended to
rem data\host-pair.log and data\host-pair.err.log.
rem
rem NOTE: this file is ASCII only on purpose. cmd.exe parses batch files with the OEM code
rem page (936 on a Chinese Windows), where UTF-8 Chinese text decodes to bytes that cmd can
rem read as command separators - the comments then turn into bogus commands. Keep it ASCII.

cd /d "%~dp0..\.."

rem Keep APPDATA explicit: the Codex JS entry resolves via %APPDATA%\npm, and without it
rem the backend silently degrades to "not enabled".
set "APPDATA=%APPDATA%"
if "%APPDATA%"=="" set "APPDATA=%USERPROFILE%\AppData\Roaming"

start "Orbis Host" /min cmd /c "node scripts\host-pair.mjs --codex >> data\host-pair.log 2>> data\host-pair.err.log"

echo Started Orbis Host in a new minimized window.
echo   - ready check: data\host-pair.log shows "started" / "P2P enabled" / "Codex backend ready"
echo   - stop: close that minimized window (taskkill /F /IM node.exe also kills Pi; use with care)
