/**
 * Read-only discovery and authenticated transport for a local Kimi Code server.
 * The instance directory is deliberately read without Kimi's listLive helper: upstream
 * maintenance deletes stale registry files, which an Orbis connection must never do.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import WebSocket from "ws";
import { meetsMinimumAgentVersion } from "./agent-installation.js";
import { kimiDesktopOwner, supportsKimiDesktop } from "./kimi-desktop-owner.js";

export const KIMI_API_CONTRACT_SHA256 = Object.freeze({
  openapi: "8e7626237241e0fe9ba980903f68f579e94d096553780b827fecb9c46cce7036",
  asyncapi: "838d85a099e5cb2dc88d42fd5a4e86fd3cd6a6afb3f0c1e6cb757c2c7a7c730d",
});

export type KimiSource = "web" | "desktop";
export type KimiSessionContract = "legacy" | "desktop-2.8.1";
export const KIMI_WEB_MIN_VERSION = "2.6.3";
const desktopProfiles = {
  darwin: {
    minimumVersion: "2.6.2",
    session: "legacy",
    hashes: {
      openapi: "9920b34adcf9458d7dcf00d42c8d4ce794f27f4a6a8f21b570e9e6b100ea985f",
      asyncapi: "6f415309b2946045b0df41f0a529a6699821359fcf0237215ad69baab53ffd59",
    },
  },
  win32: {
    minimumVersion: "2.8.1",
    session: "desktop-2.8.1",
    hashes: {
      openapi: "409a2bf32e2b0443ea02e5818f71a7487be8821cc5c645c0caa4ee177cdff002",
      asyncapi: "1e46c8d6d3956baf682ac586dcbd42299e4cf9e7af3baa43b5df16fa0973000f",
    },
  },
} as const;
type DesktopPlatform = keyof typeof desktopProfiles;
const desktopPlatform = process.platform === "win32" ? "win32" : "darwin";
export const KIMI_DESKTOP_MIN_VERSION = desktopProfiles[desktopPlatform].minimumVersion;

const MAX_REGISTRATIONS = 64;
const MAX_REGISTRATION_BYTES = 8 * 1024;
const MAX_SCHEMA_BYTES = 512 * 1024;
const MAX_REST_BYTES = 2 * 1024 * 1024;
const INSTANCE_MAX_AGE_MS = 45_000;
const REQUEST_TIMEOUT_MS = 3_000;
const API_PREFIX = "/api/v1";

export type KimiInstance = {
  serverId: string;
  pid: number;
  host: string;
  port: number;
  startedAt: number;
  heartbeatAt: number;
  version: string;
};

export type KimiServerMeta = {
  server_version: string;
  server_id: string;
  started_at: string;
  backend?: string;
  dangerous_bypass_auth: boolean;
  capabilities: Record<string, unknown>;
  [key: string]: unknown;
};

type ContractHashes = { openapi: string; asyncapi: string };

export type KimiWebClientOptions = {
  source?: KimiSource;
  /** Test seams for a registered desktop owner and its platform contract. */
  desktopPlatform?: DesktopPlatform;
  verifyDesktopOwner?: (pid: number, host: string, port: number) => Promise<boolean>;
  /** KIMI_CODE_HOME, or the platform user's default ~/.kimi-code directory. */
  homeDir?: string;
  /** Optional exact HTTP origin, e.g. http://127.0.0.1:58627, to disambiguate. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Test seam; production checks the known API schema hashes for the selected source. */
  expectedContracts?: ContractHashes;
  requestTimeoutMs?: number;
};

export class KimiBusinessError extends Error {
  constructor(readonly code: number) { super(`Kimi Code 请求未完成（业务码 ${code}）`); }
}

export class KimiWebError extends Error {
  constructor(readonly reason: "not_running" | "not_installed" | "ambiguous" | "unauthorized" | "unsupported" | "unsafe" | "unavailable", message: string) {
    super(message);
    this.name = "KimiWebError";
  }
}

type RegistrationDisk = {
  server_id: string;
  pid: number;
  host: string;
  port: number;
  started_at: number;
  heartbeat_at: number;
  host_version?: string;
};

