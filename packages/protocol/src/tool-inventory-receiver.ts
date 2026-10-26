import { AgentKeySchema, agentKeyId, type AgentKey } from "./agent-state.js";
import {
  ToolInventoryChangedSchema, ToolInventoryPageSchema, ToolInventoryPatchSchema, ToolInventoryReadRequestSchema,
  ToolInventorySnapshotSchema, toolInventoryPageMatchesSnapshot, toolJsonBytes,
  type ToolInventoryChanged, type ToolInventoryPage, type ToolInventoryPatch, type ToolInventoryReadRequest,
  type ToolInventoryReference, type ToolInventorySnapshot, type ToolInventoryVersion, type ToolSummary,
} from "./tool-activity.js";

export type ToolInventoryReceiverLimits = {
  maxTools: number; maxBytes: number; maxBufferedPatches: number; maxBufferedBytes: number; maxRetiredEpochs: number;
};
const defaults: ToolInventoryReceiverLimits = {
  maxTools: 4096, maxBytes: 8 * 1024 * 1024, maxBufferedPatches: 64, maxBufferedBytes: 1024 * 1024, maxRetiredEpochs: 64,
};
type Confirmed = { version: ToolInventoryVersion; source: ToolInventorySnapshot["source"]; records: Map<string, ToolSummary>; bytes: number };
type Pending = {
  snapshot: ToolInventorySnapshot; records: Map<string, ToolSummary>; bytes: number; cursor: string | null;
  request: ToolInventoryReadRequest | null; buffered: ToolInventoryPatch[]; bufferedBytes: number;
};
export type ToolInventoryReceiveResult = "applied" | "pending" | "ignored" | "recovery_required";
const compare = (a: ToolSummary, b: ToolSummary): number => a.order - b.order ||
  (a.tool.toolCallId < b.tool.toolCallId ? -1 : a.tool.toolCallId > b.tool.toolCallId ? 1 : 0);

/** ADR-0045 §5：整份基线和连续增量验证完成前，不替换已确认库存。 */
export class ToolInventoryReceiver {
  readonly #agent: AgentKey;
  readonly #runtimeId: string;
  readonly #limits: ToolInventoryReceiverLimits;
  readonly #retired = new Set<string>();
  #target: ToolInventorySnapshot | null = null;
  #confirmed: Confirmed | null = null;
  #pending: Pending | null = null;
  #recovery = true;

