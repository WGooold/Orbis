import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { record, resolveDshCommand } from "./dsh-client.js";
import type { PiCommand } from "./spawner.js";

export interface DshWebService {
  /** Private launch URL, including the process token. Never include it in logs. */
  url: string;
  cli?: PiCommand;
  /** Disconnecting Orbis does not close browser sessions owned by the Web service. */
  stop(): Promise<void>;
}

type Options = { cli?: PiCommand; timeoutMs?: number; port?: number };
type Descriptor = { version: 1; owner: "orbis"; home: string; pid: number; url: string; cli: PiCommand };
const starting = new Map<string, Promise<DshWebService>>();

export function validateDshWebUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("DeepSeek Web 启动链接无效"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.hash
    || url.searchParams.getAll("token").length !== 1 || !/^[A-Za-z0-9_-]{16,}$/.test(url.searchParams.get("token") ?? "")
    || [...url.searchParams.keys()].some(key => key !== "token")) {
    throw new Error("请填写本机 dsh web 启动时输出的完整 http://127.0.0.1:端口/?token=... 链接");
  }
  return url.href;
}

function dshHome(env: NodeJS.ProcessEnv): string {
  const configured = env.DSH_HOME?.trim() ? env.DSH_HOME : join(homedir(), ".dsh");
  return resolve(configured === "~" ? homedir() : /^~[/\\]/.test(configured) ? join(homedir(), configured.slice(2)) : configured);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

async function existsPort(port: number): Promise<boolean> {
  if (port === 0) return false;
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_500, () => finish(true));
  });
}

async function authenticated(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).find(value => value?.startsWith("dsh-auth-"));
    await response.body?.cancel();
    if (response.status !== 303 || !cookie) return false;
    const page = await fetch(new URL("/", url), { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (!page.ok) { await page.body?.cancel(); return false; }
    return (await page.text()).includes("__DSH_BOOT__");
  } catch { return false; }
}

async function readDescriptor(path: string, home: string): Promise<Descriptor | undefined> {
  let stored: Record<string, unknown>;
  try { stored = record(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new Error("无法读取 DeepSeek Web 服务记录", { cause: error });
  }
  if (stored.version !== 1 || stored.owner !== "orbis" || stored.home !== home
    || !Number.isSafeInteger(stored.pid) || Number(stored.pid) <= 0 || !alive(Number(stored.pid)) || typeof stored.url !== "string") return;
  const cli = record(stored.cli);
  if (typeof cli.command !== "string" || !Array.isArray(cli.prefixArgs) || !cli.prefixArgs.every(value => typeof value === "string")) return;
  let url: string;
  try { url = validateDshWebUrl(stored.url); } catch { return; }
  if (!await authenticated(url, 3_000)) return;
  return { version: 1, owner: "orbis", home, pid: Number(stored.pid), url, cli: { command: cli.command, prefixArgs: cli.prefixArgs } };
}

const handle = (url: string, cli?: PiCommand): DshWebService => ({ url, ...(cli ? { cli } : {}), stop: async () => {} });

/** Reuse a normal authenticated Web endpoint before starting one persistent local service. */
export async function ensureDshWebService(env: NodeJS.ProcessEnv = process.env, options: Options = {}): Promise<DshWebService> {
  if (env.ORBIS_DSH_WEB_URL?.trim()) {
    const url = validateDshWebUrl(env.ORBIS_DSH_WEB_URL.trim());
    if (!await authenticated(url, options.timeoutMs ?? 5_000)) throw new Error("无法连接 DeepSeek Web，请确认服务仍在运行并更新启动时输出的完整链接");
    return handle(url, options.cli);
  }
  const home = dshHome(env);
  const existing = starting.get(home);
  if (existing) return existing;
  const pending = ensureLocalService(home, env, options);
  starting.set(home, pending);
  try { return await pending; }
  finally { if (starting.get(home) === pending) starting.delete(home); }
}

async function ensureLocalService(home: string, env: NodeJS.ProcessEnv, options: Options): Promise<DshWebService> {
  const path = join(home, "cache", "orbis-web.json");
  const existing = await readDescriptor(path, home);
  if (existing) return handle(existing.url, existing.cli);
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lockId = randomUUID();
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let lock: FileHandle | undefined;
  while (!lock) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, id: lockId }));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const current = await readDescriptor(path, home);
      if (current) return handle(current.url, current.cli);
      try {
        const owner = record(JSON.parse(await readFile(lockPath, "utf8")));
        if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid)) { await unlink(lockPath); continue; }
      } catch { /* The other creator may be writing or releasing the lock. */ }
      if (Date.now() >= deadline) throw new Error("另一个 DeepSeek Web 正在启动，请稍后重试");
      await delay(100);
    }
  }
  try {
    const current = await readDescriptor(path, home);
    if (current) return handle(current.url, current.cli);
    const port = options.port ?? 3080;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("DeepSeek Web 端口无效");
    if (await existsPort(port)) throw new Error(`本机 ${port} 端口已有服务。请在设置中填写现有 DeepSeek Web 启动时输出的完整链接，接入同一会话`);
    const cli = options.cli ?? await resolveDshCommand(env);
    const outputPath = join(dirname(path), "orbis-web-output.log");
    const output = await open(outputPath, "w", 0o600);
    let child: ChildProcess;
    let failed = false;
    try {
      child = spawn(cli.command, [...cli.prefixArgs, "--profile", "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"], {
        detached: true, windowsHide: true, cwd: homedir(), env, stdio: ["ignore", output.fd, output.fd],
      });
      child.once("error", () => { failed = true; });
    } finally { await output.close(); }
    try {
      while (Date.now() < deadline) {
        if (failed || child.exitCode !== null || child.signalCode !== null) throw new Error("DeepSeek Web 启动失败，请检查本机 DSH 配置");
        const text = await readFile(outputPath, "utf8");
        const printed = /(?:^|\r?\n)dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/.exec(text)?.[1];
        if (printed && await authenticated(printed, 3_000)) {
          if (child.pid === undefined) throw new Error("DeepSeek Web 启动失败");
          const descriptor: Descriptor = { version: 1, owner: "orbis", home, pid: child.pid, url: validateDshWebUrl(printed), cli };
          const temporary = `${path}.${lockId}.tmp`;
          const file = await open(temporary, "wx", 0o600);
          try { await file.writeFile(JSON.stringify(descriptor)); } finally { await file.close(); }
          await rename(temporary, path);
          child.unref();
          return handle(descriptor.url, cli);
        }
        await delay(100);
      }
      throw new Error("DeepSeek Web 启动超时，请检查本机 DSH 配置");
    } catch (error) {
      // Only a service that has never been published is ours to terminate.
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill();
        await Promise.race([exited, delay(3_000)]);
      }
      throw error;
    }
  } finally {
    await lock.close();
    try {
      if (record(JSON.parse(await readFile(lockPath, "utf8"))).id === lockId) await unlink(lockPath);
    } catch { /* A competing process may have reclaimed the lock after our close. */ }
  }
}
