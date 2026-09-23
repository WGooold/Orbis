package dev.pi.remote

internal enum class ContentPresentation(val startsCollapsed: Boolean) {
    MESSAGE(false),
    THINKING(true),
    TOOL(true),
}

internal fun contentPresentation(role: String, contentType: String): ContentPresentation = when {
    role == "tool" -> ContentPresentation.TOOL
    contentType == "thinking" -> ContentPresentation.THINKING
    contentType == "tool_call" -> ContentPresentation.TOOL
    else -> ContentPresentation.MESSAGE
}

internal fun compactActivitySummary(value: String, maxCharacters: Int = 120): String {
    val compact = value.replace(Regex("\\s+"), " ").trim()
    if (compact.length <= maxCharacters) return compact
    if (maxCharacters <= 1) return "…"
    val candidate = compact.take(maxCharacters - 1)
    val boundary = candidate.lastIndexOf(' ').takeIf { it > 0 } ?: candidate.length
    return candidate.take(boundary).trimEnd() + "…"
}

/**
 * S7 消息形态的列表模型：会话按「轮次」呈现——
 * 用户消息独立成行（平铺气泡，右下收角）；助手消息按真实 turn 分卡片。
 * 没有 turn 计时锚点的旧历史才回退到连续非用户消息合并。
 */
internal sealed interface ChatListItem {
    /** LazyColumn 的稳定 key：取该行首条消息的 messageId。 */
    val key: String

    data class UserMessage(val message: ChatMessage) : ChatListItem {
        override val key: String get() = message.messageId
    }

    data class AssistantTurn(val messages: List<ChatMessage>) : ChatListItem {
        override val key: String get() = messages.first().messageId
    }
}

/**
 * 一张助手卡片要显示的计时。
 *
 * 有 turn 计时锚点时，助手卡片按每个真实 turn 分开；没有 turn 计时的旧历史仍按连续的非用户
 * 消息合并。后者可能让一张旧卡片包含多条计时，所以这里保留累计时长的兼容逻辑。
 */
internal fun groupTurnTiming(timings: List<TurnTiming>): TurnTiming? {
    val first = timings.minByOrNull(TurnTiming::startedAt) ?: return null
    if (timings.any { it.durationMs == null }) return first.copy(durationMs = null)
    val lastEnd = timings.maxOf { it.startedAt + (it.durationMs ?: 0L) }
    return first.copy(durationMs = maxOf(0L, lastEnd - first.startedAt))
}

/**
 * 按用户消息和真实 turn 的完成锚点组织渲染行。turn timing 的 messageId 指向该 turn 最终
 * 产生的消息，因此在这个消息后结束当前助手卡片；同一 turn 内的正文、思考和工具消息仍在
 * 同一张卡片中。没有锚点的旧历史回退到连续非用户消息合并。
 */
internal fun buildChatListItems(
    messages: List<ChatMessage>,
    turnIdsByMessageId: Map<String, String> = emptyMap(),
): List<ChatListItem> {
    val items = mutableListOf<ChatListItem>()
    var assistantMessages = mutableListOf<ChatMessage>()
    var turnBoundaryPending = false

    fun flushAssistantMessages() {
        if (assistantMessages.isNotEmpty()) {
            items += ChatListItem.AssistantTurn(assistantMessages)
            assistantMessages = mutableListOf()
        }
    }

    for (message in messages) {
        if (message.role == "user") {
            flushAssistantMessages()
            items += ChatListItem.UserMessage(message)
            turnBoundaryPending = false
            continue
        }
        // A turn timing points at the assistant message that closes or represents the turn. A
        // following tool result can still belong to that turn, so keep tool rows with it; the
        // next assistant row starts the next card.
        if (turnBoundaryPending && message.role != "tool") flushAssistantMessages()
        assistantMessages += message
        if (turnIdsByMessageId[message.messageId] != null) turnBoundaryPending = true
    }
    flushAssistantMessages()
    return items
}

