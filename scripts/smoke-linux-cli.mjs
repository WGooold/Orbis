// LINUX-HOST-VERIFY-06: exercise the actual unpacked launcher over a loopback Relay.
// No graphical session, caller HOME, installed agents, global Node on the CLI PATH, or production credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { createRelayServer } from "../packages/relay/dist/index.js";
import {
  AGENT_ENABLEMENT_FEATURE, PROTOCOL_VERSION, DEVICE_FEATURE_AGY, DEVICE_FEATURE_HERMES,
  DEVICE_FEATURE_KIMI_CODE, DEVICE_FEATURE_KIMI_CODE_DESKTOP, DEVICE_FEATURE_OPENCLAW, DEVICE_FEATURE_OPENCODE, DEVICE_FEATURE_EXPLICIT_TUI,
  EnvelopeReassembler, fragmentEnvelope,
} from "../packages/protocol/dist/index.js";
import {
  DeviceHandshake, E2eChannel, buildPairEnvelope, buildPlaintextEnvelope, createDevicePairingSession,
  decodePairingQrText, fromBase64Url, generateX25519KeyPair, readHandshakeEnvelope, readPairEnvelope, verifyPairAccept,
} from "../packages/e2e/dist/index.js";

assert.equal(process.platform, "linux");
assert.equal(process.argv.length, 3, "Usage: node scripts/smoke-linux-cli.mjs /path/to/extracted/orbis");
const cli = resolve(process.argv[2]);
const dir = await mkdtemp(join(tmpdir(), "orbis-cli-release-"));
const home = join(dir, "home");
const state = join(dir, "state");
const logs = [];
let relay, phone, model;
const piEntry = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const workspace = join(dir, "fixture workspace");
const answer = "Isolated Pi can answer through the packaged Orbis CLI.";
let prompts = 0;
const children = new Set();
const timeout = (promise, label, ms = 12_000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
  })]).finally(() => clearTimeout(timer));
};
const features = [AGENT_ENABLEMENT_FEATURE, DEVICE_FEATURE_HERMES, DEVICE_FEATURE_KIMI_CODE,
  DEVICE_FEATURE_KIMI_CODE_DESKTOP, DEVICE_FEATURE_OPENCLAW, DEVICE_FEATURE_OPENCODE, DEVICE_FEATURE_AGY, DEVICE_FEATURE_EXPLICIT_TUI];

function run(args, overrides) {
  const child = spawn(cli, args, {
    cwd: dir, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", ORBIS_RELAY_TRANSPORT: "ws", ...overrides },
  });
  children.add(child);
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const done = once(child, "close").then(([code, signal]) => {
    children.delete(child);
    // Never persist the machine-readable pairing credentials or normal device listings.
    logs.push({ command: args[0], code, signal, stderr: stderr.replace(/hostId=\S+/g, "hostId=<isolated>") });
    return { code, signal, stdout, stderr };
  });
  done.catch(() => {});
  return { child, done, output: () => stderr };
}

async function pairingLine(child) {
  const lines = createInterface({ input: child.stdout });
  try { return (await timeout(once(lines, "line"), "packaged CLI pairing payload"))[0]; }
  finally { lines.close(); }
}

