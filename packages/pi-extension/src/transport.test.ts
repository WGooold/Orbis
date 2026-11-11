import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, PROTOCOL_VERSION_ERROR_CODE, RuntimeClientMessageSchema, RuntimeEventSchema, RuntimeMetadataSchema, SessionLiveStateSchema, SessionLiveTurnSchema, type RuntimeCommand, type RuntimeEvent, type RuntimeMetadata } from "@orbis/protocol";
import { RelayRuntimeTransport } from "./transport.js";

const metadata: RuntimeMetadata = {
  runtimeId: "runtime-a",
  name: "test runtime",
  cwd: "/work/test",
  status: "idle",
};

// v0.1.16's metadata shape is strict: optional additions still need peer support.
const legacyMetadataSchema = RuntimeMetadataSchema.omit({
  currentTurnConfiguration: true, currentTurnConfigurationSupported: true, modelSelection: true,
});
const selectedMetadata: RuntimeMetadata = {
  ...metadata, status: "running", model: { provider: "p", id: "selected" }, thinkingLevel: "high",
};
const modelMetadata: RuntimeMetadata = {
  ...selectedMetadata,
  modelSelection: { model: "p/selected", thinking: "high" }, currentTurnConfigurationSupported: true,
  currentTurnConfiguration: { turnId: "turn", model: { provider: "p", id: "actual" }, thinkingLevel: "low" },
};

