package com.orbising.orbis

/** SC92–SC94: local feedback has one owner and one declared presentation level (design system §8). */
enum class FeedbackLevel { F0, F1, F2, F3, F4, F5 }
enum class FeedbackCondition(val priority: Int) { PAIRING(0), VERSION(1), COMPUTER_UNAVAILABLE(2), OTHER(3) }
enum class FeedbackAction { REPAIR, SETTINGS, RECHECK, UNDO }
data class AppFeedback(
    val key: String,
    val message: String,
    val level: FeedbackLevel,
    val condition: FeedbackCondition? = null,
    val action: FeedbackAction? = null,
    val id: String = java.util.UUID.randomUUID().toString(),
)
data class FeedbackState(
    val conditions: Map<String, AppFeedback> = emptyMap(),
    val dismissed: Set<String> = emptySet(),
    val toast: AppFeedback? = null,
    val shownToastKeys: List<String> = emptyList(),
    val foreground: Boolean = false,
    val taskFailureSequence: Long = 0,
) {
    val banner: AppFeedback? get() = conditions.values.filter { it.key !in dismissed }
        .minByOrNull { it.condition?.priority ?: Int.MAX_VALUE }
    fun present(notice: AppFeedback): FeedbackState = when (notice.level) {
        FeedbackLevel.F3 -> if (notice.key in shownToastKeys) this else {
            val consumed = copy(shownToastKeys = (shownToastKeys + notice.key).takeLast(128))
            if (foreground) consumed.copy(toast = notice) else consumed
        }
        FeedbackLevel.F4 -> {
            require(notice.condition != null && notice.action != null)
            val previous = conditions[notice.key]
            if (previous?.message == notice.message && previous.condition == notice.condition && previous.action == notice.action) this
            else copy(conditions = conditions + (notice.key to notice))
        }
        else -> error("Scoped feedback must be stored on its object or connection")
    }
    fun dismissBanner(key: String) = if (key in conditions) copy(dismissed = dismissed + key) else this
    fun resolve(key: String) = copy(conditions = conditions - key, dismissed = dismissed - key)
    fun dismissToast(id: String) = if (toast?.id == id) copy(toast = null) else this
    fun visible(value: Boolean) = if (value) copy(foreground = true) else copy(foreground = false, toast = null)
    fun clearScope(preservingConnectionConditions: Boolean = false) =
        if (preservingConnectionConditions) copy(toast = null) else FeedbackState(foreground = foreground)
}

internal fun RemoteState.presentFeedback(level: FeedbackLevel, message: String, key: String,
    condition: FeedbackCondition? = null, action: FeedbackAction? = null): RemoteState =
    copy(feedback = feedback.present(AppFeedback(key, message, level, condition, action)))
internal fun RemoteState.connectionFailure(level: FeedbackLevel, message: String, condition: FeedbackCondition): RemoteState =
    presentFeedback(level, message, condition.name, condition,
        if (condition == FeedbackCondition.PAIRING) FeedbackAction.REPAIR else if (condition == FeedbackCondition.COMPUTER_UNAVAILABLE) FeedbackAction.RECHECK else FeedbackAction.SETTINGS)
internal fun RemoteState.conversationFailure(runtimeId: String?, message: String): RemoteState {
    if (runtimeId == null) return copy(sessionListError = message)
    val conversation = conversations[runtimeId] ?: RuntimeConversation()
    return copy(conversations = conversations + (runtimeId to conversation.copy(operationError = message.takeIf(String::isNotBlank))),
        sessionOperationErrors = if (message.isBlank()) sessionOperationErrors - runtimeId else sessionOperationErrors + (runtimeId to message))
}
/** Draft and composer failures stay on their input surface; session cards retain their own operation result. */
internal fun RemoteState.composerFailure(runtimeId: String?, message: String): RemoteState {
    if (runtimeId == null) return copy(sessionConfiguration = sessionConfiguration.copy(launchError = message.takeIf(String::isNotBlank), waitingForLaunchJournal = false))
    val conversation = conversations[runtimeId] ?: RuntimeConversation()
    return copy(conversations = conversations + (runtimeId to conversation.copy(operationError = message.takeIf(String::isNotBlank))))
}

internal fun connectionRejectionStopsReconnect(code: String?): Boolean =
    code in CONNECTION_FATAL_PROTOCOL_CODES || code == "device_mismatch"

