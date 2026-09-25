// Opt-in checks against installed CLIs. Native homes and all inference traffic are isolated.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderManager } from "../packages/host/dist/provider-manager.js";
import { defaultProxyPreferences } from "../packages/host/dist/provider-proxy-config.js";
import { resolveCodexCommand } from "../packages/host/dist/codex-daemon.js";
import { resolvePiCommand } from "../packages/host/dist/spawner.js";

const root = await mkdtemp(join(tmpdir(), "orbis-native-provider-smoke-"));
const paths = { codex: join(root, "codex"), pi: join(root, "pi"), dsh: join(root, "dsh") };
for (const path of Object.values(paths)) await mkdir(path);
const workspace = join(root, "workspace"); await mkdir(workspace);
let failure; let requests = 0; let toolsVerified = 0;
const server = createServer((req, res) => { void serve(req, res).catch(error => { failure = error; res.destroy(); }); });
async function serve(req, res) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests++;
  const anthropic = req.url.endsWith("/messages");
  assert.equal(anthropic ? req.headers["x-api-key"] : req.headers.authorization, anthropic ? "smoke-key" : "Bearer smoke-key");
  const definitions = (body.tools ?? []).map(tool => anthropic ? tool : tool.function);
  const tool = definitions.find(tool => /(?:^|__)(shell_command|exec_command|bash)$/.test(tool.name));
  const resultPresent = body.messages.some(row => row.role === "tool" || (Array.isArray(row.content) && row.content.some(part => part.type === "tool_result")));
  let call;
  if (tool && !resultPresent) {
    const parameters = tool.parameters ?? tool.input_schema;
    const name = tool.name;
    call = { name, arguments: parameters.properties?.cmd ? { cmd: "echo ORBIS_PROXY_TOOL", max_output_tokens: 500 } : { command: "echo ORBIS_PROXY_TOOL" } };
  }
  if (resultPresent) { assert(JSON.stringify(body.messages).includes("ORBIS_PROXY_TOOL"), "Native tool output did not round-trip"); toolsVerified++; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (anthropic) {
    const frames = [
      { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: body.model, content: [], usage: { input_tokens: 8, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: "call_smoke", name: call.name, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) } : { type: "text_delta", text: "ORBIS_PROXY_OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    for (const frame of frames) res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
  } else {
    const delta = call ? { tool_calls: [{ index: 0, id: "call_smoke", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: "ORBIS_PROXY_OK" };
    res.write(`data: ${JSON.stringify({ id: "chat_smoke", model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
  }
  res.end();
}
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const manager = new ProviderManager(join(root, "state"), paths);
async function run(cli, args, env) {
  const child = spawn(cli.command, [...cli.prefixArgs, ...args], { env: { ...process.env, ...env }, cwd: workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 90_000);
  try {
    const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
    if (failure) throw failure;
    assert.equal(code, 0, stderr.slice(-4000) + stdout.slice(-2000));
    assert(stdout.includes("ORBIS_PROXY_OK"), stdout.slice(-4000) + stderr.slice(-4000));
    return stdout;
  } finally { clearTimeout(timer); }
}
try {
  await manager.saveProxyPreferences({ ...defaultProxyPreferences(), enabled: true, port: 0 });
  const codex = await resolveCodexCommand();
  for (const format of ["openai_chat", "anthropic"]) {
    await manager.save("codex", format, format, { apiFormat: format, auth: { OPENAI_API_KEY: "smoke-key" }, config: `model_provider = "smoke"\nmodel = "gpt-5.3-codex"\n[model_providers.smoke]\nname = "Local fixture"\nbase_url = "${baseUrl}"\nwire_api = "responses"\nrequires_openai_auth = true\n` }, true, false);
    await manager.switch("codex", format);
    const result = await run(codex, ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "Return ORBIS_PROXY_OK. This is an isolated local transport test."], { CODEX_HOME: paths.codex, OTEL_SDK_DISABLED: "true" });
    assert(result.includes('"type":"turn.completed"'), "Codex did not complete its native turn");
    const saved = await manager.get("codex", format);
    assert(saved.config.config.includes(baseUrl)); assert.equal(saved.config.auth.OPENAI_API_KEY, "smoke-key");
    console.log(`Native Codex ${format}: passed`);
  }
  await manager.save("pi", "smoke", "Smoke", { api: "openai-completions", baseUrl, apiKey: "smoke-key", models: [{ id: "smoke-model", name: "Smoke", contextWindow: 32000, maxTokens: 4096 }] }, true);
  const pi = await resolvePiCommand();
  await run(pi, ["--provider", "smoke", "--model", "smoke-model", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-p", "Return ORBIS_PROXY_OK."], { PI_CODING_AGENT_DIR: paths.pi });
  assert(JSON.parse(await readFile(join(paths.pi, "models.json"), "utf8")).providers.smoke);
  await manager.switch("pi", "smoke", false);
  assert(!JSON.parse(await readFile(join(paths.pi, "models.json"), "utf8")).providers.smoke);
  console.log(`Native Pi: passed. Requests: ${requests}; tool result round trips: ${toolsVerified}`);
  assert(toolsVerified >= 2, "Native Codex tool execution was not exercised");
} finally {
  await manager.closeRouting(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
