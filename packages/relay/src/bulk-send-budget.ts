/** NQ-15: one device-bound bulk budget per Relay, measured after JSON/base64 encoding. */
export const DEFAULT_BULK_BYTES_PER_SECOND = 2_000_000;
const BURST_BYTES = 64 * 1024;

/** Waiting senders rotate after each frame. No ciphertext is dropped or copied here. */
export class BulkSendBudget {
  readonly #waiting = new Map<object, { bytes: number; canSend: () => boolean; wake: (() => void) | undefined }>();
  #tokens = BURST_BYTES;
  #updatedAt: number;

  constructor(readonly bytesPerSecond: number, readonly now: () => number = () => performance.now()) {
    if (!Number.isSafeInteger(bytesPerSecond) || bytesPerSecond < 0) {
      throw new Error("bulkBytesPerSecond must be a nonnegative safe integer");
    }
    this.#updatedAt = now();
  }

  /** Zero reserves this frame's bytes; a positive delay leaves it in its existing FIFO. */
  delayMs(sender: object, bytes: number, canSend: () => boolean = () => true, wake?: () => void): number {
    if (this.bytesPerSecond === 0) return 0;
    const now = this.now();
    this.#tokens = Math.min(BURST_BYTES, this.#tokens + Math.max(0, now - this.#updatedAt) * this.bytesPerSecond / 1000);
    this.#updatedAt = now;
    // Legacy peers may send an indivisible frame larger than the burst. Admit one
    // when the bucket is full and repay its entire size before further bulk sends.
    // A sender that has since hit socket backpressure cannot hold up ready peers.
    for (const [waiting, entry] of this.#waiting) {
      if (entry.canSend()) break;
      this.#waiting.delete(waiting);
    }
    const first = this.#waiting.entries().next().value;
    const turn = first === undefined || first[0] === sender;
    // Sleep until the first waiting frame can send, even when our own is smaller.
    const required = Math.min(turn ? bytes : first[1].bytes, BURST_BYTES);
    if (!turn || this.#tokens < required) {
      this.#waiting.set(sender, { bytes, canSend, wake });
      return Math.max(1, Math.ceil((required - this.#tokens) * 1000 / this.bytesPerSecond));
    }
    this.#waiting.delete(sender);
    this.#tokens -= bytes;
    this.#wakeNext();
    return 0;
  }

  cancel(sender: object): void {
    if (this.#waiting.delete(sender)) this.#wakeNext();
  }

  #wakeNext(): void {
    const wake = this.#waiting.values().next().value?.wake;
    // Notify after the current mux finishes its pump, avoiding reentrant sends.
    if (wake !== undefined) queueMicrotask(wake);
  }
}
