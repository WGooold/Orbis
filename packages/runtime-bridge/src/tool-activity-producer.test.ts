import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeWireEventSchema, type AgentKind, type ToolContentReadRequest } from "@orbis/protocol";
import { ToolActivityProducer, toolContentText } from "./tool-activity-producer.js";
import { ToolContentStore } from "./tool-content-store.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0)) await run(); });
async function setup(kind: AgentKind = "pi") {
  const directory = await mkdtemp(join(tmpdir(), "orbis-tool-producer-"));
  const store = await ToolContentStore.create({ directory, producerId: kind }); let epoch = "one";
  const agent = { hostId: "h", agentKind: kind, sessionId: "s" };
  const native = vi.fn(() => ({ format: "json" as const, value: { z: "native", image: { type: "image", mimeType: "image/png", data: "YWJj" } } }));
  const producer = new ToolActivityProducer({ agent: () => agent, source: () => ({ epoch, ready: true }), runtimeId: () => "r", native, store });
  cleanup.push(async () => { await producer.dispose(); await store.dispose(); await rm(directory, { recursive: true, force: true }); });
  const request = (part: "arguments" | "output" | "result" = "output"): ToolContentReadRequest => ({ type: "session.tool.content.read",
    runtimeId: "r", viewerId: "v", requestId: Math.random().toString(), locator: { projectionVersion: 1, tool: { agent, toolCallId: "t" }, part },
    read: null, offset: 0, maxBytes: 16_384 });
  return { producer, store, native, request, replaceEpoch: () => { epoch = "two"; } };
}
describe("Pi and DSH producer boundary", () => {
  it.each(["pi", "dsh"] as const)("keeps a 10 MiB result outside every shared projection (%s)", async kind => {
    const h = await setup(kind), raw = "PRIVATE_OUTPUT_".repeat(800_000);
    const started = h.producer.event({ type: "tool.started", toolCallId: "t", toolName: "bash", arguments: { command: "pwd", large: raw } });
    const updated = h.producer.event({ type: "tool.updated", toolCallId: "t", toolName: "bash", partialResult: raw });
    const finished = h.producer.event({ type: "tool.finished", toolCallId: "t", toolName: "bash", result: { raw }, isError: true });
    for (const event of [started, updated, finished]) {
      expect(RuntimeWireEventSchema.safeParse(event).success).toBe(true);
      expect(JSON.stringify(event)).not.toContain("PRIVATE_OUTPUT_"); expect(JSON.stringify(event).length).toBeLessThan(4096);
    }
    const page = await h.producer.read("owner", h.request("output"));
    expect(page.observedThroughOffset).toBe(Buffer.byteLength(raw)); expect(page.gaps.length).toBeGreaterThan(0);
    expect(h.store.usage.retainedBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(h.native).not.toHaveBeenCalled();
    const native = await h.producer.read("owner", h.request("result"));
    expect(native.text).not.toContain("YWJj"); expect(native.text).toContain("native");
    expect(h.native).toHaveBeenCalledTimes(1);
  });
  it("invalidates leases, native caches and projection identities after a source epoch changes", async () => {
    const h = await setup(); h.producer.event({ type: "tool.started", toolCallId: "t", toolName: "read", arguments: { path: "old" } });
    const first = await h.producer.read("owner", h.request("arguments")); h.replaceEpoch();
    await expect(h.producer.read("owner", { ...h.request("arguments"), read: first.read })).rejects.toMatchObject({ reason: "content_version_invalid" });
    const replacement = h.producer.event({ type: "tool.started", toolCallId: "t", toolName: "read", arguments: { path: "new" } });
    expect(replacement).toMatchObject({ summary: { inputSummary: { text: "new" } } });
    const current = await h.producer.read("owner", h.request("arguments"));
    expect(current.text).toBe('{"path":"new"}'); expect(current.read.contentEpoch).not.toBe(first.read.contentEpoch);
  });
  it("serializes deterministic fragments and rejects cyclic or excessively deep structured values", () => {
    expect(toolContentText({ format: "json", value: { z: 1, a: 2 } })).toBe('{"a":2,"z":1}');
    const value: Record<string, unknown> = {}; value.self = value;
    expect(() => toolContentText({ format: "json", value })).toThrow();
  });
});
