import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { KimiWebClient, KimiWebConnector } from "./kimi-web-client.js";

const roots: string[] = [];
const servers: Array<{ server: Server; sockets: WebSocketServer }> = [];
const openapi = Buffer.from('{"openapi":"orbis-fixture"}');
const asyncapi = Buffer.from('{"asyncapi":"orbis-fixture"}');
const contracts = {
  openapi: createHash("sha256").update(openapi).digest("hex"),
  asyncapi: createHash("sha256").update(asyncapi).digest("hex"),
} as const;
const serverId = "01KIMICODE123456789ABCDEFGH";
const now = Date.now();

async function fixture(options: { id?: string; auth?: boolean; bypass?: boolean; redirect?: boolean; delay?: boolean; version?: string } = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), "orbis-kimi-client-")); roots.push(homeDir);
  await mkdir(join(homeDir, "server", "instances"), { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const tokenPath = join(homeDir, "server.token");
  await writeFile(tokenPath, token, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  const http = createServer(async (req, res) => {
    if (req.url === "/api/v1/healthz") { res.end('{"code":0,"data":{"ok":true}}'); return; }
    if (options.redirect && req.url === "/api/v1/meta") { res.writeHead(302, { location: "http://127.0.0.1:1/api/v1/meta" }); res.end(); return; }
    if (options.delay && req.url === "/api/v1/meta") { await new Promise(resolve => setTimeout(resolve, 100)); }
    if (options.auth !== false && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(); return; }
    if (req.url === "/api/v1/meta") res.end(JSON.stringify({ code: 0, data: {
      server_id: options.id ?? serverId, server_version: options.version ?? "2.6.3", started_at: new Date(now).toISOString(), backend: "v2", dangerous_bypass_auth: options.bypass ?? false,
      capabilities: { websocket: true },
    } }));
    else if (req.url === "/openapi.json") res.end(openapi);
    else if (req.url === "/asyncapi.json") res.end(asyncapi);
    else if (req.url === "/api/v1/sessions/demo") res.end('{"code":0,"data":{"id":"demo"}}');
    else { res.writeHead(404); res.end(); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  http.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${token}`) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => {
      sockets.emit("connection", ws, req);
      ws.send(JSON.stringify({ type: "agent", session_id: "demo" }));
    });
  });
  servers.push({ server: http, sockets });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  await writeFile(join(homeDir, "server", "instances", `${serverId}.json`), JSON.stringify({
    server_id: serverId, pid: process.pid, host: "127.0.0.1", port: address.port,
    started_at: now, heartbeat_at: now, host_version: options.version ?? "2.6.3",
  }));
  return { homeDir, endpoint: `http://127.0.0.1:${address.port}`, token };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server, sockets }) => new Promise<void>(resolve => {
    sockets.close(() => server.close(() => resolve()));
  })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Kimi Code local Web client", () => {
  it("discovers one authenticated registered loopback service and uses bounded REST/WS", async () => {
    const value = await fixture({ id: "01KIMICODEOTHER123456789ABC" });
    const client = await KimiWebClient.connect({ ...value, expectedContracts: contracts });
    await expect(client.requestJson("/api/v1/sessions/demo")).resolves.toEqual({ id: "demo" });
    await expect(client.requestJson("/api/v1/shutdown", { method: "POST" })).rejects.toMatchObject({ reason: "unsafe" });
    await expect(client.requestJson("/api/v1/sessions/demo:takeover", { method: "POST" })).rejects.toMatchObject({ reason: "unsafe" });
    const frame = new Promise<Record<string, unknown>>(resolve => {
      client.openSocket(resolve, reason => { throw new Error(reason); });
    });
    await expect(frame).resolves.toMatchObject({ type: "agent", session_id: "demo" });
    client.close();
  });

  // KIMI-11: the embedded contract is not enough without desktop ownership; never fall back to Web.
  it("separates desktop and web even with both registrations in the same data root", async () => {
    const value = await fixture({ version: "2.6.2" });
    const endpoint = new URL(value.endpoint);
    await writeFile(join(value.homeDir, "server", "instances", "01KIMICODESECOND123456789AB.json"), JSON.stringify({
      server_id: "01KIMICODESECOND123456789AB", pid: process.pid, host: "127.0.0.1", port: 1,
      started_at: now, heartbeat_at: now, host_version: "2.6.3",
    }));
    const options = { homeDir: value.homeDir, expectedContracts: contracts, source: "desktop" as const };
    await expect(KimiWebClient.connect({ ...options, verifyDesktopOwner: async () => false })).rejects.toMatchObject({ reason: "unsupported" });
    const client = await KimiWebClient.connect({ ...options, verifyDesktopOwner: async (pid, host, port) =>
      pid === process.pid && host === endpoint.hostname && port === Number(endpoint.port) });
    expect(client.meta.server_version).toBe("2.6.2"); client.close();
    await expect(KimiWebClient.connect({ ...value, expectedContracts: contracts })).rejects.toMatchObject({ reason: "not_running" });
  });

  it("requires explicit selection when multiple fresh service registrations exist", async () => {
    const value = await fixture();
    await writeFile(join(value.homeDir, "server", "instances", "01KIMICODESECOND123456789AB.json"), JSON.stringify({
      server_id: "01KIMICODESECOND123456789AB", pid: process.pid, host: "127.0.0.1", port: 1,
      started_at: now, heartbeat_at: now, host_version: "2.6.3",
    }));
    await expect(KimiWebClient.connect({ homeDir: value.homeDir, expectedContracts: contracts })).rejects.toMatchObject({ reason: "ambiguous" });
    await expect(KimiWebClient.connect({ ...value, expectedContracts: contracts })).resolves.toBeInstanceOf(KimiWebClient);
  });

  it("rejects stale registrations, unsafe endpoints, boot identity mismatch, bypassed auth and contract drift", async () => {
    const value = await fixture();
    const registration = join(value.homeDir, "server", "instances", `${serverId}.json`);
    const original = JSON.parse(await readFile(registration, "utf8")) as Record<string, unknown>;
    await writeFile(registration, JSON.stringify({ ...original, heartbeat_at: now - 60_000 }));
    await expect(KimiWebClient.connect({ homeDir: value.homeDir, expectedContracts: contracts })).rejects.toMatchObject({ reason: "not_running" });
    await writeFile(registration, JSON.stringify(original));
    await expect(KimiWebClient.connect({ ...value, endpoint: "http://localhost:58627", expectedContracts: contracts })).rejects.toMatchObject({ reason: "unsafe" });
    await expect(KimiWebClient.connect({ ...value, expectedContracts: { ...contracts, openapi: "0".repeat(64) } })).rejects.toMatchObject({ reason: "unsupported" });
    await expect(KimiWebClient.connect({ ...value, fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/api/v1/meta")) {
        const meta = await response.json() as { data: Record<string, unknown> };
        meta.data.started_at = new Date(now + 60_000).toISOString();
        return Response.json(meta);
      }
      return response;
    }, expectedContracts: contracts })).rejects.toMatchObject({ reason: "unsafe" });
    const bypass = await fixture({ bypass: true });
    await expect(KimiWebClient.connect({ ...bypass, expectedContracts: contracts })).rejects.toMatchObject({ reason: "unsupported" });
  });

  it("does not accept redirects, missing credentials, or unsafe credential permissions", async () => {
    const value = await fixture({ redirect: true });
    await expect(KimiWebClient.connect({ ...value, expectedContracts: contracts })).rejects.toMatchObject({ reason: "unsafe" });
    const tokenPath = join(value.homeDir, "server.token");
    await chmod(tokenPath, 0o644);
    await expect(KimiWebClient.connect({ homeDir: value.homeDir, expectedContracts: contracts })).rejects.toMatchObject({ reason: "unsafe" });
  });

  it("bounds slow discovery requests", async () => {
    const value = await fixture({ delay: true });
    await expect(KimiWebClient.connect({ ...value, expectedContracts: contracts, requestTimeoutMs: 5 })).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("reconnects its own WebSocket with a new generation and leaves the service running on stop", async () => {
    const value = await fixture();
    const connected: number[] = [];
    let changed!: (generation: number) => void;
    const nextGeneration = new Promise<number>(resolve => { changed = resolve; });
    const connector = new KimiWebConnector({ ...value, expectedContracts: contracts, onConnected: (_client, _socket, generation) => {
      connected.push(generation);
      if (generation > 1) changed(generation);
    } });
    connector.start();
    const deadline = Date.now() + 5_000;
    while (connected.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(connected).toEqual([1]);
    const fixtureServer = servers[0]!;
    for (const socket of fixtureServer.sockets.clients) socket.close(1012, "fixture reconnect");
    await expect(Promise.race([nextGeneration, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reconnect timeout")), 5_000))])).resolves.toBe(2);
    await connector.stop();
    expect(connector.status.state).toBe("stopped");
    expect(fixtureServer.server.listening).toBe(true);
  });
});