// Model the released strict live-turn shape, while retaining every other source field.
const legacyLive = SessionLiveStateSchema.extend({ turn: SessionLiveTurnSchema.omit({ outcome: true }).nullable() });
const sourceCompletion = (type: "session.patch" | "session.snapshot"): RuntimeEvent => {
  const source = { epoch: "source-epoch", seq: 1, ready: true };
  const head = { leafId: null };
  const checkpoint = { checkpointId: "source-epoch:1", head, headCompleteness: "complete", inventoryComplete: true };
  const live = { complete: true, turn: { turnId: "turn", startedAt: 100, durationMs: 75, outcome: "completed" }, messages: [], tools: [] };
  // These names belong to canonical user/Agent data; compatibility must never recurse into them.
  const entries = [{ entryId: "entry", parentId: null, type: "message", timestamp: "2026-11-08T00:00:00.000Z",
    data: { outcome: "canonical-data", live: { turn: { outcome: "nested-data" } },
      message: { messageId: "message", role: "assistant", timestamp: 100, content: [{ type: "text", text: "outcome remains in content" }] } } }];
  return RuntimeEventSchema.parse(type === "session.patch"
    ? { type, sessionId: "session", source, baseSeq: 0, seq: 1, checkpointId: checkpoint.checkpointId, head, headCompleteness: "complete", live, entries }
    : { type, sessionId: "session", syncId: "sync", cursor: head, mode: "replace", range: "preview", source, checkpoint, live, entries });
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

  // SC81: prevent same-version additions from breaking authentication or later metadata;
  // compatibility projection must leave local facts and arbitrary tool data intact.
  it.each([undefined, "0", "1"])("projects model metadata using the peer's exact capability header %s", async header => {
    const relay = await listen(), connected = vi.fn();
    wss!.on("headers", headers => {
      // Outcome support predates model facts and cannot imply support for them.
      headers.push("X-Orbis-Session-Turn-Outcome: 1");
      if (header !== undefined) headers.push(`X-Orbis-Runtime-Model-State: ${header}`);
    });
    transport = new RelayRuntimeTransport({ relayUrl: relay.url, credential: "runtime-secret", reconnect: false });
    const before = structuredClone(modelMetadata);
    await transport.start(modelMetadata, { connected, resync: vi.fn(), command: vi.fn() });
    const socket = await relay.connection;
    const [rawAuthentication] = await once(socket, "message");
    const authentication = JSON.parse(rawAuthentication.toString());
    const expected = header === "1" ? modelMetadata : selectedMetadata;
    expect(authentication.runtime).toEqual(expected);
    expect(legacyMetadataSchema.safeParse(authentication.runtime).success).toBe(header !== "1");
    expect(authentication).toMatchObject({ type: "runtime.authenticate", role: "agent", credential: "runtime-secret", protocolVersion: PROTOCOL_VERSION });

    const received: unknown[] = [];
    socket.on("message", raw => received.push(JSON.parse(raw.toString())));
    transport.publish({ type: "runtime.metadata", metadata: modelMetadata });
    expect(received).toEqual([]);
    socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: metadata.runtimeId }));
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());
    const published = once(socket, "message");
    transport.publish({ type: "runtime.metadata", metadata: modelMetadata });
    const [rawUpdate] = await published;
    expect(JSON.parse(rawUpdate.toString()).event).toEqual({ type: "runtime.metadata", metadata: expected });
    expect(received).toHaveLength(1);
    expect(modelMetadata).toEqual(before);

    const tool: RuntimeEvent = { type: "tool.updated", toolCallId: "tool", toolName: "test", partialResult: {
      currentTurnConfiguration: "user data", currentTurnConfigurationSupported: "user data", modelSelection: "user data",
    } };
    const toolMessage = once(socket, "message");
    transport.publish(tool);
    const [rawTool] = await toolMessage;
    expect(JSON.parse(rawTool.toString()).event).toEqual(tool);
  });

  // A Host rollback must clear the previous socket's support. Re-upgrading must
  // recover the full latest local facts rather than permanently storing stripped metadata.
  it("renegotiates model facts on new, old and new Host connections", async () => {
    const relay = await listen(), connected = vi.fn();
    let supportsModelState = true;
    wss!.on("headers", headers => { if (supportsModelState) headers.push("X-Orbis-Runtime-Model-State: 1"); });
    transport = new RelayRuntimeTransport({ relayUrl: relay.url, credential: "runtime-secret", initialReconnectDelayMs: 5, maxReconnectDelayMs: 5 });
    let latest = structuredClone(modelMetadata);
    await transport.start(latest, { connected, resync: vi.fn(), command: vi.fn() });
    let socket = await relay.connection;
    for (let index = 0; index < 3; index++) {
      const [rawAuthentication] = await once(socket, "message");
      expect(JSON.parse(rawAuthentication.toString()).runtime).toEqual(supportsModelState ? latest : { ...selectedMetadata, thinkingLevel: latest.thinkingLevel });
      socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: metadata.runtimeId }));
      await vi.waitFor(() => expect(connected).toHaveBeenCalledTimes(index + 1));
      latest = { ...latest, thinkingLevel: `level-${index}`, modelSelection: { model: `p/next-${index}` },
        currentTurnConfiguration: index === 1 ? null : { turnId: `turn-${index}` } };
      const update = once(socket, "message");
      transport.publish({ type: "runtime.metadata", metadata: latest });
      const [rawUpdate] = await update;
      expect(JSON.parse(rawUpdate.toString()).event.metadata).toEqual(supportsModelState ? latest : { ...selectedMetadata, thinkingLevel: latest.thinkingLevel });
      if (index === 2) break;
      supportsModelState = !supportsModelState;
      const next = once(wss!, "connection").then(([peer]) => peer as WebSocket);
      socket.close(1012, "Host restarted");
      socket = await next;
    }
  });

  it.each(["session.patch", "session.snapshot"] as const)("sends %s to an old Host without changing nested data or the source object", async type => {
    // No capability header means the released strict schema, even with the same protocol version.
    const relay=await listen(),connected=vi.fn();
    transport=new RelayRuntimeTransport({relayUrl:relay.url,credential:"runtime-secret",reconnect:false});
    await transport.start(metadata,{connected,resync:vi.fn(),command:vi.fn()});
    const socket=await relay.connection;await once(socket,"message");
    const event=sourceCompletion(type),before=structuredClone(event),received: unknown[]=[];
    socket.on("message",raw=>received.push(JSON.parse(raw.toString())));
    transport.publish(event); // An HTTP upgrade is insufficient until runtime.ready authenticates it.
    socket.send(JSON.stringify({type:"runtime.ready",protocolVersion:PROTOCOL_VERSION,runtimeId:metadata.runtimeId}));
    await vi.waitFor(()=>expect(connected).toHaveBeenCalledOnce());
    const published=once(socket,"message");transport.publish(event);const [raw]=await published;
    const envelope=RuntimeClientMessageSchema.parse(JSON.parse(raw.toString()));
    expect(envelope.type).toBe("runtime.event");
    if(envelope.type!=="runtime.event"||!(envelope.event.type==="session.patch"||envelope.event.type==="session.snapshot"))throw new Error("expected source event");
    expect(legacyLive.safeParse(envelope.event.live).success).toBe(true);
    expect(envelope.event.live?.turn).toEqual({turnId:"turn",startedAt:100,durationMs:75});
    expect(envelope.event.entries).toEqual((event as Extract<RuntimeEvent,{type:typeof type}>).entries);
    expect(event).toEqual(before);
    expect(received).toHaveLength(1);
    const tool:RuntimeEvent={type:"tool.updated",toolCallId:"tool",toolName:"test",partialResult:{outcome:"completed",live:{turn:{outcome:"preserve-tool-data"}}}};
    const toolMessage=once(socket,"message");transport.publish(tool);const [toolRaw]=await toolMessage;
    expect(JSON.parse(toolRaw.toString()).event).toEqual(tool);
  });

  it("renegotiates source outcomes on every reconnect from old to new and back to old Host", async () => {
    const relay=await listen(),connected=vi.fn();let supportsOutcome=false;
    wss!.on("headers",headers=>{if(supportsOutcome)headers.push("X-Orbis-Session-Turn-Outcome: 1");});
    transport=new RelayRuntimeTransport({relayUrl:relay.url,credential:"runtime-secret",initialReconnectDelayMs:5,maxReconnectDelayMs:5});
    await transport.start(metadata,{connected,resync:vi.fn(),command:vi.fn()});
    let socket=await relay.connection;
    for(let index=0;index<3;index++){
      await once(socket,"message");
      socket.send(JSON.stringify({type:"runtime.ready",protocolVersion:PROTOCOL_VERSION,runtimeId:metadata.runtimeId}));
      await vi.waitFor(()=>expect(connected).toHaveBeenCalledTimes(index+1));
      for(const type of ["session.patch","session.snapshot"] as const){
        const event=sourceCompletion(type),published=once(socket,"message");transport.publish(event);const [raw]=await published;
        const payload=JSON.parse(raw.toString()).event;
        expect(payload.live.turn.outcome).toBe(index===1?"completed":undefined);
        expect(payload.entries).toEqual((event as Extract<RuntimeEvent,{type:typeof type}>).entries);
      }
      if(index===2)break;
      supportsOutcome=index===0;
      const next=once(wss!,"connection").then(([peer])=>peer as WebSocket);socket.close(1012,"Host restarted");socket=await next;
    }
  });

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

  it("always publishes metadata events", async () => {
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

  it("Host 握手后不回 runtime.ready 时报超时，而不是永远停在 connecting", async () => {
    const relay = await listen();
    const error = vi.fn<(message: string, recoverable: boolean) => void>();
    const states: string[] = [];
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      reconnect: false,
      readyTimeoutMs: 20,
      onConnectionStateChange: (state) => states.push(state),
    });

    await transport.start(metadata, { connected: vi.fn(), resync: vi.fn(), command: vi.fn(), error });
    const socket = await relay.connection;
    await once(socket, "message");

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("runtime.ready"), true));
    expect(states).not.toContain("connected");
  });

  it("把协议版本不匹配当作终态，不重连", async () => {
    const relay = await listen();
    let attempts = 0;
    wss!.on("connection", () => { attempts += 1; });
    const error = vi.fn<(message: string, recoverable: boolean) => void>();
    const states: string[] = [];
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      initialReconnectDelayMs: 5,
      maxReconnectDelayMs: 5,
      onConnectionStateChange: (state) => states.push(state),
    });
    await transport.start(metadata, { connected: vi.fn(), resync: vi.fn(), command: vi.fn(), error });
    const socket = await relay.connection;
    await once(socket, "message");

    socket.send(JSON.stringify({ type: "protocol.error", code: PROTOCOL_VERSION_ERROR_CODE, message: "协议版本不匹配：对面是 8，Host 是 14" }));
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("协议版本不匹配"), false));
    expect(states).toContain("error");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(attempts).toBe(1);
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

  // ADR-0035 §9：对端停止读取时，Pi 必须有界——否则 ws 会把帧排进内存直到进程 OOM。
  it("drops events instead of buffering without bound when the peer stops reading", async () => {
    const relay = await listen();
    const connected = vi.fn();
    const overflow = vi.fn();
    const drained = vi.fn();
    const maxBufferedBytes = 32 * 1024;
    transport = new RelayRuntimeTransport({
      relayUrl: relay.url,
      credential: "runtime-secret",
      reconnect: false,
      maxBufferedBytes,
      bufferedLowWaterBytes: 8 * 1024,
      onOverflow: overflow,
      onDrained: drained,
    });
    await transport.start(metadata, { connected, resync: vi.fn(), command: vi.fn() });
    const socket = await relay.connection;
    socket.send(JSON.stringify({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION, runtimeId: "runtime-a" }));
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce());

    const raw = (socket as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    raw.pause();
    const payload = "A".repeat(8 * 1024);
    for (let index = 0; index < 200; index += 1) {
      transport.publish({
        type: "notification.source", producerEpoch: "e", sessionId: "s", revision: index,
        complete: true, notifications: [], pad: payload,
      } as unknown as RuntimeEvent);
    }
    expect(overflow).toHaveBeenCalledTimes(1);
    // 有界：积压停在「水位 + 一帧」量级，而不是 200 × 8KB。
    expect(socket.bufferedAmount).toBeLessThan(200 * 8 * 1024);

    raw.resume();
    await vi.waitFor(() => expect(drained).toHaveBeenCalled(), { timeout: 5000 });
  });
});
