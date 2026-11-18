/** Orbis AgentBackend projection over the authenticated Hermes TUI Gateway authority RPC. */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  RecoverableSessionSource,
  SessionSyncPreparer,
  projectToolEntry,
  type ToolAgentKey,
  type AgentSessionSummary,
  type ChatMessage,
  type RemoteContent,
  type RemoteSessionEntry,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeMetadata,
  type SessionSyncRequest,
} from "@orbis/protocol";
import { HermesGatewayRpcError, type HermesGatewayEvent, type HermesGatewayRpcClient } from "./hermes-gateway-rpc.js";
import type { HermesGatewayEndpoint, HermesGatewayRuntimeDescriptor } from "./hermes-gateway-bootstrap.js";
import type { AgentActivateContext, AgentActivateTarget, AgentBackend, BackendActivation, CommandDispatch } from "./agent-backend.js";
import { ActivationError } from "./spawner.js";
import { SessionArchiveError } from "./session-archive.js";
import { localHostname } from "./sessions.js";

type HermesGatewayClient = Pick<HermesGatewayRpcClient, "request" | "closed" | "readyState">;
// The wire enum/feature gate lands in HERMES-05. Until then this backend is not registered or published.
const HERMES_KIND = "hermes" as AgentBackend["kind"];
type JsonRecord = Record<string, unknown>;
type HermesTranscriptMessage = JsonRecord;
type HermesPendingInput = {
  commandId: string;
  messageId?: string;
  text: string;
  admissionId?: string;
  submitSettled: boolean;
  cancelRequested: boolean;
  cancelCommandId?: string;
};
type HermesLiveTurn = {
  turnId: string;
  messageId: string;
  startedAt: number;
  input?: HermesPendingInput;
  text: string;
  reasoning: string;
};
type HermesSession = {
  readonly runtimeId: string;
  readonly sessionId: string;
  gatewaySessionId: string;
  readonly source: RecoverableSessionSource;
  readonly preparer: SessionSyncPreparer;
  readonly inputsByCommand: Map<string, HermesPendingInput>;
  readonly inputsByMessage: Map<string, HermesPendingInput>;
  readonly inputsByAdmission: Map<string, HermesPendingInput>;
  readonly entries: RemoteSessionEntry[];
  subscriptionId: string;
  cwd: string;
  title: string;
  provider?: string;
  model?: string;
  running: boolean;
  executionGeneration: number;
  lastSequence: number;
  replayEpoch: string;
  turn?: HermesLiveTurn;
  eventChain: Promise<void>;
};

export type HermesGatewayBackendOptions = {
  client: HermesGatewayClient;
  endpoint: HermesGatewayEndpoint;
  runtime: HermesGatewayRuntimeDescriptor;
  hostname?: string;
  hostId: string;
  onEvent?: (runtimeId: string, event: RuntimeEvent) => void;
  onCommandResult?: (runtimeId: string, event: Extract<RuntimeEvent, { type: "command.result" }>) => void;
  log?: (message: string) => void;
};

const RPC_REQUEST_ID_LIMIT = 256;
const MAX_TEXT_CHARS = 100_000;
const MAX_PENDING_INPUTS = 256;
const READY_STATE_OPEN = 1;

/**
 * Hermes history/turns stay Gateway-owned. This adapter stores only an in-memory projection and
 * sync cursor; it never opens Hermes' state database or retries an uncertain prompt admission.
 */
export class HermesAgentBackend implements AgentBackend {
  readonly kind: AgentBackend["kind"] = HERMES_KIND;
  /** Hermes' canonical session list currently does not enumerate archived sessions. */
  readonly archivedCatalogSupported = false;
  readonly #options: HermesGatewayBackendOptions;
  readonly #byRuntime = new Map<string, HermesSession>();
  readonly #byGatewayId = new Map<string, HermesSession>();
  readonly #bySessionId = new Map<string, HermesSession>();
  #sink: (event: RuntimeEvent, runtimeId: string) => void = () => undefined;
  #catalogComplete = true;

