package com.orbising.orbis

/** One client lifecycle, independent of a worker, wire attempt or display spinner. */
enum class SessionReadPhase {
    QUEUED, LOCAL, REMOTE, WAITING, SUCCEEDED, END_REACHED, FAILED, CANCELLED, SUPERSEDED;
    val active: Boolean get() = this in setOf(QUEUED, LOCAL, REMOTE, WAITING)
}

enum class SessionReadKind { FIRST_PAGE, SOURCE, HISTORY, CATCHUP }

data class SessionReadOperation(
    val operationId: String,
    val historyKey: String,
    val deviceId: String?,
    val hostId: String?,
    val sessionId: String,
    val leafId: String?,
    val beforeEntryId: String?,
    val branchGeneration: Int,
    val cacheEpoch: String?,
    val phase: SessionReadPhase = SessionReadPhase.LOCAL,
    val commandId: String? = null,
    val error: String? = null,
    val kind: SessionReadKind = SessionReadKind.HISTORY,
    val demandGeneration: Long = 0,
    val startedAt: Long = System.currentTimeMillis(),
)

data class SessionReadAcceptance(val operationId: String? = null, val merged: Boolean = false, val rejection: String? = null)
internal data class SessionReadStart(val state: RemoteState, val acceptance: SessionReadAcceptance)

// The history entry point remains a narrow interface over the same operation owner.
typealias HistoryReadPhase = SessionReadPhase
typealias HistoryReadOperation = SessionReadOperation
typealias HistoryReadAcceptance = SessionReadAcceptance

internal fun RemoteState.latestSessionRead(key: String, kind: SessionReadKind): SessionReadOperation? =
    sessionReads.values.lastOrNull { it.historyKey == key && it.kind == kind }
internal fun RemoteState.latestHistoryRead(key: String): SessionReadOperation? = latestSessionRead(key, SessionReadKind.HISTORY)
internal fun RemoteState.historyReadForWindow(key: String): SessionReadOperation? = latestHistoryRead(key)?.takeIf(::readOwnerValid)
internal fun RemoteState.sessionReadForWindow(key: String, kind: SessionReadKind): SessionReadOperation? =
    latestSessionRead(key, kind)?.takeIf(::readOwnerValid)

private fun RemoteState.readOwnerValid(operation: SessionReadOperation): Boolean {
    if (deviceId != operation.deviceId || hostId != operation.hostId ||
        (sessionBranchGenerations[operation.historyKey] ?: 0) != operation.branchGeneration) return false
    if ((operation.kind in setOf(SessionReadKind.HISTORY, SessionReadKind.CATCHUP) ||
            operation.kind == SessionReadKind.FIRST_PAGE && operation.cacheEpoch != null) &&
        sessionGraphs[operation.sessionId]?.cacheEpoch != operation.cacheEpoch) return false
    if (operation.historyKey == "offline:${operation.sessionId}") return selectedOfflineSessionId == operation.sessionId
    val source = conversations[operation.historyKey]
    if (operation.kind == SessionReadKind.HISTORY && source?.sourceReady == true && source.sourceEpoch != null &&
        source.sourceEpoch != operation.cacheEpoch) return false
    return runtimes[operation.historyKey]?.sessionId == operation.sessionId &&
        (operation.kind in setOf(SessionReadKind.CATCHUP, SessionReadKind.SOURCE) || selectedRuntimeId == operation.historyKey)
}

internal fun RemoteState.ownsHistoryRead(operationId: String): Boolean = sessionReads[operationId]?.let {
    it.phase.active && readOwnerValid(it)
} == true

private fun RemoteState.registerRead(operation: SessionReadOperation): RemoteState {
    val retained = sessionReads.values.filter { !it.phase.active }.takeLast(63).map { it.operationId }.toSet()
    return copy(sessionReads = sessionReads.filterValues { it.phase.active || it.operationId in retained } +
        (operation.operationId to operation)).projectHistoryReads()
}

