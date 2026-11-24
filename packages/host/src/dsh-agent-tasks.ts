import type { AgentTask, AgentTaskInventory } from "@orbis/protocol";
import { agentTaskInventory } from "./agent-tasks.js";

type Row = Record<string, unknown> & { sessionId: string };
type CatalogEntry = { id: string; mode: string; title?: string };
const validId = (id: unknown): id is string => typeof id === "string" && !!id.trim() && id.length <= 256;

export function parseDshTaskCatalog(raw: unknown): { entries: CatalogEntry[]; partial: boolean } | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries: CatalogEntry[] = [];
  let partial = false;
  for (const value of raw) {
    const item = value as Record<string, unknown> | null;
    if (!item || !validId(item.id) || typeof item.mode !== "string") { partial = true; continue; }
    const name = [item.label, item.name].find(value => typeof value === "string" && value.trim()) as string | undefined;
    entries.push({ id: item.id, mode: item.mode, ...(name ? { title: name.trim().slice(0, 80) } : {}) });
    if (entries.length > 256) { partial = true; break; }
  }
  return { entries, partial };
}

type Catalog = NonNullable<ReturnType<typeof parseDshTaskCatalog>>;
const statusOf = (row: Row | undefined): AgentTask["status"] =>
  row?.agentAvailable === true && typeof row.running === "boolean" ? row.running ? "running" : "idle" : "unknown";

/** Parent catalogs prove membership, not running state or outcome. External entries have no local child Session. */
export function dshCatalogTasks(
  rootId: string, rows: ReadonlyMap<string, Row>, catalogOf: (id: string) => Catalog | undefined,
  fallback: AgentTaskInventory,
): AgentTaskInventory {
  const items = new Map<string, AgentTask>();
  const parents = [rootId];
  let partial = false;
  for (const parent of parents) {
    const catalog = catalogOf(parent);
    if (!catalog) { partial = true; continue; }
    partial ||= catalog.partial;
    for (const entry of catalog.entries) {
      if (entry.id === rootId || items.has(entry.id)) { partial = true; continue; }
      if (items.size >= 256) { partial = true; break; }
      const local = entry.mode !== "external";
      const registry = rows.get(entry.id);
      items.set(entry.id, { id: entry.id, ...(parent === rootId ? {} : { parentId: parent }),
        title: entry.title ?? "Subagent", kind: "subagent", status: local ? statusOf(registry) : "unknown" });
      if (local) parents.push(entry.id);
    }
  }
  // A live child may arrive before the parent's control update (or predate catalogs).
  // Do not hide it or claim the inventory is complete while the sources disagree.
  partial ||= fallback.items.some(item => rows.get(item.id)?.agentAvailable === true && !items.has(item.id));
  if (partial) for (const item of fallback.items) if (!items.has(item.id)) items.set(item.id, item);
  return agentTaskInventory([...items.values()], partial ? "unknown" : "ready", partial && items.size > 0);
}

/** DSH's registry supplies parent identity and running, not a complete task roster
 * or a terminal outcome. Never turn idle/removal into completed (S33 / SC52). */
export function dshAgentTasks(
  rootId: string, rows: ReadonlyMap<string, Row>, previous?: AgentTaskInventory,
  titleOf: (id: string, row: Row) => string | null | undefined = () => undefined,
): AgentTaskInventory {
  const known = new Map((previous?.items ?? []).map(item => [item.id, { ...item, status: "unknown" as const }]));
  const belongs = (row: Row): boolean => {
    const seen = new Set([row.sessionId]);
    let parent = row.parentSessionId;
    while (typeof parent === "string" && !seen.has(parent)) {
      if (parent === rootId) return true;
      seen.add(parent); parent = rows.get(parent)?.parentSessionId;
    }
    return false;
  };
  const items = new Map<string, AgentTask>(known);
  for (const row of rows.values()) {
    if (row.origin !== "subagent" || row.sessionId === rootId || (!belongs(row) && !items.has(row.sessionId))) continue;
    if (!validId(row.sessionId) || !validId(row.parentSessionId)) continue;
    const title = titleOf(row.sessionId, row);
    items.set(row.sessionId, { id: row.sessionId,
      ...(row.parentSessionId === rootId ? {} : { parentId: row.parentSessionId }),
      title: title?.trim().slice(0, 80) || items.get(row.sessionId)?.title || "Subagent", kind: "subagent",
      status: row.agentAvailable === true && typeof row.running === "boolean" ? row.running ? "running" : "idle" : "unknown" });
  }
  // Registry membership does not prove task coverage, including external runners.
  return agentTaskInventory([...items.values()], "unknown", items.size > 0);
}