async function openPhone(credential, deviceId, hostId) {
  const socket = new WebSocket(`${relay.url}/v1/device`);
  const queue = [];
  const reassembler = new EnvelopeReassembler();
  socket.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "v2.frame") {
      const envelope = reassembler.accept(frame.envelope);
      if (envelope) queue.push(envelope);
    }
  });
  try { await timeout(once(socket, "open"), "device socket"); }
  catch (error) { socket.terminate(); throw error; }
  socket.on("error", () => {});
  const send = envelope => {
    for (const piece of fragmentEnvelope(envelope)) socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: piece }));
  };
  async function next(until = Date.now() + 8_000) {
    while (!queue.length && Date.now() < until && socket.readyState === WebSocket.OPEN) await new Promise(r => setTimeout(r, 20));
    assert.ok(queue.length, "Expected device frame from Host");
    return queue.shift();
  }
  socket.send(JSON.stringify({ type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential }));
  return {
    close: () => socket.terminate(),
    async pair(request) {
      send(buildPairEnvelope({ room: hostId, from: deviceId, to: hostId, body: request }));
      return readPairEnvelope(await next());
    },
    async handshake(pskRoot) {
      const hs = new DeviceHandshake(pskRoot);
      const sendPlain = body => send(buildPlaintextEnvelope({ kind: "hs", room: hostId, from: deviceId, to: hostId, body }));
      sendPlain(hs.start());
      const hs2 = readHandshakeEnvelope(await next());
      assert.equal(hs2.type, "hs2");
      sendPlain(hs.accept(hs2));
      const channel = new E2eChannel({ keys: hs.keys, role: "device" });
      const sendData = (body, k = "data") => send(channel.seal({ k, room: hostId, from: deviceId, to: hostId, ch: "ctl", n: channel.nextSequence("ctl") }, body));
      const sendMessage = body => sendData(Buffer.from(JSON.stringify({ ...body, protocolVersion: PROTOCOL_VERSION })));
      sendMessage({ type: "host.lan.request" }); // Released apps follow HS3 with a LAN endpoint refresh.
      return {
        send: sendMessage,
        async receive(predicate) {
          const seen = new Set();
          const until = Date.now() + 15_000;
          while (Date.now() < until) {
            const envelope = await next(until).catch(error => {
              throw new Error(`${error.message}; seen: ${[...seen].join(", ")}`);
            });
            const bytes = channel.open(envelope);
            if (envelope.hdr.k === "ping") { sendData(bytes, "ping"); continue; }
            const payload = JSON.parse(bytes);
            if (predicate(payload)) return payload;
            seen.add([payload.type, payload.event?.type, payload.requestId, payload.runtime?.cwd].filter(Boolean).join(":"));
          }
          assert.fail(`No matching encrypted response; seen: ${[...seen].join(", ")}`);
        },
      };
    },
  };
}

async function startHost() {
  const host = run(["host", "--state-dir", state], { ORBIS_PI_ENTRY: piEntry, ORBIS_RUNTIME_LOG_LEVEL: "debug", ORBIS_RUNTIME_LOG: join(dir, "pi-runtime.log") });
  const until = Date.now() + 10_000;
  while (!host.output().includes("已就绪，共") && Date.now() < until && host.child.exitCode === null) await new Promise(r => setTimeout(r, 25));
  assert.match(host.output(), /已就绪，共/u, "Headless Host must become ready");
  return host;
}

