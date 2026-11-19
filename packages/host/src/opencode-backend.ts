import { isMessageNotFoundError, isSessionNotFoundError, type OpenCodeEvent } from "@opencode/client";
import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { RecoverableSessionSource, SessionSyncPreparer, type AgentSessionSummary, type ChatMessage, type InteractionRequest,
  type RemoteSessionEntry, type RuntimeCapabilities, type RuntimeCommand, type RuntimeCommandStatus, type RuntimeEvent, type RuntimeMetadata, type SessionConfigurationCatalog, type SessionLiveTurn } from "@orbis/protocol";
import type { AgentBackend, AgentActivateContext, AgentActivateTarget, BackendActivation, CommandDispatch } from "./agent-backend.js";
import { ActivationError } from "./spawner.js";
import { OPENCODE_RUNTIME_PREFIX } from "./device-agent-visibility.js";
import { type OpenCodeClient, OpenCodeServiceConnection } from "./opencode-service-connection.js";
import { formRequest, permissionRequest, projectAssistant, projectHistory, projectLive, time, wireId,
  type NativeForm, type NativeMessage, type NativeSession } from "./opencode-projection.js";

import { clientMessageKey, commandFailure, formAnswers, modelValue, OpenCodeCommandError, readAgents, readModels,
  selectionCommands, selectionModel } from "./opencode-commands.js";

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
type InboxUser = Awaited<ReturnType<OpenCodeClient["session"]["prompt"]>>;
type ModelRef = NonNullable<NativeSession["model"]>;
const sameModel = (left: NativeSession["model"], right: ModelRef) => left?.providerID === right.providerID && left.id === right.id
  && (left.variant ?? "default") === (right.variant ?? "default");
