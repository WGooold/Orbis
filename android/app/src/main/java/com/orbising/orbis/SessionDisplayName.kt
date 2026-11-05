package com.orbising.orbis

private const val SESSION_FALLBACK_NAME_MAX_LENGTH = 40
private val sessionFallbackWhitespace = Regex("\\s+")

internal fun RemoteState.runtimeDisplayName(runtime: RuntimeSummary): String =
    sessionDisplayName(runtime.sessionId, runtime)

/** Shared by runtime cards, the session drawer, chat headers and offline history. */
internal fun RemoteState.sessionDisplayName(
    sessionId: String?,
    runtime: RuntimeSummary? = runtimes.values.firstOrNull { sessionId != null && it.sessionId == sessionId },
): String = resolveSessionDisplayName(sessionId, runtime, SessionGraph::firstUserMessageTitle, ::firstUserMessageTitle,
    L10n.tr("Session 已离线"))

private fun RemoteState.resolveSessionDisplayName(
    sessionId: String?,
    runtime: RuntimeSummary?,
    graphTitle: (SessionGraph) -> String?,
    liveTitle: (List<ChatMessage>) -> String?,
    unavailable: String,
): String {
    val session = sessions[sessionId]
    if ((runtime?.agentKind ?: session?.agentKind) == "pi") {
        session?.cachedDisplayName?.takeIf(String::isNotBlank)?.let { return it }
    }
    return runtime?.sessionName?.trim()?.takeIf(String::isNotEmpty)
        ?: session?.name?.trim()?.takeIf(String::isNotEmpty)
        ?: sessionGraphs[sessionId]?.let(graphTitle)
        ?: session?.firstMessage?.let(::sessionMessagePreview)
        ?: runtime?.let { liveTitle(conversations[it.runtimeId]?.messages.orEmpty()) }
        ?: sessionId?.trim()?.takeIf(String::isNotEmpty)
        ?: runtime?.runtimeId
        ?: unavailable
}

/** One background drawer worker owns these bounded, content-dependent title results. */
internal class SessionTitleCache(
    private val projectGraph: (SessionGraph) -> String? = SessionGraph::firstUserMessageTitle,
) {
    private class GraphTitle(val graph: SessionGraph, val title: String?)
    private class LiveTitle(val messages: List<ChatMessage>, val title: String?)
    private val graphs = mutableMapOf<String, GraphTitle>()
    private val live = mutableMapOf<String, LiveTitle>()

    fun resolve(state: RemoteState, sessionId: String?, runtime: RuntimeSummary?, language: AppLanguage = AppLocalization.language): String {
        var usedGraph = false
        var usedLive = false
        val result = state.resolveSessionDisplayName(sessionId, runtime, { graph ->
            usedGraph = true
            val old = graphs[graph.sessionId]
            if (old != null && old.graph.entries === graph.entries && old.graph.display === graph.display &&
                old.graph.cursor.leafId == graph.cursor.leafId && old.graph.displayWindowStart == graph.displayWindowStart) {
                old.title.also { graphs[graph.sessionId] = GraphTitle(graph, it) }
            } else {
                projectGraph(graph).also { graphs[graph.sessionId] = GraphTitle(graph, it) }
            }
        }, { messages ->
            usedLive = true
            val key = requireNotNull(runtime).runtimeId
            val old = live[key]
            if (old != null && old.messages === messages) old.title
            else firstUserMessageTitle(messages).also { live[key] = LiveTitle(messages, it) }
        }, L10n.format("Session 已离线", language = language))
        if (!usedGraph) sessionId?.let(graphs::remove)
        if (!usedLive) runtime?.runtimeId?.let(live::remove)
        return result
    }

    fun retain(state: RemoteState?) {
        graphs.keys.retainAll(state?.sessionGraphs?.keys.orEmpty())
        live.keys.retainAll(state?.runtimes?.keys.orEmpty())
    }

    fun clear() { graphs.clear(); live.clear() }
}

