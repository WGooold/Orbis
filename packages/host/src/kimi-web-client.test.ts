import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKimiLauncher, type KimiLauncher } from "./kimi-launch.js";
import { KimiRuntime } from "./kimi-runtime.js";
import { kimiSourceKey } from "./kimi-sessions.js";
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

async function tempHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "orbis-kimi-client-")); roots.push(path); return path;
}

async function fixture(options: { homeDir?: string; id?: string; auth?: boolean; bypass?: boolean; redirect?: boolean; delay?: boolean; version?: string; windowsDesktop?: boolean; product?: string; protocol?: string } = {}) {
  const homeDir = options.homeDir ?? await tempHome();
  const id = options.id ?? serverId;
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
      server_id: id, server_version: options.version ?? "2.6.3", started_at: new Date(now).toISOString(),
      ...(options.windowsDesktop ? { product: options.product ?? "kimi-code-desktop", kimi_agent_protocol_version: options.protocol ?? "1.0.0" } : { backend: "v2" }),
      dangerous_bypass_auth: options.bypass ?? false,
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
  await writeFile(join(homeDir, "server", "instances", `${id}.json`), JSON.stringify({
    server_id: id, pid: process.pid, host: "127.0.0.1", port: address.port,
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
    const value = await fixture({ version: "2.7.1" });
    const endpoint = new URL(value.endpoint);
    await writeFile(join(value.homeDir, "server", "instances", "01KIMICODESECOND123456789AB.json"), JSON.stringify({
      server_id: "01KIMICODESECOND123456789AB", pid: process.pid, host: "127.0.0.1", port: 1,
      started_at: now, heartbeat_at: now, host_version: "2.7.1",
    }));
    const verifyDesktopOwner = async (pid: number, host: string, port: number) =>
      pid === process.pid && host === endpoint.hostname && port === Number(endpoint.port);
    const options = { homeDir: value.homeDir, expectedContracts: contracts, source: "desktop" as const, desktopPlatform: "darwin" as const };
    await expect(KimiWebClient.connect({ ...options, endpoint: value.endpoint, verifyDesktopOwner: async () => false })).rejects.toMatchObject({ reason: "unsupported" });
    const client = await KimiWebClient.connect({ ...options, verifyDesktopOwner });
    expect(client.meta.server_version).toBe("2.7.1");
    expect(client.sessionContract).toBe("legacy"); client.close();
    await expect(KimiWebClient.connect({ ...value, expectedContracts: contracts, verifyDesktopOwner })).rejects.toMatchObject({ reason: "not_running" });
  });

  it("recognizes Windows Desktop metadata without accepting a mismatched product, protocol or Web source", async () => {
    const desktop = await fixture({ version: "2.9.0", windowsDesktop: true });
    const options = { expectedContracts: contracts, source: "desktop" as const, desktopPlatform: "win32" as const, verifyDesktopOwner: async () => true };
    const client = await KimiWebClient.connect({ ...desktop, ...options });
    expect(client.meta).toMatchObject({ product: "kimi-code-desktop", server_version: "2.9.0" });
    expect(client.sessionContract).toBe("desktop-2.8.1");
    client.close();
    await expect(KimiWebClient.connect({ ...desktop, expectedContracts: contracts, verifyDesktopOwner: options.verifyDesktopOwner })).rejects.toMatchObject({ reason: "not_running" });
    await expect(KimiWebClient.connect({ ...desktop, expectedContracts: contracts, verifyDesktopOwner: async () => false })).rejects.toMatchObject({ reason: "unsupported" });
    for (const metadata of [{ product: "kimi-code" }, { protocol: "2.0.0" }]) {
      const value = await fixture({ version: "2.9.0", windowsDesktop: true, ...metadata });
      await expect(KimiWebClient.connect({ ...value, ...options })).rejects.toMatchObject({ reason: "unsupported" });
    }
  });

  it("accepts higher Web versions and rejects a lower version before fetching", async () => {
    const newer = await fixture({ version: "2.10.0" });
    const client = await KimiWebClient.connect({ ...newer, expectedContracts: contracts, verifyDesktopOwner: async () => false });
    expect(client.meta.server_version).toBe("2.10.0");
    client.close();
    const older = await fixture({ version: "2.6.2" });
    const fetcher = vi.fn<typeof fetch>();
    await expect(KimiWebClient.connect({ ...older, expectedContracts: contracts, fetch: fetcher, verifyDesktopOwner: async () => false })).rejects.toMatchObject({ reason: "unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
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

describe("KIMI-12 on-demand launch", () => {
  it("keeps a custom endpoint or a non-default Desktop profile attach-only", async () => {
    const homeDir = await tempHome();
    expect(createKimiLauncher({ source: "web", homeDir, endpoint: "http://127.0.0.1:58627" })).toBeUndefined();
    expect(createKimiLauncher({ source: "desktop", homeDir })).toBeUndefined();
  });

  // Host and phone share a single launch but must not advertise a ready connection before authentication.
  it.each(["web", "desktop"] as const)("reuses the %s source and coalesces concurrent Host and phone requests", async source => {
    const homeDir = await tempHome();
    const target: KimiLauncher["start"] = async ({ shouldStart, waitForConnection }) => {
      expect(await shouldStart()).toBe(true);
      await fixture({ homeDir, version: source === "desktop" ? "2.6.2" : "2.6.4" });
      expect(await waitForConnection()).toBe(process.pid);
    };
    const start = vi.fn(target);
    const kimi = new KimiRuntime({ stateDir: homeDir, homeDir, source, expectedContracts: contracts, now: () => now,
      ...(source === "desktop" ? { desktopPlatform: "darwin" as const, verifyDesktopOwner: async () => true } : {}), launcher: { start, available: async () => true } });
    kimi.start();
    try {
      await vi.waitFor(() => expect(kimi.canLaunch()).toBe(true));
      expect(kimi.connectionState).toBe("not_running");
      expect(kimi.isReady()).toBe(false);
      expect(start).not.toHaveBeenCalled();
      const key = await kimiSourceKey(homeDir);
      await expect(kimi.assertResumeSource(`kimi-code:${source === "web" ? key : `desktop-${key}`}:session_demo`)).resolves.toBeUndefined();
      await expect(kimi.assertResumeSource(`kimi-code:${source === "desktop" ? key : `desktop-${key}`}:session_demo`)).rejects.toMatchObject({ code: "session_not_found" });
      const phone = kimi.ensureReady(), host = kimi.ensureReady();
      expect(kimi.connectionState).toBe("starting");
      await Promise.all([phone, host]);
      expect(kimi.connectionState).toBe("connected");
      await kimi.ensureReady();
      expect(start).toHaveBeenCalledTimes(1);
    } finally { await kimi.stop(); }
    expect(servers[0]?.server.listening).toBe(true);
  });

  it("attaches to an existing service without starting it again", async () => {
    const { homeDir } = await fixture();
    const start = vi.fn();
    const kimi = new KimiRuntime({ stateDir: homeDir, homeDir, now: () => now, expectedContracts: contracts, launcher: { start, available: async () => true } });
    kimi.start();
    try {
      await kimi.ensureReady();
      expect(kimi.isReady()).toBe(true);
      expect(start).not.toHaveBeenCalled();
    } finally { await kimi.stop(); }
  });

  // A failing credential, different contract, non-loopback listener, or multiple instances is not absence.
  it.each(["unauthorized", "unsupported", "ambiguous", "unsafe"] as const)("does not spawn around a %s installation", async reason => {
    const { homeDir } = await fixture({ bypass: reason === "unsupported" });
    const reg = join(homeDir, "server", "instances", `${serverId}.json`);
    const content = JSON.parse(await readFile(reg, "utf8"));
    if (reason === "unauthorized") await writeFile(join(homeDir, "server.token"), randomBytes(32).toString("base64url"));
    if (reason === "ambiguous") await writeFile(join(homeDir, "server", "instances", "01KIMICODESECOND123456789AB.json"),
      JSON.stringify({ ...content, server_id: "01KIMICODESECOND123456789AB" }));
    if (reason === "unsafe") await writeFile(reg, JSON.stringify({ ...content, host: "0.0.0.0" }));
    const start = vi.fn();
    const kimi = new KimiRuntime({ stateDir: homeDir, homeDir, now: () => now, expectedContracts: contracts, launcher: { start, available: async () => true } });
    kimi.start();
    try {
      await expect(kimi.ensureReady()).rejects.toMatchObject({ reason });
      expect(kimi.canLaunch()).toBe(false);
      expect(start).not.toHaveBeenCalled();
    } finally { await kimi.stop(); }
  });

  it("revokes the right to launch if the requesting device leaves before opening the installed program", async () => {
    const homeDir = await tempHome(), opened = vi.fn();
    let resolveCheck!: () => void;
    const letCheck = new Promise<void>(resolve => { resolveCheck = resolve; });
    let current = true;
    const start = vi.fn<KimiLauncher["start"]>(async ({ shouldStart }) => {
      await letCheck;
      if (await shouldStart()) opened();
    });
    const kimi = new KimiRuntime({ stateDir: homeDir, homeDir, launcher: { start, available: async () => true } });
    kimi.start();
    try {
      const failed = expect(kimi.ensureReady(() => current)).rejects.toThrow("启动已取消");
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      current = false;
      resolveCheck();
      await failed;
      expect(opened).not.toHaveBeenCalled();
    } finally { resolveCheck(); await kimi.stop(); }
  });
});
