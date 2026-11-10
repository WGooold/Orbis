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
