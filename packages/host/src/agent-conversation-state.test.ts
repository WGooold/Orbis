import { describe, expect, it } from "vitest";
import { RuntimeEventSchema, type AgentExecutionState, type RuntimeEvent } from "@pi-remote/protocol";
import { AgentConversationState } from "./agent-conversation-state.js";
import { AgentStateFacts } from "./agent-state-facts.js";
import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";

const scope: StateScope = { kind: "agent", key: { hostId: "h", agentKind: "pi", sessionId: "s" } };
const snapshot = (epoch = "e", seq = 1): Extract<RuntimeEvent, { type: "session.snapshot" }> => ({
  type: "session.snapshot", sessionId: "s", syncId: "sync", range: "preview", cursor: { leafId: "a" }, mode: "replace", entries: [],
  source: { epoch, seq, ready: true }, checkpoint: { checkpointId: "c", head: { leafId: "a" }, headCompleteness: "complete", inventoryComplete: true },
  live: { complete: true, turn: { turnId: "turn", startedAt: 1 }, messages: [{ finished: true, contentComplete: true, message: { messageId: "m", role: "assistant", content: [{ type: "text", text: "finished but not persisted" }], timestamp: 1 } }], tools: [] },
});
describe("Host conversation projection", () => {
  it("commits history and complete recoverable live inventory atomically", () => {
    const registry = new AgentStateRegistry(); const model = new AgentConversationState(registry);
    const observed: unknown[] = [];
    registry.subscribe(() => { observed.push({ history: registry.read(scope, "history")?.availability, live: registry.read(scope, "live")?.value, baseline: model.hasBaseline(scope) }); });
    expect(model.accept(scope, snapshot())).toBe(true);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(value => JSON.stringify(value) === JSON.stringify({ history: "ready", live: snapshot().live, baseline: true }))).toBe(true);
    expect(model.hasBaseline(scope)).toBe(true);
  });
  it("rejects old sequences and retired epochs, and never lets history paging change head/live", () => {
    const registry = new AgentStateRegistry(); const model = new AgentConversationState(registry);
    expect(model.accept(scope, snapshot("e", 3))).toBe(true);
    expect(model.accept(scope, snapshot("e", 2))).toBe(false);
    const page = { ...snapshot("e", 1), range: "history" as const, checkpoint: undefined, live: undefined, cursor: { leafId: "old" } };
    expect(model.accept(scope, page)).toBe(true);
    expect(registry.read<{ head: { leafId: string } }>(scope, "history")?.value?.head.leafId).toBe("a");
    expect(model.accept(scope, snapshot("replacement", 0))).toBe(true);
    expect(model.accept(scope, snapshot("e", 999))).toBe(false);
  });
  it("does not publish a partial transaction when a live inventory exceeds budget", () => {
    const registry = new AgentStateRegistry({ maxValueBytes: 400 }); const model = new AgentConversationState(registry);
    const event = snapshot(); event.live!.messages[0]!.message.content = [{ type: "text", text: "x".repeat(800) }];
    expect(model.accept(scope, event)).toBe(false);
    expect(registry.snapshot(scope)).toEqual([]);
  });
  it("rejects missing patch bases and cross-session writes, bounds history pages", () => {
    const registry = new AgentStateRegistry(); const model = new AgentConversationState(registry);
    model.accept(scope, snapshot());
    expect(model.accept(scope, { ...snapshot(), sessionId: "another" })).toBe(false);
    const initial = snapshot();
    expect(model.accept(scope, { type: "session.patch", sessionId: "s", source: { epoch: "e", seq: 5, ready: true },
      baseSeq: 3, seq: 5, checkpointId: "p", head: { leafId: "a" }, headCompleteness: "complete", live: initial.live! })).toBe(false);
    for (let i = 0; i < 100; i++) model.accept(scope, { ...initial, range: "history", checkpoint: undefined, live: undefined, syncId: `page${i}`, beforeEntryId: `before${i}` });
    expect(model.stats().pages).toBe(64);
    expect(model.stats().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("never lets a patch become a baseline, even when the source has not pushed a snapshot yet", () => {
    const registry = new AgentStateRegistry(), model = new AgentConversationState(registry);
    const patch: Extract<RuntimeEvent, { type: "session.patch" }> = { type: "session.patch", sessionId: "s", source: { epoch: "e", seq: 1, ready: true }, baseSeq: 0, seq: 1, checkpointId: "p", head: { leafId: "a" }, headCompleteness: "complete", live: snapshot().live! };
    // Codex and DSH publish patches before any snapshot: content keeps flowing, the model stays unreconciled.
    expect(model.accept(scope, patch)).toBe(true);
    expect(model.hasBaseline(scope)).toBe(false);
    expect(registry.read(scope, "live")?.availability).toBe("unknown");
    expect(registry.read(scope, "history")).toMatchObject({ availability: "unknown" });
    expect(model.recover(scope, { type: "session.sync", sessionId: "s", syncId: "unreconciled", range: "preview" })).toBeUndefined();
    // The next patch continues the handshake; a gap still requires the source to re-baseline.
    expect(model.accept(scope, { ...patch, source: { epoch: "e", seq: 2, ready: true }, baseSeq: 1, seq: 2 })).toBe(true);
    expect(model.accept(scope, { ...patch, source: { epoch: "e", seq: 3, ready: true }, baseSeq: 1, seq: 3 })).toBe(false);
    expect(model.accept(scope, snapshot("e", 4))).toBe(true);
    expect(model.hasBaseline(scope)).toBe(true);
    const unknown = { ...patch, source: { epoch: "new", seq: 1, ready: false }, headCompleteness: "unknown" as const, live: { ...patch.live, complete: false } };
    expect(model.accept(scope, unknown)).toBe(true);
    expect(registry.read(scope, "live")).toMatchObject({ availability: "unknown", source: { sourceEpoch: "new" } });
    expect(model.hasBaseline(scope)).toBe(false);
    expect(model.accept(scope, snapshot("e", 999))).toBe(false);
    expect(model.accept(scope, { ...patch, source: { epoch: "new", seq: 2, ready: true }, baseSeq: 1, seq: 2 })).toBe(true);
    expect(model.hasBaseline(scope)).toBe(false);
    expect(model.accept(scope, snapshot("new", 2))).toBe(true);
  });

  it("does not advertise offline cache as a current baseline, even for a conditional client", () => {
    const registry = new AgentStateRegistry(), model = new AgentConversationState(registry);
    model.accept(scope, snapshot()); model.offline(scope);
    expect(model.hasBaseline(scope)).toBe(false);
    expect(model.recover(scope, { type: "session.sync", sessionId: "s", syncId: "after", range: "preview", knownState: { epoch: "e", seq: 1, head: { leafId: "a" } } })).toBeUndefined();
    expect(model.accept(scope, { ...snapshot(), selection: "unchanged", mode: "append", live: undefined })).toBe(false);
    expect(model.accept(scope, snapshot())).toBe(true);
  });

  it("records artifact references from the canonical display and keeps them after live is gone", () => {
    const registry = new AgentStateRegistry(), model = new AgentConversationState(registry);
    const report = { artifactId: "11111111-1111-4111-8111-111111111111", fileName: "report.pdf",
      mimeType: "application/pdf", size: 42, sha256: "a".repeat(64) };
    const chart = { artifactId: "22222222-2222-4222-8222-222222222222", fileName: "chart.png",
      mimeType: "image/png", size: 7, sha256: "b".repeat(64) };
    const entry = (id: string) => ({ entryId: id, parentId: id === "a" ? null : "a", type: "message",
      timestamp: "2026-01-01T00:00:00.000Z", data: { message: { role: "tool", content: [] } } });
    const event = snapshot();
    event.entries = [entry("a"), entry("b")];
    event.display = {
      projectionVersion: 2, windowStart: null, entries: [
        { displayId: "a", entryId: "a", nativeType: "message", kind: "message", reason: null,
          message: { messageId: "a", role: "tool", timestamp: 1, content: [{ type: "artifact", artifact: report }] } },
        { displayId: "b", entryId: "b", nativeType: "message", kind: "message", reason: null,
          message: { messageId: "b", role: "assistant", timestamp: 2, content: [{ type: "text", text: "done" }] } },
      ],
    };
    event.live = { complete: true, turn: null, tools: [], messages: [{ finished: false, contentComplete: true,
      message: { messageId: "live-row", role: "assistant", timestamp: 3, content: [{ type: "artifact", artifact: chart }] } }] };
    expect(model.accept(scope, event)).toBe(true);
    const references = () => registry.read<Record<string, { messageId: string }>>(scope, "artifacts")?.value ?? {};
    // Canonical display and live inventory are two sources of the same reference index.
    expect(Object.keys(references())).toEqual([report.artifactId, chart.artifactId]);
    expect(references()[report.artifactId]?.messageId).toBe("a");

    // A later page (or a snapshot whose live is empty) must not drop references that already arrived.
    const page = { ...snapshot("e", 1), range: "history" as const, checkpoint: undefined, live: undefined,
      entries: [], display: undefined, cursor: { leafId: "a" } };
    expect(model.accept(scope, page)).toBe(true);
    expect(model.accept(scope, { ...snapshot("e", 2), selection: "state", mode: "append", entries: [], display: undefined, live: { complete: true, turn: null, messages: [], tools: [] } })).toBe(true);
    expect(Object.keys(references())).toEqual([report.artifactId, chart.artifactId]);
  });

  it("serves a first preview with canonical entries and their supplied display at the same capture", () => {
    const registry = new AgentStateRegistry(), model = new AgentConversationState(registry);
    const event = snapshot(); event.entries = [{ entryId: "a", parentId: null, type: "native", timestamp: "now", data: {} }];
    event.display = { projectionVersion: 2, windowStart: null, entries: [{ displayId: "a", entryId: "a", nativeType: "native", kind: "message", message: event.live!.messages[0]!.message, reason: null }] };
    expect(model.accept(scope, event)).toBe(true);
    const result = model.recover(scope, { type: "session.sync", sessionId: "s", syncId: "first", range: "preview" });
    expect(result).toMatchObject({ syncId: "first", selection: "snapshot", mode: "replace", entries: event.entries, display: event.display, live: event.live, complete: true });
    expect(RuntimeEventSchema.safeParse(result).success).toBe(true);
    const duplicate = { ...event, syncId: "again" }; model.accept(scope, duplicate);
    expect(model.stats().pages).toBe(1);
  });

  it("commits the execution turn and recovery cache before publishing the conversation change", () => {
    const registry = new AgentStateRegistry(), model = new AgentConversationState(registry);
    const facts = new AgentStateFacts({ registry, hostId: "h", kindOf: () => "pi" });
    facts.observe("r", { type: "runtime.metadata", metadata: { runtimeId: "r", name: "Pi", cwd: "D:/repo", status: "running", sessionId: "s" } });
    const observed: unknown[] = [];
    registry.subscribe(change => { if (change.kind === "committed") observed.push({ turn: registry.read<AgentExecutionState>(scope, "execution")?.value?.turn, live: registry.read<{ turn: unknown }>(scope, "live")?.value?.turn, baseline: model.hasBaseline(scope) }); });
    const event = snapshot();
    expect(model.accept(scope, event, ready => facts.prepareConversation("r", event, ready))).toBe(true);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(value => JSON.stringify(value) === JSON.stringify({ turn: event.live!.turn, live: event.live!.turn, baseline: true }))).toBe(true);
    facts.observe("r", { type: "turn.started", turnId: "late", startedAt: 999 });
    expect(registry.read<AgentExecutionState>(scope, "execution")?.value?.turn).toEqual(event.live!.turn);
    model.offline(scope, facts.prepareOffline("r"));
    expect(registry.read(scope, "execution")?.availability).toBe("unknown");
    expect(registry.read(scope, "live")?.availability).toBe("unknown");
  });

  it("keeps an authoritative runtime status while a new conversation baseline is incomplete", () => {
    const registry = new AgentStateRegistry(), model = new AgentConversationState(registry);
    const facts = new AgentStateFacts({ registry, hostId: "h", kindOf: () => "pi" });
    facts.observe("r", { type: "runtime.metadata", metadata: { runtimeId: "r", name: "Pi", cwd: "D:/repo", status: "running", sessionId: "s" } });
    const state = registry.read<AgentExecutionState>(scope, "execution");
    expect(state?.availability).toBe("ready");
    const incomplete = { ...snapshot(), cursor: { leafId: null }, source: { epoch: "new", seq: 1, ready: false },
      checkpoint: { checkpointId: "new:1", head: { leafId: null }, headCompleteness: "unknown" as const, inventoryComplete: false },
      live: { complete: false, turn: null, messages: [], tools: [] } };
    expect(model.accept(scope, incomplete, ready => facts.prepareConversation("r", incomplete, ready))).toBe(true);
    expect(registry.read<AgentExecutionState>(scope, "execution")).toEqual(state);
    expect(registry.read(scope, "history")?.availability).toBe("unknown");
  });

  it("does not reset a new session's execution on successive handshake patches before its first preview", () => {
    const registry = new AgentStateRegistry(), model = new AgentConversationState(registry);
    const facts = new AgentStateFacts({ registry, hostId: "h", kindOf: () => "pi" });
    facts.observe("r", { type: "runtime.metadata", metadata: { runtimeId: "r", name: "Pi", cwd: "D:/repo", status: "running", sessionId: "s" } });
    const patch: Extract<RuntimeEvent, { type: "session.patch" }> = {
      type: "session.patch", sessionId: "s", source: { epoch: "e", seq: 1, ready: true }, baseSeq: 0, seq: 1,
      checkpointId: "e:1", head: { leafId: null }, headCompleteness: "complete", live: snapshot().live!,
    };
    expect(model.accept(scope, patch, ready => facts.prepareConversation("r", patch, ready))).toBe(true);
    expect(model.hasBaseline(scope)).toBe(false);
    expect(registry.read<AgentExecutionState>(scope, "execution")).toMatchObject({ availability: "ready", value: { phase: "running" } });
    facts.observe("r", { type: "runtime.status", status: "idle" });
    const settled = { ...patch, source: { epoch: "e", seq: 2, ready: true }, baseSeq: 1, seq: 2,
      live: { complete: true, turn: null, messages: [], tools: [] } };
    expect(model.accept(scope, settled, ready => facts.prepareConversation("r", settled, ready))).toBe(true);
    expect(registry.read<AgentExecutionState>(scope, "execution")).toMatchObject({ availability: "ready", value: { phase: "idle" } });
    const preview = { ...snapshot("e", 2), cursor: { leafId: null },
      checkpoint: { checkpointId: "e:2", head: { leafId: null }, headCompleteness: "complete" as const, inventoryComplete: true }, live: settled.live };
    expect(model.accept(scope, preview, ready => facts.prepareConversation("r", preview, ready))).toBe(true);
    expect(model.hasBaseline(scope)).toBe(true);
    expect(registry.read<AgentExecutionState>(scope, "execution")).toMatchObject({ availability: "ready", value: { phase: "idle", turn: null } });
  });

  it("rolls back companion accumulators and versions when any conversation value is rejected", () => {
    const registry = new AgentStateRegistry({ maxValueBytes: 800 }), model = new AgentConversationState(registry);
    const facts = new AgentStateFacts({ registry, hostId: "h", kindOf: () => "pi" });
    facts.observe("r", { type: "runtime.metadata", metadata: { runtimeId: "r", name: "Pi", cwd: "D:/repo", status: "running", sessionId: "s" } });
    const before = registry.snapshot(scope), event = snapshot(); event.live!.messages[0]!.message.content = [{ type: "text", text: "x".repeat(1000) }];
    expect(model.accept(scope, event, ready => facts.prepareConversation("r", event, ready))).toBe(false);
    expect(registry.snapshot(scope)).toEqual(before);
    facts.observe("r", { type: "runtime.status", status: "idle" });
    expect(registry.read<AgentExecutionState>(scope, "execution")?.value?.turn).toBeNull();
  });

  it("bounds current sessions and bytes, marks over-budget captures unknown, and releases on reset/end", () => {
    const registry = new AgentStateRegistry(), model = new AgentConversationState(registry, { maxCurrentSessions: 1, maxCurrentBytes: 1500, maxPageBytes: 1000 });
    expect(model.accept(scope, snapshot())).toBe(true);
    const otherScope: StateScope = { kind: "agent", key: { hostId: "h", agentKind: "pi", sessionId: "other" } };
    expect(model.accept(otherScope, { ...snapshot(), sessionId: "other" })).toBe(false);
    const large = snapshot("e", 2); large.live!.messages[0]!.message.content = [{ type: "text", text: "x".repeat(2000) }];
    expect(model.accept(scope, large)).toBe(true);
    expect(registry.read(scope, "live")?.availability).toBe("unknown");
    expect(model.stats().currentBytes).toBeLessThanOrEqual(1500);
    registry.endScope(scope); expect(model.stats().currentSessions).toBe(0);
    model.accept(scope, snapshot()); registry.beginModelEpoch();
    expect(model.stats()).toEqual({ pages: 0, bytes: 0, currentSessions: 0, currentBytes: 0 });
  });

  // ADR-0039 §2/§3：entries 以冻结的引用进入权威模型（不再深拷贝），live 保持可变。
  it("freezes accepted entries and keeps live mutable", () => {
    const registry = new AgentStateRegistry(); const model = new AgentConversationState(registry);
    const entry = { entryId: "a", parentId: null, type: "message", timestamp: "t",
      data: { message: { messageId: "a", role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } } };
    const event = { ...snapshot(), mode: "append" as const, cursor: { leafId: "a" }, entries: [entry] };
    expect(model.accept(scope, event)).toBe(true);

    // 冻结发生在**传入的那个对象**上：adapter 事后原地改写会抛错，而不是静默分叉。
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.data.message.content)).toBe(true);
    expect(() => { (entry.data.message.content[0] as { text: string }).text = "changed"; }).toThrow(TypeError);

    // 被拒绝的改写没有留下痕迹，权威模型仍是原文。
    expect(entry.data.message.content[0]).toEqual({ type: "text", text: "hello" });
    // 同 id、内容被改写（换新对象）必须被拒，否则模型会静默分叉。
    const changed = { ...entry, data: { message: { ...entry.data.message, content: [{ type: "text", text: "changed" }] } } };
    expect(model.accept(scope, { ...event, entries: [changed as unknown as typeof entry] })).toBe(false);

    // live 不能冻结：DSH/DSH-Web 的流式累加依赖原地 push。
    const live = registry.read<{ messages: Array<{ message: { content: unknown[] } }> }>(scope, "live")?.value;
    expect(Object.isFrozen(live)).toBe(false);
    expect(() => { live!.messages[0]!.message.content.push({ type: "text", text: "more" }); }).not.toThrow();
  });

  // ADR-0038 §8：按需取回未截断的原始条目（线路投影里它可能被截断）。
  it("serves the untruncated entry on demand", () => {
    const registry = new AgentStateRegistry(); const model = new AgentConversationState(registry);
    const entry = { entryId: "a", parentId: null, type: "message", timestamp: "t",
      data: { message: { messageId: "a", role: "user", content: [{ type: "text", text: "x".repeat(200_000) }], timestamp: 1 } } };
    expect(model.accept(scope, { ...snapshot(), mode: "append" as const, cursor: { leafId: "a" }, entries: [entry] })).toBe(true);
    const full = model.entry(scope, "a");
    expect(full?.entryId).toBe("a");
    // 原文完整保留，逐字一致（截断只发生在发给设备的载荷上）。
    expect(JSON.stringify(full)).toContain("x".repeat(1000));
    expect(model.entry(scope, "missing")).toBeUndefined();
  });
});
