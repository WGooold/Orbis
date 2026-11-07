import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { HostRelayClient } from "./relay-client.js";
import * as relaySockets from "./relay-socket.js";
import { createRelayServer } from "@orbis/relay";
import { createBusinessRelayServer, relayBusinessHostOptions, stopRelayBusinessTransports } from "./fixtures/relay-business-transport.js";

const expectHandshakeFailure = async (response: object, expected: RegExp): Promise<void> => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.on("connection", (socket) => {
    socket.once("message", () => {
      socket.send(JSON.stringify(response), () => socket.close(1008, "invalid_message"));
    });
  });
  const client = new HostRelayClient({
    relayUrl: `ws://127.0.0.1:${port}`,
    credential: "secret",
    runtime: { runtimeId: "host-1", name: "Host", cwd: "/", status: "idle" },
    onFrame: () => undefined,
    reconnect: false,
  });
  try {
    await expect(client.start()).rejects.toThrow(expected);
  } finally {
    await client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe("Host Relay handshake errors", () => {
  it("prompts an update when Relay sends the dedicated version error", async () => {
    await expectHandshakeFailure({
      type: "protocol.error",
      code: "protocol_version_mismatch",
      message: "Protocol version mismatch. Update Orbis Host to the latest version.",
    }, /协议版本不兼容.*更新到最新版本/u);
  });

  it("prompts an update when Relay rejects the authenticate protocol version", async () => {
    await expectHandshakeFailure({
      type: "protocol.error",
      code: "invalid_message",
      message: "Message does not match the runtime protocol (type=runtime.authenticate, fields=credential,protocolVersion,role,runtime,type, issuePaths=protocolVersion)",
    }, /协议版本不兼容.*更新到最新版本/u);
  });

  it("prompts an update when runtime.ready has an incompatible protocol version", async () => {
    await expectHandshakeFailure({
      type: "runtime.ready",
      protocolVersion: PROTOCOL_VERSION - 1,
      runtimeId: "host-1",
    }, /协议版本不兼容.*更新到最新版本/u);
  });

  it("preserves non-version authentication failures", async () => {
    await expectHandshakeFailure({
      type: "protocol.error",
      code: "unauthorized",
      message: "Invalid runtime credential",
    }, /Relay 认证失败：unauthorized Invalid runtime credential/u);
  });
});

describe("Host Relay transport handoff", () => {
  // NQ-16: exercise policy handoff with local authenticated sockets; native QUIC framing has its own tests.
  it("replaces a QUIC incumbent with WS when selecting Auto and reuses an existing WS", async () => {
    const relay = await createRelayServer({ port: 0, host: "127.0.0.1", runtimeCredentials: ["secret"] });
    const prepare = relaySockets.prepareRelaySocket;
    const selection = vi.spyOn(relaySockets, "prepareRelaySocket").mockImplementation(async (url, mode, signal, options) => {
      const prepared = await prepare(url, "ws", signal, options);
      return { ...prepared, kind: mode === "quic" ? "quic" : "ws" };
    });
    const client = new HostRelayClient({ relayUrl: relay.url, credential: "secret", transportMode: "quic",
      runtime: { runtimeId: "host-auto", name: "Host", cwd: "/", status: "idle" }, onFrame: () => undefined, reconnect: false });
    try {
      await client.start();
      expect(client.transportKind).toBe("quic");
      await client.setTransportMode("auto");
      expect(client.state).toBe("connected");
      expect(client.transportMode).toBe("auto");
      expect(client.transportKind).toBe("ws");
      expect(selection).toHaveBeenCalledTimes(2);
      await client.setTransportMode("ws");
      await client.setTransportMode("auto");
      expect(selection).toHaveBeenCalledTimes(2);
    } finally { await client.stop(); selection.mockRestore(); await relay.close(); }
  });

  it("keeps the authenticated incumbent when a forced QUIC candidate has no advertisement", async () => {
    const relay = await createRelayServer({ port: 0, host: "127.0.0.1", runtimeCredentials: ["secret"] });
    const states: string[] = [];
    const client = new HostRelayClient({ relayUrl: relay.url, credential: "secret",
      runtime: { runtimeId: "host-1", name: "Host", cwd: "/", status: "idle" },
      onFrame: () => undefined, onStateChange: state => states.push(state), reconnect: false });
    try {
      await client.start();
      await expect(client.setTransportMode("quic")).rejects.toThrow("QUIC");
      expect(client.state).toBe("connected"); expect(client.transportKind).toBe("ws");
      expect(states).toEqual(["connecting", "connected"]);
      await client.setTransportMode("auto");
      expect(client.transportKind).toBe("ws");
    } finally { await client.stop(); await relay.close(); }
  });

  it("authenticates only the latest selection and joins repeated handoffs and shutdown", async () => {
    const relay = await createBusinessRelayServer({ port: 0, host: "127.0.0.1", runtimeCredentials: ["secret"] });
    const options = relayBusinessHostOptions(relay.url);
    const client = new HostRelayClient({ relayUrl: relay.url, credential: "secret",
      ...(options.relayTransport === undefined ? {} : { transportMode: options.relayTransport }),
      ...(options.relaySocketOptions === undefined ? {} : { socketOptions: options.relaySocketOptions }),
      runtime: { runtimeId: "host-1", name: "Host", cwd: "/", status: "idle" }, onFrame: () => undefined, reconnect: false });
    try {
      await client.start();
      expect(client.transportKind).toBe(options.relayTransport ?? "ws");
      // NQ-16: Auto must hand an existing QUIC connection back to WS too.
      await client.setTransportMode("auto");
      expect(client.transportMode).toBe("auto");
      expect(client.transportKind).toBe("ws");
      for (let n = 0; n < 3; n++) {
        const incumbent = client.transportKind!;
        const obsolete = client.setTransportMode(incumbent === "ws" ? "quic" : "ws").then(() => "ready", () => "superseded");
        await client.setTransportMode(incumbent);
        expect(await obsolete).toBe("superseded");
        await client.setTransportMode("ws");
        expect(client.transportKind).toBe("ws");
        await client.setTransportMode(options.relayTransport ?? "ws");
        expect(client.transportKind).toBe(options.relayTransport ?? "ws");
      }
      const canceled = client.setTransportMode(client.transportKind === "ws" ? "quic" : "ws").catch(() => undefined);
      await client.stop(); await canceled;
      expect(client.state).toBe("closed"); expect(client.transportKind).toBeUndefined();
    } finally { await client.stop(); await stopRelayBusinessTransports(); await relay.close(); }
  });

  it("does not redial another transport after runtime authentication is rejected", async () => {
    const relay = await createBusinessRelayServer({ port: 0, host: "127.0.0.1", runtimeCredentials: ["correct"] });
    const options = relayBusinessHostOptions(relay.url);
    const errors: string[] = [];
    const client = new HostRelayClient({ relayUrl: relay.url, credential: "wrong", transportMode: "auto",
      ...(options.relaySocketOptions === undefined ? {} : { socketOptions: options.relaySocketOptions }),
      runtime: { runtimeId: "host-1", name: "Host", cwd: "/", status: "idle" }, onFrame: () => undefined,
      onProtocolError: code => errors.push(code), reconnect: false });
    try {
      await expect(client.start()).rejects.toThrow("unauthorized");
      expect(errors).toEqual(["unauthorized"]);
      expect(client.state).toBe("closed");
    } finally { await client.stop(); await stopRelayBusinessTransports(); await relay.close(); }
  });
});
