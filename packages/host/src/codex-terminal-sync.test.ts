import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@orbis/protocol";
import type { CodexAppServer } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import type { CodexTerminalConnectionInput } from "./codex-terminal-connection.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });

function harness() {
  const events: RuntimeEvent[] = [];
  const rolloutRoot = mkdtempSync(join(tmpdir(), "orbis-terminal-sync-"));
  const settings = { model: "terminal-model", modelProvider: "terminal-provider", reasoningEffort: "high",
    sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never", approvalsReviewer: "user" };
  const snapshot = { id: "terminal", cwd: rolloutRoot, path: join(rolloutRoot, "rollout-terminal.jsonl"),
    status: { type: "idle" }, turns: [] as unknown[] };
  const resume = vi.fn<() => Promise<unknown>>(() => Promise.resolve({ ...settings, thread: snapshot }));
  const listTurns = vi.fn<() => Promise<unknown>>(() => Promise.resolve({ data: snapshot.turns }));
  const request = vi.fn((method: string) => {
    if (method === "thread/resume") return resume().then(value => {
      snapshot.turns = (value as { thread: { turns: unknown[] } }).thread.turns;
      return value;
    });
    if (method === "thread/turns/list") return listTurns();
    if (method === "turn/start") return Promise.resolve({ turn: { id: "phone-turn" } });
    if (method === "config/read") return Promise.resolve({ config: {} });
    if (method === "config/batchWrite") return Promise.resolve({ status: "ok" });
    if (method === "model/list") return Promise.resolve({ data: [
      { id: "terminal-model", isDefault: true }, { id: "gpt-6-astra" },
    ] });
    return Promise.resolve({ data: [] });
  });
  const server = { request, endpoint: "ws://127.0.0.1:9931", codexCommand: { command: "node.exe", prefixArgs: ["codex.js"] } } as unknown as CodexAppServer;
  let select: CodexTerminalConnectionInput["onThread"] = () => {};
  const runtime = new CodexRuntime({ server, rolloutRoot, onEvent: event => events.push(event),
    createTerminalConnection: async ({ onThread }) => { select = onThread; return {
      endpoint: "ws://127.0.0.1:19931/terminal", selectedThreadId: "terminal", selectionPending: false, acquireClose: () => () => {}, close: async () => {},
    }; },
    pollTuiProcesses: async () => new Set(["__orbis_remote_tui__"]) });
  runtime.markStarted();
  cleanups.push(() => { server.onExit?.(0); rmSync(rolloutRoot, { recursive: true, force: true }); });
  const notify = (method: string, params: unknown) => server.onNotification?.(method, params);
  const launch = async (awaitHydration = true) => {
    await runtime.prepareTerminalLaunch(rolloutRoot);
    select(snapshot);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    // Selection now binds immediately; wait for native hydration to publish the
    // initial metadata before testing history or subsequent notifications.
    if (awaitHydration) await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "runtime.metadata", metadata: expect.objectContaining({ sessionId: "terminal" }),
    })));
  };
  const sync = () => {
    const start = events.length;
    runtime.handleCommand({ type: "session.sync", sessionId: "terminal", syncId: "phone-sync", range: "preview" }, "sync", "terminal");
    return events.slice(start);
  };
  return { runtime, server, events, settings, snapshot, request, resume, listTurns, notify, launch, sync };
}

const user = (id: string, text: string) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const assistant = (id: string, text: string) => ({ id, type: "agentMessage", text });

