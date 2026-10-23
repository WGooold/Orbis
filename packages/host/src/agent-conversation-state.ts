import { type DisplayBatch, type RemoteSessionEntry, type RuntimeEvent, type RuntimeTurnTiming, type SessionBranchCursor, type SessionLiveState, type SessionSourceEpoch, type SessionSyncRequest } from "@pi-remote/protocol";
import { createHash } from "node:crypto";

import { AgentStateRegistry, type PreparedRegistryCommit, type RegistryMutation, type StateScope } from "./agent-state-registry.js";

type Snapshot = Extract<RuntimeEvent, { type: "session.snapshot" }>;
type Patch = Extract<RuntimeEvent, { type: "session.patch" }>;
type Current = {
  source: SessionSourceEpoch; retired: Set<string>; head: SessionBranchCursor; live: SessionLiveState;
  entries: RemoteSessionEntry[]; display?: DisplayBatch; timings: RuntimeTurnTiming[]; bytes: number;
};
export type ConversationStateOptions = { maxCurrentSessions?: number; maxCurrentBytes?: number; maxPageBytes?: number; maxPages?: number; maxPageCacheBytes?: number };
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/**
 * ADR-0039 §4：条目字节数在首次接收时测一次并缓存。
 *
 * 以前每个事件都 `size(next)` 把整份当前状态序列化一遍，成本是 O(全部条目字节)，
 * 而条目在 §2 之后是**不可变引用**——同一个对象只需要量一次。替换条目时按
 * `总字节 - 旧 + 新` 记账，口径与 §4 一致。
 */
const entryBytes = new WeakMap<object, number>();
const bytesOfEntry = (entry: object): number => {
  const cached = entryBytes.get(entry);
  if (cached !== undefined) return cached;
  const measured = size(entry);
  entryBytes.set(entry, measured);
  return measured;
};
const bytesOfEntries = (entries: readonly object[] | undefined): number =>
  (entries ?? []).reduce((total, entry) => total + bytesOfEntry(entry), 0);

/** 事件字节数：条目部分走缓存，其余字段（很小）照常序列化。 */
const bytesOfEvent = (event: { entries?: readonly unknown[] | undefined } & Record<string, unknown>): number => {
  const { entries, ...rest } = event;
  return bytesOfEntries(entries as readonly object[] | undefined) + size(rest);
};

/** 当前状态的字节数：条目走缓存，live/头/版本再序列化（它们与条目总量相比很小）。 */
const bytesOfCurrent = (current: { entries: readonly object[]; live: unknown; head: unknown; source: unknown }): number =>
  bytesOfEntries(current.entries) + size({ live: current.live, head: current.head, source: current.source });
/** Bounded by construction: the conversation projection only keeps the newest references. */
const MAX_ARTIFACT_REFERENCES = 256;
const scopeKey = (scope: StateScope): string => scope.kind === "agent" ? JSON.stringify([scope.key.hostId, scope.key.agentKind, scope.key.sessionId]) : "";

/** Native adapters own semantics. This boundary owns bounded, versioned current projections and
 * replaceable canonical/display pages, never a second durable history database. */

/**
 * ADR-0039 §2：权威模型持有**冻结的引用**，而不是深拷贝。
 *
 * 深拷贝的职责本来是"adapter 不得改写权威状态"，但它是静默的：adapter 改了它自己那份，
 * 模型看起来没变。冻结把同一条约束变成显式错误——在严格模式下赋值直接抛异常。
 *
 * 只用于 entries（和 display 行）。**不能**用于 `event.live`：live 在 DSH/DSH-Web 里是
 * 原地累加的，冻结会当场打断流式输出（ADR-0039 §2 的明确禁止项）。
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child !== null && typeof child === "object") deepFreeze(child);
  }
  return value;
}


/**
 * ADR-0039 §3：条目修订号必须由**内容**派生，且同一内容重发必须得到同一值。
 *
 * 它是"同 entryId 内容被改写必须被拒"的判据。以前每次都 `JSON.stringify` 两侧各算一遍，
 * 成本 O(字节) 且每个事件都付；现在按对象身份缓存摘要——条目在 §2 之后是不可变引用，
 * 因此同一个对象只算一次，比较变成 O(1)。
 *
 * 不使用全局源序号：同一 entry 重发时全局序号可能变化，会被误判为"内容被改写"从而
 * 永久拒绝该条目（ADR-0039 §3 的明确禁止项）。
 */
