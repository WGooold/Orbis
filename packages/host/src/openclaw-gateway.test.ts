import { createHash, createPublicKey, verify } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { buildDeviceAuthPayloadV3 } from "@openclaw/gateway-client";
import { loadOpenClawConfig, OpenClawGateway, openClawRequestedScopes, openClawUrl, readOpenClawDesktopSettings, saveOpenClawDesktopSettings, type OpenClawAccess } from "./openclaw-gateway.js";

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
  expect(await loadOpenClawConfig(dir, { ORBIS_OPENCLAW_URL: "ws://[::1]:19000/" })).toEqual({ url: "ws://[::1]:19000", environment: true });
  expect(await loadOpenClawConfig(dir, { ORBIS_OPENCLAW_TOKEN: "override" })).toEqual({ url: "ws://127.0.0.1:18789", token: "override", environment: true });
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
  expect(await save(endpoint, "desktop-token")).toEqual({ source: "file", url: endpoint, access: "auto", hasToken: true, invalid: false });
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
  expect(await readOpenClawDesktopSettings(dir, {})).toEqual({ source: "file", url: "", access: "auto", hasToken: false, invalid: true });
  expect(await save("")).toEqual({ source: "file", url: "", access: "auto", hasToken: false, invalid: false });
  expect(await loadOpenClawConfig(dir, {})).toBeUndefined();
});

// OPENCLAW-HOST-SETTINGS-01: explicit grant and credential edits are bound to one endpoint.
test("keeps access policy and token on a same-endpoint edit, and does not carry either to another endpoint", async () => {
  const dir = await stateDir();
  const endpoint = "wss://gateway.example.net";
  const save = (url: string, token = "", options?: { access?: unknown; clearToken?: unknown }) => saveOpenClawDesktopSettings(dir, url, token, {}, options);
  expect(await save(endpoint, "fixture", { access: "admin" })).toMatchObject({ hasToken: true, access: "admin" });
  expect(await save(endpoint, "", { access: "sessions" })).toMatchObject({ hasToken: true, access: "sessions" });
  expect(await save(endpoint)).toMatchObject({ hasToken: true, access: "sessions" });
  await expect(save(endpoint, "secret", { clearToken: true })).rejects.toThrow(/凭据操作无效/);
  await expect(save(endpoint, "", { access: ["operator.admin"] })).rejects.toThrow(/权限选项无效/);
  expect(await loadOpenClawConfig(dir, {})).toEqual({ url: endpoint, token: "fixture", access: "sessions" });
  expect(await loadOpenClawConfig(dir, { ORBIS_OPENCLAW_ACCESS: "admin" })).toEqual({ url: endpoint, token: "fixture", access: "admin", environment: true });
  expect(await readOpenClawDesktopSettings(dir, { ORBIS_OPENCLAW_ACCESS: "admin" })).toEqual({
    source: "environment", url: endpoint, hasToken: true, invalid: false, access: "admin",
  });
  await expect(saveOpenClawDesktopSettings(dir, endpoint, "", { ORBIS_OPENCLAW_ACCESS: "sessions" }, { access: "admin" })).rejects.toThrow(/环境变量/);
  expect(await save(endpoint, "", { clearToken: true })).toMatchObject({ hasToken: false, access: "sessions" });
  await save(endpoint, "fixture", { access: "admin" });
  expect(await save("wss://new.example.net")).toMatchObject({ hasToken: false, access: "auto" });
});

