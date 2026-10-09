import { isDeepStrictEqual } from "node:util";

export type CodexBufferedNotification = { method: string; params: unknown };

const DELTA_METHODS = new Set([
  "item/agentMessage/delta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
]);

/** A lost prefix invalidates the whole buffer. Only a new native read may reset it. */
export class CodexNotificationBuffer {
  #notifications: Array<CodexBufferedNotification & { bytes: number }> = [];
  #bytes = 0;
  overflowed = false;

  constructor(readonly maxNotifications = 512, readonly maxBytes = 512 * 1024) {}

  get length(): number { return this.#notifications.length; }

  push(notification: CodexBufferedNotification): "accepted" | "overflow" | "dropped" {
    if (this.overflowed) return "dropped";
    const previous = this.#notifications.at(-1);
    const incoming = notification.params as Record<string, unknown> | null;
    const prior = previous?.params as Record<string, unknown> | null;
    // Consecutive chunks for the same native object have the same ordering semantics as
    // one concatenated chunk. Never merge across another item, turn or lifecycle event.
    const merge = previous?.method === notification.method && DELTA_METHODS.has(notification.method)
      && incoming !== null && prior !== null && typeof incoming?.delta === "string"
      && typeof prior?.delta === "string" && typeof incoming.itemId === "string"
      && isDeepStrictEqual({ ...incoming, delta: undefined }, { ...prior, delta: undefined });
    const combined = merge ? { ...notification, params: { ...incoming, delta: (prior!.delta as string) + (incoming!.delta as string) } }
      : notification;
    const bytes = Buffer.byteLength(JSON.stringify(combined), "utf8");
    const total = this.#bytes - (merge ? previous!.bytes : 0) + bytes;
    if ((!merge && this.length >= this.maxNotifications) || total > this.maxBytes) {
      this.overflowed = true;
      this.#notifications = [];
      this.#bytes = 0;
      return "overflow";
    }
    if (merge) this.#notifications.pop();
    this.#notifications.push({ ...combined, bytes });
    this.#bytes = total;
    return "accepted";
  }

  take(): CodexBufferedNotification[] {
    const pending = this.#notifications.map(({ method, params }) => ({ method, params }));
    this.#notifications = [];
    this.#bytes = 0;
    return pending;
  }

  reset(): void {
    this.take();
    this.overflowed = false;
  }
}
