import { describe, expect, it } from "vitest";
import { ToolInventoryReceiver } from "./tool-inventory-receiver.js";
import { createToolSummary, type ToolInventoryPage, type ToolInventoryPatch, type ToolInventorySnapshot, type ToolSummary } from "./tool-activity.js";

const agent = { hostId: "host", agentKind: "codex", sessionId: "session" } as const;
const tool = (order: number, over: Partial<ToolSummary> = {}) => ({ ...createToolSummary({
  tool: { agent, toolCallId: "t" + order }, toolName: "exec", phase: "running", order, contents: [],
}), ...over });
const snapshot = (revision = 1, totalCount = 2, epoch = "inventory", seq = revision): ToolInventorySnapshot => ({
  snapshotId: "snapshot-" + revision + epoch, agent, version: { epoch, revision }, source: { epoch: "source-" + epoch, seq }, totalCount,
});
const patch = (base = 1, upserts = [tool(2)], removes: string[] = [], epoch = "inventory"): ToolInventoryPatch => ({
  type: "session.tools.patch", runtimeId: "runtime", agent, version: { epoch, revision: base + 1 }, baseRevision: base,
  source: { epoch: "source-" + epoch, seq: base + 1 }, upserts, removes,
});
function page(receiver: ToolInventoryReceiver, tools: ToolSummary[], start = 0, terminal = true, over: Partial<ToolInventoryPage> = {}): ToolInventoryPage {
  const request = receiver.nextRequest("request-" + start)!;
  return { type: "session.tools.page", requestId: request.requestId, runtimeId: "runtime", snapshot: request.snapshot,
    startIndex: start, endIndex: start + tools.length, tools, nextCursor: terminal ? null : "cursor-" + (start + tools.length), ...over };
}
function confirmed(limits: ConstructorParameters<typeof ToolInventoryReceiver>[2] = {}) {
  const receiver = new ToolInventoryReceiver(agent, "runtime", limits);
  receiver.begin(snapshot(1, 1)); expect(receiver.acceptPage(page(receiver, [tool(0)]))).toBe("applied");
  return receiver;
}

