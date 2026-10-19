import { type DisplayBatch, type RemoteSessionEntry, type RuntimeEvent, type RuntimeTurnTiming, type SessionBranchCursor, type SessionLiveState, type SessionSourceEpoch, type SessionSyncRequest } from "@pi-remote/protocol";
import { AgentStateRegistry, type PreparedRegistryCommit, type RegistryMutation, type StateScope } from "./agent-state-registry.js";

type Snapshot = Extract<RuntimeEvent, { type: "session.snapshot" }>;
type Patch = Extract<RuntimeEvent, { type: "session.patch" }>;
type Current = {
  source: SessionSourceEpoch; retired: Set<string>; head: SessionBranchCursor; live: SessionLiveState;
  entries: RemoteSessionEntry[]; display?: DisplayBatch; timings: RuntimeTurnTiming[]; bytes: number;
};
export type ConversationStateOptions = { maxCurrentSessions?: number; maxCurrentBytes?: number; maxPageBytes?: number; maxPages?: number; maxPageCacheBytes?: number };
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const scopeKey = (scope: StateScope): string => scope.kind === "agent" ? JSON.stringify([scope.key.hostId, scope.key.agentKind, scope.key.sessionId]) : "";

/** Native adapters own semantics. This boundary owns bounded, versioned current projections and
 * replaceable canonical/display pages, never a second durable history database. */
