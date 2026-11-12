import { codexChildThread } from "./codex-agent-tasks.js";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const sourceKinds = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];

/** SC83: prove the native descendant filter before trusting an empty list. Older
 * serde servers silently ignore unknown fields. The documented mutually-exclusive
 * filter rejection proves both fields are understood, without creating a thread.
 * A connection owns this cache; reconnects must negotiate again. */
export class CodexTaskRegistry {
  #support: Promise<boolean> | undefined;
  constructor(private readonly request: Request) {}

  async #supported(): Promise<boolean> {
    return this.#support ??= (async () => {
      try {
        const id = "00000000-0000-0000-0000-000000000000";
        await this.request("thread/list", { parentThreadId: id, ancestorThreadId: id, limit: 1 });
        return false;
      } catch (error) {
        if (error instanceof Error && error.message.includes("parentThreadId and ancestorThreadId are mutually exclusive")) return true;
        // Transport failures and unknown rejections are not capability evidence.
        this.#support = undefined;
        return false;
      }
    })();
  }

  async read(rootId: string): Promise<unknown[]> {
    if (!await this.#supported()) throw new Error("codex_task_registry_unsupported");
    const first = await this.#scan(rootId), second = await this.#scan(rootId);
    // Pagination is not an atomic snapshot. Check membership/ancestry twice;
    // native lifecycle events are additionally guarded by the task generation.
    const signature = (rows: unknown[]) => JSON.stringify(rows.map(row => {
      const child = codexChildThread(row)!; return [child.id, child.parentId];
    }).sort((a, b) => a[0]!.localeCompare(b[0]!)));
    if (signature(first) !== signature(second)) throw new Error("codex_task_registry_changed");
    return second;
  }

  async #scan(rootId: string): Promise<unknown[]> {
    const rows = new Map<string, unknown>();
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = object(await this.request("thread/list", { ancestorThreadId: rootId, archived,
          sourceKinds, modelProviders: [], sortKey: "created_at", sortDirection: "asc", limit: 64,
          ...(cursor === undefined ? {} : { cursor }) }));
        if (!Array.isArray(page.data) || page.nextCursor != null && (typeof page.nextCursor !== "string" || !page.nextCursor)) throw new Error("codex_task_registry_invalid_page");
        for (const value of page.data) {
          const child = codexChildThread(value);
          if (!child || rows.has(child.id) || child.id === rootId || !["idle", "active", "notLoaded", "systemError"].includes(String(object(child.status).type))) throw new Error("codex_task_registry_invalid_child");
          rows.set(child.id, value);
          if (rows.size > 256) throw new Error("codex_task_registry_overflow");
        }
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
        if (cursor !== undefined) {
          if (cursors.has(cursor) || cursors.size >= 256) throw new Error("codex_task_registry_invalid_cursor");
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
    }
    // A filtered response from an incompatible implementation must never grant
    // close admission. Every descendant needs a finite path to this exact root.
    for (const value of rows.values()) {
      let child = codexChildThread(value)!;
      const seen = new Set([child.id]);
      while (child.parentId !== rootId) {
        const parent = codexChildThread(rows.get(child.parentId));
        if (!parent || seen.has(parent.id)) throw new Error("codex_task_registry_invalid_ancestry");
        seen.add(parent.id); child = parent;
      }
    }
    return [...rows.values()];
  }
}
