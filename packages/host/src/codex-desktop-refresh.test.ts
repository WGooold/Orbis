import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@pi-remote/protocol";
import type { CodexAppServer } from "./codex-daemon.js";
import { CodexDesktopRefreshBridge } from "./codex-desktop-refresh-bridge.js";
import { CodexDesktopRefreshDriver, desktopHistoryRevision } from "./codex-desktop-refresh.js";
import { CodexClientRefreshCoordinator, FileCodexRefreshJournal } from "./codex-client-refresh.js";
import { CodexRuntime } from "./codex-runtime.js";

const app = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock("./codex-desktop-app.js", () => ({ openCodexDesktopThread: app.open }));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); app.open.mockReset(); });

const turns = (count = 2) => Array.from({ length: count }, (_, i) => ({ id: `t${i + 1}`, status: "completed",
  items: [{ id: `u${i + 1}`, type: "userMessage", content: [{ type: "text", text: `question ${i + 1}` }] },
    { id: `a${i + 1}`, type: "agentMessage", text: `answer ${i + 1}` }] }));

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "orbis-desktop-refresh-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let retained = turns();
  let archived = false;
  let loaded = true;
  let busy = false;
  let child = false;
  let failUnarchive = false;
  let subscribed = true;
  const events: RuntimeEvent[] = [];
  const lifecycle: string[] = [];
  const open = vi.fn(async () => {});
  let notify: (method: string, params: unknown) => void = () => {};
  const bridge = new CodexDesktopRefreshBridge((method, params) => request(method, params));
  const response = (id: number, result: unknown) => bridge.guiResponse(JSON.stringify({ id, result }));
  const gui = (method: string, params: unknown, id = 1) => bridge.guiRequest(JSON.stringify({ id, method, params }));
  // Captured from the actual GUI handshake of Windows MSIX 26.1002.7124.0.
  gui("initialize", { clientInfo: { name: "codex_desktop", version: "26.1002.52244" } });
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (method === "thread/list") return { data: params.ancestorThreadId ? child ? [{ id: "child" }] : []
      : [{ id: "session", cwd: "D:/repo", path: "D:/codex/sessions/rollout.jsonl", status: { type: "idle" } }], nextCursor: null };
    if (method === "thread/loaded/list") return { data: loaded ? ["session"] : [] };
    if (method === "thread/queue/list") return { data: busy ? [{ id: "queued" }] : [] };
    if (method === "thread/read" || method === "thread/resume") {
      if (method === "thread/resume") { loaded = true; subscribed = true; lifecycle.push("resume"); }
      return { thread: { id: "session", cwd: "D:/repo", path: archived ? "D:/codex/archived_sessions/rollout.jsonl" : "D:/codex/sessions/rollout.jsonl",
        status: { type: busy ? "active" : loaded ? "idle" : "notLoaded" }, turns: method === "thread/resume" ? retained : [] } };
    }
    if (method === "thread/turns/list") return { data: retained, nextCursor: null };
    if (method === "thread/revert") {
      lifecycle.push("revert"); retained = turns(1);
      notify("thread/reverted", { threadId: "session" });
      return { thread: { id: "session", turns: [] } };
    }
    if (method === "thread/archive") {
      lifecycle.push("archive"); archived = true; loaded = false; subscribed = false;
      notify("thread/closed", { threadId: "session" });
      notify("thread/archived", { threadId: "session" });
      bridge.guiResponse(JSON.stringify({ method: "thread/archived", params: { threadId: "session" } }));
      return {};
    }
    if (method === "thread/unarchive") {
      lifecycle.push("unarchive");
      if (failUnarchive) throw new Error("connection lost");
      archived = false;
      notify("thread/unarchived", { threadId: "session" });
      bridge.guiResponse(JSON.stringify({ method: "thread/unarchived", params: { threadId: "session" } }));
      return {};
    }
    return { data: [] };
  });
  const endpoint = await bridge.listen();
  cleanup.push(async () => bridge.close());
  const server = { mode: "external", request, stop: vi.fn(async () => {}), notify: vi.fn() } as unknown as CodexAppServer;
  const options = { journalDirectory: directory, resolveBridge: () => endpoint };
  const journal = new FileCodexRefreshJournal(directory);
  const protect = vi.fn();
  const driverOptions = { ...options, server, revision: async () => desktopHistoryRevision(retained), localBusy: () => busy,
    isSubscribed: () => subscribed, restored: vi.fn(), protect, openThread: open };
  const coordinator = new CodexClientRefreshCoordinator(journal, new CodexDesktopRefreshDriver(driverOptions));
  const operation = { operationId: "op-1", backendId: "codex-desktop", threadId: "session", historyRevision: desktopHistoryRevision(retained) };
  const runtime = new CodexRuntime({ server, desktopRefresh: options, rolloutRoot: directory, onEvent: event => events.push(event) });
  cleanup.push(() => runtime.stop());
  notify = (method, params) => { server.onNotification?.(method, params); };
  const hydrate = () => {
    gui("thread/turns/list", { threadId: "session", itemsView: "notLoaded" }, 11);
    response(11, { data: retained.map(t => ({ ...t, items: [], itemsView: "notLoaded" })) });
    gui("thread/items/list", { threadId: "session", turnId: retained[0]!.id }, 12);
    response(12, { data: retained[0]!.items });
  };
  return { bridge, endpoint, server, request, events, lifecycle, coordinator, operation, journal, driverOptions, runtime, gui, response,
    hydrate, open, protect, setBusy: () => { busy = true; }, setChild: () => { child = true; }, failUnarchive: () => { failUnarchive = true; } };
}

