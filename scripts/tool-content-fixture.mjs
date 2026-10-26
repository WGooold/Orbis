// Isolated encrypted Android pipeline fixture. No real agent sessions or pairing records are read.
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { generateX25519KeyPair, toBase64Url } from "@orbis/e2e";
import { PROTOCOL_VERSION, RelayToDeviceMessageSchema, RecoverableSessionSource, createToolSummary, selectSessionSyncSnapshot } from "@orbis/protocol";
import { createProcessToolContentStore } from "@orbis/runtime-bridge";
import { DeviceLink } from "../packages/host/dist/device-link.js";
import { SessionSyncTasks } from "../packages/host/dist/session-sync-tasks.js";
import { AgentStateRegistry } from "../packages/host/dist/agent-state-registry.js";
import { AgentStateFacts } from "../packages/host/dist/agent-state-facts.js";
import { AgentConversationState } from "../packages/host/dist/agent-conversation-state.js";
import { AgentStateSubscriptions } from "../packages/host/dist/agent-state-subscriptions.js";
import { HostStateFacts } from "../packages/host/dist/host-state-facts.js";
import { buildAgentStateSnapshot } from "../packages/host/dist/agent-state-snapshot.js";
import { AgentToolInventory } from "../packages/host/dist/agent-tool-inventory.js";
import { ToolInventoryIngestion } from "../packages/host/dist/tool-inventory-ingestion.js";
import { ToolContentService } from "../packages/host/dist/tool-content-service.js";

const output = resolve(process.argv[2] ?? ".scratch/tool-content-fixture");
await mkdir(output, { recursive: true });
const hostId = "tool-fixture-host", pskRoot = Buffer.alloc(32, 0x73).toString("base64url"); // Public test key.
const kinds = ["pi", "codex", "codexDesktop", "dsh"], links = new Map(), stats = new Map(), sources = new Map();
const registry = new AgentStateRegistry(), inventory = new AgentToolInventory(registry), ingestion = new ToolInventoryIngestion(inventory);
const store = await createProcessToolContentStore(output, "fixture");
const conversation = new AgentConversationState(registry);
const facts = new AgentStateFacts({ registry, hostId, kindOf: id => kinds.find(kind => id === `${kind}:tools`) });
const hostFacts = new HostStateFacts({ registry });
const metadata = kind => ({ runtimeId: `${kind}:tools`, name: `Tool fixture ${kind}`, cwd: "D:/tool-fixture", status: "running", sessionId: `${kind}-session`, sessionGraphSync: true, sessionLeafId: null });
const agent = kind => ({ hostId, agentKind: kind, sessionId: `${kind}-session` });
let sequence = 0;
const message = (runtimeId, event) => ({ type: "runtime.event", protocolVersion: PROTOCOL_VERSION, runtimeId, sequence: ++sequence, event });
const send = (deviceId, value, channel = "msg") => links.get(deviceId)?.send(Buffer.from(JSON.stringify(RelayToDeviceMessageSchema.parse(value))), channel) ?? false;
const privateContents = new ToolContentService({ scope: id => facts.scopeOf(id)?.key,
  reader: () => store, send: (deviceId, runtimeId, event) => {
    const bytes = Buffer.from(JSON.stringify(RelayToDeviceMessageSchema.parse(message(runtimeId, event))));
    return event.type === "session.tool.content.page" ? links.get(deviceId)?.sendToolContent(bytes) ?? false : links.get(deviceId)?.send(bytes, "ctl") ?? false;
  } });
