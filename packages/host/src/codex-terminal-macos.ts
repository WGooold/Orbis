import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import { resolveCodexCommand, type CodexCommand } from "./codex-daemon.js";
import { openMacAgentTerminal } from "./macos-agent-terminal.js";
import { processExecutable } from "./codex-desktop-macos.js";
import { CODEX_STARTUP_ARGS } from "./agent-startup.js";

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type TerminalInput = { sessionId: string; cwd: string; endpoint: string; codexCommand?: CodexCommand };
export type MacCodexTui = { pid: number; started: string; command: string; sessionId?: string };

/** Keep the exact app-server CLI and endpoint; a fresh standalone CLI would take a second writer lock. */
export function macCodexTerminalScript(input: TerminalInput & { codexCommand: CodexCommand; sessionsRoot: string }): string {
  const invocation = [input.codexCommand.command, ...input.codexCommand.prefixArgs,
    ...CODEX_STARTUP_ARGS, "resume", input.sessionId, "--remote", input.endpoint].map(quote).join(" ");
  return [
    `: ${quote(`orbis-codex-wait:${input.sessionId}:${new URL(input.endpoint).port}`)};`,
    "unset CODEX_INTERNAL_ORIGINATOR_OVERRIDE;",
    `until /usr/bin/find ${quote(input.sessionsRoot)} -type f -name ${quote(`*${input.sessionId}*.jsonl`)} -print -quit 2>/dev/null | /usr/bin/grep -q .; do`,
    "sleep 0.5;",
    "done;",
    `exec ${invocation}`,
  ].join(" ");
}

export async function openMacCodexTerminal(input: TerminalInput): Promise<void> {
  const codexCommand = input.codexCommand ?? await resolveCodexCommand();
  const sessionsRoot = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  await openMacAgentTerminal({ stateDir: join(tmpdir(), "orbis-codex-terminal"), cwd: input.cwd,
    command: "/bin/sh", args: ["-c", macCodexTerminalScript({ ...input, codexCommand, sessionsRoot })], env: process.env, confirmStart: true });
}

/** Require a terminal, a Codex executable, and exact --remote/resume tokens, not a substring PID match. */
export function parseMacCodexTuis(output: string, endpoint: string): MacCodexTui[] {
  return output.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.{24})\s+(.+)$/u);
    if (!match || match[2] === "??" || match[2] === "?" || !/^\d+$/u.test(match[1]!)) return [];
    const command = match[4]!;
    const waiting = command.match(/^\/bin\/sh -c : 'orbis-codex-wait:([a-zA-Z0-9-]+):(\d+)';/u);
    if (waiting && waiting[2] === new URL(endpoint).port && command.includes(`'--remote' ${quote(endpoint)}`)) {
      return [{ pid: Number(match[1]), started: match[3]!, command, sessionId: waiting[1]! }];
    }
    const native = /^(?:.*\/)?codex(?:\s|$)/u.test(command);
    const npm = /^(?:.*\/)?node\s/u.test(command) && /\/@openai\/codex\/bin\/codex\.js(?:\s|$)/u.test(command);
    if (command.includes("app-server") || !native && !npm) return [];
    const tokens = command.trim().split(/\s+/u);
    if (!tokens.some((token, index) => token === "--remote" && tokens[index + 1] === endpoint || token === `--remote=${endpoint}`)) return [];
    const resume = tokens.lastIndexOf("resume");
    const sessionId = resume >= 0 && /^[a-zA-Z0-9-]+$/u.test(tokens[resume + 1] ?? "") ? tokens[resume + 1] : undefined;
    return [{ pid: Number(match[1]), started: match[3]!, command, ...(sessionId === undefined ? {} : { sessionId }) }];
  });
}

export async function listMacCodexTuis(endpoint: string): Promise<MacCodexTui[]> {
  return (await listMacCodexTuisByEndpoint([endpoint])).get(endpoint) ?? [];
}

/** One process snapshot per watchdog tick, even with many terminal windows. */
export async function listMacCodexTuisByEndpoint(endpoints: readonly string[]): Promise<Map<string, MacCodexTui[]>> {
  const { stdout } = await execute("/bin/ps", ["-axo", "pid=,tty=,lstart=,args="], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  const byEndpoint = new Map(endpoints.map(endpoint => [endpoint, parseMacCodexTuis(stdout, endpoint)]));
  const candidates = new Map([...byEndpoint.values()].flat().map(item => [item.pid, item]));
  const verified = new Set(await Promise.all([...candidates.values()].map(async item => {
    const executable = await processExecutable(item.pid);
    // argv can mention any program. Check the executable itself before a PID is
    // eligible for monitoring or a close request.
    return executable && /\/(?:codex|node|sh)$/u.test(executable) ? item.pid : undefined;
  })));
  return new Map([...byEndpoint].map(([endpoint, items]) => [endpoint, items.filter(item => verified.has(item.pid))]));
}

type MacTerminalControl = { list: typeof listMacCodexTuis; signal: (pid: number) => void; wait: () => Promise<void> };
export async function closeMacCodexTuis(sessionId: string, endpoint: string, control: MacTerminalControl = {
  list: listMacCodexTuis, signal: pid => { process.kill(pid, "SIGTERM"); }, wait: () => delay(100),
}): Promise<boolean> {
  // A terminal: key uses a private endpoint, so both bare and resumed TUIs
  // (including a rollout-waiting shell) belong to exactly this window.
  const matches = (await control.list(endpoint)).filter(item => sessionId.startsWith("terminal:") || item.sessionId === sessionId);
  let closed = false;
  for (const identity of matches) {
    // Recheck PID reuse and argv immediately before signalling only this native TUI.
    const current = (await control.list(endpoint)).find(item => item.pid === identity.pid);
    if (!current || current.started !== identity.started || current.command !== identity.command) continue;
    try { control.signal(identity.pid); closed = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    for (let attempt = 0; attempt < 50; attempt++) {
      const remaining = (await control.list(endpoint)).find(item => item.pid === identity.pid && item.started === identity.started);
      if (!remaining) break;
      if (attempt === 49) throw new Error("Codex 终端进程尚未退出，请在电脑端核对");
      await control.wait();
    }
  }
  return closed;
}
