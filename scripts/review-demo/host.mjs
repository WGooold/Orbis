import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadOrCreateHostIdentity } from "@orbis/e2e";
import { HostService } from "../../packages/host/dist/host-service.js";
import { SessionSpawner } from "../../packages/host/dist/spawner.js";
import { listPiSessions } from "../../packages/host/dist/sessions.js";
import { createRelayServer } from "../../packages/relay/dist/index.js";
import { createPortal } from "./portal.mjs";
import { configurePi } from "./pi-config.mjs";

const config = JSON.parse(await readFile("/run/secrets/host.json", "utf8"));
if (!config.publicRelayUrl?.startsWith("wss://")) throw new Error("Invalid review configuration");
const stateDir = "/data/host";
const agentDir = "/data/home/.pi/agent";
const workspace = "/data/workspace";
process.env.HOME = "/data/home";
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.ORBIS_STATE_DIR = stateDir;
process.env.ORBIS_PI_ENTRY = "/app/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
process.env.ORBIS_EXTENSION_PATH = "/app/packages/pi-extension/dist/index.js";
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.DEEPSEEK_API_KEY = (await readFile("/run/secrets/deepseek.key", "utf8")).trim();
for (const dir of [stateDir, agentDir, workspace]) await mkdir(dir, { recursive: true, mode: 0o700 });
for (const file of await readdir("/app/scripts/review-demo/sample")) {
  await copyFile(join("/app/scripts/review-demo/sample", file), join(workspace, file), constants.COPYFILE_EXCL)
    .catch(error => { if (error.code !== "EEXIST") throw error; });
}
if (!await access(join(workspace, ".git")).then(() => true, () => false)) {
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Orbis Review", "-c", "user.email=review@orbising.com", "commit", "-m", "Add sample workspace"], { cwd: workspace, stdio: "ignore" });
}
await configurePi(agentDir);
await loadOrCreateHostIdentity({ dir: stateDir, hostName: "Orbis Review Demo" });

// The public iOS UI may request a terminal window. This Linux review Host has no GUI.
class ReviewSpawner extends SessionSpawner {
  activate(input) { return super.activate({ ...input, spawnMode: "headless" }); }
}
const spawner = new ReviewSpawner({ stateDir });
let host; let relay; let portal; let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await portal?.close();
  for (const agent of spawner.running) { try { process.kill(-agent.pid, "SIGTERM"); } catch { /* Already stopped. */ } }
  for (let n = 0; n < 50 && spawner.running.length; n++) await delay(100);
  for (const agent of spawner.running) { try { process.kill(-agent.pid, "SIGKILL"); } catch { /* Already stopped. */ } }
  await host?.stop(); await relay?.close();
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await stop(); process.exit(0); });
try {
  relay = await createRelayServer({ host: "0.0.0.0", port: 8787,
    runtimeCredentials: [config.runtimeCredential], adminToken: config.adminToken,
    stateFile: "/data/relay.json", adminStateFile: "/data/relay-admin.json", pairingTtlMs: 120_000,
  });
  host = await HostService.create({ relayUrl: "ws://127.0.0.1:8787", credential: config.runtimeCredential,
    adminToken: config.adminToken, stateDir, sessionsRoot: join(agentDir, "sessions"), spawner, lan: false,
    onPaired: () => console.log("Review device paired"),
  });
  await host.start();
  const sessions = await listPiSessions({ root: join(agentDir, "sessions") });
  const prior = sessions.sessions.find(session => session.cwd === workspace);
  await spawner.activate({ deviceId: "review-setup", target: prior
    ? { type: "resume", cwd: workspace, sessionId: prior.sessionId, sessionFile: sessions.files.get(prior.sessionId) }
    : { type: "new", agentKind: "pi", cwd: workspace } });
  const deadline = Date.now() + 60_000;
  while (!host.localRuntimes.length && Date.now() < deadline) await delay(250);
  if (!host.localRuntimes.length) throw new Error("Real Pi runtime did not register");
  portal = await createPortal({ hostService: host, publicRelayUrl: config.publicRelayUrl,
    ready: () => host.relayState === "connected" && host.localRuntimes.length > 0 });
  console.log("Review Host and real Pi runtime ready");
} catch (error) { await stop(); console.error(error.message); process.exit(1); }
