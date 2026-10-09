package dev.pi.remote

/** The reducer and SQLite writer must agree before authority can replace a cache generation. */
internal data class SessionSnapshotSourceGate(
    val cacheAllowed: Boolean,
    val stale: Boolean,
    val epochSwitchRejected: Boolean,
)

/** Validate conditional responses before either SQLite or the reducer can consume them. */
internal fun PendingSessionSync.validatePreviewSelection(snapshot: SessionGraphSnapshot) {
    require(snapshot.targetLeafId == null || snapshot.targetLeafId == snapshot.cursor.leafId) { "session_target_mismatch" }
    if (range != "preview") {
        require(snapshot.selection == null) { "session_selection_range_mismatch" }
        return
    }
    when (snapshot.selection ?: "snapshot") {
        "snapshot" -> require(snapshot.mode == "replace") { "session_range_mode_mismatch" }
        "state", "delta", "unchanged" -> {
            val known = requireNotNull(knownState) { "session_applied_state_missing" }
            val source = requireNotNull(snapshot.source) { "session_source_missing" }
            val checkpoint = requireNotNull(snapshot.checkpoint) { "session_checkpoint_missing" }
            require(snapshot.mode == "append" && source.ready && source.epoch == known.epoch &&
                checkpoint.headCompleteness == "complete" && checkpoint.inventoryComplete &&
                checkpoint.head == snapshot.cursor && snapshot.complete == true && snapshot.rangeStatus == "complete") {
                "session_conditional_response_invalid"
            }
            if (snapshot.selection == "unchanged") {
                require(source.seq == known.seq && checkpoint.head == known.head && snapshot.entries.isEmpty() &&
                    snapshot.turnTimings.orEmpty().isEmpty() && snapshot.live == null) { "session_unchanged_mismatch" }
            } else {
                require(source.seq > known.seq && snapshot.live?.complete == true) { "session_conditional_version_invalid" }
                if (snapshot.selection == "state") {
                    require(checkpoint.head == known.head && snapshot.entries.isEmpty() && snapshot.turnTimings.orEmpty().isEmpty()) {
                        "session_state_range_invalid"
                    }
                } else {
                    var parent = known.head.leafId
                    require(snapshot.entries.isNotEmpty()) { "session_delta_empty" }
                    snapshot.entries.forEach { entry ->
                        require(entry.parentId == parent) { "session_delta_gap" }
                        parent = entry.entryId
                    }
                    require(parent == checkpoint.head?.leafId) { "session_delta_head_mismatch" }
                }
            }
        }
        else -> error("session_selection_invalid")
    }
}

internal fun contiguousSourcePatches(epoch: String, seq: Long, patches: Collection<SessionPatch>): List<SessionPatch> {
    val result = mutableListOf<SessionPatch>()
    var base = seq
    for (patch in patches.filter { it.source.epoch == epoch && it.seq > seq }.sortedBy { it.seq }) {
        if (patch.baseSeq != base || patch.source.seq != patch.seq || patch.seq <= base ||
            !patch.source.ready || patch.headCompleteness != "complete" || !patch.live.complete) break
        result.add(patch)
        base = patch.seq
    }
    return result
}

internal fun mergedPatchEntries(entries: List<SessionGraphEntry>, patches: List<SessionPatch>): List<SessionGraphEntry> {
    val merged = validateCanonicalEntries(entries, { null }).toMutableMap()
    patches.forEach { patch -> merged.putAll(validateCanonicalEntries(patch.entries, { null })) }
    return merged.values.toList()
}

