package dev.pi.remote

/** One remote ingestion path, shared by all three ranges and exercised with real SQLite.
 * The caller serializes state changes around this operation; the guard is also checked inside
 * the transaction and after commit before publishing a projection. Null means obsolete work. */
internal fun ingestSessionSnapshot(
    store: SessionGraphStore,
    device: DeviceCredential,
    runtimeId: String,
    commandId: String,
    snapshot: SessionGraphSnapshot,
    currentState: () -> RemoteState,
    connectionCurrent: () -> Boolean,
): List<SessionGraphEntry>? {
    fun owns(): Boolean = connectionCurrent() && currentState().ownsSessionSnapshot(
        commandId, runtimeId, snapshot.sessionId, snapshot.syncId,
        snapshot.targetLeafId ?: snapshot.cursor.leafId, snapshot.range, snapshot.beforeEntryId,
    )
    if (!owns()) return null
    val state = currentState()
    val pending = state.sessionSyncCommands.getValue(commandId)
    require(snapshot.targetLeafId == null || snapshot.targetLeafId == snapshot.cursor.leafId) { "session_target_mismatch" }
    require(when (pending.range) {
        "preview" -> snapshot.mode == "replace"
        "history" -> snapshot.mode == "prepend"
        "catchup" -> snapshot.mode in setOf("replace", "append")
        else -> false
    }) { "session_range_mode_mismatch" }
    // Validate the same immutable content against the published window before committing disk.
    (state.sessionGraphs[snapshot.sessionId] ?: SessionGraph(snapshot.sessionId)).merge(snapshot)
    val observed = if (pending.range == "history") null else
        (pending.targetLeafId ?: snapshot.targetLeafId ?: snapshot.cursor.leafId)?.takeIf { id ->
            snapshot.entries.any { it.entryId == id } || store.contains(device, snapshot.sessionId, id)
        }
    try {
        store.upsert(device, snapshot.sessionId, snapshot.entries, observed,
            snapshot.turnTimings.orEmpty(), writeGuard = ::owns,
            agentKind = if (state.runtimes.getValue(runtimeId).isCodex) "codex" else "pi")
    } catch (error: SessionGraphStoreException) {
        if (error.message == "stale_snapshot") return null
        throw error
    }
    val entries = store.readEntries(device, snapshot.sessionId, snapshot.entries.map { it.entryId })
    return entries.takeIf { owns() }
}
