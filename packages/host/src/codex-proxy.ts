import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { gunzip, inflate, brotliDecompress, type ZlibOptions } from "node:zlib";
import { createParser } from "eventsource-parser";
import { ChatResponses, responsesToChat, type ResponseEvent } from "./codex-chat.js";
import { AnthropicChat, responsesToAnthropic } from "./codex-anthropic.js";
import { ProviderCircuit, object, text, upstreamUrl, type Obj, type ProxyPreferences, type ProxyRoute } from "./provider-proxy-config.js";
import { ProviderError } from "./provider-error.js";

export type ProxySnapshot = { preferences: ProxyPreferences; routes: ProxyRoute[] };
const MAX_BODY = 16 * 1024 * 1024;
class UpstreamFailure extends Error { constructor(readonly status: number) { super(`Upstream HTTP ${status}`); } }
const retryable = (error: unknown): boolean => error instanceof UpstreamFailure ? [401, 403, 408, 429].includes(error.status) || error.status >= 500 : !(error instanceof ProviderError);
async function boundedBody(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of body) { size += chunk.length; if (size > MAX_BODY) throw new ProviderError("Request or response exceeded 16 MB"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function jsonResponse(output: ServerResponse, status: number, message: string): void {
  if (output.destroyed) return;
  if (output.headersSent) { output.destroy(); return; }
  output.writeHead(status, { "content-type": "application/json" });
  output.end(JSON.stringify({ error: { message, type: status < 500 ? "invalid_request_error" : "upstream_error" } }));
}
async function write(output: ServerResponse, value: string | Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!output.write(value)) await once(output, "drain", { signal });
}
function eventString(event: Obj): string { return `event: ${text(event.type)}\ndata: ${JSON.stringify(event)}\n\n`; }

/** Loopback data plane. The only accepted operation is an authenticated inference request. */
export class CodexProxy {
  #server: Server | undefined; #baseUrl = ""; #token = "";
  readonly #active = new Set<AbortController>();
  readonly #circuits = new Map<string, ProviderCircuit>();
  readonly #reasoning = new Map<string, Map<string, string>>();
  #lastProvider = ""; #requests = 0; #successes = 0; #failovers = 0;
  constructor(readonly snapshot: () => Promise<ProxySnapshot>, readonly onStatus?: () => void) {}
  get baseUrl(): string { return this.#baseUrl; }
  get running(): boolean { return this.#server !== undefined; }
  get status(): Obj {
    return { running: this.running, baseUrl: this.baseUrl, activeRequests: this.#active.size, totalRequests: this.#requests, successfulRequests: this.#successes, failoverCount: this.#failovers, lastProviderId: this.#lastProvider, health: [...this.#circuits].map(([id, c]) => ({ id, state: c.state, failures: c.failures, lastError: c.lastError, lastSuccessAt: c.lastSuccessAt, lastFailureAt: c.lastFailureAt })) };
  }
  reset(id: string): void { this.#circuits.delete(id); }
  async start(port: number, token: string): Promise<void> {
    if (this.#server) return;
    const server = createServer((request, response) => { void this.#handle(request, response).catch(() => jsonResponse(response, 500, "Local route failed")); });
    server.requestTimeout = 60_000; server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    server.on("error", () => { /* Individual socket errors must not terminate the Host. */ });
    this.#server = server; this.#token = token;
    this.#baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }
  async stop(): Promise<void> {
    const server = this.#server; this.#server = undefined;
    for (const controller of this.#active) controller.abort();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    this.#baseUrl = ""; this.#reasoning.clear();
  }
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authorization = request.headers.authorization ?? "";
    const expected = `Bearer ${this.#token}`;
    const valid = Buffer.byteLength(authorization) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(authorization), Buffer.from(expected));
    if (request.headers.origin || request.headers.host !== new URL(this.baseUrl).host || !valid) { jsonResponse(response, 401, "Local route authentication required"); return; }
    const requestUrl = new URL(request.url ?? "/", this.baseUrl);
    if (request.method !== "POST" || !["/v1/responses", "/v1/responses/compact"].includes(requestUrl.pathname)) { jsonResponse(response, 404, "Unknown route"); return; }
    if (this.#active.size >= 32) { jsonResponse(response, 429, "Too many local inference requests"); return; }
    const abort = new AbortController(); this.#active.add(abort); this.#requests++;
    const close = () => { if (!response.writableFinished) abort.abort(); };
    response.once("close", close);
    let timer: NodeJS.Timeout | undefined;
    try {
      let data = await boundedBody(request);
      const encoding = request.headers["content-encoding"];
      if (encoding && encoding !== "identity") {
        const decoder = encoding === "gzip" ? gunzip : encoding === "deflate" ? inflate : encoding === "br" ? brotliDecompress : undefined;
        if (!decoder) { jsonResponse(response, 415, "Unsupported content encoding"); return; }
        const decompress = decoder as (buffer: Uint8Array, options: ZlibOptions, callback: (error: Error | null, result: Buffer) => void) => void;
        data = await new Promise<Buffer>((resolve, reject) => decompress(data, { maxOutputLength: MAX_BODY }, (error, result) => error ? reject(error) : resolve(result)));
      }
      let body: Obj;
      try { const value: unknown = JSON.parse(data.toString("utf8")); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); body = value as Obj; }
      catch { jsonResponse(response, 400, "Expected a JSON request object"); return; }
      const snapshot = await this.snapshot();
      const { preferences: p, routes } = snapshot;
      if (!p.enabled || !routes.length) { jsonResponse(response, 503, "No enabled Codex route"); return; }
      timer = setTimeout(() => abort.abort(), p.requestTimeout * 1000);
      const compact = requestUrl.pathname.endsWith("/compact");
      let last = "All configured routes are unavailable";
      const candidates = p.autoFailoverEnabled ? routes : routes.slice(0, 1);
      let attempts = 0;
      for (const [index, route] of candidates.entries()) {
        if (attempts > p.maxRetries) break;
        abort.signal.throwIfAborted();
        let circuit = this.#circuits.get(route.id);
        if (!circuit) { circuit = new ProviderCircuit(); this.#circuits.set(route.id, circuit); }
        if (p.autoFailoverEnabled && !circuit.allow(p)) continue;
        attempts++;
        let upstreamAbort: AbortController | undefined;
        try {
          if (upstreamUrl(route, compact).origin === new URL(this.baseUrl).origin) throw new ProviderError("A proxy route cannot point back to itself");
          let history = this.#reasoning.get(route.id);
          if (!history) { history = new Map(); this.#reasoning.set(route.id, history); }
          while (this.#reasoning.size > 8) this.#reasoning.delete(this.#reasoning.keys().next().value!);
          const model = (Array.isArray(route.options.models) ? route.options.models.map(text).find(id => id.toLowerCase() === text(body.model).toLowerCase()) : undefined) ?? route.model;
          const options = { ...route.options, reasoning: object(route.options.reasoningByModel)[model] ?? route.options.reasoning };
          const converted = route.format === "openai_chat" ? responsesToChat(body, model, options, history) : route.format === "anthropic" ? responsesToAnthropic(body, model, options) : undefined;
          const payload = { ...(converted?.body ?? body), ...object(route.options.bodyOverrides) };
          // Stream framing is a transport contract, not an overridable vendor field.
          if (converted || Object.hasOwn(body, "stream")) payload.stream = body.stream === true;
          else delete payload.stream;
          const cacheMode = route.options.promptCacheRouting;
          const url = new URL(route.url);
          if (route.format === "openai_chat" && cacheMode !== "disabled" && (cacheMode === "enabled" || url.hostname === "api.openai.com" || (url.hostname === "api.kimi.com" && url.pathname.startsWith("/coding")))) {
            const key = text(body.prompt_cache_key) || text(request.headers["session_id"]);
            if (key) payload.prompt_cache_key = key;
          }
          upstreamAbort = new AbortController();
          const signal = AbortSignal.any([abort.signal, upstreamAbort.signal]);
          let idle = setTimeout(() => upstreamAbort!.abort(), (body.stream === true ? p.firstByteTimeout : p.requestTimeout) * 1000);
          const kick = () => { clearTimeout(idle); idle = setTimeout(() => upstreamAbort!.abort(), p.idleTimeout * 1000); };
          try {
            const upstream = await fetch(upstreamUrl(route, compact, requestUrl.searchParams), { method: "POST", headers: route.headers, body: JSON.stringify(payload), redirect: "error", signal });
            if (!upstream.ok) { await upstream.body?.cancel(); throw new UpstreamFailure(upstream.status); }
            if (!upstream.body) throw new Error("Empty upstream response");
            if (body.stream !== true) clearTimeout(idle);
            const converter = converted ? new ChatResponses(converted.tools, model || text(body.model), (id, thoughts) => {
              if (thoughts) history!.set(id, thoughts.slice(0, 100_000));
              while (history!.size > 64) history!.delete(history!.keys().next().value!);
            }) : undefined;
            if (body.stream === true) {
              const events: Obj[] = []; const anthropic = new AnthropicChat();
              let terminal = false; let size = 0;
              const parser = createParser({ onEvent: event => {
                if (event.data === "[DONE]") return;
                let value: Obj; try { value = object(JSON.parse(event.data)); } catch { throw new ProviderError("Malformed upstream SSE JSON"); }
                if (converter) for (const chunk of route.format === "anthropic" ? anthropic.push(value) : [value]) events.push(...converter.push(chunk));
                else {
                  if (value.error || value.type === "response.failed") throw new Error("Upstream response failed");
                  if (["response.completed", "response.incomplete"].includes(text(value.type))) terminal = true;
                  events.push(value);
                }
              } });
              const decoder = new TextDecoder();
              for await (const chunk of upstream.body) {
                kick(); size += chunk.byteLength; if (size > MAX_BODY) throw new Error("Upstream output is too large");
                parser.feed(decoder.decode(chunk, { stream: true }));
                if (events.length && !response.headersSent) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                for (const event of events.splice(0)) await write(response, eventString(event), signal);
              }
              parser.feed(decoder.decode());
              if (converter) events.push(...converter.finish()); else if (!terminal) throw new Error("Upstream stream ended without completion");
              if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
              for (const event of events) await write(response, eventString(event), signal);
              response.end();
            } else {
              const value = object(JSON.parse((await boundedBody(upstream.body)).toString("utf8")));
              if (value.error) throw new Error("Upstream returned an error");
              let result: Obj = value;
              if (converter) {
                for (const chunk of route.format === "anthropic" ? new AnthropicChat().complete(value) : [value]) converter.push(chunk);
                result = object((converter.finish().at(-1) as ResponseEvent).response);
              }
              response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
            }
          } finally { clearTimeout(idle); }
          circuit.record(true, p); this.#successes++; this.#lastProvider = route.id; if (index > 0) this.#failovers++;
          return;
        } catch (error) {
          circuit.probing = false;
          if (abort.signal.aborted) throw error;
          last = error instanceof UpstreamFailure || error instanceof ProviderError ? error.message : "Upstream connection failed or timed out";
          circuit.record(false, p, last);
          if (response.headersSent || !p.autoFailoverEnabled || !retryable(error)) { if (!response.headersSent) jsonResponse(response, error instanceof ProviderError ? 400 : 502, last); else response.destroy(); return; }
        } finally { upstreamAbort?.abort(); }
      }
      jsonResponse(response, 503, last);
    } catch { jsonResponse(response, abort.signal.aborted ? 504 : 400, abort.signal.aborted ? "Inference request cancelled or timed out" : "Invalid local inference request"); }
    finally { if (timer) clearTimeout(timer); response.off("close", close); this.#active.delete(abort); this.onStatus?.(); }
  }
}
