import { parse, stringify } from "smol-toml";
import { parseDocument, stringify as yaml } from "yaml";
import type { AgentKind } from "@pi-remote/protocol";
import { ProviderError, type ProviderProfile } from "./provider-manager.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
export type ProviderFields = { baseUrl: string; apiKey: string; model: string; api: string; providerKey: string };
export function providerFields(profile: ProviderProfile): ProviderFields {
  const config = profile.config;
  if (profile.kind === "codex") {
    const toml = parse(String(config.config ?? ""));
    const key = String(toml.model_provider ?? "openai");
    const provider = object(object(toml.model_providers)[key]);
    return { providerKey: key, baseUrl: String(provider.base_url ?? ""), apiKey: String(object(config.auth).OPENAI_API_KEY ?? ""), model: String(toml.model ?? ""), api: "openai-responses" };
  }
  if (profile.kind === "pi") return { providerKey: profile.id, baseUrl: String(config.baseUrl ?? ""), apiKey: String(config.apiKey ?? ""), model: String(object((config.models as unknown[] | undefined)?.[0]).id ?? ""), api: String(config.api ?? "openai-completions") };
  const document = parseDocument(String(config.patch ?? ""));
  if (document.errors.length || document.warnings.length) return { providerKey: "", baseUrl: "", apiKey: "", model: "", api: "openai-completions" };
  const patch: unknown = document.toJS();
  const rows = Array.isArray(patch) ? patch.map(object) : [];
  const acp = object(rows.find(row => row.id === "acp")?.config);
  const key = String(acp.provider ?? "custom");
  const route = object(object(object(rows.find(row => row.id === "llm-pi-ai")?.config).providers)[key]);
  return { providerKey: key, baseUrl: String(route.baseURL ?? ""), apiKey: String(object(config.env)[String(route.apiKeyEnv ?? "ORBIS_DSH_API_KEY")] ?? ""), model: String(acp.model ?? ""), api: String(route.api ?? "openai-completions") };
}
/** Basic form is a projection over the complete native config; advanced mode retains all fields. */
export function applyProviderFields(kind: AgentKind, previous: Obj, fields: ProviderFields): Obj {
  if (!fields.model.trim()) throw new ProviderError("请填写供应商支持的模型 ID");
  if (!fields.providerKey.trim() || fields.providerKey.length > 128 || ["__proto__", "prototype", "constructor"].includes(fields.providerKey)) throw new ProviderError("请填写有效的供应商标识");
  if (fields.baseUrl) {
    let url: URL;
    try { url = new URL(fields.baseUrl); } catch { throw new ProviderError("API 地址格式无效"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new ProviderError("API 地址须为 HTTP(S)，且不能在地址中包含密码");
  }
  const config = structuredClone(previous);
  if (kind === "codex") {
    if (["openai", "ollama", "lmstudio"].includes(fields.providerKey)) throw new ProviderError("内置供应商请使用原生账号或高级配置；自定义供应商请使用独立标识");
    if (!fields.baseUrl) throw new ProviderError("请填写自定义供应商 API 地址");
    const toml = parse(String(config.config ?? "")) as Obj;
    const providers = object(toml.model_providers);
    const route = { ...object(providers[fields.providerKey]), name: fields.providerKey, base_url: fields.baseUrl, wire_api: "responses", requires_openai_auth: true } as Obj;
    for (const key of ["auth", "env_key", "experimental_bearer_token"]) delete route[key];
    toml.model_provider = fields.providerKey; toml.model = fields.model;
    toml.cli_auth_credentials_store = "file";
    toml.model_providers = { ...providers, [fields.providerKey]: route };
    config.config = stringify(toml as Parameters<typeof stringify>[0]);
    config.auth = { OPENAI_API_KEY: fields.apiKey };
  } else if (kind === "pi") {
    config.baseUrl = fields.baseUrl; config.apiKey = fields.apiKey; config.api = fields.api;
    const models = Array.isArray(config.models) ? config.models : [];
    config.models = [{ ...object(models[0]), id: fields.model }, ...models.slice(1)];
  } else {
    const doc = parseDocument(String(config.patch ?? ""));
    if (doc.errors.length || doc.warnings.length) throw new ProviderError("此 YAML 含自定义标签，请在高级配置中编辑以保留标签");
    const rows = (Array.isArray(doc.toJS()) ? doc.toJS() as unknown[] : []).map(object);
    const row = (id: string): Obj => { let item = rows.find(value => value.id === id); if (!item) { item = { id }; rows.push(item); } return item; };
    const llm = row("llm-pi-ai"); const llmConfig = object(llm.config);
    const providers = object(llmConfig.providers); const route = object(providers[fields.providerKey]);
    llm.config = { ...llmConfig, providers: { ...providers, [fields.providerKey]: { ...route, baseURL: fields.baseUrl, api: fields.api, apiKeyEnv: "ORBIS_DSH_API_KEY", models: [{ ...object((route.models as unknown[] | undefined)?.[0]), id: fields.model }] } } };
    const acp = row("acp"); acp.config = { ...object(acp.config), provider: fields.providerKey, model: fields.model };
    config.patch = yaml(rows); config.env = { ...object(config.env), ORBIS_DSH_API_KEY: fields.apiKey };
  }
  return config;
}
export function newProviderConfig(kind: AgentKind): Obj {
  return kind === "codex" ? { auth: { OPENAI_API_KEY: "" }, config: "model_provider = \"custom\"\nmodel = \"\"\n\n[model_providers.custom]\nname = \"custom\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n" }
    : kind === "pi" ? { baseUrl: "", apiKey: "", api: "openai-completions", models: [{ id: "" }] }
    : { patch: "[]\n", env: {} };
}
