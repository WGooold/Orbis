// Native-file switching follows CC Switch (MIT); see THIRD-PARTY-NOTICES.md.
import { ProviderError } from "./provider-error.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
export const claudeProtocolSelectors = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD"];
const ownedEnv = (key: string): boolean => ["ANTHROPIC_", "AWS_", "VERTEX_REGION_"].some(prefix => key.startsWith(prefix)) || claudeProtocolSelectors.includes(key) ||
  ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS"].includes(key) ||
  (key.startsWith("CLAUDE_CODE_SKIP_") && key.endsWith("_AUTH"));
const ownedSettings = ["model", "availableModels", "apiKeyHelper", "apiBaseUrl", "primaryModel", "smallFastModel", "apiKey", "fallbackModel", "modelOverrides", "modelPicker", "advisorModel", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "forceLoginMethod", "forceLoginOrgUUID"];
const sharedSettings = new Set(["env", "$schema", "hooks", "permissions", "mcpServers", "enabledPlugins", "extraKnownMarketplaces", "statusLine"]);
const profileKeys = (template: Obj): string[] => [...new Set([...ownedSettings, ...Object.keys(template).filter(key => !sharedSettings.has(key))])];

export function validateClaudeConfig(config: Obj): void {
  if (config.env !== undefined && (config.env === null || Array.isArray(config.env) || typeof config.env !== "object" ||
      Object.entries(config.env).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string"))) {
    throw new ProviderError("Claude Code env 必须是环境变量名到字符串的映射");
  }
  if (config.model !== undefined && typeof config.model !== "string") throw new ProviderError("Claude Code model 必须是字符串");
}

/** Official means native Claude subscription routing, not a user-editable category label. */
export function claudeOfficial(config: Obj): boolean {
  const env = object(config.env);
  const base = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL.trim() : "";
  if (base && !/^https:\/\/api\.anthropic\.com\/?$/.test(base)) return false;
  return !["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some(key => Object.hasOwn(env, key)) &&
    !claudeProtocolSelectors.some(key => ["1", "true"].includes(String(env[key]).toLowerCase())) && !config.apiKeyHelper && !config.apiKey && !config.apiBaseUrl;
}

/** Hooks, permissions, MCP and unrelated preferences stay in the live settings file. */
export function backfillClaude(live: Obj, template: Obj = {}): Obj {
  const result: Obj = { env: Object.fromEntries(Object.entries(object(live.env)).filter(([key]) => ownedEnv(key) || Object.hasOwn(object(template.env), key))) };
  for (const key of profileKeys(template)) if (Object.hasOwn(live, key)) result[key] = structuredClone(live[key]);
  return result;
}

export function prepareClaude(profile: Obj, live: Obj, outgoing: Obj = {}): Obj {
  validateClaudeConfig(profile);
  const result = structuredClone(live);
  const env = { ...object(live.env) };
  for (const key of Object.keys(env)) if (ownedEnv(key) || (Object.hasOwn(object(outgoing.env), key) && env[key] === object(outgoing.env)[key])) delete env[key];
  result.env = { ...env, ...object(profile.env) };
  if (["1", "true"].includes(String(object(result.env).CLAUDE_CODE_USE_BEDROCK).toLowerCase()) && profile.apiKey !== undefined && object(result.env).AWS_BEARER_TOKEN_BEDROCK === undefined) {
    object(result.env).AWS_BEARER_TOKEN_BEDROCK = profile.apiKey;
  }
  for (const key of new Set([...profileKeys(outgoing), ...profileKeys(profile)])) {
    delete result[key];
    if (Object.hasOwn(profile, key)) result[key] = structuredClone(profile[key]);
  }
  return result;
}
