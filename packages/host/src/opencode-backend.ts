import type { OpenCodeEvent } from "@opencode/client";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { RecoverableSessionSource, SessionSyncPreparer, type AgentSessionSummary, type ChatMessage, type InteractionRequest,
  type RemoteSessionEntry, type RuntimeCommand, type RuntimeEvent, type RuntimeMetadata, type SessionLiveTurn } from "@orbis/protocol";
import type { AgentBackend, AgentActivateTarget, BackendActivation, CommandDispatch } from "./agent-backend.js";
import { ActivationError } from "./spawner.js";
import { OPENCODE_RUNTIME_PREFIX } from "./dsh-desktop-visibility.js";
import { type OpenCodeClient, OpenCodeServiceConnection } from "./opencode-service-connection.js";
import { formRequest, permissionRequest, projectAssistant, projectHistory, projectLive, time, wireId,
  type NativeForm, type NativeMessage, type NativeSession } from "./opencode-projection.js";

const PAGE_SIZE = 200;
const MAX_PAGES = 500;
const REQUEST_MS = 10_000;
const STREAM_IDLE_MS = 90_000;
const REFRESH_MS = 80;
const MAX_RUNTIMES = 256;
const runtimeIdFor = (sessionId: string) => OPENCODE_RUNTIME_PREFIX + sessionId;
const SESSION_EVENTS = ["session.created", "session.deleted", "session.archived", "session.unarchived", "session.renamed", "session.moved",
  "session.agent.selected", "session.model.selected", "session.execution.started", "session.execution.succeeded", "session.execution.failed",
  "session.execution.interrupted", "session.idle", "session.step.started", "session.step.ended", "session.step.failed",
  "session.inbox.delivered", "session.inbox.enqueued", "session.inbox.cancelled", "session.inbox.delivery.changed",
  "session.text.delta", "session.text.ended", "session.reasoning.delta", "session.reasoning.ended", "session.tool.input.started",
  "session.tool.called", "session.tool.progress", "session.tool.success", "session.tool.failed", "session.compaction.ended",
  "session.revert.committed", "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled"] as const;

type Attempt = { client: OpenCodeClient; controller: AbortController };
type PendingInteraction = { request: InteractionRequest; form?: NativeForm };
type RecordState = {
  nativeId: string;
  runtime?: RuntimeMetadata;
  source: RecoverableSessionSource;
  preparer: SessionSyncPreparer;
  entries: readonly RemoteSessionEntry[];
  firstMessage?: string | undefined;
  messageCount?: number;
  turn: SessionLiveTurn | null;
  assistant?: ChatMessage | undefined;
  interactions: Map<string, PendingInteraction>;
  interactionsKnown?: boolean;
  queue: Promise<void>;
  timer?: ReturnType<typeof setTimeout> | undefined;
  full: boolean;
  liveMessageId?: string | undefined;
};

type OpenCodeBackendOptions = {
  connection: OpenCodeServiceConnection;
  hostId: string;
  onRuntimeOnline: (runtime: RuntimeMetadata) => void;
  onRuntimeOffline: (runtimeId: string, reason: string) => void;
  onEvent: (runtimeId: string, event: RuntimeEvent) => void;
  onCatalogChange: () => void;
  onAvailabilityChange: () => void;
  reconnectMs?: number;
};

async function readPages<T extends { id: string }>(read: (cursor: string | undefined) => Promise<{
  data: T[]; cursor: { next?: string | null | undefined };
}>): Promise<T[]> {
  const rows = new Map<string, T>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await read(cursor);
    for (const row of page.data) if (!rows.has(row.id)) rows.set(row.id, row);
    const next = page.cursor.next;
    if (next == null) return [...rows.values()];
    if (cursors.has(next)) throw new Error("OpenCode returned a repeated cursor");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("OpenCode pagination limit reached");
}

export class OpenCodeBackend implements AgentBackend {
  readonly kind = "opencode" as const;
  readonly #records = new Map<string, RecordState>();
  #unsubscribe: (() => void) | undefined;
  #monitor: AbortController | undefined;
  #attempt: Attempt | undefined;
  #ready = false;
  #closed = false;

  constructor(readonly options: OpenCodeBackendOptions) {}

