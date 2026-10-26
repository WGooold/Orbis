import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_PAGE_MAX_BYTES, toolJsonBytes, type ToolContentReadRequest } from "@orbis/protocol";
import { CodexToolContentReader, type CodexToolContentReaderOptions } from "./codex-tool-content-reader.js";
import type { CodexReadOptions } from "./codex-daemon.js";

const agent = { hostId: "host", agentKind: "codex", sessionId: "session" } as const;
const readers: CodexToolContentReader[] = [], directories: string[] = [];
let sequence = 0;
const request = (part: "arguments" | "output" | "result" = "output"): ToolContentReadRequest => ({
  type: "session.tool.content.read", requestId: "r" + ++sequence, runtimeId: "runtime", viewerId: "viewer",
  locator: { projectionVersion: 1, tool: { agent, toolCallId: "tool" }, part }, read: null, offset: 0, maxBytes: 16384,
});
async function setup(over: Partial<CodexToolContentReaderOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "orbis-codex-tool-read-")); directories.push(directory);
  const state = { epoch: "source", ready: true, committed: true };
  const native = { id: "tool", type: "commandExecution", command: "run", status: "completed", aggregatedOutput: "output" };
  const rpc = vi.fn(async () => ({ data: [{ id: "turn", items: [native] }] }));
  const reader = await CodexToolContentReader.create({ server: { request: rpc }, agent, runtimeId: "runtime", nativeThreadId: "native-session",
    directory, producerId: "codex", source: () => state, isCommitted: () => state.committed, ...over });
  readers.push(reader); return { reader, state, rpc, native };
}
afterEach(async () => {
  await Promise.all(readers.splice(0).map(reader => reader.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("bounded Codex native tool content reader (ADR-0045)", () => {
  it("reads 10 MiB aggregatedOutput once and reuses a fixed range for later pages and devices", async () => {
    const { reader, rpc, native } = await setup(); native.aggregatedOutput = "😀".repeat(10 * 1024 * 1024 / 4);
    const firstRequest = request(), first = await reader.read("device-1", firstRequest);
    expect(first.read.throughOffset).toBe(10 * 1024 * 1024); expect(first.text).not.toContain("�");
    expect(toolJsonBytes(first)).toBeLessThan(TOOL_PAGE_MAX_BYTES); expect(first.gaps).toEqual([]);
    const next = await reader.read("device-1", { ...request(), read: first.read, offset: first.nextCursor! });
    expect(next.fromOffset).toBe(first.nextCursor); expect(next.read).toEqual(first.read);
    expect(await reader.read("device-1", firstRequest)).toEqual(first);
    await reader.read("device-2", request()); expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("thread/turns/list", { threadId: "native-session", itemsView: "full", sortDirection: "desc", limit: 1 },
      15000, { signal: expect.any(AbortSignal), maxResponseBytes: 32 * 1024 * 1024 });
    expect(reader.usage.retainedBytes).toBe(10 * 1024 * 1024);
    await expect(reader.read("device-2", { ...request(), read: first.read })).rejects.toMatchObject({ reason: "scope_mismatch" });
  });

  it("invalidates pinned reads on native epoch changes and rejects uncommitted or offline tools", async () => {
    const { reader, rpc, state, native } = await setup(); const first = await reader.read("device", request());
    state.epoch = "replacement"; native.aggregatedOutput = "corrected";
    await expect(reader.read("device", { ...request(), read: first.read })).rejects.toMatchObject({ reason: "content_version_invalid" });
    expect((await reader.read("device", request())).text).toBe("corrected"); expect(rpc).toHaveBeenCalledTimes(2);
    state.committed = false; await expect(reader.read("device", request())).rejects.toMatchObject({ reason: "content_unavailable" });
    state.committed = true; state.ready = false; await expect(reader.read("device", request())).rejects.toMatchObject({ reason: "content_unavailable" });
  });

  it("verifies ownership before native access and returns missing parts explicitly", async () => {
    const { reader, rpc } = await setup();
    const wrong = request(); wrong.locator.tool.agent = { ...agent, sessionId: "other" };
    await expect(reader.read("device", wrong)).rejects.toMatchObject({ reason: "scope_mismatch" });
    await expect(reader.read("", request())).rejects.toMatchObject({ reason: "scope_mismatch" }); expect(rpc).not.toHaveBeenCalled();
    const missing = await setup({ server: { request: async () => ({ data: [{ id: "turn", items: [{ id: "tool", type: "mcpToolCall", tool: "lookup" }] }] }) } });
    await expect(missing.reader.read("device", request("result"))).rejects.toMatchObject({ reason: "content_unavailable" });
  });

  it("bounds page count, response size, cumulative scans and repeated native cursors", async () => {
    for (const limits of [{ pages: 1 }, { scanBytes: 1 }, { responseBytes: 1 }, {}]) {
      const rpc = vi.fn(async () => ({ data: [{ id: "turn", items: [] }], nextCursor: "repeat" }));
      const { reader } = await setup({ server: { request: rpc }, limits });
      await expect(reader.read("device", request())).rejects.toMatchObject({ reason: "content_unavailable" });
      expect(rpc.mock.calls.length).toBeLessThanOrEqual(2);
    }
  });

  it("cancels a pending native read and reports busy instead of starting another full read", async () => {
    const rpc = vi.fn((_method: string, _params?: unknown, _timeout?: number, options?: CodexReadOptions): Promise<unknown> => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("codex_request_cancelled")), { once: true });
    }));
    const { reader } = await setup({ server: { request: rpc } }), controller = new AbortController();
    const pending = reader.read("device", request(), controller.signal);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    await expect(reader.read("device", request("arguments"))).rejects.toMatchObject({ reason: "busy" });
    controller.abort(); await expect(pending).rejects.toMatchObject({ reason: "cancelled" }); expect(reader.usage.parts).toBe(0);
  });

  it("does not accept a native response captured across source replacement", async () => {
    let finish!: (value: unknown) => void;
    const { reader, state } = await setup({ server: { request: () => new Promise(resolve => { finish = resolve; }) } });
    const pending = reader.read("device", request()); state.epoch = "new";
    finish({ data: [{ id: "turn", items: [{ id: "tool", type: "commandExecution", aggregatedOutput: "obsolete" }] }] });
    await expect(pending).rejects.toMatchObject({ reason: "content_version_invalid" }); expect(reader.usage.parts).toBe(0);
  });

  it("separates structured MCP results from arguments and pins owner cancellation", async () => {
    const item = { id: "tool", type: "mcpToolCall", tool: "search", arguments: { z: 2, a: 1 },
      result: { content: [{ type: "text", text: "answer" }], structuredContent: { value: 42 } } };
    const { reader } = await setup({ server: { request: async () => ({ data: [{ id: "turn", items: [item] }] }) } });
    const result = await reader.read("one", request("result")), args = await reader.read("one", request("arguments"));
    expect(JSON.parse(result.text)).toEqual(item.result); expect(JSON.parse(args.text).arguments).toEqual(item.arguments);
    await expect(reader.cancel("two", result.read.readId)).rejects.toMatchObject({ reason: "scope_mismatch" });
    await reader.cancel("one", result.read.readId);
    await expect(reader.read("one", { ...request("result"), read: result.read })).rejects.toMatchObject({ reason: "content_expired" });
    expect((await reader.read("two", request("arguments"))).text).toBe(args.text);
  });

  it("finds older native tools by bounded turn pages and records explicit quota suffix gaps", async () => {
    const output = "a".repeat(17 * 1024 * 1024);
    const rpc = vi.fn(async (_method: string, params?: unknown) => {
      if (!(params as { cursor?: string }).cursor) return { data: [{ id: "new", items: [] }], nextCursor: "older" };
      return { data: [{ id: "old", items: [{ id: "tool", type: "commandExecution", status: "completed", aggregatedOutput: output }] }] };
    });
    const { reader } = await setup({ server: { request: rpc } }), first = await reader.read("device", request());
    expect(first.availableThroughOffset).toBe(16 * 1024 * 1024); expect(first.observedThroughOffset).toBe(17 * 1024 * 1024);
    expect(first.gaps).toEqual([{ fromOffset: 16 * 1024 * 1024, throughOffset: 17 * 1024 * 1024, reason: "quota" }]);
    expect(rpc).toHaveBeenCalledTimes(2); expect(first.contentFinal).toBe(true);
    expect(reader.usage.retainedBytes).toBe(16 * 1024 * 1024);
  });
});