describe("terminal Codex session synchronization", () => {
  it("rejects startup before creating a thread when native project authorization fails", async () => {
    const h = harness();
    h.request.mockImplementation((method: string) => method === "config/read" ? Promise.resolve({ config: {} })
      : method === "config/batchWrite" ? Promise.resolve({ status: "okOverridden" }) : Promise.resolve({ data: [] }));
    await expect(h.runtime.activate({ type: "new", cwd: h.snapshot.cwd })).rejects.toThrow("项目授权未生效");
    expect(h.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    expect(h.runtime.directoryEntries()).toEqual([]);
    await expect(h.runtime.prepareTerminalLaunch(h.snapshot.cwd)).rejects.toThrow("项目授权未生效");
  });

  it("accepts an empty subscribed terminal when turns/list rejects it before the first message", async () => {
    const h = harness();
    h.listTurns.mockRejectedValueOnce(new Error(
      "thread terminal is not materialized yet; thread/turns/list is unavailable before first user message（code=-32600）",
    ));
    await h.launch();
    expect(h.sync()).toContainEqual(expect.objectContaining({
      type: "session.snapshot", entries: [], complete: true, source: expect.objectContaining({ ready: true }),
    }));
    h.notify("item/completed", { threadId: "terminal", turnId: "first", item: user("u1", "first message") });
    h.notify("item/completed", { threadId: "terminal", turnId: "first", item: assistant("a1", "first answer") });
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "session.snapshot", entries: [
      expect.objectContaining({ entryId: "u1", parentId: null }), expect.objectContaining({ entryId: "a1", parentId: "u1" }),
    ] }));
  });

  it("subscribes to the terminal thread and loads history, tree, model and effective permissions", async () => {
    const h = harness();
    h.snapshot.turns = [{ id: "terminal-turn", status: "completed", items: [user("u1", "from terminal"), assistant("a1", "answer")] }];
    await h.launch();
    expect(h.request).toHaveBeenCalledWith("thread/resume", { threadId: "terminal" });
    expect(h.runtime.directoryEntries()[0]).toMatchObject({ sessionLeafId: "a1", thinkingLevel: "high",
      model: { id: "terminal-model", provider: "terminal-provider" }, permissions: { sandbox: "dangerFullAccess", approvalPolicy: "never" } });
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "session.snapshot", syncId: "phone-sync", entries: [
      expect.objectContaining({ entryId: "u1", parentId: null }), expect.objectContaining({ entryId: "a1", parentId: "u1" }),
    ] }));
    const capabilities = h.events.filter(event => event.type === "runtime.capabilities").at(-1);
    expect(capabilities).toMatchObject({ capabilities: { commands: expect.arrayContaining([
      expect.objectContaining({ name: "tree", argument: expect.objectContaining({ options: expect.arrayContaining([expect.objectContaining({ value: "u1" })]) }) }),
    ]) } });
    h.notify("item/completed", { threadId: "terminal", turnId: "second", item: assistant("a2", "next answer") });
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "session.snapshot", cursor: { leafId: "a2" } }));
    h.notify("thread/settings/updated", { threadId: "terminal", threadSettings: { ...h.settings, approvalPolicy: "on-request" } });
    expect(h.runtime.directoryEntries()[0]?.permissions?.approvalPolicy).toBe("on-request");
    h.runtime.handleCommand({ type: "user_message", text: "from phone", messageId: "phone" }, "send", "terminal");
    expect(h.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: "terminal", clientUserMessageId: "phone" }));
  });

  it("retries after the first turn materializes instead of permanently losing the terminal history", async () => {
    const h = harness();
    h.resume.mockRejectedValueOnce(new Error("no rollout found for thread id terminal"));
    await h.launch();
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "session.snapshot", entries: [], complete: true }));
    h.snapshot.turns = [{ id: "first", status: "completed", items: [user("u1", "first message"), assistant("a1", "first answer")] }];
    // An unsubscribed observer receives status broadcasts, but misses all first-turn items.
    h.notify("thread/status/changed", { threadId: "terminal", status: { type: "idle" } });
    await vi.waitFor(() => expect(h.runtime.directoryEntries()[0]?.sessionLeafId).toBe("a1"));
    expect(h.resume).toHaveBeenCalledTimes(2);
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "session.snapshot", entries: expect.arrayContaining([
      expect.objectContaining({ entryId: "u1" }), expect.objectContaining({ entryId: "a1" }),
    ]) }));
    expect(h.runtime.directoryEntries()[0]?.permissions?.sandbox).toBe("dangerFullAccess");
  });

  it("keeps pre-input model selections without settings RPCs and preserves them through the first subscription", async () => {
    const h = harness();
    h.resume.mockRejectedValueOnce(new Error("no rollout found for thread id terminal"));
    await h.launch();
    h.request.mockClear();
    h.runtime.handleCommand({ type: "slash.execute", name: "model", args: "gpt-6-astra" }, "model", "terminal");
    h.runtime.handleCommand({ type: "slash.execute", name: "thinking", args: "low" }, "thinking", "terminal");
    expect(h.events).toContainEqual({ type: "command.result", commandId: "model", ok: true });
    expect(h.events).toContainEqual({ type: "command.result", commandId: "thinking", ok: true });
    expect(h.request).not.toHaveBeenCalled();
    h.snapshot.turns = [{ id: "first", status: "completed", items: [user("u1", "first terminal input")] }];
    h.notify("thread/status/changed", { threadId: "terminal", status: { type: "idle" } });
    await vi.waitFor(() => expect(h.runtime.directoryEntries()[0]?.sessionLeafId).toBe("u1"));
    h.notify("thread/settings/updated", { threadId: "terminal", threadSettings: {
      ...h.settings, effort: "high", approvalPolicy: "on-request",
    } });
    expect(h.runtime.directoryEntries()[0]).toMatchObject({ model: { id: "gpt-6-astra" }, thinkingLevel: "low",
      permissions: { approvalPolicy: "on-request" } });
    h.runtime.handleCommand({ type: "user_message", text: "from phone" }, "send", "terminal");
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: "terminal", model: "gpt-6-astra", effort: "low",
    })));
    expect(h.request.mock.calls.some(([method]) => method === "thread/settings/update")).toBe(false);
  });

  it("accepts an empty live resume before its rollout file exists", async () => {
    const h = harness();
    await h.launch();
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "session.snapshot", entries: [], complete: true }));
    h.notify("item/completed", { threadId: "terminal", turnId: "first", item: user("u1", "first message") });
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "session.snapshot", cursor: { leafId: "u1" } }));
  });

  it("retries through the window watcher when no later status broadcast arrives", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.resume.mockRejectedValueOnce(new Error("no rollout found for thread id terminal"));
    await h.launch();
    h.snapshot.turns = [{ id: "first", status: "completed", items: [user("u1", "missed broadcast")] }];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.resume).toHaveBeenCalledTimes(2);
    expect(h.runtime.directoryEntries()[0]?.sessionLeafId).toBe("u1");
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "command.result", ok: true }));
  });

  it("preserves notifications arriving before the resume response and restores a running turn for stop", async () => {
    const h = harness();
    let resolve!: (result: unknown) => void;
    h.resume.mockImplementationOnce(() => new Promise(result => { resolve = result; }));
    await h.launch(false);
    h.notify("item/completed", { threadId: "terminal", turnId: "running", item: assistant("a2", "newer answer") });
    h.notify("thread/settings/updated", { threadId: "terminal", threadSettings: { ...h.settings, approvalPolicy: "on-request" } });
    resolve({ ...h.settings, thread: { ...h.snapshot, status: { type: "active" }, turns: [
      { id: "running", status: "inProgress", items: [user("u1", "in progress")] },
    ] } });
    await vi.waitFor(() => expect(h.runtime.directoryEntries()[0]?.sessionLeafId).toBe("a2"));
    expect(h.runtime.directoryEntries()[0]).toMatchObject({ status: "running", permissions: { approvalPolicy: "on-request" } });
    h.runtime.handleCommand({ type: "stop" }, "stop", "terminal");
    expect(h.request).toHaveBeenCalledWith("turn/interrupt", { threadId: "terminal", turnId: "running" });
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "session.snapshot", entries: [
      expect.objectContaining({ entryId: "u1", parentId: null }), expect.objectContaining({ entryId: "a2", parentId: "u1" }),
    ] }));
  });

  it("retries a failed subscription and never republishes a thread after the server exits", async () => {
    const h = harness();
    h.resume.mockRejectedValueOnce(new Error("temporary transport failure"));
    await h.launch();
    expect(h.sync()).toContainEqual(expect.objectContaining({ type: "command.result", ok: false, error: "codex_attach_pending" }));
    let resolve!: (result: unknown) => void;
    h.resume.mockImplementationOnce(() => new Promise(result => { resolve = result; }));
    h.notify("thread/status/changed", { threadId: "terminal", status: { type: "idle" } });
    h.server.onExit?.(0);
    const count = h.events.length;
    resolve({ ...h.settings, thread: h.snapshot });
    await new Promise(result => setTimeout(result, 10));
    expect(h.runtime.directoryEntries()).toEqual([]);
    expect(h.events).toHaveLength(count);
  });
});
