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
    val snapshot: SessionConfigurationSnapshot? = null, val proposed: SessionConfigurationValues? = null, val error: String? = null) {
    val values get() = proposed ?: snapshot?.values ?: SessionConfigurationValues()
    val model get() = snapshot?.catalog?.models?.firstOrNull { it.value == values.model }
}

internal fun SessionConfigurationValues.payload(): JsonObject = buildJsonObject {
    model?.let { put("model", it) }; thinking?.let { put("thinking", it) }
    put("permissions", buildJsonObject { permissions.forEach { (key, value) -> put(key, value) } })
}

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
        failure = message["error"]?.jsonPrimitive?.contentOrNull), error = null)
    return this
}
