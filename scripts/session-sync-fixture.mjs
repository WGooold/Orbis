// Local-only companion for SessionSyncSlowLinkInstrumentedTest. Build workspaces first.
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { generateX25519KeyPair, toBase64Url } from "@orbis/e2e";
import { PROTOCOL_VERSION, RelayToDeviceMessageSchema, RecoverableSessionSource, selectSessionSyncSnapshot } from "@orbis/protocol";
import { DeviceLink } from "../packages/host/dist/device-link.js";
import { SessionSyncTasks } from "../packages/host/dist/session-sync-tasks.js";
import { AgentStateRegistry } from "../packages/host/dist/agent-state-registry.js";
import { AgentStateFacts } from "../packages/host/dist/agent-state-facts.js";
import { AgentConversationState } from "../packages/host/dist/agent-conversation-state.js";
import { AgentStateSubscriptions } from "../packages/host/dist/agent-state-subscriptions.js";
import { HostStateFacts } from "../packages/host/dist/host-state-facts.js";
import { buildAgentStateSnapshot } from "../packages/host/dist/agent-state-snapshot.js";

const output = resolve(process.argv[2] ?? ".scratch/chat-history-sync-backlog/live-fixture");
await mkdir(output, { recursive: true });
const pskRoot = Buffer.alloc(32, 0x73).toString("base64url"); // Public test key, never a paired user device.
const hostId = "sync-fixture-host";
const links = new Map();
const stats = new Map();
const gates = new Map();
let sequence = 0;
// --rich：一段包含三种显示形态的短会话（压缩、失败回合、带产物的自定义消息），供
// DisplayScenariosInstrumentedTest 在设备上核对渲染。这里只造原生事实，解释由协议层的显示投影负责。
const ARTIFACT = { artifactId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", fileName: "report.pdf",
  mimeType: "application/pdf", size: 1024, sha256: "a".repeat(64) };
const richEntries = () => [
  { entryId: "r1", parentId: null, type: "message", timestamp: "2026-01-01T00:00:00.000Z",
    data: { message: { role: "user", content: "旧问题（应被压缩裁掉）" } } },
  { entryId: "r2", parentId: "r1", type: "message", timestamp: "2026-01-01T00:00:01.000Z",
    data: { message: { role: "assistant", content: "旧回答（应被压缩裁掉）" } } },
  { entryId: "r3", parentId: "r2", type: "message", timestamp: "2026-01-01T00:00:02.000Z",
    data: { message: { role: "user", content: "保留的问题" } } },
  { entryId: "r4", parentId: "r3", type: "compaction", timestamp: "2026-01-01T00:00:03.000Z",
    data: { summary: "前面聊了旧话题", firstKeptEntryId: "r3" } },
  { entryId: "r5", parentId: "r4", type: "message", timestamp: "2026-01-01T00:00:04.000Z",
    data: { message: { role: "user", content: "压缩之后的问题" } } },
  { entryId: "r6", parentId: "r5", type: "message", timestamp: "2026-01-01T00:00:05.000Z",
    data: { message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider 504" },
      remoteFailure: "SCENARIO_FAILURE_TEXT" } },
  { entryId: "r7", parentId: "r6", type: "custom_message", timestamp: "2026-01-01T00:00:06.000Z",
    data: { display: true, content: "SCENARIO_ARTIFACT_TEXT", details: { remoteArtifact: ARTIFACT } } },
];
const entries = process.argv.includes("--rich") ? richEntries() : Array.from({ length: 400 }, (_, index) => {
  const n = index + 1;
  return { entryId: `e${n}`, parentId: n === 1 ? null : `e${n - 1}`, type: "message",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: { message: { role: "user", content: n === 400 ? "SYNC_VISIBLE_400" : `entry-${n} ${"x".repeat(1100)}` } } };
});
const metadata = (kind) => ({ runtimeId: `${kind}:slow-sync`, name: `Slow sync ${kind}`,
  cwd: "D:/sync-fixture", status: "idle", sessionId: `${kind}-session`, sessionGraphSync: true,
  sessionLeafId: entries.at(-1).entryId });
const eventMessage = (runtimeId, event) => ({ type: "runtime.event", protocolVersion: PROTOCOL_VERSION,
  runtimeId, sequence: ++sequence, event });
const send = (deviceId, message, channel = "ctl") => links.get(deviceId)?.send(Buffer.from(JSON.stringify(RelayToDeviceMessageSchema.parse(message))), channel);
const log = (line) => process.stdout.write(`${line}\n`);
const registry = new AgentStateRegistry({ maxValueBytes: 4 * 1024 * 1024 });
const facts = new AgentStateFacts({ registry, hostId,
  kindOf: runtimeId => runtimeId === "pi:slow-sync" ? "pi" : runtimeId === "codex:slow-sync" ? "codex" : undefined });
