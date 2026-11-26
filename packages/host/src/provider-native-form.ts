import type { ProviderFields } from "./provider-form.js";
import { ProviderError } from "./provider-error.js";
import type { NativeProviderKind } from "./provider-native.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
const modelInput = (image: boolean): string[] => image ? ["text", "image"] : ["text"];
// The form speaks one API vocabulary; each Agent keeps its own spelling on disk.
const apiNames: Record<NativeProviderKind, Record<string, string>> = {
  opencode: { "openai-completions": "@ai-sdk/openai-compatible", "openai-responses": "@ai-sdk/openai", "anthropic-messages": "@ai-sdk/anthropic", "google-generative-ai": "@ai-sdk/google", "bedrock-converse-stream": "@ai-sdk/amazon-bedrock" },
  openclaw: {},
  hermes: { "openai-completions": "chat_completions", "openai-responses": "codex_responses", "anthropic-messages": "anthropic_messages", "bedrock-converse-stream": "bedrock_converse" },
  kimiCode: { "openai-completions": "openai", "openai-responses": "openai_responses", "anthropic-messages": "anthropic", "google-generative-ai": "google-genai" },
};
const toApi = (kind: NativeProviderKind, value: unknown): string => Object.entries(apiNames[kind]).find(([, native]) => native === value)?.[0] ?? text(value);
const fromApi = (kind: NativeProviderKind, api: string): string => apiNames[kind][api] ?? api;

