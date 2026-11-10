import { createPrivateKey, createSign, createHash } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";

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
  readonly #config: APNsConfig;
  #session: ClientHttp2Session | undefined;
  #jwt?: { value: string; issuedAt: number };

  constructor(config: APNsConfig) {
    if (!/^[A-Z0-9]{10}$/u.test(config.keyId) || !/^[A-Z0-9]{10}$/u.test(config.teamId)) throw new Error("Invalid APNs Key ID or Team ID");
    if (!/^[A-Za-z0-9.-]+$/u.test(config.bundleId)) throw new Error("Invalid APNs bundle ID");
    if (config.environment !== "sandbox" && config.environment !== "production") throw new Error("Invalid APNs environment");
    this.#config = config;
  }

  async send(deviceToken: string, hint: APNsWakeHint): Promise<"sent" | "invalid-token"> {
    if (!/^[a-fA-F0-9]{64,200}$/u.test(deviceToken)) throw new Error("Invalid APNs device token");
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(hint.eventId)) throw new Error("Invalid push event ID");
    const session = this.#getSession();
    const response = await new Promise<{ status: number; reason?: string }>((resolve, reject) => {
      const req = session.request({
        ":method": "POST", ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${this.#providerToken()}`,
        "apns-topic": this.#config.bundleId,
        "apns-push-type": "alert", "apns-priority": "10",
        "apns-collapse-id": createHash("sha256").update(hint.eventId).digest("hex").slice(0, 32),
      });
      let status = 0;
      const chunks: Buffer[] = [];
      const timeout = setTimeout(() => { req.close(); reject(new Error("APNs request timed out")); }, 10_000);
      req.on("response", headers => { status = Number(headers[":status"] ?? 0); });
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        clearTimeout(timeout);
        let reason: string | undefined;
        try { reason = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: unknown }).reason as string | undefined; } catch { /* HTTP status remains authoritative for malformed error bodies. */ }
        resolve({ status, ...(reason === undefined ? {} : { reason }) });
      });
      req.on("error", error => { clearTimeout(timeout); reject(error); });
      req.end(JSON.stringify({
        aps: { alert: { title: "Orbis", body: hint.category === "approval-requested" ? "有待处理的审批" : "任务已完成" }, sound: "default" },
        orbis: { v: 1, category: hint.category, eventId: hint.eventId, hostId: hint.hostId },
      }));
    });
    if (response.status === 200) return "sent";
    if (response.status === 410) return "invalid-token";
    throw new Error(`APNs request failed with HTTP ${response.status}`);
  }

  close(): void { this.#session?.close(); this.#session = undefined; }

  #getSession(): ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const origin = this.#config.environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const session = connect(origin);
    session.on("error", () => { if (this.#session === session) this.#session = undefined; });
    return this.#session = session;
  }

  #providerToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.#jwt && now - this.#jwt.issuedAt < 50 * 60) return this.#jwt.value;
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
