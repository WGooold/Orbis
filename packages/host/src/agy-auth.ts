import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { agyKey } from "./agy-credential.js";

export const AGY_AUTH_METHODS = ["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"] as const;
export type AgyAuthMethod = typeof AGY_AUTH_METHODS[number];
export type AgyAuthConfig = { authMethod: AgyAuthMethod; apiKey: string; gcpProject: string; gcpLocation: string };
export const DEFAULT_AGY_AUTH: AgyAuthConfig = { authMethod: "oauth-personal", apiKey: "", gcpProject: "", gcpLocation: "" };
export const agyUsesGoogle = (method: AgyAuthMethod): boolean => method === "oauth-personal" || method === "oauth-business";

export function parseAgyAuthConfig(value: unknown): AgyAuthConfig | undefined {
  if (typeof value === "string") {
    const apiKey = agyKey(value);
    return apiKey ? { ...DEFAULT_AGY_AUTH, authMethod: "gemini-api-key", apiKey } : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const authMethod = AGY_AUTH_METHODS.find(method => method === input.authMethod);
  if (!authMethod) return undefined;
  const projectMode = authMethod === "oauth-business" || authMethod === "agent-platform";
  const setting = (raw: unknown, length: number) => raw === undefined ? ""
    : typeof raw === "string" && raw.length <= length && !/\p{Cc}/u.test(raw) ? raw.trim() : undefined;
  const gcpProject = projectMode ? setting(input.gcpProject, 256) : "";
  const gcpLocation = projectMode ? setting(input.gcpLocation, 128) : "";
  const apiKey = agyUsesGoogle(authMethod) || input.apiKey === "" || input.apiKey === undefined ? "" : agyKey(input.apiKey);
  if (apiKey === undefined || gcpProject === undefined || gcpLocation === undefined) return undefined;
  return { authMethod, apiKey, gcpProject, gcpLocation };
}

export function agyAuthIssue(auth: AgyAuthConfig): string | undefined {
  if (auth.authMethod === "oauth-business" && (!auth.gcpProject || !auth.gcpLocation)) return "Gemini Enterprise 需要 GCP project 和 location";
  if (auth.authMethod === "gemini-api-key" && !auth.apiKey) return "请在 Host 配置 Gemini API Key";
  if (auth.authMethod === "agent-platform" && !auth.apiKey && (!auth.gcpProject || !auth.gcpLocation)) {
    return "Agent Platform 需要 API Key，或 GCP project 和 location";
  }
  return undefined;
}

/** One Host instance uses a hashed native profile. Keep the released API-Key profile intact. */
export function agyProfile(stateDir: string, authMethod: AgyAuthMethod, instanceId = "orbis:agy:default") {
  const legacy = authMethod === "gemini-api-key";
  const instance = createHash("sha256").update(instanceId).digest("hex");
  const directory = legacy ? resolve(stateDir, "agy-acp") : resolve(stateDir, "providers", "antigravity", instance);
  const home = join(directory, "home");
  return { directory, home, temp: join(directory, "tmp"), lock: join(directory, "owner.lock"),
    geminiDir: legacy ? join(home, ".gemini") : directory, appDataDir: legacy ? "orbis-agy" : "antigravity-acp" };
}
