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
    val cacheOnly = pending.range == "history" || state.conversations[runtimeId]?.sourceEpoch != null &&
        (pending.range != "preview" || snapshot.source == null)
    val observed = if (cacheOnly) null else
        (pending.targetLeafId ?: snapshot.targetLeafId ?: snapshot.cursor.leafId)?.takeIf { id ->
            snapshot.entries.any { it.entryId == id } || store.contains(device, snapshot.sessionId, id)
        }
    return ingestCanonicalPage(store, device, snapshot, state, observed, ::owns,
        state.runtimes.getValue(runtimeId).agentKind)
}

internal fun RemoteState.ownsSessionPatch(runtimeId: String, patch: SessionPatch): Boolean {
    val runtime = runtimes[runtimeId] ?: return false
    val conversation = conversations[runtimeId] ?: RuntimeConversation()
    return runtime.sessionId == patch.sessionId && runtimeId !in sessionSyncFailures &&
        patch.source.epoch !in conversation.retiredSourceEpochs &&
        (patch.source.epoch != conversation.sourceEpoch || patch.seq > conversation.sourceSeq) &&
        patch.source.seq == patch.seq && patch.baseSeq >= 0 && patch.seq > patch.baseSeq
}

/** State transactions share the exact canonical validation/SQLite commit path with sync pages.
 * A future version can supplement the cache, but only the reducer's version gate moves the view. */
internal fun ingestSessionPatch(
    store: SessionGraphStore,
    device: DeviceCredential,
    runtimeId: String,
    patch: SessionPatch,
    currentState: () -> RemoteState,
    connectionCurrent: () -> Boolean,
): List<SessionGraphEntry>? {
    fun owns() = connectionCurrent() && currentState().ownsSessionPatch(runtimeId, patch)
    if (!owns()) return null
    require(patch.entries.size <= 256) { "session_patch_too_many_entries" }
    val state = currentState()
    val conversation = state.conversations[runtimeId]
    val applies = conversation?.sourceEpoch == patch.source.epoch && conversation.sourceReady &&
        conversation.sourceSeq == patch.baseSeq && patch.source.ready &&
        patch.headCompleteness == "complete" && patch.live.complete
    val observed = patch.head.leafId?.takeIf { id -> applies &&
        (patch.entries.any { it.entryId == id } || store.contains(device, patch.sessionId, id)) }
    return ingestCanonicalPage(store, device, patch.canonicalPage(), state, observed, ::owns,
        state.runtimes.getValue(runtimeId).agentKind)
}

private fun ingestCanonicalPage(
    store: SessionGraphStore,
    device: DeviceCredential,
    snapshot: SessionGraphSnapshot,
    state: RemoteState,
    observed: String?,
    owns: () -> Boolean,
    agentKind: String?,
): List<SessionGraphEntry>? {
    // Validate the same immutable content against the published window before committing disk.
    (state.sessionGraphs[snapshot.sessionId] ?: SessionGraph(snapshot.sessionId)).merge(snapshot)
    try {
        store.upsert(device, snapshot.sessionId, snapshot.entries, observed,
            snapshot.turnTimings.orEmpty(), writeGuard = owns, agentKind = agentKind)
    } catch (error: SessionGraphStoreException) {
        if (error.message == "stale_snapshot") return null
        throw error
    }
    val entries = store.readEntries(device, snapshot.sessionId, snapshot.entries.map { it.entryId })
    return entries.takeIf { owns() }
}
