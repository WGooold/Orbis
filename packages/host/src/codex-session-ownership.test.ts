import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRuntime } from "./codex-runtime.js";
import type { CodexAppServer } from "./codex-daemon.js";

const roots: string[] = [];
const runtimes: CodexRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const desktopId = "01a19ae6-8810-7743-ba59-429765e8e3d7";
const terminalId = "01a19c0e-942b-7751-934e-50cf9980194e";

async function fixture(mode: "owned" | "external" = "owned", failOpen = false) {
  const root = await mkdtemp(join(tmpdir(), "orbis-codex-ownership-")); roots.push(root);
  const sessions = join(root, "sessions"); await mkdir(sessions);
  const write = async (id: string, originator: string, source: unknown = "vscode", archived = false) => {
    const path = join(root, archived ? "archived_sessions" : "sessions"); await mkdir(path, { recursive: true });
    await writeFile(join(path, `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta",
      payload: { id, cwd: root, timestamp: "2026-11-02T06:16:01Z", originator, source } }) + "\n");
  };
  const request = vi.fn(async (method: string, params?: { threadId?: string }) => {
    if (method === "thread/resume") return { thread: { id: params!.threadId, cwd: root, status: { type: "idle" }, turns: [] } };
    if (method === "thread/read") return { thread: { id: params!.threadId, cwd: root, path: join(sessions, `rollout-${params!.threadId}.jsonl`), status: { type: "idle" } } };
    if (method === "config/read") return { config: { projects: { [root]: { trust_level: "trusted" } } } };
    return { data: [] };
  });
  const logs: string[] = [];
  const open = vi.fn(async () => { if (failOpen) throw new Error("Terminal unavailable"); });
  const server = { mode, endpoint: "ws://127.0.0.1:51217", request,
    notify: vi.fn(), stop: vi.fn(async () => {}) } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, rolloutRoot: sessions, openHeadWindow: open,
    onEvent: () => {}, log: line => logs.push(line) });
  runtimes.push(runtime);
  return { runtime, request, write, open, logs, notify: (method: string, params: unknown) => server.onNotification?.(method, params) };
}

describe("Codex session backend ownership", () => {
  it("does not turn historical Desktop origin into current backend ownership", async () => {
    const h = await fixture();
    h.runtime.markStarted();
    await h.write(desktopId, "Codex Desktop");
    await h.write(terminalId, "codex_vscode");
    const catalog = await h.runtime.catalog();
    expect(catalog.map(entry => [entry.sessionId, entry.agentKind]).sort()).toEqual([[desktopId, "codex"], [terminalId, "codex"]].sort());
    expect(await h.runtime.activate({ type: "resume", sessionId: desktopId })).toMatchObject({ sessionId: desktopId, spawnMode: "tui" });
    expect(h.open).toHaveBeenCalledOnce();
  });

  it("refuses a known Desktop identity in the terminal backend before native mutations", async () => {
    const h = await fixture(); await h.write(desktopId, "Codex Desktop");
    h.runtime.seedDesktopThreads([desktopId]);
    await expect(h.runtime.activate({ type: "resume", sessionId: desktopId })).rejects.toThrow("不属于 Codex");
    await expect(h.runtime.setArchived(desktopId, true)).rejects.toThrow("属于 Codex 桌面版");
    expect(h.request).not.toHaveBeenCalled(); expect(h.open).not.toHaveBeenCalled();
  });

  it("keeps a known Desktop session namespaced and opens no terminal", async () => {
    const h = await fixture("external"); await h.write(desktopId, "Codex Desktop");
    h.runtime.seedDesktopThreads([desktopId]);
    expect(await h.runtime.activate({ type: "resume", sessionId: `codex-desktop:${desktopId}` }))
      .toMatchObject({ sessionId: `codex-desktop:${desktopId}`, spawnMode: "headless" });
    expect(h.request).toHaveBeenCalledWith("thread/resume", { threadId: desktopId });
    expect(h.open).not.toHaveBeenCalled();
  });

  it("keeps explicit desktop ownership on archived sessions and excludes internal child threads", async () => {
    const h = await fixture(); await h.write(desktopId, "Codex Desktop", "vscode", true);
    h.runtime.seedDesktopThreads([desktopId]);
    await h.write("child", "Codex Desktop", { subagent: "review" });
    expect(await h.runtime.catalog()).toEqual([]);
    expect(await h.runtime.catalog(true)).toEqual([]);
  });

  it("reports a failed terminal launch and releases its new idle subscription without claiming success", async () => {
    const h = await fixture("owned", true);
    await expect(h.runtime.activate({ type: "resume", sessionId: terminalId })).rejects.toMatchObject({ code: "spawn_failed" });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: terminalId }));
    expect(h.runtime.directoryEntries()).toEqual([]);
    expect(h.logs.some(line => line.includes("启动请求已受理"))).toBe(false);
  });

  it("preserves an already attached native session if reopening its terminal fails", async () => {
    const h = await fixture();
    h.runtime.markStarted();
    await h.runtime.activate({ type: "resume", sessionId: terminalId });
    h.open.mockRejectedValueOnce(new Error("Terminal unavailable"));
    await expect(h.runtime.activate({ type: "resume", sessionId: terminalId })).rejects.toMatchObject({ code: "spawn_failed" });
    expect(h.runtime.directoryEntries()).toHaveLength(1);
    expect(h.request).not.toHaveBeenCalledWith("thread/unsubscribe", { threadId: terminalId });
  });

  it.each(["running", "compaction"] as const)("keeps native %s that begins while the terminal is opening", async activity => {
    const h = await fixture(); h.runtime.markStarted();
    h.open.mockImplementationOnce(async () => {
      if (activity === "running") h.notify("turn/started", { threadId: terminalId, turn: { id: "native-turn" } });
      else h.notify("item/started", { threadId: terminalId, item: { id: "compact", type: "contextCompaction" } });
      throw new Error("Terminal unavailable");
    });
    await expect(h.runtime.activate({ type: "resume", sessionId: terminalId })).rejects.toMatchObject({ code: "spawn_failed" });
    expect(h.runtime.directoryEntries()).toHaveLength(1);
    expect(h.request).not.toHaveBeenCalledWith("thread/unsubscribe", { threadId: terminalId });
    expect(h.request).not.toHaveBeenCalledWith("turn/interrupt", expect.anything());
  });
});