const conversation = new AgentConversationState(registry);
const hostFacts = new HostStateFacts({ registry });
const subscriptions = new AgentStateSubscriptions(registry, (deviceId, message) => send(deviceId, message, "msg"));
const sources = new Map();
for (const kind of ["pi", "codex"]) {
  const runtimeId = `${kind}:slow-sync`;
  facts.observe(runtimeId, { type: "runtime.metadata", metadata: metadata(kind) });
  facts.observe(runtimeId, { type: "delivery.snapshot", items: [] });
  facts.observe(runtimeId, { type: "interaction.snapshot", requests: [] });
  facts.observe(runtimeId, { type: "execution.activity", retry: "unavailable", compaction: "unavailable" });
  const source = new RecoverableSessionSource(`${kind}-session`, () => undefined);
  source.transaction(() => { source.reconcile(entries, entries.at(-1).entryId); source.setAvailability(true, true); });
  sources.set(kind, source);
}
hostFacts.identity({ hostId, hostName: "Isolated model fixture", protocolVersion: PROTOCOL_VERSION });
hostFacts.backends({ backends: ["pi", "codex"].map(kind => ({ kind, ready: true, launchable: false, runtimeCount: 1, reason: null })), agents: ["pi", "codex"], launchableAgents: [] });
hostFacts.catalog({ totalSessions: 2, truncated: false, backends: ["pi", "codex"].map(kind => ({ kind, ready: true, sessions: 1, complete: true, elapsedMs: 0 })),
  sessions: ["pi", "codex"].map(kind => ({ sessionId: `${kind}-session`, agentKind: kind, hostname: "fixture", cwd: "D:/sync-fixture", name: `Slow sync ${kind}`, createdAt: 1, modifiedAt: 1, messageCount: entries.length })), currentProviders: [] });
const tasks = new SessionSyncTasks({
  link: (deviceId) => links.get(deviceId),
  dispatch: (runtimeId, commandId, command) => {
    const kind = runtimeId.split(":")[0];
    const deviceId = `sync-fixture-${kind}`;
    const record = stats.get(deviceId);
    record.generated += 1;
    if (record.generated === 1) gates.get(deviceId).until = Date.now() + 10_000;
    tasks.handleEvent(runtimeId, { type: "command.result", commandId, ok: true });
    const snapshot = selectSessionSyncSnapshot(entries, `${kind}-session`, entries.at(-1).entryId, command, [], sources.get(kind).snapshot());
    record.entries += snapshot.entries.length;
    record.ranges.push({ range: command.range, target: command.targetLeafId, known: command.knownLeafId,
      entries: snapshot.entries.length, bytes: Buffer.byteLength(JSON.stringify(snapshot)) });
    tasks.handleEvent(runtimeId, snapshot);
    return "handled";
  },
  encodeEvent: (runtimeId, event) => Buffer.from(JSON.stringify(RelayToDeviceMessageSchema.parse(eventMessage(runtimeId, event)))),
  acceptSnapshot: (runtimeId, event) => {
    const scope = facts.scopeOf(runtimeId);
    return scope !== undefined && conversation.accept(scope, event, ready => facts.prepareConversation(runtimeId, event, ready));
  },
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
          subscriptions.clearDevice(deviceId);
          // notificationEpoch 是 device.ready 的必填项（ADR-0028）：夹具不是通知来源，给一个固定代次。
          send(deviceId, { type: "device.ready", protocolVersion: PROTOCOL_VERSION, deviceId,
            notificationEpoch: "sync-fixture-epoch", modelEpoch: registry.currentModelEpoch(), runtimes: [metadata(kind)], agents: [kind] });
          send(deviceId, { type: "device.path", protocolVersion: PROTOCOL_VERSION, path: "relay" });
        },
        onPayload: (payload) => {
          const incoming = JSON.parse(payload.toString());
          if (incoming.type === "agent.state.request") {
            const scope = incoming.scope === "host" ? { kind: "host" } : incoming.scope === "device" ? { kind: "device", key: { hostId, deviceId } } : facts.scopeOf(incoming.runtimeId);
            if (!scope) return;
            subscriptions.register(deviceId, scope, incoming);
            send(deviceId, buildAgentStateSnapshot({ registry, scope, requestId: incoming.requestId, identity: incoming,
              ...(incoming.domains === undefined ? {} : { domains: incoming.domains }), ...(incoming.known === undefined ? {} : { known: incoming.known }) }), "msg");
            return;
          }
          if (incoming.type === "agent.state.range.request") {
            send(deviceId, { type: "agent.state.range.page", protocolVersion: PROTOCOL_VERSION, requestId: incoming.requestId,
              scope: "host", domain: "catalog", page: hostFacts.catalogRange(incoming) }, "msg");
            return;
          }
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
    if (links.get(deviceId) === link) { links.delete(deviceId); tasks.clearDevice(deviceId); subscriptions.clearDevice(deviceId); }
  });
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const port = http.address().port;
await writeFile(resolve(output, "config.json"), JSON.stringify({ port, pskRoot, hostId }));
log(`fixture.ready port=${port}`);
async function stop() {
  tasks.close();
  subscriptions.close();
  for (const link of links.values()) link.close();
  for (const socket of ws.clients) socket.terminate();
  await writeFile(resolve(output, "stats.json"), JSON.stringify(Object.fromEntries(stats), null, 2));
  ws.close(); http.close();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
