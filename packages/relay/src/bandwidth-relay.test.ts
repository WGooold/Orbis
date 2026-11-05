import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { createRelayServer, type RelayServer } from "./index.js";
import type { BandwidthDay } from "./bandwidth.js";

describe("X11 / RELAY-BW-02 authenticated device edge", () => {
  let relay: RelayServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await relay?.close(); relay = undefined; });
  const open = async (path: string): Promise<WebSocket> => {
    const socket = new WebSocket(`${relay!.url}/v1/${path}`);
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  };
  const exchange = async (from: WebSocket, to: WebSocket, text: string): Promise<string> => {
    const next = once(to, "message", { signal: AbortSignal.timeout(3_000) });
    from.send(text);
    return String((await next)[0]);
  };
  const authText = (credential: string) => JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential });
  const frame = (from: string, to: string) => JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: { v: 2, hdr: { k: "data", room: "host", from, to, ch: "msg", n: 1 }, ct: "opaque-你好" } });
  const login = async (base: string): Promise<string> => {
    const login = await fetch(`${base}/v1/admin/login`, { method: "POST", headers: { origin: base }, body: JSON.stringify({ token: "admin-secret" }) });
    expect(login.status).toBe(200);
    return login.headers.get("set-cookie")!.split(";")[0]!;
  };
  type Overview = { devices: Array<{ deviceId: string; name: string; revoked: boolean; today?: BandwidthDay }> };
  const overview = async (base: string, cookie: string): Promise<Overview> => {
    const response = await fetch(`${base}/v1/admin/bandwidth`, { headers: { cookie } });
    expect(response.status).toBe(200);
    return await response.json() as Overview;
  };

  // Verify real WS UTF-8 lengths against both edges; counting Host traffic too would double usage.
  it("protects the report, counts exact UTF-8 device bytes once, and continues after reconnect/restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-bandwidth-relay-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const stateFile = join(directory, "relay.json");
    const options = { stateFile, adminToken: "admin-secret", runtimeCredentials: ["host-secret"], deviceCredentials: [
      { deviceId: "phone", credential: "phone-secret", name: "手机", hostId: "host" },
      { deviceId: "tablet", credential: "tablet-secret", name: "平板", hostId: "host" },
    ] };
    relay = await createRelayServer(options);
    let base = relay.url.replace("ws:", "http:");
    expect((await fetch(`${base}/v1/admin/bandwidth`)).status).toBe(401);
    expect((await fetch(`${base}/v1/admin/bandwidth`, { headers: { authorization: "Bearer host-secret" } })).status).toBe(401);
    let cookie = await login(base);
    expect((await overview(base, cookie)).devices.every(device => device.today === undefined)).toBe(true);
    const host = await open("runtime");
    await exchange(host, host, JSON.stringify({ type: "runtime.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "host-secret", role: "host", runtime: { runtimeId: "host", name: "host", cwd: "/private", status: "idle" } }));
    const rejected = await open("device");
    await exchange(rejected, rejected, authText("wrong"));
    const phone = await open("device"), tablet = await open("device");
    const ready = await exchange(phone, phone, authText("phone-secret"));
    await exchange(tablet, tablet, authText("tablet-secret"));
    const uploaded = frame("phone", "host"), downloaded = frame("host", "phone");
    await exchange(phone, host, uploaded);
    const delivered = await exchange(host, phone, downloaded);
    const first = await overview(base, cookie);
    const phoneBefore = first.devices.find(device => device.deviceId === "phone")!.today!;
    const tabletBefore = first.devices.find(device => device.deviceId === "tablet")!.today!;
    expect(phoneBefore).toMatchObject({ uploadBytes: Buffer.byteLength(authText("phone-secret")) + Buffer.byteLength(uploaded), downloadBytes: Buffer.byteLength(ready) + Buffer.byteLength(delivered) });
    const replacement = await open("device");
    const replaced = once(phone, "close");
    const newReady = await exchange(replacement, replacement, authText("phone-secret"));
    await replaced;
    await exchange(host, replacement, downloaded);
    const after = await overview(base, cookie);
    const expected = {
      uploadBytes: phoneBefore.uploadBytes + Buffer.byteLength(authText("phone-secret")),
      downloadBytes: phoneBefore.downloadBytes + Buffer.byteLength(newReady) + Buffer.byteLength(delivered),
    };
    expect(after.devices.find(device => device.deviceId === "phone")!.today).toMatchObject(expected);
    expect(after.devices.find(device => device.deviceId === "tablet")!.today?.totalBytes).toBe(tabletBefore.totalBytes);
    const text = JSON.stringify(after);
    for (const secret of ["host-secret", "phone-secret", "tablet-secret", "opaque", "/private", "credential"]) expect(text).not.toContain(secret);
    for (const socket of sockets.splice(0)) socket.terminate();
    await relay.close();
    const stored = await readFile(`${stateFile}.bandwidth.json`, "utf8");
    expect(stored).not.toMatch(/secret|opaque|你好|private/);
    relay = await createRelayServer(options);
    base = relay.url.replace("ws:", "http:"); cookie = await login(base);
    expect((await overview(base, cookie)).devices.find(device => device.deviceId === "phone")!.today).toMatchObject(expected);
    expect((await fetch(`${base}/assets/admin.js`).then(response => response.text()))).toContain("设备带宽");
  });
});
