import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@pi-remote/protocol";
import type { CodexAppServer } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";

const user = (id: string) => ({ id, type: "userMessage", content: [{ type: "text", text: "same question" }] });
const answer = (id: string) => ({ id, type: "agentMessage", text: "same answer" });
const tool = { id: "exec-native", type: "commandExecution", command: "dir", status: "completed", aggregatedOutput: "ok" };
// The real desktop resume view synthesizes item-1/2/3 while full turns/list retains
// native UUID/message IDs. Shared tool IDs remain unchanged in both representations.
const turns = (native: boolean) => [{ id: "turn", status: "completed", items: [
  user(native ? "uuid-user" : "item-1"), answer(native ? "msg-answer" : "item-3"), tool,
] }];
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });

function harness(desktop = false) {
  const events: RuntimeEvent[] = [];
  const logs: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "orbis-native-identity-"));
  let native = turns(true) as unknown[];
  const read = vi.fn((): Promise<unknown> => Promise.resolve({ data: native }));
  const request = vi.fn(async (method: string, params?: { threadId?: string }) => {
    if (method === "thread/loaded/list") return { data: desktop ? ["session"] : [] };
    if (method === "thread/turns/list") return read();
    if (["thread/resume", "thread/start", "thread/fork", "thread/read"].includes(method)) return {
      thread: { id: method === "thread/fork" ? "forked" : params?.threadId ?? "session", cwd: root,
        status: { type: "idle" }, turns: turns(false) }, model: "native-model",
    };
    return { data: [] };
  });
  const server = { request, ...(desktop ? { mode: "desktop" } : {}), notify: vi.fn() } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, rolloutRoot: root, onEvent: event => events.push(event), log: line => logs.push(line) });
  cleanups.push(() => { server.onExit?.(0); rmSync(root, { recursive: true, force: true }); });
  const notify = (method: string, params: unknown) => server.onNotification?.(method, params);
  const sync = (sessionId = "session") => {
    const start = events.length;
    runtime.handleCommand({ type: "session.sync", sessionId: desktop ? `codex-desktop:${sessionId}` : sessionId,
      syncId: "sync", range: "preview" }, "sync", sessionId);
    return events.slice(start).find(event => event.type === "session.snapshot");
  };
  return { runtime, events, logs, request, read, notify, sync, root, setNative: (value: unknown[]) => { native = value; } };
}

