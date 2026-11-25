import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, generateKeyPair, randomUUID, sign } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { GatewayClient, GatewayClientRequestError, type DeviceAuthTokenRecord, type DeviceIdentity, type GatewayClientRequestOptions } from "@openclaw/gateway-client";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { ConnectErrorDetailCodes, ConnectErrorDetailCodes as Connect, readConnectErrorDetailCode, readPairingConnectErrorDetails } from "@openclaw/gateway-protocol/connect-error-details";
import type { EventFrame } from "@openclaw/gateway-protocol/frame-guards";
import { isRetryableGatewayStartupUnavailableError } from "@openclaw/gateway-protocol/startup-unavailable";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { openClawConnectIssue, OpenClawSetupError, type OpenClawIssue } from "./openclaw-diagnostics.js";

const SCOPES = ["operator.read", "operator.write"];
const ADMIN = "operator.admin";
const generateEd25519 = promisify(generateKeyPair);
const METHODS = ["sessions.list", "sessions.create", "sessions.subscribe", "sessions.messages.subscribe", "sessions.messages.unsubscribe", "sessions.patch",
  "chat.history", "chat.send", "chat.abort"] as const;
export type OpenClawMethod = typeof METHODS[number];
export type OpenClawAccess = "auto" | "sessions" | "admin";
type OpenClawAuth = "token" | "password";
export type OpenClawConfig = Readonly<{ url: string; token?: string; password?: string; auth?: "password"; access?: OpenClawAccess; environment?: true }>;
export type OpenClawSettingsMethod = "config.get" | "config.patch";
export type OpenClawSettingsConnection = Readonly<{ request: (method: OpenClawSettingsMethod, params: object) => Promise<unknown> }>;
export type OpenClawConnectionState = Readonly<{
  phase: "connecting" | "connected" | "unreachable" | "tls_failed" | "token_missing" | "token_rejected" | "password_missing" | "password_rejected" | "pairing_required" |
    "pairing_rejected" | "access_denied" | "incompatible" | "methods_unavailable" | "rate_limited" | "auth_failed";
  granted: "none" | "sessions" | "admin";
  canEdit: boolean;
  approvalId?: string;
}>;
export type OpenClawGatewayEvents = {
  online: () => void;
  offline: () => void;
  diagnostic?: () => void;
  event: (event: Pick<EventFrame, "event" | "payload">) => void;
  gap: () => void;
  log?: (message: string) => void;
};

export function openClawRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** No discovery or shared OpenClaw state. Remote Gateway credentials require TLS. */
export function openClawUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || url.protocol !== "ws:" && url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("OpenClaw Gateway must be a root ws(s) URL without embedded credentials or query parameters");
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "ws:" && !loopback) throw new Error("Remote OpenClaw Gateway connections require wss:// TLS");
  return url.origin;
}

/** Local sessions may use a project outside the Gateway's configured workspace. */
export function openClawRequestedScopes(url: string, access: OpenClawAccess = "auto"): string[] | undefined {
  const loopback = openClawUrl(url).startsWith("ws://");
  if (access === "admin") return [ADMIN];
  // Only explicit loopback ws endpoints are local. The pinned SDK defaults to
  // operator.admin, but reuses the granted scopes when using a saved device token.
  return loopback && access === "auto" ? undefined : [...SCOPES];
}

function parseAccess(input: unknown): OpenClawAccess | undefined {
  if (input === undefined) return undefined;
  if (input !== "auto" && input !== "sessions" && input !== "admin") throw new Error("OpenClaw 权限选项无效");
  return input;
}

function parseAuth(input: unknown): OpenClawAuth | undefined {
  if (input === undefined) return undefined;
  if (input !== "token" && input !== "password") throw new Error("OpenClaw 认证方式无效");
  return input;
}

function credentials(auth: OpenClawAuth, secret?: string) {
  const value = secret?.trim();
  return auth === "password" ? { auth: "password" as const, ...(value ? { password: value } : {}) } : value ? { token: value } : {};
}

