import { readFile } from "node:fs/promises";
import { OpenCode } from "@opencode/client";
import { fallback, Service, type Endpoint, type Info } from "@opencode/client/service";
import { LocalAgentStart, waitForLocalAgent, type LocalAgentChild, type StartGuard } from "./local-agent-start.js";

export const OPENCODE_CLIENT_VERSION = "2.3.2";
const INFO_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
export type OpenCodeClient = ReturnType<typeof OpenCode.make>;
type ClientOptions = Parameters<typeof OpenCode.make>[0];
type Registration = Endpoint & { pid?: Info["pid"]; version?: Info["version"] };

export type OpenCodeServiceStatus =
  | { readonly state: "unavailable"; readonly reason: "service_not_found" | "unsupported_version" | "invalid_endpoint" | "connection_failed" }
  | { readonly state: "ready"; readonly version: string }
  | { readonly state: "closed" };

export type OpenCodeServiceOptions = {
  readonly registrationPath?: string;
  readonly discover?: () => Promise<Registration | undefined>;
  readonly createClient?: (options: ClientOptions) => OpenCodeClient;
  readonly pollIntervalMs?: number;
  readonly onChange?: (status: OpenCodeServiceStatus) => void;
  readonly launcher?: OpenCodeLocalLauncher;
};

export type OpenCodeLocalLauncher = {
  available(): Promise<boolean>;
  start(guard: StartGuard, shouldStart: () => Promise<boolean>, confirm: (child: LocalAgentChild) => Promise<boolean>): Promise<void>;
};

const initialStatus: OpenCodeServiceStatus = { state: "unavailable", reason: "service_not_found" };

function localServiceUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) return url;
  } catch { /* Invalid registration. */ }
  return undefined;
}