// A mode switch is not a reinterpretation of the old token, and a readback never sends a password to Qt.
test("saves Gateway password authentication without disclosing or migrating the credential", async () => {
  const dir = await stateDir(), endpoint = "wss://gateway.example.net";
  const save = (secret: string, options: { auth?: unknown; clearToken?: unknown } = {}) => saveOpenClawDesktopSettings(dir, endpoint, secret, {}, options);
  await save("old-token");
  expect(await save("", { auth: "password" })).toMatchObject({ auth: "password", hasToken: false, hasPassword: false });
  expect(await save("fixture-password", { auth: "password" })).toMatchObject({ auth: "password", hasPassword: true });
  expect(JSON.stringify(await readOpenClawDesktopSettings(dir, {}))).not.toContain("fixture-password");
  expect(await loadOpenClawConfig(dir, {})).toEqual({ url: endpoint, auth: "password", password: "fixture-password" });
  expect(await loadOpenClawConfig(dir, { ORBIS_OPENCLAW_TOKEN: "replacement" })).toEqual({ url: endpoint, token: "replacement", environment: true });
  expect(await loadOpenClawConfig(dir, { ORBIS_OPENCLAW_URL: "wss://other.example.net", ORBIS_OPENCLAW_PASSWORD: "other-password" })).toEqual({ url: "wss://other.example.net", auth: "password", password: "other-password", environment: true });
  await expect(loadOpenClawConfig(dir, { ORBIS_OPENCLAW_TOKEN: "one", ORBIS_OPENCLAW_PASSWORD: "two" })).rejects.toThrow(/只能配置一种/);
  expect(await save("", { clearToken: true })).toMatchObject({ auth: "password", hasPassword: false });
});

