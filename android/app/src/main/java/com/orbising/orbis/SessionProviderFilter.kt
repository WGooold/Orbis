package com.orbising.orbis

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
    agentKind: String = "codex",
    language: AppLanguage = AppLocalization.language,
    knownProviders: List<String> = emptyList(),
    hasUnknownProvider: Boolean = false,
): List<CodexProviderOption> {
    val rows = tree.flatMap { it.directories }.flatMap { it.sessions }.filter { it.agentKind == agentKind }
    return buildList {
        add(CodexProviderOption(CURRENT_CODEX_PROVIDER, currentProvider?.let { L10n.format("{0}（当前使用）", listOf(it), language) }
            ?: L10n.format("当前 provider（尚未获取）", language = language)))
        add(CodexProviderOption(ALL_CODEX_PROVIDERS, L10n.format("全部 provider", language = language)))
        (rows.mapNotNull { it.modelProvider } + knownProviders).distinct().sorted().filter { it != currentProvider }.forEach {
            add(CodexProviderOption(providerFilterKey(it), it))
        }
        if (hasUnknownProvider || rows.any { it.modelProvider == null }) add(CodexProviderOption(UNKNOWN_CODEX_PROVIDER, L10n.format("未知 provider", language = language)))
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
    return if (provider != current) L10n.tr("此会话属于 {0}，当前使用 {1}。请在设置页切换到 {2}，再打开会话。", provider, current, provider) else null
}

/** A Codex session owned by a provider other than the current one; null when it matches or either is unknown. */
internal fun sessionOtherProvider(row: CachedSessionRow, current: String?): String? {
    if (!row.isCodex || current.isNullOrBlank()) return null
    return row.modelProvider?.takeIf { it.isNotBlank() && it != current }
}
