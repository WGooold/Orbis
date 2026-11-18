import { createHash } from "node:crypto";
import { z } from "zod";
import { RecoverableSessionSource, SessionSyncPreparer, createToolSummary, type AgentKey, type ChatMessage,
  type RemoteSessionEntry, type RuntimeEvent, type RuntimeTurnTiming, type SessionLiveMessage, type SessionLiveTool,
  type SessionSyncRequest, type ToolContentLocator } from "@orbis/protocol";
import type { NativeToolPart } from "@orbis/runtime-bridge";
import { kimiSessionPath } from "./kimi-sessions.js";
import type { KimiWebClient } from "./kimi-web-client.js";

const DATE = z.iso.datetime({ offset: true });
const ID = z.string().min(1).max(256);
const PAGE = 25;
const MAX_TURNS = 300;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LIVE_ITEMS = 180;
const MAX_PAGES_PER_READ = 4;
const OUTCOMES = { completed: "completed", failed: "failed", interrupted: "cancelled" } as const;
export type KimiFrame = Record<string, unknown>;
export const kimiObject = (value: unknown): KimiFrame => value !== null && typeof value === "object" && !Array.isArray(value) ? value as KimiFrame : {};
const nativeItem = z.object({
  item_id: ID, type: z.string(), status: z.enum(["running", "ended"]), created_at: DATE,
  outcome: z.string().optional(), text: z.string().optional(), name: z.string().optional(), input: z.unknown().optional(),
  input_text: z.string().optional(), output: z.string().optional(), error: z.string().optional(),
  stage: z.string().optional(), truncated: z.boolean().optional(), prompt_ids: z.array(ID).max(256).optional(),
  placement: z.string().optional(), kind: z.string().optional(), summary: z.string().optional(), title: z.string().optional(), body: z.string().optional(),
});
export const kimiTurn = z.object({
  turn_id: ID, ordinal: z.number().int().nonnegative(), kind: z.enum(["agent", "system"]),
  status: z.enum(["running", "ended"]), outcome: z.string().optional(), end_reason: z.string().optional(),
  started_at: DATE, duration_ms: z.number().finite().nonnegative().optional(), ended_at: DATE.optional(),
  items: z.array(nativeItem).max(4096).optional(), retry: z.unknown().optional(), truncated: z.boolean().optional(),
});
const page = z.object({ turns: z.array(kimiTurn).max(200), has_more: z.boolean() });
type Item = z.infer<typeof nativeItem>;
export type KimiTurn = z.infer<typeof kimiTurn>;
const hash = (parts: string[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
export const kimiItemId = (turnId: string, itemId: string): string => `kimi-item:${hash([turnId, itemId])}`;
const boundaryId = (turnId: string): string => `kimi-before:${hash([turnId])}`;
const stamp = (value: string) => Math.max(Date.parse(value), 0);
const duration = (turn: KimiTurn) => Math.floor(turn.duration_ms ?? (turn.ended_at ? Math.max(0, stamp(turn.ended_at) - stamp(turn.started_at)) : 0));
const terminal = (turn: KimiTurn): "completed" | "failed" | "cancelled" | "unknown" =>
  turn.outcome && Object.hasOwn(OUTCOMES, turn.outcome) ? OUTCOMES[turn.outcome as keyof typeof OUTCOMES] : "unknown";
const retry = (turn: KimiTurn): RuntimeEvent => {
  const attempt = kimiObject(turn.retry).attempt;
  return { type: "execution.activity", retry: typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 0
    ? { phase: "running", turnId: turn.turn_id, attempt } : { phase: "idle" }, compaction: "unavailable" };
};

/** Immutable history identities come from native turns/items, never from the reusable ordinal. */
export class KimiConversation {
  #source: RecoverableSessionSource;
  readonly #preparer = new SessionSyncPreparer();
  #turns = new Map<string, KimiTurn>();
  #bytes = new Map<string, number>();
  #bridges = new Set<string>();
  #knownEntries = new Map<string, RemoteSessionEntry>();
  #parts = new Map<string, { item: Item; final: boolean }>();
  #messageCache = new WeakMap<Item, ChatMessage>();
  #entries: RemoteSessionEntry[] = [];
  #timings: RuntimeTurnTiming[] = [];
  #boundary: string | undefined;
  #historyMore = false;
  #pageBlocked = false;
  #ready = false;
  #revision = 0;
  #generation = 0;
  #renderTimer: NodeJS.Timeout | undefined;
  #prepending: Promise<void> | undefined;
  #waiters = new Set<(ready: boolean) => void>();

  constructor(readonly options: { agent: () => AgentKey; client: Pick<KimiWebClient, "requestJson">; nativeId: string;
    emit: (event: RuntimeEvent) => void; onInvalidated?: () => void; onTurnEnded?: (turn: KimiTurn) => void;
    onUserItem?: (turn: KimiTurn, promptIds: readonly string[]) => void; clientMessageIds?: (promptIds: readonly string[]) => readonly string[];
  }) { this.#source = this.#newSource(); }

  get ready(): boolean { return this.#ready; }
  get runningTurn(): KimiTurn | undefined { return [...this.#turns.values()].find(turn => turn.status === "running"); }
  get epoch(): string { return this.#source.version.epoch; }

  #newSource(): RecoverableSessionSource {
    const id = this.options.agent().sessionId;
    return new RecoverableSessionSource(id, this.options.emit, { publishTools: this.options.emit, runtimeId: () => id });
  }
  waitForBaseline(): Promise<void> {
    if (this.#ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const settled = (ready: boolean) => {
        clearTimeout(timer); this.#waiters.delete(settled);
        if (ready) resolve(); else reject(new Error("Kimi Code 会话历史尚未同步"));
      };
      const timer = setTimeout(() => settled(false), 6000);
      timer.unref();
      this.#waiters.add(settled);
    });
  }
  invalidate(): void {
    clearTimeout(this.#renderTimer); this.#renderTimer = undefined;
    this.#ready = false; this.#generation++; this.#prepending = undefined;
    this.#historyMore = false; this.#pageBlocked = false;
    this.#turns.clear(); this.#bytes.clear(); this.#bridges.clear(); this.#knownEntries.clear(); this.#parts.clear(); this.#messageCache = new WeakMap();
    this.#entries = []; this.#timings = []; this.#boundary = undefined;
    this.#preparer.invalidate();
    this.#source = this.#newSource(); this.#source.reestablish();
    for (const settle of [...this.#waiters]) settle(false);
    this.options.onInvalidated?.();
  }

  /** Main-agent frames only. Invalid patches cannot become a complete conversation. */
  frame(frame: KimiFrame): void {
    const type = frame.type;
    if (type === "turns.failed" || type === "turns.removed") { this.invalidate(); return; }
    if (type === "turns") {
      const ready = this.#ready;
      try {
        const latest = page.parse(frame);
        if (this.#generation === 0 || ready || this.#turns.size > 0) {
          // Native can emit a fresh baseline without reconnecting (e.g. reload).
          if (ready || this.#turns.size > 0) this.invalidate();
          else this.#generation++;
        }
        this.#historyMore = latest.has_more; this.#pageBlocked = false;
        this.#putPage(latest.turns);
        for (const turn of latest.turns) for (const item of turn.items ?? [])
          if (item.type === "user_message" && item.prompt_ids?.length) this.options.onUserItem?.(turn, item.prompt_ids);
        this.#ready = true;
        this.#render();
        for (const settle of [...this.#waiters]) settle(true);
      } catch { this.invalidate(); }
      return;
    }
    if (!this.#ready || typeof type !== "string" || !/^(turns?[.]|item[.])/u.test(type)) return;
    try {
      if (type === "turn.started" || type === "turn.ended") {
        const turn = kimiTurn.parse(frame.turn);
        if (type === "turn.ended" && turn.status !== "ended") throw new Error();
        const old = this.#turns.get(turn.turn_id);
        if (old && old.ordinal !== turn.ordinal) throw new Error();
        if (!old && [...this.#turns.values()].some(value => value.ordinal >= turn.ordinal)) throw new Error();
        this.#put({ ...turn, items: turn.items ?? old?.items ?? [] });
        if (type === "turn.ended") {
          this.#render(); this.options.onTurnEnded?.(turn); this.options.emit(retry(turn));
        } else this.#schedule();
        return;
      }
      const turn = typeof frame.turn_id === "string" ? this.#turns.get(frame.turn_id) : undefined;
      if (!turn) throw new Error();
      if (type === "turn.updated") {
        this.#turns.set(turn.turn_id, { ...turn, retry: frame.retry });
        this.options.emit(retry({ ...turn, retry: frame.retry })); return;
      }
      const items = [...(turn.items ?? [])];
      if (type === "item.started" || type === "item.ended") {
        const item = nativeItem.parse(frame.item);
        if (type === "item.ended" && item.status !== "ended") throw new Error();
        const index = items.findIndex(value => value.item_id === item.item_id);
        if (index < 0) items.push(item); else items[index] = item;
        this.#put({ ...turn, items });
        if (item.type === "user_message" && item.prompt_ids?.length) this.options.onUserItem?.(turn, item.prompt_ids);
      } else {
        const index = items.findIndex(value => value.item_id === frame.item_id);
        const item = items[index];
        if (!item) throw new Error();
        if (type === "item.removed") items.splice(index, 1);
        else if (type === "item.updated" && item.type === "tool_call") {
          const set = kimiObject(frame.set);
          if (Object.hasOwn(set, "item_id") || Object.hasOwn(set, "type") || Object.hasOwn(set, "created_at")) throw new Error();
          items[index] = nativeItem.parse({ ...item, ...set });
        } else if (type === "item.delta" && typeof frame.delta === "string") {
          const field = frame.field;
          if (field !== "text" && field !== "input_text" && field !== "output" || item.status !== "running") throw new Error();
          items[index] = { ...item, [field]: (item[field] ?? "") + frame.delta };
        } else throw new Error();
        this.#put({ ...turn, items });
      }
      this.#schedule();
    } catch { this.invalidate(); }
  }

  #schedule(): void {
    if (this.#renderTimer) return;
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = undefined;
      try { this.#render(); } catch { this.invalidate(); }
    }, 80);
    this.#renderTimer.unref();
  }
  #put(turn: KimiTurn): void {
    if (!this.#turns.has(turn.turn_id) && this.#turns.size >= MAX_TURNS) throw new Error("kimi_history_window_full");
    const bytes = Buffer.byteLength(JSON.stringify(turn));
    let total = bytes;
    for (const [id, size] of this.#bytes) if (id !== turn.turn_id) total += size;
    if (total > MAX_BYTES || new Set(turn.items?.map(item => item.item_id)).size !== (turn.items?.length ?? 0)
      || turn.items?.some(item => item.truncated === true) || turn.truncated === true) throw new Error("kimi_history_unavailable");
    this.#bytes.set(turn.turn_id, bytes); this.#turns.set(turn.turn_id, turn);
  }
  #putPage(turns: readonly KimiTurn[], before = Number.POSITIVE_INFINITY): void {
    let previous = -1;
    const ids = new Set<string>();
    for (const turn of turns) {
      if (ids.has(turn.turn_id) || this.#turns.has(turn.turn_id) || turn.ordinal <= previous || turn.ordinal >= before || !turn.items) throw new Error("kimi_history_page_mismatch");
      ids.add(turn.turn_id); previous = turn.ordinal;
    }
    for (const turn of turns) this.#put(turn);
  }

  #message(turn: KimiTurn, item: Item, order: number): ChatMessage | undefined {
    const messageId = kimiItemId(turn.turn_id, item.item_id), timestamp = stamp(item.created_at);
    switch (item.type) {
      case "user_message": {
        const ids = this.options.clientMessageIds?.(item.prompt_ids ?? []) ?? [];
        return { messageId, timestamp, role: "user", content: [{ type: "text", text: item.text ?? "" }],
          ...(ids[0] === undefined ? {} : { clientMessageId: ids[0] }), ...(ids.length > 1 ? { clientMessageIds: [...ids].slice(0, 256) } : {}) };
      }
      case "assistant_message": return { messageId, timestamp, role: "assistant", content: [{ type: "text", text: item.text ?? "" }] };
      case "reasoning": return { messageId, timestamp, role: "assistant", content: [{ type: "thinking", text: item.text ?? "" }] };
      case "tool_call": {
        const name = item.name?.slice(0, 256);
        if (!name) return undefined;
        return { messageId, timestamp, role: "tool", content: [], toolCallId: messageId, toolName: name, toolSummary: this.#tool(turn, item, order) };
      }
      case "notification": return { messageId, timestamp, role: "system", content: [{ type: "text", text: [item.title, item.body].filter(Boolean).join("\n") }] };
      case "system": return item.summary === undefined ? undefined : { messageId, timestamp, role: "system", content: [{ type: "text", text: item.summary }] };
      default: return undefined;
    }
  }
  #tool(turn: KimiTurn, item: Item, order: number) {
    const id = kimiItemId(turn.turn_id, item.item_id), finished = turn.status === "ended" || item.status === "ended";
    const failed = item.outcome === "failed" || item.outcome === "interrupted" || typeof item.error === "string";
    const contents: ReturnType<typeof createToolSummary>["contents"] = [];
    if (item.input !== undefined || item.input_text !== undefined) contents.push({ part: "arguments", format: typeof (item.input ?? item.input_text) === "string" ? "text" : "json", availability: "readable", readCapability: "whole-source" });
    const result = item.error ?? item.output;
    if (result !== undefined) contents.push({ part: finished ? "result" : "output", format: "text", availability: "readable", readCapability: "whole-source" });
    return createToolSummary({ tool: { agent: this.options.agent(), toolCallId: id }, turnId: turn.turn_id, order,
      toolName: item.name!.slice(0, 256), phase: item.outcome === "interrupted" ? "cancelled" : finished ? "finished" : item.stage === "input" ? "started" : "running",
      ...(finished ? { entryId: id, isError: failed } : {}), contents });
  }
  #render(): void {
    clearTimeout(this.#renderTimer); this.#renderTimer = undefined;
    if (!this.#ready) return;
    const turns = [...this.#turns.values()].sort((a, b) => a.ordinal - b.ordinal);
    const first = turns[0];
    if (!first && this.#historyMore) throw new Error("kimi_history_gap");
    const boundary = this.#historyMore && first ? boundaryId(first.turn_id) : undefined;
    const entries: RemoteSessionEntry[] = [], messages: SessionLiveMessage[] = [], tools: SessionLiveTool[] = [];
    const timings: RuntimeTurnTiming[] = [];
    const entriesById = new Map<string, RemoteSessionEntry>();
    const parts = new Map<string, { item: Item; final: boolean }>();
    let parentId: string | null = boundary ?? null;
    const append = (entry: RemoteSessionEntry) => {
      const old = this.#knownEntries.get(entry.entryId);
      const current = old && old.parentId === entry.parentId && old.type === entry.type && old.timestamp === entry.timestamp && old.data.message === entry.data.message ? old : entry;
      entriesById.set(current.entryId, current); entries.push(current); parentId = current.entryId;
    };
    let active: KimiTurn | undefined;
    for (const turn of turns) {
      if (this.#bridges.has(turn.turn_id)) append({ entryId: boundaryId(turn.turn_id), parentId, type: "kimi.history.boundary", timestamp: turn.started_at, data: {} });
      let anchor: string | undefined;
      const items = turn.items ?? [];
      if (turn.status === "running" && items.length > MAX_LIVE_ITEMS) throw new Error("kimi_live_window_full");
      if (turn.status === "running") active = turn;
      for (const [order, item] of items.entries()) {
        const id = kimiItemId(turn.turn_id, item.item_id);
        if (item.type === "tool_call" && item.name) parts.set(id, { item, final: turn.status === "ended" || item.status === "ended" });
        const message = (turn.status === "ended" ? this.#messageCache.get(item) : undefined) ?? this.#message(turn, item, order);
        if (message && turn.status === "ended") this.#messageCache.set(item, message);
        if (turn.status === "running") {
          if (message?.toolSummary && message.toolCallId) tools.push({ toolCallId: message.toolCallId, toolName: message.toolSummary.toolName,
            state: message.toolSummary.phase === "finished" || message.toolSummary.phase === "cancelled" ? "finished" : "updated", summary: message.toolSummary });
          else if (message) messages.push({ message, order, finished: item.status === "ended", contentComplete: true });
        } else {
          append({ entryId: id, parentId, type: message ? "message" : item.type.slice(0, 128) || "kimi.item", timestamp: item.created_at,
            data: message ? { message } : {} });
          if (item.type === "assistant_message" || item.type === "user_message" && !anchor) anchor = id;
        }
      }
      if (turn.status === "ended" && items.length === 0) {
        append({ entryId: kimiItemId(turn.turn_id, ""), parentId, type: "kimi.turn", timestamp: turn.started_at, data: {} });
      }
      if (anchor && turn.status === "ended") timings.push({ turnId: turn.turn_id, startedAt: stamp(turn.started_at), durationMs: duration(turn), messageId: anchor });
    }
    this.#boundary = boundary; this.#entries = entries; this.#timings = timings; this.#parts = parts; this.#knownEntries = entriesById;
    const turn = active ?? turns.at(-1);
    this.#source.transaction(() => {
      this.#source.setHistoryBoundary(boundary ?? null);
      this.#source.reconcile(entries, parentId === boundary ? null : parentId);
      this.#source.replaceLive({ messages, tools, complete: true, turn: turn ? { turnId: turn.turn_id, startedAt: stamp(turn.started_at),
        ...(turn.status === "ended" ? { durationMs: duration(turn), outcome: terminal(turn) } : {}) } : null });
      this.#source.setAvailability(true, true);
    });
    this.#revision++;
  }

  async #prepend(): Promise<void> {
    if (!this.#ready || !this.#historyMore) return;
    if (this.#pageBlocked || this.#turns.size >= MAX_TURNS) throw new Error("Kimi Code 历史已达本次读取上限");
    if (this.#prepending) return this.#prepending;
    const generation = this.#generation;
    const old = [...this.#turns.values()].sort((a, b) => a.ordinal - b.ordinal)[0];
    if (!old) throw new Error("Kimi Code 历史边界不可用");
    const task = (async () => {
      const result = page.parse(await this.options.client.requestJson(`${kimiSessionPath(this.options.nativeId)}/agents/main/turns?before_ordinal=${old.ordinal}&page_size=${Math.min(PAGE, MAX_TURNS - this.#turns.size)}`));
      if (generation !== this.#generation || !this.#ready) throw new Error("Kimi Code 历史来源已变化");
      if (result.turns.length === 0) throw new Error("Kimi Code 历史页未确认边界");
      const turns = this.#turns, bytes = this.#bytes;
      this.#turns = new Map(turns); this.#bytes = new Map(bytes);
      try { this.#putPage(result.turns, old.ordinal); }
      catch (error) { this.#turns = turns; this.#bytes = bytes; this.#pageBlocked = true; throw error; }
      this.#bridges.add(old.turn_id); this.#historyMore = result.has_more; this.#render();
    })();
    this.#prepending = task;
    try { await task; } finally { if (this.#prepending === task) this.#prepending = undefined; }
  }
  async sync(request: SessionSyncRequest): Promise<RuntimeEvent> {
    if (request.sessionId !== this.options.agent().sessionId) throw new Error("session_mismatch");
    await this.waitForBaseline();
    if (this.#renderTimer) this.#render();
    const generation = this.#generation;
    if (this.#historyMore && request.range !== "preview" && request.range !== undefined) {
      const boundary = request.range === "history" ? request.beforeEntryId : request.knownLeafId;
      for (let i = 0; i < MAX_PAGES_PER_READ && this.#historyMore; i++) {
        const offset = boundary ? this.#entries.findIndex(entry => entry.entryId === boundary) : -1;
        if (offset >= (request.range === "history" ? Math.min(request.maxEntries ?? 30, 30) : 0)) break;
        await this.#prepend();
        if (generation !== this.#generation) throw new Error("Kimi Code 历史来源已变化");
      }
    }
    if (!this.#ready || generation !== this.#generation) throw new Error("Kimi Code 历史来源已变化");
    this.#source.replayToolInventory();
    const source = this.#source.published();
    if (!source.version.ready || source.checkpoint.head.leafId !== (this.#entries.at(-1)?.entryId ?? null)) throw new Error("kimi_checkpoint_unavailable");
    return this.#preparer.select({ entries: this.#entries, turnTimings: this.#timings, sessionId: request.sessionId,
      leafId: this.#entries.at(-1)?.entryId ?? null, request: { ...request, range: request.range ?? "preview" }, source, revision: this.#revision,
      ...(this.#boundary === undefined ? {} : { historyBoundaryParentId: this.#boundary }) });
  }
  entry(id: string): RemoteSessionEntry | undefined { return this.#ready ? this.#knownEntries.get(id) : undefined; }
  toolPart(locator: ToolContentLocator): NativeToolPart | undefined {
    const part = this.#ready ? this.#parts.get(locator.tool.toolCallId) : undefined;
    if (!part || part.item.truncated) return undefined;
    const { item, final } = part;
    const value = locator.part === "arguments" ? item.input ?? item.input_text : locator.part === "result" && final ? item.error ?? item.output
      : locator.part === "output" && !final ? item.output : undefined;
    return value === undefined ? undefined : { format: typeof value === "string" ? "text" : "json", value };
  }
}
