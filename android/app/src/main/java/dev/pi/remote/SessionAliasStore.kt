package dev.pi.remote

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

internal const val SESSION_ALIAS_MAX_LENGTH = 40
internal const val SESSION_FALLBACK_NAME_MAX_LENGTH = 40
private const val SESSION_ALIAS_PREFERENCES = "pi_remote_session_aliases"
private const val SESSION_ALIAS_ENTRIES = "entries"
private val sessionFallbackWhitespace = Regex("\\s+")

data class SessionAliasIdentity(
    val runtimeId: String,
    val sessionId: String?,
)

@Serializable
internal data class StoredSessionAlias(
    val relayUrl: String,
    val deviceId: String,
    val runtimeId: String,
    val sessionId: String?,
    val alias: String,
)

internal fun RuntimeSummary.sessionAliasIdentity(): SessionAliasIdentity = SessionAliasIdentity(
    runtimeId = runtimeId,
    sessionId = sessionId,
)

internal fun RemoteState.runtimeDisplayName(runtime: RuntimeSummary): String =
    sessionDisplayName(runtime.sessionId, runtime)

/** Shared by runtime cards, the session drawer, chat headers and offline history. */
internal fun RemoteState.sessionDisplayName(
    sessionId: String?,
    runtime: RuntimeSummary? = runtimes.values.firstOrNull { sessionId != null && it.sessionId == sessionId },
): String {
    val session = sessions[sessionId]
    val alias = if (runtime != null) {
        sessionAliases[runtime.sessionAliasIdentity()]
    } else {
        // Offline history has no Runtime; retain the last saved alias for this Session.
        sessionAliases.entries.lastOrNull { sessionId != null && it.key.sessionId == sessionId }?.value
    }
    return alias?.trim()?.takeIf(String::isNotEmpty)
        ?: runtime?.sessionName?.trim()?.takeIf(String::isNotEmpty)
        ?: session?.name?.trim()?.takeIf(String::isNotEmpty)
        ?: sessionGraphs[sessionId]?.firstUserMessageTitle()
        ?: session?.firstMessage?.let(::sessionMessagePreview)
        ?: runtime?.let { firstUserMessageTitle(conversations[it.runtimeId]?.messages.orEmpty()) }
        ?: sessionId?.trim()?.takeIf(String::isNotEmpty)
        ?: runtime?.runtimeId
        ?: "Session 已离线"
}

internal fun RuntimeSummary.runtimeDisplayPath(): String {
    // Older Relay versions strip the hostname field, in which case only the directory is known.
    val host = hostname?.trim()?.takeIf(String::isNotEmpty) ?: return cwd
    return "$host-$cwd"
}

internal fun firstUserMessageTitle(messages: List<ChatMessage>): String? =
    messages.asSequence()
        .filter { it.role == "user" }
        .flatMap { message -> message.content.asSequence() }
        .filter { content -> content.type == "text" }
        .mapNotNull(RemoteContent::text)
        .mapNotNull(::sessionMessagePreview)
        .firstOrNull()

private fun sessionMessagePreview(value: String): String? {
    val text = value.trim().takeIf(String::isNotEmpty) ?: return null
    val firstSentence = text.split(Regex("(?<=[。！？.!?])|\\r?\\n"), limit = 2)
        .first()
        .replace(sessionFallbackWhitespace, " ")
        .trim()
    if (firstSentence.length <= SESSION_FALLBACK_NAME_MAX_LENGTH) return firstSentence
    return firstSentence.take(SESSION_FALLBACK_NAME_MAX_LENGTH - 1).trimEnd() + "…"
}

internal fun normalizeSessionAlias(value: String): String? {
    val normalized = buildString {
        var previousWasWhitespace = false
        for (character in value.trim()) {
            when {
                character.isWhitespace() -> {
                    if (!previousWasWhitespace) append(' ')
                    previousWasWhitespace = true
                }
                character.isISOControl() -> Unit
                else -> {
                    append(character)
                    previousWasWhitespace = false
                }
            }
        }
    }.take(SESSION_ALIAS_MAX_LENGTH).trimEnd()
    return normalized.takeIf(String::isNotBlank)
}

internal fun updateStoredSessionAliases(
    entries: List<StoredSessionAlias>,
    device: DeviceCredential,
    runtime: RuntimeSummary,
    value: String,
): List<StoredSessionAlias> {
    val remaining = entries.filterNot { entry ->
        entry.relayUrl == device.relayUrl &&
            entry.deviceId == device.deviceId &&
            entry.runtimeId == runtime.runtimeId &&
            entry.sessionId == runtime.sessionId
    }
    val alias = normalizeSessionAlias(value) ?: return remaining
    return remaining + StoredSessionAlias(
        relayUrl = device.relayUrl,
        deviceId = device.deviceId,
        runtimeId = runtime.runtimeId,
        sessionId = runtime.sessionId,
        alias = alias,
    )
}

internal fun storedSessionAliasesFor(
    entries: List<StoredSessionAlias>,
    device: DeviceCredential,
): Map<SessionAliasIdentity, String> = entries.asSequence()
    .filter { it.relayUrl == device.relayUrl && it.deviceId == device.deviceId }
    .mapNotNull { entry ->
        normalizeSessionAlias(entry.alias)?.let { alias ->
            SessionAliasIdentity(entry.runtimeId, entry.sessionId) to alias
        }
    }
    .toMap()

class SessionAliasStore(
    context: Context,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    private val preferences = context.applicationContext.getSharedPreferences(
        SESSION_ALIAS_PREFERENCES,
        Context.MODE_PRIVATE,
    )

    @Synchronized
    fun load(device: DeviceCredential): Map<SessionAliasIdentity, String> =
        storedSessionAliasesFor(readEntries(), device)

    @Synchronized
    fun save(device: DeviceCredential, runtime: RuntimeSummary, value: String) {
        writeEntries(updateStoredSessionAliases(readEntries(), device, runtime, value))
    }

    @Synchronized
    fun clear(device: DeviceCredential) {
        writeEntries(readEntries().filterNot {
            it.relayUrl == device.relayUrl && it.deviceId == device.deviceId
        })
    }

    private fun readEntries(): List<StoredSessionAlias> = preferences.getString(SESSION_ALIAS_ENTRIES, null)
        ?.let { encoded -> runCatching { json.decodeFromString<List<StoredSessionAlias>>(encoded) }.getOrNull() }
        .orEmpty()

    private fun writeEntries(entries: List<StoredSessionAlias>) {
        val editor = preferences.edit()
        if (entries.isEmpty()) {
            editor.remove(SESSION_ALIAS_ENTRIES)
        } else {
            editor.putString(SESSION_ALIAS_ENTRIES, json.encodeToString(entries))
        }
        editor.apply()
    }
}
