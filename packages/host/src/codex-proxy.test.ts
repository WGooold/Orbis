import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, it, expect, vi } from "vitest";
import { CodexProxy } from "./codex-proxy.js";
import { ProviderManager } from "./provider-manager.js";
import { defaultProxyPreferences, ProviderCircuit, proxyPreferences, proxyRoute, type ProxyRoute, type Obj } from "./provider-proxy-config.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
async function upstream(handler: (body: Obj, request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    handler(JSON.parse(Buffer.concat(chunks).toString("utf8")), request, response);
  })(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}
const route = (id: string, url: string): ProxyRoute => ({ id, name: id, url, format: "openai_chat", model: "model", headers: { authorization: `Bearer ${id}-secret` }, query: {}, options: {}, fullUrl: false });
async function proxy(routes: ProxyRoute[], extra: Partial<ReturnType<typeof defaultProxyPreferences>> = {}) {
  const preferences = { ...defaultProxyPreferences(), enabled: true, ...extra };
  const current = { preferences, routes };
  const server = new CodexProxy(async () => structuredClone(current));
  await server.start(0, "local-test-token"); cleanup.push(() => server.stop());
  const post = (body: Obj, options: RequestInit = {}) => fetch(`${server.baseUrl}/responses`, { method: "POST", headers: { authorization: "Bearer local-test-token" }, body: JSON.stringify(body), ...options });
  return { server, current, post };
}
const chat = (content = "answer") => ({ id: "chat_1", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });

