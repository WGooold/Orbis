package com.orbising.orbis

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal const val KIMI_CODE_KIND = "kimiCode"
private const val KIMI_CODE_FEATURE = "agent.kimiCode"

internal fun deviceAgentFeatures(ready: JsonObject): List<String> {
    val advertised = (ready["hostFeatures"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    return if ("device.features" !in advertised) emptyList()
    else listOf("agent.dshDesktop") + listOf(KIMI_CODE_FEATURE, MESSAGE_RENDER_FEATURE).filter { it in advertised }
}

// The authenticated reply has the Desktop key (possibly null) only after processing the feature declaration.
internal fun hasNegotiatedKimiCode(ready: JsonObject): Boolean =
    ready.containsKey("dshDesktop") && KIMI_CODE_FEATURE in deviceAgentFeatures(ready)

internal fun isKimiCode(kind: String?, id: String?): Boolean = kind == KIMI_CODE_KIND || id?.startsWith("kimi-code:") == true
internal fun kimiSpawnMode(kind: String?, original: String): String = if (kind == KIMI_CODE_KIND) "headless" else original
internal fun RuntimeSummary.withKimiIdentity(): RuntimeSummary =
    if (agentKind == null && isKimiCode(null, runtimeId)) copy(agentKind = KIMI_CODE_KIND) else this
internal fun ChatMessage.materializesClientMessage(id: String): Boolean =
    messageId == id || clientMessageId == id || clientMessageIds?.contains(id) == true
