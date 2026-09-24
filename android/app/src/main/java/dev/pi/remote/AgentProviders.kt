package dev.pi.remote

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.booleanOrNull

data class AgentProvider(val id: String, val kind: String, val name: String, val enabled: Boolean, val additive: Boolean)
data class AgentProvidersState(
    val kind: String = "codex",
    val hostId: String? = null,
    val requestId: String? = null,
    val providers: List<AgentProvider> = emptyList(),
    val loading: Boolean = false,
    val notice: String? = null,
    val error: String? = null,
)

internal fun RemoteState.withProviderResult(message: JsonObject): RemoteState {
    val request = message["requestId"]?.jsonPrimitive?.contentOrNull
    val kind = message["kind"]?.jsonPrimitive?.contentOrNull
    val current = agentProviders
    if (request == null || request != current.requestId || kind != current.kind || current.hostId != hostId) return this
    val failure = message["error"]?.jsonPrimitive?.contentOrNull
    if (failure != null) return copy(agentProviders = current.copy(loading = false, requestId = null, error = failure))
    val rows = message["providers"]?.jsonArray?.mapNotNull { element ->
        val row = element.jsonObject
        val id = row["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        if (row["kind"]?.jsonPrimitive?.contentOrNull != kind) return@mapNotNull null
        AgentProvider(id, kind, row["name"]?.jsonPrimitive?.contentOrNull ?: id,
            row["enabled"]?.jsonPrimitive?.booleanOrNull == true,
            row["mode"]?.jsonPrimitive?.contentOrNull == "additive")
    } ?: emptyList()
    return copy(agentProviders = current.copy(requestId = null, loading = false, providers = rows,
        error = null, notice = message["notice"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)))
}