internal fun RemoteState.beginSessionRead(
    key: String,
    kind: SessionReadKind,
    operationId: String,
    targetLeafId: String? = runtimes[key]?.sessionLeafId,
    demandGeneration: Long = sessionSyncDemandGenerations[key] ?: 0L,
): SessionReadStart {
    val current = reconcileHistoryReads()
    current.latestSessionRead(key, kind)?.takeIf { it.phase.active }?.let {
        // A newer live tail must not replace an in-progress fixed catch-up goal.
        return SessionReadStart(current, SessionReadAcceptance(it.operationId, merged = true))
    }
    val sessionId = current.runtimes[key]?.sessionId ?: key.removePrefix("offline:").takeIf { key.startsWith("offline:") }
        ?: return SessionReadStart(current, SessionReadAcceptance(rejection = "没有可读取的会话"))
    val operation = SessionReadOperation(operationId, key, current.deviceId, current.hostId, sessionId, targetLeafId,
        null, current.sessionBranchGenerations[key] ?: 0, current.sessionGraphs[sessionId]?.cacheEpoch,
        phase = if (kind == SessionReadKind.FIRST_PAGE) SessionReadPhase.LOCAL else SessionReadPhase.QUEUED,
        kind = kind, demandGeneration = demandGeneration)
    if (!current.readOwnerValid(operation)) return SessionReadStart(current, SessionReadAcceptance(rejection = "读取归属已失效"))
    return SessionReadStart(current.registerRead(operation), SessionReadAcceptance(operationId))
}

internal fun RemoteState.beginHistoryRead(key: String, operationId: String): SessionReadStart {
    var current = reconcileHistoryReads()
    current.latestHistoryRead(key)?.takeIf { it.phase.active }?.let {
        return SessionReadStart(current, SessionReadAcceptance(it.operationId, merged = true))
    }
    val retired = current.sessionSyncCommands.filterValues {
        it.runtimeId == key && it.range == "history" && it.exhaustedAt != null
    }.keys
    if (retired.isNotEmpty()) current = current.copy(sessionSyncCommands = current.sessionSyncCommands - retired,
        pendingCommands = current.pendingCommands - retired)
    fun rejected(reason: String) = SessionReadStart(current, SessionReadAcceptance(rejection = reason))
    val sessionId = current.runtimes[key]?.sessionId ?: key.removePrefix("offline:").takeIf { key.startsWith("offline:") }
        ?: return rejected("没有可读取的会话")
    val history = current.sessionHistory[key] ?: return rejected("历史首屏尚未就绪")
    if (history.sessionId != sessionId) return rejected("会话已经改变")
    if (!history.hasOlder || history.oldestEntryId == null) return rejected("没有更早的历史")
    if (current.sessionSyncCommands.values.any { it.runtimeId == key && it.range == "history" }) return rejected("历史页仍在等待响应")
    val operation = SessionReadOperation(operationId, key, current.deviceId, current.hostId, sessionId,
        history.leafId, history.oldestEntryId, current.sessionBranchGenerations[key] ?: 0,
        current.sessionGraphs[sessionId]?.cacheEpoch)
    if (!current.readOwnerValid(operation)) return rejected("该历史窗口已关闭")
    return SessionReadStart(current.registerRead(operation).copy(
        sessionRangeFailures = current.sessionRangeFailures - sessionRangeFailureKey(key, "history")), SessionReadAcceptance(operationId))
}

internal fun RemoteState.finishHistoryRead(operationId: String, phase: SessionReadPhase, error: String? = null): RemoteState {
    require(!phase.active)
    val operation = sessionReads[operationId]?.takeIf { it.phase.active } ?: return this
    return copy(sessionReads = sessionReads + (operationId to operation.copy(phase = phase, error = error))).projectHistoryReads()
}

internal fun RemoteState.bindHistoryRead(operationId: String, commandId: String): RemoteState {
    val operation = sessionReads[operationId]?.takeIf { it.phase.active } ?: return this
    if (!ownsHistoryRead(operationId) || commandId !in sessionSyncCommands) return this
    return copy(sessionReads = sessionReads + (operationId to operation.copy(
        phase = SessionReadPhase.REMOTE, commandId = commandId))).projectHistoryReads()
}

internal fun RemoteState.waitForSessionRead(operationId: String): RemoteState {
    val operation = sessionReads[operationId]?.takeIf { it.phase.active } ?: return this
    return copy(sessionReads = sessionReads + (operationId to operation.copy(phase = SessionReadPhase.WAITING, commandId = null)))
}

/** Missing rows are cache gaps, unlike canonical ancestors excluded by the declared display window. */
internal fun SessionGraph.hasDisplayFor(entry: SessionGraphEntry, windowStart: String? = displayWindowStart): Boolean =
    entry.entryId in display || windowStart != null && entry.entryId != windowStart && isDescendant(windowStart, entry.entryId)

