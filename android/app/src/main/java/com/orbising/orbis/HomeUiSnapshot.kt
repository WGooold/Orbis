package com.orbising.orbis

/** A UI publication deliberately contains no transcript, graph or download payload. */
internal class HomeUiSnapshot(
    val state: RemoteState = RemoteState(),
    val hosts: List<HostSnapshot> = emptyList(),
    val catalog: List<CachedHostGroup> = emptyList(),
    val sync: HomeSyncStatus = HomeSyncStatus.Idle,
    val activeDownloads: Int = 0,
)

/** Owned by one Default collector. Equality/traversal here never runs in composition. */
internal class HomeUiWorker {
    private val catalog = DrawerCatalogCache()
    private var previous: HomeUiSnapshot? = null
    private var syncInput: HomePresentationRequest? = null
    private var sync: HomeSyncStatus = HomeSyncStatus.Idle
    private var downloadInput: Map<String, ArtifactDownload>? = null
    private var active = 0

    fun resolve(source: RemoteState, hosts: List<HostSnapshot>, language: AppLanguage): HomeUiSnapshot {
        val old = syncInput
        if (old == null || old.language != language || old.state.hostId != source.hostId ||
            old.state.connection != source.connection || old.state.e2eReady != source.e2eReady ||
            old.state.homeDirectoryReceived != source.homeDirectoryReceived || old.state.agentModelEpoch != source.agentModelEpoch ||
            old.state.runtimes !== source.runtimes || old.state.agentStateReads !== source.agentStateReads ||
            old.state.agentStateSnapshots !== source.agentStateSnapshots) sync = source.homeSyncStatus
        syncInput = HomePresentationRequest(source, language)
        val state = RemoteState(hostId = source.hostId, hostName = source.hostName,
            connection = source.connection, e2eReady = source.e2eReady, path = source.path,
            runtimes = source.runtimes, sessions = source.sessions, homeSnapshot = source.homeSnapshot,
            catalogQuery = source.catalogQuery,
            capabilities = source.capabilities, currentProviders = source.currentProviders,
            sessionActivateRequests = source.sessionActivateRequests, ledger = OperationLedger(operations = source.ledger.operations.filter {
                it.payload is LedgerPayload.Archive || it.payload is LedgerPayload.Quit
            }))
        val menu = hosts.map { host -> HostSnapshot(host.pairing,
            if (host.hostId == source.hostId) state else RemoteState(hostId = host.hostId,
                hostName = host.state.hostName, connection = host.state.connection,
                e2eReady = host.state.e2eReady), host.hasPendingInteraction) }
        val tree = catalog.resolve(source, language)
        if (downloadInput !== source.downloads) {
            downloadInput = source.downloads
            active = source.downloads.values.count { it.status == "queued" || it.status == "downloading" }
        }
        val before = previous
        if (before != null && before.state == state && before.hosts == menu && before.catalog === tree &&
            before.sync == sync && before.activeDownloads == active) return before
        return HomeUiSnapshot(state, menu, tree, sync, active).also { previous = it }
    }
}
