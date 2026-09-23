package dev.pi.remote

import java.util.Locale
import kotlin.math.roundToInt

/** How full the active context is; drives the color of the composer status strip. */
internal enum class ContextUsageSeverity { Normal, Elevated, Critical }

/**
 * Presentation for the two Runtime facts the UI surfaces: the active model (shown as conversation
 * identity in the top bar) and how much of that model's context window is in use (shown as an
 * ambient fill rail on the composer). Both parts are optional because a Runtime may have no model
 * selected and may not be able to estimate tokens yet.
 */
internal data class ComposerStatus(
    val modelLabel: String?,
    val contextLabel: String?,
    /** Fill ratio for the context bar, or null when the token estimate is unknown. */
    val contextProgress: Float?,
    val severity: ContextUsageSeverity,
) {
    val isEmpty: Boolean get() = modelLabel == null && contextLabel == null
}

private const val ELEVATED_PERCENT = 70.0
private const val CRITICAL_PERCENT = 90.0

internal fun composerStatus(runtime: RuntimeSummary?): ComposerStatus {
    val usage = runtime?.contextUsage
    val percent = usage?.contextPercent()
    return ComposerStatus(
        modelLabel = runtime?.model?.let(::modelLabel)?.takeIf(String::isNotBlank),
        contextLabel = if (percent == null) null else contextLabel(percent, usage),
        contextProgress = percent?.let { (it / 100.0).toFloat().coerceIn(0f, 1f) },
        severity = when {
            percent == null -> ContextUsageSeverity.Normal
            percent >= CRITICAL_PERCENT -> ContextUsageSeverity.Critical
            percent >= ELEVATED_PERCENT -> ContextUsageSeverity.Elevated
            else -> ContextUsageSeverity.Normal
        },
    )
}

/**
 * Reported utilization, or one derived from the token counts when the Runtime only sends those.
 * Returns null while either the window or the used-token estimate is unknown, because a percentage
 * without both is meaningless.
 */
internal fun RuntimeContextUsage.contextPercent(): Double? {
    val window = contextWindow ?: return null
    if (window <= 0) return null
    percent?.let { return it.coerceIn(0.0, 100.0) }
    val used = tokens ?: return null
    return (used.toDouble() / window.toDouble() * 100).coerceIn(0.0, 100.0)
}

private fun contextLabel(percent: Double, usage: RuntimeContextUsage): String {
    val share = formatContextPercent(percent)
    val window = usage.contextWindow
    val used = usage.tokens
    // Percent first: the fill ratio is what the user scans for; token counts are the detail.
    return if (used != null && window != null && window > 0) {
        "$share · ${formatTokenCount(used)}/${formatTokenCount(window)}"
    } else {
        share
    }
}

/** Catalog name when the provider has one; otherwise a prettified rendering of the raw model id. */
internal fun modelLabel(model: RuntimeModelInfo): String =
    model.name?.takeIf(String::isNotBlank) ?: prettyModelId(model.id)

private val MODEL_ACRONYMS = setOf("gpt", "glm", "ai", "llm", "moe", "vlm")
private val MODEL_NAME_FIXES = mapOf(
    "deepseek" to "DeepSeek",
    "chatglm" to "ChatGLM",
    "minimax" to "MiniMax",
    "kimi" to "Kimi",
)

/**
 * Turns raw model ids such as "claude-sonnet-4-5-20250101" or "deepseek-v4.1-flash" into readable
 * labels ("Claude Sonnet 4.5", "DeepSeek V4.1 Flash"): separators become spaces, a trailing build
 * date is dropped, digit runs collapse into a dotted version, and known casing is restored.
 */
internal fun prettyModelId(id: String): String {
    val tokens = id.lowercase(Locale.US).split('-', '_').filter(String::isNotBlank)
    // Drop trailing build noise such as "20250101" or "latest".
    val trimmed = tokens.dropLastWhile { it == "latest" || (it.length == 8 && it.startsWith("20") && it.all(Char::isDigit)) }

    val merged = mutableListOf<String>()
    var index = 0
    while (index < trimmed.size) {
        if (trimmed[index].all(Char::isDigit)) {
            var end = index
            while (end < trimmed.size && trimmed[end].all(Char::isDigit)) end++
            merged.add(trimmed.subList(index, end).joinToString("."))
            index = end
        } else {
            merged.add(trimmed[index])
            index++
        }
    }
    return merged.joinToString(" ") { token ->
        when {
            token in MODEL_NAME_FIXES -> MODEL_NAME_FIXES.getValue(token)
            token in MODEL_ACRONYMS -> token.uppercase(Locale.US)
            token[0].isDigit() ->
                // Parameter sizes like "8b" read better uppercased; versions like "4o" stay as-is.
                if (token.length > 1 && token.last() == 'b' && token.dropLast(1).all(Char::isDigit)) {
                    token.dropLast(1) + "B"
                } else {
                    token
                }
            else -> token.replaceFirstChar { it.uppercase(Locale.US) }
        }
    }
}

internal fun formatContextPercent(percent: Double): String {
    val rounded = percent.roundToInt()
    // A non-zero share that rounds to 0 reads as "no context used", which is misleading.
    return if (rounded == 0 && percent > 0) "<1%" else "$rounded%"
}

internal fun formatTokenCount(tokens: Long): String {
    val value = tokens.coerceAtLeast(0)
    return when {
        value < 1_000 -> value.toString()
        value < 100_000 -> String.format(Locale.US, "%.1fk", value / 1_000.0)
        value < 1_000_000 -> "${value / 1_000}k"
        else -> String.format(Locale.US, "%.1fM", value / 1_000_000.0)
    }
}
