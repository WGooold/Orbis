package com.orbising.orbis

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** Public Host backends projection. A missing row means the Host has not advertised OpenCode. */
data class OpenCodeAvailability(val ready: Boolean, val reason: String?) {
    internal fun message(): String? = if (ready) null else when (reason) {
        "service_not_found" -> L10n.tr("OpenCode 共享服务未运行。请在电脑上启动 OpenCode。")
        "unsupported_version" -> L10n.tr("OpenCode 版本不兼容。请在电脑上使用 Host 支持的版本。")
        "invalid_endpoint" -> L10n.tr("OpenCode 服务注册地址无效。请检查电脑上的 OpenCode 服务配置。")
        "connection_failed" -> L10n.tr("Host 无法连接 OpenCode 共享服务。请检查电脑上的服务状态和认证配置。")
        "event_stream_unavailable" -> L10n.tr("OpenCode 实时连接未就绪。请稍后再试。")
        else -> L10n.tr("OpenCode 当前不可用。请检查电脑上的服务状态。")
    }
}

internal fun OpenCodeAvailability?.draftNotice(selectedKind: String): String? =
    if (selectedKind == "opencode") this?.message() else null

internal data class DraftAgentReconciliation(
    val kind: String,
    val allowUnavailableOpenCode: Boolean,
)

internal fun reconcileDraftAgent(
    current: String,
    supported: Set<String>?,
    kinds: List<String>,
    canChooseOpenCode: Boolean,
    allowUnavailableOpenCode: Boolean,
    preferLaunchable: Boolean,
): DraftAgentReconciliation {
    val usable = if (current == "opencode") canChooseOpenCode else (supported == null || current in supported)
    if (usable && agentFamily(current) in kinds) {
        return DraftAgentReconciliation(current, allowUnavailableOpenCode = current == "opencode")
    }
    if (!preferLaunchable && allowUnavailableOpenCode && current == "opencode" && "opencode" in kinds) {
        return DraftAgentReconciliation("opencode", allowUnavailableOpenCode = true)
    }
    if (supported != null) {
        val fallback = listOf("codex", "codexDesktop", "claude", "dsh", "dshDesktop", "pi", "openclaw", KIMI_CODE_KIND, "hermes", "opencode")
            .firstOrNull { it in supported && agentFamily(it) in kinds && (it != "opencode" || canChooseOpenCode) }
            ?: "opencode".takeIf { "opencode" in kinds }
        if (fallback != null) {
            return DraftAgentReconciliation(fallback, allowUnavailableOpenCode = fallback == "opencode")
        }
    } else if (current == "opencode" && !canChooseOpenCode) {
        val fallback = listOf("codex", "codexDesktop", "claude", "dsh", "dshDesktop", "pi", "openclaw", KIMI_CODE_KIND, "hermes")
            .firstOrNull { agentFamily(it) in kinds }
        if (fallback != null) {
            return DraftAgentReconciliation(fallback, allowUnavailableOpenCode = false)
        }
    }
    return DraftAgentReconciliation(current, allowUnavailableOpenCode = current == "opencode" && "opencode" in kinds)
}

internal fun openCodeAvailability(backends: JsonObject): OpenCodeAvailability? {
    val row = (backends["backends"] as? JsonArray)?.filterIsInstance<JsonObject>()
        ?.firstOrNull { it.text("kind") == "opencode" } ?: return null
    val ready = (row["ready"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: return null
    return OpenCodeAvailability(ready, row.text("reason"))
}

private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
