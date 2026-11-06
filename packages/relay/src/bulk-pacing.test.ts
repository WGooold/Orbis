import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type MuxChannel } from "@orbis/protocol";
import { createRelayServer, type RelayServer } from "./index.js";

describe("NQ-15 Relay download pacing", () => {
  let relay: RelayServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await relay?.close();
    relay = undefined;
  });
  async function connect(path: string, message: unknown): Promise<WebSocket> {
    const socket = new WebSocket(`${relay!.url}/v1/${path}`);
    sockets.push(socket);
    await once(socket, "open");
    const reply = once(socket, "message", { signal: AbortSignal.timeout(3000) });
    socket.send(JSON.stringify(message));
    expect(JSON.parse(String((await reply)[0])).type).toBe(path === "runtime" ? "runtime.ready" : "device.ready");
    return socket;
  }
  async function setup(rate: number) {
    relay = await createRelayServer({ bulkBytesPerSecond: rate, runtimeCredentials: ["host-secret"], deviceCredentials: [1, 2].map(n => ({
      deviceId: `phone-${n}`, credential: `phone-secret-${n}`, name: `phone-${n}`, hostId: `host-${n}`,
    })) });
    const pairs = [];
    for (const n of [1, 2]) {
      const host = await connect("runtime", { type: "runtime.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "host-secret", role: "host",
        runtime: { runtimeId: `host-${n}`, name: "test", cwd: "/", status: "idle" } });
      const device = await connect("device", { type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: `phone-secret-${n}` });
      pairs.push({ host, device, n });
    }
    return pairs;
  }
  const frame = (n: number, channel: MuxChannel, sequence: number, ct = "control") => ({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION,
    envelope: { v: 2, hdr: { k: "data", room: `host-${n}`, from: `host-${n}`, to: `phone-${n}`, ch: channel, n: sequence }, ct } });

  // Real authenticated sockets from two different Hosts must share one server
  // allowance; verify delivery order/content and the aggregate byte/time bound.
  it("shares encoded-byte credit across Hosts while ctl/msg overtake queued downloads", async () => {
    const rate = 128 * 1024;
    const pairs = await setup(rate);
    const received: Array<{ peer: number; channel: string; sequence: number; bytes: number; at: number }> = [];
    let startedAt = 0;
    for (const { device, n } of pairs) device.on("message", raw => {
      const message = JSON.parse(String(raw)) as ReturnType<typeof frame>;
      received.push({ peer: n, channel: message.envelope.hdr.ch, sequence: message.envelope.hdr.n, bytes: Buffer.byteLength(String(raw)), at: performance.now() - startedAt });
    });
    const bulkFrames = pairs.flatMap(({ n }) => Array.from({ length: 12 }, (_, i) => frame(n, "bulk", i + 1, "A".repeat(8192))));
    startedAt = performance.now();
    for (const { host, n } of pairs) {
      for (const message of bulkFrames.filter(message => message.envelope.hdr.from === `host-${n}`)) host.send(JSON.stringify(message));
      host.send(JSON.stringify(frame(n, "ctl", 1)));
      host.send(JSON.stringify(frame(n, "msg", 1)));
    }
    await vi.waitFor(() => expect(received).toHaveLength(28), { timeout: 4000 });
    let bulkBytes = 0;
    for (const sample of received.filter(sample => sample.channel === "bulk")) {
      bulkBytes += sample.bytes;
      // Allow 10 ms only for observation timing around the initial send.
      expect(bulkBytes).toBeLessThanOrEqual(65_536 + rate * (sample.at + 10) / 1000);
    }
    for (const { n } of pairs) {
      const messages = received.filter(sample => sample.peer === n);
      expect(messages.filter(sample => sample.channel === "bulk").map(sample => sample.sequence)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(messages.findIndex(sample => sample.channel === "ctl")).toBeLessThan(messages.length - 2);
      expect(messages.findIndex(sample => sample.channel === "msg")).toBeLessThan(messages.length - 1);
    }
    expect(bulkBytes).toBe(bulkFrames.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0));
  });

  // HS2 must retire both old ciphertext and its waiting place. Otherwise an
  // obsolete owner's long credit delay can stall unrelated authenticated Hosts.
  it("releases a rate-limited session on HS2 without blocking another Host", async () => {
    const [a, b] = await setup(4096);
    const seen: string[] = [];
    a!.device.on("message", raw => seen.push((JSON.parse(String(raw)) as ReturnType<typeof frame>).envelope.ct));
    async function deliver(host: WebSocket, device: WebSocket, message: unknown) {
      const reply = once(device, "message", { signal: AbortSignal.timeout(1000) });
      host.send(JSON.stringify(message));
      return JSON.parse(String((await reply)[0])) as ReturnType<typeof frame>;
    }
    await deliver(a!.host, a!.device, frame(1, "bulk", 1, "A".repeat(65_536)));
    a!.host.send(JSON.stringify(frame(1, "bulk", 2, "old-key".padEnd(8192, "A"))));
    await deliver(a!.host, a!.device, frame(1, "ctl", 1, "queued-a"));
    const other: string[] = [];
    b!.device.on("message", raw => other.push((JSON.parse(String(raw)) as ReturnType<typeof frame>).envelope.ct));
    b!.host.send(JSON.stringify(frame(2, "bulk", 1, "other-host")));
    await deliver(b!.host, b!.device, frame(2, "ctl", 1, "queued-b"));
    expect(other).toEqual(["queued-b"]);
    await deliver(a!.host, a!.device, { type: "v2.frame", protocolVersion: PROTOCOL_VERSION,
      envelope: { v: 2, hdr: { k: "hs", room: "host-1", from: "host-1", to: "phone-1", n: 0 }, ct: "e30" } });
    await vi.waitFor(() => expect(other).toContain("other-host"), { timeout: 1000 });
    expect(seen.some(ct => ct.startsWith("old-key"))).toBe(false);
    expect((await deliver(a!.host, a!.device, frame(1, "bulk", 1, "new-key"))).envelope.ct).toBe("new-key");
  });

  // Reject typo/NaN rates instead of creating a permanently stalled queue or a
  // 1 ms timer loop in production.
  it("rejects invalid configured rates before opening a listener", async () => {
    for (const bulkBytesPerSecond of [-1, NaN, Infinity, 0.5]) {
      await expect(createRelayServer({ bulkBytesPerSecond })).rejects.toThrow("bulkBytesPerSecond");
    }
  });
});
