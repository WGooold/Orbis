import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent, ToolContentReadRequest } from "@orbis/protocol";
import { ToolContentStore } from "@orbis/runtime-bridge";
import { CodexRuntime } from "./codex-runtime.js";
import type { CodexAppServer } from "./codex-daemon.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function harness(desktop = false, producerBytes = 64 * 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), "orbis-codex-content-runtime-")), events: RuntimeEvent[] = [];
  const store = await ToolContentStore.create({ directory: root, producerId: "codex", limits: { producerBytes } });
  const turns = (id: string) => [{ id: "turn-" + id, status: "completed", items: [
    { id: "tool-" + id, type: "commandExecution", command: "dir", status: "completed", aggregatedOutput: "12345678" },
  ] }];
  const rpc = vi.fn(async (method: string, params?: { threadId?: string }) => {
    if (method === "thread/turns/list") return { data: turns(params?.threadId ?? "session") };
    if (method === "thread/resume") return { thread: { id: params?.threadId, cwd: root, status: { type: "idle" } } };
    return { data: [] };
  });
  const server = { request: rpc, mode: desktop ? "desktop" : "owned", notify: vi.fn() } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, rolloutRoot: root, toolContentStore: store, onEvent: event => events.push(event) });
  runtime.setToolContentStore(store, "host");
  if (desktop) runtime.seedDesktopThreads(["session", "one", "two"]);
  cleanups.push(async () => { server.onExit?.(0); await store.dispose(); await rm(root, { recursive: true, force: true }); });
  const request = (sessionId = "session"): ToolContentReadRequest => ({
    type: "session.tool.content.read", requestId: "request-" + sessionId, runtimeId: runtime.runtimeIdFor(sessionId), viewerId: "viewer",
    locator: { projectionVersion: 1, tool: { agent: { hostId: "host", agentKind: desktop ? "codexDesktop" : "codex", sessionId: desktop ? "codex-desktop:" + sessionId : sessionId }, toolCallId: "tool-" + sessionId }, part: "output" },
    read: null, offset: 0, maxBytes: 16384,
  });
  const activate = async (id = "session") => runtime.activate({ type: "resume", sessionId: desktop ? "codex-desktop:" + id : id });
  const sync = (id = "session") => {
    const index = events.length; runtime.handleCommand({ type: "session.sync", sessionId: desktop ? "codex-desktop:" + id : id, syncId: "s", range: "preview" }, "sync", id);
    return events.slice(index).find(event => event.type === "session.snapshot");
  };
  return { runtime, server, store, rpc, events, request, activate, sync };
}

describe("Codex backend private tool content integration", () => {
  it.each([false, true])("keeps 10 MiB output and eight out-of-order completions outside shared live and history (desktop=%s)", async desktop => {
    const h = await harness(desktop); await h.activate();
    const notify = (method: string, item: unknown) => h.server.onNotification?.(method, { threadId: "session", ...item as object });
    notify("item/started", { item: { id: "pending", type: "agentMessage", text: "answer" } });
    notify("item/started", { item: { id: "stream", type: "commandExecution", command: "large command" } });
    const before = h.events.length, seq = h.sync()?.source?.seq;
    for (let i = 0; i < 10; i++) notify("item/commandExecution/outputDelta", { itemId: "stream", delta: "X".repeat(1024 * 1024) });
    expect(h.events.slice(before).every(event => event.type !== "session.patch")).toBe(true);
    expect(h.sync()?.source?.seq).toBe(seq);
    const request = h.request(); request.locator.tool.toolCallId = "stream";
    const output = await h.runtime.toolContents.read("viewer", request);
    expect(output.observedThroughOffset).toBe(10 * 1024 * 1024); expect(output.gaps.length).toBeGreaterThan(0);
    expect(h.store.usage.retainedBytes).toBeLessThanOrEqual(1024 * 1024);
    const raw = "PRIVATE_TOOL_RESULT_".repeat(50_000);
    for (let i = 0; i < 8; i++) {
      const item = { id: `parallel-${i}`, type: "commandExecution", command: "work", aggregatedOutput: raw };
      notify("item/started", { item: { ...item, aggregatedOutput: undefined } });
      notify("item/completed", { item: { ...item, status: "completed" } });
    }
    const waiting = h.sync()!;
    expect(waiting.live?.toolInventory?.totalCount).toBe(9);
    expect(waiting.entries.some(entry => entry.entryId.startsWith("parallel"))).toBe(false);
    expect(JSON.stringify(h.events)).not.toContain("PRIVATE_TOOL_RESULT_");
    expect(Buffer.byteLength(JSON.stringify(waiting))).toBeLessThan(16 * 1024);
    notify("item/completed", { item: { id: "pending", type: "agentMessage", text: "answer" } });
    notify("item/completed", { item: { id: "stream", type: "commandExecution", command: "large command", status: "completed", aggregatedOutput: "final" } });
    const committed = h.sync()!;
    expect(committed.live?.toolInventory?.totalCount).toBe(0);
    expect(committed.entries.filter(entry => entry.entryId.startsWith("parallel"))).toHaveLength(16);
    expect(JSON.stringify(committed)).not.toContain("PRIVATE_TOOL_RESULT_");
    h.server.onExit?.(0);
    await expect(h.runtime.toolContents.read("viewer", { ...request, read: output.read })).rejects.toMatchObject({ reason: "content_unavailable" });
  });
  it.each([false, true])("reads only the selected native session without publishing or changing source state (desktop=%s)", async desktop => {
    const h = await harness(desktop); await h.activate();
    const before = h.sync(), events = h.events.length;
    const page = await h.runtime.toolContents.read("device", h.request());
    expect(page.text).toBe("12345678"); expect(h.events.length).toBe(events);
    expect(h.sync()).toEqual(before);
    expect(h.rpc).toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({ threadId: "session", limit: 1 }), 15000, expect.objectContaining({ maxResponseBytes: 32 * 1024 * 1024 }));
    h.server.onExit?.(0);
    await expect(h.runtime.toolContents.read("device", h.request())).rejects.toMatchObject({ reason: "content_unavailable" });
  });

  it("shares one producer quota across native sessions and keeps store lifecycle with the Host", async () => {
    const h = await harness(false, 12); await h.activate("one"); await h.activate("two");
    const first = await h.runtime.toolContents.read("device", h.request("one"));
    await h.runtime.toolContents.read("device", h.request("two"));
    expect(h.store.usage.retainedBytes).toBe(8);
    await expect(h.runtime.toolContents.read("device", { ...h.request("one"), requestId: "later", read: first.read })).rejects.toMatchObject({ reason: "content_expired" });
    h.server.onExit?.(0);
    // Attached readers do not dispose the shared producer store.
    await h.store.begin(h.request("one").locator, "text"); expect(h.store.usage.parts).toBeGreaterThan(0);
  });

  it("rejects uncommitted tool identities and wrong backend/session scopes before native access", async () => {
    const h = await harness(); await h.activate(); const count = h.rpc.mock.calls.length;
    const missing = h.request(); missing.locator.tool.toolCallId = "unfinished";
    await expect(h.runtime.toolContents.read("device", missing)).rejects.toMatchObject({ reason: "content_unavailable" });
    const wrong = h.request(); wrong.locator.tool.agent.sessionId = "other";
    await expect(h.runtime.toolContents.read("device", wrong)).rejects.toMatchObject({ reason: "scope_mismatch" });
    expect(h.rpc.mock.calls.length).toBe(count);
  });
});