describe("real desktop refresh driver", () => {
  it("archives, restores the backend subscription, and confirms the GUI's own paginated reload", async () => {
    const h = await harness();
    const first = await h.coordinator.start(h.operation);
    expect(first.status).toBe("awaiting_confirmation");
    expect(h.lifecycle).toEqual(["archive", "unarchive", "resume"]);
    expect(h.open).toHaveBeenCalledExactlyOnceWith("session", "local");
    expect(h.protect).toHaveBeenCalledExactlyOnceWith("session");
    h.hydrate();
    expect((await h.coordinator.recover(h.operation.operationId)).status).toBe("complete");
    expect((await h.journal.list())[0]?.kind).toBe("receipt");
  });

  it("checks the observed GUI protocol version independently of the Windows package version", async () => {
    const h = await harness();
    const first = await h.coordinator.start(h.operation);
    expect(first.status).toBe("awaiting_confirmation");
    const record = (await h.journal.list())[0];
    expect(record).toMatchObject({ plan: { client: { compatibilityVersion: "26.1002.52244" } } });
    expect(h.lifecycle).toEqual(["archive", "unarchive", "resume"]);
  });

  it("recovers a settled archive after Host reconstruction without archiving or reverting again", async () => {
    const h = await harness();
    await h.coordinator.start(h.operation);
    const next = new CodexClientRefreshCoordinator(h.journal, new CodexDesktopRefreshDriver(h.driverOptions));
    const result = await next.recover(h.operation.operationId);
    expect(result.status).toBe("awaiting_confirmation");
    h.hydrate();
    expect((await next.recover(h.operation.operationId)).status).toBe("complete");
    expect(h.lifecycle.filter(s => s === "archive")).toHaveLength(1);
    expect(h.lifecycle).not.toContain("revert");
  });

  it("refuses running/queued threads, all descendant subtrees, and unverified client versions before archive", async () => {
    for (const setup of ["busy", "child", "version"] as const) {
      const h = await harness();
      if (setup === "busy") h.setBusy();
      if (setup === "child") h.setChild();
      if (setup === "version") h.gui("initialize", { clientInfo: { version: "99.1.0" } });
      const result = await h.coordinator.start(h.operation).catch(() => ({ status: "manual_required" }));
      expect(result.status).toBe("manual_required");
      expect(h.lifecycle).not.toContain("archive");
    }
  });

  it("does not unarchive after a concurrent GUI archive request", async () => {
    const h = await harness();
    await h.coordinator.start(h.operation);
    h.gui("thread/archive", { threadId: "session" });
    expect((await h.coordinator.recover(h.operation.operationId)).status).toBe("manual_required");
    expect(h.lifecycle).toEqual(["archive", "unarchive", "resume"]);
  });

  it("accepts the GUI's queue read while confirming its reopened history", async () => {
    const h = await harness();
    await h.coordinator.start(h.operation);
    h.gui("thread/queue/list", { threadId: "session" }, 13);
    h.response(13, { data: [] });
    h.hydrate();
    expect((await h.coordinator.recover(h.operation.operationId)).status).toBe("complete");
    expect(h.lifecycle).toEqual(["archive", "unarchive", "resume"]);
    expect(await h.bridge.command({ ...h.operation, action: "inspect" })).toMatchObject({ conflict: false, guiReloaded: true });
  });

  it.each(["add", "update", "delete", "reorder", "start"])("still rejects a concurrent GUI queue %s", async action => {
    const h = await harness();
    await h.coordinator.start(h.operation);
    h.gui(`thread/queue/${action}`, { threadId: "session" });
    expect((await h.coordinator.recover(h.operation.operationId)).status).toBe("manual_required");
    expect(h.lifecycle).toEqual(["archive", "unarchive", "resume"]);
  });

  it("keeps an uncertain unarchive result for inspection instead of repeating the native mutation", async () => {
    const h = await harness();
    h.failUnarchive();
    expect((await h.coordinator.start(h.operation)).status).toBe("recovery_pending");
    const restarted = new CodexClientRefreshCoordinator(h.journal, new CodexDesktopRefreshDriver(h.driverOptions));
    expect((await restarted.recover(h.operation.operationId)).status).toBe("recovery_pending");
    expect(h.lifecycle).toEqual(["archive", "unarchive"]);
  });

  it("requires control authentication and deduplicates native archive on retried control requests", async () => {
    const h = await harness();
    const body = JSON.stringify({ ...h.operation, action: "begin" });
    expect((await fetch(h.endpoint.url, { method: "POST", body })).status).toBe(403);
    await h.bridge.command({ ...h.operation, action: "begin" });
    await Promise.all([h.bridge.command({ ...h.operation, action: "archive" }), h.bridge.command({ ...h.operation, action: "archive" })]);
    expect(h.lifecycle).toEqual(["archive"]);
  });

  it("ignores old GUI reads and metadata-only responses as hydration evidence", async () => {
    const h = await harness();
    h.gui("thread/read", { threadId: "session", includeTurns: true }, 4);
    await h.coordinator.start(h.operation);
    h.response(4, { thread: { turns: turns() } });
    h.gui("thread/read", { threadId: "session", includeTurns: false }, 5);
    h.response(5, { thread: { turns: [] } });
    expect((await h.coordinator.recover(h.operation.operationId)).status).toBe("awaiting_confirmation");
  });

  it("does not correlate a server request that reuses a pending GUI history request ID", async () => {
    const h = await harness();
    await h.coordinator.start(h.operation);
    h.gui("thread/turns/list", { threadId: "session", itemsView: "notLoaded" }, 11);
    h.bridge.guiResponse(JSON.stringify({ id: 11, method: "item/commandExecution/requestApproval", params: {} }));
    h.response(11, { data: turns() });
    h.gui("thread/items/list", { threadId: "session", turnId: "t1" }, 12);
    h.response(12, { data: turns()[0]!.items });
    expect((await h.coordinator.recover(h.operation.operationId)).status).toBe("complete");
  });

  it("rejects stale wrapper incarnation after recovery instead of compensating another desktop process", async () => {
    const h = await harness();
    await h.coordinator.start(h.operation);
    const next = new CodexClientRefreshCoordinator(h.journal, new CodexDesktopRefreshDriver({ ...h.driverOptions,
      resolveBridge: () => ({ ...h.endpoint, instanceId: "another-instance" }) }));
    expect((await next.recover(h.operation.operationId)).status).toBe("manual_required");
    expect(h.lifecycle).toEqual(["archive", "unarchive", "resume"]);
  });
});