describe("versioned inventory receiver (ADR-0045)", () => {
  it("preserves old confirmed tools until complete replacement and buffers consecutive patches", () => {
    const receiver = confirmed(); receiver.begin(snapshot(2, 2));
    expect(receiver.acceptPage(page(receiver, [tool(1)], 0, false))).toBe("pending");
    expect(receiver.tools().map(t => t.order)).toEqual([0]); expect(receiver.covers(snapshot(1, 1))).toBe(false);
    expect(receiver.acceptPatch(patch(2, [tool(3)], ["t1"]))).toBe("pending");
    expect(receiver.acceptPatch(patch(3, [tool(4)]))).toBe("pending");
    expect(receiver.acceptPage(page(receiver, [tool(2)], 1))).toBe("applied");
    expect(receiver.tools().map(t => t.order)).toEqual([2, 3, 4]); expect(receiver.covers(snapshot(4))).toBe(true);
    expect(receiver.covers({ ...snapshot(4), source: { epoch: "source-inventory", seq: 5 } })).toBe(false);
  });

  it("applies empty complete baselines and explicit removes with deterministic ordering", () => {
    const receiver = confirmed(); expect(receiver.acceptPatch(patch(1, [tool(3), tool(1)]))).toBe("applied");
    expect(receiver.tools().map(t => t.order)).toEqual([0, 1, 3]);
    expect(receiver.acceptPatch(patch(2, [], ["t0", "t3"]))).toBe("applied");
    receiver.begin(snapshot(4, 0)); expect(receiver.acceptPage(page(receiver, []))).toBe("applied"); expect(receiver.tools()).toEqual([]);
  });

  it("requires recovery on lost or reordered revisions and preserves confirmed inventory", () => {
    const receiver = confirmed(); expect(receiver.acceptPatch(patch(3))).toBe("recovery_required");
    expect(receiver.tools().map(t => t.order)).toEqual([0]); expect(receiver.acceptPatch(patch(1))).toBe("recovery_required");
    receiver.begin(snapshot(4, 1)); expect(receiver.acceptPage(page(receiver, [tool(4)]))).toBe("applied");
    expect(receiver.tools().map(t => t.order)).toEqual([4]);
  });

  it("bounds delta count and bytes during paging without silently claiming completion", () => {
    for (const limits of [{ maxBufferedPatches: 1 }, { maxBufferedBytes: 1 }]) {
      const receiver = confirmed(limits); receiver.begin(snapshot(2, 2));
      receiver.acceptPage(page(receiver, [tool(1)], 0, false));
      const first = receiver.acceptPatch(patch(2));
      if (first === "pending") expect(receiver.acceptPatch(patch(3))).toBe("recovery_required");
      else expect(first).toBe("recovery_required");
      expect(receiver.tools().map(t => t.order)).toEqual([0]);
      expect(receiver.state()).toMatchObject({ recoveryRequired: true, updating: false, bufferedBytes: 0 });
    }
  });

  it("rejects duplicate IDs across pages, incorrect coverage and mismatched source captures", () => {
    const duplicate = confirmed(); duplicate.begin(snapshot(2, 2)); duplicate.acceptPage(page(duplicate, [tool(1)], 0, false));
    expect(duplicate.acceptPage(page(duplicate, [tool(1)], 1))).toBe("recovery_required");
    expect(duplicate.tools().map(t => t.order)).toEqual([0]);
    const mismatched = confirmed(); mismatched.begin(snapshot(2, 1));
    const wrong = page(mismatched, [tool(2)]); wrong.snapshot.source.seq = 3;
    expect(mismatched.acceptPage(wrong)).toBe("recovery_required");
    const gap = confirmed(); gap.begin(snapshot(2, 2));
    expect(gap.acceptPage(page(gap, [tool(1)], 1))).toBe("recovery_required");
  });

  it("ignores superseded page responses and retired epochs without interrupting current reads", () => {
    const receiver = confirmed(); receiver.begin(snapshot(2, 1)); const late = page(receiver, [tool(2)]);
    receiver.begin(snapshot(1, 1, "new")); expect(receiver.acceptPage(late)).toBe("ignored");
    expect(receiver.acceptPatch(patch(2))).toBe("ignored"); expect(receiver.begin(snapshot(99))).toBe("ignored");
    expect(receiver.acceptPage(page(receiver, [tool(5)]))).toBe("applied"); expect(receiver.tools().map(t => t.order)).toEqual([5]);
  });

  it("rejects impossible deltas after paging, mixed versions and unproved removals", () => {
    const receiver = confirmed(); receiver.begin(snapshot(2, 1));
    expect(receiver.acceptPatch(patch(2, [], ["missing"]))).toBe("pending");
    expect(receiver.acceptPage(page(receiver, [tool(2)]))).toBe("recovery_required");
    expect(receiver.tools().map(t => t.order)).toEqual([0]);
    const mixed = confirmed(); expect(mixed.acceptPatch({ ...patch(1), source: { epoch: "other", seq: 2 } })).toBe("recovery_required");
  });

  it("deduplicates buffered patches, rejects conflicting duplicates and isolates mutable callers", () => {
    const receiver = confirmed(); receiver.begin(snapshot(2, 1)); const next = patch(2);
    expect(receiver.acceptPatch(next)).toBe("pending"); expect(receiver.acceptPatch(next)).toBe("ignored");
    next.upserts[0]!.phase = "finished";
    expect(receiver.acceptPatch(next)).toBe("recovery_required");
    const tools = receiver.tools(); tools[0]!.phase = "cancelled"; expect(receiver.tools()[0]!.phase).toBe("running");
  });

  it("requires baseline refresh for oversized-change notices and bounds materialized inventory", () => {
    const receiver = confirmed();
    expect(receiver.acceptChanged({ type: "session.tools.changed", runtimeId: "runtime", agent, version: { epoch: "inventory", revision: 2 }, source: { epoch: "source-inventory", seq: 2 } })).toBe("recovery_required");
    expect(receiver.tools().map(t => t.order)).toEqual([0]);
    expect(confirmed({ maxTools: 1 }).begin(snapshot(2, 2))).toBe("recovery_required");
    const bytes = new ToolInventoryReceiver(agent, "runtime", { maxBytes: 1 }); bytes.begin(snapshot(1, 1));
    expect(bytes.acceptPage(page(bytes, [tool(0)]))).toBe("recovery_required"); expect(bytes.tools()).toEqual([]);
  });

  it("retries lost pages with the same request and recovers only on correlated read failure", () => {
    const receiver = confirmed(); receiver.begin(snapshot(2, 1));
    const first = receiver.nextRequest("first", 1)!;
    expect(receiver.nextRequest("retry", 128)).toEqual(first);
    expect(receiver.readFailed("old")).toBe("ignored");
    expect(receiver.readFailed("first")).toBe("recovery_required"); expect(receiver.tools().map(t => t.order)).toEqual([0]);
  });

  it("rejects changed facts at the same version and does not cover older chat dependencies after removal", () => {
    const receiver = confirmed(); receiver.begin(snapshot(1, 1));
    expect(receiver.acceptPage(page(receiver, [tool(0, { phase: "finished" })]))).toBe("recovery_required");
    expect(receiver.tools()[0]!.phase).toBe("running");
    const current = confirmed(); expect(current.acceptPatch(patch(1, [], ["t0"]))).toBe("applied");
    expect(current.covers(snapshot(1, 1))).toBe(false); expect(current.covers(snapshot(2, 0))).toBe(true);
  });

  it("rejects conflicting applied duplicates and revision changes without a newer source transaction", () => {
    const receiver = confirmed(), next = patch(1);
    expect(receiver.acceptPatch(next)).toBe("applied"); expect(receiver.acceptPatch(next)).toBe("ignored");
    expect(receiver.acceptPatch(patch(1, [tool(2, { phase: "finished" })]))).toBe("recovery_required");
    expect(confirmed().begin(snapshot(2, 1, "inventory", 1))).toBe("recovery_required");
  });

  it("does not forget observed future revisions when baseline reads are restarted", () => {
    const receiver = confirmed(); receiver.begin(snapshot(2, 2));
    receiver.acceptPage(page(receiver, [tool(1)], 0, false)); receiver.acceptPatch(patch(2));
    expect(receiver.begin(snapshot(2, 2))).toBe("ignored");
    expect(receiver.state().bufferedPatches).toBe(1);
    expect(receiver.acceptPage(page(receiver, [tool(2)], 1))).toBe("applied");
    expect(receiver.state().version?.revision).toBe(3);
    receiver.acceptChanged({ type: "session.tools.changed", runtimeId: "runtime", agent,
      version: { epoch: "inventory", revision: 5 }, source: { epoch: "source-inventory", seq: 5 } });
    expect(receiver.begin(snapshot(4, 1))).toBe("ignored"); expect(receiver.state().recoveryRequired).toBe(true);
  });
});
