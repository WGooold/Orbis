import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { APNsSender } from "./apns.js";
import * as httpUtils from "./http-utils.js";
import { createRelayServer, type RelayServer, type RelayServerOptions } from "./index.js";

vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const oldToken = "a".repeat(64), newToken = "b".repeat(64);
const devices = [
  { deviceId: "phone", credential: "phone-secret", name: "phone", hostId: "host" },
  { deviceId: "tablet", credential: "tablet-secret", name: "tablet", hostId: "host" },
  { deviceId: "other", credential: "other-secret", name: "other", hostId: "other-host" },
];
const apns = { keyId: "ABCDEFGHIJ", teamId: "KLMNOPQRST", bundleId: "com.example.app", privateKey: "not-used", environment: "production" as const };

// APNS-L01: exercise the real authenticated HTTP/WS routes with synthetic devices;
// only Apple's transport is replaced. No production credential or device is used.
describe("push registration lifecycle", () => {
  let relay: RelayServer;
  let stateFile: string;
  const sockets: WebSocket[] = [];
  const start = async (options: RelayServerOptions = {}, pushEnabled = true) => {
    stateFile ??= join(await testDirectory(join(tmpdir(), "orbis-push-lifecycle-")), "relay.json");
    relay = await createRelayServer({ port: 0, stateFile, ...(pushEnabled ? { apns } : {}), runtimeCredentials: ["host-secret"], deviceCredentials: devices, ...options });
    return relay;
  };
  const request = (path: string, credential: string, body?: unknown, method = "POST") => fetch(relay.url.replace("ws:", "http:") + path, {
    method, headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const register = (token: string | null, credential = "phone-secret", extra = {}) => request("/v1/push/register", credential, { token, ...extra });
  const tokens = async () => (JSON.parse(await readFile(`${stateFile}.push.json`, "utf8")) as { tokens: Array<{ deviceId: string; token: string }> }).tokens;
  const connectHost = async () => {
    const socket = new WebSocket(relay.url + "/v1/runtime"); sockets.push(socket);
    await once(socket, "open");
    const ready = once(socket, "message");
    socket.send(JSON.stringify({ type: "runtime.authenticate", role: "host", protocolVersion: PROTOCOL_VERSION,
      credential: "host-secret", runtime: { runtimeId: "host", name: "host", cwd: "/", status: "idle" } }));
    await ready;
  };
  const wake = (deviceIds = ["phone"]) => request("/v1/push/wake", "host-secret", { hostId: "host", deviceIds, category: "task-completed", eventId: "event" });
  afterEach(async () => {
    sockets.splice(0).forEach(socket => socket.close());
    await relay?.close(); vi.restoreAllMocks(); stateFile = undefined!;
  });

  it.each([newToken, oldToken])("preserves a fresh registration %s when an old in-flight send returns 410", async replacement => {
    await start(); await connectHost(); await register(oldToken);
    let finish!: (result: "invalid-token") => void;
    const send = vi.spyOn(APNsSender.prototype, "send").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = wake();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((await register(replacement)).status).toBe(204);
    finish("invalid-token"); await pending;
    expect(await tokens()).toEqual([expect.objectContaining({ deviceId: "phone", token: replacement })]);
  });

  it("allows unregistering after push credentials have been disabled", async () => {
    await start(); await register(oldToken); await relay.close();
    await start({}, false);
    expect((await register(null)).status).toBe(204);
    expect(await tokens()).toEqual([]);
  });

  it("rejects a sandbox token on a production relay without overwriting the working token", async () => {
    await start(); await register(oldToken);
    expect((await register(newToken, "phone-secret", { environment: "sandbox" })).status).toBe(409);
    expect(await tokens()).toEqual([expect.objectContaining({ token: oldToken })]);
  });

  it("advertises the environment only to currently paired devices", async () => {
    await start();
    expect((await request("/v1/push/config", "wrong", undefined, "GET")).status).toBe(401);
    const config = await request("/v1/push/config", "phone-secret", undefined, "GET");
    expect(await config.json()).toEqual({ version: 1, environment: "production" });
    await request("/v1/device", "phone-secret", undefined, "DELETE");
    expect((await request("/v1/push/config", "phone-secret", undefined, "GET")).status).toBe(401);
    await relay.close(); await start({}, false);
    expect((await request("/v1/push/config", "tablet-secret", undefined, "GET")).status).toBe(503);
  });

  // Authentication must be checked again after asynchronous body reception:
  // a request admitted before revocation cannot restore a deleted destination.
  it("does not resurrect a revoked device after its slow request body finishes", async () => {
    await start(); await register(oldToken);
    const original = httpUtils.readJson;
    let reading = false;
    vi.spyOn(httpUtils, "readJson").mockImplementation(request => {
      if (request.url === "/v1/push/register") reading = true;
      return original(request);
    });
    const pending = httpRequest(relay.url.replace("ws:", "http:") + "/v1/push/register", {
      method: "POST", headers: { authorization: "Bearer phone-secret", "content-type": "application/json" },
    });
    const response = new Promise<number>(resolve => pending.once("response", incoming => {
      incoming.resume(); resolve(incoming.statusCode!);
    }));
    pending.write('{"token":');
    await vi.waitFor(() => expect(reading).toBe(true));
    expect((await request("/v1/device", "phone-secret", undefined, "DELETE")).status).toBe(204);
    pending.end(JSON.stringify(newToken) + "}");
    expect(await response).toBe(401);
    expect(await tokens()).toEqual([]);
  });

  // APNS-L02: reproduce a slow failed disk write overlapping a newer request;
  // rollback must finish before the later registration becomes authoritative.
  it("does not roll back a later registration when an older persistence fails", async () => {
    await start(); await register(oldToken);
    let fail!: (reason: Error) => void;
    vi.mocked(rename).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const older = register(newToken);
    await vi.waitFor(() => expect(fail).toBeDefined());
    const later = register("c".repeat(64));
    fail(new Error("injected push persistence failure"));
    expect((await older).status).toBe(500);
    expect((await later).status).toBe(204);
    expect(await tokens()).toEqual([expect.objectContaining({ token: "c".repeat(64) })]);
  });

  it("deduplicates the same installation re-paired to the same Host", async () => {
    await start(); await connectHost();
    await register(oldToken); await register(oldToken, "tablet-secret");
    const send = vi.spyOn(APNsSender.prototype, "send").mockResolvedValue("sent");
    expect((await wake(["phone", "tablet", "phone"])).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("restores current registrations across relay restart and keeps different Hosts isolated", async () => {
    await start(); await register(oldToken); await register(newToken); await register(oldToken, "other-secret");
    await relay.close(); await start(); await connectHost();
    const send = vi.spyOn(APNsSender.prototype, "send").mockResolvedValue("sent");
    const result = await wake(["phone", "other"]);
    expect(await result.json()).toMatchObject({ sent: ["phone"], failed: [] });
    expect(send).toHaveBeenCalledExactlyOnceWith(newToken, expect.objectContaining({ hostId: "host" }));
  });

  it("does not revive an orphaned registration from a stale push state file", async () => {
    await start(); await register(oldToken);
    const stale = await readFile(`${stateFile}.push.json`, "utf8");
    expect((await request("/v1/device", "phone-secret", undefined, "DELETE")).status).toBe(204);
    await relay.close(); await writeFile(`${stateFile}.push.json`, stale);
    await start({ deviceCredentials: [] }); await connectHost();
    const send = vi.spyOn(APNsSender.prototype, "send").mockResolvedValue("sent");
    await wake(); expect(send).not.toHaveBeenCalled();
    expect(await tokens()).toEqual([]);
  });

  it("keeps registrations on transient APNs failures and removes a truly stale token", async () => {
    await start(); await connectHost(); await register(oldToken);
    const send = vi.spyOn(APNsSender.prototype, "send").mockRejectedValueOnce(new Error("temporary APNs failure"));
    expect((await wake()).status).toBe(502);
    expect(await tokens()).toHaveLength(1);
    send.mockResolvedValue("invalid-token");
    await wake(); expect(await tokens()).toEqual([]);
  });
});
