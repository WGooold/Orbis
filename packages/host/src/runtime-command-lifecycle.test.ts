import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCommandLifecycle } from "./runtime-command-lifecycle.js";

afterEach(() => vi.useRealTimers());
const message = { type: "user_message", text: "hi", messageId: "phone" } as const;

describe("runtime command lifecycle (AIN-03)", () => {
  it("replays pending/terminal receipts without resetting the deadline or re-executing, and isolates device/content", () => {
    vi.useFakeTimers(); const onUnconfirmed = vi.fn();
    const ledger = new RuntimeCommandLifecycle({ onUnconfirmed });
    expect(ledger.begin("d", "r", "c", message).kind).toBe("new");
    vi.advanceTimersByTime(59_000);
    expect(ledger.begin("d", "r", "c", message)).toMatchObject({ kind: "replay", record: { terminal: false, receipt: { status: "pending" } } });
    expect(ledger.begin("other", "r", "c", message)).toEqual({ kind: "reject", error: "command_id_conflict" });
    expect(ledger.begin("d", "r", "c", { ...message, text: "changed" })).toEqual({ kind: "reject", error: "command_id_conflict" });
    vi.advanceTimersByTime(1_000);
    expect(onUnconfirmed).toHaveBeenCalledOnce();
    expect(ledger.begin("d", "r", "c", message)).toMatchObject({ kind: "replay", record: { terminal: true, receipt: { status: "unconfirmed" } } });
    ledger.receive("r", { type: "command.result", commandId: "c", ok: true, status: "success" });
    expect(ledger.begin("d", "r", "c", message)).toMatchObject({ kind: "replay", record: { receipt: { status: "success" } } });
    expect(ledger.receive("r", { type: "command.result", commandId: "c", ok: true, status: "pending" })).toBeUndefined();
    ledger.close();
  });

  it("keeps pending nonterminal and confirms native failure, cancellation, unsupported and every terminal status", () => {
    const ledger = new RuntimeCommandLifecycle({ onUnconfirmed: vi.fn() });
    for (const status of ["success", "failure", "cancelled", "already_delivered", "not_cancelable", "message_id_conflict", "unconfirmed"] as const) {
      ledger.begin("d", "r", status, { ...message, messageId: status });
      expect(ledger.receive("r", { type: "command.result", commandId: status, ok: true, status: "pending" })).toMatchObject({ terminal: false });
      expect(ledger.receive("r", { type: "command.result", commandId: status, ok: status === "success", status })).toMatchObject({ terminal: true });
    }
    ledger.close();
  });

  it("terminates only the disconnected runtime, preserves unresolved receipts at capacity and expires terminals", () => {
    vi.useFakeTimers(); const onUnconfirmed = vi.fn();
    const ledger = new RuntimeCommandLifecycle({ onUnconfirmed, capacity: 2 });
    ledger.begin("d", "a", "c", message); ledger.begin("d", "b", "c", message);
    expect(ledger.begin("d", "c", "c", message)).toEqual({ kind: "reject", error: "host_busy" });
    ledger.offline("a", "disconnected");
    expect(onUnconfirmed).toHaveBeenCalledOnce();
    expect([...ledger.values()].map(item => [item.runtimeId, item.terminal])).toEqual([["a", true], ["b", false]]);
    ledger.receive("b", { type: "command.result", commandId: "c", ok: true, status: "success" });
    vi.advanceTimersByTime(300_000); ledger.sweep();
    expect(ledger.begin("d", "c", "c", message).kind).toBe("new");
    expect(ledger.begin("d", "a", "c", message)).toMatchObject({ kind: "replay", record: { receipt: { status: "unconfirmed" } } });
    ledger.close();
    expect(ledger.begin("d", "new", "new", message)).toEqual({ kind: "reject", error: "host_busy" });
  });
  it("rejects reuse of a message identity by another command, including a replaced runtime of the same session", () => {
    const ledger = new RuntimeCommandLifecycle({ onUnconfirmed: vi.fn() });
    expect(ledger.begin("d", "old", "first", message, "session").kind).toBe("new");
    expect(ledger.begin("d", "old", "other", message, "session")).toEqual({ kind: "reject", error: "message_id_conflict" });
    expect(ledger.begin("d", "replacement", "other", message, "session")).toEqual({ kind: "reject", error: "message_id_conflict" });
    expect(ledger.begin("d", "replacement", "other", message, "different-session").kind).toBe("new");
    ledger.close();
  });

});
