import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveCodexCommand, type CodexCommand } from "./codex-daemon.js";

const LOOPBACK_DESCRIPTOR = join(homedir(), ".pi-remote", "loopback.json");

type LoopbackDescriptor = { url?: unknown; token?: unknown };
type LaunchResult = { endpoint?: unknown; command?: unknown; prefixArgs?: unknown };

export function usesHostLaunch(args: readonly string[]): boolean {
  return args.length === 0;
}

/** Entry used by the managed Windows `codex.cmd` shim. */
export async function runCodexShim(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (usesHostLaunch(args)) {
    const launch = await requestHostLaunch(process.cwd()).catch(() => undefined);
    if (launch !== undefined) return await spawnCodex({
      command: { command: launch.command, prefixArgs: launch.prefixArgs },
      args: ["--remote", launch.endpoint],
      cwd: process.cwd(),
    });
  }
  const command = await resolveCodexCommand();
  return await spawnCodex({ command, args, cwd: process.cwd() });
}

async function requestHostLaunch(cwd: string): Promise<{ endpoint: string; command: string; prefixArgs: string[] }> {
  const descriptor = JSON.parse(await readFile(LOOPBACK_DESCRIPTOR, "utf8")) as LoopbackDescriptor;
  if (typeof descriptor.url !== "string" || typeof descriptor.token !== "string") throw new Error("invalid Host loopback descriptor");
  const response = await fetch(`${descriptor.url.replace(/^ws:/u, "http:")}/v1/codex/launch`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify({ cwd }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Host launch request failed: ${response.status}`);
  const result = await response.json() as LaunchResult;
  if (typeof result.endpoint !== "string" || typeof result.command !== "string" || !Array.isArray(result.prefixArgs)
    || !result.prefixArgs.every((arg): arg is string => typeof arg === "string")) {
    throw new Error("invalid Host launch response");
  }
  return { endpoint: result.endpoint, command: result.command, prefixArgs: result.prefixArgs };
}

async function spawnCodex(input: { command: CodexCommand | { command: string; prefixArgs?: readonly string[] }; args: readonly string[]; cwd: string }): Promise<number> {
  const child = spawn(input.command.command, [...(input.command.prefixArgs ?? []), ...input.args], {
    cwd: input.cwd,
    stdio: "inherit",
    windowsHide: false,
  });
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 1)));
  });
}

if (process.argv[1]?.endsWith("codex-shim.js") === true) {
  runCodexShim().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
