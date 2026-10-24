// Run after `npm run build`. Uses an isolated official DSH Web service and
// a loopback proxy; never reads the user's pairing or calls a model provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { resolveDshCommand } from "../packages/host/dist/dsh-client.js";
import { DshWebClient } from "../packages/host/dist/dsh-web-client.js";
import { DshWebRuntime } from "../packages/host/dist/dsh-web-runtime.js";
import { loadDshStreamDecoder } from "../packages/host/dist/dsh-web-history.js";

const repo = resolve(import.meta.dirname, "..");
const output = process.argv[2] ? resolve(process.argv[2]) : undefined;
await mkdir(join(repo, ".scratch"), { recursive: true });
const root = await mkdtemp(join(repo, ".scratch", "dsh-reconnect-"));
const home = join(root, "home"); const workspace = join(root, "workspace");
let child;
let nativeOutput = "";
let spawnFailure;
const waitFor = async (predicate, description, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await delay(25);
  }
};
let proxy; let mux; let client; let runtime;
const connections = new Set();
const diagnostics = []; const results = []; const failures = []; const offline = [];
const events = [];
try {
  await mkdir(home); await mkdir(workspace);
  const cli = await resolveDshCommand();
  child = spawn(cli.command, [...cli.prefixArgs, "--profile", "web", "--host", "127.0.0.1", "--no-open", "--port", "0"], {
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" }, cwd: workspace,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { nativeOutput = (nativeOutput + chunk).slice(-16_384); });
  child.stderr.on("data", chunk => { nativeOutput = (nativeOutput + chunk).slice(-16_384); });
  child.on("error", error => { spawnFailure = error; });
  await waitFor(() => spawnFailure || child.exitCode !== null || /dsh web:\s+http:\/\/127\.0\.0\.1:\d+\/[^\s]*/i.test(nativeOutput), "isolated DSH startup", 60_000);
  if (spawnFailure || child.exitCode !== null) throw new Error("Isolated DSH could not start");
  const launch = new URL(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/i.exec(nativeOutput)[1]);
  const nativeOrigin = launch.origin;
  proxy = createServer((incoming, outgoing) => {
    const forwarded = httpRequest(new URL(incoming.url, nativeOrigin), { method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    forwarded.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(forwarded);
  });
  mux = new WebSocketServer({ noServer: true });
  proxy.on("upgrade", (request, socket, head) => mux.handleUpgrade(request, socket, head, downstream => {
    const upstream = new WebSocket(nativeOrigin.replace("http:", "ws:") + request.url, { headers: {
      Host: request.headers.host, Cookie: request.headers.cookie ?? "", Origin: request.headers.origin,
    } });
    const connection = { downstream, upstream, eventsStream: undefined };
    connections.add(connection);
    const pending = [];
    upstream.on("open", () => { for (const bytes of pending.splice(0)) upstream.send(bytes, { binary: false }); });
    downstream.on("message", bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.type === "open" && frame.endpoint === "$events") connection.eventsStream = frame.streamId;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary: false }); else pending.push(bytes);
    });
    upstream.on("message", (bytes, binary) => { if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes, { binary }); });
    upstream.on("error", () => downstream.terminate());
    downstream.on("error", () => upstream.terminate());
    upstream.on("close", () => downstream.terminate());
    downstream.on("close", () => { connections.delete(connection); upstream.terminate(); });
  }));
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  launch.port = String(proxy.address().port);
  client = await DshWebClient.connect({ url: launch.href, cli, timeoutMs: 10_000, reconnectDelayMs: 100 });
  runtime = new DshWebRuntime(client, await loadDshStreamDecoder(cli.prefixArgs[0]));
  runtime.onDiagnostic = event => { diagnostics.push({ ...event, at: new Date().toISOString() }); };
  runtime.onOffline = reason => offline.push(reason);
  runtime.setEventSink(event => {
    if (event.type === "command.result" || event.type === "session.snapshot" || event.type === "notification.source") events.push(event);
  });
  await runtime.start();
  const { sessionId } = await runtime.activate({ type: "new", cwd: workspace });
  const preview = async id => {
    runtime.dispatchCommand(sessionId, id, { type: "session.sync", sessionId, syncId: id, range: "preview", maxEntries: 30 });
    await waitFor(() => events.some(event => event.type === "command.result" && event.commandId === id), id);
    assert.equal(events.find(event => event.type === "command.result" && event.commandId === id).ok, true, `${id} must complete successfully`);
    assert.ok(events.some(event => event.type === "session.snapshot" && event.syncId === id && event.source.ready), `${id} needs a verified source baseline`);
    results.push(id);
  };
  await preview("initial-open");
  for (const kind of ["socket-close", "event-stream-end", "event-stream-error"]) {
    const connection = [...connections].at(-1);
    assert.ok(connection?.eventsStream, "forwarded event stream must be open");
    const before = diagnostics.filter(event => event.event === "reconnected").length;
    if (kind === "socket-close") connection.downstream.close(1012, "isolated test restart");
    else connection.downstream.send(JSON.stringify({ type: kind === "event-stream-end" ? "end" : "error", streamId: connection.eventsStream,
      ...(kind === "event-stream-error" ? { error: { code: "gateway/service-unavailable", message: "isolated event source replacement", details: {} } } : {}) }));
    await waitFor(() => diagnostics.some(event => event.event === "socket.closed") &&
      diagnostics.filter(event => event.event === "reconnected").length > before, kind);
    await preview(`reopen-after-${kind}`);
  }
  await waitFor(() => {
    const notice = events.filter(event => event.type === "notification.source").at(-1);
    return notice && !notice.notifications.some(item => ["dsh.skills", "dsh.models", "dsh.recovery"].includes(item.code));
  }, "native metadata and follow recovery");
  assert.deepEqual(offline, [], "ordinary reconnects must not mark the runtime permanently offline");
  console.log(`PASS: ${results.length} native DSH opens; socket close and event-stream end/error recover without a model call`);
} catch (error) {
  failures.push({ name: error.name, message: error.message });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await runtime?.stop().catch(() => {});
  await client?.stop().catch(() => {});
  for (const connection of connections) { connection.downstream.terminate(); connection.upstream.terminate(); }
  if (mux) await new Promise(resolve => mux.close(resolve));
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  if (child?.exitCode === null && child.signalCode === null && child.pid) {
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited;
  }
  await rm(root, { recursive: true, force: true });
  if (output) {
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, JSON.stringify({ passed: failures.length === 0, scenarios: results, diagnostics, failures,
      isolated: true, modelCalls: 0, finishedAt: new Date().toISOString() }, null, 2));
  }
}
