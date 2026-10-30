package com.orbising.orbis

/** A complete homepage card; background reads cannot alter any of its visible fields. */
data class HomeRuntimeCard(
    val runtime: RuntimeSummary,
    val title: String,
    val hasPendingInteraction: Boolean,
)

internal val HOME_MODEL_DOMAINS = setOf("identity", "execution", "interactions")

private fun RemoteState.homeRead(runtime: RuntimeSummary) = agentStateReads.entries.firstOrNull {
    it.value.scope == "agent" && it.value.runtimeId == runtime.runtimeId && it.value.sessionId == runtime.sessionId
}

private fun RemoteState.homeModelSnapshot(runtime: RuntimeSummary): AgentStateSnapshotView? {
    val read = homeRead(runtime)
    val canonical = agentStateSnapshots["agent|${runtime.agentKind.orEmpty()}|${runtime.sessionId.orEmpty()}"]
    return canonical?.takeIf { it.requestId == read?.key }
        ?: agentStateSnapshots.values.firstOrNull { it.scope == "agent" && it.requestId == read?.key }
        ?: canonical
}

private fun RemoteState.homeFactsComplete(runtime: RuntimeSummary): Boolean {
    if (runtime.sessionId.isNullOrBlank() || runtime.agentKind.isNullOrBlank() || runtime.cwd.isBlank()) return false
    val read = homeRead(runtime)
    if (read?.value?.pendingDomains?.any { it in HOME_MODEL_DOMAINS } == true) return false
    val snapshot = homeModelSnapshot(runtime) ?: return false
    if (snapshot.error != null || snapshot.modelEpoch != agentModelEpoch) return false
    return HOME_MODEL_DOMAINS.all { name ->
        val domain = snapshot.domains[name]
        runtime.domainAvailability[name] == "ready" && name !in snapshot.missing &&
            domain?.availability == "ready" && (domain.completeness == "complete" || domain.projectionComplete)
    }
}

internal val RemoteState.homeRuntimesLoading: Boolean get() = homeSnapshot == null
internal val RemoteState.homeRuntimesUpdating: Boolean
    get() = !e2eReady || !homeDirectoryReceived || !runtimes.values.all(::homeFactsComplete)
internal val RemoteState.homeCards: List<HomeRuntimeCard>
    get() = homeSnapshot.orEmpty().filter { it.runtime.runtimeId !in closingRuntimes }
internal val RemoteState.homeRuntimes: List<RuntimeSummary> get() = homeCards.map { it.runtime }

internal val RemoteState.homeRuntimesError: String?
    get() {
        if (!homeRuntimesUpdating) return null
        if (connection == RelayConnection.OFFLINE) return "电脑未连接，请重试"
        for (runtime in runtimes.values) {
            if (runtime.sessionId.isNullOrBlank()) return "会话身份尚未就绪，请重新加载"
            val read = homeRead(runtime)
            val snapshot = homeModelSnapshot(runtime)
            if (snapshot?.requestId == read?.key) snapshot?.error?.let { return it }
            if (read?.value?.pendingDomains?.any { it in HOME_MODEL_DOMAINS } == true) continue
            snapshot?.error?.let { return it }
            if (snapshot != null && !homeFactsComplete(runtime)) return "会话信息未能完整读取，请重试"
        }
        return null
    }

/** 首页同步进度。首版快照发布前由列表区域显示，发布后由连接胶囊显示，不再占用单独一行。 */
internal sealed interface HomeSyncStatus {
    data object Idle : HomeSyncStatus
    data object Syncing : HomeSyncStatus
    data class Failed(val message: String) : HomeSyncStatus
}

internal val RemoteState.homeSyncStatus: HomeSyncStatus
    get() = if (!homeRuntimesUpdating) HomeSyncStatus.Idle
        else homeRuntimesError?.let(HomeSyncStatus::Failed) ?: HomeSyncStatus.Syncing

/** Called at publication boundaries, after the whole authenticated event has been reduced. */
internal fun RemoteState.commitHomePresentation(): RemoteState {
    if (homeRuntimesUpdating) return this
    val collator = java.text.Collator.getInstance(java.util.Locale.CHINA)
    val cards = runtimes.values.sortedWith(compareByDescending<RuntimeSummary> { sessions[it.sessionId]?.modifiedAt ?: 0L }
        .thenBy(collator) { runtimeDisplayName(it) }.thenBy { it.runtimeId })
        .map { HomeRuntimeCard(it, runtimeDisplayName(it), hasPendingInteraction(it.runtimeId)) }
    return if (homeSnapshot == cards) this else copy(homeSnapshot = cards)
}

internal fun RemoteState.homeCardIsCurrent(card: HomeRuntimeCard): Boolean =
    e2eReady && homeDirectoryReceived && runtimes[card.runtime.runtimeId]?.sessionId == card.runtime.sessionId

internal fun RemoteState.failHomeRead(requestId: String, message: String): RemoteState {
    val read = agentStateReads[requestId]?.takeIf { it.scope == "agent" } ?: return this
    val previous = agentStateSnapshots[read.key]
    val failed = previous?.copy(requestId = requestId, error = message)
        ?: AgentStateSnapshotView(read.key, "agent", requestId, error = message)
    return copy(agentStateRequests = agentStateRequests - requestId,
        agentStateSnapshots = agentStateSnapshots + (read.key to failed))
}
