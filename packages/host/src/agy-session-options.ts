import type { RuntimeMetadata, RuntimeSlashCommand } from "@orbis/protocol";
import { record } from "./acp-client.js";

type Choice = { value: string; label: string; description?: string };
export type AgySetting = "model" | "thinking";
export type AgyOption = { id: string; current: string; choices: Choice[] };
export type AgyOptions = Partial<Record<AgySetting, AgyOption>>;

/** ACP select values are opaque. Only identified model/effort selectors enter the existing App UI. */
export function agyOptions(native: unknown): AgyOptions | undefined {
  if (!Array.isArray(native) || native.length > 64) return undefined;
  const result: AgyOptions = {};
  const seen = new Set<AgySetting>();
  const unique = new Set<string>();
  for (const value of native) {
    const row = record(value);
    if (typeof row.id !== "string" || !row.id || row.id.length > 128 || unique.has(row.id)) return undefined;
    unique.add(row.id);
    const category = row.category === "model" || row.id === "model" ? "model"
      : row.category === "thought_level" || row.id === "thinking" || row.id === "thinking_level" ? "thinking" : undefined;
    if (!category) continue;
    if (seen.has(category)) return undefined;
    seen.add(category);
    if (row.type !== "select" || typeof row.currentValue !== "string" || !Array.isArray(row.options) || row.options.length > 64) continue;
    const nativeValues = row.options.flatMap(item => {
      const group = record(item);
      return typeof group.group === "string" && Array.isArray(group.options) && group.options.length <= 64 ? group.options : [item];
    });
    const maxLength = category === "thinking" ? 64 : 256;
    if (nativeValues.length > 64) continue;
    const choices: Choice[] = [];
    const values = new Set<string>();
    for (const item of nativeValues) {
      const option = record(item);
      if (typeof option.value !== "string" || !option.value || option.value.length > maxLength || values.has(option.value)
        || typeof option.name !== "string" || !option.name.trim()) continue;
      values.add(option.value);
      choices.push({ value: option.value, label: option.name.trim().slice(0, 128),
        ...(typeof option.description === "string" ? { description: option.description.slice(0, 256) } : {}) });
    }
    if (values.has(row.currentValue)) result[category] = { id: row.id, current: row.currentValue, choices };
  }
  return result;
}

export function agyOptionCommands(options: AgyOptions): RuntimeSlashCommand[] {
  return (["model", "thinking"] as const).flatMap(name => {
    const option = options[name];
    return option ? [{ name, source: "builtin", argument: { kind: "select", required: true, options: option.choices } }] : [];
  });
}

export function agyOptionMetadata(options: AgyOptions): Pick<RuntimeMetadata, "model" | "modelSelection" | "thinkingLevel"> {
  const { model, thinking } = options;
  return { ...(model ? { model: { provider: "agy", id: model.current, name: model.choices.find(choice => choice.value === model.current)!.label } } : {}),
    ...(thinking ? { thinkingLevel: thinking.current } : {}),
    ...(model || thinking ? { modelSelection: { ...(model ? { model: model.current } : {}), ...(thinking ? { thinking: thinking.current } : {}) } } : {}) };
}
