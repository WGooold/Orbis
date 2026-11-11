import { open } from "node:fs/promises";
import type { TurnConfiguration } from "@orbis/protocol";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** S52: read only the native-owned path and exact thread/turn. Bounded I/O, no history scan.
 * A context outside the tail budget stays unknown; settings snapshots cannot fill that gap. */
export async function readCodexTurnConfiguration(path: string, threadId: string, turnId: string): Promise<TurnConfiguration | undefined> {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const head = Buffer.alloc(Math.min(size, 128 * 1024));
    const header = await file.read(head, 0, head.length, 0);
    const firstLine = head.subarray(0, header.bytesRead).toString("utf8").split("\n")[0];
    const meta = object(JSON.parse(firstLine ?? "{}"));
    const identity = object(meta.payload);
    if (meta.type !== "session_meta" || identity.id !== threadId) return;
    const start = Math.max(0, size - 2 * 1024 * 1024);
    const tail = Buffer.alloc(size - start);
    const read = await file.read(tail, 0, tail.length, start);
    const lines = tail.subarray(0, read.bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    // A partially appended line is not yet an execution fact.
    lines.pop();
    for (let i = lines.length - 1; i >= 0; i--) {
      let row: Record<string, unknown>;
      try { row = object(JSON.parse(lines[i]!)); } catch { continue; }
      if (row.type !== "turn_context") continue;
      const context = object(row.payload);
      if (context.turn_id !== turnId || typeof context.model !== "string" || !context.model || context.model.length > 256) continue;
      const provider = context.model_provider ?? identity.model_provider;
      if (typeof provider !== "string" || !provider || provider.length > 128) return;
      const effort = context.effort;
      return { turnId, model: { provider, id: context.model },
        ...(effort === null || typeof effort === "string" && effort.length > 0 && effort.length <= 64 ? { thinkingLevel: effort } : {}) };
    }
  } finally { await file.close(); }
}
