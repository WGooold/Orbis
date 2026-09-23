import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionRequestSchema, type InteractionRequest, type RuntimeEvent } from "@pi-remote/protocol";
import { CodexRuntime } from "./codex-runtime.js";
import { type CodexAppServer } from "./codex-daemon.js";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); vi.useRealTimers(); });

async function harness() {
  const events: RuntimeEvent[] = [];
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => method === "thread/resume"
    ? { thread: { id: params.threadId, cwd: "D:/test", turns: [] }, model: "test", approvalPolicy: "never",
      sandbox: { type: "readOnly" }, approvalsReviewer: "user" } : { data: [] });
  const server = { request } as unknown as CodexAppServer;
  const runtime = new CodexRuntime({ server, onEvent: (event) => events.push(event), rolloutRoot: "D:/not-existing-codex-audit-rollouts" });
  runtime.markStarted();
  cleanups.push(() => server.onExit?.(0));
  await runtime.activate({ type: "resume", sessionId: "a" });
  const approval = (params: Record<string, unknown> = {}, method = "item/commandExecution/requestApproval", id: string | number = 42) => {
    const respond = vi.fn(); const fail = vi.fn();
    server.onServerRequest?.({ id, method, params: { threadId: "a", turnId: "turn-1", itemId: "item-1",
      command: "Get-ChildItem", startedAtMs: Date.now(), ...params }, respond, fail });
    return { respond, fail };
  };
  const latest = (): InteractionRequest => {
    const event = [...events].reverse().find((e) => e.type === "interaction.requested");
    return InteractionRequestSchema.parse(event?.type === "interaction.requested" ? event.request : undefined);
  };
  const answer = (prompt: InteractionRequest, value = "0", threadId = "a", extensionId = "codex", commandId = "answer-1") => {
    runtime.dispatchCommand(`codex:${threadId}`, commandId, { type: "interaction.respond", requestId: prompt.requestId,
      extensionId, response: { kind: "select", value } });
  };
  return { events, server, runtime, approval, latest, answer };
}

