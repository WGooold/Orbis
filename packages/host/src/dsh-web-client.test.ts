import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { DshWebClient, type DshWebEvent, type DshWebProtocol } from "./dsh-web-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

// These stand-ins keep transport tests independent of a globally installed CLI.
const protocol: DshWebProtocol = {
  muxPath: "/api/remote.mux", eventEndpoint: "$events", eventResultEndpoint: "$events/result",
  parseStream(text) {
    const value = JSON.parse(text) as ReturnType<DshWebProtocol["parseStream"]>;
    if (!value.streamId || !["item", "end", "error"].includes(value.type)) throw new Error("invalid stream");
    return value;
  },
  parseResponse(value) {
    const response = value as ReturnType<DshWebProtocol["parseResponse"]>;
    if (response.type !== "server-response" || typeof response.rpcId !== "string" || typeof response.result.ok !== "boolean") throw new Error("invalid RPC response");
    return response;
  },
  parseEventResult: value => value,
};
type Rpc = { type: string; rpcId: string; method: string; payload: { args: Record<string, unknown> } };
type Open = { type: string; streamId: string; endpoint: string; payload: { args: Record<string, unknown> } };

async function fixture(options: { redirect?: string; missingCookie?: boolean; deny?: boolean } = {}) {
  const rpcs: Rpc[] = [];
  const opens: Open[] = [];
  const cancels: string[] = [];
  const sockets: WebSocket[] = [];
  let rpcHandler: ((rpc: Rpc, response: ServerResponse) => void) | undefined;
  const respond = (response: ServerResponse, rpc: Rpc, value: unknown) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "server-response", rpcId: rpc.rpcId, result: { ok: true, value } }));
  };
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/?token=local-launch-secret") {
      response.writeHead(302, { Location: options.redirect ?? "./", ...(options.missingCookie ? {} : { "Set-Cookie": "dsh_test=authenticated; Path=/; HttpOnly" }) });
      response.end();
      return;
    }
    if (request.headers.cookie !== "dsh_test=authenticated") { response.writeHead(401); response.end(); return; }
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const rpc = JSON.parse(body) as Rpc;
      rpcs.push(rpc);
      if (rpcHandler) rpcHandler(rpc, response); else respond(response, rpc, { accepted: true });
      return;
    }
    response.writeHead(200); response.end("alive");
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (options.deny || request.headers.cookie !== "dsh_test=authenticated") { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(request, socket, head, client => wss.emit("connection", client, request));
  });
  wss.on("connection", socket => {
    const generation = sockets.push(socket);
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes.toString()) as Open;
      if (frame.type === "cancel") { cancels.push(frame.streamId); return; }
      opens.push(frame);
      if (frame.endpoint === "$events") socket.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { type: "ready", clientId: `client-${generation}`, host: { home: "C:/isolated-dsh" } } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    url, rpcs, opens, cancels, sockets, respond,
    setRpcHandler(handler: typeof rpcHandler) { rpcHandler = handler; },
    send(endpoint: string, value: unknown) {
      const stream = [...opens].reverse().find(item => item.endpoint === endpoint);
      if (!stream) throw new Error(`missing stream ${endpoint}`);
      sockets.at(-1)!.send(JSON.stringify({ type: "item", streamId: stream.streamId, value }));
    },
    broadcast(endpoint: string, value: unknown) {
      const streams = opens.filter(item => item.endpoint === endpoint);
      for (const [index, socket] of sockets.entries()) {
        const stream = streams[index];
        if (stream) socket.send(JSON.stringify({ type: "item", streamId: stream.streamId, value }));
      }
    },
    async connect() {
      const client = await DshWebClient.connect({ url: `${url}?token=local-launch-secret`, protocol, timeoutMs: 1_000, reconnectDelayMs: 10 });
      cleanup.push(() => client.stop());
      return client;
    },
  };
}

