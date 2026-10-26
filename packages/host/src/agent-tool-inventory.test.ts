import { afterEach, describe, expect, it } from "vitest";
import {
  TOOL_PAGE_BODY_MAX_BYTES, ToolInventoryReceiver, createToolSummary, toolJsonBytes,
  type AgentKey, type RuntimeEvent, type ToolInventoryPatch, type ToolInventoryReadRequest,
  type ToolInventorySnapshot, type ToolSummary,
} from "@orbis/protocol";
import { AgentConversationState } from "./agent-conversation-state.js";
import { AgentStateRegistry, commitPreparedRegistryTransaction, type PreparedRegistryCommit, type StateScope } from "./agent-state-registry.js";
import { AgentToolInventory, type ToolInventoryLimits } from "./agent-tool-inventory.js";

const agent: AgentKey = { hostId: "host", agentKind: "codex", sessionId: "session" };
const scope: StateScope = { kind: "agent", key: agent };
const source = (seq = 1, epoch = "source") => ({ epoch, seq });
const tool = (index: number, over: Partial<ToolSummary> = {}): ToolSummary => ({ ...createToolSummary({
  tool: { agent, toolCallId: "tool-" + index }, toolName: "exec", phase: "running", order: index, contents: [],
}), ...over });
const owners: AgentToolInventory[] = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); });
function setup(limits: Partial<ToolInventoryLimits> = {}, now?: () => number) {
  const registry = new AgentStateRegistry(), inventory = new AgentToolInventory(registry, { limits, ...(now ? { now } : {}) });
  owners.push(inventory); return { registry, inventory };
}
function baseline(inventory: AgentToolInventory, tools: ToolSummary[], seq = 1, epoch = "source") {
  const plan = inventory.prepare({ agent, runtimeId: "runtime", source: source(seq, epoch), update: { kind: "baseline", tools } });
  expect(inventory.commit(plan).ok).toBe(true); return plan;
}
function request(snapshot: ToolInventorySnapshot, cursor: string | null = null, maxItems = 128): ToolInventoryReadRequest {
  return { type: "session.tools.read", requestId: "request", runtimeId: "runtime", snapshot, cursor, maxItems };
}