function isLoopbackLiteral(host: string): boolean {
  if (host === "::1" || host.toLowerCase() === "::1") return isIP(host) === 6;
  const octets = host.split(".");
  return isIP(host) === 4 && Number(octets[0]) === 127 && octets.every(part => /^(0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255);
}

function decodeRegistration(value: unknown, now: number): KimiInstance | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Partial<RegistrationDisk>;
  if (typeof item.server_id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/u.test(item.server_id)
    || !Number.isSafeInteger(item.pid) || item.pid! < 1 || item.pid! > 0x7fff_ffff
    || typeof item.host !== "string" || item.host.length === 0 || item.host.length > 128
    || !Number.isInteger(item.port) || item.port! < 1 || item.port! > 65535
    || !Number.isSafeInteger(item.started_at) || !Number.isSafeInteger(item.heartbeat_at)
    || typeof item.host_version !== "string" || item.host_version.length === 0 || item.host_version.length > 128
    || item.heartbeat_at! > now + 5_000 || now - item.heartbeat_at! > INSTANCE_MAX_AGE_MS) return undefined;
  return {
    serverId: item.server_id,
    pid: item.pid!,
    host: item.host,
    port: item.port!,
    startedAt: item.started_at!,
    heartbeatAt: item.heartbeat_at!,
    version: item.host_version,
  };
}

function registrationOwnerMayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function readRegistrations(homeDir: string, now: number): Promise<KimiInstance[]> {
  const directory = join(homeDir, "server", "instances");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new KimiWebError("unavailable", "无法读取 Kimi Code 服务登记目录");
  }
  const files = names.filter(name => /^[A-Za-z0-9_-]{8,80}\.json$/u.test(name)).sort();
  if (files.length > MAX_REGISTRATIONS) throw new KimiWebError("unsafe", "Kimi Code 服务登记数量超过安全上限");
  const results = await Promise.all(files.map(async name => {
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_REGISTRATION_BYTES) return undefined;
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      const candidate = decodeRegistration(parsed, now);
      // A dead owned launch can leave its registry entry until Kimi next tidies it. Never remove it here.
      return candidate && name === `${candidate.serverId}.json` && registrationOwnerMayBeAlive(candidate.pid) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }));
  return results.filter((entry): entry is KimiInstance => entry !== undefined);
}

/** Launch only on proven absence of a fresh registration other than the verified alternate source. */
export async function assertKimiMayStart(options: KimiWebClientOptions): Promise<void> {
  if (options.endpoint !== undefined) throw new KimiWebError("not_running", "指定的 Kimi Code 地址仅接入已有服务");
  const instances = await readRegistrations(options.homeDir ?? defaultKimiHome(), (options.now ?? Date.now)());
  for (const item of instances) {
    if (!isLoopbackLiteral(item.host)) throw new KimiWebError("unsafe", "Kimi Code 实例未使用本机回环地址");
    const verifyOwner = options.verifyDesktopOwner ?? kimiDesktopOwner;
    if (options.source !== "desktop" && await verifyOwner(item.pid, item.host, item.port)) continue;
    if (options.source === "desktop") {
      // A version may be used by both products. Confirm the other source before starting alongside it.
      const web = await KimiWebClient.connect({ ...options, source: "web", endpoint: instanceEndpoint(item).origin }).catch(() => undefined);
      if (web) { web.close(); continue; }
    }
    // A newly registered listener or an older standalone CLI is not evidence that it is safe to start another one.
    throw new KimiWebError("unavailable", "检测到 Kimi Code 实例，等待当前实例完成接入");
  }
}

async function readPrivateToken(homeDir: string): Promise<string> {
  const path = join(homeDir, "server.token");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new KimiWebError("unauthorized", "缺少 Kimi Code 本机 Web 凭据");
    throw new KimiWebError("unavailable", "无法读取 Kimi Code 本机 Web 凭据");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    || info.size < 16 || info.size > 512) throw new KimiWebError("unsafe", "Kimi Code 本机凭据权限或格式不安全");
  const token = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new KimiWebError("unauthorized", "Kimi Code 本机凭据格式无效");
  return token;
}

function parseEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new KimiWebError("unsafe", "Kimi Code 地址无效"); }
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "http:" || !isLoopbackLiteral(host) || url.username || url.password || url.search || url.hash
    || (url.pathname !== "" && url.pathname !== "/") || !url.port) {
    throw new KimiWebError("unsafe", "Kimi Code 只允许明确的 HTTP 字面回环地址");
  }
  return new URL(`http://${host.includes(":") ? `[${host}]` : host}:${url.port}`);
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new KimiWebError("unsupported", "Kimi Code 响应超过大小上限");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new KimiWebError("unsupported", "Kimi Code 响应超过大小上限");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function instanceEndpoint(item: KimiInstance): URL {
  return parseEndpoint(`http://${item.host.includes(":") ? `[${item.host}]` : item.host}:${item.port}`);
}

function validMeta(value: unknown, windowsDesktop: boolean): value is KimiServerMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<KimiServerMeta>;
  return typeof meta.server_id === "string" && /^[A-Za-z0-9_-]{8,80}$/u.test(meta.server_id)
    && typeof meta.server_version === "string" && meta.server_version.length > 0 && meta.server_version.length <= 128
    && typeof meta.started_at === "string" && Number.isFinite(Date.parse(meta.started_at))
    && (windowsDesktop
      ? meta.product === "kimi-code-desktop" && meta.kimi_agent_protocol_version === "1.0.0"
      : meta.backend === "v2" && meta.product !== "kimi-code-desktop")
    && meta.dangerous_bypass_auth === false
    && typeof meta.capabilities === "object" && meta.capabilities !== null && meta.capabilities.websocket === true;
}

/** One authenticated connection to a confirmed running Kimi Code Web instance. */
export class KimiWebClient {
  readonly endpoint: URL;
  readonly instance: KimiInstance;
  readonly meta: KimiServerMeta;
  readonly sessionContract: KimiSessionContract;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  #socket: WebSocket | undefined;
  readonly #lifetime = new AbortController();

