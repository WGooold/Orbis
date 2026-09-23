import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  type EnvelopeV2,
} from "@pi-remote/protocol";
import { createRelayServer, type RelayServer } from "./index.js";

const openSocket = async (url: string): Promise<WebSocket> => {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
};

const nextMessage = async (socket: WebSocket, timeoutMs = 5_000): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.off("message", onMessage);
    reject(new Error(`timed out waiting for JSON message after ${timeoutMs}ms`));
  }, timeoutMs);
  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) return;
    clearTimeout(timer);
    socket.off("message", onMessage);
    try {
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch (error) {
      reject(error);
    }
  };
  socket.on("message", onMessage);
});

const noMessage = async (socket: WebSocket, timeoutMs = 100): Promise<boolean> => new Promise((resolve) => {
  const onMessage = (): void => {
    clearTimeout(timer);
    resolve(false);
  };
  const timer = setTimeout(() => {
    socket.off("message", onMessage);
    resolve(true);
  }, timeoutMs);
  socket.once("message", onMessage);
});

describe("relay online runtime discovery", () => {
  let relay: RelayServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await relay?.close();
  });

  // (a) 的不变量：中继上的"运行时"入口会把该连接的事件**明文**广播给设备，
  // 所以它只能由网关（Host）使用。agent 身份一律拒之门外——扩展在找不到本机 Host 时
  // 也不再回落到中继（见 pi-extension 的 resolveRuntimeTransport）。
  it("只接受网关：agent 身份的 runtime 连不上中继", async () => {
    relay = await createRelayServer({
      port: 0,
      runtimeCredentials: ["runtime-secret"],
      deviceCredentials: [{ deviceId: "phone-1", credential: "device-secret", name: "Pixel" }],
    });
    const runtime = await openSocket(`${relay.url}/v1/runtime`);
    sockets.push(runtime);
    const closed = once(runtime, "close");
    runtime.send(JSON.stringify({
      type: "runtime.authenticate",
      role: "agent",
      protocolVersion: PROTOCOL_VERSION,
      credential: "runtime-secret",
      runtime: { runtimeId: "runtime-a", name: "A", cwd: "/work", status: "idle" },
    }));
    await expect(nextMessage(runtime)).resolves.toMatchObject({
      type: "protocol.error",
      code: "runtime_role_not_allowed",
    });
    await closed;
  });

  it("不给手机播网关（role=host）：它是路由端点，不是一条进程", async () => {
    relay = await createRelayServer({
      port: 0,
      runtimeCredentials: ["runtime-secret"],
      deviceCredentials: [{ deviceId: "phone-1", credential: "device-secret", name: "Pixel" }],
    });

    const gateway = await openSocket(`${relay.url}/v1/runtime`);
    sockets.push(gateway);
    gateway.send(JSON.stringify({
      type: "runtime.authenticate",
      protocolVersion: PROTOCOL_VERSION,
      credential: "runtime-secret",
      role: "host",
      runtime: { runtimeId: "host-1", name: "devbox", cwd: "/home/dev", status: "idle" },
    }));
    await expect(nextMessage(gateway)).resolves.toMatchObject({ type: "runtime.ready", runtimeId: "host-1" });

    const device = await openSocket(`${relay.url}/v1/device`);
    sockets.push(device);
    device.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "device-secret" }));
    // 目录里没有网关自己。播了的话，手机上会凭空多出一条 cwd 是用户目录的假进程，
    // 而真正的 Pi 进程反而看起来全不在线。
    await expect(nextMessage(device)).resolves.toMatchObject({ type: "device.ready", runtimes: [] });
    // 也**不播**「网关上线了」——否则手机连上之后又会把它加回来。
    await expect(noMessage(device)).resolves.toBe(true);

    // 但它照样是可达的：v2 帧按 `hdr.to = hostId` 路由，靠的正是这张表。
    const envelope: EnvelopeV2 = {
      v: 2,
      hdr: { k: "data", room: "host-1", from: "phone-1", to: "host-1", n: 1, ch: "ctl" },
      ct: "opaque",
    };
    const forwarded = nextMessage(gateway);
    device.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope }));
    await expect(forwarded).resolves.toEqual({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope });

    // 网关断开必须显式告诉手机（host.offline）：手机的 WS 不会断，不重握手的话
    // 新 Host 进程的握手永远 not_ready，所有请求石沉大海而 UI 还显示「已连接」。
    gateway.close();
    await expect(nextMessage(device)).resolves.toMatchObject({ type: "host.offline", hostId: "host-1" });
  });

  it("设备在线时 Host 网关注册/退出 → 手机收到 host.online / host.offline", async () => {
    relay = await createRelayServer({
      port: 0,
      runtimeCredentials: ["runtime-secret"],
      deviceCredentials: [{ deviceId: "phone-1", credential: "device-secret", name: "Pixel" }],
    });

    const device = await openSocket(`${relay.url}/v1/device`);
    sockets.push(device);
    device.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "device-secret" }));
    await expect(nextMessage(device)).resolves.toMatchObject({ type: "device.ready" });

    // Host 后上线：手机立刻收到 host.online（触发重握手），但不播 runtime.online（不进目录）。
    const gateway = await openSocket(`${relay.url}/v1/runtime`);
    sockets.push(gateway);
    gateway.send(JSON.stringify({
      type: "runtime.authenticate",
      protocolVersion: PROTOCOL_VERSION,
      credential: "runtime-secret",
      role: "host",
      runtime: { runtimeId: "host-1", name: "devbox", cwd: "/home/dev", status: "idle" },
    }));
    await expect(nextMessage(device)).resolves.toMatchObject({ type: "host.online", hostId: "host-1" });

    // 退出：host.offline，而不是 runtime.offline。
    gateway.close();
    await expect(nextMessage(device)).resolves.toMatchObject({
      type: "host.offline",
      hostId: "host-1",
      reason: expect.any(String),
    });
  });

  it("does not reveal runtimes to an unauthenticated device", async () => {
    relay = await createRelayServer({ port: 0, runtimeCredentials: ["runtime-secret"] });
    const device = await openSocket(`${relay.url}/v1/device`);
    sockets.push(device);
    device.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "wrong" }));

    await expect(nextMessage(device)).resolves.toMatchObject({
      type: "protocol.error",
      code: "unauthorized",
    });
    await once(device, "close");
  });

  it("persists only the hashed device credential across Relay restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-relay-"));
    const stateFile = join(directory, "state.json");
    relay = await createRelayServer({ port: 0, adminToken: "owner-secret", stateFile });
    const httpUrl = relay.url.replace("ws://", "http://");
    const codeResponse = await fetch(`${httpUrl}/v1/pairing-codes`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret" },
    });
    const { code } = await codeResponse.json() as { code: string };
    const pairingResponse = await fetch(`${httpUrl}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: "Persistent Pixel" }),
    });
    const paired = await pairingResponse.json() as { deviceId: string; credential: string };
    await relay.close();

    relay = await createRelayServer({ port: 0, adminToken: "owner-secret", stateFile });
    const device = await openSocket(`${relay.url}/v1/device`);
    sockets.push(device);
    device.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: paired.credential }));
    await expect(nextMessage(device)).resolves.toMatchObject({
      type: "device.ready",
      deviceId: paired.deviceId,
    });
  });

  it("exchanges a one-time pairing code for a revocable device credential", async () => {
    relay = await createRelayServer({ port: 0, adminToken: "owner-secret" });
    const httpUrl = relay.url.replace("ws://", "http://");

    const codeResponse = await fetch(`${httpUrl}/v1/pairing-codes`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret" },
    });
    expect(codeResponse.status).toBe(201);
    const { code } = await codeResponse.json() as { code: string };

    const pairingResponse = await fetch(`${httpUrl}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: "Pixel 9" }),
    });
    expect(pairingResponse.status).toBe(201);
    const paired = await pairingResponse.json() as { deviceId: string; credential: string };

    const reusedCode = await fetch(`${httpUrl}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, deviceName: "attacker" }),
    });
    expect(reusedCode.status).toBe(401);

    const device = await openSocket(`${relay.url}/v1/device`);
    sockets.push(device);
    device.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: paired.credential }));
    await expect(nextMessage(device)).resolves.toMatchObject({ type: "device.ready", deviceId: paired.deviceId });

    const devicesResponse = await fetch(`${httpUrl}/v1/devices`, {
      headers: { authorization: "Bearer owner-secret" },
    });
    await expect(devicesResponse.json()).resolves.toMatchObject({
      devices: [expect.objectContaining({ deviceId: paired.deviceId, name: "Pixel 9" })],
    });

    const revokeResponse = await fetch(`${httpUrl}/v1/device`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${paired.credential}` },
    });
    expect(revokeResponse.status).toBe(204);
    await once(device, "close");

    const revoked = await openSocket(`${relay.url}/v1/device`);
    sockets.push(revoked);
    revoked.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: paired.credential }));
    await expect(nextMessage(revoked)).resolves.toMatchObject({ type: "protocol.error", code: "unauthorized" });
  });
});