/** Capture only newly available Pi names. Existing labels never follow later history or renames. */
internal fun RemoteState.cachePiSessionNames(previous: RemoteState? = null): RemoteState {
    val candidates = mutableSetOf<String>()
    if (sessions !== previous?.sessions) {
        sessions.forEach { (id, entry) -> if (entry !== previous?.sessions?.get(id)) candidates += id }
    }
    if (runtimes !== previous?.runtimes || conversations !== previous?.conversations) {
        runtimes.values.forEach { runtime ->
            if (runtime !== previous?.runtimes?.get(runtime.runtimeId) ||
                conversations[runtime.runtimeId] !== previous?.conversations?.get(runtime.runtimeId)) {
                runtime.sessionId?.let(candidates::add)
            }
        }
    }
    if (sessionGraphs !== previous?.sessionGraphs) {
        sessionGraphs.forEach { (id, graph) -> if (graph !== previous?.sessionGraphs?.get(id)) candidates += id }
    }
    if (candidates.isEmpty()) return this
    val runtimeBySession = runtimes.values.groupBy(RuntimeSummary::sessionId)
    var updated: MutableMap<String, SessionCatalogEntry>? = null
    for (id in candidates) {
        if (id.isBlank()) continue
        val windows = runtimeBySession[id].orEmpty()
        val entry = sessions[id] ?: windows.firstOrNull()?.catalogEntry() ?: continue
        if ((windows.firstNotNullOfOrNull(RuntimeSummary::agentKind) ?: entry.agentKind) != "pi" ||
            !entry.cachedDisplayName.isNullOrBlank()) continue
        // Catalog metadata is enough on launch. Only inspect already loaded messages when
        // unnamed; neither the Session ID nor the generic runtime name is a cacheable title.
        val name = windows.firstNotNullOfOrNull { it.sessionName?.trim()?.takeIf { name -> name.isNotEmpty() && name != id } }
            ?: entry.name?.trim()?.takeIf { it.isNotEmpty() && it != id }
            ?: entry.firstMessage?.let(::sessionMessagePreview)
            ?: sessionGraphs[id]?.firstUserMessageTitle()
            ?: windows.firstNotNullOfOrNull { runtime ->
                conversations[runtime.runtimeId]?.takeIf { it.streamingSessionId == null || it.streamingSessionId == id }
                    ?.let { firstUserMessageTitle(it.messages) }
            }
            ?: continue
        if (updated == null) updated = sessions.toMutableMap()
        updated[id] = entry.copy(cachedDisplayName = name, agentKind = "pi")
    }
    return updated?.let { copy(sessions = it) } ?: this
}

internal fun RuntimeSummary.runtimeDisplayPath(): String {
    // Older Relay versions strip the hostname field, in which case only the directory is known.
    val host = hostname?.trim()?.takeIf(String::isNotEmpty) ?: return cwd
    return "$host-$cwd"
}

internal fun firstUserMessageTitle(messages: List<ChatMessage>): String? =
    messages.asSequence()
        .filter { it.role == "user" }
        .flatMap { message -> message.content.asSequence() }
        .filter { content -> content.type == "text" }
        .mapNotNull(RemoteContent::text)
        .mapNotNull(::sessionMessagePreview)
        .firstOrNull()

private fun sessionMessagePreview(value: String): String? {
    val text = value.trim().takeIf(String::isNotEmpty) ?: return null
    val firstSentence = text.split(Regex("(?<=[。！？.!?])|\\r?\\n"), limit = 2)
        .first()
        .replace(sessionFallbackWhitespace, " ")
        .trim()
    if (firstSentence.length <= SESSION_FALLBACK_NAME_MAX_LENGTH) return firstSentence
    return firstSentence.take(SESSION_FALLBACK_NAME_MAX_LENGTH - 1).trimEnd() + "…"
}