// OPENCLAW-LOCAL-ADMIN-01: do not extend the local default to TLS/remote connections.
test("only explicit loopback ws endpoints use the SDK's default operator scopes", () => {
  expect(openClawRequestedScopes("ws://127.0.0.1:18789")).toBeUndefined();
  expect(openClawRequestedScopes("ws://[::1]:18789")).toBeUndefined();
  expect(openClawRequestedScopes("wss://gateway.example.net")).toEqual(["operator.read", "operator.write"]);
  expect(openClawRequestedScopes("wss://127.0.0.1:18789")).toEqual(["operator.read", "operator.write"]);
  expect(openClawRequestedScopes("ws://127.0.0.1:18789", "sessions")).toEqual(["operator.read", "operator.write"]);
  expect(openClawRequestedScopes("wss://gateway.example.net", "admin")).toEqual(["operator.admin"]);
  expect(() => openClawRequestedScopes("ws://gateway.example.net")).toThrow(/wss/);
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
  const connects: Array<{ deviceId: string; token: string; valid: boolean; password?: string }> = [];
  const requestedScopes: string[][] = [];
  let scopes = ["operator.admin"];
  let needsPairing = false, rotateSharedToken = false, tokenRejected = false;
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
      requestedScopes.push(frame.params.scopes);
      const raw = Buffer.from(device.publicKey, "base64url");
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: device.publicKey }, format: "jwk" });
      const signed = buildDeviceAuthPayloadV3({ deviceId: device.id, clientId: client.id, clientMode: client.mode, role,
        scopes: frame.params.scopes, signedAtMs: ts, token: auth.token ?? auth.deviceToken ?? null, nonce, platform: client.platform, deviceFamily: client.deviceFamily });
      connects.push({ deviceId: device.id, token: auth.deviceToken ?? auth.token, ...(auth.password ? { password: auth.password } : {}),
        valid: device.nonce === nonce && device.signedAt === ts && createHash("sha256").update(raw).digest("hex") === device.id &&
          verify(null, Buffer.from(signed), key, Buffer.from(device.signature, "base64url")) });
      if (needsPairing) {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { code: "NOT_PAIRED", message: "fixture approval required",
          details: { code: "PAIRING_REQUIRED", reason: "not-paired", requestId: "fixture-pairing" } } }));
        return;
      }
      if (rotateSharedToken && auth.deviceToken !== "paired-token") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { code: "INVALID_REQUEST", message: "obsolete credential",
          details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true } } }));
        return;
      }
      if (tokenRejected) {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { code: "INVALID_REQUEST",
          message: "server-controlled secret fixture", details: { code: "AUTH_TOKEN_MISMATCH" } } }));
        return;
      }
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", protocol: 4,
        server: { version: "fixture", connId: "fixture" }, features: { methods: ["sessions.list", "sessions.create", "sessions.subscribe",
          "sessions.messages.subscribe", "sessions.messages.unsubscribe", "sessions.patch", "chat.history", "chat.send", "chat.abort", "config.get", "config.patch"], events: [] },
        snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
        auth: { role: "operator", scopes, deviceToken: "paired-token" },
        policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 10000 } } }));
    });
  });
  const events = { online: vi.fn(), offline: vi.fn(), event: vi.fn(), gap: vi.fn(), log: vi.fn() };
  const start = async (token?: string, access?: OpenClawAccess): Promise<OpenClawGateway> => {
    const gateway = await OpenClawGateway.create({ url, ...(token ? { token } : {}), ...(access ? { access } : {}) }, dir, events);
    cleanups.push(() => gateway.stop()); gateway.start(); return gateway;
  };
  const first = await start("bootstrap-token");
  await vi.waitFor(() => expect(first.ready).toBe(true));
  expect(await first.request("sessions.list", {})).toEqual({ method: "sessions.list" });
  expect(first.connectionState).toEqual({ phase: "connected", granted: "admin", canEdit: true });
  const firstSettings = first.settingsConnection!;
  await expect(firstSettings.request("config.get", {})).resolves.toEqual({ method: "config.get" });
  await first.stop();
  await expect(firstSettings.request("config.patch", {})).rejects.toThrow(/unavailable/);
  expect(await readdir(join(dir, "openclaw", createHash("sha256").update(url).digest("hex")))).toHaveLength(2);
  const second = await start();
  await vi.waitFor(() => expect(second.ready).toBe(true));
  expect(connects).toEqual([{ deviceId: connects[0]?.deviceId, token: "bootstrap-token", valid: true },
    { deviceId: connects[0]?.deviceId, token: "paired-token", valid: true }]);
  // OPENCLAW-LOCAL-ADMIN-01: fresh shared-token auth and reconnect both send the authorized scope.
  expect(requestedScopes).toEqual([["operator.admin"], ["operator.admin"]]);
  await second.stop();
  // HOST-AGENT-START-01: after native approval, retry only the transport and keep the same Orbis identity.
  needsPairing = true;
  const pending = await start();
  await vi.waitFor(() => expect(pending.issue).toBe("pairing_required"));
  expect(pending.ready).toBe(false);
  expect(pending.connectionState).toEqual({ phase: "pairing_required", granted: "none", canEdit: false, approvalId: "fixture-pairing" });
  needsPairing = false;
  await pending.retryLocal(() => {});
  await vi.waitFor(() => expect(pending.ready).toBe(true));
  expect(pending.issue).toBeUndefined();
  expect(connects.at(-1)?.deviceId).toBe(connects[0]?.deviceId);
  await pending.stop();
  scopes = ["operator.read"];
  const third = await start("bootstrap-token");
  await vi.waitFor(() => expect(third.issue).toBe("session_access_denied"));
  expect(third.ready).toBe(false);
  await expect(third.request("chat.send", {})).rejects.toThrow(/offline/);
  await third.stop();
  // A token from an older read/write pairing can still connect without a scope upgrade.
  scopes = ["operator.read", "operator.write"];
  const tokenFile = join(dir, "openclaw", createHash("sha256").update(url).digest("hex"), `${connects[0]?.deviceId}.json`);
  await writeFile(tokenFile, JSON.stringify({ token: "paired-token", scopes }), { mode: 0o600 });
  const existing = await start();
  await vi.waitFor(() => expect(existing.ready).toBe(true));
  expect(connects.at(-1)?.token).toBe("paired-token");
  expect(requestedScopes.at(-1)).toEqual(scopes);
  expect(existing.connectionState).toEqual({ phase: "connected", granted: "sessions", canEdit: false });
  expect(existing.settingsConnection).toBeUndefined();
  await existing.stop();

  // Explicit administrator selection must not silently fall back to session read/write.
  const refused = await start("bootstrap-token", "admin");
  await vi.waitFor(() => expect(refused.connectionState.phase).toBe("access_denied"));
  expect(requestedScopes.at(-1)).toEqual(["operator.admin"]);
  expect(refused.settingsConnection).toBeUndefined();
  await refused.stop();
  scopes = ["operator.admin"];
  const limited = await start("bootstrap-token", "sessions");
  await vi.waitFor(() => expect(limited.connectionState.phase).toBe("access_denied"));
  expect(requestedScopes.at(-1)).toEqual(["operator.read", "operator.write"]);
  expect(limited.settingsConnection).toBeUndefined();
  await limited.stop();
  tokenRejected = true;
  const mismatched = await start("stale-token");
  await vi.waitFor(() => expect(mismatched.connectionState.phase).toBe("token_rejected"));
  expect(JSON.stringify(events.log.mock.calls)).not.toContain("server-controlled secret fixture");
  await mismatched.stop();
  tokenRejected = false;
  const configured = await OpenClawGateway.create({ url, auth: "password", password: "fixture-password" }, dir, events);
  cleanups.push(() => configured.stop()); configured.start();
  await vi.waitFor(() => expect(configured.ready).toBe(true));
  expect(connects.at(-1)).toMatchObject({ password: "fixture-password", valid: true });

  // A rotated shared token needn't block a paired device. Do not announce a
  // mismatch while the SDK's one allowed stored-token retry is in flight.
  rotateSharedToken = true;
  const before = connects.length;
  events.log.mockClear();
  const rotated = await start("previously-valid-token");
  await vi.waitFor(() => expect(rotated.ready).toBe(true), { timeout: 3_000 });
  expect(connects.slice(before).map(row => row.token)).toEqual(["previously-valid-token", "paired-token"]);
  expect(rotated.issue).toBeUndefined();
  expect(events.log.mock.calls.flat()).not.toContain("OpenClaw Gateway: token_mismatch");
});

