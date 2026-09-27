import { parse } from "smol-toml";
import { parseDocument, stringify as yaml } from "yaml";
import type { AgentKind } from "@pi-remote/protocol";
import { ProviderError, type ProviderProfile } from "./provider-manager.js";
import { codexOfficial, codexToken } from "./provider-codex.js";
import { setToml } from "./provider-toml.js";
import { catalogSpecs } from "./provider-catalog.js";
import { upstreamFormat, validateCodexRouting } from "./provider-proxy-config.js";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const dshDefaultSelection = (rows: Obj[]): Obj => object((rows.find(row => row.id === "agent-default-model") ?? rows.find(row => row.id === "acp"))?.config);
export type ProviderFields = { baseUrl: string; apiKey: string; model: string; api: string; providerKey: string; headers?: Record<string, string>; compat?: Obj; models?: Obj[]; catalog?: Obj[]; reasoningEffort?: string; routing?: Obj };
export function providerFields(profile: ProviderProfile, allowIncomplete = false): ProviderFields {
  const config = profile.config;
  if (profile.kind === "codex") {
    const toml = parse(String(config.config ?? ""));
    const key = String(toml.model_provider ?? "openai");
    const provider = object(object(toml.model_providers)[key]);
    const routing = { isFullUrl: (config.isFullUrl ?? config.fullUrl) === true, promptCacheRouting: config.promptCacheRouting ?? "auto", codexChatReasoning: object(config.codexChatReasoning), chatOptions: object(config.chatOptions), requestOverrides: object(config.requestOverrides) };
    return { providerKey: key, baseUrl: String(provider.base_url ?? ""), apiKey: codexToken(config), model: String(toml.model ?? ""), api: ({ responses: "openai-responses", openai_chat: "openai-completions", anthropic: "anthropic-messages" })[upstreamFormat(config)], headers: object(provider.http_headers) as Record<string, string>, catalog: structuredClone(catalogSpecs(config, allowIncomplete)), reasoningEffort: String(toml.model_reasoning_effort ?? ""), routing: structuredClone(routing) };
  }
  if (profile.kind === "pi") return { providerKey: profile.id, baseUrl: String(config.baseUrl ?? ""), apiKey: String(config.apiKey ?? ""), model: String(object((config.models as unknown[] | undefined)?.[0]).id ?? ""), api: String(config.api ?? ""), headers: object(config.headers) as Record<string, string>, compat: object(config.compat), models: Array.isArray(config.models) ? structuredClone(config.models.map(object)) : [] };
  const document = parseDocument(String(config.patch ?? ""));
  if (document.errors.length || document.warnings.length) return { providerKey: "", baseUrl: "", apiKey: "", model: "", api: "openai-completions" };
  const patch: unknown = document.toJS();
  const rows = Array.isArray(patch) ? patch.map(object) : [];
  const selection = dshDefaultSelection(rows);
  const key = String(selection.provider ?? "custom");
  const route = object(object(object(rows.find(row => row.id === "llm-pi-ai")?.config).providers)[key]);
  return { providerKey: key, baseUrl: String(route.baseURL ?? ""), apiKey: String(object(config.env)[String(route.apiKeyEnv ?? "ORBIS_DSH_API_KEY")] ?? ""), model: String(selection.model ?? ""), api: String(route.api ?? "openai-completions"), ...(Array.isArray(route.models) ? { models: structuredClone(route.models.map(object)) } : {}) };
}
/** Basic form is a projection over the complete native config; advanced mode retains all fields. */
export function applyProviderFields(kind: AgentKind, previous: Obj, fields: ProviderFields, create = false, validateRequired = true): Obj {
  if (!isObject(previous) || !isObject(fields) || [fields.model, fields.providerKey, fields.baseUrl, fields.apiKey, fields.api].some(value => typeof value !== "string")) throw new ProviderError("供应商表单格式无效");
  if (fields.headers !== undefined && (!isObject(fields.headers) || !Object.values(fields.headers).every(value => typeof value === "string"))) throw new ProviderError("请求头必须是字符串映射");
  const official = kind === "codex" && codexOfficial(previous) && fields.providerKey === "openai";
  if (validateRequired && kind !== "pi" && !official && !fields.model.trim()) throw new ProviderError("请填写供应商支持的模型 ID");
  if ((validateRequired && !fields.providerKey.trim()) || fields.providerKey.length > 128 || ["__proto__", "prototype", "constructor"].includes(fields.providerKey)) throw new ProviderError("请填写有效的供应商标识");
  if (fields.baseUrl) {
    let url: URL;
    try { url = new URL(fields.baseUrl); } catch { throw new ProviderError("API 地址格式无效"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new ProviderError("API 地址须为 HTTP(S)，且不能在地址中包含密码");
  }
  const config = structuredClone(previous);
  if (kind === "codex") {
    if (!["openai-responses", "openai-completions", "anthropic-messages"].includes(fields.api)) throw new ProviderError("Codex 上游格式必须是 Responses、Chat Completions 或 Anthropic Messages");
    if (!official && (create || fields.api !== providerFields({ kind, id: "", name: "", config: previous }, !validateRequired).api)) config.apiFormat = fields.api === "openai-completions" ? "openai_chat" : fields.api === "anthropic-messages" ? "anthropic" : "responses";
    if (fields.routing !== undefined) {
      if (!isObject(fields.routing)) throw new ProviderError("路由配置必须是 JSON 对象");
      for (const key of ["isFullUrl", "promptCacheRouting", "codexChatReasoning", "chatOptions", "requestOverrides"])
        if (Object.hasOwn(fields.routing, key)) config[key] = structuredClone(fields.routing[key]);
      validateCodexRouting(config);
    }
    let toml = String(config.config ?? "");
    const initial = providerFields({ kind, id: "", name: "", config: previous }, !validateRequired);
    if (!official) {
      if (["openai", "ollama", "lmstudio", "amazon-bedrock", "amazon-bedrock-runtime"].includes(fields.providerKey)) throw new ProviderError("此内置供应商请使用原生配置；自定义供应商请使用独立标识");
      if (validateRequired && !fields.baseUrl) throw new ProviderError("请填写自定义供应商 API 地址");
      const route = ["model_providers", fields.providerKey];
      if (create || initial.providerKey !== fields.providerKey) {
        for (const [key, value] of Object.entries({ name: fields.providerKey, wire_api: "responses", requires_openai_auth: true })) toml = setToml(toml, [...route, key], value);
        toml = setToml(toml, ["model_provider"], fields.providerKey);
      }
      if (create || initial.providerKey !== fields.providerKey || fields.baseUrl !== initial.baseUrl) toml = setToml(toml, [...route, "base_url"], fields.baseUrl || undefined);
      if (fields.headers !== undefined && JSON.stringify(fields.headers) !== JSON.stringify(initial.headers)) toml = setToml(toml, [...route, "http_headers"], fields.headers);
      if (fields.apiKey !== initial.apiKey) {
        // Changing a key is explicit; an ordinary edit must not replace env/auth
        // credentials or flatten an existing native authentication payload.
        for (const key of ["auth", "env_key", "experimental_bearer_token"]) toml = setToml(toml, [...route, key], undefined);
        toml = setToml(toml, [...route, "requires_openai_auth"], true);
        config.auth = { ...object(config.auth), OPENAI_API_KEY: fields.apiKey };
      }
    }
    if (fields.model !== initial.model) toml = setToml(toml, ["model"], fields.model || undefined);
    if (fields.reasoningEffort !== undefined) {
      if (!["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(fields.reasoningEffort)) throw new ProviderError("Codex 思考档位无效");
      toml = setToml(toml, ["model_reasoning_effort"], fields.reasoningEffort || undefined);
    }
    if (fields.catalog !== undefined) {
      const models = fields.catalog.map(row => {
        const next = { ...row };
        if (next.contextWindow === "") delete next.contextWindow;
        return next;
      });
      config.modelCatalog = { ...object(config.modelCatalog), models };
      catalogSpecs(config, !validateRequired);
    }
    config.config = toml;
  } else if (kind === "pi") {
    // Explicit built-in overrides may contain only apiKey. Missing fields inherit
    // Pi defaults; inventing an API/base URL/model would change their meaning.
    for (const key of ["baseUrl", "apiKey", "api"] as const) {
      if (fields[key]) config[key] = fields[key]; else delete config[key];
    }
    if (fields.headers !== undefined) {
      if (!isObject(fields.headers) || !Object.values(fields.headers).every(value => typeof value === "string")) throw new ProviderError("请求头必须是字符串映射");
      if (Object.keys(fields.headers).length) config.headers = fields.headers; else delete config.headers;
    }
    if (fields.compat !== undefined) {
      if (!isObject(fields.compat)) throw new ProviderError("兼容参数必须是 JSON 对象");
      if (Object.keys(fields.compat).length || Object.hasOwn(previous, "compat")) config.compat = fields.compat;
    }
    const models = fields.models ?? (Array.isArray(config.models) && config.models.length ? [{ ...object(config.models[0]), id: fields.model }, ...config.models.slice(1) as Obj[]] : fields.model ? [{ id: fields.model }] : []);
    const normalized = normalizeModels("pi", models, fields, create, validateRequired);
    if (normalized.length || Object.hasOwn(previous, "models")) config.models = normalized;
  } else {
    const doc = parseDocument(String(config.patch ?? ""));
    if (doc.errors.length || doc.warnings.length) throw new ProviderError("此 YAML 含自定义标签，请在高级配置中编辑以保留标签");
    const rows = (Array.isArray(doc.toJS()) ? doc.toJS() as unknown[] : []).map(object);
    const row = (id: string): Obj => { let item = rows.find(value => value.id === id); if (!item) { item = { id }; rows.push(item); } return item; };
    const llm = row("llm-pi-ai"); const llmConfig = object(llm.config);
    const providers = object(llmConfig.providers); const route = object(providers[fields.providerKey]);
    const previousModel = String(dshDefaultSelection(rows).model ?? "");
    const models = fields.models === undefined ? (Array.isArray(route.models) ? route.models.map(object) : []) : normalizeModels("dsh", fields.models, fields, create, validateRequired);
    if (fields.models !== undefined) {
      if (validateRequired && !models.some(model => model.id === fields.model)) throw new ProviderError("默认模型必须在模型目录中，请选择或添加该模型");
    } else if (!models.some(model => model.id === fields.model)) {
      const index = models.findIndex(model => model.id === previousModel);
      if (index >= 0) models[index] = { ...models[index], id: fields.model };
      else models.push({ id: fields.model });
    }
    const envKey = typeof route.apiKeyEnv === "string" && /^[A-Z_][A-Z0-9_]*$/.test(route.apiKeyEnv) ? route.apiKeyEnv : "ORBIS_DSH_API_KEY";
    llm.config = { ...llmConfig, providers: { ...providers, [fields.providerKey]: { ...route, baseURL: fields.baseUrl, api: fields.api, apiKeyEnv: envKey, models } } };
    const selection = row("agent-default-model"); selection.config = { ...object(selection.config), provider: fields.providerKey, model: fields.model };
    const acp = rows.find(item => item.id === "acp");
    if (acp) acp.config = { ...object(acp.config), provider: fields.providerKey, model: fields.model };
    config.patch = yaml(rows); config.env = { ...object(config.env), [envKey]: fields.apiKey };
  }
  return config;
}
function normalizeModels(kind: "pi" | "dsh", models: Obj[], fields: ProviderFields, create: boolean, validateRequired: boolean): Obj[] {
  if (!Array.isArray(models) || (validateRequired && create && !models.length) || models.some(model => !isObject(model) || typeof model.id !== "string" || (validateRequired && !model.id.trim()))) throw new ProviderError("请填写有效模型 ID；新建供应商至少需要一个模型");
  const ids = models.map(model => model.id).filter(id => validateRequired || id);
  if (new Set(ids).size !== ids.length) throw new ProviderError("同一供应商的模型 ID 不能重复");
  return models.map(model => {
    const next = { ...model };
    if (validateRequired && create && !(kind === "pi" && typeof next.api === "string" && next.api.trim()) && !fields.api.trim()) throw new ProviderError("请为新建供应商选择 API 格式");
    if (validateRequired && create && !(kind === "pi" && typeof next.baseUrl === "string" && next.baseUrl.trim()) && !fields.baseUrl.trim()) throw new ProviderError("请填写新建供应商 API 地址");
    if (next.name === "") next.name = next.id;
    for (const key of ["contextWindow", "maxTokens"] as const) {
      if (next[key] === "") { delete next[key]; continue; }
      if (typeof next[key] === "string") {
        if (!/^\d+$/.test(next[key])) throw new ProviderError(`${key} 必须是正整数`);
        next[key] = Number(next[key]);
      }
      if (next[key] !== undefined && (!Number.isSafeInteger(next[key]) || (next[key] as number) <= 0)) throw new ProviderError(`${key} 必须是正整数`);
    }
    if (next.input !== undefined && (!Array.isArray(next.input) || next.input.some(value => value !== "text" && value !== "image"))) throw new ProviderError("模型输入类型只能包含 text 或 image");
    if (kind === "pi") {
      if (next.reasoning !== undefined && typeof next.reasoning !== "boolean") throw new ProviderError("reasoning 必须是布尔值");
      if (typeof next.thinkingLevelMap === "string") {
        try { next.thinkingLevelMap = next.thinkingLevelMap.trim() ? JSON.parse(next.thinkingLevelMap) as unknown : {}; }
        catch { throw new ProviderError("思考档位映射必须是 JSON 对象"); }
        if (!isObject(next.thinkingLevelMap) || Object.entries(next.thinkingLevelMap).some(([key, value]) => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(key) || (value !== null && typeof value !== "string"))) throw new ProviderError("思考档位映射的值须为字符串或 null");
      }
    } else {
      if (typeof next.reasoningEfforts === "string") {
        try { if (next.reasoningEfforts.trim()) next.reasoningEfforts = JSON.parse(next.reasoningEfforts) as unknown; else delete next.reasoningEfforts; }
        catch { throw new ProviderError("DSH 推理档位映射必须是 JSON 对象或 false"); }
      }
      if (next.reasoningEfforts !== undefined && next.reasoningEfforts !== false && (!isObject(next.reasoningEfforts) || !Object.keys(next.reasoningEfforts).length || Object.entries(next.reasoningEfforts).some(([key, value]) => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(key) || !(key === "off" && value === null) && (typeof value !== "string" || key !== "off" && !value.trim())))) throw new ProviderError("DSH 推理档位映射须为非空档位映射或 false");
    }
    return next;
  });
}
export function newProviderConfig(kind: AgentKind): Obj {
  return kind === "codex" ? { auth: { OPENAI_API_KEY: "" }, config: "model_provider = \"custom\"\nmodel = \"\"\n\n[model_providers.custom]\nname = \"custom\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n" }
    : kind === "pi" ? { baseUrl: "", apiKey: "", api: "openai-completions", models: [{ id: "" }] }
    : { patch: "[]\n", env: {} };
}
