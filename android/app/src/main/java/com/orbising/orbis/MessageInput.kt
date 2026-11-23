package com.orbising.orbis

internal data class FirstSessionSubmission(val commandId: String?)
internal const val MAX_USER_MESSAGE_CHARACTERS = 100_000

internal data class ComputerPathMentionInsertion(val text: String, val caretUtf16: Int)

/** CHAT-PATH-01: a newly typed @ opens the remote file browser and is replaced at its UTF-16 caret. */
internal fun insertedComputerPathTriggerIndex(
    previous: String,
    current: String,
    caretUtf16: Int,
    markedText: Boolean = false,
): Int? {
    if (markedText) return null
    var prefix = 0
    while (prefix < minOf(previous.length, current.length) && previous[prefix] == current[prefix]) prefix++
    var oldEnd = previous.length
    var newEnd = current.length
    while (oldEnd > prefix && newEnd > prefix && previous[oldEnd - 1] == current[newEnd - 1]) {
        oldEnd--
        newEnd--
    }
    return prefix.takeIf { newEnd - prefix == 1 && current[prefix] == '@' && caretUtf16 == prefix + 1 }
}

internal fun insertComputerPathMention(text: String, triggerIndex: Int, path: String): ComputerPathMentionInsertion? {
    if (triggerIndex !in text.indices || text[triggerIndex] != '@') return null
    val prefix = text.substring(0, triggerIndex)
    val suffix = text.substring(triggerIndex + 1)
    val mention = computerPathReferenceText(path)
    val leading = if (prefix.lastOrNull()?.isWhitespace() == false) " " else ""
    val trailing = if (suffix.firstOrNull()?.isWhitespace() == false) " " else if (suffix.isEmpty()) " " else ""
    val inserted = leading + mention + trailing
    return ComputerPathMentionInsertion(prefix + inserted + suffix, triggerIndex + inserted.length)
}

internal fun computerPathReferenceText(path: String): String =
    if (path.any(Char::isWhitespace) || '"' in path) "@\"${path.replace("\"", "\\\"")}\"" else "@$path"

/** Same UTF-16 length limit as the deployed user_message schema. */
internal fun userMessageInputError(text: String): String? = when {
    text.trimStart().startsWith("/") -> L10n.tr("斜杠命令只能从当前会话提供的菜单中选择")
    text.trim().length > MAX_USER_MESSAGE_CHARACTERS -> L10n.tr("消息超过 {0} 个字符，请缩短后重试", MAX_USER_MESSAGE_CHARACTERS)
    else -> null
}