const subscriptions = new AgentStateSubscriptions(registry, (id, event) => send(id, event));
for (const kind of kinds) {
  const runtimeId = metadata(kind).runtimeId;
  facts.observe(runtimeId, { type: "runtime.metadata", metadata: metadata(kind) });
  const source = new RecoverableSessionSource(`${kind}-session`, () => {}, { runtimeId: () => runtimeId,
    publishTools: event => { if (!ingestion.accept(runtimeId, agent(kind), event)) throw new Error("fixture_inventory_rejected"); } });
  source.transaction(() => {
    source.setAvailability(true, true);
    for (let i = 0; i < 200; i++) source.observe({ type: "tool.activity", summary: createToolSummary({ tool: { agent: agent(kind), toolCallId: `tool-${i}` },
      toolName: "fixture", phase: "finished", isError: false, order: i,
      contents: [{ part: "output", format: "text", availability: "readable", readCapability: "range" }] }) });
  });
  sources.set(runtimeId, source);
  const locator = { projectionVersion: 1, tool: { agent: agent(kind), toolCallId: "tool-0" }, part: "output" };
  const part = await store.begin(locator, "text");
  await store.append(locator, part.contentEpoch, "TOOL_PRIVATE_BEGIN\n");
  for (let i = 0; i < 10; i++) await store.append(locator, part.contentEpoch, "x".repeat(1024 * 1024));
  await store.finish(locator, part.contentEpoch);
}
hostFacts.identity({ hostId, hostName: "Tool content fixture", protocolVersion: PROTOCOL_VERSION });
hostFacts.backends({ backends: kinds.map(kind => ({ kind, ready: true, launchable: false, runtimeCount: 1, reason: null })), agents: kinds, launchableAgents: [] });
hostFacts.catalog({ totalSessions: 4, truncated: false, backends: kinds.map(kind => ({ kind, ready: true, sessions: 1, complete: true, elapsedMs: 0 })),
  sessions: kinds.map(kind => ({ sessionId: `${kind}-session`, agentKind: kind, hostname: "fixture", cwd: "D:/tool-fixture", name: `Tools ${kind}`, createdAt: 1, modifiedAt: 1, messageCount: 0 })), currentProviders: [] });