// ADR-0091 §2：SDK discover probes the recorded URL before returning it. Vet it before any network I/O.
async function readRegistration(path: string): Promise<Registration | undefined> {
  try {
    const info: Partial<Info> | null = JSON.parse(await readFile(path, "utf8"));
    if (!info || typeof info.url !== "string" || typeof info.pid !== "number" || !Number.isSafeInteger(info.pid) || info.pid <= 0 || info.pid > 0x7fff_ffff ||
        (info.version !== undefined && typeof info.version !== "string") ||
        (info.password !== undefined && typeof info.password !== "string")) throw new Error("Invalid OpenCode registration");
    try { process.kill(info.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined; }
    return { url: info.url, pid: info.pid, ...(info.version === undefined ? {} : { version: info.version }),
      ...(info.password === undefined ? {} : { auth: { type: "basic", username: "opencode", password: info.password } }) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function localFetch(origin: string): typeof globalThis.fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin || url.username || url.password) throw new Error("OpenCode request outside registered origin");
    return fetch(input, { ...init, redirect: "error" });
  };
}

/** Monitors the user-level service; only explicit, admitted operations can launch it. */
export class OpenCodeServiceConnection {
  readonly #discover: NonNullable<OpenCodeServiceOptions["discover"]>;
  readonly #createClient: NonNullable<OpenCodeServiceOptions["createClient"]>;
  readonly #pollIntervalMs: number;
  readonly #onChange: OpenCodeServiceOptions["onChange"];
  readonly #listeners = new Set<(status: OpenCodeServiceStatus) => void>();
  readonly #lifetime = new AbortController();
  readonly #startup = new LocalAgentStart();
  readonly #launcher: OpenCodeLocalLauncher | undefined;
  #installed = false;
  #status: OpenCodeServiceStatus = initialStatus;
  #attached: { origin: string; authorization: string | null; pid: number; client: OpenCodeClient } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #refreshing: Promise<OpenCodeServiceStatus> | undefined;
  #started = false;

  constructor(options: OpenCodeServiceOptions = {}) {
    this.#discover = options.discover ?? (() => readRegistration(options.registrationPath ?? fallback()));
    this.#createClient = options.createClient ?? OpenCode.make;
    this.#pollIntervalMs = Math.max(250, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.#onChange = options.onChange;
    this.#launcher = options.launcher;
  }

  get status(): OpenCodeServiceStatus { return this.#status; }
  get client(): OpenCodeClient | undefined { return this.#attached?.client; }
  get isReady(): boolean { return this.#status.state === "ready" && this.#attached !== undefined; }
  get starting(): boolean { return this.#startup.starting; }
  get launchable(): boolean { return !this.#lifetime.signal.aborted && (this.starting || this.#missing() && this.#installed); }

  #missing(): boolean { return this.#status.state === "unavailable" && this.#status.reason === "service_not_found"; }

  async ensure(current: () => boolean, streamReady: () => boolean): Promise<void> {
    if (!current()) throw new Error("OpenCode 启动已取消");
    if (streamReady()) return;
    const launcher = this.#launcher;
    const checkResult = () => {
      if (this.#status.state !== "unavailable") return;
      switch (this.#status.reason) {
        case "service_not_found": return;
        case "unsupported_version": throw new Error("OpenCode 共享服务版本不兼容");
        case "invalid_endpoint": throw new Error("OpenCode 共享服务未使用有效的本机地址");
        case "connection_failed": throw new Error("无法验证已有 OpenCode 共享服务，请检查认证和连接");
      }
    };
    await this.#startup.run(current, () => this.#notify(), async guard => {
      await this.refresh();
      guard.check();
      checkResult();
      if (this.#missing()) {
        if (!launcher) throw new Error("OpenCode 共享服务未运行");
        await launcher.start(guard, async () => {
          await this.refresh(); guard.check(); checkResult();
          return this.#missing();
        }, child => waitForLocalAgent(guard.signal, async () => {
          await this.refresh();
          if (this.isReady) return child.pid === this.#attached?.pid;
          if (child.failed()) throw new Error("OpenCode 共享服务启动失败，请检查电脑端安装和配置");
          // A concurrent native client can win the service port. Attach to its registered instance instead.
          if (this.#status.state === "unavailable" && this.#status.reason !== "connection_failed") checkResult();
          return undefined;
        }));
      }
      await waitForLocalAgent(guard.signal, () => { checkResult(); return streamReady() ? true : undefined; });
    });
  }

  subscribe(listener: (status: OpenCodeServiceStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refresh(): Promise<OpenCodeServiceStatus> {
    if (this.#lifetime.signal.aborted) return Promise.resolve(this.#status);
    if (this.#refreshing) return this.#refreshing;
    const task = this.#probe().finally(() => { this.#refreshing = undefined; });
    this.#refreshing = task;
    return task;
  }

  async start(): Promise<void> {
    if (this.#started || this.#lifetime.signal.aborted) return;
    this.#started = true;
    try { await this.refresh(); } finally { this.#schedule(); }
  }

  /** Release our requests and timer without changing the shared service. */
  close(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#lifetime.abort();
    this.#startup.cancel();
    clearTimeout(this.#timer);
    this.#attached = undefined;
    this.#setStatus({ state: "closed" });
    this.#listeners.clear();
  }

  async drainStartup(): Promise<void> { await this.#startup.close(); }

  async #probe(): Promise<OpenCodeServiceStatus> {
    let next: OpenCodeServiceStatus = initialStatus;
    let attached: { origin: string; authorization: string | null; pid: number; client: OpenCodeClient } | undefined;
    try {
      const registration = await this.#discover();
      if (this.#lifetime.signal.aborted) return this.#status;
      if (registration) {
        const url = localServiceUrl(registration.url);
        if (!url) next = { state: "unavailable", reason: "invalid_endpoint" };
        else if (registration.version !== undefined && registration.version !== OPENCODE_CLIENT_VERSION)
          next = { state: "unavailable", reason: "unsupported_version" };
        else {
          const headers = new Headers(Service.headers(registration));
          const authorization = headers.get("authorization");
          const previous = this.#attached;
          const sameEndpoint = previous?.origin === url.origin && previous.authorization === authorization;
          const create = () => this.#createClient({ baseUrl: registration.url, headers, fetch: localFetch(url.origin) });
          const client = sameEndpoint && (registration.pid === undefined || registration.pid === previous.pid) ? previous.client : create();
          const info = await client.server.info({ signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(INFO_TIMEOUT_MS)]) });
          if (info.version !== OPENCODE_CLIENT_VERSION) next = { state: "unavailable", reason: "unsupported_version" };
          else if (registration.pid !== undefined && registration.pid !== info.pid) next = { state: "unavailable", reason: "connection_failed" };
          else {
            next = { state: "ready", version: info.version };
            attached = { origin: url.origin, authorization, pid: info.pid, client: previous?.client === client && previous.pid !== info.pid ? create() : client };
          }
        }
      }
    } catch { next = { state: "unavailable", reason: "connection_failed" }; }
    const installed = next.state === "unavailable" && next.reason === "service_not_found" && this.#launcher
      ? await this.#launcher.available().catch(() => this.#installed) : this.#installed;
    if (this.#lifetime.signal.aborted) return this.#status;
    const changedLaunchability = this.#installed !== installed;
    this.#installed = installed;
    const changedClient = this.#attached?.client !== attached?.client;
    this.#attached = attached;
    this.#setStatus(next, changedClient || changedLaunchability);
    return this.#status;
  }

  #setStatus(status: OpenCodeServiceStatus, changedClient = false): void {
    if (!changedClient && status.state === "unavailable" && this.#status.state === "unavailable" && this.#status.reason === status.reason) return;
    if (!changedClient && status.state === "ready" && this.#status.state === "ready" && this.#status.version === status.version) return;
    this.#status = status;
    this.#notify();
  }

  #notify(): void {
    if (this.#lifetime.signal.aborted && this.#status.state !== "closed") return;
    this.#onChange?.(this.#status);
    for (const listener of this.#listeners) listener(this.#status);
  }

  #schedule(): void {
    if (this.#lifetime.signal.aborted) return;
    this.#timer = setTimeout(() => { void this.refresh().finally(() => this.#schedule()); }, this.#pollIntervalMs);
    this.#timer.unref();
  }
}
