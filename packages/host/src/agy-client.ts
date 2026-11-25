import { constants } from "node:fs";
import { access, mkdir, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { AcpCleanupError, AcpClient, AcpResponseError, record, type AcpConnection } from "./acp-client.js";
import type { PiCommand } from "./spawner.js";

export const AGY_VERSION = "1.5.17";

async function resolveAgy(env: NodeJS.ProcessEnv): Promise<PiCommand> {
  const entry = env.ORBIS_AGY_ENTRY?.trim();
  if (entry && !isAbsolute(entry)) throw new Error("ORBIS_AGY_ENTRY 必须是绝对路径");
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs = [...(env.PATH ?? "").split(delimiter), join(home, ".local", "bin")];
  for (const candidate of entry ? [entry] : dirs.filter(isAbsolute).map(dir => join(dir, name))) {
    if (await stat(candidate).then(s => s.isFile(), () => false)
      && await access(candidate, constants.X_OK).then(() => true, () => false)) return { command: candidate, prefixArgs: [] };
  }
  throw new Error("未找到 Antigravity CLI；请安装 agy 或设置 ORBIS_AGY_ENTRY");
}

export async function connectAgy(options: {
  cli?: PiCommand; env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal;
}): Promise<AcpClient> {
  const cli = options.cli ?? await resolveAgy(options.env ?? process.env);
  return AcpClient.launch(cli, ["acp", "--stdio", "--disable-telemetry", "--sandbox", "--app-data-dir", "orbis-agy"], "Antigravity CLI", {
    ...options, timeoutMs: 15_000, validate(result) {
      const caps = record(result.agentCapabilities);
      const list = record(caps.sessionCapabilities).list;
      if (record(result.agentInfo).version !== AGY_VERSION || result.protocolVersion !== 1 || caps.loadSession !== true
        || list === null || typeof list !== "object" || Array.isArray(list)) throw new Error(`需要 Antigravity CLI ${AGY_VERSION} 与 ACP v1 list/load 能力`);
    },
  });
}

/** Headless, single-writer native profile. The policy gate is local, not a paired-App setting. */
export const agyLocallyAllowed = (env = process.env): boolean => env.ORBIS_AGY_ENABLED === "1";

export async function openAgyProfile(stateDir: string, signal: AbortSignal, env = process.env): Promise<AcpConnection> {
  if (!agyLocallyAllowed(env)) throw new Error("请先在 Host 本机启用 Antigravity CLI 接入");
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("请在 Host 本机配置授权的 Gemini API key");
  const cli = await resolveAgy(env);
  signal.throwIfAborted();
  const profile = resolve(stateDir, "agy-acp");
  const home = join(profile, "home");
  const tmp = join(profile, "tmp");
  await Promise.all([home, tmp].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const lock = join(profile, "owner.lock");
  const owner = await open(lock, "wx", 0o600).catch(() => { throw new Error("Antigravity CLI 专用目录已被占用"); });
  let client: AcpClient | undefined;
  const release = async () => { await owner.close(); await unlink(lock); };
  try {
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
    client = await connectAgy({ cli, env: childEnv, cwd: profile, signal });
    const stop = client.stop.bind(client);
    let cleanup: Promise<void> | undefined;
    client.stop = () => cleanup ??= stop().then(release);
    const abort = () => { void client?.stop().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      // Never fall back to personal OAuth. The CLI reads the key from its own env.
      await client.request("authenticate", { methodId: "gemini-api-key" }, 20_000);
      signal.throwIfAborted();
      if (!client.connected) throw new Error("ACP 已断开");
      return client;
    } finally { signal.removeEventListener("abort", abort); }
  } catch (error) {
    if (client) await client.stop();
    else if (error instanceof AcpCleanupError) await owner.close(); // Preserve ownership on startup cleanup uncertainty.
    else await release();
    if (error instanceof AcpResponseError) throw new Error("Antigravity CLI 未确认 Gemini API key 认证");
    if (error instanceof Error && "code" in error) throw new Error("Antigravity CLI 专用目录或进程不可用");
    throw error;
  }
}
