import { testDirectorySync } from "../../../scripts/test-fixtures/temp-directory.js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServer, type CodexTransport } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import type { RuntimeEvent } from "@orbis/protocol";

function transport(reply: (frame: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const messages: Array<(text: string) => void> = [];
  const close = vi.fn(async () => {});
  const value: CodexTransport = {
    send(text) {
      const frame = JSON.parse(text) as Record<string, unknown>;
      const response = reply(frame);
      if (response) queueMicrotask(() => messages.forEach(handler => handler(JSON.stringify(response))));
    },
    close,
    onMessage: handler => { messages.push(handler); },
    onClose: () => {},
  };
  return { value, close };
}

const runtimes: CodexRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); });

function desktopHarness(mode: "desktop" | "external" = "desktop", endpoint?: string) {
  const loaded = new Set<string>();
  const native = new Set<string>();
  const subagents = new Set<string>();
  const ephemeral = new Set<string>();
  const history = new Map<string, unknown[]>();
  const noRollout = new Set<string>();
  const parents = new Map<string, string>();
  const events: Array<{ event: RuntimeEvent; threadId?: string }> = [];
  const archived = new Set<string>();
  const status = new Map<string, "idle" | "active">();
  const calls: string[] = [];
  const stop = vi.fn(async () => {});
  let releaseResume: (() => void) | undefined;
  let pauseResume = false;
  const request = vi.fn(async (method: string, params?: { threadId?: string; archived?: boolean; includeTurns?: boolean; limit?: number }) => {
    calls.push(method);
    if (method === "model/list" || method === "skills/list" || method === "mcpServerStatus/list") return { data: [] };
    if (method === "thread/loaded/list") return { data: [...loaded] };
    if (method === "thread/list") return { data: [...native].filter(id => archived.has(id) === (params?.archived === true)).map(id => ({
      id, cwd: "D:/repo", name: id, createdAt: 1_780_000_000, updatedAt: 1_780_000_001, turns: [],
      ...(subagents.has(id) ? { source: { subAgent: "review" } } : {}),
      ...(ephemeral.has(id) ? { ephemeral: true, threadSource: "thread_title" } : {}),
    })) };
    const id = params?.threadId ?? "";
    const thread = { id, cwd: "D:/repo", name: id, path: archived.has(id) ? "D:/archived_sessions/rollout.jsonl" : "D:/sessions/rollout.jsonl", status: { type: status.get(id) ?? "idle" }, turns: [],
      ...(subagents.has(id) ? { source: { subAgent: "review" } } : {}),
      ...(ephemeral.has(id) ? { ephemeral: true, threadSource: "thread_title" } : {}),
      ...(parents.has(id) ? { parentThreadId: parents.get(id), agentNickname: id } : {}) };
    if (method === "thread/read") return { thread: { ...thread, turns: params?.includeTurns ? history.get(id) ?? [] : [] } };
    if (method === "thread/archive" || method === "thread/unarchive") {
      if (method === "thread/archive") archived.add(id);
      else archived.delete(id);
      return {};
    }
    if (method === "thread/start") return { thread: { id: "fresh", cwd: "D:/repo", name: "fresh", path: "D:/sessions/rollout.jsonl", status: { type: "idle" }, turns: [] }, model: "gpt-5.5" };
    if (method === "thread/unsubscribe") return {};
    if (method === "thread/turns/list") {
      if (noRollout.has(id)) throw new Error(`thread ${id} is not materialized yet; thread/turns/list is unavailable before first user message`);
      return { data: history.get(id) ?? [] };
    }
    if (method === "thread/resume") {
      if (pauseResume) await new Promise<void>(resolve => { releaseResume = resolve; });
      return { thread, model: "gpt-5.5" };
    }
    throw new Error(`unexpected RPC: ${method}`);
  });
  const server = { mode, endpoint, request, stop, notify: vi.fn() } as unknown as CodexAppServer;
  const opened: string[] = [];
  const rolloutRoot = testDirectorySync(join(tmpdir(), "orbis-desktop-test-"));
  const runtime = new CodexRuntime({ server, onEvent: (event, threadId) => { events.push({ event, ...(threadId ? { threadId } : {}) }); }, rolloutRoot, openHeadWindow: ({ sessionId }) => { opened.push(sessionId); } });
  runtimes.push(runtime);
  const notify = (method: string, params: unknown) => server.onNotification?.(method, params);
  return { loaded, native, subagents, parents, ephemeral, history, noRollout, events, archived, status, calls, stop, request, server, runtime, notify, opened, rolloutRoot,
    pause: () => { pauseResume = true; },
    release: () => { releaseResume?.(); },
  };
}