export async function loadOpenClawConfig(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<OpenClawConfig | undefined> {
  if (env.ORBIS_OPENCLAW_URL === "") return undefined;
  const accessOverride = parseAccess(env.ORBIS_OPENCLAW_ACCESS);
  if (env.ORBIS_OPENCLAW_TOKEN !== undefined && env.ORBIS_OPENCLAW_PASSWORD !== undefined) throw new Error("OpenClaw 只能配置一种 Gateway 凭据");
  const authOverride = env.ORBIS_OPENCLAW_PASSWORD !== undefined ? "password" : env.ORBIS_OPENCLAW_TOKEN !== undefined ? "token" : undefined;
  const secretOverride = env.ORBIS_OPENCLAW_PASSWORD ?? env.ORBIS_OPENCLAW_TOKEN;
  // An environment-selected endpoint must never inherit a file's token for a different Gateway.
  if (env.ORBIS_OPENCLAW_URL !== undefined) {
    return { url: openClawUrl(env.ORBIS_OPENCLAW_URL), ...credentials(authOverride ?? "token", secretOverride), ...(accessOverride ? { access: accessOverride } : {}), environment: true };
  }
  const text = await readPrivate(join(stateDir, "openclaw-gateway.json"));
  if (text === undefined) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("Invalid openclaw-gateway.json"); }
  const config = openClawRecord(raw);
  if (!config || typeof config.url !== "string" || config.token !== undefined && typeof config.token !== "string" ||
      config.password !== undefined && typeof config.password !== "string") throw new Error("Invalid openclaw-gateway.json");
  const savedAuth = parseAuth(config.auth) ?? "token";
  if (savedAuth === "token" ? config.password !== undefined : config.token !== undefined) throw new Error("Invalid openclaw-gateway.json");
  const savedSecret = savedAuth === "password" ? config.password : config.token;
  const access = accessOverride ?? parseAccess(config.access);
  const environment = env.ORBIS_OPENCLAW_TOKEN !== undefined || env.ORBIS_OPENCLAW_PASSWORD !== undefined || env.ORBIS_OPENCLAW_ACCESS !== undefined;
  return { url: openClawUrl(config.url), ...credentials(authOverride ?? savedAuth, secretOverride ?? (typeof savedSecret === "string" ? savedSecret : undefined)), ...(access ? { access } : {}), ...(environment ? { environment: true } : {}) };
}

const usesEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  env.ORBIS_OPENCLAW_URL !== undefined || env.ORBIS_OPENCLAW_TOKEN !== undefined ||
  env.ORBIS_OPENCLAW_PASSWORD !== undefined || env.ORBIS_OPENCLAW_ACCESS !== undefined;

/** The desktop bridge returns the endpoint and policy, but never returns a token. */
export async function readOpenClawDesktopSettings(stateDir: string, env: NodeJS.ProcessEnv = process.env) {
  const source = usesEnvironment(env) ? "environment" : "file";
  try {
    const config = await loadOpenClawConfig(stateDir, env);
    return { source, url: config?.url ?? "", access: config?.access ?? "auto", hasToken: !!config?.token, invalid: false,
      ...(config?.auth === "password" ? { auth: "password" as const, hasPassword: !!config.password } : {}) };
  } catch {
    return { source, url: "", access: "auto", hasToken: false, invalid: true };
  }
}

export async function saveOpenClawDesktopSettings(stateDir: string, url: unknown, token: unknown, env: NodeJS.ProcessEnv = process.env,
  options: { access?: unknown; auth?: unknown; clearToken?: unknown } = {}) {
  if (usesEnvironment(env)) throw new Error("OpenClaw 由环境变量配置");
  if (typeof url !== "string" || url.length > 2048 || typeof token !== "string" || token.length > 4096) throw new Error("OpenClaw 配置无效");
  const requestedAccess = parseAccess(options.access);
  const requestedAuth = parseAuth(options.auth);
  if (options.clearToken !== undefined && typeof options.clearToken !== "boolean" || options.clearToken === true && token.trim()) throw new Error("OpenClaw 凭据操作无效");
  const path = join(stateDir, "openclaw-gateway.json");
  const input = url.trim();
  if (!input) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  } else {
    let endpoint: string;
    try { endpoint = openClawUrl(input); }
    catch (error) {
      if (error instanceof Error && error.message.includes("require wss")) throw new Error("远程 Gateway 地址须使用 wss:// 加密连接");
      throw new Error("Gateway 地址须为本机 ws(s) 或远程 wss 根地址");
    }
    const saved = await loadOpenClawConfig(stateDir, {}).catch(() => undefined);
    const sameEndpoint = saved?.url === endpoint;
    const access = requestedAccess ?? (sameEndpoint ? saved.access : undefined);
    const savedAuth = sameEndpoint ? saved.auth ?? "token" : "token";
    const auth = requestedAuth ?? savedAuth;
    const credential = token.trim() || (sameEndpoint && auth === savedAuth && options.clearToken !== true ? saved.password ?? saved.token : undefined);
    const text = JSON.stringify({ url: endpoint, ...credentials(auth, credential), ...(access && access !== "auto" ? { access } : {}) });
    if (Buffer.byteLength(text) > 16_384) throw new Error("OpenClaw 配置过长");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writePrivate(path, text);
  }
  return readOpenClawDesktopSettings(stateDir, env);
}

