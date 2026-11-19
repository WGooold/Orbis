/** Orbis AgentBackend projection over the authenticated Hermes TUI Gateway authority RPC. */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  RecoverableSessionSource,
  SessionSyncPreparer,
  type SessionConfigurationCatalog,
  type ToolSummary,
  type AgentKey,
  type AgentSessionSummary,
  type ChatMessage,
  type RemoteContent,
  type RemoteSessionEntry,
  type RuntimeCapabilities,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeMetadata,
} from "@orbis/protocol";
import { HermesGatewayRpcError, type HermesGatewayEvent, type HermesGatewayRpcClient } from "./hermes-gateway-rpc.js";
import type { HermesGatewayEndpoint, HermesGatewayRuntimeDescriptor } from "./hermes-gateway-bootstrap.js";
import type { AgentActivateContext, AgentActivateTarget, AgentBackend, BackendActivation, CommandDispatch } from "./agent-backend.js";
import { ActivationError } from "./spawner.js";
import { SessionArchiveError } from "./session-archive.js";
import { localHostname } from "./sessions.js";
import { HermesInteractions } from "./hermes-interactions.js";
import { hermesModelCatalog, hermesModelValue, requireHermesModel, type HermesModelSelection } from "./hermes-session-configuration.js";
import { hermesToolIdentity, hermesToolSummary } from "./hermes-tool-projection.js";
import { SessionConfigurationError } from "./session-configuration-store.js";

type HermesGatewayClient = Pick<HermesGatewayRpcClient, "request" | "closed" | "readyState">;
const HERMES_KIND = "hermes" as const;
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
export type UnconfirmedHermesModel = { selection: HermesModelSelection; minRevision: number; minGeneration: number };
type HermesSession = {
  readonly runtimeId: string;
  readonly sessionId: string;
  gatewaySessionId: string;
  readonly source: RecoverableSessionSource;
  readonly preparer: SessionSyncPreparer;
  readonly inputsByCommand: Map<string, HermesPendingInput>;
  readonly inputsByMessage: Map<string, HermesPendingInput>;
  readonly inputsByAdmission: Map<string, HermesPendingInput>;
  entries: RemoteSessionEntry[];
  readonly interactions: HermesInteractions;
  readonly tools: Map<string, ToolSummary>;
  readonly clientMessages: Map<number, string>;
  needsSnapshot: boolean;
  subscriptionId: string;
  cwd: string;
  title: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  configurationChanging?: boolean;
  modelUnconfirmed?: UnconfirmedHermesModel;
  modelOptions?: { at: number; commands: RuntimeCapabilities["commands"] };
  modelOptionsLoading?: boolean;
  canSwitchModel: boolean;
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
  modelFences?: Map<string, UnconfirmedHermesModel>;
  onEvent?: (runtimeId: string, event: RuntimeEvent) => void;
  onCommandResult?: (runtimeId: string, event: Extract<RuntimeEvent, { type: "command.result" }>) => void;
  log?: (message: string) => void;
};

const RPC_REQUEST_ID_LIMIT = 256;
const MAX_TEXT_CHARS = 100_000;
const MAX_PENDING_INPUTS = 256;
const MAX_LIVE_TOOLS = 4096;
const READY_STATE_OPEN = 1;

/**
 * Hermes history/turns stay Gateway-owned. This adapter stores only an in-memory projection and
 * sync cursor; it never opens Hermes' state database or retries an uncertain prompt admission.
 */