  start(): void {
    if (this.#unsubscribe || this.#closed) return;
    const connect = () => {
      this.#monitor?.abort();
      const client = this.options.connection.client;
      this.#offline(this.options.connection.isReady ? "service_replaced" : "service_unavailable");
      if (!client || !this.options.connection.isReady) return;
      const controller = new AbortController();
      this.#monitor = controller;
      void this.#run(client, controller.signal);
    };
    this.#unsubscribe = this.options.connection.subscribe(connect);
    if (this.options.connection.isReady) connect();
  }

  isReady(): boolean { return this.#ready && !this.#closed; }
  ownsRuntime(runtimeId: string): boolean { return runtimeId.startsWith(OPENCODE_RUNTIME_PREFIX); }
  directoryEntries(): RuntimeMetadata[] {
    return [...this.#records.values()].flatMap(record => record.runtime ? [record.runtime] : []);
  }

  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    const attempt = this.#requireReady();
    let rows: NativeSession[];
    try {
      rows = await readPages(cursor => attempt.client.session.list({ archived, order: "desc", limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }) }, this.#request(attempt)));
      attempt.controller.signal.throwIfAborted();
    } catch (error) {
      if (error instanceof Error && error.message === "OpenCode returned a repeated cursor") throw error;
      throw new Error("OpenCode session catalog could not be read");
    }
    return rows.map(info => {
      const known = this.#records.get(info.id);
      return { sessionId: info.id, cwd: info.location.directory, createdAt: time(info.time.created), modifiedAt: time(info.time.updated),
        ...(info.title === undefined ? {} : { name: info.title.slice(0, 256) }),
        ...(known?.firstMessage === undefined ? {} : { firstMessage: known.firstMessage }),
        // SessionInfo has no message count; zero is the protocol's unknown count before a history read.
        messageCount: known?.messageCount ?? 0, agentKind: this.kind, hostname: hostname(), archived,
        ...(info.model === undefined ? {} : { modelProvider: info.model.providerID }) };
    });
  }

  async activate(target: AgentActivateTarget): Promise<BackendActivation> {
    const attempt = this.#requireReady();
    if (target.type !== "resume") throw new ActivationError("agent_unsupported", "OpenCode creation is not available");
    if (!target.sessionId || runtimeIdFor(target.sessionId).length > 128) throw new ActivationError("session_not_found", "OpenCode session not found");
    const record = this.#record(target.sessionId);
    try { await this.#enqueue(record, attempt, () => this.#refresh(record, attempt)); }
    catch {
      if (!record.runtime) this.#records.delete(target.sessionId);
      throw new ActivationError(attempt.controller.signal.aborted ? "agent_unsupported" : "session_not_found", "OpenCode session could not be opened");
    }
    return { sessionId: target.sessionId, spawnMode: "headless" };
  }

  async setArchived(): Promise<void> { throw new Error("OpenCode archive operation is not available"); }

  async readSessionEntry(runtimeId: string, sessionId: string, entryId: string): Promise<RemoteSessionEntry | undefined> {
    const record = this.#records.get(sessionId);
    return runtimeId === runtimeIdFor(sessionId) && record?.runtime ? record.source.entry(entryId) : undefined;
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    if (!this.#ready || !this.#attempt || !this.ownsRuntime(runtimeId)) return "offline";
    const record = this.#records.get(runtimeId.slice(OPENCODE_RUNTIME_PREFIX.length));
    if (!record?.runtime) return "offline";
    if (command.type !== "session.sync") return "unsupported";
    try {
      if (command.sessionId !== record.nativeId) throw new Error("session_mismatch");
      const source = record.source.published();
      const snapshot = record.preparer.select({ entries: record.entries, sessionId: record.nativeId, leafId: source.checkpoint.head.leafId,
        source, request: { ...command, range: command.range ?? "preview" } });
      this.options.onEvent(runtimeId, snapshot);
    } catch { this.options.onEvent(runtimeId, { type: "runtime.error", commandId, recoverable: true, message: "OpenCode history could not be read" }); }
    return "handled";
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    this.#monitor?.abort();
    this.#offline("host_shutdown");
    this.#records.clear();
  }

  #requireReady(): Attempt {
    if (!this.#ready || !this.#attempt || this.#attempt.controller.signal.aborted) {
      throw new ActivationError("agent_unsupported", "OpenCode shared service is not available; open OpenCode on this computer and check its version");
    }
    return this.#attempt;
  }

  #request(attempt: Attempt): { signal: AbortSignal } {
    return { signal: AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(REQUEST_MS)]) };
  }

