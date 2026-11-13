import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@orbis/protocol";
import { CodexRuntime } from "./codex-runtime.js";
import type { CodexAppServer } from "./codex-daemon.js";
import { codexPermissionSelectionMatches, codexPermissionUpdate } from "./codex-permissions.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); vi.useRealTimers(); });

async function harness() {
  const events: RuntimeEvent[] = [];
  const settings = { model: "gpt-6.1-sol", modelProvider: "openai", effort: "medium",
    approvalPolicy: "on-request", approvalsReviewer: "user",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: ["D:/shared"], excludeSlashTmp: true } };
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => method === "thread/resume"
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
  // SC85: native saved selections own the display; directory lists and temporary-path
  // normalization must never turn a confirmed selection into a permanent input barrier.
  it("confirms only the selected native option without validating directories", () => {
    const settings = { sandbox: { type: "workspaceWrite", writableRoots: ["D:/visualization"],
      networkAccess: true, excludeSlashTmp: true }, approvalPolicy: "never", approvalsReviewer: "user" };
    expect(codexPermissionSelectionMatches(settings, "sandbox", "workspaceWrite")).toBe(true);
    expect(codexPermissionSelectionMatches(settings, "sandbox", "dangerFullAccess")).toBe(false);
    expect(codexPermissionSelectionMatches(settings, "network", "enabled")).toBe(true);
    expect(codexPermissionSelectionMatches(settings, "network", "restricted")).toBe(false);
    expect(codexPermissionSelectionMatches(settings, "approvals", "never")).toBe(true);
    expect(codexPermissionSelectionMatches(settings, "approvals", "on-request")).toBe(false);
    expect(codexPermissionSelectionMatches(settings, "approval-reviewer", "auto_review")).toBe(false);
    expect(codexPermissionSelectionMatches({ sandbox: { type: "externalSandbox", networkAccess: "enabled" } }, "network", "enabled")).toBe(true);
    expect(codexPermissionSelectionMatches({}, "network", "restricted")).toBe(false);
  });

  it("confirms normalized workspace permissions and keeps sending and later changes available", async () => {
    const h = await harness();
    h.notify({ sandboxPolicy: { type: "dangerFullAccess" } });
    h.apply("sandbox", "workspaceWrite");
    const policy = { type: "workspaceWrite", writableRoots: ["D:/visualization"], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    h.notify({ sandboxPolicy: policy });
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "apply", ok: true }));
    expect(h.runtime.directoryEntries()[0]?.permissions).toMatchObject({ sandbox: "workspaceWrite", writableRoots: ["D:/visualization"] });
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings.every(setting => !setting.disabledReason)).toBe(true);
    h.apply("approvals", "never", "next-change");
    h.notify({ sandboxPolicy: policy, approvalPolicy: "never" });
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "next-change", ok: true }));
    h.runtime.dispatchCommand("codex:a", "message", { type: "user_message", text: "continue" });
    await vi.waitFor(() => expect(h.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true));
  });

  // Saved permission settings take effect on the next native turn. An active turn
  // must keep running, while confirmation releases follow-up input immediately.
  it("displays saved permissions during the current turn and leaves execution to the next turn", async () => {
    const h = await harness();
    h.notify({ sandboxPolicy: { type: "dangerFullAccess" } });
    h.server.onNotification?.("turn/started", { threadId: "a", turn: { id: "current", status: "inProgress" } });
    h.request.mockClear();
    h.apply("sandbox", "workspaceWrite");
    h.notify({ sandboxPolicy: { type: "workspaceWrite", writableRoots: ["D:/visualization"], networkAccess: true } });
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "apply", ok: true }));
    expect(h.runtime.directoryEntries()[0]).toMatchObject({ status: "running", permissions: { sandbox: "workspaceWrite" } });
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings.every(setting => !setting.disabledReason)).toBe(true);
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update"]);
    h.runtime.dispatchCommand("codex:a", "follow-up", { type: "user_message", text: "next turn", delivery: "followUp", messageId: "next-message" });
    expect(h.events).toContainEqual(expect.objectContaining({ commandId: "follow-up", ok: true, status: "success" }));
    expect(h.request.mock.calls.some(([method]) => method === "turn/start" || method === "turn/interrupt")).toBe(false);
    h.server.onNotification?.("turn/completed", { threadId: "a", turn: { id: "current", status: "completed" } });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("turn/start", {
      threadId: "a", input: [{ type: "text", text: "next turn" }], clientUserMessageId: "next-message", model: "gpt-6.1-sol", effort: "medium",
    }));
    expect(h.request.mock.calls.filter(([method]) => method === "thread/settings/update")).toHaveLength(1);
  });

  it("recovers a lost confirmation from saved native settings without another write", async () => {
    const h = await harness(); vi.useFakeTimers();
    h.notify({ sandboxPolicy: { type: "dangerFullAccess" } });
    const sandbox = { type: "workspaceWrite", writableRoots: ["D:/visualization"], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    h.request.mockClear();
    h.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ ...h.settings, sandboxPolicy: undefined, sandbox,
      thread: { id: "a" } });
    h.apply("sandbox", "workspaceWrite");
    // Simulate a missing notification; the recovery read uses the same saved selection.
    await vi.advanceTimersByTimeAsync(15_001);
    expect(h.events).toContainEqual(expect.objectContaining({ commandId: "apply", status: "unconfirmed" }));
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update", "thread/resume"]);
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings.every(setting => !setting.disabledReason)).toBe(true);
    h.runtime.dispatchCommand("codex:a", "recovered", { type: "user_message", text: "after recovery" });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true);
  });

  it("keeps unknown writes blocked for every delivery mode and retries only the recovery read", async () => {
    const h = await harness(); vi.useFakeTimers();
    h.request.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("read disconnected"));
    h.apply("approvals", "never");
    await vi.advanceTimersByTimeAsync(15_001);
    expect(h.runtime.directoryEntries()[0]?.status).toBe("idle");
    for (const delivery of [undefined, "followUp", "steer"] as const) {
      const commandId = delivery ?? "plain";
      h.runtime.dispatchCommand("codex:a", commandId, { type: "user_message", text: "preserve this draft", ...(delivery ? { delivery } : {}) });
      expect(h.events).toContainEqual({ type: "command.result", commandId, ok: false, status: "failure", error: "权限设置尚未确认，请稍后重试" });
    }
    expect(h.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings[0]?.disabledReason).toBe("权限设置尚未确认，请稍后重试");
    await vi.advanceTimersByTimeAsync(1_001);
    h.request.mockResolvedValueOnce({ ...h.settings, approvalPolicy: "never", thread: { id: "a" } });
    h.runtime.dispatchCommand("codex:a", "retry", { type: "user_message", text: "retry" });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings.every(setting => !setting.disabledReason)).toBe(true);
    expect(h.request.mock.calls.filter(([method]) => method === "thread/settings/update")).toHaveLength(1);
    expect(h.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  // Recovery adopts the saved native selection instead of keeping the UI locked to
  // an old request; the original request is not retrospectively reported successful.
  it("releases uncertainty when the read confirms a different saved native selection", async () => {
    const h = await harness(); vi.useFakeTimers();
    h.request.mockClear();
    h.request.mockResolvedValueOnce({}).mockResolvedValueOnce({ ...h.settings, approvalPolicy: "untrusted", thread: { id: "a" } });
    h.apply("approvals", "never");
    await vi.advanceTimersByTimeAsync(15_001);
    expect(h.runtime.directoryEntries()[0]?.permissions?.approvalPolicy).toBe("untrusted");
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings[0]?.disabledReason).toBeUndefined();
    expect(h.events).toContainEqual(expect.objectContaining({ commandId: "apply", ok: false, status: "unconfirmed" }));
    expect(h.events).not.toContainEqual({ type: "command.result", commandId: "apply", ok: true });
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update", "thread/resume"]);
  });

  // Only this thread's valid saved settings can end uncertainty; malformed or
  // cross-thread replies must not enable sending under an unknown configuration.
  it.each(["wrong-thread", "missing-permissions"])("ignores a %s recovery response", async kind => {
    const h = await harness(); vi.useFakeTimers();
    h.request.mockResolvedValueOnce({}).mockResolvedValueOnce(kind === "wrong-thread"
      ? { ...h.settings, approvalPolicy: "never", thread: { id: "other" } } : { thread: { id: "a" } });
    h.apply("approvals", "never");
    await vi.advanceTimersByTimeAsync(15_001);
    expect(h.runtime.directoryEntries()[0]?.permissions?.approvalPolicy).toBe("on-request");
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings[0]?.disabledReason).toBeDefined();
    expect(h.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("does not let a stale recovery read overwrite newer native permissions", async () => {
    const h = await harness(); vi.useFakeTimers();
    let finishRead!: (result: unknown) => void;
    h.request.mockResolvedValueOnce({}).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    h.apply("approvals", "never");
    await vi.advanceTimersByTimeAsync(15_001);
    h.notify({ approvalPolicy: "untrusted" });
    finishRead({ ...h.settings, approvalPolicy: "never", thread: { id: "a" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.runtime.directoryEntries()[0]?.permissions?.approvalPolicy).toBe("untrusted");
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings[0]?.disabledReason).toBeDefined();
    h.notify({ approvalPolicy: "never" });
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings[0]?.disabledReason).toBeUndefined();
  });

  it("waits for the original write to settle before starting timeout recovery", async () => {
    const h = await harness(); vi.useFakeTimers();
    let finishWrite!: (result: unknown) => void;
    h.request.mockClear();
    h.request.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    h.apply("approvals", "never");
    await vi.advanceTimersByTimeAsync(15_001);
    h.runtime.dispatchCommand("codex:a", "blocked", { type: "user_message", text: "do not race" });
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update"]);
    h.request.mockResolvedValueOnce({ ...h.settings, approvalPolicy: "never", thread: { id: "a" } });
    finishWrite({}); await vi.advanceTimersByTimeAsync(1);
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update", "thread/resume"]);
    expect(h.runtime.directoryEntries()[0]?.permissionManagement?.settings[0]?.disabledReason).toBeUndefined();
  });

  // A recovery resume can subscribe after an archive; wait for it before unsubscribing
  // and never republish the returned settings for a closed session.
  it("releases a late recovery subscription without reviving a closed session", async () => {
    const h = await harness(); vi.useFakeTimers();
    let finishRead!: (result: unknown) => void;
    h.request.mockClear();
    h.request.mockResolvedValueOnce({}).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    h.apply("approvals", "never");
    await vi.advanceTimersByTimeAsync(15_001);
    h.server.onNotification?.("thread/archived", { threadId: "a" });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.runtime.directoryEntries()).toEqual([]);
    expect(h.request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(false);
    finishRead({ ...h.settings, approvalPolicy: "never", thread: { id: "a" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update", "thread/resume", "thread/unsubscribe"]);
    expect(h.runtime.directoryEntries()).toEqual([]);
  });

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

  // SC73: a lost effective-settings notification cannot release queued work
  // under unknown permissions. A later native snapshot resolves that barrier.
  it("holds subsequent messages after a permission timeout until native settings match", async () => {
    const h = await harness(); vi.useFakeTimers();
    h.request.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("native settings unavailable"));
    h.apply("approvals", "never", "uncertain");
    await vi.advanceTimersByTimeAsync(15_001); vi.useRealTimers();
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "uncertain", status: "unconfirmed" }));
    h.request.mockClear();
    h.runtime.dispatchCommand("codex:a", "blocked-first", { type: "user_message", text: "wait for settings" });
    expect(h.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    h.notify({ approvalPolicy: "never" });
    h.runtime.dispatchCommand("codex:a", "confirmed-first", { type: "user_message", text: "now confirmed" });
    await vi.waitFor(() => expect(h.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true));
  });

  it("serializes configuration writes while allowing changes during an approval", async () => {
    const h = await harness();
    h.apply("approvals", "never");
    h.apply("approval-reviewer", "auto_review", "concurrent");
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "concurrent", ok: false }));
    h.notify({ approvalPolicy: "never" });
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "apply", ok: true }));
    const respond = vi.fn();
    h.server.onServerRequest?.({ id: 42, method: "item/commandExecution/requestApproval", params: { threadId: "a", command: "Get-ChildItem" }, respond, fail: vi.fn() });
    h.request.mockClear();
    h.apply("sandbox", "dangerFullAccess", "busy");
    expect(h.request).toHaveBeenCalledWith("thread/settings/update", { threadId: "a", sandboxPolicy: { type: "dangerFullAccess" } });
    // SC73: selecting subsequent permissions must not answer the active approval.
    expect(respond).not.toHaveBeenCalled();
    h.notify({ sandboxPolicy: { type: "dangerFullAccess" } });
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "command.result", commandId: "busy", ok: true }));
  });
});
