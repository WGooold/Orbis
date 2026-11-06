package com.orbising.orbis

/** FT-G03: each view releases only its own interest; the lightweight home baseline
 * remains. Capabilities also authorize the home Close action until catalog paging. */
internal val HOME_AGENT_MODEL_DOMAINS = listOf("identity", "execution", "interactions", "capabilities")
internal val CHAT_AGENT_MODEL_DOMAINS = listOf("delivery", "model", "context", "permissions")
internal val HOME_HOST_MODEL_DOMAINS = listOf("identity", "backends", "catalog", "providers")

internal fun AgentStateRead.matchesInterest(wanted: List<String>, now: Long): Boolean =
    domains == wanted.toSet() && now - sentAt < 14_000

internal data class ModelInterests(private val values: Map<String, Map<String, Set<String>>> = emptyMap()) {
    fun replacing(key: String, owner: String, domains: Set<String>): ModelInterests {
        val owners = values[key].orEmpty().let { if (domains.isEmpty()) it - owner else it + (owner to domains) }
        return ModelInterests(if (owners.isEmpty()) values - key else values + (key to owners))
    }

    fun domains(key: String, base: List<String>, allowed: List<String>): List<String> =
        (base + values[key].orEmpty().values.flatten()).distinct().filter { it in allowed }
}
