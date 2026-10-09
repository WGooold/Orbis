import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { desktopHistoryRevision } from "./codex-desktop-refresh.js";

/** Private, authenticated loopback control. Never contains transcript text or activation data. */
export type DesktopRefreshEndpoint = { url: string; token: string; instanceId: string };
export type DesktopRefreshEvidence = {
  instanceId: string;
  clientVersion: string;
  guiAttached: boolean;
  conflict: boolean;
  archive: "not_started" | "pending" | "applied" | "unknown";
  unarchive: "not_started" | "pending" | "applied" | "unknown";
  guiReloaded: boolean;
};

type Operation = {
  id: string;
  threadId: string;
  conflict: boolean;
  archive: DesktopRefreshEvidence["archive"];
  unarchive: DesktopRefreshEvidence["unarchive"];
  /** Only GUI-originated history reads AFTER its archive notification count. */
  archiveDelivered: boolean;
  unarchiveDelivered: boolean;
  historyRevision: string;
  deliveredTurns: Set<string>;
  guiReloaded: boolean;
};
type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Lives in the desktop wrapper, independently of Host. Native RPC outcomes survive a Host
 * reconnect in this wrapper incarnation. A lost wrapper or unknown RPC result fails closed.
 * This first driver handles leaf threads only; callers must prove the absence of descendants.
 */
export class CodexDesktopRefreshBridge {
  readonly #instanceId = randomUUID();
  readonly #token = randomUUID();
  readonly #rpc: Rpc;
  readonly #operations = new Map<string, Operation>();
  readonly #guiReads = new Map<string | number, { method: string; full: boolean; descending: boolean; turnId?: string; operation?: string }>();
  #clientVersion = "";
  #guiAttached = false;
  #server: Server | undefined;

