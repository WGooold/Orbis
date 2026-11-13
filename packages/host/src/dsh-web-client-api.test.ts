// ADR-0076 DSH-DESKTOP-02: Orbis attaches to Desktop as an independent owner API Peer via `/connect`.
// The fake Gateway enforces the lifecycle observed against official dsh 0.2.2-rc.2: one cookie per Peer,
// 409 for a second socket, 401 after the Peer's socket closes, and a fresh token exchange per carrier.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { DshWebAuthenticationError, DshWebClient, DshWebIncompatibleError, type DshWebProtocol } from "./dsh-web-client.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

const protocol: DshWebProtocol = {
  muxPath: "/api/remote.mux", eventEndpoint: "$events", eventResultEndpoint: "$events/result",
  parseStream: text => JSON.parse(text) as ReturnType<DshWebProtocol["parseStream"]>,
  parseResponse: value => value as ReturnType<DshWebProtocol["parseResponse"]>,
  parseEventResult: value => value,
};

async function gateway(options: { connectRoute?: boolean } = {}) {
  let token = "desktop-launch-token-0001";
  const peers = new Map<string, { socket?: WebSocket; closed: boolean }>();
  const exchanges: string[] = [];
  const rpcStatuses: number[] = [];
  const peerOf = (request: IncomingMessage) => /dsh-auth-test=([^;]+)/u.exec(request.headers.cookie ?? "")?.[1];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/connect") {
      if (options.connectRoute === false) { response.writeHead(404); response.end(); return; }
      if (url.searchParams.get("token") !== token || url.searchParams.get("interactions") !== "answer") { response.writeHead(401); response.end(); return; }
      const id = randomUUID();
      peers.set(id, { closed: false });
      exchanges.push(id);
      response.writeHead(302, { Location: "./api/remote.mux", "Set-Cookie": `dsh-auth-test=${id}; Path=/; HttpOnly` });
      response.end();
      return;
    }
    const peer = peers.get(peerOf(request) ?? "");
    if (!peer || peer.closed) { rpcStatuses.push(401); response.writeHead(401); response.end("unauthorized"); return; }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const rpc = JSON.parse(body) as { rpcId: string };
    rpcStatuses.push(200);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "server-response", rpcId: rpc.rpcId, result: { ok: true, value: { items: [] } } }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const peer = peers.get(peerOf(request) ?? "");
    if (!peer || peer.closed) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    if (peer.socket) { socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(request, socket, head, client => {
      peer.socket = client;
      client.on("close", () => { peer.closed = true; });
      client.on("message", bytes => {
        const frame = JSON.parse(bytes.toString()) as { type: string; streamId: string; endpoint: string };
        if (frame.endpoint === "$events") client.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { type: "ready", clientId: `client-${exchanges.length}`, host: { home: "isolated" } } }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {
    base, exchanges, rpcStatuses, peers,
    url: () => `${base}?token=${token}`,
    rotateToken() { token = "desktop-launch-token-0002"; },
    dropSockets() { for (const socket of wss.clients) socket.terminate(); },
    async connect(url = `${base}?token=${token}`) {
      const client = await DshWebClient.connect({ url, protocol, authentication: "api", label: "DeepSeek Harness Desktop", timeoutMs: 1_000, reconnectDelayMs: 10 });
      cleanup.push(() => client.stop());
      return client;
    },
  };
}

describe("DSH API Peer transport", () => {
  it("exchanges the launch token for a Peer before its carrier and serves unary calls with that Peer", async () => {
    const backend = await gateway();
    const client = await backend.connect();
    expect(backend.exchanges).toHaveLength(1);
    await expect(client.request("session/list", { _request: {} })).resolves.toEqual({ items: [] });
    expect(backend.rpcStatuses).toEqual([200]);
  });

  it("opens a fresh Peer for every replacement carrier instead of reusing the closed Peer's cookie", async () => {
    const backend = await gateway();
    const client = await backend.connect();
    const reconnected = new Promise<void>(resolve => { client.onReconnect = resolve; });
    backend.dropSockets();
    await reconnected;
    expect(backend.exchanges).toHaveLength(2);
    await expect(client.request("session/list", { _request: {} })).resolves.toEqual({ items: [] });
    expect(backend.rpcStatuses.at(-1)).toBe(200);
    // The first Peer ended with its socket; nothing kept using it.
    expect(backend.peers.get(backend.exchanges[0]!)?.closed).toBe(true);
  });

  it("retires the bridge when Desktop's Host restarted with a new token, so recovery rereads the endpoint", async () => {
    const backend = await gateway();
    const client = await backend.connect();
    const exited = new Promise<string>(resolve => { client.onExit = resolve; });
    backend.rotateToken();
    backend.dropSockets();
    expect(await exited).toContain("launch token");
  });

  it("reports a version without the API route as incompatible and an invalid token as an authentication failure", async () => {
    const missing = await gateway({ connectRoute: false });
    await expect(missing.connect()).rejects.toBeInstanceOf(DshWebIncompatibleError);
    const backend = await gateway();
    await expect(backend.connect(`${backend.base}?token=desktop-launch-token-9999`)).rejects.toBeInstanceOf(DshWebAuthenticationError);
    await expect(DshWebClient.connect({ url: backend.base, protocol, authentication: "api" })).rejects.toBeInstanceOf(DshWebAuthenticationError);
  });

  it("closing Orbis's client ends only its own Peer", async () => {
    const backend = await gateway();
    const client = await backend.connect();
    const other = await backend.connect();
    await client.stop();
    await vi.waitFor(() => expect(backend.peers.get(backend.exchanges[0]!)?.closed).toBe(true));
    await expect(other.request("session/list", { _request: {} })).resolves.toEqual({ items: [] });
  });
});
