import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AGENT_LAUNCH_ENV_KEYS } from "./agent-command.js";

/** Opening a private .command file needs no Terminal Apple Events/Automation consent. */
export async function openMacAgentTerminal(input: { stateDir: string; cwd: string; command: string; args: readonly string[]; env: NodeJS.ProcessEnv; confirmStart?: boolean; unsetEnv?: readonly string[] }): Promise<void> {
  const directory = join(input.stateDir, "tmp");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `agent-${randomUUID()}.command`);
  const startedFile = `${file}.started`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // Deliberately do not copy credentials or the entire Host environment into a file.
  const environment = [...AGENT_LAUNCH_ENV_KEYS, "ORBIS_STATE_DIR", "PI_REMOTE_STATE_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK"]
    .flatMap(key => input.env[key] === undefined ? [] : [`${key}=${input.env[key]}`]);
  const script = ["#!/bin/sh", `cd -- ${quote(input.cwd)} || exit 1`, 'rm -f -- "$0"',
    ...(input.confirmStart ? [`[ -t 0 ] || exit 1`, `/usr/bin/touch -- ${quote(startedFile)}`] : []),
    `exec /usr/bin/env ${[...(input.unsetEnv ?? []).flatMap(key => ["-u", key]), ...environment, input.command, ...input.args].map(quote).join(" ")}`, ""].join("\n");
  await writeFile(file, script, { mode: 0o700, flag: "wx" });
  try {
    await chmod(file, 0o700);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/open", ["-a", "Terminal", file], { stdio: "ignore", cwd: input.cwd, timeout: 15_000 });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("无法打开 macOS 终端，请检查 Terminal 是否可用")));
    });
    if (input.confirmStart) {
      await waitForMacTerminalScriptStart(startedFile, "Terminal 未确认启动 Codex 会话，请检查终端窗口后重试");
    }
  } catch (error) { await unlink(file).catch(() => undefined); throw error; }
  finally { if (input.confirmStart) await unlink(startedFile).catch(() => undefined); }
}

/** An `open` receipt is not evidence that Terminal executed the private script. */
export async function waitForMacTerminalScriptStart(startedFile: string, timeoutMessage: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await stat(startedFile).then(() => true, () => false)) {
    if (Date.now() >= deadline) throw new Error(timeoutMessage);
    await delay(50);
  }
}
