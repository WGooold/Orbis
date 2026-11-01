import { createHash } from "node:crypto";
import type { RuntimeCommand, RuntimeEvent } from "@orbis/protocol";

type Receipt = Extract<RuntimeEvent, { type: "command.result" | "runtime.error" }>;
export type RuntimeCommandRecord = {
  deviceId: string; runtimeId: string; commandId: string; requestId?: string;
  at: number; fingerprint: string; terminal: boolean; receipt: Receipt;
};
type Entry = RuntimeCommandRecord & { messageKey?: string; deadline: number; timer?: ReturnType<typeof setTimeout> };

/** Device-private admission and receipts. A timeout ends waiting, never proves non-execution. */
export class RuntimeCommandLifecycle {
  #closed = false;
  readonly #entries = new Map<string, Entry>();
  readonly #messageIds = new Map<string, string>();
  readonly #now: () => number;
  readonly #timeout: number;
  readonly #retention: number;
  readonly #capacity: number;
  readonly #onUnconfirmed: (record: RuntimeCommandRecord, event: Receipt) => void;

  constructor(options: { onUnconfirmed: (record: RuntimeCommandRecord, event: Receipt) => void;
    now?: () => number; timeoutMs?: number; retentionMs?: number; capacity?: number }) {
    this.#now = options.now ?? Date.now;
    this.#timeout = options.timeoutMs ?? 60_000;
    this.#retention = options.retentionMs ?? 300_000;
    this.#capacity = options.capacity ?? 4096;
    this.#onUnconfirmed = options.onUnconfirmed;
  }

  values(): IterableIterator<RuntimeCommandRecord> { return this.#entries.values(); }

  begin(deviceId: string, runtimeId: string, commandId: string, command: RuntimeCommand, sessionScope = runtimeId):
    { kind: "new" | "replay"; record: RuntimeCommandRecord } | { kind: "reject"; error: "command_id_conflict" | "message_id_conflict" | "host_busy" } {
    if (this.#closed) return { kind: "reject", error: "host_busy" };
    this.sweep();
    const key = this.#key(runtimeId, commandId);
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const previous = this.#entries.get(key);
    if (previous) return previous.deviceId === deviceId && previous.fingerprint === fingerprint
      ? { kind: "replay", record: previous } : { kind: "reject", error: "command_id_conflict" };
    const messageKey = command.type === "user_message" && command.messageId ? JSON.stringify([sessionScope, command.messageId]) : undefined;
    if (messageKey && this.#messageIds.has(messageKey)) return { kind: "reject", error: "message_id_conflict" };
    if (this.#entries.size >= this.#capacity) return { kind: "reject", error: "host_busy" };
    const at = this.#now();
    const entry: Entry = { deviceId, runtimeId, commandId, fingerprint, at, terminal: false,
      ...(command.type === "interaction.respond" ? { requestId: command.requestId } : {}),
      receipt: { type: "command.result", commandId, ok: true, status: "pending" }, deadline: at + this.#timeout };
    this.#entries.set(key, entry);
    if (messageKey) { entry.messageKey = messageKey; this.#messageIds.set(messageKey, key); }
    entry.timer = setTimeout(() => this.#unconfirm(entry, "命令结果尚未确认，请核对会话"), this.#timeout);
    entry.timer.unref();
    return { kind: "new", record: entry };
  }

  /** Definite terminals cannot regress; an unknown result can still be resolved by native evidence. */
  receive(runtimeId: string, event: Receipt): RuntimeCommandRecord | undefined {
    if (!event.commandId) return undefined;
    const entry = this.#entries.get(this.#key(runtimeId, event.commandId));
    if (!entry || entry.terminal && !(entry.receipt.type === "command.result" && entry.receipt.status === "unconfirmed")) return undefined;
    if (entry.terminal && event.type === "command.result" && event.status === "pending") return undefined;
    entry.receipt = event;
    entry.terminal = event.type === "runtime.error" || event.status !== "pending";
    if (entry.terminal) {
      clearTimeout(entry.timer); delete entry.timer;
      entry.deadline = this.#now() + this.#retention;
    }
    return entry;
  }

  offline(runtimeId: string, reason: string): void {
    for (const entry of this.#entries.values()) if (entry.runtimeId === runtimeId) this.#unconfirm(entry, reason);
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      this.#unconfirm(entry, "Host 已停止，命令结果待核对");
      clearTimeout(entry.timer);
    }
  }

  sweep(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (!entry.terminal && entry.deadline <= now) this.#unconfirm(entry, "命令结果尚未确认，请核对会话");
      else if (entry.terminal && !(entry.receipt.type === "command.result" && entry.receipt.status === "unconfirmed") && entry.deadline <= now) {
        this.#entries.delete(key);
        if (entry.messageKey && this.#messageIds.get(entry.messageKey) === key) this.#messageIds.delete(entry.messageKey);
      }
    }
  }

  #unconfirm(entry: Entry, reason: string): void {
    if (entry.terminal) return;
    const event: Receipt = { type: "command.result", commandId: entry.commandId, ok: false, status: "unconfirmed", error: reason.slice(0, 4000) };
    // The callback commits through the normal event path, before any observer is notified.
    this.#onUnconfirmed(entry, event);
    // Standalone consumers may only record the callback; the ledger still owns its deadline.
    if (!entry.terminal) this.receive(entry.runtimeId, event);
  }

  #key(runtimeId: string, commandId: string): string { return JSON.stringify([runtimeId, commandId]); }
}
