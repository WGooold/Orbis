// Behavior ported from farion1231/cc-switch f8788719, MIT. See THIRD-PARTY-NOTICES.md.
import { parse } from "smol-toml";
import { ProviderError } from "./provider-error.js";
import { mergeToml, removeToml, setToml } from "./provider-toml.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const reserved = new Set(["openai", "ollama", "lmstudio", "amazon-bedrock", "amazon-bedrock-runtime"]);
export type CodexPreferences = { commonConfig: string; commonCleared: boolean; preserveOfficialLogin: boolean };
export const defaultCodexPreferences = (): CodexPreferences => ({ commonConfig: "", commonCleared: false, preserveOfficialLogin: false });
export function codexOfficial(config: Obj): boolean {
  const doc = parse(text(config.config));
  return (!doc.model_provider || doc.model_provider === "openai") && !doc.openai_base_url && !doc.base_url;
}
export function codexToken(config: Obj): string {
  const doc = parse(text(config.config));
  const id = text(doc.model_provider);
  const route = reserved.has(id) ? {} : object(object(doc.model_providers)[id]);
  return text(object(config.auth).OPENAI_API_KEY).trim() || text(route.experimental_bearer_token).trim() || text(doc.experimental_bearer_token).trim();
}
export function extractCodexCommon(config: string): string {
  for (const key of ["model", "model_provider", "base_url", "openai_base_url", "wire_api", "model_providers", "mcp_servers", "experimental_bearer_token", "model_catalog_json"]) config = setToml(config, [key], undefined);
  config = setToml(config, ["mcp", "servers"], undefined);
  if (parse(config).web_search === "disabled") config = setToml(config, ["web_search"], undefined);
  return config.trim();
}
export function backfillCodex(live: Obj, template: Obj, common: string, useCommon: boolean): Obj {
  let config = text(live.config);
  const doc = parse(config);
  const route = text(doc.model_provider);
  const token = text(object(object(doc.model_providers)[route]).experimental_bearer_token) || text(doc.experimental_bearer_token);
  let auth = live.auth;
  if (token) {
    config = setToml(config, ["model_providers", route, "experimental_bearer_token"], undefined);
    config = setToml(config, ["experimental_bearer_token"], undefined);
    auth = { ...object(template.auth), OPENAI_API_KEY: token };
  } else if (!codexOfficial(live) && Object.keys(object(object(live.auth).tokens)).length) {
    // A preserved official login is ambient state, never a third-party card's credential.
    auth = object(template.auth);
  }
  if (useCommon && common.trim()) config = removeToml(config, common);
  // MCP remains a live, shared resource and is projected again on every write.
  config = setToml(config, ["mcp_servers"], undefined);
  return { ...template, ...live, auth, config };
}

