import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { agentCommandForEntry, cliSearchDirs, findExternalAgentEntries, stopAgentProcess, type AgentCommand } from "./agent-command.js";
import { meetsMinimumAgentVersion } from "./agent-installation.js";

const exec = promisify(execFile);
export type StartGuard = { signal: AbortSignal; check: () => void };
export class LocalAgentStartTimeout extends Error {
  constructor() { super("本机服务启动或接入超时，请稍后重试"); }
}

/** Coalesce explicit callers without letting a retired owner grant permission to spawn. */
export class LocalAgentStart {
  readonly #lifetime = new AbortController();
  readonly #requests = new Set<() => boolean>();
  #pending: Promise<void> | undefined;
  get starting(): boolean { return this.#pending !== undefined; }

  async run(current: () => boolean, changed: () => void, work: (guard: StartGuard) => Promise<void>): Promise<void> {
    if (this.#lifetime.signal.aborted || !current()) throw new Error("启动已取消");
    const request = () => current();
    this.#requests.add(request);
    try {
      if (!this.#pending) {
        const deadline = AbortSignal.timeout(15_000);
        const signal = AbortSignal.any([this.#lifetime.signal, deadline]);
        const check = () => {
          signal.throwIfAborted();
          if (![...this.#requests].some(valid => valid())) throw new Error("启动已取消");
        };
        this.#pending = Promise.resolve().then(() => work({ signal, check })).catch(error => {
          if (this.#lifetime.signal.aborted) throw new Error("启动已取消");
          if (deadline.aborted) throw new LocalAgentStartTimeout();
          throw error;
        }).finally(() => { this.#pending = undefined; changed(); });
        changed();
      }
      await this.#pending;
      if (!current()) throw new Error("启动已取消");
    } finally { this.#requests.delete(request); }
  }

  cancel(): void { this.#lifetime.abort(); }
  async close(): Promise<void> { this.cancel(); await this.#pending?.catch(() => undefined); }
}

export function serviceCli(kind: "opencode" | "openclaw", inherited: NodeJS.ProcessEnv = process.env) {
  const home = (process.platform === "win32" ? inherited.USERPROFILE : inherited.HOME) || homedir();
  const env = { ...inherited };
  for (const key of Object.keys(env)) if (/^orbis_/iu.test(key) || (key.toUpperCase() === "PATH" && key !== "PATH")) delete env[key];
  env.PATH = cliSearchDirs(kind, inherited, process.platform, home).join(delimiter);
  const find = async (minimumVersion?: string) => {
    for (const candidate of await findExternalAgentEntries(kind, inherited)) {
      if (minimumVersion && candidate.version && !meetsMinimumAgentVersion(candidate.version, minimumVersion)) continue;
      if (process.platform === "win32" && !/\.(?:exe|[cm]?js)$/iu.test(candidate.entry)) continue;
      if (await stat(candidate.entry).then(info => info.isFile(), () => false)) return candidate.entry;
    }
    return undefined;
  };
  return { env, cwd: home, find, resolve: async (entry: string) => agentCommandForEntry(entry, env) };
}

export class ServiceCliVersionError extends Error {
  constructor(readonly reason: "unavailable" | "unsupported", message: string) { super(message); }
}

export async function checkServiceCliVersion(cli: AgentCommand, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, name: string, minimumVersion: string, aliases: readonly string[] = [name, name.toLowerCase()]): Promise<void> {
  let result: string;
  try { result = (await exec(cli.command, [...cli.prefixArgs, "--version"], { cwd, env, signal, timeout: 4_000, windowsHide: true, maxBuffer: 8192 })).stdout.trim(); }
  catch { signal.throwIfAborted(); throw new ServiceCliVersionError("unavailable", `无法检查 ${name} CLI 版本`); }
  const prefix = [...aliases].sort((a, b) => b.length - a.length).find(value => result.startsWith(`${value} `));
  const reported = prefix ? result.slice(prefix.length + 1).replace(/ \([^\r\n]*\)$/u, "") : result;
  if (!meetsMinimumAgentVersion(reported, minimumVersion))
    throw new ServiceCliVersionError("unsupported", `${name} CLI 版本不受支持，最低需要 ${minimumVersion}`);
}

export async function waitForLocalAgent<T>(signal: AbortSignal, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    const value = await probe();
    signal.throwIfAborted();
    if (value !== undefined) return value;
    await delay(200, undefined, { signal });
  }
}

export type LocalAgentChild = { pid?: number; failed: () => boolean; exited: () => boolean };

/** Keep only a confirmed shared service. Stop only the exact, unpublished child we spawned. */
export async function launchLocalService(cli: AgentCommand, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv },
  confirm: (child: LocalAgentChild) => Promise<boolean>): Promise<void> {
  const child = spawn(cli.command, [...cli.prefixArgs, ...args], { ...options, detached: true, windowsHide: true, stdio: "ignore" });
  const lease: LocalAgentChild = {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    failed: () => errored || child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0),
    exited: () => errored || child.exitCode !== null || child.signalCode !== null,
  };
  let errored = false, keep = false;
  const exited = new Promise<void>(resolve => {
    child.once("error", () => { errored = true; resolve(); });
    child.once("exit", () => resolve());
  });
  try { keep = await confirm(lease); }
  finally {
    if (!keep && child.pid !== undefined && !lease.exited()) {
      await stopAgentProcess(child, options.env).catch(() => undefined);
      if (!await Promise.race([exited.then(() => true), delay(2_000, false, { ref: false })])) {
        child.kill("SIGKILL");
        await Promise.race([exited, delay(1000)]);
      }
    }
    child.unref();
  }
}
