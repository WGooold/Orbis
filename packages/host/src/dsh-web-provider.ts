import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseDocument } from "yaml";
import { record } from "./dsh-client.js";
import type { DshWebConnection } from "./dsh-web-client.js";

/** Private launch metadata, removed before spawning the shared Web process. */
export const DSH_PROVIDER_ENV = "ORBIS_DSH_PROVIDER_ENV";

export function dshProviderCredentials(env: NodeJS.ProcessEnv): Record<string, string> {
  const value = record(JSON.parse(env[DSH_PROVIDER_ENV] ?? "{}"));
  if (Object.entries(value).some(([key, secret]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof secret !== "string")) throw new Error("DeepSeek 供应商凭据格式无效");
  return value as Record<string, string>;
}

export function dshWebLaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const launch = { ...env };
  for (const key of Object.keys(dshProviderCredentials(env))) delete launch[key];
  delete launch[DSH_PROVIDER_ENV];
  return launch;
}

function includes(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => includes(actual[index], item));
  if (expected !== null && typeof expected === "object") return Object.entries(expected).every(([key, value]) => includes(record(actual)[key], value));
  return actual === expected;
}

/** Keep the native home patch authoritative; DSH HMR applies it without ending sessions. */
export async function applyDshWebProvider(client: DshWebConnection, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<void> {
  const credentials = dshProviderCredentials(env);
  const path = join(env.DSH_HOME || join(homedir(), ".dsh"), "cordis.patch.yml");
  const patch = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "[]"; throw error; });
  const document = parseDocument(patch, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] });
  if (document.errors.length) throw new Error("DeepSeek 供应商补丁无效");
  const rows: unknown = document.toJS();
  const expected = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = record(raw);
    if (["llm-pi-ai", "llm-deepseek", "agent-default-model"].includes(String(row.id)) && row.config && row.disabled !== true) expected.set(String(row.id), record(row.config));
  }
  const deadline = Date.now() + timeoutMs;
  while (expected.size) {
    const state = record(await client.request("settings/describe", {}));
    const namespaces = (Array.isArray(state.namespaces) ? state.namespaces : []).map(record);
    if ([...expected].every(([id, config]) => {
      const value = namespaces.find(ns => ns.ns === id)?.value;
      if (!includes(value, config)) return false;
      return id !== "llm-pi-ai" || Object.keys(record(record(value).providers)).sort().join("\n") === Object.keys(record(config.providers)).sort().join("\n");
    })) break;
    if (Date.now() >= deadline) throw new Error("DeepSeek Web 未应用供应商补丁，请检查原生配置及 HMR 状态；本次切换已撤回");
    await delay(100);
  }
  // Native credential writes are resolved anew for each model request. Never
  // bake managed keys into a persistent process's immutable environment.
  for (const [ref, value] of Object.entries(credentials)) {
    if (value) await client.request("credentials/set", { ref, value });
    else await client.request("credentials/unset", { ref });
  }
}