const clientIdOf = (item: InboxUser): string | undefined => {
  const id = item.payload.metadata?.[clientMessageKey];
  return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
};
const queueIdOf = (item: InboxUser): string => clientIdOf(item) ?? wireId(item.id);
const selectionNames = new Set(["model", "thinking", "agent"]);
type RecordState = {
  nativeId: string;
  runtime?: RuntimeMetadata;
  info?: NativeSession;
  capabilities?: RuntimeCapabilities;
  capabilitiesUntil?: number;
  pendingModel?: ModelRef;
  pendingAgent?: string;
  inbox: Map<string, InboxUser>;
  inboxTerminal: Map<string, { state: "delivered" | "cancelled"; clientId?: string | undefined }>;
  inboxKnown: boolean;
  responding: Set<string>;
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
      rows = await readPages(cursor => attempt.client.session.list({ archived, limit: PAGE_SIZE,
        ...(cursor === undefined ? { order: "desc" } : { cursor }) }, this.#request(attempt)));
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

  async sessionConfiguration(cwd: string): Promise<SessionConfigurationCatalog> {
    await this.#checkDirectory(cwd);
    const attempt = this.#requireReady();
    try {
      const { catalog } = await readModels(attempt.client, cwd, this.#request(attempt));
      attempt.controller.signal.throwIfAborted();
      return catalog;
    } catch { throw new Error("OpenCode model options could not be read"); }
  }

  async activate(target: AgentActivateTarget, context?: AgentActivateContext): Promise<BackendActivation> {
    const attempt = this.#requireReady();
    const { client } = attempt;
    let sessionId: string;
    let selected: ModelRef | undefined;
    try {
      if (target.type === "new") {
        await this.#checkDirectory(target.cwd);
        if (context?.configuration) selected = selectionModel(await readModels(client, target.cwd, this.#request(attempt)), context.configuration);
        attempt.controller.signal.throwIfAborted();
        const info = await client.session.create({ location: { directory: target.cwd }, ...(selected ? { model: selected } : {}) }, this.#request(attempt));
        sessionId = info.id;
        await context?.onCreated?.({ sessionId, spawnMode: "headless" });
        if (selected && !sameModel(info.model, selected)) throw new OpenCodeCommandError("configuration_unconfirmed", "unconfirmed");
        this.options.onCatalogChange();
      } else sessionId = target.sessionId;
      attempt.controller.signal.throwIfAborted();
      if (!sessionId || runtimeIdFor(sessionId).length > 128) throw new ActivationError("session_not_found", "OpenCode session not found");
      const record = this.#record(sessionId);
      try {
        await this.#enqueue(record, attempt, async () => {
          // A configured launch recovery may only apply settings to the already recorded session.
          if (target.type === "resume" && context?.configuration) {
            const info = await client.session.get({ sessionID: sessionId }, this.#request(attempt));
            const models = await readModels(client, info.location.directory, this.#request(attempt));
            const model = selectionModel(models, context.configuration);
            if (model && !sameModel(info.model, model)) await this.#switchModel(record, attempt, model);
          }
          await this.#refresh(record, attempt);
          if (selected && !sameModel(record.info?.model, selected)) throw new OpenCodeCommandError("configuration_unconfirmed", "unconfirmed");
        });
      } catch (error) {
        if (!record.runtime && this.#records.get(sessionId) === record && this.#attempt === attempt) this.#records.delete(sessionId);
        throw error;
      }
      return { sessionId, spawnMode: "headless" };
    } catch (error) {
      if (error instanceof ActivationError || error instanceof OpenCodeCommandError) throw error;
      if (target.type === "resume" && isSessionNotFoundError(error)) throw new ActivationError("session_not_found", "OpenCode session could not be opened");
      throw new ActivationError(target.type === "new" ? "spawn_failed" : "agent_unsupported", "OpenCode session result could not be confirmed");
    }
  }

  async #checkDirectory(cwd: string): Promise<void> {
    if (!isAbsolute(cwd) || !await stat(cwd).then(value => value.isDirectory(), () => false)) {
      throw new ActivationError("cwd_missing", "OpenCode working directory is unavailable");
    }
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const attempt = this.#requireReady();
    try { await attempt.client.session.update({ sessionID: sessionId, archived }, this.#request(attempt)); }
    catch { throw new Error("OpenCode archive result could not be confirmed"); }
    this.options.onCatalogChange();
  }

  async readSessionEntry(runtimeId: string, sessionId: string, entryId: string): Promise<RemoteSessionEntry | undefined> {
    const record = this.#records.get(sessionId);
    return runtimeId === runtimeIdFor(sessionId) && record?.runtime ? record.source.entry(entryId) : undefined;
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    if (!this.#ready || !this.#attempt || !this.ownsRuntime(runtimeId)) return "offline";
    const record = this.#records.get(runtimeId.slice(OPENCODE_RUNTIME_PREFIX.length));
    if (!record?.runtime) return "offline";
    if (command.type !== "session.sync") {
      if (command.type !== "user_message" && command.type !== "user_message.cancel" && command.type !== "stop" && command.type !== "interaction.respond" &&
          !(command.type === "slash.execute" && selectionNames.has(command.name))) return "unsupported";
      void this.#dispatch(record, this.#attempt, commandId, command);
      return "handled";
    }
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

  // ADR-0091 §3: the stream is live-only. Native reads rebuild the current snapshot after every subscription.
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
    delete record.info;
    delete record.capabilities;
    delete record.capabilitiesUntil;
    record.responding = new Set();
    record.source = this.#source(record.nativeId);
    record.entries = [];
    record.preparer.invalidate();
    record.assistant = undefined;
    record.interactions.clear();
    record.interactionsKnown = false;
    record.inboxKnown = false;
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
      entries: [], turn: null, interactions: new Map(), inbox: new Map(), inboxTerminal: new Map(), inboxKnown: false, responding: new Set(), queue: Promise.resolve(), full: false };
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
    const data = event.data as { sessionID?: string; assistantMessageID?: string };
    const id = event.type === "form.created" ? event.data.form.sessionID : data.sessionID;
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
    if (event.type === "permission.replied" || event.type === "form.replied") {
      const requestId = event.type === "permission.replied" ? event.data.requestID : event.data.id;
      this.#finishInteraction(record, requestId, false, record.responding.has(requestId) ? "remote" : "local");
    } else if (event.type === "form.cancelled") this.#finishInteraction(record, event.data.id, true, "remote");
    else if (event.type === "session.inbox.delivered") this.#finishInbox(record, event.data.inboxID, "delivered");
    else if (event.type === "session.inbox.cancelled") this.#finishInbox(record, event.data.inboxID, "cancelled");
    // Read the persisted partial message rather than replaying deltas collected before the recovery snapshot.
    const messageId = data.assistantMessageID;
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
    const [info, active, messages, interactions, inbox] = await Promise.all([
      client.session.get({ sessionID }, this.#request(attempt)), client.session.active(this.#request(attempt)),
      readPages(cursor => client.message.list({ sessionID, limit: PAGE_SIZE,
        ...(cursor === undefined ? { order: "asc" } : { cursor }) }, this.#request(attempt))),
      this.#readInteractions(sessionID, attempt).catch(() => undefined),
      this.#readInbox(sessionID, attempt).catch(() => undefined),
    ]);
    this.#check(record, attempt);
    if (info.id !== sessionID) throw new Error("OpenCode returned mismatched session identity");
    const running = Object.hasOwn(active, sessionID);
    this.#publishHistory(record, info, messages, running);
    if (interactions) this.#publishInteractions(record, interactions);
    if (inbox) this.#publishInbox(record, inbox, new Set(messages.map(message => message.id)));
    const modelChanged = !isDeepStrictEqual(record.info?.model, info.model);
    record.info = info;
    this.#confirmSelection(record, info);
    if (modelChanged || !record.capabilitiesUntil || record.capabilitiesUntil <= Date.now()) await this.#refreshCapabilities(record, attempt, info);
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
      ...(info.model ? { model: { provider: info.model.providerID, id: info.model.id }, modelSelection: { model: modelValue(info.model),
        ...(info.model.variant === undefined ? {} : { thinking: info.model.variant }) },
        ...(info.model.variant === undefined ? {} : { thinkingLevel: info.model.variant }) } : {}) };
  }

  async #dispatch(record: RecordState, attempt: Attempt, commandId: string, command: RuntimeCommand): Promise<void> {
    const runtimeId = runtimeIdFor(record.nativeId);
    const result = (ok: boolean, status: RuntimeCommandStatus, error?: string) => this.options.onEvent(runtimeId,
      { type: "command.result", commandId, ok, status, ...(error === undefined ? {} : { error }) });
    const { client } = attempt;
    const sessionID = record.nativeId;
    try {
      this.#check(record, attempt);
      let status: RuntimeCommandStatus = "success";
      switch (command.type) {
        case "user_message":
          await this.#enqueue(record, attempt, async () => {
            if (record.pendingAgent !== undefined || record.pendingModel !== undefined) {
              const info = await client.session.get({ sessionID }, this.#request(attempt));
              this.#confirmSelection(record, info);
              if (record.pendingAgent !== undefined || record.pendingModel !== undefined) throw new OpenCodeCommandError("configuration_confirmation_required");
            }
            const files = (command.attachments ?? []).map(path => {
              if (!isAbsolute(path)) throw new OpenCodeCommandError("invalid_attachment_path");
              return { uri: pathToFileURL(path).href, name: basename(path) };
            });
            const inbox = await client.session.prompt({ sessionID, text: command.text, delivery: command.delivery === "steer" ? "steer" : "queue",
              ...(command.messageId === undefined ? {} : { metadata: { [clientMessageKey]: command.messageId } }),
              ...(files.length ? { files } : {}) }, this.#request(attempt));
            this.#check(record, attempt);
            if (inbox.sessionID !== sessionID || !inbox.id || (command.messageId !== undefined && clientIdOf(inbox) !== command.messageId))
              throw new OpenCodeCommandError("opencode_result_unconfirmed", "unconfirmed");
            if (!record.inbox.has(inbox.id)) {
              const terminal = record.inboxTerminal.get(inbox.id)?.state ?? (record.source.entry(wireId(inbox.id)) ? "delivered" : undefined);
              if (terminal) this.#finishInbox(record, inbox.id, terminal, inbox);
              else { record.inbox.set(inbox.id, inbox); this.#emitInbox(record, inbox, "accepted"); }
            }
          });
          break;
        case "user_message.cancel":
          await this.#cancelQueued(record, attempt, command.messageId);
          status = "cancelled";
          break;
        case "stop": {
          const { interrupted } = await client.session.interrupt({ sessionID }, this.#request(attempt));
          if (!interrupted) throw new OpenCodeCommandError("turn_not_running", "not_cancelable");
          break;
        }
        case "interaction.respond":
          status = await this.#respond(record, attempt, command) ? "cancelled" : "success";
          break;
        case "slash.execute":
          await this.#enqueue(record, attempt, () => this.#select(record, attempt, command.name, command.args));
          break;
        default: throw new OpenCodeCommandError("unsupported_command");
      }
      this.#check(record, attempt);
      result(true, status);
    } catch (error) {
      const failure = commandFailure(error);
      result(false, failure.status, failure.error);
    } finally {
      if (this.#attempt === attempt && !attempt.controller.signal.aborted && this.#records.get(sessionID) === record) {
        record.full = true;
        this.#schedule(record, attempt);
      }
    }
  }

  async #readInbox(sessionID: string, attempt: Attempt): Promise<Map<string, InboxUser>> {
    const inbox = await attempt.client.session.inbox.list({ sessionID }, this.#request(attempt));
    return new Map(inbox.filter((item): item is InboxUser => item.type === "user" && item.sessionID === sessionID).map(item => [item.id, item]));
  }

  #emitInbox(record: RecordState, item: InboxUser, state: Extract<RuntimeEvent, { type: "message.queued" }>["state"]): void {
    if (!item.payload.text) return;
    this.options.onEvent(runtimeIdFor(record.nativeId), { type: "message.queued", queueId: queueIdOf(item), text: item.payload.text,
      delivery: item.delivery === "steer" ? "steer" : "followUp", state });
  }

  #publishInbox(record: RecordState, inbox: Map<string, InboxUser>, delivered: ReadonlySet<string>): void {
    for (const [key, item] of record.inbox) if (!inbox.has(key) || delivered.has(key)) {
      if (delivered.has(key)) this.#finishInbox(record, key, "delivered");
      else this.#emitInbox(record, item, "unconfirmed");
    }
    for (const [key, item] of inbox) {
      if (record.inboxTerminal.has(key) || delivered.has(key)) { inbox.delete(key); continue; }
      if (!record.inboxKnown || !isDeepStrictEqual(record.inbox.get(key), item)) this.#emitInbox(record, item, "accepted");
    }
    record.inbox = inbox;
    record.inboxKnown = true;
  }

  #finishInbox(record: RecordState, inboxId: string, state: "delivered" | "cancelled", item = record.inbox.get(inboxId)): void {
    const prior = record.inboxTerminal.get(inboxId);
    if (item && (prior?.state !== state || prior.clientId === undefined)) this.#emitInbox(record, item, state);
    record.inbox.delete(inboxId);
    record.inboxTerminal.set(inboxId, { state, clientId: item ? clientIdOf(item) : prior?.clientId });
    if (record.inboxTerminal.size > 128) record.inboxTerminal.delete(record.inboxTerminal.keys().next().value!);
  }

  async #delivered(record: RecordState, attempt: Attempt, inboxId: string): Promise<boolean> {
    const message = await attempt.client.session.message.get({ sessionID: record.nativeId, messageID: inboxId }, this.#request(attempt))
      .catch((error: unknown) => { if (isMessageNotFoundError(error)) return undefined; throw error; });
    this.#check(record, attempt);
    if (message && (message.id !== inboxId || message.type !== "user")) throw new OpenCodeCommandError("opencode_result_unconfirmed", "unconfirmed");
    return message !== undefined;
  }

  async #cancelQueued(record: RecordState, attempt: Attempt, messageId: string): Promise<void> {
    const deliveredError = () => new OpenCodeCommandError("message_already_delivered", "already_delivered");
    const sessionID = record.nativeId;
    const inbox = await this.#readInbox(sessionID, attempt);
    this.#check(record, attempt);
    const matches = (item: InboxUser) => queueIdOf(item) === messageId || wireId(item.id) === messageId;
    const item = [...inbox.values()].find(matches);
    if (!item) {
      const alreadyDelivered = [...record.inboxTerminal.entries()].some(([id, fact]) => fact.state === "delivered"
        && (fact.clientId === messageId || wireId(id) === messageId)) || record.entries.some(entry =>
          entry.entryId === messageId || (entry.data.message as ChatMessage | undefined)?.clientMessageId === messageId);
      const prior = [...record.inbox.values()].find(matches);
      if (alreadyDelivered || prior && await this.#delivered(record, attempt, prior.id)) throw deliveredError();
      throw new OpenCodeCommandError("message_not_queued", "not_cancelable");
    }
    await attempt.client.session.inbox.cancel({ sessionID, inboxID: item.id }, this.#request(attempt));
    this.#check(record, attempt);
    // 2.3.2 returns 204 for an inbox conflict too; a concurrent delivery is not a successful cancellation.
    const terminal = record.inboxTerminal.get(item.id)?.state;
    if (terminal === "cancelled") return;
    if (terminal === "delivered" || await this.#delivered(record, attempt, item.id)) {
      this.#finishInbox(record, item.id, "delivered", item);
      throw deliveredError();
    }
    const remaining = await this.#readInbox(sessionID, attempt);
    this.#check(record, attempt);
    if (record.inboxTerminal.get(item.id)?.state === "delivered") throw deliveredError();
    if (remaining.has(item.id)) throw new OpenCodeCommandError("opencode_result_unconfirmed", "unconfirmed");
    this.#finishInbox(record, item.id, "cancelled", item);
  }

  async #respond(record: RecordState, attempt: Attempt, command: Extract<RuntimeCommand, { type: "interaction.respond" }>): Promise<boolean> {
    const current = record.interactions.get(command.requestId);
    if (!current || current.request.extensionId !== command.extensionId) throw new OpenCodeCommandError("interaction_not_found");
    if (record.responding.has(command.requestId)) throw new OpenCodeCommandError("interaction_busy");
    const responding = record.responding;
    responding.add(command.requestId);
    const sessionID = record.nativeId;
    const { client } = attempt;
    const { response } = command;
    try {
      let cancelled = false;
      if (command.extensionId === "opencode.permission") {
        if (response.kind !== "confirm" && response.kind !== "cancel") throw new OpenCodeCommandError("invalid_interaction_response");
        await client.permission.reply({ sessionID, requestID: command.requestId,
          decision: response.kind === "confirm" && response.value ? "once" : "reject" }, this.#request(attempt));
      } else if (current.form) {
        const form = await client.session.form.get({ sessionID, formID: current.form.id }, this.#request(attempt));
        this.#check(record, attempt);
        if (form.sessionID !== sessionID || form.id !== current.form.id || !formRequest(runtimeIdFor(sessionID), form, Date.now()))
          throw new OpenCodeCommandError("interaction_not_found");
        if (response.kind === "cancel") {
          await client.session.form.cancel({ sessionID, formID: form.id }, this.#request(attempt));
          cancelled = true;
        } else if (response.kind === "questionnaire") {
          await client.session.form.reply({ sessionID, formID: form.id, answer: formAnswers(form, response) }, this.#request(attempt));
        } else throw new OpenCodeCommandError("invalid_interaction_response");
      } else throw new OpenCodeCommandError("interaction_not_found");
      this.#check(record, attempt);
      this.#finishInteraction(record, command.requestId, cancelled, "remote");
      return cancelled;
    } finally { responding.delete(command.requestId); }
  }

  #finishInteraction(record: RecordState, requestId: string, cancelled: boolean, source: "local" | "remote"): void {
    if (!record.interactions.delete(requestId)) return;
    this.options.onEvent(runtimeIdFor(record.nativeId), cancelled ? { type: "interaction.cancelled", requestId, reason: "cancelled" }
      : { type: "interaction.resolved", requestId, source });
  }

  async #select(record: RecordState, attempt: Attempt, name: string, value: string): Promise<void> {
    const sessionID = record.nativeId;
    const { client } = attempt;
    const info = await client.session.get({ sessionID }, this.#request(attempt));
    this.#check(record, attempt);
    const cwd = info.location.directory;
    if (name === "agent") {
      const agents = await readAgents(client, cwd, this.#request(attempt));
      this.#check(record, attempt);
      if (!agents.some(item => item.value === value)) throw new OpenCodeCommandError("configuration_stale");
      record.pendingAgent = value;
      try { await client.session.switchAgent({ sessionID, agent: value }, this.#request(attempt)); }
      catch (error) { if (commandFailure(error).status === "failure") delete record.pendingAgent; throw error; }
      const actual = await client.session.get({ sessionID }, this.#request(attempt));
      this.#check(record, attempt);
      if (actual.agent !== value) throw new OpenCodeCommandError("configuration_unconfirmed", "unconfirmed");
      this.#confirmSelection(record, actual);
    } else {
      const models = await readModels(client, cwd, this.#request(attempt));
      this.#check(record, attempt);
      const selected = name === "model" ? selectionModel(models, { model: value }) : info.model &&
        selectionModel(models, { model: modelValue(info.model), thinking: value });
      if (!selected) throw new OpenCodeCommandError("configuration_stale");
      await this.#switchModel(record, attempt, selected);
    }
    await this.#refresh(record, attempt);
  }

  async #switchModel(record: RecordState, attempt: Attempt, model: ModelRef): Promise<void> {
    this.#check(record, attempt);
    const sessionID = record.nativeId;
    record.pendingModel = model;
    try { await attempt.client.session.switchModel({ sessionID, model }, this.#request(attempt)); }
    catch (error) { if (commandFailure(error).status === "failure") delete record.pendingModel; throw error; }
    const actual = await attempt.client.session.get({ sessionID }, this.#request(attempt));
    this.#check(record, attempt);
    if (!sameModel(actual.model, model)) throw new OpenCodeCommandError("configuration_unconfirmed", "unconfirmed");
    this.#confirmSelection(record, actual);
  }

  #confirmSelection(record: RecordState, info: NativeSession): void {
    if (record.pendingAgent === info.agent) delete record.pendingAgent;
    if (record.pendingModel && sameModel(info.model, record.pendingModel)) delete record.pendingModel;
  }

  async #refreshCapabilities(record: RecordState, attempt: Attempt, info: NativeSession): Promise<void> {
    const options = this.#request(attempt);
    const cwd = info.location.directory;
    const [models, agents] = await Promise.all([
      readModels(attempt.client, cwd, options).catch(() => undefined),
      readAgents(attempt.client, cwd, options).catch(() => undefined),
    ]);
    this.#check(record, attempt);
    if (record.info !== info) return;
    record.capabilitiesUntil = Date.now() + 30_000;
    const capabilities = selectionCommands(info, models, agents);
    if (!isDeepStrictEqual(record.capabilities, capabilities)) {
      record.capabilities = capabilities;
      this.options.onEvent(runtimeIdFor(record.nativeId), { type: "runtime.capabilities", capabilities });
    }
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
