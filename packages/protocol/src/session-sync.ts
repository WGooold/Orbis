import type {
  RemoteSessionEntry, RuntimeCommand, RuntimeEvent, RuntimeTurnTiming, SessionCheckpoint, SessionLiveState, SessionSourceEpoch,
  SessionSyncRange, SessionSyncRangeStatus,
} from "./index.js";

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

/** Selects a bounded canonical range. It never truncates, rewrites, or skips an Entry. */
export function selectSessionSyncSnapshot(
  entries: readonly RemoteSessionEntry[],
  sessionId: string,
  liveLeaf: string | null,
  request: Omit<SessionSyncRequest, "type">,
  turnTimings: readonly RuntimeTurnTiming[] = [],
  source?: { version: SessionSourceEpoch; live: SessionLiveState; checkpoint: SessionCheckpoint },
  /** Verified native tail boundary; omitted for graphs that claim complete ancestor coverage. */
  historyBoundaryParentId?: string,
): SessionSyncSnapshot {
  if (request.sessionId !== sessionId) throw new Error("session_mismatch");
  const range = request.range;
  if (range === undefined) throw new Error("session_sync_range_required");
  if (request.knownState !== undefined && range !== "preview") throw new Error("session_known_state_range_mismatch");
  // Keep the default response bounded for first paint; callers can request a larger history page
  // explicitly, subject to the byte limits below.
  const maxEntries = request.maxEntries ?? 30;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 2000) throw new Error("invalid_max_entries");
  const byId = new Map<string, RemoteSessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.entryId)) throw new Error("duplicate_entry_id");
    byId.set(entry.entryId, entry);
  }
  const targetLeafId = request.targetLeafId ?? liveLeaf;
  const branch = branchPath(byId, targetLeafId);
  const path = branch.path;
  let status = branch.status;
  const boundedPrefix = status === "missing_parent" && source?.version.ready === true &&
    historyBoundaryParentId !== undefined && path[0]?.parentId === historyBoundaryParentId;
  if (boundedPrefix) status = "complete";
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
    return {
      type: "session.snapshot", sessionId, syncId: request.syncId,
      cursor: { leafId: targetLeafId }, mode, entries: page,
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
    return selectSessionSyncSnapshot(entries, sessionId, liveLeaf, { ...request, knownState: undefined }, turnTimings, source, historyBoundaryParentId);
  }
  return snapshot;
}
