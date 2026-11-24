import type { AgentTaskInventory } from "@orbis/protocol";
import { dshAgentTasks, dshCatalogTasks, parseDshTaskCatalog } from "./dsh-agent-tasks.js";
import type { DshWebConnection, DshWebEvent } from "./dsh-web-client.js";
import { DshSessionTitles } from "./dsh-session-titles.js";

type Row = Record<string, unknown> & { sessionId: string };
type Change = (rows: Map<string, Row>) => void;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const row = (value: unknown): Row | undefined => {
  const item = object(value);
  return typeof item.sessionId === "string" && item.sessionId.length > 0 ? item as Row : undefined;
};

export type DshLiveSession = {
  sessionId: string; cwd: string; running: boolean; title?: string | null; createdAt: number;
};
type DiscoveryCallbacks = {
  live: (session: DshLiveSession) => void;
  offline: (id: string, removed: boolean) => void;
  archived: (id: string, archived: boolean) => void;
  changed: () => void;
  tasks?: (id: string) => void;
  unverified?: () => void;
};

/** Observes the native registry without creating Agents for cold history. */
export class DshWebDiscovery {
  readonly #client: DshWebConnection;
  readonly #callbacks: DiscoveryCallbacks;
  #rows = new Map<string, Row>();
  #taskCatalogs = new Map<string, { seq: number; catalog: ReturnType<typeof parseDshTaskCatalog> }>();
  #taskReads = new Map<string, number>();
  #taskReadCount = 0;
  #taskGeneration = 0;
  #taskControlReady = false;
  #archives: Set<string> | undefined;
  #workspaceReady = false;
  #catalogReady = false;
  #published = new Set<string>();
  #changes: Change[] | undefined;
  #refreshing: Promise<void> | undefined;
  #starting: Promise<void> | undefined;
  #workspace: (() => void) | undefined;
  #cancelOpening: (() => void) | undefined;
  #retry: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(client: DshWebConnection, callbacks: DiscoveryCallbacks, readonly titles: DshSessionTitles = new DshSessionTitles()) {
    this.#client = client;
    this.#callbacks = callbacks;
  }

  start(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#starting ??= this.#open().catch(error => {
      this.#starting = undefined;
      this.#scheduleRetry();
      throw error;
    });
  }

  async #open(): Promise<void> {
    if (!this.#workspace) {
      this.#workspaceReady = false;
      await new Promise<void>((resolve, reject) => {
        let opened = false;
        const timer = setTimeout(() => fail(new Error("DeepSeek Web 会话目录订阅超时")), 15_000);
        const finish = () => { clearTimeout(timer); this.#cancelOpening = undefined; };
        const fail = (error: Error) => {
          finish();
          this.#workspaceReady = false;
          this.#callbacks.unverified?.();
          this.#workspace?.(); this.#workspace = undefined;
          if (!opened) reject(error);
          else this.#scheduleRetry();
        };
        this.#cancelOpening = () => { finish(); resolve(); };
        try { this.#workspace = this.#client.subscribe("workspace/follow", {}, raw => {
          if (this.#closed) return;
          const frame = object(raw);
          const values = frame.type === "baseline" ? object(frame.value).archivedSessionIds : frame.type === "archived" ? frame.archivedSessionIds : undefined;
          if (!Array.isArray(values)) return;
          const previous = this.#archives ?? new Set<string>();
          const next = new Set(values.filter((id): id is string => typeof id === "string"));
          this.#archives = next;
          this.#workspaceReady = true;
          for (const id of new Set([...previous, ...next])) {
            if (previous.has(id) !== next.has(id)) this.#callbacks.archived(id, next.has(id));
          }
          this.#publish();
          if (!opened) { opened = true; finish(); resolve(); }
          else if (frame.type === "baseline") void this.refresh().catch(() => {});
        }, fail); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    }
    await this.refresh();
  }

  reconnect(): Promise<void> {
    // The replayed Workspace baseline must not publish the previous generation's
    // live rows while its fresh Session list is still in flight (or vice versa).
    this.invalidate();
    return this.refresh();
  }

  invalidate(): void {
    this.#workspaceReady = false; this.#catalogReady = false;
    this.resetTaskControl();
  }

  retry(): void { this.#scheduleRetry(); }

  tasks(id: string, previous?: AgentTaskInventory): AgentTaskInventory {
    if (!this.#workspaceReady || !this.#catalogReady) return { availability: "unknown", items: previous?.items ?? [], truncated: false };
    const fallback = dshAgentTasks(id, this.#rows, previous, (childId, item) => this.titles.read(childId, item));
    if (!this.#taskControlReady) return fallback;
    return dshCatalogTasks(id, this.#rows, parent => this.#taskCatalog(parent), fallback);
  }

  resetTaskControl(): void {
    this.#taskControlReady = false;
    ++this.#taskGeneration;
    this.#taskCatalogs.clear();
    this.#taskReads.clear();
    this.#callbacks.unverified?.();
  }

  taskControlBaseline(projections: Record<string, unknown>): void {
    if (this.#closed) return;
    ++this.#taskGeneration;
    this.#taskCatalogs.clear();
    this.#taskReads.clear();
    for (const [id, projection] of Object.entries(projections)) this.#storeTaskCatalog(id, projection);
    this.#taskControlReady = true;
    this.#callbacks.unverified?.();
  }

  taskControlUpdate(id: string, projection: unknown): void {
    if (this.#taskControlReady && this.#storeTaskCatalog(id, projection)) this.#callbacks.unverified?.();
  }

  #storeTaskCatalog(id: string, raw: unknown): boolean {
    const { asOfSeq: seq, values } = object(raw);
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= (this.#taskCatalogs.get(id)?.seq ?? -Infinity)) return false;
    this.#taskCatalogs.set(id, { seq, catalog: parseDshTaskCatalog(object(values).subagentCatalog) });
    return true;
  }

  #taskCatalog(id: string): ReturnType<typeof parseDshTaskCatalog> {
    const cached = this.#taskCatalogs.get(id);
    if (cached) return cached.catalog;
    // Cold descendants do not appear in the control baseline. Read their exact
    // projections without activating them; throttle failures and bound concurrent reads.
    const now = Date.now();
    if (this.#taskReadCount >= 8 || (this.#taskReads.get(id) ?? 0) > now || this.#closed) return;
    const generation = this.#taskGeneration;
    this.#taskReads.set(id, Infinity);
    ++this.#taskReadCount;
    void this.#client.request("session/projections", { request: { sessionId: id } }).then(raw => {
      if (this.#closed || generation !== this.#taskGeneration) return;
      if (object(raw).kind === "sequenced") this.#storeTaskCatalog(id, raw);
    }).catch(() => {}).finally(() => {
      --this.#taskReadCount;
      if (this.#closed) return;
      if (generation === this.#taskGeneration) {
        if (this.#taskCatalogs.has(id)) this.#taskReads.delete(id);
        else this.#taskReads.set(id, Date.now() + 2_000);
      }
      this.#callbacks.unverified?.();
    });
  }

  titleProjection(id: string, baseline: unknown, complete = false): void {
    if (this.#closed || !this.titles.apply(id, baseline, "sequenced", complete)) return;
    this.#callbacks.changed();
    this.#publish();
  }

  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#refreshing) return this.#refreshing;
    // Notifications arriving during a list RPC win over that RPC's older view.
    const changes: Change[] = [];
    this.#changes = changes;
    const operation = (async () => {
      const result = object(await this.#client.request("session/list", { _request: {} }));
      if (this.#closed) return;
      if (!Array.isArray(result.items)) throw new Error("DeepSeek Web 返回了无效会话目录");
      const rows = new Map<string, Row>();
      for (const value of result.items) { const item = row(value); if (item) rows.set(item.sessionId, item); }
      for (const change of changes) change(rows);
      for (const [id, previous] of this.#rows) {
        if (previous.agentAvailable === true && rows.get(id)?.agentAvailable !== true) this.#callbacks.offline(id, true);
      }
      this.#rows = rows;
      this.#catalogReady = true;
      this.#callbacks.changed();
      this.#publish();
    })();
    this.#refreshing = operation.catch(error => { this.#catalogReady = false; this.#callbacks.unverified?.(); this.#scheduleRetry(); throw error; }).finally(() => {
      this.#refreshing = undefined;
      this.#changes = undefined;
    });
    return this.#refreshing;
  }

  event(event: DshWebEvent): void {
    if (this.#closed || event.type !== "emit") return;
    let change: Change;
    if (event.event === "api-session/added") {
      const item = row(event.args[0]); if (!item) return;
      change = rows => { rows.set(item.sessionId, item); };
    } else {
      const id = event.args[0]; if (typeof id !== "string") return;
      if (event.event === "api-session/removed") {
        change = rows => { rows.delete(id); };
        // Also clear an explicit local detach when the native instance disappears.
        this.#callbacks.offline(id, true);
      } else if (event.event === "api-session/status" && typeof event.args[1] === "boolean") {
        const running = event.args[1];
        change = rows => { rows.set(id, { ...rows.get(id), sessionId: id, agentAvailable: true, running }); };
      } else if (event.event === "api-session/activity") {
        const updatedAt = event.args[1];
        change = rows => { rows.set(id, { ...rows.get(id), sessionId: id, updatedAt }); };
      } else return;
    }
    change(this.#rows);
    this.#changes?.push(change);
    this.#callbacks.changed();
    this.#publish();
    if (this.#archives && [...this.#rows.values()].some(item => item.agentAvailable === true && typeof item.cwd !== "string")) {
      void this.refresh().catch(() => {});
    }
  }

  #publish(): void {
    if (!this.#workspaceReady || !this.#catalogReady || this.#archives === undefined || this.#closed) return;
    const live = new Set<string>();
    for (const item of this.#rows.values()) {
      if (item.agentAvailable !== true || item.origin === "subagent" || this.#archives.has(item.sessionId) || typeof item.cwd !== "string") continue;
      live.add(item.sessionId);
      const title = this.titles.read(item.sessionId, item);
      this.#callbacks.live({ sessionId: item.sessionId, cwd: item.cwd, running: item.running === true,
        createdAt: Number(item.createdAt ?? item.updatedAt ?? Date.now()),
        ...(title === undefined ? {} : { title }) });
      this.#callbacks.tasks?.(item.sessionId);
    }
    for (const id of this.#published) if (!live.has(id)) this.#callbacks.offline(id, false);
    this.#published = live;
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retry) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#open().catch(() => this.#scheduleRetry());
    }, 2_000);
    this.#retry.unref();
  }

  stop(): void {
    this.#closed = true;
    clearTimeout(this.#retry);
    this.#cancelOpening?.();
    this.#workspace?.();
    this.#workspace = undefined;
  }
}
