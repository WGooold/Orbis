import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  HostBackendsStateSchema, HostConnectionsStateSchema, HostFilesStateSchema, HostIdentityStateSchema,
  HostManagementStateSchema, HostOperationsStateSchema, HostWorkspacesStateSchema,
  AgentSessionSummarySchema, HostCatalogStateSchema,
  type AgentKind, type DomainAvailability, type DomainCompleteness, type HostBackendsState,
  type HostCatalogState, type HostConnectionsState, type HostDiagnosticsState, type HostFilesState,
  type HostIdentityState, type HostManagementState, type HostOperationsState, type HostProvidersState,
  type HostStateDomain, type HostWorkspacesState,
  type AgentSessionSummary, type HostCatalogRange, type AgentStateRangeRequest,
  type CatalogQuery, type CatalogQueryRequest, type CatalogQueryPage,
} from "@orbis/protocol";

import { AgentStateRegistry, type CommitResult, type StateScope } from "./agent-state-registry.js";

/**
 * Host 级共享领域的写入器（ADR-0032 的 HostState）。
 *
 * 每个领域有独立来源与内容版本。服务先完成 IO，再把捕获的公共事实交给这里；
 * 读取失败保留最后已知值，不把失败当作完整空清单。
 */

export type HostStateFactsOptions = {
  readonly registry: AgentStateRegistry;
  readonly now?: () => number;
};

const PUBLIC_VALUE_BYTES = 192 * 1024;
/** A committed catalog response is the first page, not an inline directory dump. */
const CATALOG_PAGE_VALUE_BYTES = 28 * 1024;
const CATALOG_INVENTORY_BYTES = 8 * 1024 * 1024;
const CATALOG_INVENTORY_ENTRIES = 20_000;
type CatalogInput = Omit<HostCatalogState, "checkedAt">;
type CatalogInventory = { snapshotId: string; modelEpoch: string; fingerprint: string; state: CatalogInput; sessions: AgentSessionSummary[] };

/** Binary search keeps truncation work logarithmic even for thousands of long catalog entries. */
function boundedArray<T>(items: readonly T[], bytes: number, wrap: (items: T[]) => unknown): T[] {
  const size = (count: number) => Buffer.byteLength(JSON.stringify(wrap(items.slice(0, count))));
  if (size(items.length) <= bytes) return [...items];
  let low = 0; let high = items.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (size(middle) <= bytes) low = middle; else high = middle - 1; }
  return items.slice(0, low);
}

/** A hidden-kind view (ADR-0076 DSH-DESKTOP-06) has its own cursor space; full and filtered offsets never mix. */
const catalogCursor = (snapshotId: string, offset: number, hide?: AgentKind, queryHash?: string): string =>
  Buffer.from(JSON.stringify([snapshotId, offset, ...(queryHash === undefined ? [] : [queryHash]), ...(hide === undefined ? [] : [`-${hide}`])])).toString("base64url");
const queryKey = (query: CatalogQuery): string => createHash("sha256").update(JSON.stringify([
  query.text, query.agentKind, query.archived, query.provider, query.directory ?? null,
])).digest("hex");
const searchKey = (value: string): string => value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "");

/**
 * 「有供应商切换正在进行」这条事实（模块 20）。
 *
 * 只有 Host 自己发起的切换才是已知事实；没在切换**不等于**没有切换——桌面端可能在带外改配置，
 * 所以那种情况记 ~null~（未核对），而不是 ~false~。客户端据此知道：进行中时路由结论还不作数。
 */
export function providerSwitchingFact(changingKind: AgentKind | undefined, kind: AgentKind): boolean | null {
  return changingKind === kind ? true : null;
}

export class HostStateFacts {
  readonly #registry: AgentStateRegistry;
  readonly #now: () => number;
  readonly #epoch = randomUUID();
  #catalogInventory: CatalogInventory | undefined;

  constructor(options: HostStateFactsOptions) {
    this.#registry = options.registry;
    this.#now = options.now ?? Date.now;
  }

