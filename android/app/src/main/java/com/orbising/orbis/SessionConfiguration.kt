package com.orbising.orbis

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable
data class SessionConfigurationValues(val model: String? = null, val thinking: String? = null, val permissions: Map<String, String> = emptyMap())
@Serializable
data class SessionConfigurationModel(val value: String, val label: String, val thinking: List<RuntimePermissionOption> = emptyList(), val defaultThinking: String? = null)
@Serializable
data class SessionConfigurationCatalog(val binding: String, val defaults: SessionConfigurationValues = SessionConfigurationValues(),
    val models: List<SessionConfigurationModel> = emptyList(), val permissions: List<RuntimePermissionSetting> = emptyList(), val notice: String? = null)
@Serializable
data class SessionConfigurationSnapshot(val agentKind: String, val cwd: String, val binding: String, val revision: Long,
    val values: SessionConfigurationValues, val catalog: SessionConfigurationCatalog)

data class SessionConfigurationState(val agentKind: String = "", val cwd: String = "", val requestId: String? = null,
    val snapshot: SessionConfigurationSnapshot? = null, val proposed: SessionConfigurationValues? = null, val error: String? = null,
    val launchError: String? = null, val waitingForLaunchJournal: Boolean = false) {
    val values get() = proposed ?: snapshot?.values ?: SessionConfigurationValues()
    val model get() = snapshot?.catalog?.models?.firstOrNull { it.value == values.model }
}

internal enum class ConfiguredLaunchBlock { CONFIGURATION_UNCONFIRMED, JOURNAL_LOADING }

internal data class ConfiguredLaunchAdmission(val configuration: SessionConfigurationState, val block: ConfiguredLaunchBlock?) {
    val allowed: Boolean get() = block == null
}

/** Admission uses this request's configuration and local storage readiness, never another request's result. */
internal fun SessionConfigurationState.admitConfiguredLaunch(
    kind: String, cwd: String, journalLoaded: Boolean,
): ConfiguredLaunchAdmission {
    val block = when {
        snapshot == null || snapshot.agentKind != kind || snapshot.cwd != cwd || error != null -> ConfiguredLaunchBlock.CONFIGURATION_UNCONFIRMED
        !journalLoaded -> ConfiguredLaunchBlock.JOURNAL_LOADING
        else -> null
    }
    val failure = when (block) {
        ConfiguredLaunchBlock.CONFIGURATION_UNCONFIRMED -> L10n.tr("请先读取并确认启动配置")
        ConfiguredLaunchBlock.JOURNAL_LOADING -> L10n.tr("正在确认配置…")
        null -> return ConfiguredLaunchAdmission(copy(launchError = null, waitingForLaunchJournal = false), null)
    }
    val next = if (block == ConfiguredLaunchBlock.CONFIGURATION_UNCONFIRMED) copy(error = failure, launchError = null, waitingForLaunchJournal = false)
        else copy(launchError = failure, waitingForLaunchJournal = true)
    return ConfiguredLaunchAdmission(next, block)
}

/** SC104: the journal loading warning uses the shared status presentation. */
internal val SessionConfigurationState.launchErrorTitle: String?
    get() = if (launchError != null && waitingForLaunchJournal) L10n.tr("启动未确认") else null

/** SC100: a settled journal releases only the warning that was waiting on that journal. */
internal fun SessionConfigurationState.reconcileLaunchJournal(loaded: Boolean): SessionConfigurationState =
    if (waitingForLaunchJournal && loaded) copy(launchError = null, waitingForLaunchJournal = false) else this

internal fun SessionConfigurationValues.payload(): JsonObject = buildJsonObject {
    model?.let { put("model", it) }; thinking?.let { put("thinking", it) }
    put("permissions", buildJsonObject { permissions.forEach { (key, value) -> put(key, value) } })
}

/** ADR-0090: opt in only after authenticated Host readiness; preserve old Hosts' windowed default. */
internal fun RemoteState.sessionSpawnMode(explicit: String?): String = explicit ?: if (prefersAutoSessionSpawn) "auto" else "tui"

