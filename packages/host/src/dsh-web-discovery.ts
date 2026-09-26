import type { DshWebConnection, DshWebEvent } from "./dsh-web-client.js";

type Row = Record<string, unknown> & { sessionId: string };
type Change = (rows: Map<string, Row>) => void;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const row = (value: unknown): Row | undefined => {
  const item = object(value);
  return typeof item.sessionId === "string" && item.sessionId.length > 0 ? item as Row : undefined;
};

export type DshLiveSession = {
  sessionId: string; cwd: string; running: boolean; title?: string; createdAt: number;
};
type DiscoveryCallbacks = {
  live: (session: DshLiveSession) => void;
  offline: (id: string, removed: boolean) => void;
  archived: (id: string, archived: boolean) => void;
  changed: () => void;
};

/** Observes the native registry without creating Agents for cold history. */
export class DshWebDiscovery {
  readonly #client: DshWebConnection;
  readonly #callbacks: DiscoveryCallbacks;
  #rows = new Map<string, Row>();
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

  constructor(client: DshWebConnection, callbacks: DiscoveryCallbacks) {
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
    this.#workspaceReady = false;
    this.#catalogReady = false;
    return this.refresh();
  }

  retry(): void { this.#scheduleRetry(); }

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
    this.#refreshing = operation.catch(error => { this.#scheduleRetry(); throw error; }).finally(() => {
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
      this.#callbacks.live({ sessionId: item.sessionId, cwd: item.cwd, running: item.running === true,
        createdAt: Number(item.createdAt ?? item.updatedAt ?? Date.now()),
        ...(typeof item.title === "string" && item.title.length > 0 ? { title: item.title.slice(0, 256) } : {}) });
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