  identity(state: HostIdentityState): CommitResult { return this.#validated("identity", HostIdentityStateSchema, state); }
  backends(state: HostBackendsState): CommitResult { return this.#validated("backends", HostBackendsStateSchema, state); }
  workspaces(state: HostWorkspacesState): CommitResult {
    const previous = this.readDomain<HostWorkspacesState>("workspaces");
    const workspaces = state.truncated ? [...new Map([
      ...(previous?.workspaces ?? []).map(workspace => [workspace.workspaceId, workspace] as const),
      ...state.workspaces.map(workspace => [workspace.workspaceId, workspace] as const),
    ]).values()].slice(-256) : state.workspaces;
    const bounded = boundedArray(workspaces, PUBLIC_VALUE_BYTES, items => ({ ...state, workspaces: items, truncated: true }));
    const truncated = state.truncated || bounded.length < workspaces.length;
    return this.#validated("workspaces", HostWorkspacesStateSchema, { ...state, workspaces: bounded, truncated }, truncated ? "partial" : "complete");
  }
  files(state: HostFilesState): CommitResult {
    const previous = this.readDomain<HostFilesState>("files");
    const files = state.truncated ? [...new Map([
      ...(previous?.files ?? []).map(file => [file.fileId, file] as const),
      ...state.files.map(file => [file.fileId, file] as const),
    ]).values()].slice(-500) : state.files;
    const bounded = boundedArray(files, PUBLIC_VALUE_BYTES, items => ({ ...state, files: items, truncated: true }));
    const truncated = state.truncated || bounded.length < files.length;
    return this.#validated("files", HostFilesStateSchema, { ...state, files: bounded, truncated }, truncated ? "partial" : "complete");
  }
  operations(state: HostOperationsState): CommitResult { return this.#validated("operations", HostOperationsStateSchema, state, state.truncated ? "partial" : "complete"); }
  connections(state: HostConnectionsState): CommitResult { return this.#validated("connections", HostConnectionsStateSchema, state); }
  management(state: HostManagementState): CommitResult { return this.#validated("management", HostManagementStateSchema, state); }

  /** A failed reconciliation retains the last confirmed value and advertises that it is no longer current. */
  unknown(domain: HostStateDomain): CommitResult { return this.#commit(domain, null, "unknown", "unknown"); }

  readDomain<T>(domain: HostStateDomain): T | undefined {
    return this.#registry.read<T>(this.#scope(), domain)?.value ?? undefined;
  }

  #validated<T>(domain: HostStateDomain, schema: { parse: (input: unknown) => T }, state: T, completeness: DomainCompleteness = "complete"): CommitResult {
    try { return this.#commit(domain, schema.parse(state), "ready", completeness); }
    catch { return { ok: false, code: "invalid_fact", detail: domain }; }
  }

  #commit<T>(domain: HostStateDomain, value: T, availability: DomainAvailability, completeness: DomainCompleteness): CommitResult {
    const previous = this.#registry.read<unknown>(this.#scope(), domain);
    const effectiveValue = availability === "ready" ? value : previous?.value ?? null;
    const unchanged = previous?.availability === availability && previous.completeness === completeness &&
      JSON.stringify(previous.value) === JSON.stringify(effectiveValue);
    return this.#registry.commitValue(this.#scope(), domain, {
      source: { producer: "host", sourceId: `host:${domain}`, sourceEpoch: this.#epoch,
        sourceRevision: (previous?.source.sourceRevision ?? 0) + (unchanged ? 0 : 1) },
      availability, completeness, value,
    });
  }

  /** Legacy values also expose checkedAt; keep that field stable when only the envelope was rechecked. */
  #withCheckedAt<T>(domain: HostStateDomain, state: T): T & { checkedAt: number } {
    const previous = this.#registry.read<T & { checkedAt: number }>(this.#scope(), domain)?.value;
    if (previous) {
      const { checkedAt, ...content } = previous;
      if (isDeepStrictEqual(content, state)) return { ...state, checkedAt };
    }
    return { ...state, checkedAt: this.#now() };
  }

  /**
   * 记录一次目录聚合。
   *
   * 只要有一个后端没读全，整个目录就不是完整清单，因此 `completeness` 只能是 partial：
   * 客户端据此知道「这里少了东西」，而不是把缺席的会话当成已删除。
   */
  catalog(state: CatalogInput): void {
    const previous = this.#catalogInventory;
    let staged = false;
    try {
      if (state.sessions === undefined) {
        const complete = state.backends.every(backend => backend.complete) && !state.truncated;
        this.#commit("catalog", this.#withCheckedAt("catalog", state), "ready", complete ? "complete" : "partial");
        return;
      }
      const incompleteKinds = new Set(state.backends.filter(backend => !backend.complete).map(backend => backend.kind));
      const retained = previous?.sessions.filter(session => incompleteKinds.has(session.agentKind)) ?? [];
      const sessions = [...new Map([...retained, ...state.sessions].map(session => {
        const normalized = AgentSessionSummarySchema.parse(session);
        return [JSON.stringify([normalized.agentKind, normalized.sessionId]), normalized] as const;
      })).values()];
      const inventory = boundedArray(sessions.slice(0, CATALOG_INVENTORY_ENTRIES), CATALOG_INVENTORY_BYTES,
        items => ({ ...state, sessions: items }));
      const input = { ...state };
      delete input.snapshotId;
      delete input.nextCursor;
      // Reconciliation latency is operational metadata, not a change to the directory itself.
      const backends = input.backends.map(backend => {
        const prior = previous?.state.backends.find(candidate => candidate.kind === backend.kind);
        return prior && prior.ready === backend.ready && prior.sessions === backend.sessions && prior.complete === backend.complete && prior.error === backend.error
          ? { ...backend, elapsedMs: prior.elapsedMs } : backend;
      });
      const full: CatalogInput = { ...input, backends, sessions: inventory, totalSessions: Math.max(state.totalSessions, sessions.length),
        truncated: state.truncated || inventory.length < sessions.length };
      const fingerprint = JSON.stringify(full);
      const modelEpoch = this.#registry.currentModelEpoch();
      const snapshotId = previous?.fingerprint === fingerprint && previous.modelEpoch === modelEpoch ? previous.snapshotId : randomUUID();
      const projected = boundedArray(inventory.slice(0, 2_000), CATALOG_PAGE_VALUE_BYTES, items => ({ ...full, sessions: items, snapshotId }));
      const value = { ...full, sessions: projected, snapshotId,
        nextCursor: projected.length < inventory.length ? catalogCursor(snapshotId, projected.length) : null,
        // The committed domain is a bounded first page. More pages are not a lost
        // source inventory; nextCursor expresses their availability independently.
        truncated: full.truncated };
      const candidate = { snapshotId, modelEpoch, fingerprint, state: full, sessions: inventory };
      const validated = HostCatalogStateSchema.parse(this.#withCheckedAt("catalog", value));
      this.#catalogInventory = candidate;
      staged = true;
      const complete = full.backends.every(backend => backend.complete) && !value.truncated && projected.length === inventory.length;
      const committed = this.#commit("catalog", validated, "ready", complete ? "complete" : "partial");
      if (!committed.ok) this.#catalogInventory = previous;
    } catch {
      if (staged) this.#catalogInventory = previous;
      // 记账失败不影响会话目录的正常返回。
    }
  }

  catalogProviders(currentProviders: NonNullable<HostCatalogState["currentProviders"]>): void {
    if (this.#catalogInventory) this.catalog({ ...this.#catalogInventory.state, currentProviders });
  }

  /** Pages only expose the immutable inventory attached to the currently committed catalog version. */
  // ADR-0032 §7：分页不跨 snapshotId 拼接；别为省一次重读而混版本。
  catalogRange(request: Pick<AgentStateRangeRequest, "cursor" | "limit"> & { query?: CatalogQuery } = {}, hide?: AgentKind): HostCatalogRange {
    const state = this.#registry.read<HostCatalogState>(this.#scope(), "catalog");
    const full = this.#catalogInventory;
    const inventory = full && hide !== undefined ? this.#hiddenInventory(full, hide) : full;
    const empty = (error: NonNullable<HostCatalogRange["error"]>): HostCatalogRange => ({
      modelEpoch: this.#registry.currentModelEpoch(), revision: state?.revision ?? 0, snapshotId: state?.value?.snapshotId ?? null,
      offset: 0, totalSessions: inventory?.state.totalSessions ?? 0, sessions: [], nextCursor: null, complete: false, truncated: true, error,
    });
    if (!inventory || inventory.modelEpoch !== this.#registry.currentModelEpoch() || state?.value?.snapshotId !== inventory.snapshotId) return empty("catalog_unavailable");
    const query = request.query;
    const matched = query ? this.#catalogMatches(query, inventory) : inventory.sessions;
    const hash = query && queryKey(query);
    let offset = 0;
    if (request.cursor) {
      let cursor: unknown;
      if (request.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(request.cursor)) return empty("invalid_cursor");
      try { cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")); } catch { return empty("invalid_cursor"); }
      if (!Array.isArray(cursor) || cursor.length !== 2 + (query ? 1 : 0) + (hide === undefined ? 0 : 1)
        || typeof cursor[0] !== "string" || !Number.isSafeInteger(cursor[1]) || cursor[1] < 0
        || query && cursor[2] !== hash || hide !== undefined && cursor[query ? 3 : 2] !== `-${hide}`) return empty("invalid_cursor");
      if (cursor[0] !== inventory.snapshotId) return empty("snapshot_changed");
      offset = cursor[1] as number;
      if (offset > matched.length) return empty("invalid_cursor");
    }
    const limit = Number.isSafeInteger(request.limit) ? Math.max(1, Math.min(200, request.limit!)) : 100;
    const totals = new Map<string, number>();
    if (query) for (const row of matched) totals.set(row.cwd, (totals.get(row.cwd) ?? 0) + 1);
    const candidates = matched.slice(offset, offset + limit).map(row => query ? { ...row, directoryTotal: totals.get(row.cwd)! } : row);
    const sessions = boundedArray(candidates, CATALOG_PAGE_VALUE_BYTES, items => ({ sessions: items }));
    // One valid public row can exceed the 28 KiB target (e.g. escaped Unicode paths).
    // It still fits the 64 KiB hard page; never produce a cursor that points to itself.
    if (sessions.length === 0 && candidates[0]) sessions.push(candidates[0]);
    const next = offset + sessions.length;
    const backends = query?.agentKind ? inventory.state.backends.filter(backend => backend.kind === query.agentKind) : inventory.state.backends;
    const complete = backends.length > 0 && backends.every(backend => backend.complete) && !inventory.state.truncated;
    return { modelEpoch: inventory.modelEpoch, revision: state.revision, snapshotId: inventory.snapshotId,
      offset, totalSessions: query ? matched.length : inventory.state.totalSessions, sessions,
      nextCursor: next < matched.length ? catalogCursor(inventory.snapshotId, next, hide, hash) : null,
      complete, truncated: inventory.state.truncated };
  }

  #hidden: { source: CatalogInventory; hide: AgentKind; view: CatalogInventory } | undefined;
  /** The committed inventory without one agent kind; the order is kept, so a filtered prefix is a prefix of this view. */
  #hiddenInventory(inventory: CatalogInventory, hide: AgentKind): CatalogInventory {
    if (this.#hidden?.source === inventory && this.#hidden.hide === hide) return this.#hidden.view;
    const sessions = inventory.sessions.filter(session => session.agentKind !== hide);
    const removed = Math.max(inventory.sessions.length - sessions.length, inventory.state.backends.find(backend => backend.kind === hide)?.sessions ?? 0);
    const state: CatalogInput = { ...inventory.state, backends: inventory.state.backends.filter(backend => backend.kind !== hide),
      ...(inventory.state.currentProviders === undefined ? {} : { currentProviders: inventory.state.currentProviders.filter(row => row.agentKind !== hide) }),
      totalSessions: inventory.state.truncated ? Math.max(sessions.length, inventory.state.totalSessions - removed) : sessions.length };
    const view = { ...inventory, state, sessions };
    this.#hidden = { source: inventory, hide, view };
    return view;
  }

  /**
   * The committed catalog value as a device without `hide` sees it: same snapshot and revision,
   * sessions/rows of that kind removed, totals and next cursor from the filtered inventory.
   */
  hiddenCatalog(value: Record<string, unknown>, hide: AgentKind): Record<string, unknown> {
    const inventory = this.#catalogInventory;
    const keep = (row: unknown): boolean => !(row !== null && typeof row === "object" && (row as { agentKind?: unknown; kind?: unknown }).agentKind === hide)
      && !(row !== null && typeof row === "object" && (row as { kind?: unknown }).kind === hide);
    const next: Record<string, unknown> = { ...value };
    if (Array.isArray(value.sessions)) next.sessions = value.sessions.filter(keep);
    if (Array.isArray(value.backends)) next.backends = value.backends.filter(keep);
    if (Array.isArray(value.currentProviders)) next.currentProviders = value.currentProviders.filter(keep);
    if (!inventory || value.snapshotId !== inventory.snapshotId) {
      // No inventory for this version: never advertise a cursor whose offsets could not be honoured.
      const sessions = Array.isArray(next.sessions) ? next.sessions.length : 0;
      return { ...next, nextCursor: null, totalSessions: sessions, truncated: value.nextCursor !== null && value.nextCursor !== undefined || value.truncated === true };
    }
    const view = this.#hiddenInventory(inventory, hide);
    const count = Array.isArray(next.sessions) ? next.sessions.length : 0;
    return { ...next, totalSessions: view.state.totalSessions,
      nextCursor: count < view.sessions.length ? catalogCursor(inventory.snapshotId, count, hide) : null };
  }

  catalogQuery(request: CatalogQueryRequest, hide?: AgentKind): CatalogQueryPage {
    const page = this.catalogRange(request, hide);
    const full = this.#catalogInventory;
    const inventory = full && hide !== undefined ? this.#hiddenInventory(full, hide) : full;
    const rows = inventory?.sessions.filter(row => request.query.agentKind === null || row.agentKind === request.query.agentKind) ?? [];
    const all = [...new Set(rows.flatMap(row => row.modelProvider ? [row.modelProvider] : []))].sort();
    const providers = boundedArray(all.slice(0, 64), 8 * 1024, providers => providers);
    // Facets describe this immutable source inventory; loaded rows and global matches are separate.
    const groups = page.error ? [] : this.#catalogMatches(request.query, inventory);
    const counts = new Map<string, number>();
    for (const row of groups) counts.set(row.cwd, (counts.get(row.cwd) ?? 0) + 1);
    const previewCount = [...counts.values()].reduce((sum, count) => sum + Math.min(5, count), 0);
    return { type: "session.catalog.page", requestId: request.requestId, format: "v1", query: request.query, page,
      directoryCount: new Set(groups.map(row => row.cwd)).size,
      previewsComplete: page.offset + page.sessions.length >= previewCount,
      ...(request.cursor ? {} : { providers, unknownProvider: rows.some(row => !row.modelProvider), providersTruncated: providers.length < all.length }) };
  }

  #catalogMatches(query: CatalogQuery, inventory: CatalogInventory | undefined = this.#catalogInventory): AgentSessionSummary[] {
    const current = inventory?.state.currentProviders?.find(row => row.agentKind === query.agentKind)?.provider;
    const text = searchKey(query.text.trim());
    const matched = inventory?.sessions.filter(session =>
      (query.agentKind === null || session.agentKind === query.agentKind) && (session.archived === true) === query.archived &&
      (!query.directory || createHash("sha256").update(session.cwd).digest("hex") === query.directory) &&
      (!text || [session.cwd, session.name ?? "", session.firstMessage ?? "", session.sessionId].some(value => searchKey(value).includes(text))) &&
      (query.agentKind !== "codex" && query.agentKind !== "codexDesktop" || query.provider === "all" ||
        query.provider === "current" && current !== undefined && session.modelProvider === current ||
        query.provider === "unknown" && !session.modelProvider || query.provider.startsWith("provider:") && session.modelProvider === query.provider.slice(9))) ?? [];
    if (query.directory) return matched;
    // Surface directory headers and their five-row previews before hidden older rows.
    // Expanding a directory uses its exact path hash instead of downloading other groups.
    const groups = new Map<string, AgentSessionSummary[]>();
    for (const row of matched) { const group = groups.get(row.cwd) ?? []; group.push(row); groups.set(row.cwd, group); }
    return [...[...groups.values()].flatMap(rows => rows.slice(0, 5)), ...[...groups.values()].flatMap(rows => rows.slice(5))];
  }

  /**
   * 记录供应商公共投影（模块 20–22）。
   *
   * 与目录不同，这里没有「完整清单」的概念：某个后端没报摘要就是它缺席，客户端按 `unknown`
   * 处理，而不是把缺席当成「这台电脑没有供应商」。
   */
  providers(state: Omit<HostProvidersState, "checkedAt">): void {
    try {
      this.#commit("providers", this.#withCheckedAt("providers", state), state.providers.length === 0 ? "unknown" : "ready", "partial");
    } catch {
      // 记账失败不影响供应商命令本身的返回。
    }
  }

  /**
   * 记录诊断目录（模块 23 的读取侧）。
   *
   * 空 journal 是**事实**（这台电脑现在没有记录），所以 availability 是 ready 而不是 unknown；
   * 有没有缺口由 completeness 说：淘汰过或落盘失败过就是 partial，客户端据此知道手里的不是全部。
   */
  diagnostics(state: Omit<HostDiagnosticsState, "checkedAt">): void {
    try {
      this.#commit("diagnostics", this.#withCheckedAt("diagnostics", state), "ready",
        state.dropped > 0 || state.persistFailures > 0 ? "partial" : "complete");
    } catch {
      // 记账失败不影响记录本身：诊断是旁路。
    }
  }

  /** 供 Host 内部与测试读取当前诊断目录。 */
  readDiagnostics(): HostDiagnosticsState | undefined {
    return this.#registry.read<HostDiagnosticsState>(this.#scope(), "diagnostics")?.value ?? undefined;
  }

  /** 供 Host 内部与测试读取当前供应商投影。 */
  readProviders(): HostProvidersState | undefined {
    return this.#registry.read<HostProvidersState>(this.#scope(), "providers")?.value ?? undefined;
  }

  #scope(): StateScope {
    return { kind: "host" };
  }

  /** 供 Host 内部与测试读取当前目录模型。 */
  read(): HostCatalogState | undefined {
    return this.#registry.read<HostCatalogState>(this.#scope(), "catalog")?.value ?? undefined;
  }
}
