package com.orbising.orbis

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private fun JsonObject.features(key: String): List<String> = (get(key) as? JsonArray).orEmpty()
    .mapNotNull { (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.contentOrNull }

internal fun readyAdmitsOpenClaw(ready: JsonObject): Boolean =
    "agent.openclaw" in ready.features("hostFeatures") && "agent.openclaw" in ready.features("deviceFeatures")

/** Called only on authenticated control frames; an offline Gateway can still negotiate. */
internal fun requestedAgentFeatures(ready: JsonObject): List<String> {
    val features = ready.features("hostFeatures")
    if ("device.features" !in features) return emptyList()
    val hostSupportsOpenClaw = "agent.openclaw" in features
    if ("dshDesktop" in ready && (!hostSupportsOpenClaw || readyAdmitsOpenClaw(ready))) return emptyList()
    return if (hostSupportsOpenClaw) listOf("agent.dshDesktop", "agent.openclaw") else listOf("agent.dshDesktop")
}