  private constructor(options: { endpoint: URL; instance: KimiInstance; meta: KimiServerMeta; sessionContract: KimiSessionContract; token: string; fetch: typeof globalThis.fetch; timeoutMs: number }) {
    this.endpoint = options.endpoint;
    this.instance = options.instance;
    this.meta = options.meta;
    this.sessionContract = options.sessionContract;
    this.#token = options.token;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  static async connect(options: KimiWebClientOptions = {}): Promise<KimiWebClient> {
    const homeDir = options.homeDir ?? process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
    const now = (options.now ?? Date.now)();
    const desktop = options.source === "desktop";
    if (desktop && !supportsKimiDesktop && !options.verifyDesktopOwner) throw new KimiWebError("unsupported", "当前平台不支持 Kimi Code Desktop 接入");
    const requested = options.endpoint === undefined ? undefined : parseEndpoint(options.endpoint);
    const profile = desktopProfiles[(options.verifyDesktopOwner ? options.desktopPlatform : undefined) ?? desktopPlatform];
    const minimum = desktop ? profile.minimumVersion : KIMI_WEB_MIN_VERSION;
    const registered = await readRegistrations(homeDir, now);
    const candidates = requested ? registered.filter(item =>
      item.host === requested.hostname.replace(/^\[|\]$/gu, "") && item.port === Number(requested.port)) : registered;
    const verifyOwner = options.verifyDesktopOwner ?? kimiDesktopOwner;
    const selected: KimiInstance[] = [];
    let belowMinimum = false;
    for (const item of candidates) {
      if (!isLoopbackLiteral(item.host)) throw new KimiWebError("unsafe", "Kimi Code 实例未使用本机回环地址");
      if (await verifyOwner(item.pid, item.host, item.port) !== desktop) continue;
      if (meetsMinimumAgentVersion(item.version, minimum)) selected.push(item);
      else belowMinimum = true;
      if (selected.length > 1) throw new KimiWebError("ambiguous", "发现多个 Kimi Code 服务，请指定一个本机回环地址");
    }
    if (!selected.length) {
      if (belowMinimum) throw new KimiWebError("unsupported", `Kimi Code 服务版本不受支持，最低需要 ${minimum}`);
      if (desktop && requested && candidates.length) throw new KimiWebError("unsupported", "Kimi Code 服务不是已验证的桌面应用实例");
      throw new KimiWebError("not_running", desktop ? "未发现支持的 Kimi Code Desktop 内嵌服务" : "未发现正在运行的 Kimi Code Web 服务");
    }
    const instance = selected[0]!;
    const endpoint = instanceEndpoint(instance);
    const token = await readPrivateToken(homeDir);
    const fetcher = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const request = async (path: string, maxBytes = MAX_REST_BYTES): Promise<Uint8Array> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(new URL(path, endpoint), { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: controller.signal, redirect: "manual" });
        if (response.status >= 300 && response.status < 400) throw new KimiWebError("unsafe", "Kimi Code 不允许 HTTP 重定向");
        if (response.status === 401 || response.status === 403) throw new KimiWebError("unauthorized", "Kimi Code 本机 Web 凭据已失效");
        if (!response.ok) throw new KimiWebError("unavailable", `Kimi Code 本机服务响应异常（HTTP ${response.status}）`);
        return await boundedBody(response, maxBytes);
      } catch (error) {
        if (error instanceof KimiWebError) throw error;
        throw new KimiWebError("unavailable", error instanceof Error && error.name === "AbortError" ? "Kimi Code 本机服务响应超时" : "无法连接 Kimi Code 本机服务");
      } finally { clearTimeout(timer); }
    };

    let meta: unknown;
    try {
      const healthBytes = await request(`${API_PREFIX}/healthz`, 16 * 1024);
      const healthEnvelope = JSON.parse(new TextDecoder().decode(healthBytes)) as { code?: unknown; data?: { ok?: unknown } };
      if (healthEnvelope.code !== 0 || healthEnvelope.data?.ok !== true) throw new KimiWebError("unavailable", "Kimi Code 本机服务健康检查失败");
      const bytes = await request(`${API_PREFIX}/meta`, 64 * 1024);
      const envelope = JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown; data?: unknown };
      if (envelope.code !== 0) throw new KimiWebError("unavailable", "Kimi Code 元数据响应无效");
      meta = envelope.data;
    } catch (error) {
      if (error instanceof KimiWebError) throw error;
      throw new KimiWebError("unsupported", "Kimi Code 元数据格式无效");
    }
    if (!validMeta(meta, desktop && profile.session === "desktop-2.8.1")) throw new KimiWebError("unsupported", "Kimi Code 服务未满足受支持的认证 API 契约");
    // In Kimi Code 2.6.3 the registry ULID and /meta server_id have different identity
    // scopes. Bind the listener to the registration by the exact product version and
    // near-identical boot timestamps; keep both opaque IDs, but never equate them.
    if (meta.server_version !== instance.version || Math.abs(Date.parse(meta.started_at) - instance.startedAt) > 10_000) {
      throw new KimiWebError("unsafe", "Kimi Code 实例登记与认证服务启动身份不匹配");
    }

    const expected = options.expectedContracts ?? (desktop ? profile.hashes : KIMI_API_CONTRACT_SHA256);
    for (const [name, path] of [["openapi", "/openapi.json"], ["asyncapi", "/asyncapi.json"]] as const) {
      let bytes: Uint8Array;
      try { bytes = await request(path, MAX_SCHEMA_BYTES); }
      catch (error) {
        if (error instanceof KimiWebError && error.reason === "unauthorized") throw error;
        throw new KimiWebError("unsupported", `Kimi Code ${name} 契约不可验证`);
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== expected[name]) throw new KimiWebError("unsupported", `Kimi Code ${name} 契约版本不受支持`);
    }
    return new KimiWebClient({ endpoint, instance, meta, token, sessionContract: desktop ? profile.session : "legacy", fetch: fetcher, timeoutMs });
  }

  /** Authenticated JSON request. Redirects, credentials in output, and unbounded bodies are excluded. */
  async requestJson<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; maxBytes?: number } = {}): Promise<T> {
    if (this.#lifetime.signal.aborted) throw new KimiWebError("unavailable", "Kimi Code 连接已关闭");
    const relative = path.startsWith("/") ? path : `/${path}`;
    if (!relative.startsWith("/api/v1/") && !relative.startsWith("/api/v2/")) throw new KimiWebError("unsafe", "Kimi Code 请求路径无效");
    let target: URL;
    try { target = new URL(relative, this.endpoint); } catch { throw new KimiWebError("unsafe", "Kimi Code 请求路径无效"); }
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(target.pathname); } catch { throw new KimiWebError("unsafe", "Kimi Code 请求路径编码无效"); }
    if (target.origin !== this.endpoint.origin || /[\\]/u.test(decodedPath)
      || decodedPath.split("/").some(segment => segment === "." || segment === "..")
      || /(?:^|\/|:)(?:shutdown|takeover|delete)(?:$|:|\/)/iu.test(decodedPath)
      || /^\/api\/v1\/(?:oauth|remote-control)(?:\/|$)/iu.test(decodedPath)) {
      throw new KimiWebError("unsafe", "该 Kimi Code 操作不在 Orbis 接入权限内");
    }
    const signal = AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(this.#timeoutMs), ...(init.signal ? [init.signal] : [])]);
    try {
      const response = await this.#fetch(target, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${this.#token}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) throw new KimiWebError("unsafe", "Kimi Code 不允许 HTTP 重定向");
      if (response.status === 401 || response.status === 403) {
        this.#socket?.terminate();
        throw new KimiWebError("unauthorized", "Kimi Code 本机 Web 凭据已失效");
      }
      if (!response.ok) throw new KimiWebError("unavailable", `Kimi Code 请求失败（HTTP ${response.status}）`);
      const bytes = await boundedBody(response, init.maxBytes ?? MAX_REST_BYTES);
      if (response.status === 204 || bytes.byteLength === 0) return undefined as T;
      const envelope = JSON.parse(new TextDecoder().decode(bytes)) as { code?: unknown; msg?: unknown; data?: T };
      if (typeof envelope?.code !== "number" || !Number.isSafeInteger(envelope.code)) throw new KimiWebError("unsupported", "Kimi Code 响应格式无效");
      if (envelope.code !== 0) throw new KimiBusinessError(envelope.code);
      return envelope.data as T;
    } catch (error) {
      if (error instanceof KimiWebError || error instanceof KimiBusinessError) throw error;
      if (error instanceof SyntaxError) throw new KimiWebError("unsupported", "Kimi Code 响应 JSON 无效");
      throw new KimiWebError("unavailable", "Kimi Code 本机请求中断或超时");
    }
  }

  /** Opens an authenticated subscription; close() only closes this client's socket. */
  openSocket(onFrame: (frame: Record<string, unknown>) => void, onClose: (reason: string) => void): WebSocket {
    if (this.#lifetime.signal.aborted) throw new KimiWebError("unavailable", "Kimi Code 连接已关闭");
    if (this.#socket && this.#socket.readyState < WebSocket.CLOSING) throw new Error("Kimi Code WebSocket already open");
    const url = new URL("/api/v1/ws", this.endpoint);
    url.protocol = "ws:";
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.#token}` }, maxPayload: 1024 * 1024, handshakeTimeout: this.#timeoutMs });
    this.#socket = socket;
    let lastInboundAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastInboundAt > 30_000) socket.terminate();
    }, 5_000);
    watchdog.unref();
    socket.on("message", data => {
      lastInboundAt = Date.now();
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (bytes.byteLength > 1024 * 1024) { socket.close(1009, "message too large"); return; }
      let frame: unknown;
      try { frame = JSON.parse(bytes.toString("utf8")); } catch { return; }
      if (typeof frame !== "object" || frame === null || Array.isArray(frame) || typeof (frame as Record<string, unknown>).type !== "string") return;
      const value = frame as Record<string, unknown>;
      if (value.type === "ping") { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "pong" })); return; }
      onFrame(value);
    });
    socket.once("close", code => {
      clearInterval(watchdog);
      if (this.#socket === socket) this.#socket = undefined;
      if (!this.#lifetime.signal.aborted) onClose(`Kimi Code 连接关闭（${code}）`);
    });
    socket.once("error", () => { /* close is the single lifecycle notification */ });
    return socket;
  }

  close(): void {
    this.#lifetime.abort();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Orbis disconnected");
  }
}

