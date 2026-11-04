import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DeviceHandshake, E2eChannel, HostHandshake, randomKey } from "@orbis/e2e";
import {
  buildHandshakeEnvelope, readHandshakeEnvelope,
} from "@orbis/e2e";
import {
  PROTOCOL_VERSION, RELAY_WIRE_PROTOCOL_VERSIONS, V2FrameSchema,
  type EnvelopeV2,
} from "@orbis/protocol";
import { createRelayServer, type RelayServer } from "./index.js";
import { checkRelayProtocolCompatibility } from "./protocol-smoke.js";

describe("released Relay wire formats", () => {
  let relay: RelayServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await relay?.close();
  });

  const open = async (route: "runtime" | "device"): Promise<WebSocket> => {
    const socket = new WebSocket(`${relay!.url}/v1/${route}`);
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  };
  const next = async (socket: WebSocket): Promise<Record<string, unknown>> => {
    const [raw] = await once(socket, "message", { signal: AbortSignal.timeout(5_000) });
    return JSON.parse(raw.toString()) as Record<string, unknown>;
  };
  const start = async (): Promise<void> => {
    relay = await createRelayServer({
      port: 0, runtimeCredentials: ["test-host-credential"],
      deviceCredentials: [{ deviceId: "phone-1", credential: "test-phone-credential", name: "test", hostId: "host-1" }],
    });
  };
  const auth = async (route: "runtime" | "device", protocolVersion: number): Promise<WebSocket> => {
    const socket = await open(route);
    const ready = next(socket);
    socket.send(JSON.stringify(route === "runtime" ? {
      type: "runtime.authenticate", protocolVersion, role: "host", credential: "test-host-credential",
      runtime: { runtimeId: "host-1", name: "Host", cwd: "/", status: "idle" },
    } : { type: "device.authenticate", protocolVersion, credential: "test-phone-credential" }));
    // Exact released response shapes: extra handshake fields also break strict 18.
    await expect(ready).resolves.toEqual(route === "runtime" ? {
      type: "runtime.ready", protocolVersion, runtimeId: "host-1",
    } : {
      type: "device.ready", protocolVersion, deviceId: "phone-1", notificationEpoch: null, runtimes: [], agents: null,
    });
    return socket;
  };
  const forward = async (from: WebSocket, to: WebSocket, sourceVersion: number, targetVersion: number, envelope: EnvelopeV2): Promise<EnvelopeV2> => {
    const received = next(to);
    from.send(JSON.stringify({ type: "v2.frame", protocolVersion: sourceVersion, envelope }));
    const packet = await received;
    expect(packet).toEqual({ type: "v2.frame", protocolVersion: targetVersion, envelope });
    // Version is a transport property: hdr, MAC, ciphertext and inner version stay intact.
    return V2FrameSchema.parse({ ...packet, protocolVersion: PROTOCOL_VERSION }).envelope;
  };

  it("requires explicit support for the current revision", () => {
    expect(RELAY_WIRE_PROTOCOL_VERSIONS).toEqual([18, 19]);
    expect(RELAY_WIRE_PROTOCOL_VERSIONS).toContain(PROTOCOL_VERSION);
  });

  it("checks both deployed authentication routes without real credentials", async () => {
    await start();
    await expect(checkRelayProtocolCompatibility(relay!.url)).resolves.toBeUndefined();
  });

  it.each([[18, 18], [18, 19], [19, 18], [19, 19]])(
    "Host %s / device %s carries authenticated handshakes, requests, receipts and binary bytes",
    async (hostVersion, deviceVersion) => {
      await start();
      const host = await auth("runtime", hostVersion);
      const device = await auth("device", deviceVersion);
      const psk = randomKey();
      const dh = new DeviceHandshake(psk);
      const hh = new HostHandshake(psk);
      const hs = (from: "phone-1" | "host-1", body: Parameters<typeof buildHandshakeEnvelope>[0]["body"]): EnvelopeV2 =>
        buildHandshakeEnvelope({ room: "host-1", from, to: from === "phone-1" ? "host-1" : "phone-1", body });
      const hello = await forward(device, host, deviceVersion, hostVersion, hs("phone-1", dh.start()));
      const accept = hh.acceptHello(readHandshakeEnvelope(hello) as ReturnType<DeviceHandshake["start"]>);
      const accepted = await forward(host, device, hostVersion, deviceVersion, hs("host-1", accept));
      const confirm = dh.accept(readHandshakeEnvelope(accepted) as typeof accept);
      const confirmed = await forward(device, host, deviceVersion, hostVersion, hs("phone-1", confirm));
      hh.confirm(readHandshakeEnvelope(confirmed) as typeof confirm);
      const dc = new E2eChannel({ keys: dh.keys, role: "device" });
      const hc = new E2eChannel({ keys: hh.keys, role: "host" });
      const request = Buffer.from(JSON.stringify({ type: "session.list", protocolVersion: 18, requestId: "request-1" }));
      const sent = dc.seal({ k: "data", room: "host-1", from: "phone-1", to: "host-1", ch: "ctl", n: 1 }, request);
      expect(hc.open(await forward(device, host, deviceVersion, hostVersion, sent))).toEqual(request);
      const receipt = Buffer.from(JSON.stringify({ type: "session.list.result", requestId: "request-1", sessions: [] }));
      const reply = hc.seal({ k: "data", room: "host-1", from: "host-1", to: "phone-1", ch: "ctl", n: 1 }, receipt);
      expect(dc.open(await forward(host, device, hostVersion, deviceVersion, reply))).toEqual(receipt);
      for (const [sender, recipient, from, to, source, target, sendChannel, receiveChannel] of [
        [device, host, "phone-1", "host-1", deviceVersion, hostVersion, dc, hc],
        [host, device, "host-1", "phone-1", hostVersion, deviceVersion, hc, dc],
      ] as const) {
        const bytes = Buffer.from([0, 18, 19, 128, 255]);
        const chunk = sendChannel.seal({ k: "bin", room: "host-1", from, to, ch: "bulk", n: 1 }, bytes);
        expect(receiveChannel.open(await forward(sender, recipient, source, target, chunk))).toEqual(bytes);
        const piece: EnvelopeV2 = { v: 2, hdr: { ...chunk.hdr, k: "piece", ik: "bin", mid: "chunk-1", idx: 0, last: true }, ct: chunk.ct };
        await forward(sender, recipient, source, target, piece);
      }
    },
  );

  it.each(["runtime", "device"] as const)("binds %s frames to the authenticated version", async (route) => {
    await start();
    const socket = await auth(route, 18);
    const received = next(socket);
    socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: 19, envelope: {
      v: 2, hdr: { k: "data", room: "host-1", from: route === "runtime" ? "host-1" : "phone-1", to: "host-1", ch: "ctl", n: 1 }, ct: "opaque",
    } }));
    await expect(received).resolves.toMatchObject({ type: "protocol.error", code: "protocol_version_mismatch" });
  });

  it.each(["runtime", "device"] as const)("keeps %s credentials mandatory for version 18", async (route) => {
    await start();
    const socket = await open(route);
    const received = next(socket);
    socket.send(JSON.stringify(route === "runtime" ? {
      type: "runtime.authenticate", protocolVersion: 18, role: "host", credential: "wrong",
      runtime: { runtimeId: "host-1", name: "Host", cwd: "/", status: "idle" },
    } : { type: "device.authenticate", protocolVersion: 18, credential: "wrong" }));
    await expect(received).resolves.toMatchObject({ type: "protocol.error", code: "unauthorized" });
  });

  it.each(["runtime", "device"] as const)("retains authenticated %s identity checks for version 18", async (route) => {
    await start();
    const socket = await auth(route, 18);
    const received = next(socket);
    socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: 18, envelope: {
      v: 2, hdr: { k: "data", room: "host-1", from: "another-peer", to: "host-1", ch: "ctl", n: 1 }, ct: "opaque",
    } }));
    await expect(received).resolves.toMatchObject({ type: "protocol.error", code: route === "runtime" ? "runtime_mismatch" : "device_mismatch" });
  });
});
