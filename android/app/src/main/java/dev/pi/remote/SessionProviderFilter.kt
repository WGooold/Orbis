package dev.pi.remote

internal const val CURRENT_CODEX_PROVIDER = "current"
internal const val ALL_CODEX_PROVIDERS = "all"
internal const val UNKNOWN_CODEX_PROVIDER = "unknown"

internal fun providerFilterKey(provider: String): String = "provider:$provider"

internal val CachedSessionRow.modelProvider: String?
    get() = catalogEntry?.modelProvider?.takeIf(String::isNotBlank)

internal data class CodexProviderOption(val key: String, val label: String)

internal fun codexProviderOptions(
    tree: List<CachedHostGroup>,
    currentProvider: String?,
): List<CodexProviderOption> {
    val rows = tree.flatMap { it.directories }.flatMap { it.sessions }.filter { it.isCodex }
    return buildList {
        add(CodexProviderOption(CURRENT_CODEX_PROVIDER, currentProvider?.let { "$it（当前使用）" } ?: "当前 provider（尚未获取）"))
        add(CodexProviderOption(ALL_CODEX_PROVIDERS, "全部 provider"))
        rows.mapNotNull { it.modelProvider }.distinct().sorted().filter { it != currentProvider }.forEach {
            add(CodexProviderOption(providerFilterKey(it), it))
        }
        if (rows.any { it.modelProvider == null }) add(CodexProviderOption(UNKNOWN_CODEX_PROVIDER, "未知 provider"))
    }
}

internal fun matchesCodexProvider(row: CachedSessionRow, filterKey: String, currentProvider: String?): Boolean =
    when (filterKey) {
        ALL_CODEX_PROVIDERS -> true
        CURRENT_CODEX_PROVIDER -> currentProvider != null && row.modelProvider == currentProvider
        UNKNOWN_CODEX_PROVIDER -> row.modelProvider == null
        else -> filterKey.startsWith("provider:") && row.modelProvider == filterKey.removePrefix("provider:")
    }

internal fun RemoteState.codexProviderMismatch(sessionId: String): String? {
    val session = sessions[sessionId] ?: return null
    if (session.agentKind != "codex") return null
    val provider = session.modelProvider?.takeIf(String::isNotBlank) ?: return null
    val current = currentProviders["codex"] ?: return null
    return if (provider != current) "此会话属于 $provider，当前使用 $current。请先在电脑端切换到 $provider，再打开会话。" else null
}