try {
  await mkdir(home, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await mkdir(workspace);
  await access(piEntry);
  // Real pinned Pi CLI and the shipped extension; the only model endpoint is a local SSE fixture.
  model = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    if (parsed.model !== "fixture" || !parsed.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("packaged CLI prompt"))) {
      res.writeHead(400).end(); return;
    }
    prompts++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: answer }, null], [{}, "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-orbis-fixture", object: "chat.completion.chunk",
        created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const piConfig = join(home, ".pi", "agent");
  await mkdir(piConfig, { recursive: true });
  await writeFile(join(piConfig, "models.json"), JSON.stringify({ providers: { "orbis-fixture": {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: "openai-completions", apiKey: "isolated-synthetic-key",
    models: [{ id: "fixture", name: "Orbis fixture", input: ["text"] }],
  } } }));
  await writeFile(join(piConfig, "settings.json"), JSON.stringify({ defaultProvider: "orbis-fixture", defaultModel: "fixture" }));
  const released = process.env.ORBIS_LINUX_CLI_RELEASED_RELAY_ROOT;
  const startRelay = released ? (await import(pathToFileURL(resolve(released, "packages/relay/dist/index.js")).href)).createRelayServer : createRelayServer;
  relay = await startRelay({ host: "127.0.0.1", port: 0,
    runtimeCredentials: ["isolated-client-runtime"], adminToken: "isolated-client-admin", stateFile: join(dir, "relay.json") });
  await writeFile(join(state, "config.json"), JSON.stringify({ relayUrl: relay.url, runtimeCredential: "isolated-client-runtime", adminToken: "isolated-client-admin", lanPort: 0 }), { mode: 0o600 });
  const version = await timeout(run(["--version"]).done, "version");
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/u);
  assert.equal((await timeout(run(["--help"]).done, "help")).code, 0);

  const pairArgs = ["pair", "--state-dir", state, "--print-payload"];
  const cancelled = run(pairArgs);
  const cancelledLine = await pairingLine(cancelled.child);
  assert.equal(decodePairingQrText(cancelledLine).relayUrl, relay.url);
  cancelled.child.kill("SIGTERM");
  const cancelledResult = await timeout(cancelled.done, "pair exits on SIGTERM before a device connects");
  assert.equal(cancelledResult.code, 0);
  assert.equal(cancelledResult.stdout, `${cancelledLine}\n`);
  assert.doesNotMatch(cancelledResult.stderr, /配对窗口已过期|配对成功/u);

  const pairing = run(pairArgs);
  const line = await pairingLine(pairing.child);
  const qr = decodePairingQrText(line);
  assert.equal(qr.relayUrl, relay.url);
  const response = await fetch(`${relay.url.replace(/^ws/u, "http")}/v1/pairings`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ code: qr.code, deviceName: "Linux CLI QA" }), signal: globalThis.AbortSignal.timeout(5_000) });
  assert.equal(response.ok, true, `Pair exchange HTTP ${response.status}`);
  const { credential, deviceId } = await response.json();
  const pairingSession = createDevicePairingSession({ hostPublicRaw: fromBase64Url(qr.hostPub, "hostPub"),
    psk: fromBase64Url(qr.psk, "psk"), deviceId, deviceKeyPair: generateX25519KeyPair() });
  phone = await openPhone(credential, deviceId, qr.hostId);
  const accept = await phone.pair(pairingSession.request);
  assert.equal(accept.type, "pair-accept");
  verifyPairAccept(pairingSession, accept);
  const result = await timeout(pairing.done, "pair exit without lingering expiry timer");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, `${line}\n`, "pair machine output must contain exactly one line");
  phone.close();
  assert.ok((await timeout(run(["devices", "--state-dir", state]).done, "device persistence")).stdout.includes(deviceId));

  let sessionId;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const host = await startHost();
    phone = await openPhone(credential, deviceId, qr.hostId);
    const connection = await phone.handshake(pairingSession.pskRoot);
    const ready = await connection.receive(payload => payload.type === "device.ready");
    assert.ok(ready.hostFeatures?.includes("session.spawn.auto"));
    connection.send({ type: "device.features", features });
    connection.send({ type: "agent.enablement.read", requestId: "linux-catalog" });
    const catalog = await connection.receive(payload => payload.requestId === "linux-catalog");
    assert.equal(catalog.type, "agent.enablement.snapshot");
    assert.deepEqual(catalog.snapshot.agents.map(agent => agent.kind).sort(), ["pi", "codex", "dsh", "kimiCode", "hermes", "openclaw", "opencode"].sort());
    connection.send({ type: "session.list", requestId: "linux-sessions" });
    const sessions = await connection.receive(payload => payload.requestId === "linux-sessions");
    assert.equal(sessions.type, "session.list.result");
    connection.send({ type: "agent.enablement.write", requestId: "linux-unsupported", kind: "kimiCodeDesktop", enabled: true, expectedRevision: catalog.snapshot.revision });
    assert.equal((await connection.receive(payload => payload.requestId === "linux-unsupported")).type, "protocol.error");
    if (!sessionId) {
      connection.send({ type: "agent.enablement.write", requestId: "linux-enable-pi", kind: "pi", enabled: true, expectedRevision: catalog.snapshot.revision });
      const enabled = await connection.receive(payload => payload.requestId === "linux-enable-pi");
      assert.equal(enabled.type, "agent.enablement.result");
      assert.equal(enabled.snapshot.agents.find(row => row.kind === "pi").enabled, true);
    } else assert.equal(catalog.snapshot.agents.find(row => row.kind === "pi").enabled, true);
    if (sessionId) assert.ok(sessions.sessions.some(entry => entry.sessionId === sessionId), "Pi session survives Host restart");
    connection.send({ type: "session.activate", requestId: "linux-pi", spawnMode: "auto",
      target: sessionId ? { type: "resume", sessionId, agentKind: "pi" } : { type: "new", cwd: workspace, agentKind: "pi" } });
    // Production sends early creation and runtime events on different lanes; preserve either ordering.
    let launched, runtime;
    while (!launched || !runtime) {
      const event = await connection.receive(payload => payload.requestId === "linux-pi" || (payload.type === "runtime.online" && payload.runtime.cwd === workspace));
      if (event.requestId === "linux-pi") { assert.equal(event.type, "session.activated", event.message); launched = event; }
      else runtime = event.runtime;
    }
    assert.equal(launched.spawnMode, "headless");
    assert.ok(launched.sessionId, "Pi launch must return a durable session identity");
    assert.equal(launched.sessionId, runtime.sessionId);
    if (!sessionId) {
      sessionId = launched.sessionId;
      connection.send({ type: "runtime.command", runtimeId: runtime.runtimeId, commandId: "linux-prompt",
        command: { type: "user_message", messageId: "linux-prompt", text: "packaged CLI prompt" } });
      let completed = false, sawAnswer = false, ran = false;
      while (!completed || !sawAnswer) {
        const message = await connection.receive(payload => {
          if (payload.commandId === "linux-prompt" && payload.type === "protocol.error") assert.fail(payload.message);
          if (payload.runtimeId !== runtime.runtimeId || !payload.event) return false;
          const event = payload.event;
          if (event.type === "command.result" && event.commandId === "linux-prompt") assert.equal(event.ok, true, event.error);
          return event.type === "turn.finished" || event.type === "runtime.status" || JSON.stringify(event).includes(answer);
        }).catch(error => { throw new Error(`Pi model calls=${prompts}, turn completed=${completed}, phone saw answer=${sawAnswer}: ${error.message}`); });
        if (message.event.type === "turn.finished") {
          assert.equal(message.event.outcome, "completed");
          completed = true;
        } else if (message.event.type === "runtime.status") {
          if (message.event.status === "running") ran = true;
          if (ran && message.event.status === "idle") completed = true;
        } else sawAnswer = true;
      }
      assert.equal(prompts, 1);
    } else assert.equal(runtime.sessionId, sessionId);
    phone.close();
    host.child.kill(signal);
    assert.equal((await timeout(host.done, `Host exited after ${signal}`)).code, 0);
    assert.throws(() => process.kill(launched.pid, 0), { code: "ESRCH" }, "CLI-owned Pi must not survive Host exit");
    await assert.rejects(access(join(state, "loopback.json")), { code: "ENOENT" });
  }
  console.log(`Linux CLI ${version.stdout.trim()} ${process.arch}: packaged pairing, encrypted reconnect, Agent gating, native Pi create/prompt/resume and signal cleanup passed`);
} finally {
  phone?.close();
  for (const child of children) child.kill("SIGKILL");
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  await relay?.close();
  await mkdir(".artifacts/linux-cli-verification", { recursive: true });
  await writeFile(".artifacts/linux-cli-verification/packaged-cli.json", `${JSON.stringify(logs, null, 2)}\n`);
  const piLog = await readFile(join(dir, "pi-runtime.log"), "utf8").catch(() => undefined);
  if (piLog) await writeFile(".artifacts/linux-cli-verification/pi-runtime.log", piLog);
  await rm(dir, { recursive: true, force: true });
}
