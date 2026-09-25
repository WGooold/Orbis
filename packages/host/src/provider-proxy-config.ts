// Adapted from CC Switch f8788719 proxy configuration and circuit semantics (MIT).
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { ProviderError } from "./provider-error.js";
import { codexOfficial, codexToken } from "./provider-codex.js";
import { setToml } from "./provider-toml.js";
import { providerUrl } from "./provider-network.js";
import type { ProviderProfile } from "./provider-manager.js";
import { reasoningOptions } from "./codex-reasoning.js";

export type Obj = Record<string, unknown>;
export const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
export const text = (value: unknown): string => typeof value === "string" ? value : "";
export type UpstreamFormat = "responses" | "openai_chat" | "anthropic";
export function validateCodexRouting(config: Obj): void {
  for (const key of ["isFullUrl", "fullUrl"])
    if (config[key] !== undefined && typeof config[key] !== "boolean") throw new ProviderError(`${key} must be a boolean`);
  if (config.promptCacheRouting !== undefined && !["auto", "enabled", "disabled"].includes(text(config.promptCacheRouting))) throw new ProviderError("Invalid prompt cache routing mode");
  for (const key of ["codexChatReasoning", "chatOptions", "requestOverrides"])
    if (config[key] !== undefined && (!config[key] || Array.isArray(config[key]) || typeof config[key] !== "object")) throw new ProviderError(`${key} must be a JSON object`);
  const reasoning = object(config.codexChatReasoning);
  for (const key of ["supportsThinking", "supportsEffort"])
    if (reasoning[key] !== undefined && typeof reasoning[key] !== "boolean") throw new ProviderError(`Invalid ${key}`);
  for (const [key, values] of Object.entries({ thinkingParam: ["none", "thinking", "enable_thinking", "reasoning_split"], effortParam: ["none", "reasoning_effort", "reasoning.effort"], effortValueMode: ["passthrough", "deepseek", "low_high", "openrouter", "zen"], outputFormat: ["auto", "reasoning_content", "reasoning", "reasoning_details", "think_tag"] }))
    if (reasoning[key] !== undefined && !values.includes(text(reasoning[key]))) throw new ProviderError(`Invalid reasoning ${key}`);
  const overrides = object(config.requestOverrides);
  for (const key of ["headers", "body"])
    if (overrides[key] !== undefined && (!overrides[key] || Array.isArray(overrides[key]) || typeof overrides[key] !== "object")) throw new ProviderError(`Request ${key} override must be a JSON object`);
  if (Object.values(object(overrides.headers)).some(value => typeof value !== "string")) throw new ProviderError("Request header overrides must be strings");
}
export function upstreamFormat(config: Obj): UpstreamFormat {
  const doc = parse(text(config.config));
  const route = object(object(doc.model_providers)[text(doc.model_provider)]);
  const value = text(config.apiFormat ?? config.api_format ?? route.wire_api ?? doc.wire_api ?? "responses").trim().toLowerCase();
  if (["responses", "openai_responses", "openai-responses"].includes(value)) return "responses";
  if (["chat", "chat_completions", "chat-completions", "openai_chat", "openai-chat", "openai_chat_completions", "openai-completions"].includes(value)) return "openai_chat";
  if (["anthropic", "anthropic_messages", "anthropic-messages", "claude", "messages"].includes(value)) return "anthropic";
  throw new ProviderError("Unsupported Codex upstream API format");
}
export type ProxyPreferences = {
  enabled: boolean; port: number; autoFailoverEnabled: boolean; queue: string[];
  maxRetries: number; firstByteTimeout: number; idleTimeout: number; requestTimeout: number;
  failureThreshold: number; successThreshold: number; timeoutSeconds: number; errorRateThreshold: number; minRequests: number;
};
export const defaultProxyPreferences = (): ProxyPreferences => ({
  enabled: false, port: 43129, autoFailoverEnabled: false, queue: [], maxRetries: 2,
  firstByteTimeout: 60, idleTimeout: 120, requestTimeout: 600,
  failureThreshold: 4, successThreshold: 2, timeoutSeconds: 60, errorRateThreshold: 0.6, minRequests: 10,
});
export function proxyPreferences(value: unknown): ProxyPreferences {
  const p = { ...defaultProxyPreferences(), ...object(value) };
  if (typeof p.enabled !== "boolean" || typeof p.autoFailoverEnabled !== "boolean" || !Array.isArray(p.queue) || p.queue.length > 100 || p.queue.some(id => typeof id !== "string" || !id || id.length > 128) || new Set(p.queue).size !== p.queue.length) throw new ProviderError("Invalid proxy settings or failover queue");
  for (const [key, min, max] of [["port", 0, 65535], ["maxRetries", 0, 10], ["firstByteTimeout", 1, 600], ["idleTimeout", 1, 3600], ["requestTimeout", 1, 3600], ["failureThreshold", 1, 100], ["successThreshold", 1, 100], ["timeoutSeconds", 1, 3600], ["minRequests", 1, 1000]] as const) {
    if (!Number.isSafeInteger(p[key]) || p[key] < min || p[key] > max) throw new ProviderError(`Invalid proxy ${key}`);
  }
  if (typeof p.errorRateThreshold !== "number" || !(p.errorRateThreshold > 0 && p.errorRateThreshold <= 1)) throw new ProviderError("Invalid circuit error rate");
  return p;
}
export type ProxyRoute = { id: string; name: string; url: string; format: UpstreamFormat; model: string; headers: Record<string, string>; fullUrl: boolean; query: Record<string, string>; options: Obj };
export function proxyRoute(profile: ProviderProfile): ProxyRoute {
  validateCodexRouting(profile.config);
  if (profile.kind !== "codex" || profile.authBinding || codexOfficial(profile.config)) throw new ProviderError("Official Codex accounts cannot join the proxy failover queue");
  const doc = parse(text(profile.config.config));
  const provider = object(object(doc.model_providers)[text(doc.model_provider)]);
  if (provider.auth || provider.aws) throw new ProviderError("This authentication method requires native Codex routing");
  const url = providerUrl(text(provider.base_url));
  const headers = new Headers(object(provider.http_headers) as Record<string, string>);
  for (const [name, key] of Object.entries(object(provider.env_http_headers))) {
    if (!process.env[text(key)]) throw new ProviderError(`Missing header environment variable: ${text(key)}`);
    headers.set(name, process.env[text(key)]!);
  }
  const token = provider.env_key ? process.env[text(provider.env_key)] : codexToken(profile.config);
  if (provider.env_key && !token) throw new ProviderError(`Missing credential environment variable: ${text(provider.env_key)}`);
  const format = upstreamFormat(profile.config);
  if (token && !headers.has("authorization") && !headers.has("x-api-key")) headers.set(format === "anthropic" ? "x-api-key" : "authorization", format === "anthropic" ? token : `Bearer ${token}`);
  if (format === "anthropic" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  for (const [key, value] of Object.entries(object(object(profile.config.requestOverrides).headers))) headers.set(key, String(value));
  for (const name of ["host", "content-length", "connection", "transfer-encoding", "cookie", "origin"]) headers.delete(name);
  headers.set("content-type", "application/json"); headers.set("accept-encoding", "identity");
  const model = text(doc.model);
  const reasoning = reasoningOptions(profile.config, profile.name, url.toString(), model);
  const models = object(profile.config.modelCatalog).models;
  const modelIds = Array.isArray(models) ? models.map(row => text(object(row).model)) : [];
  const reasoningByModel = Object.fromEntries(modelIds.map(id => [id, reasoningOptions(profile.config, profile.name, url.toString(), id)]));
  const options = { reasoning, reasoningByModel, requiresReasoningContent: /kimi|moonshot|deepseek/i.test(`${profile.name} ${url.hostname} ${model}`), supportsDeveloperRole: false, models: modelIds, promptCacheRouting: profile.config.promptCacheRouting, bodyOverrides: object(object(profile.config.requestOverrides).body), ...object(profile.config.chatOptions) };
  return { id: profile.id, name: profile.name, url: url.toString(), format, model, headers: Object.fromEntries(headers), fullUrl: (profile.config.isFullUrl ?? profile.config.fullUrl) === true, query: object(provider.query_params) as Record<string, string>, options };
}
export function upstreamUrl(route: ProxyRoute, compact = false, query?: URLSearchParams): URL {
  const url = new URL(route.url);
  const nativeCompact = compact && route.format === "responses";
  if (!route.fullUrl) {
    const suffix = route.format === "openai_chat" ? "/chat/completions" : route.format === "anthropic" ? "/messages" : "/responses";
    const base = url.pathname.replace(/\/+$/, "");
    url.pathname = (base.endsWith(suffix) ? base : `${base || "/v1"}${suffix}`) + (nativeCompact ? "/compact" : "");
  } else if (nativeCompact) url.pathname = url.pathname.replace(/\/$/, "") + "/compact";
  for (const [key, value] of query ?? []) if (!Object.hasOwn(route.query, key)) url.searchParams.append(key, value);
  for (const [key, value] of Object.entries(route.query)) url.searchParams.set(key, String(value));
  return url;
}

export type ProxyTakeover = { original: string; projected: string };
const routingKeys = ["model_provider", "model_providers", "openai_base_url", "base_url", "experimental_bearer_token"];
export function projectProxy(config: string, baseUrl: string, token: string): ProxyTakeover {
  let projected = config;
  for (const key of routingKeys) projected = setToml(projected, [key], undefined);
  projected = setToml(projected, ["model_provider"], "orbis-router");
  projected = setToml(projected, ["model_providers", "orbis-router"], { name: "Orbis Router", base_url: baseUrl, wire_api: "responses", requires_openai_auth: false, experimental_bearer_token: token, supports_websockets: false });
  return { original: config, projected };
}
export function restoreProxy(config: string, takeover: ProxyTakeover): string {
  const actual = parse(config); const expected = parse(takeover.projected); const original = parse(takeover.original);
  // Preserve external preference/MCP edits, but never silently overwrite changed routing.
  if (routingKeys.some(key => !isDeepStrictEqual(actual[key], expected[key]))) throw new ProviderError("Codex routing was edited outside Host while the proxy was active; restore the routing or resolve the conflict before switching");
  if (config === takeover.projected) return takeover.original;
  for (const key of routingKeys) config = setToml(config, [key], original[key]);
  return config;
}

export class ProviderCircuit {
  state: "closed" | "open" | "half_open" = "closed";
  failures = 0; successes = 0; total = 0; failed = 0; openedAt = 0; probing = false;
  lastError = ""; lastSuccessAt = 0; lastFailureAt = 0;
  constructor(readonly now = Date.now) {}
  allow(p: ProxyPreferences): boolean {
    if (this.state === "open" && this.now() - this.openedAt >= p.timeoutSeconds * 1000) this.state = "half_open";
    if (this.state === "open" || (this.state === "half_open" && this.probing)) return false;
    if (this.state === "half_open") this.probing = true;
    return true;
  }
  record(success: boolean, p: ProxyPreferences, error = ""): void {
    this.probing = false; this.total++;
    if (success) {
      this.failures = 0; this.successes++; this.lastSuccessAt = this.now(); this.lastError = "";
      if (this.state === "half_open" && this.successes >= p.successThreshold) { this.state = "closed"; this.total = 0; this.failed = 0; }
    } else {
      this.failed++; this.failures++; this.successes = 0; this.lastFailureAt = this.now(); this.lastError = error;
      if (this.state === "half_open" || this.failures >= p.failureThreshold || (this.total >= p.minRequests && this.failed / this.total >= p.errorRateThreshold)) { this.state = "open"; this.openedAt = this.now(); }
    }
  }
}
