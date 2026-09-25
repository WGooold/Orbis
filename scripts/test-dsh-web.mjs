// Opt-in integration check for the installed DSH Web surface.  The script starts
// its own Web process, temporary DSH_HOME, and loopback OpenAI-compatible model;
// it never attaches to the user's running Web or Host process.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolveDshCommand } from "../packages/host/dist/dsh-client.js";
import { DshWebClient } from "../packages/host/dist/dsh-web-client.js";
import { applyDshWebProvider } from "../packages/host/dist/dsh-web-provider.js";

const root = await mkdtemp(join(tmpdir(), "orbis-dsh-web-smoke-"));
const home = join(root, "dsh-home");
const workspace = join(root, "workspace");
await mkdir(join(home, "profiles"), { recursive: true });
await mkdir(workspace, { recursive: true });
// `dsh web` accepts --patch only before the profile app arguments.  A home-level
// patch is cleaner for this smoke and is exactly the launcher layer production
// uses for a shared provider/default selection.
const patch = join(home, "cordis.patch.yml");
await writeFile(patch, `
- id: llm-pi-ai
  config:
    providers:
      smoke:
        apiKeyEnv: ORBIS_DSH_WEB_TEST_KEY
        baseURL: http://127.0.0.1:__MODEL_PORT__/v1
        api: openai-completions
        models:
          - id: smoke-model
- id: agent-default-model
  config:
    provider: smoke
    model: smoke-model
- id: llm-retry
  disabled: true
- id: session-title-llm
  disabled: true
`);

let modelRequests = 0;
let lastModelPath;
let releaseFirst;
const firstResponseGate = new Promise(resolve => { releaseFirst = resolve; });
let releaseSecond;
const secondResponseGate = new Promise(resolve => { releaseSecond = resolve; });
const model = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.method !== "POST" || !["/v1/chat/completions", "/v2/chat/completions"].includes(request.url)) { response.writeHead(404).end(); return; }
  assert.equal(request.headers.authorization, request.url.startsWith("/v2/") ? "Bearer switched-local-key" : "Bearer orbis-local-web-smoke");
  modelRequests++;
  lastModelPath = request.url;
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(body.model, "smoke-model");
  if (modelRequests === 1) await firstResponseGate;
  if (modelRequests === 2) await secondResponseGate;
  response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive", "cache-control": "no-cache" });
  response.flushHeaders();
  const toolRequested = body.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("WEB_SMOKE_TOOL"));
  const toolReturned = body.messages.some(message => message.role === "tool");
  if (toolRequested && !toolReturned) {
    const call = { id: "web-smoke-tool-call", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "printf WEB_TOOL_OK", workdir: workspace }) } };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  const text = toolReturned ? "WEB_SMOKE_TOOL_DONE" : modelRequests === 1 ? "WEB_SMOKE_TOKEN" : "WEB_SMOKE_FOLLOW";
  const frames = [
    { choices: [{ index: 0, delta: { role: "assistant", content: text.slice(0, 8) } }] },
    { choices: [{ index: 0, delta: { content: text.slice(8) } }] },
    { choices: [{ index: 0, delta: {} , finish_reason: "stop" }] },
  ];
  for (const frame of frames) { response.write(`data: ${JSON.stringify(frame)}\n\n`); await delay(10); }
  response.end("data: [DONE]\n\n");
});
await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
const modelPort = model.address().port;
const patchText = await (await import("node:fs/promises")).readFile(patch, "utf8");
await writeFile(patch, patchText.replace("__MODEL_PORT__", String(modelPort)));

const cli = await resolveDshCommand();
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" };
delete env.ORBIS_DSH_WEB_TEST_KEY;
const child = spawn(cli.command, [...cli.prefixArgs, "--profile", "web", "--no-open", "--port", "0"], { env, cwd: workspace, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let output = "";
child.stdout.on("data", chunk => { output += chunk.toString(); });
child.stderr.on("data", chunk => { output += chunk.toString(); });
const started = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`DSH Web did not announce a URL: ${output.slice(-2_000)}`)), 45_000);
  const onData = () => {
    const found = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/i.exec(output);
    if (found) { clearTimeout(timer); resolve(found[1]); }
  };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.once("exit", code => { clearTimeout(timer); reject(new Error(`DSH Web exited (${code}): ${output.slice(-2_000)}`)); });
});

