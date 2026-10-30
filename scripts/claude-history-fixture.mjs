// Real Host + Relay + Claude Mods HTTP bridge, with synthetic native transcript rows.
// Run after `npm run typecheck`; pass the output directory, then use fixture.json's
// port as -e claudeFixturePort for ClaudeHistoryInstrumentedTest on an emulator.
import { createServer } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRelayServer } from "../packages/relay/dist/index.js";
import { HostService } from "@orbis/host";

const output = resolve(process.argv[2] ?? ".scratch/claude-history");
const stateDir = join(output, `host-${randomUUID()}`);
const configDir = join(stateDir, "claude-config");
await mkdir(join(configDir, "projects", "fixture"), { recursive: true });
const sessionId = "claude-history-fixture", runtimeId = `claude:${sessionId}`;
const transcript = join(configDir, "projects", "fixture", `${sessionId}.jsonl`);
const row = (type, uuid, parentUuid, content) => ({ type, uuid, parentUuid, cwd: stateDir,
  timestamp: new Date().toISOString(), message: { role: type, content,
    ...(type === "assistant" ? { model: "claude-opus-fixture" } : {}) } });
const lines = rows => rows.map(value => `${JSON.stringify(value)}\n`).join("");
await writeFile(transcript, lines([
  row("user", "u1", null, "Show the existing conversation"),
  row("assistant", "a1", "u1", [{ type: "text", text: "CLAUDE_HISTORY_VISIBLE" }]),
]));
const relay = await createRelayServer({ port: 0, runtimeCredentials: ["claude-fixture-runtime"],
  adminToken: "claude-fixture-admin", stateFile: join(stateDir, "relay.json") });
const host = await HostService.create({ relayUrl: relay.url, credential: "claude-fixture-runtime",
  adminToken: "claude-fixture-admin", stateDir, sessionsRoot: join(stateDir, "pi-sessions"),
  reconnect: false, lan: false, claude: { configDir,
    launcher: { unavailable: async () => "fixture_read_only", launch: async () => { throw new Error("fixture_read_only"); } } } });
await host.start();
const descriptor = JSON.parse(await readFile(join(stateDir, "loopback.json"), "utf8"));
async function post(path, body) {
  const response = await fetch(`${descriptor.url.replace(/^ws/u, "http")}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`bridge_http_${response.status}`);
  return response.json();
}
const hello = await post("/v1/claude/mods/hello", { type: "hello", instanceId: "fixture-tui", sessionId,
  cwd: stateDir, claudeVersion: "2.1.312", bridgeVersion: "1", configDir,
  capabilities: ["prompt.submit", "turn.abort", "session.append", "turn.start", "turn.complete", "turn.step.delta", "tool.call"] });
if (!hello.ok) throw new Error(`bridge_hello_${hello.error}`);
async function event(value) {
  const result = await post("/v1/claude/mods/event", { runtimeId, generation: hello.generation, event: value });
  if (result.result !== "accepted") throw new Error(`bridge_event_${result.result}`);
}
const heartbeat = setInterval(() => {
  void post("/v1/claude/mods/poll", { runtimeId, generation: hello.generation }).catch(() => undefined);
}, 2_000);
await event({ type: "session.state", state: { model: "claude-opus-fixture", modelName: "Opus fixture" } });
await event({ type: "turn.start", turnId: "fixture-turn", startedAt: Date.now() });
await event({ type: "turn.step.chunks", turnId: "fixture-turn", stepIndex: 0,
  chunks: [{ blockIndex: 0, contentType: "text", delta: "CLAUDE_ALREADY_STREAMING" }] });
let advanced = false, finished = false;
const server = createServer((request, response) => {
  void (async () => {
    response.setHeader("content-type", "application/json");
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/pairing") {
      const pairing = await host.openPairingWindow();
      response.end(JSON.stringify({ ...pairing.payload, relayUrl: relay.url.replace("127.0.0.1", "10.0.2.2") }));
    } else if (path === "/advance" && request.method === "POST" && !advanced) {
      advanced = true;
      await appendFile(transcript, lines([
        row("assistant", "call-1", "a1", [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "fixture-a" } }]),
        row("assistant", "call-2", "call-1", [{ type: "tool_use", id: "tool-2", name: "Read", input: { file_path: "fixture-b" } }]),
        row("user", "result-1", "call-1", [{ type: "tool_result", tool_use_id: "tool-1", content: "first result" }]),
        row("user", "result-2", "call-2", [{ type: "tool_result", tool_use_id: "tool-2", content: "second result" }]),
        row("assistant", "parallel", "result-2", [{ type: "text", text: "CLAUDE_PARALLEL_HISTORY" }]),
      ]));
      await event({ type: "session.append", uuid: "parallel", door: "main" });
      await event({ type: "turn.step.chunks", turnId: "fixture-turn", stepIndex: 1,
        chunks: [{ blockIndex: 0, contentType: "text", delta: "CLAUDE_STREAM_VISIBLE" }] });
      response.end("{}");
    } else if (path === "/finish" && request.method === "POST" && advanced && !finished) {
      finished = true;
      await appendFile(transcript, lines([row("assistant", "final", "parallel", [{ type: "text", text: "CLAUDE_FINAL_VISIBLE" }])]));
      await event({ type: "session.append", uuid: "final", door: "main" });
      await event({ type: "turn.complete", turnId: "fixture-turn", answer: "CLAUDE_FINAL_VISIBLE" });
      response.end("{}");
    } else if (path === "/stats") {
      const rejected = host.readDiagnostics({ category: "recovery" }).records
        .filter(record => record.message.includes("Rejected conversation"));
      response.end(JSON.stringify({ advanced, finished, rejected: rejected.map(record => record.detail?.reason) }));
    } else response.writeHead(404).end("{}");
  })().catch(error => { response.writeHead(500).end(JSON.stringify({ error: error.message })); });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await writeFile(join(output, "fixture.json"), JSON.stringify({ port: server.address().port, runtimeId, sessionId }));
process.stdout.write(`Claude history fixture listening on ${server.address().port}\n`);
let closing = false;
async function stop() {
  if (closing) return; closing = true;
  clearInterval(heartbeat); server.close();
  await host.stop(); await relay.close();
}
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