/**
 * messageId → 该消息所在列表行的下标。滚动锚定（历史翻页/刷新回位）以消息 ID 记忆
 * 视口，恢复时必须换算回「列表行」下标——分组后行数少于消息数。
 */
internal fun chatListItemIndexByMessageId(items: List<ChatListItem>): Map<String, Int> = buildMap {
    items.forEachIndexed { index, item ->
        when (item) {
            is ChatListItem.UserMessage -> put(item.message.messageId, index)
            is ChatListItem.AssistantTurn -> item.messages.forEach { message ->
                put(message.messageId, index)
            }
        }
    }
}

internal data class ConversationPresentation(
    val messages: List<ChatMessage>,
    val toolResults: Map<String, ChatMessage>,
)

internal fun buildConversationPresentation(messages: List<ChatMessage>): ConversationPresentation {
    // LazyColumn keys must identify one stable row. A graph refresh can briefly contain the
    // lifecycle row and its persisted replacement, so keep the latest value at the first ID slot.
    val byId = linkedMapOf<String, ChatMessage>()
    messages.forEach { message -> byId[message.messageId] = message }
    val normalized = byId.values.filter(ChatMessage::hasRenderableContent)
    val toolResults = normalized
        .filter { it.role == "tool" && it.toolCallId != null }
        .associateBy { requireNotNull(it.toolCallId) }
    return ConversationPresentation(
        messages = normalized.filterNot { it.role == "tool" && it.toolCallId in toolResults },
        toolResults = toolResults,
    )
}

private fun ChatMessage.hasRenderableContent(): Boolean = content.any { block ->
    when (block.type) {
        "artifact" -> block.artifact != null
        "tool_call" -> !block.toolCallId.isNullOrBlank() || !block.toolName.isNullOrBlank() ||
            block.arguments != null || !block.text.isNullOrBlank()
        else -> !block.text.isNullOrBlank()
    }
}

/**
 * Tool cards rendered after the conversation are only a live fallback for tool calls the projected
 * messages do not show yet. A finished tool whose call is absent from the rendered messages has
 * nothing left to stand in for, so showing it would pin a stale result card below the chat until an
 * unrelated session/chat snapshot happens to reconcile it.
 */
internal fun orphanToolActivities(
    tools: Collection<ToolActivity>,
    representedToolIds: Set<String>,
): List<ToolActivity> = tools.filterNot { tool ->
    tool.toolCallId in representedToolIds || tool.state == "finished"
}

internal fun shouldFollowLatest(
    initialPositioned: Boolean,
    lastVisibleIndex: Int,
    totalItems: Int,
): Boolean = !initialPositioned || totalItems <= 0 || lastVisibleIndex >= totalItems - 2

internal fun deliveryChoicesVisible(requested: Boolean, runtimeStatus: String?): Boolean =
    requested && runtimeStatus == "running"

/**
 * The composer button shares one slot for three states:
 * - runtime idle (or offline): send
 * - runtime working with an empty input: abort the running turn
 * - runtime working with typed input: send (choosing steer/follow-up)
 */
internal enum class ComposerAction { Send, Abort }

internal fun composerAction(isWorking: Boolean, input: String): ComposerAction =
    if (isWorking && input.isBlank()) ComposerAction.Abort else ComposerAction.Send

private val computerFilePath = Regex(
    """(?:^|[\s（(：\[])([A-Za-z]:[\\/][^\s`<>\"'，。；：！？、]+|/(?:[^\s/`<>\"'，。；：！？、]+/)+[^\s`<>\"'，。；：！？、]+)""",
)

/** Finds unambiguous computer file paths that can be offered as one-tap downloads. */
internal fun detectableFilePaths(text: String): List<String> = computerFilePath.findAll(text)
    .map { match -> match.groupValues[1].trimEnd('.', ',', ';', ':', ')', ']', '}', '。', '，', '；', '：', '）', '】') }
    .filter { it.isNotEmpty() }
    .distinct()
    .toList()
