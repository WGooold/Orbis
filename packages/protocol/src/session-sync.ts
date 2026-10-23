import type {
  DisplayBatch, DisplayEntry, RemoteSessionEntry, RuntimeCommand, RuntimeEvent, RuntimeTurnTiming, SessionCheckpoint, SessionLiveState,
  SessionSourceEpoch, SessionSyncRange, SessionSyncRangeStatus,
} from "./index.js";
import { projectDisplayEntries } from "./display-entries.js";
import { WireTruncator } from "./wire-truncate.js";

export type SessionSyncRequest = Extract<RuntimeCommand, { type: "session.sync" }>;
export type SessionSyncSnapshot = Omit<Extract<RuntimeEvent, { type: "session.snapshot" }>,
  "range" | "targetLeafId" | "beforeEntryId" | "turnTimings" | "hasOlder" | "complete" | "rangeStatus"> & {
  range: SessionSyncRange;
  targetLeafId: string | null;
  beforeEntryId?: string | null;
  turnTimings: RuntimeTurnTiming[];
  hasOlder: boolean;
  complete: boolean;
  rangeStatus: SessionSyncRangeStatus;
  checkpoint?: SessionCheckpoint;
};
export const SESSION_SYNC_PAGE_BYTES = 256 * 1024;
export const SESSION_SYNC_MAX_BYTES = 1024 * 1024;
// A runtime.event wrapper has routing fields and a runtime ID (up to 256 Unicode characters).
export const SESSION_SYNC_WRAPPER_BYTES = 4096;

function branchPath(byId: ReadonlyMap<string, RemoteSessionEntry>, leaf: string | null): {
  path: RemoteSessionEntry[]; status: SessionSyncRangeStatus;
} {
  const reverse: RemoteSessionEntry[] = [];
  const visited = new Set<string>();
  let current = leaf;
  while (current !== null) {
    if (visited.has(current)) return { path: reverse.reverse(), status: "cycle_detected" };
    visited.add(current);
    const entry = byId.get(current);
    if (entry === undefined) {
      return { path: reverse.reverse(), status: reverse.length === 0 ? "leaf_not_found" : "missing_parent" };
    }
    reverse.push(entry);
    current = entry.parentId;
  }
  return { path: reverse.reverse(), status: "complete" };
}

/**
 * 会话同步的“预处理”部分：与“取哪一页”无关的工作（条目索引、分支路径、显示投影）。
 *
 * ADR-0035 §8：翻历史页时这些输入完全不变，只有页在变。拆出来之后，每页只做路径切片与
 * 页内序列化，而不是对整段历史重跑一遍显示投影。
 */
export type PreparedSessionSync = {
  sessionId: string;
  liveLeaf: string | null;
  byId: ReadonlyMap<string, RemoteSessionEntry>;
  path: readonly RemoteSessionEntry[];
  pathStatus: SessionSyncRangeStatus;
  boundedPrefix: boolean;
  display: ReturnType<typeof projectDisplayEntries>;
  /**
   * 显示条目按 entryId 的索引（含它在投影里的位置）。
   *
   * `displayBatchFromProjection` 是「过滤整份投影」，每页 O(投影条目数)；翻 400 页就是
   * O(页数 × S)。索引一次之后每页只按页内条目查表，再按投影位置排序以保持原顺序。
   */
  displayByEntryId: ReadonlyMap<string, { position: number; entry: DisplayEntry }>;
};

const TRUNCATOR = new WireTruncator();

