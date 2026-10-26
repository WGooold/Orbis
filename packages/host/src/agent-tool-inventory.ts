import { randomUUID } from "node:crypto";
import {
  AgentKeySchema, ToolInventoryChangedSchema, ToolInventoryPageSchema, ToolInventoryPatchSchema,
  ToolInventoryReadRequestSchema, ToolInventoryReferenceSchema, ToolSourceDependencySchema, ToolSummarySchema,
  TOOL_PAGE_BODY_MAX_BYTES, TOOL_PROJECTION_VERSION, agentKeyId, toolJsonBytes,
  type AgentKey, type ToolInventoryChanged, type ToolInventoryPage, type ToolInventoryPatch,
  type ToolInventoryReadRequest, type ToolInventoryReference, type ToolInventorySnapshot, type ToolSummary,
} from "@orbis/protocol";
import {
  AgentStateRegistry, commitPreparedRegistryTransaction, type PreparedRegistryCommit, type TransactionResult,
} from "./agent-state-registry.js";

export type ToolInventoryLimits = {
  maxSessions: number; maxToolsPerSession: number; maxTools: number;
  maxSessionBytes: number; maxBytes: number; maxRetiredEpochs: number;
  maxSnapshots: number; maxSnapshotBytes: number; snapshotTtlMs: number;
};
const defaults: ToolInventoryLimits = {
  maxSessions: 256, maxToolsPerSession: 4096, maxTools: 16384,
  maxSessionBytes: 8 * 1024 * 1024, maxBytes: 32 * 1024 * 1024, maxRetiredEpochs: 64,
  maxSnapshots: 32, maxSnapshotBytes: 16 * 1024 * 1024, snapshotTtlMs: 30_000,
};
type Source = ToolInventoryReference["source"];
type Inventory = {
  reference: ToolInventoryReference; latestSource: Source;
  records: ReadonlyMap<string, ToolSummary>; retired: ReadonlySet<string>;
};
type Snapshot = {
  owner: string; runtimeId: string; snapshot: ToolInventorySnapshot; tools: readonly ToolSummary[];
  bytes: number; expires: number; cursors: Map<string, number>; positions: Map<number, string>;
};
export type ToolInventoryMutation = {
  agent: AgentKey; runtimeId: string; source: Source;
  /** Authenticated producer's fixed reference, verified against the complete locally received pages. */
  reference?: ToolInventoryReference;
  /** Baseline is a complete authoritative inventory; patch removes must be explicit. */
  update: { kind: "baseline"; tools: readonly ToolSummary[] } |
    { kind: "patch"; upserts: readonly ToolSummary[]; removes: readonly string[] };
};
export type PreparedToolInventory = PreparedRegistryCommit & {
  readonly reference: ToolInventoryReference;
  readonly publication: ToolInventoryPatch | ToolInventoryChanged | null;
};
export class ToolInventoryError extends Error {
  constructor(readonly code: "invalid_inventory" | "inventory_limit" | "source_baseline_required" |
    "stale_source" | "source_conflict" | "snapshot_expired" | "scope_mismatch" | "invalid_cursor" | "busy") { super(code); }
}
const fail = (code: ToolInventoryError["code"]): never => { throw new ToolInventoryError(code); };
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const ordered = (records: ReadonlyMap<string, ToolSummary>): ToolSummary[] => [...records.values()]
  .sort((a, b) => a.order - b.order || (a.tool.toolCallId < b.tool.toolCallId ? -1 : a.tool.toolCallId > b.tool.toolCallId ? 1 : 0));

/** ADR-0045 §5：Registry 只保存描述符；固定版本摘要页不随后续工具更新变化。 */
export class AgentToolInventory {
  readonly #registry: AgentStateRegistry;
  readonly #limits: ToolInventoryLimits;
  readonly #now: () => number;
  readonly #unsubscribe: () => void;
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #inventories = new Map<string, Inventory>();
  readonly #snapshots = new Map<string, Snapshot>();
  #generation = 0;
  #bytes = 0;
  #tools = 0;
  #snapshotBytes = 0;
  #disposed = false;

