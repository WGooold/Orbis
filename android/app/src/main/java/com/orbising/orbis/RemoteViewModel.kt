package com.orbising.orbis

import android.app.Application
import android.net.Uri
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.util.UUID

/**
 * 状态页只读的配对现场（spec §5）。这些值来自凭据与 E2E 身份库，只在配对/解配时变化，
 * 按需读取即可，不进入 RemoteState 的实时事件流。pskRoot 只暴露「存在与否」，不显示内容。
 */
data class PairingStatus(
    val relayUrl: String?,
    val deviceId: String?,
    val hostId: String?,
    val hostPublicKeyFingerprint: String?,
    val pskRootPresent: Boolean,
)

/** One paired computer and the last state its connection published. */
data class HostSnapshot(
    val pairing: HostPairing,
    val state: RemoteState,
) {
    val hostId: String get() = pairing.hostId
    val name: String
        get() = sequenceOf(pairing.hostName, state.hostName)
            .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
            .firstOrNull()
            ?: "已配对电脑"
}

/**
 * The multi-Host hub.
 *
 * One [HostConnection] per paired computer, each with its own Relay socket, E2E session and
 * `RemoteState`. `state` is whatever the selected Host last published, so every single-Host screen
 * keeps working unchanged; [hosts] carries the rest for the drawer, the switcher and merged views.
 *
 * Host identity is the pairing's `hostId`. Re-pairing the same computer replaces that record in
 * [HostPairingStore] — two records with one `hostId` would open two sockets to the same Host.
 */
class RemoteViewModel(application: Application) : AndroidViewModel(application) {
    private val pairings = HostPairingStore(application)
    private val legacyCredentials = CredentialStore(application)
    private val legacyIdentity = E2eIdentityStore(application)
    private val stores = HostStores(application)

    private val lock = Any()
    private val connections = LinkedHashMap<String, HostConnection>()
    private val observationJobs = mutableMapOf<String, Job>()
    private val activeHostId = MutableStateFlow<String?>(null)
    private val pairingOrder = MutableStateFlow<List<HostPairing>>(emptyList())
    private val hostStates = MutableStateFlow<Map<String, RemoteState>>(emptyMap())
    private val pairingErrors = MutableStateFlow<String?>(null)
    private var pairingJob: Job? = null

    /** What the selected Host last published. */
    val state: StateFlow<RemoteState> = combine(hostStates, activeHostId) { states, active ->
        states[active] ?: RemoteState()
    }.stateIn(viewModelScope, SharingStarted.Eagerly, RemoteState())

