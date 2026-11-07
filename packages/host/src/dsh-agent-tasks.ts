import type { AgentTask, AgentTaskInventory } from "@orbis/protocol";
import { agentTaskInventory } from "./agent-tasks.js";

type Row = Record<string, unknown> & { sessionId: string };

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
    if (!row.sessionId.trim() || typeof row.parentSessionId !== "string" || !row.parentSessionId.trim() || row.sessionId.length > 256 || row.parentSessionId.length > 256) continue;
    const title = titleOf(row.sessionId, row);
    items.set(row.sessionId, { id: row.sessionId,
      ...(row.parentSessionId === rootId ? {} : { parentId: row.parentSessionId }),
      title: title?.trim().slice(0, 80) || items.get(row.sessionId)?.title || "Subagent", kind: "subagent",
      status: row.agentAvailable === true && typeof row.running === "boolean" ? row.running ? "running" : "idle" : "unknown" });
  }
  // Registry membership does not prove task coverage, including external runners.
  return agentTaskInventory([...items.values()], "unknown", items.size > 0);
}
