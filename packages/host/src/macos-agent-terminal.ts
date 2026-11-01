import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Opening a private .command file needs no Terminal Apple Events/Automation consent. */
export async function openMacAgentTerminal(input: { stateDir: string; cwd: string; command: string; args: readonly string[]; env: NodeJS.ProcessEnv }): Promise<void> {
  const directory = join(input.stateDir, "tmp");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `agent-${randomUUID()}.command`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // Deliberately do not copy credentials or the entire Host environment into a file.
  const environment = ["PATH", "ORBIS_STATE_DIR", "PI_REMOTE_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "CODEX_HOME"]
    .flatMap(key => input.env[key] === undefined ? [] : [`${key}=${input.env[key]}`]);
  const script = ["#!/bin/sh", `cd -- ${quote(input.cwd)} || exit 1`, 'rm -f -- "$0"',
    `exec /usr/bin/env ${[...environment, input.command, ...input.args].map(quote).join(" ")}`, ""].join("\n");
  await writeFile(file, script, { mode: 0o700, flag: "wx" });
  try {
    await chmod(file, 0o700);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/open", ["-a", "Terminal", file], { stdio: "ignore", cwd: input.cwd, timeout: 15_000 });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("无法打开 macOS 终端，请检查 Terminal 是否可用")));
    });
  } catch (error) { await unlink(file).catch(() => undefined); throw error; }
}
