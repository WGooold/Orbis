import {
  RecoverableSessionSource,
  SessionSyncPreparer,
  type RuntimeCommand,
  type RuntimeEvent,
} from "@orbis/protocol";
import { ClaudeTranscriptReader, findClaudeTranscript } from "./claude-transcript.js";

type SessionSyncRequest = Extract<RuntimeCommand, { type: "session.sync" }>;
type SessionSnapshot = Extract<RuntimeEvent, { type: "session.snapshot" }>;

export type ClaudeSessionHistoryOptions = {
  locate?: (sessionId: string, configDir: string) => Promise<string | undefined>;
  /** How long a finished turn waits for its announced rows to reach the transcript. */
  settleTimeoutMs?: number;
  settleIntervalMs?: number;
};

/**
 * Versioned conversation source for one attached Claude Code Session.
 *
 * Canonical history comes only from the native transcript. Streamed output is live
 * state; once a turn completes and its rows are on disk, the transcript replaces it.
 */
export class ClaudeSessionHistory {
  readonly source: RecoverableSessionSource;
  readonly #sessionId: string;
  readonly #configDir: string;
  readonly #preparer = new SessionSyncPreparer();
  readonly #options: ClaudeSessionHistoryOptions;
  #reader: ClaudeTranscriptReader | undefined;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(sessionId: string, configDir: string, publish: (event: Extract<RuntimeEvent, { type: "session.patch" }>) => void,
    options: ClaudeSessionHistoryOptions = {}) {
    this.#sessionId = sessionId;
    this.#configDir = configDir;
    this.#options = options;
    this.source = new RecoverableSessionSource(sessionId, event => { if (!this.#closed) publish(event); });
  }

  /** Consumes legacy live events (messages, turns, tools); false means forward the event as is. */
  observe(event: RuntimeEvent): boolean { return this.source.observe(event); }

  hasEntry(uuid: string): boolean { return this.#reader?.projection.has(uuid) ?? false; }

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
    const live = this.source.snapshot().live;
    if (live.messages.length > 0) this.source.replaceLive({ ...live, messages: [] });
  }

  async sync(request: SessionSyncRequest): Promise<SessionSnapshot> {
    await this.refresh().catch(() => undefined);
    this.source.flushPending();
    const projection = this.#reader?.projection;
    return this.#preparer.select({
      entries: projection?.entries ?? [], sessionId: this.#sessionId, leafId: projection?.leafId ?? null,
      request, source: this.source.snapshot(),
    });
  }

  close(): void { this.#closed = true; }

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
        this.source.reconcile(projection.entries, projection.leafId);
        this.source.setAvailability(true, true);
      });
    } catch (error) {
      if (!this.#closed) this.source.setAvailability(false, false);
      throw error;
    }
  }
}
