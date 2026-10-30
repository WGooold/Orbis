package com.orbising.orbis

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

data class AgentProvider(val id: String, val kind: String, val name: String, val enabled: Boolean, val additive: Boolean, val globalDefault: Boolean = false, val subscriptionSupported: Boolean = false) {
    val removable: Boolean get() = kind == "pi" && enabled && additive
}
data class AgentProvidersState(
    val kind: String = "codex",
    val hostId: String? = null,
    val requestId: String? = null,
    val providers: List<AgentProvider> = emptyList(),
    val loading: Boolean = false,
    val notice: String? = null,
    val error: String? = null,
    val pendingRemovals: List<AgentProvider> = emptyList(),
    val removalCount: Int = 0,
    val quotaRequestId: String? = null,
    val quotaProviderId: String? = null,
    val quota: SubscriptionQuota? = null,
    val quotaError: String? = null,
)

data class SubscriptionWindow(val name: String, val remainingPercent: Double?, val resetsAt: Long?)
data class SubscriptionQuota(val checkedAt: Long, val windows: List<SubscriptionWindow>)

internal fun parseSubscriptionQuota(value: JsonObject): SubscriptionQuota? {
    val checkedAt = (value["checkedAt"] as? JsonPrimitive)?.longOrNull?.takeIf { it >= 0 } ?: return null
    val rows = value["windows"] as? JsonArray ?: return null
    if (rows.size != 2) return null
    val windows = rows.map { item ->
        val row = item as? JsonObject ?: return null
        val name = (row["name"] as? JsonPrimitive)?.contentOrNull ?: return null
        val remaining = if (row["remainingPercent"] == JsonNull) null else
            (row["remainingPercent"] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() && it in 0.0..100.0 } ?: return null
        val resetsAt = if (row["resetsAt"] == JsonNull) null else
            (row["resetsAt"] as? JsonPrimitive)?.longOrNull?.takeIf { it >= 0 } ?: return null
        SubscriptionWindow(name, remaining, resetsAt)
    }
    if (windows.map { it.name }.toSet() != setOf("five_hour", "seven_day")) return null
    return SubscriptionQuota(checkedAt, windows)
}

internal fun RemoteState.withSubscriptionResult(message: JsonObject): RemoteState {
    val current = agentProviders
    val request = message["requestId"]?.jsonPrimitive?.contentOrNull ?: return this
    val id = message["id"]?.jsonPrimitive?.contentOrNull ?: return this
    if (request != current.quotaRequestId || id != current.quotaProviderId || current.hostId != hostId ||
        message["kind"]?.jsonPrimitive?.contentOrNull != current.kind ||
        current.providers.none { it.id == id && it.enabled && it.subscriptionSupported }) return this
    val failure = message["error"]?.jsonPrimitive?.contentOrNull
    val quota = (message["quota"] as? JsonObject)?.let(::parseSubscriptionQuota)
    return copy(agentProviders = current.copy(quotaRequestId = null, quota = if (failure == null) quota else null,
        quotaError = failure ?: if (quota == null) "配额数据格式无法识别，请升级 Host 后重试" else null))
}

internal fun AgentProvidersState.stopOperation(error: String): AgentProvidersState = copy(
    requestId = null, loading = false, pendingRemovals = emptyList(), removalCount = 0,
    error = if (removalCount > 0) "批量移除已停止：$error" else error,
)

internal fun AgentProvidersState.canRemove(providers: List<AgentProvider>, expectedHostId: String?): Boolean =
    expectedHostId != null && hostId == expectedHostId && !loading && error == null &&
        providers.isNotEmpty() && providers.map { it.id }.distinct().size == providers.size &&
        providers.all { it.removable && it.kind == kind && it in this.providers }

internal fun RemoteState.withProviderResult(message: JsonObject): RemoteState {
    val request = message["requestId"]?.jsonPrimitive?.contentOrNull
    val kind = message["kind"]?.jsonPrimitive?.contentOrNull
    val current = agentProviders
    if (request == null || request != current.requestId || kind != current.kind || current.hostId != hostId) return this
    val failure = message["error"]?.jsonPrimitive?.contentOrNull
    if (failure != null) return copy(agentProviders = current.stopOperation(failure))
    val remaining = current.pendingRemovals.drop(1)
    val notice = message["notice"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
    return copy(agentProviders = current.copy(requestId = null, loading = remaining.isNotEmpty(), pendingRemovals = remaining,
        error = null, notice = if (current.removalCount > 0 && remaining.isEmpty())
            "已移除 ${current.removalCount} 个供应商。" + notice.orEmpty() else notice,
        removalCount = if (remaining.isEmpty()) 0 else current.removalCount))
}
