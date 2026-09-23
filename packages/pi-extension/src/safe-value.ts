const MAX_SAFE_VALUE_DEPTH = 64;
const MAX_SAFE_VALUE_NODES = 100_000;
const CIRCULAR_SAFE_VALUE = "[Circular]";
const TRUNCATED_SAFE_VALUE = "[Truncated]";

/**
 * Keep arbitrary tool/message/session payloads JSON-safe and bounded before they
 * reach JSON.stringify or the mobile parser. Shared by the outbound event path
 * (transport.ts) and the session graph projection (pi-adapter.ts).
 */
export function safeValue(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>(),
  budget = { remaining: MAX_SAFE_VALUE_NODES },
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === undefined) return undefined;
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_SAFE_VALUE_DEPTH) return TRUNCATED_SAFE_VALUE;
  if (ancestors.has(value)) return CIRCULAR_SAFE_VALUE;
  if (budget.remaining <= 0) return TRUNCATED_SAFE_VALUE;
  budget.remaining -= 1;

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.map((item) => safeValue(item, depth + 1, nextAncestors, budget) ?? null);
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      child = "[Unserializable]";
    }
    const safeChild = safeValue(child, depth + 1, nextAncestors, budget);
    if (safeChild !== undefined) result[key] = safeChild;
  }
  return result;
}