  constructor(options: HermesGatewayBackendOptions) { this.#options = options; }

  setEventSink(sink: (event: RuntimeEvent, runtimeId: string) => void): void { this.#sink = sink; }

  isReady(): boolean {
    return !this.#options.client.closed && this.#options.client.readyState === READY_STATE_OPEN;
  }

  ownsRuntime(runtimeId: string): boolean { return this.#byRuntime.has(runtimeId); }

  get catalogComplete(): boolean { return this.#catalogComplete; }

  directoryEntries(): RuntimeMetadata[] {
    return [...this.#byRuntime.values()].map(session => this.#metadata(session));
  }

  async currentProvider(): Promise<string | undefined> {
    return [...this.#byRuntime.values()].find(session => session.provider)?.provider;
  }

  /**
   * The canonical runtime list separates live and resumable rows. Its v1 row intentionally has no
   * workspace field; cwd remains unknown until Gateway returns an attached session snapshot.
   */
  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    if (archived) return [];
    this.#assertReady();
    const [live, stored] = await Promise.all([
      this.#request<{ sessions?: unknown }>("session.list", { scope: "live", limit: 200 }),
      this.#request<{ sessions?: unknown }>("session.list", { scope: "stored", limit: 200 }),
    ]);
    // This Gateway contract has a hard limit and no cursor. A full page cannot prove there are no later rows.
    this.#catalogComplete = Array.isArray(live.sessions) && Array.isArray(stored.sessions) &&
      live.sessions.length < 200 && stored.sessions.length < 200;
    const rows = new Map<string, AgentSessionSummary>();
    for (const [scope, result] of [["stored", stored], ["live", live]] as const) {
      if (!Array.isArray(result.sessions)) throw new Error("Hermes Gateway returned an invalid session list");
      for (const value of result.sessions) {
        const row = asRecord(value);
        const sessionId = firstString(scope === "live" ? row.session_id : row.resolved_id, row.session_id, row.id);
        if (!sessionId) continue;
        const startedAt = epochMillis(row.started_at);
        const title = boundedString(row.title, 256);
        const preview = boundedString(row.preview, 4_000);
        rows.set(sessionId, {
          sessionId,
          agentKind: HERMES_KIND,
          hostname: this.#options.hostname ?? localHostname(),
          cwd: "",
          ...(title ? { name: title } : {}),
          ...(preview ? { firstMessage: preview } : {}),
          createdAt: startedAt,
          modifiedAt: startedAt,
          messageCount: boundedCount(row.message_count),
          archived: false,
          ...(typeof row.model === "string" && row.model.trim() ? { modelProvider: providerFromModel(row.model) } : {}),
        });
      }
    }
    return [...rows.values()].sort((a, b) => b.modifiedAt - a.modifiedAt || a.sessionId.localeCompare(b.sessionId));
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    void sessionId;
    void archived;
    throw new SessionArchiveError("unsupported", "此 Hermes Gateway 版本未开放可核验的归档操作");
  }

  async activate(target: AgentActivateTarget, context?: AgentActivateContext): Promise<BackendActivation> {
    this.#assertReady();
    if (target.type === "resume") {
      const existing = this.#bySessionId.get(target.sessionId);
      if (existing) return { sessionId: existing.sessionId, spawnMode: "headless" };
      let raw: unknown;
      try {
        raw = await this.#request<unknown>("session.resume", {
          session_id: target.sessionId,
          source: "tui",
          display_projection: true,
        });
      } catch (error) {
        if (error instanceof HermesGatewayRpcError &&
            ["not_found", "session_not_found"].includes(String(error.data?.reason ?? error.message)))
          throw new ActivationError("session_not_found", "Hermes Gateway 中找不到这个会话");
        throw error;
      }
      const session = this.#attachSnapshot(raw, target.sessionId);
      return { sessionId: session.sessionId, spawnMode: "headless" };
    }

    if (!isAbsolute(target.cwd) || !await stat(target.cwd).then(info => info.isDirectory(), () => false))
      throw new ActivationError("cwd_missing", "请选择存在的绝对目录");
    if (!this.#options.runtime.session_create.sources.includes("tui") ||
        !this.#options.runtime.session_create.parameters.includes("cwd")) {
      throw new ActivationError("agent_unsupported", "当前 Hermes Gateway 不支持 Orbis 所需的 TUI session 创建参数");
    }
    const params: JsonRecord = { source: "tui", cwd: target.cwd };
    // request_id is an idempotency key only when the negotiated contract advertises it.
    if (this.#options.runtime.session_create.parameters.includes("request_id"))
      params.request_id = safeRequestId(context?.launchId) ?? randomUUID();
    const raw = await this.#request<unknown>("session.create", params);
    const session = this.#attachSnapshot(raw);
    await context?.onCreated?.({ sessionId: session.sessionId, spawnMode: "headless" });
    return { sessionId: session.sessionId, spawnMode: "headless" };
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    const session = this.#byRuntime.get(runtimeId);
    if (!session || !this.isReady()) return "offline";
    if (command.type === "user_message" && !this.#hasCapability("durable-admission-v1")) return "unsupported";
    if (command.type === "user_message" && (command.attachments?.length ?? 0) > 0) return "unsupported";
    if (!["user_message", "user_message.cancel", "stop", "session.sync"].includes(command.type)) return "unsupported";
    void this.#dispatch(session, commandId, command).catch(error => {
      this.#reportCommand(session, commandId, false, isUncertainRpcFailure(error) ? "unconfirmed" : "failure", errorText(error));
    });
    return "handled";
  }

  async readSessionEntry(runtimeId: string, sessionId: string, entryId: string): Promise<RemoteSessionEntry | undefined> {
    const session = this.#byRuntime.get(runtimeId);
    if (!session || session.sessionId !== sessionId) return undefined;
    const entry = session.entries.find(item => item.entryId === entryId);
    return entry ? structuredClone(entry) : undefined;
  }

  /** Called from connectHermesGateway's onEvent hook; replay and live notifications share one dedupe path. */
  handleGatewayEvent(event: HermesGatewayEvent): Promise<void> {
    const gatewaySessionId = typeof event.session_id === "string" ? event.session_id : undefined;
    const session = gatewaySessionId ? this.#byGatewayId.get(gatewaySessionId) : undefined;
    if (!session) return Promise.resolve();
    const work = session.eventChain.then(() => this.#acceptEvent(session, event));
    session.eventChain = work.catch(error => {
      this.#options.log?.(`Hermes Gateway event failed (${event.type}): ${errorText(error)}`);
      this.#emit({ type: "runtime.error", message: "Hermes 会话事件暂时无法同步", recoverable: true }, session.runtimeId);
    });
    return session.eventChain;
  }

  async #dispatch(session: HermesSession, commandId: string, command: RuntimeCommand): Promise<void> {
    if (command.type === "session.sync") {
      await this.#syncHistory(session, commandId, command);
      return;
    }
    if (command.type === "user_message") {
      await this.#submit(session, commandId, command);
      return;
    }
    if (command.type === "user_message.cancel") {
      await this.#cancelInput(session, commandId, command.messageId);
      return;
    }
    if (command.type === "stop") {
      await this.#stop(session, commandId);
    }
  }

  async #submit(session: HermesSession, commandId: string, command: Extract<RuntimeCommand, { type: "user_message" }>): Promise<void> {
    if (commandId.length > RPC_REQUEST_ID_LIMIT || command.text.length > MAX_TEXT_CHARS)
      throw new Error("Hermes prompt exceeds the supported limit");
    const input: HermesPendingInput = {
      commandId,
      ...(command.messageId ? { messageId: command.messageId } : {}),
      text: command.text,
      submitSettled: false,
      cancelRequested: false,
    };
    this.#rememberInput(session, input);
    try {
      // A timeout/connection loss is not retried: even a durable submission_id cannot prove whether
      // the caller has enough authority/result state to safely replay this particular Orbis command.
      const receipt = asRecord(await this.#request<unknown>("prompt.submit", {
        session_id: session.gatewaySessionId,
        submission_id: commandId,
        text: command.text,
      }));
      input.submitSettled = true;
      if (typeof receipt.admission_id === "string") {
        input.admissionId = receipt.admission_id;
        session.inputsByAdmission.set(receipt.admission_id, input);
        if (session.turn?.turnId === receipt.admission_id) session.turn.input = input;
      }
      const status = typeof receipt.status === "string" ? receipt.status : "unknown";
      if (receipt.voice_stopped === true) {
        this.#reportCommand(session, commandId, true, "success");
        this.#settleUnadmittedCancel(session, input, false);
        this.#forgetInput(session, input);
        return;
      }
      if (!["queued", "started", "unknown", "terminal"].includes(status) || !input.admissionId) {
        this.#reportCommand(session, commandId, false, "unconfirmed", "Hermes did not return a verifiable prompt receipt");
        this.#settleUnadmittedCancel(session, input, true);
        return;
      }
      if (status === "unknown") {
        this.#reportCommand(session, commandId, false, "unconfirmed", "Hermes prompt outcome is unknown; it was not resent");
        this.#settleUnadmittedCancel(session, input, true);
        return;
      }
      this.#reportCommand(session, commandId, true, status === "terminal" ? "already_delivered" : "success");
      if (input.cancelRequested) await this.#cancelAdmission(session, input);
    } catch (error) {
      input.submitSettled = true;
      if (isUncertainRpcFailure(error)) {
        this.#reportCommand(session, commandId, false, "unconfirmed", "Hermes prompt outcome is unknown; it was not resent");
        this.#settleUnadmittedCancel(session, input, true);
      } else {
        this.#reportCommand(session, commandId, false, "failure", errorText(error));
        this.#settleUnadmittedCancel(session, input, false);
      }
    }
  }

