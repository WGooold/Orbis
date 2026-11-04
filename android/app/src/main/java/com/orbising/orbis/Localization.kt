package com.orbising.orbis

import android.content.Context
import android.content.res.Resources
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale

internal enum class AppLanguage(val key: String) {
    System("system"), Chinese("zh-Hans"), English("en");

    fun resolved(preferredLanguages: List<String>): AppLanguage {
        if (this != System) return this
        for (identifier in preferredLanguages) {
            when (identifier.replace('_', '-').substringBefore('-').lowercase(Locale.ROOT)) {
                "zh" -> return Chinese
                "en" -> return English
            }
        }
        return English
    }

    companion object {
        fun preference(key: String?): AppLanguage = entries.firstOrNull { it.key == key } ?: System
    }
}

/** Snapshot reads invalidate text users, without recreating the Activity, navigation or connections. */
internal object AppLocalization {
    const val PREFERENCES = "orbis-language"
    const val PREFERENCE_KEY = "language"
    var preference by mutableStateOf(AppLanguage.System)
        private set
    // Core/test rendering stays deterministic until the application supplies device preferences.
    var language by mutableStateOf(AppLanguage.Chinese)
        private set
    private var preferences: android.content.SharedPreferences? = null
    private var systemLanguages: () -> List<String> = {
        val locales = Resources.getSystem().configuration.locales
        (0 until locales.size()).map { locales[it].toLanguageTag() }
    }
    val locale: Locale get() = if (language == AppLanguage.Chinese) Locale.SIMPLIFIED_CHINESE else Locale.ENGLISH

    fun configure(context: Context) {
        preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        preference = AppLanguage.preference(preferences?.getString(PREFERENCE_KEY, null))
        refreshSystemLanguage()
    }

    fun select(choice: AppLanguage) {
        preference = choice
        preferences?.edit()?.putString(PREFERENCE_KEY, choice.key)?.apply()
        refreshSystemLanguage()
    }

    fun refreshSystemLanguage() { language = preference.resolved(systemLanguages()) }
}

@PublishedApi
internal object L10n {
    val locale: Locale get() = AppLocalization.locale
    private val placeholder = Regex("\\{([0-9]+)\\}")
    private val hostSourcesByEnglish = LocalizationCatalog.hostExact.sorted().associateBy { LocalizationCatalog.english.getValue(it) }
    private val hostPatterns = LocalizationCatalog.hostTemplates.flatMap { source ->
        listOf(source, LocalizationCatalog.english.getValue(source)).map { template ->
            val parts = template.split("{0}")
            Triple(source, parts[0], parts[1])
        }
    }

    // Restricted to Host-owned UI fields; unknown text and captured values remain opaque.
    fun hostText(value: String, language: AppLanguage = AppLocalization.language): String {
        fun line(value: String): String? {
            if (value in LocalizationCatalog.hostExact) return format(value, language = language)
            hostSourcesByEnglish[value]?.let {
                return format(it, language = language)
            }
            for ((source, prefix, suffix) in hostPatterns) {
                if (value.startsWith(prefix) && value.endsWith(suffix) && value.length >= prefix.length + suffix.length) {
                    val argument = value.substring(prefix.length, value.length - suffix.length)
                    return format(source, listOf(argument), language)
                }
            }
            return null
        }
        return line(value) ?: value.split('\n').joinToString("\n") { line(it) ?: it }
    }

    fun hostSummary(value: String, language: AppLanguage = AppLocalization.language): String =
        value.split(" · ").joinToString(" · ") { hostText(it, language) }

    @PublishedApi
    internal fun tr(source: String, vararg arguments: Any?): String =
        format(source, arguments.map { it.toString() }, AppLocalization.language)

    // Legacy stored notices may have been created before the user changed language.
    fun matches(value: String?, source: String): Boolean =
        value != null && (value == source || value == LocalizationCatalog.english[source])

    fun hasPrefix(value: String?, source: String): Boolean = value != null &&
        (value.startsWith(source) || LocalizationCatalog.english[source]?.let(value::startsWith) == true)

    fun format(source: String, arguments: List<String> = emptyList(), language: AppLanguage): String {
        val template = if (language == AppLanguage.English) {
            if (arguments.firstOrNull()?.toDoubleOrNull() == 1.0)
                LocalizationCatalog.singular[source] ?: LocalizationCatalog.english[source] ?: source
            else LocalizationCatalog.english[source] ?: source
        } else source
        if (arguments.isEmpty()) return template
        // Never look up dynamic content or interpret placeholders introduced by an argument.
        return placeholder.replace(template) { match ->
            match.groupValues[1].toIntOrNull()?.let { arguments.getOrNull(it) } ?: match.value
        }
    }
}
