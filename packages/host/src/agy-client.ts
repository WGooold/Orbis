import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, rm, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AcpCleanupError, AcpClient, AcpResponseError, record, type AcpConnection } from "./acp-client.js";
import { cliPathDirs } from "./agent-command.js";
import { agyKey, agyKeyFailure, verifyAgyKey, type AgyKeyCheck } from "./agy-credential.js";
import type { PiCommand } from "./spawner.js";

export const AGY_VERSION = "1.5.17";
const AGY_KEY_METHOD = "gemini-api-key";

export class AgyCredentialRejectedError extends Error {
  constructor() { super("Antigravity CLI 未确认 Gemini API Key 认证"); }
}

async function resolveAgy(env: NodeJS.ProcessEnv): Promise<PiCommand> {
  const entry = env.ORBIS_AGY_ENTRY?.trim();
  if (entry && !isAbsolute(entry)) throw new Error("ORBIS_AGY_ENTRY 必须是绝对路径");
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs = [...cliPathDirs(env), join(home, ".local", "bin")];
  if (process.platform === "win32" && env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, "agy", "bin"));
  for (const candidate of entry ? [entry] : dirs.filter(isAbsolute).map(dir => join(dir, name))) {
    if (await stat(candidate).then(s => s.isFile(), () => false)
      && await access(candidate, constants.X_OK).then(() => true, () => false)) return { command: candidate, prefixArgs: [] };
  }
  throw new Error("未找到 Antigravity CLI；请使用 Host 可见的安装路径");
}

export const findAgy = async (env = process.env): Promise<boolean> => resolveAgy(env).then(() => true, () => false);

export async function connectAgy(options: {
  cli?: PiCommand; env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; geminiDir?: string;
}): Promise<AcpClient> {
  const cli = options.cli ?? await resolveAgy(options.env ?? process.env);
  const args = ["acp", "--stdio", "--disable-telemetry", "--sandbox", "--app-data-dir", "orbis-agy"];
  if (options.geminiDir) args.push("--gemini-dir", options.geminiDir);
  const key = agyKey(options.env?.GEMINI_API_KEY);
  return AcpClient.launch(cli, args, "Antigravity CLI", {
    ...options, ...(key ? { redact: (line: string) => line.replaceAll(key, "[REDACTED]") } : {}), timeoutMs: 15_000, validate(result) {
      const caps = record(result.agentCapabilities);
      const list = record(caps.sessionCapabilities).list;
      if (record(result.agentInfo).version !== AGY_VERSION || result.protocolVersion !== 1 || caps.loadSession !== true
        || list === null || typeof list !== "object" || Array.isArray(list)) throw new Error(`需要 Antigravity CLI ${AGY_VERSION} 与 ACP v1 list/load 能力`);
      if (!Array.isArray(result.authMethods) || !result.authMethods.some(method => record(method).id === AGY_KEY_METHOD)) {
        throw new Error("Antigravity CLI 未提供 Gemini API Key 认证");
      }
    },
  });
}

/** Headless, single-writer native profile. Callers own the local policy and credential source. */
export async function openAgyProfile(stateDir: string, signal: AbortSignal, options: {
  key: unknown; env?: NodeJS.ProcessEnv; verify?: typeof verifyAgyKey; cli?: PiCommand;
}): Promise<AcpConnection> {
  signal.throwIfAborted();
  const apiKey = agyKey(options.key);
  if (!apiKey) throw new Error(agyKeyFailure("invalid"));
  const env = options.env ?? process.env;
  const cli = options.cli ?? await resolveAgy(env);
  const verification = await (options.verify ?? verifyAgyKey)(apiKey, signal);
  signal.throwIfAborted();
  if (verification !== "verified") throw new Error(agyKeyFailure(verification));
  const profile = resolve(stateDir, "agy-acp");
  const home = join(profile, "home");
  const tmp = join(profile, "tmp");
  await Promise.all([home, tmp].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const lock = join(profile, "owner.lock");
  const owner = await open(lock, "wx", 0o600).catch(() => { throw new Error("Antigravity CLI 专用目录已被占用"); });
  let client: AcpClient | undefined;
  const release = async () => { await owner.close(); await unlink(lock); };
  try {
    signal.throwIfAborted();
    await owner.writeFile(`${process.pid}\n`);
    // Do not copy Host, Relay or other agents' credentials to the subprocess. The
    // API key is supplied only as documented native process environment, never RPC.
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL"]) {
      if (env[key] !== undefined) childEnv[key] = env[key];
    }
    Object.assign(childEnv, {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"), TMPDIR: tmp, TMP: tmp, TEMP: tmp, GEMINI_API_KEY: apiKey,
    });
    client = await connectAgy({ cli, env: childEnv, cwd: profile, geminiDir: join(home, ".gemini"), signal });
    const stop = client.stop.bind(client);
    let cleanup: Promise<void> | undefined;
    client.stop = () => cleanup ??= stop().then(release);
    const abort = () => { void client?.stop().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      // Never fall back to personal OAuth. The CLI reads the key from its own env.
      await client.request("authenticate", { methodId: AGY_KEY_METHOD }, 20_000);
      signal.throwIfAborted();
      if (!client.connected) throw new Error("ACP 已断开");
      return client;
    } finally { signal.removeEventListener("abort", abort); }
  } catch (error) {
    if (client) await client.stop();
    else if (error instanceof AcpCleanupError) await owner.close(); // Preserve ownership on startup cleanup uncertainty.
    else await release();
    if (error instanceof AcpResponseError) throw new AgyCredentialRejectedError();
    if (error instanceof Error && "code" in error) throw new Error("Antigravity CLI 专用目录或进程不可用");
    throw error;
  }
}

/** Google Models API + native ACP auth + session/list, before a candidate replaces a saved key. */
export async function verifyAgyConnection(value: unknown, options: {
  signal?: AbortSignal; env?: NodeJS.ProcessEnv; verify?: typeof verifyAgyKey; cli?: PiCommand;
} = {}): Promise<AgyKeyCheck> {
  const key = agyKey(value);
  if (!key) return "invalid";
  const verification = await (options.verify ?? verifyAgyKey)(key, options.signal);
  options.signal?.throwIfAborted();
  if (verification !== "verified") return verification;
  const directory = await mkdtemp(join(tmpdir(), "orbis-agy-auth-check-"));
  let client: AcpConnection | undefined;
  try {
    client = await openAgyProfile(directory, options.signal ?? new AbortController().signal, {
      key, env: options.env ?? process.env, verify: async () => "verified", cli: options.cli ?? await resolveAgy(options.env ?? process.env),
    });
    const sessions = record(await client.request("session/list", {}, 5_000));
    return Array.isArray(sessions.sessions) ? "verified" : "unavailable";
  } catch (error) {
    options.signal?.throwIfAborted();
    return error instanceof AgyCredentialRejectedError ? "rejected" : "unavailable";
  } finally {
    if (client) await client.stop().catch(() => {});
    const lock = join(directory, "agy-acp", "owner.lock");
    // Never erase a profile still owned by a child whose cleanup was not confirmed.
    if (!await stat(lock).then(() => true, () => false)) await rm(directory, { recursive: true, force: true });
  }
}
