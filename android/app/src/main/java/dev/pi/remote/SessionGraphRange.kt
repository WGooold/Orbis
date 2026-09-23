package dev.pi.remote

enum class SessionGraphRangeStatus {
    COMPLETE,
    OLDER_AVAILABLE,
    LEAF_NOT_FOUND,
    RANGE_START_NOT_FOUND,
    MISSING_PARENT,
    CYCLE_DETECTED,
    LIMIT_REACHED,
}

data class SessionGraphRange(
    val entries: List<SessionGraphEntry>,
    val hasOlder: Boolean,
    val complete: Boolean,
    val status: SessionGraphRangeStatus = SessionGraphRangeStatus.COMPLETE,
)

data class SessionGraphPath(
    val entries: List<SessionGraphEntry>,
    val status: SessionGraphRangeStatus,
)

internal fun selectOlderSessionGraphRange(
    path: List<SessionGraphEntry>,
    beforeEntryId: String,
    maxEntries: Int,
): SessionGraphRange {
    if (maxEntries <= 0) return SessionGraphRange(
        emptyList(),
        hasOlder = true,
        complete = false,
        status = SessionGraphRangeStatus.LIMIT_REACHED,
    )
    val boundaryIndex = path.indexOfFirst { it.entryId == beforeEntryId }
    if (boundaryIndex < 0) return SessionGraphRange(
        emptyList(),
        hasOlder = false,
        complete = false,
        status = SessionGraphRangeStatus.RANGE_START_NOT_FOUND,
    )
    val older = path.take(boundaryIndex)
    val selected = older.takeLast(maxEntries)
    val hasOlder = older.size > selected.size
    return SessionGraphRange(
        entries = selected,
        hasOlder = hasOlder,
        complete = !hasOlder,
        status = if (hasOlder) SessionGraphRangeStatus.OLDER_AVAILABLE else SessionGraphRangeStatus.COMPLETE,
    )
}

internal fun walkSessionGraphPath(
    leafId: String?,
    maxEntries: Int,
    lookup: (String) -> SessionGraphEntry?,
): SessionGraphPath {
    if (leafId == null) return SessionGraphPath(emptyList(), SessionGraphRangeStatus.LEAF_NOT_FOUND)
    if (maxEntries <= 0) return SessionGraphPath(emptyList(), SessionGraphRangeStatus.LIMIT_REACHED)

    val rows = mutableListOf<SessionGraphEntry>()
    val visited = mutableSetOf<String>()
    var currentId: String? = leafId
    var status = SessionGraphRangeStatus.COMPLETE
    while (currentId != null && rows.size < maxEntries) {
        if (!visited.add(currentId)) {
            status = SessionGraphRangeStatus.CYCLE_DETECTED
            break
        }
        val entry = lookup(currentId)
        if (entry == null) {
            status = if (rows.isEmpty()) {
                SessionGraphRangeStatus.LEAF_NOT_FOUND
            } else {
                SessionGraphRangeStatus.MISSING_PARENT
            }
            break
        }
        rows += entry
        currentId = entry.parentId
    }
    if (status == SessionGraphRangeStatus.COMPLETE && currentId != null) {
        status = SessionGraphRangeStatus.LIMIT_REACHED
    }
    return SessionGraphPath(rows.asReversed(), status)
}

internal fun selectSessionGraphRange(
    path: List<SessionGraphEntry>,
    startEntryId: String? = null,
): SessionGraphRange {
    if (path.isEmpty()) return SessionGraphRange(
        emptyList(),
        hasOlder = false,
        complete = startEntryId == null,
        status = if (startEntryId == null) SessionGraphRangeStatus.COMPLETE else SessionGraphRangeStatus.RANGE_START_NOT_FOUND,
    )
    if (startEntryId == null) {
        val hasOlder = path.first().parentId != null
        return SessionGraphRange(
            path,
            hasOlder = hasOlder,
            complete = !hasOlder,
            status = if (hasOlder) SessionGraphRangeStatus.OLDER_AVAILABLE else SessionGraphRangeStatus.COMPLETE,
        )
    }
    val startIndex = path.indexOfFirst { it.entryId == startEntryId }
    if (startIndex < 0) {
        return SessionGraphRange(
            entries = path,
            hasOlder = path.first().parentId != null,
            complete = false,
            status = SessionGraphRangeStatus.RANGE_START_NOT_FOUND,
        )
    }
    return SessionGraphRange(
        entries = path.drop(startIndex),
        hasOlder = startIndex > 0,
        complete = true,
        status = if (startIndex > 0) SessionGraphRangeStatus.OLDER_AVAILABLE else SessionGraphRangeStatus.COMPLETE,
    )
}