describe("relay v2 frame routing", () => {
  let relay: RelayServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await relay?.close();
  });

  /** 起一对已认证的 runtime + device，并把认证期的噪声消息消费掉。 */
  const connectedPair = async (): Promise<{ runtime: WebSocket; device: WebSocket }> => {
    relay = await createRelayServer({
      port: 0,
      runtimeCredentials: ["runtime-secret"],
      deviceCredentials: [{ deviceId: "phone-1", credential: "device-secret", name: "Pixel" }],
    });

    const runtime = await openSocket(`${relay.url}/v1/runtime`);
    sockets.push(runtime);
    runtime.send(JSON.stringify({
      type: "runtime.authenticate",
      role: "host",
      protocolVersion: PROTOCOL_VERSION,
      credential: "runtime-secret",
      runtime: { runtimeId: "host-1", name: "host", cwd: "/work", status: "idle" },
    }));
    await nextMessage(runtime);

    const device = await openSocket(`${relay.url}/v1/device`);
    sockets.push(device);
    device.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "device-secret" }));
    await nextMessage(device);
    return { runtime, device };
  };

  it("forwards opaque v2 frames both ways and never rewrites ct", async () => {
    const { runtime, device } = await connectedPair();

    const toHost: EnvelopeV2 = {
      v: 2,
      hdr: { k: "data", room: "host-1", from: "phone-1", to: "host-1", n: 1, ch: "ctl" },
      ct: "not-a-real-ciphertext",
    };
    const forwardedToHost = nextMessage(runtime);
    device.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: toHost }));
    await expect(forwardedToHost).resolves.toEqual({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: toHost });

    const toDevice: EnvelopeV2 = {
      v: 2,
      hdr: { k: "data", room: "host-1", from: "host-1", to: "phone-1", n: 1, ch: "ctl" },
      ct: "another-opaque-blob",
    };
    const forwardedToDevice = nextMessage(device);
    runtime.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: toDevice }));
    await expect(forwardedToDevice).resolves.toEqual({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: toDevice });
  });

  // 写入层切片（issue 03）：片也是 `v2.frame`，只是 `hdr.k = "piece"`——中继照旧只按
  // `hdr.to` 路由、按 `hdr.ch` 排队，**不重组也不需要理解 `ct`**。这条用例把那个前提钉住：
  // 若哪天有人给中继加"重组后再转发"，它会立刻红。
  it("片帧按 hdr.to 原样转发：中继不重组、也不改写 ct", async () => {
    const { runtime, device } = await connectedPair();

    const piece: EnvelopeV2 = {
      v: 2,
      hdr: {
        k: "piece",
        room: "host-1",
        from: "phone-1",
        to: "host-1",
        n: 4,
        ch: "bulk",
        ik: "bin",
        mid: "piece-1",
        idx: 0,
        last: false,
      },
      ct: "A".repeat(64),
    };
    const forwarded = nextMessage(runtime);
    device.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: piece }));
    await expect(forwarded).resolves.toEqual({
      type: "v2.frame",
      protocolVersion: PROTOCOL_VERSION,
      envelope: piece,
    });
  });

  it("refuses a v2 frame claiming another device's identity", async () => {
    const { device } = await connectedPair();

    const forged = nextMessage(device);
    device.send(JSON.stringify({
      type: "v2.frame",
      protocolVersion: PROTOCOL_VERSION,
      envelope: {
        v: 2,
        hdr: { k: "data", room: "host-1", from: "phone-2", to: "host-1", n: 1, ch: "ctl" },
        ct: "forged",
      },
    }));
    await expect(forged).resolves.toMatchObject({ type: "protocol.error", code: "device_mismatch" });
  });

  it("tells the runtime when the destination device is offline", async () => {
    relay = await createRelayServer({ port: 0, runtimeCredentials: ["runtime-secret"] });
    const runtime = await openSocket(`${relay.url}/v1/runtime`);
    sockets.push(runtime);
    runtime.send(JSON.stringify({
      type: "runtime.authenticate",
      role: "host",
      protocolVersion: PROTOCOL_VERSION,
      credential: "runtime-secret",
      runtime: { runtimeId: "host-1", name: "host", cwd: "/work", status: "idle" },
    }));
    await nextMessage(runtime);

    const error = nextMessage(runtime);
    runtime.send(JSON.stringify({
      type: "v2.frame",
      protocolVersion: PROTOCOL_VERSION,
      envelope: {
        v: 2,
        hdr: { k: "data", room: "host-1", from: "host-1", to: "phone-9", n: 1, ch: "ctl" },
        ct: "nobody-home",
      },
    }));
    await expect(error).resolves.toMatchObject({
      type: "protocol.error",
      code: "device_offline",
      // v2 载荷是端到端加密的，中继取不到 transferId；只有 `hdr.to` 能让 Host 知道
      // 是哪台设备不在了——没有它，Host 只能对着黑洞一窗一窗重传分片。
      targetDeviceId: "phone-9",
    });
  });
});
