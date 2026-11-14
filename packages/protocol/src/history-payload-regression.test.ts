import { describe, expect, it } from "vitest";
import {
  RecoverableSessionSource, RuntimeEventSchema, selectSessionSyncSnapshot, truncateWireEntry,
  SESSION_SYNC_PAGE_BYTES, SESSION_SYNC_WRAPPER_BYTES,
  type RemoteSessionEntry, type SessionPatch,
} from "./index.js";

const entry = (id: string, parentId: string | null, data: Record<string, unknown>, type = "message"): RemoteSessionEntry => ({
  entryId: id, parentId, type, timestamp: "2026-11-14T00:00:00.000Z", data,
});
const message = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });
const read = (tree: RemoteSessionEntry[], range: "preview" | "history" | "catchup" = "preview", beforeEntryId?: string) =>
  selectSessionSyncSnapshot(tree, "s", tree.at(-1)!.entryId, { sessionId: "s", syncId: "read", range, maxEntries: 1,
    ...(beforeEntryId === undefined ? {} : { beforeEntryId }) });
const bounded = (value: unknown) => {
  expect(RuntimeEventSchema.safeParse(value).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(value)) + SESSION_SYNC_WRAPPER_BYTES).toBeLessThanOrEqual(SESSION_SYNC_PAGE_BYTES);
};

// FT-G12-PAYLOAD-01: a truncated wire page must leave the deployed App's full-entry action reachable.
describe("history payload release regressions", () => {
  it.each(["text", "thinking", "native-thinking", "string", "summary"])("retains full-content markers for %s", shape => {
    const text = "回复🙂".repeat(12_000);
    const data = shape === "summary" ? { summary: text } : { message: { role: "assistant", content:
      shape === "string" ? text : [{ type: shape === "text" ? "text" : "thinking",
        ...(shape === "native-thinking" ? { thinking: text } : { text }) }] } };
    const original = entry("long", null, data, shape === "summary" ? "branch_summary" : "message");
    const page = read([original]); bounded(page);
    expect(page.display?.entries[0]?.message?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ truncated: true, originalBytes: expect.any(Number) }),
    ]));
    expect(page.display?.entries[0]?.message?.messageId).toBe(original.entryId);
    expect(truncateWireEntry(page.entries[0]!)).toEqual(page.entries[0]);
    expect(JSON.stringify(original.data)).toContain(text);
  });

  // FT-G12-PAYLOAD-02: live and canonical text share a page but cannot starve each other or drift at the same seq.
  it.each([28_000, 62_000, 200_000])("opens and reconciles a long head during %i bytes of streaming", bytes => {
    const patches: SessionPatch[] = [];
    const source = new RecoverableSessionSource("s", patch => patches.push(patch));
    const head = entry("head", null, message("p".repeat(200_000)));
    source.transaction(() => { source.reconcile([head], head.entryId); source.setAvailability(true, true); });
    const before = source.published();
    source.upsertMessage({ message: { messageId: "stream", role: "assistant", timestamp: 1,
      content: [{ type: "thinking", text: "x".repeat(bytes) }] }, finished: false, contentComplete: true });
    const current = source.published();
    for (const knownState of [undefined, { epoch: before.version.epoch, seq: before.version.seq, head: before.checkpoint.head }]) {
      const page = selectSessionSyncSnapshot([head], "s", head.entryId,
        { sessionId: "s", syncId: "live", range: "preview", ...(knownState ? { knownState } : {}) }, [], current);
      bounded(page);
      expect(page.live).toEqual(patches.at(-1)!.live);
      expect(page.live?.messages[0]?.message.messageId).toBe("stream");
    }
    expect(source.snapshot().live.messages[0]?.message.content[0]).toMatchObject({ text: "x".repeat(bytes) });
  });

  // FT-G12-PAYLOAD-03: a wide/deep native record must neither block the newest page nor strand its ancestors.
  it.each(["wide", "deep", "compaction", "parallel-tools"])("pages across a %s entry without losing identity", shape => {
    let data: Record<string, unknown>;
    if (shape === "deep") {
      let nested: unknown = "x".repeat(80_000);
      for (let depth = 0; depth < 12; depth++) nested = { nested };
      data = { ...message("answer"), nested };
    } else if (shape === "compaction") {
      data = { summary: "summary", firstKeptEntryId: "root", details: {
        readFiles: Array.from({ length: 1200 }, (_, i) => `/project/${i}/${"path".repeat(30)}`),
      } };
    } else if (shape === "parallel-tools") {
      data = { message: { role: "assistant", content: Array.from({ length: 80 }, (_, i) => ({ type: "toolCall",
        id: `tool-${i}`, name: "bash", arguments: { command: "echo x;".repeat(150) } })) } };
    } else data = { ...message("answer"), details: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`f${i}`, "short field".repeat(4)])) };
    const root = entry("root", null, message("root"));
    const large = entry("large", "root", data, shape === "compaction" ? "compaction" : "message");
    const tail = entry("tail", "large", message("tail"));
    for (const page of [read([root, large]), read([root, large, tail], "history", "tail")]) {
      bounded(page);
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0]).toMatchObject({ entryId: "large", parentId: "root", type: large.type, timestamp: large.timestamp });
      expect(truncateWireEntry(page.entries[0]!)).toEqual(page.entries[0]);
      if (shape === "compaction") expect(page.display?.windowStart).toBe("root");
    }
    expect(read([root, large, tail], "history", "large").entries[0]?.entryId).toBe("root");
  });

  // FT-G12-PAYLOAD-04: a single long reply uses the same deterministic projection in patch and recovery.
  it.each([40_000, 200_000])("commits %i bytes without replacing the source epoch", size => {
    const patches: SessionPatch[] = [];
    const source = new RecoverableSessionSource("s", patch => patches.push(patch));
    const root = entry("root", null, message("root"));
    source.transaction(() => { source.reconcile([root], "root"); source.setAvailability(true, true); });
    const before = source.version;
    const reply = entry("reply", "root", message("x".repeat(size)));
    source.reconcile([root, reply], "reply");
    expect(source.version).toEqual({ ...before, seq: before.seq + 1 });
    const patch = patches.at(-1)!; bounded(patch);
    expect(source.entry("reply")).toBe(reply);
    const page = read([root, reply]);
    expect(patch.entries).toEqual(page.entries);
    expect(patch.display?.entries).toEqual(page.display?.entries);
  });
});
