import { createHash, randomUUID } from "node:crypto";

import { agentKeyId, type AgentExecutionState, type AgentKey, type AgentKind, type SessionLiveState } from "@orbis/protocol";

import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";
import { relayHttpBase } from "./config.js";

export type LiveActivityOutcome = "completed" | "failed" | "cancelled" | "unknown";
export type LiveActivityContentState = {
  version: 1;
  phase: "running" | "attention" | "ended" | "stale";
  runningCount: number;
  pendingCount: number;
  focusKey: string | null;
  agentKind: AgentKind | null;
  startedAt: number | null;
  updatedAt: number;
  outcome: LiveActivityOutcome | null;
};

export type LiveActivityUpdateRequest = {
  version: 1;
  hostId: string;
  producerId: string;
  revision: number;
  event: "update" | "end";
  contentState: LiveActivityContentState;
};

/** LA-H01: this same compact JSON tuple is hashed by the iOS routing cache. */
export function liveActivityFocusKey(key: AgentKey): string {
  return createHash("sha256").update(JSON.stringify([key.hostId, key.agentKind, key.sessionId]), "utf8").digest("hex");
}

type AgentScope = Extract<StateScope, { kind: "agent" }>;
type Tracked = {
  scope: AgentScope;
  active: boolean;
  turnId: string | null;
  startedAt: number | null;
  outcome: LiveActivityOutcome | null;
  removed: boolean;
  backgroundAgentWork: boolean;
  backgroundContinued: boolean;
};
type SemanticState = Omit<LiveActivityContentState, "updatedAt">;

type LiveActivityPublisherOptions = {
  registry: AgentStateRegistry;
  hostId: string;
  relayUrl: string;
  credential: string;
  now?: () => number;
  producerId?: string;
  /** Ordinary changes coalesce; a quiet activity only needs a bounded freshness renewal. */
  includeAgent?: (key: AgentKey) => boolean;
  coalesceMs?: number;
  heartbeatMs?: number;
  terminalCoalesceMs?: number;
  retryMs?: number;
  send?: (request: LiveActivityUpdateRequest, signal: AbortSignal) => Promise<number>;
  log?: (message: string) => void;
};

/** One privacy-preserving activity summary per Host. The committed registry is the
 * only business authority; push is an optional, serialized projection of it. */
export class LiveActivityPublisher {
  readonly #options: LiveActivityPublisherOptions;
  readonly #now: () => number;
  readonly #send: (request: LiveActivityUpdateRequest, signal: AbortSignal) => Promise<number>;
  readonly #producerId: string;
  readonly #unsubscribe: () => void;
  readonly #tracked = new Map<string, Tracked>();
  #summary: SemanticState | undefined;
  #fingerprint: string | undefined;
  #focus: string | undefined;
  #revision = 0;
  #lastPublicationAt = 0;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #connected = false;
  #connectionGeneration = 0;
  #unsupported = false;
  #closing = false;
  #closed = false;
  #collectQueued = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerDue = Number.POSITIVE_INFINITY;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #desired: LiveActivityUpdateRequest | undefined;
  #sending: Promise<void> | undefined;
  #controller: AbortController | undefined;

