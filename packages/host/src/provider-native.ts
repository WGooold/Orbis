import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { Document, isMap, isScalar, isSeq, parseDocument, type Node as YamlNode, type Pair } from "yaml";
import { parseJson5, setJson5 } from "./json5-document.js";
import { ProviderError } from "./provider-error.js";
import { hermesBuiltinProviderIds } from "./provider-native-presets.js";
import { setToml } from "./provider-toml.js";

/**
 * PROVIDER-NATIVE-01: Agents whose own configuration holds many providers at once. Field ownership, default-model
 * rules and removal guards follow CC Switch (MIT); each write edits only its nodes and keeps the rest of the file.
 */
export const nativeProviderKinds = ["opencode", "openclaw", "hermes", "kimiCode"] as const;
export type NativeProviderKind = (typeof nativeProviderKinds)[number];
export const isNativeProviderKind = (kind: unknown): kind is NativeProviderKind => nativeProviderKinds.includes(kind as NativeProviderKind);

type Obj = Record<string, unknown>;
export type NativeLive = {
  providers: Record<string, Obj>;
  /** Managed by the Agent itself: listed and selectable, never rewritten here. */
  readOnly: string[];
  /** OpenCode V2 (`providers`) declarations, which take precedence over V1 (`provider`). */
  v2: string[];
  defaultId: string;
};
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const asObject = (value: unknown): Obj => object(value) ? value : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const define = (target: Obj, key: string, value: unknown): void => { Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true }); };
const own = (target: unknown, key: string): unknown => object(target) && Object.hasOwn(target, key) ? target[key] : undefined;
const labels: Record<NativeProviderKind, string> = { opencode: "OpenCode 配置", openclaw: "OpenClaw openclaw.json", hermes: "Hermes config.yaml", kimiCode: "Kimi Code config.toml" };

export function nativeProviderRoot(kind: NativeProviderKind, env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  if (kind === "opencode") return env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  if (kind === "openclaw") return env.OPENCLAW_CONFIG_PATH || env.OPENCLAW_STATE_DIR || join(home, ".openclaw");
  if (kind === "hermes") return env.HERMES_HOME?.trim() || (process.platform === "win32" && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "hermes") : join(home, ".hermes"));
  return env.KIMI_CODE_HOME || join(home, ".kimi-code");
}
export function nativeProviderFile(kind: NativeProviderKind, root: string): string {
  if (kind === "opencode") return join(root, existsSync(join(root, "opencode.jsonc")) ? "opencode.jsonc" : "opencode.json");
  if (kind === "openclaw") return root.endsWith(".json") ? root : join(root, "openclaw.json");
  return join(root, kind === "hermes" ? "config.yaml" : "config.toml");
}

function guarded<T>(kind: NativeProviderKind, work: () => T): T {
  try { return work(); }
  catch (error) {
    if (error instanceof ProviderError) throw error;
    // Never include source text or credentials in errors.
    throw new ProviderError(`${labels[kind]}格式无法识别，未修改；请先修正该文件`);
  }
}
function section(root: Obj, key: string, kind: NativeProviderKind): Obj {
  const value = own(root, key);
  if (value === undefined || value === null) return {};
  if (!object(value)) throw new ProviderError(`${labels[kind]} 的 ${key} 必须是对象`);
  return value;
}
function json5(source: string | null): Obj {
  if (source === null || !source.trim()) return {};
  const value = parseJson5(source);
  if (!object(value)) throw new SyntaxError("root");
  return value;
}