  constructor(agent: AgentKey, runtimeId: string, limits: Partial<ToolInventoryReceiverLimits> = {}) {
    this.#agent = AgentKeySchema.parse(agent); this.#runtimeId = runtimeId; this.#limits = { ...defaults, ...limits };
    if (Object.values(this.#limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("invalid_tool_receiver_limits");
  }

  /** Called only with a baseline descriptor accepted from the current authenticated Host. */
  begin(input: ToolInventorySnapshot): ToolInventoryReceiveResult {
    const parsed = ToolInventorySnapshotSchema.safeParse(input);
    if (!parsed.success || agentKeyId(parsed.data.agent) !== agentKeyId(this.#agent)) return this.#recover();
    const snapshot = parsed.data, previous = this.#target ?? this.#confirmed;
    if (this.#retired.has(snapshot.version.epoch)) return "ignored";
    if (previous && previous.version.epoch === snapshot.version.epoch &&
      (previous.source.epoch !== snapshot.source.epoch || snapshot.version.revision < previous.version.revision || snapshot.source.seq < previous.source.seq)) return "ignored";
    if (previous && previous.version.epoch === snapshot.version.epoch && previous.version.revision === snapshot.version.revision &&
      previous.source.seq !== snapshot.source.seq) return this.#recover();
    if (previous && previous.version.epoch === snapshot.version.epoch && snapshot.version.revision > previous.version.revision &&
      snapshot.source.seq <= previous.source.seq) return this.#recover();
    if (snapshot.totalCount !== null && snapshot.totalCount > this.#limits.maxTools) return this.#recover();
    if (previous && previous.version.epoch !== snapshot.version.epoch) {
      if (this.#retired.size >= this.#limits.maxRetiredEpochs) return this.#recover();
      this.#retired.add(previous.version.epoch);
    }
    this.#target = snapshot; this.#pending = { snapshot, records: new Map(), bytes: 0, cursor: null, request: null, buffered: [], bufferedBytes: 0 };
    this.#recovery = false;
    return "pending";
  }

  nextRequest(requestId: string, maxItems = 128): ToolInventoryReadRequest | undefined {
    const pending = this.#pending;
    if (!pending) return undefined;
    // Retrying a lost page keeps its original request identity, cursor and limits.
    if (pending.request) return structuredClone(pending.request);
    pending.request = ToolInventoryReadRequestSchema.parse({ type: "session.tools.read", requestId, runtimeId: this.#runtimeId,
      snapshot: pending.snapshot, cursor: pending.cursor, maxItems });
    return structuredClone(pending.request);
  }

  acceptPage(input: ToolInventoryPage): ToolInventoryReceiveResult {
    const parsed = ToolInventoryPageSchema.safeParse(input);
    if (!parsed.success) return this.#recover();
    const page = parsed.data, pending = this.#pending, request = pending?.request;
    // Late replies to superseded reads never discard the current pending baseline.
    if (!pending || !request || page.requestId !== request.requestId || page.snapshot.snapshotId !== pending.snapshot.snapshotId) return "ignored";
    if (page.runtimeId !== this.#runtimeId || !toolInventoryPageMatchesSnapshot(pending.snapshot, page) ||
      page.startIndex !== pending.records.size || page.tools.length > request.maxItems ||
      (page.nextCursor !== null && page.nextCursor === pending.cursor)) return this.#recover();
    let last = [...pending.records.values()].at(-1);
    for (const summary of page.tools) {
      if (pending.records.has(summary.tool.toolCallId) || (last && compare(last, summary) > 0)) return this.#recover();
      pending.records.set(summary.tool.toolCallId, summary); pending.bytes += toolJsonBytes(summary); last = summary;
      if (!this.#fits(pending.records, pending.bytes)) return this.#recover();
    }
    pending.cursor = page.nextCursor; pending.request = null;
    if (page.nextCursor !== null) return "pending";
    let candidate: Confirmed = { version: pending.snapshot.version, source: pending.snapshot.source, records: pending.records, bytes: pending.bytes };
    for (const patch of pending.buffered) {
      const applied = this.#apply(candidate, patch);
      if (!applied) return this.#recover();
      candidate = applied;
    }
    if (this.#confirmed && candidate.version.epoch === this.#confirmed.version.epoch &&
      candidate.version.revision === this.#confirmed.version.revision &&
      JSON.stringify([...candidate.records.values()].sort(compare)) !== JSON.stringify([...this.#confirmed.records.values()].sort(compare))) return this.#recover();
    this.#confirmed = candidate; this.#target = { ...pending.snapshot, version: candidate.version, source: candidate.source };
    this.#pending = null; this.#recovery = false;
    return "applied";
  }

  acceptPatch(input: ToolInventoryPatch): ToolInventoryReceiveResult {
    const parsed = ToolInventoryPatchSchema.safeParse(input);
    if (!parsed.success) return this.#recover();
    const patch = parsed.data;
    if (!this.#scope(patch)) return this.#recover();
    if (this.#retired.has(patch.version.epoch)) return "ignored";
    if (this.#recovery) return "recovery_required";
    const pending = this.#pending;
    if (pending) {
      const latest = pending.buffered.at(-1) ?? pending.snapshot;
      if (patch.version.epoch !== latest.version.epoch || patch.source.epoch !== latest.source.epoch) return this.#recover();
      if (patch.version.revision <= pending.snapshot.version.revision) return "ignored";
      if (patch.version.revision <= latest.version.revision) {
        return pending.buffered.some(previous => JSON.stringify(previous) === JSON.stringify(patch)) ? "ignored" : this.#recover();
      }
      if (patch.baseRevision !== latest.version.revision || patch.source.seq <= latest.source.seq) return this.#recover();
      const bytes = toolJsonBytes(patch);
      if (pending.buffered.length >= this.#limits.maxBufferedPatches || pending.bufferedBytes + bytes > this.#limits.maxBufferedBytes) return this.#recover();
      pending.buffered.push(patch); pending.bufferedBytes += bytes;
      this.#target = { ...pending.snapshot, version: patch.version, source: patch.source };
      return "pending";
    }
    const confirmed = this.#confirmed;
    if (!confirmed) return this.#recover();
    if (patch.version.epoch === confirmed.version.epoch && patch.source.epoch === confirmed.source.epoch) {
      if (patch.version.revision < confirmed.version.revision) return "ignored";
      if (patch.version.revision === confirmed.version.revision) {
        return patch.source.seq === confirmed.source.seq && patch.removes.every(id => !confirmed.records.has(id)) &&
          patch.upserts.every(summary => JSON.stringify(summary) === JSON.stringify(confirmed.records.get(summary.tool.toolCallId)))
          ? "ignored" : this.#recover();
      }
    }
    const next = this.#apply(confirmed, patch);
    if (!next) return this.#recover();
    this.#confirmed = next;
    if (this.#target) this.#target = { ...this.#target, version: next.version, source: next.source };
    return "applied";
  }

  acceptChanged(input: ToolInventoryChanged): ToolInventoryReceiveResult {
    const parsed = ToolInventoryChangedSchema.safeParse(input);
    if (!parsed.success || !this.#scope(parsed.data)) return this.#recover();
    const notice = parsed.data, latest = this.#pending?.buffered.at(-1) ?? this.#pending?.snapshot ?? this.#confirmed;
    if (this.#retired.has(notice.version.epoch) || (latest && notice.version.epoch === latest.version.epoch &&
      notice.source.epoch === latest.source.epoch && notice.version.revision <= latest.version.revision)) return "ignored";
    if (this.#target && notice.version.epoch === this.#target.version.epoch && notice.source.epoch === this.#target.source.epoch &&
      notice.version.revision > this.#target.version.revision && notice.source.seq > this.#target.source.seq) {
      this.#target = { ...this.#target, version: notice.version, source: notice.source };
    }
    return this.#recover();
  }

  /** No raw content read participates in this dependency check. */
  covers(reference: Pick<ToolInventoryReference, "agent" | "version" | "source">): boolean {
    const confirmed = this.#confirmed;
    return !this.#recovery && !this.#pending && confirmed !== null && agentKeyId(reference.agent) === agentKeyId(this.#agent) &&
      reference.version.epoch === confirmed.version.epoch && reference.version.revision === confirmed.version.revision &&
      reference.source.epoch === confirmed.source.epoch && reference.source.seq === confirmed.source.seq;
  }
  /** A correlated expired/failed read restarts inventory recovery, without clearing confirmed tools. */
  readFailed(requestId: string): ToolInventoryReceiveResult {
    return this.#pending?.request?.requestId === requestId ? this.#recover() : "ignored";
  }
  tools(): ToolSummary[] { return structuredClone([...(this.#confirmed?.records.values() ?? [])].sort(compare)); }
  state(): { version: ToolInventoryVersion | null; recoveryRequired: boolean; updating: boolean; bufferedPatches: number; bufferedBytes: number } {
    return { version: this.#confirmed ? { ...this.#confirmed.version } : null, recoveryRequired: this.#recovery,
      updating: this.#pending !== null, bufferedPatches: this.#pending?.buffered.length ?? 0, bufferedBytes: this.#pending?.bufferedBytes ?? 0 };
  }
  #scope(value: { agent: AgentKey; runtimeId: string }): boolean { return value.runtimeId === this.#runtimeId && agentKeyId(value.agent) === agentKeyId(this.#agent); }
  #fits(records: Map<string, ToolSummary>, bytes: number): boolean { return records.size <= this.#limits.maxTools && bytes <= this.#limits.maxBytes; }
  #recover(): ToolInventoryReceiveResult { this.#pending = null; this.#recovery = true; return "recovery_required"; }
  #apply(previous: Confirmed, patch: ToolInventoryPatch): Confirmed | null {
    if (patch.version.epoch !== previous.version.epoch || patch.source.epoch !== previous.source.epoch ||
      patch.baseRevision !== previous.version.revision || patch.source.seq <= previous.source.seq) return null;
    const records = new Map(previous.records); let bytes = previous.bytes;
    for (const id of patch.removes) { const old = records.get(id); if (!old) return null; bytes -= toolJsonBytes(old); records.delete(id); }
    for (const summary of patch.upserts) {
      const old = records.get(summary.tool.toolCallId); bytes += toolJsonBytes(summary) - (old ? toolJsonBytes(old) : 0);
      records.set(summary.tool.toolCallId, summary);
    }
    return this.#fits(records, bytes) ? { version: patch.version, source: patch.source, records, bytes } : null;
  }
}
