import { readFile } from "node:fs/promises";
import { ToolActivityProducer, ToolContentReadError, type ToolContentStore } from "@orbis/runtime-bridge";
import {
  RecoverableSessionSource,
  SessionSyncPreparer,
  type AgentKey,
  type RemoteSessionEntry,
  type RuntimeCommand,
  type RuntimeEvent,
  type ToolContentLocator,
  type ToolContentPage,
  type ToolContentReadRequest,
} from "@orbis/protocol";
import { ClaudeTranscriptReader, findClaudeTranscript, type ClaudeTranscriptFacts } from "./claude-transcript.js";

/** Phone prompts waiting for their transcript row; older ones fall back to the device rule. */
const MAX_PHONE_PROMPTS = 16;
const PHONE_PROMPT_TTL_MS = 10 * 60_000;

type SessionSyncRequest = Extract<RuntimeCommand, { type: "session.sync" }>;
type SessionSnapshot = Extract<RuntimeEvent, { type: "session.snapshot" }>;
type Published = Extract<RuntimeEvent, { type: "session.patch" | "session.tools.produced" }>;

export type ClaudeSessionHistoryOptions = {
  locate?: (sessionId: string, configDir: string) => Promise<string | undefined>;
  /** How long a finished turn waits for its announced rows to reach the transcript. */
  settleTimeoutMs?: number;
  settleIntervalMs?: number;
  /** The Host id that scopes tool summaries; set once the Host knows it. */
  hostId?: () => string;
  toolStore?: ToolContentStore;
  /** Called when the transcript's Session facts (title, permission mode, model) change. */
  onFacts?: (facts: ClaudeTranscriptFacts) => void;
};

/**
 * Versioned conversation source for one attached Claude Code Session.
 *
 * Canonical history comes only from the native transcript. Streamed output is live
 * state; once a turn completes and its rows are on disk, the transcript replaces it.
 * Tool calls go through the shared producer boundary (ADR-0045): summaries in shared
 * state, bodies only through explicit reads served from the transcript.
 */
export class ClaudeSessionHistory {
  readonly source: RecoverableSessionSource;
  readonly #sessionId: string;
  readonly #configDir: string;
  readonly #preparer = new SessionSyncPreparer();
  readonly #options: ClaudeSessionHistoryOptions;
  readonly #tools: ToolActivityProducer;
  #reader: ClaudeTranscriptReader | undefined;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #facts = "";
  /** ADR-0049 §2: prompts Mods accepted from the phone, in submission order. */
  readonly #prompts: { clientMessageId: string; text: string; after: number; at: number }[] = [];
  /** Transcript uuid → phone messageId, once a prompt claimed its row. */
  readonly #claims = new Map<string, string>();
  readonly #annotated = new WeakMap<RemoteSessionEntry, RemoteSessionEntry>();
  /** One native step may persist several rows (thinking, text and tool calls). */
  readonly #steps = new Map<string, { reserved: Set<string>; stored?: readonly string[] }>();
  readonly #rowOwners = new Map<string, string>();
  readonly #retiredMessages = new Set<string>();