// ---- Hermes YAML -------------------------------------------------------------------------------------------------
// Hermes reads with PyYAML (YAML 1.1): a 1.2 writer would leave `yes` or `12:30` unquoted.
function yamlDocument(source: string | null): Document.Parsed {
  const doc = parseDocument(source ?? "", { version: "1.1" });
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents) && !(isScalar(doc.contents) && doc.contents.value === null))) throw new SyntaxError("yaml");
  return doc;
}
function yamlRoot(source: string | null): Obj { return asObject(yamlDocument(source).toJS()); }
/** Replace one top-level section in place; comments and layout outside it stay byte-identical. */
function setYamlSection(source: string, key: string, edit: (doc: Document, current: YamlNode | undefined) => YamlNode): string {
  const doc = yamlDocument(source);
  const pair = isMap(doc.contents) ? (doc.contents.items as Pair<YamlNode, YamlNode | null>[]).find(item => isScalar(item.key) && item.key.value === key) : undefined;
  const value = edit(doc, pair?.value ?? undefined);
  const expected = { ...asObject(yamlRoot(source)), [key]: value.toJS(doc) as unknown };
  const mini = new Document({}, { version: "1.1" });
  (mini.contents as unknown as { items: unknown[] }).items.push(mini.createPair(key, value));
  const compact = !/^[\w-]+:[ \t]*(?:#.*)?\r?\n[ \t]+- /mu.test(source) && /^[\w-]+:[ \t]*(?:#.*)?\r?\n- /mu.test(source);
  let body = mini.toString({ lineWidth: 0, indentSeq: !compact }).trimEnd();
  if (source.includes("\r\n")) body = body.replace(/\r?\n/gu, "\r\n");
  let result: string;
  if (pair) {
    const start = pair.key.range![0], end = pair.value?.range?.[1] ?? source.indexOf(":", pair.key.range![1]) + 1;
    result = source.slice(0, start) + body + source.slice(source[end - 1] === "\n" ? end - 1 : end);
  } else result = `${source}${source && !source.endsWith("\n") ? "\n" : ""}${body}\n`;
  if (!isDeepStrictEqual(yamlRoot(result), expected)) throw new SyntaxError("yaml edit mismatch");
  return result;
}
const setYamlValue = (source: string, key: string, value: unknown): string => setYamlSection(source, key, doc => doc.createNode(value) as YamlNode);

/** Hermes stores a models mapping; older writers left a list. */
function hermesModels(value: unknown): Obj {
  if (!Array.isArray(value)) return asObject(value);
  const result: Obj = {};
  for (const row of value) { const id = text(asObject(row).id); if (id) { const rest = { ...row as Obj }; delete rest.id; define(result, id, rest); } }
  return result;
}
function hermesConfig(entry: Obj): Obj {
  const config = structuredClone(entry);
  delete config.name; delete config.model;
  if (Object.hasOwn(config, "models")) config.models = hermesModels(config.models);
  return config;
}
function readHermes(source: string | null): NativeLive {
  const root = yamlRoot(source), providers: Record<string, Obj> = {}, readOnly: string[] = [];
  const list = root.custom_providers;
  if (list !== undefined && list !== null && !Array.isArray(list)) throw new ProviderError("Hermes custom_providers 必须是列表");
  for (const entry of list as unknown[] ?? []) { const name = text(asObject(entry).name); if (name) define(providers, name, hermesConfig(entry as Obj)); }
  for (const [key, entry] of Object.entries(asObject(root.providers))) {
    if (!object(entry)) continue;
    const name = text(entry.name) || key.trim();
    // The list wins over the overlay mapping on duplicate names, as it does in Hermes.
    if (!name || Object.hasOwn(providers, name)) continue;
    define(providers, name, hermesConfig(entry)); readOnly.push(name);
  }
  return { providers, readOnly, v2: [], defaultId: object(root.model) ? text(root.model.provider) : "" };
}
/** Keep `auxiliary.title_generation.model` on the active card's declared model; never touch a user's own choice. */
function syncHermesTitle(source: string, wanted: string, released: string): string {
  const live = readHermes(source), root = yamlRoot(source);
  const auxiliary = asObject(root.auxiliary), title = { ...asObject(auxiliary.title_generation) };
  if ((text(title.provider) && text(title.provider) !== "auto") || text(title.base_url)) return source;
  const current = text(title.model);
  const owned = current === released || Object.values(live.providers).some(config => text(config.title_generation_model) === current);
  if (current === wanted || (current && !owned)) return source;
  if (wanted) title.model = wanted; else delete title.model;
  const next = { ...auxiliary };
  if (Object.keys(title).length) next.title_generation = title; else delete next.title_generation;
  return setYamlValue(source, "auxiliary", next);
}
function writeHermes(source: string, id: string, config: Obj | undefined): string {
  const before = readHermes(source);
  if (before.readOnly.includes(id)) throw new ProviderError("此供应商由 Hermes 的 providers 管理，请在 Hermes 中修改");
  if (!config && !Object.hasOwn(before.providers, id)) return source;
  let result = setYamlSection(source, "custom_providers", (doc, current) => {
    const list = isSeq(current) ? current : doc.createNode([]);
    const index = list.items.findIndex(item => isMap(item) && item.get("name") === id);
    if (!config) { list.items.splice(index, 1); return list as YamlNode; }
    const first = firstNativeModel("hermes", config);
    const entry: Obj = { name: id, ...hermesConfig(config), ...(first ? { model: first } : {}) };
    const existing = list.items[index];
    if (isMap(existing)) {
      const value = existing.toJS(doc) as Obj;
      for (const key of Object.keys(value)) if (!Object.hasOwn(entry, key)) existing.delete(key);
      for (const [key, item] of Object.entries(entry)) if (!isDeepStrictEqual(value[key], item)) existing.set(key, doc.createNode(item));
    } else list.items.push(doc.createNode(entry) as never);
    list.flow = false;
    return list as YamlNode;
  });
  if (!config) result = syncHermesTitle(result, text(asObject(readHermes(result).providers[before.defaultId]).title_generation_model), text(before.providers[id]!.title_generation_model));
  return result;
}

// ---- Kimi Code TOML ----------------------------------------------------------------------------------------------
const kimiTypes = ["kimi", "openai", "openai_responses", "anthropic", "google-genai", "vertexai"];
export function kimiOfficial(config: Obj): boolean {
  const provider = asObject(config.provider);
  return provider.type === "kimi" && !!text(asObject(provider.oauth).key);
}
function kimiRoot(source: string | null): Obj {
  const root = parseToml(source ?? "") as Obj;
  section(root, "providers", "kimiCode"); section(root, "models", "kimiCode");
  return root;
}
function readKimi(source: string | null): NativeLive {
  const root = kimiRoot(source), models = asObject(root.models), providers: Record<string, Obj> = {};
  for (const [id, provider] of Object.entries(asObject(root.providers))) if (object(provider)) {
    const owned: Obj = {};
    for (const [key, model] of Object.entries(models)) if (asObject(model).provider === id) define(owned, key, model);
    define(providers, id, structuredClone({ provider, models: owned }));
  }
  const id = text(asObject(own(models, text(root.default_model))).provider);
  return { providers, readOnly: [], v2: [], defaultId: Object.hasOwn(providers, id) ? id : "" };
}
function validateKimi(id: string, config: Obj): void {
  const provider = asObject(config.provider);
  if (!kimiTypes.includes(String(provider.type))) throw new ProviderError("请选择 Kimi Code 支持的供应商类型");
  if (provider.base_url !== undefined) {
    const url = typeof provider.base_url === "string" ? URL.parse(provider.base_url) : null;
    if (!url || !["http:", "https:"].includes(url.protocol)) throw new ProviderError("请填写有效的 Kimi Code API 地址");
  }
  const env = asObject(provider.env), keyEnv = text(provider.api_key_env), oauth = text(asObject(provider.oauth).key);
  if (!text(provider.api_key) && !oauth && !keyEnv
    && !["KIMI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "VERTEXAI_API_KEY"].some(key => text(env[key]))) throw new ProviderError("请填写 API Key，或保留已有的 Kimi 登录");
  if (provider.api_key_env !== undefined && (provider.oauth !== undefined || text(provider.api_key))) throw new ProviderError("api_key_env 不能与 API Key 或 Kimi 登录同时使用");
  const models = Object.entries(asObject(config.models));
  if (!models.length) throw new ProviderError("请至少添加一个 Kimi Code 模型");
  for (const [key, model] of models) {
    const row = asObject(model);
    if (!key.trim() || !text(row.model)) throw new ProviderError("Kimi Code 模型需要模型 ID");
    if (!Number.isSafeInteger(row.max_context_size) || (row.max_context_size as number) <= 0) throw new ProviderError("请填写每个 Kimi Code 模型的上下文长度");
    if (row.provider !== undefined && row.provider !== id) throw new ProviderError("Kimi Code 模型属于其他供应商");
  }
}
function writeKimi(source: string, id: string, config: Obj | undefined): string {
  const root = kimiRoot(source), models = asObject(root.models), existing = own(root.providers, id);
  if (!config && existing === undefined) return source;
  const official = object(existing) && kimiOfficial({ provider: existing });
  // Signing in owns an official node's endpoint and login reference; editing it may only change models.
  const next = config && official ? { ...config, provider: existing } : config;
  if (next) validateKimi(id, next);
  const nextModels = next ? Object.fromEntries(Object.entries(asObject(next.models)).map(([key, model]) => [key, { ...asObject(model), provider: id }])) : {};
  const removed = (key: string): boolean => asObject(own(models, key)).provider === id && !Object.hasOwn(nextModels, key);
  if (removed(text(root.default_model))) throw new ProviderError("请先将其他供应商设为默认，再移除此供应商或其当前模型");
  const secondary = asObject(root.secondary_model);
  if (removed(text(secondary.default_model)) || Object.keys(asObject(secondary.models)).some(removed)) throw new ProviderError("此模型仍被 Kimi Code 的 secondary_model 使用，请先在 Kimi Code 中更换");
  for (const key of Object.keys(nextModels)) { const owner = asObject(own(models, key)).provider; if (owner !== undefined && owner !== id) throw new ProviderError(`Kimi Code 模型键 ${key} 已属于其他供应商`); }
  let result = source;
  for (const key of Object.keys(models)) if (asObject(models[key]).provider === id && !Object.hasOwn(nextModels, key)) result = setToml(result, ["models", key], undefined);
  const write = (path: string[], value: Obj): void => {
    if (isDeepStrictEqual(own(asObject(root[path[0]!]), path[1]!), value)) return;
    result = setToml(setToml(result, path, undefined), path, value);
  };
  if (next) {
    write(["providers", id], structuredClone(asObject(next.provider)));
    for (const [key, model] of Object.entries(nextModels)) write(["models", key], model);
    if (!text(root.default_model)) result = setToml(result, ["default_model"], Object.keys(nextModels)[0]);
  } else {
    result = setToml(result, ["providers", id], undefined);
    // Search and fetch services must not keep pointing at a removed account.
    const login = text(asObject(asObject(existing).oauth).key), fallback = asObject(own(root.providers, "managed:kimi-code")).oauth;
    if (official && id !== "managed:kimi-code" && object(fallback)) for (const [name, service] of Object.entries(asObject(root.services)))
      if (text(asObject(asObject(service).oauth).key) === login) write(["services", name], { ...asObject(service), oauth: fallback });
  }
  return result;
}

// ---- OpenCode / OpenClaw -----------------------------------------------------------------------------------------
type Check = (value: unknown) => boolean;
const isString: Check = value => typeof value === "string", isBoolean: Check = value => typeof value === "boolean", isFinite: Check = value => typeof value === "number" && Number.isFinite(value);
const strings: Check = value => Array.isArray(value) && value.every(isString), integer: Check = value => Number.isSafeInteger(value);
const headers: Check = value => object(value) && Object.values(value).every(isString);
const fields = (checks: Record<string, Check>): Check => value => object(value) && Object.entries(checks).every(([key, check]) => value[key] === undefined || check(value[key]));
const compaction: Check = value => object(value) && (value.type === "summary" || value.type === "native");
const overlays = { settings: fields({ compaction }), headers, body: object as Check };
const cost: Check = value => object(value) && isFinite(value.input) && isFinite(value.output) && fields({ cache: fields({ read: isFinite, write: isFinite }), tier: tier => object(tier) && tier.type === "context" && integer(tier.size) })(value);
const v2Model = fields({ modelID: isString, family: isString, name: isString, package: isString, disabled: isBoolean, ...overlays,
  compatibility: fields({ reasoningField: isString, requireReasoning: isBoolean, maxTokensField: value => value === "max_completion_tokens" || value === "max_tokens", requireFinishReason: isBoolean, requireAssistantAfterTool: isBoolean, supportsPromptCacheKey: isBoolean }),
  capabilities: value => object(value) && isBoolean(value.tools) && strings(value.input) && strings(value.output),
  variants: value => Array.isArray(value) && value.every(row => object(row) && isString(row.id) && fields(overlays)(row)),
  cost: value => Array.isArray(value) ? value.every(cost) : cost(value), limit: fields({ context: integer, input: integer, output: integer }) });
/** OpenCode ignores a native declaration that does not match its schema; such an entry must not shadow the V1 one. */
const v2Provider = fields({ name: isString, package: isString, canonical: isString, env: strings, headers, body: object as Check,
  settings: fields({ timeout: value => value === false || isFinite(value), chunkTimeout: isFinite, compaction, transport: value => value === "http" || value === "websocket" }),
  models: value => object(value) && Object.values(value).every(v2Model) });
const v2Keys = ["package", "settings", "headers", "body", "canonical"], v1Keys = ["npm", "options", "api"];
export function openCodeV2(config: Obj, saved = false): boolean {
  return saved || (!v1Keys.some(key => Object.hasOwn(config, key)) && v2Keys.some(key => Object.hasOwn(config, key)));
}
function readOpenCode(source: string | null): NativeLive {
  const root = json5(source), providers: Record<string, Obj> = {}, v2: string[] = [];
  for (const [id, value] of Object.entries(section(root, "provider", "opencode"))) if (object(value)) define(providers, id, value);
  for (const [id, value] of Object.entries(section(root, "providers", "opencode"))) if (v2Provider(value)) { define(providers, id, value); v2.push(id); }
  const model = text(root.model);
  return { providers, readOnly: [], v2, defaultId: model.includes("/") ? model.slice(0, model.indexOf("/")) : "" };
}
function writeOpenCode(source: string, id: string, config: Obj | undefined, savedV2: boolean): string {
  const live = readOpenCode(source), base = source.trim() ? source : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  if (!config) {
    const legacy = own(section(json5(source), "provider", "opencode"), id) !== undefined;
    let result = legacy ? setJson5(base, ["provider", id], undefined) : base;
    // A valid native entry shadowed the legacy one: remove both so the older one cannot resurface.
    if (live.v2.includes(id) || (!legacy && own(section(json5(source), "providers", "opencode"), id) !== undefined)) result = setJson5(result, ["providers", id], undefined);
    return result;
  }
  if (openCodeV2(config, savedV2)) {
    if (!v2Provider(config)) throw new ProviderError("OpenCode 原生供应商字段不符合 V2 配置格式");
    return setJson5(base, ["providers", id], config);
  }
  if (live.v2.includes(id)) throw new ProviderError("OpenCode 配置中已有同名的原生 V2 供应商，请刷新列表后再编辑");
  if ((!text(config.npm) || !Object.keys(asObject(config.models)).length) && !Object.hasOwn(live.providers, id)) throw new ProviderError("新的 OpenCode 供应商需要 npm 包和至少一个模型");
  return setJson5(base, ["provider", id], config);
}
function readOpenClaw(source: string | null): NativeLive {
  const root = json5(source), providers: Record<string, Obj> = {};
  for (const [id, value] of Object.entries(section(section(root, "models", "openclaw"), "providers", "openclaw"))) if (object(value)) define(providers, id, value);
  const model = asObject(asObject(root.agents).defaults).model, primary = text(object(model) ? model.primary : model);
  return { providers, readOnly: [], v2: [], defaultId: primary.includes("/") ? primary.slice(0, primary.indexOf("/")) : "" };
}

// ---- Shared entry points -----------------------------------------------------------------------------------------
export function readNativeProviders(kind: NativeProviderKind, source: string | null): NativeLive {
  return guarded(kind, () => kind === "opencode" ? readOpenCode(source) : kind === "openclaw" ? readOpenClaw(source) : kind === "hermes" ? readHermes(source) : readKimi(source));
}
export function validateNativeProvider(kind: NativeProviderKind, config: Obj): void {
  if (kind === "kimiCode") {
    if (!object(config.provider) || !object(config.models)) throw new ProviderError("Kimi Code 配置需要 provider 与 models 对象");
  } else if (kind === "openclaw") {
    if (!["baseUrl", "api", "models"].some(key => Object.hasOwn(config, key))) throw new ProviderError("OpenClaw 供应商需要 baseUrl、api 或 models");
    if (config.models !== undefined && (!Array.isArray(config.models) || config.models.some(model => !text(asObject(model).id)))) throw new ProviderError("OpenClaw models 必须是包含模型 id 的数组");
  } else if (config.models !== undefined && !object(config.models) && !(kind === "hermes" && Array.isArray(config.models))) throw new ProviderError("models 必须是以模型 ID 为键的对象");
}
/** Write (or, with `undefined`, remove) one provider node. */
export function writeNativeProvider(kind: NativeProviderKind, source: string | null, id: string, config: Obj | undefined, savedV2 = false): string {
  return guarded(kind, () => {
    const current = source ?? "";
    if (kind === "opencode") return writeOpenCode(current, id, config, savedV2);
    if (kind === "openclaw") return current.trim() ? setJson5(current, ["models", "providers", id], config) : config ? `${JSON.stringify({ models: { mode: "merge", providers: { [id]: config } } }, null, 2)}\n` : current;
    if (kind === "kimiCode") return writeKimi(current, id, config);
    if (config && hermesBuiltinProviderIds.has(id)) throw new ProviderError("此标识是 Hermes 内置供应商，同名自定义配置会被忽略，请换一个标识");
    return writeHermes(current, id, config);
  });
}
export function firstNativeModel(kind: NativeProviderKind, config: Obj): string {
  return kind === "openclaw" ? text(asObject((config.models as unknown[] | undefined)?.[0]).id) : Object.keys(kind === "hermes" ? hermesModels(config.models) : asObject(config.models))[0] ?? "";
}
/** Make a provider already present in the file the one the Agent uses by default. */
export function selectNativeProvider(kind: NativeProviderKind, source: string | null, id: string): string {
  return guarded(kind, () => {
    const current = source ?? "", config = own(readNativeProviders(kind, source).providers, id);
    if (!object(config)) throw new ProviderError("请先启用此供应商");
    const model = firstNativeModel(kind, config);
    if (kind === "hermes") {
      const previous = yamlRoot(current).model;
      const next: Obj = object(previous) ? { ...previous } : typeof previous === "string" && previous ? { default: previous } : {};
      if (model) next.default = model;
      next.provider = id;
      return syncHermesTitle(setYamlSection(current, "model", (doc, node) => {
        if (!isMap(node)) return doc.createNode(next) as YamlNode;
        for (const [key, value] of Object.entries(next)) if (node.get(key) !== value) node.set(key, value);
        return node as YamlNode;
      }), text(config.title_generation_model), "");
    }
    if (!model) throw new ProviderError("该供应商没有配置模型");
    if (kind === "kimiCode") {
      const root = kimiRoot(current), selected = text(root.default_model);
      return asObject(own(root.models, selected)).provider === id ? current : setToml(current, ["default_model"], model);
    }
    const primary = `${id}/${model}`;
    if (kind === "opencode") return setJson5(current, ["model"], primary);
    const defaults = asObject(asObject(json5(current).agents).defaults), previous = defaults.model;
    const value = object(previous) ? { ...previous, primary, ...(Array.isArray(previous.fallbacks) ? { fallbacks: previous.fallbacks.filter(item => item !== primary) } : {}) } : typeof previous === "string" ? primary : { primary };
    const result = setJson5(current, ["agents", "defaults", "model"], value);
    // A non-empty catalog is an allowlist: a default outside it would be rejected by OpenClaw.
    return object(defaults.models) && Object.keys(defaults.models).length && !Object.hasOwn(defaults.models, primary) ? setJson5(result, ["agents", "defaults", "models", primary], {}) : result;
  });
}
