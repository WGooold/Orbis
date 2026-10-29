package com.orbising.orbis

private const val SESSION_FALLBACK_NAME_MAX_LENGTH = 40
private val sessionFallbackWhitespace = Regex("\\s+")

internal fun RemoteState.runtimeDisplayName(runtime: RuntimeSummary): String =
    sessionDisplayName(runtime.sessionId, runtime)

/** Shared by runtime cards, the session drawer, chat headers and offline history. */
internal fun RemoteState.sessionDisplayName(
    sessionId: String?,
    runtime: RuntimeSummary? = runtimes.values.firstOrNull { sessionId != null && it.sessionId == sessionId },
): String {
    val session = sessions[sessionId]
    return runtime?.sessionName?.trim()?.takeIf(String::isNotEmpty)
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
