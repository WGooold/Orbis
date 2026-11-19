import { createHash } from "node:crypto";
import type { SessionConfigurationCatalog, SessionConfigurationValues } from "@orbis/protocol";
import { SessionConfigurationError } from "./session-configuration-store.js";

const hermesRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const hermesString = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type HermesModelSelection = { provider: string; model: string };
export const hermesModelValue = (choice: HermesModelSelection): string => `hermes-model:${digest([choice.provider, choice.model])}`;

/** Pair identity stays exact even when two providers advertise the same model id. No credentials, URLs or native config. */
export function hermesModelCatalog(raw: unknown, profileId: string, cwd: string): {
  catalog: SessionConfigurationCatalog;
  selections: ReadonlyMap<string, HermesModelSelection>;
} {
  const result = hermesRecord(raw);
  if (!Array.isArray(result.providers)) throw new SessionConfigurationError("configuration_unavailable", "Hermes 未返回可用模型清单");
  const selections = new Map<string, HermesModelSelection>();
  const models: SessionConfigurationCatalog["models"] = [];
  const current = { provider: hermesString(result.provider, 128) ?? "", model: hermesString(result.model, 256) ?? "" };
  // Reserve room for the rest of the control frame. Preserve the current choice first where possible.
  let bytes = 0;
  const providers = result.providers.map(hermesRecord);
  providers.sort((left, right) => Number(right.slug === current.provider) - Number(left.slug === current.provider));
  outer: for (const row of providers) {
    const provider = hermesString(row.slug, 128);
    if (!provider || row.authenticated === false || !Array.isArray(row.models)) continue;
    const unavailable = new Set(Array.isArray(row.unavailable_models) ? row.unavailable_models : []);
    const candidates = provider === current.provider && row.models.includes(current.model) ? [current.model, ...row.models] : row.models;
    for (const rawModel of candidates) {
      const model = hermesString(rawModel, 256);
      if (!model || unavailable.has(model)) continue;
      const selection = { provider, model };
      const value = hermesModelValue(selection);
      if (selections.has(value)) continue;
      const option = { value, label: `${model} · ${hermesString(row.name, 128) ?? provider}`, thinking: [] };
      bytes += Buffer.byteLength(JSON.stringify(option), "utf8") + 1;
      if (bytes > 48 * 1024 || models.length === 1000) break outer;
      selections.set(value, selection);
      models.push(option);
    }
  }
  const value = hermesModelValue(current);
  return { catalog: { binding: digest(["hermes", profileId, cwd, current]), defaults: selections.has(value) ? { model: value } : {},
    models, permissions: [] }, selections };
}

export function requireHermesModel(values: SessionConfigurationValues | undefined,
  selections: ReadonlyMap<string, HermesModelSelection>): HermesModelSelection | undefined {
  if (values?.thinking !== undefined || Object.keys(values?.permissions ?? {}).length)
    throw new SessionConfigurationError("configuration_stale", "当前 Hermes Gateway 未提供此配置选项");
  if (values?.model === undefined) return undefined;
  const choice = selections.get(values.model);
  if (!choice) throw new SessionConfigurationError("configuration_stale", "Hermes 模型选项已变化，请刷新后重新选择");
  return choice;
}