describe("bounded Host tool inventory (ADR-0045)", () => {
  it("pages 900 summaries above the Registry single-value limit without losing any tool", () => {
    const { registry, inventory } = setup();
    const summaries = Array.from({ length: 900 }, (_, i) => tool(i, { inputSummary: { text: "x".repeat(1024), originalBytes: 1024, omitted: false } }));
    baseline(inventory, summaries);
    expect(inventory.stats().bytes).toBeGreaterThan(1024 * 1024);
    expect(toolJsonBytes(registry.read(scope, "tools")?.value)).toBeLessThan(1024);
    const snapshot = inventory.openSnapshot("device", agent, "runtime");
    let cursor: string | null = null, pages = 0; const received: ToolSummary[] = [];
    do {
      const page = inventory.read("device", request(snapshot, cursor));
      expect(toolJsonBytes(page)).toBeLessThanOrEqual(TOOL_PAGE_BODY_MAX_BYTES);
      expect(page.startIndex).toBe(received.length); received.push(...page.tools); cursor = page.nextCursor; pages++;
    } while (cursor);
    expect(pages).toBeGreaterThan(10); expect(received).toEqual(summaries);
  });

  it("pins opaque-cursor pages while later changes update the current inventory", () => {
    const { inventory } = setup(); baseline(inventory, [tool(0), tool(1), tool(2)]);
    const snapshot = inventory.openSnapshot("device", agent, "runtime");
    const first = inventory.read("device", request(snapshot, null, 1));
    const plan = inventory.prepare({ agent, runtimeId: "runtime", source: source(2), update: { kind: "patch", upserts: [tool(3)], removes: ["tool-1"] } });
    expect(plan.publication?.type).toBe("session.tools.patch"); expect(inventory.commit(plan).ok).toBe(true);
    expect(inventory.read("device", request(snapshot, first.nextCursor, 2)).tools.map(t => t.order)).toEqual([1, 2]);
    const current = inventory.openSnapshot("device", agent, "runtime");
    expect(inventory.read("device", request(current)).tools.map(t => t.order)).toEqual([0, 2, 3]);
    expect(() => inventory.read("other-device", request(snapshot))).toThrow("scope_mismatch");
    expect(() => inventory.read("device", request(snapshot, "invented"))).toThrow("invalid_cursor");
  });

  it("keeps revision stable for unchanged checks and finished tools until explicit removal", () => {
    const { registry, inventory } = setup(); const first = baseline(inventory, [tool(0, { phase: "finished" })]);
    const before = registry.read(scope, "tools")?.revision;
    const heartbeat = inventory.prepare({ agent, runtimeId: "runtime", source: source(2), update: { kind: "patch", upserts: [tool(0, { phase: "finished" })], removes: [] } });
    expect(heartbeat.publication).toBeNull(); expect(heartbeat.reference).toEqual(first.reference);
    expect(inventory.commit(heartbeat).ok).toBe(true); expect(registry.read(scope, "tools")?.revision).toBe(before);
    expect(registry.read(scope, "tools")?.source.sourceRevision).toBe(2); expect(inventory.stats().tools).toBe(1);
    expect(() => inventory.prepare({ agent, runtimeId: "runtime", source: source(2), update: { kind: "patch", upserts: [tool(0)], removes: [] } })).toThrow("source_conflict");
    const remove = inventory.prepare({ agent, runtimeId: "runtime", source: source(3), update: { kind: "patch", upserts: [], removes: ["tool-0"] } });
    expect(inventory.commit(remove).ok).toBe(true); expect(inventory.reference(agent)?.totalCount).toBe(0);
  });

  it("emits a baseline notice for an atomic mutation exceeding delta item limits", () => {
    const { inventory } = setup(); baseline(inventory, []);
    const plan = inventory.prepare({ agent, runtimeId: "runtime", source: source(2), update: { kind: "patch", upserts: Array.from({ length: 200 }, (_, i) => tool(i)), removes: [] } });
    expect(plan.publication?.type).toBe("session.tools.changed"); expect(inventory.commit(plan).ok).toBe(true);
    expect(inventory.reference(agent)?.totalCount).toBe(200);
  });

  it("rejects overflow, duplicate identities, stale epochs and missing baselines without mutation", () => {
    const { inventory } = setup({ maxToolsPerSession: 2, maxTools: 2 }); baseline(inventory, [tool(0)]);
    const prepare = (tools: ToolSummary[], seq = 2, epoch = "source") => inventory.prepare({ agent, runtimeId: "runtime", source: source(seq, epoch), update: { kind: "baseline", tools } });
    expect(() => prepare([tool(0), tool(1), tool(2)])).toThrow("inventory_limit");
    expect(() => prepare([tool(0), tool(0)])).toThrow("invalid_inventory"); expect(inventory.stats().tools).toBe(1);
    expect(inventory.commit(prepare([], 0, "replacement")).ok).toBe(true);
    expect(() => prepare([], 999)).toThrow("stale_source");
    expect(() => inventory.prepare({ agent: { ...agent, sessionId: "new" }, runtimeId: "runtime", source: source(), update: { kind: "patch", upserts: [], removes: [] } })).toThrow("source_baseline_required");
  });

  it("expires bounded leases and cleans device, session and model state", () => {
    let time = 0; const { registry, inventory } = setup({ maxSnapshots: 1, snapshotTtlMs: 100 }, () => time);
    baseline(inventory, [tool(0)]); const snapshot = inventory.openSnapshot("device", agent, "runtime");
    expect(() => inventory.openSnapshot("other", agent, "runtime")).toThrow("busy");
    time = 100; expect(() => inventory.read("device", request(snapshot))).toThrow("snapshot_expired");
    inventory.openSnapshot("device", agent, "runtime"); inventory.closeOwner("device"); expect(inventory.stats().snapshots).toBe(0);
    inventory.openSnapshot("device", agent, "runtime"); registry.endScope(scope);
    expect(inventory.stats()).toEqual({ sessions: 0, tools: 0, bytes: 0, snapshots: 0, snapshotBytes: 0 });
    const prepared = inventory.prepare({ agent, runtimeId: "runtime", source: source(), update: { kind: "baseline", tools: [] } });
    registry.beginModelEpoch(); expect(inventory.commit(prepared)).toMatchObject({ ok: false, detail: "stale_prepared_state" });
  });

  it("rolls back owners on rejection and rejects stale or duplicate prepared owners", () => {
    const { registry, inventory } = setup(); const plan = inventory.prepare({ agent, runtimeId: "runtime", source: source(), update: { kind: "baseline", tools: [tool(0)] } });
    let swapped = false;
    const invalid: PreparedRegistryCommit = { changes: [{ kind: "value", scope, domain: "execution", fact: {
      availability: "ready", completeness: "complete", source: { producer: "adapter", sourceId: "a", sourceEpoch: "e", sourceRevision: 1 }, value: "x".repeat(1024 * 1024),
    } }], onCommitted: () => { swapped = true; } };
    expect(inventory.commit(plan, [invalid]).ok).toBe(false); expect(swapped).toBe(false);
    expect(inventory.reference(agent)).toBeUndefined(); expect(registry.snapshot(scope)).toEqual([]);
    expect(commitPreparedRegistryTransaction(registry, [plan, plan])).toMatchObject({ ok: false, detail: "duplicate_prepared_owner" });
    const newer = inventory.prepare({ agent, runtimeId: "runtime", source: source(), update: { kind: "baseline", tools: [] } });
    expect(inventory.commit(newer).ok).toBe(true); expect(inventory.commit(plan)).toMatchObject({ ok: false, detail: "stale_prepared_state" });
  });

  it("commits canonical Entry, head and inventory removal as one observable transaction", () => {
    const { registry, inventory } = setup(); const conversation = new AgentConversationState(registry);
    const live = { complete: true, turn: null, messages: [], tools: [] };
    const initial: Extract<RuntimeEvent, { type: "session.snapshot" }> = { type: "session.snapshot", sessionId: agent.sessionId,
      syncId: "s", range: "preview", cursor: { leafId: null }, mode: "replace", entries: [], source: { ...source(), ready: true },
      checkpoint: { checkpointId: "c", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true }, live };
    const first = inventory.prepare({ agent, runtimeId: "runtime", source: source(), update: { kind: "baseline", tools: [tool(0, { phase: "finished" })] } });
    expect(conversation.accept(scope, initial, ready => ready ? first : undefined)).toBe(true);
    const observations: { count: number | undefined; entry: string | undefined }[] = [];
    registry.subscribe(() => observations.push({ count: inventory.reference(agent)?.totalCount, entry: conversation.entry(scope, "entry")?.entryId }));
    const remove = inventory.prepare({ agent, runtimeId: "runtime", source: source(2), update: { kind: "patch", upserts: [], removes: ["tool-0"] } });
    const entry = { entryId: "entry", parentId: null, type: "message", timestamp: "t", data: {} };
    expect(conversation.accept(scope, { type: "session.patch", sessionId: agent.sessionId, source: { ...source(2), ready: true },
      baseSeq: 1, seq: 2, checkpointId: "c2", head: { leafId: "entry" }, headCompleteness: "complete", live, entries: [entry] }, () => remove)).toBe(true);
    expect(observations.length).toBeGreaterThan(0); expect(observations.every(value => value.count === 0 && value.entry === "entry")).toBe(true);
    expect((remove.publication as ToolInventoryPatch).removes).toEqual(["tool-0"]);
  });

  it("integrates fixed paging with buffered incremental receiver application", () => {
    const { inventory } = setup(); baseline(inventory, [tool(0), tool(1), tool(2)]);
    const snapshot = inventory.openSnapshot("device", agent, "runtime"), receiver = new ToolInventoryReceiver(agent, "runtime");
    receiver.begin(snapshot); const first = receiver.nextRequest("first", 1)!;
    expect(receiver.acceptPage(inventory.read("device", first))).toBe("pending");
    const update = inventory.prepare({ agent, runtimeId: "runtime", source: source(2), update: { kind: "patch", upserts: [tool(3)], removes: ["tool-0"] } });
    expect(inventory.commit(update).ok).toBe(true); expect(receiver.acceptPatch(update.publication as ToolInventoryPatch)).toBe("pending");
    expect(receiver.tools()).toEqual([]);
    expect(receiver.acceptPage(inventory.read("device", receiver.nextRequest("last", 128)!))).toBe("applied");
    expect(receiver.tools().map(t => t.order)).toEqual([1, 2, 3]); expect(receiver.covers(update.reference)).toBe(true);
  });

  it("bounds session/global bytes, snapshot bytes and retired epoch records", () => {
    const cases: Partial<ToolInventoryLimits>[] = [{ maxSessionBytes: 1 }, { maxBytes: 1 }];
    for (const limits of cases) {
      const { registry, inventory } = setup(limits);
      expect(() => inventory.prepare({ agent, runtimeId: "runtime", source: source(), update: { kind: "baseline", tools: [tool(0)] } })).toThrow("inventory_limit");
      expect(registry.snapshot(scope)).toEqual([]); expect(inventory.stats().sessions).toBe(0);
    }
    const { inventory } = setup({ maxSessions: 1, maxSnapshotBytes: 1, maxRetiredEpochs: 1 }); baseline(inventory, [tool(0)]);
    expect(() => inventory.openSnapshot("device", agent, "runtime")).toThrow("busy");
    expect(() => inventory.prepare({ agent: { ...agent, sessionId: "other" }, runtimeId: "runtime", source: source(), update: { kind: "baseline", tools: [] } })).toThrow("inventory_limit");
    baseline(inventory, [], 1, "second");
    expect(() => inventory.prepare({ agent, runtimeId: "runtime", source: source(1, "third"), update: { kind: "baseline", tools: [] } })).toThrow("inventory_limit");
  });

  it("uses a baseline notice when escaped JSON exceeds bytes despite fitting the item limit", () => {
    const { inventory } = setup(); baseline(inventory, []);
    const upserts = Array.from({ length: 60 }, (_, i) => tool(i, { inputSummary: { text: "界".repeat(340), originalBytes: 1020, omitted: false } }));
    const plan = inventory.prepare({ agent, runtimeId: "runtime", source: source(2), update: { kind: "patch", upserts, removes: [] } });
    expect(plan.publication?.type).toBe("session.tools.changed"); expect(inventory.commit(plan).ok).toBe(true);
    const snapshot = inventory.openSnapshot("device", agent, "runtime"), firstRequest = request(snapshot);
    const first = inventory.read("device", firstRequest);
    expect(first.nextCursor).not.toBeNull(); expect(first.tools.length).toBeLessThan(60);
    expect(inventory.read("device", firstRequest)).toEqual(first);
  });

  it("rejects stale inventory companions before altering the conversation owner", () => {
    const { registry, inventory } = setup();
    const stale = inventory.prepare({ agent, runtimeId: "runtime", source: source(), update: { kind: "baseline", tools: [tool(0)] } });
    baseline(inventory, []);
    const conversation = new AgentConversationState(registry);
    const event: Extract<RuntimeEvent, { type: "session.snapshot" }> = { type: "session.snapshot", sessionId: agent.sessionId,
      syncId: "s", range: "preview", cursor: { leafId: null }, mode: "replace", entries: [], source: { ...source(), ready: true },
      checkpoint: { checkpointId: "c", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] } };
    expect(conversation.accept(scope, event, () => stale)).toBe(false);
    expect(conversation.hasBaseline(scope)).toBe(false); expect(registry.read(scope, "history")).toBeUndefined();
    expect(inventory.reference(agent)?.totalCount).toBe(0);
  });

  it("rejects mismatched conversation sources and plans belonging to another inventory owner", () => {
    const { registry, inventory } = setup(); const second = setup().inventory;
    const plan = inventory.prepare({ agent, runtimeId: "runtime", source: source(2), update: { kind: "baseline", tools: [tool(0)] } });
    expect(second.commit(plan)).toMatchObject({ ok: false, detail: "prepared_owner_mismatch" });
    const conversation = new AgentConversationState(registry);
    const event: Extract<RuntimeEvent, { type: "session.snapshot" }> = { type: "session.snapshot", sessionId: agent.sessionId,
      syncId: "s", range: "preview", cursor: { leafId: null }, mode: "replace", entries: [], source: { ...source(), ready: true },
      checkpoint: { checkpointId: "c", head: { leafId: null }, headCompleteness: "complete", inventoryComplete: true },
      live: { complete: true, turn: null, messages: [], tools: [] } };
    const rejected: string[] = [];
    expect(conversation.accept(scope, event, () => plan, reason => rejected.push(reason))).toBe(false);
    expect(rejected).toEqual(["companion_source_mismatch"]);
    expect(inventory.reference(agent)).toBeUndefined(); expect(registry.snapshot(scope)).toEqual([]);
    const other = inventory.prepare({ agent: { ...agent, sessionId: "other" }, runtimeId: "runtime", source: source(), update: { kind: "baseline", tools: [] } });
    expect(conversation.accept(scope, event, () => other)).toBe(false); expect(registry.stats().entries).toBe(0);
  });
});
