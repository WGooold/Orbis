import type {
  RemoteSessionEntry, RuntimeCommand, RuntimeEvent, RuntimeTurnTiming, SessionSyncRange, SessionSyncRangeStatus,
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
): SessionSyncSnapshot {
  if (request.sessionId !== sessionId) throw new Error("session_mismatch");
  const range = request.range;
  if (range === undefined) throw new Error("session_sync_range_required");
  const maxEntries = request.maxEntries ?? 100;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 2000) throw new Error("invalid_max_entries");
  const byId = new Map<string, RemoteSessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.entryId)) throw new Error("duplicate_entry_id");
    byId.set(entry.entryId, entry);
  }
  const targetLeafId = request.targetLeafId ?? liveLeaf;
  const { path, status } = branchPath(byId, targetLeafId);
  let candidates = path;
  let rangeStatus = status;
  let mode: SessionSyncSnapshot["mode"] = range === "history" ? "prepend" : "replace";
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
  let timings = new Map(unanchored.map((timing) => [timing.turnId, timing]));
  let selected: RemoteSessionEntry[] = [];
  const response = (page: RemoteSessionEntry[], pageTimings: ReadonlyMap<string, RuntimeTurnTiming>): SessionSyncSnapshot => {
    const remaining = candidates.length > page.length;
    return {
      type: "session.snapshot", sessionId, syncId: request.syncId,
      cursor: { leafId: targetLeafId }, mode, entries: page,
      turnTimings: [...pageTimings.values()], range, targetLeafId,
      ...(range === "history" ? { beforeEntryId: request.beforeEntryId ?? null } : {}),
      hasOlder: backwards && remaining,
      complete: rangeStatus === "complete" && !remaining,
      rangeStatus: rangeStatus !== "complete" ? rangeStatus
        : remaining ? range === "history" ? "older_available" : "limit_reached" : "complete",
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
  return snapshot;
}
