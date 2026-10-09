import { spawn } from "node:child_process";
import { homedir } from "node:os";

/** Open the target on the verified local Windows desktop, without restarting the app. */
export async function openCodexDesktopThread(threadId: string, hostId: string): Promise<void> {
  if (process.platform !== "win32" || hostId !== "local" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(threadId)) {
    throw new Error("desktop_refresh_route_unverified");
  }
  const uri = `codex://threads/${encodeURIComponent(threadId)}?hostId=local`;
  const script = `$ErrorActionPreference = 'Stop'\nStart-Process -FilePath '${uri}' -WindowStyle Hidden`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: "ignore", windowsHide: true, cwd: homedir(), timeout: 15_000 });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("无法重新打开 Codex 桌面会话")));
  });
}

/**
 * Activate the registered MSIX application, as the Start menu does. Starting its
 * versioned ChatGPT.exe directly gives the taskbar an executable shortcut and
 * its embedded icon; that shortcut can break after a Store update.
 */
export async function launchCodexDesktopApp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform === "darwin") {
    const child = spawn("open", ["-a", "Codex"], { stdio: "ignore", cwd: homedir(), env });
    await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("无法打开 Codex 桌面版"))); });
    return;
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if ($null -eq $package) { throw '未找到 Codex 桌面版安装包' }
$manifest = Get-AppxPackageManifest -Package $package.PackageFullName
$application = $manifest.Package.Applications.Application | Where-Object { $_.Executable -match '(^|[\\/])ChatGPT\.exe$' } | Select-Object -First 1
if ($null -eq $application) { throw '未找到 Codex 桌面版应用入口' }
$appId = $package.PackageFamilyName + '!' + $application.Id
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
    [PreserveSig] int ActivateForFile(IntPtr appId, IntPtr items, IntPtr verb, out uint processId);
    [PreserveSig] int ActivateForProtocol(IntPtr appId, IntPtr items, out uint processId);
}

public static class OrbisDesktopActivation {
    public static uint Open(string appId) {
        object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c")));
        try {
            uint processId;
            // AO_NOERRORUI: errors belong in the Host UI, not a Windows dialog.
            int result = ((IApplicationActivationManager)instance).ActivateApplication(appId, null, 2, out processId);
            Marshal.ThrowExceptionForHR(result);
            return processId;
        } finally { Marshal.FinalReleaseComObject(instance); }
    }
}
'@
[OrbisDesktopActivation]::Open($appId) | Out-Null
`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    stdio: ["ignore", "ignore", "pipe"], windowsHide: true, cwd: homedir(), timeout: 15_000, env,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`无法打开 Codex 桌面版${stderr.trim() ? `：${stderr.trim()}` : "，请重试"}`)));
  });
}