describe("Codex approval lifecycle", () => {
  it("only completes submission after the server resolves it and keeps retries idempotent", async () => {
    const h = await harness(); const pending = h.approval(); const prompt = h.latest();
    h.answer(prompt); h.answer(prompt, "0", "a", "codex", "retry");
    expect(pending.respond).toHaveBeenCalledTimes(1);
    expect(h.events).toContainEqual({ type: "command.result", commandId: "answer-1", ok: true, status: "pending" });
    expect(h.events.some((e) => e.type === "interaction.resolved")).toBe(false);
    h.server.onNotification?.("serverRequest/resolved", { threadId: "a", requestId: 42 });
    expect(h.events).toContainEqual({ type: "interaction.resolved", requestId: prompt.requestId, source: "remote" });
    expect(h.events).toContainEqual({ type: "command.result", commandId: "retry", ok: true });
    h.answer(prompt, "0", "a", "codex", "late");
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "late", ok: false }));
  });

  it("replays pending and submitted snapshots on reconnect and clears a desktop answer", async () => {
    const h = await harness(); const pending = h.approval(); const prompt = h.latest();
    h.events.length = 0; h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: [{ ...prompt, submitted: false }] });
    h.answer(prompt); h.events.length = 0; h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: [{ ...prompt, submitted: true }] });
    h.server.onNotification?.("serverRequest/resolved", { threadId: "a", requestId: 42 });
    expect(pending.respond).toHaveBeenCalledTimes(1);
    const local = h.approval({}, undefined, "desktop"); const localPrompt = h.latest();
    h.server.onNotification?.("serverRequest/resolved", { threadId: "a", requestId: "desktop" });
    expect(local.respond).not.toHaveBeenCalled();
    expect(h.events).toContainEqual({ type: "interaction.resolved", requestId: localPrompt.requestId, source: "local" });
    h.events.length = 0; h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: [] });
  });

  it("rejects wrong thread, extension and decisions without consuming a valid request", async () => {
    const h = await harness();
    expect(h.approval({ threadId: "unknown" }).respond).toHaveBeenCalledWith({ decision: "decline" });
    await h.runtime.activate({ type: "resume", sessionId: "b" });
    const pending = h.approval(); const prompt = h.latest();
    h.answer(prompt, "0", "b"); h.answer(prompt, "0", "a", "other"); h.answer(prompt, "999");
    expect(pending.respond).not.toHaveBeenCalled();
    expect(h.events.filter((e) => e.type === "command.result" && !e.ok)).toHaveLength(3);
    h.answer(prompt); expect(pending.respond).toHaveBeenCalledWith({ decision: "accept" });
  });

  it("never reuses a mobile approval id even when app-server reuses its numeric id", async () => {
    const h = await harness(); h.approval(); const old = h.latest();
    h.server.onNotification?.("serverRequest/resolved", { threadId: "a", requestId: 42 });
    const pending = h.approval(); const next = h.latest();
    expect(next.requestId).not.toBe(old.requestId);
    h.answer(old); expect(pending.respond).not.toHaveBeenCalled();
  });

  it("uses type-specific denial on timeout and clears the phone at turn completion", async () => {
    vi.useFakeTimers(); const h = await harness();
    const pending = h.approval({ permissions: { network: { enabled: true } } }, "item/permissions/requestApproval");
    await vi.advanceTimersByTimeAsync(300_001);
    expect(pending.respond).toHaveBeenCalledWith({ permissions: {}, scope: "turn" });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "interaction.cancelled", reason: "timeout" }));
    h.approval(); h.server.onNotification?.("turn/completed", { threadId: "a", turn: { id: "turn-1", status: "interrupted" } });
    h.events.length = 0; h.runtime.announce("a");
    expect(h.events).toContainEqual({ type: "interaction.snapshot", requests: [] });
  });

  it("rejects expired answers even before the timeout callback runs", async () => {
    vi.useFakeTimers(); const h = await harness(); const pending = h.approval(); const prompt = h.latest();
    vi.setSystemTime(prompt.expiresAt);
    h.answer(prompt);
    expect(pending.respond).not.toHaveBeenCalled();
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", ok: false, error: expect.stringContaining("过期") }));
  });

  it("does not report an unconfirmed submission as successful when the turn ends", async () => {
    const h = await harness(); h.approval(); const prompt = h.latest(); h.answer(prompt);
    h.events.length = 0;
    h.server.onNotification?.("turn/completed", { threadId: "a", turn: { id: "turn-1", status: "interrupted" } });
    expect(h.events).toContainEqual({ type: "interaction.cancelled", requestId: prompt.requestId, reason: "cancelled" });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "answer-1", ok: false }));
    expect(h.events.some((e) => e.type === "interaction.resolved")).toBe(false);
  });

  it("surfaces nested effective settings and sandbox failures including failed turns", async () => {
    const h = await harness();
    expect(h.runtime.directoryEntries()[0]?.permissions).toMatchObject({ sandbox: "readOnly", approvalPolicy: "never" });
    h.server.onNotification?.("thread/settings/updated", { threadId: "a", threadSettings: {
      approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: true }, approvalsReviewer: "auto_review",
    } });
    expect(h.runtime.directoryEntries()[0]?.permissions).toMatchObject({ sandbox: "workspaceWrite", reviewer: "auto_review", networkAccess: true });
    h.server.onNotification?.("error", { threadId: "a", error: { message: "windows sandbox: setup refresh had errors", codexErrorInfo: "sandboxError" } });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("电脑端修复") }));
    expect(h.runtime.directoryEntries()[0]?.permissions?.problem).toContain("setup refresh");
    h.server.onNotification?.("turn/completed", { threadId: "a", turn: { id: "turn-1", status: "failed", error: { message: "provider unavailable" } } });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "runtime.error", message: "provider unavailable" }));
  });

  it("dispatches user input and returns proper JSON-RPC errors for unknown methods", async () => {
    const h = await harness();
    const input = h.approval({ questions: [{ id: "q", header: "Question", question: "Explain", options: null }] }, "item/tool/requestUserInput");
    expect(h.latest()).toMatchObject({ kind: "questionnaire" }); expect(input.respond).not.toHaveBeenCalled();
    const unknown = h.approval({}, "unknown", "unsupported");
    expect(unknown.respond).not.toHaveBeenCalled(); expect(unknown.fail).toHaveBeenCalled();
  });
});
