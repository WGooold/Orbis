import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, generateKeyPair, randomUUID, sign } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { GatewayClient, type DeviceAuthTokenRecord, type DeviceIdentity, type GatewayClientRequestOptions } from "@openclaw/gateway-client";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import type { EventFrame } from "@openclaw/gateway-protocol/frame-guards";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";

const SCOPES = ["operator.read", "operator.write"];
const generateEd25519 = promisify(generateKeyPair);
const METHODS = ["sessions.list", "sessions.create", "sessions.subscribe", "sessions.messages.subscribe", "sessions.messages.unsubscribe", "sessions.patch",
  "chat.history", "chat.send", "chat.abort"] as const;
export type OpenClawMethod = typeof METHODS[number];
export type OpenClawConfig = Readonly<{ url: string; token?: string }>;
export type OpenClawGatewayEvents = {
  online: () => void;
  offline: () => void;
  event: (event: Pick<EventFrame, "event" | "payload">) => void;
  gap: () => void;
  log?: (message: string) => void;
};

export function openClawRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** No discovery or shared OpenClaw state. A gateway path is a local Host work directory. */
export function openClawUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || url.protocol !== "ws:" && url.protocol !== "wss:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("OpenClaw Gateway must be a root WebSocket URL on 127.0.0.1 or [::1]");
  }
  return url.origin;
}

export async function loadOpenClawConfig(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<OpenClawConfig | undefined> {
  if (env.ORBIS_OPENCLAW_URL === "") return undefined;
  // An environment-selected endpoint must never inherit a file's token for a different Gateway.
  if (env.ORBIS_OPENCLAW_URL !== undefined) {
    const token = env.ORBIS_OPENCLAW_TOKEN?.trim();
    return { url: openClawUrl(env.ORBIS_OPENCLAW_URL), ...(token ? { token } : {}) };
  }
  const text = await readPrivate(join(stateDir, "openclaw-gateway.json"));
  if (text === undefined) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("Invalid openclaw-gateway.json"); }
  const config = openClawRecord(raw);
  if (!config || typeof config.url !== "string" || config.token !== undefined && typeof config.token !== "string") throw new Error("Invalid openclaw-gateway.json");
  const token = (env.ORBIS_OPENCLAW_TOKEN ?? config.token)?.trim();
  return { url: openClawUrl(config.url), ...(token ? { token } : {}) };
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

export class OpenClawGateway {
  readonly url: string;
  readonly #client: GatewayClient;
  #ready = false;
  #stopped = false;

  static async create(config: OpenClawConfig, stateDir: string, events: OpenClawGatewayEvents): Promise<OpenClawGateway> {
    const url = openClawUrl(config.url);
    const directory = join(stateDir, "openclaw", createHash("sha256").update(url).digest("hex"));
    const identity = await loadIdentity(directory);
    return new OpenClawGateway({ ...config, url }, identity, join(directory, `${identity.deviceId}.json`), events);
  }

  private constructor(config: OpenClawConfig, identity: DeviceIdentity, tokenFile: string, events: OpenClawGatewayEvents) {
    this.url = config.url;
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
    this.#client = new GatewayClient({ url: config.url, ...(config.token ? { token: config.token } : {}),
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT, clientDisplayName: "Orbis Host", mode: GATEWAY_CLIENT_MODES.BACKEND,
      role: "operator", scopes: SCOPES, deviceIdentity: identity, requestTimeoutMs: 10_000,
      minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
      hostDeps: {
        publicKeyRawBase64UrlFromPem: pem => rawKey(createPublicKey(pem)).toString("base64url"),
        signDevicePayload: (pem, payload) => sign(null, Buffer.from(payload), createPrivateKey(pem)).toString("base64url"),
        loadDeviceAuthToken: () => stored(),
        storeDeviceAuthToken: ({ token, scopes, expectedToken }) => updateStored(expectedToken, () => writePrivate(tokenFile, JSON.stringify({ token, scopes }))),
        clearDeviceAuthToken: ({ expectedToken }) => updateStored(expectedToken, () => unlink(tokenFile).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        })),
      },
      onHelloOk: hello => {
        if (this.#stopped) return;
        if (hello.protocol !== PROTOCOL_VERSION || hello.auth.role !== "operator" || !SCOPES.every(scope => hello.auth.scopes.includes(scope)) ||
            !METHODS.every(method => hello.features.methods.includes(method))) {
          events.log?.("OpenClaw Gateway did not grant the required operator scopes or chat methods");
          this.#client.stop(); return;
        }
        this.#ready = true;
        events.online();
      },
      onConnectError: error => {
        // Never print the upstream error or close reason: those are server-controlled.
        const details = openClawRecord(openClawRecord(error)?.details);
        const id = details?.requestId;
        events.log?.(typeof id === "string" && /^[\w-]{1,128}$/.test(id) ? `OpenClaw device approval required: ${id}` : "OpenClaw Gateway connection failed");
      },
      onClose: () => { if (this.#ready) { this.#ready = false; if (!this.#stopped) events.offline(); } },
      onGap: () => { if (this.ready) events.gap(); },
      onEvent: event => { if (this.ready) events.event(event); },
    });
    this.#drainTokenWrites = () => tokenWrites;
  }
  readonly #drainTokenWrites: () => Promise<void>;
  get ready(): boolean { return this.#ready && !this.#stopped && this.#client.connected; }
  start(): void { if (!this.#stopped) this.#client.start(); }
  async stop(): Promise<void> {
    this.#stopped = true; this.#ready = false;
    await this.#client.stopAndWait();
    await this.#drainTokenWrites();
  }
  request<T = unknown>(method: OpenClawMethod, params: object, options?: GatewayClientRequestOptions): Promise<T> {
    if (!this.ready) return Promise.reject(new Error("OpenClaw Gateway is offline"));
    if (!METHODS.includes(method)) return Promise.reject(new Error("Unsupported OpenClaw Gateway method"));
    return this.#client.request<T>(method, params, options);
  }
}