internal fun RemoteState.sessionActivationRequest(id: String, target: JsonObject, spawnMode: String? = null, codexLaunchMode: String? = null): JsonObject = buildJsonObject {
    put("type", "session.activate"); put("protocolVersion", PROTOCOL_VERSION); put("requestId", id)
    put("target", target); put("spawnMode", sessionSpawnMode(spawnMode))
    if (unifiedCodexHistory && codexLaunchMode != null) put("codexLaunchMode", codexLaunchMode)
}

internal fun RemoteState.configuredSessionLaunchRequest(id: String, config: SessionConfigurationSnapshot, spawnMode: String? = null): JsonObject {
    val payload = configuredLaunchPayload(id, config, sessionConfiguration.values, kimiSpawnMode(config.agentKind, sessionSpawnMode(spawnMode)))
    val mode = when (config.agentKind) { "codex" -> "terminal"; "codexDesktop" -> "desktop"; else -> null }
    return if (unifiedCodexHistory && mode != null) JsonObject(payload + ("codexLaunchMode" to JsonPrimitive(mode))) else payload
}

/** LAUNCH-WAIT-01: only the matching local journal can release a configured launch. */
internal fun LaunchState.canAbandonConfiguredLaunch(journalLaunchId: String?): Boolean =
    requestId == journalLaunchId && (failure != null || unconfirmed)

internal fun RemoteState.markConfiguredLaunchUnconfirmed(id: String, reason: String? = null): RemoteState {
    val value = launch(id) ?: return this
    return updateLaunch(value.copy(unconfirmed = true, failure = reason)).copy(sessionActivateRequests = sessionActivateRequests - id)
}

/** Recreate an unconfirmed overlay; a recovered record never revives its original send operation. */
internal fun RemoteState.restoreConfiguredLaunch(id: String, fields: Map<String, String>, now: Long,
    codexLaunchMode: String? = null, following: Boolean = true): RemoteState {
    if (launch(id) != null) return if (following) focusLaunch(id) else this
    val placeholder = "launch:$id"
    val operation = if (ledger.operation(id) != null) ledger else ledger.create(id, OperationKinds.LAUNCH, placeholder,
        policy = OperationKinds.launchPolicy, basis = ledgerBasis(OperationKinds.RUNTIMES_DOMAIN),
        payload = LedgerPayload.Launch(id, placeholder), written = true, now = now).first
    val value = LaunchState(id, placeholder, fields, L10n.tr("新会话"), fields["cwd"].orEmpty(), fields["agentKind"], null,
        unconfirmed = true, codexLaunchMode = codexLaunchMode, following = false, configured = true)
    val next = copy(ledger = operation, backgroundLaunches = backgroundLaunches + (id to value))
    return if (following) next.focusLaunch(id) else next
}

internal fun RemoteState.restoreConfiguredLaunchRecord(id: String, saved: JsonObject, now: Long, show: Boolean,
    mayRestoreSelection: Boolean = false): RemoteState {
    val fields = mapOf("type" to "new", "agentKind" to (saved["agentKind"]?.jsonPrimitive?.contentOrNull ?: return this),
        "cwd" to (saved["cwd"]?.jsonPrimitive?.contentOrNull ?: return this))
    val following = show || mayRestoreSelection && allowAutomaticLaunchSelection && launching == null &&
        selectedOfflineSessionId == null && saved["following"]?.jsonPrimitive?.booleanOrNull != false
    var next = restoreConfiguredLaunch(id, fields, now, saved["codexLaunchMode"]?.jsonPrimitive?.contentOrNull, following)
    val text = saved["firstMessage"]?.jsonPrimitive?.contentOrNull.orEmpty()
    val messageId = saved["firstMessageId"]?.jsonPrimitive?.contentOrNull
    if (text.isNotBlank() && messageId != null && messageId !in next.pendingSends) {
        next = next.copy(pendingSends = next.pendingSends + (messageId to PendingSend(messageId,
            saved["firstCommandId"]?.jsonPrimitive?.contentOrNull ?: messageId, "launch:$id", text, emptyList(), null,
            now, null, PendingSendState.Unconfirmed, needsDeliveryEvidence = true, runtimeId = "launch:$id")))
    }
    return next
}