/** Resolve all auth decisions before any live file or current marker changes. */
export function prepareCodex(config: Obj, category: string | undefined, preferences: CodexPreferences, useCommon: boolean, live: Obj): { config: string; auth?: unknown } {
  let result = text(config.config);
  if (useCommon && preferences.commonConfig.trim()) result = mergeToml(result, preferences.commonConfig);
  const official = category === "official" || (category === undefined && codexOfficial(config));
  const key = codexToken(config);
  let doc = parse(result);
  let providers = object(doc.model_providers);
  for (const [id, data] of Object.entries(providers)) {
    const route = object(data);
    if (route.aws !== undefined && id !== "amazon-bedrock" && id !== "amazon-bedrock-runtime") throw new ProviderError("Codex 自定义供应商不能包含 aws 字段；请使用 Bedrock 内置供应商");
    if (route.auth !== undefined && (route.requires_openai_auth === true || route.env_key !== undefined || route.experimental_bearer_token !== undefined)) throw new ProviderError("Codex auth 不能和 requires_openai_auth、env_key 或 experimental_bearer_token 同时使用");
    if (reserved.has(id) && id !== "amazon-bedrock" && id !== "amazon-bedrock-runtime") {
      let renamed = "cc-switch";
      for (let suffix = 2; Object.hasOwn(providers, renamed); suffix++) renamed = `cc-switch-${suffix}`;
      result = setToml(result, ["model_providers", id], undefined);
      result = setToml(result, ["model_providers", renamed], { ...route, name: text(route.name).trim() || "Custom", wire_api: "responses" });
      const fallsBack = route.requires_openai_auth === true && route.env_key === undefined && route.experimental_bearer_token === undefined;
      if (!official && (text(doc.model_provider) || "openai") === id && (key || !fallsBack)) result = setToml(result, ["model_provider"], renamed);
      doc = parse(result); providers = object(doc.model_providers);
    } else if (!reserved.has(id) && !text(route.name).trim()) result = setToml(result, ["model_providers", id, "name"], id);
  }
  // Orbis does not own an MCP database: the latest live native table is authoritative.
  const mcp = parse(text(live.config)).mcp_servers;
  result = setToml(result, ["mcp_servers"], mcp);
  if (official) {
    const auth = object(config.auth);
    const identity = (value: unknown): string | undefined => {
      const tokens = object(object(value).tokens);
      if (!text(tokens.account_id) || !text(tokens.id_token)) return undefined;
      try {
        const jwt = object(JSON.parse(Buffer.from(text(tokens.id_token).split(".")[1] ?? "", "base64url").toString("utf8")) as unknown);
        return text(jwt.sub) ? `${text(tokens.account_id)}:${text(jwt.sub)}` : undefined;
      } catch { return undefined; }
    };
    const savedIdentity = identity(auth);
    if (savedIdentity && savedIdentity === identity(live.auth)) return { config: result }; // Adopt CLI rotation in place.
    const material = Object.entries(auth).some(([key, value]) => key !== "auth_mode" && value !== null && value !== "" && (typeof value !== "object" || Object.keys(object(value)).length > 0));
    return material ? { config: result, auth } : { config: result };
  }
  doc = parse(result);
  if (key && (!doc.model_provider || doc.model_provider === "openai") && text(doc.openai_base_url)) {
    let id = "cc-switch";
    for (let suffix = 2; Object.hasOwn(object(doc.model_providers), id); suffix++) id = `cc-switch-${suffix}`;
    result = setToml(result, ["model_provider"], id);
    result = setToml(result, ["model_providers", id], { name: id, base_url: doc.openai_base_url, wire_api: "responses" });
    result = setToml(result, ["openai_base_url"], undefined);
    doc = parse(result);
  }
  const id = text(doc.model_provider);
  const route = object(object(doc.model_providers)[id]);
  if (key && (!id || reserved.has(id) || !Object.keys(route).length)) throw new ProviderError("Codex 第三方配置需要自定义 model_providers 条目承载 API 密钥");
  const authorizationHeader = [route.http_headers, route.env_http_headers].some(headers => Object.keys(object(headers)).some(name => name.toLowerCase() === "authorization"));
  const ownAuth = route.auth !== undefined || route.aws !== undefined || route.env_key !== undefined || (route.requires_openai_auth !== true && authorizationHeader);
  const fallsBack = route.requires_openai_auth === true && route.env_key === undefined && route.experimental_bearer_token === undefined;
  if (!key && (fallsBack || ((!id || id === "openai") && doc.openai_base_url))) throw new ProviderError("此第三方配置会回退使用官方登录；请填写 API 密钥或移除 requires_openai_auth");
  if (key && !ownAuth) result = setToml(result, ["model_providers", id, "experimental_bearer_token"], key);
  if (route.env_key !== undefined || route.experimental_bearer_token !== undefined || (key && !ownAuth)) result = setToml(result, ["model_providers", id, "requires_openai_auth"], preferences.preserveOfficialLogin);
  return preferences.preserveOfficialLogin ? { config: result } : { config: result, auth: null };
}
