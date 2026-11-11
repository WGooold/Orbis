import type { TurnConfiguration } from "@orbis/protocol";

/** Native assistant messages describe the routed request, unlike the live selection getters. */
export function piTurnConfiguration(turnId: string, message: unknown): TurnConfiguration | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const value = message as Record<string, unknown>;
  if (value.role !== "assistant" || typeof value.provider !== "string" || !value.provider ||
      typeof value.model !== "string" || !value.model) return undefined;
  return { turnId, model: { provider: value.provider.slice(0, 128), id: value.model.slice(0, 256) },
    // Older Pi streams do not report the requested level until message_end. Do not guess it
    // from ctx.thinkingLevel: it may have changed, or the virtual model may have routed it.
    ...(typeof value.thinkingLevel === "string" && value.thinkingLevel.length > 0
      ? { thinkingLevel: value.thinkingLevel.slice(0, 64) } : {}) };
}
