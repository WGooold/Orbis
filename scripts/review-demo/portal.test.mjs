import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createRelayServer } from "@orbis/relay";
import { decodePairingQrText, loadOrCreateHostIdentity } from "@orbis/e2e";
import { HostService } from "../../packages/host/src/host-service.ts";
import { SessionSpawner } from "../../packages/host/src/spawner.ts";
import { createPortal } from "./portal.mjs";
import { connectDevice } from "./device.mjs";
import { configurePi } from "./pi-config.mjs";

let relay, host, portal, dir, device, spawner;
afterEach(async () => {
  for (const agent of spawner?.running ?? []) { try { process.kill(-agent.pid, "SIGTERM"); } catch { /* Exited. */ } }
  for (let n = 0; n < 100 && spawner?.running.length; n++) await delay(50);
  for (const agent of spawner?.running ?? []) { try { process.kill(-agent.pid, "SIGKILL"); } catch { /* Exited. */ } }
  for (let n = 0; n < 20 && spawner?.running.length; n++) await delay(50);
  const remaining = spawner?.running ?? [];
  await device?.close(); await portal?.close(); await host?.stop(); await relay?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  relay = host = portal = dir = device = spawner = undefined;
  expect(remaining).toHaveLength(0);
});

async function setup(publicRelayUrl) {
  dir = await mkdtemp(join(tmpdir(), "orbis-review-test-"));
  relay = await createRelayServer({ host: "127.0.0.1", port: 0, runtimeCredentials: ["review-runtime"], adminToken: "review-admin" });
  await loadOrCreateHostIdentity({ dir, hostName: "Orbis Review Demo" });
  host = await HostService.create({ relayUrl: relay.url, stateDir: dir, sessionsRoot: join(dir, "sessions"),
    credential: "review-runtime", adminToken: "review-admin", lan: false, loopback: false, reconnect: false });
  await host.start();
  portal = await createPortal({ hostService: host, publicRelayUrl: publicRelayUrl ?? relay.url, host: "127.0.0.1", port: 0 });
}

async function pair() {
  return fetch(`${portal.url}/pair`, { method: "POST", headers: { "x-review-request": "1" } });
}

it("registers a real headless Pi through the standard local Host channel without calling a model", async () => {
  dir = await mkdtemp(join(tmpdir(), "orbis-review-config-"));
  await configurePi(dir);
  relay = await createRelayServer({ host: "127.0.0.1", port: 0, runtimeCredentials: ["review-runtime"], adminToken: "review-admin" });
  spawner = new SessionSpawner({ stateDir: dir, env: {
    PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, ORBIS_STATE_DIR: dir, PI_OFFLINE: "1",
    DEEPSEEK_API_KEY: "unused-test-placeholder",
    ORBIS_PI_ENTRY: fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url)),
    ORBIS_EXTENSION_PATH: fileURLToPath(new URL("../../packages/pi-extension/dist/index.js", import.meta.url)),
  } });
  host = await HostService.create({ relayUrl: relay.url, stateDir: dir, sessionsRoot: join(dir, "sessions"),
    credential: "review-runtime", adminToken: "review-admin", lan: false, reconnect: false, spawner });
  await host.start();
  await spawner.activate({ deviceId: "test", target: { type: "new", agentKind: "pi", cwd: dir }, spawnMode: "headless" });
  const end = Date.now() + 20_000;
  while (!host.localRuntimes.length && Date.now() < end) await delay(100);
  expect(host.localRuntimes).toHaveLength(1);
  expect(await realpath(host.localRuntimes[0].cwd)).toBe(await realpath(dir));
}, 30_000);

it("uses the public Relay URL while keeping a fresh, ordinary short-lived pairing payload", async () => {
  await setup("wss://orbising.com/review-relay");
  const response = await pair(); expect(response.status).toBe(200);
  const body = await response.json(); const qr = decodePairingQrText(body.text);
  expect(qr.relayUrl).toBe("wss://orbising.com/review-relay");
  expect(qr.hostId).toBe(host.hostId); expect(qr.hostName).toBe("Orbis Review Demo");
  expect(qr.exp * 1000 - Date.now()).toBeGreaterThan(115_000);
  expect(qr.exp * 1000 - Date.now()).toBeLessThanOrEqual(120_000);
  expect(qr.lan).toBeUndefined(); expect(body.image).toMatch(/^data:image\/png;base64,/u);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body.text).not.toContain("review-admin"); expect(body.text).not.toContain("review-runtime");
});

it("pairs and exchanges encrypted mobile messages, then issues another one-use code", async () => {
  await setup(); const body = await (await pair()).json();
  device = await connectDevice(body.text);
  expect(device.ready.deviceId).toBe(host.devices[0].deviceId);
  device.send({ type: "session.list", requestId: "demo-sessions" });
  const list = await device.matching(message => message.type === "session.list.result" && message.requestId === "demo-sessions");
  expect(list.sessions).toEqual([]); expect(host.devices).toHaveLength(1);
  const replay = await fetch(`${relay.url.replace(/^ws/u, "http")}/v1/pairings`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ code: device.qr.code, deviceName: "Replay" }) });
  expect(replay.ok).toBe(false);
  const next = decodePairingQrText((await (await pair()).json()).text);
  expect(next.psk).not.toBe(device.qr.psk); expect(next.code).not.toBe(device.qr.code);
});

it("requires the same-origin request header and provides a page without embedded pairing secrets", async () => {
  await setup();
  expect((await fetch(`${portal.url}/pair`, { method: "POST" })).status).toBe(403);
  const response = await fetch(portal.url); const page = await response.text();
  expect(page).toContain("Generate a fresh pairing QR code");
  expect(page).not.toContain("review-admin"); expect(page).not.toContain('"psk":');
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});