describe("phone tree to desktop lifecycle", () => {
  it("ends only the matching refresh condition after native GUI hydration is confirmed", async () => {
    const h = await harness(); h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(1));
    h.server.onNotification?.("windowsSandbox/setupCompleted", { success: false, error: "sandbox failure" });
    h.runtime.handleCommand({ type: "slash.execute", name: "tree", args: "u2" }, "tree-notice", "session");
    const inventory = () => h.events.filter(event => event.type === "notification.source").at(-1)?.notifications ?? [];
    await vi.waitFor(() => expect(inventory().map(item => item.code).sort()).toEqual(["codex.refresh", "codex.sandbox"]));
    expect(inventory().find(item => item.code === "codex.refresh")?.scope.operationId).toBeTruthy();
    h.hydrate();
    await vi.waitFor(() => expect(inventory().map(item => item.code)).toEqual(["codex.sandbox"]), { timeout: 4000 });
    expect(h.lifecycle.filter(item => item === "revert")).toHaveLength(1);
  });
  it("does not tell the phone to archive manually when GUI reopening queries its queue", async () => {
    const h = await harness();
    app.open.mockImplementation(async () => {
      h.gui("thread/queue/list", { threadId: "session" }, 13);
      h.response(13, { data: [] });
      h.hydrate();
    });
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(1));
    h.runtime.handleCommand({ type: "slash.execute", name: "tree", args: "u2" }, "tree-queue", "session");
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "tree-queue", ok: true })));
    expect(h.lifecycle).toEqual(["resume", "revert", "archive", "unarchive", "resume"]);
    expect((await h.journal.list())[0]).toMatchObject({ kind: "receipt", result: { status: "complete" } });
    expect(h.events.filter(event => event.type === "runtime.error")).toEqual([]);
  });

  it("wires real refresh after committed tree, retaining the mobile session throughout temporary archive", async () => {
    const h = await harness();
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(1));
    expect(h.runtime.directoryEntries()).toHaveLength(1);
    h.runtime.handleCommand({ type: "slash.execute", name: "tree", args: "u2" }, "tree-1", "session");
    await vi.waitFor(() => expect(h.events.some(e => e.type === "command.result" && e.commandId === "tree-1")).toBe(true));
    expect(h.lifecycle).toEqual(["resume", "revert", "archive", "unarchive", "resume"]);
    expect(app.open).toHaveBeenCalledExactlyOnceWith("session", "local");
    expect(h.events.find(e => e.type === "command.result" && e.commandId === "tree-1")).toMatchObject({ ok: true, result: { editorText: "question 2" } });
    expect(h.runtime.directoryEntries().map(e => e.sessionId)).toEqual(["codex-desktop:session"]);
    h.runtime.handleCommand({ type: "session.sync", sessionId: "codex-desktop:session", syncId: "after", range: "preview" }, "after", "session");
    await vi.waitFor(() => expect(h.events.some(e => e.type === "session.snapshot" && e.syncId === "after")).toBe(true));
    expect(h.events.find(e => e.type === "session.snapshot" && e.syncId === "after")).toMatchObject({ entries: [{ entryId: "u1" }, { entryId: "a1" }] });
  });

  it("does not refresh a no-op tree or a desktop-originated revert notification", async () => {
    const h = await harness();
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(1));
    h.runtime.handleCommand({ type: "slash.execute", name: "tree", args: "a2" }, "noop", "session");
    h.server.onNotification?.("thread/reverted", { threadId: "session" });
    await vi.waitFor(() => expect(h.events.some(e => e.type === "command.result" && e.commandId === "noop")).toBe(true));
    expect(h.lifecycle).toEqual(["resume"]);
    expect(app.open).not.toHaveBeenCalled();
  });
});
