import { describe, expect, it, vi } from "vitest";
import { RuntimeEventSchema, isToolSummaryProjection, type RuntimeEvent, type SessionSyncRequest } from "@orbis/protocol";
import { KimiConversation, kimiItemId } from "./kimi-conversation.js";

const agent = { hostId: "fixture-host", agentKind: "kimiCode" as const, sessionId: "kimi-code:root:session_demo" };
const time = "2026-11-19T05:00:00.000Z";
const item = (id: string, type = "assistant_message", extra = {}) => ({ item_id: id, type, status: "ended", created_at: time, text: id, ...extra });
const turn = (id: string, ordinal: number, items = [item("reply")], extra = {}) => ({ turn_id: id, ordinal, kind: "agent", status: "ended",
  started_at: time, ended_at: time, outcome: "completed", items, ...extra });
const setup = (request: (path: string) => Promise<unknown> = async () => { throw Error("unexpected_native_read"); }) => {
  const events: RuntimeEvent[] = [];
  const source = new KimiConversation({ agent: () => agent, nativeId: "session_demo", client: { requestJson: <T>(path: string) => request(path) as Promise<T> },
    emit: event => { RuntimeEventSchema.parse(event); expect(isToolSummaryProjection(event)).toBe(true); events.push(event); } });
  const sync = async (overrides: Partial<SessionSyncRequest> = {}) => {
    const result = await source.sync({ type: "session.sync", syncId: "sync", sessionId: agent.sessionId, range: "preview", ...overrides });
    if (result.type !== "session.snapshot") throw Error("expected snapshot");
    RuntimeEventSchema.parse(result); expect(isToolSummaryProjection(result)).toBe(true); return result;
  };
  return { events, source, sync };
};