private fun RemoteState.reconcileHistoryDisplayCoverage(previous: RemoteState?): RemoteState {
    var histories = sessionHistory
    for ((key, history) in sessionHistory) {
        val graph = sessionGraphs[history.sessionId] ?: continue
        if (previous != null && history === previous.sessionHistory[key] && graph === previous.sessionGraphs[history.sessionId]) continue
        val path = buildSessionPath(graph.entries, history.leafId)
        val boundary = path.indexOfFirst { it.entryId == history.oldestEntryId }
        // Older temporary pages can be outside the bounded graph; absence cannot revoke them.
        if (boundary < 0) continue
        // A compacted history can have thousands of intentionally hidden ancestors. Walking
        // the window's parent chain once per entry made every selection update quadratic.
        val excludedAncestors by lazy {
            buildSessionPath(graph.entries, graph.displayWindowStart).asSequence()
                .map(SessionGraphEntry::entryId).filter { it != graph.displayWindowStart }.toHashSet()
        }
        val gap = path.indexOfLast { it.entryId !in graph.display && it.entryId !in excludedAncestors }
        val restart = path.getOrNull(gap + 1)?.takeIf { gap >= boundary } ?: continue
        histories = histories + (key to history.copy(oldestEntryId = restart.entryId, hasOlder = true))
    }
    return if (histories == sessionHistory) this else copy(sessionHistory = histories)
}

/** All phases are changed here; IO and reducers report facts, never write a phase or spinner. */
internal fun RemoteState.reconcileHistoryReads(previous: RemoteState? = null): RemoteState {
    var next = reconcileHistoryDisplayCoverage(previous)
    for (operation in sessionReads.values.filter { it.phase.active }) {
        if (!next.readOwnerValid(operation)) {
            next = next.finishHistoryRead(operation.operationId, SessionReadPhase.SUPERSEDED)
            continue
        }
        if (next.connection == RelayConnection.RECONNECTING && operation.kind in setOf(SessionReadKind.SOURCE, SessionReadKind.CATCHUP) &&
            operation.phase in setOf(SessionReadPhase.QUEUED, SessionReadPhase.WAITING)) {
            next = next.finishHistoryRead(operation.operationId, SessionReadPhase.CANCELLED)
            continue
        }
        if (operation.phase != SessionReadPhase.REMOTE || operation.commandId in next.sessionSyncCommands) continue
        next = when (operation.kind) {
            SessionReadKind.HISTORY -> next.finishHistoryRead(operation.operationId, SessionReadPhase.CANCELLED)
            SessionReadKind.CATCHUP, SessionReadKind.SOURCE -> if (next.connection == RelayConnection.RECONNECTING)
                next.finishHistoryRead(operation.operationId, SessionReadPhase.CANCELLED)
                else next.waitForSessionRead(operation.operationId)
            SessionReadKind.FIRST_PAGE -> next.finishHistoryRead(operation.operationId, SessionReadPhase.CANCELLED)
        }
    }
    return next.projectHistoryReads()
}

private fun RemoteState.projectHistoryReads(): RemoteState {
    var histories = sessionHistory
    for (key in sessionReads.values.filter { it.kind == SessionReadKind.HISTORY }.map { it.historyKey }.distinct()) {
        val operation = latestHistoryRead(key) ?: continue
        val history = histories[key]
        if (!readOwnerValid(operation)) {
            if (history?.sessionId == operation.sessionId && history.loading) histories = histories +
                (key to history.copy(loading = false, requestId = null))
            continue
        }
        val owned = history?.takeIf { it.sessionId == operation.sessionId }
            ?: SessionHistoryState(operation.sessionId, operation.leafId, operation.beforeEntryId, true)
        val projected = owned.copy(loading = operation.phase.active,
            requestId = operation.commandId.takeIf { operation.phase == SessionReadPhase.REMOTE })
        if (projected != history) histories = histories + (key to projected)
    }
    return if (histories == sessionHistory) this else copy(sessionHistory = histories)
}

internal fun RemoteState.cancelHistoryReads(exceptKey: String? = null): RemoteState =
    sessionReads.values.filter { it.phase.active && it.historyKey != exceptKey && it.kind != SessionReadKind.CATCHUP }
        .fold(this) { state, operation -> state.finishHistoryRead(operation.operationId, SessionReadPhase.CANCELLED) }

