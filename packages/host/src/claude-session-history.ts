import { readFile } from "node:fs/promises";
import { ToolActivityProducer, ToolContentReadError, type ToolContentStore } from "@orbis/runtime-bridge";
import {
  RecoverableSessionSource,
  SessionSyncPreparer,
  type AgentKey,
  type RuntimeCommand,
  type RuntimeEvent,
  type ToolContentLocator,
  type ToolContentPage,
  type ToolContentReadRequest,
} from "@orbis/protocol";
import { ClaudeTranscriptReader, findClaudeTranscript, type ClaudeTranscriptFacts } from "./claude-transcript.js";

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
  observe(event: RuntimeEvent): boolean { return this.source.observe(this.#tools.event(event)); }

  turnAnchor(announced: readonly string[]): string | undefined {
    const ids = new Set(announced);
    return [...this.#projected()].reverse().find(entry => ids.has(entry.entryId)
      && typeof entry.data.message === "object" && entry.data.message !== null
      && (entry.data.message as { role?: string }).role === "assistant")?.entryId;
  }

  hasEntry(uuid: string): boolean { return this.#reader?.projection.has(uuid) ?? false; }

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
  async settleTurn(announced: readonly string[]): Promise<void> {
    const timeout = this.#options.settleTimeoutMs ?? 3_000;
    const interval = this.#options.settleIntervalMs ?? 100;
    const deadline = Date.now() + timeout;
    for (;;) {
      await this.refresh().catch(() => undefined);
      if (this.#closed || announced.every(uuid => this.hasEntry(uuid)) || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    if (this.#closed) return;
    // Live tools leave on their own: reconcile drops the twin of every tool result on disk.
    const live = this.source.snapshot().live;
    if (live.messages.length > 0) this.source.replaceLive({ ...live, messages: [] });
  }

  async sync(request: SessionSyncRequest): Promise<SessionSnapshot> {
    await this.refresh().catch(() => undefined);
    this.source.flushPending();
    this.source.replayToolInventory();
    const projection = this.#reader?.projection;
    return this.#preparer.select({
      entries: this.#projected(), sessionId: this.#sessionId, leafId: projection?.leafId ?? null,
      request, source: this.source.snapshot(),
    });
  }

  close(): void {
    this.#closed = true;
    void this.#tools.dispose().catch(() => undefined);
  }

  #projected() {
    return (this.#reader?.projection.entries ?? []).map((entry, order) => this.#tools.entry(entry, order));
  }

  async #refreshNow(): Promise<void> {
    if (this.#closed) return;
    try {
      if (this.#reader === undefined) {
        const path = await (this.#options.locate ?? findClaudeTranscript)(this.#sessionId, this.#configDir);
        // A brand-new Session has no transcript until its first row; that is an empty history.
        if (path === undefined) {
          this.source.setAvailability(true, true);
          return;
        }
        this.#reader = new ClaudeTranscriptReader(path);
      }
      const reset = await this.#reader.read();
      if (this.#closed) return;
      if (reset) this.#preparer.invalidate();
      const projection = this.#reader.projection;
      this.source.transaction(() => {
        this.source.reconcile(this.#projected(), projection.leafId);
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
