import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { createRelayServer, type RelayServer } from "./index.js";

describe("Relay device telemetry consent", () => {
  let relay: RelayServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await relay?.close();
    relay = undefined;
  });

  const openDevice = async (): Promise<WebSocket> => {
    const socket = new WebSocket(`${relay!.url}/v1/device`);
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  };
  const sendAndRead = async (socket: WebSocket, message: unknown): Promise<Record<string, unknown>> => {
    const next = once(socket, "message", { signal: AbortSignal.timeout(3_000) });
    socket.send(JSON.stringify(message));
    return JSON.parse(String((await next)[0])) as Record<string, unknown>;
  };
  const auth = (credential: string) => ({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential });
  const frame = () => ({
    type: "v2.frame", protocolVersion: PROTOCOL_VERSION,
    envelope: { v: 2, hdr: { k: "data", room: "host", from: "phone", to: "host", ch: "msg", n: 1 }, ct: "opaque" },
  });
  const login = async (base: string): Promise<string> => {
    const response = await fetch(`${base}/v1/admin/login`, { method: "POST", headers: { origin: base }, body: JSON.stringify({ token: "admin-secret" }) });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };

  it("defaults to off, requires the paired credential, and deletes device detail when consent is withdrawn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-telemetry-consent-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    relay = await createRelayServer({
      stateFile: join(directory, "relay.json"), adminToken: "admin-secret",
      deviceCredentials: [{ deviceId: "phone", credential: "phone-secret", name: "Test phone", hostId: "host" }],
    });
    const base = relay.url.replace("ws:", "http:");
    const deviceURL = `${base}/v1/device/telemetry-consent`;
    expect((await fetch(deviceURL)).status).toBe(401);
    expect((await fetch(deviceURL, { method: "PUT", body: JSON.stringify({ enabled: true }) })).status).toBe(401);

    const cookie = await login(base);
    const dashboard = async (path: "usage" | "bandwidth") => fetch(`${base}/v1/admin/${path}${path === "usage" ? "?granularity=day" : ""}`, { headers: { cookie } }).then(response => response.json());
    const socket = await openDevice();
    const ready = await sendAndRead(socket, auth("phone-secret"));
    expect(ready.type).toBe("device.ready");
    const authorization = { Authorization: "Bearer phone-secret" };
    const consentURL = await fetch(deviceURL, { headers: authorization }).then(response => response.json());
    expect(consentURL).toEqual({ enabled: false });

    // Traffic from a device that has not opted in is neither listed nor retained.
    await sendAndRead(socket, frame());
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await dashboard("bandwidth") as { devices: unknown[] }).devices).toEqual([]);
    const unconsentedUsage = await dashboard("usage") as { users: unknown[]; aggregate: Array<{ websitePageViews: number }> };
    expect(unconsentedUsage.users).toEqual([]);
    expect(unconsentedUsage.aggregate.some(period => period.websitePageViews > 0)).toBe(true);

    const enabled = await fetch(deviceURL, {
      method: "PUT", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ enabled: true });
    await sendAndRead(socket, frame());
    expect((await dashboard("bandwidth") as { devices: Array<{ deviceId: string }> }).devices.map(device => device.deviceId)).toEqual(["phone"]);
    expect((await dashboard("usage") as { users: Array<{ deviceId: string }> }).users.map(device => device.deviceId)).toEqual(["phone"]);

    const disabled = await fetch(deviceURL, {
      method: "PUT", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ enabled: false });
    expect(await fetch(deviceURL, { headers: authorization }).then(response => response.json())).toEqual({ enabled: false });
    expect((await dashboard("bandwidth") as { devices: unknown[] }).devices).toEqual([]);
    expect((await dashboard("usage") as { users: unknown[] }).users).toEqual([]);
  });

  it("rejects malformed consent writes without enabling collection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-telemetry-invalid-consent-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    relay = await createRelayServer({
      stateFile: join(directory, "relay.json"),
      deviceCredentials: [{ deviceId: "phone", credential: "phone-secret", name: "Test phone" }],
    });
    const base = relay.url.replace("ws:", "http:");
    const response = await fetch(`${base}/v1/device/telemetry-consent`, {
      method: "PUT", headers: { Authorization: "Bearer phone-secret", "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, extra: "not accepted" }),
    });
    expect(response.status).toBe(400);
    expect(await fetch(`${base}/v1/device/telemetry-consent`, { headers: { Authorization: "Bearer phone-secret" } }).then(result => result.json()))
      .toEqual({ enabled: false });
  });
});
