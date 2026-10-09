import { createHash } from "node:crypto";
import type { CodexAppServer } from "./codex-daemon.js";
import type { CodexRefreshAction, CodexRefreshDriver, CodexRefreshObservation, CodexRefreshOperation, CodexRefreshRequest } from "./codex-client-refresh.js";
import type { DesktopRefreshEndpoint, DesktopRefreshEvidence } from "./codex-desktop-refresh-bridge.js";
import { openCodexDesktopThread } from "./codex-desktop-app.js";

export type CodexDesktopRefreshOptions = {
  journalDirectory: string;
  resolveBridge: () => DesktopRefreshEndpoint | undefined;
};
type Options = CodexDesktopRefreshOptions & {
  server: CodexAppServer;
  revision: (threadId: string) => Promise<string>;
  localBusy: (threadId: string) => boolean;
  isSubscribed: (threadId: string) => boolean;
  restored: (threadId: string, snapshot: Record<string, unknown>) => void;
  protect: (threadId: string) => void;
  openThread?: (threadId: string, hostId: string) => Promise<void>;
};

const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];
// Archive eviction and local deep links verified from these desktop bundles. Unknown
// versions retain native revert and phone reconciliation, but require manual GUI reopening.
const COMPATIBLE_CLIENTS = new Set(["26.930.7945", "26.1002.7124"]);

export function desktopHistoryRevision(turns: unknown): string {
  return createHash("sha256").update(JSON.stringify(turns, (_key, child: unknown) => {
    if (child === null || typeof child !== "object" || Array.isArray(child)) return child;
    return Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  })).digest("hex");
}

