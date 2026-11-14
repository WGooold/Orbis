import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { DesktopCli, DesktopCliCandidate } from "./codex-desktop-cli.js";

/** Only a failed OS spawn permits retrying an arbitrary command. */
export class DesktopCliSpawnError extends Error {
  constructor(readonly command: string, cause: unknown) {
    super("无法启动 " + command + "：" + (cause instanceof Error ? cause.message : String(cause)), { cause });
  }
}

export type StartedDesktopCli = { child: ChildProcess; closed: Promise<number> };
export async function startDesktopCli(cli: DesktopCli, args: readonly string[], options: SpawnOptions): Promise<StartedDesktopCli> {
  let child: ChildProcess;
  try { child = spawn(cli.command, [...cli.prefixArgs, ...args], options); }
  catch (error) { throw new DesktopCliSpawnError(cli.command, error); }
  const closed = new Promise<number>(resolve => child.once("close", (code, signal) => resolve(code ?? (signal === null ? 0 : 1))));
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    // Keep an error listener after spawn too; only rejection before spawn selects another CLI.
    child.on("error", error => reject(new DesktopCliSpawnError(cli.command, error)));
  });
  return { child, closed };
}

export type StartupQueryResult = { code: number; stdout: string; stderr: string };
export function isStartupPolicyQuery(args: readonly string[]): boolean {
  return args.includes("app-server") && args.includes("--print-startup-config") && !args.includes("--startup-sign-out");
}
export function desktopVersionFromArgs(args: readonly string[]): string | undefined {
  const index = args.indexOf("--startup-client-info");
  if (index < 0) return undefined;
  try {
    const value = JSON.parse(args[index + 1] ?? "") as { version?: unknown };
    return typeof value.version === "string" && /^\d+(?:\.\d+)*$/u.test(value.version) ? value.version : undefined;
  } catch { return undefined; }
}
export function startupProbeArgs(args: readonly string[]): string[] {
  const index = args.indexOf("--startup-client-info");
  return ["app-server", "--print-startup-config", "--startup-client-info",
    index >= 0 ? args[index + 1] ?? "{}" : JSON.stringify({ name: "codex_desktop", title: "Codex Desktop", version: "orbis-runtime-check" })];
}

export function isStartupProtocolResponse(stdout: string): boolean {
  try {
    const value: unknown = JSON.parse(stdout);
    if (value === null || typeof value !== "object") return false;
    const result = value as Record<string, unknown>;
    // Native errors must pass through, including organization/auth/configuration errors.
    if (result.error !== null && typeof result.error === "object") {
      const error = result.error as Record<string, unknown>;
      return typeof error.code === "number" && typeof error.message === "string";
    }
    return typeof result.appServerVersion === "string" && result.configRequirements !== null && typeof result.configRequirements === "object";
  } catch { return false; }
}

/** Read-only startup query: buffer its protocol output so a rejected CLI cannot corrupt stdout. */
export async function queryDesktopStartup(cli: DesktopCli, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<StartupQueryResult> {
  if (!isStartupPolicyQuery(args)) throw new Error("只允许探测只读启动策略查询");
  const { child, closed } = await startDesktopCli(cli, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "", failure: string | undefined;
  const timer = setTimeout(() => { failure = "启动策略查询超时"; child.kill(); }, timeoutMs);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (stdout.length + chunk.length > 4 * 1024 * 1024) { failure = "启动策略输出超过限制"; child.kill(); }
    else stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-65536); });
  try {
    const code = await closed;
    if (failure !== undefined) throw new Error(failure);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

export async function selectStartupCli(
  candidates: readonly DesktopCliCandidate[], args: readonly string[], env: NodeJS.ProcessEnv,
  log: (message: string) => void,
  query: typeof queryDesktopStartup = queryDesktopStartup,
): Promise<{ cli: DesktopCliCandidate; result: StartupQueryResult }> {
  const deadline = Date.now() + 25_000;
  const failures: string[] = [];
  for (const cli of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const result = await query(cli, args, env, Math.min(remaining, 20_000));
      if (isStartupProtocolResponse(result.stdout)) {
        log("使用 CLI source=" + cli.source + " path=" + cli.command);
        return { cli, result };
      }
      const reason = "启动协议不兼容，exit=" + result.code + " stdoutBytes=" + Buffer.byteLength(result.stdout);
      failures.push(cli.source + ": " + reason);
      log("跳过 CLI source=" + cli.source + " path=" + cli.command + "；" + reason);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(cli.source + ": " + reason);
      log("跳过 CLI source=" + cli.source + " path=" + cli.command + "；" + reason);
    }
  }
  throw new Error("没有可用的匹配 Codex CLI" + (failures.length ? "；" + failures.join("；") : ""));
}

/** Never replay a command after it has started, even if it exits with a nonzero status. */
export async function passthroughCandidates(candidates: readonly DesktopCliCandidate[], args: readonly string[], env: NodeJS.ProcessEnv,
  log: (message: string) => void): Promise<number> {
  for (const cli of candidates) {
    let started: StartedDesktopCli;
    try { started = await startDesktopCli(cli, args, { env, stdio: "inherit", windowsHide: false }); }
    catch (error) {
      if (!(error instanceof DesktopCliSpawnError)) throw error;
      log(error.message);
      continue;
    }
    return started.closed;
  }
  throw new Error("所有 Codex CLI 候选均无法启动");
}