describe("KIMI-03 native conversation source", () => {
  it("joins paged and streamed items through stable parents and retains native terminal outcome", async () => {
    const request = vi.fn(async (path: string) => path.includes("before_ordinal=2")
      ? { turns: [turn("older", 1)], has_more: true }
      : { turns: [turn("oldest", 0)], has_more: false });
    const { events, source, sync } = setup(request);
    source.frame({ type: "turns", turns: [turn("recent", 2)], has_more: true });
    const first = await sync();
    expect(first.hasOlder).toBe(true);
    expect(first.cursor.leafId).toBe(kimiItemId("recent", "reply"));
    const active = turn("live", 3, [], { status: "running" });
    source.frame({ type: "turn.started", turn: active });
    source.frame({ type: "item.started", turn_id: "live", item: item("reply", "assistant_message", { status: "running", text: "chunk" }) });
    const pending = sync({ range: "history", beforeEntryId: first.entries[0]!.entryId });
    source.frame({ type: "item.delta", turn_id: "live", item_id: "reply", field: "text", delta: "-end" });
    const history = await pending;
    expect(history.range).toBe("history");
    // A page fills the synthetic parent pointer without rewriting an already-issued native entry.
    expect(history.entries.map(entry => entry.entryId).filter(id => id.startsWith("kimi-item:")))
      .toEqual([kimiItemId("oldest", "reply"), kimiItemId("older", "reply")]);
    expect(history.entries.every((entry, index) => entry.parentId === (history.entries[index - 1]?.entryId ?? null))).toBe(true);
    expect(history.entries.at(-1)?.entryId).toBe(first.entries[0]?.parentId);
    expect(request).toHaveBeenCalledTimes(2);
    expect(source.epoch).toBe(first.source!.epoch);
    const live = await sync();
    expect(live.live?.messages[0]?.message.content).toEqual([{ type: "text", text: "chunk-end" }]);
    source.frame({ type: "item.ended", turn_id: "live", item: item("reply", "assistant_message", { text: "canonical" }) });
    const { items: omitted, ...end } = turn("live", 3, [], { outcome: "interrupted", end_reason: "aborted" });
    expect(omitted).toEqual([]);
    source.frame({ type: "turn.ended", turn: end });
    const finished = await sync();
    expect(finished.live?.messages).toEqual([]);
    expect(finished.live?.turn?.outcome).toBe("cancelled");
    expect(finished.entries.filter(entry => entry.entryId === kimiItemId("live", "reply"))).toHaveLength(1);
    expect(finished.entries.find(entry => entry.entryId === first.cursor.leafId)?.parentId).toBe(first.entries[0]?.parentId);
    expect(events.some(event => event.type === "session.patch")).toBe(true);
  });

  it("drops a late page after undo and refuses malformed baselines or unknown mutations", async () => {
    let finish!: (result: unknown) => void;
    const request = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const { source, sync } = setup(request);
    source.frame({ type: "turns", turns: [turn("removed", 1)], has_more: true });
    const wait = sync({ range: "history", beforeEntryId: kimiItemId("removed", "reply") });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    source.frame({ type: "turns.removed", turn_ids: ["removed"] });
    expect(source.ready).toBe(false);
    source.frame({ type: "turns", turns: [turn("replacement", 1)], has_more: false });
    finish({ turns: [turn("old", 0)], has_more: false });
    await expect(wait).rejects.toThrow("来源已变化");
    const next = await sync();
    expect(next.entries.map(value => value.entryId)).toEqual([kimiItemId("replacement", "reply")]);
    source.frame({ type: "turn.unknown", turn_id: "replacement" });
    expect(source.ready).toBe(false);
    source.frame({ type: "turns", turns: [turn("bad", 2, [], { truncated: true })], has_more: false });
    expect(source.ready).toBe(false);
    const failed = source.waitForBaseline();
    source.frame({ type: "turns.failed" });
    await expect(failed).rejects.toThrow("尚未同步");
  });

  it("keeps the live tool identity when Kimi revises its provisional timestamp at approval", async () => {
    const { source, sync } = setup();
    source.frame({ type: "turns", turns: [], has_more: false });
    source.frame({ type: "turn.started", turn: turn("active", 0, [], { status: "running" }) });
    source.frame({ type: "item.started", turn_id: "active", item: item("tool", "tool_call", { status: "running", name: "Bash", stage: "input", input_text: "{}" }) });
    source.frame({ type: "item.updated", turn_id: "active", item_id: "tool", set: {
      created_at: "2026-11-19T05:00:01.000Z", stage: "awaiting_approval", interaction_id: "approval_fixture",
    } });
    expect(source.ready).toBe(true);
    const id = kimiItemId("active", "tool");
    expect((await sync()).live?.toolInventory).toBeDefined();
    expect(source.toolPart({ projectionVersion: 1, tool: { agent, toolCallId: id }, part: "arguments" })).toEqual({ format: "text", value: "{}" });
  });

  it("keeps reasoning, tool failure and large tool output separate from the shared transcript", async () => {
    const { source, sync, events } = setup();
    const large = "fixture-private-output ".repeat(8000);
    source.frame({ type: "turns", has_more: false, turns: [turn("with-tool", 1, [
      item("thinking", "reasoning"), item("tool", "tool_call", { name: "Read", outcome: "failed", error: large, input: { path: "a.txt" } }),
    ], { outcome: "failed" })] });
    const result = await sync();
    expect(result.display?.entries[0]?.message?.content[0]?.type).toBe("thinking");
    expect(result.live?.turn?.outcome).toBe("failed");
    expect(result.display?.entries[1]?.message?.toolSummary).toMatchObject({ isError: true, phase: "finished" });
    expect(JSON.stringify([result, ...events])).not.toContain("fixture-private-output");
    const locator = { projectionVersion: 1 as const, tool: { agent, toolCallId: kimiItemId("with-tool", "tool") }, part: "result" as const };
    expect(source.toolPart(locator)).toEqual({ format: "text", value: large });
    source.invalidate();
    expect(source.toolPart(locator)).toBeUndefined();
  });
});