  // ADR-0085 §3: the stream is live-only. Native reads rebuild the current snapshot after every subscription.
  async #run(client: OpenCodeClient, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.#closed) {
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      signal.addEventListener("abort", interrupt, { once: true });
      const attempt = { client, controller };
      this.#attempt = attempt;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const activity = () => {
        clearTimeout(timeout);
        timeout = setTimeout(interrupt, STREAM_IDLE_MS);
        timeout.unref();
      };
      let stream: AsyncIterator<OpenCodeEvent> | undefined;
      try {
        activity();
        stream = client.event.subscribe({ types: [...SESSION_EVENTS], signal: controller.signal, onActivity: activity })[Symbol.asyncIterator]();
        const first = await stream.next();
        if (first.done || first.value.type !== "server.connected") throw new Error("OpenCode event stream not connected");
        const active = await client.session.active(this.#request(attempt));
        controller.signal.throwIfAborted();
        for (const id of Object.keys(active)) this.#recordIfValid(id);
        for (const record of this.#records.values()) {
          try { await this.#enqueue(record, attempt, () => this.#refresh(record, attempt)); }
          catch { /* An unavailable session does not prevent other sessions from attaching. */ }
        }
        controller.signal.throwIfAborted();
        this.#setReady(true);
        this.options.onCatalogChange();
        while (!controller.signal.aborted) {
          const item = await stream.next();
          if (item.done || controller.signal.aborted) break;
          this.#event(item.value, attempt);
        }
      } catch { /* Never include native errors, URLs, or payloads in Host output. */ }
      finally {
        if (this.#attempt === attempt) this.#offline("event_stream_disconnected");
        clearTimeout(timeout);
        signal.removeEventListener("abort", interrupt);
        controller.abort();
        try { await stream?.return?.(); } catch { /* Already disconnected. */ }
      }
      if (!signal.aborted) await delay(this.options.reconnectMs ?? 1_000, undefined, { signal, ref: false }).catch(() => undefined);
    }
  }

  #setReady(value: boolean): void {
    if (this.#ready === value) return;
    this.#ready = value;
    this.options.onAvailabilityChange();
  }

  #offline(reason: string): void {
    this.#attempt?.controller.abort();
    this.#attempt = undefined;
    for (const record of this.#records.values()) this.#retire(record, reason);
    this.#setReady(false);
    this.options.onCatalogChange();
  }

  #retire(record: RecordState, reason: string): void {
    clearTimeout(record.timer);
    record.timer = undefined;
    record.full = false;
    record.liveMessageId = undefined;
    record.queue = Promise.resolve();
    const runtime = record.runtime;
    delete record.runtime;
    record.source = this.#source(record.nativeId);
    record.entries = [];
    record.preparer.invalidate();
    record.assistant = undefined;
    record.interactions.clear();
    record.interactionsKnown = false;
    if (runtime) this.options.onRuntimeOffline(runtime.runtimeId, reason);
  }

  #source(id: string): RecoverableSessionSource {
    return new RecoverableSessionSource(id, event => this.options.onEvent(runtimeIdFor(id), event));
  }

  #recordIfValid(id: string): RecordState | undefined {
    if (!id || runtimeIdFor(id).length > 128) return undefined;
    if (!this.#records.has(id) && this.#records.size >= MAX_RUNTIMES && ![...this.#records.values()].some(record => !record.runtime)) return undefined;
    return this.#record(id);
  }

  #record(id: string): RecordState {
    const existing = this.#records.get(id);
    if (existing) return existing;
    if (this.#records.size >= MAX_RUNTIMES) {
      const old = [...this.#records.values()].find(record => !record.runtime || record.runtime.status === "idle");
      if (!old) throw new ActivationError("agent_unsupported", "OpenCode runtime limit reached");
      this.#retire(old, "runtime_limit");
      this.#records.delete(old.nativeId);
    }
    const record: RecordState = { nativeId: id, source: this.#source(id), preparer: new SessionSyncPreparer(),
      entries: [], turn: null, interactions: new Map(), queue: Promise.resolve(), full: false };
    this.#records.set(id, record);
    return record;
  }

  #check(record: RecordState, attempt: Attempt): void {
    attempt.controller.signal.throwIfAborted();
    if (this.#attempt !== attempt || this.#records.get(record.nativeId) !== record) throw new Error("OpenCode session no longer attached");
  }

  #enqueue(record: RecordState, attempt: Attempt, action: () => Promise<void>): Promise<void> {
    const next = record.queue.then(() => { this.#check(record, attempt); return action(); });
    record.queue = next.catch(() => undefined);
    return next;
  }

  #event(event: OpenCodeEvent, attempt: Attempt): void {
    const data = event.data as { sessionID?: string; form?: { sessionID: string }; id?: string };
    const id = event.type === "form.created" ? event.data.form.sessionID
      : event.type === "form.replied" || event.type === "form.cancelled"
        ? [...this.#records.values()].find(record => record.interactions.get(event.data.id)?.form)?.nativeId
        : data.sessionID;
    if (!id) return;
    if (event.type === "session.deleted") {
      const record = this.#records.get(id);
      if (record) { this.#records.delete(id); this.#retire(record, "session_deleted"); }
      this.options.onCatalogChange();
      return;
    }
    if (["session.created", "session.renamed", "session.archived", "session.unarchived", "session.moved", "session.inbox.delivered",
      "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) this.options.onCatalogChange();
    const record = this.#records.get(id) ?? (["session.execution.started", "permission.asked", "form.created"].includes(event.type)
      ? this.#recordIfValid(id) : undefined);
    if (!record) return;
    // Read the persisted partial message rather than replaying deltas collected before the recovery snapshot.
    const messageId = (data as { assistantMessageID?: string }).assistantMessageID;
    if (messageId && (event.type.startsWith("session.text.") || event.type.startsWith("session.reasoning.") || event.type.startsWith("session.tool."))) {
      record.liveMessageId = messageId;
    } else record.full = true;
    this.#schedule(record, attempt);
  }

  #schedule(record: RecordState, attempt: Attempt): void {
    if (record.timer) return;
    record.timer = setTimeout(() => {
      record.timer = undefined;
      void this.#enqueue(record, attempt, async () => {
        const full = record.full;
        const liveMessageId = record.liveMessageId;
        record.full = false;
        record.liveMessageId = undefined;
        if (full || !record.runtime) await this.#refresh(record, attempt);
        else if (liveMessageId !== undefined && record.turn && record.turn.outcome === undefined) {
          const native = await attempt.client.session.message.get({ sessionID: record.nativeId, messageID: liveMessageId }, this.#request(attempt));
          this.#check(record, attempt);
          if (native.type === "assistant" && native.time.completed === undefined) {
            record.assistant = projectAssistant(this.options.hostId, record.nativeId, native);
            record.source.replaceLive(projectLive(record.turn, record.assistant));
          }
        }
      }).catch(() => {
        // A failed read is not an authoritative empty state. Re-establish the stream and all baselines.
        if (this.#attempt === attempt && this.#records.get(record.nativeId) === record) attempt.controller.abort();
      });
    }, REFRESH_MS);
    record.timer.unref();
  }

  async #refresh(record: RecordState, attempt: Attempt): Promise<void> {
    const { client } = attempt;
    const sessionID = record.nativeId;
    const [info, active, messages, interactions] = await Promise.all([
      client.session.get({ sessionID }, this.#request(attempt)), client.session.active(this.#request(attempt)),
      readPages(cursor => client.message.list({ sessionID, order: "asc", limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }) }, this.#request(attempt))),
      this.#readInteractions(sessionID, attempt).catch(() => undefined),
    ]);
    this.#check(record, attempt);
    if (info.id !== sessionID) throw new Error("OpenCode returned mismatched session identity");
    const running = Object.hasOwn(active, sessionID);
    this.#publishHistory(record, info, messages, running);
    if (interactions) this.#publishInteractions(record, interactions);
  }

  #publishHistory(record: RecordState, info: NativeSession, messages: NativeMessage[], running: boolean): void {
    const start = time(info.time.busy ?? info.time.updated);
    if (running && (!record.turn || record.turn.startedAt !== start || record.turn.outcome !== undefined)) {
      record.turn = { turnId: wireId(`${runtimeIdFor(info.id)}:turn:${start}`), startedAt: start };
    } else if (!running && (record.turn || info.time.busy !== undefined) && info.time.idle !== undefined) {
      const turn = record.turn?.startedAt === start ? record.turn : { turnId: wireId(`${runtimeIdFor(info.id)}:turn:${start}`), startedAt: start };
      record.turn = { ...turn, durationMs: Math.max(0, time(info.time.idle) - start), outcome: info.outcome === "succeeded" ? "completed"
        : info.outcome === "failed" ? "failed" : info.outcome === "interrupted" ? "cancelled" : "unknown" };
    } else if (!running) record.turn = null;

    const latest = running ? [...messages].reverse().find(message => message.type === "assistant" && message.time.completed === undefined) : undefined;
    record.assistant = latest?.type === "assistant" ? projectAssistant(this.options.hostId, info.id, latest) : undefined;
    const first = messages.find(message => message.type === "user");
    const firstMessage = first?.type === "user" ? first.text.slice(0, 4_000) : undefined;
    const changedCount = record.messageCount !== messages.length || record.firstMessage !== firstMessage;
    record.firstMessage = firstMessage;
    record.messageCount = messages.length;
    const entries = projectHistory(this.options.hostId, info.id, messages, running);
    record.entries = entries;
    record.preparer.invalidate();
    const leafId = entries.at(-1)?.entryId ?? null;
    const runtime = this.#runtime(info, running);
    const firstPublication = record.runtime === undefined;
    const changedRuntime = !isDeepStrictEqual(record.runtime, runtime);
    record.runtime = runtime;
    if (changedRuntime) this.options.onRuntimeOnline(runtime);
    if (changedCount) this.options.onCatalogChange();
    if (firstPublication) record.source.reestablish();
    record.source.transaction(() => {
      record.source.reconcile(entries, leafId);
      const live = projectLive(record.turn, record.assistant);
      record.source.replaceLive(live);
      record.source.setAvailability(true, live.complete);
    });
  }

  #runtime(info: NativeSession, running: boolean): RuntimeMetadata {
    const title = info.title?.trim().slice(0, 256);
    return { runtimeId: runtimeIdFor(info.id), name: title || "OpenCode", cwd: info.location.directory,
      status: running ? "running" : "idle", sessionId: info.id, sessionGraphSync: true, hostname: hostname(),
      ...(title ? { sessionName: title } : {}),
      ...(info.model ? { model: { provider: info.model.providerID, id: info.model.id } } : {}) };
  }

  async #readInteractions(sessionID: string, attempt: Attempt): Promise<Map<string, PendingInteraction>> {
    const { client } = attempt;
    const [permissions, forms] = await Promise.all([client.permission.list({ sessionID }, this.#request(attempt)),
      client.session.form.list({ sessionID }, this.#request(attempt))]);
    const result = new Map<string, PendingInteraction>();
    const runtimeId = runtimeIdFor(sessionID);
    const now = Date.now();
    for (const permission of permissions.slice(0, 64)) if (permission.sessionID === sessionID) {
      result.set(permission.id, { request: permissionRequest(runtimeId, permission, now) });
    }
    for (const item of forms.filter(form => form.sessionID === sessionID).slice(0, 64 - result.size)) {
      const form = await client.session.form.get({ sessionID, formID: item.id }, this.#request(attempt));
      if (form.id !== item.id || form.sessionID !== sessionID || result.has(form.id)) continue;
      const request = formRequest(runtimeId, form, now);
      if (request) result.set(request.requestId, { request, form });
    }
    return result;
  }

  #publishInteractions(record: RecordState, next: Map<string, PendingInteraction>): void {
    const runtimeId = runtimeIdFor(record.nativeId);
    for (const [key, pending] of next) {
      const previous = record.interactions.get(key);
      if (previous && isDeepStrictEqual({ ...pending.request, expiresAt: previous.request.expiresAt }, previous.request)) {
        pending.request = previous.request;
      } else this.options.onEvent(runtimeId, { type: "interaction.requested", request: pending.request });
    }
    if (!record.interactionsKnown || next.size !== record.interactions.size || [...next].some(([key, item]) => item.request !== record.interactions.get(key)?.request)) {
      this.options.onEvent(runtimeId, { type: "interaction.snapshot", requests: [...next.values()].map(item => item.request) });
    }
    record.interactions = next;
    record.interactionsKnown = true;
  }
}
