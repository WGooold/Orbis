#ifndef StageDir
  #error StageDir is required
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
[Setup]
AppId={{7D5CE083-9F47-48CA-B802-CC14F269FAE1}
AppName=Orbis Host
AppVersion=0.1.6
AppPublisher=Orbis
AppPublisherURL=https://github.com/WGooold/Orbis
DefaultDirName={localappdata}\Programs\Orbis Host
DefaultGroupName=Orbis
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=OrbisHost-0.1.6-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\src\assets\orbis.ico
UninstallDisplayIcon={app}\OrbisHost.exe
CloseApplications=yes
RestartApplications=no

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked

[Icons]
Name: "{group}\Orbis Host"; Filename: "{app}\OrbisHost.exe"
Name: "{userdesktop}\Orbis Host"; Filename: "{app}\OrbisHost.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\OrbisHost.exe"; Description: "Launch Orbis Host"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; User configuration, Windows-protected activation and pairing records are deliberately retained.

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "OrbisHost"; Flags: uninsdeletevalue
