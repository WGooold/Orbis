import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client";
import { loadOpenClawConfig, OpenClawGateway, openClawUrl, readOpenClawDesktopSettings, saveOpenClawDesktopSettings } from "./openclaw-gateway.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function stateDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "orbis-openclaw-test-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

// Remote Gateway tokens travel only over TLS; endpoint credentials remain scoped.
test("OPENCLAW-01 admits local WebSocket or remote TLS endpoints and keeps credential sources scoped", async () => {
  const dir = await stateDir();
  expect(await loadOpenClawConfig(dir, {})).toBeUndefined();
  await writeFile(join(dir, "openclaw-gateway.json"), JSON.stringify({ url: "ws://127.0.0.1:18789", token: "bootstrap" }), { mode: 0o600 });
  expect(await loadOpenClawConfig(dir, {})).toEqual({ url: "ws://127.0.0.1:18789", token: "bootstrap" });
  expect(await loadOpenClawConfig(dir, { ORBIS_OPENCLAW_URL: "ws://[::1]:19000/" })).toEqual({ url: "ws://[::1]:19000" });
  expect(await loadOpenClawConfig(dir, { ORBIS_OPENCLAW_URL: "" })).toBeUndefined();
  expect(openClawUrl("wss://gateway.example.net")).toBe("wss://gateway.example.net");
  expect(openClawUrl("wss://[2001:db8::1]:9443")).toBe("wss://[2001:db8::1]:9443");
  for (const url of ["https://127.0.0.1", "ws://gateway.example.net", "ws://localhost", "ws://u:p@127.0.0.1",
    "ws://127.0.0.1/other", "ws://127.0.0.1/?token=x"]) expect(() => openClawUrl(url)).toThrow();
  if (process.platform !== "win32") {
    await chmod(join(dir, "openclaw-gateway.json"), 0o644);
    await expect(loadOpenClawConfig(dir, {})).rejects.toThrow(/private regular file/);
  }
});

// OPENCLAW-04: neither desktop settings nor failed writes leak or move the shared token.
test("desktop saves the private config, retains the token only on the same endpoint and honors environment overrides", async () => {
  const dir = await stateDir();
  const endpoint = "ws://127.0.0.1:18789", path = join(dir, "openclaw-gateway.json");
  const save = (url: string, token = "") => saveOpenClawDesktopSettings(dir, url, token, {});
  expect(await save(endpoint, "desktop-token")).toEqual({ source: "file", url: endpoint, hasToken: true, invalid: false });
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await save(`${endpoint}/`)).toHaveProperty("hasToken", true);
  expect(await loadOpenClawConfig(dir, {})).toEqual({ url: endpoint, token: "desktop-token" });
  await expect(save("ws://example.com", "wrong")).rejects.toThrow(/wss/);
  expect(await save("wss://gateway.example.net", "remote-token")).toHaveProperty("hasToken", true);
  expect(await loadOpenClawConfig(dir, {})).toEqual({ url: "wss://gateway.example.net", token: "remote-token" });
  for (const env of [{ ORBIS_OPENCLAW_URL: "" }, { ORBIS_OPENCLAW_TOKEN: "environment-token" }]) {
    expect(await readOpenClawDesktopSettings(dir, env)).toHaveProperty("source", "environment");
    await expect(saveOpenClawDesktopSettings(dir, "", "", env)).rejects.toThrow(/环境变量/);
  }
  const other = "ws://[::1]:18789";
  expect(await save(other)).toHaveProperty("hasToken", false);
  expect(await loadOpenClawConfig(dir, {})).toEqual({ url: other });
  await writeFile(path, "invalid");
  expect(await readOpenClawDesktopSettings(dir, {})).toEqual({ source: "file", url: "", hasToken: false, invalid: true });
  expect(await save("")).toEqual({ source: "file", url: "", hasToken: false, invalid: false });
  expect(await loadOpenClawConfig(dir, {})).toBeUndefined();
});

// Exercise the published SDK against real WebSocket frames, not a mocked SDK method.
test("OPENCLAW-01 signs the nonce, checks scope/RPC admission and reuses its device proof and token", async () => {
  const dir = await stateDir();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (typeof address !== "object" || !address) throw new Error("missing address");
  const url = `ws://127.0.0.1:${address.port}`;
  const connects: Array<{ deviceId: string; token: string; valid: boolean }> = [];
  let scopes = ["operator.read", "operator.write"];
  server.on("connection", socket => {
    const nonce = `nonce-${connects.length}`;
    const ts = Date.now();
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce, ts } }));
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.method !== "connect") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { method: frame.method } }));
        return;
      }
      const { device, client, role, auth } = frame.params;
      const raw = Buffer.from(device.publicKey, "base64url");
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: device.publicKey }, format: "jwk" });
      const signed = buildDeviceAuthPayloadV3({ deviceId: device.id, clientId: client.id, clientMode: client.mode, role,
        scopes: frame.params.scopes, signedAtMs: ts, token: auth.token ?? auth.deviceToken, nonce, platform: client.platform, deviceFamily: client.deviceFamily });
      connects.push({ deviceId: device.id, token: auth.deviceToken ?? auth.token,
        valid: device.nonce === nonce && device.signedAt === ts && createHash("sha256").update(raw).digest("hex") === device.id &&
          verify(null, Buffer.from(signed), key, Buffer.from(device.signature, "base64url")) });
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", protocol: 4,
        server: { version: "fixture", connId: "fixture" }, features: { methods: ["sessions.list", "sessions.create", "sessions.subscribe",
          "sessions.messages.subscribe", "sessions.messages.unsubscribe", "sessions.patch", "chat.history", "chat.send", "chat.abort"], events: [] },
        snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
        auth: { role: "operator", scopes, deviceToken: "paired-token" },
        policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 10000 } } }));
    });
  });
  const events = { online: vi.fn(), offline: vi.fn(), event: vi.fn(), gap: vi.fn(), log: vi.fn() };
  const start = async (token?: string): Promise<OpenClawGateway> => {
    const gateway = await OpenClawGateway.create({ url, ...(token ? { token } : {}) }, dir, events);
    cleanups.push(() => gateway.stop()); gateway.start(); return gateway;
  };
  const first = await start("bootstrap-token");
  await vi.waitFor(() => expect(first.ready).toBe(true));
  expect(await first.request("sessions.list", {})).toEqual({ method: "sessions.list" });
  await first.stop();
  expect(await readdir(join(dir, "openclaw", createHash("sha256").update(url).digest("hex")))).toHaveLength(2);
  const second = await start();
  await vi.waitFor(() => expect(second.ready).toBe(true));
  expect(connects).toEqual([{ deviceId: connects[0]?.deviceId, token: "bootstrap-token", valid: true },
    { deviceId: connects[0]?.deviceId, token: "paired-token", valid: true }]);
  await second.stop();
  scopes = ["operator.read"];
  const third = await start("bootstrap-token");
  await vi.waitFor(() => expect(events.log).toHaveBeenCalledWith(expect.stringContaining("required operator scopes")));
  expect(third.ready).toBe(false);
  await expect(third.request("chat.send", {})).rejects.toThrow(/offline/);
});
