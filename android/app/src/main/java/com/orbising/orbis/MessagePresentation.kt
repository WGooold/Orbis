package com.orbising.orbis

internal enum class ContentPresentation(val startsCollapsed: Boolean) {
    MESSAGE(false),
    THINKING(true),
    TOOL(true),
}

internal const val CHAT_CARD_PROSE_LIMIT = 4
internal const val CHAT_TOOL_PAGE_SIZE = 8

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
 * S31: cards follow visible reasoning/text/tool steps on every backend. Native turns
 * remain timing/execution facts and never decide the visual grouping.
 */
internal sealed interface ChatListItem {
    /** Stable local card identity; tool-only cards use the native tool identity. */
    val key: String

    data class UserMessage(val message: ChatMessage) : ChatListItem {
        override val key: String get() = message.messageId
    }

    data class AssistantTurn(
        val messages: List<ChatMessage>,
        val copyMessages: List<ChatMessage> = messages,
        override val key: String = messages.first().messageId,
        /** Only the last fragment owns source timing and file-change anchors. */
        val completedMessageIds: Set<String> = messages.mapTo(linkedSetOf()) { it.messageId },
    ) : ChatListItem
}

/** Tool groups page locally; storage message batching must not create extra card frames. */
@Suppress("UNUSED_PARAMETER")
internal fun chatViewportItems(items: List<ChatListItem>, previous: List<ChatListItem> = emptyList()): List<ChatListItem> = items

/**
 * Timings describe the native work ending in this card, independently of visual boundaries.
 * If several native turns end here, the interval spans all of them and remains live until all finish.
 */
internal fun groupTurnTiming(timings: List<TurnTiming>): TurnTiming? {
    val first = timings.minByOrNull(TurnTiming::startedAt) ?: return null
    if (timings.any { it.durationMs == null }) return first.copy(durationMs = null)
    val lastEnd = timings.maxOf { it.startedAt + (it.durationMs ?: 0L) }
    return first.copy(durationMs = maxOf(0L, lastEnd - first.startedAt))
}

/**
 * A step contains reasoning, text, then tools. New reasoning/text after tools starts
 * the next card, including when both steps were packed into one native message.
 * Source message IDs/content stay intact outside this local projection.
 */
@Suppress("UNUSED_PARAMETER")
internal fun buildChatListItems(
    messages: List<ChatMessage>,
    turnIdsByMessageId: Map<String, String> = emptyMap(),
    /**
     * 上一次的列表行（ADR-0039 §5）：内容相同的行必须复用**同一个对象**，否则每次 patch 都会
     * 让 Compose 认为所有行都变了，重新测量/重组整段会话。
     *
     * 判定只看对象身份：消息是不可变数据类，内容变化必定产生新对象。
     */
    previous: List<ChatListItem> = emptyList(),
): List<ChatListItem> {
    val items = mutableListOf<ChatListItem>()
    var assistantMessages = mutableListOf<ChatMessage>()
    var hasTools = false
    var hasText = false
    var proseCount = 0
    var cardKey: String? = null
    val completed = linkedSetOf<String>()
    val reusableUsers = previous.filterIsInstance<ChatListItem.UserMessage>().associateBy { it.message.messageId }
    val reusableTurns = previous.filterIsInstance<ChatListItem.AssistantTurn>().groupBy { it.key }

    fun flushAssistantMessages() {
        if (assistantMessages.isNotEmpty()) {
            val key = requireNotNull(cardKey)
            val reused = reusableTurns[key]?.firstOrNull { turn ->
                turn.completedMessageIds == completed &&
                turn.messages.size == assistantMessages.size &&
                    turn.messages.indices.all { turn.messages[it] === assistantMessages[it] || turn.messages[it] == assistantMessages[it] }
            }
            items += reused ?: ChatListItem.AssistantTurn(assistantMessages.toList(), key = key, completedMessageIds = completed.toSet())
            assistantMessages = mutableListOf()
        }
        completed.clear(); cardKey = null; hasTools = false; hasText = false; proseCount = 0
    }

    fun partKey(message: ChatMessage, start: Int): String {
        val tool = message.content.getOrNull(start)?.toolCallId
        return if (tool != null) "tool-card:$tool" else if (start == 0) message.messageId else "${message.messageId}:card:$start"
    }

    fun append(message: ChatMessage, start: Int, end: Int) {
        if (start == end && message.content.isNotEmpty()) return
        if (cardKey == null) cardKey = partKey(message, start)
        assistantMessages += if (start == 0 && end == message.content.size) message
            else message.copy(content = message.content.subList(start, end).toList())
        if (end == message.content.size) completed += message.messageId
    }

    for (message in messages) {
        if (message.role == "user") {
            flushAssistantMessages()
            val cached = reusableUsers[message.messageId]
            items += if (cached != null && cached.message === message) cached else ChatListItem.UserMessage(message)
            continue
        }
        if (message.role !in setOf("assistant", "tool") || message.isError == true) {
            flushAssistantMessages()
            append(message, 0, message.content.size)
            flushAssistantMessages()
            continue
        }
        var start = 0
        message.content.forEachIndexed { index, block ->
            val tool = message.role == "tool" || block.type in setOf("tool_call", "toolCall")
            if (!tool && block.artifact == null && block.text.isNullOrBlank()) return@forEachIndexed
            val knownStart = partKey(message, index) in reusableTurns && (assistantMessages.isNotEmpty() || start < index)
            if (knownStart || !tool && (hasTools || block.type == "thinking" && hasText || proseCount >= CHAT_CARD_PROSE_LIMIT)) {
                if (start < index) append(message, start, index)
                flushAssistantMessages()
                start = index
            }
            if (tool) hasTools = true
            else proseCount++
            if (block.type == "text" && !tool && !block.text.isNullOrBlank()) hasText = true
        }
        append(message, start, message.content.size)
    }
    flushAssistantMessages()
    return items
}

internal data class ChatCardTool(val message: ChatMessage, val block: RemoteContent, val index: Int) {
    val key: String get() = block.toolCallId ?: "${message.messageId}:tool:$index"
}

internal data class AssistantCardContent(val prose: List<ChatMessage>, val tools: List<ChatCardTool>)

/** Group tools across native message boundaries; the card grouper guarantees they are a tail. */
internal fun assistantCardContent(messages: List<ChatMessage>): AssistantCardContent {
    val tools = mutableListOf<ChatCardTool>()
    val prose = messages.mapNotNull { message ->
        val content = message.content.filterIndexed { index, block ->
            val tool = block.type in setOf("tool_call", "toolCall")
            if (tool) tools += ChatCardTool(message, block, index)
            !tool
        }
        if (content.isEmpty()) null else if (content.size == message.content.size) message else message.copy(content = content)
    }
    return AssistantCardContent(prose, tools)
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
    val represented = normalized.flatMap { it.content }.mapNotNull { it.toolCallId }.toSet()
    return ConversationPresentation(
        messages = normalized.mapNotNull { message ->
            if (message.role != "tool") message
            else message.toolSummary?.takeIf { message.toolCallId !in represented }?.let { summary ->
                message.copy(role = "assistant", content = listOf(RemoteContent(type = "tool_call",
                    toolCallId = summary.tool.toolCallId, toolName = summary.toolName, summary = summary)))
            }
        },
        toolResults = toolResults,
    )
}

private fun ChatMessage.hasRenderableContent(): Boolean = toolSummary != null || content.any { block ->
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
