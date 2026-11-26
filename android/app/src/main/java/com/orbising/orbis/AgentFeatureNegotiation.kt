package com.orbising.orbis

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal const val AGENT_ENABLEMENT_FEATURE = "agent.enablement.v1"
internal const val CODEX_UNIFIED_HISTORY = "codex.history-unified.v1"
internal const val AGY_KIND = "agy"
internal const val AGY_FEATURE = "agent.agy"
private const val KIMI_CODE_FEATURE = "agent.kimiCode"
private const val KIMI_CODE_DESKTOP_FEATURE = "agent.kimiCodeDesktop"
internal fun readyAdmitsCodexHistory(ready: JsonObject): Boolean =
    CODEX_UNIFIED_HISTORY in ready.features("hostFeatures") && CODEX_UNIFIED_HISTORY in ready.features("deviceFeatures")
internal fun readyAdmitsAgentEnablement(ready: JsonObject): Boolean =
    AGENT_ENABLEMENT_FEATURE in ready.features("hostFeatures") && AGENT_ENABLEMENT_FEATURE in ready.features("deviceFeatures")
internal fun readyAdmitsAgentDialReview(ready: JsonObject): Boolean = readyAdmitsAgentEnablement(ready) &&
    AGENT_DIAL_REVIEW_FEATURE in ready.features("hostFeatures") && AGENT_DIAL_REVIEW_FEATURE in ready.features("deviceFeatures")
internal fun readyAdmitsRuntimeClose(ready: JsonObject): Boolean =
    RUNTIME_CLOSE_FEATURE in ready.features("hostFeatures") && RUNTIME_CLOSE_FEATURE in ready.features("deviceFeatures")

private fun JsonObject.features(key: String): List<String> = (get(key) as? JsonArray).orEmpty()
    .mapNotNull { (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.contentOrNull }

internal fun readyAdmitsAgy(ready: JsonObject): Boolean =
    AGY_FEATURE in ready.features("hostFeatures") && AGY_FEATURE in ready.features("deviceFeatures")

internal fun readyAdmitsOpenClaw(ready: JsonObject): Boolean =
    "agent.openclaw" in ready.features("hostFeatures") && "agent.openclaw" in ready.features("deviceFeatures")

/** Called only on authenticated control frames; an offline Gateway can still negotiate. */
internal fun requestedAgentFeatures(ready: JsonObject): List<String> {
    val features = ready.features("hostFeatures")
    if ("device.features" !in features) return emptyList()
    val hostSupportsOpenClaw = "agent.openclaw" in features
    if ("dshDesktop" in ready && (!hostSupportsOpenClaw || readyAdmitsOpenClaw(ready)) &&
        (AGENT_ENABLEMENT_FEATURE !in features || readyAdmitsAgentEnablement(ready)) &&
        (AGENT_DIAL_REVIEW_FEATURE !in features || readyAdmitsAgentDialReview(ready)) &&
        (AGY_FEATURE !in features || readyAdmitsAgy(ready)) &&
        (KIMI_CODE_FEATURE !in features || KIMI_CODE_FEATURE in ready.features("deviceFeatures")) &&
        (KIMI_CODE_DESKTOP_FEATURE !in features || KIMI_CODE_DESKTOP_FEATURE in ready.features("deviceFeatures")) &&
        (CODEX_UNIFIED_HISTORY !in features || readyAdmitsCodexHistory(ready)) &&
        (RUNTIME_CLOSE_FEATURE !in features || readyAdmitsRuntimeClose(ready)) &&
        (RUNTIME_VIEW_CLOSE_FEATURE !in features || RUNTIME_VIEW_CLOSE_FEATURE in ready.features("deviceFeatures"))) return emptyList()
    return deviceAgentFeatures(ready)
}
