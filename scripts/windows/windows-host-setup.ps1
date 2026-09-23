param([string]$InstallRoot = 'D:\Qt')
$ErrorActionPreference = 'Stop'
python -m pip install --user aqtinstall==3.3.0
if ($LASTEXITCODE -ne 0) { throw 'aqtinstall setup failed' }
python -m aqt install-qt windows desktop 6.8.3 win64_mingw -O $InstallRoot --archives qtbase qtdeclarative qttools qtsvg qttranslations
if ($LASTEXITCODE -ne 0) { throw 'Qt installation failed' }
python -m aqt install-tool windows desktop tools_mingw1310 qt.tools.win64_mingw1310 -O $InstallRoot
if ($LASTEXITCODE -ne 0) { throw 'MinGW installation failed' }
Write-Output "Qt and MinGW ready in $InstallRoot. CMake and Ninja must also be on PATH."
