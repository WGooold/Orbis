import { createPrivateKey, createSign, createHash } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import { LIVE_ACTIVITY_START_WINDOW_SECONDS, type LiveActivityPush } from "./live-activities.js";

export type APNsConfig = {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKey: string;
  environment: "sandbox" | "production";
};

export type APNsWakeHint = { category: "task-completed" | "approval-requested"; eventId: string; hostId: string };

/** APNs transport for privacy-preserving wake hints. Never include session text or credentials. */
export class APNsSender {
  readonly environment: APNsConfig["environment"];
  readonly #config: APNsConfig;
  #session: ClientHttp2Session | undefined;
  #jwt?: { value: string; issuedAt: number };

  constructor(config: APNsConfig) {
    if (!/^[A-Z0-9]{10}$/u.test(config.keyId) || !/^[A-Z0-9]{10}$/u.test(config.teamId)) throw new Error("Invalid APNs Key ID or Team ID");
    if (!/^[A-Za-z0-9.-]+$/u.test(config.bundleId)) throw new Error("Invalid APNs bundle ID");
    if (config.environment !== "sandbox" && config.environment !== "production") throw new Error("Invalid APNs environment");
    this.#config = config;
    this.environment = config.environment;
  }

  async send(deviceToken: string, hint: APNsWakeHint): Promise<"sent" | "invalid-token"> {
    if (!/^[a-fA-F0-9]{64,200}$/u.test(deviceToken)) throw new Error("Invalid APNs device token");
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(hint.eventId)) throw new Error("Invalid push event ID");
    return this.#post(deviceToken, {
      "apns-topic": this.#config.bundleId,
      "apns-push-type": "alert", "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 300),
      "apns-collapse-id": createHash("sha256").update(JSON.stringify([hint.hostId, hint.category, hint.eventId])).digest("hex").slice(0, 32),
    }, {
      aps: { alert: { title: "Orbis", subtitle: `电脑 ${createHash("sha256").update(hint.hostId).digest("hex").slice(0, 4).toUpperCase()}`,
        body: hint.category === "approval-requested" ? "有待处理的交互。" : "任务已完成" }, sound: "default",
        "thread-id": `orbis.host.${createHash("sha256").update(hint.hostId).digest("hex")}`, "mutable-content": 1 },
      orbis: { v: 1, category: hint.category, eventId: hint.eventId, hostId: hint.hostId },
    });
  }

  /** LA-R02: ActivityKit uses its own topic and tokens. Start requires an
   * alert; keep it generic and silent, with no session text or actions. */
  async sendActivity(activityToken: string, push: LiveActivityPush): Promise<"sent" | "invalid-token"> {
    if (!/^[a-fA-F0-9]{64,1024}$/u.test(activityToken)) throw new Error("Invalid APNs activity token");
    const start = push.event === "start" ? {
      "attributes-type": "OrbisLiveActivityAttributes",
      attributes: { hostId: push.attributes.hostId, pairingRef: push.attributes.pairingRef, launchId: push.attributes.launchId },
      alert: { title: "Orbis", body: { "loc-key": "live-activity.started" } },
      ...(push.inputPushToken ? { "input-push-token": 1 } : {}),
    } : undefined;
    return this.#post(activityToken, {
      "apns-topic": `${this.#config.bundleId}.push-type.liveactivity`,
      "apns-push-type": "liveactivity", "apns-priority": String(push.priority),
      "apns-expiration": String(push.timestamp + (start ? LIVE_ACTIVITY_START_WINDOW_SECONDS : 300)),
      "apns-collapse-id": createHash("sha256").update(push.event === "start" ?
        JSON.stringify([activityToken, push.attributes.pairingRef, "start"]) : activityToken).digest("hex").slice(0, 32),
    }, { aps: {
      timestamp: push.timestamp, event: push.event, "content-state": push.contentState,
      "relevance-score": push.contentState.phase === "attention" ? 100 : push.contentState.phase === "running" ? 50 : 0,
      ...start,
      ...(push.event === "end" ? { "dismissal-date": push.dismissalTimestamp ?? push.timestamp + 300 } : { "stale-date": push.timestamp + 600 }),
    } });
  }

  async #post(deviceToken: string, headers: Record<string, string>, payload: unknown): Promise<"sent" | "invalid-token"> {
    // Fail before opening a socket when local signing material is invalid.
    const authorization = `bearer ${this.#providerToken()}`;
    const session = this.#getSession();
    const response = await new Promise<{ status: number; reason?: string }>((resolve, reject) => {
      const req = session.request({
        ":method": "POST", ":path": `/3/device/${deviceToken}`,
        authorization,
        ...headers,
      });
      let status = 0;
      let finished = false;
      const chunks: Buffer[] = [];
      const timeout = setTimeout(() => { req.close(); reject(new Error("APNs request timed out")); }, 10_000);
      req.on("response", headers => { status = Number(headers[":status"] ?? 0); });
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        finished = true;
        clearTimeout(timeout);
        let reason: string | undefined;
        try {
          const value = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: unknown }).reason;
          if (typeof value === "string" && /^[A-Za-z]{1,64}$/u.test(value)) reason = value;
        } catch { /* HTTP status remains authoritative for malformed error bodies. */ }
        resolve({ status, ...(reason === undefined ? {} : { reason }) });
      });
      req.on("error", error => { clearTimeout(timeout); reject(error); });
      req.on("close", () => { clearTimeout(timeout); if (!finished) reject(new Error("APNs stream closed before response")); });
      req.end(JSON.stringify(payload));
    });
    if (response.status === 200) return "sent";
    if (response.status === 410 || response.status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(response.reason ?? "")) return "invalid-token";
    throw Object.assign(new Error(`APNs request failed with HTTP ${response.status}${response.reason ? ` (${response.reason})` : ""}`),
      { apnsRejected: response.status >= 400 && response.status <= 599 });
  }

  close(): void { this.#session?.close(); this.#session = undefined; }

  #getSession(): ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const origin = this.#config.environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const session = connect(origin);
    session.on("error", () => { if (this.#session === session) this.#session = undefined; session.destroy(); });
    session.on("goaway", () => { if (this.#session === session) this.#session = undefined; session.close(); });
    return this.#session = session;
  }

  #providerToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.#jwt && now >= this.#jwt.issuedAt && now - this.#jwt.issuedAt < 50 * 60) return this.#jwt.value;
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: this.#config.keyId })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: this.#config.teamId, iat: now })).toString("base64url");
    const unsigned = `${header}.${claims}`;
    const signer = createSign("SHA256"); signer.update(unsigned); signer.end();
    const signature = signer.sign({ key: createPrivateKey(this.#config.privateKey), dsaEncoding: "ieee-p1363" }).toString("base64url");
    const value = `${unsigned}.${signature}`;
    this.#jwt = { value, issuedAt: now };
    return value;
  }
}