describe("Codex canonical native item identity", () => {
  it("coalesces a large stream during a slow native read and publishes the replay as one ready version", async () => {
    const h = harness();
    await h.runtime.activate({ type: "resume", sessionId: "session" });
    h.notify("turn/started", { threadId: "session", turn: { id: "running", startedAt: 1_800_000_000 } });
    h.notify("item/started", { threadId: "session", turnId: "running", item: answer("draft") });
    h.setNative([...turns(true), { id: "running", status: "inProgress", startedAt: 1_800_000_000, items: [answer("draft")] }]);
    let resolve!: (value: unknown) => void;
    h.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    h.runtime.announce("session");
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    h.events.length = 0;
    for (let i = 0; i < 5000; ++i) h.notify("item/agentMessage/delta", {
      threadId: "session", turnId: "running", itemId: "draft", delta: "x",
    });
    resolve({ data: [...turns(true), { id: "running", status: "inProgress", startedAt: 1_800_000_000, items: [answer("draft")] }] });
    await vi.waitFor(() => expect(h.events.filter(event => event.type === "session.patch").at(-1)?.source.ready).toBe(true));
    const snapshot = h.sync();
    expect(snapshot?.live?.messages.find(item => item.message.messageId === "draft")).toMatchObject({
      contentComplete: true, message: { content: [{ type: "text", text: "same answer" + "x".repeat(5000) }] },
    });
    expect(h.events.filter(event => event.type === "session.patch" && event.source.ready)).toHaveLength(1);
    expect(h.events.filter(event => event.type === "session.patch" && !event.source.ready)).toHaveLength(0);
    expect(h.logs.filter(line => line.includes("缓冲已满"))).toHaveLength(0);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("queues one repair for thousands of overflowing notifications and never commits their truncated prefix", async () => {
    const h = harness();
    await h.runtime.activate({ type: "resume", sessionId: "session" });
    const originalEpoch = h.sync()?.source?.epoch;
    let resolve!: (value: unknown) => void;
    h.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    h.runtime.announce("session");
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 5000; ++i) h.notify("item/completed", {
      threadId: "session", turnId: "turn", item: answer(`discarded-${i}`),
    });
    const repaired = [{ id: "turn", status: "completed", items: [...turns(true)[0]!.items, answer("native-final")] }];
    h.setNative(repaired);
    resolve({ data: turns(true) });
    await vi.waitFor(() => expect(h.sync()?.entries.at(-1)?.entryId).toBe("native-final"));
    expect(h.logs.filter(line => line.includes("缓冲已满"))).toHaveLength(1);
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.sync()?.source).toMatchObject({ ready: true });
    expect(h.sync()?.source?.epoch).not.toBe(originalEpoch);
    expect(h.sync()?.entries.some(entry => entry.entryId.startsWith("discarded-"))).toBe(false);
  });

  it("repairs an overflowing desktop attach once instead of invalidating it for every incoming chunk", async () => {
    const h = harness(true);
    let resolve!: (value: unknown) => void;
    h.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    h.runtime.markStarted();
    h.notify("thread/started", { threadId: "session" });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5000; ++i) h.notify("item/completed", {
      threadId: "session", turnId: "turn", item: answer(`discarded-${i}`),
    });
    resolve({ data: turns(true) });
    await vi.waitFor(() => expect(h.sync()?.source?.ready).toBe(true));
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.logs.filter(line => line.includes("缓冲已满"))).toHaveLength(1);
    expect(h.sync()?.entries.map(entry => entry.entryId)).toEqual(["uuid-user", "msg-answer", "exec-native", "exec-native:result"]);
  });

  it("never resurrects reverted disk history and confines legacy fallback to native retained turns", async () => {
    const h = harness();
    writeFileSync(join(h.root, "rollout-session.jsonl"), [
      { type: "session_meta", payload: { id: "session" } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "kept", item: user("uuid-kept") } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "removed", item: answer("msg-removed") } },
    ].map(line => JSON.stringify(line)).join("\n"));
    h.setNative([]);
    await h.runtime.activate({ type: "resume", sessionId: "session" });
    expect(h.sync()).toMatchObject({ entries: [], source: { ready: true } });
    h.setNative([{ id: "kept", status: "completed", items: [] }]);
    await h.runtime.activate({ type: "resume", sessionId: "session" });
    expect(h.sync()?.entries.map(entry => entry.entryId)).toEqual(["uuid-kept"]);
  });

  it("automatically attaches desktop history without publishing resume's synthesized graph", async () => {
    const h = harness(true);
    h.runtime.markStarted();
    h.notify("thread/started", { threadId: "session" });
    await vi.waitFor(() => expect(h.sync()?.source?.ready).toBe(true));
    expect(h.sync()?.entries.map(entry => [entry.entryId, entry.parentId])).toEqual([
      ["uuid-user", null], ["msg-answer", "uuid-user"], ["exec-native", "msg-answer"], ["exec-native:result", "exec-native"],
    ]);
  });

  it.each(["resume", "new"] as const)("seeds %s from native IDs and stays identical across reconcile and reactivation", async type => {
    const h = harness();
    await h.runtime.activate(type === "resume" ? { type, sessionId: "session" } : { type, cwd: "D:/repo" });
    const original = h.sync()?.entries;
    expect(original?.map(entry => [entry.entryId, entry.parentId])).toEqual([
      ["uuid-user", null], ["msg-answer", "uuid-user"], ["exec-native", "msg-answer"], ["exec-native:result", "exec-native"],
    ]);
    h.notify("thread/reverted", { threadId: "session" });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.sync()?.source?.ready).toBe(true));
    expect(h.sync()?.entries).toEqual(original);
    await h.runtime.activate({ type: "resume", sessionId: "session" });
    expect(h.sync()?.entries).toEqual(original);
  });

  it("hydrates fork from its own full native history instead of the fork response", async () => {
    const h = harness();
    await h.runtime.activate({ type: "resume", sessionId: "session" });
    h.runtime.handleCommand({ type: "slash.execute", name: "fork", args: "" }, "fork", "session");
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "fork", ok: true })));
    expect(h.request).toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({ threadId: "forked", itemsView: "full" }));
    expect(h.sync("forked")?.entries).toEqual(h.sync()?.entries);
  });

  it("buffers completion during initial history load without inventing a root parent", async () => {
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const activating = h.runtime.activate({ type: "resume", sessionId: "session" });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.notify("item/completed", { threadId: "session", turnId: "turn", item: tool });
    expect(h.sync()).toMatchObject({ entries: [], source: { ready: false }, checkpoint: { headCompleteness: "unknown" } });
    expect(h.events.filter(event => event.type === "session.patch" && event.source.ready)).toHaveLength(0);
    resolve({ data: turns(true) });
    await activating;
    expect(h.sync()?.entries.find(entry => entry.entryId === "exec-native")?.parentId).toBe("msg-answer");
  });

  it("discards an initial read invalidated by a new turn and rehydrates the running source", async () => {
    const h = harness();
    let resolve!: (value: unknown) => void;
    h.read.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const activating = h.runtime.activate({ type: "resume", sessionId: "session" });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.setNative([...turns(true), { id: "running", status: "inProgress", startedAt: 1_800_000_000, items: [] }]);
    h.notify("turn/started", { threadId: "session", turn: { id: "running", startedAt: 1_800_000_000 } });
    resolve({ data: turns(true) });
    await activating;
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.sync()).toMatchObject({ source: { ready: true }, live: { turn: { turnId: "running" } } });
  });

  it("never substitutes resume IDs or commits buffered items after a failed full read", async () => {
    const h = harness();
    let reject!: (error: Error) => void;
    h.read.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const activating = h.runtime.activate({ type: "resume", sessionId: "session" });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(1));
    h.notify("item/completed", { threadId: "session", turnId: "turn", item: tool });
    reject(new Error("temporary_native_failure"));
    await activating;
    expect(h.sync()).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ type: "command.result", ok: false, error: "temporary_native_failure" });
    h.notify("item/completed", { threadId: "session", turnId: "turn", item: tool });
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.sync()?.source?.ready).toBe(true));
    expect(h.sync()?.entries.find(entry => entry.entryId === "exec-native")?.parentId).toBe("msg-answer");
  });

  it("rejects incomplete native items even when resume supplies a complete-looking history", async () => {
    const h = harness();
    h.read.mockResolvedValueOnce({ data: [{ id: "turn", itemsView: "summary", items: [] }] });
    await h.runtime.activate({ type: "resume", sessionId: "session" });
    expect(h.sync()).toBeUndefined();
    expect(h.events.at(-1)).toMatchObject({ ok: false, error: "codex_native_history_incomplete" });
  });
});