  async #cancelInput(session: HermesSession, cancelCommandId: string, messageId: string): Promise<void> {
    const input = session.inputsByMessage.get(messageId);
    if (!input) {
      this.#reportCommand(session, cancelCommandId, false, "not_cancelable", "Hermes prompt is no longer cancellable");
      return;
    }
    if (!input.admissionId) {
      if (!input.submitSettled) {
        input.cancelRequested = true;
        input.cancelCommandId = cancelCommandId;
        return;
      }
      this.#reportCommand(session, cancelCommandId, false, "unconfirmed", "Hermes did not confirm the prompt identity");
      return;
    }
    input.cancelCommandId = cancelCommandId;
    await this.#cancelAdmission(session, input);
  }

  #settleUnadmittedCancel(session: HermesSession, input: HermesPendingInput, uncertain: boolean): void {
    const commandId = input.cancelCommandId;
    if (!commandId) return;
    delete input.cancelCommandId;
    this.#reportCommand(session, commandId, !uncertain, uncertain ? "unconfirmed" : "cancelled",
      uncertain ? "Hermes prompt outcome is unknown; cancellation was not replayed" : undefined);
  }

  async #cancelAdmission(session: HermesSession, input: HermesPendingInput): Promise<void> {
    if (!input.admissionId || !input.cancelCommandId) return;
    const commandId = input.cancelCommandId;
    delete input.cancelCommandId;
    try {
      const result = asRecord(await this.#request<unknown>("prompt.cancel", {
        session_id: session.gatewaySessionId,
        admission_id: input.admissionId,
      }));
      if (result.status === "terminal" && result.outcome === "cancelled")
        this.#reportCommand(session, commandId, true, "cancelled");
      else if (result.status === "queued" || result.status === "started")
        this.#reportCommand(session, commandId, false, "not_cancelable", "Hermes prompt has already started");
      else if (result.status === "terminal")
        this.#reportCommand(session, commandId, false, "not_cancelable", "Hermes prompt has already finished");
      else this.#reportCommand(session, commandId, false, "unconfirmed", "Hermes did not confirm prompt cancellation");
      if (result.status === "terminal") this.#forgetInput(session, input);
    } catch (error) {
      this.#reportCommand(session, commandId, false, isUncertainRpcFailure(error) ? "unconfirmed" : "failure", errorText(error));
    }
  }

  async #stop(session: HermesSession, commandId: string): Promise<void> {
    if (!session.running || session.executionGeneration <= 0) {
      this.#reportCommand(session, commandId, false, "not_cancelable", "Hermes has no confirmed running turn");
      return;
    }
    try {
      const result = asRecord(await this.#request<unknown>("session.interrupt", {
        session_id: session.gatewaySessionId,
        execution_generation: session.executionGeneration,
      }));
      if (result.execution_state === "running" || result.execution_state === "waiting")
        this.#reportCommand(session, commandId, true, "pending");
      else if (result.execution_state === "idle" || result.execution_state === "terminal")
        this.#reportCommand(session, commandId, false, "not_cancelable");
      else this.#reportCommand(session, commandId, false, "unconfirmed", "Hermes interrupt state is unknown");
    } catch (error) {
      this.#reportCommand(session, commandId, false, isUncertainRpcFailure(error) ? "unconfirmed" : "failure", errorText(error));
    }
  }

  async #syncHistory(session: HermesSession, commandId: string,
    request: Extract<RuntimeCommand, { type: "session.sync" }>): Promise<void> {
    try {
      if (request.sessionId !== session.sessionId) throw new Error("session_mismatch");
      if (!session.source.published().version.ready) await this.#refreshSnapshot(session);
      session.source.flushPending();
      const snapshot = session.preparer.select({
        entries: session.entries,
        sessionId: session.sessionId,
        leafId: session.entries.at(-1)?.entryId ?? null,
        request: request as SessionSyncRequest,
        source: session.source.published(),
      });
      this.#emit(snapshot, session.runtimeId);
    } catch (error) {
      this.#reportCommand(session, commandId, false, "failure", errorText(error));
    }
  }

  async #acceptEvent(session: HermesSession, event: HermesGatewayEvent): Promise<void> {
    const sequence = finiteInteger(event.seq);
    const epoch = firstString(event.replay_epoch, event.epoch);
    if (epoch && session.replayEpoch && epoch !== session.replayEpoch) {
      this.#markHistoryUnknown(session, "Hermes Gateway event epoch changed");
      session.replayEpoch = epoch;
      session.lastSequence = 0;
    }
    if (sequence !== undefined && sequence <= session.lastSequence) return;
    if (sequence !== undefined && sequence > session.lastSequence + 1) {
      if (this.#hasCapability("event-replay-v1")) await this.#replayEvents(session);
      if (sequence <= session.lastSequence) return;
      if (sequence > session.lastSequence + 1) {
        this.#markHistoryUnknown(session, "Hermes event replay has a gap");
        session.lastSequence = sequence - 1;
      }
    }
    this.#applyEvent(session, event);
    if (sequence !== undefined) session.lastSequence = sequence;
    if (epoch) session.replayEpoch = epoch;
  }

  async #replayEvents(session: HermesSession): Promise<void> {
    if (!this.#hasCapability("event-replay-v1")) return;
    const result = asRecord(await this.#request<unknown>("session.events.since", {
      session_id: session.gatewaySessionId,
      last_sequence: session.lastSequence,
      replay_epoch: session.replayEpoch,
    }));
    if (result.snapshot_required === true || result.truncated === true) {
      this.#markHistoryUnknown(session, "Hermes event replay window expired");
      return;
    }
    if (Array.isArray(result.events)) {
      for (const value of result.events) {
        const replay = asRecord(value);
        if (typeof replay.type !== "string") continue;
        const seq = finiteInteger(replay.seq);
        if (seq !== undefined && seq <= session.lastSequence) continue;
        this.#applyEvent(session, replay as HermesGatewayEvent);
        if (seq !== undefined) session.lastSequence = seq;
      }
    }
    const latest = finiteInteger(result.latest_seq);
    if (latest !== undefined && latest > session.lastSequence) this.#markHistoryUnknown(session, "Hermes event replay was incomplete");
    const replayEpoch = firstString(result.replay_epoch, result.epoch);
    if (replayEpoch) session.replayEpoch = replayEpoch;
  }

  #applyEvent(session: HermesSession, event: HermesGatewayEvent): void {
    const payload = asRecord(event.payload);
    const generation = finiteInteger(event.execution_generation);
    if (generation !== undefined) session.executionGeneration = generation;
    switch (event.type) {
      case "session.info":
        this.#applyInfo(session, payload);
        this.#publishMetadata(session);
        return;
      case "message.start": {
        const startedAt = Date.now();
        const turnId = turnIdentity(event);
        const messageId = `hermes-live:${digest(turnId).slice(0, 32)}`;
        session.running = true;
        session.turn = { turnId, messageId, startedAt, text: "", reasoning: "",
          ...(typeof event.admission_id === "string" && session.inputsByAdmission.has(event.admission_id)
            ? { input: session.inputsByAdmission.get(event.admission_id)! } : {}) };
        const turn: RuntimeEvent = { type: "turn.started", turnId, startedAt };
        this.#observe(session, turn);
        const message: ChatMessage = { messageId, role: "assistant", content: [{ type: "text", text: "" }], timestamp: startedAt };
        this.#observe(session, { type: "message.started", message });
        this.#publishMetadata(session);
        return;
      }
      case "message.delta":
        this.#applyDelta(session, payload, "text", event);
        return;
      case "reasoning.delta":
      case "thinking.delta":
        this.#applyDelta(session, payload, "thinking", event);
        return;
      case "message.complete":
        this.#finishTurn(session, payload, event);
        return;
      case "error": {
        const message = boundedString(payload.message, 512) || "Hermes Gateway session error";
        this.#emit({ type: "runtime.error", message, recoverable: payload.recoverable === true }, session.runtimeId);
        return;
      }
      case "session.reclaimed":
        session.running = false;
        this.#publishMetadata(session);
        this.#emit({ type: "runtime.error", message: "Hermes Gateway 已将此会话交由其他 owner 管理", recoverable: true }, session.runtimeId);
        return;
      default:
        return;
    }
  }

  #applyDelta(session: HermesSession, payload: JsonRecord, contentType: "text" | "thinking", event: HermesGatewayEvent): void {
    if (!session.turn) {
      const turnId = turnIdentity(event);
      const startedAt = Date.now();
      const messageId = `hermes-live:${digest(turnId).slice(0, 32)}`;
      session.turn = { turnId, messageId, startedAt, text: "", reasoning: "",
        ...(typeof event.admission_id === "string" && session.inputsByAdmission.has(event.admission_id)
          ? { input: session.inputsByAdmission.get(event.admission_id)! } : {}) };
      session.running = true;
      this.#observe(session, { type: "turn.started", turnId, startedAt });
      this.#observe(session, { type: "message.started", message: { messageId, role: "assistant", content: [], timestamp: startedAt } });
      this.#publishMetadata(session);
    }
    const delta = typeof payload.rendered === "string" ? payload.rendered : payload.text;
    if (typeof delta !== "string" || delta.length === 0) return;
    if (contentType === "text") session.turn.text += delta;
    else session.turn.reasoning += delta;
    this.#observe(session, { type: "message.delta", messageId: session.turn.messageId, contentType, delta });
  }

  #finishTurn(session: HermesSession, payload: JsonRecord, event: HermesGatewayEvent): void {
    let turn = session.turn;
    if (!turn) {
      const turnId = turnIdentity(event);
      const startedAt = Date.now();
      turn = { turnId, messageId: `hermes-live:${digest(turnId).slice(0, 32)}`, startedAt, text: "", reasoning: "" };
      if (typeof event.admission_id === "string") {
        const input = session.inputsByAdmission.get(event.admission_id);
        if (input) turn.input = input;
      }
      session.turn = turn;
      this.#observe(session, { type: "turn.started", turnId, startedAt });
      this.#observe(session, { type: "message.started", message: { messageId: turn.messageId, role: "assistant", content: [], timestamp: startedAt } });
      this.#publishMetadata(session);
    }
    const finalText = typeof payload.text === "string" ? payload.text.slice(0, MAX_TEXT_CHARS) : turn.text;
    const content: RemoteContent[] = finalText ? [{ type: "text", text: finalText }] : [];
    if (turn.reasoning) content.unshift({ type: "thinking", text: turn.reasoning.slice(0, MAX_TEXT_CHARS) });
    const message: ChatMessage = { messageId: turn.messageId, role: "assistant", content, timestamp: Date.now(),
      ...(payload.status === "error" ? { isError: true } : {}) };
    this.#observe(session, { type: "message.finished", message });
    const status = payload.status;
    const outcome = status === "error" ? "failed" : status === "interrupted" ? "cancelled" : status === "complete" ? "completed" : "unknown";
    const durationMs = Math.max(0, Date.now() - turn.startedAt);
    const persisted = asRecord(payload.persisted_turn);
    const persistedMessages = this.#commitPersistedTurn(session, turn, message, persisted);
    const projectionComplete = persistedTurnProjectionComplete(persisted, turn.input);
    if (projectionComplete) session.source.setAvailability(true, true);
    else session.source.setAvailability(true, false);
    if (!projectionComplete && turn.input)
      this.#forgetInput(session, turn.input);
    this.#observe(session, { type: "turn.finished", turnId: turn.turnId, startedAt: turn.startedAt,
      durationMs, outcome, messageId: turn.messageId, ...(persistedMessages.length ? { persistedMessages } : {}) });
    session.running = false;
    delete session.turn;
    this.#publishMetadata(session);
  }

  #commitPersistedTurn(session: HermesSession, turn: HermesLiveTurn, assistant: ChatMessage,
    persisted: JsonRecord): Array<{ messageId: string; entryId: string }> {
    const assistantRowId = finiteInteger(persisted.final_assistant_row_id);
    if (assistantRowId === undefined) return [];
    const submissionId = typeof persisted.submission_id === "string" ? persisted.submission_id : undefined;
    const input = (submissionId ? session.inputsByCommand.get(submissionId) : undefined) ?? turn.input;
    const rows: RemoteSessionEntry[] = [];
    let parentId = session.entries.at(-1)?.entryId ?? null;
    const userRowId = finiteInteger(persisted.user_row_id);
    if (userRowId !== undefined && input) {
      const user = chatFromInput(input, userRowId);
      const entry = toRemoteEntry(session.sessionId, userRowId, user, parentId);
      if (!session.entries.some(item => item.entryId === entry.entryId)) rows.push(entry);
      parentId = entry.entryId;
    }
    const assistantEntry = toRemoteEntry(session.sessionId, assistantRowId, assistant, parentId);
    if (!session.entries.some(item => item.entryId === assistantEntry.entryId)) rows.push(assistantEntry);
    if (rows.length) {
      session.entries.push(...rows);
      session.preparer.invalidate();
    }
    const mappings = [{ messageId: assistant.messageId, entryId: assistantEntry.entryId }];
    const userMessageId = input?.messageId;
    if (userMessageId && userRowId !== undefined) {
      mappings.push({ messageId: userMessageId, entryId: toRemoteEntry(session.sessionId, userRowId, chatFromInput(input, userRowId), null).entryId });
    }
    session.source.reconcile(session.entries, session.entries.at(-1)?.entryId ?? null, mappings);
    const assistantMapping = { messageId: assistant.messageId, entryId: assistantEntry.entryId };
    if (input) this.#forgetInput(session, input);
    return [assistantMapping];
  }

  #forgetInput(session: HermesSession, input: HermesPendingInput): void {
    session.inputsByCommand.delete(input.commandId);
    if (input.messageId) session.inputsByMessage.delete(input.messageId);
    if (input.admissionId) session.inputsByAdmission.delete(input.admissionId);
  }

  #rememberInput(session: HermesSession, input: HermesPendingInput): void {
    session.inputsByCommand.set(input.commandId, input);
    if (input.messageId) session.inputsByMessage.set(input.messageId, input);
    while (session.inputsByCommand.size > MAX_PENDING_INPUTS) {
      const oldest = session.inputsByCommand.values().next().value as HermesPendingInput | undefined;
      if (!oldest) break;
      this.#forgetInput(session, oldest);
    }
  }

  #attachSnapshot(raw: unknown, fallbackSessionId?: string): HermesSession {
    const snapshot = asRecord(raw);
    const gatewaySessionId = firstString(snapshot.session_id, fallbackSessionId);
    const sessionId = firstString(snapshot.stored_session_id, fallbackSessionId, snapshot.session_id);
    const info = asRecord(snapshot.info);
    if (!gatewaySessionId || !sessionId) throw new Error("Hermes Gateway returned an invalid session identity");
    const cwd = boundedString(info.cwd, 4096);
    if (!cwd) throw new Error("Hermes Gateway did not return the session workspace");
    const runtimeId = runtimeIdFor(this.#options.endpoint.profile_id, sessionId);
    if (!Array.isArray(snapshot.messages)) throw new Error("Hermes Gateway returned no transcript snapshot");
    const messages = snapshot.messages.map(asRecord) as HermesTranscriptMessage[];
    const entries = transcriptEntries(sessionId, messages, this.#options.hostId);
    const session = {
      runtimeId,
      sessionId,
      gatewaySessionId,
      source: new RecoverableSessionSource(runtimeId,
        (event: Extract<RuntimeEvent, { type: "session.patch" }>) => this.#emit({ ...event, sessionId }, runtimeId),
        { coalesceMs: 24 }),
      preparer: new SessionSyncPreparer(),
      inputsByCommand: new Map<string, HermesPendingInput>(),
      inputsByMessage: new Map<string, HermesPendingInput>(),
      inputsByAdmission: new Map<string, HermesPendingInput>(),
      entries,
      subscriptionId: firstString(snapshot.subscription_id) ?? "",
      cwd,
      title: boundedString(info.title, 256),
      ...(boundedString(info.provider, 128) ? { provider: boundedString(info.provider, 128) } : {}),
      ...(boundedString(info.model, 256) ? { model: boundedString(info.model, 256) } : {}),
      running: snapshot.running === true,
      executionGeneration: finiteInteger(snapshot.execution_generation) ?? 0,
      lastSequence: finiteInteger(snapshot.last_sequence) ?? 0,
      replayEpoch: firstString(snapshot.replay_epoch) ?? "",
      eventChain: Promise.resolve(),
    } satisfies HermesSession;
    session.source.transaction(() => {
      session.source.replaceLive({ complete: !snapshot.running, turn: null, messages: [], tools: [] });
      session.source.reconcile(session.entries, session.entries.at(-1)?.entryId ?? null);
      session.source.setAvailability(true, !snapshot.running);
    });
    this.#byRuntime.set(runtimeId, session);
    this.#byGatewayId.set(gatewaySessionId, session);
    this.#bySessionId.set(sessionId, session);
    if (gatewaySessionId !== sessionId) this.#bySessionId.set(gatewaySessionId, session);
    this.#publishMetadata(session);
    // Catch notifications that arrived after the snapshot's native sequence but before map registration.
    if (this.#hasCapability("event-replay-v1")) {
      session.eventChain = session.eventChain.then(() => this.#replayEvents(session)).catch(error => {
        this.#options.log?.(`Hermes initial event catch-up failed: ${errorText(error)}`);
        this.#markHistoryUnknown(session, "Hermes session events could not be caught up");
      });
    }
    return session;
  }

  async #refreshSnapshot(session: HermesSession): Promise<void> {
    const oldSubscription = session.subscriptionId;
    const oldGatewaySessionId = session.gatewaySessionId;
    const snapshot = asRecord(await this.#request<unknown>("session.resume", {
      session_id: session.sessionId,
      source: "tui",
      display_projection: true,
    }));
    const gatewaySessionId = firstString(snapshot.session_id);
    const storedSessionId = firstString(snapshot.stored_session_id, session.sessionId);
    const info = asRecord(snapshot.info);
    const cwd = boundedString(info.cwd, 4096);
    if (!gatewaySessionId || storedSessionId !== session.sessionId || !cwd || !Array.isArray(snapshot.messages))
      throw new Error("Hermes Gateway returned an incomplete recovery snapshot");
    session.entries.splice(0, session.entries.length, ...transcriptEntries(session.sessionId, snapshot.messages.map(asRecord), this.#options.hostId));
    session.preparer.invalidate();
    session.source.transaction(() => {
      session.source.replaceLive({ complete: snapshot.running !== true, turn: null, messages: [], tools: [] });
      session.source.reconcile(session.entries, session.entries.at(-1)?.entryId ?? null);
      session.source.setAvailability(true, snapshot.running !== true);
    });
    this.#applyInfo(session, info);
    session.gatewaySessionId = gatewaySessionId;
    session.cwd = cwd;
    session.running = snapshot.running === true;
    session.executionGeneration = finiteInteger(snapshot.execution_generation) ?? session.executionGeneration;
    session.lastSequence = finiteInteger(snapshot.last_sequence) ?? 0;
    session.replayEpoch = firstString(snapshot.replay_epoch) ?? "";
    session.subscriptionId = firstString(snapshot.subscription_id) ?? session.subscriptionId;
    if (oldGatewaySessionId !== gatewaySessionId) this.#byGatewayId.delete(oldGatewaySessionId);
    this.#byGatewayId.set(gatewaySessionId, session);
    if (oldSubscription && session.subscriptionId && oldSubscription !== session.subscriptionId) {
      void this.#request("session.detach", { session_id: oldGatewaySessionId, subscription_id: oldSubscription }).catch(() => undefined);
    }
    this.#publishMetadata(session);
  }

  #applyInfo(session: HermesSession, info: JsonRecord): void {
    const cwd = boundedString(info.cwd, 4096);
    if (cwd) session.cwd = cwd;
    const title = boundedString(info.title, 256);
    if (title) session.title = title;
    const provider = boundedString(info.provider, 128);
    const model = boundedString(info.model, 256);
    if (provider) session.provider = provider;
    if (model) session.model = model;
  }

  #metadata(session: HermesSession): RuntimeMetadata {
    return {
      runtimeId: session.runtimeId,
      name: "Hermes Agent",
      cwd: session.cwd,
      status: session.running ? "running" : "idle",
      sessionId: session.sessionId,
      sessionGraphSync: true,
      sessionLeafId: session.entries.at(-1)?.entryId ?? null,
      ...(session.title ? { sessionName: session.title } : {}),
      ...(session.provider && session.model ? { model: { provider: session.provider, id: session.model } } : {}),
    };
  }

  #publishMetadata(session: HermesSession): void {
    this.#emit({ type: "runtime.status", status: session.running ? "running" : "idle" }, session.runtimeId);
    this.#emit({ type: "runtime.metadata", metadata: this.#metadata(session) }, session.runtimeId);
  }

  #observe(session: HermesSession, event: RuntimeEvent): void {
    session.source.transaction(() => {
      if (!session.source.observe(event)) this.#emit(event, session.runtimeId);
    });
  }

  #markHistoryUnknown(session: HermesSession, reason: string): void {
    session.source.setAvailability(false, false);
    this.#emit({ type: "runtime.error", message: reason, recoverable: true }, session.runtimeId);
  }

  #reportCommand(session: HermesSession, commandId: string, ok: boolean,
    status?: Extract<RuntimeEvent, { type: "command.result" }>['status'], error?: string): void {
    const event: Extract<RuntimeEvent, { type: "command.result" }> = {
      type: "command.result", commandId, ok, ...(status ? { status } : {}), ...(error ? { error: error.slice(0, 512) } : {}),
    };
    this.#options.onCommandResult?.(session.runtimeId, event);
    this.#emit(event, session.runtimeId);
  }

  #emit(event: RuntimeEvent, runtimeId: string): void {
    this.#options.onEvent?.(runtimeId, event);
    this.#sink(event, runtimeId);
  }

  #assertReady(): void {
    if (!this.isReady()) throw new ActivationError("agent_unsupported", "Hermes Gateway 未连接或尚未就绪");
  }

  #hasCapability(capability: string): boolean { return this.#options.runtime.capabilities.includes(capability); }

  #request<T>(method: string, params: JsonRecord): Promise<T> {
    return this.#options.client.request<T>(method, params);
  }
}

