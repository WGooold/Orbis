import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolContentPage, type RuntimeCommand, type ToolContentReadRequest } from "@orbis/protocol";
import { PiToolContentReader } from "./pi-tool-content-reader.js";
const agent = { hostId: "h", agentKind: "pi" as const, sessionId: "s" };
const request = (): ToolContentReadRequest => ({ type: "session.tool.content.read", requestId: "device-q", runtimeId: "r", viewerId: "device-v",
  locator: { projectionVersion: 1, tool: { agent, toolCallId: "t" }, part: "result" }, read: null, offset: 0, maxBytes: 4 });
function setup() {
  const commands: RuntimeCommand[] = [];
  const reader = new PiToolContentReader({ scope: () => agent, send: (_runtime, _id, command) => { commands.push(command); return true; } });
  const answer = () => { const q = [...commands].reverse().find(command => command.type === "session.tool.content.read") as ToolContentReadRequest;
    reader.accept("r", createToolContentPage({ type: "session.tool.content.page", requestId: q.requestId, runtimeId: "r", locator: q.locator,
      read: q.read ?? { readId: "fixed", contentEpoch: "epoch", throughOffset: 4 }, format: "text", representation: "utf8-fragment",
      fromOffset: 0, availableFromOffset: 0, availableThroughOffset: 4, observedThroughOffset: 4, contentFinal: true, gaps: [] }, "abcd")); };
  return { reader, commands, answer };
}
afterEach(() => vi.useRealTimers());
describe("Pi private loopback correlation", () => {
  it("rewrites correlation identities and rejects other owners and expired leases", async () => {
    vi.useFakeTimers(); const h = setup(); const first = h.reader.read("a", request()); h.answer(); const page = await first;
    expect(page.requestId).toBe("device-q");
    expect(h.commands[0]).not.toMatchObject({ requestId: "device-q", viewerId: "device-v" });
    await expect(h.reader.read("b", { ...request(), read: page.read })).rejects.toMatchObject({ reason: "scope_mismatch" });
    vi.advanceTimersByTime(30_001);
    await expect(h.reader.read("a", { ...request(), read: page.read })).rejects.toMatchObject({ reason: "content_expired" });
    h.reader.close();
  });
  it("sends producer cancellation for a pending first read and consumes unknown late private pages", async () => {
    const h = setup(), controller = new AbortController(); const work = h.reader.read("a", request(), controller.signal);
    controller.abort(); await expect(work).rejects.toMatchObject({ reason: "cancelled" });
    expect(h.commands.at(-1)).toMatchObject({ type: "session.tool.content.cancel", readId: "cancel-pending" });
    h.answer();
    expect(h.reader.accept("r", { type: "session.tool.read.failed", runtimeId: "r", requestId: "unknown", reason: "cancelled", gaps: [] })).toBe(true);
    h.reader.close();
  });
});
