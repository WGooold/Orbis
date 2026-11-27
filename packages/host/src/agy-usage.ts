import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SubscriptionQuota, SubscriptionQuotaPool, SubscriptionQuotaWindow } from "@orbis/protocol";
import { agyProfile } from "./agy-auth.js";
import type { AgyAuthConfig } from "./agy-auth.js";
import { ProviderError } from "./provider-error.js";
import { proxyFetch, responseJson } from "./provider-network.js";

const GOOGLE_DAILY = "https://daily-cloudcode-pa.googleapis.com";
const GOOGLE_PROD = "https://cloudcode-pa.googleapis.com";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_BUCKETS = 32;
type AgyUsageFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const requireExternal = createRequire(import.meta.url);

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const boundedText = (value: unknown, max: number): string => text(value).replace(/\p{Cc}/gu, "").slice(0, max);
const missing = (error: unknown): boolean => object(error).code === "ENOENT";

/** go-keyring prefixes UTF-8 when the platform's credential store cannot retain it directly. */
export function decodeAgyKeyringSecret(secret: ArrayLike<number>): string {
  const value = new TextDecoder().decode(Uint8Array.from(secret));
  if (value.startsWith("go-keyring-base64:")) return Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8");
  if (value.startsWith("go-keyring-encoded:")) return Buffer.from(value.slice("go-keyring-encoded:".length), "hex").toString("utf8");
  return value;
}

/** Reads the CLI's existing Windows Credential Manager entry without creating or replacing it. */
export function readWindowsAgyKeyringSecret(architecture = process.arch): Uint8Array | undefined {
  if (architecture !== "x64" && architecture !== "arm64") throw new Error("Unsupported Windows credential architecture");
  const ffi = requireExternal("ffi-rs") as {
    DataType: { Void: unknown; U8Array: unknown; BigInt: unknown; WString: unknown; U32: unknown; I32: unknown };
    open(options: { library: string; path: string }): unknown;
    load(options: { library: string; funcName: string; retType: unknown; paramsType: unknown[]; paramsValue: unknown[]; errno?: boolean }): { value: number; errnoCode?: number };
  };
  ffi.open({ library: "orbis-advapi32", path: "advapi32.dll" });
  ffi.open({ library: "orbis-kernel32", path: "kernel32.dll" });
  const copy = (into: Buffer, from: bigint): void => {
    ffi.load({ library: "orbis-kernel32", funcName: "RtlMoveMemory", retType: ffi.DataType.Void,
      paramsType: [ffi.DataType.U8Array, ffi.DataType.BigInt, ffi.DataType.BigInt], paramsValue: [into, from, BigInt(into.length)] });
  };
  const out = Buffer.alloc(8);
  const read = ffi.load({ library: "orbis-advapi32", funcName: "CredReadW", retType: ffi.DataType.I32,
    paramsType: [ffi.DataType.WString, ffi.DataType.U32, ffi.DataType.U32, ffi.DataType.U8Array],
    paramsValue: ["gemini:antigravity", 1, 0, out], errno: true });
  if (read.value === 0) {
    if (read.errnoCode === 1168) return undefined;
    throw new Error("Windows credential read failed");
  }
  const credential = out.readBigUInt64LE();
  try {
    const header = Buffer.alloc(48);
    copy(header, credential);
    const size = header.readUInt32LE(32);
    if (size === 0) return undefined;
      if (size > 1_048_576) throw new Error("Windows credential exceeds the read limit");
    const blob = Buffer.alloc(size);
    copy(blob, header.readBigUInt64LE(40));
    return blob;
  } finally {
    ffi.load({ library: "orbis-advapi32", funcName: "CredFree", retType: ffi.DataType.Void,
      paramsType: [ffi.DataType.BigInt], paramsValue: [credential] });
  }
}

