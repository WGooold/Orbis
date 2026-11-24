import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { posix, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { GatewayClientRequestError } from "@openclaw/gateway-client";
import {
  RecoverableSessionSource, SessionSyncPreparer, type AgentSessionSummary, type RemoteSessionEntry,
  type RuntimeCommand, type RuntimeEvent, type RuntimeMetadata, type SessionConfigurationCatalog,
} from "@orbis/protocol";
import type { AgentActivateContext, AgentActivateTarget, AgentBackend, BackendActivation, CommandDispatch, NativeRunningSession } from "./agent-backend.js";
import { OpenClawGateway, openClawRecord, openClawUrl, type OpenClawConfig, type OpenClawGatewayEvents, type OpenClawMethod } from "./openclaw-gateway.js";
import { clawHash, clawInt, clawMessage, clawText, clawTime, OPENCLAW_PREFIX, readClawHistory, type ClawHistoryPage } from "./openclaw-history.js";
import { ActivationError } from "./spawner.js";
import { exitViewCapability, matchesViewExit } from "./shared-session-view.js";

const CATALOG_LIMIT = 2_000;
const HISTORY_LIMIT = 800;
const ACTIVE_LIMIT = 16;
const STREAM_TEXT_LIMIT = 6_000;
const localPath = (path: unknown): string | undefined => {
  const text = clawText(path, 4096);
  return text && !text.includes("\0") && (posix.isAbsolute(text) || /^[a-z]:[\\/]/i.test(text) && win32.isAbsolute(text)) ? text : undefined;
};
const cwdFrom = (row: Record<string, unknown>): string | undefined => localPath(row.spawnedCwd) ?? localPath(row.workspaceDir) ?? localPath(row.sessionRoot);

type SessionRef = { key: string; nativeId: string; id: string; agentId?: string; cwd: string; name?: string; archived: boolean };
type Turn = { id: string; startedAt: number; seq: number; gap: boolean };
type Session = {
  ref: SessionRef; id: string; subscriptionId: string; source: RecoverableSessionSource; preparer: SessionSyncPreparer;
  rows: ClawHistoryPage["rows"]; entries: RemoteSessionEntry[]; earlier: ClawHistoryPage | undefined;
  historyLine: Promise<unknown>; turn: Turn | undefined; streamId: string | undefined; streamText: string;
  settled: Set<string>; timer: ReturnType<typeof setTimeout> | undefined; subscribed: boolean; announced: boolean;
  eventVersion: number; lastHistoryAt: number; inputPending: string | undefined; busy: boolean;
  activeRunIds?: string[]; inFlightRunId?: string; viewGeneration: string; closing?: Promise<void>;
};

type HiddenView = { ref: SessionRef; idle: boolean; activeRunIds?: string[]; inFlightRunId?: string };
type OpenClawBackendCallbacks = {
  ready: () => void; catalog: () => void; online: (runtime: RuntimeMetadata) => void;
  offline: (runtimeId: string, reason: string) => void; event: (runtimeId: string, event: RuntimeEvent) => void;
  log?: (message: string) => void;
};
/** The deliberately small seam used by transport tests. Production uses the official SDK. */
export type OpenClawConnection = Pick<OpenClawGateway, "request" | "ready" | "start" | "stop"> & Partial<Pick<OpenClawGateway, "pairingEpoch" | "retryLocal">>;

export class OpenClawBackend implements AgentBackend {
  readonly kind = "openclaw";
  readonly #refs = new Map<string, SessionRef>();
  readonly #sessions = new Map<string, Session>();
  readonly #byKey = new Map<string, Session>();
  readonly #resume = new Map<string, SessionRef>();
  readonly #hidden = new Map<string, HiddenView>();
  readonly #coverage = new Map<boolean, boolean>();
  #ready = false;
  #stopped = false;
  #generation = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #transport!: OpenClawConnection;
  readonly #namespace: string;
  readonly #runPrefix: string;

  static async create(config: OpenClawConfig, stateDir: string, hostId: string, callbacks: OpenClawBackendCallbacks,
    connect: (events: OpenClawGatewayEvents) => Promise<OpenClawConnection> = events => OpenClawGateway.create(config, stateDir, events)): Promise<OpenClawBackend> {
    const backend = new OpenClawBackend(openClawUrl(config.url), hostId, callbacks);
    backend.#transport = await connect({ online: () => void backend.#handshake(), offline: () => backend.#disconnect(),
      gap: () => backend.#gap(), event: event => backend.#event(event), ...(callbacks.log ? { log: callbacks.log } : {}) });
    return backend;
  }

  private constructor(readonly url: string, hostId: string, readonly callbacks: OpenClawBackendCallbacks) {
    this.#namespace = `${OPENCLAW_PREFIX}${clawHash(url).slice(0, 16)}:`;
    this.#runPrefix = `orbis-${clawHash(hostId).slice(0, 16)}:`;
  }

  start(): void { if (!this.#stopped) this.#transport.start(); }
  async stop(): Promise<void> {
    this.#stopped = true; this.#disconnect(); this.#resume.clear(); this.#refs.clear(); this.#hidden.clear();
    await this.#transport.stop();
  }
  isReady(): boolean { return this.#ready && this.#transport.ready && !this.#stopped; }
  get pairingEpoch(): number { return this.#transport.pairingEpoch ?? 0; }
  async retryLocal(current: () => void): Promise<void> { await this.#transport.retryLocal?.(current); }
  matchesSessionSource(id: string): boolean { return id.startsWith(this.#namespace) && /^[A-Za-z0-9_-]{43}$/u.test(id.slice(this.#namespace.length)); }
  ownsRuntime(runtimeId: string): boolean { return this.#sessions.has(runtimeId); }
  catalogComplete(): boolean { return this.#coverage.get(false) === true && this.#coverage.get(true) === true; }

  #publicId(nativeId: string, key: string, agentId?: string): string {
    return `${this.#namespace}${clawHash(JSON.stringify([nativeId, key, agentId ?? key.split(":")[1] ?? ""]))}`;
  }
  #launchKey(deviceId: string, launchId: string): string {
    return `dashboard:orbis-${createHash("sha256").update(JSON.stringify([this.#namespace, this.#runPrefix, deviceId, launchId])).digest("hex").slice(0, 40)}`;
  }
  #matchesLaunch(ref: SessionRef, key: string, cwd: string): boolean {
    return ref.key.startsWith("agent:") && ref.key.split(":").slice(2).join(":") === key && ref.cwd === cwd;
  }
  /** A lost acknowledgement permits a read of the reserved native key, not a second create. */
  async recoverLaunch(deviceId: string, launchId: string, cwd: string): Promise<string | undefined> {
    const key = this.#launchKey(deviceId, launchId);
    const rows = await this.catalog();
    if (!this.#coverage.get(false)) return undefined;
    const matches = rows.map(row => this.#refs.get(row.sessionId)).filter(ref => ref && this.#matchesLaunch(ref, key, cwd));
    return matches.length === 1 ? matches[0]?.id : undefined;
  }
  #address(ref: SessionRef): { sessionKey: string; agentId?: string } {
    return { sessionKey: ref.key, ...(ref.agentId ? { agentId: ref.agentId } : {}) };
  }
  #identity(row: Record<string, unknown>): Omit<SessionRef, "cwd"> | undefined {
    const key = clawText(row.key, 512), nativeId = clawText(row.sessionId, 256);
    if (!key || !nativeId) return undefined;
    const agentId = clawText(row.agentId, 128), name = clawText(row.displayName, 256) ?? clawText(row.derivedTitle, 256) ?? clawText(row.label, 256);
    return { key, nativeId, id: this.#publicId(nativeId, key, agentId), archived: row.archived === true,
      ...(agentId ? { agentId } : {}), ...(name ? { name } : {}) };
  }

  #ref(row: Record<string, unknown>): SessionRef | undefined {
    const identity = this.#identity(row), cwd = cwdFrom(row);
    return identity && cwd ? { ...identity, cwd } : undefined;
  }

  async #handshake(): Promise<void> {
    const generation = ++this.#generation;
    try {
      const subscription = openClawRecord(await this.#transport.request("sessions.subscribe", {}));
      if (subscription?.subscribed !== true) throw new Error("Subscription not acknowledged");
      const probe = openClawRecord(await this.#transport.request("sessions.list", { limit: 1 }));
      if (!Array.isArray(probe?.sessions)) throw new Error("Catalog not confirmed");
      if (generation !== this.#generation || this.#stopped || !this.#transport.ready) return;
      this.#ready = true; this.callbacks.ready();
      for (const ref of this.#resume.values()) {
        if (generation !== this.#generation || !this.isReady()) break;
        try { await this.#attach(ref); } catch { /* Old session was not confirmed; never replace it with another. */ }
      }
    } catch {
      if (generation !== this.#generation || this.#stopped || !this.#transport.ready) return;
      this.callbacks.log?.("OpenClaw Gateway session access is not ready");
      this.#retry = setTimeout(() => void this.#handshake(), 15_000); this.#retry.unref();
    }
  }

  #disconnect(): void {
    ++this.#generation; clearTimeout(this.#retry); this.#retry = undefined;
    this.#ready = false; this.#coverage.clear();
    for (const session of [...this.#sessions.values()]) this.#detach(session, "OpenClaw Gateway disconnected", !this.#stopped);
    if (!this.#stopped) this.callbacks.ready();
  }

  #detach(session: Session, reason: string, reconnect = false): void {
    if (this.#sessions.get(session.id) !== session) return;
    this.#sessions.delete(session.id);
    if (this.#byKey.get(session.ref.key) === session) this.#byKey.delete(session.ref.key);
    if (reconnect) {
      this.#resume.set(session.ref.id, session.ref);
      if (this.#resume.size > ACTIVE_LIMIT) this.#resume.delete(this.#resume.keys().next().value!);
    }
    if (!reconnect && session.subscribed && this.#transport.ready && !this.#stopped) {
      void this.#transport.request("sessions.messages.unsubscribe", { key: session.ref.key, subscriptionId: session.subscriptionId,
        ...(session.ref.agentId ? { agentId: session.ref.agentId } : {}) }).catch(() => undefined);
    }
    clearTimeout(session.timer); session.source.flushPending();
    if (session.announced && !this.#stopped) this.callbacks.offline(session.id, reason);
  }

  #current(session: Session): boolean { return this.isReady() && this.#sessions.get(session.id) === session; }
  directoryEntries(): RuntimeMetadata[] { return this.isReady() ? [...this.#sessions.values()].filter(session => session.announced).map(session => this.#metadata(session)) : []; }
  #metadata(session: Session): RuntimeMetadata {
    return { runtimeId: session.id, sessionId: session.ref.id, name: "OpenClaw", cwd: session.ref.cwd,
      ...(session.ref.name ? { sessionName: session.ref.name } : {}), status: session.turn || session.busy ? "running" : "idle", sessionGraphSync: true,
      sessionLeafId: session.entries.at(-1)?.entryId ?? null };
  }

  async readRunningSessions(): Promise<NativeRunningSession[]> {
    const generation = this.#generation;
    const sessions = new Map<string, NativeRunningSession>();
    const signal = AbortSignal.timeout(4_000);
    let offset = 0;
    for (let page = 0; page < 3; page++) {
      const result = openClawRecord(await this.#transport.request("sessions.list", { activeOnly: true, archived: false,
        limit: 200, offset, includeDerivedTitles: true, excludeCron: true, excludeSubagents: true, excludeSystem: true, excludeDock: true }, { signal }));
      if (generation !== this.#generation || !this.isReady() || !Array.isArray(result?.sessions) || result.sessions.length > 200)
        throw new Error("OpenClaw running session list unavailable");
      for (const item of result.sessions) {
        const row = openClawRecord(item);
        if (!row || !(row.hasActiveRun === true || Array.isArray(row.activeRunIds) && row.activeRunIds.some(id => clawText(id, 256)))) continue;
        const ref = this.#identity(row);
        if (ref && !ref.archived) sessions.set(ref.id, { sessionId: ref.id, ...(ref.name ? { name: ref.name } : {}) });
      }
      const next = clawInt(result.nextOffset);
      if (result.hasMore !== true || next === undefined || next <= offset) break;
      offset = next;
    }
    return [...sessions.values()];
  }

  async catalog(archived = false): Promise<AgentSessionSummary[]> {
    const generation = this.#generation;
    const rows = new Map<string, AgentSessionSummary>();
    let offset = 0, complete = false;
    const observed = new Map<string, SessionRef>();
    try {
      for (let page = 0; page < Math.ceil(CATALOG_LIMIT / 200); page++) {
        const response = openClawRecord(await this.#rpc("sessions.list", { archived, limit: 200, offset, includeDerivedTitles: true,
          excludeCron: true, excludeSubagents: true, excludeSystem: true, excludeDock: true }));
        if (!Array.isArray(response?.sessions) || response.sessions.length > 200) throw new Error("OpenClaw catalog response is invalid");
        for (const item of response.sessions) {
          const row = openClawRecord(item); if (!row) continue;
          const ref = this.#ref(row); if (!ref || ref.archived !== archived) continue;
          observed.set(ref.id, ref);
          const modifiedAt = clawTime(row.updatedAt);
          const modelProvider = clawText(row.modelProvider, 128);
          rows.set(ref.id, { sessionId: ref.id, agentKind: this.kind, cwd: ref.cwd, hostname: hostname(), ...(ref.name ? { name: ref.name } : {}),
            createdAt: clawTime(row.createdAt ?? modifiedAt), modifiedAt, messageCount: Math.min(100_000, clawInt(row.messageCount) ?? 0),
            ...(modelProvider ? { modelProvider } : {}), archived });
        }
        if (response.hasMore === false) { complete = true; break; }
        const next = clawInt(response.nextOffset);
        if (response.hasMore !== true || next === undefined || next <= offset) throw new Error("OpenClaw catalog continuation is invalid");
        offset = next;
      }
      if (generation !== this.#generation || !this.isReady()) throw new Error("OpenClaw Gateway reconnected during catalog read");
      if (complete) for (const [id, ref] of this.#refs) if (ref.archived === archived && !observed.has(id)) this.#refs.delete(id);
      for (const [id, ref] of observed) this.#refs.set(id, ref);
      return [...rows.values()];
    } finally { if (generation === this.#generation) this.#coverage.set(archived, complete); }
  }

  async #find(id: string): Promise<SessionRef> {
    if (!id.startsWith(this.#namespace)) throw new ActivationError("session_not_found", "Not an OpenClaw session on this Gateway");
    const found = this.#refs.get(id) ?? [...this.#sessions.values()].find(item => item.ref.id === id)?.ref;
    if (found) return found;
    await Promise.all([this.catalog(), this.catalog(true)]);
    const next = this.#refs.get(id);
    if (!next) throw new ActivationError("session_not_found", "OpenClaw Gateway did not return this session");
    return next;
  }

  async sessionConfiguration(cwd: string): Promise<SessionConfigurationCatalog> {
    if (!this.isReady()) throw new ActivationError("agent_unsupported", "OpenClaw Gateway is offline");
    if (!localPath(cwd)) throw new ActivationError("cwd_missing", "OpenClaw requires an absolute workspace path");
    return { binding: `${this.#namespace}defaults`, defaults: { permissions: {} }, models: [], permissions: [] };
  }

  async activate(target: AgentActivateTarget, context?: AgentActivateContext): Promise<BackendActivation> {
    if (target.type === "resume" && !target.sessionId.startsWith(this.#namespace)) throw new ActivationError("session_not_found", "Not an OpenClaw session on this Gateway");
    if (!this.isReady()) throw new ActivationError("agent_unsupported", "OpenClaw Gateway is offline");
    let ref: SessionRef;
    if (target.type === "new") {
      await this.sessionConfiguration(target.cwd);
      if (context?.configuration?.model !== undefined || context?.configuration?.thinking !== undefined || Object.keys(context?.configuration?.permissions ?? {}).length > 0) {
        throw new ActivationError("agent_unsupported", "Configure the model and permissions in OpenClaw");
      }
      if (!context?.deviceId || !context.launchId) throw new ActivationError("agent_unsupported", "OpenClaw requires a durable launch identity");
      const key = this.#launchKey(context.deviceId, context.launchId);
      context?.requireCurrent?.();
      const response = openClawRecord(await this.#rpc("sessions.create", { key, idempotencyKey: key, cwd: target.cwd }));
      const entry = openClawRecord(response?.entry);
      const confirmed = this.#ref({ ...entry, key: response?.key, sessionId: response?.sessionId, agentId: response?.agentId });
      if (response?.ok !== true || !confirmed || !this.#matchesLaunch(confirmed, key, target.cwd) || confirmed.archived) {
        throw new Error("OpenClaw did not confirm the created session");
      }
      ref = confirmed; this.#refs.set(ref.id, ref); this.callbacks.catalog();
      await context?.onCreated?.({ sessionId: ref.id, spawnMode: "headless" });
    } else ref = await this.#find(target.sessionId);
    if (ref.archived) throw new ActivationError("session_not_found", "Restore this OpenClaw session before opening it");
    if (target.type === "resume") context?.requireCurrent?.();
    await this.#attach(ref);
    return { sessionId: ref.id, spawnMode: "headless" };
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    const ref = await this.#find(sessionId);
    const response = openClawRecord(await this.#rpc("sessions.patch", { key: ref.key, ...(ref.agentId ? { agentId: ref.agentId } : {}),
      expectedSessionId: ref.nativeId, archived }));
    const entry = openClawRecord(response?.entry);
    if (response?.ok !== true || response.key !== ref.key || entry?.sessionId !== ref.nativeId || (typeof entry.archivedAt === "number") !== archived) {
      throw new Error("OpenClaw did not confirm the archive change");
    }
    ref.archived = archived;
    if (archived) {
      const session = this.#byKey.get(ref.key); if (session?.ref.id === ref.id) this.#detach(session, "OpenClaw session archived");
    }
    this.#resume.delete(ref.id); this.callbacks.catalog();
  }

  async #attach(ref: SessionRef): Promise<void> {
    const previous = this.#byKey.get(ref.key);
    if (previous?.closing) {
      await previous.closing;
      return this.#attach(ref);
    }
    if (previous?.ref.id === ref.id && previous.announced) {
      this.#resume.delete(ref.id); this.callbacks.online(this.#metadata(previous)); return;
    }
    if (previous) this.#detach(previous, "OpenClaw session identity changed");
    if (this.#sessions.size >= ACTIVE_LIMIT) throw new Error("OpenClaw active session limit reached");
    const id = `${ref.id}:${randomUUID()}`;
    const session: Session = { ref, id, subscriptionId: randomUUID(), source: new RecoverableSessionSource(ref.id, event => {
      if (session.announced && this.#current(session)) this.callbacks.event(id, event);
    }, { coalesceMs: 60 }), preparer: new SessionSyncPreparer(), rows: [], entries: [], earlier: undefined,
    historyLine: Promise.resolve(), turn: undefined, streamId: undefined, streamText: "", settled: new Set(), timer: undefined,
    subscribed: false, announced: false, eventVersion: 0, lastHistoryAt: 0, inputPending: undefined, busy: false,
    viewGeneration: randomUUID() };
    this.#sessions.set(id, session); this.#byKey.set(ref.key, session);
    try {
      const subscription = openClawRecord(await this.#rpc("sessions.messages.subscribe", { key: ref.key, subscriptionId: session.subscriptionId, ...(ref.agentId ? { agentId: ref.agentId } : {}) }));
      if (subscription?.subscribed !== true || subscription.key !== ref.key) throw new Error("OpenClaw session subscription is unavailable");
      session.subscribed = true;
      await this.#read(session, false);
      if (!this.#current(session)) throw new Error("OpenClaw Gateway disconnected while opening the session");
      session.source.flushPending();
      session.announced = true; this.#resume.delete(ref.id);
      this.callbacks.online(this.#metadata(session));
      this.callbacks.event(id, { type: "runtime.capabilities", capabilities: { commands: [exitViewCapability(session.viewGeneration)] } });
      this.#hidden.delete(ref.nativeId);
    } catch (error) { this.#detach(session, "OpenClaw session could not be confirmed"); throw error; }
  }

  async #closeView(session: Session, commandId: string): Promise<void> {
    const viewGeneration = session.viewGeneration;
    const subscriptionId = session.subscriptionId;
    try {
      const response = openClawRecord(await this.#transport.request("sessions.messages.unsubscribe", {
        key: session.ref.key, subscriptionId, ...(session.ref.agentId ? { agentId: session.ref.agentId } : {}),
      }));
      if (response?.unsubscribed !== true || response.key !== session.ref.key) throw new Error("OpenClaw Gateway did not confirm the view detach");
    } catch (error) {
      if (this.#sessions.get(session.id) === session) this.callbacks.event(session.id, { type: "command.result", commandId, ok: false,
        status: error instanceof Error && error.message.includes("confirm") ? "failure" : "unconfirmed", error: "OpenClaw 未确认退订" });
      return;
    }
    if (this.#sessions.get(session.id) !== session || session.viewGeneration !== viewGeneration || session.subscriptionId !== subscriptionId || !this.isReady()) {
      if (this.#sessions.get(session.id) === session) this.callbacks.event(session.id, { type: "command.result", commandId, ok: false, status: "failure", error: "attachment_changed" });
      return;
    }
    const activeRunIds = session.activeRunIds;
    this.#hidden.set(session.ref.nativeId, { ref: session.ref, idle: !session.busy && !session.turn,
      ...(activeRunIds ? { activeRunIds: [...activeRunIds] } : {}), ...(session.inFlightRunId ? { inFlightRunId: session.inFlightRunId } : {}) });
    clearTimeout(session.timer);
    session.source.flushPending();
    this.#resume.delete(session.ref.id);
    this.#sessions.delete(session.id);
    if (this.#byKey.get(session.ref.key) === session) this.#byKey.delete(session.ref.key);
    this.callbacks.event(session.id, { type: "command.result", commandId, ok: true, status: "success" });
    if (session.announced) this.callbacks.offline(session.id, "view_closed");
  }

  #hiddenRunIds(row: Record<string, unknown>): string[] | undefined {
    if (Array.isArray(row.activeRunIds)) return row.activeRunIds.flatMap(value => clawText(value, 256) ? [clawText(value, 256)!] : []);
    const inFlight = openClawRecord(row.inFlightRun);
    const runId = clawText(inFlight?.runId, 256);
    return runId ? [runId] : undefined;
  }

  #considerHidden(row: Record<string, unknown>, key: string | undefined, agentId: string | undefined): void {
    if (!key) return;
    const nativeId = clawText(row.sessionId, 256);
    if (!nativeId) return;
    const hidden = this.#hidden.get(nativeId);
    if (!hidden || hidden.ref.key !== key || hidden.ref.agentId !== undefined && agentId !== undefined && hidden.ref.agentId !== agentId) return;
    const activeRunIds = this.#hiddenRunIds(row);
    if (activeRunIds === undefined) return; // hasActiveRun without exact identity is not a new-work proof.
    const wasIdle = hidden.idle;
    hidden.idle = activeRunIds.length === 0;
    if (activeRunIds.length === 0) { hidden.activeRunIds = []; delete hidden.inFlightRunId; return; }
    const prior = new Set([...(hidden.activeRunIds ?? []), ...(hidden.inFlightRunId ? [hidden.inFlightRunId] : [])]);
    const isNew = wasIdle || activeRunIds.some(id => !prior.has(id));
    hidden.activeRunIds = activeRunIds;
    if (activeRunIds[0]) hidden.inFlightRunId = activeRunIds[0]; else delete hidden.inFlightRunId;
    if (isNew) void this.#attach(hidden.ref).catch(() => undefined);
  }

  #sessionRunPrefix(ref: SessionRef): string { return `${this.#runPrefix}${clawHash(ref.id).slice(0, 16)}:`; }
  #clientId(ref: SessionRef, runId: string): string | undefined {
    const prefix = this.#sessionRunPrefix(ref);
    if (!runId.startsWith(prefix)) return undefined;
    const encoded = runId.slice(prefix.length), decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return Buffer.from(decoded, "utf8").toString("base64url") === encoded ? clawText(decoded, 256) : undefined;
  }

  async #page(session: Session, cursor?: string): Promise<ClawHistoryPage> {
    const result = await this.#rpc("chat.history", { ...this.#address(session.ref), limit: 48, maxBytes: 196608,
      maxChars: 6000, toolResultMaxChars: 256, ...(cursor ? { cursor } : {}) });
    if (!this.#current(session)) throw new Error("OpenClaw history source changed during read");
    const response = openClawRecord(result);
    if (response && response.sessionKey === session.ref.key && response.sessionId !== session.ref.nativeId) {
      this.#refs.delete(session.ref.id); this.#resume.delete(session.ref.id); this.#detach(session, "OpenClaw replaced this session");
    }
    return readClawHistory(result, session.ref.key, session.ref.nativeId, runId => this.#clientId(session.ref, runId));
  }

  /** One FIFO per attached session; older reads use a Gateway cursor pinned to the native transcript. */
  #read(session: Session, older: boolean): Promise<void> {
    const pending = session.historyLine.then(async () => {
      if (!this.#current(session)) throw new Error("OpenClaw session is offline");
      const version = session.eventVersion;
      let rows: ClawHistoryPage["rows"], earlier: ClawHistoryPage | undefined, page: ClawHistoryPage;
      if (older) {
        page = session.earlier ?? { rows: [] };
        if (!session.earlier || session.rows.length + page.rows.length > HISTORY_LIMIT) return;
        earlier = page.older ? await this.#page(session, page.older) : undefined;
        rows = [...page.rows, ...session.rows];
      } else {
        page = await this.#page(session);
        const first = page.rows[0];
        const index = first ? session.rows.findIndex(row => row.id === first.id) : -1;
        if (index >= 0 && index + page.rows.length <= HISTORY_LIMIT) {
          rows = [...session.rows.slice(0, index), ...page.rows]; earlier = session.earlier;
        } else {
          rows = page.rows;
          earlier = page.older ? await this.#page(session, page.older) : undefined;
        }
      }
      if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("OpenClaw history ranges overlap unexpectedly");
      if (earlier && earlier.rows.length === 0) {
        if (earlier.older) throw new Error("OpenClaw history cannot anchor the older range");
        earlier = undefined;
      }
      session.rows = rows; session.earlier = earlier;
      const boundary = earlier?.rows.at(-1)?.id ?? null;
      const prior = new Map(session.entries.map(entry => [entry.entryId, entry]));
      const entries = rows.map((row, index): RemoteSessionEntry => {
        const entry = { ...row.entry, parentId: rows[index - 1]?.id ?? boundary };
        const previous = prior.get(entry.entryId);
        return previous && isDeepStrictEqual(previous, entry) ? previous : entry;
      });
      if (entries.length !== session.entries.length || entries.some((entry, index) => entry !== session.entries[index])) {
        session.entries = entries; session.preparer.invalidate();
      }
      const observedRun = page.inFlight;
      const runId = clawText(observedRun?.runId, 256);
      if (!older && version === session.eventVersion) {
        session.lastHistoryAt = Date.now();
          const info = page.info;
        const activeRunIds = Array.isArray(info?.activeRunIds)
          ? info.activeRunIds.flatMap(value => clawText(value, 256) ? [clawText(value, 256)!] : []) : undefined;
        if (activeRunIds) session.activeRunIds = activeRunIds; else delete session.activeRunIds;
        if (runId) session.inFlightRunId = runId; else delete session.inFlightRunId;
        if (session.turn && (info?.hasActiveRun === false || activeRunIds !== undefined && !activeRunIds.includes(session.turn.id)) && runId !== session.turn.id) {
          this.#finish(session, session.turn, "unknown");
        }
        const busyKnown = info?.hasActiveRun !== undefined || activeRunIds !== undefined || runId !== undefined;
        const busy = activeRunIds !== undefined ? activeRunIds.length > 0 : runId !== undefined || info?.hasActiveRun === true;
        if (busyKnown && busy !== session.busy) {
          session.busy = busy;
          if (session.announced && !session.turn) this.callbacks.event(session.id, { type: "runtime.status", status: busy ? "running" : "idle" });
        }
        if (runId && !session.settled.has(runId)) {
          const startedAt = clawTime(observedRun?.startedAt) || Date.now();
          this.#begin(session, runId, startedAt);
          const turn = session.turn;
          const seq = clawInt(observedRun?.seq);
          if (turn?.id === runId && (turn.seq < 0 || seq !== undefined && seq >= turn.seq)) {
            const message = clawMessage({ role: "assistant", content: typeof observedRun?.text === "string" ? observedRun.text.slice(0, STREAM_TEXT_LIMIT) : undefined }, this.#streamId(runId), startedAt);
            if (message) {
              if (seq !== undefined) { turn.seq = seq; turn.gap = false; }
              this.#publishStream(session, runId, message, false);
            }
          }
        }
        const nativeName = clawText(page.info?.displayName, 256);
        if (nativeName) session.ref.name = nativeName;
      }
      // One native run may commit several assistant occurrences. Bind a live tail only
      // when exactly one durable candidate identifies it; never reconcile by reply text.
      const matches = [...rows].filter(row => row.runId && session.streamId === this.#streamId(row.runId) &&
        openClawRecord(row.entry.data.message)?.role === "assistant");
      const committed = matches.length === 1 ? matches[0] : undefined;
      if (!session.turn && session.streamId && matches.length > 1) {
        session.source.replaceLive({ ...session.source.snapshot().live, messages: [] });
        session.streamId = undefined;
      }
      session.source.transaction(() => {
        session.source.setHistoryBoundary(boundary);
        session.source.reconcile(session.entries, session.entries.at(-1)?.entryId ?? null,
          committed && session.streamId && !session.turn ? [{ messageId: session.streamId, entryId: committed.id }] : []);
        session.source.setAvailability(true, true);
      });
      if (committed && !session.turn) session.streamId = undefined;
    });
    session.historyLine = pending.catch(() => undefined);
    return pending;
  }

  #scheduleRead(session: Session): void {
    if (session.timer || !this.#current(session)) return;
    session.timer = setTimeout(() => {
      session.timer = undefined;
      void this.#read(session, false).catch(() => { if (this.#current(session)) session.source.setAvailability(false, false); });
    }, 120); session.timer.unref();
  }

  #gap(): void {
    if (!this.isReady()) return;
    this.callbacks.catalog();
    for (const session of this.#sessions.values()) {
      ++session.eventVersion; session.lastHistoryAt = 0;
      if (session.turn) session.turn.gap = true;
      session.source.reestablish(); this.#scheduleRead(session);
    }
  }

  #streamId(runId: string): string { return `claw-live:${clawHash(runId)}`; }
  #begin(session: Session, id: string, startedAt: number): void {
    if (session.turn || session.settled.has(id)) return;
    if (session.streamId) {
      session.source.replaceLive({ ...session.source.snapshot().live, messages: [] });
      session.streamId = undefined;
    }
    session.streamText = "";
    session.turn = { id, startedAt, seq: -1, gap: false };
    const turnId = clawHash(id);
    session.source.observe({ type: "turn.started", turnId, startedAt });
    if (session.announced) this.callbacks.event(session.id, { type: "runtime.status", status: "running" });
  }

  #event(event: Parameters<OpenClawGatewayEvents["event"]>[0]): void {
    if (!this.isReady()) return;
    const data = openClawRecord(event.payload);
    if (!data) return;
    const key = clawText(data.sessionKey, 512);
    const session = key ? this.#byKey.get(key) : undefined;
    if (event.event === "sessions.changed") {
      this.callbacks.catalog();
      const row = openClawRecord(data.session) ?? data;
      const changedKey = key ?? clawText(row.key, 512);
      const changedAgent = clawText(data.agentId, 128) ?? clawText(row?.agentId, 128);
      if (row) {
        for (const [hiddenId, hidden] of this.#hidden) if (changedKey === hidden.ref.key && hiddenId !== clawText(row.sessionId, 256)) this.#hidden.delete(hiddenId);
        this.#considerHidden(row, changedKey, changedAgent);
      }
      if (session) {
        if ((row?.sessionId === session.ref.nativeId && row.archived === true) || (data.sessionId === session.ref.nativeId && data.archived === true)) {
          session.ref.archived = true; this.#hidden.delete(session.ref.nativeId); this.#detach(session, "OpenClaw session archived");
        } else { ++session.eventVersion; this.#scheduleRead(session); }
      }
      return;
    }
    if (!session || !this.#current(session) || (session.ref.agentId && data.agentId !== undefined && data.agentId !== session.ref.agentId) ||
        (data.sessionId !== undefined && data.sessionId !== session.ref.nativeId)) return;
    if (event.event === "session.message") { ++session.eventVersion; this.#scheduleRead(session); return; }
    if (event.event !== "chat") return;
    const runId = clawText(data.runId, 256), seq = clawInt(data.seq), state = data.state;
    if (!runId || seq === undefined || session.settled.has(runId) || !["status", "delta", "final", "error", "aborted"].includes(String(state))) return;
    ++session.eventVersion;
    this.#begin(session, runId, Date.now());
    const turn = session.turn;
    if (!turn || turn.id !== runId || seq < turn.seq || seq === turn.seq && (state === "status" || state === "delta")) return;
    const gap = turn.seq >= 0 && seq > turn.seq + 1;
    if (gap) { turn.gap = true; this.#scheduleRead(session); }
    turn.seq = seq;
    const terminal = state === "final" || state === "error" || state === "aborted";
    session.source.transaction(() => {
      const raw = openClawRecord(data.message);
      let message = raw?.role === "assistant" ? clawMessage(raw, this.#streamId(runId), turn.startedAt) : undefined;
      if (message || data.replace === true && typeof data.deltaText === "string") turn.gap = false;
      if (!message && state === "delta" && typeof data.deltaText === "string" && !turn.gap) {
        const text = (data.replace === true ? data.deltaText : session.streamText + data.deltaText).slice(0, STREAM_TEXT_LIMIT);
        message = clawMessage({ role: "assistant", content: text }, this.#streamId(runId), turn.startedAt);
      }
      if (!message && terminal && session.streamId) {
        message = session.source.snapshot().live.messages.find(item => item.message.messageId === session.streamId)?.message;
      }
      if (message) this.#publishStream(session, runId, message, terminal, terminal && !turn.gap && raw?.role === "assistant");
      if (terminal) this.#finish(session, turn, state === "final" ? "completed" : state === "aborted" ? "cancelled" : "failed");
    });
    if (terminal) this.#scheduleRead(session);
  }

  #publishStream(session: Session, runId: string, message: NonNullable<ReturnType<typeof clawMessage>>, finished: boolean, complete = false): void {
    session.streamId = this.#streamId(runId);
    let remaining = STREAM_TEXT_LIMIT;
    const content = message.content.flatMap(part => {
      if (part.type !== "text" && part.type !== "thinking" || remaining === 0) return [];
      const text = part.text.slice(0, remaining); remaining -= text.length;
      return [{ ...part, text }];
    });
    session.streamText = content.filter(part => part.type === "text").map(part => part.text).join("");
    session.source.upsertMessage({ message: { ...message, content }, finished, contentComplete: complete && remaining > 0 });
  }

  #finish(session: Session, turn: Turn, outcome: "completed" | "failed" | "cancelled" | "unknown"): void {
    session.settled.add(turn.id);
    if (session.settled.size > 64) session.settled.delete(session.settled.values().next().value!);
    session.turn = undefined; session.busy = false;
    session.source.observe({ type: "turn.finished", turnId: clawHash(turn.id), startedAt: turn.startedAt,
      durationMs: Math.max(0, Date.now() - turn.startedAt), outcome });
    if (session.announced) this.callbacks.event(session.id, { type: "runtime.status", status: "idle" });
  }

  dispatchCommand(runtimeId: string, commandId: string, command: RuntimeCommand): CommandDispatch {
    const session = this.#sessions.get(runtimeId);
    if (!session?.announced || !this.#current(session)) return "offline";
    if (command.type === "session.close") {
      if (session.closing || !matchesViewExit(command, session.ref.id, session.viewGeneration)) return "unsupported";
      const pending = this.#closeView(session, commandId);
      session.closing = pending;
      void pending.finally(() => { if (session.closing === pending) delete session.closing; });
      return "handled";
    }
    if (session.closing) return "offline";
    if (command.type !== "session.sync" && command.type !== "user_message" && command.type !== "stop") return "unsupported";
    const reply = (event: RuntimeEvent): void => { if (this.#current(session)) this.callbacks.event(runtimeId, event); };
    void this.#command(session, commandId, command, reply).catch(error => {
      reply({ type: "command.result", commandId, ok: false, status: error instanceof UnconfirmedClawWrite ? "unconfirmed" : "failure",
        error: error instanceof Error ? error.message : "OpenClaw request failed" });
    });
    return "handled";
  }

  async #command(session: Session, commandId: string, command: Extract<RuntimeCommand, { type: "session.sync" | "user_message" | "stop" }>, reply: (event: RuntimeEvent) => void): Promise<void> {
    switch (command.type) {
      case "session.sync": {
        if (command.sessionId !== session.ref.id) throw new Error("OpenClaw session identity mismatch");
        if (command.range === "history" || command.range === "catchup") {
          const boundary = command.range === "history" ? command.beforeEntryId : command.knownLeafId;
          if (command.range === "catchup" && !session.source.version.ready) await this.#read(session, false);
          for (let i = 0; i < 3 && session.earlier && (boundary ? session.entries.findIndex(entry => entry.entryId === boundary) <= 0 : false); i++) await this.#read(session, true);
        } else if (!session.source.version.ready || Date.now() - session.lastHistoryAt > 750) await this.#read(session, false);
        session.source.flushPending();
        reply(session.preparer.select({ entries: session.entries, sessionId: session.ref.id, leafId: session.entries.at(-1)?.entryId ?? null,
          request: command, source: session.source.published(), ...(session.entries[0]?.parentId ? { historyBoundaryParentId: session.entries[0].parentId } : {}) }));
        break;
      }
      case "user_message": {
        if (command.attachments?.length) throw new Error("OpenClaw attachments are not supported by Orbis");
        if (command.text.trimStart().startsWith("/")) throw new Error("OpenClaw slash commands are not supported by Orbis");
        const clientId = command.messageId ?? commandId;
        const encoded = Buffer.from(clientId).toString("base64url");
        if (!encoded || encoded.length > 200) throw new Error("OpenClaw message ID exceeds the supported limit");
        const runId = `${this.#sessionRunPrefix(session.ref)}${encoded}`;
        if (session.inputPending || session.busy && !session.turn || session.turn && session.turn.id !== runId) throw new Error("OpenClaw is already running a turn in this session");
        reply({ type: "command.result", commandId, ok: true, status: "pending" });
        session.inputPending = runId;
        let response: Record<string, unknown> | undefined;
        try {
          response = openClawRecord(await this.#write("chat.send", { ...this.#address(session.ref), sessionId: session.ref.nativeId,
            message: command.text, idempotencyKey: runId, deliver: false }));
        } finally { session.inputPending = undefined; }
        if (!this.#current(session)) return;
        if (response?.runId !== runId) throw new UnconfirmedClawWrite();
        if (response.status === "started" || response.status === "in_flight") this.#begin(session, runId, Date.now());
        else if (response.status !== "ok" && response.status !== "queued") throw new UnconfirmedClawWrite();
        this.#scheduleRead(session);
        break;
      }
      case "stop": {
        const active = session.turn;
        if (!active) throw new Error("Orbis has no confirmed OpenClaw turn to stop");
        const response = openClawRecord(await this.#write("chat.abort", { ...this.#address(session.ref), sessionId: session.ref.nativeId, runId: active.id }));
        if (response?.aborted !== true) throw new Error("OpenClaw did not stop this turn");
        break;
      }
    }
    reply({ type: "command.result", commandId, ok: true, status: "success" });
  }

  async #rpc(method: OpenClawMethod, params: object): Promise<unknown> {
    try { return await this.#transport.request(method, params); }
    catch { throw new Error(`OpenClaw Gateway did not confirm ${method}`); }
  }
  async #write(method: "chat.send" | "chat.abort", params: object): Promise<unknown> {
    let sent = false;
    try { return await this.#transport.request(method, params, { onSent: () => { sent = true; } }); }
    catch (error) {
      if (sent && (!(error instanceof GatewayClientRequestError) || error.retryable || error.code === "UNAVAILABLE")) throw new UnconfirmedClawWrite();
      throw new Error(`OpenClaw Gateway rejected ${method}`);
    }
  }
}

class UnconfirmedClawWrite extends Error {
  constructor() { super("OpenClaw Gateway has not confirmed this action; check the conversation before retrying"); }
}
