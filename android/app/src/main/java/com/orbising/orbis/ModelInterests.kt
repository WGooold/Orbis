package com.orbising.orbis

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** FT-G03: each view releases only its own interest; the lightweight home baseline
 * remains. Capabilities also authorize the home Close action until catalog paging. */
internal val HOME_AGENT_MODEL_DOMAINS = listOf("identity", "execution", "interactions", "capabilities")
internal val CHAT_AGENT_MODEL_DOMAINS = listOf("delivery", "model", "context", "permissions")
internal val HOME_HOST_MODEL_DOMAINS = listOf("identity", "backends", "catalog", "providers")

internal fun AgentStateRead.matchesInterest(wanted: List<String>, now: Long): Boolean =
    domains == wanted.toSet() && now - sentAt < 14_000

internal fun AgentStateRead.needsLegacyRetry(message: JsonObject): Boolean {
    if (stateFormat != "compact-v1") return false
    val type = message["type"]?.jsonPrimitive?.contentOrNull
    return type == "protocol.error" && message["code"]?.jsonPrimitive?.contentOrNull in setOf("invalid_request", "unsupported_request") ||
        type == "agent.state.snapshot" && message["stateFormat"] == null
}

internal data class ModelInterests(private val values: Map<String, Map<String, Set<String>>> = emptyMap()) {
    fun replacing(key: String, owner: String, domains: Set<String>): ModelInterests {
        val owners = values[key].orEmpty().let { if (domains.isEmpty()) it - owner else it + (owner to domains) }
        return ModelInterests(if (owners.isEmpty()) values - key else values + (key to owners))
    }

    fun domains(key: String, base: List<String>, allowed: List<String>): List<String> =
        (base + values[key].orEmpty().values.flatten()).distinct().filter { it in allowed }
}
