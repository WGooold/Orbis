package com.orbising.orbis

/** One drawer's current catalog, independent of transport counters and other paired computers. */
internal class DrawerCatalogCache(private val titles: SessionTitleCache = SessionTitleCache()) {
    private var source: RemoteState? = null
    private var language: AppLanguage? = null
    private var tree: List<CachedHostGroup> = emptyList()
    private var rows: List<CachedSessionRow> = emptyList()

    fun resolve(state: RemoteState?, language: AppLanguage): List<CachedHostGroup> {
        val previous = source
        // Keep these dependencies in sync with cachedHistoryTree, sessionHost and title/ledger resolution.
        // Reference checks avoid walking long transcripts merely to test whether the cache is valid.
        if (this.language == language && (previous === state ||
                previous != null && state != null &&
                previous.hostId == state.hostId && previous.hostName == state.hostName &&
                previous.sessions === state.sessions && previous.runtimes === state.runtimes &&
                previous.sessionGraphs === state.sessionGraphs &&
                previous.conversations === state.conversations && previous.ledger === state.ledger)) {
            // Keep the latest snapshot rather than retaining an old, unrelated UI state.
            source = state
            return tree
        }
        if (previous?.hostId != state?.hostId) titles.clear()
        titles.retain(state)
        val host = state?.sessionHost(language)
        val nextRows = state?.let { current ->
            cachedHistoryRows(current, host) { id, runtime -> titles.resolve(current, id, runtime, language) }
        }.orEmpty()
        // Incoming status, assistant text and unrelated ledger operations can change source
        // references without changing a single drawer row. Preserve the grouped tree in that case.
        if (host == null) tree = emptyList()
        else if (this.language != language || previous?.hostId != state.hostId ||
            previous?.hostName != state.hostName || tree.firstOrNull()?.hostname != host.name || nextRows != rows) {
            tree = groupCachedHistoryRows(host.hostId, host.name, nextRows)
        }
        rows = nextRows
        source = state
        this.language = language
        return tree
    }
}
