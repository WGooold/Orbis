import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { APNsSender } from "./apns.js";
import * as httpUtils from "./http-utils.js";
import { createRelayServer, type RelayServer } from "./index.js";

// LA-R03/05: authenticated HTTP routes use synthetic paired identities and a real
// local Relay. Apple's transport alone is replaced. This covers body/revocation
// races and released alert capability shape without starting a device session.
describe("ActivityKit HTTP routes", () => {
  let relay: RelayServer;
  let stateFile: string;
  const sockets: WebSocket[] = [];
  const start = async (pushEnabled = true, existingStateFile?: string) => {
    stateFile = existingStateFile ?? join(await testDirectory(join(tmpdir(), "orbis-live-http-")), "relay.json");
    relay = await createRelayServer({ port: 0, stateFile, runtimeCredentials: ["host-secret"],
      deviceCredentials: [
        { deviceId: "phone", credential: "phone-secret", name: "phone", hostId: "host" },
        { deviceId: "other", credential: "other-secret", name: "other", hostId: "other-host" },
      ], ...(pushEnabled ? { apns: { keyId: "ABCDEFGHIJ", teamId: "KLMNOPQRST", bundleId: "com.example.app", privateKey: "not-used", environment: "production" as const } } : {}) });
  };
  const request = (path: string, credential: string, body?: unknown, method = "POST") => fetch(relay.url.replace("ws:", "http:") + path, {
    method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const register = (activityId = "first", token: string | null = "a".repeat(64), credential = "phone-secret") =>
    request("/v1/live-activities/register", credential, { version: 1, activityId, token, environment: "production" });
  const publish = (revision = 1, hostId = "host") => request("/v1/live-activities/update", "host-secret", {
    version: 1, hostId, producerId: "producer", revision, event: "update",
    contentState: { version: 1, phase: "running", runningCount: 3, pendingCount: 0, focusKey: null,
      agentKind: null, startedAt: null, updatedAt: Date.now(), outcome: null },
  });
  const connectHost = async () => {
    const socket = new WebSocket(relay.url + "/v1/runtime"); sockets.push(socket);
    await once(socket, "open"); const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "runtime.authenticate", role: "host", protocolVersion: PROTOCOL_VERSION,
      credential: "host-secret", runtime: { runtimeId: "host", name: "host", cwd: "/", status: "idle" } }));
    await ready;
  };
  afterEach(async () => {
    sockets.splice(0).forEach(socket => socket.close()); await relay?.close(); vi.restoreAllMocks();
  });

  it("keeps legacy push config exact and advertises ActivityKit only to paired devices", async () => {
    await start();
    expect((await request("/v1/live-activities/config", "wrong", undefined, "GET")).status).toBe(401);
    expect(await (await request("/v1/live-activities/config", "phone-secret", undefined, "GET")).json()).toEqual({ version: 1, environment: "production" });
    expect(await (await request("/v1/push/config", "phone-secret", undefined, "GET")).json()).toEqual({ version: 1, environment: "production" });
    expect((await request("/v1/live-activities/config?environment=sandbox", "phone-secret", undefined, "GET")).status).toBe(409);
  });

  it("isolates Hosts, checks live Host credentials, and conditionally unregisters old activities", async () => {
    await start();
    const send = vi.spyOn(APNsSender.prototype, "sendActivity").mockResolvedValue("sent");
    expect((await publish()).status).toBe(401);
    await connectHost();
    expect((await register()).status).toBe(204);
    expect((await register("second", "b".repeat(64))).status).toBe(204);
    expect((await register("first", null)).status).toBe(204);
    await register("other", "c".repeat(64), "other-secret");
    expect((await publish(1, "other-host")).status).toBe(401);
    expect((await publish()).status).toBe(200);
    expect(send).toHaveBeenCalledExactlyOnceWith("b".repeat(64), expect.objectContaining({ priority: 5, contentState: { version: 1,
      phase: "running", runningCount: 3, pendingCount: 0, focusKey: null, agentKind: null, startedAt: null, updatedAt: expect.any(Number), outcome: null } }));
    expect((await publish(0)).status).toBe(409);
    await request("/v1/device", "phone-secret", undefined, "DELETE");
    const stored = JSON.parse(await readFile(`${stateFile}.live-activities.json`, "utf8"));
    expect(stored.registrations).toEqual([expect.objectContaining({ deviceId: "other" })]);
    expect((await request("/v1/live-activities/config", "phone-secret", undefined, "GET")).status).toBe(401);
  });

  it("sends the current cached summary when a fresh activity token registers", async () => {
    await start(); await connectHost();
    const send = vi.spyOn(APNsSender.prototype, "sendActivity").mockResolvedValue("sent");
    expect((await publish()).status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    expect((await register()).status).toBe(204);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![1].contentState.runningCount).toBe(3);
  });

  it("accepts Host summaries without retry-provoking errors when APNs is unconfigured", async () => {
    await start(false); await connectHost();
    const send = vi.spyOn(APNsSender.prototype, "sendActivity").mockResolvedValue("sent");
    expect((await request("/v1/live-activities/config", "phone-secret", undefined, "GET")).status).toBe(503);
    expect((await register()).status).toBe(503);
    const result = await publish();
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ sent: [], failed: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps old registrations inert when APNs is removed, while allowing cleanup", async () => {
    await start(); await register(); await relay.close();
    await start(false, stateFile); await connectHost();
    const send = vi.spyOn(APNsSender.prototype, "sendActivity").mockResolvedValue("sent");
    const result = await publish();
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ sent: [], failed: [] });
    expect(send).not.toHaveBeenCalled();
    expect((await register("first", null)).status).toBe(204);
    expect(JSON.parse(await readFile(`${stateFile}.live-activities.json`, "utf8")).registrations).toEqual([]);
  });

  it("returns a retryable failure without losing the token, then deduplicates successful retries", async () => {
    await start(); await connectHost(); await register();
    const send = vi.spyOn(APNsSender.prototype, "sendActivity").mockRejectedValueOnce(new Error("temporary APNs error")).mockResolvedValue("sent");
    const body = { version: 1, hostId: "host", producerId: "producer", revision: 1, event: "update", contentState: {
      version: 1, phase: "running", runningCount: 1, pendingCount: 0, focusKey: null,
      agentKind: null, startedAt: null, updatedAt: Date.now(), outcome: null,
    } };
    const failed = await request("/v1/live-activities/update", "host-secret", body);
    expect(failed.status).toBe(502); expect(await failed.json()).toEqual({ sent: [], failed: ["phone"] });
    expect(JSON.parse(await readFile(`${stateFile}.live-activities.json`, "utf8")).registrations).toHaveLength(1);
    const recovered = await request("/v1/live-activities/update", "host-secret", body);
    expect(recovered.status).toBe(200); expect(await recovered.json()).toEqual({ sent: ["phone"], failed: [] });
    expect((await request("/v1/live-activities/update", "host-secret", body)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("cannot resurrect a revoked device through an already admitted slow registration", async () => {
    await start(); await register();
    let reading = false;
    const original = httpUtils.readJson;
    vi.spyOn(httpUtils, "readJson").mockImplementation(request => {
      if (request.url === "/v1/live-activities/register") reading = true;
      return original(request);
    });
    const pending = httpRequest(relay.url.replace("ws:", "http:") + "/v1/live-activities/register", {
      method: "POST", headers: { authorization: "Bearer phone-secret", "content-type": "application/json" },
    });
    const result = new Promise<number>(resolve => pending.once("response", incoming => { incoming.resume(); resolve(incoming.statusCode!); }));
    pending.write('{"version":1,"activityId":"second","token":');
    await vi.waitFor(() => expect(reading).toBe(true));
    expect((await request("/v1/device", "phone-secret", undefined, "DELETE")).status).toBe(204);
    pending.end(JSON.stringify("b".repeat(64)) + ',"environment":"production"}');
    expect(await result).toBe(401);
    expect(JSON.parse(await readFile(`${stateFile}.live-activities.json`, "utf8")).registrations).toEqual([]);
  });
});