internal fun RemoteState.applyLocalHistoryRead(operationId: String, page: SessionGraphRange,
    cacheEpoch: String? = sessionReads[operationId]?.cacheEpoch): RemoteState {
    if (!ownsHistoryRead(operationId)) return reconcileHistoryReads()
    val operation = sessionReads.getValue(operationId)
    if (cacheEpoch != operation.cacheEpoch) return finishHistoryRead(operationId, SessionReadPhase.SUPERSEDED)
    if (operation.kind != SessionReadKind.HISTORY || operation.phase != SessionReadPhase.LOCAL) return this
    if (page.status in setOf(SessionGraphRangeStatus.LEAF_NOT_FOUND, SessionGraphRangeStatus.RANGE_START_NOT_FOUND) &&
        page.entries.isEmpty()) return this
    if (page.status !in setOf(SessionGraphRangeStatus.COMPLETE, SessionGraphRangeStatus.OLDER_AVAILABLE, SessionGraphRangeStatus.MISSING_PARENT))
        return finishHistoryRead(operationId, SessionReadPhase.FAILED, "本地历史范围无效：${page.status}")
    if (page.entries.isEmpty()) {
        if (page.status != SessionGraphRangeStatus.COMPLETE || !page.complete || page.hasOlder) return this
        val history = sessionHistory[operation.historyKey] ?: return this
        return copy(sessionHistory = sessionHistory + (operation.historyKey to history.copy(hasOlder = false)))
            .finishHistoryRead(operationId, SessionReadPhase.END_REACHED)
    }
    val graph = sessionGraphs[operation.sessionId] ?: SessionGraph(operation.sessionId)
    // 本地页自带显示结果：条目与解释同源，页面读进来就能渲染。
    val merged = graph.copy(
        entries = LinkedHashMap(graph.entries).apply { page.entries.forEach { putIfAbsent(it.entryId, it) } },
        display = graph.display + page.display,
        displayWindowStart = if (page.displayVersion == null) graph.displayWindowStart else page.displayWindowStart,
        displayVersion = page.displayVersion ?: graph.displayVersion,
    )
    // Canonical coverage does not prove that the producer's display rows are cached. Keep the
    // same operation active so its worker can fetch this fixed range from the source.
    if (page.entries.any { !merged.hasDisplayFor(it) }) return this
    val history = sessionHistory[operation.historyKey] ?: return this
    val first = page.entries.first()
    val keepBoundary = history.oldestEntryId != operation.beforeEntryId && merged.isDescendant(first.entryId, history.oldestEntryId)
    val nextHistory = history.copy(oldestEntryId = if (keepBoundary) history.oldestEntryId else first.entryId,
        hasOlder = if (keepBoundary) history.hasOlder else page.hasOlder)
    val conversation = conversations[operation.historyKey]
    val viewLeaf = runtimeSessionViews[operation.historyKey]?.leafId ?: history.leafId
    val projection = if (merged.hasCompleteEntryChain(viewLeaf)) projectSessionGraph(merged.copy(cursor = SessionBranchCursor(viewLeaf)))
        else SessionProjectionResult(projectSessionEntries(page.entries, merged.display, merged.displayWindowStart))
    val ids = projection.messages.map(ChatMessage::messageId).toSet()
    val nextConversations = if (conversation == null) conversations else conversations + (operation.historyKey to
        conversation.copy(messages = projection.messages + conversation.messages.filterNot { it.messageId in ids },
            turnTimings = projection.turnTimings.associateBy(TurnTiming::turnId) + conversation.turnTimings,
            revision = conversation.revision + 1))
    return copy(sessionGraphs = sessionGraphs + (operation.sessionId to merged), conversations = nextConversations,
        sessionHistory = sessionHistory + (operation.historyKey to nextHistory)).finishHistoryRead(operationId, SessionReadPhase.SUCCEEDED)
}

