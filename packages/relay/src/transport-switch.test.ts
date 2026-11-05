import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { createRelayServer, type RelayServer } from "./index.js";

// Both native adapters terminate at this existing device endpoint. A prepared
// socket must have no ownership; only a valid authentication may retire it.
describe("Relay transport ownership", () => {
  let relay: RelayServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    const closed = sockets.filter(s => s.readyState !== WebSocket.CLOSED).map(s => {
      const result = once(s, "close");
      s.terminate();
      return result;
    });
    await Promise.all(closed);
    sockets.length = 0;
    await relay?.close();
  });

  async function open(path: string): Promise<WebSocket> {
    const socket = new WebSocket(`${relay!.url}${path}`);
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }
  async function exchange(socket: WebSocket, message: unknown): Promise<Record<string, unknown>> {
    const reply = once(socket, "message");
    socket.send(JSON.stringify(message));
    return JSON.parse((await reply)[0].toString()) as Record<string, unknown>;
  }
  const auth = (credential = "device-secret") => ({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential });
  const frame = (tag: string, to = "phone-1") => ({
    type: "v2.frame", protocolVersion: PROTOCOL_VERSION,
    envelope: { v: 2, hdr: { k: "data", room: "host-1", from: "host-1", to, n: 1, ch: "ctl" }, ct: tag },
  });
  async function setup() {
    relay = await createRelayServer({ port: 0, host: "127.0.0.1",
      runtimeCredentials: ["host-secret"], deviceCredentials: [
        { deviceId: "phone-1", credential: "device-secret", name: "first" },
        { deviceId: "phone-2", credential: "other-secret", name: "second" },
      ],
    });
    const host = await open("/v1/runtime");
    expect(await exchange(host, { type: "runtime.authenticate", protocolVersion: PROTOCOL_VERSION,
      credential: "host-secret", role: "host", runtime: { runtimeId: "host-1", name: "test", cwd: "/", status: "idle" },
    })).toMatchObject({ type: "runtime.ready" });
    const active = await open("/v1/device");
    expect(await exchange(active, auth())).toMatchObject({ type: "device.ready" });
    return { host, active };
  }
  async function deliver(host: WebSocket, device: WebSocket, tag: string, to?: string) {
    const received = once(device, "message");
    const message = frame(tag, to);
    host.send(JSON.stringify(message));
    expect(JSON.parse((await received)[0].toString())).toEqual(message);
  }

  it("preparing and cancelling a candidate leaves the active device usable", async () => {
    const { host, active } = await setup();
    const candidate = await open("/v1/device");
    await deliver(host, active, "while-preparing");
    const closed = once(candidate, "close");
    candidate.close();
    await closed;
    await deliver(host, active, "after-cancel");
  });

  it("failed authentication cannot displace the current device", async () => {
    const { host, active } = await setup();
    const candidate = await open("/v1/device");
    expect(await exchange(candidate, auth("invalid"))).toMatchObject({ type: "protocol.error", code: "unauthorized" });
    await deliver(host, active, "after-auth-failure");
  });

  it("valid replacement retires the old socket and its late close cannot erase the new route", async () => {
    const { host, active } = await setup();
    const other = await open("/v1/device");
    expect(await exchange(other, auth("other-secret"))).toMatchObject({ type: "device.ready" });
    const candidate = await open("/v1/device");
    const oldMessages: RawData[] = [];
    active.on("message", data => oldMessages.push(data));
    // Hold the old peer's close reception: the server must revoke its uplink
    // without relying on a completed close handshake on a lossy transport.
    active.pause();
    const closed = once(active, "close", { signal: AbortSignal.timeout(1500) });
    // Attach the rejection handler before waiting for the authentication reply.
    const retirement = expect(closed).resolves.toEqual([4001, Buffer.from("replaced")]);
    expect(await exchange(candidate, auth())).toMatchObject({ type: "device.ready" });
    const uplink = (tag: string) => ({ ...frame(tag), envelope: {
      ...frame(tag).envelope, hdr: { ...frame(tag).envelope.hdr, from: "phone-1", to: "host-1" },
    } });
    const forwarded = once(host, "message");
    active.send(JSON.stringify(uplink("retired-uplink")));
    candidate.send(JSON.stringify(uplink("current-uplink")));
    expect(JSON.parse((await forwarded)[0].toString())).toEqual(uplink("current-uplink"));
    active.resume();
    await retirement;
    await deliver(host, candidate, "new-owner");
    await deliver(host, other, "other-device", "phone-2");
    expect(oldMessages).toEqual([]);
  });
  it("HS2 retires queued ciphertext before a new key's frames can drain", async () => {
    const { host, active } = await setup();
    const messages: Array<Record<string, unknown>> = [];
    active.on("message", raw => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    const backlog = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockReturnValue(10_000_000);
    const old = frame("old-key"); old.envelope.hdr.ch = "msg";
    const handshake = { ...frame("hs2"), envelope: { v: 2, hdr: { k: "hs", room: "host-1", from: "host-1", to: "phone-1", n: 0 }, ct: "e30" } };
    try {
      const hs2 = once(active, "message");
      host.send(JSON.stringify(old)); host.send(JSON.stringify(handshake));
      expect(JSON.parse((await hs2)[0].toString())).toEqual(handshake);
      backlog.mockRestore();
      const next = frame("new-key"); next.envelope.hdr.ch = "msg";
      host.send(JSON.stringify(next));
      await vi.waitFor(() => expect(messages).toContainEqual(next));
      expect(messages).toEqual([handshake, next]);
    } finally { backlog.mockRestore(); }
  });

  it("Host replacement rejects invalid credentials and retires only the previous runtime owner", async () => {
    const { host, active } = await setup();
    const candidate = await open("/v1/runtime");
    const authenticate = (credential: string) => ({ type: "runtime.authenticate", protocolVersion: PROTOCOL_VERSION,
      credential, role: "host", runtime: { runtimeId: "host-1", name: "test", cwd: "/", status: "idle" } });
    expect(await exchange(candidate, authenticate("wrong"))).toMatchObject({ type: "protocol.error", code: "unauthorized" });
    await deliver(host, active, "incumbent-still-live");
    const replacement = await open("/v1/runtime");
    const received: unknown[] = [];
    active.on("message", raw => received.push(JSON.parse(raw.toString())));
    host.pause();
    const closed = once(host, "close", { signal: AbortSignal.timeout(1500) });
    const retirement = expect(closed).resolves.toEqual([4001, Buffer.from("replaced")]);
    expect(await exchange(replacement, authenticate("host-secret"))).toMatchObject({ type: "runtime.ready" });
    host.send(JSON.stringify(frame("retired-host")));
    replacement.send(JSON.stringify(frame("new-host")));
    await vi.waitFor(() => expect(received).toContainEqual(frame("new-host")));
    host.resume(); await retirement;
    expect(received).not.toContainEqual(frame("retired-host"));
    expect(received).not.toContainEqual({ type: "host.offline", hostId: "host-1" });
    const upstream = once(replacement, "message");
    const message = frame("new-runtime-route");
    message.envelope.hdr.from = "phone-1"; message.envelope.hdr.to = "host-1";
    active.send(JSON.stringify(message));
    expect(JSON.parse((await upstream)[0].toString())).toEqual(message);
  });

  it("one device's HS1 retires its pending uplink without discarding the other device", async () => {
    const { host, active } = await setup();
    const other = await open("/v1/device");
    expect(await exchange(other, auth("other-secret"))).toMatchObject({ type: "device.ready" });
    const messages: unknown[] = [];
    host.on("message", raw => messages.push(JSON.parse(raw.toString())));
    const uplink = (sender: string, tag: string) => { const m = frame(tag); m.envelope.hdr.from = sender; m.envelope.hdr.to = "host-1"; m.envelope.hdr.ch = "bulk"; return m; };
    const backlog = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockReturnValue(10_000_000);
    try {
      active.send(JSON.stringify(uplink("phone-1", "old-a")));
      other.send(JSON.stringify(uplink("phone-2", "keep-b")));
      const handshake = { type: "v2.frame", protocolVersion: PROTOCOL_VERSION,
        envelope: { v: 2, hdr: { k: "hs", room: "host-1", from: "phone-1", to: "host-1", n: 0 }, ct: "e30" } };
      active.send(JSON.stringify(handshake));
      await vi.waitFor(() => expect(messages).toContainEqual(handshake));
      backlog.mockRestore();
      active.send(JSON.stringify(uplink("phone-1", "new-a")));
      await vi.waitFor(() => expect(messages).toContainEqual(uplink("phone-1", "new-a")));
      await vi.waitFor(() => expect(messages).toContainEqual(uplink("phone-2", "keep-b")));
      expect(messages).not.toContainEqual(uplink("phone-1", "old-a"));
    } finally { backlog.mockRestore(); }
  });

});
