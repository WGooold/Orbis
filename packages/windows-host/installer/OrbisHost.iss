#ifndef StageDir
  #error StageDir is required
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
[Setup]
AppId={{7D5CE083-9F47-48CA-B802-CC14F269FAE1}
AppName=Orbis Host
AppVersion=0.1.20
AppPublisher=Orbis
AppPublisherURL=https://github.com/WGooold/Orbis
DefaultDirName={localappdata}\Programs\Orbis Host
DefaultGroupName=Orbis
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=OrbisHost-0.1.20-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\src\assets\orbis.ico
UninstallDisplayIcon={app}\OrbisHost.exe
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs overwritereadonly uninsremovereadonly

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked

[Icons]
Name: "{group}\Orbis Host"; Filename: "{app}\OrbisHost.exe"
Name: "{userdesktop}\Orbis Host"; Filename: "{app}\OrbisHost.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\OrbisHost.exe"; Description: "Launch Orbis Host"; Flags: nowait postinstall skipifsilent
Filename: "{app}\OrbisHost.exe"; Flags: nowait runasoriginaluser; Check: RelaunchAfterUpdate

[Code]
function RelaunchAfterUpdate: Boolean;
begin
  Result := ExpandConstant('{param:ORBISRELAUNCH|0}') = '1';
end;

function SupportsInstallerCleanup(const InstalledHost: String): Boolean;
var
  SupportedHash: AnsiString;
begin
  { A downgraded executable must not inherit a newer install's capability marker. }
  Result := LoadStringFromFile(ExpandConstant('{app}\installer-update-v1.sha256'), SupportedHash);
  if Result then
    Result := CompareText(Trim(String(SupportedHash)), GetSHA256OfFile(InstalledHost)) = 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
  InstalledHost: String;
begin
  Result := '';
  if ExpandConstant('{param:ORBISHOSTCLOSED|0}') = '1' then Exit;
  InstalledHost := ExpandConstant('{app}\OrbisHost.exe');
  if not FileExists(InstalledHost) then Exit;
  { HOST-UPDATE-03: setup owns confirmation; cleanup never opens a Host page. }
  if SuppressibleMsgBox('停止后台并安装新版 Host？' + #13#10 + #13#10 +
    '手机连接将断开，Orbis 管理的相关后台将停止，正在执行的任务可能中断。',
    mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) <> IDYES then begin
    Result := '安装已取消。';
    Exit;
  end;
  ExitCode := 1;
  if SupportsInstallerCleanup(InstalledHost) then begin
    if not Exec(InstalledHost, '--prepare-update-confirmed', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then begin
      Result := '无法启动后台收尾流程，请关闭相关应用后重试。';
      Exit;
    end;
  end;
  if ExitCode = 1 then begin
    { Older executables or running instances cannot accept setup-owned confirmation. }
    if SuppressibleMsgBox('旧版 Host 不支持安装器自动收尾。请先退出 Host、DeepSeek Web 和 Codex 桌面端，相关任务会中断。确认全部关闭后继续安装？', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) <> IDYES then
      Result := '安装已取消。';
  end else if ExitCode <> 0 then
    Result := '后台收尾未完成，安装已暂停。请关闭相关应用后重试。';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
  RuntimeRoot: String;
begin
  if CurStep <> ssPostInstall then Exit;
  RuntimeRoot := ExpandConstant('{app}\runtime');
  ExitCode := -1;
  if not Exec(RuntimeRoot + '\node\node.exe',
    '"' + RuntimeRoot + '\packages\host\dist\pi-integration-install.js" "' + RuntimeRoot + '\packages\pi-extension"',
    '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
    RaiseException('Could not register Orbis with Pi. Check the current user''s Pi configuration.');
  ExitCode := -1;
  if not Exec(RuntimeRoot + '\node\node.exe',
    '"' + RuntimeRoot + '\packages\host\dist\codex-shim-install.js" --install "' + RuntimeRoot + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
    RaiseException('Could not install the Codex terminal shim.');
  ExitCode := -1;
  if not Exec(RuntimeRoot + '\node\node.exe',
    '"' + RuntimeRoot + '\packages\host\dist\claude-integration-install.js" "' + RuntimeRoot + '\packages\claude-mod" --settings "' + ExpandConstant('{localappdata}\Orbis\Orbis Host\settings.ini') + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
    Log('Could not register Orbis with Claude Code. The desktop app will retry when opened.');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ExitCode: Integer;
  RuntimeRoot: String;
begin
  if CurUninstallStep <> usUninstall then Exit;
  RuntimeRoot := ExpandConstant('{app}\runtime');
  if FileExists(RuntimeRoot + '\packages\host\dist\pi-integration-install.js') then begin
    ExitCode := -1;
    if not Exec(RuntimeRoot + '\node\node.exe',
      '"' + RuntimeRoot + '\packages\host\dist\pi-integration-install.js" "' + RuntimeRoot + '\packages\pi-extension" --uninstall',
      '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      Log('Could not remove the Orbis Pi integration from user settings.');
  end;
  if FileExists(RuntimeRoot + '\packages\host\dist\codex-shim-install.js') then begin
    ExitCode := -1;
    if not Exec(RuntimeRoot + '\node\node.exe',
      '"' + RuntimeRoot + '\packages\host\dist\codex-shim-install.js" --uninstall',
      '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      Log('Could not remove the Orbis Codex terminal shim.');
  end;
  if FileExists(RuntimeRoot + '\packages\host\dist\claude-integration-install.js') then begin
    ExitCode := -1;
    if not Exec(RuntimeRoot + '\node\node.exe',
      '"' + RuntimeRoot + '\packages\host\dist\claude-integration-install.js" "' + RuntimeRoot + '\packages\claude-mod" --uninstall',
      '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      Log('Could not remove the Orbis Claude Code plugin.');
  end;
end;

[UninstallDelete]
; User configuration, Windows-protected activation and pairing records are deliberately retained.

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "OrbisHost"; Flags: uninsdeletevalue
