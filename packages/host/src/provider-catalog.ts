// Native Responses catalog behavior adapted from CC Switch f8788719 (MIT).
import { basename, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { nativeTemplate, deepseekCatalog, textOnlyModels, webSearchRejectHosts, webSearchRejectModels } from "./provider-catalog-data.js";
import { setToml } from "./provider-toml.js";
import { ProviderError } from "./provider-error.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const positive = (value: unknown): number | undefined => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
const levels: Record<string, string> = { none: "Disable Thinking", minimal: "Minimal reasoning", low: "Fast responses with lighter reasoning", medium: "Balances speed and reasoning depth for everyday tasks", high: "Greater reasoning depth for complex problems", xhigh: "Extra high reasoning depth for complex problems", max: "Maximum reasoning depth for the hardest problems", ultra: "Ultra reasoning depth" };
export const catalogFilename = "orbis-model-catalog.json";
export function ownedCatalog(config: string, dir: string): boolean {
  const pointer = parse(config).model_catalog_json;
  return typeof pointer === "string" && basename(pointer) === catalogFilename && resolve(dir, pointer).toLowerCase() === resolve(dir, catalogFilename).toLowerCase();
}
export function catalogSpecs(config: Obj): Obj[] {
  const rows = Array.isArray(config.modelCatalog) ? config.modelCatalog : object(config.modelCatalog).models;
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw new ProviderError("Codex modelCatalog.models 必须是数组");
  const result = rows.map(object);
  const ids = result.map(row => text(row.model).trim());
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new ProviderError("Codex 模型目录需要不重复的模型 ID");
  for (const row of result) if (row.contextWindow !== undefined && !positive(row.contextWindow)) throw new ProviderError("模型上下文窗口必须为正整数");
  return result;
}
function inferredModalities(id: string): string[] {
  const tail = id.toLowerCase().replace(/\[[^\]]*\]/g, "").trim().split("/").at(-1)!;
  return textOnlyModels.includes(tail) ? ["text"] : ["text", "image"];
}
function catalogEntry(row: Obj, index: number, config: string): Obj {
  const doc = parse(config); const route = object(object(doc.model_providers)[text(doc.model_provider)]);
  let host = "";
  try { host = new URL(text(route.base_url)).hostname; } catch { /* No vendor-specific template. */ }
  const isDeepseek = host === "deepseek.com" || host.endsWith(".deepseek.com");
  const id = text(row.model).trim();
  const vendor = isDeepseek ? deepseekCatalog.models.find(entry => text(entry.slug).toLowerCase() === id.toLowerCase()) ?? deepseekCatalog.models[0] : undefined;
  const result = structuredClone(vendor ?? nativeTemplate);
  const displayName = text(row.displayName) || (vendor ? text(vendor.display_name) : "") || id;
  const contextWindow = positive(row.contextWindow) ?? (vendor ? positive(vendor.context_window) : undefined) ?? positive(doc.model_context_window) ?? 128000;
  Object.assign(result, { slug: id, display_name: displayName, description: displayName, context_window: contextWindow, max_context_window: contextWindow, priority: 1000 + index, additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null });
  result.input_modalities = Array.isArray(row.inputModalities) && row.inputModalities.length ? row.inputModalities : vendor?.slug === id ? vendor.input_modalities : inferredModalities(id);
  if (typeof row.supportsParallelToolCalls === "boolean") result.supports_parallel_tool_calls = row.supportsParallelToolCalls;
  if (text(row.baseInstructions).trim()) result.base_instructions = text(row.baseInstructions).trim();
  if (Array.isArray(row.reasoningLevels) && row.reasoningLevels.length) {
    const requested = [...new Set(row.reasoningLevels.filter((level): level is string => typeof level === "string" && Object.hasOwn(levels, level)))];
    if (!requested.length) throw new ProviderError("Codex 思考档位无效");
    result.supported_reasoning_levels = requested.map(effort => ({ effort, description: levels[effort] }));
    result.default_reasoning_level = requested.includes(text(row.defaultReasoningLevel)) ? row.defaultReasoningLevel : requested.includes(text(result.default_reasoning_level)) ? result.default_reasoning_level : requested.at(-1);
  }
  return result;
}
export function prepareCatalog(settings: Obj, config: string, dir: string): { config: string; catalog: Obj | null } {
  const specs = catalogSpecs(settings); const doc = parse(config);
  const pointer = text(doc.model_catalog_json);
  const own = ownedCatalog(config, dir);
  if (pointer && !own) return { config, catalog: null }; // User-owned external catalogs remain native.
  if (!specs.length) {
    if (own) config = setToml(config, ["model_catalog_json"], undefined);
    if (doc.web_search === "disabled" && own) config = setToml(config, ["web_search"], undefined);
    return { config, catalog: null };
  }
  const catalog = { models: specs.map((row, index) => catalogEntry(row, index, config)) };
  config = setToml(config, ["model_catalog_json"], resolve(dir, catalogFilename));
  const route = object(object(doc.model_providers)[text(doc.model_provider)]); let host = "";
  try { host = new URL(text(route.base_url)).hostname.toLowerCase(); } catch { /* Only known native gateways disable the hosted tool. */ }
  const model = text(doc.model).toLowerCase().split("/").at(-1) ?? "";
  const rejected = webSearchRejectHosts.some(domain => host === domain || host.endsWith(`.${domain}`)) || webSearchRejectModels.some(prefix => model.startsWith(prefix));
  if (rejected) config = setToml(config, ["web_search"], "disabled");
  else if (doc.web_search === "disabled" && own) config = setToml(config, ["web_search"], undefined);
  return { config, catalog };
}
/** Backfill native capability edits without replacing an unchanged row's optional/unknown metadata. */
export function backfillCatalog(catalog: Obj, template: Obj, config: string): Obj {
  if (!Array.isArray(catalog.models)) return object(template.modelCatalog);
  const saved = catalogSpecs(template);
  const mappings: Record<string, string> = { display_name: "displayName", context_window: "contextWindow", supports_parallel_tool_calls: "supportsParallelToolCalls", input_modalities: "inputModalities", base_instructions: "baseInstructions", default_reasoning_level: "defaultReasoningLevel" };
  return { ...object(template.modelCatalog), models: catalog.models.flatMap((item, index) => {
    const native = object(item); const id = text(native.slug); if (!id) return [];
    const row = structuredClone(saved.find(model => model.model === id) ?? { model: id });
    const expected = catalogEntry(row, index, config);
    for (const [nativeKey, key] of Object.entries(mappings)) if (native[nativeKey] !== undefined && !isDeepStrictEqual(native[nativeKey], expected[nativeKey])) row[key] = native[nativeKey];
    if (Array.isArray(native.supported_reasoning_levels) && !isDeepStrictEqual(native.supported_reasoning_levels, expected.supported_reasoning_levels)) row.reasoningLevels = native.supported_reasoning_levels.map(level => object(level).effort);
    return [row];
  }) };
}