const entryRevisions = new WeakMap<object, string>();
function contentRevision(value: object): string {
  const cached = entryRevisions.get(value);
  if (cached !== undefined) return cached;
  const revision = createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 22);
  entryRevisions.set(value, revision);
  return revision;
}

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
      if (!old?.source.ready || !source.ready || old.source.epoch !== source.epoch || source.seq > old.source.seq || bytesOfEvent(event) > this.#limits.maxPageBytes) return false;
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
    if (bytesOfEvent(event) > this.#limits.maxPageBytes) ready = false;
    if (ready && old?.source.ready && sameEpoch && old.source.seq === source.seq &&
      (JSON.stringify(old.head) !== JSON.stringify(head) || JSON.stringify(old.live) !== JSON.stringify(event.live))) return false;
    const canonical = ready ? this.#canonical(sameEpoch ? old : undefined, event, head!) : { entries: [], timings: [] };
    if (!canonical) return false;
    let next: Current = { source: { ...source, ready: ready === true }, retired, head: structuredClone(head ?? old?.head ?? { leafId: null }),
      live: structuredClone(event.live ?? old?.live ?? { complete: false, turn: null, messages: [], tools: [] }), ...canonical, bytes: 0 };
    next.bytes = bytesOfCurrent(next);
    if (this.#currentBytes - (old?.bytes ?? 0) + next.bytes > this.#limits.maxCurrentBytes) {
      // Retain provenance and last-known registry values; discarded ranges cannot be a baseline.
      ready = false;
      next = { source: { ...source, ready: false }, retired, head: { leafId: null }, live: { complete: false, turn: null, messages: [], tools: [] }, entries: [], timings: [], bytes: 0 };
      next.bytes = bytesOfCurrent(next);
      if (this.#currentBytes - (old?.bytes ?? 0) + next.bytes > this.#limits.maxCurrentBytes) return false;
    }
    const provenance = { producer: "adapter" as const, sourceId: `conversation:${scope.key.agentKind}`, sourceEpoch: source.epoch, sourceRevision: source.seq };
    const changes: RegistryMutation[] = ready ? [
      { kind: "value", scope, domain: "history", fact: { source: provenance, availability: "ready", completeness: "complete", value: { source, head, headCompleteness: "complete", displayVersion: next.display?.projectionVersion ?? null } } },
      { kind: "value", scope, domain: "live", fact: { source: provenance, availability: "ready", completeness: "complete", value: event.live } },
    ] : ["history", "live", "artifacts"].map(domain => ({ kind: "value", scope, domain: domain as "history" | "live" | "artifacts", fact: { source: provenance, availability: "unknown", completeness: "unknown", value: null } }));
    if (ready) {
      // References survive live -> canonical migration, and come from both places: an artifact that
      // reached the canonical display is still a real file after its live row is gone (and after a
      // Host restart, when a page re-supplies the display). Empty live never deletes native history.
      const previousArtifacts = this.#registry.read<Record<string, unknown>>(scope, "artifacts")?.value;
      const artifacts = new Map<string, unknown>(previousArtifacts === null || previousArtifacts === undefined
        ? [] : Object.entries(previousArtifacts));
      const collect = (message: { messageId: string; content: readonly unknown[] } | null | undefined): void => {
        if (message === null || message === undefined) return;
        for (const content of message.content) {
          if (typeof content !== "object" || content === null) continue;
          const block = content as { type?: unknown; artifact?: unknown };
          if (block.type !== "artifact") continue;
          const artifact = block.artifact as { artifactId?: unknown } | undefined;
          if (typeof artifact?.artifactId !== "string") continue;
          artifacts.set(artifact.artifactId, { ...(artifact as Record<string, unknown>), messageId: message.messageId });
        }
      };
      for (const row of event.display?.entries ?? []) collect(row.message);
      for (const item of event.live!.messages) collect(item.message);
      // This is a reference index for the bounded window, not an inventory of the session's files:
      // absence never deletes, and the oldest references are dropped by id, not by omission.
      const dropped: string[] = [];
      while (artifacts.size > MAX_ARTIFACT_REFERENCES) {
        const oldest = artifacts.keys().next().value as string;
        artifacts.delete(oldest);
        dropped.push(oldest);
      }
      changes.push({ kind: "collection", scope, domain: "artifacts", fact: { source: provenance, availability: "ready", completeness: "complete", items: Object.fromEntries(artifacts) } });
      if (dropped.length > 0) changes.push({ kind: "remove", scope, domain: "artifacts", fact: { source: provenance, availability: "ready", completeness: "complete", removeIds: dropped } });
    }
    const companion = prepare?.(ready === true);
    const result = this.#registry.commitTransaction([...changes, ...(companion?.changes ?? [])], () => {
      this.#currentBytes += next.bytes - (old?.bytes ?? 0);
      this.#current.set(key, next);
      if (!sameEpoch) this.#dropPages(key);
      if (ready && event.type === "session.snapshot" && bytesOfEvent(event) <= this.#limits.maxPageBytes) this.#cache(key, event);
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
      // ADR-0039 §3：按内容派生的修订号比较，两侧都是 O(1)（按对象身份缓存）。
      if (previous && contentRevision(previous) !== contentRevision(entry)) return;
      byId.set(entry.entryId, deepFreeze(entry));
    }
    const path: RemoteSessionEntry[] = [], seen = new Set<string>(); let id = head.leafId;
    while (id !== null && byId.has(id) && path.length < 500) {
      if (seen.has(id)) return;
      seen.add(id); const entry = byId.get(id)!; path.push(entry); id = entry.parentId;
    }
    path.reverse();
    const version = event.display?.projectionVersion ?? old?.display?.projectionVersion;
    const rows = new Map((!replace && old?.display && old.display.projectionVersion === version ? old.display.entries : []).map(row => [row.entryId, row]));
    for (const row of event.display?.entries ?? []) rows.set(row.entryId, deepFreeze(row));
    const display = version !== undefined && path.every(entry => rows.has(entry.entryId)) ? { projectionVersion: version, windowStart: event.display?.windowStart ?? old?.display?.windowStart ?? null, entries: path.map(entry => rows.get(entry.entryId)!) } : undefined;
    const timings = new Map((replace ? [] : old?.timings ?? []).map(timing => [timing.turnId, timing]));
    if (event.type === "session.snapshot") for (const timing of event.turnTimings ?? []) timings.set(timing.turnId, structuredClone(timing));
    return { entries: path, ...(display ? { display } : {}), timings: [...timings.values()].slice(-256) };
  }
  #cache(key: string, event: Snapshot): void {
    const cacheKey = JSON.stringify([key, event.source?.epoch, event.cursor.leafId, event.range, event.beforeEntryId ?? null]);
    const bytes = bytesOfEvent(event); if (bytes > this.#limits.maxPageBytes || bytes > this.#limits.maxPageCacheBytes) return;
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
  /**
   * ADR-0038 §8：按需取回**未截断**的那一条 Entry。
   *
   * 线路投影会截断超长载荷，但权威模型里保留的是原文；这里只按 id 查表，并且把
   * "能不能发"交给调用方（超上限按确定性失败拒绝，不发半截内容）。
   */
  entry(scope: StateScope, entryId: string): RemoteSessionEntry | undefined {
    if (scope.kind !== "agent") return undefined;
    const current = this.#current.get(scopeKey(scope));
    return current?.entries.find(entry => entry.entryId === entryId);
  }

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
    return bytesOfEvent(base) <= this.#limits.maxPageBytes ? base : undefined;
  }
  offline(scope: StateScope, companion?: PreparedRegistryCommit): void {
    if (scope.kind !== "agent") return;
    const current = this.#current.get(scopeKey(scope));
    const changes: RegistryMutation[] = current ? ["history", "live", "artifacts"].map(domain => ({ kind: "value", scope, domain: domain as "history" | "live" | "artifacts", fact: { source: { producer: "adapter", sourceId: `conversation:${scope.key.agentKind}`, sourceEpoch: current.source.epoch, sourceRevision: current.source.seq }, availability: "unknown", completeness: "unknown", value: null } })) : [];
    this.#registry.commitTransaction([...changes, ...(companion?.changes ?? [])], () => { if (current) current.source.ready = false; companion?.onCommitted(); });
  }
}