  constructor(sessionId: string, configDir: string, publish: (event: Published) => void,
    options: ClaudeSessionHistoryOptions = {}) {
    this.#sessionId = sessionId;
    this.#configDir = configDir;
    this.#options = options;
    // The runtime id is not the Session id here; tool inventory pages must name the runtime.
    this.source = new RecoverableSessionSource(sessionId, event => { if (!this.#closed) publish(event); },
      { publishTools: event => { if (!this.#closed) publish(event); }, runtimeId: () => `claude:${sessionId}` });
    this.#tools = new ToolActivityProducer({
      agent: () => this.agent,
      runtimeId: () => `claude:${sessionId}`,
      source: () => ({ epoch: this.source.version.epoch, ready: !this.#closed && this.source.version.ready }),
      ...(options.toolStore === undefined ? {} : { store: options.toolStore }),
      native: locator => this.#nativeTool(locator),
    });
  }

  get agent(): AgentKey { return { hostId: this.#options.hostId?.() ?? "local", agentKind: "claude", sessionId: this.#sessionId }; }
  get configDir(): string { return this.#configDir; }
  get facts(): ClaudeTranscriptFacts { return { ...this.#reader?.projection.facts }; }

  attachToolStore(store: ToolContentStore): void { this.#tools.attach(store); }

  /** Consumes live events (messages, turns, tools); false means forward the event as is. */
  observe(event: RuntimeEvent): boolean {
    const id = event.type === "message.delta" ? event.messageId
      : event.type === "message.started" || event.type === "message.finished" ? event.message.messageId : undefined;
    // A late chunk or turn.complete must never resurrect an already committed step.
    if (id !== undefined && this.#retiredMessages.has(id)) return true;
    return this.source.observe(this.#tools.event(event));
  }

  /** Called before the native append continues, so even a concurrent sync cannot expose a twin. */
  reserveStepRow(messageId: string, uuid: string): void {
    if (this.#closed || this.#retiredMessages.has(messageId)) return;
    let step = this.#steps.get(messageId);
    if (step === undefined) { step = { reserved: new Set() }; this.#steps.set(messageId, step); }
    const owner = this.#rowOwners.get(uuid);
    if (owner !== undefined && owner !== messageId) return;
    step.reserved.add(uuid);
    this.#rowOwners.set(uuid, messageId);
  }

  /** Explicit native boundary: every stored response row belonging to this step is now known. */
  async finishStep(messageId: string, uuids: readonly string[]): Promise<void> {
    if (this.#closed || this.#retiredMessages.has(messageId)) return;
    for (const uuid of uuids) this.reserveStepRow(messageId, uuid);
    const step = this.#steps.get(messageId) ?? { reserved: new Set<string>() };
    step.stored = [...uuids];
    this.#steps.set(messageId, step);
    await this.refresh();
  }

  turnAnchor(announced: readonly string[]): string | undefined {
    const ids = new Set(announced);
    return [...this.#projected()].reverse().find(entry => ids.has(entry.entryId)
      && typeof entry.data.message === "object" && entry.data.message !== null
      && (entry.data.message as { role?: string }).role === "assistant")?.entryId;
  }

  hasEntry(uuid: string): boolean { return this.#reader?.projection.has(uuid) ?? false; }

  /**
   * ADR-0049 §2: Mods submissions carry no native identity, so the Host remembers the exact
   * text it submitted. Only a later user row with exactly that text can claim the phone id;
   * a rewritten prompt stays unclaimed and the device falls back to source authority.
   */
  expectPrompt(clientMessageId: string, text: string, now = Date.now()): void {
    if (this.#prompts.some(prompt => prompt.clientMessageId === clientMessageId)) return;
    this.#prompts.push({ clientMessageId, text: text.trim(), after: this.#reader?.projection.entries.length ?? 0, at: now });
    while (this.#prompts.length > MAX_PHONE_PROMPTS) this.#prompts.shift();
  }

  readTool(owner: string, request: ToolContentReadRequest, signal?: AbortSignal): Promise<ToolContentPage> {
    if (this.#closed) return Promise.reject(new ToolContentReadError("content_unavailable"));
    return this.#tools.read(owner, request, signal);
  }

  /** Serialized transcript read; failures publish unknown rather than an empty history. */
  refresh(): Promise<void> {
    const run = this.#queue.then(() => this.#refreshNow());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Waits until every row the bridge announced for the turn is on disk, then drops the
   * streamed copies. Unmatched streamed text is never kept next to its canonical twin.
   */
  async settleTurn(announced: readonly string[], messageIds: readonly string[] = this.source.snapshot().live.messages.map(item => item.message.messageId)): Promise<void> {
    // Capture ownership before the first await. A newer turn can start while disk writes settle.
    const owned = new Set(messageIds);
    const timeout = this.#options.settleTimeoutMs ?? 3_000;
    const interval = this.#options.settleIntervalMs ?? 100;
    const deadline = Date.now() + timeout;
    for (;;) {
      await this.refresh().catch(() => undefined);
      if (this.#closed || announced.every(uuid => this.hasEntry(uuid)) || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    if (this.#closed) return;
    this.source.transaction(() => {
      this.#commitProjection();
      for (const id of owned) {
        // A reported commit whose bytes are late remains live until a later refresh can hand it
        // over. Timing out is not proof that its native content was lost or can be discarded.
        const step = this.#steps.get(id);
        if (step?.stored !== undefined) owned.delete(id);
        else this.#retire(id);
      }
      // Release only this turn's interrupted / unmapped steps, in the same canonical transaction.
      this.#commitProjection();
      const live = this.source.snapshot().live;
      if (live.messages.some(item => owned.has(item.message.messageId))) {
        this.source.replaceLive({ ...live, messages: live.messages.filter(item => !owned.has(item.message.messageId)) });
      }
    });
  }

  async sync(request: SessionSyncRequest): Promise<SessionSnapshot> {
    await this.refresh().catch(() => undefined);
    this.source.flushPending();
    this.source.replayToolInventory();
    const entries = this.#projected();
    return this.#preparer.select({
      entries, sessionId: this.#sessionId, leafId: entries.at(-1)?.entryId ?? null,
      request, source: this.source.published(),
    });
  }

  close(): void {
    this.#closed = true;
    void this.#tools.dispose().catch(() => undefined);
  }

  #projected() {
    const entries = this.#reader?.projection.entries ?? [];
    // Keep the canonical path intact: descendants of a gated row wait with their parent.
    const boundary = entries.findIndex(entry => this.#rowOwners.has(entry.entryId));
    return (boundary < 0 ? entries : entries.slice(0, boundary))
      .map((entry, order) => this.#withClientId(this.#tools.entry(entry, order)));
  }

  #retire(messageId: string): void {
    const step = this.#steps.get(messageId);
    for (const uuid of step?.reserved ?? []) if (this.#rowOwners.get(uuid) === messageId) this.#rowOwners.delete(uuid);
    this.#steps.delete(messageId);
    this.#retiredMessages.add(messageId);
    while (this.#retiredMessages.size > 512) this.#retiredMessages.delete(this.#retiredMessages.values().next().value!);
  }

  #commitProjection(): void {
    const mappings: { messageId: string; entryId: string }[] = [];
    const retired = new Set<string>();
    for (const [messageId, step] of this.#steps) {
      // Commit in native step order: a later step cannot remove its overlay while an earlier
      // missing row still gates its canonical ancestors.
      if (step.stored === undefined || !step.stored.every(uuid => this.hasEntry(uuid))) break;
      // An opaque step identity owns this whole set, never a match guessed from text or position.
      // The last rendered row is the commit anchor; all rows are released in this transaction.
      const ids = new Set(step.stored);
      const anchor = [...(this.#reader?.projection.entries ?? [])].reverse().find(entry => ids.has(entry.entryId));
      if (anchor !== undefined) mappings.push({ messageId, entryId: anchor.entryId });
      retired.add(messageId);
      this.#retire(messageId);
    }
    const entries = this.#projected();
    this.source.reconcile(entries, entries.at(-1)?.entryId ?? null, mappings);
    // Empty / signature-only native responses have no rendered commit anchor.
    const live = this.source.snapshot().live;
    if (live.messages.some(item => retired.has(item.message.messageId))) {
      this.source.replaceLive({ ...live, messages: live.messages.filter(item => !retired.has(item.message.messageId)) });
    }
  }

  #withClientId(entry: RemoteSessionEntry): RemoteSessionEntry {
    const clientMessageId = this.#claims.get(entry.entryId);
    if (clientMessageId === undefined) return entry;
    const cached = this.#annotated.get(entry);
    if (cached !== undefined) return cached;
    const message = entry.data.message as Record<string, unknown>;
    const annotated = { ...entry, data: { ...entry.data, message: { ...message, clientMessageId } } };
    this.#annotated.set(entry, annotated);
    return annotated;
  }

  #claimPrompts(now = Date.now()): void {
    while (this.#prompts.length > 0 && now - this.#prompts[0]!.at > PHONE_PROMPT_TTL_MS) this.#prompts.shift();
    if (this.#prompts.length === 0) return;
    const entries = this.#reader?.projection.entries ?? [];
    const claimed = new Set(this.#claims.keys());
    for (const prompt of [...this.#prompts]) {
      const row = entries.slice(Math.min(prompt.after, entries.length)).find(entry => {
        if (claimed.has(entry.entryId) || entry.type !== "message") return false;
        const message = entry.data.message as { role?: unknown; content?: unknown } | undefined;
        return message?.role === "user" && userText(message.content) === prompt.text;
      });
      if (row === undefined) continue;
      claimed.add(row.entryId);
      this.#claims.set(row.entryId, prompt.clientMessageId);
      while (this.#claims.size > 256) this.#claims.delete(this.#claims.keys().next().value!);
      this.#prompts.splice(this.#prompts.indexOf(prompt), 1);
    }
  }

  async #refreshNow(): Promise<void> {
    if (this.#closed) return;
    try {
      if (this.#reader === undefined) {
        const path = await (this.#options.locate ?? findClaudeTranscript)(this.#sessionId, this.#configDir);
        // A brand-new Session has no transcript until its first row; that is an empty history.
        if (path === undefined) {
          this.source.transaction(() => {
            this.#commitProjection();
            this.source.setAvailability(true, true);
          });
          return;
        }
        this.#reader = new ClaudeTranscriptReader(path);
      }
      const reset = await this.#reader.read();
      if (this.#closed) return;
      if (reset) this.#preparer.invalidate();
      this.#claimPrompts();
      const projection = this.#reader.projection;
      this.source.transaction(() => {
        this.#commitProjection();
        this.source.setAvailability(true, true);
      });
      const facts = JSON.stringify(projection.facts);
      if (facts !== this.#facts) {
        this.#facts = facts;
        this.#options.onFacts?.({ ...projection.facts });
      }
    } catch (error) {
      if (!this.#closed) this.source.setAvailability(false, false);
      throw error;
    }
  }

  /** Explicit tool reads only: the call's input or its result, straight from the transcript. */
  async #nativeTool(locator: ToolContentLocator): Promise<{ format: "json" | "text"; value: unknown } | undefined> {
    const path = this.#reader?.path;
    if (path === undefined) return undefined;
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024 * 1024) throw new ToolContentReadError("content_unavailable");
    const id = locator.tool.toolCallId;
    for (const line of raw.split("\n")) {
      if (!line.includes(id)) continue;
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      const content = (row as { message?: { content?: unknown } } | null)?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Record<string, unknown>[]) {
        if (locator.part === "arguments" && block.type === "tool_use" && block.id === id) return { format: "json", value: block.input ?? {} };
        if (locator.part !== "arguments" && block.type === "tool_result" && block.tool_use_id === id) {
          return typeof block.content === "string" ? { format: "text", value: block.content } : { format: "json", value: block.content ?? null };
        }
      }
    }
    return undefined;
  }
}

function userText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap(block => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []);
  return texts.length === content.length ? texts.join("\n").trim() : undefined;
}