// OPENCLAW-RECOVERY-01: only a confirmed local refusal or structured Gateway
// rejection diagnoses the failure. Reconnect keeps the endpoint and pairing identity.
test("reports a closed local port with no claim about Gateway auth", async () => {
  const dir = await stateDir();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  await new Promise<void>(resolve => server.close(() => resolve()));
  const gateway = await OpenClawGateway.create({ url: `ws://127.0.0.1:${address.port}` }, dir,
    { online: vi.fn(), offline: vi.fn(), event: vi.fn(), gap: vi.fn() });
  cleanups.push(() => gateway.stop());
  gateway.start();
  await vi.waitFor(() => expect(gateway.issue).toBe("local_port_closed"));
  expect(gateway.ready).toBe(false);
});

test.each([
  ["AUTH_TOKEN_MISSING", false, "token_missing"],
  ["AUTH_TOKEN_MISSING", true, "environment_token_missing"],
  ["AUTH_TOKEN_MISMATCH", false, "token_mismatch"],
  ["AUTH_TOKEN_MISMATCH", true, "environment_token_mismatch"],
  ["AUTH_TOKEN_NOT_CONFIGURED", false, "gateway_token_unconfigured"],
  ["AUTH_DEVICE_TOKEN_MISMATCH", false, "device_token_rejected"],
  ["PAIRING_EXPIRED", false, "pairing_rejected"],
  ["AUTH_SCOPE_MISMATCH", false, "session_access_denied"],
  ["PROTOCOL_MISMATCH", false, "version_incompatible"],
  ["CLIENT_VERSION_MISMATCH", false, "version_incompatible"],
  ["UNKNOWN_FIXTURE_DETAIL", false, "connect_unconfirmed"],
  ["startup-sidecars", false, "starting"],
] as const)("uses safe next steps for structured Gateway reply %s (environment=%s)", async (code, environment, issue) => {
  const dir = await stateDir();
  const secret = "fixture-private-message-or-url";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture", ts: Date.now() } }));
    socket.on("message", raw => {
      const { id } = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ type: "res", id, ok: false, error: code === "startup-sidecars"
        ? { code: "UNAVAILABLE", message: secret, retryable: true, details: { reason: code } }
        : { code: "INVALID_REQUEST", message: secret, details: { code, remediationHint: secret, requestId: secret } } }));
    });
  });
  const events = { online: vi.fn(), offline: vi.fn(), event: vi.fn(), gap: vi.fn(), log: vi.fn() };
  const gateway = await OpenClawGateway.create({ url: `ws://127.0.0.1:${address.port}`, ...(environment ? { environment: true } : {}) }, dir, events);
  cleanups.push(() => gateway.stop());
  gateway.start();
  await vi.waitFor(() => expect(gateway.issue).toBe(issue));
  expect(gateway.ready).toBe(false);
  expect(events.online).not.toHaveBeenCalled();
  expect(events.log).toHaveBeenCalledExactlyOnceWith(`OpenClaw Gateway: ${issue}`);
  expect(JSON.stringify(events.log.mock.calls)).not.toContain(secret);
});

