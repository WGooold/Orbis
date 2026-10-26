import { agentKeyId, messageToolSummary, projectToolEntry, projectToolMessage, stripInlineMedia, toolContentLocatorId,
  type AgentKey, type ChatMessage, type RemoteSessionEntry, type RuntimeEvent, type ToolContentLocator,
  type ToolContentPage, type ToolContentReadRequest } from "@orbis/protocol";
import { ToolContentCapture } from "./tool-content-capture.js";
import { waitForToolRead } from "./tool-read-wait.js";
import { ToolContentReadError, ToolContentStore, type ToolContentReader } from "./tool-content-store.js";

export type NativeToolPart = { format: ToolContentPage["format"]; value: unknown };
type NativeToolReader = (locator: ToolContentLocator, signal?: AbortSignal) => NativeToolPart | undefined | Promise<NativeToolPart | undefined>;
export function toolContentText(part: NativeToolPart): string {
  if (part.format === "text") {
    if (typeof part.value !== "string") throw new ToolContentReadError("content_unavailable");
    return part.value;
  }
  const parents = new Set<object>();
  const validate = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object") return;
    if (depth >= 64 || parents.has(value)) throw new ToolContentReadError("content_unavailable");
    parents.add(value); for (const child of Object.values(value)) validate(child, depth + 1); parents.delete(value);
  };
  validate(part.value, 0);
  const text = JSON.stringify(stripInlineMedia(part.value), (_key, value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  if (text === undefined) throw new ToolContentReadError("content_unavailable");
  return text;
}
const busyStores = new WeakSet<ToolContentStore>();

/** Shared producer boundary for Pi and DSH. Native history callbacks run only on explicit reads. */
export class ToolActivityProducer implements ToolContentReader {
  readonly #options: {
    agent: () => AgentKey;
    source: () => { epoch: string; ready: boolean };
    native?: NativeToolReader;
    runtimeId: () => string;
  };
  #store: ToolContentStore | undefined;
  #capture: ToolContentCapture | undefined;
  #epoch: string | undefined;
  #agent: AgentKey | undefined;
  #disposed = false;
  readonly #readEpochs = new Map<string, string>();
  #order = 0;
  readonly #tools = new Map<string, Extract<RuntimeEvent, { type: "tool.activity" }>["summary"]>();
  #entries = new WeakMap<RemoteSessionEntry, RemoteSessionEntry>();
  readonly #hydrated = new Set<string>();

  constructor(options: { agent: () => AgentKey; source: () => { epoch: string; ready: boolean };
    runtimeId: () => string; native?: NativeToolReader; store?: ToolContentStore }) {
    this.#options = options;
    if (options.store) this.attach(options.store);
  }
  attach(store: ToolContentStore): void {
    if (this.#store && this.#store !== store) throw new Error("tool_store_already_attached");
    this.#store = store; this.#capture ??= new ToolContentCapture(store);
    this.#entries = new WeakMap();
  }
  reset(): void {
    if (this.#agent) void this.#store?.invalidateAgent(this.#agent).catch(() => undefined);
    this.#capture?.invalidate(this.#options.agent().sessionId); this.#tools.clear(); this.#hydrated.clear();
    this.#entries = new WeakMap(); this.#epoch = undefined; this.#order = 0; this.#readEpochs.clear();
  }
  #locator(id: string, part: ToolContentLocator["part"]): ToolContentLocator {
    return { projectionVersion: 1, tool: { agent: this.#options.agent(), toolCallId: id }, part };
  }
  #checkEpoch(): void {
    const epoch = this.#options.source().epoch, agent = this.#options.agent();
    if (epoch === this.#epoch && this.#agent && agentKeyId(this.#agent) === agentKeyId(agent)) return;
    if (this.#agent) {
      this.#capture?.invalidate(this.#agent.sessionId);
      void this.#store?.invalidateAgent(this.#agent).catch(() => undefined);
    }
    this.#agent = agent; this.#readEpochs.clear();
    this.#epoch = epoch; this.#hydrated.clear(); this.#tools.clear(); this.#entries = new WeakMap(); this.#order = 0;
  }
  #retain(id: string, part: ToolContentLocator["part"], value: unknown, final: boolean): void {
    if (value === undefined || !this.#capture) return;
    try {
      const format = typeof value === "string" ? "text" : "json";
      this.#capture.replace(this.#locator(id, part), format, toolContentText({ format, value }), final);
    } catch { /* Explicit unavailable on read; no raw value reaches shared state. */ }
  }
  event(event: RuntimeEvent): RuntimeEvent {
    this.#checkEpoch();
    if (event.type === "message.started" || event.type === "message.finished") return { ...event, message: this.message(event.message) };
    if (event.type !== "tool.started" && event.type !== "tool.updated" && event.type !== "tool.finished") return event;
    const id = event.toolCallId, previous = this.#tools.get(id), final = event.type === "tool.finished";
    if (event.type === "tool.started") this.#retain(id, "arguments", event.arguments, true);
    if (event.type === "tool.updated") this.#retain(id, "output", event.partialResult, false);
    if (final) { this.#retain(id, "result", event.result, true); this.#capture?.finish(this.#locator(id, "output")); }
    const contents = new Map(previous?.contents.map(part => [part.part, part]));
    const part = event.type === "tool.started" ? "arguments" : final ? "result" : "output";
    const value = event.type === "tool.started" ? event.arguments : final ? event.result : event.partialResult;
    if (value !== undefined) contents.set(part, { part, format: typeof value === "string" ? "text" : "json",
      availability: this.#store ? "readable" : "temporarily-unavailable", readCapability: this.#store ? "range" : "none" });
    if (!final && !contents.has("output")) contents.set("output", { part: "output", format: "json", availability: "pending",
      readCapability: this.#store ? "range" : "none" });
    let summary = messageToolSummary({ agent: this.#options.agent(), order: previous?.order ?? this.#order++,
      phase: final ? "finished" : event.type === "tool.started" ? "started" : "running",
      readCapability: this.#store ? "range" : "none", contents: [...contents.values()] }, id, event.toolName,
      event.type === "tool.started" ? event.arguments : undefined, final ? event.isError : undefined);
    if (previous?.inputSummary && !summary.inputSummary) summary = { ...summary, inputSummary: previous.inputSummary };
    if (this.#tools.size >= 4096 && !previous) {
      const old = [...this.#tools].find(([, value]) => value.phase === "finished" || value.phase === "cancelled");
      if (!old) throw new Error("tool_inventory_limit");
      this.#tools.delete(old[0]);
    }
    this.#tools.set(id, summary);
    return { type: "tool.activity", summary };
  }

  message(message: ChatMessage): ChatMessage {
    this.#checkEpoch();
    return projectToolMessage({ agent: this.#options.agent(), order: this.#order,
      readCapability: this.#options.native ? "whole-source" : this.#store ? "range" : "none" }, message);
  }
  entry(entry: RemoteSessionEntry, order: number): RemoteSessionEntry {
    this.#checkEpoch();
    const previous = this.#entries.get(entry); if (previous) return previous;
    const projected = projectToolEntry({ agent: this.#options.agent(), order,
      readCapability: this.#options.native ? "whole-source" : "none" }, entry);
    this.#entries.set(entry, projected); return projected;
  }

  async read(owner: string, request: ToolContentReadRequest, signal?: AbortSignal): Promise<ToolContentPage> {
    this.#checkEpoch();
    const source = { ...this.#options.source() }, store = this.#store;
    if (!store || !source.ready || this.#disposed) throw new ToolContentReadError("content_unavailable");
    if (request.runtimeId !== this.#options.runtimeId() || agentKeyId(request.locator.tool.agent) !== agentKeyId(this.#options.agent())) {
      throw new ToolContentReadError("scope_mismatch");
    }
    const valid = (): void => {
      if (signal?.aborted) throw new ToolContentReadError("cancelled");
      const now = this.#options.source();
      if (this.#disposed || !now.ready || now.epoch !== source.epoch) throw new ToolContentReadError("content_version_invalid");
    };
    if (request.read && this.#readEpochs.get(request.read.readId) !== source.epoch) throw new ToolContentReadError("content_version_invalid");
    const readPage = async (): Promise<ToolContentPage> => {
      const page = await store.read(owner, request, signal); valid();
      this.#readEpochs.delete(page.read.readId); this.#readEpochs.set(page.read.readId, source.epoch);
      while (this.#readEpochs.size > 64) this.#readEpochs.delete(this.#readEpochs.keys().next().value!);
      return page;
    };
    valid(); await this.#capture?.flush(); valid();
    const key = toolContentLocatorId(request.locator);
    if (request.read !== null || this.#hydrated.has(key) || this.#capture?.has(request.locator) &&
      (request.locator.part === "output" || this.#tools.get(request.locator.tool.toolCallId)?.phase !== "finished")) {
      try { return await readPage(); }
      catch (error) {
        if (request.read || !(error instanceof ToolContentReadError) || !["content_unavailable", "content_expired"].includes(error.reason)) throw error;
        this.#hydrated.delete(key);
      }
    }
    if (!this.#options.native) return readPage();
    if (busyStores.has(store)) throw new ToolContentReadError("busy");
    busyStores.add(store);
    let nativeSettled = false, detached = false;
    try {
      const native = Promise.resolve(this.#options.native(request.locator, signal));
      void native.then(() => { nativeSettled = true; if (detached) busyStores.delete(store); },
        () => { nativeSettled = true; if (detached) busyStores.delete(store); });
      const part = await waitForToolRead(native, signal); valid();
      if (!part) throw new ToolContentReadError("content_unavailable");
      const text = toolContentText(part); valid();
      if (Buffer.byteLength(text, "utf8") > 32 * 1024 * 1024) throw new ToolContentReadError("content_unavailable");
      const status = await store.begin(request.locator, part.format);
      for (let offset = 0; offset < text.length;) {
        valid(); let end = Math.min(offset + 16_384, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
        await store.append(request.locator, status.contentEpoch, text.slice(offset, end)); offset = end;
      }
      await store.finish(request.locator, status.contentEpoch); valid();
      if (this.#hydrated.size >= 256) this.#hydrated.delete(this.#hydrated.values().next().value!);
      this.#hydrated.add(key); return readPage();
    } finally { detached = true; if (nativeSettled) busyStores.delete(store); }
  }
  async cancel(owner: string, readId: string): Promise<void> { await this.#store?.cancel(owner, readId); this.#readEpochs.delete(readId); }
  async dispose(): Promise<void> {
    this.#disposed = true; await this.#capture?.dispose();
    if (this.#agent) await this.#store?.invalidateAgent(this.#agent);
    this.#tools.clear(); this.#hydrated.clear(); this.#readEpochs.clear();
  }
}
