import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { HERMES_GATEWAY_WS_PROTOCOL, HermesGatewayRpcClient, type HermesGatewayRpcOptions } from "./hermes-gateway-rpc.js";

const servers: WebSocketServer[] = [];
const clients: HermesGatewayRpcClient[] = [];

async function startServer(onConnection: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("connection", onConnection);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP test listener");
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function connect(url: string, options: HermesGatewayRpcOptions = {}) {
  // The factory performs the real WebSocket handshake and applies bounded payload settings.
  const client = await HermesGatewayRpcClient.connect(url, undefined, options);
  clients.push(client);
  return client;
}

describe("HermesGatewayRpcClient", () => {
  it("requires the canonical Gateway subprotocol when one is requested", async () => {
    const server = new WebSocketServer({
      port: 0,
      handleProtocols: protocols => protocols.has(HERMES_GATEWAY_WS_PROTOCOL) ? HERMES_GATEWAY_WS_PROTOCOL : false,
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP test listener");
    const client = await HermesGatewayRpcClient.connect(`ws://127.0.0.1:${address.port}`,
      [HERMES_GATEWAY_WS_PROTOCOL, "hermes-gateway-ticket.fixture"]);
    clients.push(client);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it("correlates concurrent responses even when the Gateway replies out of order", async () => {
    const { url } = await startServer(socket => socket.on("message", raw => {
      const request = JSON.parse(raw.toString()) as { id: string; method: string };
      setTimeout(() => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { method: request.method } })),
        request.method === "slow" ? 20 : 0);
    }));
    const client = await connect(url);
    const [slow, fast] = await Promise.all([
      client.request<{ method: string }>("slow"), client.request<{ method: string }>("fast"),
    ]);
    expect(slow.method).toBe("slow");
    expect(fast.method).toBe("fast");
  });

  it("dispatches Gateway event notifications without treating them as RPC responses", async () => {
    const { url } = await startServer(socket => socket.send(JSON.stringify({
      jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { replay_epoch: "e1" } },
    })));
    let resolve!: (event: unknown) => void;
    const seen = new Promise<unknown>(done => { resolve = done; });
    const client = await connect(url, { onEvent: resolve });
    expect(await seen).toMatchObject({ type: "gateway.ready", payload: { replay_epoch: "e1" } });
    expect(client.closed).toBe(false);
  });

  it("answers Gateway-originated requests through a registered server-request handler", async () => {
    let resolve!: (value: unknown) => void;
    const answered = new Promise<unknown>(done => { resolve = done; });
    const { url } = await startServer(socket => {
      socket.on("message", raw => {
        const frame = JSON.parse(raw.toString()) as { id?: string; result?: unknown };
        if (frame.id === "approval-1") resolve(frame.result);
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: "approval-1", method: "approval", params: { command: "make" } }));
    });
    const client = await connect(url, { onServerRequest: request => ({ choice: request.method === "approval" ? "deny" : "allow" }) });
    expect(await answered).toEqual({ choice: "deny" });
    expect(client.closed).toBe(false);
  });

  it("returns method-not-found when the host has no handler for a Gateway request", async () => {
    let resolve!: (value: unknown) => void;
    const answered = new Promise<unknown>(done => { resolve = done; });
    const { url } = await startServer(socket => {
      socket.on("message", raw => {
        const frame = JSON.parse(raw.toString()) as { id?: string; error?: { code?: number } };
        if (frame.id === "unsupported-1") resolve(frame.error?.code);
      });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: "unsupported-1", method: "unsupported", params: {} }));
    });
    const client = await connect(url);
    expect(await answered).toBe(-32601);
    expect(client.closed).toBe(false);
  });

  it("rejects outstanding requests when the socket closes", async () => {
    let accepted!: () => void;
    const hasRequest = new Promise<void>(resolve => { accepted = resolve; });
    const { url } = await startServer(socket => socket.on("message", () => accepted()));
    const client = await connect(url);
    const request = client.request("pending", {}, 5_000);
    await hasRequest;
    for (const server of servers) server.clients.forEach(peer => peer.close(1011, "test close"));
    await expect(request).rejects.toThrow(/closed/iu);
  });

  it("closes on malformed JSON-RPC frames and rejects pending calls", async () => {
    let received!: () => void;
    const sent = new Promise<void>(resolve => { received = resolve; });
    const { url } = await startServer(socket => socket.on("message", () => {
      received();
      socket.send("{not-json");
    }));
    const client = await connect(url);
    const pending = client.request("pending", {}, 5_000);
    await sent;
    await expect(pending).rejects.toThrow(/invalid JSON/iu);
    expect(client.closed).toBe(true);
  });

  it("times out a request and ignores a later reply", async () => {
    const { url } = await startServer(socket => socket.on("message", raw => {
      const request = JSON.parse(raw.toString()) as { id: string };
      setTimeout(() => socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: true })), 30);
    }));
    const client = await connect(url);
    await expect(client.request("slow", {}, 5)).rejects.toThrow(/timed out/iu);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(client.closed).toBe(false);
  });
});
