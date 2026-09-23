import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@pi-remote/protocol";
import { CodexRuntime } from "./codex-runtime.js";
import type { CodexAppServer } from "./codex-daemon.js";
import { codexPermissionUpdate } from "./codex-permissions.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); vi.useRealTimers(); });

async function harness() {
  const events: RuntimeEvent[] = [];
  const settings = { approvalPolicy: "on-request", approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: ["D:/shared"], excludeSlashTmp: true } };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === "thread/resume"
    ? { thread: { id: params.threadId, cwd: "D:/test", turns: [] }, ...settings } : { data: [] });
  const server = { request } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, onEvent: (event) => events.push(event), rolloutRoot: "D:/not-existing-controls-rollouts" });
  runtime.markStarted();
  await runtime.activate({ type: "resume", sessionId: "a" });
  cleanups.push(() => server.onExit?.(0));
  const apply = (name: string, args: string, id = "apply") => runtime.dispatchCommand("codex:a", id, { type: "slash.execute", name, args });
  const notify = (patch: Record<string, unknown>, threadId = "a") => server.onNotification?.("thread/settings/updated", { threadId, threadSettings: { ...settings, ...patch } });
  return { events, settings, request, server, runtime, apply, notify };
}

describe("mobile Codex permission settings", () => {
  it("acknowledges an already effective value without waiting for a notification Codex does not emit", async () => {
    const h = await harness();
    h.request.mockClear();
    h.apply("approval-reviewer", "user");
    expect(h.request).not.toHaveBeenCalled();
    expect(h.events).toContainEqual({ type: "command.result", commandId: "apply", ok: true });
  });

  it("preserves filesystem scope and uncommon restrictions when changing network", () => {
    const sandboxPolicy = { type: "workspaceWrite", writableRoots: ["D:/shared"], excludeSlashTmp: true,
      readOnlyAccess: { readableRoots: ["D:/read"] }, networkAccess: false };
    expect(codexPermissionUpdate("network", "enabled", { sandboxPolicy }))
      .toEqual({ sandboxPolicy: { ...sandboxPolicy, networkAccess: true } });
    expect(codexPermissionUpdate("approvals", "never", {})).toEqual({ approvalPolicy: "never" });
    expect(() => codexPermissionUpdate("network", "enabled", {})).toThrow("尚未收到");
    expect(() => codexPermissionUpdate("network", "restricted", { sandbox: { type: "dangerFullAccess" } })).toThrow("完全访问");
    expect(() => codexPermissionUpdate("sandbox", "arbitrary", {})).toThrow("选项");
  });

  it("waits for both the RPC and effective state, ignoring unrelated thread and mismatched notifications", async () => {
    const h = await harness();
    h.apply("network", "enabled");
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("thread/settings/update", {
      threadId: "a", sandboxPolicy: { ...h.settings.sandboxPolicy, networkAccess: true },
    }));
    expect(h.runtime.directoryEntries()[0]?.permissions?.networkAccess).toBe(false);
    h.notify({ sandboxPolicy: { ...h.settings.sandboxPolicy, networkAccess: true } }, "other");
    h.notify({ approvalPolicy: "never" });
    expect(h.events).not.toContainEqual({ type: "command.result", commandId: "apply", ok: true });
    h.notify({ sandboxPolicy: { ...h.settings.sandboxPolicy, networkAccess: true } });
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "apply", ok: true }));
    expect(h.runtime.directoryEntries()[0]?.permissions).toMatchObject({ networkAccess: true, writableRoots: ["D:/shared"] });
  });

  it("does not claim success after RPC failure or missing notification", async () => {
    const h = await harness();
    h.request.mockRejectedValueOnce(new Error("managed policy disallows this change"));
    h.apply("sandbox", "dangerFullAccess");
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "apply", ok: false, error: expect.stringContaining("managed policy") })));
    expect(h.runtime.directoryEntries()[0]?.permissions?.sandbox).toBe("workspaceWrite");
    vi.useFakeTimers();
    h.apply("approvals", "never", "timeout");
    await vi.advanceTimersByTimeAsync(15_001);
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "timeout", ok: false, error: expect.stringContaining("未收到") }));
  });

  it("rejects concurrent writes and changes during an approval", async () => {
    const h = await harness();
    h.apply("approvals", "never");
    h.apply("approval-reviewer", "auto_review", "concurrent");
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "concurrent", ok: false }));
    h.notify({ approvalPolicy: "never" });
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "apply", ok: true }));
    h.server.onServerRequest?.({ id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "a", command: "Get-ChildItem" }, respond: vi.fn(), fail: vi.fn() });
    h.request.mockClear();
    h.apply("sandbox", "dangerFullAccess", "busy");
    expect(h.request).not.toHaveBeenCalled();
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "busy", ok: false, error: expect.stringContaining("待处理交互") }));
  });
});
