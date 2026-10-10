import { describe, expect, it } from "vitest";
import { RecoverableSessionSource, type ChatMessage, type RemoteSessionEntry, type SessionPatch } from "./index.js";
import { selectSessionSyncSnapshot } from "./session-sync.js";

const message: ChatMessage = { messageId: "live", role: "assistant", timestamp: 1, content: [{ type: "text", text: "answer" }] };
const entry: RemoteSessionEntry = { entryId: "entry", parentId: null, type: "message", timestamp: new Date(1).toISOString(), data: { message } };

describe("recoverable source", () => {
  it("hands a live reply to canonical storage atomically and recovers the same partition without lifecycle replay", () => {
    const patches: SessionPatch[] = [];
    const source = new RecoverableSessionSource("session", patch => patches.push(patch));
    source.setAvailability(true, true);
    source.observe({ type: "message.started", message: { ...message, content: [] } });
    source.observe({ type: "message.finished", message });
    // Finished does not mean persisted. A sync in this window must keep the final body.
    expect(source.snapshot().live.messages).toMatchObject([{ finished: true, message }]);
    const beforeCommit = source.snapshot();
    source.transaction(() => {
      source.reconcile([entry], entry.entryId, [{ messageId: "live", entryId: "entry" }]);
    });
    const commit = patches.at(-1)!;
    expect(commit.entries).toEqual([entry]);
    expect(commit.live.messages).toEqual([]);
    expect(beforeCommit.live.messages).toHaveLength(1); // Captured response cannot mutate after commit.
    const recovered = selectSessionSyncSnapshot([entry], "session", "entry", { sessionId: "session", syncId: "recover", range: "preview" }, [], source.snapshot());
    expect(recovered.entries).toEqual([entry]);
    expect(recovered.live?.messages).toEqual([]);
    const version = source.snapshot().version;
    source.reconcile([entry], "entry");
    expect(source.snapshot().version).toEqual(version);
    source.setAvailability(false, false);
    expect(source.snapshot().checkpoint.inventoryComplete).toBe(false);
  });

  it("invalidates a corrected or rewound native history rather than confirming an old applied baseline", () => {
    const patches: SessionPatch[] = [];
    const source = new RecoverableSessionSource("session", patch => patches.push(patch));
    source.transaction(() => { source.reconcile([entry], "entry"); source.setAvailability(true, true); });
    const old = source.snapshot();
    const corrected = { ...entry, data: { message: { ...message, content: [{ type: "text", text: "corrected" }] } } };
    source.reconcile([corrected], "entry");
    expect(source.snapshot().version.epoch).not.toBe(old.version.epoch);
    expect(patches.some(patch => !patch.source.ready)).toBe(true);
    const result = selectSessionSyncSnapshot([corrected], "session", "entry", { sessionId: "session", syncId: "recovery", range: "preview", knownState: { epoch: old.version.epoch, seq: old.version.seq, head: old.checkpoint.head } }, [], source.snapshot());
    expect(result.selection).toBe("snapshot");
    expect(result.entries).toEqual([corrected]);
  });
});