async function readAgyKeyringSecret(): Promise<string | undefined> {
  try {
    if (process.platform === "win32") {
      const secret = readWindowsAgyKeyringSecret();
      return secret ? decodeAgyKeyringSecret(secret) : undefined;
    }
    const keyring = requireExternal("@napi-rs/keyring") as { AsyncEntry: new (service: string, account: string) => { getSecret(): Promise<Uint8Array | number[] | undefined> } };
    const secret = await new keyring.AsyncEntry("gemini", "antigravity").getSecret();
    return secret ? decodeAgyKeyringSecret(secret) : undefined;
  } catch {
    // A missing/locked keyring is an unavailable credential source, not an auth token to log.
    return undefined;
  }
}

async function readAccessToken(stateDir: string, auth: AgyAuthConfig, now = Date.now()): Promise<string> {
  const profile = agyProfile(stateDir, auth.authMethod);
  const tokenPath = join(profile.geminiDir, profile.appDataDir, "antigravity-oauth-token");
  let source: string | undefined;
  try { source = await readFile(tokenPath, "utf8"); }
  catch (error) {
    if (!missing(error)) throw new ProviderError("无法读取 Antigravity CLI 登录状态，请稍后重试");
  }
  // The personal CLI code flow is forced to its private profile file. Enterprise ACP may use the
  // native keyring, which is read in place and never copied into Orbis storage.
  if (!source && auth.authMethod === "oauth-business") source = await readAgyKeyringSecret();
  if (!source) throw new ProviderError("未找到 Google 账号登录，请先在 Host 登录 Antigravity");
  let token: JsonObject;
  try { token = object(JSON.parse(source)); }
  catch { throw new ProviderError("Antigravity CLI 登录状态无法识别，请重新登录"); }
  const credentials = object(token.token);
  const accessToken = text(credentials.access_token);
  const expiry = typeof credentials.expiry === "string" ? Date.parse(credentials.expiry) : NaN;
  if (!accessToken || !Number.isFinite(expiry) || expiry <= now + 60_000) {
    throw new ProviderError("Antigravity 登录已过期，请在 Host 重新登录后重试");
  }
  // Avoid retaining the CLI's serialized refresh credential beyond parsing the access token.
  source = undefined;
  token = {};
  return accessToken;
}

function bucketWindow(bucket: JsonObject): SubscriptionQuotaWindow | undefined {
  const name = bucket.window === "5h" ? "five_hour" : bucket.window === "weekly" ? "seven_day" : undefined;
  const remainingFraction = bucket.remainingFraction;
  if (!name || typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return undefined;
  const fraction = Math.max(0, Math.min(1, remainingFraction));
  const parsedReset = typeof bucket.resetTime === "string" ? Date.parse(bucket.resetTime) : NaN;
  const resetsAt = Number.isSafeInteger(parsedReset) && parsedReset >= 0 ? parsedReset : null;
  return { name, remainingPercent: Math.round(fraction * 10_000) / 100, resetsAt };
}

function familyLabel(bucketId: string, groupName: string): string {
  if (bucketId.startsWith("gemini-argon-")) return groupName || "Gemini Argon";
  if (bucketId.startsWith("gemini-carbon-")) return groupName || "Gemini Carbon";
  if (bucketId.startsWith("gemini-")) return "Gemini";
  if (bucketId.startsWith("3p-")) return "Claude & GPT (shared)";
  return groupName || bucketId;
}

function poolsFromSummary(value: unknown): SubscriptionQuotaPool[] {
  const summary = object(value);
  const groups = Array.isArray(summary.groups) ? summary.groups.map(object) : [];
  const useGroups = groups.some(group => Array.isArray(group.buckets) && group.buckets.length > 0)
    ? groups : [{ buckets: summary.buckets }];
  const pools = new Map<string, { id: string; label: string; values: Partial<Record<"five_hour" | "seven_day", SubscriptionQuotaWindow>> }>();
  for (const group of useGroups) {
    const groupName = boundedText(group.displayName, 128);
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const value of buckets) {
      const bucket = object(value);
      if (bucket.disabled === true) continue;
      const id = boundedText(bucket.bucketId, 256);
      const window = bucketWindow(bucket);
      if (!id || !window) continue;
      const previous = pools.get(id);
      if (previous) {
        // Keep the stricter duplicate reading if both Cloud Code hosts return the same bucket.
        const old = previous.values[window.name];
        if (!old || (window.remainingPercent ?? 100) < (old.remainingPercent ?? 100)) previous.values[window.name] = window;
        continue;
      }
      if (pools.size >= MAX_BUCKETS) continue;
      pools.set(id, { id, label: familyLabel(id, groupName), values: { [window.name]: window } });
    }
  }
  return [...pools.values()].map(pool => ({ id: pool.id, label: pool.label,
    windows: (["five_hour", "seven_day"] as const).map(name => pool.values[name] ?? { name, remainingPercent: null, resetsAt: null }) }));
}