function transcriptEntries(sessionId: string, messages: HermesTranscriptMessage[], hostId: string): RemoteSessionEntry[] {
  const entries: RemoteSessionEntry[] = [];
  messages.forEach((raw, index) => {
    const rowId = finiteInteger(raw.row_id);
    const entryId = entryIdFor(sessionId, rowId ?? index + 1);
    const message = transcriptMessage(raw, entryId);
    const entry = toRemoteEntry(sessionId, rowId ?? index + 1, message, entries.at(-1)?.entryId ?? null);
    entries.push(projectToolEntry({ agent: hermesAgentKey(hostId, sessionId), order: index, entryId,
      readCapability: "none" }, entry));
  });
  return entries;
}

function hermesAgentKey(hostId: string, sessionId: string): ToolAgentKey {
  return { hostId, agentKind: "hermes", sessionId };
}

function transcriptMessage(raw: HermesTranscriptMessage, fallbackId: string): ChatMessage {
  const roleValue = typeof raw.role === "string" ? raw.role : "custom";
  const role: ChatMessage["role"] = roleValue === "user" ? "user" : roleValue === "assistant" ? "assistant"
    : roleValue === "tool" || roleValue === "toolResult" ? "tool" : roleValue === "system" ? "system" : "custom";
  const timestamp = epochMillis(raw.timestamp);
  const content = transcriptContent(raw.content, raw.text, raw.reasoning);
  const toolCallId = typeof raw.tool_call_id === "string" ? raw.tool_call_id : undefined;
  const toolName = typeof raw.name === "string" ? raw.name : undefined;
  return {
    messageId: fallbackId,
    role,
    content,
    timestamp,
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(raw.is_error === true ? { isError: true } : {}),
  };
}

