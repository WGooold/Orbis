import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  agentKeyId, CHANGE_PAGE_MAX_BYTES, CHANGE_PROJECTION_VERSION, FileChangeDetailPageSchema,
  TurnChangeSummarySchema, TurnChangesPageSchema, TurnChangesSummariesSchema,
  type AgentKey, type FileChangeMetadata, type RuntimeEvent, type TurnChangeSummary,
  type TurnChangesRequest, type FileChangeDetailReadRequest,
} from "@orbis/protocol";
import { compareTurnText, renderTurnDiff, type TextComparison } from "./turn-file-change-diff.js";
import { atomicJson, captureWorkspace, DEFAULT_CAPTURE_BUDGET, readCapturedText,
  type CaptureBudget, type CapturedFile, type WorkspaceSnapshot, type BlobStorageQuota } from "./turn-file-change-snapshot.js";

type Failure = Extract<RuntimeEvent, { type: "session.changes.failed" }>["reason"];
type Comparison = { metadata: FileChangeMetadata; before?: CapturedFile; after?: CapturedFile; index?: TextComparison };
type Record = { summary: TurnChangeSummary; runtimeId: string; cwd: string; before?: WorkspaceSnapshot; after?: WorkspaceSnapshot; files: Comparison[]; expired?: boolean };
type Lease = { deviceId: string; runtimeId: string; viewerId: string; comparison: string; expires: number };
type Options = {
  directory: string;
  scope: (runtimeId: string) => AgentKey | undefined;
  send: (deviceId: string, runtimeId: string, event: RuntimeEvent) => boolean;
  publish: (runtimeId: string, summary: TurnChangeSummary) => void;
  captureBudget?: Partial<CaptureBudget>;
  maxStorageBytes?: number;
  retentionMs?: number;
};
export type TurnChangeBegin = { runtimeId: string; agent: AgentKey; cwd: string; reviewTurnId: string; startedAt?: number; reliable: boolean; anchorEntryId?: string; capture?: boolean };
export type TurnChangeFinish = { reviewTurnId?: string; anchorEntryId?: string; outcome?: TurnChangeSummary["outcome"]; reliable?: boolean };
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const error = (reason: Failure): Error & { reason: Failure } => Object.assign(new Error(reason), { reason });
const cursor = (binding: string, offset: number): string => `${offset}.${digest(`${binding}:${offset}`).slice(0, 32)}`;
function position(value: string | null | undefined, binding: string): number {
  if (value == null) return 0;
  const offset = Number(value.split(".")[0]);
  if (!Number.isSafeInteger(offset) || offset < 0 || cursor(binding, offset) !== value) throw error("invalid-cursor");
  return offset;
}
const pairKey = (file: CapturedFile | undefined): string => file ? JSON.stringify([file.kind, file.mode, file.hash ?? null, file.unavailable ?? false]) : "absent";
const comparisonId = (record: Record, file: Comparison): string => JSON.stringify([record.summary.changeSetId, record.summary.manifestVersion, file.metadata.fileId, file.metadata.contentVersion]);

