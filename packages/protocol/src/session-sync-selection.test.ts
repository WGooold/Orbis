import { describe, expect, it } from "vitest";
import { RuntimeCommandSchema, RuntimeEventSchema, type RemoteSessionEntry, type SessionAppliedState } from "./index.js";
import { selectSessionSyncSnapshot, SESSION_SYNC_PAGE_BYTES, SESSION_SYNC_WRAPPER_BYTES } from "./session-sync.js";

const entries = (count: number): RemoteSessionEntry[] => Array.from({ length: count }, (_, index) => ({
  entryId: `${index + 1}`, parentId: index === 0 ? null : `${index}`, type: "message", timestamp: "1",
  data: { message: { role: "user", content: "history" } },
}));
const source = (seq = 10, head: string | null = "100") => ({
  version: { epoch: "epoch", seq, ready: true },
  checkpoint: { checkpointId: `epoch:${seq}`, head: { leafId: head }, headCompleteness: "complete" as const, inventoryComplete: true },
  live: { complete: true, turn: null, messages: [], tools: [] },
});
const known = (seq = 10, head: string | null = "100"): SessionAppliedState => ({ epoch: "epoch", seq, head: { leafId: head } });
const request = { sessionId: "s", syncId: "sync", range: "preview" as const, maxEntries: 30 };

describe("Host-selected preview content", () => {
  it("acknowledges an unchanged baseline without old history, timings or live bodies", () => {
    const state = source();
    const withHugeLive = { ...state, live: { ...state.live, messages: [{
      message: { messageId: "live", role: "assistant" as const, content: [{ type: "text" as const, text: "x".repeat(2_000_000) }], timestamp: 1 },
      finished: false, contentComplete: true,
    }] } };
    const response = selectSessionSyncSnapshot(entries(100), "s", "100", { ...request, knownState: known() },
      [{ turnId: "old", startedAt: 1, durationMs: 2 }], withHugeLive);
    expect(response).toMatchObject({ selection: "unchanged", mode: "append", entries: [], turnTimings: [], complete: true });
    expect(response.live).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1_000);
    expect(RuntimeEventSchema.safeParse(response).success).toBe(true);
  });

  it("returns the current live checkpoint when seq changes at the same historical head", () => {
    const state = source(11);
    const live = { ...state.live, tools: [{ toolCallId: "tool", toolName: "bash", state: "finished" as const }] };
    const response = selectSessionSyncSnapshot(entries(100), "s", "100", { ...request, knownState: known() },
      [{ turnId: "old", startedAt: 1, durationMs: 2 }], { ...state, live });
    expect(response).toMatchObject({ selection: "state", mode: "append", entries: [], turnTimings: [], live, complete: true });
    expect(RuntimeEventSchema.safeParse(response).success).toBe(true);
  });

  it("sends exactly the missing canonical suffix and checkpoint", () => {
    const tree = entries(103);
    const response = selectSessionSyncSnapshot(tree, "s", "103", { ...request, knownState: known() }, [], source(13, "103"));
    expect(response).toMatchObject({ selection: "delta", mode: "append", entries: tree.slice(100), complete: true });
    expect(RuntimeEventSchema.safeParse(response).success).toBe(true);
  });

  it("can append from an applied empty history", () => {
    expect(selectSessionSyncSnapshot(entries(2), "s", "2", { ...request, knownState: known(0, null) }, [], source(2, "2")))
      .toMatchObject({ selection: "delta", entries: entries(2), complete: true });
    expect(selectSessionSyncSnapshot([], "s", null, { ...request, knownState: known(1, null) }, [], source(1, null)))
      .toMatchObject({ selection: "unchanged", entries: [] });
  });

  it("recovers a bounded tail after rewind, epoch change, future watermark or missing baseline", () => {
    for (const baseline of [undefined, { ...known(), epoch: "old" }, known(20), known(9, "deleted"), known(10, "99")]) {
      const response = selectSessionSyncSnapshot(entries(100), "s", "100", { ...request, knownState: baseline }, [], source());
      expect(response.selection).toBe("snapshot");
      expect(response.entries.map(entry => entry.entryId)).toEqual(entries(100).slice(70).map(entry => entry.entryId));
    }
  });

  it("does not suppress content from unversioned, unknown or incomplete source state", () => {
    const state = source();
    const cases = [undefined, { ...state, version: { ...state.version, ready: false } },
      { ...state, checkpoint: { ...state.checkpoint, headCompleteness: "unknown" as const } },
      { ...state, checkpoint: { ...state.checkpoint, inventoryComplete: false }, live: { ...state.live, complete: false } },
      { ...state, checkpoint: { ...state.checkpoint, head: { leafId: "other" } } }];
    for (const value of cases) {
      expect(selectSessionSyncSnapshot(entries(100), "s", "100", { ...request, knownState: known() }, [], value).selection)
        .toBe("snapshot");
    }
    expect(selectSessionSyncSnapshot(entries(100).slice(1), "s", "100", { ...request, knownState: known() }, [], state))
      .toMatchObject({ selection: "snapshot", rangeStatus: "missing_parent", entries: [] });
  });

  it("uses a bounded recovery snapshot if the suffix exceeds the count or byte budget", () => {
    const response = selectSessionSyncSnapshot(entries(140), "s", "140", { ...request, knownState: known() }, [], source(50, "140"));
    expect(response).toMatchObject({ selection: "snapshot", complete: false });
    expect(response.entries.map(entry => entry.entryId)).toEqual(entries(140).slice(110).map(entry => entry.entryId));
    const tree = entries(103).map(entry => ({ ...entry, data: { text: "x".repeat(100_000) } }));
    const bounded = selectSessionSyncSnapshot(tree, "s", "103", { ...request, knownState: known() }, [], source(13, "103"));
    expect(bounded).toMatchObject({ selection: "snapshot", complete: false });
    expect(Buffer.byteLength(JSON.stringify(bounded)) + SESSION_SYNC_WRAPPER_BYTES).toBeLessThanOrEqual(SESSION_SYNC_PAGE_BYTES);
  });

  it("rejects malformed conditional responses and unknown acknowledgement fields", () => {
    const unchanged = selectSessionSyncSnapshot(entries(100), "s", "100", { ...request, knownState: known() }, [], source());
    expect(RuntimeEventSchema.safeParse({ ...unchanged, entries: entries(1) }).success).toBe(false);
    expect(RuntimeEventSchema.safeParse({ ...unchanged, live: source().live }).success).toBe(false);
    expect(RuntimeEventSchema.safeParse({ ...unchanged, selection: "state" }).success).toBe(false);
    expect(RuntimeEventSchema.safeParse({ ...unchanged, complete: false }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({ type: "session.sync", ...request, range: "history", knownState: known() }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({ type: "session.sync", ...request, knownState: { ...known(), received: true } }).success).toBe(false);
    expect(() => selectSessionSyncSnapshot(entries(100), "s", "100", { ...request, range: "history", knownState: known() }))
      .toThrow("session_known_state_range_mismatch");
  });
});