  constructor(rpc: Rpc) { this.#rpc = rpc; }

  async listen(): Promise<DesktopRefreshEndpoint> {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      const auth = request.headers.authorization;
      const expected = `Bearer ${this.#token}`;
      if (request.method !== "POST" || typeof auth !== "string" || Buffer.byteLength(auth) !== Buffer.byteLength(expected)
        || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
        response.writeHead(403); response.end("{}"); return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body) > 8_192) request.destroy();
      });
      request.on("end", () => {
        void (async () => {
          const result = await this.command(JSON.parse(body) as unknown);
          response.end(JSON.stringify(result));
        })().catch(() => { response.writeHead(400); response.end("{}"); });
      });
      request.on("error", () => response.destroy());
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.maxConnections = 8;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.#server = server;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("desktop_refresh_bind_failed");
    return { url: `http://127.0.0.1:${address.port}`, token: this.#token, instanceId: this.#instanceId };
  }

  close(): void { this.#server?.closeAllConnections(); this.#server?.close(); }

  async command(input: unknown): Promise<DesktopRefreshEvidence> {
    const value = object(input);
    if (!identity(value.operationId) || !identity(value.threadId)) throw new Error("invalid_refresh_identity");
    const id = value.operationId;
    let operation = this.#operations.get(id);
    if (value.action === "begin" && operation === undefined) {
      if (typeof value.historyRevision !== "string" || !/^[a-f0-9]{64}$/u.test(value.historyRevision)) throw new Error("invalid_refresh_revision");
      // Keep receipts across Host restarts. Bound memory rather than evicting provenance.
      if (this.#operations.size >= 256) throw new Error("desktop_refresh_receipt_limit");
      if ([...this.#operations.values()].some(o => o.threadId === value.threadId && o.archive === "pending")) {
        throw new Error("desktop_refresh_pending");
      }
      operation = { id, threadId: value.threadId, conflict: false, archive: "not_started", unarchive: "not_started",
        archiveDelivered: false, unarchiveDelivered: false, historyRevision: value.historyRevision, deliveredTurns: new Set(), guiReloaded: false };
      this.#operations.set(id, operation);
    }
    if (operation === undefined || operation.threadId !== value.threadId) throw new Error("desktop_refresh_provenance_lost");
    if (value.action === "archive" || value.action === "unarchive") {
      const action = value.action;
      if (operation.conflict || !this.#guiAttached) throw new Error("desktop_refresh_concurrent_action");
      if (action === "unarchive" && operation.archive !== "applied") throw new Error("desktop_refresh_archive_unconfirmed");
      if (operation[action] === "not_started") {
        // Mark before dispatch; a timed-out Host HTTP request cannot issue the RPC twice.
        operation[action] = "pending";
        try {
          for (const archived of [false, true]) {
            const descendants = object(await this.#rpc("thread/list", { ancestorThreadId: operation.threadId, archived,
              sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"], modelProviders: [], limit: 1 }));
            if (!Array.isArray(descendants.data) || descendants.data.length > 0 || descendants.nextCursor != null) {
              operation[action] = "not_started";
              throw new Error("desktop_refresh_subtree_requires_manual_reopen");
            }
          }
          const thread = object(object(await this.#rpc("thread/read", { threadId: operation.threadId, includeTurns: false })).thread);
          const status = object(thread.status);
          const queue = status.type === "notLoaded" ? { data: [] } : object(await this.#rpc("thread/queue/list", { threadId: operation.threadId }));
          if (status.type !== "idle" && status.type !== "notLoaded" || !Array.isArray(queue.data)
            || queue.data.length > 0 || queue.nextCursor != null || operation.conflict) {
            operation[action] = "not_started";
            throw new Error("desktop_refresh_thread_busy");
          }
          await this.#rpc(action === "archive" ? "thread/archive" : "thread/unarchive", { threadId: operation.threadId });
          operation[action] = "applied";
        } catch (error) {
          if (operation[action] === "pending") operation[action] = "unknown";
          throw error;
        }
      }
    } else if (value.action !== "begin" && value.action !== "inspect") throw new Error("invalid_refresh_action");
    return this.#evidence(operation);
  }

  #evidence(operation: Operation): DesktopRefreshEvidence {
    return { instanceId: this.#instanceId, clientVersion: this.#clientVersion, guiAttached: this.#guiAttached,
      conflict: operation.conflict, archive: operation.archive, unarchive: operation.unarchive, guiReloaded: operation.guiReloaded };
  }

  /** Observes frames only; it never edits, delays, drops or injects GUI protocol frames. */
  guiRequest(line: string): void {
    const frame = parse(line);
    if (frame.method === "initialize") {
      const info = object(object(frame.params).clientInfo);
      this.#clientVersion = typeof info.version === "string" ? info.version : "";
      this.#guiAttached = true;
    }
    const params = object(frame.params);
    const threadId = params.threadId;
    if (typeof threadId !== "string") return;
    // The desktop reads its queue when reopening. A read cannot invalidate the
    // refresh's ownership; actual queue edits and turn/lifecycle mutations still can.
    if (typeof frame.method === "string" && frame.method !== "thread/queue/list"
      && (/^(turn\/|thread\/(archive|unarchive|delete|revert|queue\/))/.test(frame.method))) {
      for (const operation of this.#operations.values()) if (operation.threadId === threadId) operation.conflict = true;
    }
    if ((frame.method === "thread/resume" || frame.method === "thread/read" || frame.method === "thread/turns/list" || frame.method === "thread/items/list")
      && (typeof frame.id === "string" || typeof frame.id === "number")) {
      if (this.#guiReads.size >= 512) { this.#guiReads.clear(); return; }
      const operation = [...this.#operations.values()].reverse().find(o => o.threadId === threadId && o.archiveDelivered && !o.conflict);
      this.#guiReads.set(frame.id, { method: frame.method,
        full: frame.method === "thread/resume" || frame.method === "thread/read" && params.includeTurns === true
          || frame.method === "thread/turns/list" && params.itemsView === "full" && params.cursor == null,
        descending: params.sortDirection !== "asc", ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
        ...(operation === undefined ? {} : { operation: operation.id }) });
    }
  }

  guiResponse(line: string): void {
    const frame = parse(line);
    const params = object(frame.params);
    for (const operation of this.#operations.values()) {
      if (params.threadId !== operation.threadId) continue;
      // Successful own archive/unarchive requests provide provenance; all other changes
      // are concurrent. A broadcast alone is never used as an ownership receipt.
      if (frame.method === "thread/archived") {
        if (operation.archiveDelivered || operation.archive === "not_started") operation.conflict = true;
        operation.archiveDelivered = true;
      }
      if (frame.method === "thread/unarchived") {
        if (operation.unarchiveDelivered || operation.unarchive === "not_started") operation.conflict = true;
        operation.unarchiveDelivered = true;
      }
      if (frame.method === "turn/started" || frame.method === "thread/reverted") operation.conflict = true;
    }
    // Server requests have their own ID space and can share a GUI request's ID.
    if (typeof frame.method === "string" || typeof frame.id !== "string" && typeof frame.id !== "number") return;
    const read = this.#guiReads.get(frame.id);
    this.#guiReads.delete(frame.id);
    if (read?.operation === undefined || frame.error != null) return;
    const operation = this.#operations.get(read.operation);
    const result = object(frame.result);
    if (operation === undefined || !operation.unarchiveDelivered || operation.conflict) return;
    // The paginated GUI first requests turns with itemsView=notLoaded and then loads
    // items separately. Observe that actual GUI data flow instead of requiring a full
    // legacy resume transcript that modern desktop versions never request.
    if (read.method === "thread/turns/list" && Array.isArray(result.data)) {
      for (const turn of result.data) {
        const id = object(turn).id;
        if (typeof id === "string" && operation.deliveredTurns.size < 2_048) operation.deliveredTurns.add(id);
      }
      if (result.data.length === 0 && result.nextCursor == null && desktopHistoryRevision([]) === operation.historyRevision) operation.guiReloaded = true;
    }
    if (read.method === "thread/items/list" && read.turnId !== undefined && operation.deliveredTurns.has(read.turnId)
      && Array.isArray(result.data)) operation.guiReloaded = true;
    const turns = read.method === "thread/turns/list" ? result.data : object(result.thread).turns;
    if (read.full && Array.isArray(turns)
      && (read.method !== "thread/turns/list" || result.nextCursor == null)) {
      const ordered = read.method === "thread/turns/list" && read.descending ? [...turns].reverse() : turns;
      if (desktopHistoryRevision(ordered) === operation.historyRevision) operation.guiReloaded = true;
    }
  }
}

function identity(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value); }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function parse(line: string): Record<string, unknown> { try { return object(JSON.parse(line) as unknown); } catch { return {}; } }