    /** Every paired computer with its live state, in pairing order. */
    val hosts: StateFlow<List<HostSnapshot>> = combine(pairingOrder, hostStates) { order, states ->
        order.mapNotNull { pairing -> states[pairing.hostId]?.let { HostSnapshot(pairing, it) } }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    /** Add-a-computer failures; the pairing screen shows these instead of the session error. */
    val pairingError: StateFlow<String?> = pairingErrors

    init {
        migrateLegacyPairing()
        val stored = pairings.hosts()
        stored.forEach { install(it, makeActive = false) }
        setActiveHost(pairings.activeHostId() ?: stored.firstOrNull()?.hostId)
        // Records written before multi-Host carry no owner. With one Host they can only belong to
        // it; with several there is no safe guess, so they stay hidden instead of being duplicated
        // into every Host's download scheduler.
        if (stored.size == 1) {
            stores.downloads.adoptHostId(stored[0].hostId)
            stores.uploads.adoptHostId(stored[0].hostId)
        }
    }

    // ── Host lifecycle ──────────────────────────────────────────────────────

    private fun migrateLegacyPairing() {
        if (pairings.hosts().isNotEmpty()) return
        val identity = legacyIdentity.loadPairedHost() ?: return
        val credential = legacyCredentials.load() ?: return
        pairings.add(
            HostPairing(
                hostId = identity.hostId,
                hostName = identity.hostName,
                hostPub = identity.hostPub,
                pskRoot = identity.pskRoot,
                lanEndpoints = identity.lanEndpoints,
                relayUrl = credential.relayUrl,
                deviceId = credential.deviceId,
                credential = credential.credential,
            ),
        )
    }

    private fun install(pairing: HostPairing, makeActive: Boolean) {
        pairings.add(pairing)
        val existing = synchronized(lock) { connections.remove(pairing.hostId) }
        existing?.shutdown()
        observationJobs.remove(pairing.hostId)?.cancel()
        val connection = HostConnection(
            application = getApplication(),
            scope = viewModelScope,
            initial = pairing,
            stores = stores,
            deviceKeyPair = { legacyIdentity.loadOrCreateDeviceKeyPair() },
            onPairingUpdated = { updated ->
                pairings.add(updated)
                pairingOrder.update { order ->
                    order.map { if (it.hostId == updated.hostId) updated else it }
                }
            },
        )
        synchronized(lock) { connections[pairing.hostId] = connection }
        hostStates.update { it + (pairing.hostId to connection.state.value) }
        pairingOrder.value = pairings.hosts()
        observationJobs[pairing.hostId] = viewModelScope.launch {
            connection.state.collect { latest -> hostStates.update { it + (pairing.hostId to latest) } }
        }
        if (makeActive) setActiveHost(pairing.hostId)
    }

    /** Selects the Host the interactive screens operate on. */
    fun selectHost(hostId: String) {
        setActiveHost(hostId)
    }

    private fun setActiveHost(hostId: String?) {
        val resolved = synchronized(lock) { hostId?.takeIf { connections.containsKey(it) } }
            ?: pairingOrder.value.firstOrNull()?.hostId
        activeHostId.value = resolved
        pairings.setActiveHostId(resolved)
    }

    private fun active(): HostConnection? {
        val id = activeHostId.value ?: return null
        return synchronized(lock) { connections[id] }
    }

    /** Removes a pairing, its live connection and everything cached under it. */
    fun unpair(hostId: String? = activeHostId.value) {
        val id = hostId ?: return
        val connection = synchronized(lock) { connections.remove(id) }
        observationJobs.remove(id)?.cancel()
        connection?.shutdown()
        val pairing = pairingOrder.value.firstOrNull { it.hostId == id }
        pairings.remove(id)
        hostStates.update { it - id }
        pairingOrder.value = pairings.hosts()
        stores.lastSession.clear(id)
        pairing?.let { removed ->
            val credential = removed.credential()
            val downloadIds = stores.downloads.load().filter { it.hostId == id }.map(ArtifactDownload::taskId).toSet()
            val uploadIds = stores.uploads.load().filter { it.hostId == id }.map(UploadTask::taskId).toSet()
            if (downloadIds.isNotEmpty()) stores.downloads.delete(downloadIds)
            if (uploadIds.isNotEmpty()) stores.uploads.delete(uploadIds)
            stores.sessionAlias.clear(credential)
            stores.draft.clear(credential)
            viewModelScope.launch(Dispatchers.IO) {
                runCatching { SessionCatalogStore(getApplication(), id).clear() }
                runCatching { stores.sessionGraph.clearDevice(credential) }
                runCatching { RelayClient().apply { setApplicationContext(getApplication()) }.revoke(credential) }
            }
        }
        setActiveHost(activeHostId.value)
    }

    // ── Pairing a new computer ──────────────────────────────────────────────

    fun clearPairingError() {
        pairingErrors.value = null
    }

    /**
     * Pairs one more computer. Uses a dedicated Relay socket so an add-host attempt can never
     * disconnect the computers that are already online.
     */
    fun pair(relayUrl: String, code: String, qrRaw: String? = null) {
        pairingJob?.cancel()
        pairingErrors.value = null
        pairingJob = viewModelScope.launch {
            val qr = qrRaw?.let(::parsePairingQrV2)
            if (qr == null) {
                pairingErrors.value = "二维码缺少端到端加密材料或格式无效：请在电脑上重新执行 orbis pair，扫描新二维码"
                return@launch
            }
            if (qr.exp * 1000 < System.currentTimeMillis()) {
                pairingErrors.value = "配对二维码已过期，请在电脑上重新生成（配对窗口只有几分钟）"
                return@launch
            }
            val relay = RelayClient().apply { setApplicationContext(getApplication()) }
            val paired = runCatching { relay.pair(relayUrl.trim(), code, Build.MODEL) }.getOrElse { error ->
                pairingErrors.value = localizedError(error, "配对失败，请检查中继服务器地址、配对码和网络连接")
                return@launch
            }
            val keyPair = legacyIdentity.loadOrCreateDeviceKeyPair()
            val session = runCatching {
                DevicePairingSession.create(
                    hostPublicRaw = Crypto.fromBase64UrlFixed(qr.hostPub, Crypto.X25519_KEY_BYTES, "hostPub"),
                    psk = Crypto.fromBase64UrlFixed(qr.psk, Crypto.SYMMETRIC_KEY_BYTES, "psk"),
                    deviceId = paired.deviceId,
                    deviceKeyPair = keyPair,
                )
            }.getOrElse { error ->
                pairingErrors.value = localizedError(error, "配对材料无效，请重新扫码")
                return@launch
            }
            val accepted = CompletableDeferred<Unit>()
            relay.connect(
                device = paired,
                onMessage = { _, _ -> },
                onOpen = {},
                onClosed = { accepted.completeExceptionally(IllegalStateException("配对连接已断开")) },
                e2eOptions = E2eConnectOptions(
                    hostId = qr.hostId,
                    deviceId = paired.deviceId,
                    deviceKeyPair = keyPair,
                    pairingSession = session,
                    onPairAccepted = { accepted.complete(Unit) },
                ),
            )
            val outcome = runCatching { withTimeout(10_000) { accepted.await() } }
            relay.disconnect()
            outcome.onSuccess {
                install(
                    HostPairing(
                        hostId = qr.hostId,
                        hostName = qr.hostName,
                        hostPub = qr.hostPub,
                        pskRoot = Crypto.toBase64Url(session.pskRoot),
                        lanEndpoints = qr.lan,
                        relayUrl = paired.relayUrl,
                        deviceId = paired.deviceId,
                        credential = paired.credential,
                    ),
                    makeActive = true,
                )
            }.onFailure {
                pairingErrors.value = "配对没有完成：电脑没有回确认（配对窗口可能已关闭或过期）。" +
                    "请确认电脑上的配对窗口还开着，再扫一次二维码"
            }
        }
    }

    // ── Selected-Host facade ────────────────────────────────────────────────
    // Every session, download and interaction command addresses exactly one paired computer; the
    // user selects which one with the Host switcher.

    fun refreshSessions() = active()?.refreshSessions()

    fun refreshDiagnostics(cursor: String? = null) = active()?.refreshDiagnostics(cursor)

    fun refreshProviderFacts() = active()?.refreshProviderModel()

    /** 前台和定期核对按领域重读；聊天与通知仍保留各自事务和恢复水位。 */
    fun reconcileModels() {
        synchronized(lock) { connections.values.toList() }.forEach { connection ->
            connection.refreshHostModel()
            connection.state.value.runtimes.keys.forEach { connection.refreshAgentModel(it) }
        }
    }

    /** Switches to [hostId] and opens its runtime (or activates the Session) in one step. */
    fun openSession(hostId: String, sessionId: String) {
        val connection = connectionFor(hostId) ?: return
        setActiveHost(hostId)
        val runtime = connection.state.value.runtimes.values.firstOrNull { it.sessionId == sessionId }
        if (runtime != null) connection.selectRuntime(runtime.runtimeId) else connection.activateSession(sessionId)
    }

    fun openOfflineSession(hostId: String, sessionId: String) {
        val connection = connectionFor(hostId) ?: return
        setActiveHost(hostId)
        connection.selectOfflineSession(sessionId)
    }

    fun openRuntime(hostId: String, runtimeId: String) {
        val connection = connectionFor(hostId) ?: return
        setActiveHost(hostId)
        connection.selectRuntime(runtimeId)
    }

    fun setSessionArchived(sessionId: String, archived: Boolean) =
        active()?.setSessionArchived(sessionId, archived)

    fun browseSessions(path: String? = null) = active()?.browseSessions(path)

    fun browseInto(name: String) = active()?.browseInto(name)

    fun browseUp() = active()?.browseUp()

    fun dismissBrowse() = active()?.dismissBrowse()

    fun activateSession(sessionId: String) = active()?.activateSession(sessionId)

    fun createSession(agentKind: String, cwd: String, expectedHostId: String?) =
        active()?.createSession(agentKind, cwd, expectedHostId)

    fun loadAgentProviders(kind: String) = active()?.loadAgentProviders(kind)

    fun switchAgentProvider(provider: AgentProvider, expectedHostId: String?) =
        active()?.switchAgentProvider(provider, expectedHostId)

    fun clearActivationNotice() = active()?.clearActivationNotice()

    fun selectRuntime(runtimeId: String?) = active()?.selectRuntime(runtimeId)

    fun refreshWorkingBranch(runtimeId: String) = active()?.refreshWorkingBranch(runtimeId)

    fun refreshRuntime(runtimeId: String? = null, explicitRetry: Boolean = false): Boolean {
        val connection = active() ?: return false
        return if (runtimeId == null) connection.refreshRuntime(explicitRetry = explicitRetry)
        else connection.refreshRuntime(runtimeId, explicitRetry)
    }

    fun refreshAfterBranchAction(runtimeId: String) = active()?.refreshAfterBranchAction(runtimeId)

    fun selectOfflineSession(sessionId: String?) = active()?.selectOfflineSession(sessionId)

    fun loadOlderHistory(runtimeId: String? = null): HistoryReadAcceptance {
        val connection = active() ?: return HistoryReadAcceptance(rejection = "没有选中的历史窗口")
        return if (runtimeId == null) connection.loadOlderHistory() else connection.loadOlderHistory(runtimeId)
    }

    fun loadDraft(runtimeId: String): String = active()?.loadDraft(runtimeId).orEmpty()

    fun saveDraft(runtimeId: String, value: String) = active()?.saveDraft(runtimeId, value)

    fun clearDraft(runtimeId: String) = active()?.clearDraft(runtimeId)

    fun setSessionAlias(runtimeId: String, value: String) = active()?.setSessionAlias(runtimeId, value)

    fun setSessionAliasOn(hostId: String, runtimeId: String, value: String) =
        connectionFor(hostId)?.setSessionAlias(runtimeId, value)

    fun setSessionArchivedOn(hostId: String, sessionId: String, archived: Boolean) =
        connectionFor(hostId)?.setSessionArchived(sessionId, archived)

    fun sendMessage(
        text: String,
        delivery: String? = null,
        attachments: List<String> = emptyList(),
    ): String? = active()?.sendMessage(text, delivery, attachments)

    fun detachUploads(taskIds: Set<String>) = active()?.detachUploads(taskIds)

    fun attachedTaskIds(sessionKey: String): Set<String> =
        active()?.attachedTaskIds(sessionKey).orEmpty()

    fun setAttachedTaskIds(sessionKey: String, taskIds: Set<String>) =
        active()?.setAttachedTaskIds(sessionKey, taskIds)

    fun executeSlashCommand(name: String, args: String): String? =
        active()?.executeSlashCommand(name, args)

    fun updatePermissions(settingId: String, value: String): String? =
        active()?.updatePermissions(settingId, value)

    fun consumeCommandResult(commandId: String) = active()?.consumeCommandResult(commandId)

    fun stopRuntime() = active()?.stopRuntime()

    fun requestFullEntry(runtimeId: String, entryId: String) =
        active()?.requestFullEntry(runtimeId, entryId)

    fun downloadArtifact(runtimeId: String, artifact: RemoteArtifact) =
        active()?.downloadArtifact(runtimeId, artifact)

    fun downloadFile(path: String) = active()?.downloadFile(path)

    fun downloadFile(runtimeId: String, path: String) = active()?.downloadFile(runtimeId, path)

    fun cancelDownload(taskId: String) = active()?.cancelDownload(taskId)

    fun deleteDownloads(taskIds: Set<String>) = active()?.deleteDownloads(taskIds)

    fun retryDownload(taskId: String) = active()?.retryDownload(taskId)

    fun respondConfirm(request: PendingInteraction, approved: Boolean) =
        active()?.respondConfirm(request, approved)

    fun respondValue(request: PendingInteraction, value: String) = active()?.respondValue(request, value)

    fun respondValues(request: PendingInteraction, values: List<String>) =
        active()?.respondValues(request, values)

    fun respondQuestionnaire(request: PendingInteraction, answers: List<QuestionnaireAnswer>?) =
        active()?.respondQuestionnaire(request, answers)

    fun cancelInteraction(request: PendingInteraction) = active()?.cancelInteraction(request)

    fun clearError() = active()?.clearError()

    fun syncNotifications(runtimeId: String) {
        // Every online Host pushes its own notifications; a single runtimeId belongs to one of them.
        hosts.value.firstOrNull { it.state.runtimes.containsKey(runtimeId) }
            ?.let { snapshot -> connectionFor(snapshot.hostId)?.syncNotifications(runtimeId) }
            ?: active()?.syncNotifications(runtimeId)
    }

    fun dismissNotification(runtimeId: String, notificationId: String) {
        hosts.value.firstOrNull { it.state.runtimes.containsKey(runtimeId) }
            ?.let { connectionFor(it.hostId)?.dismissNotification(runtimeId, notificationId) }
            ?: active()?.dismissNotification(runtimeId, notificationId)
    }

    fun queueUpload(uri: Uri, runtimeId: String, onQueued: (String) -> Unit = {}) =
        active()?.queueUpload(uri, runtimeId, onQueued)

    fun removeUploads(taskIds: Set<String>) = active()?.removeUploads(taskIds)

    fun pathPreference(): List<String> = stores.pathPreference.load()

    fun setPathPreference(order: List<String>) = active()?.setPathPreference(order)

    private fun connectionFor(hostId: String): HostConnection? = synchronized(lock) { connections[hostId] }

    // ── Diagnostics ─────────────────────────────────────────────────────────

    fun pairingStatus(): PairingStatus {
        val pairing = active()?.pairing
        return PairingStatus(
            relayUrl = pairing?.relayUrl,
            deviceId = pairing?.deviceId,
            hostId = pairing?.hostId,
            hostPublicKeyFingerprint = pairing?.hostPub?.take(12),
            pskRootPresent = !pairing?.pskRoot.isNullOrBlank(),
        )
    }

    fun diagnosticReport(): String = buildString {
        val order = pairingOrder.value
        appendLine("已配对电脑 ${order.size} 台")
        order.forEachIndexed { index, pairing ->
            val snapshot = hosts.value.firstOrNull { it.hostId == pairing.hostId }
            val current = snapshot?.state
            appendLine(
                "  ${index + 1}. ${pairing.hostName ?: pairing.hostId}" +
                    " [${pairing.hostId}] 连接 ${current?.connection ?: RelayConnection.OFFLINE}" +
                    if (activeHostId.value == pairing.hostId) "（当前）" else "",
            )
        }
        appendLine("──── 当前电脑 ────")
        append(active()?.diagnosticReport() ?: "未选择电脑")
    }

    private fun localizedError(error: Throwable, fallback: String): String {
        val message = error.message
        return if (message?.any { it in '\u4e00'..'\u9fff' } == true) message else fallback
    }

    override fun onCleared() {
        synchronized(lock) { connections.values.toList() }.forEach(HostConnection::shutdown)
        synchronized(lock) { connections.clear() }
        stores.sessionGraph.close()
        super.onCleared()
    }
}
