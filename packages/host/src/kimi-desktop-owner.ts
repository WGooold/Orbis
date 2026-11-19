import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export const supportsKimiDesktop = process.platform === "darwin" && process.arch === "arm64";
const executableSuffix = "/Contents/MacOS/Kimi Code";
const requirement = 'anchor apple generic and identifier "com.kimi.code.desktop" and certificate leaf[subject.OU] = "2J9472RW75"';

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
    if (!bundle.endsWith(".app")) return false;
    const options = { timeout: 3000, maxBuffer: 8192 };
    const { stdout } = await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(bundle, "Contents", "Info.plist")], options);
    if (stdout.trim() !== "1.3.7") return false;
    await run("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${requirement}`, bundle], options);
    const { stdout: listeners } = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], options);
    const address = host.includes(":") ? `[${host}]` : host;
    return listeners.split("\n").includes(`n${address}:${port}`) && await command() === reported;
  } catch { return false; }
}
