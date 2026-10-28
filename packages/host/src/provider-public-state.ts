import { parse as parseToml } from "smol-toml";
import type {
  AgentKind, HostProviderAuthentication, HostProviderHealth, HostProviderRouting, HostProviderUsage,
} from "@orbis/protocol";
import { codexOfficial, codexToken } from "./provider-codex.js";
import { providerFields } from "./provider-form.js";
import type { ProxyPublicStatus } from "./codex-proxy.js";
import type { ProviderProfile } from "./provider-manager.js";
import type { UsageSnapshot } from "./provider-usage-cache.js";
import type { ProxyPreferences } from "./provider-proxy-config.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const timestamp = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Presence is local evidence. We deliberately never turn it into a claim that the remote credential is valid. */
export function publicProviderAuthentication(profile: ProviderProfile | undefined, managedAccountIds: ReadonlySet<string>, defaultAccountId?: string): HostProviderAuthentication {
  if (!profile) return { availability: "unknown", method: "unknown", credentialPresent: null, bindingReady: null, verified: null };
  if (profile.authBinding) {
    const bound = profile.authBinding.accountId ?? defaultAccountId;
    const present = bound !== undefined && managedAccountIds.has(bound);
    return { availability: "ready", method: "managed_account", credentialPresent: present, bindingReady: present, verified: null };
  }
  if (profile.kind === "codex") {
    const tokens = object(object(profile.config.auth).tokens);
    if (codexOfficial(profile.config) && ["access_token", "refresh_token", "id_token", "account_id"].every(key => text(tokens[key]))) {
      return { availability: "ready", method: "native_oauth", credentialPresent: true, bindingReady: null, verified: null };
    }
    const doc = parseToml(text(profile.config.config));
    const provider = object(object(doc.model_providers)[text(doc.model_provider)]);
    const envKey = text(provider.env_key);
    const present = envKey ? !!process.env[envKey]?.trim() : !!codexToken(profile.config);
    // Built-in providers may use OS credentials or credential helpers that this manager cannot inspect.
    if (["ollama", "lmstudio", "amazon-bedrock", "amazon-bedrock-runtime"].includes(text(doc.model_provider))) {
      return { availability: "unknown", method: "unknown", credentialPresent: null, bindingReady: null, verified: null };
    }
    return { availability: "ready", method: present ? "api_key" : "none", credentialPresent: present, bindingReady: null, verified: null };
  }
  const value = providerFields(profile, true).apiKey.trim();
  // Pi command/env references belong to the native credential resolver; do not run a command to make a summary.
  if (profile.kind === "pi" && (!value || value.startsWith("!") || /^[A-Z_][A-Z0-9_]*$/.test(value))) {
    return { availability: "unknown", method: "unknown", credentialPresent: null, bindingReady: null, verified: null };
  }
  return { availability: "ready", method: value ? "api_key" : "none", credentialPresent: value.length > 0, bindingReady: null, verified: null };
}

/** Arbitrary usage scripts can return secrets in strings or unknown keys. Publish finite quota numbers only. */
export function publicProviderUsage(snapshot?: UsageSnapshot): HostProviderUsage {
  if (!snapshot) return { availability: "unknown", detail: null, rows: [], updatedAt: null, attemptedAt: null, error: null };
  const rows = (snapshot.data ?? []).slice(0, 32).map(value => {
    const row = object(value);
    return { remaining: numeric(row.remaining), used: numeric(row.used), total: numeric(row.total) };
  }).filter(row => row.remaining !== null || row.used !== null || row.total !== null);
  return { availability: rows.length ? "ready" : "unknown", detail: null, rows,
    updatedAt: timestamp(snapshot.updatedAt), attemptedAt: timestamp(snapshot.attemptedAt),
    error: snapshot.error === undefined ? null : "query_failed" };
}

export function publicProviderHealth(kind: AgentKind, status: ProxyPublicStatus): HostProviderHealth {
  return { availability: kind === "codex" && status.health.length ? "ready" : "unknown",
    circuits: kind === "codex" ? status.health.slice(0, 64).map(circuit => ({
      providerId: circuit.id, state: circuit.state, failures: circuit.failures,
      lastSuccessAt: circuit.lastSuccessAt || null, lastFailureAt: circuit.lastFailureAt || null,
    })) : [] };
}

export function publicProviderRouting(kind: AgentKind, preferences: ProxyPreferences, status: ProxyPublicStatus): HostProviderRouting {
  if (kind !== "codex") return { availability: "unavailable", enabled: null, running: null, failoverEnabled: null,
    queue: [], activeRequests: null, lastProviderId: null, totalRequests: null, successfulRequests: null, failoverCount: null, requests: [] };
  return { availability: "ready", enabled: preferences.enabled, running: status.running,
    failoverEnabled: preferences.autoFailoverEnabled, queue: preferences.queue.slice(0, 64),
    activeRequests: status.activeRequests, lastProviderId: status.lastProviderId, totalRequests: status.totalRequests,
    successfulRequests: status.successfulRequests, failoverCount: status.failoverCount, requests: status.requests };
}