async function readPrivate(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384 || process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("OpenClaw Host state must be a private regular file (chmod 600)");
    }
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

async function writePrivate(path: string, text: string, exclusive = false): Promise<void> {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
  const file = await open(target, "wx", 0o600);
  try {
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    if (!exclusive) await rename(target, path);
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  }
}

const rawKey = (key: ReturnType<typeof createPublicKey>): Buffer => Buffer.from(key.export({ format: "jwk" }).x!, "base64url");

async function loadIdentity(dir: string): Promise<DeviceIdentity> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "identity.pem");
  let privateKeyPem = await readPrivate(path);
  if (!privateKeyPem) {
    const { privateKey } = await generateEd25519("ed25519");
    const generated = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await writePrivate(path, generated, true).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    privateKeyPem = await readPrivate(path);
    if (!privateKeyPem) throw new Error("OpenClaw device identity is unavailable");
  }
  const publicKey = createPublicKey(privateKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid OpenClaw device identity");
  return { deviceId: createHash("sha256").update(rawKey(publicKey)).digest("hex"), privateKeyPem,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() };
}

const clawState = (phase: OpenClawConnectionState["phase"], approvalId?: string): OpenClawConnectionState => ({
  phase, granted: "none", canEdit: false, ...(approvalId ? { approvalId } : {}),
});

/** Only SDK codes are used in the connection panel. Never expose upstream error text or credentials. */
function connectFailure(error: Error): OpenClawConnectionState["phase"] {
  switch (readConnectErrorDetailCode(openClawRecord(error)?.details)) {
    case Connect.AUTH_TOKEN_MISSING: return "token_missing";
    case Connect.AUTH_TOKEN_MISMATCH: case Connect.AUTH_DEVICE_TOKEN_MISMATCH:
    case Connect.AUTH_TOKEN_NOT_CONFIGURED: return "token_rejected";
    case Connect.AUTH_PASSWORD_MISSING: return "password_missing";
    case Connect.AUTH_PASSWORD_MISMATCH: case Connect.AUTH_PASSWORD_NOT_CONFIGURED: return "password_rejected";
    case Connect.PAIRING_EXPIRED: case Connect.PAIRING_REJECTED: return "pairing_rejected";
    case Connect.AUTH_SCOPE_MISMATCH: case Connect.AUTH_VERIFIED_USER_REQUIRED:
    case Connect.AUTHENTICATED_PROFILE_UNAVAILABLE: case Connect.OPERATOR_ACCESS_DENIED: return "access_denied";
    case Connect.PROTOCOL_MISMATCH: case Connect.CLIENT_VERSION_MISMATCH: return "incompatible";
    case Connect.AUTH_RATE_LIMITED: return "rate_limited";
    default: break;
  }
  const code = (error as NodeJS.ErrnoException).code ?? "";
  if (/^(?:ERR_(TLS|SSL)_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_VERIFY_|UNABLE_TO_GET_ISSUER_)/u.test(code)) return "tls_failed";
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "unreachable";
  return "auth_failed";
}

export class OpenClawGateway {
  readonly url: string;
  #client: GatewayClient;
  readonly #makeClient: () => GatewayClient;
  #connectionGeneration = 0;
  #pairingEpoch = 0;
  #issue: OpenClawIssue | undefined;
  #ready = false;
  #stopped = false;
  #connectionState = clawState("connecting");
  #settings: OpenClawSettingsConnection | undefined;

  static async create(config: OpenClawConfig, stateDir: string, events: OpenClawGatewayEvents): Promise<OpenClawGateway> {
    const url = openClawUrl(config.url);
    const directory = join(stateDir, "openclaw", createHash("sha256").update(url).digest("hex"));
    const identity = await loadIdentity(directory);
    return new OpenClawGateway({ ...config, url }, identity, join(directory, `${identity.deviceId}.json`), events);
  }