internal fun feedbackActionText(action: FeedbackAction, condition: FeedbackCondition?): String = when (action) {
    FeedbackAction.REPAIR -> L10n.tr("重新配对")
    FeedbackAction.SETTINGS -> if (condition == FeedbackCondition.VERSION) L10n.tr("检查更新") else L10n.tr("设置")
    FeedbackAction.RECHECK -> L10n.tr("重新连接")
    FeedbackAction.UNDO -> L10n.tr("撤销")
}
internal fun RemoteState.downloadFailure(commandId: String?, message: String): RemoteState {
    val task = commandId?.let(pendingDownloads::get)?.taskId?.let(downloads::get) ?: return this
    return copy(downloads = downloads + (task.taskId to task.copy(status = "failed", commandId = null, error = message)),
        pendingDownloads = pendingDownloads - commandId)
}

internal fun RemoteState.sessionFailure(objectId: String, message: String): RemoteState =
    copy(sessionOperationErrors = sessionOperationErrors + (objectId to message))

private val opaqueFeedbackCodes = CONNECTION_ACTION_PROTOCOL_CODES + setOf(
    "host_busy", "command_id_conflict", "message_id_conflict", "invalid_command", "invalid_request", "runtime_offline",
    "device_offline", "unsupported_command", "agent_unsupported", "spawn_failed", "spawn_limit_reached", "cwd_missing",
    "session_not_found", "session_request_failed", "catalog_page_too_large", "model_subscription_limit", "provider_switching",
    "interaction_not_available", "slash_commands_not_available", "slash_command_not_available", "slash_command_argument_required",
    "slash_command_arguments_not_allowed", "slash_command_argument_not_available", "slash_command_cancelled", "not_cancelable",
    "already_delivered", "runtime_busy", "model_not_available", "thinking_level_not_available", "session_not_available",
    "assistant_message_not_available", "file_not_available", "file_not_a_file", "file_size_invalid", "artifact_changed",
    "artifact_chunk_invalid", "artifact_size_mismatch",
)
private val registeredFeedbackCode = opaqueFeedbackCodes.joinToString("|") { Regex.escape(it) }
// SC103: unregistered codes are lower-case snake tokens; upper-case names such as environment variables are user-facing.
private const val unregisteredFeedbackCode = "(?-i:[a-z][a-z0-9]*(?:_[a-z0-9]+)+)"
private val opaqueFeedbackCode = "(?:$registeredFeedbackCode|$unregisteredFeedbackCode)"
// A dot is part of a name only before an extension; sentence punctuation still ends the code.
private val opaqueFeedbackToken = Regex(
    "(?<![A-Za-z0-9/._\\\\-])" + opaqueFeedbackCode + "(?![A-Za-z0-9/_\\\\-]|\\.[A-Za-z0-9])",
    RegexOption.IGNORE_CASE,
)
private val opaqueFeedbackAnnotation = Regex(
    "[（(]\\s*" + opaqueFeedbackCode + "\\s*[）)]",
    RegexOption.IGNORE_CASE,
)

/** SC101: machine-code tokens are diagnostic-only; paths, filenames and readable transport reasons remain intact. */
internal fun feedbackFailureText(value: String?, fallback: String): String {
    val text = value?.trim()?.takeIf(String::isNotEmpty) ?: return fallback
    if (text.lowercase(java.util.Locale.ROOT) in opaqueFeedbackCodes) return fallback
    val display = opaqueFeedbackAnnotation.replace(text, "").trim()
    if (display.isEmpty() || opaqueFeedbackToken.containsMatchIn(display)) return fallback
    return display
}

/** SC94: transfers keep F1 on their row; only leaving that row adds one F3 per failed attempt. */
internal data class TransferFeedbackScope(val downloadsVisible: Boolean = false, val uploadIds: Set<String> = emptySet())
internal fun RemoteState.withTransferFailureFeedback(previous: RemoteState, scope: TransferFeedbackScope): RemoteState {
    if (downloads === previous.downloads && uploads === previous.uploads) return this
    var next = feedback
    fun failed(key: String, message: String, visible: Boolean) {
        val sequence = next.taskFailureSequence + 1
        next = next.copy(taskFailureSequence = sequence)
        if (!visible) next = next.present(AppFeedback("transfer:$key:$sequence", message, FeedbackLevel.F3))
    }
    if (downloads !== previous.downloads) for ((id, task) in downloads) {
        val old = previous.downloads[id] ?: continue // Restored failures are already recorded in F1.
        if (task.status == "failed" && old.status != "failed")
            failed("download:$id", L10n.tr("下载未完成，请在下载中重试"), scope.downloadsVisible)
    }
    if (uploads !== previous.uploads) for ((id, task) in uploads) {
        val old = previous.uploads[id] ?: continue
        if (task.status == "failed" && old.status != "failed")
            failed("upload:$id", L10n.tr("上传未完成，附件已保留"), id in scope.uploadIds)
    }
    return if (next === feedback) this else copy(feedback = next)
}