export function defaultKimiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
}

export type KimiWebConnectionStatus = {
  state: "disabled" | "connecting" | "connected" | KimiWebError["reason"] | "stopped";
  reason: string | null;
  generation: number;
};

/** Background, bounded reconnect loop. It owns only its REST/WS clients, never the Kimi process. */
export class KimiWebConnector {
  readonly #options: KimiWebClientOptions & {
    onStatus?: (status: KimiWebConnectionStatus) => void;
    onMissing?: () => void;
    onFrame?: (frame: Record<string, unknown>, generation: number) => void;
    onConnected?: (client: KimiWebClient, socket: WebSocket, generation: number) => void | Promise<void>;
  };
  #status: KimiWebConnectionStatus = { state: "disabled", reason: null, generation: 0 };
  #client: KimiWebClient | undefined;
  #retry: NodeJS.Timeout | undefined;
  #connecting: Promise<void> | undefined;
  #running = false;
  #backoffMs = 1_000;

  constructor(options: KimiWebClientOptions & {
    onStatus?: (status: KimiWebConnectionStatus) => void;
    onMissing?: () => void;
    onFrame?: (frame: Record<string, unknown>, generation: number) => void;
    onConnected?: (client: KimiWebClient, socket: WebSocket, generation: number) => void | Promise<void>;
  }) { this.#options = options; }

  get status(): KimiWebConnectionStatus { return this.#status; }
  get client(): KimiWebClient | undefined { return this.#client; }

  /** Starts probing in the background; callers must not await this on Host startup. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#set("connecting", null);
    void this.#attempt();
  }

  /** Explicit user actions can wake discovery instead of waiting for the background backoff. */
  async probe(): Promise<void> {
    if (this.#connecting) return this.#connecting;
    if (!this.#running || this.#status.state === "connected") return;
    clearTimeout(this.#retry); this.#retry = undefined;
    await this.#attempt();
  }

  #set(state: KimiWebConnectionStatus["state"], reason: string | null): void {
    if (this.#status.state === state && this.#status.reason === reason) return;
    this.#status = { state, reason, generation: this.#status.generation };
    this.#options.onStatus?.(this.#status);
  }

  #attempt(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connectOnce().finally(() => { this.#connecting = undefined; });
    return this.#connecting;
  }

  async #connectOnce(): Promise<void> {
    let client: KimiWebClient | undefined;
    try {
      client = await KimiWebClient.connect(this.#options);
      if (!this.#running) { client.close(); return; }
      const socket = client.openSocket(
        frame => this.#options.onFrame?.(frame, this.#status.generation),
        reason => this.#connectionLost(client!, reason),
      );
      this.#client = client;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new KimiWebError("unavailable", "Kimi Code WebSocket 握手超时")), this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
        const cleanup = () => { clearTimeout(timer); socket.off("open", opened); socket.off("error", errored); socket.off("close", closed); };
        const opened = () => { cleanup(); resolve(); };
        const errored = () => { cleanup(); reject(new KimiWebError("unavailable", "Kimi Code WebSocket 握手失败")); };
        const closed = () => { cleanup(); reject(new KimiWebError("unavailable", "Kimi Code WebSocket 握手期间断开")); };
        socket.once("open", opened); socket.once("error", errored); socket.once("close", closed);
      });
      if (!this.#running) { client.close(); return; }
      const generation = this.#status.generation + 1;
      this.#status = { state: "connected", reason: null, generation };
      this.#backoffMs = 1_000;
      this.#options.onStatus?.(this.#status);
      await this.#options.onConnected?.(client, socket, generation);
    } catch (error) {
      if (client && this.#client !== client) client.close();
      if (client && this.#client === client) { this.#client = undefined; client.close(); }
      if (!this.#running) return;
      const failure = error instanceof KimiWebError ? error : new KimiWebError("unavailable", "Kimi Code 本机连接失败");
      this.#set(failure.reason, failure.message);
      if (failure.reason === "not_running") this.#options.onMissing?.();
      this.#scheduleRetry();
    }
  }

  #connectionLost(client: KimiWebClient, reason: string): void {
    if (!this.#running || this.#client !== client) return;
    this.#client = undefined;
    client.close();
    this.#set("unavailable", reason);
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (!this.#running || this.#retry) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
    this.#retry = setTimeout(() => { this.#retry = undefined; void this.#attempt(); }, delay);
    this.#retry.unref();
  }

  async stop(): Promise<void> {
    if (!this.#running && !this.#connecting) return;
    this.#running = false;
    clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#client?.close();
    this.#client = undefined;
    await this.#connecting?.catch(() => {});
    this.#set("stopped", null);
  }
}