function transcriptContent(raw: unknown, textValue: unknown, reasoningValue?: unknown): RemoteContent[] {
  const content: RemoteContent[] = [];
  if (typeof raw === "string" && raw.length) content.push({ type: "text", text: raw.slice(0, MAX_TEXT_CHARS) });
  else if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value === "string") { if (value) content.push({ type: "text", text: value.slice(0, MAX_TEXT_CHARS) }); continue; }
      const part = asRecord(value);
      if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text.slice(0, MAX_TEXT_CHARS) });
      else if ((part.type === "thinking" || part.type === "reasoning") && typeof part.text === "string") content.push({ type: "thinking", text: part.text.slice(0, MAX_TEXT_CHARS) });
      else if (part.type === "tool_call" && typeof part.id === "string" && typeof part.name === "string")
        content.push({ type: "tool_call", toolCallId: part.id, toolName: part.name, ...(part.arguments === undefined ? {} : { arguments: part.arguments }) });
      else if (part.type === "image") content.push({ type: "text", text: "[Hermes image content]" });
    }
  }
  if (content.length === 0 && typeof textValue === "string" && textValue.length) content.push({ type: "text", text: textValue.slice(0, MAX_TEXT_CHARS) });
  if (typeof reasoningValue === "string" && reasoningValue.length && !content.some(item => item.type === "thinking"))
    content.push({ type: "thinking", text: reasoningValue.slice(0, MAX_TEXT_CHARS) });
  return content;
}

