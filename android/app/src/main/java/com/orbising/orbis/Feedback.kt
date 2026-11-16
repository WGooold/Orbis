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
    fun clearScope() = FeedbackState(foreground = foreground)
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
internal fun RemoteState.downloadFailure(commandId: String?, message: String): RemoteState {
    val task = commandId?.let(pendingDownloads::get)?.taskId?.let(downloads::get) ?: return this
    return copy(downloads = downloads + (task.taskId to task.copy(status = "failed", commandId = null, error = message)),
        pendingDownloads = pendingDownloads - commandId)
}

internal fun RemoteState.sessionFailure(objectId: String, message: String): RemoteState =
    copy(sessionOperationErrors = sessionOperationErrors + (objectId to message))

/** Native details are diagnostic-only when they contain opaque codes or internal transport names. */
internal fun feedbackFailureText(value: String?, fallback: String): String {
    val text = value?.trim()?.takeIf(String::isNotEmpty) ?: return fallback
    if (Regex("[a-z]+_[a-z_]+|\\b(?:runtime|Host|relay|protocol)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)) return fallback
    return text
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