describe("DSH Web transport", () => {
  it("exchanges the launch token, uses named RPC arguments, and multiplexes independent streams", async () => {
    const backend = await fixture();
    const client = await backend.connect();
    expect(client.url).toBe(backend.url);
    expect(client.url).not.toContain("secret");
    await expect(client.request("session/prompt", { request: { sessionId: "web-session", requestId: "mobile-message", mode: "steer", content: [{ type: "text", text: "continue" }] } })).resolves.toEqual({ accepted: true });
    expect(backend.rpcs[0]).toMatchObject({ type: "client-request", method: "session/prompt", payload: { args: { request: { sessionId: "web-session", mode: "steer" } } } });
    const follow = vi.fn();
    const control = vi.fn();
    const dispose = client.subscribe("session/follow", { request: { address: { kind: "session", sessionId: "web-session" }, assistantStream: true } }, follow);
    client.subscribe("session/control", {}, control);
    await vi.waitFor(() => expect(backend.opens).toHaveLength(3));
    backend.send("session/follow", { type: "snapshot", cursor: 10, records: [] });
    backend.send("session/control", { type: "baseline", value: { projections: {} } });
    await vi.waitFor(() => expect(follow).toHaveBeenCalledOnce());
    expect(control).toHaveBeenCalledExactlyOnceWith({ type: "baseline", value: { projections: {} } });
    dispose();
    await vi.waitFor(() => expect(backend.cancels).toHaveLength(1));
  });

  it("restores subscriptions on a new Web generation and retires pending interactions", async () => {
    const backend = await fixture();
    const client = await backend.connect();
    const events: DshWebEvent[] = [];
    client.onEvent = event => events.push(event);
    client.onReconnect = vi.fn();
    const frames = vi.fn();
    client.subscribe("session/follow", { request: { address: { kind: "session", sessionId: "session" }, assistantStream: true } }, frames);
    await vi.waitFor(() => expect(backend.opens).toHaveLength(2));
    backend.send("$events", { type: "waterfall", event: "approval/request", eventId: "approval-old", agentId: "session", request: { name: "write" } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    backend.sockets[0]!.terminate();
    await vi.waitFor(() => expect(client.onReconnect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(backend.opens).toHaveLength(4));
    // A transport reconnect does not cancel the DSH waterfall; the Gateway
    // replays it to this generation so the phone can still answer it.
    backend.send("$events", { type: "waterfall", event: "approval/request", eventId: "approval-old", agentId: "session", request: { name: "write" } });
    await vi.waitFor(() => expect(events.filter(event => event.type === "waterfall")).toHaveLength(2));
    await client.respondEvent("approval-old", { kind: "result", value: true });
    backend.send("session/follow", { type: "snapshot", cursor: 15, records: [] });
    await vi.waitFor(() => expect(frames).toHaveBeenCalledWith({ type: "snapshot", cursor: 15, records: [] }));
    expect(backend.opens.filter(value => value.endpoint === "session/follow")[0]!.streamId).not.toBe(backend.opens.filter(value => value.endpoint === "session/follow")[1]!.streamId);
  });

  it("answers one approval in its exact client generation and delegates unhandled requests", async () => {
    const backend = await fixture();
    const client = await backend.connect();
    backend.send("$events", { type: "waterfall", event: "approval/request", eventId: "unhandled", agentId: "session", request: {} });
    await vi.waitFor(() => expect(backend.rpcs).toHaveLength(1));
    expect(backend.rpcs[0]).toMatchObject({ method: "$events/result", payload: { args: { clientId: "client-1", eventId: "unhandled", outcome: { kind: "next" } } } });
    client.onEvent = vi.fn();
    backend.send("$events", { type: "waterfall", event: "approval/request", eventId: "approved", agentId: "session", request: { operation: "edit" } });
    await vi.waitFor(() => expect(client.onEvent).toHaveBeenCalledOnce());
    await client.respondEvent("approved", { kind: "result", value: { decision: "allow" } });
    expect(backend.rpcs[1]).toMatchObject({ method: "$events/result", payload: { args: { clientId: "client-1", eventId: "approved", outcome: { kind: "result", value: { decision: "allow" } } } } });
    await expect(client.respondEvent("approved", { kind: "next" })).rejects.toThrow("no longer pending");
  });

  it("lets multiple Web operators observe one approval and cancels the loser after the first result", async () => {
    const backend = await fixture();
    const first = await backend.connect();
    const second = await backend.connect();
    const firstEvents: DshWebEvent[] = [];
    const secondEvents: DshWebEvent[] = [];
    first.onEvent = event => firstEvents.push(event);
    second.onEvent = event => secondEvents.push(event);
    backend.broadcast("$events", { type: "waterfall", event: "approval/request", eventId: "shared", agentId: "session", request: {} });
    await vi.waitFor(() => expect(firstEvents).toHaveLength(1));
    await vi.waitFor(() => expect(secondEvents).toHaveLength(1));
    await first.respondEvent("shared", { kind: "result", value: { decision: "allow" } });
    // The fixture does not emulate Gateway's winner broadcast; inject the
    // official `cancel` frame to the losing generation.
    const secondEventsStream = backend.opens.filter(value => value.endpoint === "$events")[1]!;
    backend.sockets[1]!.send(JSON.stringify({ type: "item", streamId: secondEventsStream.streamId, value: { type: "cancel", eventId: "shared" } }));
    await vi.waitFor(() => expect(secondEvents).toHaveLength(2));
    expect(secondEvents.at(-1)).toEqual({ type: "cancel", eventId: "shared" });
    await expect(second.respondEvent("shared", { kind: "next" })).rejects.toThrow("no longer pending");
  });

  it("contains a throwing application event listener and rejects its waterfall", async () => {
    const backend = await fixture();
    const client = await backend.connect();
    client.onEvent = () => { throw new Error("mobile handler failed"); };
    backend.send("$events", { type: "waterfall", event: "approval/request", eventId: "throwing", agentId: "session", request: {} });
    await vi.waitFor(() => expect(backend.rpcs).toHaveLength(1));
    expect(backend.rpcs[0]).toMatchObject({ method: "$events/result", payload: { args: { eventId: "throwing", outcome: { kind: "rejected", error: { message: "mobile handler failed" } } } } });
    await expect(client.request("session/list", { _request: {} })).resolves.toEqual({ accepted: true });
  });

  it("stops its own connection while the Web server and other clients remain usable", async () => {
    const backend = await fixture();
    const client = await backend.connect();
    await client.stop();
    await client.stop();
    await expect(client.request("session/list", { _request: {} })).rejects.toThrow("disconnected");
    const second = await backend.connect();
    await expect(second.request("session/list", { _request: {} })).resolves.toEqual({ accepted: true });
    expect(backend.sockets).toHaveLength(2);
  });

  it("does not retry an uncertain mutation and keeps HTML out of RPC errors", async () => {
    const backend = await fixture();
    const client = await backend.connect();
    backend.setRpcHandler(() => {});
    await expect(client.request("session/prompt", { request: {} }, 30)).rejects.toThrow("refresh before retrying");
    expect(backend.rpcs).toHaveLength(1);
    backend.setRpcHandler((_rpc, response) => { response.writeHead(405, { "content-type": "text/html" }); response.end("<html>private server details</html>"); });
    await expect(client.request("session/prompt", { request: {} })).rejects.toThrow("HTTP 405");
    backend.setRpcHandler((rpc, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "server-response", rpcId: rpc.rpcId, result: { ok: false, error: { code: "gateway/internal", message: "405 <!DOCTYPE html><html>private details</html>", details: {} } } }));
    });
    await expect(client.request("session/prompt", { request: {} })).rejects.toThrow("HTML error page");
  });

  it("rejects correlation errors and invalid stream messages without leaking response bodies", async () => {
    const backend = await fixture();
    const client = await backend.connect();
    backend.setRpcHandler((rpc, response) => backend.respond(response, { ...rpc, rpcId: "wrong-id" }, {}));
    await expect(client.request("session/list", { _request: {} })).rejects.toThrow("correlation mismatch");
    client.onExit = vi.fn();
    backend.sockets[0]!.send("<html>bad carrier</html>");
    await vi.waitFor(() => expect(client.onExit).toHaveBeenCalledExactlyOnceWith("DSH Web returned an invalid Remote stream frame"));
  });

  it("refuses remote origins, cross-origin token redirects, and absent authentication", async () => {
    await expect(DshWebClient.connect({ url: "https://example.com/?token=secret", protocol })).rejects.toThrow("loopback");
    const redirect = await fixture({ redirect: "https://example.com/" });
    await expect(redirect.connect()).rejects.toThrow("another origin");
    const noCookie = await fixture({ missingCookie: true });
    await expect(noCookie.connect()).rejects.toThrow("authentication cookie");
    const denied = await fixture({ deny: true });
    await expect(denied.connect()).rejects.toThrow("authentication required");
  });
});