function chatFromInput(input: HermesPendingInput, rowId: number): ChatMessage {
  return {
    messageId: entryIdFor("input", rowId),
    role: "user",
    content: [{ type: "text", text: input.text.slice(0, MAX_TEXT_CHARS) }],
    timestamp: Date.now(),
    ...(input.messageId ? { clientMessageId: input.messageId } : {}),
  };
}

function persistedTurnProjectionComplete(persisted: JsonRecord, input: HermesPendingInput | undefined): boolean {
  if (persisted.complete !== true) return false;
  const finalAssistantRowId = finiteInteger(persisted.final_assistant_row_id);
  if (finalAssistantRowId === undefined || !Array.isArray(persisted.row_ids)) return false;
  const userRowId = finiteInteger(persisted.user_row_id);
  const userRows = Array.isArray(persisted.user_row_ids) ? persisted.user_row_ids.map(finiteInteger) : [];
  if (userRows.some(value => value === undefined) || userRows.length > 1) return false;
  if (userRows.length === 1 && (!input || userRowId === undefined || userRows[0] !== userRowId)) return false;
  if (userRowId !== undefined && !input) return false;
  const represented = new Set([finalAssistantRowId, ...(input && userRowId !== undefined ? [userRowId] : [])]);
  const rowIds = persisted.row_ids.map(finiteInteger);
  return rowIds.length === represented.size && rowIds.every(value => value !== undefined && represented.has(value));
}