// OPENCLAW-RECOVERY-01: only a confirmed local refusal or structured Gateway
// rejection diagnoses the failure. Reconnect keeps the endpoint and pairing identity.
test("reports a closed local port with no claim about Gateway auth", async () => {
  const dir = await stateDir();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  await new Promise<void>(resolve => server.close(() => resolve()));
  const gateway = await OpenClawGateway.create({ url: `ws://127.0.0.1:${address.port}` }, dir,
    { online: vi.fn(), offline: vi.fn(), event: vi.fn(), gap: vi.fn() });
  cleanups.push(() => gateway.stop());
  gateway.start();
  await vi.waitFor(() => expect(gateway.issue).toBe("local_port_closed"));
  expect(gateway.ready).toBe(false);
});

test.each([
  ["AUTH_TOKEN_MISSING", false, "token_missing"],
  ["AUTH_TOKEN_MISSING", true, "environment_token_missing"],
  ["AUTH_TOKEN_MISMATCH", false, "token_mismatch"],
  ["AUTH_TOKEN_MISMATCH", true, "environment_token_mismatch"],
  ["AUTH_TOKEN_NOT_CONFIGURED", false, "gateway_token_unconfigured"],
  ["AUTH_DEVICE_TOKEN_MISMATCH", false, "device_token_rejected"],
  ["PAIRING_EXPIRED", false, "pairing_rejected"],
  ["AUTH_SCOPE_MISMATCH", false, "session_access_denied"],
  ["PROTOCOL_MISMATCH", false, "version_incompatible"],
  ["CLIENT_VERSION_MISMATCH", false, "version_incompatible"],
  ["UNKNOWN_FIXTURE_DETAIL", false, "connect_unconfirmed"],
  ["startup-sidecars", false, "starting"],
] as const)("uses safe next steps for structured Gateway reply %s (environment=%s)", async (code, environment, issue) => {
  const dir = await stateDir();
  const secret = "fixture-private-message-or-url";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture", ts: Date.now() } }));
    socket.on("message", raw => {
      const { id } = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ type: "res", id, ok: false, error: code === "startup-sidecars"
        ? { code: "UNAVAILABLE", message: secret, retryable: true, details: { reason: code } }
        : { code: "INVALID_REQUEST", message: secret, details: { code, remediationHint: secret, requestId: secret } } }));
    });
  });
  const events = { online: vi.fn(), offline: vi.fn(), event: vi.fn(), gap: vi.fn(), log: vi.fn() };
  const gateway = await OpenClawGateway.create({ url: `ws://127.0.0.1:${address.port}`, ...(environment ? { environment: true } : {}) }, dir, events);
  cleanups.push(() => gateway.stop());
  gateway.start();
  await vi.waitFor(() => expect(gateway.issue).toBe(issue));
  expect(gateway.ready).toBe(false);
  expect(events.online).not.toHaveBeenCalled();
  expect(events.log).toHaveBeenCalledExactlyOnceWith(`OpenClaw Gateway: ${issue}`);
  expect(JSON.stringify(events.log.mock.calls)).not.toContain(secret);
});