internal fun RuntimeConversation.snapshotSourceGate(
    snapshot: SessionGraphSnapshot,
    range: String,
    sourceRecovery: Boolean = false,
    sourceRecoveryEpoch: String? = sourceEpoch,
): SessionSnapshotSourceGate {
    val source = snapshot.source
    val cacheOnly = range != "preview" || source == null
    if (source == null) return SessionSnapshotSourceGate(sourceEpoch == null, sourceEpoch != null, false)
    val retired = source.epoch in retiredSourceEpochs
    if (cacheOnly) return SessionSnapshotSourceGate(
        source.ready && sourceReady && source.epoch == sourceEpoch && !retired,
        retired || source.epoch != sourceEpoch || !sourceReady || !source.ready, false,
    )
    val changed = sourceEpoch != null && sourceEpoch != source.epoch
    val stale = retired || sourceEpoch == source.epoch && source.seq < sourceSeq
    // Only the correlated recovery task can authorize a new source baseline. Display loading
    // can change while reading cached rows and cannot identify a recovery handshake.
    val currentRecovery = sourceRecovery && sourceRecoveryEpoch == sourceEpoch
    val rejected = changed && !retired && source.ready && sourceReady && !currentRecovery
    val complete = source.ready && snapshot.checkpoint?.head != null &&
        snapshot.checkpoint.headCompleteness == "complete" && snapshot.checkpoint.inventoryComplete &&
        snapshot.live?.complete == true
    return SessionSnapshotSourceGate(!stale && !rejected && complete, stale, rejected)
}

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
    pending.validatePreviewSelection(snapshot)
    // No data is carried: this acknowledges a fixed baseline and never writes a cache epoch.
    if (snapshot.selection == "unchanged") return emptyList()
    require(snapshot.targetLeafId == null || snapshot.targetLeafId == snapshot.cursor.leafId) { "session_target_mismatch" }
    require(when (pending.range) {
        "preview" -> snapshot.mode in setOf("replace", "append")
        "history" -> snapshot.mode == "prepend"
        "catchup" -> snapshot.mode in setOf("replace", "append")
        else -> false
    }) { "session_range_mode_mismatch" }
    val conversation = state.conversations[runtimeId] ?: RuntimeConversation()
    // A conditional reply cannot authorize a new baseline after its original one was invalidated.
    if (snapshot.selection in setOf("state", "delta") &&
        (!conversation.sourceReady || conversation.sourceEpoch != pending.knownState?.epoch)) return emptyList()
    val gate = conversation.snapshotSourceGate(
        snapshot, pending.range, pending.sourceRecovery, pending.sourceRecoveryEpoch,
    )
    // Leave rejected/unknown boundaries to the reducer; neither can modify persistent rows.
    if (!gate.cacheAllowed) return emptyList()
    val cacheOnly = pending.range == "history" || state.conversations[runtimeId]?.sourceEpoch != null &&
        (pending.range != "preview" || snapshot.source == null)
    val observed = if (cacheOnly) null else
        (pending.targetLeafId ?: snapshot.targetLeafId ?: snapshot.cursor.leafId)?.takeIf { id ->
            snapshot.entries.any { it.entryId == id } || store.contains(device, snapshot.sessionId, id)
        }
    val patches = snapshot.source?.takeIf { !cacheOnly }?.let { source ->
        contiguousSourcePatches(source.epoch, source.seq, state.conversations[runtimeId]?.sourcePatchBuffer?.values.orEmpty())
    }.orEmpty()
    val page = if (patches.isEmpty()) snapshot else snapshot.copy(
        entries = mergedPatchEntries(snapshot.entries, patches), source = patches.last().source,
    )
    val finalObserved = if (patches.isEmpty()) observed else patches.last().head.leafId?.takeIf { id ->
        page.entries.any { it.entryId == id } || store.contains(device, snapshot.sessionId, id)
    }
    return ingestCanonicalPage(store, device, page, state, finalObserved, ::owns,
        state.runtimes.getValue(runtimeId).agentKind, activateSource = !cacheOnly)
}

internal fun RemoteState.ownsSessionPatch(runtimeId: String, patch: SessionPatch): Boolean {
    val runtime = runtimes[runtimeId] ?: return false
    val conversation = conversations[runtimeId] ?: RuntimeConversation()
    return runtime.sessionId == patch.sessionId && runtimeId !in sessionSyncFailures &&
        patch.source.epoch !in conversation.retiredSourceEpochs &&
        (patch.source.epoch != conversation.sourceEpoch || patch.seq > conversation.sourceSeq) &&
        patch.source.seq == patch.seq && patch.baseSeq >= 0 && patch.seq > patch.baseSeq
}

/** State transactions share validation/SQLite with sync pages. Future patches stay buffered until
 * their version gap closes; a checkpoint can commit the same contiguous buffered suffix. */
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
    // Future epochs are recovery signals, not permission to modify the current cache.
    if (patch.source.epoch != conversation?.sourceEpoch || !patch.source.ready || !conversation.sourceReady)
        return emptyList()
    val patches = contiguousSourcePatches(patch.source.epoch, conversation.sourceSeq,
        (conversation.sourcePatchBuffer + (patch.seq to patch)).values)
    if (patches.isEmpty()) return emptyList()
    val page = patches.last().canonicalPage(mergedPatchEntries(emptyList(), patches))
    val observed = patches.last().head.leafId?.takeIf { id ->
        page.entries.any { it.entryId == id } || store.contains(device, patch.sessionId, id) }
    return ingestCanonicalPage(store, device, page, state, observed, ::owns,
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
    activateSource: Boolean = false,
): List<SessionGraphEntry>? {
    // SQLite owns persisted row versions. A bounded memory window may not know the newer
    // version of a disk row, so it cannot veto an authoritative page before disk filters it.
    if (snapshot.source == null) (state.sessionGraphs[snapshot.sessionId] ?: SessionGraph(snapshot.sessionId)).merge(snapshot)
    else validateCanonicalEntries(snapshot.entries, { null })
    try {
        store.upsert(device, snapshot.sessionId, snapshot.entries, observed,
            snapshot.turnTimings.orEmpty(), writeGuard = owns, agentKind = agentKind,
            source = snapshot.source, activateSource = activateSource)
    } catch (error: SessionGraphStoreException) {
        if (error.message == "stale_snapshot") return null
        throw error
    }
    val entries = store.readEntries(device, snapshot.sessionId, snapshot.entries.map { it.entryId })
    return entries.takeIf { owns() }
}
