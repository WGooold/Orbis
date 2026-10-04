import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { CodexAppServer, type CodexTransport } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";

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

function desktopHarness() {
  const loaded = new Set<string>();
  const native = new Set<string>();
  const archived = new Set<string>();
  const status = new Map<string, "idle" | "active">();
  const calls: string[] = [];
  const stop = vi.fn(async () => {});
  let releaseResume: (() => void) | undefined;
  let pauseResume = false;
  const request = vi.fn(async (method: string, params?: { threadId?: string; archived?: boolean }) => {
    calls.push(method);
    if (method === "model/list" || method === "skills/list" || method === "mcpServerStatus/list") return { data: [] };
    if (method === "thread/loaded/list") return { data: [...loaded] };
    if (method === "thread/list") return { data: [...native].filter(id => archived.has(id) === (params?.archived === true)).map(id => ({
      id, cwd: "D:/repo", name: id, createdAt: 1_780_000_000, updatedAt: 1_780_000_001, turns: [],
    })) };
    const id = params?.threadId ?? "";
    const thread = { id, cwd: "D:/repo", name: id, path: archived.has(id) ? "D:/archived_sessions/rollout.jsonl" : "D:/sessions/rollout.jsonl", status: { type: status.get(id) ?? "idle" }, turns: [] };
    if (method === "thread/read") return { thread };
    if (method === "thread/archive" || method === "thread/unarchive") {
      if (method === "thread/archive") archived.add(id);
      else archived.delete(id);
      return {};
    }
    if (method === "thread/unsubscribe") return {};
    if (method === "thread/resume") {
      if (pauseResume) await new Promise<void>(resolve => { releaseResume = resolve; });
      return { thread, model: "gpt-5.5" };
    }
    throw new Error(`unexpected RPC: ${method}`);
  });
  const server = { mode: "desktop", endpoint: undefined, request, stop, notify: vi.fn() } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, onEvent: () => {}, rolloutRoot: mkdtempSync(join(tmpdir(), "orbis-desktop-test-")) });
  const notify = (method: string, params: unknown) => server.onNotification?.(method, params);
  return { loaded, native, archived, status, calls, stop, request, server, runtime, notify,
    pause: () => { pauseResume = true; },
    release: () => { releaseResume?.(); },
  };
}

describe("Codex desktop attachment", () => {
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

    const server = await CodexAppServer.createDesktop({
      spawnImpl: (_command, args) => {
        expect(args.slice(-2)).toEqual(["app-server", "proxy"]);
        return child;
      },
    });
    expect(sent.map(line => JSON.parse(line).method)).toEqual(["initialize", "initialized", "thread/loaded/list"]);
    await server.stop();
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
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries().map(entry => entry.sessionId)).toEqual(["codex-desktop:first"]));
    expect(h.runtime.kind).toBe("codexDesktop");
    expect(h.runtime.ownsRuntime("codex:first")).toBe(false);
    expect(h.runtime.ownsRuntime("codex-desktop:first")).toBe(true);
    expect(h.calls).toContain("thread/resume");
    h.loaded.add("second");
    h.notify("thread/started", { threadId: "second" });
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(2));
    h.loaded.delete("first");
    h.notify("thread/closed", { threadId: "first" });
    await vi.waitFor(() => expect(h.runtime.directoryEntries().map(entry => entry.sessionId)).toEqual(["codex-desktop:second"]));
    expect(h.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "first" });
    await h.runtime.stop();
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it("unsubscribes after an in-flight resume settles when a view closes", async () => {
    const h = desktopHarness();
    h.loaded.add("closing");
    h.pause();
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.calls).toContain("thread/resume"));
    h.loaded.delete("closing");
    h.notify("thread/closed", { threadId: "closing" });
    expect(h.calls).not.toContain("thread/unsubscribe");
    h.release();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "closing" }));
    expect(h.runtime.directoryEntries()).toEqual([]);
    await h.runtime.stop();
  });

  it("replays status notifications after resume and keeps /quit local until new desktop work", async () => {
    const h = desktopHarness();
    h.loaded.add("first");
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
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("thread/read", { threadId: "first", includeTurns: false }));
    h.status.set("first", "active");
    h.notify("thread/status/changed", { threadId: "first", status: { type: "active" } });
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(1));
    expect(() => h.runtime.assertProviderSwitchReady()).toThrow("共享后端");
    await h.runtime.stop();
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
    await h.runtime.stop();
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
      onEvent: () => {}, rolloutRoot: mkdtempSync(join(tmpdir(), "orbis-terminal-test-")),
    });
    h.runtime.onDesktopThread = id => terminal.seedDesktopThreads([id]);
    h.runtime.markStarted();
    await vi.waitFor(() => expect(h.runtime.directoryEntries()).toHaveLength(1));
    expect((await terminal.catalog()).map(entry => entry.sessionId)).toEqual(["terminal-thread"]);
    await expect(terminal.activate({ type: "resume", sessionId: "desktop-thread" })).rejects.toThrow("不属于 Codex");
    await expect(terminal.setArchived("desktop-thread", true)).rejects.toThrow("属于 Codex 桌面版");
    expect(terminalRequest).toHaveBeenCalledTimes(1);
    await h.runtime.stop();
  });
});