export function prepareSessionSync(
  entries: readonly RemoteSessionEntry[],
  sessionId: string,
  liveLeaf: string | null,
  options: { historyBoundaryParentId?: string; sourceReady?: boolean } = {},
): PreparedSessionSync {
  // ADR-0038：超长文本在这条出口先按线路预算截断，再做页装配与字节判断。
  // 身份/版本字段来自原文，因此缓存键与 knownState 判断不受影响；按对象身份缓存，
  // 不可变条目只截断一次（ADR-0035 的引用复用是这里的成本前提）。
  entries = TRUNCATOR.entries(entries);
  const byId = new Map<string, RemoteSessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.entryId)) throw new Error("duplicate_entry_id");
    byId.set(entry.entryId, entry);
  }
  const branch = branchPath(byId, liveLeaf);
  let status = branch.status;
  const boundedPrefix = status === "missing_parent" && options.sourceReady === true &&
    options.historyBoundaryParentId !== undefined && branch.path[0]?.parentId === options.historyBoundaryParentId;
  if (boundedPrefix) status = "complete";
  // 显示投影只算一次，每页只挑自己那几条：分页不会把同一段历史重复归一 N 遍。
  const display = projectDisplayEntries([...byId.values()], liveLeaf, {
    boundaryParentId: boundedPrefix ? options.historyBoundaryParentId : undefined,
  });
  const displayByEntryId = new Map<string, { position: number; entry: DisplayEntry }>();
  display.entries.forEach((entry, position) => {
    if (entry.entryId !== null) displayByEntryId.set(entry.entryId, { position, entry });
  });
  return { sessionId, liveLeaf, byId, path: branch.path, pathStatus: status, boundedPrefix, display, displayByEntryId };
}

