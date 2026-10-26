import {
  ToolContentReadRequestSchema, agentKeyId, toolContentLocatorId, type AgentKey, type ToolContentPage, type ToolContentReadRequest,
} from "@orbis/protocol";
import { ToolContentReadError, ToolContentStore, type ToolContentReader } from "@orbis/runtime-bridge";
import { codexResponseBytes, type CodexAppServer } from "./codex-daemon.js";
import { codexToolContentText, codexToolContents } from "./codex-tool-projection.js";

export const CODEX_TOOL_NATIVE_LIMITS = { responseBytes: 32 * 1024 * 1024, scanBytes: 64 * 1024 * 1024, pages: 64, requestTimeoutMs: 15_000, lookupTimeoutMs: 30_000 } as const;
type Limits = { [K in keyof typeof CODEX_TOOL_NATIVE_LIMITS]: number };
type NativeVersion = { epoch: string; ready: boolean };
type Cached = { epoch: string };
export type CodexToolContentReaderOptions = {
  server: Pick<CodexAppServer, "request">; agent: AgentKey; runtimeId: string; nativeThreadId: string;
  /** Current canonical source; epoch changes on native corrections/revert or adapter replacement. */
  source: () => NativeVersion;
  /** Only canonically committed tool identities may be looked up in native history. */
  isCommitted: (toolCallId: string) => boolean;
  directory: string; producerId: string; limits?: Partial<Limits>;
};
export type AttachedCodexToolContentReaderOptions = Omit<CodexToolContentReaderOptions, "directory" | "producerId">;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const hydratingStores = new WeakSet<ToolContentStore>();

/** ADR-0045 §4/§6：原生整页读取有界；固定范围后续页复用 producer 存储，不重复读取全文。 */
export class CodexToolContentReader implements ToolContentReader {
  readonly #options: AttachedCodexToolContentReaderOptions;
  readonly #limits: Limits;
  readonly #store: ToolContentStore;
  readonly #ownsStore: boolean;
  readonly #cache = new Map<string, Cached>();
  readonly #active = new Set<AbortController>();
  #hydrating = false;
  #disposed = false;

  private constructor(options: AttachedCodexToolContentReaderOptions, store: ToolContentStore, ownsStore: boolean) {
    this.#options = options; this.#store = store; this.#ownsStore = ownsStore; this.#limits = { ...CODEX_TOOL_NATIVE_LIMITS, ...options.limits };
  }
  static async create(options: CodexToolContentReaderOptions): Promise<CodexToolContentReader> {
    this.#validate(options);
    const store = await ToolContentStore.create({ directory: options.directory, producerId: options.producerId });
    return new CodexToolContentReader(options, store, true);
  }
  /** Multiple native sessions share one producer quota and store lifecycle. */
  static attach(options: AttachedCodexToolContentReaderOptions, store: ToolContentStore): CodexToolContentReader {
    this.#validate(options);
    return new CodexToolContentReader(options, store, false);
  }
  static #validate(options: AttachedCodexToolContentReaderOptions): void {
    if (!["codex", "codexDesktop"].includes(options.agent.agentKind)) throw new Error("tool_agent_mismatch");
    if (Object.values({ ...CODEX_TOOL_NATIVE_LIMITS, ...options.limits }).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("invalid_codex_tool_reader_limits");
  }

