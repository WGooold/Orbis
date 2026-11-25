package com.orbising.orbis

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

internal const val KIMI_CODE_KIND = "kimiCode"
internal const val KIMI_CODE_DESKTOP_KIND = "kimiCodeDesktop"
private const val KIMI_CODE_FEATURE = "agent.kimiCode"
private const val KIMI_CODE_DESKTOP_FEATURE = "agent.kimiCodeDesktop"

internal fun deviceAgentFeatures(ready: JsonObject): List<String> {
    val advertised = (ready["hostFeatures"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    return if ("device.features" !in advertised) emptyList()
    else listOf("agent.dshDesktop") + listOf(
        KIMI_CODE_FEATURE,
        KIMI_CODE_DESKTOP_FEATURE,
        MESSAGE_RENDER_FEATURE,
        "agent.openclaw",
        "agent.hermes",
        "agent.opencode",
        AGY_FEATURE,
        AGENT_ENABLEMENT_FEATURE,
        AGENT_DIAL_REVIEW_FEATURE,
        "state.compact-bootstrap.v1",
        "claude.send-now.v1",
        RUNTIME_CLOSE_FEATURE,
        RUNTIME_VIEW_CLOSE_FEATURE,
        CODEX_UNIFIED_HISTORY,
    ).filter { it in advertised }
}

// The authenticated reply has the Desktop key (possibly null) only after processing the feature declaration.
internal fun hasNegotiatedKimiCode(ready: JsonObject): Boolean =
    ready.containsKey("dshDesktop") && KIMI_CODE_FEATURE in deviceAgentFeatures(ready) && KIMI_CODE_FEATURE in ready.strings("deviceFeatures")
internal fun hasNegotiatedKimiCodeDesktop(ready: JsonObject): Boolean =
    ready.containsKey("dshDesktop") && KIMI_CODE_DESKTOP_FEATURE in deviceAgentFeatures(ready) && KIMI_CODE_DESKTOP_FEATURE in ready.strings("deviceFeatures")

private fun JsonObject.strings(key: String): List<String> = (get(key) as? JsonArray).orEmpty()
    .mapNotNull { (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.contentOrNull }

internal fun kimiKind(kind: String?, id: String?): String? = when {
    kind == KIMI_CODE_DESKTOP_KIND -> KIMI_CODE_DESKTOP_KIND
    id?.startsWith("kimi-code-desktop:") == true -> KIMI_CODE_DESKTOP_KIND
    kind == KIMI_CODE_KIND -> KIMI_CODE_KIND
    id?.startsWith("kimi-code:desktop-") == true -> KIMI_CODE_DESKTOP_KIND
    id?.startsWith("kimi-code:") == true -> KIMI_CODE_KIND
    else -> null
}
internal fun isKimiCode(kind: String?, id: String?): Boolean = kimiKind(kind, id) != null
internal fun isKimiCodeDesktop(kind: String?, id: String? = null): Boolean = kimiKind(kind, id) == KIMI_CODE_DESKTOP_KIND
internal fun RemoteState.supportsKimiCode(kind: String?, id: String? = null): Boolean = when (kimiKind(kind, id)) {
    KIMI_CODE_KIND -> kimiCodeSupported
    KIMI_CODE_DESKTOP_KIND -> kimiCodeDesktopSupported
    else -> true
}
internal fun kimiSpawnMode(kind: String?, original: String): String = if (kind == KIMI_CODE_KIND || kind == KIMI_CODE_DESKTOP_KIND) "headless" else original
internal fun RuntimeSummary.withKimiIdentity(): RuntimeSummary {
    val resolved = kimiKind(agentKind, runtimeId)
    return if (agentKind == null && resolved != null) copy(agentKind = resolved) else this
}
internal fun ChatMessage.materializesClientMessage(id: String): Boolean =
    messageId == id || clientMessageId == id || clientMessageIds?.contains(id) == true