  private constructor(config: OpenClawConfig, identity: DeviceIdentity, tokenFile: string, events: OpenClawGatewayEvents) {
    this.url = config.url;
    const requestedScopes = openClawRequestedScopes(config.url, config.access);
    let tokenWrites: Promise<void> = Promise.resolve();
    const stored = async (): Promise<DeviceAuthTokenRecord | null> => {
      const text = await readPrivate(tokenFile);
      if (text === undefined) return null;
      const value = openClawRecord(JSON.parse(text));
      if (typeof value?.token !== "string" || !Array.isArray(value.scopes) || !value.scopes.every(x => typeof x === "string")) return null;
      return { token: value.token, scopes: value.scopes as string[] };
    };
    const updateStored = (expected: string | null | undefined, update: () => Promise<void>): Promise<void> => {
      const next = tokenWrites.then(async () => {
        if (expected !== undefined && (await stored())?.token !== (expected ?? undefined)) return;
        await update();
      });
      tokenWrites = next.catch(() => events.log?.("OpenClaw pairing token could not be saved"));
      return next;
    };
    this.#makeClient = () => {
      const generation = this.#connectionGeneration;
      const current = () => !this.#stopped && generation === this.#connectionGeneration;
      let diagnosed = false;
      const report = (issue: OpenClawIssue) => {
        if (!current()) return;
        diagnosed = true;
        if (this.#issue === issue) return;
        this.#issue = issue;
        events.log?.(`OpenClaw Gateway: ${issue}`);
        events.diagnostic?.();
      };
      const environment = config.environment === true;
      const endpoint = new URL(config.url);
      const host = endpoint.hostname.replace(/^\[|\]$/g, "");
      const port = Number(endpoint.port || (endpoint.protocol === "wss:" ? "443" : "80"));
      return new GatewayClient({ url: config.url, ...(config.password ? { password: config.password } : config.token ? { token: config.token } : {}),
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT, clientDisplayName: "Orbis Host", mode: GATEWAY_CLIENT_MODES.BACKEND,
        role: "operator", ...(requestedScopes ? { scopes: requestedScopes } : {}), deviceIdentity: identity, requestTimeoutMs: 10_000,
        minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION, notifyOnStartupRetry: true,
        hostDeps: {
          beforeConnect: () => { diagnosed = false; this.#settings = undefined; this.#connectionState = clawState("connecting"); },
          publicKeyRawBase64UrlFromPem: pem => rawKey(createPublicKey(pem)).toString("base64url"),
          signDevicePayload: (pem, payload) => sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
          loadDeviceAuthToken: () => stored().catch(() => { throw new OpenClawSetupError("host_state_unavailable"); }),
          storeDeviceAuthToken: ({ token, scopes, expectedToken }) => updateStored(expectedToken, () => writePrivate(tokenFile, JSON.stringify({ token, scopes })))
            .catch(() => { throw new OpenClawSetupError("host_state_unavailable"); }),
          clearDeviceAuthToken: ({ expectedToken }) => updateStored(expectedToken, () => unlink(tokenFile).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          })),
        },
        onHelloOk: hello => {
          if (!current()) return;
          const frame = openClawRecord(hello), auth = openClawRecord(frame?.auth), features = openClawRecord(frame?.features);
          const scopes = auth?.scopes, methods = features?.methods;
          const granted = Array.isArray(scopes) && auth?.role === "operator" ? scopes : [];
          const admin = granted.includes(ADMIN);
          const sessions = SCOPES.every(scope => granted.includes(scope));
          const expectsAdmin = config.access === "admin";
          const mayUseAdmin = expectsAdmin || requestedScopes === undefined;
          const permitted = expectsAdmin ? admin : mayUseAdmin ? sessions || admin : sessions && !admin;
          const effective = admin ? "admin" : sessions ? "sessions" : "none";
          const malformed = frame?.type !== "hello-ok" || !Number.isInteger(frame.protocol) || !Array.isArray(scopes) || !Array.isArray(methods);
          const incompatible = frame?.protocol !== PROTOCOL_VERSION;
          const methodsReady = Array.isArray(methods) && METHODS.every(method => methods.includes(method));
          const issue = malformed ? "connect_unconfirmed" : incompatible ? "version_incompatible"
            : !permitted ? "session_access_denied" : !methodsReady ? "session_methods_unavailable" : undefined;
          const phase = malformed ? "auth_failed" : incompatible ? "incompatible" : !permitted ? "access_denied"
            : !methodsReady ? "methods_unavailable" : "connected";
          const canEdit = phase === "connected" && mayUseAdmin && admin && Array.isArray(methods) && methods.includes("config.get") && methods.includes("config.patch");
          this.#settings = undefined;
          this.#connectionState = { phase, granted: effective, canEdit };
          if (issue) { report(issue); this.#client.stop(); return; }
          this.#issue = undefined;
          if (canEdit) {
            const connection: OpenClawSettingsConnection = { request: async (method, params) => {
              if (this.settingsConnection !== connection || (method !== "config.get" && method !== "config.patch")) throw new Error("OpenClaw Gateway configuration is unavailable");
              return this.#client.request(method, params);
            } };
            this.#settings = connection;
          }
          this.#ready = true;
          events.online();
        },
        onConnectError: error => {
          if (!current()) return;
          const pairing = readPairingConnectErrorDetails(openClawRecord(error)?.details);
          const id = typeof pairing?.requestId === "string" && /^[\w-]{1,128}$/u.test(pairing.requestId) ? pairing.requestId : undefined;
          if (pairing) { this.#pairingEpoch++; this.#connectionState = clawState("pairing_required", id); }
          else this.#connectionState = clawState(connectFailure(error));
          const issue = error instanceof OpenClawSetupError ? error.issue : openClawConnectIssue(error, environment);
          if (issue === "token_mismatch" || issue === "environment_token_mismatch") return;
          if (issue) { report(issue); return; }
          if (pairing) { events.log?.("OpenClaw device approval required"); return; }
          const socketError = error as NodeJS.ErrnoException & { address?: string; port?: number };
          if (!(error instanceof GatewayClientRequestError) && (host === "127.0.0.1" || host === "::1") &&
              socketError.code === "ECONNREFUSED" && socketError.syscall === "connect" && socketError.address === host && socketError.port === port) {
            report("local_port_closed");
          } else if (!diagnosed) report("connect_unconfirmed");
          if (!diagnosed) events.log?.("OpenClaw Gateway connection failed");
        },
        onReconnectPaused: ({ detailCode }) => {
          if (detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH) {
            this.#connectionState = clawState(config.auth === "password" ? "password_rejected" : "token_rejected");
            report(environment ? "environment_token_mismatch" : "token_mismatch");
          }
        },
        onClose: (_code, _reason, info) => {
          if (!current()) return;
          this.#settings = undefined;
          if (this.#connectionState.phase === "connected" || this.#connectionState.phase === "connecting") this.#connectionState = clawState("unreachable");
          if (isRetryableGatewayStartupUnavailableError(info?.connectError)) report("starting");
          else if (!diagnosed && readConnectErrorDetailCode(openClawRecord(info?.connectError)?.details) !== ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH)
            report("connect_unconfirmed");
          if (this.#ready) { this.#ready = false; events.offline(); }
        },
        onGap: () => { if (current() && this.ready) events.gap(); },
        onEvent: event => { if (current() && this.ready) events.event(event); },
      });
    };
    this.#client = this.#makeClient();
    this.#drainTokenWrites = () => tokenWrites;
  }
  readonly #drainTokenWrites: () => Promise<void>;
  get ready(): boolean { return this.#ready && !this.#stopped && this.#client.connected; }
  get issue(): OpenClawIssue | undefined { return this.#stopped ? undefined : this.#issue; }
  get pairingEpoch(): number { return this.#pairingEpoch; }
  get connectionState(): OpenClawConnectionState { return this.#connectionState; }
  get settingsConnection(): OpenClawSettingsConnection | undefined { return this.ready ? this.#settings : undefined; }
  start(): void { if (!this.#stopped) this.#client.start(); }
  /** Explicit attach can wake a disconnected SDK client out of its reconnect backoff. */
  async retryLocal(current: () => void): Promise<void> {
    current();
    if (this.#stopped || this.ready) return;
    const generation = ++this.#connectionGeneration;
    this.#issue = undefined;
    try { await this.#client.stopAndWait(); }
    finally {
      if (!this.#stopped && generation === this.#connectionGeneration) {
        this.#ready = false;
        this.#settings = undefined;
        this.#connectionState = clawState("connecting");
        this.#client = this.#makeClient();
        this.#client.start(); // Restore passive attachment even if the caller has since disconnected.
      }
    }
    current();
  }
  async stop(): Promise<void> {
    this.#stopped = true; this.#ready = false;
    this.#settings = undefined;
    await this.#client.stopAndWait();
    await this.#drainTokenWrites();
  }
  request<T = unknown>(method: OpenClawMethod, params: object, options?: GatewayClientRequestOptions): Promise<T> {
    if (!this.ready) return Promise.reject(new Error("OpenClaw Gateway is offline"));
    if (!METHODS.includes(method)) return Promise.reject(new Error("Unsupported OpenClaw Gateway method"));
    return this.#client.request<T>(method, params, options);
  }
}