/** Selects a bounded canonical range from prepared state. It never truncates, rewrites, or skips an Entry. */
export function selectPreparedSessionSync(
  prepared: PreparedSessionSync,
  request: Omit<SessionSyncRequest, "type">,
  turnTimings: readonly RuntimeTurnTiming[] = [],
  source?: { version: SessionSourceEpoch; live: SessionLiveState; checkpoint: SessionCheckpoint },
  historyBoundaryParentId?: string,
): SessionSyncSnapshot {
  const { sessionId, byId, path, display: displayProjection } = prepared;
  if (request.sessionId !== sessionId) throw new Error("session_mismatch");
  const range = request.range;
  if (range === undefined) throw new Error("session_sync_range_required");
  if (request.knownState !== undefined && range !== "preview") throw new Error("session_known_state_range_mismatch");
  // Keep the default response bounded for first paint; callers can request a larger history page
  // explicitly, subject to the byte limits below.
  const maxEntries = request.maxEntries ?? 30;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 2000) throw new Error("invalid_max_entries");
  const targetLeafId = request.targetLeafId ?? prepared.liveLeaf;
  // 预处理绑定在一个 leaf 上；换 leaf 说明调用方用错了缓存，重新 prepare。
  if (targetLeafId !== prepared.liveLeaf) throw new Error("prepared_leaf_mismatch");
  const status = prepared.pathStatus;
  const boundedPrefix = prepared.boundedPrefix;  // 页内显示批次：查表 + 按投影位置排序，O(页) 而不是过滤整份投影。
  const displayFor = (page: readonly RemoteSessionEntry[]): DisplayBatch | undefined => {
    if (page.length === 0 || displayProjection.status !== "complete") return undefined;
    const hits: { position: number; entry: DisplayEntry }[] = [];
    for (const entry of page) {
      const hit = prepared.displayByEntryId.get(entry.entryId);
      if (hit !== undefined) hits.push(hit);
    }
    if (hits.length === 0) return undefined;
    hits.sort((left, right) => left.position - right.position);
    return {
      projectionVersion: displayProjection.projectionVersion,
      entries: hits.map((hit) => hit.entry),
      windowStart: displayProjection.windowStart,
    };
  };
  let candidates = path;
  let rangeStatus = status;
  let mode: SessionSyncSnapshot["mode"] = range === "history" ? "prepend" : "replace";
  let selection: SessionSyncSnapshot["selection"] = range === "preview" ? "snapshot" : undefined;
  const known = request.knownState;
  // A head ID alone is not a live-state watermark. Only a complete source checkpoint and a
  // committed same-epoch client baseline permit content suppression.
  const conditional = range === "preview" && status === "complete" && source !== undefined &&
    source.version.ready && source.checkpoint.headCompleteness === "complete" &&
    source.checkpoint.inventoryComplete && source.live.complete &&
    source.checkpoint.head.leafId === targetLeafId && known?.epoch === source.version.epoch &&
    known.seq <= source.version.seq;
  if (conditional && known !== undefined && source !== undefined) {
    if (known.head.leafId === targetLeafId && known.seq === source.version.seq) {
      return {
        type: "session.snapshot", sessionId, syncId: request.syncId,
        range, selection: "unchanged", cursor: { leafId: targetLeafId }, targetLeafId,
        mode: "append", entries: [], turnTimings: [], hasOlder: false, complete: true,
        rangeStatus: "complete", source: source.version, checkpoint: source.checkpoint,
      };
    }
    if (known.seq < source.version.seq) {
      if (known.head.leafId === targetLeafId) {
        candidates = [];
        selection = "state";
        mode = "append";
      } else {
        const index = known.head.leafId === null ? -1 : path.findIndex(entry => entry.entryId === known.head.leafId);
        if (known.head.leafId === null || index >= 0) {
          const suffix = path.slice(index + 1);
          if (suffix.length <= maxEntries) {
            candidates = suffix;
            selection = "delta";
            mode = "append";
          }
        }
      }
    }
  }
  if (range === "history") {
    const boundary = request.beforeEntryId ?? null;
    const index = boundary === null ? path.length : path.findIndex((entry) => entry.entryId === boundary);
    candidates = status === "complete" && index >= 0 ? path.slice(0, index) : [];
    if (status === "complete" && index < 0) rangeStatus = "range_start_not_found";
  } else if (range === "catchup" && request.knownLeafId != null) {
    const knownPath = branchPath(byId, request.knownLeafId).path;
    const knownIds = new Set(knownPath.map((entry) => entry.entryId));
    const common = path.reduce((index, entry, candidate) => knownIds.has(entry.entryId) ? candidate : index, -1);
    if (common >= 0) {
      mode = "append";
      candidates = path.slice(common + 1);
    }
  }
  // A malformed path cannot be evidence for canonical storage, even if its tail is renderable.
  if (rangeStatus !== "complete") candidates = [];
  const backwards = range !== "catchup";
  const timingsByMessage = new Map<string, RuntimeTurnTiming[]>();
  const unanchored: RuntimeTurnTiming[] = [];
  for (const timing of turnTimings) {
    if (timing.messageId === undefined) unanchored.push(timing);
    else timingsByMessage.set(timing.messageId, [...(timingsByMessage.get(timing.messageId) ?? []), timing]);
  }
  let timings = new Map((selection === "state" ? [] : unanchored).map((timing) => [timing.turnId, timing]));
  let selected: RemoteSessionEntry[] = [];
  const response = (page: RemoteSessionEntry[], pageTimings: ReadonlyMap<string, RuntimeTurnTiming>): SessionSyncSnapshot => {
    const remaining = candidates.length > page.length;
    const olderOutsideWindow = boundedPrefix && range !== "catchup" && selection !== "state" && selection !== "delta";
    const display = displayFor(page);
    return {
      type: "session.snapshot", sessionId, syncId: request.syncId,
      cursor: { leafId: targetLeafId }, mode, entries: page,
      ...(display === undefined ? {} : { display }),
      turnTimings: [...pageTimings.values()], range, targetLeafId,
      ...(range === "history" ? { beforeEntryId: request.beforeEntryId ?? null } : {}),
      hasOlder: backwards && (remaining || olderOutsideWindow),
      complete: rangeStatus === "complete" && !remaining && !olderOutsideWindow,
      rangeStatus: rangeStatus !== "complete" ? rangeStatus
        : remaining || olderOutsideWindow ? range === "history" ? "older_available" : "limit_reached" : "complete",
      ...(selection === undefined ? {} : { selection }),
      // All pages carry cache ownership. Only preview establishes head/live state.
      ...(source === undefined ? {} : { source: source.version }),
      ...(source === undefined || range !== "preview" ? {} : {
        live: source.live,
        checkpoint: source.checkpoint,
      }),
    };
  };
  const bytes = (snapshot: SessionSyncSnapshot): number =>
    Buffer.byteLength(JSON.stringify(snapshot), "utf8") + SESSION_SYNC_WRAPPER_BYTES;
  let snapshot = response(selected, timings);
  if (bytes(snapshot) > SESSION_SYNC_PAGE_BYTES) throw new Error("session_metadata_too_large");
  for (let index = 0; index < Math.min(candidates.length, maxEntries); index++) {
    const entry = candidates[backwards ? candidates.length - 1 - index : index]!;
    const next = backwards ? [entry, ...selected] : [...selected, entry];
    const nextTimings = new Map(timings);
    const message = entry.data.message;
    const messageId = message !== null && typeof message === "object" ? (message as { messageId?: unknown }).messageId : undefined;
    for (const id of [entry.entryId, ...(typeof messageId === "string" ? [messageId] : [])]) {
      for (const timing of timingsByMessage.get(id) ?? []) nextTimings.set(timing.turnId, timing);
    }
    const nextSnapshot = response(next, nextTimings);
    const size = bytes(nextSnapshot);
    if (size > SESSION_SYNC_PAGE_BYTES && selected.length > 0) break;
    if (size > SESSION_SYNC_MAX_BYTES) throw new Error("session_entry_too_large");
    selected = next;
    timings = nextTimings;
    snapshot = nextSnapshot;
    if (size > SESSION_SYNC_PAGE_BYTES) break;
  }
  // Never label a truncated suffix as a complete incremental recovery. Existing cache-hole
  // paging can fill the ancestors of a bounded recovery snapshot without changing live state.
  if (selection === "delta" && !snapshot.complete) {
    return selectPreparedSessionSync(prepared, { ...request, knownState: undefined }, turnTimings, source, historyBoundaryParentId);
  }
  return snapshot;
}

