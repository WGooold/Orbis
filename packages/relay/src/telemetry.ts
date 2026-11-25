import { Worker } from "node:worker_threads";

export const USAGE_GRANULARITIES = ["hour", "day", "week", "fortnight", "month"] as const;
export type UsageGranularity = typeof USAGE_GRANULARITIES[number];

export type RelayResourceSample = {
  sampledAt: number;
  cpuPercent: number;
  rssBytes: number;
  heapUsedBytes: number;
  connectedDevices: number;
  connectedHosts: number;
  eventLoopP95Ms: number;
  eventLoopMaxMs: number;
};

type WorkerReply = { id: number; ok: true; value?: unknown } | { id: number; ok: false; error: string };

/** RELAY-GROWTH-01: worker-backed Relay usage telemetry.
 *
 * Relay telemetry transport. All aggregation and SQLite work runs in a
 * worker so message accounting never synchronously writes on the Relay loop.
 * Only aggregate rows and pseudonymous device IDs are persisted; payloads,
 * credentials, IPs, user agents and URLs/query strings are never sent here.
 */
export class RelayTelemetry {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  #sequence = 0;
  #failed = false;
  #closed = false;

  constructor(stateFile: string) {
    const workerUrl = import.meta.url.endsWith(".ts") ? new URL("../dist/telemetry-worker.js", import.meta.url) : new URL("./telemetry-worker.js", import.meta.url);
    this.#worker = new Worker(workerUrl, { workerData: { stateFile } });
    this.#worker.on("message", (reply: WorkerReply) => {
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      this.#pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new Error(reply.error));
    });
    this.#worker.on("error", () => this.#fail());
    this.#worker.on("exit", code => { if (code !== 0 && !this.#closed) this.#fail(); });
  }

  #fail(): void {
    this.#failed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("telemetry_worker_unavailable"));
    this.#pending.clear();
    console.warn(JSON.stringify({ event: "relay.telemetry.worker_failed" }));
  }

  #send(type: string, value: Record<string, unknown> = {}): void {
    if (this.#failed || this.#closed) return;
    try { this.#worker.postMessage({ type, ...value }); }
    catch { this.#fail(); }
  }

  #request<T>(type: string, value: Record<string, unknown> = {}): Promise<T> {
    if (this.#failed || this.#closed) return Promise.reject(new Error("telemetry_worker_unavailable"));
    const id = ++this.#sequence;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try { this.#worker.postMessage({ id, type, ...value }); }
      catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("telemetry_worker_unavailable"));
      }
    });
  }

  recordDeviceTraffic(deviceId: string, direction: "upload" | "download", bytes: number, at = Date.now()): void {
    if (Number.isSafeInteger(bytes) && bytes > 0) this.#send("traffic", { deviceId, direction, bytes, at });
  }

  startDeviceSession(deviceId: string, sessionId: string, at = Date.now()): void {
    this.#send("session-start", { deviceId, sessionId, at });
  }

  checkpointDeviceSession(sessionId: string, at = Date.now()): void {
    this.#send("session-checkpoint", { sessionId, at });
  }

  endDeviceSession(sessionId: string, at = Date.now()): void {
    this.#send("session-end", { sessionId, at });
  }

  recordHostRegistration(hostId: string, at = Date.now()): void {
    this.#send("host-registered", { hostId, at });
  }

  recordRegistrationStart(at = Date.now()): void { this.#send("registration-start", { at }); }
  recordPairingCode(at = Date.now()): void { this.#send("pairing-code", { at }); }
  recordWebsiteView(page: "home", at = Date.now()): void { this.#send("site-view", { page, at }); }
  recordDownload(platform: string, bytes: number, at = Date.now()): void { this.#send("download", { platform, bytes, at }); }
  recordResourceSample(sample: RelayResourceSample): void { this.#send("resource", { sample }); }

  consentedDeviceIds(): Promise<string[]> { return this.#request("consented-devices"); }

  setDeviceConsent(deviceId: string, enabled: boolean): Promise<void> {
    return this.#request("set-device-consent", { deviceId, enabled });
  }

  forgetDevice(deviceId: string): Promise<void> {
    return this.#request("forget-device", { deviceId });
  }

  snapshot(granularity: UsageGranularity, deviceId?: string): Promise<any> {
    if (!USAGE_GRANULARITIES.includes(granularity)) return Promise.reject(new Error("invalid_usage_granularity"));
    return this.#request("snapshot", { granularity, ...(deviceId ? { deviceId } : {}) });
  }

  async flush(): Promise<void> { await this.#request("flush"); }

  async close(): Promise<void> {
    if (this.#closed) return;
    try { await this.#request("close"); } finally {
      this.#closed = true;
      await this.#worker.terminate();
      for (const pending of this.#pending.values()) pending.reject(new Error("telemetry_worker_closed"));
      this.#pending.clear();
    }
  }
}
