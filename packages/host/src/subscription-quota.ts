// Endpoint/auth conventions adapted from CC Switch 4ed07150 (MIT), services/subscription.rs.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SubscriptionQuota } from "@orbis/protocol";
import { ProviderError } from "./provider-error.js";
import { proxyFetch, responseJson } from "./provider-network.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const execute = promisify(execFile);
const hash = (value: string, length: number): string => createHash("sha256").update(value).digest("hex").slice(0, length);
const hasCodexOAuth = (value: unknown): boolean => {
  const auth = object(value);
  return auth.auth_mode !== "apikey" && !!text(object(auth.tokens).access_token);
};
const isCodexApiKey = (value: unknown): boolean => {
  const auth = object(value);
  return auth.auth_mode === "apikey" || (auth.auth_mode !== "chatgpt" && !!text(auth.OPENAI_API_KEY));
};
const hasClaudeOAuth = (value: unknown): boolean => {
  const auth = object(value);
  const oauth = object(auth.claudeAiOauth ?? auth["claude.ai_oauth"]);
  return !!text(oauth.accessToken);
};
async function credentialFile(path: string): Promise<Obj> {
  try { return object(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (object(error).code === "ENOENT") return {};
    throw new ProviderError("无法读取本机登录凭据，请在 CLI 中重新登录");
  }
}
// A QA build is re-signed for every candidate, so macOS asks for keychain access
// each launch. ORBIS_NO_KEYCHAIN=1 keeps isolated runs on the credential files.
const keychainDisabled = (): boolean => {
  const value = (process.env.ORBIS_NO_KEYCHAIN ?? "").toLowerCase();
  return value === "1" || value === "true";
};
type KeychainResult = { value?: Obj; accessError?: boolean };
async function keychain(service: string, account?: string): Promise<KeychainResult> {
  if (keychainDisabled()) return {};
  try {
    const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
    const { stdout } = await execute("/usr/bin/security", args, { timeout: 8_000, maxBuffer: 256_000 });
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    try { return { value: object(JSON.parse(trimmed)) }; }
    catch { return {}; }
  } catch (error) {
    if (object(error).code === 44) return {};
    // execFile errors can contain the secret on stdout; never propagate them.
    return { accessError: true };
  }
}
export async function claudeSubscriptionCredentials(configDir: string, customDir = false): Promise<Obj> {
  let accessError = false;
  if (process.platform === "darwin") {
    const service = "Claude Code-credentials" + (customDir || configDir !== join(homedir(), ".claude") ? `-${hash(configDir.normalize("NFC"), 8)}` : "");
    const username = process.env.USER || userInfo().username;
    const account = /^[A-Za-z0-9._-]+$/.test(username) ? username : "claude-code-user";
    const primary = await keychain(service, account);
    if (primary.value && hasClaudeOAuth(primary.value)) return primary.value;
    if (primary.accessError) accessError = true;
    else {
      const legacy = await keychain(service);
      if (legacy.value && hasClaudeOAuth(legacy.value)) return legacy.value;
      if (legacy.accessError) accessError = true;
    }
  }
  const file = await credentialFile(join(configDir, ".credentials.json"));
  if (!hasClaudeOAuth(file) && accessError) {
    throw new ProviderError("无法读取系统钥匙串中的 CLI 登录，请在电脑端检查访问权限");
  }
  return file;
}
export async function codexSubscriptionCredentials(configDir: string, storage: unknown, native: unknown, preferNative = false): Promise<Obj> {
  if (preferNative && (hasCodexOAuth(native) || isCodexApiKey(native))) return object(native);
  if (storage === "file" && (hasCodexOAuth(native) || isCodexApiKey(native))) return object(native);
  if (process.platform === "darwin") {
    const canonical = await realpath(configDir).catch(() => configDir);
    const kc = await keychain("Codex Auth", `cli|${hash(canonical, 16)}`);
    if (kc.value && (hasCodexOAuth(kc.value) || (!hasCodexOAuth(native) && !isCodexApiKey(native)))) return kc.value;
    if (hasCodexOAuth(native)) return object(native);
    if (storage === "keyring") {
      throw new ProviderError(kc.accessError
        ? "无法读取系统钥匙串中的 CLI 登录，请在电脑端检查访问权限"
        : "当前登录保存在系统凭据库，无法读取订阅；请使用 CLI 的文件登录存储后重试");
    }
    if (kc.accessError && !isCodexApiKey(native)) {
      throw new ProviderError("无法读取系统钥匙串中的 CLI 登录，请在电脑端检查访问权限");
    }
  } else if (storage === "keyring" && !hasCodexOAuth(native)) {
    throw new ProviderError("当前登录保存在系统凭据库，无法读取订阅；请使用 CLI 的文件登录存储后重试");
  }
  return object(native);
}

export function parseSubscriptionQuota(kind: "claude" | "codex", body: unknown, checkedAt = Date.now()): SubscriptionQuota {
  const root = object(body);
  const hasCodexBody = Object.hasOwn(root, "rate_limit") || Object.hasOwn(root, "credits") || Object.hasOwn(root, "plan_type");
  if (kind === "claude" ? !Object.hasOwn(root, "five_hour") && !Object.hasOwn(root, "seven_day") : !hasCodexBody) {
    throw new ProviderError("订阅接口返回了无法识别的配额数据");
  }
  const limits = object(root.rate_limit);
  const windows = [object(limits.primary_window), object(limits.secondary_window)];
  return { checkedAt, windows: (["five_hour", "seven_day"] as const).map(name => {
    const value = kind === "claude" ? object(root[name]) : windows.find(window => window.limit_window_seconds === (name === "five_hour" ? 18_000 : 604_800)) ?? {};
    const used = kind === "claude" ? value.utilization : value.used_percent;
    const remainingPercent = typeof used === "number" && Number.isFinite(used) && used >= 0 ? Math.max(0, 100 - Math.min(used, 100)) : null;
    const reset = kind === "claude"
      ? (typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN)
      : (typeof value.reset_at === "number" && Number.isFinite(value.reset_at) ? Math.round(value.reset_at * 1000) : NaN);
    return { name, remainingPercent, resetsAt: remainingPercent !== null && Number.isSafeInteger(reset) && reset >= 0 && !(kind === "codex" && used === 0) ? reset : null };
  }) };
}

export async function querySubscriptionQuota(kind: "claude" | "codex", credentials: unknown): Promise<SubscriptionQuota> {
  const auth = object(credentials);
  const oauth = object(kind === "claude" ? auth.claudeAiOauth ?? auth["claude.ai_oauth"] : auth.tokens);
  const token = text(kind === "claude" ? oauth.accessToken : oauth.access_token);
  const apiKeyOnly = kind === "codex" && (auth.auth_mode === "apikey" || (auth.auth_mode !== "chatgpt" && !!text(auth.OPENAI_API_KEY)));
  if (!token || apiKeyOnly) {
    throw new ProviderError(`未找到订阅登录，请先在 ${kind === "claude" ? "Claude Code" : "Codex"} 中登录官方订阅账号（API Key 不提供订阅配额）`);
  }
  if (kind === "claude" && typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) throw new ProviderError("Claude Code 登录已过期，请在 CLI 中重新登录或刷新登录后重试");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (kind === "claude") headers["anthropic-beta"] = "oauth-2025-04-20";
  else {
    headers["User-Agent"] = "codex-cli";
    if (text(oauth.account_id)) headers["ChatGPT-Account-Id"] = text(oauth.account_id);
  }
  let response: Response;
  try {
    response = await proxyFetch(kind === "claude" ? "https://api.anthropic.com/api/oauth/usage" : "https://chatgpt.com/backend-api/wham/usage",
      { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch { throw new ProviderError("订阅配额查询失败或超时，请检查网络后重试"); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new ProviderError("订阅登录已失效或没有查询权限，请在 CLI 中重新登录后重试");
    if (response.status === 429) throw new ProviderError("订阅查询过于频繁，请稍后重试");
    throw new ProviderError(`订阅配额查询失败（HTTP ${response.status}）`);
  }
  let body: unknown;
  try { body = await responseJson(response, 256_000); }
  catch { throw new ProviderError("订阅接口响应无效或读取超时，请稍后重试"); }
  return parseSubscriptionQuota(kind, body);
}