internal fun RemoteState.applyFirstSessionPage(operationId: String, loaded: SessionGraph): RemoteState {
    if (!ownsHistoryRead(operationId)) return reconcileHistoryReads()
    val operation = sessionReads.getValue(operationId)
    if (operation.kind != SessionReadKind.FIRST_PAGE || loaded.sessionId != operation.sessionId) return this
    val existing = sessionGraphs[operation.sessionId]
    val source = conversations[operation.historyKey]
    if (source?.sourceReady == true && source.sourceEpoch != null && source.sourceEpoch != loaded.cacheEpoch)
        return finishHistoryRead(operationId, SessionReadPhase.SUPERSEDED)
    if (existing?.cacheEpoch != null && existing.cacheEpoch != loaded.cacheEpoch ||
        operation.cacheEpoch != null && operation.cacheEpoch != loaded.cacheEpoch)
        return finishHistoryRead(operationId, SessionReadPhase.SUPERSEDED)
    val compatible = existing?.takeIf { it.cacheEpoch == loaded.cacheEpoch }
    val graph = loaded.copy(cursor = compatible?.cursor?.takeIf {
            appliedSessionState(operation.historyKey) != null || compatible.isDescendant(it.leafId, loaded.cursor.leafId) ||
                (compatible.entryVersions[it.leafId] ?: -1) > (loaded.entryVersions[loaded.cursor.leafId] ?: -1)
        } ?: loaded.cursor,
        entries = LinkedHashMap(loaded.entries).apply { compatible?.entries?.forEach { (id, entry) ->
            if (id !in this || (compatible.entryVersions[id] ?: Long.MAX_VALUE) >= (loaded.entryVersions[id] ?: -1)) put(id, entry)
        } },
        turnTimings = LinkedHashMap(loaded.turnTimings).apply { compatible?.turnTimings?.forEach { (id, timing) ->
            if (id !in this || (compatible.timingVersions[id] ?: Long.MAX_VALUE) >= (loaded.timingVersions[id] ?: -1)) put(id, timing)
        } },
        entryVersions = (loaded.entryVersions.keys + compatible?.entryVersions.orEmpty().keys).associateWith {
            maxOf(loaded.entryVersions[it] ?: -1, compatible?.entryVersions?.get(it) ?: -1)
        },
        timingVersions = (loaded.timingVersions.keys + compatible?.timingVersions.orEmpty().keys).associateWith {
            maxOf(loaded.timingVersions[it] ?: -1, compatible?.timingVersions?.get(it) ?: -1)
        })
    var next = finishHistoryRead(operationId, SessionReadPhase.SUCCEEDED).copy(sessionGraphs = sessionGraphs + (operation.sessionId to graph),
        sessions = sessions + (operation.sessionId to (sessions[operation.sessionId] ?: SessionCatalogEntry(operation.sessionId))
            .withHistoryCache(runtimes[operation.historyKey]?.hostname)))
    next = if (operation.historyKey.startsWith("offline:")) {
        val branch = buildSessionPath(graph.entries, graph.cursor.leafId)
        next.copy(sessionHistory = next.sessionHistory + (operation.historyKey to SessionHistoryState(operation.sessionId,
            graph.cursor.leafId, branch.firstOrNull()?.entryId, branch.firstOrNull()?.parentId != null)))
    } else next.seedCachedSessionView(operation.historyKey, graph, cachedFirstPage = true)
    return next
}

internal fun RemoteState.observeCatchupCoverage(operationId: String, completedRange: PendingSessionSync?, gap: SessionSyncGap?,
    cacheEpoch: String? = sessionReads[operationId]?.cacheEpoch): RemoteState {
    if (!ownsHistoryRead(operationId)) return reconcileHistoryReads()
    if (sessionReads[operationId]?.kind != SessionReadKind.CATCHUP) return this
    if (cacheEpoch != sessionReads[operationId]?.cacheEpoch) return finishHistoryRead(operationId, SessionReadPhase.SUPERSEDED)
    if (gap == null) return finishHistoryRead(operationId, SessionReadPhase.SUCCEEDED)
    if (completedRange?.historyOperationId == operationId && gap.targetLeafId == completedRange.requestTargetLeafId &&
        gap.knownLeafId == completedRange.knownLeafId) return failLocalSessionRead(operationId, "补齐范围未推进，请重试")
    return this
}

internal fun RemoteState.failLocalSessionRead(operationId: String, message: String): RemoteState {
    val operation = sessionReads[operationId]?.takeIf { it.phase.active } ?: return this
    val next = finishHistoryRead(operationId, SessionReadPhase.FAILED, message)
    return if (operation.kind == SessionReadKind.CATCHUP) next.copy(sessionRangeFailures =
        next.sessionRangeFailures + (sessionRangeFailureKey(operation.historyKey, "catchup") to message)) else next
}

