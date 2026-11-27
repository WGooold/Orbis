import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { AcpCleanupError, record } from "./acp-client.js";
import { agentInvocation, stopAgentProcess } from "./agent-command.js";
import { agyProfile, agyUsesGoogle, type AgyAuthConfig } from "./agy-auth.js";
import { agyEnvironment, agyLoginArgs, connectAgy, lockAgyProfile, resolveAgy, writeAgySettings, type AgyProcessOptions } from "./agy-client.js";

const MAX_LINE = 16_384;
const GOOGLE_REDIRECT = "https://antigravity.google/oauth-callback";
const USER_DEADLINE = 5 * 60_000;

function googleAuthorizationUrl(raw: string, kind: "code" | "browser"): URL | undefined {
  if (raw.length > MAX_LINE || /\s/u.test(raw)) return undefined;
  const url = URL.parse(raw);
  if (!url || url.origin !== "https://accounts.google.com" || url.username || url.password || url.hash) return undefined;
  const expectedPath = kind === "code" ? "/o/oauth2/auth" : "/o/oauth2/v2/auth";
  if (url.pathname !== expectedPath) return undefined;
  const one = (key: string) => url.searchParams.getAll(key).length === 1 ? url.searchParams.get(key) : null;
  const state = one("state");
  const redirect = one("redirect_uri");
  const redirectValid = kind === "code" ? redirect === GOOGLE_REDIRECT : (() => {
    if (!redirect) return false;
    const callback = URL.parse(redirect);
    return callback?.protocol === "http:" && callback.hostname === "127.0.0.1" &&
      Number(callback.port) >= 1024 && Number(callback.port) <= 65535 && callback.pathname === "/" &&
      !callback.search && !callback.hash && !callback.username && !callback.password;
  })();
  return redirectValid && one("response_type") === "code" && state && state.length <= 512 && !/\s/u.test(state) ? url : undefined;
}

export function parseAgyAuthorizationUrl(raw: string, kind: "code" | "browser"): string | undefined {
  return googleAuthorizationUrl(raw, kind)?.href;
}

export interface AgyCodeLogin {
  authorizationUrl: string;
  complete(code: unknown): Promise<void>;
  cancel(): Promise<void>;
}

/** The CLI opens no browser in remote mode. The private Host UI opens the validated link and passes the user's code to stdin. */
export async function startAgyPersonalLogin(stateDir: string, auth: AgyAuthConfig, options: AgyProcessOptions): Promise<AgyCodeLogin> {
  const env = options.env ?? process.env;
  const cli = options.cli ?? await resolveAgy(env);
  const profile = agyProfile(stateDir, "oauth-personal");
  const owner = await lockAgyProfile(profile, options.signal);
  let child;
  try {
    await writeAgySettings(profile, auth);
    options.signal?.throwIfAborted();
    const childEnv = agyEnvironment(env, profile, auth);
    const invocation = agentInvocation(cli, agyLoginArgs(profile.geminiDir, profile.appDataDir), childEnv);
    child = spawn(invocation.command, invocation.args, { cwd: profile.directory, env: childEnv, shell: false, windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
  } catch { await owner.close(); throw new Error("无法启动 Antigravity 登录"); }

  let finished = false;
  const exit = new Promise<number | null>(resolve => child.once("close", code => { finished = true; resolve(code); }));
  const cleaned = exit.then(owner.close);
  // Failures are observed by complete/cancel; early exits must not create an unhandled rejection.
  void cleaned.catch(() => {});
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    if (!finished) await stopAgentProcess(child);
    if (!await Promise.race([exit.then(() => true), delay(3_000, false, { ref: false })])) {
      throw new AcpCleanupError("Antigravity 登录进程未退出；保留专用目录锁");
    }
    await cleaned;
  })();
  const abort = () => { void stop().catch(() => {}); };
  const lifetime = setTimeout(abort, USER_DEADLINE);
  lifetime.unref();
  options.signal?.addEventListener("abort", abort, { once: true });
  void exit.then(() => { clearTimeout(lifetime); options.signal?.removeEventListener("abort", abort); });
  child.stdin.on("error", abort);
  child.stdout.on("error", abort);
  child.on("error", abort);
  if (options.signal?.aborted) abort();
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let bytes = 0;
  let url: URL;
  let disposeOutput: () => void = () => {};
  try {
    url = await new Promise<URL>((resolveUrl, rejectUrl) => {
      const timer = setTimeout(() => rejectUrl(new Error("Antigravity 登录链接生成超时")), 30_000);
      const onChunk = (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 64 * 1024) { rejectUrl(new Error("Antigravity 登录输出超过限制")); return; }
        buffered += decoder.write(chunk);
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const link = googleAuthorizationUrl(buffered.slice(0, end).trim(), "code");
          buffered = buffered.slice(end + 1);
          if (link) { resolveUrl(link); return; }
        }
      };
      disposeOutput = () => { clearTimeout(timer); child.stdout.off("data", onChunk); child.stdout.resume(); };
      child.stdout.on("data", onChunk);
      void exit.then(() => rejectUrl(new Error("Antigravity 登录在输出链接前结束")));
    });
    options.signal?.throwIfAborted();
  } catch (error) { await stop(); throw error; }
  finally { disposeOutput(); }
  let used = false;
  return {
    authorizationUrl: url.href,
    async complete(value) {
      if (used || finished || stopping) throw new Error("Antigravity 登录流程已结束，请重新开始");
      used = true;
      try {
        if (typeof value !== "string" || value.length > 2048 || /[\r\n\0]/u.test(value) || !/^[\w./~-]{1,2048}$/u.test(value.trim())) {
          throw new Error("Google 登录代码格式无效");
        }
        child.stdin.end(`${value.trim()}\n`);
        const code = await Promise.race([exit, delay(45_000, null, { ref: false })]);
        if (code !== 0) throw new Error("Antigravity CLI 未确认 Google 登录");
        await cleaned;
        options.signal?.throwIfAborted();
      } finally { await stop(); }
    },
    cancel: stop,
  };
}