  async read(owner: string, input: ToolContentReadRequest, signal?: AbortSignal): Promise<ToolContentPage> {
    const request = ToolContentReadRequestSchema.parse(input);
    if (!owner.trim() || request.runtimeId !== this.#options.runtimeId || agentKeyId(request.locator.tool.agent) !== agentKeyId(this.#options.agent)) {
      throw new ToolContentReadError("scope_mismatch");
    }
    if (signal?.aborted) throw new ToolContentReadError("cancelled");
    const version = { ...this.#options.source() }, key = toolContentLocatorId(request.locator), cached = this.#cache.get(key);
    if (this.#disposed || !version.ready || !this.#options.isCommitted(request.locator.tool.toolCallId)) throw new ToolContentReadError("content_unavailable");
    if (request.read !== null && cached?.epoch !== version.epoch) throw new ToolContentReadError("content_version_invalid");
    if (cached?.epoch === version.epoch) {
      try {
        const page = await this.#store.read(owner, request, signal);
        this.#assertCurrent(version.epoch, request.locator.tool.toolCallId); return page;
      }
      catch (error) {
        if (request.read !== null || !(error instanceof ToolContentReadError) || !["content_expired", "content_unavailable"].includes(error.reason)) throw error;
      }
    }
    if (request.read !== null) throw new ToolContentReadError("content_expired");
    if (this.#hydrating || hydratingStores.has(this.#store)) throw new ToolContentReadError("busy");
    this.#hydrating = true; hydratingStores.add(this.#store);
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, this.#limits.lookupTimeoutMs); timer.unref();
    signal?.addEventListener("abort", abort, { once: true }); this.#active.add(controller);
    try {
      const native = await this.#find(request.locator.tool.toolCallId, controller.signal);
      this.#assertCurrent(version.epoch, request.locator.tool.toolCallId);
      const part = [...codexToolContents(native)].find(value => value.part === request.locator.part);
      if (!part) throw new ToolContentReadError("content_unavailable");
      const text = codexToolContentText(part), state = await this.#store.begin(request.locator, part.format);
      // 64K UTF-16 code units encode to at most 256 KiB; preserve surrogate pairs at boundaries.
      for (let offset = 0; offset < text.length;) {
        if (controller.signal.aborted) throw new ToolContentReadError("cancelled");
        let end = Math.min(text.length, offset + 64 * 1024);
        const previous = text.charCodeAt(end - 1);
        if (end < text.length && previous >= 0xd800 && previous <= 0xdbff) end--;
        await this.#store.append(request.locator, state.contentEpoch, text.slice(offset, end)); offset = end;
      }
      if (controller.signal.aborted) throw new ToolContentReadError("cancelled");
      this.#assertCurrent(version.epoch, request.locator.tool.toolCallId);
      await this.#store.finish(request.locator, state.contentEpoch);
      this.#cache.delete(key); this.#cache.set(key, { epoch: version.epoch });
      while (this.#cache.size > 256) this.#cache.delete(this.#cache.keys().next().value!);
      const page = await this.#store.read(owner, request, controller.signal);
      this.#assertCurrent(version.epoch, request.locator.tool.toolCallId); return page;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.message === "codex_request_cancelled")) throw new ToolContentReadError("cancelled");
      if (error instanceof ToolContentReadError) throw error;
      throw new ToolContentReadError("content_unavailable");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#active.delete(controller); this.#hydrating = false; hydratingStores.delete(this.#store); }
  }

  #assertCurrent(epoch: string, toolCallId: string): void {
    const source = this.#options.source();
    if (this.#disposed || !source.ready || source.epoch !== epoch || !this.#options.isCommitted(toolCallId)) throw new ToolContentReadError("content_version_invalid");
  }

  async #find(toolCallId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    let cursor: string | undefined, bytes = 0;
    const cursors = new Set<string>();
    for (let index = 0; index < this.#limits.pages; index++) {
      const response = await this.#options.server.request("thread/turns/list", { threadId: this.#options.nativeThreadId,
        itemsView: "full", sortDirection: "desc", limit: 1, ...(cursor ? { cursor } : {}) }, this.#limits.requestTimeoutMs,
      { signal, maxResponseBytes: this.#limits.responseBytes });
      // A real CodexAppServer supplies complete JSON wire bytes. Injected transports may not.
      const pageBytes = codexResponseBytes(response) ?? (() => {
        const serialized = JSON.stringify(response);
        if (serialized === undefined) throw new ToolContentReadError("content_unavailable");
        return Buffer.byteLength(serialized, "utf8");
      })();
      bytes += pageBytes;
      if (pageBytes > this.#limits.responseBytes || bytes > this.#limits.scanBytes) throw new ToolContentReadError("content_unavailable");
      const page = record(response);
      if (!page || !Array.isArray(page.data)) throw new ToolContentReadError("content_unavailable");
      for (const value of page.data) {
        const turn = record(value);
        if (!turn || turn.itemsView === "summary" || !Array.isArray(turn.items)) throw new ToolContentReadError("content_unavailable");
        const matches = turn.items.filter(value => record(value)?.id === toolCallId);
        if (matches.length > 1) throw new ToolContentReadError("content_unavailable");
        if (matches.length === 1) return record(matches[0])!;
      }
      if (page.nextCursor === undefined || page.nextCursor === null) break;
      if (typeof page.nextCursor !== "string" || !page.nextCursor.trim() || cursors.has(page.nextCursor)) throw new ToolContentReadError("content_unavailable");
      cursor = page.nextCursor; cursors.add(cursor);
    }
    throw new ToolContentReadError("content_unavailable");
  }
  cancel(owner: string, readId: string): Promise<void> { return this.#store.cancel(owner, readId); }
  get usage(): ToolContentStore["usage"] { return this.#store.usage; }
  async dispose(): Promise<void> {
    this.#disposed = true; for (const controller of this.#active) controller.abort();
    this.#cache.clear(); if (this.#ownsStore) await this.#store.dispose();
  }
}
