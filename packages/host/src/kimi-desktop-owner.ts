import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { isIP } from "node:net";
import { promisify } from "node:util";

import { meetsMinimumAgentVersion } from "./agent-installation.js";

const run = promisify(execFile);
export const supportsKimiDesktop = (process.platform === "darwin" && process.arch === "arm64")
  || (process.platform === "win32" && process.arch === "x64");
const executableSuffix = "/Contents/MacOS/Kimi Code";
const requirement = 'anchor apple generic and identifier "com.kimi.code.desktop" and certificate leaf[subject.OU] = "2J9472RW75"';
const options = { timeout: 3000, maxBuffer: 8192 };

export async function findKimiDesktopBundle(): Promise<string | undefined> {
  if (!supportsKimiDesktop) return undefined;
  if (process.platform === "win32") return findWindowsKimiDesktop();
  for (const root of [join(homedir(), "Applications"), "/Applications"]) {
    const bundle = await realpath(join(root, "Kimi Code.app")).catch(() => undefined);
    if (bundle?.endsWith(".app") && await stat(bundle + executableSuffix).then(info => info.isFile(), () => false)) return bundle;
  }
  return undefined;
}

/** Apply the same version and signature gate before launching and before trusting a listener. */
export async function verifyKimiDesktopBundle(bundle: string, signal?: AbortSignal): Promise<boolean> {
  if (process.platform === "win32") return verifyWindowsDesktop(bundle, undefined, signal);
  try {
    const limits = { ...options, signal };
    const { stdout } = await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(bundle, "Contents", "Info.plist")], limits);
    if (!meetsMinimumAgentVersion(stdout, "1.3.7")) return false;
    await run("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${requirement}`, bundle], limits);
    return true;
  } catch { return false; }
}

/** Registry PID is a hint, not desktop identity. Never inspect process arguments or launch anything. */
export async function kimiDesktopOwner(pid: number, host: string, port: number): Promise<boolean> {
  if (!supportsKimiDesktop) return false;
  if (process.platform === "win32") {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff || !Number.isInteger(port) || port < 1 || port > 65535
      || !(host === "::1" || (isIP(host) === 4 && host.startsWith("127.")))) return false;
    const installed = await findWindowsKimiDesktop();
    return installed !== undefined && verifyWindowsDesktop(installed, { pid, host, port });
  }
  const command = async () => (await run("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 1200, maxBuffer: 8192 })).stdout.trim();
  try {
    const reported = await command();
    if (!reported.startsWith("/") || !reported.endsWith(executableSuffix)) return false;
    const executable = await realpath(reported);
    if (!executable.endsWith(executableSuffix)) return false;
    const bundle = executable.slice(0, -executableSuffix.length);
    if (!bundle.endsWith(".app") || !await verifyKimiDesktopBundle(bundle)) return false;
    const { stdout: listeners } = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], options);
    const address = host.includes(":") ? `[${host}]` : host;
    return listeners.split("\n").includes(`n${address}:${port}`) && await command() === reported;
  } catch { return false; }
}

const windowsDesktopVersion = "1.5.1.0";
const windowsCertificate = "2473FB09CF3076630B7249051CB9246B7563249D";
// The Electron application code lives in app.asar, outside the signed exe.
const windowsAppHash = "668271B8E42D6642A39C2BE71C32DE7C059313F6F7B00250A45064750FC34500";
const windowsUninstallKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\8e1a5331-d39b-57b9-8da5-3dc7219b2990";

const psLiteral = (value: string): string => `'${value.replace(/['\u2018\u2019\u201a\u201b]/gu, "$&$&")}'`;
async function windowsProbe(script: string, signal?: AbortSignal): Promise<string> {
  const system = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
  const shell = join(system, "powershell.exe");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  env.PSModulePath = join(system, "Modules");
  const command = Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); ${script}`, "utf16le").toString("base64");
  try {
    return (await run(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", command],
      { windowsHide: true, timeout: 9_000, maxBuffer: 8192, signal, env })).stdout.trim();
  } catch { return ""; }
}

async function findWindowsKimiDesktop(): Promise<string | undefined> {
  // The official per-user NSIS installer records the executable even for a custom install directory.
  const icon = await windowsProbe(`(Get-ItemProperty -LiteralPath ${psLiteral(`HKCU:\\${windowsUninstallKey}`)} -Name DisplayIcon).DisplayIcon`);
  const entry = /^"([^"\r\n]+)"(?:,0)?$|^([^"\r\n]+?)(?:,0)?$/u.exec(icon);
  const file = entry?.[1] ?? entry?.[2];
  if (!file || !/^[A-Za-z]:[\\/]/u.test(file) || !isAbsolute(file) || basename(file).toLowerCase() !== "kimi code.exe") return undefined;
  return realpath(file).then(async resolved => await stat(resolved).then(info => info.isFile(), () => false) ? resolved : undefined, () => undefined);
}

async function verifyWindowsDesktop(file: string, owner?: { pid: number; host: string; port: number }, signal?: AbortSignal): Promise<boolean> {
  const identity = owner ? `
    $before = Get-Process -Id ${owner.pid}; $started = $before.StartTime;
    if ($before.Path -ine $file) { exit 1 };
    $native = Get-CimInstance Win32_Process -Filter 'ProcessId = ${owner.pid}';
    $processOwner = Invoke-CimMethod -InputObject $native -MethodName GetOwnerSid;
    if ($processOwner.ReturnValue -ne 0 -or $processOwner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { exit 1 };
  ` : "";
  const listener = owner ? `
    $rows = @(Get-NetTCPConnection -State Listen -OwningProcess ${owner.pid} -LocalAddress ${psLiteral(owner.host)} -LocalPort ${owner.port});
    $after = Get-Process -Id ${owner.pid};
    if ($rows.Count -ne 1 -or $after.Path -ine $file -or $after.StartTime -ne $started) { exit 1 };
  ` : "";
  const result = await windowsProbe(`$file=${psLiteral(file)};
    ${identity}
    if ((Get-Item -LiteralPath $file).VersionInfo.ProductVersion -ne '${windowsDesktopVersion}') { exit 1 };
    $sig = Get-AuthenticodeSignature -LiteralPath $file;
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Thumbprint -ne '${windowsCertificate}') { exit 1 };
    $asar = Join-Path (Split-Path -LiteralPath $file) 'resources\\app.asar';
    if ((Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash -ne '${windowsAppHash}') { exit 1 };
    ${listener}
    'verified';`, signal);
  return result === "verified";
}
