import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "@pi-remote/protocol";
import { HostRelayClient } from "./relay-client.js";

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