function aggregateWindows(pools: SubscriptionQuotaPool[]): SubscriptionQuotaWindow[] {
  return (["five_hour", "seven_day"] as const).map(name => {
    const values = pools.flatMap(pool => pool.windows).filter(window => window.name === name && window.remainingPercent !== null);
    const strictest = values.reduce<SubscriptionQuotaWindow | undefined>((best, candidate) =>
      !best || candidate.remainingPercent! < best.remainingPercent! ? candidate : best, undefined);
    return { name, remainingPercent: strictest?.remainingPercent ?? null, resetsAt: strictest?.resetsAt ?? null };
  });
}

/** Reads quota from Google's Cloud Code endpoint using the CLI-owned OAuth token; tokens never leave this function. */
export async function queryAgySubscriptionQuota(stateDir: string, auth: AgyAuthConfig,
  fetcher: AgyUsageFetch = proxyFetch, now = Date.now()): Promise<SubscriptionQuota> {
  if (auth.authMethod !== "oauth-personal" && auth.authMethod !== "oauth-business") {
    throw new ProviderError("API Key 和 Agent Platform 不提供 Google 账号订阅配额");
  }
  const accessToken = await readAccessToken(stateDir, auth, now);
  const primary = auth.authMethod === "oauth-personal" ? GOOGLE_DAILY : GOOGLE_PROD;
  const endpoints = [primary, primary === GOOGLE_DAILY ? GOOGLE_PROD : GOOGLE_DAILY];
  let rejected = false;
  let rateLimited = false;
  const results = await Promise.all(endpoints.map(async endpoint => {
    let response: Response | undefined;
    try {
      response = await fetcher(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json",
          "Content-Type": "application/json", "User-Agent": `antigravity/hub/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)` },
        body: JSON.stringify(auth.authMethod === "oauth-business" && auth.gcpProject ? { project: auth.gcpProject } : {}),
      });
      if (response.status === 401 || response.status === 403) { rejected = true; await response.body?.cancel(); return []; }
      if (response.status === 429) { rateLimited = true; await response.body?.cancel(); return []; }
      if (!response.ok) { await response.body?.cancel(); return []; }
      return poolsFromSummary(await responseJson(response, MAX_RESPONSE_BYTES));
    } catch {
      await response?.body?.cancel().catch(() => {});
      return [];
    }
  }));
  const byId = new Map<string, SubscriptionQuotaPool>();
  // The selected tier wins duplicate windows; the alternate host fills unreported windows.
  for (const pool of results.flat()) {
    const previous = byId.get(pool.id);
    if (!previous) { byId.set(pool.id, pool); continue; }
    byId.set(pool.id, { ...previous, windows: previous.windows.map(window => {
      const alternate = pool.windows.find(item => item.name === window.name);
      return window.remainingPercent === null && alternate && alternate.remainingPercent !== null ? alternate : window;
    }) });
  }
  const pools = [...byId.values()].slice(0, MAX_BUCKETS);
  if (!pools.some(pool => pool.windows.some(window => window.remainingPercent !== null))) {
    if (rejected) throw new ProviderError("Google 登录已失效或没有读取配额的权限，请在 Host 重新登录后重试");
    if (rateLimited) throw new ProviderError("Google 配额查询过于频繁，请稍后重试");
    throw new ProviderError("Google 没有返回可用的 Antigravity 配额，请稍后重试");
  }
  return { checkedAt: now, windows: aggregateWindows(pools), pools };
}