let first;
let second;
const waitFor = async (predicate, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for DSH Web smoke event"); await delay(25); }
};
try {
  const url = await started;
  first = await DshWebClient.connect({ url, cliEntry: cli.prefixArgs[0], timeoutMs: 15_000 });
  second = await DshWebClient.connect({ url, cliEntry: cli.prefixArgs[0], timeoutMs: 15_000 });
  await applyDshWebProvider(first, { ...env, ORBIS_DSH_PROVIDER_ENV: JSON.stringify({ ORBIS_DSH_WEB_TEST_KEY: "orbis-local-web-smoke" }) });
  const list = await first.request("session/list", { _request: {} });
  assert.ok(list && Array.isArray(list.items));
  const created = await first.request("session/create", { request: { cwd: workspace } });
  const sessionId = created.sessionId;
  const frames = [];
  const dispose = second.subscribe("session/follow", { request: { address: { kind: "session", sessionId }, assistantStream: true } }, frame => frames.push(frame), error => { throw error; });
  await second.request("session/prompt", { request: { sessionId, requestId: "web-first", mode: "queue", content: [{ type: "text", text: "WEB_SMOKE_FIRST" }] } });
  await waitFor(() => modelRequests >= 1);
  const queued = await second.request("session/prompt", { request: { sessionId, requestId: "web-queued", mode: "queue", content: [{ type: "text", text: "WEB_SMOKE_QUEUED" }] } });
  assert.equal(queued.accepted, true);
  // Queue mutation uses the official Web API and is intentionally exercised even
  // when the model completes too quickly to retain an item in the inbox.
  await second.request("session/updateQueue", { request: { sessionId, itemId: "web-queued", action: { kind: "remove" } } }).catch(error => assert.match(String(error), /queue-item-not-found|pending/));
  releaseFirst();
  await waitFor(() => frames.some(frame => JSON.stringify(frame).includes("WEB_SMOKE_TOKEN")));
  await first.request("session/prompt", { request: { sessionId, requestId: "web-follow", mode: "queue", content: [{ type: "text", text: "WEB_SMOKE_FOLLOW" }] } });
  await waitFor(() => modelRequests >= 2);
  await second.request("session/cancel", { request: { sessionId } });
  releaseSecond();
  await waitFor(() => frames.some(frame => JSON.stringify(frame).includes("WEB_SMOKE_FOLLOW")));
  await first.request("session/prompt", { request: { sessionId, requestId: "web-tool", mode: "queue", content: [{ type: "text", text: "WEB_SMOKE_TOOL" }] } });
  await waitFor(() => modelRequests >= 3 && frames.some(frame => JSON.stringify(frame).includes("WEB_SMOKE_TOOL_DONE")));
  const switched = (await (await import("node:fs/promises")).readFile(patch, "utf8")).replace("/v1\n", "/v2\n");
  await writeFile(patch, switched);
  await applyDshWebProvider(first, { ...env, ORBIS_DSH_PROVIDER_ENV: JSON.stringify({ ORBIS_DSH_WEB_TEST_KEY: "switched-local-key" }) });
  const beforeSwitch = modelRequests;
  await first.request("session/prompt", { request: { sessionId, requestId: "web-switched", mode: "queue", content: [{ type: "text", text: "VERIFY_SWITCH" }] } });
  await waitFor(() => modelRequests > beforeSwitch);
  assert.equal(lastModelPath, "/v2/chat/completions");
  dispose();
  console.log("PASS: isolated DSH Web launch, two clients, prompt, live follow, streamed token/tool, queue mutation, stop, and live provider URL/key switch");
} finally {
  await first?.stop().catch(() => {});
  await second?.stop().catch(() => {});
  if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once("exit", resolve)); }
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