/** Real Windows wrapper driver. It intentionally refuses native archive subtrees. */
export class CodexDesktopRefreshDriver implements CodexRefreshDriver {
  readonly #options: Options;
  readonly #resumed = new Set<string>();
  constructor(options: Options) { this.#options = options; }

  async prepare(request: CodexRefreshRequest): ReturnType<CodexRefreshDriver["prepare"]> {
    const bridge = this.#options.resolveBridge();
    if (bridge === undefined) return { ready: false, reason: "desktop_refresh_wrapper_upgrade_required" };
    const state = await this.#nativeState(request.threadId);
    if (!state.idle || state.queuedWork || this.#options.localBusy(request.threadId)) return { ready: false, reason: "desktop_refresh_thread_busy" };
    if (state.archived || !state.loaded || !this.#options.isSubscribed(request.threadId)) return { ready: false, reason: "desktop_refresh_thread_not_attached" };
    if (await this.#options.revision(request.threadId) !== request.historyRevision) return { ready: false, reason: "desktop_refresh_history_superseded" };
    const evidence = await this.#control(bridge, request, "begin");
    const version = evidence.clientVersion.replace(/\.0$/, "");
    if (!evidence.guiAttached || !COMPATIBLE_CLIENTS.has(version)) return { ready: false, reason: "desktop_refresh_client_version_unverified" };
    // Protect before any lifecycle side effect, including broadcasts preceding RPC replies.
    this.#options.protect(request.threadId);
    return { ready: true, plan: {
      client: { kind: "desktop", instanceId: bridge.instanceId, compatibilityVersion: version, desktopHostId: "local" },
      affected: [{ threadId: request.threadId, ...state, subscribed: true, pendingApproval: false }],
    } };
  }

  async inspect(operation: CodexRefreshOperation): Promise<CodexRefreshObservation> {
    const bridge = this.#options.resolveBridge();
    if (bridge === undefined || bridge.instanceId !== operation.plan.client.instanceId) {
      return { ownership: "lost", historyRevision: "unknown", scopeComplete: false, concurrentAction: "unknown", threads: [] };
    }
    const evidence = await this.#control(bridge, operation.request, "inspect");
    const state = await this.#nativeState(operation.request.threadId);
    const archivedByUs = evidence.archive === "applied";
    const subscribed = archivedByUs ? this.#resumed.has(operation.request.operationId) : this.#options.isSubscribed(operation.request.threadId);
    let inFlightStatus: CodexRefreshObservation["inFlightStatus"];
    if (operation.inFlight?.kind === "archive") inFlightStatus = settled(evidence.archive);
    if (operation.inFlight?.kind === "unarchive") inFlightStatus = settled(evidence.unarchive);
    if (operation.inFlight?.kind === "load" || operation.inFlight?.kind === "subscribe") inFlightStatus = subscribed ? "applied" : "not_applied";
    return {
      ownership: evidence.instanceId === bridge.instanceId && evidence.guiAttached ? "verified" : "lost",
      historyRevision: await this.#options.revision(operation.request.threadId), scopeComplete: true,
      concurrentAction: evidence.conflict ? "manual_archive" : this.#options.localBusy(operation.request.threadId) ? "new_work" : "none",
      threads: [{ threadId: operation.request.threadId, ...state, subscribed, pendingApproval: !state.idle,
        ...(archivedByUs ? { archivedBy: operation.request.operationId, unloadedBy: operation.request.operationId, unsubscribedBy: operation.request.operationId } : {}) }],
      ...(inFlightStatus === undefined ? {} : { inFlightStatus }),
      // Evidence comes from the GUI's own history response delivered after eviction, never
      // from our resume RPC. It proves transcript data delivery, not pixels being painted.
      ...(evidence.guiReloaded ? { hydratedHistoryRevision: operation.request.historyRevision } : {}),
    };
  }

  async perform(operation: CodexRefreshOperation, action: CodexRefreshAction): ReturnType<CodexRefreshDriver["perform"]> {
    const observed = await this.inspect(operation);
    if (observed.ownership !== "verified" || observed.concurrentAction !== "none"
      || observed.historyRevision !== operation.request.historyRevision
      || observed.threads.some(t => !t.idle || t.queuedWork || t.pendingApproval)) return { outcome: "not_applied", reason: "desktop_refresh_state_changed" };
    const bridge = this.#options.resolveBridge();
    if (bridge === undefined) return { outcome: "not_applied", reason: "desktop_refresh_wrapper_lost" };
    if (action.kind === "archive" || action.kind === "unarchive") {
      const evidence = await this.#control(bridge, operation.request, action.kind);
      return { outcome: evidence[action.kind] === "applied" ? "applied" : "unknown" };
    }
    if (action.kind === "load" || action.kind === "subscribe") {
      const response = object(await this.#options.server.request("thread/resume", { threadId: operation.request.threadId }));
      const snapshot = object(response.thread);
      if (snapshot.id !== operation.request.threadId) throw new Error("desktop_refresh_resume_identity_mismatch");
      this.#resumed.add(operation.request.operationId);
      this.#options.restored(operation.request.threadId, snapshot);
      return { outcome: "applied" };
    }
    if (action.kind === "open_desktop" && operation.plan.client.kind === "desktop") {
      await (this.#options.openThread ?? openCodexDesktopThread)(operation.request.threadId, operation.plan.client.desktopHostId);
      return { outcome: "applied" };
    }
    return { outcome: "not_applied", reason: "desktop_refresh_unsupported_action" };
  }

  async #control(bridge: DesktopRefreshEndpoint, request: CodexRefreshRequest, action: string): Promise<DesktopRefreshEvidence> {
    const response = await fetch(bridge.url, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: request.operationId, threadId: request.threadId, historyRevision: request.historyRevision, action }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("desktop_refresh_bridge_request_failed");
    const result = object(await response.json());
    if (result.instanceId !== bridge.instanceId || typeof result.clientVersion !== "string" || typeof result.conflict !== "boolean"
      || typeof result.guiAttached !== "boolean" || typeof result.guiReloaded !== "boolean"
      || !["not_started", "pending", "applied", "unknown"].includes(String(result.archive))
      || !["not_started", "pending", "applied", "unknown"].includes(String(result.unarchive))) throw new Error("desktop_refresh_invalid_evidence");
    return result as DesktopRefreshEvidence;
  }

  async #nativeState(threadId: string): Promise<{ archived: boolean; loaded: boolean; idle: boolean; queuedWork: boolean }> {
    // Explicitly include all native source kinds: default thread/list omits subagents.
    for (const archived of [false, true]) {
      const descendants = object(await this.#options.server.request("thread/list", {
        ancestorThreadId: threadId, archived, sourceKinds: SOURCE_KINDS, modelProviders: [], limit: 1,
      }));
      if (!Array.isArray(descendants.data) || descendants.data.length > 0 || descendants.nextCursor != null) throw new Error("desktop_refresh_subtree_requires_manual_reopen");
    }
    const loaded = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = object(await this.#options.server.request("thread/loaded/list", { ...(cursor === undefined ? {} : { cursor }) }));
      if (!Array.isArray(page.data) || page.data.some(id => typeof id !== "string")) throw new Error("desktop_refresh_loaded_state_unknown");
      for (const id of page.data as string[]) loaded.add(id);
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor !== undefined && cursors.has(cursor) || loaded.size > 2_048) throw new Error("desktop_refresh_loaded_state_unknown");
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    const snapshot = object(object(await this.#options.server.request("thread/read", { threadId, includeTurns: false })).thread);
    if (snapshot.id !== threadId || typeof snapshot.path !== "string") throw new Error("desktop_refresh_thread_state_unknown");
    const type = object(snapshot.status).type;
    const queue = !loaded.has(threadId) && type === "notLoaded" ? { data: [] } : object(await this.#options.server.request("thread/queue/list", { threadId }));
    if (!Array.isArray(queue.data)) throw new Error("desktop_refresh_queue_unknown");
    return { archived: snapshot.path.split(/[\\/]/u).includes("archived_sessions"), loaded: loaded.has(threadId),
      idle: type === "idle" || type === "notLoaded", queuedWork: queue.data.length > 0 || queue.nextCursor != null };
  }
}

function settled(value: DesktopRefreshEvidence["archive"]): CodexRefreshObservation["inFlightStatus"] {
  return value === "not_started" ? "not_applied" : value;
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
