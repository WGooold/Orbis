import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AcpCleanupError, AcpClient, AcpResponseError, record, type AcpConnection } from "./acp-client.js";
import { cliPathDirs } from "./agent-command.js";
import { meetsMinimumAgentVersion } from "./agent-installation.js";
import { agyKey, agyKeyFailure, verifyAgyKey, type AgyKeyCheck } from "./agy-credential.js";
import { agyAuthIssue, agyProfile, agyUsesGoogle, parseAgyAuthConfig, type AgyAuthConfig, type AgyAuthMethod } from "./agy-auth.js";
import type { PiCommand } from "./spawner.js";

export const AGY_VERSION = "1.5.17";
export type AgyProfile = ReturnType<typeof agyProfile>;
export type AgyProcessOptions = {
  env?: NodeJS.ProcessEnv; cli?: PiCommand; signal?: AbortSignal; verify?: typeof verifyAgyKey;
  onAuthorizationUrl?: (url: string) => void;
};

export class AgyCredentialRejectedError extends Error {
  constructor() { super("Antigravity CLI 未确认所选认证方式；请在 Host 本机检查登录"); }
}

export async function resolveAgy(env: NodeJS.ProcessEnv): Promise<PiCommand> {
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

export function agyArgs(geminiDir?: string, appDataDir = "orbis-agy"): string[] {
  return ["acp", "--stdio", "--disable-telemetry", "--sandbox", "--app-data-dir", appDataDir,
    ...(geminiDir ? ["--gemini-dir", geminiDir] : [])];
}

/** Match the CLI's dedicated non-ACP-stdio login mode; unlike the agent process it has no sandbox flag. */
export function agyLoginArgs(geminiDir: string, appDataDir = "antigravity-acp"): string[] {
  return ["acp", "--app-data-dir", appDataDir, "--gemini-dir", geminiDir, "--login"];
}

export async function connectAgy(options: AgyProcessOptions & {
  cwd?: string; geminiDir?: string; appDataDir?: string; authMethod?: AgyAuthMethod;
}): Promise<AcpClient> {
  const cli = options.cli ?? await resolveAgy(options.env ?? process.env);
  const authMethod = options.authMethod ?? "gemini-api-key";
  const key = agyKey(options.env?.GEMINI_API_KEY) ?? agyKey(options.env?.GOOGLE_API_KEY);
  const args = agyArgs(options.geminiDir, options.appDataDir);
  return AcpClient.launch(cli, args, "Antigravity CLI", {
    ...options, ...(key ? { redact: (line: string) => line.replaceAll(key, "[REDACTED]") } : {}), timeoutMs: 15_000, validate(result) {
      const caps = record(result.agentCapabilities);
      const list = record(caps.sessionCapabilities).list;
      if (!meetsMinimumAgentVersion(record(result.agentInfo).version, AGY_VERSION) || result.protocolVersion !== 1 || caps.loadSession !== true
        || list === null || typeof list !== "object" || Array.isArray(list)) throw new Error(`需要 Antigravity CLI ${AGY_VERSION} 或更新版本与 ACP v1 list/load 能力`);
      if (!Array.isArray(result.authMethods) || !result.authMethods.some(method => record(method).id === authMethod)) {
        throw new Error("Antigravity CLI 未提供所选认证方式");
      }
    },
  });
}

/** Explicit auth settings, never inherited Google/Relay secrets. OAuth stays in the CLI. */
export function agyBrowserCommand(executable = process.execPath, platform = process.platform): string {
  const marker = "__ORBIS_ANTIGRAVITY_AUTH_URL__";
  const source = `process.stderr.on("error",()=>process.exit(0)).write(${JSON.stringify(marker)}+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = [executable, "-e", source, "--", "%s"].map(quote).join(" ");
  if (command.includes(platform === "win32" ? ";" : ":") || /[\r\n\0]/u.test(executable) || executable.includes("%s")) {
    throw new Error("Antigravity browser helper path is not supported");
  }
  return command;
}

export function agyEnvironment(env: NodeJS.ProcessEnv, profile: AgyProfile, auth: AgyAuthConfig, browser = false): NodeJS.ProcessEnv {
  const { home, temp, geminiDir } = profile;
  const result: NodeJS.ProcessEnv = {};
  const allowed = ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL",
    ...(browser ? ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] : [])];
  for (const name of allowed) {
    const source = env[name] ?? (process.platform === "win32" ? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1] : undefined);
    if (source !== undefined) result[name] = source;
  }
  Object.assign(result, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"), TMPDIR: temp, TMP: temp, TEMP: temp,
    GEMINI_HOME: geminiDir, AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  });
  // The pinned CLI chooses its own profile-local storage for remote sign-in.
  // Only personal uses that native flow; never inject any token or OAuth client identity.
  if (auth.authMethod === "oauth-personal") result.SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";
  if (browser) {
    const runtime = process.platform === "win32" ? env.ORBIS_AGY_NODE_RUNTIME || process.execPath : process.execPath;
    result.BROWSER = agyBrowserCommand(runtime);
  }
  if (auth.authMethod === "gemini-api-key") result.GEMINI_API_KEY = auth.apiKey;
  if (auth.authMethod === "agent-platform") {
    if (auth.apiKey) result.GOOGLE_API_KEY = auth.apiKey;
    else {
      // ADC is an explicit choice; permit the official auth library to find the default
      // user credentials, without honoring an ambient GOOGLE_APPLICATION_CREDENTIALS override.
      const userHome = env.HOME || env.USERPROFILE || homedir();
      result.HOME = userHome;
      result.USERPROFILE = userHome;
      if (process.platform === "win32") result.APPDATA = env.APPDATA || join(userHome, "AppData", "Roaming");
    }
  }
  return result;
}

export async function lockAgyProfile(profile: AgyProfile, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await Promise.all([profile.home, profile.temp].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const owner = await open(profile.lock, "wx", 0o600).catch(() => { throw new Error("Antigravity CLI 专用目录已被占用"); });
  let release: Promise<void> | undefined;
  const close = () => release ??= owner.close().then(() => unlink(profile.lock));
  try { await owner.writeFile(`${process.pid}\n`); signal?.throwIfAborted(); }
  catch (error) { await close(); throw error; }
  return { close, preserve: () => owner.close() };
}

export async function writeAgySettings(profile: AgyProfile, auth: AgyAuthConfig): Promise<void> {
  if (auth.authMethod === "gemini-api-key") return; // No migration or rewrite of the existing native profile.
  const directory = join(profile.geminiDir, profile.appDataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const gcp = { ...(auth.gcpProject ? { project: auth.gcpProject } : {}), ...(auth.gcpLocation ? { location: auth.gcpLocation } : {}) };
  await writeFile(join(directory, "settings.json"), `${JSON.stringify({ auth: { type: auth.authMethod },
    ...(Object.keys(gcp).length ? { gcp } : {}) })}\n`, { mode: 0o600 });
}

/** Headless service; only the explicit local setup flow may start browser authentication. */
export async function openAgyProfile(stateDir: string, signal: AbortSignal, options: AgyProcessOptions & {
  key?: unknown; auth?: AgyAuthConfig;
}): Promise<AcpConnection> {
  signal.throwIfAborted();
  const auth = parseAgyAuthConfig(options.auth ?? options.key);
  if (!auth) throw new Error(agyKeyFailure("invalid"));
  const issue = agyAuthIssue(auth);
  if (issue) throw new Error(issue);
  const env = options.env ?? process.env;
  const cli = options.cli ?? await resolveAgy(env);
  if (auth.authMethod === "gemini-api-key") {
    const verification = await (options.verify ?? verifyAgyKey)(auth.apiKey, signal);
    signal.throwIfAborted();
    if (verification !== "verified") throw new Error(agyKeyFailure(verification));
  }
  const profile = agyProfile(stateDir, auth.authMethod);
  const owner = await lockAgyProfile(profile, signal);
  let client: AcpClient | undefined;
  try {
    await writeAgySettings(profile, auth);
    client = await connectAgy({ cli, env: agyEnvironment(env, profile, auth), cwd: profile.directory,
      geminiDir: profile.geminiDir, appDataDir: profile.appDataDir, authMethod: auth.authMethod, signal });
    const stop = client.stop.bind(client);
    let cleanup: Promise<void> | undefined;
    client.stop = () => cleanup ??= stop().then(owner.close, async error => { await owner.preserve(); throw error; });
    const abort = () => { void client?.stop().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      // The official CLI determines whether its saved Google sign-in still works.
      // No browser from background work, and never extract its credentials.
      if (!agyUsesGoogle(auth.authMethod)) await client.request("authenticate", { methodId: auth.authMethod }, 20_000);
      signal.throwIfAborted();
      if (!client.connected) throw new Error("ACP 已断开");
      return client;
    } finally { signal.removeEventListener("abort", abort); }
  } catch (error) {
    if (client) await client.stop();
    else if (error instanceof AcpCleanupError) await owner.preserve();
    else await owner.close();
    if (error instanceof AcpResponseError) throw new AgyCredentialRejectedError();
    if (error instanceof Error && "code" in error) throw new Error("Antigravity CLI 专用目录或进程不可用");
    throw error;
  }
}

/** Verify a candidate without touching the active profile. Google sign-in is verified in its own native profile. */
export async function verifyAgyConnection(value: unknown, options: AgyProcessOptions & { stateDir?: string } = {}): Promise<AgyKeyCheck> {
  const auth = parseAgyAuthConfig(value);
  if (!auth || agyAuthIssue(auth)) return "invalid";
  const google = agyUsesGoogle(auth.authMethod);
  if (google && !options.stateDir) return "invalid";
  if (auth.authMethod === "gemini-api-key") {
    const verification = await (options.verify ?? verifyAgyKey)(auth.apiKey, options.signal);
    options.signal?.throwIfAborted();
    if (verification !== "verified") return verification;
  }
  const temp = google ? undefined : await mkdtemp(join(tmpdir(), "orbis-agy-auth-check-"));
  const directory = temp ?? options.stateDir!;
  const signal = options.signal ?? new AbortController().signal;
  let client: AcpConnection | undefined;
  let result: AgyKeyCheck = "unavailable";
  try {
    client = await openAgyProfile(directory, signal, { ...options, auth, verify: async () => "verified" });
    const abort = () => { void client?.stop().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const sessions = record(await client.request("session/list", {}, 5_000));
      result = Array.isArray(sessions.sessions) ? "verified" : "unavailable";
    } finally { signal.removeEventListener("abort", abort); }
  } catch (error) {
    result = error instanceof AgyCredentialRejectedError || error instanceof AcpResponseError && error.code === -32000 ? "rejected" : "unavailable";
  } finally {
    try {
      await client?.stop();
      if (temp && !await stat(agyProfile(temp, auth.authMethod).lock).then(() => true, () => false)) await rm(temp, { recursive: true, force: true });
    } catch { result = "unavailable"; }
  }
  signal.throwIfAborted();
  return result;
}
