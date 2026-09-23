import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, type RuntimeCommand, type RuntimeEvent, type RuntimeMetadata } from "@pi-remote/protocol";
import { RelayRuntimeTransport } from "./transport.js";

const metadata: RuntimeMetadata = {
  runtimeId: "runtime-a",
  name: "test runtime",
  cwd: "/work/test",
  status: "idle",
};

describe("RelayRuntimeTransport", () => {
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  let transport: RelayRuntimeTransport | undefined;

  afterEach(async () => {
    transport?.close();
    await new Promise<void>((resolve) => wss?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  });

  const listen = async (options: { autoPong?: boolean } = {}): Promise<{ url: string; connection: Promise<WebSocket> }> => {
    server = createServer();
    wss = new WebSocketServer({
      noServer: true,
      ...(options.autoPong === undefined ? {} : { autoPong: options.autoPong }),
    });
    server.on("upgrade", (request, socket, head) => {
      wss!.handleUpgrade(request, socket, head, (client) => wss!.emit("connection", client, request));
    });
    const connection = once(wss, "connection").then(([socket]) => socket as WebSocket);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return { url: `ws://127.0.0.1:${address.port}`, connection };
  };

  it("authenticates outbound, sequences events, and delivers commands", async () => {
    const relay = await listen();
    const connected = vi.fn();
    const command = vi.fn<(commandId: string, runtimeId: string, command: RuntimeCommand) => void>();
    const error = vi.fn<(message: string, recoverable: boolean) => void>();
    const states: string[] = [];
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      reconnect: false,
      onConnectionStateChange: (state) => states.push(state),
    });

    await transport.start(metadata, { connected, resync: vi.fn(), command, error });
    const socket = await relay.connection;
    const [authentication] = await once(socket, "message");
    expect(JSON.parse(authentication.toString())).toMatchObject({
      type: "runtime.authenticate",
      role: "agent",
      protocolVersion: PROTOCOL_VERSION,
      credential: "runtime-secret",
      runtime: metadata,
    });

    socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime-a" }));
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());

    const event: RuntimeEvent = { type: "runtime.status", status: "running" };
    transport.publish(event);
    const [published] = await once(socket, "message");
    const publishedEvent = JSON.parse(published.toString());
    expect(publishedEvent).toEqual({
      type: "runtime.event",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: "runtime-a",
      sequence: expect.any(Number),
      event,
    });
    expect(publishedEvent.sequence).toBeGreaterThan(1_000_000_000);

    socket.send(JSON.stringify({
      type: "runtime.command",
      protocolVersion: PROTOCOL_VERSION,
      runtimeId: "runtime-a",
      commandId: "stop-1",
      command: { type: "stop" },
    }));
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith("stop-1", "runtime-a", { type: "stop" }));
    socket.send(JSON.stringify({ type: "protocol.error", code: "unauthorized", message: "bad credential" }));
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("bad credential", false));
    expect(states).toContain("error");
  });

  it("serializes deeply nested and circular runtime event payloads safely", async () => {
    const relay = await listen();
    const connected = vi.fn();
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      reconnect: false,
    });
    await transport.start(metadata, { connected, resync: vi.fn(), command: vi.fn() });
    const socket = await relay.connection;
    await once(socket, "message");
    socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime-a" }));
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());

    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 20_000; index += 1) nested = { nested };
    const circular: Record<string, unknown> = { nested };
    circular.self = circular;

    const eventPromise = once(socket, "message");
    transport.publish({ type: "tool.updated", toolCallId: "tool-1", toolName: "test", partialResult: circular });
    const [raw] = await eventPromise;
    const message = JSON.parse(raw.toString()) as { event?: { partialResult?: { self?: string } } };
    expect(message.event?.partialResult?.self).toBe("[Circular]");
  });

  it("suppresses repeated recoverable protocol errors until reconnect", async () => {
    const relay = await listen();
    const error = vi.fn<(message: string, recoverable: boolean) => void>();
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      reconnect: false,
    });
    await transport.start(metadata, { connected: vi.fn(), resync: vi.fn(), command: vi.fn(), error });
    const socket = await relay.connection;
    await once(socket, "message");
    socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime-a" }));
    await vi.waitFor(() => expect(error).not.toHaveBeenCalled());

    for (let index = 0; index < 3; index += 1) {
      socket.send(JSON.stringify({ type: "protocol.error", code: "invalid_message", message: "same failure" }));
    }
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith("same failure", true);
  });

  it("always publishes metadata events（ADR-0008 之后不再有能力位协商）", async () => {
    const relay = await listen();
    const connected = vi.fn();
    transport = new RelayRuntimeTransport({ relayUrl: relay.url, credential: "runtime-secret", reconnect: false });
    await transport.start(metadata, { connected, resync: vi.fn(), command: vi.fn() });
    const socket = await relay.connection;
    await once(socket, "message");
    socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime-a" }));
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());

    const metadataEvent = once(socket, "message");
    transport.publish({
      type: "runtime.metadata",
      metadata: { ...metadata, sessionName: "API refactor" },
    });
    await expect(metadataEvent).resolves.toSatisfy(([raw]) =>
      (JSON.parse(raw.toString()) as { event?: RuntimeEvent }).event?.type === "runtime.metadata");
  });

  it("continues event sequencing when the transport is recreated for the same runtime", async () => {
    const relay = await listen();
    const runtimeMetadata = { ...metadata, runtimeId: "runtime-sequence" };
    const firstConnected = vi.fn();
    const first = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      reconnect: false,
    });
    transport = first;
    await first.start(runtimeMetadata, { connected: firstConnected, resync: vi.fn(), command: vi.fn() });
    const firstSocket = await relay.connection;
    await once(firstSocket, "message");
    firstSocket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: runtimeMetadata.runtimeId }));
    await vi.waitFor(() => expect(firstConnected).toHaveBeenCalledOnce());
    first.publish({ type: "runtime.status", status: "running" });
    const [firstEvent] = await once(firstSocket, "message");
    const firstSequence = Number(JSON.parse(firstEvent.toString()).sequence);
    expect(firstSequence).toBeGreaterThan(1_000_000_000);
    first.close();

    const secondConnection = once(wss!, "connection").then(([socket]) => socket as WebSocket);
    const secondConnected = vi.fn();
    const second = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      reconnect: false,
    });
    transport = second;
    await second.start(runtimeMetadata, { connected: secondConnected, resync: vi.fn(), command: vi.fn() });
    const secondSocket = await secondConnection;
    await once(secondSocket, "message");
    secondSocket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: runtimeMetadata.runtimeId }));
    await vi.waitFor(() => expect(secondConnected).toHaveBeenCalledOnce());
    second.publish({ type: "runtime.status", status: "idle" });
    const [secondEvent] = await once(secondSocket, "message");
    expect(JSON.parse(secondEvent.toString()).sequence).toBe(firstSequence + 1);
  });

  it("keeps an authenticated idle runtime connection alive with WebSocket pings", async () => {
    const relay = await listen();
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      reconnect: false,
      heartbeatIntervalMs: 5,
    });
    await transport.start(metadata, { connected: vi.fn(), resync: vi.fn(), command: vi.fn() });
    const socket = await relay.connection;
    await once(socket, "message");

    await expect(once(socket, "ping")).resolves.toBeDefined();
  });

  it("reconnects when an idle relay stops answering WebSocket heartbeats", async () => {
    const relay = await listen({ autoPong: false });
    const connected = vi.fn();
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      heartbeatIntervalMs: 50,
      initialReconnectDelayMs: 5,
      maxReconnectDelayMs: 5,
    });
    await transport.start(metadata, { connected, resync: vi.fn(), command: vi.fn() });
    const first = await relay.connection;
    const firstPing = once(first, "ping");
    await once(first, "message");
    first.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime-a" }));
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1));

    const secondConnection = once(wss!, "connection").then(([socket]) => socket as WebSocket);
    await expect(firstPing).resolves.toBeDefined();
    const second = await secondConnection;
    await expect(once(second, "message")).resolves.toBeDefined();
    second.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime-a" }));
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2));
  });

  it("reconnects outbound and announces connection again so the bridge can resync a snapshot", async () => {
    const relay = await listen();
    const connected = vi.fn();
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      initialReconnectDelayMs: 5,
      maxReconnectDelayMs: 5,
    });
    await transport.start(metadata, { connected, resync: vi.fn(), command: vi.fn() });
    const first = await relay.connection;
    await once(first, "message");
    first.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime-a" }));
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(1));

    const secondConnection = once(wss!, "connection").then(([socket]) => socket as WebSocket);
    first.close(1012, "restart");
    const second = await secondConnection;
    const [authentication] = await once(second, "message");
    expect(JSON.parse(authentication.toString())).toMatchObject({
      type: "runtime.authenticate",
      role: "agent",
      protocolVersion: PROTOCOL_VERSION,
      runtime: { runtimeId: "runtime-a" },
    });
    second.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime-a" }));
    await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(2));
  });

  it("re-resolves the endpoint before connecting, so a restarted Host on a new port is found again", async () => {
    const relay = await listen();
    const connected = vi.fn();
    const resolveEndpoint = vi.fn(async () => ({ relayUrl: relay.url, credential: "fresh-secret" }));
    transport = new RelayRuntimeTransport({
      // 构造时给一个死地址：证明真正连上的是解析出来的那一个。
      relayUrl: "ws://127.0.0.1:9",
      credential: "stale-secret",
      reconnect: false,
      resolveEndpoint,
    });

    await transport.start(metadata, { connected, resync: vi.fn(), command: vi.fn() });
    const socket = await relay.connection;
    const [authentication] = await once(socket, "message");
    expect(JSON.parse(authentication.toString())).toMatchObject({
      type: "runtime.authenticate",
      credential: "fresh-secret",
    });
    expect(resolveEndpoint).toHaveBeenCalledTimes(1);
  });

  it("falls back to the configured endpoint when nothing can be re-resolved", async () => {
    const relay = await listen();
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      reconnect: false,
      resolveEndpoint: async () => undefined,
    });

    await transport.start(metadata, { connected: vi.fn(), resync: vi.fn(), command: vi.fn() });
    const socket = await relay.connection;
    const [authentication] = await once(socket, "message");
    expect(JSON.parse(authentication.toString())).toMatchObject({
      type: "runtime.authenticate",
      credential: "runtime-secret",
    });
  });
});