function toRemoteEntry(sessionId: string, rowId: number, message: ChatMessage, parentId: string | null): RemoteSessionEntry {
  const entryId = entryIdFor(sessionId, rowId);
  const timestamp = new Date(message.timestamp).toISOString();
  return { entryId, parentId, type: "message", timestamp, data: { message: { ...message, messageId: entryId } } };
}

function entryIdFor(sessionId: string, rowId: number): string { return `hermes:${digest(sessionId).slice(0, 24)}:${rowId}`; }
function runtimeIdFor(profileId: string, sessionId: string): string { return `hermes:${digest(`${profileId}\0${sessionId}`).slice(0, 40)}`; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function turnIdentity(event: HermesGatewayEvent): string {
  if (typeof event.admission_id === "string" && event.admission_id) return event.admission_id;
  const generation = finiteInteger(event.execution_generation);
  const sequence = finiteInteger(event.seq);
  return sequence !== undefined ? `seq-${sequence}` : generation === undefined ? `turn-${Date.now()}` : `generation-${generation}-${Date.now()}`;
}
function safeRequestId(value: string | undefined): string | undefined {
  return value && value.length > 0 && value.length <= RPC_REQUEST_ID_LIMIT ? value : undefined;
}
function providerFromModel(model: string): string {
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator).slice(0, 128) : "hermes";
}
function epochMillis(value: unknown): number {
  const number = finiteNumber(value);
  if (number === undefined || number < 0) return 0;
  const millis = number < 1_000_000_000_000 ? number * 1000 : number;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(millis));
}
function boundedCount(value: unknown): number { return Math.max(0, Math.min(100_000, Math.trunc(finiteNumber(value) ?? 0))); }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function finiteInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function firstString(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === "string" && value.length > 0); }
function boundedString(value: unknown, max: number): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function asRecord(value: unknown): JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isUncertainRpcFailure(error: unknown): boolean {
  if (!(error instanceof HermesGatewayRpcError)) return true;
  if (error.code !== undefined) return false;
  return !/not connected|not ready/iu.test(error.message);
}
