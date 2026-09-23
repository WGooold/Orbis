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
});