/** Confirmation is a committed data fact, never merely disappearance of a task. */
internal fun RemoteState.confirmSourceRead(previous: RemoteState, commandId: String?, response: SessionGraphSnapshot? = null): RemoteState {
    var next = this
    val completedId = commandId?.takeIf { id ->
        val task = previous.sessionSyncCommands[id]
        task != null && id !in sessionSyncCommands && response != null && previous.ownsSessionSnapshot(id,
            task.runtimeId, response.sessionId, response.syncId, response.targetLeafId ?: response.cursor.leafId,
            response.range, response.beforeEntryId)
    }?.let { previous.sessionSyncCommands[it]?.historyOperationId }
    for (operation in sessionReads.values.filter { it.kind == SessionReadKind.SOURCE && it.phase.active &&
        (it.operationId == completedId || it.phase == SessionReadPhase.WAITING) }) {
        val conversation = next.conversations[operation.historyKey]
        if (next.ownsHistoryRead(operation.operationId) && (next.appliedSessionState(operation.historyKey) != null ||
                conversation?.sourceEpoch == null && conversation?.hasLiveSnapshot == true &&
                !conversation.isChatSyncing && conversation.chatSyncError == null))
            next = next.finishHistoryRead(operation.operationId, SessionReadPhase.SUCCEEDED)
    }
    return next
}

internal fun RemoteState.finishRemoteHistoryRead(commandId: String, phase: SessionReadPhase, error: String? = null): RemoteState =
    sessionSyncCommands[commandId]?.historyOperationId?.let { finishHistoryRead(it, phase, error) } ?: this

internal fun RemoteState.recoverLateHistoryRead(commandId: String): RemoteState {
    val task = sessionSyncCommands[commandId]?.takeIf { it.exhaustedAt != null } ?: return this
    val old = task.historyOperationId?.let(sessionReads::get) ?: return this
    if (old.phase != SessionReadPhase.FAILED || latestSessionRead(old.historyKey, old.kind)?.operationId != old.operationId || !readOwnerValid(old)) return this
    val recoveryId = "${old.operationId}:late"
    return registerRead(old.copy(operationId = recoveryId, phase = SessionReadPhase.REMOTE, error = null,
        startedAt = System.currentTimeMillis())).copy(
        sessionSyncCommands = sessionSyncCommands + (commandId to task.copy(historyOperationId = recoveryId)))
}

/** A response may satisfy only the demand generation its immutable task captured. */
internal fun RemoteState.trackSessionReadDemands(previous: RemoteState, changedTargets: Set<String> = emptySet(),
    consumedCommands: Set<String> = emptySet()): RemoteState {
    var requests = sessionSyncRequests
    val completed = previous.sessionSyncCommands.filterKeys { it in consumedCommands && it !in sessionSyncCommands }.values
    for (task in completed.filter { it.range == "preview" && it.demandGeneration != null }) {
        if (task.runtimeId in previous.sessionSyncRequests && task.runtimeId !in requests &&
            task.demandGeneration != (previous.sessionSyncDemandGenerations[task.runtimeId] ?: 0L)) requests = requests + task.runtimeId
    }
    var generations = sessionSyncDemandGenerations
    for (key in requests) {
        val targetChanged = key in changedTargets || previous.sessionBranchGenerations[key] != sessionBranchGenerations[key]
        if ((key !in previous.sessionSyncRequests || targetChanged) &&
            (generations[key] ?: 0) <= (previous.sessionSyncDemandGenerations[key] ?: 0)) generations = generations +
            (key to ((previous.sessionSyncDemandGenerations[key] ?: 0) + 1))
    }
    return if (requests == sessionSyncRequests && generations == sessionSyncDemandGenerations) this
        else copy(sessionSyncRequests = requests, sessionSyncDemandGenerations = generations)
}

internal fun RemoteState.expireWaitingSessionReads(now: Long): RemoteState {
    var next = this
    for (operation in sessionReads.values.filter { it.kind == SessionReadKind.SOURCE && it.phase.active && now - it.startedAt >= 150_000 }) {
        val task = operation.commandId?.let(next.sessionSyncCommands::get)
        if (task != null) {
            next = next.failSessionSync(operation.commandId!!, SESSION_SYNC_TIMEOUT_MESSAGE)
            if (task.attempts > 0) next = next.copy(sessionSyncCommands = next.sessionSyncCommands +
                (operation.commandId to task.copy(exhaustedAt = now, slow = true)))
        } else next = next.finishHistoryRead(operation.operationId, SessionReadPhase.FAILED, SESSION_SYNC_TIMEOUT_MESSAGE).copy(
            sessionSyncFailures = next.sessionSyncFailures + (operation.historyKey to SESSION_SYNC_TIMEOUT_MESSAGE),
            sessionSyncRequests = if (operation.demandGeneration != (next.sessionSyncDemandGenerations[operation.historyKey] ?: 0L))
                next.sessionSyncRequests else next.sessionSyncRequests - operation.historyKey)
    }
    return next
}