/** Only explicit abandonment releases an uncertain launch; an unreported native identity is not absence. */
internal fun RemoteState.abandonConfiguredLaunchState(id: String, firstId: String?): RemoteState {
    val launch = launching?.takeIf { it.requestId == id } ?: return this
    if (launch.failure == null && !launch.unconfirmed) return this
    return retireConfiguredLaunchState(id, firstId)
}

/** Remove only the superseded attempt, even when its launch page has already closed. */
internal fun RemoteState.retireConfiguredLaunchState(id: String, firstId: String?): RemoteState {
    val placeholder = "launch:$id"
    // Send operations use command IDs, not message IDs. Release every send owned
    // by this placeholder, including restored rows without a ledger operation.
    val abandonedSends = ledger.operations.filter { op ->
        val send = op.payload as? LedgerPayload.Send
        send != null && (send.sessionId == placeholder || send.runtimeId == placeholder || id in op.prerequisites)
    }
    val messageIds = abandonedSends.map { (it.payload as LedgerPayload.Send).messageId }.toSet() +
        pendingSends.values.filter { it.sessionId == placeholder || it.runtimeId == placeholder || it.messageId == firstId }.map { it.messageId }
    val remainingLedger = abandonedSends.fold(ledger.remove(id)) { current, op -> current.remove(op.opId) }
    return copy(launching = launching?.takeUnless { it.requestId == id }, backgroundLaunches = backgroundLaunches - id, ledger = remainingLedger,
        sessionActivateRequests = sessionActivateRequests - id, pendingSends = pendingSends - messageIds,
        launchSessions = launchSessions - placeholder,
        selectedRuntimeId = selectedRuntimeId.takeUnless { it == placeholder },
        activatedSessionToOpen = if (launching?.requestId == id) null else activatedSessionToOpen)
}

/** S51: only the matching native configuration confirmation can release the optimistic launch. */
internal fun RemoteState.withConfiguredLaunchResult(message: JsonObject): RemoteState {
    val id = (message["launchId"] as? JsonPrimitive)?.contentOrNull ?: return this
    val current = launch(id)?.takeUnless { it.endingWait } ?: return this
    val phase = (message["phase"] as? JsonPrimitive)?.contentOrNull
    val now = System.currentTimeMillis()
    if (phase == "ready") {
        val session = (message["sessionId"] as? JsonPrimitive)?.contentOrNull ?: return this
        // A recovery reply can be the first proof of the operation after a process restart.
        return reduceSessionActivated(ledgerWritten(id, now), buildJsonObject {
            put("type", "session.activated"); put("requestId", id); put("sessionId", session)
            put("agentKind", current.agentKind ?: "codex"); put("spawnMode", (message["spawnMode"] as? JsonPrimitive)?.contentOrNull ?: "tui")
        }, confirmedConfiguration = true)
    }
    val error = (message["error"] as? JsonPrimitive)?.contentOrNull
    if (phase == "failed") {
        val failure = error ?: L10n.tr("启动失败")
        return updateLaunch(current.copy(unconfirmed = false, failure = failure)).copy(sessionActivateRequests = sessionActivateRequests - id)
            .ledgerWritten(id, now).ledgerReceipt(id, LedgerReceipt.Failed(LedgerRejection("configuration_rejected", failure)), now)
    }
    if (phase == "unknown") return markConfiguredLaunchUnconfirmed(id, error)
    if (phase == "absent") return updateLaunch(current.copy(unconfirmed = true, failure = error))
    return this
}

internal fun configuredLaunchPayload(id: String, config: SessionConfigurationSnapshot, values: SessionConfigurationValues, spawnMode: String): JsonObject = buildJsonObject {
    put("type", "session.launch"); put("protocolVersion", PROTOCOL_VERSION); put("requestId", id); put("launchId", id)
    put("agentKind", config.agentKind); put("cwd", config.cwd); put("binding", config.binding); put("revision", config.revision)
    put("values", (if (config.agentKind == "openclaw") SessionConfigurationValues() else values).payload())
    put("spawnMode", if (config.agentKind == "openclaw") "headless" else spawnMode)
}