async function withNativeAgyProfile<T>(stateDir: string, auth: AgyAuthConfig, options: AgyProcessOptions, browser: boolean,
  run: (client: Awaited<ReturnType<typeof connectAgy>>) => Promise<T>): Promise<T> {
  const env = options.env ?? process.env;
  const cli = options.cli ?? await resolveAgy(env);
  const profile = agyProfile(stateDir, auth.authMethod);
  const owner = await lockAgyProfile(profile, options.signal);
  let client: Awaited<ReturnType<typeof connectAgy>> | undefined;
  let listenerInstalled = false;
  let safeToRelease = true;
  const abort = () => { void client?.stop().catch(() => {}); };
  let result: T;
  try {
    await writeAgySettings(profile, auth);
    client = await connectAgy({ ...options, cli, env: agyEnvironment(env, profile, auth, browser), cwd: profile.directory,
      geminiDir: profile.geminiDir, appDataDir: profile.appDataDir, authMethod: auth.authMethod });
    options.signal?.addEventListener("abort", abort, { once: true });
    listenerInstalled = true;
    options.signal?.throwIfAborted();
    result = await run(client);
  } catch (error) {
    if (error instanceof AcpCleanupError) safeToRelease = false;
    if (listenerInstalled) options.signal?.removeEventListener("abort", abort);
    let failure: unknown = error;
    try { await client?.stop(); }
    catch (cleanupError) { safeToRelease = false; failure = cleanupError; }
    try { await (safeToRelease ? owner.close() : owner.preserve()); }
    catch (cleanupError) { failure = cleanupError; }
    throw failure;
  }
  if (listenerInstalled) options.signal?.removeEventListener("abort", abort);
  try { await client?.stop(); }
  catch (error) {
    await owner.preserve();
    throw error;
  }
  await owner.close();
  return result;
}

/** Gemini Enterprise uses the official ACP browser flow; do not feed personal login codes to it. */
export async function signInAgyEnterprise(stateDir: string, auth: AgyAuthConfig, options: AgyProcessOptions): Promise<void> {
  let observedUrl: string | undefined;
  const onAuthorizationUrl = (raw: string) => {
    const url = parseAgyAuthorizationUrl(raw, "browser");
    if (!url) throw new Error("Antigravity 返回了无效的 Google 登录链接");
    if (observedUrl && observedUrl !== url) throw new Error("Antigravity 启动了多个 Google 登录流程");
    observedUrl = url;
    options.onAuthorizationUrl?.(url);
  };
  await withNativeAgyProfile(stateDir, auth, { ...options, onAuthorizationUrl }, true, async client => {
    await client.request("authenticate", { methodId: "oauth-business" }, USER_DEADLINE);
    if (!Array.isArray(record(await client.request("session/list", {}, 5_000)).sessions)) throw new Error("Antigravity 未确认会话目录");
    options.signal?.throwIfAborted();
  });
}

export async function signOutAgyGoogle(stateDir: string, auth: AgyAuthConfig, options: AgyProcessOptions): Promise<void> {
  if (!agyUsesGoogle(auth.authMethod)) throw new Error("当前不是 Google 登录方式");
  await withNativeAgyProfile(stateDir, auth, options, false, async client => {
    if (!client.supportsLogout) throw new Error("Antigravity CLI 未提供退出登录能力");
    await client.request("logout", {}, 15_000);
    options.signal?.throwIfAborted();
  });
}