/** 一次性调用（不做缓存的后端）：prepare + select。 */
export function selectSessionSyncSnapshot(
  entries: readonly RemoteSessionEntry[],
  sessionId: string,
  liveLeaf: string | null,
  request: Omit<SessionSyncRequest, "type">,
  turnTimings: readonly RuntimeTurnTiming[] = [],
  source?: { version: SessionSourceEpoch; live: SessionLiveState; checkpoint: SessionCheckpoint },
  historyBoundaryParentId?: string,
): SessionSyncSnapshot {
  return selectPreparedSessionSync(
    // 一次性调用：请求可以显式指定 targetLeafId（旧行为），预处理要按那个 leaf 建。
    prepareSessionSync(entries, sessionId, request.targetLeafId ?? liveLeaf, {
      ...(historyBoundaryParentId === undefined ? {} : { historyBoundaryParentId }),
      ...(source === undefined ? {} : { sourceReady: source.version.ready }),
    }),
    request, turnTimings, source, historyBoundaryParentId,
  );
}

/**
 * 每个会话一份的同步预处理缓存（ADR-0035 §10）。
 *
 * Codex / DSH 每次 `session.sync` 都会重来一遍 prepare（全量索引 + 显示投影），翻 400 页就是
 * 400 × O(S)。这里按「来源版本 + 条目数 + leaf + 调用方给的改写信号」缓存 prepare 结果，
 * 翻页只走 select。失效判据是来源事实，不是再算一遍比较。
 */
export type SessionSyncSelectionInput = {
  entries: readonly RemoteSessionEntry[];
  sessionId: string;
  leafId: string | null;
  request: Omit<SessionSyncRequest, "type">;
  turnTimings?: readonly RuntimeTurnTiming[];
  source?: { version: SessionSourceEpoch; live: SessionLiveState; checkpoint: SessionCheckpoint };
  historyBoundaryParentId?: string;
  /**
   * 条目集被**原地**改写时的额外信号（Codex 用它已有的 `sourceSeq`）。
   * 缺省时只靠来源 epoch 与条目数判断。
   */
  revision?: string | number;
};

export class SessionSyncPreparer {
  #cache: { key: string; prepared: PreparedSessionSync } | undefined;

  /** 条目集被替换/修正后调用；翻页不要调用。 */
  invalidate(): void {
    this.#cache = undefined;
  }

  select(input: SessionSyncSelectionInput): SessionSyncSnapshot {
    const target = input.request.targetLeafId ?? input.leafId;
    const key = [
      input.sessionId, target, input.leafId ?? "", input.entries.length,
      input.source?.version.epoch ?? "-", input.source?.version.ready ? 1 : 0,
      input.historyBoundaryParentId ?? "", input.revision ?? "",
    ].join("\u0000");
    if (this.#cache?.key !== key) {
      this.#cache = {
        key,
        prepared: prepareSessionSync(input.entries, input.sessionId, target, {
          ...(input.historyBoundaryParentId === undefined ? {} : { historyBoundaryParentId: input.historyBoundaryParentId }),
          ...(input.source === undefined ? {} : { sourceReady: input.source.version.ready }),
        }),
      };
    }
    return selectPreparedSessionSync(
      this.#cache.prepared, input.request, input.turnTimings ?? [], input.source, input.historyBoundaryParentId,
    );
  }
}
