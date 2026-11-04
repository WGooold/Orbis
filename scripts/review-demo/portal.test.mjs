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
import { createFixedReviewPairing } from "./fixed-pairing.mjs";

let relay, host, portal, dir, device, spawner, pairing, identity;
afterEach(async () => {
  for (const agent of spawner?.running ?? []) { try { process.kill(-agent.pid, "SIGTERM"); } catch { /* Exited. */ } }
  for (let n = 0; n < 100 && spawner?.running.length; n++) await delay(50);
  for (const agent of spawner?.running ?? []) { try { process.kill(-agent.pid, "SIGKILL"); } catch { /* Exited. */ } }
  for (let n = 0; n < 20 && spawner?.running.length; n++) await delay(50);
  const remaining = spawner?.running ?? [];
  await device?.close(); await portal?.close(); await host?.stop(); await relay?.close(); pairing?.dispose();
  if (dir) await rm(dir, { recursive: true, force: true });
  relay = host = portal = dir = device = spawner = pairing = identity = undefined;
  expect(remaining).toHaveLength(0);
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "orbis-review-test-"));
  relay = await createRelayServer({ host: "127.0.0.1", port: 0, runtimeCredentials: ["review-runtime"], adminToken: "review-admin" });
  identity = await loadOrCreateHostIdentity({ dir, hostName: "Orbis Review Demo" });
  host = await HostService.create({ relayUrl: relay.url, stateDir: dir, sessionsRoot: join(dir, "sessions"),
    credential: "review-runtime", adminToken: "review-admin", lan: false, loopback: false, reconnect: false,
    onPaired: current => { for (const previous of host.devices) if (previous.deviceId !== current.deviceId) host.revokeDevice(previous.deviceId); } });
  pairing = await createFixedReviewPairing({ host, identity, accessPath: join(dir, "review-pairing.json"), publicRelayUrl: relay.url });
  await host.start();
  portal = await createPortal({ pairing, relayUrl: relay.url, adminToken: "review-admin", host: "127.0.0.1", port: 0 });
}

it("registers a real Pi through the standard local Host channel without a model call", async () => {
  dir = await mkdtemp(join(tmpdir(), "orbis-review-config-")); await configurePi(dir);
  relay = await createRelayServer({ host: "127.0.0.1", port: 0, runtimeCredentials: ["review-runtime"], adminToken: "review-admin" });
  spawner = new SessionSpawner({ stateDir: dir, env: {
    PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir, ORBIS_STATE_DIR: dir, PI_OFFLINE: "1", DEEPSEEK_API_KEY: "unused-test-placeholder",
    ORBIS_PI_ENTRY: fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url)),
    ORBIS_EXTENSION_PATH: fileURLToPath(new URL("../../packages/pi-extension/dist/index.js", import.meta.url)),
  } });
  host = await HostService.create({ relayUrl: relay.url, stateDir: dir, sessionsRoot: join(dir, "sessions"),
    credential: "review-runtime", adminToken: "review-admin", lan: false, reconnect: false, spawner });
  await host.start(); await spawner.activate({ deviceId: "test", target: { type: "new", agentKind: "pi", cwd: dir }, spawnMode: "headless" });
  const end = Date.now() + 20_000;
  while (!host.localRuntimes.length && Date.now() < end) await delay(100);
  expect(host.localRuntimes).toHaveLength(1); expect(await realpath(host.localRuntimes[0].cwd)).toBe(await realpath(dir));
}, 30_000);

it("keeps the exact QR across restarts and serves its PNG/JSON without login", async () => {
  await setup(); const first = pairing.text;
  const loaded = await createFixedReviewPairing({ host, identity, accessPath: join(dir, "review-pairing.json"), publicRelayUrl: relay.url });
  expect(loaded.text).toBe(first);
  const qr = decodePairingQrText(first); expect(qr.exp).toBeGreaterThan(Date.now() / 1000 + 10 * 365 * 86400);
  expect(qr.code).toMatch(/^[A-Z0-9_-]{4,128}$/u);
  expect(qr.hostName).toBe("Orbis Review Demo");
  const image = await fetch(`${portal.url}${pairing.pagePath}qr.png`);
  expect(image.status).toBe(200); expect(image.headers.get("content-type")).toBe("image/png");
  expect(await (await fetch(`${portal.url}${pairing.pagePath}pairing.json`)).text()).toBe(first);
  expect((await fetch(portal.url)).status).toBe(404); loaded.dispose();
});

it("reuses the same QR to pair twice, replacing the old device and preserving encrypted commands", async () => {
  await setup(); device = await connectDevice(pairing.text, { httpBase: portal.url });
  const first = device; const firstId = first.ready.deviceId;
  const second = await connectDevice(pairing.text, { httpBase: portal.url });
  device = second; await first.close();
  expect(second.ready.deviceId).not.toBe(firstId);
  expect(host.devices.find(item => item.deviceId === firstId).revoked).toBe(true);
  expect(host.devices.filter(item => !item.revoked)).toHaveLength(1);
  second.send({ type: "session.list", requestId: "demo-sessions" });
  const list = await second.matching(message => message.type === "session.list.result" && message.requestId === "demo-sessions");
  expect(list.sessions).toEqual([]);
});

it("rejects a wrong fixed code and keeps API/administrator secrets out of the page", async () => {
  await setup();
  const denied = await fetch(`${portal.url}/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "wrong", deviceName: "test" }) });
  expect(denied.status).toBe(401);
  const response = await fetch(`${portal.url}${pairing.pagePath}`); const page = await response.text();
  expect(page).not.toContain("review-admin"); expect(page).not.toContain("review-runtime");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
