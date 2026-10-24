import { describe, expect, it } from "vitest";
import { RecoverableSessionSource, type ChatMessage, type RemoteSessionEntry, type SessionPatch } from "./index.js";
import { SESSION_SYNC_MAX_BYTES, SESSION_SYNC_PAGE_BYTES, selectSessionSyncSnapshot } from "./session-sync.js";
import { SESSION_SYNC_WRAPPER_BYTES } from "./session-sync.js";

const message: ChatMessage = { messageId: "live", role: "assistant", timestamp: 1, content: [{ type: "text", text: "answer" }] };
const entry: RemoteSessionEntry = { entryId: "entry", parentId: null, type: "message", timestamp: new Date(1).toISOString(), data: { message } };

describe("recoverable source", () => {
  it("never serves an unpublished state under an already-published seq", () => {
    // 现场：流式输出期间 Host 每 10–50 秒拒收一条 preview，原因码 `same_seq_state_mismatch`。
    // 触发条件是 live 装不进页预算：`#flush` 回滚了 seq，但状态已经改过；`snapshot()` 仍返回
    // 当前状态，于是同一个 seq 带着两份不同的 head/live 出去。Host 侧的正确行为是拒绝。
    const patches: SessionPatch[] = [];
    const source = new RecoverableSessionSource("session", patch => patches.push(patch));
    source.setAvailability(true, true);
    source.observe({ type: "turn.started", turnId: "t1", startedAt: 1 });
    // 每条约 200KB、截断后仍有 64KB；12 条超过 512KB 的页预算，必须回滚。
    for (let index = 0; index < 12; index += 1) {
      source.observe({ type: "tool.started", toolCallId: `c${index}`, toolName: "bash", arguments: { text: "x".repeat(200_000) } });
    }
    const published = patches.at(-1)!;
    // 同步响应用 published()：对外只能看到已发布的那一版，seq、head、live 必须逐字段一致。
    const wire = source.published();
    expect(wire.version).toMatchObject({ seq: published.seq, ready: true });
    expect(wire.checkpoint.head).toEqual(published.head);
    expect(wire.live).toEqual(published.live);
    // 源端自身的原文不受影响：需要全文时仍从 snapshot()/entry() 取。
    expect(source.snapshot().live.tools.length).toBe(12);
  });

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

  // ADR-0038：装不下的 live 不再静默丢弃——按线路预算截断后照常发布，
  // 并且版本只在真正发布时推进（否则 seq 缺口会让 Host 永久拒绝后续增量）。
  it("truncates an oversize live patch and keeps version continuity", () => {
    const patches: SessionPatch[] = [];
    const source = new RecoverableSessionSource("session", patch => patches.push(patch));
    source.setAvailability(true, true);
    source.transaction(() => source.reconcile([entry], entry.entryId));
    patches.length = 0;
    const before = source.snapshot().version;
    const big = { content: [{ type: "text", text: "y".repeat(SESSION_SYNC_MAX_BYTES) }] };
    source.observe({ type: "tool.finished", toolCallId: "c1", toolName: "read", result: big, isError: false });

    const published = patches.at(-1);
    expect(published).toBeDefined();
    expect(published!.baseSeq).toBe(before.seq);
    expect(published!.seq).toBe(before.seq + 1);
    expect(JSON.stringify(published!.live)).toContain("已截断");
    expect(Buffer.byteLength(JSON.stringify(published)) + SESSION_SYNC_WRAPPER_BYTES)
      .toBeLessThanOrEqual(SESSION_SYNC_PAGE_BYTES);
    // 源端仍保留完整原文（截断只发生在发给设备的载荷上）。
    expect(source.snapshot().live.tools[0]?.detail).toEqual(big);
  });
});

// ADR-0035 §15：合并流式发布（默认关闭）。seq 仍然只在真正发布时前进，序列保持连续。
describe("coalesced publishing", () => {
  it("publishes one patch per window and keeps the sequence contiguous", async () => {
    const patches: SessionPatch[] = [];
    const source = new RecoverableSessionSource("session", patch => patches.push(patch), { coalesceMs: 20 });
    source.setAvailability(true, true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const before = source.snapshot().version;
    patches.length = 0;
    for (let index = 0; index < 5; index += 1) {
      source.upsertMessage({
        message: { messageId: "m", role: "assistant", timestamp: 1, content: [{ type: "text", text: "x".repeat(index + 1) }] },
        finished: false, contentComplete: true,
      });
      expect(patches).toHaveLength(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.baseSeq).toBe(before.seq);
    expect(patches[0]!.seq).toBe(before.seq + 1);
  });
});
