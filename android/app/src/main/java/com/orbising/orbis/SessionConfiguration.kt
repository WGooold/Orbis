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

internal enum class ConfiguredLaunchBlock { CONFIGURATION_UNCONFIRMED, JOURNAL_LOADING, PREVIOUS_LAUNCH }

internal data class ConfiguredLaunchAdmission(val configuration: SessionConfigurationState, val block: ConfiguredLaunchBlock?) {
    val allowed: Boolean get() = block == null
}

/** LAUNCH-FEEDBACK-01: an unresolved launch owns its warning without invalidating native configuration. */
internal fun SessionConfigurationState.admitConfiguredLaunch(
    kind: String, cwd: String, journalLoaded: Boolean, journalPresent: Boolean,
): ConfiguredLaunchAdmission {
    val block = when {
        snapshot == null || snapshot.agentKind != kind || snapshot.cwd != cwd || error != null -> ConfiguredLaunchBlock.CONFIGURATION_UNCONFIRMED
        !journalLoaded -> ConfiguredLaunchBlock.JOURNAL_LOADING
        journalPresent -> ConfiguredLaunchBlock.PREVIOUS_LAUNCH
        else -> null
    }
    val failure = when (block) {
        ConfiguredLaunchBlock.CONFIGURATION_UNCONFIRMED -> L10n.tr("请先读取并确认启动配置")
        ConfiguredLaunchBlock.JOURNAL_LOADING, ConfiguredLaunchBlock.PREVIOUS_LAUNCH -> L10n.tr("请先核对上一次启动及首句结果")
        null -> return ConfiguredLaunchAdmission(copy(launchError = null, waitingForLaunchJournal = false), null)
    }
    val next = if (block == ConfiguredLaunchBlock.CONFIGURATION_UNCONFIRMED) copy(error = failure, launchError = null, waitingForLaunchJournal = false)
        else copy(launchError = failure, waitingForLaunchJournal = true)
    return ConfiguredLaunchAdmission(next, block)
}

/** SC104: only a previous launch awaiting reconciliation is headed as unconfirmed; null shows the error text itself. */
internal val SessionConfigurationState.launchErrorTitle: String?
    get() = if (launchError != null && waitingForLaunchJournal) L10n.tr("启动未确认") else null

/** SC100: a settled journal releases only the warning that was waiting on that journal. */
internal fun SessionConfigurationState.reconcileLaunchJournal(loaded: Boolean, present: Boolean): SessionConfigurationState =
    if (waitingForLaunchJournal && loaded && !present) copy(launchError = null, waitingForLaunchJournal = false) else this

internal fun SessionConfigurationValues.payload(): JsonObject = buildJsonObject {
    model?.let { put("model", it) }; thinking?.let { put("thinking", it) }
    put("permissions", buildJsonObject { permissions.forEach { (key, value) -> put(key, value) } })
}

/** ADR-0084: opt in only after authenticated Host readiness; preserve old Hosts' windowed default. */
private fun RemoteState.sessionSpawnMode(explicit: String?): String = explicit ?: if (prefersAutoSessionSpawn) "auto" else "tui"

internal fun RemoteState.sessionActivationRequest(id: String, target: JsonObject, spawnMode: String? = null): JsonObject = buildJsonObject {
    put("type", "session.activate"); put("protocolVersion", PROTOCOL_VERSION); put("requestId", id)
    put("target", target); put("spawnMode", sessionSpawnMode(spawnMode))
}

internal fun RemoteState.configuredSessionLaunchRequest(id: String, config: SessionConfigurationSnapshot, spawnMode: String? = null): JsonObject = buildJsonObject {
    put("type", "session.launch"); put("protocolVersion", PROTOCOL_VERSION); put("requestId", id); put("launchId", id)
    put("agentKind", config.agentKind); put("cwd", config.cwd); put("binding", config.binding); put("revision", config.revision)
    put("values", sessionConfiguration.values.payload()); put("spawnMode", sessionSpawnMode(spawnMode))
}

/** LAUNCH-WAIT-01: only the matching local journal can release a configured launch. */
internal fun LaunchState.canAbandonConfiguredLaunch(journalLaunchId: String?): Boolean =
    requestId == journalLaunchId && (failure != null || unconfirmed)

/** Leaving an uncertain page preserves its ledger identity; reopening must not attempt to create it again. */
internal fun RemoteState.restoreConfiguredLaunch(id: String, fields: Map<String, String>, now: Long): RemoteState {
    if (launching != null) return this
    val existing = ledger.operation(id)
    if (existing == null) return createLaunch(id, fields, L10n.tr("新会话"), now).first
    val launch = LaunchState(id, "launch:$id", fields, L10n.tr("新会话"), fields["cwd"].orEmpty(), fields["agentKind"], null,
        unconfirmed = true)
    return copy(launching = launch, selectedRuntimeId = launch.placeholder)
}

/** Only explicit abandonment releases an uncertain launch; an unreported native identity is not absence. */
internal fun RemoteState.abandonConfiguredLaunchState(id: String, firstId: String?): RemoteState {
    val launch = launching?.takeIf { it.requestId == id } ?: return this
    if (launch.failure == null && !launch.unconfirmed) return this
    // Send operations use command IDs, not message IDs. Release every send owned
    // by this placeholder, including restored rows without a ledger operation.
    val abandonedSends = ledger.operations.filter { op ->
        val send = op.payload as? LedgerPayload.Send
        send != null && (send.sessionId == launch.placeholder || send.messageId == firstId && id in op.prerequisites)
    }
    val messageIds = abandonedSends.map { (it.payload as LedgerPayload.Send).messageId }.toSet() +
        pendingSends.values.filter { it.sessionId == launch.placeholder }.map { it.messageId }
    val remainingLedger = abandonedSends.fold(ledger.remove(id)) { current, op -> current.remove(op.opId) }
    return copy(launching = null, ledger = remainingLedger, sessionActivateRequests = sessionActivateRequests - id,
        pendingSends = pendingSends - messageIds,
        selectedRuntimeId = selectedRuntimeId.takeUnless { it == launch.placeholder }, activatedSessionToOpen = null)
}

/** S51: only the matching native configuration confirmation can release the optimistic launch. */
internal fun RemoteState.withConfiguredLaunchResult(message: JsonObject): RemoteState {
    val id = message["launchId"]?.jsonPrimitive?.contentOrNull ?: return this
    val current = launching?.takeIf { it.requestId == id } ?: return this
    val phase = message["phase"]?.jsonPrimitive?.contentOrNull
    if (phase == "ready") {
        val session = message["sessionId"]?.jsonPrimitive?.contentOrNull ?: return this
        return reduceSessionActivated(this, buildJsonObject {
            put("type", "session.activated"); put("requestId", id); put("sessionId", session)
            put("agentKind", current.agentKind ?: "codex"); put("spawnMode", message["spawnMode"] ?: JsonPrimitive("tui"))
        })
    }
    if (phase in setOf("unknown", "failed", "absent")) return copy(launching = current.copy(unconfirmed = true,
        failure = message["error"]?.jsonPrimitive?.contentOrNull))
    return this
}
