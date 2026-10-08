package dev.pi.remote

internal const val SESSION_CACHE_UPDATED_NOTICE = "聊天记录已更新，正在重新同步"

/** A format migration invalidates one canonical graph, not its independent local interactions. */
internal fun RemoteState.afterSessionCacheRebuild(sessionId: String): RemoteState {
    val runtimeIds = runtimes.values.filter { it.sessionId == sessionId }.mapTo(mutableSetOf(), RuntimeSummary::runtimeId)
    runtimeIds += knownRuntimeSessions.filterValues { it == sessionId }.keys
    runtimeIds += runtimeSessionViews.values.filter { it.sessionId == sessionId }.map(RuntimeSessionView::runtimeId)
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
            sourcePatchBuffer = emptyMap(),
            sourceRecoveryRetryAt = 0,
            activeTurnId = null,
            turnTimings = emptyMap(),
            tools = emptyMap(),
            isChatSyncing = runtimeId in runtimes,
            chatSyncError = null,
            systemNotice = if (runtimeId == offlineKey) "聊天记录已更新，请连接后重新同步" else SESSION_CACHE_UPDATED_NOTICE,
            revision = (conversations[runtimeId]?.revision ?: 0) + 1,
        )
    }
    return copy(
        sessionGraphs = sessionGraphs - sessionId,
        runtimeSessionViews = runtimeSessionViews.filterValues { it.sessionId != sessionId },
        sessionHistory = sessionHistory.filterValues { it.sessionId != sessionId },
        sessionSyncCommands = sessionSyncCommands - commandIds,
        pendingCommands = pendingCommands - commandIds,
        sessionSyncFailures = sessionSyncFailures - runtimeIds,
        sessionSyncRequests = (sessionSyncRequests - runtimeIds) + runtimes.values
            .filter { it.sessionId == sessionId && it.sessionGraphSync }.map(RuntimeSummary::runtimeId),
        sessionBranchGenerations = sessionBranchGenerations + runtimeIds.associateWith {
            (sessionBranchGenerations[it] ?: 0) + 1
        },
        conversations = conversations + refreshed,
        sessions = sessions[sessionId]?.let { sessions + (sessionId to it.copy(hasHistoryCache = false)) } ?: sessions,
    )
}
