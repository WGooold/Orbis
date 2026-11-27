import type { OpenCodeEvent, SessionInfo } from "@opencode/client";

// This module is copied verbatim after compilation into OpenCode's local TUI plugin directory.
// Keep it dependency-free at runtime. The types below describe the small public 2.3.2 API it uses.
export const ORBIS_APP_SESSION_KEY = "orbis.app.session";
type TabEvent = Extract<OpenCodeEvent, { type: "session.created" | "server.connected" }>;
type TuiContext = {
  data: {
    on<Type extends TabEvent["type"]>(type: Type, handler: (event: Extract<TabEvent, { type: Type }>) => void): () => void;
    session: { active(): string[]; get(id: string): SessionInfo | undefined; sync(id: string): Promise<void> };
  };
  storage: {
    memory<Value extends object>(key: string, options: { initial: Value }): readonly [Value, (mutation: (draft: Value) => void) => void];
  };
  ui: { tabs: { enabled(): boolean; list(): readonly { sessionID: string }[]; open(id: string): boolean } };
};

export default {
  id: "orbis.opencode-tabs",
  setup(context: TuiContext) {
    const { data, storage } = context;
    const tabs = context.ui?.tabs;
    if (typeof data?.on !== "function" || typeof data.session?.active !== "function" || typeof data.session.get !== "function"
        || typeof data.session.sync !== "function" || typeof storage?.memory !== "function" || typeof tabs?.enabled !== "function"
        || typeof tabs.list !== "function" || typeof tabs.open !== "function") return;
    let disposed = false;
    const pending = new Set<string>();
    // Survives TUI plugin hot reloads. If the user closes an auto-added tab, a later reconnect
    // in this TUI must not add it again. The actual tab list is owned by OpenCode, not this plugin.
    const [state, update] = storage.memory("opened", { initial: { sessions: {} as Record<string, true> } });
    const show = async (id: string, activeOnly = false) => {
      if (disposed || !tabs.enabled() || Object.hasOwn(state.sessions, id) || pending.has(id)) return;
      pending.add(id);
      try {
        await data.session.sync(id);
        if (disposed || !tabs.enabled() || (activeOnly && !data.session.active().includes(id))) return;
        const row = data.session.get(id);
        // Children and forks can inherit metadata. Do not promote them to App-created tabs.
        if (!row || row.parentID != null || row.fork || row.time.archived != null || row.metadata?.[ORBIS_APP_SESSION_KEY] !== 1) return;
        if (tabs.list().some(tab => tab.sessionID === id) || tabs.open(id)) update(draft => { draft.sessions[id] = true; });
      } catch { /* A deleted session or temporarily unavailable service does not create a tab. */ }
      finally { pending.delete(id); }
    };

    // The TUI refreshes its own active snapshot asynchronously on connect. Recheck it
    // briefly on load/reconnect instead of holding a stale API client or paging idle history.
    let recovery: ReturnType<typeof setTimeout> | undefined;
    const catchUp = (remaining = 4) => {
      clearTimeout(recovery);
      if (disposed || !tabs.enabled()) return;
      for (const id of data.session.active()) void show(id, true);
      if (remaining > 0) recovery = setTimeout(() => catchUp(remaining - 1), 500);
    };
    const offCreated = data.on("session.created", ({ data: event }) => {
      if (event.parentID == null && event.metadata?.[ORBIS_APP_SESSION_KEY] === 1) void show(event.sessionID);
    });
    const offConnected = data.on("server.connected", () => catchUp());
    catchUp();
    return () => { disposed = true; clearTimeout(recovery); offCreated(); offConnected(); };
  },
};