describe("Codex desktop attachment", () => {
  // CODEX-UNIFIED-01: reading an unloaded session is not a reason to adopt it or start Terminal.
  it("includes saved history from a desktop-only connection without consulting the ownership ledger", async () => {
    const h = desktopHarness();
    h.native.add("before-pairing");
    h.native.add("archived-before-pairing"); h.archived.add("archived-before-pairing");
    h.native.add("child"); h.subagents.add("child");
    h.native.add("ephemeral"); h.ephemeral.add("ephemeral");
    expect(await h.runtime.catalog()).toEqual([]);
    expect(await h.runtime.unifiedCatalog(false)).toMatchObject({ complete: true, sessions: [{ sessionId: "before-pairing" }] });
    expect(await h.runtime.unifiedCatalog(true)).toMatchObject({ complete: true, sessions: [{ sessionId: "archived-before-pairing", archived: true }] });
    expect(h.runtime.directoryEntries()).toEqual([]);
    expect(h.calls.every(call => call === "thread/list")).toBe(true);
  });

  it("uses the official proxy's newline-delimited stdio protocol", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin, stdout, stderr, kill: vi.fn(() => { (child as unknown as { exitCode: number | null }).exitCode = 0; child.emit("exit", 0); return true; }) });
    Object.defineProperty(child, "exitCode", { value: null, writable: true, configurable: true });
    const sent: string[] = [];
    stdin.on("data", chunk => {
      const line = chunk.toString("utf8").trim();
      if (line.length === 0) return;
      sent.push(line);
      const frame = JSON.parse(line) as { id: number; method: string };
      const result = frame.method === "initialize" ? {} : { data: [] };
      stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
    });

    // 解析 CLI 只是为了真实拉起进程；注入了 spawn 的测试用文档化的 ORBIS_CODEX_ENTRY 指向一个
    // 临时入口，这样没装 codex 的 CI 不会因为“找不到 codex”而失败（本地装着则永远发现不了）。
    const entry = join(testDirectorySync(join(tmpdir(), "orbis-proxy-cli-")), "codex.js");
    writeFileSync(entry, "");
    vi.stubEnv("ORBIS_CODEX_ENTRY", entry);
    try {
      const server = await CodexAppServer.createDesktop({
        spawnImpl: (_command, args) => {
          expect(args.slice(-2)).toEqual(["app-server", "proxy"]);
          return child;
        },
      });
      expect(sent.map(line => JSON.parse(line).method)).toEqual(["initialize", "initialized", "thread/loaded/list"]);
      await server.stop();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects an incompatible desktop daemon without creating an owned server", async () => {
    const desktop = transport(frame => frame.method === "initialize"
      ? { id: frame.id, result: {} }
      : frame.method === "thread/loaded/list"
        ? { id: frame.id, error: { code: -32601, message: "unknown method" } }
        : undefined);
    const transports = [desktop.value];
    await expect(CodexAppServer.createDesktop({ transportImpl: async () => transports.shift()! })).rejects.toThrow();
    expect(desktop.close).toHaveBeenCalledOnce();
    expect(transports).toHaveLength(0);
  });

  it("discovers loaded idle and later desktop threads, then removes closed sessions", async () => {
    const h = desktopHarness();
    h.loaded.add("first");
    h.native.add("first");
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries().map(entry => entry.sessionId)).toEqual(["codex-desktop:first"]));
    expect(h.runtime.kind).toBe("codexDesktop");
    expect(h.runtime.ownsRuntime("codex:first")).toBe(false);
    expect(h.runtime.ownsRuntime("codex-desktop:first")).toBe(true);
    expect(h.calls).toContain("thread/resume");
    h.loaded.add("second");
    h.native.add("second");
    h.notify("thread/started", { threadId: "second" });
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(2));
    h.loaded.delete("first");
    h.notify("thread/closed", { threadId: "first" });
    await vi.waitFor(() => expect(h.runtime.directoryEntries().map(entry => entry.sessionId)).toEqual(["codex-desktop:second"]));
    expect(h.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "first" });
    await h.runtime.stop();
    expect(h.stop).toHaveBeenCalledOnce();
  });

  // CODEX-DESKTOP-DRAFT-01: reproduce the two visible native IDs plus Desktop's internal title thread.
  it.each([false, true])("keeps a passive draft hidden and adopts the first real turn (same ID=%s)", async reuseDraft => {
    const h = desktopHarness();
    h.loaded.add("draft");
    h.noRollout.add("draft"); // thread/read still advertises a rollout path.
    h.runtime.onDesktopThread = vi.fn();
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.request.mock.calls.some(([method, p]) => method === "thread/turns/list" && p?.threadId === "draft")).toBe(true));
    expect(h.runtime.directoryEntries()).toEqual([]);
    expect(h.runtime.onDesktopThread).not.toHaveBeenCalled();

    const id = reuseDraft ? "draft" : "conversation";
    h.loaded.add(id);
    h.noRollout.delete(id);
    h.history.set(id, [{ id: "first", status: "completed", items: [
      { id: "first-user", type: "userMessage", content: [{ type: "text", text: "first message" }] },
    ] }]);
    // The status may already be idle and the catalog may lag a fast first turn.
    h.loaded.add("title");
    h.status.set("title", "active");
    h.ephemeral.add("title");
    h.history.set("title", [{ id: "title-turn", status: "inProgress", items: [] }]);
    h.notify("thread/status/changed", { threadId: id, status: { type: "idle" } });
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toMatchObject([{
      sessionId: `codex-desktop:${id}`, sessionLeafId: "first-user",
    }]));
    expect(h.request.mock.calls.filter(([method]) => method === "thread/resume").map(([, p]) => p?.threadId)).toEqual([id]);
    expect(h.runtime.onDesktopThread).toHaveBeenCalledExactlyOnceWith(id);
  });

  it("keeps a running Desktop thread even when catalog and history have not materialized", async () => {
    const h = desktopHarness();
    h.loaded.add("busy");
    h.noRollout.add("busy");
    h.status.set("busy", "active");
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toMatchObject([{ sessionId: "codex-desktop:busy", status: "running" }]));
  });

  it.each([false, true])("keeps real idle history without a catalog match (legacy turns API=%s)", async legacy => {
    const h = desktopHarness();
    h.loaded.add("gone");
    h.loaded.add("real");
    h.history.set("real", [{ id: "t", status: "completed", items: [] }]);
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation((method, params) => {
      if (method === "thread/read" && params?.threadId === "gone") return Promise.reject(new Error("thread not found"));
      if (method === "thread/list" && params?.limit === 200) return Promise.reject(new Error("temporary catalog failure"));
      if (legacy && method === "thread/turns/list" && params?.limit === 1) return Promise.reject(new Error("method not found（code=-32601）"));
      return original(method, params);
    });
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toMatchObject([{ sessionId: "codex-desktop:real" }]));
  });

  it("does not undo an App pre-create when an older loaded snapshot arrives after activation", async () => {
    const h = desktopHarness();
    const original = h.request.getMockImplementation()!;
    let staleReply!: (value: { data: string[] }) => void;
    let stale = true;
    h.request.mockImplementation((method, params) => {
      if (method === "thread/loaded/list" && stale) {
        stale = false;
        return new Promise(resolve => { staleReply = resolve; });
      }
      return original(method, params);
    });
    h.noRollout.add("fresh");
    h.runtime.markStarted();
    await vi.waitFor(() => expect(staleReply).toBeTypeOf("function"));
    const created = await h.runtime.activate({ type: "new", cwd: "D:/repo" });
    h.loaded.add("fresh");
    h.notify("thread/started", { thread: { id: "fresh" } });
    staleReply({ data: [] });
    await vi.waitFor(() => expect(h.request.mock.calls.filter(([method]) => method === "thread/loaded/list")).toHaveLength(2));
    expect(h.runtime.directoryEntries()).toMatchObject([{ sessionId: created.sessionId!, status: "idle" }]);
    expect(h.calls).not.toContain("thread/unsubscribe");
    expect(h.calls).not.toContain("thread/resume");
    expect(h.opened).toEqual([]);
  });

  it("does not resume a thread from the desktop watcher while the App is configuring that same launch", async () => {
    const h = desktopHarness();
    let finish!: () => void;
    const configuring = new Promise<void>(resolve => { finish = resolve; });
    h.runtime.markStarted();
    const create = h.runtime.activate({ type: "new", cwd: "D:/repo" }, {
      configuration: {}, onCreated: () => configuring,
    });
    try {
      h.loaded.add("fresh");
      h.native.add("fresh");
      h.status.set("fresh", "active");
      h.notify("thread/started", { thread: { id: "fresh" } });
      await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("thread/read", { threadId: "fresh", includeTurns: false }, 5_000));
      expect(h.runtime.directoryEntries()).toEqual([]);
      expect(h.calls).not.toContain("thread/resume");
    } finally { finish(); await create; }
    expect(h.runtime.directoryEntries()).toMatchObject([{ sessionId: "codex-desktop:fresh" }]);
  });

  it("does not revive old Desktop drafts from shared disk, but keeps catalog-confirmed and real history", async () => {
    const h = desktopHarness();
    const disk = (id: string, originator: string, extra: unknown[] = []) => writeFileSync(join(h.rolloutRoot, `rollout-${id}.jsonl`), [
      { type: "session_meta", payload: { id, cwd: "D:/repo", originator } }, ...extra,
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    disk("draft", "Codex Desktop"); // May already have been persisted by an older Host.
    disk("unknown-draft", "Codex Desktop");
    disk("listed-empty", "Codex Desktop");
    disk("real-no-preview", "Codex Desktop", [{ type: "event_msg", payload: { type: "task_started" } }]);
    disk("terminal-empty", "codex_cli_rs");
    h.native.add("listed-empty");
    h.runtime.seedDesktopThreads(["draft", "listed-empty", "real-no-preview"]);
    const terminal = new CodexRuntime({ server: { mode: "owned", request: h.request, notify: vi.fn(), stop: vi.fn() } as unknown as CodexAppServer,
      onEvent: () => {}, rolloutRoot: h.rolloutRoot });
    runtimes.push(terminal);
    terminal.seedDesktopThreads(["draft", "listed-empty", "real-no-preview"]);
    expect((await h.runtime.catalog()).map(entry => entry.sessionId)).toEqual(["codex-desktop:listed-empty", "codex-desktop:real-no-preview"]);
    expect((await terminal.catalog()).map(entry => entry.sessionId)).toEqual(["terminal-empty"]);
  });

  // Startup ordering is arbitrary: descendants only become tasks of an adopted root.
  it("restores already loaded nested children without attaching them as sessions", async () => {
    const h = desktopHarness();
    for (const id of ["grandchild", "child", "parent"]) h.loaded.add(id);
    h.native.add("parent");
    h.parents.set("child", "parent"); h.parents.set("grandchild", "child");
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.events.filter(item => item.event.type === "execution.tasks").at(-1)).toMatchObject({
      threadId: "parent", event: { tasks: { availability: "unknown", truncated: true, items: [
        { id: "child", status: "idle" }, { id: "grandchild", parentId: "child", status: "idle" },
      ] } },
    }));
    expect(h.runtime.directoryEntries().map(entry => entry.sessionId)).toEqual(["codex-desktop:parent"]);
    expect(h.request.mock.calls.filter(([method]) => method === "thread/resume").map(([, args]) => args?.threadId)).toEqual(["parent"]);
  });

  it("does not expose subagent threads from loaded or persistent desktop catalogs", async () => {
    const h = desktopHarness();
    h.native.add("parent");
    h.native.add("child");
    h.loaded.add("parent");
    h.loaded.add("child");
    h.subagents.add("child");
    h.runtime.markStarted();

    await vi.waitFor(() => expect(h.runtime.directoryEntries().map(entry => entry.sessionId)).toEqual(["codex-desktop:parent"]));
    expect((await h.runtime.catalog()).map(entry => entry.sessionId)).toEqual(["codex-desktop:parent"]);
    expect(h.request).toHaveBeenCalledWith("thread/read", { threadId: "child", includeTurns: false }, 5_000);
  });

  // “桌面版后端”，这套后端会退回成终端语义：runtimeId 变成 `codex`、桌面 thread 发现
  // 根本不启动——端点接上了，手机却什么也看不到。
  // 桌面版的「有头」就是它的 GUI。当初只有 proxy 模式（endpoint 为空）时这条被“恰好”跳过，
  // 换成包装器的外部端点后 endpoint 非空，Host 就会给桌面会话再开一个终端 TUI：
  // 用户那边凭空多一个客户端，而且 GUI 永远不在 `--remote` 进程名单里。
  it("never opens a terminal head window for a desktop session", async () => {
    const h = desktopHarness("external", "ws://127.0.0.1:59069");
    const activated = await h.runtime.activate({ type: "new", cwd: "D:/repo" });
    expect(activated.spawnMode).toBe("headless");
    expect(h.opened).toEqual([]);
  });

  it("treats an external app-server endpoint as the desktop backend", async () => {
    const h = desktopHarness("external");
    h.loaded.add("wrapped");
    h.native.add("wrapped");
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries().map(entry => entry.sessionId)).toEqual(["codex-desktop:wrapped"]));
    expect(h.runtime.kind).toBe("codexDesktop");
    expect(h.runtime.runtimeId).toBe("codex-desktop");
    expect(h.runtime.directoryEntries()[0]?.runtimeId).toBe("codex-desktop:wrapped");
    expect(h.calls).toContain("thread/resume");
  });

  it("unsubscribes after an in-flight resume settles when a view closes", async () => {
    const h = desktopHarness();
    h.loaded.add("closing");
    h.native.add("closing");
    h.pause();
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.calls).toContain("thread/resume"));
    h.loaded.delete("closing");
    h.notify("thread/closed", { threadId: "closing" });
    expect(h.calls).not.toContain("thread/unsubscribe");
    h.release();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "closing" }));
    expect(h.runtime.directoryEntries()).toEqual([]);
  });

  it("replays status notifications after resume and keeps /quit local until new desktop work", async () => {
    const h = desktopHarness();
    h.loaded.add("first");
    h.native.add("first");
    h.pause();
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.calls).toContain("thread/resume"));
    h.status.set("first", "active");
    h.notify("thread/status/changed", { threadId: "first", status: { type: "active" } });
    h.release();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()[0]?.status).toBe("running"));
    const respond = vi.fn();
    h.server.onServerRequest?.({ id: 99, method: "item/commandExecution/requestApproval",
      params: { threadId: "first", turnId: "turn-1", itemId: "item-1", command: "Get-ChildItem" },
      respond, fail: vi.fn() });
    expect(h.runtime.handleCommand({ type: "slash.execute", name: "quit", args: "" }, "quit", "first")).toBe(true);
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(0));
    expect(respond).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    h.notify("thread/started", { threadId: "first" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.runtime.directoryEntries()).toHaveLength(0);
    h.status.set("first", "idle");
    h.notify("thread/status/changed", { threadId: "first", status: { type: "idle" } });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("thread/read", { threadId: "first", includeTurns: false }, 5_000));
    h.status.set("first", "active");
    h.notify("thread/status/changed", { threadId: "first", status: { type: "active" } });
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(1));
    expect(() => h.runtime.assertProviderSwitchReady()).toThrow("共享后端");
  });

  it("keeps desktop history namespaced after closing and supports archive and unarchive", async () => {
    const h = desktopHarness();
    h.loaded.add("desktop-thread");
    h.native.add("desktop-thread");
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(1));

    h.loaded.clear();
    h.notify("thread/closed", { threadId: "desktop-thread" });
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(0));
    expect((await h.runtime.catalog()).map(entry => [entry.sessionId, entry.agentKind]))
      .toEqual([["codex-desktop:desktop-thread", "codexDesktop"]]);

    const changes: Array<[string, boolean]> = [];
    h.runtime.onArchiveChange = (id, archived) => changes.push([id, archived]);
    await h.runtime.setArchived("codex-desktop:desktop-thread", true);
    h.notify("thread/archived", { threadId: "desktop-thread" });
    expect(changes).toEqual([["codex-desktop:desktop-thread", true]]);
    expect(await h.runtime.catalog()).toEqual([]);
    expect((await h.runtime.catalog(true)).map(entry => [entry.sessionId, entry.archived]))
      .toEqual([["codex-desktop:desktop-thread", true]]);
    await h.runtime.setArchived("codex-desktop:desktop-thread", false);
    expect((await h.runtime.catalog()).map(entry => entry.sessionId)).toEqual(["codex-desktop:desktop-thread"]);
    await expect(h.runtime.setArchived("desktop-thread", true)).rejects.toThrow("不属于 Codex 桌面版");
  });

  it("does not let the terminal backend claim an observed desktop thread", async () => {
    const h = desktopHarness();
    h.native.add("desktop-thread");
    h.native.add("terminal-thread");
    h.loaded.add("desktop-thread");
    const terminalRequest = vi.fn(async (method: string, params?: { archived?: boolean }) => {
      if (method === "thread/list") return { data: [...h.native].filter(id => !h.archived.has(id) || params?.archived === true).map(id => ({
        id, cwd: "D:/repo", createdAt: 1_780_000_000, updatedAt: 1_780_000_001, turns: [],
      })) };
      throw new Error(`unexpected terminal RPC: ${method}`);
    });
    const terminal = new CodexRuntime({
      server: { mode: "owned", request: terminalRequest, notify: vi.fn() } as unknown as CodexAppServer,
      onEvent: () => {}, rolloutRoot: testDirectorySync(join(tmpdir(), "orbis-terminal-test-")),
    });
    h.runtime.onDesktopThread = id => terminal.seedDesktopThreads([id]);
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(1));
    expect((await terminal.catalog()).map(entry => entry.sessionId)).toEqual(["terminal-thread"]);
    await expect(terminal.activate({ type: "resume", sessionId: "desktop-thread" })).rejects.toThrow("不属于 Codex");
    await expect(terminal.setArchived("desktop-thread", true)).rejects.toThrow("属于 Codex 桌面版");
    expect(terminalRequest).toHaveBeenCalledTimes(1);
  });
});
