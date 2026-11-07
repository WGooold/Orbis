import type { AgentTask, AgentTaskInventory, DomainAvailability } from "@orbis/protocol";

/** Shared Host projection: native adapters own status semantics; inventory identity,
 * bounds and reconciliation are identical for every backend (S33 / SC52). */
export function agentTaskInventory(
  items: readonly AgentTask[], availability: DomainAvailability = "ready", truncated = false,
): AgentTaskInventory {
  const unique = new Map(items.map(item => [item.id, { id: item.id,
    ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
    title: item.title.slice(0, 80), kind: item.kind.slice(0, 48), status: item.status }]));
  const overflow = truncated || unique.size > 256;
  return { availability: overflow && availability === "ready" ? "unknown" : availability,
    items: [...unique.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, 256), truncated: overflow };
}

/** A complete snapshot replaces the list. An incomplete snapshot updates known IDs
 * without deleting unseen children; a failed read retains the last known list. */
export function mergeAgentTaskInventory(
  previous: AgentTaskInventory | undefined, incoming: AgentTaskInventory,
): AgentTaskInventory {
  if (incoming.availability === "ready" || incoming.availability === "unavailable") return agentTaskInventory(incoming.items, incoming.availability, incoming.truncated);
  if (incoming.truncated) {
    const updated = new Set(incoming.items.map(item => item.id));
    const retained = (previous?.items ?? []).filter(item => !updated.has(item.id)).slice(0, Math.max(0, 256 - incoming.items.length))
      .map(item => previous?.availability === "unknown" && !previous.truncated ? { ...item, status: "unknown" as const } : item);
    return agentTaskInventory([...retained, ...incoming.items], "unknown", true);
  }
  return agentTaskInventory(previous?.items ?? incoming.items, "unknown");
}