const tasks = new SessionSyncTasks({ link: id => links.get(id),
  dispatch: (runtimeId, commandId, command) => {
    tasks.handleEvent(runtimeId, { type: "command.result", commandId, ok: true });
    const source = sources.get(runtimeId);
    source.replayToolInventory();
    tasks.handleEvent(runtimeId, selectSessionSyncSnapshot([], facts.scopeOf(runtimeId).key.sessionId, null, command, [], source.published()));
    return "handled";
  }, encodeEvent: (id, event) => Buffer.from(JSON.stringify(RelayToDeviceMessageSchema.parse(message(id, event)))),
  acceptSnapshot: (runtimeId, event) => {
    const scope = facts.scopeOf(runtimeId);
    return scope && conversation.accept(scope, event, ready => {
      const state = facts.prepareConversation(runtimeId, event, ready);
      if (!ready || !event.live?.toolInventory) return state;
      const tools = ingestion.prepare(runtimeId, scope.key, event.source, event.live.toolInventory);
      return { changes: [...tools.changes, ...(state?.changes ?? [])], conversationSource: tools.conversationSource,
        isCurrent: () => tools.isCurrent?.() !== false && state?.isCurrent?.() !== false,
        onCommitted: () => { tools.onCommitted(); state?.onCommitted(); } };
    });
  }, sendEvent: (id, runtimeId, event) => send(id, message(runtimeId, event)),
  error: (id, commandId, code, detail) => send(id, { type: "protocol.error", commandId, code, message: detail ?? code }),
  log: line => process.stdout.write(`${line}\n`),
});
const http = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/shutdown" && req.method === "POST") { res.end("closing"); void stop(); return; }
  if (url.pathname !== "/stats") { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(stats.get(url.searchParams.get("device")) ?? {}));
});
const ws = new WebSocketServer({ server: http, path: "/v1/device" });
ws.on("connection", socket => {
  let deviceId, link;
  socket.on("message", data => {
    const incoming = JSON.parse(data.toString());
    if (incoming.type === "device.authenticate") {
      deviceId = incoming.credential;
      const kind = kinds.find(value => deviceId === `tool-fixture-${value}`);
      if (!kind) { socket.close(); return; }
      const counters = stats.get(deviceId) ?? { inventoryPages: 0, detailRequests: 0, cancels: 0, wireBytes: 0, peakDetailQueue: 0 };
      stats.set(deviceId, counters);
      link = new DeviceLink({ hostId, device: { deviceId, devicePub: toBase64Url(generateX25519KeyPair().publicRaw), pskRoot, label: "tool fixture", createdAt: 0, revoked: false }, probeIntervalMs: 0,
        onSessionReady: () => {
          send(deviceId, { type: "device.ready", protocolVersion: PROTOCOL_VERSION, deviceId, notificationEpoch: "tool-epoch", modelEpoch: registry.currentModelEpoch(), runtimes: [metadata(kind)], agents: [kind] }, "ctl");
          send(deviceId, { type: "device.path", protocolVersion: PROTOCOL_VERSION, path: "relay" }, "ctl");
        }, onPayload: payload => {
          const value = JSON.parse(payload.toString()), runtimeId = metadata(kind).runtimeId;
          if (value.type === "agent.state.request") {
            const scope = value.scope === "host" ? { kind: "host" } : value.scope === "device" ? { kind: "device", key: { hostId, deviceId } } : facts.scopeOf(runtimeId);
            subscriptions.register(deviceId, scope, value);
            send(deviceId, buildAgentStateSnapshot({ registry, scope, requestId: value.requestId, identity: value,
              ...(value.domains === undefined ? {} : { domains: value.domains }), ...(value.known === undefined ? {} : { known: value.known }) })); return;
          }
          if (value.type === "agent.state.range.request") { send(deviceId, { type: "agent.state.range.page", protocolVersion: PROTOCOL_VERSION, requestId: value.requestId, scope: "host", domain: "catalog", page: hostFacts.catalogRange(value) }); return; }
          if (value.type !== "runtime.command" || value.runtimeId !== runtimeId) return;
          const command = value.command;
          if (command.type === "session.sync") tasks.request(deviceId, runtimeId, value.commandId, command);
          else if (command.type === "session.snapshot.ack") tasks.acknowledge(deviceId, command.syncId, command.result);
          else if (command.type === "session.tools.open") send(deviceId, message(runtimeId, { type: "session.tools.opened", runtimeId, requestId: command.requestId, snapshot: inventory.openSnapshot(deviceId, agent(kind), runtimeId) }));
          else if (command.type === "session.tools.read") { counters.inventoryPages++; send(deviceId, message(runtimeId, inventory.read(deviceId, command))); }
          else if (command.type === "session.tool.content.read") { counters.detailRequests++; void privateContents.read(deviceId, runtimeId, command); }
          else if (command.type === "session.tool.content.cancel") { counters.cancels++; privateContents.cancel(deviceId, runtimeId, command.viewerId, command.readId); }
        }, onError: error => process.stderr.write(`fixture.error ${error.message}\n`),
      });
      links.get(deviceId)?.close(); links.set(deviceId, link);
      link.attach("relay", envelope => {
        if (socket.readyState !== WebSocket.OPEN) throw new Error("closed");
        const encoded = JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope });
        counters.wireBytes += Buffer.byteLength(encoded); counters.peakDetailQueue = Math.max(counters.peakDetailQueue, link.toolContentQueuedBytes);
        socket.send(encoded);
      });
    } else if (incoming.type === "v2.frame") link?.handle("relay", incoming.envelope);
  });
  socket.on("close", () => { if (links.get(deviceId) === link) { links.delete(deviceId); tasks.clearDevice(deviceId); subscriptions.clearDevice(deviceId); inventory.closeOwner(deviceId); privateContents.releaseDevice(deviceId); } link?.close(); });
});
await new Promise(done => http.listen(Number(process.argv[3] ?? 0), "127.0.0.1", done));
const port = http.address().port;
await writeFile(resolve(output, "config.json"), JSON.stringify({ port, hostId, pskRoot }));
process.stdout.write(`fixture.ready port=${port}\n`);
async function stop() {
  tasks.close(); subscriptions.close(); privateContents.close(); inventory.dispose();
  for (const link of links.values()) link.close(); for (const socket of ws.clients) socket.terminate();
  await store.dispose(); await writeFile(resolve(output, "stats.json"), JSON.stringify(Object.fromEntries(stats), null, 2));
  ws.close(); http.close();
}
process.once("SIGINT", stop); process.once("SIGTERM", stop);
