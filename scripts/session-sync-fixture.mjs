// Local-only companion for SessionSyncSlowLinkInstrumentedTest. Build workspaces first.
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { generateX25519KeyPair, toBase64Url } from "@pi-remote/e2e";
import { PROTOCOL_VERSION, RelayToDeviceMessageSchema, selectSessionSyncSnapshot } from "@pi-remote/protocol";
import { DeviceLink } from "../packages/host/dist/device-link.js";
import { SessionSyncTasks } from "../packages/host/dist/session-sync-tasks.js";

const output = resolve(process.argv[2] ?? ".scratch/chat-history-sync-backlog/live-fixture");
await mkdir(output, { recursive: true });
const pskRoot = Buffer.alloc(32, 0x73).toString("base64url"); // Public test key, never a paired user device.
const hostId = "sync-fixture-host";
const links = new Map();
const stats = new Map();
const gates = new Map();
let sequence = 0;
const entries = Array.from({ length: 400 }, (_, index) => {
  const n = index + 1;
  return { entryId: `e${n}`, parentId: n === 1 ? null : `e${n - 1}`, type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: { message: { role: "user", content: n === 400 ? "SYNC_VISIBLE_400" : `entry-${n} ${"x".repeat(1100)}` } } };
});
const metadata = (kind) => ({ runtimeId: `${kind}:slow-sync`, name: `Slow sync ${kind}`,
  cwd: "D:/sync-fixture", status: "idle", sessionId: `${kind}-session`, sessionGraphSync: true, sessionLeafId: "e400" });
const eventMessage = (runtimeId, event) => ({ type: "runtime.event", protocolVersion: PROTOCOL_VERSION,
  runtimeId, sequence: ++sequence, event });
const send = (deviceId, message, channel = "ctl") => links.get(deviceId)?.send(Buffer.from(JSON.stringify(RelayToDeviceMessageSchema.parse(message))), channel);
const log = (line) => process.stdout.write(`${line}\n`);
const tasks = new SessionSyncTasks({
  link: (deviceId) => links.get(deviceId),
  dispatch: (runtimeId, commandId, command) => {
    const kind = runtimeId.split(":")[0];
    const deviceId = `sync-fixture-${kind}`;
    const record = stats.get(deviceId);
    record.generated += 1;
    if (record.generated === 1) gates.get(deviceId).until = Date.now() + 10_000;
    tasks.handleEvent(runtimeId, { type: "command.result", commandId, ok: true });
    const snapshot = selectSessionSyncSnapshot(entries, `${kind}-session`, "e400", command);
    record.entries += snapshot.entries.length;
    record.ranges.push({ range: command.range, target: command.targetLeafId, known: command.knownLeafId,
      entries: snapshot.entries.length, bytes: Buffer.byteLength(JSON.stringify(snapshot)) });
    tasks.handleEvent(runtimeId, snapshot);
    return "handled";
  },
  encodeEvent: (runtimeId, event) => Buffer.from(JSON.stringify(RelayToDeviceMessageSchema.parse(eventMessage(runtimeId, event)))),
  sendEvent: (deviceId, runtimeId, event) => send(deviceId, eventMessage(runtimeId, event)),
  error: (deviceId, commandId, code, message) => send(deviceId, { type: "protocol.error", commandId, code, message: message ?? code }),
  log,
});
const http = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/shutdown" && req.method === "POST") { res.end("closing"); void stop(); return; }
  if (url.pathname !== "/stats") { res.writeHead(404).end(); return; }
  const deviceId = url.searchParams.get("device");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ...stats.get(deviceId), tasks: tasks.stats(deviceId) }));
});
const ws = new WebSocketServer({ server: http, path: "/v1/device" });
ws.on("connection", (socket) => {
  let deviceId;
  let link;
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "device.authenticate") {
      deviceId = message.credential;
      if (!["sync-fixture-pi", "sync-fixture-codex"].includes(deviceId)) { socket.close(); return; }
      const kind = deviceId.endsWith("codex") ? "codex" : "pi";
      stats.set(deviceId, stats.get(deviceId) ?? { requests: 0, generated: 0, entries: 0, wireBytes: 0, pieces: 0, peakQueueBytes: 0, ranges: [], ids: [] });
      const gate = { until: 0, tokens: 32768, at: Date.now() };
      gates.set(deviceId, gate);
      link = new DeviceLink({ hostId, device: { deviceId, devicePub: toBase64Url(generateX25519KeyPair().publicRaw),
        pskRoot, label: "isolated sync fixture", createdAt: 0, revoked: false }, probeIntervalMs: 0,
        onSessionReady: () => {
          tasks.clearDevice(deviceId);
          send(deviceId, { type: "device.ready", protocolVersion: PROTOCOL_VERSION, deviceId, runtimes: [metadata(kind)], agents: [kind] });
          send(deviceId, { type: "device.path", protocolVersion: PROTOCOL_VERSION, path: "relay" });
        },
        onPayload: (payload) => {
          const incoming = JSON.parse(payload.toString());
          if (incoming.type !== "runtime.command" || incoming.command.type !== "session.sync") return;
          const record = stats.get(deviceId);
          record.requests += 1;
          record.ids.push(incoming.command.syncId);
          tasks.request(deviceId, incoming.runtimeId, incoming.commandId, incoming.command);
        },
        onError: (error) => log(`fixture.error ${error.message}`),
      });
      links.get(deviceId)?.close();
      links.set(deviceId, link);
      const sink = (envelope) => {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("fixture_socket_closed");
        const encoded = JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope });
        if (envelope.hdr.ch === "msg") {
          gate.tokens -= Buffer.byteLength(encoded);
          const record = stats.get(deviceId);
          record.wireBytes += Buffer.byteLength(encoded);
          record.pieces += 1;
        }
        socket.send(encoded);
      };
      sink.backlog = () => {
        const now = Date.now();
        gate.tokens = Math.min(32768, gate.tokens + (now - gate.at) * 32768 / 1000);
        gate.at = now;
        const record = stats.get(deviceId);
        record.peakQueueBytes = Math.max(record.peakQueueBytes, link.sessionSyncQueuedBytes);
        return now < gate.until || gate.tokens <= 0 ? 1_000_000 : socket.bufferedAmount;
      };
      link.attach("relay", sink);
    } else if (message.type === "v2.frame") link?.handle("relay", message.envelope);
  });
  socket.on("close", () => {
    link?.close();
    if (links.get(deviceId) === link) { links.delete(deviceId); tasks.clearDevice(deviceId); }
  });
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const port = http.address().port;
await writeFile(resolve(output, "config.json"), JSON.stringify({ port, pskRoot, hostId }));
log(`fixture.ready port=${port}`);
async function stop() {
  tasks.close();
  for (const link of links.values()) link.close();
  for (const socket of ws.clients) socket.terminate();
  await writeFile(resolve(output, "stats.json"), JSON.stringify(Object.fromEntries(stats), null, 2));
  ws.close(); http.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
