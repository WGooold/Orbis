import { describe, expect, it } from "vitest";
import {
  RuntimeEventSchema, selectSessionSyncSnapshot, SESSION_SYNC_MAX_BYTES, SESSION_SYNC_PAGE_BYTES,
  SESSION_SYNC_WRAPPER_BYTES, type RemoteSessionEntry, type RuntimeTurnTiming,
} from "./index.js";

const entries = (count: number, text = ""): RemoteSessionEntry[] => Array.from({ length: count }, (_, index) => ({
  entryId: String(index + 1), parentId: index === 0 ? null : String(index),
  type: "message", timestamp: "2026-09-21T00:00:00.000Z", data: { text },
}));
const request = { sessionId: "s", syncId: "request", maxEntries: 3 };

describe("bounded Session ranges", () => {
  it("pages backwards for display and forwards for catchup on a fixed branch", () => {
    const tree = [...entries(11), { ...entries(1)[0]!, entryId: "sibling", parentId: "3" }];
    const preview = selectSessionSyncSnapshot(tree, "s", "11", { ...request, range: "preview", targetLeafId: "10" });
    expect(preview).toMatchObject({ mode: "replace", targetLeafId: "10", hasOlder: true, complete: false });
    expect(preview.entries.map((entry) => entry.entryId)).toEqual(["8", "9", "10"]);
    const history = selectSessionSyncSnapshot(tree, "s", "11", { ...request, range: "history", targetLeafId: "10", beforeEntryId: "8" });
    expect(history).toMatchObject({ mode: "prepend", beforeEntryId: "8", rangeStatus: "older_available" });
    expect(history.entries.map((entry) => entry.entryId)).toEqual(["5", "6", "7"]);
    const collected: RemoteSessionEntry[] = [];
    let knownLeafId: string | null = null;
    for (let page = 0; page < 4; page++) {
      const snapshot = selectSessionSyncSnapshot(tree, "s", "11", { ...request, range: "catchup", targetLeafId: "10", knownLeafId });
      expect(RuntimeEventSchema.safeParse(snapshot).success).toBe(true);
      collected.push(...snapshot.entries);
      knownLeafId = snapshot.entries.at(-1)?.entryId ?? null;
      expect(snapshot.complete).toBe(page === 3);
    }
    expect(collected).toEqual(tree.slice(0, 10));
    const fork = selectSessionSyncSnapshot(tree, "s", "sibling", { ...request, range: "catchup", knownLeafId: "10" });
    expect(fork).toMatchObject({ mode: "append", complete: true });
    expect(fork.entries.map((entry) => entry.entryId)).toEqual(["sibling"]);
  });

  it.each(["preview", "history", "catchup"] as const)("enforces UTF-8 response budgets for %s without changing nodes", (range) => {
    const tree = entries(50, "中文🙂".repeat(10_000));
    const snapshot = selectSessionSyncSnapshot(tree, "s", "50", { ...request, maxEntries: 100, range });
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.entries.length).toBeLessThan(50);
    expect(Buffer.byteLength(JSON.stringify(snapshot)) + SESSION_SYNC_WRAPPER_BYTES).toBeLessThanOrEqual(SESSION_SYNC_PAGE_BYTES);
    for (const entry of snapshot.entries) expect(entry).toEqual(tree[Number(entry.entryId) - 1]);
    expect(snapshot.complete).toBe(false);
  });

  it("sends a single large Entry intact and fails at an unsendable Entry rather than skipping it", () => {
    const tree = entries(2, "x".repeat(400_000));
    const snapshot = selectSessionSyncSnapshot(tree, "s", "2", { ...request, range: "catchup" });
    expect(snapshot.entries).toEqual([tree[0]]);
    expect(snapshot.complete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(snapshot)) + SESSION_SYNC_WRAPPER_BYTES).toBeLessThanOrEqual(SESSION_SYNC_MAX_BYTES);
    tree[1]!.data = { text: "x".repeat(SESSION_SYNC_MAX_BYTES) };
    expect(() => selectSessionSyncSnapshot(tree, "s", "2", { ...request, range: "catchup", knownLeafId: "1" }))
      .toThrow("session_entry_too_large");
  });

  it("pages anchored timing with its Entries and includes metadata in the byte limit", () => {
    const tree = entries(4);
    const timing = (id: string): RuntimeTurnTiming => ({ turnId: `turn-${id}`, messageId: id, startedAt: 1, durationMs: 2 });
    const snapshot = selectSessionSyncSnapshot(tree, "s", "4", { ...request, maxEntries: 1, range: "preview" }, [timing("1"), timing("4")]);
    expect(snapshot.turnTimings).toEqual([timing("4")]);
    const hugeMetadata = Array.from({ length: 6000 }, (_, index) => ({ turnId: `turn-${index}`, startedAt: 1, durationMs: 2 }));
    expect(() => selectSessionSyncSnapshot(tree, "s", "4", { ...request, range: "preview" }, hugeMetadata))
      .toThrow("session_metadata_too_large");
  });

  it("rejects missing ranges, bad identity, duplicate nodes and invalid limits", () => {
    expect(() => selectSessionSyncSnapshot([], "s", null, request)).toThrow("session_sync_range_required");
    expect(() => selectSessionSyncSnapshot([], "other", null, { ...request, range: "preview" })).toThrow("session_mismatch");
    expect(() => selectSessionSyncSnapshot([...entries(1), ...entries(1)], "s", "1", { ...request, range: "preview" })).toThrow("duplicate_entry_id");
    expect(() => selectSessionSyncSnapshot(entries(1), "s", "1", { ...request, range: "preview", maxEntries: 0 })).toThrow("invalid_max_entries");
  });

  it("never reports missing ancestors, cycles or invalid history boundaries as a complete range", () => {
    const tree = entries(3);
    tree[0]!.parentId = "3";
    expect(selectSessionSyncSnapshot(tree, "s", "3", { ...request, range: "catchup" }))
      .toMatchObject({ entries: [], complete: false, rangeStatus: "cycle_detected" });
    expect(selectSessionSyncSnapshot(entries(3).slice(1), "s", "3", { ...request, range: "preview" }))
      .toMatchObject({ entries: [], complete: false, rangeStatus: "missing_parent" });
    expect(selectSessionSyncSnapshot(entries(3), "s", "missing", { ...request, range: "preview" }))
      .toMatchObject({ complete: false, rangeStatus: "leaf_not_found" });
    expect(selectSessionSyncSnapshot(entries(3), "s", "3", { ...request, range: "history", beforeEntryId: "sibling" }))
      .toMatchObject({ entries: [], complete: false, rangeStatus: "range_start_not_found" });
    expect(selectSessionSyncSnapshot([], "s", null, { ...request, range: "preview" }))
      .toMatchObject({ entries: [], complete: true, rangeStatus: "complete" });
  });

  it("carries display results for exactly the entries in each page", () => {
    const tree: RemoteSessionEntry[] = [1, 2, 3, 4, 5].map((index) => ({
      entryId: String(index), parentId: index === 1 ? null : String(index - 1), type: "message",
      timestamp: "2026-09-21T00:00:00.000Z",
      data: { message: { role: index % 2 === 1 ? "user" : "assistant", content: `第 ${index} 句` } },
    }));
    const preview = selectSessionSyncSnapshot(tree, "s", "5", { ...request, range: "preview", targetLeafId: "5" });
    expect(preview.entries.map((entry) => entry.entryId)).toEqual(["3", "4", "5"]);
    expect(preview.display?.entries.map((item) => item.displayId)).toEqual(["3", "4", "5"]);
    expect(preview.display?.entries[0]?.message?.content).toEqual([{ type: "text", text: "第 3 句" }]);
    expect(preview.display?.windowStart).toBeNull();
    expect(RuntimeEventSchema.safeParse(preview).success).toBe(true);
    const history = selectSessionSyncSnapshot(tree, "s", "5", {
      ...request, range: "history", targetLeafId: "5", beforeEntryId: "3",
    });
    expect(history.entries.map((entry) => entry.entryId)).toEqual(["1", "2"]);
    expect(history.display?.entries.map((item) => item.displayId)).toEqual(["1", "2"]);
    // 没有条目就没有批次：ack/状态页不该为一无所有的一页付出显示投影的开销。
    const empty = selectSessionSyncSnapshot([], "s", null, { ...request, range: "preview" });
    expect(empty.display).toBeUndefined();
  });

  it("branch is incomplete: no display batch, unless the native boundary is verified", () => {
    const tree: RemoteSessionEntry[] = [1, 2, 3].map((index) => ({
      entryId: String(index), parentId: index === 1 ? "native-tail" : String(index - 1), type: "message",
      timestamp: "2026-09-21T00:00:00.000Z",
      data: { message: { role: "user", content: `第 ${index} 句` } },
    }));
    const partial = selectSessionSyncSnapshot(tree, "s", "3", { ...request, range: "preview", targetLeafId: "3" });
    expect(partial.rangeStatus).toBe("missing_parent");
    expect(partial.entries).toEqual([]);
    expect(partial.display).toBeUndefined();
    const source = {
      version: { epoch: "e1", seq: 1, ready: true },
      checkpoint: { checkpointId: "e1:1", head: { leafId: "3" }, headCompleteness: "complete" as const, inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] },
    };
    const bounded = selectSessionSyncSnapshot(tree, "s", "3", { ...request, range: "preview", targetLeafId: "3" },
      [], source, "native-tail");
    // 已验证的边界让这一页成为自洽的前缀（祖先链到此为止），但边界之外仍有更旧的内容。
    expect(bounded).toMatchObject({ rangeStatus: "limit_reached", hasOlder: true, complete: false });
    expect(bounded.entries.map((entry) => entry.entryId)).toEqual(["1", "2", "3"]);
    expect(bounded.display?.entries.map((item) => item.displayId)).toEqual(["1", "2", "3"]);
  });

  it("carries a source version and recoverable live state independently of transport sequence", () => {
    const snapshot = selectSessionSyncSnapshot(entries(1), "s", "1", {
      ...request, range: "preview",
    }, [], {
      version: { epoch: "codex-epoch-7", seq: 42, ready: true },
      checkpoint: { checkpointId: "codex-epoch-7:42", head: { leafId: "1" }, headCompleteness: "complete", inventoryComplete: true },
      live: {
        complete: true,
        turn: { turnId: "turn-1", startedAt: 10 },
        messages: [{
          message: { messageId: "live-1", role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 10 },
          finished: false,
          contentComplete: false,
        }],
        tools: [],
      },
    });
    expect(snapshot.source).toEqual({ epoch: "codex-epoch-7", seq: 42, ready: true });
    expect(snapshot.checkpoint?.inventoryComplete).toBe(true);
    expect(snapshot.live?.messages[0]?.message.messageId).toBe("live-1");
    expect(RuntimeEventSchema.safeParse(snapshot).success).toBe(true);
  });
});
