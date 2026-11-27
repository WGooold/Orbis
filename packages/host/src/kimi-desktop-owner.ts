import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { meetsMinimumAgentVersion } from "./agent-installation.js";

const run = promisify(execFile);
export const supportsKimiDesktop = process.platform === "darwin" && process.arch === "arm64";
const executableSuffix = "/Contents/MacOS/Kimi Code";
const requirement = 'anchor apple generic and identifier "com.kimi.code.desktop" and certificate leaf[subject.OU] = "2J9472RW75"';
const options = { timeout: 3000, maxBuffer: 8192 };

export async function findKimiDesktopBundle(): Promise<string | undefined> {
  if (!supportsKimiDesktop) return undefined;
  for (const root of [join(homedir(), "Applications"), "/Applications"]) {
    const bundle = await realpath(join(root, "Kimi Code.app")).catch(() => undefined);
    if (bundle?.endsWith(".app") && await stat(bundle + executableSuffix).then(info => info.isFile(), () => false)) return bundle;
  }
  return undefined;
}

/** Apply the same version and signature gate before launching and before trusting a listener. */
export async function verifyKimiDesktopBundle(bundle: string, signal?: AbortSignal): Promise<boolean> {
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
