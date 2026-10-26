import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolContentPage, type RuntimeEvent, type ToolContentReadRequest } from "@orbis/protocol";
import { type ToolContentReader } from "@orbis/runtime-bridge";
import { ToolContentService } from "./tool-content-service.js";

const agent = { hostId: "host", agentKind: "pi" as const, sessionId: "s" };
const request = (id = "q", viewerId = "v"): ToolContentReadRequest => ({ type: "session.tool.content.read", runtimeId: "r",
  requestId: id, viewerId, locator: { projectionVersion: 1, tool: { agent, toolCallId: "t" }, part: "output" }, read: null, offset: 0, maxBytes: 4 });
function page(q: ToolContentReadRequest) { return createToolContentPage({ type: "session.tool.content.page", requestId: q.requestId,
  runtimeId: q.runtimeId, locator: q.locator, read: q.read ?? { readId: "read-" + q.requestId, contentEpoch: "c", throughOffset: 4 },
  fromOffset: 0, availableFromOffset: 0, availableThroughOffset: 4, observedThroughOffset: 4, contentFinal: false,
  format: "text", representation: "utf8-fragment", gaps: [] }, "abcd"); }
function setup(read: ToolContentReader["read"] = async (_owner, q) => page(q)) {
  let current = agent;
  const sent: { device: string; event: RuntimeEvent }[] = [];
  const reader = { read: vi.fn(read), cancel: vi.fn(async () => {}) };
  const service = new ToolContentService({ scope: () => current, reader: () => reader,
    send: (device, _runtime, event) => { sent.push({ device, event }); return true; } });
  return { service, sent, reader, scope: (value: typeof agent) => { current = value; } };
}
afterEach(() => { vi.useRealTimers(); });
describe("device private tool reads", () => {
  it("isolates devices and viewer leases, validates scope before invoking the producer", async () => {
    const h = setup();
    try {
      await h.service.read("a", "r", request("a")); await h.service.read("b", "r", request("b"));
      expect(h.sent.map(value => [value.device, value.event.type])).toEqual([["a", "session.tool.content.page"], ["b", "session.tool.content.page"]]);
      expect(h.reader.read.mock.calls.map(call => call[0])).toEqual(['["a","v"]', '["b","v"]']);
      await h.service.read("b", "r", { ...request("steal"), read: page(request("a")).read });
      await h.service.read("a", "wrong", request("wrong"));
      expect(h.reader.read).toHaveBeenCalledTimes(2);
      expect(h.sent.slice(-2).every(value => value.event.type === "session.tool.read.failed" && value.event.reason === "scope_mismatch")).toBe(true);
      h.service.cancel("b", "r", "v", "read-a"); expect(h.reader.cancel).not.toHaveBeenCalled();
      h.service.releaseDevice("a"); expect(h.reader.cancel).toHaveBeenCalledWith('["a","v"]', "read-a");
    } finally { h.service.close(); }
  });
  it("bounds concurrency and releases uncooperative late reads on cancel without sending their pages", async () => {
    const pending: Array<() => void> = [];
    const h = setup((_owner, q) => new Promise(resolve => pending.push(() => resolve(page(q)))));
    const a = h.service.read("a", "r", request("one", "v1"));
    const b = h.service.read("a", "r", request("two", "v2"));
    await h.service.read("a", "r", request("three", "v3"));
    expect(h.sent[0]?.event).toMatchObject({ type: "session.tool.read.failed", reason: "busy" });
    h.service.cancel("a", "r", "v1", "cancel-pending");
    pending[0]!(); await a;
    expect(h.reader.cancel).toHaveBeenCalledWith('["a","v1"]', "read-one");
    expect(h.sent.some(value => value.event.type === "session.tool.content.page")).toBe(false);
    pending[1]!(); await b;
    expect(h.sent.at(-1)).toMatchObject({ device: "a", event: { type: "session.tool.content.page", requestId: "two" } });
    h.service.close();
  });
  it("ends local waits on timeout and refuses responses after the runtime changes ownership", async () => {
    vi.useFakeTimers();
    let done!: () => void;
    const h = setup((_owner, q) => new Promise(resolve => { done = () => resolve(page(q)); }));
    const waiting = h.service.read("a", "r", request());
    await vi.advanceTimersByTimeAsync(30_001); await waiting;
    expect(h.sent[0]?.event).toMatchObject({ type: "session.tool.read.failed", reason: "cancelled" });
    done(); await Promise.resolve(); expect(h.reader.cancel).toHaveBeenCalled();
    const next = h.service.read("a", "r", request("next")); h.scope({ ...agent, sessionId: "other" });
    done(); await next;
    expect(h.sent.at(-1)?.event).toMatchObject({ type: "session.tool.read.failed", reason: "scope_mismatch" });
    h.service.close();
  });
});
