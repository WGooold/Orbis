import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@orbis/protocol";
import { CodexRuntime } from "./codex-runtime.js";
import type { CodexAppServer } from "./codex-daemon.js";
import { codexPermissionUpdate } from "./codex-permissions.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); vi.useRealTimers(); });

async function harness() {
  const events: RuntimeEvent[] = [];
  const settings = { model: "gpt-6.1-sol", modelProvider: "openai", effort: "medium",
    approvalPolicy: "on-request", approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: ["D:/shared"], excludeSlashTmp: true } };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === "thread/resume"
    ? { thread: { id: params.threadId, cwd: "D:/test", turns: [] }, ...settings, reasoningEffort: settings.effort }
    : method === "model/list" ? { data: [
      { id: "gpt-6.1-sol", isDefault: true }, { id: "gpt-6-astra" },
    ] } : { data: [] });
  const server = { request } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, onEvent: (event) => events.push(event), rolloutRoot: "D:/not-existing-controls-rollouts" });
  runtime.markStarted();
  await runtime.activate({ type: "resume", sessionId: "a" });
  cleanups.push(() => server.onExit?.(0));
  const apply = (name: string, args: string, id = "apply") => runtime.dispatchCommand("codex:a", id, { type: "permissions.update", settingId: name, value: args });
  const notify = (patch: Record<string, unknown>, threadId = "a") => server.onNotification?.("thread/settings/updated", { threadId, threadSettings: { ...settings, ...patch } });
  return { events, settings, request, server, runtime, apply, notify };
}

describe("mobile Codex permission settings", () => {
  it("preserves next-turn Astra and reasoning selections across every permission snapshot", async () => {
    const h = await harness();
    h.request.mockClear();
    h.runtime.dispatchCommand("codex:a", "model", { type: "slash.execute", name: "model", args: "gpt-6-astra" });
    h.runtime.dispatchCommand("codex:a", "thinking", { type: "slash.execute", name: "thinking", args: "high" });
    expect(h.request).not.toHaveBeenCalled();
    for (const [name, value, patch] of [
      ["network", "enabled", { sandboxPolicy: { ...h.settings.sandboxPolicy, networkAccess: true } }],
      ["approvals", "never", { approvalPolicy: "never" }],
      ["approval-reviewer", "auto_review", { approvalsReviewer: "auto_review" }],
      ["sandbox", "dangerFullAccess", { sandboxPolicy: { type: "dangerFullAccess" } }],
    ] as const) {
      h.apply(name, value, name);
      expect(h.request).toHaveBeenLastCalledWith("thread/settings/update", { threadId: "a", ...patch });
      // Native permissions include the unchanged base model, not Host's next-turn override.
      h.notify(patch);
      await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: name, ok: true }));
      expect(h.runtime.directoryEntries()[0]).toMatchObject({ model: { id: "gpt-6-astra" }, thinkingLevel: "high" });
    }
    h.runtime.dispatchCommand("codex:a", "message", { type: "user_message", text: "continue" });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("turn/start", {
      threadId: "a", input: [{ type: "text", text: "continue" }], model: "gpt-6-astra", effort: "high",
    }));
  });

  it("preserves local selections on resume and still adopts real native configuration changes", async () => {
    const h = await harness();
    h.runtime.dispatchCommand("codex:a", "model", { type: "slash.execute", name: "model", args: "gpt-6-astra" });
    h.runtime.dispatchCommand("codex:a", "thinking", { type: "slash.execute", name: "thinking", args: "high" });
    await h.runtime.activate({ type: "resume", sessionId: "a" });
    expect(h.runtime.directoryEntries()[0]).toMatchObject({ model: { id: "gpt-6-astra" }, thinkingLevel: "high" });
    h.notify({ model: "desktop-model", effort: "low" });
    expect(h.runtime.directoryEntries()[0]).toMatchObject({ model: { id: "desktop-model" }, thinkingLevel: "low" });
    h.runtime.dispatchCommand("codex:a", "model-again", { type: "slash.execute", name: "model", args: "gpt-6-astra" });
    h.runtime.dispatchCommand("codex:a", "thinking-again", { type: "slash.execute", name: "thinking", args: "high" });
    h.notify({ model: "desktop-model", effort: "xhigh" });
    expect(h.runtime.directoryEntries()[0]).toMatchObject({ model: { id: "gpt-6-astra" }, thinkingLevel: "xhigh" });
    h.notify({ model: "gpt-6-astra", effort: null });
    expect(h.runtime.directoryEntries()[0]?.thinkingLevel).toBeUndefined();
  });

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
