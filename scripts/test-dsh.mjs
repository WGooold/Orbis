// Opt-in integration check against the installed CLI. All model traffic stays on loopback.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DshAcpClient, resolveDshCommand } from "../packages/host/dist/dsh-client.js";
import { openDshHistory } from "../packages/host/dist/dsh-history.js";
import { DshRuntime } from "../packages/host/dist/dsh-runtime.js";
import { RuntimeEventSchema } from "../packages/protocol/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "orbis-dsh-smoke-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "fixture.txt"), "DSH_TOOL_FILE 中文");
const patch = join(root, "smoke.patch.yml");
await writeFile(patch, "- id: session-log-deepseek\n  config:\n    enabled: false\n- id: plugin-package-inventory-deepseek\n  disabled: true\n- id: llm-deepseek\n  config:\n    apiKeyEnv: ORBIS_DSH_TEST_KEY\n- id: llm-retry\n  disabled: true\n");
let requests = 0;
let serverFailure;
const server = createServer((req, res) => { void serve(req, res).catch(error => { serverFailure = error; res.destroy(); }); });
async function serve(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!req.url.includes("messages")) { res.writeHead(404).end(); return; }
  requests++;
  const body = JSON.parse(Buffer.concat(chunks).toString());
  assert(body.messages.some(message => JSON.stringify(message).includes("DSH_SMOKE")));
  if (requests === 5) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); return; }
  const tool = requests === 1 ? { name: "read", input: { file_path: join(workspace, "fixture.txt") } }
    : requests === 3 ? { name: "write", input: { file_path: join(root, "approved.txt"), content: "DSH_APPROVED", sandbox_permissions: "danger-full-access", justification: "Allow writing this isolated smoke-test fixture?" } } : undefined;
  if (tool) assert(body.tools.some(item => item.name === tool.name));
  if (requests === 2) assert(JSON.stringify(body.messages).includes("DSH_TOOL_FILE"), "Real read tool result was not returned to the model");
  const frames = [
    { type: "message_start", message: { id: `mock-${requests}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: `call-${requests}`, name: tool.name, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "DSH_SMOKE_OK 中文" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const frame of frames) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  res.end();
}
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const env = { ...process.env, DSH_HOME: join(root, "home"), DSH_PERMISSION_MODE: "workspace-write", DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, ORBIS_DSH_TEST_KEY: "sk-orbis-local-test-placeholder" };
const cli = await resolveDshCommand();
let runtime;
const events = [];
async function start() {
  const history = await openDshHistory(cli.prefixArgs[0], join(env.DSH_HOME, "sessions"));
  try {
    const client = await DshAcpClient.create({ cli, cwd: workspace, env, patches: [patch] });
    const backend = new DshRuntime(client, history);
    backend.setEventSink((event, runtimeId) => { RuntimeEventSchema.parse(event); events.push({ event, runtimeId }); });
    return backend;
  } catch (error) { await history.close(); throw error; }
}
async function command(runtimeId, commandId, command) {
  assert.equal(runtime.dispatchCommand(runtimeId, commandId, command), "handled");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (serverFailure) throw serverFailure;
    const result = events.find(item => item.event.type === "command.result" && item.event.commandId === commandId && item.event.status !== "pending");
    if (result) { assert.equal(result.event.ok, true, result.event.error); return result.event; }
    await delay(50);
  }
  throw new Error(`Timed out: ${commandId}`);
}
async function waitFor(predicate) {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (serverFailure) throw serverFailure;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for DSH event");
    await delay(50);
  }
}
try {
  runtime = await start();
  console.log("ACP initialized");
  const first = await runtime.activate({ type: "new", cwd: workspace });
  const second = await runtime.activate({ type: "new", cwd: workspace });
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(runtime.directoryEntries().length, 2);
  console.log("Two independent persistent sessions created");
  const capabilities = events.findLast(item => item.runtimeId === first.sessionId && item.event.type === "runtime.capabilities").event.capabilities;
  const model = capabilities.commands.find(item => item.name === "model");
  assert(model?.argument.options.length > 0);
  const current = runtime.directoryEntries().find(item => item.sessionId === first.sessionId).model.id;
  await command(first.sessionId, "config-model", { type: "slash.execute", name: "model", args: JSON.stringify(current) });
  const reasoning = capabilities.commands.find(item => item.name === "thinking");
  if (reasoning) await command(first.sessionId, "config-reasoning", { type: "slash.execute", name: "thinking", args: reasoning.argument.options[0].value });
  await command(first.sessionId, "prompt", { type: "user_message", text: "DSH_SMOKE", messageId: "mobile-message" });
  console.log("Prompt complete; mock model requests:", requests);
  assert(events.some(item => item.event.type === "tool.finished" && item.event.toolName === "read" && !item.event.isError));
  const permissionPrompt = command(first.sessionId, "permission-prompt", { type: "user_message", text: "DSH_SMOKE approval" });
  // Attach a handler immediately; the actual result is asserted below.
  permissionPrompt.catch(() => {});
  await waitFor(() => {
    if (events.some(item => item.event.type === "command.result" && item.event.commandId === "permission-prompt" && item.event.status !== "pending")) {
      throw new Error(`Prompt ended without permission: ${JSON.stringify(events.filter(item => item.event.type === "tool.finished" || item.event.type === "command.result").slice(-4))}`);
    }
    return events.some(item => item.event.type === "interaction.requested");
  });
  const approval = events.findLast(item => item.event.type === "interaction.requested").event.request;
  assert(approval.description.includes("approved.txt"), "Permission UI must identify the requested file operation");
  const allow = approval.options.find(item => /allow/i.test(item.value));
  assert(allow, "ACP did not advertise a one-shot allow option");
  await command(first.sessionId, "approve", { type: "interaction.respond", requestId: approval.requestId, extensionId: "dsh", response: { kind: "select", value: allow.value } });
  await permissionPrompt;
  assert.equal(await readFile(join(root, "approved.txt"), "utf8"), "DSH_APPROVED");
  const pending = command(first.sessionId, "slow-prompt", { type: "user_message", text: "DSH_SMOKE cancellation" });
  pending.catch(() => {});
  await waitFor(() => requests === 5);
  await command(first.sessionId, "stop", { type: "stop" });
  assert.equal((await pending).status, "cancelled");
  console.log("Model/reasoning configuration, real read/write, one-shot approval and cancellation passed");
  await command(first.sessionId, "sync", { type: "session.sync", sessionId: first.sessionId, syncId: "preview", range: "preview" });
  const snapshot = events.find(item => item.event.type === "session.snapshot" && item.event.syncId === "preview").event;
  assert(snapshot.entries.some(entry => JSON.stringify(entry).includes("DSH_SMOKE_OK")), "Committed assistant output missing from history");
  await command(first.sessionId, "quit", { type: "slash.execute", name: "quit", args: "" });
  assert(runtime.ownsRuntime(second.sessionId));
  await runtime.stop(); runtime = undefined;
  runtime = await start();
  assert((await runtime.catalog()).some(item => item.sessionId === first.sessionId));
  await runtime.activate({ type: "resume", sessionId: first.sessionId });
  await command(first.sessionId, "resync", { type: "session.sync", sessionId: first.sessionId, syncId: "resumed", range: "preview" });
  const resumed = events.find(item => item.event.type === "session.snapshot" && item.event.syncId === "resumed").event;
  assert.deepEqual(resumed.entries.slice(0, snapshot.entries.length), snapshot.entries);
  assert.equal(requests, 5);
  console.log("PASS: real DSH launch, configuration, multi-session, prompt, tools, approval, stop, history, close, restart, resume; canonical entries unchanged");
  console.log("Isolated diagnostics:", root);
} finally {
  try { await runtime?.stop(); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
