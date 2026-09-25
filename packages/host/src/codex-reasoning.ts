// Vendor inference and effort mapping from CC Switch f8788719 (MIT).
type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown): string => typeof v === "string" ? v : "";
const levels = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export function reasoningOptions(config: Obj, name: string, url: string, model: string): Obj {
  const explicit = object(config.codexChatReasoning);
  const catalog = object(config.modelCatalog).models;
  const row = (Array.isArray(catalog) ? catalog : []).map(object).find(row => text(row.model).toLowerCase() === model.toLowerCase());
  const effortLevels = row?.reasoningLevels ?? row?.reasoning_levels;
  if (Object.keys(explicit).length) return { ...explicit, ...(explicit.effortValueMode === "zen" ? { effortLevels } : {}) };
  const platform = `${name} ${url}`.toLowerCase(); const all = `${platform} ${model.toLowerCase()}`;
  if (platform.includes("openrouter")) return { supportsThinking: false, supportsEffort: true, thinkingParam: "none", effortParam: "reasoning.effort", effortValueMode: "openrouter" };
  if (/siliconflow|modelscope/.test(platform)) return { supportsThinking: true, supportsEffort: false, thinkingParam: "enable_thinking" };
  if (platform.includes("opencode.ai")) {
    return { supportsThinking: true, supportsEffort: true, thinkingParam: "none", effortParam: "reasoning_effort", effortValueMode: "zen", effortLevels };
  }
  if (all.includes("deepseek")) return { supportsThinking: true, supportsEffort: true, thinkingParam: "thinking", effortParam: "reasoning_effort", effortValueMode: "deepseek" };
  if (/stepfun|step-3.5-flash-2603/.test(all)) return { supportsThinking: true, supportsEffort: /2603|step-3.7-flash/.test(model), thinkingParam: "none", effortParam: "reasoning_effort", effortValueMode: model.includes("2603") ? "low_high" : "passthrough" };
  if (/kimi|moonshot|glm|zhipu|z\.ai|mimo/.test(all)) return { supportsThinking: true, supportsEffort: false, thinkingParam: "thinking" };
  if (/qwen|dashscope|bailian/.test(all)) return { supportsThinking: true, supportsEffort: false, thinkingParam: "enable_thinking" };
  if (all.includes("minimax")) return { supportsThinking: true, supportsEffort: false, thinkingParam: "reasoning_split" };
  return {};
}
export function applyReasoning(chat: Obj, request: Obj, options: Obj): void {
  const config = object(options.reasoning);
  const effort = text(object(request.reasoning).effort).trim().toLowerCase();
  if (!Object.keys(config).length) {
    const model = text(chat.model).toLowerCase();
    const grokMinor = /^grok-4\.(\d+)/.exec(model)?.[1];
    const supported = /^o\d|^gpt-[5-9]|^grok-build-/.test(model) || (grokMinor !== undefined && Number(grokMinor) >= 5);
    if (effort && (options.supportsReasoningEffort === true || (options.supportsReasoningEffort !== false && supported))) chat.reasoning_effort = effort;
    return;
  }
  if (!Object.hasOwn(request, "reasoning")) return;
  const enabled = request.reasoning !== null && !["none", "off", "disabled"].includes(effort);
  const parameter = text(config.thinkingParam) || "thinking";
  if (config.supportsThinking === true || config.supportsEffort === true) {
    if (parameter === "thinking") chat.thinking = { type: enabled ? "enabled" : "disabled" };
    else if (["enable_thinking", "reasoning_split"].includes(parameter)) chat[parameter] = enabled;
  }
  const effortParameter = text(config.effortParam) || "reasoning_effort";
  if (!enabled) { if (effortParameter === "reasoning.effort") chat.reasoning = { effort: "none" }; return; }
  if (config.supportsEffort !== true || !levels.includes(effort)) return;
  let mapped: string | undefined = effort;
  if (config.effortValueMode === "deepseek") mapped = ["xhigh", "max", "ultra"].includes(effort) ? "max" : "high";
  if (config.effortValueMode === "low_high") mapped = ["minimal", "low"].includes(effort) ? "low" : "high";
  if (config.effortValueMode === "openrouter" && ["max", "ultra"].includes(effort)) mapped = "xhigh";
  if (config.effortValueMode === "zen") {
    const supported = (Array.isArray(config.effortLevels) ? config.effortLevels : []).filter((l): l is string => typeof l === "string" && levels.includes(l)).sort((a, b) => levels.indexOf(a) - levels.indexOf(b));
    mapped = supported.find(level => levels.indexOf(level) >= levels.indexOf(effort)) ?? supported.at(-1);
  }
  if (!mapped) return;
  if (effortParameter === "reasoning.effort") chat.reasoning = { effort: mapped };
  else if (effortParameter === "reasoning_effort") chat.reasoning_effort = mapped;
}
