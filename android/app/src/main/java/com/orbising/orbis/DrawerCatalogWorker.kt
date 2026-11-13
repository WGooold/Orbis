package com.orbising.orbis

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.referentialEqualityPolicy
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

internal data class DrawerCatalogFilter(
    val agentKey: String,
    val archived: Boolean,
    val requestedProvider: String,
    val currentProvider: String?,
    val hostProvider: String?,
    val query: String,
)

/** Equality is deliberately constant-time on the UI thread, even with long loaded transcripts. */
internal class DrawerCatalogRequest(val state: RemoteState?, val language: AppLanguage, val filter: DrawerCatalogFilter,
                                    val prepared: List<CachedHostGroup>? = null) {
    fun sameView(other: DrawerCatalogRequest): Boolean =
        state?.hostId == other.state?.hostId && language == other.language && filter == other.filter

    override fun equals(other: Any?): Boolean = other is DrawerCatalogRequest && sameView(other) && prepared === other.prepared &&
        state?.hostName == other.state?.hostName && state?.sessions === other.state?.sessions &&
        state?.runtimes === other.state?.runtimes && state?.sessionGraphs === other.state?.sessionGraphs &&
        state?.catalogQuery === other.state?.catalogQuery &&
        state?.conversations === other.state?.conversations && state?.ledger === other.state?.ledger

    override fun hashCode(): Int = listOf(state?.hostId, state?.hostName, language, filter).hashCode()
}

/** Published results retain identity, never an old full conversation/graph snapshot. */
internal data class DrawerCatalogIdentity(val hostId: String?, val language: AppLanguage, val filter: DrawerCatalogFilter) {
    fun matches(request: DrawerCatalogRequest): Boolean =
        hostId == request.state?.hostId && language == request.language && filter == request.filter
}

internal data class DrawerHostSection(val hostId: String, val hostName: String, val directories: List<CachedDirectoryGroup>)

internal class DrawerCatalogContent(val sections: List<DrawerHostSection>) {
    val directoryCount = sections.sumOf { it.directories.size }
    val sessions = sections.flatMap { it.directories }.flatMap { it.sessions }
    val ids = sessions.mapTo(HashSet()) { it.sessionId }
}

internal class DrawerCatalogProjection(
    val identity: DrawerCatalogIdentity,
    val options: List<CodexProviderOption>,
    val providerKey: String,
    val content: DrawerCatalogContent,
)

/** A single collector owns the cache; no worker ever reads or mutates Compose state. */
internal class DrawerCatalogWorker(
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val cache: DrawerCatalogCache = DrawerCatalogCache(),
) {
    private var previousTree: List<CachedHostGroup>? = null
    private var previous: DrawerCatalogProjection? = null
    private var previousQuery: CatalogQueryResult? = null

    suspend fun resolve(request: DrawerCatalogRequest): DrawerCatalogProjection = withContext(dispatcher) {
        val tree = request.prepared ?: cache.resolve(request.state, request.language)
        val old = previous
        if (tree === previousTree && old?.identity?.matches(request) == true && previousQuery === request.state?.catalogQuery) return@withContext old
        val filter = request.filter
        val agent = drawerAgentFilter(filter.agentKey)
        val facets = request.state?.catalogQuery?.takeIf { it.query.agentKind == agent.key }
        val options = codexProviderOptions(tree, filter.currentProvider, agent.key, request.language,
            facets?.providers.orEmpty(), facets?.unknownProvider == true)
        val provider = filter.requestedProvider.takeIf { key -> options.any { it.key == key } } ?: CURRENT_CODEX_PROVIDER
        val sections = tree.mapNotNull { host ->
            val directories = host.directories.mapNotNull { directory ->
                val matchesPath = filter.query.isEmpty() || directory.cwd.contains(filter.query, ignoreCase = true)
                val sessions = directory.sessions.filter { row ->
                    agent.matches(row) && row.isArchived == filter.archived &&
                        (!agent.hasProviderFilter || host.hostId != request.state?.hostId ||
                            matchesCodexProvider(row, provider, filter.hostProvider)) &&
                        (matchesPath || row.title.contains(filter.query, ignoreCase = true))
                }
                sessions.takeIf { it.isNotEmpty() }?.let { directory.copy(sessions = it) }
            }
            directories.takeIf { it.isNotEmpty() }?.let { DrawerHostSection(host.hostId, host.hostname, it) }
        }
        val content = if (old != null && old.content.sections == sections) old.content else DrawerCatalogContent(sections)
        DrawerCatalogProjection(DrawerCatalogIdentity(request.state?.hostId, request.language, filter), options, provider, content)
            .also { previousTree = tree; previous = it; previousQuery = request.state?.catalogQuery }
    }
}

// Conflate pending snapshots, not business events. Serial processing avoids cancellation starvation
// during continuous streaming; a switch of Host/filter is checked again before UI publication.
internal fun Flow<DrawerCatalogRequest>.projectDrawerCatalog(worker: DrawerCatalogWorker): Flow<DrawerCatalogProjection> =
    conflate().map { worker.resolve(it) }

@Composable
internal fun rememberDrawerCatalog(request: DrawerCatalogRequest): DrawerCatalogProjection? {
    val current by rememberUpdatedState(request)
    val worker = remember { DrawerCatalogWorker() }
    var result by remember { mutableStateOf<DrawerCatalogProjection?>(null, referentialEqualityPolicy()) }
    LaunchedEffect(worker) {
        snapshotFlow { current }.projectDrawerCatalog(worker).collect { next ->
            if (next.identity.matches(current)) result = next
        }
    }
    return result?.takeIf { it.identity.matches(request) }
}

private class DrawerViewport(var content: DrawerCatalogContent)

@Composable
internal fun rememberDrawerViewport(content: DrawerCatalogContent, list: LazyListState, identity: Any?): DrawerCatalogContent {
    val shown = remember(identity) { DrawerViewport(content) }
    if (!list.isScrollInProgress) shown.content = content
    return shown.content
}