export class HermesAgentBackend implements AgentBackend {
  readonly kind = HERMES_KIND;
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
    if (!this.isReady()) return undefined;
    try { return firstString(asRecord(await this.#request("model.options", {})).provider); }
    catch { return undefined; }
  }

  async sessionConfiguration(cwd: string): Promise<SessionConfigurationCatalog> {
    return (await this.#modelCatalog(cwd)).catalog;
  }

  async #modelCatalog(cwd: string): Promise<ReturnType<typeof hermesModelCatalog>> {
    this.#assertReady();
    if (!this.#supportsModelCreate()) throw new SessionConfigurationError("configuration_unavailable", "当前 Hermes Gateway 未提供会话模型设置");
    if (!isAbsolute(cwd) || !await stat(cwd).then(info => info.isDirectory(), () => false))
      throw new ActivationError("cwd_missing", "请选择存在的绝对目录");
    return hermesModelCatalog(await this.#request("model.options", {}), this.#options.endpoint.profile_id, cwd);
  }

  #supportsModelCreate(): boolean {
    return this.#options.runtime.session_create.sources.includes("tui") &&
      ["cwd", "model", "provider"].every(field => this.#options.runtime.session_create.parameters.includes(field));
  }

  #confirmModel(info: JsonRecord, selection: HermesModelSelection | undefined): void {
    if (selection && (info.model !== selection.model || info.provider !== selection.provider))
      throw new SessionConfigurationError("configuration_unconfirmed", "Hermes 未确认所选模型，未发送首句");
  }

  /**
   * The canonical runtime list separates live and resumable rows. Its v1 row intentionally has no
   * workspace field; cwd remains unknown until Gateway returns an attached session snapshot.
   */
  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    if (archived) return [];
    this.#assertReady();
    const [live, stored] = await Promise.all([
      this.#request<{ sessions?: unknown }>("session.list", { scope: "live", limit: 200 }, 2_000),
      this.#request<{ sessions?: unknown }>("session.list", { scope: "stored", limit: 200 }, 2_000),
    ]);
    // This Gateway contract has a hard limit and no cursor. A full page cannot prove there are no later rows.
    this.#catalogComplete = Array.isArray(live.sessions) && Array.isArray(stored.sessions) &&
      live.sessions.length < 200 && stored.sessions.length < 200;
    const rows = new Map<string, AgentSessionSummary>();
    for (const [scope, result] of [["stored", stored], ["live", live]] as const) {
      if (!Array.isArray(result.sessions)) throw new Error("Hermes Gateway returned an invalid session list");
      for (const value of result.sessions) {
        const row = asRecord(value);
        const sessionId = hermesToolIdentity(firstString(scope === "live" ? row.session_id : row.resolved_id, row.session_id, row.id));
        if (!sessionId) { this.#catalogComplete = false; continue; }
        const attached = this.#bySessionId.get(sessionId);
        const startedAt = epochMillis(row.started_at);
        const title = boundedString(row.title, 256);
        const preview = boundedString(row.preview, 4_000);
        rows.set(sessionId, {
          sessionId,
          agentKind: HERMES_KIND,
          hostname: this.#options.hostname ?? localHostname(),
          cwd: attached?.cwd ?? "",
          ...(title ? { name: title } : {}),
          ...(preview ? { firstMessage: preview } : {}),
          createdAt: startedAt,
          modifiedAt: startedAt,
          messageCount: boundedCount(row.message_count),
          archived: false,
          ...(attached?.provider ? { modelProvider: attached.provider } : {}),
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
      const values = context?.configuration;
      if (values?.thinking !== undefined || Object.keys(values?.permissions ?? {}).length)
        requireHermesModel(values, new Map());
      if (existing) {
        if (values?.model !== undefined) {
          const selection = requireHermesModel(values, (await this.#modelCatalog(existing.cwd)).selections);
          const info = asRecord(await this.#request("session.info", { session_id: existing.gatewaySessionId }));
          this.#assertSnapshotOwner({}, info);
          this.#confirmModel(info, selection);
          this.#applyInfo(existing, info);
          this.#publishMetadata(existing);
        }
        return { sessionId: existing.sessionId, spawnMode: "headless" };
      }
      let raw: unknown;
      try {
        raw = await this.#request<unknown>("session.resume", {
          session_id: target.sessionId,
          source: "tui",
        });
      } catch (error) {
        if (error instanceof HermesGatewayRpcError &&
            ["not_found", "session_not_found"].includes(String(error.data?.reason ?? error.message)))
          throw new ActivationError("session_not_found", "Hermes Gateway 中找不到这个会话");
        throw error;
      }
      if (values?.model !== undefined) {
        const info = asRecord(asRecord(raw).info);
        const selection = requireHermesModel(values, (await this.#modelCatalog(boundedString(info.cwd, 4096))).selections);
        this.#confirmModel(info, selection);
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
    const selection = requireHermesModel(context?.configuration, context?.configuration?.model === undefined
      ? new Map() : (await this.#modelCatalog(target.cwd)).selections);
    const params: JsonRecord = { source: "tui", cwd: target.cwd, ...selection };
    // request_id is an idempotency key only when the negotiated contract advertises it.
    if (context?.launchId !== undefined && (!safeRequestId(context.launchId) || !this.#options.runtime.session_create.parameters.includes("request_id")))
      throw new ActivationError("agent_unsupported", "Hermes Gateway 未提供可核验的启动请求身份");
    if (this.#options.runtime.session_create.parameters.includes("request_id")) params.request_id = context?.launchId ?? randomUUID();
    const raw = asRecord(await this.#request("session.create", params));
    this.#assertSnapshotOwner(raw, asRecord(raw.info));
    const nativeId = hermesToolIdentity(raw.stored_session_id ?? raw.session_id);
    if (!nativeId) throw new Error("Hermes Gateway returned an invalid session identity");
    // The native session already exists even if its effective configuration could not be confirmed.
    await context?.onCreated?.({ sessionId: nativeId, spawnMode: "headless" });
    if (selection) {
      const nativeSession = hermesToolIdentity(raw.session_id);
      if (!nativeSession) throw new Error("Hermes Gateway returned an invalid session identity");
      const info = asRecord(await this.#request("session.info", { session_id: nativeSession }));
      this.#assertSnapshotOwner({}, info);
      this.#confirmModel(info, selection);
      raw.info = { ...asRecord(raw.info), ...info };
    }
    const session = this.#attachSnapshot(raw);
    return { sessionId: session.sessionId, spawnMode: "headless" };
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    const session = this.#byRuntime.get(runtimeId);
    if (!session || !this.isReady()) return "offline";
    if (command.type === "slash.execute" && (command.name !== "model" || !session.canSwitchModel)) return "unsupported";
    if (command.type === "user_message" && !this.#hasCapability("durable-admission-v1")) return "unsupported";
    if (command.type === "user_message" && ((command.attachments?.length ?? 0) > 0 || command.delivery === "steer")) return "unsupported";
    if (!["user_message", "user_message.cancel", "stop", "session.sync", "interaction.respond", "slash.execute"].includes(command.type)) return "unsupported";
    void this.#dispatch(session, commandId, command).catch(error => {
      this.#reportCommand(session, commandId, false, isUncertainRpcFailure(error) ? "unconfirmed" : "failure", "Hermes 未确认此操作");
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
    const work = session.eventChain.then(async () => {
      if (!this.isReady() || session.gatewaySessionId !== gatewaySessionId) return;
      await this.#acceptEvent(session, event);
      if (session.needsSnapshot) await this.#refreshSnapshot(session);
    });
    session.eventChain = work.catch(error => {
      this.#markHistoryUnknown(session, "Hermes 会话事件暂时无法同步");
      this.#options.log?.(`Hermes Gateway event projection failed (${error instanceof Error ? error.name : "unknown"})`);
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
    if (command.type === "slash.execute") {
      await this.#switchModel(session, commandId, command.args);
    }
    if (command.type === "interaction.respond") {
      let status: "success" | "failure" | "unconfirmed";
      try { status = await session.interactions.respond(session.gatewaySessionId, command, (method, params) => this.#request(method, params)); }
      catch (error) { status = isUncertainRpcFailure(error) ? "unconfirmed" : "failure"; }
      this.#reportCommand(session, commandId, status === "success", status,
        status === "failure" ? "Hermes 未接受此交互回复" : status === "unconfirmed" ? "Hermes 尚未确认此交互回复，未重发" : undefined);
    }
  }

  async #submit(session: HermesSession, commandId: string, command: Extract<RuntimeCommand, { type: "user_message" }>): Promise<void> {
    if (session.configurationChanging || session.modelUnconfirmed) {
      this.#reportCommand(session, commandId, false, "failure", "Hermes 会话模型尚未核对，消息未发送");
      return;
    }
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
      if (session.needsSnapshot || (request.range === "preview" && session.modelUnconfirmed)) {
        await this.#queueSessionRead(session, async () => {
          if (session.needsSnapshot) await this.#refreshSnapshot(session);
          else if (session.modelUnconfirmed) {
            // A failed configuration read must not make otherwise available history unreadable.
            await this.#refreshSnapshot(session).catch(() => undefined);
          }
        });
      }
      session.source.replayToolInventory();
      const snapshot = session.preparer.select({
        entries: session.entries,
        sessionId: session.sessionId,
        leafId: session.entries.at(-1)?.entryId ?? null,
        request,
        source: session.source.published(),
      });
      this.#emit(snapshot, session.runtimeId);
      if (request.range === "preview") {
        session.interactions.snapshot();
        void this.#announceModelOptions(session);
      }
    } catch (error) {
      this.#reportCommand(session, commandId, false, "failure", errorText(error));
    }
  }

  async #announceModelOptions(session: HermesSession): Promise<void> {
    if (!session.canSwitchModel || session.modelOptionsLoading || session.modelUnconfirmed) return;
    if (session.modelOptions && Date.now() - session.modelOptions.at < 30_000) {
      this.#emit({ type: "runtime.capabilities", capabilities: { commands: session.modelOptions.commands } }, session.runtimeId);
      return;
    }
    session.modelOptionsLoading = true;
    const generation = session.executionGeneration;
    const gatewaySessionId = session.gatewaySessionId;
    try {
      // Read only after the caller specifically previews this Hermes session. Failures cannot stall history.
      const result = asRecord(await this.#request("model.options", { session_id: gatewaySessionId }));
      if (!this.isReady() || session.gatewaySessionId !== gatewaySessionId || session.executionGeneration !== generation || session.modelUnconfirmed) return;
      const models = hermesModelCatalog(result, this.#options.endpoint.profile_id, session.cwd).catalog.models;
      const commands: RuntimeCapabilities["commands"] = models.length ? [{ name: "model", source: "builtin",
        argument: { kind: "select", required: true, options: models.map(({ value, label }) => ({ value, label })) } }] : [];
      session.modelOptions = { at: Date.now(), commands };
      this.#emit({ type: "runtime.capabilities", capabilities: { commands } }, session.runtimeId);
    } catch {
      delete session.modelOptions;
      this.#emit({ type: "runtime.capabilities", capabilities: { commands: [] } }, session.runtimeId);
    } finally { delete session.modelOptionsLoading; }
  }

  async #switchModel(session: HermesSession, commandId: string, value: string): Promise<void> {
    if (session.running || session.needsSnapshot || session.configurationChanging || session.modelUnconfirmed) {
      this.#reportCommand(session, commandId, false, "failure", "请先结束当前轮次并核对会话，再切换模型");
      return;
    }
    // Lock sends immediately, but line up the write/readback behind replay and snapshot recovery.
    session.configurationChanging = true;
    try {
      const status = await this.#queueSessionRead(session, () => this.#mutateModel(session, value));
      this.#reportCommand(session, commandId, status === "success", status, status === "success" ? undefined :
        status === "unconfirmed" ? "Hermes 未确认模型切换，未重发" : "Hermes 未接受此模型切换，请在电脑端核对");
    } catch {
      this.#reportCommand(session, commandId, false, "failure", "Hermes 模型选项或会话版本不可核对，未发起切换");
    } finally { delete session.configurationChanging; }
  }

  async #mutateModel(session: HermesSession, value: string): Promise<"success" | "failure" | "unconfirmed"> {
    if (!this.isReady() || session.running || session.needsSnapshot) return "failure";
    const sessionId = session.gatewaySessionId;
    const options = hermesModelCatalog(await this.#request("model.options", { session_id: sessionId }),
      this.#options.endpoint.profile_id, session.cwd);
    const selection = requireHermesModel({ model: value }, options.selections)!;
    const snapshot = asRecord(await this.#request("session.resume", { session_id: sessionId }));
    this.#assertSnapshotOwner(snapshot, asRecord(snapshot.info));
    const revision = finiteInteger(snapshot.revision);
    const generation = finiteInteger(snapshot.execution_generation);
    if (snapshot.session_id !== sessionId || snapshot.running !== false || revision === undefined || generation === undefined ||
        generation < session.executionGeneration || (Array.isArray(snapshot.pending) && snapshot.pending.length > 0)) return "failure";

    const fence: UnconfirmedHermesModel = { selection, minRevision: revision + 1, minGeneration: generation + 1 };
    let receivedReply = false;
    this.#options.modelFences?.set(session.sessionId, fence);
    try {
      const result = asRecord(await this.#request("session.mutate", { session_id: sessionId, operation: "model", request_id: randomUUID(),
        expected_revision: revision, expected_generation: generation, payload: selection }));
      receivedReply = true;
      if (result.session_id === sessionId && result.operation === "model") {
        if (result.status === "confirmation_required" || result.status === "refused") { this.#options.modelFences?.delete(session.sessionId); return "failure"; }
        const committedRevision = finiteInteger(result.revision), committedGeneration = finiteInteger(result.execution_generation);
        // The checked contract's commit receipt has the effective model/provider, not a status field.
        if (result.status === undefined && committedRevision !== undefined && committedRevision >= fence.minRevision &&
            committedGeneration !== undefined && committedGeneration >= fence.minGeneration && sameModel(result, selection)) {
          fence.minRevision = committedRevision;
          fence.minGeneration = committedGeneration;
          const info = asRecord(await this.#request("session.info", { session_id: sessionId }));
          this.#assertSnapshotOwner({}, info);
          if (sameModel(info, selection)) {
            this.#options.modelFences?.delete(session.sessionId);
            session.executionGeneration = committedGeneration;
            session.interactions.advance(committedGeneration);
            this.#applyInfo(session, info);
            this.#publishMetadata(session);
            return "success";
          }
        }
      }
    } catch (error) {
      // A refusal of the write is different from an error reading back an already committed write.
      if (!receivedReply && error instanceof HermesGatewayRpcError && (error.code === 4001 || error.code === -32601)) {
        this.#options.modelFences?.delete(session.sessionId);
        if (error.code === -32601) {
          session.canSwitchModel = false;
          this.#emit({ type: "runtime.capabilities", capabilities: { commands: [] } }, session.runtimeId);
        }
        return "failure";
      }
    }
    session.modelUnconfirmed = fence;
    delete session.modelOptions;
    this.#publishMetadata(session);
    this.#emit({ type: "runtime.capabilities", capabilities: { commands: [] } }, session.runtimeId);
    return "unconfirmed";
  }

  #queueSessionRead<T>(session: HermesSession, work: () => Promise<T>): Promise<T> {
    const result = session.eventChain.then(work);
    session.eventChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async #acceptEvent(session: HermesSession, event: HermesGatewayEvent): Promise<void> {
    if (event.authority_epoch !== undefined && event.authority_epoch !== this.#options.endpoint.authority_epoch) {
      this.#markHistoryUnknown(session, "Hermes Gateway owner 已变化");
      return;
    }
    const sequence = finiteInteger(event.seq);
    const epoch = firstString(event.replay_epoch);
    if (sequence === undefined || epoch !== session.replayEpoch) {
      this.#markHistoryUnknown(session, "Hermes Gateway event epoch changed");
      return;
    }
    if (sequence <= session.lastSequence) return;
    if (sequence > session.lastSequence + 1) {
      await this.#replayEvents(session);
      if (sequence <= session.lastSequence) return;
      if (sequence !== session.lastSequence + 1) {
        this.#markHistoryUnknown(session, "Hermes event replay has a gap");
        return;
      }
    }
    if (!session.needsSnapshot) this.#applyEvent(session, event);
    session.lastSequence = sequence;
  }

  async #replayEvents(session: HermesSession): Promise<void> {
    if (!this.#hasCapability("event-replay-v1")) return;
    const events = await this.#readReplay(session, session.lastSequence);
    if (!events) {
      this.#markHistoryUnknown(session, "Hermes event replay was incomplete");
      return;
    }
    this.#applyReplay(session, events);
  }

  async #readReplay(session: HermesSession, since: number): Promise<HermesGatewayEvent[] | undefined> {
    const result = asRecord(await this.#request("session.events.since", {
      session_id: session.gatewaySessionId, last_sequence: since, replay_epoch: session.replayEpoch,
    }));
    const events = Array.isArray(result.events) ? result.events.map(asRecord) : undefined;
    const latest = finiteInteger(result.latest_seq);
    const epoch = firstString(result.replay_epoch, result.epoch);
    // Validate the whole replay suffix before opening any possibly stale approval card.
    if (!events || result.snapshot_required === true || result.truncated === true || epoch !== session.replayEpoch ||
      latest !== since + events.length || !events.every((event, i) => typeof event.type === "string" &&
        event.session_id === session.gatewaySessionId && event.seq === since + i + 1 && event.replay_epoch === epoch &&
        (event.authority_epoch === undefined || event.authority_epoch === this.#options.endpoint.authority_epoch))) return undefined;
    return events as HermesGatewayEvent[];
  }

  #applyReplay(session: HermesSession, events: readonly HermesGatewayEvent[]): void {
    for (const event of events) {
      if (!session.needsSnapshot) this.#applyEvent(session, event, true);
      session.lastSequence++;
    }
    if (events.length) session.interactions.snapshot();
  }

  async #restoreActiveTools(session: HermesSession): Promise<boolean> {
    if (!session.running || !session.lastSequence || !this.#hasCapability("event-replay-v1")) return false;
    const cut = session.lastSequence;
    const events = await this.#readReplay(session, 0).catch(() => undefined);
    // The owner has no live tool inventory in resume; retain only verified same-turn summaries.
    // Earlier prompts/messages are superseded by the native snapshot, not replayed as live state.
    if (!events || events.length < cut) return false;
    const persistedTools = new Set(session.entries.flatMap(entry => {
      const message = asRecord(entry.data.message);
      return message.role === "toolResult" ? [message.toolCallId] : [];
    }));
    session.source.transaction(() => {
      for (const event of events.slice(0, cut)) {
        if (event.execution_generation !== session.executionGeneration ||
            (event.type !== "tool.start" && event.type !== "tool.progress" && event.type !== "tool.complete")) continue;
        const payload = asRecord(event.payload);
        if (!persistedTools.has(payload.tool_id)) this.#toolEvent(session, event.type, payload);
      }
    });
    this.#applyReplay(session, events.slice(cut));
    return true;
  }

  #applyEvent(session: HermesSession, event: HermesGatewayEvent, replay = false): void {
    const payload = asRecord(event.payload);
    const generation = finiteInteger(event.execution_generation);
    if (generation !== undefined && generation < session.executionGeneration) return;
    if (generation !== undefined && generation > session.executionGeneration) {
      session.executionGeneration = generation;
      session.interactions.advance(generation);
    }
    switch (event.type) {
      case "session.info":
        this.#assertSnapshotOwner(payload, payload);
        this.#applyInfo(session, payload);
        this.#publishMetadata(session);
        return;
      case "approval.request":
      case "clarify.request":
        if (session.running && payload.kind === event.type.split(".")[0]) session.interactions.open(payload, !replay);
        return;
      case "approval.settled":
      case "clarify.settled":
        session.interactions.settled(event.type === "approval.settled" ? "approval" : "clarify", payload);
        return;
      case "tool.start":
      case "tool.progress":
      case "tool.complete":
        if (session.running && generation === session.executionGeneration) this.#toolEvent(session, event.type, payload);
        return;
      case "message.start": {
        if (generation === undefined || generation === 0) return;
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
        if (generation !== undefined && session.running) this.#applyDelta(session, payload, "text", event);
        return;
      case "reasoning.delta":
      case "thinking.delta":
        if (generation !== undefined && session.running) this.#applyDelta(session, payload, "thinking", event);
        return;
      case "message.complete":
        // Cancelling a queued admission emits its own completion without an execution generation.
        if (generation === undefined || !session.running ||
            (session.turn && typeof event.admission_id === "string" && event.admission_id !== session.turn.turnId)) return;
        this.#finishTurn(session, payload, event);
        return;
      case "error": {
        this.#emit({ type: "runtime.error", message: "Hermes Gateway 会话出错", recoverable: payload.recoverable === true }, session.runtimeId);
        return;
      }
      case "session.reclaimed":
        session.interactions.clear("owner_closed");
        this.#markHistoryUnknown(session, "Hermes 会话所有权已变化");
        session.running = false;
        this.#publishMetadata(session);
        return;
      default:
        return;
    }
  }

  #toolEvent(session: HermesSession, type: "tool.start" | "tool.progress" | "tool.complete", payload: JsonRecord): void {
    const id = hermesToolIdentity(payload.tool_id);
    if (!id) return;
    const previous = session.tools.get(id);
    if (previous?.phase === "finished" || (type === "tool.start" && previous)) return;
    if (!previous && session.tools.size >= MAX_LIVE_TOOLS) {
      session.source.setAvailability(true, false);
      return;
    }
    const toolName = previous?.toolName ?? hermesToolIdentity(payload.name);
    if (!toolName) return;
    const duration = finiteNumber(payload.duration_s);
    const durationMs = duration !== undefined && duration >= 0 ? finiteInteger(Math.round(duration * 1000)) : undefined;
    const summary = hermesToolSummary(hermesAgentKey(this.#options.hostId, session.sessionId), {
      toolCallId: id, toolName, order: previous?.order ?? session.tools.size,
      phase: type === "tool.complete" ? "finished" : type === "tool.progress" ? "running" : "started",
      ...(typeof payload.is_error === "boolean" && type === "tool.complete" ? { isError: payload.is_error } : {}),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(session.turn ? { turnId: session.turn.turnId } : {}), args: payload.args, result: payload.result,
    });
    if (previous) for (const part of previous.contents) if (!summary.contents.some(item => item.part === part.part)) summary.contents.push(part);
    session.tools.set(id, summary);
    this.#observe(session, { type: "tool.activity", summary });
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
    const field = contentType === "text" ? "text" : "reasoning";
    const value = typeof payload.rendered === "string" ? payload.rendered : payload.text;
    const delta = typeof value === "string" ? value.slice(0, MAX_TEXT_CHARS - session.turn[field].length) : "";
    if (!delta) return;
    session.turn[field] += delta;
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
    const reasoning = boundedString(payload.reasoning, MAX_TEXT_CHARS) || turn.reasoning;
    if (reasoning) content.unshift({ type: "thinking", text: reasoning });
    const message: ChatMessage = { messageId: turn.messageId, role: "assistant", content, timestamp: Date.now(),
      ...(payload.status === "error" ? { isError: true } : {}) };
    this.#observe(session, { type: "message.finished", message });
    const status = payload.status;
    const outcome = status === "error" ? "failed" : status === "interrupted" ? "cancelled" : status === "complete" ? "completed" : "unknown";
    const durationMs = Math.max(0, Date.now() - turn.startedAt);
    const persisted = asRecord(payload.persisted_turn);
    const submissionId = typeof persisted.submission_id === "string" ? persisted.submission_id : undefined;
    const input = submissionId ? session.inputsByCommand.get(submissionId) : turn.input;
    const userRowId = finiteInteger(persisted.user_row_id);
    if (persisted.complete === true && userRowId !== undefined && input?.messageId &&
        Array.isArray(persisted.row_ids) && persisted.row_ids.includes(userRowId)) {
      session.clientMessages.set(userRowId, input.messageId);
      if (session.clientMessages.size > 1024) session.clientMessages.delete(session.clientMessages.keys().next().value!);
    }
    const projectionComplete = session.source.published().live.complete && session.tools.size === 0 && persistedTurnProjectionComplete(persisted, input);
    const persistedMessages = projectionComplete ? this.#commitPersistedTurn(session, message, input, persisted) : [];
    if (!projectionComplete) {
      session.needsSnapshot = true;
      // Do not publish a partial canonical append while the native rows are being recovered.
    }
    session.interactions.clear("cancelled");
    if (input) this.#forgetInput(session, input);
    this.#observe(session, { type: "turn.finished", turnId: turn.turnId, startedAt: turn.startedAt,
      durationMs, outcome, messageId: turn.messageId, ...(persistedMessages.length ? { persistedMessages } : {}) });
    session.running = false;
    delete session.turn;
    this.#publishMetadata(session);
  }

  #commitPersistedTurn(session: HermesSession, assistant: ChatMessage, input: HermesPendingInput | undefined,
    persisted: JsonRecord): Array<{ messageId: string; entryId: string }> {
    const assistantRowId = finiteInteger(persisted.final_assistant_row_id);
    if (assistantRowId === undefined) return [];
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
    const gatewaySessionId = hermesToolIdentity(snapshot.session_id);
    const sessionId = hermesToolIdentity(snapshot.stored_session_id ?? snapshot.session_id);
    const info = asRecord(snapshot.info);
    this.#assertSnapshotOwner(snapshot, info);
    if (!gatewaySessionId || !sessionId) throw new Error("Hermes Gateway returned an invalid session identity");
    const cwd = firstString(info.cwd);
    if (!cwd || cwd.length > 4096 || !isAbsolute(cwd)) throw new Error("Hermes Gateway did not return a local session workspace");
    const runtimeId = runtimeIdFor(this.#options.endpoint.profile_id, sessionId);
    if (!Array.isArray(snapshot.messages)) throw new Error("Hermes Gateway returned no transcript snapshot");
    const messages = snapshot.messages.map(asRecord) as HermesTranscriptMessage[];
    const entries = transcriptEntries(sessionId, messages, this.#options.hostId);
    const session = {
      runtimeId,
      sessionId,
      gatewaySessionId,
      source: new RecoverableSessionSource(sessionId, event => this.#emit(event, runtimeId),
        { coalesceMs: 24, runtimeId: () => runtimeId, publishTools: event => this.#emit(event, runtimeId) }),
      interactions: new HermesInteractions(runtimeId, event => this.#emit(event, runtimeId)),
      tools: new Map<string, ToolSummary>(),
      clientMessages: new Map<number, string>(),
      needsSnapshot: false,
      canSwitchModel: this.#supportsModelCreate() && finiteInteger(snapshot.revision) !== undefined,
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
    if (fallbackSessionId) this.#bySessionId.set(fallbackSessionId, session);
    if (gatewaySessionId !== sessionId) this.#bySessionId.set(gatewaySessionId, session);
    this.#applyInfo(session, info);
    this.#recoverModelFence(session, snapshot, info);
    this.#publishMetadata(session);
    session.interactions.adopt(snapshot.prompts, session.running ? session.executionGeneration : 0);
    session.source.flushPending();
    // Catch notifications that arrived after the snapshot's native sequence but before map registration.
    if (this.#hasCapability("event-replay-v1")) {
      session.eventChain = session.eventChain.then(async () => {
        if (!await this.#restoreActiveTools(session)) await this.#replayEvents(session);
        if (session.needsSnapshot) await this.#refreshSnapshot(session);
      }).catch(error => {
        this.#options.log?.(`Hermes initial event catch-up failed (${error instanceof Error ? error.name : "unknown"})`);
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
    }));
    const gatewaySessionId = hermesToolIdentity(snapshot.session_id);
    const storedSessionId = hermesToolIdentity(snapshot.stored_session_id ?? snapshot.session_id);
    const info = asRecord(snapshot.info);
    this.#assertSnapshotOwner(snapshot, info);
    const cwd = firstString(info.cwd);
    if (!gatewaySessionId || storedSessionId !== session.sessionId || !cwd || cwd.length > 4096 || !isAbsolute(cwd) || !Array.isArray(snapshot.messages))
      throw new Error("Hermes Gateway returned an incomplete recovery snapshot");
    const finalTurn = session.running ? null : session.source.snapshot().live.turn;
    session.entries = transcriptEntries(session.sessionId, snapshot.messages.map(asRecord), this.#options.hostId, session.clientMessages);
    session.needsSnapshot = false;
    session.tools.clear();
    delete session.turn;
    session.preparer.invalidate();
    session.source.transaction(() => {
      session.source.replaceLive({ complete: snapshot.running !== true, turn: snapshot.running === true ? null : finalTurn, messages: [], tools: [] });
      session.source.reconcile(session.entries, session.entries.at(-1)?.entryId ?? null);
      session.source.setAvailability(true, snapshot.running !== true);
    });
    this.#applyInfo(session, info);
    this.#recoverModelFence(session, snapshot, info);
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
    session.interactions.adopt(snapshot.prompts ?? [], session.running ? session.executionGeneration : 0);
    this.#publishMetadata(session);
    await this.#restoreActiveTools(session);
  }

  #recoverModelFence(session: HermesSession, snapshot: JsonRecord, info: JsonRecord): void {
    const fence = session.modelUnconfirmed ?? this.#options.modelFences?.get(session.sessionId);
    if (fence && snapshot.running === false && (finiteInteger(snapshot.revision) ?? -1) >= fence.minRevision &&
        (finiteInteger(snapshot.execution_generation) ?? -1) >= fence.minGeneration && sameModel(info, fence.selection)) {
      delete session.modelUnconfirmed;
      this.#options.modelFences?.delete(session.sessionId);
    } else if (fence) session.modelUnconfirmed = fence;
  }

  #assertSnapshotOwner(snapshot: JsonRecord, info: JsonRecord): void {
    if ((snapshot.authority_epoch !== undefined && snapshot.authority_epoch !== this.#options.endpoint.authority_epoch) ||
      (info.profile_id !== undefined && info.profile_id !== this.#options.endpoint.profile_id)) throw new Error("Hermes Gateway snapshot identity mismatch");
  }

  #applyInfo(session: HermesSession, info: JsonRecord): void {
    const cwd = boundedString(info.cwd, 4096);
    if (cwd && cwd === info.cwd && isAbsolute(cwd)) session.cwd = cwd;
    const title = boundedString(info.title, 256);
    if (title) session.title = title;
    const provider = boundedString(info.provider, 128);
    const model = boundedString(info.model, 256);
    if (Object.hasOwn(info, "provider")) { if (provider) session.provider = provider; else delete session.provider; }
    if (Object.hasOwn(info, "model")) { if (model) session.model = model; else delete session.model; }
    if (Object.hasOwn(info, "reasoning_effort")) {
      const thinking = boundedString(info.reasoning_effort, 64);
      if (thinking) session.thinkingLevel = thinking;
      else delete session.thinkingLevel;
    }
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
      ...(!session.modelUnconfirmed && session.provider && session.model ? { model: { provider: session.provider, id: session.model },
        modelSelection: { model: hermesModelValue({ provider: session.provider, model: session.model }) } } : {}),
      ...(!session.modelUnconfirmed && session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
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
    session.needsSnapshot = true;
    session.interactions.invalidate();
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

  #request<T>(method: string, params: JsonRecord, timeoutMs?: number): Promise<T> {
    return this.#options.client.request<T>(method, params, timeoutMs);
  }
}

function transcriptEntries(sessionId: string, messages: HermesTranscriptMessage[], hostId: string,
  clientMessages?: ReadonlyMap<number, string>): RemoteSessionEntry[] {
  const entries: RemoteSessionEntry[] = [];
  const agent = hermesAgentKey(hostId, sessionId);
  const called = new Map<string, string>();
  for (const [index, raw] of messages.entries()) {
    // A display-only row without a durable identity is not a row-id addressed history entry.
    const rowId = finiteInteger(raw.row_id);
    if (rowId === undefined) throw new Error("Hermes Gateway transcript row identity unavailable");
    if (raw.display_kind === "hidden" || asRecord(raw.display_metadata).model_only === true) continue;
    const entryId = entryIdFor(sessionId, rowId);
    const timestamp = epochMillis(raw.timestamp);
    const context = { entryId, order: index };
    const role: ChatMessage["role"] = raw.role === "user" || raw.role === "assistant" || raw.role === "system" ? raw.role
      : raw.role === "tool" || raw.role === "toolResult" ? "tool" : "custom";
    let message: ChatMessage;
    if (role === "tool") {
      const id = hermesToolIdentity(raw.tool_call_id) ?? entryId;
      const name = hermesToolIdentity(raw.tool_name) ?? hermesToolIdentity(raw.name) ?? called.get(id) ?? "tool";
      const isError = typeof raw.is_error === "boolean" ? raw.is_error : undefined;
      message = { messageId: entryId, role, timestamp, content: [], toolCallId: id, toolName: name,
        ...(isError !== undefined ? { isError } : {}), toolSummary: hermesToolSummary(agent, {
          ...context, toolCallId: id, toolName: name, phase: "finished", isError, result: raw.content ?? raw.text,
        }) };
    } else {
      const content = transcriptContent(raw.content, raw.text, raw.reasoning ?? raw.reasoning_content);
      if (role === "assistant") {
        const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
        const blocks = Array.isArray(raw.content) ? raw.content.map(asRecord).filter(part => part.type === "tool_call" || part.type === "toolCall") : [];
        const seen = new Set<string>();
        for (const value of [...calls, ...blocks]) {
          const call = asRecord(value), fn = asRecord(call.function);
          const id = hermesToolIdentity(call.id), name = hermesToolIdentity(fn.name ?? call.name);
          if (!id || !name || seen.has(id)) continue;
          seen.add(id); called.set(id, name);
          content.push({ type: "tool_call", toolCallId: id, toolName: name, summary: hermesToolSummary(agent, {
            ...context, toolCallId: id, toolName: name, phase: "started", args: fn.arguments ?? call.arguments,
          }) });
        }
      }
      const clientMessageId = role === "user" ? clientMessages?.get(rowId) : undefined;
      message = { messageId: entryId, role, timestamp, content, ...(raw.is_error === true ? { isError: true } : {}),
        ...(clientMessageId ? { clientMessageId } : {}) };
    }
    const entry = toRemoteEntry(sessionId, rowId, message, entries.at(-1)?.entryId ?? null);
    if (role === "tool") entry.data.message = { ...message, role: "toolResult" };
    entries.push(entry);
  }
  return entries;
}

function hermesAgentKey(hostId: string, sessionId: string): AgentKey {
  return { hostId, agentKind: "hermes", sessionId };
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
      else if (part.type === "image" || part.type === "image_url") content.push({ type: "render", renderKind: "image", text: "图片内容暂不可显示" });
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
  return rowIds.length === represented.size && new Set(rowIds).size === represented.size &&
    rowIds.at(-1) === finalAssistantRowId && rowIds.every(value => value !== undefined && represented.has(value));
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
function epochMillis(value: unknown): number {
  const number = finiteNumber(value);
  if (number === undefined || number < 0) return 0;
  const millis = number < 1_000_000_000_000 ? number * 1000 : number;
  return Math.min(8_640_000_000_000_000, Math.floor(millis));
}
function boundedCount(value: unknown): number { return Math.max(0, Math.min(100_000, Math.trunc(finiteNumber(value) ?? 0))); }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function finiteInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function firstString(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === "string" && value.length > 0); }
function boundedString(value: unknown, max: number): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function asRecord(value: unknown): JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function sameModel(info: JsonRecord, selection: HermesModelSelection): boolean { return info.model === selection.model && info.provider === selection.provider; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isUncertainRpcFailure(error: unknown): boolean {
  if (!(error instanceof HermesGatewayRpcError)) return true;
  if (error.code !== undefined) return false;
  return !/not connected|not ready/iu.test(error.message);
}
