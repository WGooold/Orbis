package com.orbising.orbis

internal val SESSION_CACHE_UPDATED_NOTICE get() = L10n.tr("聊天记录已更新，正在重新同步")

/** A format migration invalidates one canonical graph, not its independent local interactions. */
internal fun RemoteState.afterSessionCacheRebuild(sessionId: String, storageId: String = sessionId): RemoteState {
    val runtimeIds = runtimes.values.filter { it.sessionId == sessionId || it.directorySessionId == storageId }
        .mapTo(mutableSetOf(), RuntimeSummary::runtimeId)
    runtimeIds += knownRuntimeSessions.filterValues { it == sessionId }.keys
    runtimeIds += runtimeSessionViews.values.filter { it.runtimeId in runtimeIds && it.sessionId == sessionId }.map(RuntimeSessionView::runtimeId)
    val commandIds = sessionSyncCommands.filterValues { it.sessionId == sessionId }.keys
    val offlineKey = "offline:$sessionId"
    val affectedConversations = runtimeIds + offlineKey
    val refreshed = affectedConversations.associateWith { runtimeId ->
        (conversations[runtimeId] ?: RuntimeConversation()).copy(
            messages = emptyList(),
            streamingMessageIds = emptySet(),
            finishedMessageIds = emptySet(),
            streamingSessionId = null,
            hasLiveSnapshot = false,
            sourceReady = false,
            sourceHeadLeafId = null,
            retainedProjectionLeafId = null,
            sourcePatchBuffer = emptyMap(),
            sourceRecoveryRetryAt = 0,
            activeTurnId = null,
            turnTimings = emptyMap(),
            tools = emptyMap(),
            isChatSyncing = runtimeId in runtimes,
            chatSyncError = null,
            systemNotice = if (runtimeId == offlineKey) L10n.tr("聊天记录已更新，请连接后重新同步") else SESSION_CACHE_UPDATED_NOTICE,
            revision = (conversations[runtimeId]?.revision ?: 0) + 1,
        )
    }
    return copy(
        sessionGraphs = sessionGraphs - storageId,
        runtimeSessionViews = runtimeSessionViews.filterValues { it.runtimeId !in runtimeIds },
        sessionHistory = sessionHistory.filterKeys { it !in runtimeIds && it != offlineKey },
        sessionSyncCommands = sessionSyncCommands - commandIds,
        pendingCommands = pendingCommands - commandIds,
        sessionSyncFailures = sessionSyncFailures - runtimeIds,
        sessionRangeFailures = sessionRangeFailures.filterKeys { key -> runtimeIds.none { key.startsWith("$it\u0000") } },
        sessionSyncRequests = (sessionSyncRequests - runtimeIds) + runtimes.values
            .filter { (it.sessionId == sessionId || it.directorySessionId == storageId) && it.sessionGraphSync }.map(RuntimeSummary::runtimeId),
        sessionBranchGenerations = sessionBranchGenerations + (runtimeIds + offlineKey).associateWith {
            (sessionBranchGenerations[it] ?: 0) + 1
        },
        conversations = conversations + refreshed,
        sessions = sessions[storageId]?.let { sessions + (storageId to it.copy(hasHistoryCache = false)) } ?: sessions,
    )
}