  constructor(registry: AgentStateRegistry, options: { limits?: Partial<ToolInventoryLimits>; now?: () => number } = {}) {
    this.#registry = registry; this.#now = options.now ?? Date.now;
    this.#limits = { ...defaults, ...options.limits };
    if (Object.values(this.#limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("invalid_tool_inventory_limits");
    this.#unsubscribe = registry.subscribe(change => {
      if (change.kind === "reset") this.#clear();
      if (change.kind === "closed" && change.domain === "tools" && change.scope.kind === "agent") {
        const key = agentKeyId(change.scope.key), old = this.#inventories.get(key);
        if (old) { this.#bytes -= old.reference.summaryBytes; this.#tools -= old.records.size; this.#inventories.delete(key); }
        for (const [id, snapshot] of this.#snapshots) if (agentKeyId(snapshot.snapshot.agent) === key) this.#dropSnapshot(id);
        this.#generation++;
      }
    });
    this.#timer = setInterval(() => this.#sweep(), Math.min(1000, this.#limits.snapshotTtlMs));
    this.#timer.unref();
  }

  prepare(input: ToolInventoryMutation): PreparedToolInventory {
    if (this.#disposed) return fail("invalid_inventory");
    const agent = AgentKeySchema.parse(input.agent), source = ToolSourceDependencySchema.parse(input.source);
    const key = agentKeyId(agent), previous = this.#inventories.get(key);
    const replaced = previous !== undefined && previous.latestSource.epoch !== source.epoch;
    if ((!previous || replaced) && input.update.kind !== "baseline") return fail("source_baseline_required");
    if (previous?.retired.has(source.epoch) || (previous && !replaced && source.seq < previous.latestSource.seq)) return fail("stale_source");
    const retired = new Set(previous?.retired);
    if (replaced) retired.add(previous!.latestSource.epoch);
    if (retired.size > this.#limits.maxRetiredEpochs) return fail("inventory_limit");
    const upserts = input.update.kind === "baseline" ? input.update.tools : input.update.upserts;
    const removes = input.update.kind === "baseline" ? [] : input.update.removes;
    if (upserts.length > this.#limits.maxToolsPerSession || removes.length > this.#limits.maxToolsPerSession) return fail("inventory_limit");
    const records = new Map(input.update.kind === "patch" ? previous!.records : []);
    const touched = new Set<string>();
    for (const raw of upserts) {
      const summary = ToolSummarySchema.parse(raw), id = summary.tool.toolCallId;
      if (agentKeyId(summary.tool.agent) !== key || touched.has(id)) return fail("invalid_inventory");
      touched.add(id); records.set(id, freeze(summary));
    }
    for (const id of removes) {
      if (typeof id !== "string" || id.trim() === "" || touched.has(id) || !records.has(id)) return fail("invalid_inventory");
      touched.add(id); records.delete(id);
    }
    const summaryBytes = [...records.values()].reduce((sum, summary) => sum + toolJsonBytes(summary), 0);
    const totalBytes = this.#bytes - (previous?.reference.summaryBytes ?? 0) + summaryBytes;
    const totalTools = this.#tools - (previous?.records.size ?? 0) + records.size;
    if ((!previous && this.#inventories.size >= this.#limits.maxSessions) ||
      records.size > this.#limits.maxToolsPerSession || summaryBytes > this.#limits.maxSessionBytes ||
      totalBytes > this.#limits.maxBytes || totalTools > this.#limits.maxTools) return fail("inventory_limit");
    const changed = !previous || replaced || records.size !== previous.records.size ||
      [...records].some(([id, summary]) => JSON.stringify(summary) !== JSON.stringify(previous.records.get(id)));
    if (previous && !replaced && changed && source.seq === previous.latestSource.seq) return fail("source_conflict");
    let reference = changed ? freeze(ToolInventoryReferenceSchema.parse({
      projectionVersion: TOOL_PROJECTION_VERSION, agent, source, totalCount: records.size, summaryBytes,
      version: { epoch: !previous || replaced ? randomUUID() : previous.reference.version.epoch,
        revision: !previous || replaced ? 1 : previous.reference.version.revision + 1 },
    })) : previous!.reference;
    if (input.reference) {
      const supplied = ToolInventoryReferenceSchema.parse(input.reference);
      if (agentKeyId(supplied.agent) !== key || supplied.source.epoch !== source.epoch || supplied.source.seq > source.seq ||
        supplied.totalCount !== records.size || supplied.summaryBytes !== summaryBytes ||
        !changed && JSON.stringify(supplied) !== JSON.stringify(previous!.reference) ||
        changed && previous && !replaced && (supplied.version.epoch !== previous.reference.version.epoch || supplied.version.revision <= previous.reference.version.revision)) return fail("invalid_inventory");
      reference = freeze(supplied);
    }
    let publication: ToolInventoryPatch | ToolInventoryChanged | null = null;
    if (changed) {
      const metadata = { runtimeId: input.runtimeId, agent, source, version: reference.version };
      const delta = previous && !replaced ? ToolInventoryPatchSchema.safeParse({
        type: "session.tools.patch", ...metadata, baseRevision: previous.reference.version.revision,
        upserts: [...records].filter(([id, summary]) => JSON.stringify(summary) !== JSON.stringify(previous.records.get(id))).map(([, summary]) => summary),
        removes: [...previous.records.keys()].filter(id => !records.has(id)),
      }) : undefined;
      publication = freeze(delta?.success ? delta.data : ToolInventoryChangedSchema.parse({ type: "session.tools.changed", ...metadata }));
    } else {
      // Validate routing identity even when this heartbeat produces no wire mutation.
      ToolInventoryChangedSchema.parse({ type: "session.tools.changed", runtimeId: input.runtimeId, agent, source, version: reference.version });
    }
    const generation = this.#generation, modelEpoch = this.#registry.currentModelEpoch();
    const next: Inventory = { reference, latestSource: source, records, retired };
    return { owner: this, reference, publication, conversationSource: { agent, ...source },
      changes: [{ kind: "value", scope: { kind: "agent", key: agent }, domain: "tools", fact: {
        source: { producer: "adapter", sourceId: `tools:${agent.agentKind}`, sourceEpoch: source.epoch, sourceRevision: source.seq },
        modelEpoch, availability: "ready", completeness: "complete", value: reference,
      } }],
      isCurrent: () => !this.#disposed && generation === this.#generation && modelEpoch === this.#registry.currentModelEpoch(),
      onCommitted: () => { this.#inventories.set(key, next); this.#bytes = totalBytes; this.#tools = totalTools; this.#generation++; },
    };
  }

  commit(plan: PreparedToolInventory, companions: readonly PreparedRegistryCommit[] = []): TransactionResult {
    if (plan.owner !== this) return { ok: false, code: "invalid_fact", detail: "prepared_owner_mismatch", index: 0 };
    return commitPreparedRegistryTransaction(this.#registry, [plan, ...companions]);
  }
  reference(agent: AgentKey): ToolInventoryReference | undefined { return this.#inventories.get(agentKeyId(agent))?.reference; }

  openSnapshot(owner: string, agent: AgentKey, runtimeId: string): ToolInventorySnapshot {
    this.#sweep();
    const inventory = this.#inventories.get(agentKeyId(agent));
    if (!inventory || this.#disposed) return fail("source_baseline_required");
    if (!owner.trim()) return fail("scope_mismatch");
    if (this.#snapshots.size >= this.#limits.maxSnapshots || this.#snapshotBytes + inventory.reference.summaryBytes > this.#limits.maxSnapshotBytes) return fail("busy");
    const { version, source, totalCount } = inventory.reference;
    const snapshot = freeze({ snapshotId: randomUUID(), agent: inventory.reference.agent, version, source, totalCount });
    // Validate the complete descriptor and routing fields, including their byte budget.
    ToolInventoryReadRequestSchema.parse({ type: "session.tools.read", requestId: "validate", runtimeId, snapshot, cursor: null, maxItems: 1 });
    this.#snapshots.set(snapshot.snapshotId, { owner, runtimeId, snapshot, tools: ordered(inventory.records),
      bytes: inventory.reference.summaryBytes, expires: this.#now() + this.#limits.snapshotTtlMs, cursors: new Map(), positions: new Map() });
    this.#snapshotBytes += inventory.reference.summaryBytes;
    return snapshot;
  }

  read(owner: string, input: ToolInventoryReadRequest): ToolInventoryPage {
    this.#sweep();
    const request = ToolInventoryReadRequestSchema.parse(input), lease = this.#snapshots.get(request.snapshot.snapshotId);
    if (!lease) return fail("snapshot_expired");
    if (owner !== lease.owner || request.runtimeId !== lease.runtimeId || JSON.stringify(request.snapshot) !== JSON.stringify(lease.snapshot)) return fail("scope_mismatch");
    const start = request.cursor === null ? 0 : lease.cursors.get(request.cursor);
    if (start === undefined) return fail("invalid_cursor");
    const tools: ToolSummary[] = [];
    const token = (position: number): string | null => {
      if (position === lease.tools.length) return null;
      let cursor = lease.positions.get(position);
      if (!cursor) { cursor = randomUUID(); lease.positions.set(position, cursor); lease.cursors.set(cursor, position); }
      return cursor;
    };
    const page = (): ToolInventoryPage => ({ type: "session.tools.page", requestId: request.requestId, runtimeId: request.runtimeId,
      snapshot: lease.snapshot, startIndex: start, endIndex: start + tools.length, tools, nextCursor: token(start + tools.length) });
    while (tools.length < request.maxItems && start + tools.length < lease.tools.length) {
      tools.push(lease.tools[start + tools.length]!);
      if (toolJsonBytes(page()) > TOOL_PAGE_BODY_MAX_BYTES) { tools.pop(); break; }
    }
    return ToolInventoryPageSchema.parse(page());
  }

  closeSnapshot(owner: string, snapshotId: string): void {
    if (this.#snapshots.get(snapshotId)?.owner === owner) this.#dropSnapshot(snapshotId);
  }
  closeOwner(owner: string): void { for (const [id, snapshot] of this.#snapshots) if (snapshot.owner === owner) this.#dropSnapshot(id); }
  closeRuntime(runtimeId: string): void { for (const [id, snapshot] of this.#snapshots) if (snapshot.runtimeId === runtimeId) this.#dropSnapshot(id); }
  stats(): { sessions: number; tools: number; bytes: number; snapshots: number; snapshotBytes: number } {
    this.#sweep(); return { sessions: this.#inventories.size, tools: this.#tools, bytes: this.#bytes, snapshots: this.#snapshots.size, snapshotBytes: this.#snapshotBytes };
  }
  dispose(): void { this.#disposed = true; clearInterval(this.#timer); this.#unsubscribe(); this.#clear(); }
  #sweep(): void { for (const [id, snapshot] of this.#snapshots) if (snapshot.expires <= this.#now()) this.#dropSnapshot(id); }
  #dropSnapshot(id: string): void { const snapshot = this.#snapshots.get(id); if (snapshot) { this.#snapshotBytes -= snapshot.bytes; this.#snapshots.delete(id); } }
  #clear(): void { this.#inventories.clear(); this.#snapshots.clear(); this.#bytes = 0; this.#tools = 0; this.#snapshotBytes = 0; this.#generation++; }
}
