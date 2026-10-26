import { toolContentLocatorId, type ToolContentLocator, type ToolContentPage, type ToolContentReadRequest } from "@orbis/protocol";
import { ToolContentReadError, ToolContentStore } from "./tool-content-store.js";

type Pending = {
  locator: ToolContentLocator; format: ToolContentPage["format"]; generation: number;
  replace: boolean; chunks: string[]; bytes: number; gap: number; final: boolean;
  epoch?: string; unavailable?: boolean;
};

/** ADR-0045 §4：生产通知只排入有界原文；超出待写预算的后缀以字节缺口保存。 */
export class ToolContentCapture {
  readonly #store: ToolContentStore;
  readonly #parts = new Map<string, Pending>();
  #bytes = 0;
  #chunks = 0;
  #generation = 0;
  #work: Promise<void> | undefined;
  #closed = false;
  constructor(store: ToolContentStore) { this.#store = store; }

  has(locator: ToolContentLocator): boolean {
    const part = this.#parts.get(toolContentLocatorId(locator));
    return part !== undefined && part.unavailable !== true;
  }

  replace(locator: ToolContentLocator, format: ToolContentPage["format"], text: string, final: boolean): void {
    if (this.#closed) return;
    const key = toolContentLocatorId(locator), previous = this.#parts.get(key);
    if (previous) { this.#bytes -= previous.bytes; this.#chunks -= previous.chunks.length; }
    if (!previous && this.#parts.size >= 256) {
      const oldest = [...this.#parts].find(([, part]) => part.final && part.bytes === 0);
      if (!oldest) return;
      this.#parts.delete(oldest[0]);
    }
    const part: Pending = { locator, format, generation: ++this.#generation, replace: true,
      chunks: [], bytes: 0, gap: 0, final };
    this.#parts.set(key, part);
    this.#append(part, text); this.#schedule();
  }

  append(locator: ToolContentLocator, text: string): void {
    if (this.#closed) return;
    const part = this.#parts.get(toolContentLocatorId(locator));
    if (!part) { this.replace(locator, "text", text, false); return; }
    if (part.final || part.unavailable) return;
    this.#append(part, text); this.#schedule();
  }

  finish(locator: ToolContentLocator): void {
    const part = this.#parts.get(toolContentLocatorId(locator));
    if (part) { part.final = true; this.#schedule(); }
  }

  #append(part: Pending, text: string): void {
    const length = Buffer.byteLength(text, "utf8");
    // Once an input suffix is missing, subsequent input remains a declared suffix gap.
    const budget = part.gap > 0 || this.#chunks >= 64 ? 0 : Math.max(0, 1024 * 1024 - this.#bytes);
    let end = Math.min(text.length, budget);
    if (end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    let prefix = text.slice(0, end);
    while (Buffer.byteLength(prefix, "utf8") > budget) {
      end = Math.floor(end * budget / Buffer.byteLength(prefix, "utf8"));
      if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
      prefix = text.slice(0, end);
    }
    const kept = Buffer.byteLength(prefix, "utf8");
    // Copy the prefix so a small queued substring cannot retain a huge source string.
    if (kept) { part.chunks.push(Buffer.from(prefix, "utf8").toString("utf8")); this.#chunks++; }
    part.bytes += kept; this.#bytes += kept; part.gap += length - kept;
  }

  #schedule(): void {
    if (this.#work || this.#closed) return;
    this.#work = Promise.resolve().then(() => this.#drain()).finally(() => { this.#work = undefined; });
  }

  async #drain(): Promise<void> {
    for (;;) {
      const part = [...this.#parts.values()].find(value => !value.unavailable &&
        (value.replace || value.chunks.length > 0 || value.gap > 0 || (value.final && value.epoch !== undefined)));
      if (!part || this.#closed) return;
      const key = toolContentLocatorId(part.locator), generation = part.generation;
      const current = (): boolean => this.#parts.get(key)?.generation === generation;
      try {
        if (part.replace) {
          const status = await this.#store.begin(part.locator, part.format);
          if (!current()) continue;
          part.epoch = status.contentEpoch; part.replace = false;
        }
        while (current() && part.chunks.length) {
          const text = part.chunks.shift()!;
          const bytes = Buffer.byteLength(text, "utf8"); part.bytes -= bytes;
          try {
            for (let offset = 0; offset < text.length;) {
              let end = Math.min(offset + 16_384, text.length);
              if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
              await this.#store.append(part.locator, part.epoch!, text.slice(offset, end)); offset = end;
            }
          } finally {
            this.#bytes -= bytes; this.#chunks--;
          }
        }
        if (!current()) continue;
        if (part.gap) {
          const gap = part.gap; part.gap = 0;
          await this.#store.recordGap(part.locator, part.epoch!, gap, "source-missing");
        }
        if (part.final && current() && part.bytes === 0 && part.gap === 0) {
          await this.#store.finish(part.locator, part.epoch!);
          // Keep availability but no longer schedule a finished part.
          delete part.epoch;
        }
      } catch {
        if (current()) {
          this.#bytes -= part.bytes; this.#chunks -= part.chunks.length; part.bytes = 0; part.chunks = []; part.gap = 0; part.unavailable = true;
        }
      }
    }
  }

  async flush(): Promise<void> { while (this.#work) await this.#work; }

  async read(owner: string, request: ToolContentReadRequest, signal?: AbortSignal): Promise<ToolContentPage> {
    await this.flush();
    if (signal?.aborted) throw new ToolContentReadError("cancelled");
    if (!this.has(request.locator)) throw new ToolContentReadError("content_unavailable");
    return this.#store.read(owner, request, signal);
  }

  invalidate(sessionId: string): void {
    for (const [key, part] of this.#parts) if (part.locator.tool.agent.sessionId === sessionId) {
      this.#bytes -= part.bytes; this.#chunks -= part.chunks.length; this.#parts.delete(key);
    }
  }
  async dispose(): Promise<void> { this.#closed = true; await this.#work; this.#parts.clear(); this.#bytes = 0; }
  get pendingBytes(): number { return this.#bytes; }
}
