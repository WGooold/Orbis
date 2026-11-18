import { OpenCode } from "@opencode/client";
import { Service, type Endpoint } from "@opencode/client/service";

export const OPENCODE_CLIENT_VERSION = "2.3.2";
const INFO_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

type OpenCodeClient = ReturnType<typeof OpenCode.make>;
type ClientOptions = Parameters<typeof OpenCode.make>[0];

export type OpenCodeServiceStatus =
  | { readonly state: "unavailable"; readonly reason: "service_not_found" | "unsupported_version" | "invalid_endpoint" | "connection_failed" }
  | { readonly state: "ready"; readonly version: string }
  | { readonly state: "closed" };

export type OpenCodeServiceDependencies = {
  readonly discover?: () => Promise<Endpoint | undefined>;
  readonly createClient?: (options: ClientOptions) => OpenCodeClient;
};

export type OpenCodeServiceOptions = OpenCodeServiceDependencies & {
  readonly pollIntervalMs?: number;
  readonly onChange?: (status: OpenCodeServiceStatus) => void;
};

const initialStatus: OpenCodeServiceStatus = { state: "unavailable", reason: "service_not_found" };

function localServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname.toLowerCase()) &&
      url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

/** Read-only connection monitor for the OpenCode user-level shared service.
 *
 * `Service.discover` only reads the registered service and probes its health. This
 * wrapper intentionally never imports or calls `Service.ensure` or `Service.stop`.
 */
export class OpenCodeServiceConnection {
  readonly #discover: NonNullable<OpenCodeServiceDependencies["discover"]>;
  readonly #createClient: NonNullable<OpenCodeServiceDependencies["createClient"]>;
  readonly #pollIntervalMs: number;
  readonly #onChange: ((status: OpenCodeServiceStatus) => void) | undefined;
  readonly #listeners = new Set<(status: OpenCodeServiceStatus) => void>();
  #status: OpenCodeServiceStatus = initialStatus;
  #client: OpenCodeClient | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #refreshing: Promise<OpenCodeServiceStatus> | undefined;
  #started = false;
  #closed = false;
  #generation = 0;

  constructor(options: OpenCodeServiceOptions = {}) {
    this.#discover = options.discover ?? (async () => {
      const endpoint = await Service.discover();
      if (endpoint === undefined) return undefined;
      return { url: endpoint.url, ...(endpoint.auth === undefined ? {} : { auth: endpoint.auth }) };
    });
    this.#createClient = options.createClient ?? (clientOptions => OpenCode.make(clientOptions));
    this.#pollIntervalMs = Math.max(250, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.#onChange = options.onChange;
  }

  get status(): OpenCodeServiceStatus { return this.#status; }
  get client(): OpenCodeClient | undefined { return this.#client; }
  subscribe(listener: (status: OpenCodeServiceStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  get isReady(): boolean { return this.#status.state === "ready" && this.#client !== undefined; }

  /** Probe once. Concurrent probes share one request. */
  refresh(): Promise<OpenCodeServiceStatus> {
    if (this.#closed) return Promise.resolve(this.#status);
    if (this.#refreshing) return this.#refreshing;
    const generation = this.#generation;
    const task = this.#probe(generation).finally(() => {
      if (this.#refreshing === task) this.#refreshing = undefined;
    });
    this.#refreshing = task;
    return task;
  }

  /** Begin read-only discovery and periodic reconnect attempts. */
  async start(): Promise<void> {
    if (this.#started || this.#closed) return;
    this.#started = true;
    await this.refresh();
    this.#schedule();
  }

  /** Release only this monitor's timer and client reference; the OpenCode service keeps running. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    this.#generation++;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#client = undefined;
    this.#status = { state: "closed" };
    this.#listeners.clear();
  }

  async #probe(generation: number): Promise<OpenCodeServiceStatus> {
    let next: OpenCodeServiceStatus = { state: "unavailable", reason: "service_not_found" };
    let client: OpenCodeClient | undefined;
    try {
      const endpoint = await this.#discover();
      if (endpoint !== undefined) {
        if (!localServiceUrl(endpoint.url)) {
          next = { state: "unavailable", reason: "invalid_endpoint" };
        } else {
          const headers = Service.headers(endpoint);
          client = this.#createClient({ baseUrl: endpoint.url, ...(headers === undefined ? {} : { headers }) });
          const info = await client.server.info({ signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
          next = info.version === OPENCODE_CLIENT_VERSION
            ? { state: "ready", version: info.version }
            : { state: "unavailable", reason: "unsupported_version" };
        }
      }
    } catch {
      next = { state: "unavailable", reason: "connection_failed" };
    }
    if (!this.#closed && generation === this.#generation) {
      this.#client = next.state === "ready" ? client : undefined;
      this.#setStatus(next);
    }
    return next;
  }

  #setStatus(status: OpenCodeServiceStatus): void {
    if (status.state === "unavailable" && this.#status.state === "unavailable" && this.#status.reason === status.reason) return;
    if (status.state === "ready" && this.#status.state === "ready" && this.#status.version === status.version) return;
    if (status.state === "closed" && this.#status.state === "closed") return;
    this.#status = status;
    this.#onChange?.(status);
    for (const listener of this.#listeners) listener(status);
  }

  #schedule(): void {
    if (!this.#started || this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.refresh().finally(() => this.#schedule());
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }
}