/** Host-owned turn snapshots. Request paths never name source files; all content reads use frozen IDs. */
export class TurnFileChangeService {
  readonly #options: Options;
  readonly #records = new Map<string, Record>();
  readonly #durable = new Map<string, TurnChangeSummary>();
  readonly #active = new Map<string, Record>();
  readonly #chains = new Map<string, Promise<void>>();
  readonly #writes = new Map<string, Promise<void>>();
  readonly #recordBytes = new Map<string, number>();
  readonly #work = new Set<Promise<void>>();
  readonly #leases = new Map<string, Lease>();
  readonly #requests = new Map<string, { runtimeId: string; token: object }>();
  readonly #inFlight = new Map<object, { deviceId: string; owner: string; comparison: string }>();
  readonly #rendered = new Map<string, Buffer>();
  readonly #quota: BlobStorageQuota;
  #renderedBytes = 0;
  #initialization: Promise<void> | undefined;
  #maintenance: Promise<void> = Promise.resolve();
  #closed = false;
  #comparing = 0;
  readonly #comparisonWaiters: Array<() => void> = [];
  constructor(options: Options) { this.#options = options; this.#quota = { used: 0, maximum: options.maxStorageBytes ?? 512 * 1024 * 1024, hashes: new Set() }; }

  initialize(): Promise<void> { return this.#initialization ??= this.#load(); }
  async #load(): Promise<void> {
    await mkdir(join(this.#options.directory, "records"), { recursive: true, mode: 0o700 });
    for (const name of (await readdir(join(this.#options.directory, "records"))).filter(name => /^[a-f0-9-]{36}\.json$/u.test(name)).slice(0, 1024)) {
      try {
        const path = join(this.#options.directory, "records", name);
        if ((await stat(path)).size > 32 * 1024 * 1024) continue;
        const record = JSON.parse(await readFile(path, "utf8")) as Record;
        record.summary = TurnChangeSummarySchema.parse(record.summary);
        if (!Array.isArray(record.files) || record.files.length > 20_000 || record.summary.changeSetId + ".json" !== name) continue;
        this.#records.set(record.summary.changeSetId, record); this.#durable.set(record.summary.changeSetId, structuredClone(record.summary)); this.#recordBytes.set(record.summary.changeSetId, jsonBytes(record));
        if (record.summary.state === "collecting" || record.summary.state === "finalizing") {
          record.summary.state = "unavailable"; record.summary.coverage = "unavailable";
          record.summary.reasons = [...new Set([...record.summary.reasons, "host-restarted-during-capture"])].slice(0, 32);
          delete record.before; delete record.after; record.files = [];
          await this.#persist(record);
        }
      } catch { /* Corrupt private records cannot authorize arbitrary reads. */ }
    }
    for (const hash of await readdir(join(this.#options.directory, "blobs")).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{64}$/u.test(hash)) continue;
      this.#quota.hashes.add(hash); this.#quota.used += await stat(join(this.#options.directory, "blobs", hash)).then(info => info.size, () => 0);
    }
    await this.#prune();
  }
  async #persist(record: Record, publish = false): Promise<void> {
    const id = record.summary.changeSetId;
    const work = (this.#writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      record.summary.revision++;
      const persisted = structuredClone(record);
      await atomicJson(join(this.#options.directory, "records", `${id}.json`), persisted);
      this.#recordBytes.set(id, jsonBytes(persisted));
      this.#durable.set(id, structuredClone(persisted.summary));
      if (publish) this.#publish(persisted);
    });
    this.#writes.set(id, work);
    try { await work; } finally { if (this.#writes.get(id) === work) this.#writes.delete(id); }
  }
  #publish(record: Record): void {
    try { this.#options.publish(record.runtimeId, TurnChangeSummarySchema.parse(record.summary)); } catch { /* Lost subscriptions do not change stored facts. */ }
  }
  #serialize(runtimeId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#chains.get(runtimeId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(operation);
    this.#chains.set(runtimeId, work);
    void work.finally(() => { if (this.#chains.get(runtimeId) === work) this.#chains.delete(runtimeId); }).catch(() => undefined);
    return work;
  }
  async begin(input: TurnChangeBegin): Promise<void> {
    await this.initialize();
    return this.#serialize(input.runtimeId, async () => {
      if (this.#closed) return;
      const same = [...this.#records.values()].find(record => agentKeyId(record.summary.agent) === agentKeyId(input.agent) && record.summary.reviewTurnId === input.reviewTurnId);
      if (same) return;
      const previous = this.#active.get(input.runtimeId);
      if (previous) { previous.summary.reasons.push("overlapping-turn-boundary"); await this.#finish(previous, { reliable: false }); }
      const record: Record = { runtimeId: input.runtimeId, cwd: input.cwd, files: [], summary: {
        projectionVersion: CHANGE_PROJECTION_VERSION, agent: input.agent, reviewTurnId: input.reviewTurnId, sourceTurnIds: [],
        changeSetId: randomUUID(), manifestVersion: 1, revision: 0, anchorEntryId: input.anchorEntryId ?? null,
        startedAt: input.startedAt ?? Date.now(), finishedAt: null, state: "collecting", outcome: "unknown",
        coverage: input.reliable ? "complete" : "partial", scope: "unknown", attribution: "workspace-window",
        reasons: input.reliable ? [] : ["start-boundary-unconfirmed"],
        fileCount: null, addedFiles: null, modifiedFiles: null, deletedFiles: null, additions: null, deletions: null, preview: [],
      } };
      this.#records.set(record.summary.changeSetId, record); this.#active.set(input.runtimeId, record);
      // Register protection before waiting: a collector already in flight finishes before capture writes.
      await this.#maintenance;
      if (input.capture === false) {
        record.summary.coverage = "unavailable"; record.summary.reasons = ["start-not-captured"];
      } else if ([...this.#records.values()].filter(value => value.summary.state === "collecting" || value.summary.state === "finalizing").length > 32) {
        record.summary.coverage = "unavailable"; record.summary.reasons.push("capture-concurrency-budget");
      } else {
        record.before = await captureWorkspace(input.cwd, this.#options.directory, { ...DEFAULT_CAPTURE_BUDGET, ...this.#options.captureBudget }, this.#quota);
        record.cwd = record.before.root; record.summary.scope = record.before.scope;
        for (const other of this.#active.values()) if (other !== record && other.cwd === record.cwd) {
          record.summary.reasons.push("concurrent-workspace-turn"); other.summary.reasons.push("concurrent-workspace-turn");
          record.summary.coverage = "partial"; other.summary.coverage = "partial";
        }
        if (!record.before.complete) record.summary.coverage = "partial";
        record.summary.reasons = [...new Set([...record.summary.reasons, ...record.before.reasons])].slice(0, 32);
      }
      await this.#persist(record, true);
    });
  }
  markUnreliable(runtimeId: string, reason: string, reviewTurnId?: string): void {
    const records = [...this.#records.values()].filter(record => record.runtimeId === runtimeId &&
      (reviewTurnId ? record.summary.reviewTurnId === reviewTurnId || record.summary.sourceTurnIds.includes(reviewTurnId) :
        this.#active.get(runtimeId) === record || record.summary.state === "finalizing"));
    for (const record of records) {
      if (record.summary.coverage !== "unavailable") record.summary.coverage = "partial";
      record.summary.reasons = [...new Set([...record.summary.reasons, reason.slice(0, 128)])].slice(0, 32);
      this.#track(this.#persist(record, true).catch(() => undefined));
    }
  }
  observeTurn(runtimeId: string, nativeTurnId: string): void {
    const record = this.#active.get(runtimeId);
    if (record && !record.summary.sourceTurnIds.includes(nativeTurnId)) {
      record.summary.sourceTurnIds.push(nativeTurnId);
      while (record.summary.sourceTurnIds.length > 128) record.summary.sourceTurnIds.shift();
      while (jsonBytes(record.summary) > 12 * 1024 && record.summary.preview.length) record.summary.preview.pop();
      while (jsonBytes(record.summary) > 12 * 1024 && record.summary.sourceTurnIds.length) record.summary.sourceTurnIds.shift();
    }
  }
  observeAnchor(runtimeId: string, reviewTurnId: string, entryId: string): void {
    const record = [...this.#records.values()].find(record => record.runtimeId === runtimeId && (record.summary.reviewTurnId === reviewTurnId || record.summary.sourceTurnIds.includes(reviewTurnId)));
    if (!record || record.summary.anchorEntryId === entryId) return;
    record.summary.anchorEntryId = entryId;
    const work = this.#persist(record, true).catch(() => undefined);
    this.#track(work);
  }
  async finish(runtimeId: string, input: TurnChangeFinish = {}): Promise<void> {
    await this.initialize();
    return this.#serialize(runtimeId, async () => {
      const record = this.#active.get(runtimeId);
      if (!record) return;
      if (input.reviewTurnId && input.reviewTurnId !== record.summary.reviewTurnId && !record.summary.sourceTurnIds.includes(input.reviewTurnId)) return;
      await this.#finish(record, input);
    });
  }
  async #finish(record: Record, input: TurnChangeFinish): Promise<void> {
    record.summary.state = "finalizing"; record.summary.finishedAt = Date.now();
    record.summary.outcome = input.outcome ?? "unknown";
    if (input.anchorEntryId) record.summary.anchorEntryId = input.anchorEntryId;
    if (input.reliable === false) { record.summary.coverage = "partial"; record.summary.reasons.push("end-boundary-unconfirmed"); }
    await this.#persist(record, true);
    await this.#maintenance;
    if (record.before) record.after = await captureWorkspace(record.cwd, this.#options.directory, { ...DEFAULT_CAPTURE_BUDGET, ...this.#options.captureBudget }, this.#quota);
    this.#active.delete(record.runtimeId);
    if (!record.before || !record.after) {
      record.summary.state = "unavailable"; record.summary.coverage = "unavailable"; await this.#persist(record, true); await this.#prune(); return;
    }
    if (!record.after.complete) record.summary.coverage = "partial";
    record.summary.reasons = [...new Set([...record.summary.reasons, ...record.after.reasons])].slice(0, 32);
    await this.#persist(record);
    this.#track(this.#finalize(record).catch(async (cause) => {
      record.summary.state = "unavailable"; record.summary.coverage = "unavailable";
      record.summary.reasons = [...new Set([...record.summary.reasons, cause instanceof Error && cause.message === "host-stopped-before-comparison" ? cause.message : "comparison-unavailable"])].slice(0, 32);
      delete record.before; delete record.after; record.files = [];
      await this.#persist(record, true);
    }));
  }
  #track(work: Promise<void>): void { this.#work.add(work); void work.finally(() => this.#work.delete(work)).catch(() => undefined); }
  async #finalize(record: Record): Promise<void> {
    if (this.#comparing >= 2) await new Promise<void>(resolve => this.#comparisonWaiters.push(resolve));
    this.#comparing++;
    try {
      if (this.#closed) throw new Error("host-stopped-before-comparison");
      const before = record.before!, after = record.after!;
      const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
      const indexes = new Map<string, TextComparison | undefined>();
      let indexBytes = 0, manifestBytes = 0;
      const comparisonDeadline = Date.now() + 10_000;
      for (const path of paths) {
        if (this.#closed) throw new Error("host-stopped-before-comparison");
        const old = before.files[path], next = after.files[path];
        if (pairKey(old) === pairKey(next) && !old?.unavailable && !next?.unavailable) continue;
        const uncertain = (!old && !before.complete) || (!next && !after.complete) || old?.unavailable || next?.unavailable;
        const metadata: FileChangeMetadata = {
          fileId: digest(path), path, changeKind: uncertain ? "unknown" : !old ? "added" : !next ? "deleted" : old.kind !== next.kind ? "type-changed" : "modified",
          fileKind: "unknown", additions: null, deletions: null, beforeBytes: old?.bytes ?? null, afterBytes: next?.bytes ?? null,
          contentVersion: digest(JSON.stringify([pairKey(old), pairKey(next), "jsdiff-9.0.0-lines-v1"])), detail: "not-captured",
        };
        const file: Comparison = { metadata, ...(old ? { before: old } : {}), ...(next ? { after: next } : {}) };
        if (!uncertain) {
          const kind = next?.kind ?? old?.kind;
          if (kind !== "file" || old && old.kind !== "file" || next && next.kind !== "file") {
            metadata.fileKind = kind === "file" ? "unknown" : kind ?? "unknown"; metadata.detail = "unsupported";
          } else if (old?.contentUnavailable || next?.contentUnavailable) { metadata.detail = "not-captured"; }
          else if (old && !old.blob || next && !next.blob) { metadata.detail = "too-large"; }
          else if (Date.now() >= comparisonDeadline) { metadata.detail = "busy"; record.summary.reasons.push("comparison-turn-budget"); }
          else {
            const [oldText, nextText] = await Promise.all([readCapturedText(this.#options.directory, old), readCapturedText(this.#options.directory, next)]);
            if (oldText === undefined || nextText === undefined) { metadata.fileKind = "binary"; metadata.detail = "binary"; }
            else {
              metadata.fileKind = "text";
              if ((oldText.match(/\n/g)?.length ?? 0) > 100_000 || (nextText.match(/\n/g)?.length ?? 0) > 100_000) metadata.detail = "too-large";
              else {
                let index = indexes.get(metadata.contentVersion);
                if (!indexes.has(metadata.contentVersion)) { index = await compareTurnText(oldText, nextText); if (indexes.size < 128) indexes.set(metadata.contentVersion, index); }
                if (index && indexBytes + jsonBytes(index) <= 8 * 1024 * 1024) {
                  indexBytes += jsonBytes(index); file.index = index; metadata.additions = index.additions; metadata.deletions = index.deletions; metadata.detail = "available";
                } else {
                  metadata.detail = "busy";
                  record.summary.reasons.push(index ? "comparison-index-budget" : "comparison-time-budget");
                }
              }
            }
          }
        }
        const fileBytes = jsonBytes(file);
        if (record.files.length >= 20_000 || manifestBytes + fileBytes > 24 * 1024 * 1024) {
          record.summary.coverage = "partial"; record.summary.reasons.push("manifest-budget"); break;
        }
        manifestBytes += fileBytes; record.files.push(file);
      }
      if (this.#closed) throw new Error("host-stopped-before-comparison");
      const files = record.files.map(file => file.metadata);
      record.summary.fileCount = files.length;
      record.summary.addedFiles = files.filter(file => file.changeKind === "added").length;
      record.summary.deletedFiles = files.filter(file => file.changeKind === "deleted").length;
      record.summary.modifiedFiles = files.filter(file => file.changeKind === "modified" || file.changeKind === "type-changed" || file.changeKind === "renamed").length;
      record.summary.additions = files.every(file => file.additions !== null) ? files.reduce((sum, file) => sum + file.additions!, 0) : null;
      record.summary.deletions = files.every(file => file.deletions !== null) ? files.reduce((sum, file) => sum + file.deletions!, 0) : null;
      record.summary.preview = files.slice(0, 4);
      while (jsonBytes(record.summary) > 8 * 1024 && record.summary.preview.length) record.summary.preview.pop();
      record.summary.reasons = [...new Set(record.summary.reasons)].slice(0, 32);
      record.summary.state = "ready";
      // Only changed-file references remain after finalization; unchanged baseline blobs may be collected.
      delete record.before; delete record.after;
      await this.#persist(record, true);
      await this.#prune();
    } finally { this.#comparing--; this.#comparisonWaiters.shift()?.(); }
  }
  async request(deviceId: string, runtimeId: string, request: TurnChangesRequest): Promise<void> {
    if (this.#closed) return;
    if (request.type === "session.change.detail.cancel") {
      if (runtimeId === request.runtimeId) this.#cancel(deviceId, runtimeId, request.viewerId, request.readId); return;
    }
    await this.initialize();
    const scope = this.#options.scope(runtimeId);
    if (runtimeId !== request.runtimeId || !scope || agentKeyId(scope) !== agentKeyId(request.agent)) { this.#failure(deviceId, request, "scope-mismatch"); return; }
    try {
      if (request.type === "session.changes.list") {
        const entries = new Set(request.entryIds), turns = new Set(request.turnIds);
        const records = [...this.#records.values()].filter(record => this.#durable.has(record.summary.changeSetId)).map(record => ({ ...record, summary: this.#durable.get(record.summary.changeSetId)! })).filter(record => agentKeyId(record.summary.agent) === agentKeyId(scope) &&
          (record.summary.anchorEntryId && entries.has(record.summary.anchorEntryId) || turns.has(record.summary.reviewTurnId) || record.summary.sourceTurnIds.some(id => turns.has(id))))
          .sort((a, b) => a.summary.startedAt - b.summary.startedAt || a.summary.changeSetId.localeCompare(b.summary.changeSetId));
        const binding = JSON.stringify([agentKeyId(scope), request.entryIds, request.turnIds, records.map(record => [record.summary.changeSetId, record.summary.manifestVersion])]);
        let offset = position(request.cursor, binding);
        const page = { type: "session.changes.summaries" as const, requestId: request.requestId, runtimeId, agent: scope, summaries: [] as TurnChangeSummary[], nextCursor: null as string | null };
        while (offset < records.length && page.summaries.length < 128) {
          page.summaries.push(records[offset]!.summary);
          if (jsonBytes(page) > CHANGE_PAGE_MAX_BYTES - 512) { page.summaries.pop(); break; }
          offset++;
        }
        page.nextCursor = offset < records.length ? cursor(binding, offset) : null;
        this.#send(deviceId, runtimeId, TurnChangesSummariesSchema.parse(page)); return;
      }
      const record = this.#records.get(request.changeSetId);
      if (!record) throw error("expired");
      if (agentKeyId(record.summary.agent) !== agentKeyId(scope)) throw error("scope-mismatch");
      if (record.summary.manifestVersion !== request.manifestVersion) throw error("version-mismatch");
      const durableState = this.#durable.get(record.summary.changeSetId)?.state;
      if (durableState !== "ready") throw error(durableState === "unavailable" ? "not-captured" : "busy");
      if (request.type === "session.changes.read") {
        const binding = JSON.stringify([request.changeSetId, request.manifestVersion]);
        let offset = position(request.cursor, binding);
        if (offset > record.files.length) throw error("invalid-cursor");
        const page = { type: "session.changes.page" as const, requestId: request.requestId, runtimeId, agent: scope,
          changeSetId: request.changeSetId, manifestVersion: request.manifestVersion, files: [] as FileChangeMetadata[], totalCount: record.files.length, nextCursor: null as string | null };
        while (offset < record.files.length && page.files.length < request.maxItems) {
          page.files.push(record.files[offset]!.metadata);
          if (jsonBytes(page) > CHANGE_PAGE_MAX_BYTES - 512) { page.files.pop(); break; }
          offset++;
        }
        page.nextCursor = offset < record.files.length ? cursor(binding, offset) : null;
        this.#send(deviceId, runtimeId, TurnChangesPageSchema.parse(page)); return;
      }
      await this.#detail(deviceId, runtimeId, request, record);
    } catch (cause) { this.#failure(deviceId, request, (cause as { reason?: Failure }).reason ?? "unavailable"); }
  }
  #send(deviceId: string, runtimeId: string, event: RuntimeEvent): void { this.#options.send(deviceId, runtimeId, event); }
  #failure(deviceId: string, request: { runtimeId: string; requestId: string }, reason: Failure): void {
    if (!this.#closed) this.#send(deviceId, request.runtimeId, { type: "session.changes.failed", runtimeId: request.runtimeId, requestId: request.requestId, reason });
  }
  async #detail(deviceId: string, runtimeId: string, request: FileChangeDetailReadRequest, record: Record): Promise<void> {
    if (record.expired) throw error("expired");
    const file = record.files.find(file => file.metadata.fileId === request.fileId);
    if (!file) throw error("not-captured");
    if (file.metadata.contentVersion !== request.contentVersion) throw error("version-mismatch");
    if (file.metadata.detail !== "available" || !file.index) throw error(file.metadata.detail === "available" ? "unavailable" : file.metadata.detail);
    const now = Date.now();
    // A 30-second expiry releases retention protection, not the bounded identity binding.
    // Renewing the same owner may continue at its immutable cursor after a reading pause.
    if (!request.readId) {
      const expired = [...this.#leases.entries()].filter(([, lease]) => lease.expires <= now).sort((a, b) => a[1].expires - b[1].expires);
      for (const [id, lease] of expired) {
        const deviceFull = [...this.#leases.values()].filter(value => value.deviceId === deviceId).length >= 64;
        if (this.#leases.size < 256 && !deviceFull) break;
        if (this.#leases.size >= 256 || deviceFull && lease.deviceId === deviceId) this.#leases.delete(id);
      }
    }
    const key = comparisonId(record, file), owner = JSON.stringify([deviceId, request.viewerId]);
    // Cancellation removes response ownership, but cannot pretend an outstanding file read has finished.
    if (this.#inFlight.size >= 4 || [...this.#inFlight.values()].some(read => read.owner === owner) ||
        [...this.#inFlight.values()].filter(read => read.deviceId === deviceId).length >= 2) throw error("busy");
    if (this.#leases.size >= 256 && !request.readId || [...this.#leases.values()].filter(lease => lease.deviceId === deviceId).length >= 64 && !request.readId) throw error("busy");
    const lease = request.readId ? this.#leases.get(request.readId) : undefined;
    if (request.readId && (!lease || lease.deviceId !== deviceId || lease.runtimeId !== runtimeId || lease.viewerId !== request.viewerId || lease.comparison !== key)) throw error("expired");
    const readId = request.readId ?? randomUUID();
    const token = {};
    this.#requests.set(owner, { runtimeId, token }); this.#inFlight.set(token, { deviceId, owner, comparison: key });
    try {
      let bytes = this.#rendered.get(key);
      if (!bytes) {
        const [before, after] = await Promise.all([readCapturedText(this.#options.directory, file.before), readCapturedText(this.#options.directory, file.after)]);
        if (this.#requests.get(owner)?.token !== token || this.#closed) return;
        if (before === undefined || after === undefined) throw error("expired");
        // Another permitted reader may have completed this exact immutable comparison while we read.
        bytes = this.#rendered.get(key);
        if (!bytes) {
          bytes = Buffer.from(renderTurnDiff(file.metadata.path, before, after, file.index, !!file.before, !!file.after), "utf8");
          while (this.#renderedBytes + bytes.length > 16 * 1024 * 1024 && this.#rendered.size) {
            const first = this.#rendered.keys().next().value!; this.#renderedBytes -= this.#rendered.get(first)!.length; this.#rendered.delete(first);
          }
          if (bytes.length <= 16 * 1024 * 1024) { this.#rendered.set(key, bytes); this.#renderedBytes += bytes.length; }
        }
      }
      if (this.#requests.get(owner)?.token !== token || this.#closed) return;
      const currentScope = this.#options.scope(runtimeId);
      if (!currentScope || agentKeyId(currentScope) !== agentKeyId(request.agent)) throw error("scope-mismatch");
      const offset = position(request.cursor, key);
      if (offset > bytes.length || offset > 0 && offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw error("invalid-cursor");
      let end = Math.min(bytes.length, offset + request.maxBytes);
      const base = { type: "session.change.detail.page" as const, requestId: request.requestId, runtimeId, agent: request.agent,
        changeSetId: request.changeSetId, manifestVersion: request.manifestVersion, fileId: request.fileId, contentVersion: request.contentVersion, viewerId: request.viewerId, readId };
      while (end > offset) {
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        const page = { ...base, text: bytes.subarray(offset, end).toString("utf8"), nextCursor: end < bytes.length ? cursor(key, end) : null, eof: end === bytes.length };
        if (jsonBytes(page) <= CHANGE_PAGE_MAX_BYTES) {
          this.#leases.set(readId, { deviceId, runtimeId, viewerId: request.viewerId, comparison: key, expires: Date.now() + 30_000 });
          this.#send(deviceId, runtimeId, FileChangeDetailPageSchema.parse(page)); return;
        }
        end = offset + Math.floor((end - offset) * 0.75);
      }
      if (offset === bytes.length) {
        this.#send(deviceId, runtimeId, FileChangeDetailPageSchema.parse({ ...base, text: "", nextCursor: null, eof: true })); return;
      }
      throw error("too-large");
    } finally { if (this.#requests.get(owner)?.token === token) this.#requests.delete(owner); this.#inFlight.delete(token); }
  }
  #cancel(deviceId: string, runtimeId: string, viewerId: string, readId: string | null): void {
    const owner = JSON.stringify([deviceId, viewerId]);
    if (this.#requests.get(owner)?.runtimeId === runtimeId) this.#requests.delete(owner);
    for (const [id, lease] of this.#leases) if (lease.deviceId === deviceId && lease.runtimeId === runtimeId && lease.viewerId === viewerId && (readId === null || readId === id)) this.#leases.delete(id);
  }
  releaseDevice(deviceId: string): void {
    for (const [id, lease] of this.#leases) if (lease.deviceId === deviceId) this.#leases.delete(id);
    for (const key of this.#requests.keys()) if ((JSON.parse(key) as string[])[0] === deviceId) this.#requests.delete(key);
  }
  releaseRuntime(runtimeId: string): void {
    for (const [id, lease] of this.#leases) if (lease.runtimeId === runtimeId) this.#leases.delete(id);
    for (const [key, request] of this.#requests) if (request.runtimeId === runtimeId) this.#requests.delete(key);
  }
  async settled(): Promise<void> { await Promise.allSettled([...this.#chains.values()]); while (this.#work.size) await Promise.allSettled([...this.#work]); await Promise.allSettled([...this.#writes.values()]); await this.#maintenance; }
  async close(): Promise<void> { this.#closed = true; this.#requests.clear(); this.#leases.clear(); await this.settled(); this.#rendered.clear(); this.#renderedBytes = 0; }
  #prune(): Promise<void> {
    const work = this.#maintenance.catch(() => undefined).then(() => this.#performPrune());
    this.#maintenance = work; return work;
  }
  async #performPrune(): Promise<void> {
    // Only the service's content-addressed private store is eligible for collection.
    const now = Date.now(), retention = this.#options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    const protectedIds = new Set([...this.#active.values()].map(record => record.summary.changeSetId));
    for (const record of this.#records.values()) if (record.summary.state === "finalizing") protectedIds.add(record.summary.changeSetId);
    for (const lease of this.#leases.values()) if (lease.expires > now) protectedIds.add((JSON.parse(lease.comparison) as string[])[0]!);
    for (const read of this.#inFlight.values()) protectedIds.add((JSON.parse(read.comparison) as string[])[0]!);
    const records = [...this.#records.values()].sort((a, b) => a.summary.startedAt - b.summary.startedAt);
    const references = new Map<string, number>();
    const hashes = (record: Record): Set<string> => new Set([...Object.values(record.before?.files ?? {}), ...Object.values(record.after?.files ?? {}), ...record.files.flatMap(file => [file.before, file.after].filter((value): value is CapturedFile => !!value))].flatMap(file => file.blob ? [file.blob] : []));
    for (const record of records) for (const hash of hashes(record)) references.set(hash, (references.get(hash) ?? 0) + 1);
    let total = 0, metadataBytes = [...this.#recordBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
    const sizes = new Map<string, number>();
    for (const name of await readdir(join(this.#options.directory, "blobs")).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{64}$/u.test(name)) continue;
      const size = await stat(join(this.#options.directory, "blobs", name)).then(info => info.size, () => 0);
      sizes.set(name, size); total += size;
    }
    for (const record of records) {
      if (protectedIds.has(record.summary.changeSetId)) continue;
      if (now - record.summary.startedAt <= retention && total <= (this.#options.maxStorageBytes ?? 512 * 1024 * 1024) && this.#records.size <= 512 && metadataBytes <= 64 * 1024 * 1024) continue;
      for (const hash of hashes(record)) { const left = (references.get(hash) ?? 1) - 1; references.set(hash, left); if (!left) total -= sizes.get(hash) ?? 0; }
      // Expiry removes retained content, while metadata remains usable for 30 days / 512 turns.
      if (now - record.summary.startedAt > 30 * 24 * 60 * 60 * 1000 || this.#records.size > 512 || metadataBytes > 64 * 1024 * 1024) {
        this.#records.delete(record.summary.changeSetId); this.#durable.delete(record.summary.changeSetId);
        metadataBytes -= this.#recordBytes.get(record.summary.changeSetId) ?? 0; this.#recordBytes.delete(record.summary.changeSetId);
        await rm(join(this.#options.directory, "records", `${record.summary.changeSetId}.json`), { force: true });
      } else {
        record.expired = true; delete record.before; delete record.after;
        record.files = record.files.map(file => ({ metadata: file.metadata }));
        await this.#persist(record);
      }
    }
    // Never collect while a baseline is being captured: its blobs are not published yet.
    if (this.#active.size) return;
    for (const hash of sizes.keys()) if (!references.get(hash)) {
      await rm(join(this.#options.directory, "blobs", hash), { force: true });
      this.#quota.used -= sizes.get(hash) ?? 0; this.#quota.hashes.delete(hash);
    }
  }
}