  constructor(options: LiveActivityPublisherOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#producerId = options.producerId ?? randomUUID();
    const endpoint = new URL("/v1/live-activities/update", relayHttpBase(options.relayUrl));
    this.#send = options.send ?? (async (request, signal) => {
      // APNs registration credentials are never forwarded through a redirect or plain HTTP.
      if (endpoint.protocol !== "https:") return 501;
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${options.credential}`, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      // Drain the small response so the pooled connection can be reused.
      await response.arrayBuffer();
      return response.status;
    });
    this.#unsubscribe = options.registry.subscribe(change => {
      if (this.#closing || this.#closed) return;
      if (change.kind === "reset") { this.#queueCollection(); return; }
      if (change.scope.kind !== "agent" || change.scope.key.hostId !== options.hostId || options.includeAgent?.(change.scope.key) === false ||
          !["execution", "availability"].includes(change.domain)) return;
      const id = agentKeyId(change.scope.key);
      const tracked = this.#tracked.get(id);
      if (change.kind === "closed") {
        if (tracked) tracked.removed = true;
      } else if (tracked) {
        tracked.removed = false;
      } else {
        // The registry itself is bounded. Keep a smaller bound for this optional projection.
        if (this.#tracked.size >= 2048) {
          const retired = [...this.#tracked].find(([, item]) => !item.active);
          if (retired) this.#tracked.delete(retired[0]);
          else return;
        }
        this.#tracked.set(id, { scope: change.scope, active: false, turnId: null, startedAt: null, outcome: null, removed: false,
          backgroundAgentWork: false, backgroundContinued: false });
      }
      this.#queueCollection();
    });
  }

  /** An old Relay is probed only once per real connection generation. */
  setConnected(connected: boolean): void {
    if (this.#closed || this.#closing || connected === this.#connected) return;
    this.#connected = connected;
    this.#connectionGeneration += 1;
    this.#clearTimer();
    clearInterval(this.#heartbeat); this.#heartbeat = undefined;
    if (!connected) { this.#controller?.abort(); return; }
    this.#unsupported = false;
    this.#heartbeat = setInterval(() => {
      if (this.#summary?.phase === "running" || this.#summary?.phase === "attention") this.#publish();
    }, this.#options.heartbeatMs ?? 240_000);
    this.#heartbeat.unref();
    this.#queueCollection();
    if (this.#summary) this.#schedule(0);
  }

  /** Shutdown is uncertainty, not successful task completion. Send that fact while
   * the authenticated Host Relay socket is still available, then release resources. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#closing) { await this.#sending; return; }
    this.#closing = true;
    this.#unsubscribe(); this.#clearTimer();
    clearInterval(this.#heartbeat); this.#heartbeat = undefined;
    if (this.#summary) {
      if (this.#summary.phase !== "ended") this.#summary = { ...this.#summary, phase: "stale", outcome: null };
      this.#publish();
    }
    await this.#sending;
    this.#closed = true; this.#connected = false;
    this.#desired = undefined; this.#controller?.abort(); this.#clearTimer();
  }

  #queueCollection(): void {
    if (this.#collectQueued) return;
    this.#collectQueued = true;
    queueMicrotask(() => {
      this.#collectQueued = false;
      if (!this.#closing && !this.#closed) this.#collect();
    });
  }

  #collect(): void {
    const previous = this.#summary;
    const running: Array<[string, Tracked]> = [];
    const attention: Array<[string, Tracked, number]> = [];
    const uncertain: Array<[string, Tracked]> = [];
    for (const [id, tracked] of this.#tracked) {
      const execution = this.#options.registry.read<AgentExecutionState>(tracked.scope, "execution");
      const availability = this.#options.registry.read<{ connected: boolean }>(tracked.scope, "availability");
      const ready = execution?.availability === "ready" && execution.completeness === "complete" && execution.value !== null &&
        availability?.availability === "ready" && availability.completeness === "complete" && availability.value?.connected === true;
      if (!ready && !tracked.removed) {
        if (tracked.active) uncertain.push([id, tracked]);
        continue;
      }
      const value = ready ? execution!.value! : null;
      const tasks = value?.tasks;
      const tasksConfirmed = tasks?.availability === "ready" && !tasks.truncated && !tasks.items.some(item => item.status === "unknown");
      // S60 / SC108: a parent with child agents is still working. Shells and
      // monitors alone deliberately leave its main session idle.
      const backgroundAgents = tasksConfirmed && tasks.items.some(item =>
        item.kind !== "shell" && item.kind !== "monitor" && ["pending", "running", "waiting"].includes(item.status));
      if (value?.phase === "idle" && !tasksConfirmed && tracked.active && tracked.backgroundAgentWork) {
        uncertain.push([id, tracked]);
        continue;
      }
      if (value && (value.phase !== "idle" || backgroundAgents)) {
        const turnId = value.turn?.turnId ?? null;
        if (!tracked.active || tracked.turnId !== turnId) { tracked.outcome = null; tracked.backgroundContinued = false; }
        tracked.active = true; tracked.turnId = turnId;
        if (tasksConfirmed) tracked.backgroundAgentWork = backgroundAgents;
        if (value.phase === "idle" && backgroundAgents) tracked.backgroundContinued = true;
        const sourceStartedAt = value.turn?.startedAt;
        // Source clocks need not match this Host. Drop invalid/future elapsed
        // origins instead of rejecting an otherwise useful activity summary.
        tracked.startedAt = sourceStartedAt !== undefined && Number.isSafeInteger(sourceStartedAt) &&
          sourceStartedAt >= 0 && sourceStartedAt <= this.#now() ? sourceStartedAt : null;
        if (value.phase === "waiting_local_interaction") attention.push([id, tracked, Math.max(1, value.waitingFor.length)]);
        else running.push([id, tracked]);
      } else if (tracked.active || tracked.outcome !== null) {
        const live = this.#options.registry.read<SessionLiveState>(tracked.scope, "live");
        const outcome = live?.availability === "ready" && live.completeness === "complete" &&
          live.value?.turn?.turnId === tracked.turnId ? live.value.turn.outcome : undefined;
        // A completed parent turn cannot prove success of asynchronous agents
        // that kept working after that turn ended. Their final result is separate.
        tracked.outcome = outcome === "failed" || outcome === "cancelled" ? outcome :
          outcome === "completed" && !tracked.backgroundContinued ? "completed" : "unknown";
        tracked.active = false; tracked.backgroundAgentWork = false;
      }
    }
    if (previous?.phase === "ended" && (running.length > 0 || attention.length > 0)) {
      // A later run gets its own completion evidence; an earlier failed turn is not
      // allowed to contaminate a new batch of concurrently active sessions.
      for (const tracked of this.#tracked.values()) if (!tracked.active) tracked.outcome = null;
    }
    const candidates = attention.length > 0 ? attention : running.length > 0 ? running : uncertain;
    candidates.sort(([a], [b]) => a.localeCompare(b));
    const focus = candidates.find(([id]) => id === this.#focus) ?? candidates[0];
    if (focus) this.#focus = focus[0];
    const focused = focus?.[1] ?? (this.#focus ? this.#tracked.get(this.#focus) : undefined);
    const phase = attention.length > 0 ? "attention" : uncertain.length > 0 ? "stale" : running.length > 0 ? "running" : "ended";
    // Empty startup is not a terminal observation. A mobile activity may still be
    // waiting for the Host's first authenticated source baselines after restart.
    if (phase === "ended" && previous === undefined) return;
    const outcomes = [...this.#tracked.values()].flatMap(item => item.outcome ? [item.outcome] : []);
    const outcome = phase !== "ended" ? null : outcomes.includes("failed") ? "failed" : outcomes.includes("cancelled") ? "cancelled" :
      outcomes.length > 0 && outcomes.every(item => item === "completed") ? "completed" : "unknown";
    const summary: SemanticState = {
      version: 1, phase, runningCount: Math.min(2048, running.length),
      pendingCount: Math.min(131_072, attention.reduce((total, [, , count]) => total + count, 0)),
      focusKey: focused ? liveActivityFocusKey(focused.scope.key) : null,
      agentKind: focused?.scope.key.agentKind ?? null,
      startedAt: focused?.startedAt ?? null, outcome,
    };
    const fingerprint = JSON.stringify(summary);
    if (fingerprint === this.#fingerprint) return;
    this.#summary = summary; this.#fingerprint = fingerprint;
    const critical = summary.phase === "attention" && (previous?.phase !== "attention" || summary.pendingCount > previous.pendingCount);
    const delay = summary.phase === "ended" ? this.#options.terminalCoalesceMs ?? 250 :
      critical || summary.phase === "stale" || previous === undefined ? 0 : Math.max(0, this.#lastSentAt + (this.#options.coalesceMs ?? 30_000) - this.#now());
    this.#schedule(delay);
  }

  #schedule(delay: number): void {
    if (!this.#connected || this.#closed || this.#closing || this.#unsupported) return;
    const due = this.#now() + delay;
    if (this.#timer && this.#timerDue <= due) return;
    this.#clearTimer(); this.#timerDue = due;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#timerDue = Number.POSITIVE_INFINITY; this.#publish(); }, delay);
    this.#timer.unref();
  }

  #clearTimer(): void { clearTimeout(this.#timer); this.#timer = undefined; this.#timerDue = Number.POSITIVE_INFINITY; }

  #publish(): void {
    if (!this.#summary || !this.#connected || this.#unsupported || this.#closed) return;
    const updatedAt = Math.max(this.#now(), this.#lastPublicationAt + 1);
    this.#lastPublicationAt = updatedAt;
    this.#desired = {
      version: 1, hostId: this.#options.hostId, producerId: this.#producerId, revision: ++this.#revision,
      event: this.#summary.phase === "ended" ? "end" : "update", contentState: { ...this.#summary, updatedAt },
    };
    if (!this.#sending) {
      this.#sending = this.#drain().finally(() => {
        this.#sending = undefined;
        // A disconnect/reconnect can occur while an aborted send is finishing.
        if (this.#desired && this.#connected && !this.#closed && !this.#unsupported && !this.#timer) this.#schedule(0);
      });
    }
  }

  async #drain(): Promise<void> {
    while (this.#desired && this.#connected && !this.#closed && !this.#unsupported) {
      const request = this.#desired; this.#desired = undefined;
      const generation = this.#connectionGeneration;
      const controller = new AbortController(); this.#controller = controller;
      const timeout = setTimeout(() => controller.abort(), 5_000); timeout.unref();
      let status = 0;
      try { status = await this.#send(request, controller.signal); }
      catch { /* Optional push retries never break the committed business state. */ }
      finally { clearTimeout(timeout); if (this.#controller === controller) this.#controller = undefined; }
      if (generation !== this.#connectionGeneration) {
        // A reply owned by the previous authenticated socket cannot disable or
        // acknowledge this generation. Rebuild from the current summary instead.
        if (this.#connected) this.#schedule(0);
        return;
      }
      if (!this.#connected || this.#closed) { this.#desired ??= request; return; }
      if (status >= 200 && status < 300) { this.#lastSentAt = this.#now(); continue; }
      if ([401, 403, 404, 409, 501].includes(status)) {
        // Unknown endpoint, producer mismatch or rejected credentials wait for a
        // new authenticated Relay connection, never a request loop.
        this.#unsupported = true; this.#desired = undefined; return;
      }
      if (!this.#desired) this.#desired = request;
      if (!this.#closing) {
        this.#options.log?.(`Live Activity update deferred (${status || "transport"})`);
        this.#schedule(this.#options.retryMs ?? 30_000);
      }
      return;
    }
  }
}
