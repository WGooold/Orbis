import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:http2", () => ({ connect: mocked.connect }));
import { APNsSender } from "./apns.js";

const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
const config = { keyId: "ABCDEFGHIJ", teamId: "KLMNOPQRST", bundleId: "com.example.app",
  privateKey: key.export({ type: "pkcs8", format: "pem" }).toString(), environment: "production" as const };
const hint = { category: "task-completed" as const, eventId: "same-event", hostId: "host-one" };

// APNS-L10: verify the actual HTTP/2 headers, provider JWT and APNs response
// handling with ephemeral keys and an in-process stream; no Apple endpoint is used.
function fixture(status = 200, reason?: string) {
  const sent: Array<{ headers: Record<string, string>; payload: Record<string, unknown> }> = [];
  const session = Object.assign(new EventEmitter(), { closed: false, destroyed: false,
    close: vi.fn(), destroy: vi.fn(), request: vi.fn((headers: Record<string, string>) => {
      const req = Object.assign(new EventEmitter(), {
        close() { req.emit("close"); },
        end(body: string) {
          sent.push({ headers, payload: JSON.parse(body) });
          queueMicrotask(() => { req.emit("response", { ":status": status });
            req.emit("data", Buffer.from(JSON.stringify({ reason }))); req.emit("end"); req.emit("close"); });
        },
      });
      return req;
    }),
  });
  mocked.connect.mockReturnValue(session);
  return { session, sent, sender: new APNsSender(config) };
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

describe("APNs transport lifecycle", () => {
  // LA-R02: assert Apple's ActivityKit headers and envelope independently from
  // ordinary alert push; generic content must not acquire an alert or sound.
  it("sends ActivityKit updates with stale dates and ends with a bounded dismissal", async () => {
    const f = fixture();
    const contentState = { version: 1 as const, phase: "running" as const, runningCount: 3, pendingCount: 0,
      focusKey: "a".repeat(64), agentKind: "codex", startedAt: 1_000, updatedAt: 2_000, outcome: null };
    await f.sender.sendActivity("a".repeat(64), { event: "update", timestamp: 123, priority: 5, contentState });
    expect(f.sent[0]!.headers).toMatchObject({ "apns-topic": `${config.bundleId}.push-type.liveactivity`,
      "apns-push-type": "liveactivity", "apns-priority": "5", "apns-expiration": "423" });
    expect(f.sent[0]!.payload).toEqual({ aps: { timestamp: 123, event: "update", "content-state": contentState, "stale-date": 723 } });
    await f.sender.sendActivity("a".repeat(64), { event: "end", timestamp: 124, priority: 10,
      contentState: { ...contentState, phase: "ended", runningCount: 0 } });
    expect(f.sent[1]!.headers["apns-priority"]).toBe("10");
    expect(f.sent[1]!.payload.aps).toMatchObject({ timestamp: 124, event: "end", "dismissal-date": 424 });
    expect(f.sent[1]!.payload.aps).not.toHaveProperty("stale-date");
    f.sender.close();
  });

  it("accepts longer ActivityKit tokens while keeping the released alert limit", async () => {
    const f = fixture();
    const contentState = { version: 1 as const, phase: "running" as const, runningCount: 1, pendingCount: 0,
      focusKey: null, agentKind: null, startedAt: null, updatedAt: 2_000, outcome: null };
    await f.sender.sendActivity("a".repeat(1024), { event: "update", timestamp: 123, priority: 5, contentState });
    expect(f.sent[0]!.headers[":path"]).toBe(`/3/device/${"a".repeat(1024)}`);
    await expect(f.sender.sendActivity("a".repeat(1025), { event: "update", timestamp: 123, priority: 5, contentState })).rejects.toThrow("activity token");
    await expect(f.sender.send("a".repeat(201), hint)).rejects.toThrow("device token");
    expect(f.sent).toHaveLength(1);
    f.sender.close();
  });
  it("signs a valid ES256 provider token and sends only short-lived wake metadata", async () => {
    const f = fixture();
    await f.sender.send("a".repeat(64), hint);
    expect(mocked.connect).toHaveBeenCalledWith("https://api.push.apple.com");
    const headers = f.sent[0]!.headers;
    const jwt = headers.authorization!.slice(7).split(".");
    expect(JSON.parse(Buffer.from(jwt[0]!, "base64url").toString())).toEqual({ alg: "ES256", kid: config.keyId });
    expect(JSON.parse(Buffer.from(jwt[1]!, "base64url").toString()).iss).toBe(config.teamId);
    expect(verify("sha256", Buffer.from(jwt.slice(0, 2).join(".")), { key: createPublicKey(key), dsaEncoding: "ieee-p1363" }, Buffer.from(jwt[2]!, "base64url"))).toBe(true);
    expect(headers["apns-topic"]).toBe(config.bundleId);
    expect(Number(headers["apns-expiration"])).toBeGreaterThan(Date.now() / 1000);
    expect(Number(headers["apns-expiration"])).toBeLessThanOrEqual(Date.now() / 1000 + 300);
    expect(f.sent[0]!.payload.orbis).toEqual({ v: 1, ...hint });
    expect(Object.keys(f.sent[0]!.payload)).toEqual(["aps", "orbis"]);
    f.sender.close();
  });

  it.each([[410, "Unregistered"], [400, "BadDeviceToken"], [400, "DeviceTokenNotForTopic"]])("retires invalid destinations for %i %s", async (status, reason) => {
    const f = fixture(status as number, reason as string);
    await expect(f.sender.send("a".repeat(64), hint)).resolves.toBe("invalid-token"); f.sender.close();
  });

  it.each([[403, "InvalidProviderToken"], [429, "TooManyRequests"], [500, "InternalServerError"], [503, "ServiceUnavailable"]])("preserves destination on %i %s", async (status, reason) => {
    const f = fixture(status as number, reason as string);
    await expect(f.sender.send("a".repeat(64), hint)).rejects.toThrow(String(reason)); f.sender.close();
  });

  it("does not collapse notifications from two Hosts or reuse a GOAWAY session", async () => {
    const f = fixture();
    await f.sender.send("a".repeat(64), hint);
    f.session.emit("goaway");
    await f.sender.send("a".repeat(64), { ...hint, hostId: "host-two" });
    expect(mocked.connect).toHaveBeenCalledTimes(2);
    expect(f.session.close).toHaveBeenCalled();
    expect(f.sent[0]!.headers["apns-collapse-id"]).not.toBe(f.sent[1]!.headers["apns-collapse-id"]);
    f.sender.close();
  });

  it("does not open a connection for an invalid signing key", async () => {
    const sender = new APNsSender({ ...config, privateKey: "invalid-key" });
    await expect(sender.send("a".repeat(64), hint)).rejects.toThrow();
    expect(mocked.connect).not.toHaveBeenCalled();
  });
});
