import { describe, expect, it } from "vitest";
import { RecoverableSessionSource, type ChatMessage, type RemoteSessionEntry, type SessionPatch } from "./index.js";
import { SESSION_SYNC_PAGE_BYTES, selectSessionSyncSnapshot } from "./session-sync.js";

const message: ChatMessage = { messageId: "live", role: "assistant", timestamp: 1, content: [{ type: "text", text: "answer" }] };
const entry: RemoteSessionEntry = { entryId: "entry", parentId: null, type: "message", timestamp: new Date(1).toISOString(), data: { message } };

describe("recoverable source", () => {
  it("retains confirmed turn timing through recovery until the next turn starts", () => {
    const source = new RecoverableSessionSource("session", () => undefined);
    source.setAvailability(true, true);
    source.observe({ type: "turn.started", turnId: "t1", startedAt: 100 });
    source.observe({ type: "turn.finished", turnId: "t1", startedAt: 100, durationMs: 75 });
    expect(source.snapshot().live.turn).toEqual({ turnId: "t1", startedAt: 100, durationMs: 75 });
    source.observe({ type: "turn.started", turnId: "t2", startedAt: 200 });
    expect(source.snapshot().live.turn).toEqual({ turnId: "t2", startedAt: 200 });
  });
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

  // ADR-0035 §12：净效果为零的事务（只翻标量）不能推进 seq——客户端的 knownState 依赖它。
  it("does not advance the version when a transaction's net effect is zero", () => {
    const patches: SessionPatch[] = [];
    const source = new RecoverableSessionSource("session", patch => patches.push(patch));
    source.setAvailability(true, true);
    const before = source.snapshot().version;
    patches.length = 0;
    source.transaction(() => {
      source.setAvailability(false, false);
      source.setAvailability(true, true);
    });
    expect(source.snapshot().version).toEqual(before);
    expect(patches).toHaveLength(0);
    // 真实写入必须推进：抑制不能变成漏发。
    source.observe({ type: "turn.started", turnId: "t2", startedAt: 2 });
    expect(source.snapshot().version.seq).toBe(before.seq + 1);
  });

  // ADR-0035 §13/§14：装不下的 live 不发 patch，也不推进版本——否则 seq 缺口会让 Host
  // 永久拒绝后续增量（现场是每秒两条 Rejected conversation transaction）。
  it("skips an oversize live patch without opening a version gap", () => {
    const patches: SessionPatch[] = [];
    const source = new RecoverableSessionSource("session", patch => patches.push(patch));
    source.setAvailability(true, true);
    source.transaction(() => source.reconcile([entry], entry.entryId));
    patches.length = 0;
    const before = source.snapshot().version;
    const big = { content: [{ type: "text", text: "y".repeat(SESSION_SYNC_PAGE_BYTES) }] };
    source.observe({ type: "tool.finished", toolCallId: "c1", toolName: "read", result: big, isError: false });
    expect(patches).toHaveLength(0);
    expect(source.snapshot().version).toEqual(before);
    expect(source.snapshot().live.tools[0]?.detail).toEqual(big);
    // live 缩小之后，下一条 patch 必须严格衔接上一个已发布版本。
    source.replaceLive({ complete: true, turn: null, messages: [], tools: [] });
    const published = patches.at(-1);
    expect(published).toBeDefined();
    expect(published!.baseSeq).toBe(before.seq);
    expect(published!.seq).toBe(before.seq + 1);
  });
});