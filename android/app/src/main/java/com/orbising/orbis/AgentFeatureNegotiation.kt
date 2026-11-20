package com.orbising.orbis

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal const val AGENT_ENABLEMENT_FEATURE = "agent.enablement.v1"
internal const val CODEX_UNIFIED_HISTORY = "codex.history-unified.v1"
internal fun readyAdmitsCodexHistory(ready: JsonObject): Boolean =
    CODEX_UNIFIED_HISTORY in ready.features("hostFeatures") && CODEX_UNIFIED_HISTORY in ready.features("deviceFeatures")
internal fun readyAdmitsAgentEnablement(ready: JsonObject): Boolean =
    AGENT_ENABLEMENT_FEATURE in ready.features("hostFeatures") && AGENT_ENABLEMENT_FEATURE in ready.features("deviceFeatures")

private fun JsonObject.features(key: String): List<String> = (get(key) as? JsonArray).orEmpty()
    .mapNotNull { (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.contentOrNull }

internal fun readyAdmitsOpenClaw(ready: JsonObject): Boolean =
    "agent.openclaw" in ready.features("hostFeatures") && "agent.openclaw" in ready.features("deviceFeatures")

/** Called only on authenticated control frames; an offline Gateway can still negotiate. */
internal fun requestedAgentFeatures(ready: JsonObject): List<String> {
    val features = ready.features("hostFeatures")
    if ("device.features" !in features) return emptyList()
    val hostSupportsOpenClaw = "agent.openclaw" in features
    if ("dshDesktop" in ready && (!hostSupportsOpenClaw || readyAdmitsOpenClaw(ready)) &&
        (AGENT_ENABLEMENT_FEATURE !in features || readyAdmitsAgentEnablement(ready)) &&
        (CODEX_UNIFIED_HISTORY !in features || readyAdmitsCodexHistory(ready))) return emptyList()
    return deviceAgentFeatures(ready)
}