export function nativeProviderFields(kind: NativeProviderKind, id: string, config: Obj): ProviderFields {
  const base = { providerKey: id, model: "" };
  if (kind === "openclaw") {
    const models = (Array.isArray(config.models) ? config.models : []).map(object).map(row => ({ ...structuredClone(row), ...(row.input === undefined ? {} : { input: modelInput(strings(row.input).includes("image")) }) }));
    return { ...base, baseUrl: text(config.baseUrl), apiKey: text(config.apiKey), api: text(config.api), headers: plainHeaders(config.headers), models };
  }
  if (kind === "opencode") {
    const options = object(config.options);
    return { ...base, baseUrl: text(options.baseURL), apiKey: text(options.apiKey), api: toApi(kind, config.npm), headers: plainHeaders(options.headers),
      models: Object.entries(object(config.models)).map(([key, value]) => {
        const model = object(value), limit = object(model.limit);
        return { nativeKey: key, id: key, name: text(model.name) || key, reasoning: model.reasoning === true, input: modelInput(strings(object(model.modalities).input).includes("image")),
          contextWindow: limit.context ?? "", maxTokens: limit.output ?? "" };
      }) };
  }
  if (kind === "hermes") return { ...base, baseUrl: text(config.base_url), apiKey: text(config.api_key), api: toApi(kind, config.api_mode ?? "chat_completions"), headers: plainHeaders(config.extra_headers),
    models: Object.entries(object(config.models)).map(([key, value]) => { const model = object(value); return { nativeKey: key, id: key, name: key, input: modelInput((model.supports_vision ?? model.vision) === true), contextWindow: model.context_length ?? "" }; }) };
  const provider = object(config.provider);
  return { ...base, baseUrl: text(provider.base_url), apiKey: text(provider.api_key), api: toApi(kind, provider.type), headers: plainHeaders(provider.custom_headers),
    models: Object.entries(object(config.models)).map(([key, value]) => {
      const model = object(value), capabilities = strings(model.capabilities);
      return { nativeKey: key, id: text(model.model), name: text(model.display_name) || text(model.model), reasoning: capabilities.includes("thinking"), input: modelInput(capabilities.includes("image_in")), contextWindow: model.max_context_size ?? "" };
    }) };
}
function plainHeaders(value: unknown): Record<string, string> {
  // A secret reference is an object: leave such headers to the native editor instead of flattening them.
  return Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function put(target: Obj, key: string, value: unknown, previous: unknown): void {
  if (value === previous) return;
  if (value === "" || value === undefined) delete target[key]; else target[key] = value;
}
function putHeaders(target: Obj, key: string, next: Record<string, string> | undefined, previous: Record<string, string> | undefined): void {
  if (next === undefined || JSON.stringify(next) === JSON.stringify(previous)) return;
  const kept = Object.fromEntries(Object.entries(object(target[key])).filter(([, value]) => typeof value !== "string"));
  const merged = { ...kept, ...next };
  if (Object.keys(merged).length) target[key] = merged; else delete target[key];
}
function toggle(values: string[], name: string, enabled: boolean): string[] {
  return enabled ? values.includes(name) ? values : [...values, name] : values.filter(value => value !== name);
}

/** Project the shared form onto a complete native node; fields outside the form stay as they are. */
export function applyNativeProviderFields(kind: NativeProviderKind, id: string, config: Obj, fields: ProviderFields, rows: Obj[], create = false): Obj {
  const initial = nativeProviderFields(kind, id, config), next = structuredClone(config);
  const headerKey = kind === "hermes" ? "extra_headers" : kind === "kimiCode" ? "custom_headers" : "headers";
  const target = kind === "opencode" ? object(next.options) : kind === "kimiCode" ? object(next.provider) : next;
  const names = kind === "opencode" ? ["baseURL", "apiKey"] : kind === "openclaw" ? ["baseUrl", "apiKey"] : ["base_url", "api_key"];
  put(target, names[0]!, fields.baseUrl, initial.baseUrl); put(target, names[1]!, fields.apiKey, initial.apiKey);
  putHeaders(target, headerKey, fields.headers, initial.headers);
  if (kind === "opencode") { if (Object.keys(target).length) next.options = target; put(next, "npm", fromApi(kind, fields.api), fromApi(kind, initial.api)); }
  else if (kind === "kimiCode") { next.provider = target; put(target, "type", fromApi(kind, fields.api), fromApi(kind, initial.api)); }
  else put(next, kind === "openclaw" ? "api" : "api_mode", fromApi(kind, fields.api), fromApi(kind, initial.api));
  if (fields.models === undefined) return next;

  const before = new Map((initial.models ?? []).map(row => [row.nativeKey, row]));
  if (kind === "openclaw") {
    if (!rows.length && next.models === undefined) return next;
    const previous = (Array.isArray(config.models) ? config.models : []).map(object);
    next.models = rows.map(row => {
      const original = previous.find(model => model.id === row.id), image = strings(row.input).includes("image");
      // Untouched modalities (audio, video) are outside the form and must survive.
      const input = original && strings(original.input).includes("image") === image ? original.input : row.input;
      const model: Obj = { ...row, name: text(row.name) || row.id, ...(input === undefined ? {} : { input }) };
      if (input === undefined) delete model.input;
      delete model.nativeKey; delete model.thinkingLevelMap;
      return model;
    });
    return next;
  }
  const source = object(config.models), models: Obj = {};
  for (const row of rows) {
    const rowId = String(row.id), key = kind !== "kimiCode" ? rowId : (!create && text(row.nativeKey)) || uniqueKey(models, create ? {} : source, `${id}/${rowId}`);
    const model = structuredClone(object(source[text(row.nativeKey)])), was = before.get(row.nativeKey);
    const image = strings(row.input).includes("image"), hadImage = strings(was?.input).includes("image");
    const name = text(row.name) === rowId ? "" : text(row.name), hadName = was && text(was.name) !== text(was.id) ? text(was.name) : "";
    if (kind === "opencode") {
      if (name !== hadName) put(model, "name", name || rowId, undefined);
      if ((row.reasoning === true) !== (was?.reasoning === true)) model.reasoning = row.reasoning === true;
      if (image !== hadImage) { const modalities = object(model.modalities); model.modalities = { ...modalities, input: toggle(strings(modalities.input).length ? strings(modalities.input) : ["text"], "image", image), output: strings(modalities.output).length ? modalities.output : ["text"] }; }
      if (row.contextWindow !== (was?.contextWindow || undefined) || row.maxTokens !== (was?.maxTokens || undefined)) {
        if (row.contextWindow === undefined && row.maxTokens === undefined) delete model.limit;
        else if (row.contextWindow === undefined || row.maxTokens === undefined) throw new ProviderError("OpenCode 模型的上下文与最大输出需要同时填写");
        else model.limit = { ...object(model.limit), context: row.contextWindow, output: row.maxTokens };
      }
    } else if (kind === "hermes") {
      put(model, "context_length", row.contextWindow, was?.contextWindow || undefined);
      if (image !== hadImage) { delete model.vision; model.supports_vision = image; }
    } else {
      model.model = rowId;
      if (name !== hadName) put(model, "display_name", name, undefined);
      put(model, "max_context_size", row.contextWindow, was?.contextWindow || undefined);
      const capabilities = was ? strings(model.capabilities) : ["tool_use"], reasoning = row.reasoning === true;
      const changed = toggle(toggle(capabilities, "image_in", image), "thinking", reasoning);
      const result = reasoning ? changed : changed.filter(value => value !== "always_thinking" || was?.reasoning !== true);
      if (!was || JSON.stringify(result) !== JSON.stringify(strings(model.capabilities))) model.capabilities = result;
      model.provider = id;
    }
    Object.defineProperty(models, key, { value: model, enumerable: true, configurable: true, writable: true });
  }
  if (rows.length || next.models !== undefined) next.models = models;
  return next;
}
function uniqueKey(models: Obj, source: Obj, key: string): string {
  let result = key;
  for (let n = 2; Object.hasOwn(models, result) || Object.hasOwn(source, result); n++) result = `${key}-${n}`;
  return result;
}
export function newNativeProviderConfig(kind: NativeProviderKind): Obj {
  if (kind === "opencode") return { npm: "@ai-sdk/openai-compatible", options: { baseURL: "", apiKey: "", setCacheKey: true }, models: {} };
  if (kind === "openclaw") return { baseUrl: "", apiKey: "", api: "openai-completions", models: [] };
  if (kind === "hermes") return { base_url: "", api_key: "", api_mode: "chat_completions", models: {} };
  return { provider: { type: "openai", base_url: "", api_key: "" }, models: {} };
}
