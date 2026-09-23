import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer, type RelayServer } from "./index.js";
import { RegistrationAuthority } from "./registration.js";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@pi-remote/protocol";
import { RelayAdmin } from "./admin.js";
import type { IncomingMessage, ServerResponse } from "node:http";

describe("Relay web console", () => {
  let relay: RelayServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await relay?.close(); relay = undefined; });

  async function authenticate(path: string, message: unknown): Promise<{ socket: WebSocket; message: Record<string, unknown> }> {
    const socket = new WebSocket(`${relay!.url}${path}`); sockets.push(socket);
    await once(socket, "open"); const reply = once(socket, "message"); socket.send(JSON.stringify(message));
    return { socket, message: JSON.parse(String((await reply)[0])) as Record<string, unknown> };
  }
  async function login(base: string): Promise<Record<string, string>> {
    const response = await fetch(`${base}/v1/admin/login`, { method: "POST", headers: { origin: base }, body: JSON.stringify({ token: "admin-secret" }) });
    expect(response.status).toBe(200);
    const body = await response.json() as { csrf: string };
    return { origin: base, cookie: response.headers.get("set-cookie")!.split(";")[0]!, "x-orbis-csrf": body.csrf };
  }

  it("serves the Orbis site and protects the admin overview behind a session", async () => {
    relay = await createRelayServer({ port: 0, adminToken: "admin-secret", buildCommit: "test-commit" });
    const base = relay.url.replace("ws://", "http://");
    const site = await fetch(`${base}/`);
    expect(site.status).toBe(200);
    expect(await site.text()).toContain("Easy Agents Everywhere");
    expect((await fetch(`${base}/admin/`)).status).toBe(200);
    expect((await fetch(`${base}/v1/admin/overview`)).status).toBe(401);

    const login = await fetch(`${base}/v1/admin/login`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ token: "admin-secret" }),
    });
    expect(login.status).toBe(200);
    const cookieHeader = login.headers.get("set-cookie");
    expect(cookieHeader).toContain("HttpOnly");
    const cookie = cookieHeader!.split(";")[0]!;
    const session = await login.json() as { csrf: string };
    const overview = await fetch(`${base}/v1/admin/overview`, { headers: { cookie } });
    expect(overview.status).toBe(200);
    await expect(overview.json()).resolves.toMatchObject({ buildCommit: "test-commit", registration: { enabled: false } });

    const withoutCsrf = await fetch(`${base}/v1/admin/logout`, { method: "POST", headers: { origin: base, cookie } });
    expect(withoutCsrf.status).toBe(403);
    const logout = await fetch(`${base}/v1/admin/logout`, { method: "POST", headers: { origin: base, cookie, "x-orbis-csrf": session.csrf } });
    expect(logout.status).toBe(204);
    expect((await fetch(`${base}/v1/admin/overview`, { headers: { cookie } })).status).toBe(401);
  });

  it("does not accept admin login without a same-origin request", async () => {
    relay = await createRelayServer({ port: 0, adminToken: "admin-secret" });
    const base = relay.url.replace("ws://", "http://");
    const response = await fetch(`${base}/v1/admin/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "admin-secret" }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects a Host token, foreign origins, missing CSRF and excessive login guesses", async () => {
    relay = await createRelayServer({ adminToken: "admin-secret" });
    const base = relay.url.replace("ws:", "http:");
    expect((await fetch(`${base}/v1/admin/overview`, { headers: { authorization: "Bearer admin-secret" } })).status).toBe(401);
    const headers = await login(base);
    const mutation = `${base}/v1/admin/hosts/unknown`;
    expect((await fetch(mutation, { method: "POST", headers: { cookie: headers.cookie!, origin: base }, body: '{}' })).status).toBe(403);
    expect((await fetch(mutation, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: '{}' })).status).toBe(403);
    for (let i = 0; i < 10; i++) expect((await fetch(`${base}/v1/admin/login`, { method: "POST", headers: { origin: base }, body: JSON.stringify({ token: "wrong" }) })).status).toBe(401);
    expect((await fetch(`${base}/v1/admin/login`, { method: "POST", headers: { origin: base }, body: JSON.stringify({ token: "admin-secret" }) })).status).toBe(429);
  });

  it("persists the QQ verification switch and limits direct registration to its optional state", async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), "orbis-policy-")), "relay.json");
    const registration = await RegistrationAuthority.create({ stateFile: `${stateFile}.registration.json` });
    const options = { stateFile, registration, adminToken: "admin-secret" };
    relay = await createRelayServer(options);
    let base = relay.url.replace("ws:", "http:");
    let headers = await login(base);
    const activation = { hostId: "direct-host-one" };
    const activate = () => fetch(`${base}/v1/registration/activate`, { method: "POST", body: JSON.stringify(activation) });
    const policyUrl = `${base}/v1/admin/registration`;
    const setPolicy = (required: boolean, authorizedHeaders = headers) => fetch(policyUrl, { method: "POST", headers: authorizedHeaders, body: JSON.stringify({ qqEmailVerificationRequired: required }) });
    expect((await activate()).status).toBe(403);
    expect((await fetch(`${base}/v1/registration/status`)).status).toBe(200);
    expect((await setPolicy(false, { authorization: "Bearer admin-secret" })).status).toBe(401);
    expect((await setPolicy(false, { cookie: headers.cookie!, origin: base })).status).toBe(403);
    expect((await setPolicy(false, { ...headers, origin: "https://other.example" })).status).toBe(403);
    expect((await setPolicy(false)).status).toBe(200);
    expect(await (await fetch(`${base}/v1/registration/status`)).json()).toMatchObject({ enabled: true, qqEmailVerificationRequired: false, mailConfigured: false });
    const issued = await (await activate()).json() as { email: string | null; credential: string };
    expect(issued.email).toBeNull();
    expect(registration.hostForCredential(issued.credential)).toBe(activation.hostId);
    expect((await setPolicy(true)).status).toBe(200);
    expect((await fetch(`${base}/v1/registration/activate`, { method: "POST", body: JSON.stringify({ hostId: "direct-host-two" }) })).status).toBe(403);
    expect((await fetch(`${base}/v1/registration/status`)).status).toBe(200);
    expect(await (await fetch(`${base}/v1/registration/status`)).json()).toMatchObject({ enabled: false, qqEmailVerificationRequired: true });
    const overview = await (await fetch(`${base}/v1/admin/overview`, { headers })).json() as { registration: { hosts: number; verifiedHosts: number }; audit: Array<{ action: string }> };
    expect(overview.registration).toMatchObject({ hosts: 1, verifiedHosts: 0 });
    expect(overview.audit[0]?.action).toBe("registration.email_verification");
    await relay.close(); relay = await createRelayServer(options);
    base = relay.url.replace("ws:", "http:"); headers = await login(base);
    expect(await (await fetch(`${base}/v1/registration/status`)).json()).toMatchObject({ enabled: false, qqEmailVerificationRequired: true });
    expect((await authenticate("/v1/runtime", { type: "runtime.authenticate", role: "host", protocolVersion: PROTOCOL_VERSION, credential: issued.credential, runtime: { runtimeId: activation.hostId, name: "Direct Host", cwd: "/", status: "idle" } })).message.type).toBe("runtime.ready");
    expect(await readFile(`${stateFile}.admin.json`, "utf8")).toContain('"qqEmailVerificationRequired":true');
  });

  it("defaults old administrator state to required QQ verification", async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), "orbis-old-admin-")), "admin.json");
    await writeFile(stateFile, JSON.stringify({ version: 1, disabledHosts: [], events: [] }));
    const admin = await RelayAdmin.create({ stateFile, token: "admin-secret" });
    expect(admin.qqEmailVerificationRequired).toBe(true);
    await admin.record("registration.email_verification", "optional", { qqEmailVerificationRequired: false });
    const restarted = await RelayAdmin.create({ stateFile, token: "admin-secret" });
    expect(restarted.qqEmailVerificationRequired).toBe(false);
  });

  it("disables Host routing immediately, persists it across restart, and restores access on enable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-admin-"));
    const stateFile = join(directory, "relay.json");
    let code = "";
    const registration = await RegistrationAuthority.create({ sendMail: async mail => { code = mail.code; } });
    const body = { email: "owner@qq.com", hostId: "host-registered" };
    const challenge = await registration.requestCode(body, "test");
    const activated = await registration.activate({ ...body, ...challenge, code });
    const options = { stateFile, registration, adminToken: "admin-secret", runtimeCredentials: ["legacy-secret"], deviceCredentials: [{ deviceId: "phone-1", credential: "phone-secret", name: '<img src=x onerror=alert(1)>', hostId: body.hostId }] };
    relay = await createRelayServer(options);
    let base = relay.url.replace("ws:", "http:"); let headers = await login(base);
    const hostMessage = { type: "runtime.authenticate", role: "host", protocolVersion: PROTOCOL_VERSION, credential: activated.credential, runtime: { runtimeId: body.hostId, name: "My Host", cwd: "PRIVATE_DIRECTORY", status: "idle" } };
    const host = await authenticate("/v1/runtime", hostMessage);
    const device = await authenticate("/v1/device", { type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "phone-secret" });
    const overview = await (await fetch(`${base}/v1/admin/overview`, { headers })).text();
    expect(overview).toContain('"online":true'); expect(overview).toContain("My Host");
    for (const secret of [activated.credential, "phone-secret", "credentialHash", "PRIVATE_DIRECTORY"]) expect(overview).not.toContain(secret);
    const closed = Promise.all([once(host.socket, "close"), once(device.socket, "close")]);
    expect((await fetch(`${base}/v1/admin/hosts/${body.hostId}`, { method: "POST", headers, body: JSON.stringify({ disabled: true }) })).status).toBe(204);
    await closed;
    expect((await authenticate("/v1/runtime", hostMessage)).message.code).toBe("host_disabled");
    expect((await authenticate("/v1/device", { type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "phone-secret" })).message.code).toBe("host_disabled");
    expect((await fetch(`${base}/v1/pairing-codes`, { method: "POST", headers: { authorization: `Bearer ${activated.credential}` } })).status).toBe(403);
    for (const socket of sockets.splice(0)) socket.terminate();
    await relay.close(); relay = await createRelayServer(options);
    base = relay.url.replace("ws:", "http:"); headers = await login(base);
    expect((await authenticate("/v1/runtime", hostMessage)).message.code).toBe("host_disabled");
    expect((await fetch(`${base}/v1/admin/hosts/${body.hostId}`, { method: "POST", headers, body: JSON.stringify({ disabled: false }) })).status).toBe(204);
    expect((await authenticate("/v1/runtime", hostMessage)).message.type).toBe("runtime.ready");
    const saved = await readFile(`${stateFile}.admin.json`, "utf8");
    expect(saved).toContain("host.enable"); expect(saved).not.toContain("admin-secret");
  });

  it("revokes a device using the protected browser route and prevents reconnection", async () => {
    const stateFile = join(await mkdtemp(join(tmpdir(), "orbis-revoke-")), "state.json");
    relay = await createRelayServer({ stateFile, adminToken: "admin-secret", deviceCredentials: [{ deviceId: "phone-1", credential: "phone-secret", name: "My Phone" }] });
    const base = relay.url.replace("ws:", "http:"); const headers = await login(base);
    const device = await authenticate("/v1/device", { type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "phone-secret" });
    const closed = once(device.socket, "close");
    expect((await fetch(`${base}/v1/admin/devices/phone-1`, { method: "DELETE", headers })).status).toBe(204);
    await closed;
    expect((await authenticate("/v1/device", { type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: "phone-secret" })).message.code).toBe("unauthorized");
    const summary = await (await fetch(`${base}/v1/admin/overview`, { headers })).json() as { devices: unknown[]; audit: Array<{ action: string }> };
    expect(summary.devices).toEqual([]); expect(summary.audit[0]?.action).toBe("device.revoke");
    expect(JSON.parse(await readFile(stateFile, "utf8")).devices).toEqual([]);
  });

  it("expires sessions and uses secure cookies on a public HTTPS origin", async () => {
    let now = 1_000;
    const admin = await RelayAdmin.create({ token: "admin-secret", now: () => now });
    let cookie = "";
    const response = { setHeader: (_: string, value: string) => { cookie = value; } } as unknown as ServerResponse;
    const request = { headers: { host: "relay.example", origin: "https://relay.example" }, socket: { remoteAddress: "test" } } as IncomingMessage;
    const session = admin.login(request, response, "admin-secret");
    expect(cookie).toContain("Secure"); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
    request.headers.cookie = cookie.split(";")[0]!;
    expect(admin.authenticate(request).csrf).toBe(session.csrf);
    now += 8 * 60 * 60_000 + 1;
    expect(() => admin.authenticate(request)).toThrow("unauthorized");
  });

  it("serves only allowlisted web assets and verified download names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-downloads-"));
    const name = "OrbisHost-0.1.0-windows-x64-setup.exe";
    await writeFile(join(directory, name), "test artifact");
    await writeFile(join(directory, `${name}.sha256`), `${"a".repeat(64)}  ${name}`);
    await writeFile(join(directory, "secret.env"), "never served");
    relay = await createRelayServer({ downloadsDir: directory });
    const base = relay.url.replace("ws:", "http:");
    const site = await fetch(base);
    expect(site.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(site.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect((await fetch(`${base}/assets/admin.js`)).headers.get("content-type")).toContain("javascript");
    const redirect = await fetch(`${base}/admin`, { redirect: "manual" });
    expect(redirect.headers.get("location")).toBe("admin/");
    expect((await fetch(`${base}/downloads/secret.env`)).status).toBe(404);
    expect((await fetch(`${base}/assets/../main.js`)).status).toBe(404);
    const release = await fetch(`${base}/downloads/${name}`);
    expect(await release.text()).toBe("test artifact");
    expect(release.headers.get("content-disposition")).toContain(name);
    expect((await fetch(`${base}/downloads/${name}`, { method: "HEAD" })).headers.get("content-length")).toBe("13");
  });
});