describe("authenticated Codex local routing", () => {
  it.each(["responses", "openai_chat", "anthropic"] as const)("routes compact requests for %s without a bogus upstream suffix or stream field", async format => {
    const seen: Array<{ path: string; body: Obj }> = [];
    const native = { id: "cmp_1", object: "response.compaction", output: [{ type: "compaction", encrypted_content: "opaque" }], usage: { input_tokens: 2, output_tokens: 1 } };
    const url = await upstream((body, req, res) => {
      seen.push({ path: req.url!, body });
      res.end(JSON.stringify(format === "responses" ? native : format === "openai_chat" ? chat("summary") : { type: "message", content: [{ type: "text", text: "summary" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } }));
    });
    const { server } = await proxy([{ ...route("a", url), format }]);
    const result = await fetch(`${server.baseUrl}/responses/compact?trace=preserved`, { method: "POST", headers: { authorization: "Bearer local-test-token" }, body: JSON.stringify({ model: "requested", input: "summarize", instructions: "retain facts" }) });
    expect(result.status).toBe(200);
    if (format === "responses") {
      expect(await result.json()).toEqual(native);
      expect(seen[0]).toEqual({ path: "/v1/responses/compact?trace=preserved", body: { model: "requested", input: "summarize", instructions: "retain facts" } });
    } else {
      expect(await result.json()).toMatchObject({ output: [{ content: [{ text: "summary" }] }] });
      expect(seen[0]!.path).toBe((format === "openai_chat" ? "/v1/chat/completions" : "/v1/messages") + "?trace=preserved");
    }
  });
  it("selects reasoning capabilities from the requested catalog model", async () => {
    const seen: Obj[] = [];
    const url = await upstream((body, _req, res) => { seen.push(body); res.end(JSON.stringify(chat())); });
    const config = { auth: { OPENAI_API_KEY: "test" }, apiFormat: "openai_chat", config: `model_provider="custom"\nmodel="glm-5.2"\n[model_providers.custom]\nbase_url="${url}"\n`, modelCatalog: { models: [{ model: "glm-5.2", reasoningLevels: ["high", "max"] }, { model: "kimi-k3", reasoningLevels: ["max"] }, { model: "qwen" }] } };
    const { post } = await proxy([proxyRoute({ id: "zen", kind: "codex", name: "opencode.ai", config })]);
    for (const model of ["glm-5.2", "KIMI-K3", "qwen"]) {
      const response = await post({ input: "test", model, reasoning: { effort: "medium" } });
      expect(response.status).toBe(200); await response.text();
    }
    expect(seen.map(body => [body.model, body.reasoning_effort])).toEqual([["glm-5.2", "high"], ["kimi-k3", "max"], ["qwen", undefined]]);
  });
  it("uses only explicit queue order and only each target's own credentials", async () => {
    const seen: string[] = [];
    const a = await upstream((_body, request, response) => { seen.push(request.headers.authorization!); response.writeHead(429); response.end("key-secret must never escape"); });
    const b = await upstream((_body, request, response) => { seen.push(request.headers.authorization!); response.end(JSON.stringify(chat())); });
    const { post, server } = await proxy([route("a", a), route("b", b)], { autoFailoverEnabled: true });
    const result = await post({ input: "test" });
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ status: "completed", output: [{ content: [{ text: "answer" }] }] });
    expect(seen).toEqual(["Bearer a-secret", "Bearer b-secret"]);
    expect(JSON.stringify(server.status)).not.toContain("secret");
    expect(server.status).toMatchObject({ failoverCount: 1, lastProviderId: "b" });
  });
  it("does not retry with failover disabled, on input errors, or after streamed output starts", async () => {
    let second = 0;
    const bad = await upstream((_body, _req, res) => { res.writeHead(400); res.end("private upstream details"); });
    const good = await upstream((_body, _req, res) => { second++; res.end(JSON.stringify(chat())); });
    const { post } = await proxy([route("a", bad), route("b", good)], { autoFailoverEnabled: true });
    const response = await post({ input: "test" }); expect(response.status).toBe(502); expect(await response.text()).not.toContain("private"); expect(second).toBe(0);
    const disabled = await proxy([route("a", bad), route("b", good)]);
    expect((await disabled.post({ input: "x" })).status).toBe(502); expect(second).toBe(0);
    const truncated = await upstream((_body, _req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'); });
    const streaming = await proxy([route("a", truncated), route("b", good)], { autoFailoverEnabled: true });
    const partial = await streaming.post({ input: "test", stream: true });
    await expect(partial.text()).rejects.toThrow(); expect(second).toBe(0);
  });
  it("rejects unauthenticated, browser-origin and DNS rebinding requests", async () => {
    let hits = 0;
    const url = await upstream((_body, _req, res) => { hits++; res.end(JSON.stringify(chat())); });
    const { post, server } = await proxy([route("a", url)]);
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Bearer local-test-token", origin: "https://other.test" }]) {
      const response = await post({ input: "test" }, { headers }); expect(response.status).toBe(401); await response.text();
    }
    const rebound = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${server.baseUrl}/responses`, { method: "POST", headers: { host: "other.test", authorization: "Bearer local-test-token" } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.end(JSON.stringify({ input: "test" }));
    });
    expect(rebound).toBe(401);
    expect(hits).toBe(0);
  });
  it("parses split CRLF SSE, preserves UTF-8 and completes streamed tools", async () => {
    const url = await upstream((_body, _req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const raw = Buffer.from([
        'data: {"choices":[{"delta":{"reasoning_content":"思考","tool_calls":[{"index":0,"id":"call","function":{"name":"read","arguments":"{\\"file\\":"}}]}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ].join(""));
      for (let i = 0; i < raw.length; i += 7) res.write(raw.subarray(i, i + 7)); res.end();
    });
    const { post } = await proxy([route("a", url)]);
    const response = await post({ input: "x", stream: true, tools: [{ type: "function", name: "read", parameters: { type: "object" } }] });
    const data = await response.text();
    expect(data).toContain("response.completed"); expect(data).toContain("思考"); expect(data).toContain('"call_id":"call"'); expect(data).toContain('"name":"read"');
  });
  it("takes one immutable route snapshot per request and cancels upstream on disconnect", async () => {
    let finish: (() => void) | undefined; let closed = false;
    const url = await upstream((_body, _req, res) => { res.once("close", () => { closed = true; }); finish = () => res.end(JSON.stringify(chat("old"))); });
    const { post, current, server } = await proxy([route("a", url)]);
    const inFlight = post({ input: "test" });
    await vi.waitFor(() => expect(finish).toBeDefined());
    current.routes = [];
    finish!(); expect(await (await inFlight).json()).toMatchObject({ output: [{ content: [{ text: "old" }] }] });
    current.routes = [route("a", url)]; finish = undefined; closed = false;
    const abort = new AbortController(); const cancelled = post({ input: "x" }, { signal: abort.signal }).catch(() => undefined);
    await vi.waitFor(() => expect(finish).toBeDefined()); abort.abort(); await cancelled;
    await vi.waitFor(() => expect(closed).toBe(true)); await vi.waitFor(() => expect(server.status.activeRequests).toBe(0));
  });
});

describe("native proxy takeover transactions", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "orbis-proxy-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const paths = { codex: join(root, "codex"), pi: join(root, "pi"), dsh: join(root, "dsh") };
    for (const path of Object.values(paths)) await mkdir(path);
    const afterApply = vi.fn(async () => {});
    const manager = new ProviderManager(join(root, "state"), paths, { afterApply }); cleanup.push(() => manager.closeRouting());
    const profile = (name: string, format = "responses") => ({ apiFormat: format, auth: { OPENAI_API_KEY: `${name}-secret` }, config: `model_provider="custom"\nmodel="${name}"\n[model_providers.custom]\nname="Custom"\nbase_url="https://${name}.example/v1"\nwire_api="responses"\nrequires_openai_auth=true\n[features]\nkeep=true\n` });
    return { manager, paths, profile, root, afterApply };
  }
  it("backfills true upstream data and preserves external common edits while hot-switching and restoring", async () => {
    const { manager, paths, profile, afterApply } = await fixture();
    await manager.save("codex", "a", "A", profile("a"), true);
    await manager.save("codex", "b", "B", profile("b", "openai_chat"), true, false);
    await manager.saveProxyPreferences({ ...defaultProxyPreferences(), enabled: true, port: 0 });
    const native = join(paths.codex, "config.toml");
    expect(parse(await readFile(native, "utf8"))).toMatchObject({ model_provider: "orbis-router" });
    const backfilled = await manager.get("codex", "a");
    expect(JSON.stringify(backfilled)).toContain("https://a.example/v1"); expect(JSON.stringify(backfilled)).not.toContain("127.0.0.1");
    expect(backfilled.config.auth).toEqual({ OPENAI_API_KEY: "a-secret" });
    await writeFile(native, (await readFile(native, "utf8")).replace("keep=true", "keep=false"));
    afterApply.mockClear(); await manager.switch("codex", "b"); expect(afterApply).toHaveBeenCalledWith("codex", true);
    expect((await manager.get("codex", "b")).config.auth).toEqual({ OPENAI_API_KEY: "b-secret" });
    await manager.switch("codex", "a");
    await manager.saveProxyPreferences({ ...defaultProxyPreferences(), enabled: false, port: Number(new URL(String((await manager.proxyStatus() as any).baseUrl)).port) });
    const restored = await readFile(native, "utf8"); expect(restored).not.toContain("orbis-router"); expect(restored).toContain("https://a.example/v1"); expect(restored).toContain("keep=false");
  });
  it("validates queue membership, protects official accounts and refuses deletion of queued cards", async () => {
    const { manager, profile } = await fixture();
    await manager.save("codex", "official", "Official", { auth: {}, config: "" }, true);
    await manager.save("codex", "a", "A", profile("a"), true, false);
    const preferences = { ...defaultProxyPreferences(), enabled: true, port: 0, autoFailoverEnabled: true };
    await expect(manager.saveProxyPreferences({ ...preferences, queue: ["official"] })).rejects.toThrow("Official");
    await expect(manager.saveProxyPreferences({ ...preferences, queue: ["missing"] })).rejects.toThrow("missing");
    await manager.saveProxyPreferences({ ...preferences, queue: ["a"] });
    await expect(manager.remove("codex", "a")).rejects.toThrow("queue");
    expect(manager.proxyTakeoverActive).toBe(false);
  });
  it("rolls back a rejected switch without changing its active proxy target", async () => {
    const { manager, paths, profile, afterApply } = await fixture();
    await manager.save("codex", "a", "A", profile("a"), true);
    await manager.save("codex", "b", "B", profile("b"), true, false);
    await manager.saveProxyPreferences({ ...defaultProxyPreferences(), enabled: true, port: 0 });
    const before = await readFile(join(paths.codex, "config.toml"), "utf8");
    afterApply.mockRejectedValueOnce(new Error("reload failed"));
    await expect(manager.switch("codex", "b")).rejects.toThrow("已恢复原配置");
    expect(await readFile(join(paths.codex, "config.toml"), "utf8")).toBe(before);
    expect((await manager.list("codex")).find(p => p.enabled)?.id).toBe("a");
  });
  it("restores native configuration on shutdown and re-enables routing on startup", async () => {
    const { manager, paths, profile } = await fixture();
    await manager.save("codex", "a", "A", profile("a"), true);
    await manager.saveProxyPreferences({ ...defaultProxyPreferences(), enabled: true, port: 0 });
    await manager.closeRouting();
    expect(await readFile(join(paths.codex, "config.toml"), "utf8")).not.toContain("orbis-router");
    await manager.startRouting(); expect(manager.proxyTakeoverActive).toBe(true);
  });
  it("allows disabling conversion and restores the selected card's native routing", async () => {
    const { manager, paths, profile } = await fixture();
    await manager.save("codex", "a", "A", profile("a"), true);
    await manager.save("codex", "b", "B", profile("b", "openai_chat"), true, false);
    const enabled = await manager.saveProxyPreferences({ ...defaultProxyPreferences(), enabled: true, port: 0 }) as { preferences: Obj };
    await manager.switch("codex", "b");
    await expect(manager.saveProxyPreferences({ ...enabled.preferences, enabled: false })).rejects.toThrow("Responses provider");
    await manager.switch("codex", "a");
    await manager.saveProxyPreferences({ ...enabled.preferences, enabled: false });
    expect(manager.proxyTakeoverActive).toBe(false);
    const native = await readFile(join(paths.codex, "config.toml"), "utf8");
    expect(native).toContain("https://a.example/v1"); expect(native).not.toContain("orbis-router");
    expect((await manager.get("codex", "b")).config.apiFormat).toBe("openai_chat");
  });
  it("leaves externally changed routing intact and reports the conflict", async () => {
    const { manager, paths, profile } = await fixture();
    await manager.save("codex", "a", "A", profile("a"), true);
    await manager.saveProxyPreferences({ ...defaultProxyPreferences(), enabled: true, port: 0 });
    const path = join(paths.codex, "config.toml"); const before = await readFile(path, "utf8");
    const external = before.replace('model_provider = "orbis-router"', 'model_provider = "external"');
    expect(external).not.toBe(before);
    await writeFile(path, external);
    try {
      await expect(manager.saveProxyPreferences(defaultProxyPreferences())).rejects.toThrow("edited outside Host");
      expect(await readFile(path, "utf8")).toBe(external);
    } finally { await writeFile(path, before); }
  });
  it("restores a crashed takeover when its saved port is occupied at startup", async () => {
    const { manager, paths, profile, root } = await fixture();
    await manager.save("codex", "a", "A", profile("a"), true);
    const enabled = await manager.saveProxyPreferences({ ...defaultProxyPreferences(), enabled: true, port: 0 }) as { preferences: { port: number } };
    const nativePath = join(paths.codex, "config.toml"); const storePath = join(root, "state", "providers.json");
    const projected = await readFile(nativePath, "utf8"); const saved = await readFile(storePath, "utf8");
    await manager.closeRouting();
    await writeFile(nativePath, projected); await writeFile(storePath, saved);
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(enabled.preferences.port, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>(resolve => blocker.close(() => resolve())));
    await expect(manager.startRouting()).rejects.toThrow("EADDRINUSE");
    expect(await readFile(nativePath, "utf8")).not.toContain("orbis-router");
    expect(manager.proxyTakeoverActive).toBe(false);
    expect(JSON.parse(await readFile(storePath, "utf8"))).not.toHaveProperty("proxyTakeover");
  });
});

it("uses configurable circuit thresholds and allows only one recovery probe at a time", () => {
  let now = 0; const circuit = new ProviderCircuit(() => now); const p = { ...defaultProxyPreferences(), failureThreshold: 2, successThreshold: 2, timeoutSeconds: 10 };
  circuit.record(false, p); expect(circuit.allow(p)).toBe(true);
  circuit.record(false, p); expect(circuit.allow(p)).toBe(false);
  now = 10_000; expect(circuit.allow(p)).toBe(true); expect(circuit.allow(p)).toBe(false);
  circuit.record(true, p); expect(circuit.state).toBe("half_open"); expect(circuit.allow(p)).toBe(true);
  circuit.record(true, p); expect(circuit.state).toBe("closed");
  expect(() => proxyPreferences({ ...p, queue: ["a", "a"] })).toThrow();
});
