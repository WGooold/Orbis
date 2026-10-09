import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@pi-remote/protocol";
import type { CodexAppServer } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";

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
  const request = vi.fn((method: string) => {
    if (method === "thread/resume") return resume().then(value => {
      snapshot.turns = (value as { thread: { turns: unknown[] } }).thread.turns;
      return value;
    });
    if (method === "thread/turns/list") return Promise.resolve({ data: snapshot.turns });
    if (method === "turn/start") return Promise.resolve({ turn: { id: "phone-turn" } });
    return Promise.resolve({ data: [] });
  });
  const server = { request, endpoint: "ws://127.0.0.1:9931", codexCommand: { command: "node.exe", prefixArgs: ["codex.js"] } } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, rolloutRoot, onEvent: event => events.push(event), tuiSwitchGraceMs: 1,
    pollTuiProcesses: async () => new Set(["__orbis_remote_tui__"]) });
  runtime.markStarted();
  cleanups.push(() => { server.onExit?.(0); rmSync(rolloutRoot, { recursive: true, force: true }); });
  const notify = (method: string, params: unknown) => server.onNotification?.(method, params);
  const launch = async () => {
    await runtime.prepareTerminalLaunch(rolloutRoot);
    notify("thread/started", { thread: snapshot });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
  };
  const sync = () => {
    const start = events.length;
    runtime.handleCommand({ type: "session.sync", sessionId: "terminal", syncId: "phone-sync", range: "preview" }, "sync", "terminal");
    return events.slice(start);
  };
  return { runtime, server, events, settings, snapshot, request, resume, notify, launch, sync };
}

const user = (id: string, text: string) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const assistant = (id: string, text: string) => ({ id, type: "agentMessage", text });

describe("terminal Codex session synchronization", () => {
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
    await h.launch();
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
