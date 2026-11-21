import { createHash } from "node:crypto";
import type { AgentSessionSummary, CodexLaunchMode } from "@orbis/protocol";

export type CodexRuntimeKind = "codex" | "codexDesktop";
export const codexMode = (kind: CodexRuntimeKind): CodexLaunchMode => kind === "codex" ? "terminal" : "desktop";
export const isCodexKind = (kind: unknown): kind is CodexRuntimeKind => kind === "codex" || kind === "codexDesktop";
export const isCodexHistoryId = (id: unknown): id is string => typeof id === "string" && id.startsWith("codex-history:");
export const codexHistoryId = (hostId: string, store: string, thread: string): string => `codex-history:${createHash("sha256").update(JSON.stringify([hostId, store, thread])).digest("hex")}`;

type Slice = { sessions: AgentSessionSummary[]; complete: boolean };
export type CodexHistoryRead = { kind: CodexRuntimeKind; store: string; active?: Slice; archived?: Slice };
export type CodexHistoryRoute = { store: string; threadId: string; archived: boolean };

/** CODEX-UNIFIED-01. Cache and completeness are per native store, never per UI label. */
export class CodexHistoryCatalog {
  #slices = new Map<string, { routes: Map<string, CodexHistoryRoute>; rows: AgentSessionSummary[] }>();
  readonly #lastStore = new Map<CodexRuntimeKind, string>();
  constructor(readonly hostId: string) {}

  id(store: string, thread: string): string { return codexHistoryId(this.hostId, store, thread); }

  route(id: string): CodexHistoryRoute | undefined {
    for (const store of this.#slices.values()) {
      const route = store.routes.get(id);
      if (route) return route;
    }
    return undefined;
  }

  update(reads: readonly CodexHistoryRead[], enabled: ReadonlySet<CodexRuntimeKind>): { sessions: AgentSessionSummary[]; complete: boolean } {
    const groups = new Map<string, CodexHistoryRead[]>();
    for (const read of reads) {
      this.#lastStore.set(read.kind, read.store);
      const rows = groups.get(read.store) ?? [];
      rows.push(read); groups.set(read.store, rows);
    }
    let complete = enabled.size > 0;
    for (const kind of enabled) {
      if (reads.some(read => read.kind === kind)) continue;
      const store = this.#lastStore.get(kind);
      if (store && !groups.has(store)) groups.set(store, []);
      if (!store || !groups.get(store)?.length) complete = false;
    }
    const next = new Map<string, { routes: Map<string, CodexHistoryRoute>; rows: AgentSessionSummary[] }>();
    for (const [store, group] of groups) {
      const previous = this.#slices.get(store);
      const routes = new Map<string, CodexHistoryRoute>();
      const byId = new Map<string, AgentSessionSummary>();
      const availableKinds = new Set(group.map(item => item.kind));
      // A failed/partial source read cannot revoke a previously verified launch
      // route. Keep that route as long as the source remains enabled; an explicit
      // disable removes it from enabled and therefore from the published modes.
      for (const row of previous?.rows ?? []) {
        for (const mode of row.codexLaunchModes ?? []) {
          const kind: CodexRuntimeKind = mode === "desktop" ? "codexDesktop" : "codex";
          if (enabled.has(kind)) availableKinds.add(kind);
        }
      }
      const modes = [...availableKinds].filter(kind => enabled.has(kind)).map(codexMode).sort();
      for (const category of ["active", "archived"] as const) {
        const archived = category === "archived";
        const readings = group.flatMap(item => item[category] ? [item[category]] : []);
        if (!readings.some(item => item.complete)) {
          complete = false;
          for (const row of previous?.rows ?? []) {
            if ((row.archived === true) !== archived || byId.has(row.sessionId)) continue;
            const route = previous?.routes.get(row.sessionId);
            if (route) { routes.set(row.sessionId, route); byId.set(row.sessionId, { ...row, codexLaunchModes: modes }); }
          }
        }
        for (const row of readings.flatMap(read => read.sessions)) {
          const id = this.id(store, row.sessionId);
          const prior = byId.get(id);
          if (prior && prior.archived === archived && prior.modifiedAt > row.modifiedAt) continue;
          routes.set(id, { store, threadId: row.sessionId, archived });
          byId.set(id, { ...row, agentKind: "codex", sessionId: id, archived, codexLaunchModes: modes });
        }
      }
      next.set(store, { routes, rows: [...byId.values()] });
    }
    this.#slices = next;
    return { sessions: [...next.values()].flatMap(group => group.rows), complete };
  }
}