export class AgentConversationState {
  readonly #registry: AgentStateRegistry;
  readonly #current = new Map<string, Current>();
  readonly #pages = new Map<string, { event: Snapshot; bytes: number }>();
  readonly #limits: Required<ConversationStateOptions>;
  #bytes = 0;
  #currentBytes = 0;
  constructor(registry: AgentStateRegistry, options: ConversationStateOptions = {}) {
    this.#registry = registry;
    this.#limits = { maxCurrentSessions: 64, maxCurrentBytes: 8 * 1024 * 1024, maxPageBytes: 1024 * 1024, maxPages: 64, maxPageCacheBytes: 8 * 1024 * 1024, ...options };
    registry.subscribe(change => {
      if (change.kind === "reset") { this.#current.clear(); this.#pages.clear(); this.#bytes = this.#currentBytes = 0; }
      else if (change.kind === "closed" && change.domain === "history") this.#forget(scopeKey(change.scope));
    });
  }

  // ADR-0032 §5 §7：patch 可先写内容，但永远不是恢复基线；别放宽 hasBaseline。
  accept(scope: StateScope, event: Snapshot | Patch, prepare?: (ready: boolean) => PreparedRegistryCommit | undefined): boolean {
    if (scope.kind !== "agent" || event.sessionId !== scope.key.sessionId) return false;
    const key = scopeKey(scope), source = event.source, old = this.#current.get(key);
    if (!source || !Number.isSafeInteger(source.seq) || source.seq < 0 || old?.retired.has(source.epoch)) return false;
    if (!this.#validDisplay(event)) return false;
    const range = event.type === "session.snapshot" && (event.range === "history" || event.range === "catchup");
    if (range) {
      // A delayed page cannot establish a new source, revive an offline source or switch head.
      if (!old?.source.ready || !source.ready || old.source.epoch !== source.epoch || source.seq > old.source.seq || size(event) > this.#limits.maxPageBytes) return false;
      this.#cache(key, event);
      return true;
    }
    if (old?.source.epoch === source.epoch && source.seq < old.source.seq) return false;
    if (event.type === "session.snapshot" && event.selection === "unchanged") {
      return old?.source.ready === true && old.source.epoch === source.epoch && old.source.seq === source.seq && event.cursor.leafId === old.head.leafId;
    }
    const sameEpoch = old?.source.epoch === source.epoch;
    // A source that has delivered no snapshot yet still publishes patches (Codex and DSH only emit
    // snapshots on request). Such a patch is a handshake: it carries content forward to devices and
    // keeps the source watermark, but it can never establish a recovery baseline.
    const handshake = event.type === "session.patch" && source.ready && old?.source.ready !== true;
    if (event.type === "session.patch") {
      if (source.seq !== event.seq || event.baseSeq >= event.seq) return false;
      // Unknown is source-rebuild; an established source requires its committed baseline.
      if (!handshake && source.ready && (!sameEpoch || !old?.source.ready || event.baseSeq !== old.source.seq)) return false;
      if (handshake && old !== undefined && (!sameEpoch || event.baseSeq !== old.source.seq)) return false;
      if (!source.ready && sameEpoch && event.baseSeq !== old!.source.seq) return false;
      if (!source.ready && !sameEpoch && event.baseSeq !== 0) return false;
    } else if ((event.selection === "state" || event.selection === "delta") && (!sameEpoch || !old?.source.ready)) return false;
    const head = event.type === "session.patch" ? event.head : event.checkpoint?.head;
    if (event.type === "session.snapshot" && head && head.leafId !== event.cursor.leafId) return false;
    let ready = !handshake && source.ready && (event.type === "session.patch" ? event.headCompleteness === "complete" : event.checkpoint?.headCompleteness === "complete" && event.checkpoint.inventoryComplete) && event.live?.complete === true && head !== undefined;
    const retired = new Set(old?.retired);
    if (old && !sameEpoch) { if (retired.size >= 64) return false; retired.add(old.source.epoch); }
    if (!old && this.#current.size >= this.#limits.maxCurrentSessions) return false;
    if (size(event) > this.#limits.maxPageBytes) ready = false;
    if (ready && old?.source.ready && sameEpoch && old.source.seq === source.seq &&
      (JSON.stringify(old.head) !== JSON.stringify(head) || JSON.stringify(old.live) !== JSON.stringify(event.live))) return false;
    const canonical = ready ? this.#canonical(sameEpoch ? old : undefined, event, head!) : { entries: [], timings: [] };
    if (!canonical) return false;
    let next: Current = { source: { ...source, ready: ready === true }, retired, head: structuredClone(head ?? old?.head ?? { leafId: null }),
      live: structuredClone(event.live ?? old?.live ?? { complete: false, turn: null, messages: [], tools: [] }), ...canonical, bytes: 0 };
    next.bytes = size(next);
    if (this.#currentBytes - (old?.bytes ?? 0) + next.bytes > this.#limits.maxCurrentBytes) {
      // Retain provenance and last-known registry values; discarded ranges cannot be a baseline.
      ready = false;
      next = { source: { ...source, ready: false }, retired, head: { leafId: null }, live: { complete: false, turn: null, messages: [], tools: [] }, entries: [], timings: [], bytes: 0 };
      next.bytes = size(next);
      if (this.#currentBytes - (old?.bytes ?? 0) + next.bytes > this.#limits.maxCurrentBytes) return false;
    }
    const provenance = { producer: "adapter" as const, sourceId: `conversation:${scope.key.agentKind}`, sourceEpoch: source.epoch, sourceRevision: source.seq };
    const changes: RegistryMutation[] = ready ? [
      { kind: "value", scope, domain: "history", fact: { source: provenance, availability: "ready", completeness: "complete", value: { source, head, headCompleteness: "complete", displayVersion: next.display?.projectionVersion ?? null } } },
      { kind: "value", scope, domain: "live", fact: { source: provenance, availability: "ready", completeness: "complete", value: event.live } },
    ] : ["history", "live", "artifacts"].map(domain => ({ kind: "value", scope, domain: domain as "history" | "live" | "artifacts", fact: { source: provenance, availability: "unknown", completeness: "unknown", value: null } }));
    if (ready) {
      // References survive live -> canonical migration. Empty live never deletes native history.
      const artifacts = { ...(this.#registry.read<Record<string, unknown>>(scope, "artifacts")?.value ?? {}) };
      for (const item of event.live!.messages) for (const content of item.message.content) if (content.type === "artifact") artifacts[content.artifact.artifactId] = { ...content.artifact, messageId: item.message.messageId };
      changes.push({ kind: "collection", scope, domain: "artifacts", fact: { source: provenance, availability: "ready", completeness: "complete", items: artifacts } });
    }
    const companion = prepare?.(ready === true);
    const result = this.#registry.commitTransaction([...changes, ...(companion?.changes ?? [])], () => {
      this.#currentBytes += next.bytes - (old?.bytes ?? 0);
      this.#current.set(key, next);
      if (!sameEpoch) this.#dropPages(key);
      if (ready && event.type === "session.snapshot" && size(event) <= this.#limits.maxPageBytes) this.#cache(key, event);
      companion?.onCommitted();
    });
    return result.ok;
  }

  #validDisplay(event: Snapshot | Patch): boolean {
    if (!event.display) return true;
    const ids = new Set((event.entries ?? []).map(entry => entry.entryId)), seen = new Set<string>();
    for (const row of event.display.entries) {
      if (row.entryId === null || !ids.has(row.entryId) || seen.has(row.entryId)) return false;
      seen.add(row.entryId);
    }
    return seen.size === ids.size;
  }
  #canonical(old: Current | undefined, event: Snapshot | Patch, head: SessionBranchCursor): Pick<Current, "entries" | "display" | "timings"> | undefined {
    const replace = event.type === "session.snapshot" && event.mode === "replace";
    const byId = new Map((replace ? [] : old?.entries ?? []).map(entry => [entry.entryId, entry]));
    for (const entry of event.entries ?? []) {
      const previous = byId.get(entry.entryId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) return;
      byId.set(entry.entryId, structuredClone(entry));
    }
    const path: RemoteSessionEntry[] = [], seen = new Set<string>(); let id = head.leafId;
    while (id !== null && byId.has(id) && path.length < 500) {
      if (seen.has(id)) return;
      seen.add(id); const entry = byId.get(id)!; path.push(entry); id = entry.parentId;
    }
    path.reverse();
    const version = event.display?.projectionVersion ?? old?.display?.projectionVersion;
    const rows = new Map((!replace && old?.display && old.display.projectionVersion === version ? old.display.entries : []).map(row => [row.entryId, row]));
    for (const row of event.display?.entries ?? []) rows.set(row.entryId, structuredClone(row));
    const display = version !== undefined && path.every(entry => rows.has(entry.entryId)) ? { projectionVersion: version, windowStart: event.display?.windowStart ?? old?.display?.windowStart ?? null, entries: path.map(entry => rows.get(entry.entryId)!) } : undefined;
    const timings = new Map((replace ? [] : old?.timings ?? []).map(timing => [timing.turnId, timing]));
    if (event.type === "session.snapshot") for (const timing of event.turnTimings ?? []) timings.set(timing.turnId, structuredClone(timing));
    return { entries: path, ...(display ? { display } : {}), timings: [...timings.values()].slice(-256) };
  }
  #cache(key: string, event: Snapshot): void {
    const cacheKey = JSON.stringify([key, event.source?.epoch, event.cursor.leafId, event.range, event.beforeEntryId ?? null]);
    const bytes = size(event); if (bytes > this.#limits.maxPageBytes || bytes > this.#limits.maxPageCacheBytes) return;
    const previous = this.#pages.get(cacheKey);
    if ((previous?.event.source?.seq ?? -1) > (event.source?.seq ?? -1)) return;
    if (previous) { this.#bytes -= previous.bytes; this.#pages.delete(cacheKey); }
    this.#pages.set(cacheKey, { event: structuredClone(event), bytes }); this.#bytes += bytes;
    while (this.#pages.size > this.#limits.maxPages || this.#bytes > this.#limits.maxPageCacheBytes) {
      const first = this.#pages.keys().next().value as string; this.#bytes -= this.#pages.get(first)!.bytes; this.#pages.delete(first);
    }
  }
  #dropPages(key: string): void { for (const [id, page] of this.#pages) if (JSON.parse(id)[0] === key) { this.#bytes -= page.bytes; this.#pages.delete(id); } }
  #forget(key: string): void { const old = this.#current.get(key); if (old) { this.#currentBytes -= old.bytes; this.#current.delete(key); } this.#dropPages(key); }
  stats(): { pages: number; bytes: number; currentSessions: number; currentBytes: number } { return { pages: this.#pages.size, bytes: this.#bytes, currentSessions: this.#current.size, currentBytes: this.#currentBytes }; }
  hasBaseline(scope: StateScope): boolean { return this.#current.get(scopeKey(scope))?.source.ready === true && this.#registry.read(scope, "live")?.availability === "ready"; }
  recover(scope: StateScope, request: SessionSyncRequest): Snapshot | undefined {
    if (scope.kind !== "agent" || request.sessionId !== scope.key.sessionId) return;
    const key = scopeKey(scope), current = this.#current.get(key);
    if (!current?.source.ready || !this.hasBaseline(scope)) return;
    if (request.range !== "preview") {
      for (const page of [...this.#pages.values()].reverse()) if (page.event.range === request.range && page.event.source?.epoch === current.source.epoch &&
        page.event.cursor.leafId === (request.targetLeafId ?? current.head.leafId) && (page.event.beforeEntryId ?? null) === (request.beforeEntryId ?? null) && page.event.entries.length <= (request.maxEntries ?? 30)) {
        // Catchup depends on the caller's known branch, which old wire pages do not record.
        if (request.range === "catchup") return;
        return { ...structuredClone(page.event), syncId: request.syncId };
      }
      return;
    }
    if (request.targetLeafId !== undefined && request.targetLeafId !== current.head.leafId) return;
    const known = request.knownState;
    const conditional = known?.epoch === current.source.epoch && known.seq <= current.source.seq && known.head.leafId === current.head.leafId;
    const unchanged = conditional && known.seq === current.source.seq;
    const base: Snapshot = { type: "session.snapshot", sessionId: request.sessionId, syncId: request.syncId, range: "preview", mode: conditional ? "append" : "replace", selection: conditional ? unchanged ? "unchanged" : "state" : "snapshot", entries: [], cursor: structuredClone(current.head), source: { ...current.source }, complete: true, hasOlder: false, rangeStatus: "complete", checkpoint: { checkpointId: `host:${current.source.epoch}:${current.source.seq}`, head: structuredClone(current.head), headCompleteness: "complete", inventoryComplete: true }, ...(unchanged ? {} : { live: structuredClone(current.live) }) };
    if (!conditional) {
      if (current.head.leafId !== null && current.entries.at(-1)?.entryId !== current.head.leafId) return;
      const entries = current.entries.slice(-(request.maxEntries ?? 30));
      if (entries.length > 0 && !current.display) return;
      base.entries = structuredClone(entries);
      if (current.display) base.display = { ...structuredClone(current.display), entries: structuredClone(current.display.entries.slice(-entries.length)) };
      base.turnTimings = structuredClone(current.timings);
      base.hasOlder = entries[0]?.parentId != null; base.complete = !base.hasOlder;
      base.rangeStatus = base.hasOlder ? "limit_reached" : "complete";
    }
    return size(base) <= this.#limits.maxPageBytes ? base : undefined;
  }
  offline(scope: StateScope, companion?: PreparedRegistryCommit): void {
    if (scope.kind !== "agent") return;
    const current = this.#current.get(scopeKey(scope));
    const changes: RegistryMutation[] = current ? ["history", "live", "artifacts"].map(domain => ({ kind: "value", scope, domain: domain as "history" | "live" | "artifacts", fact: { source: { producer: "adapter", sourceId: `conversation:${scope.key.agentKind}`, sourceEpoch: current.source.epoch, sourceRevision: current.source.seq }, availability: "unknown", completeness: "unknown", value: null } })) : [];
    this.#registry.commitTransaction([...changes, ...(companion?.changes ?? [])], () => { if (current) current.source.ready = false; companion?.onCommitted(); });
  }
}
