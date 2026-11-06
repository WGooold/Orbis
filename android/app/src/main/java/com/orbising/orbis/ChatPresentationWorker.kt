package com.orbising.orbis

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.referentialEqualityPolicy
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.withContext

internal data class ChatPresentationIdentity(val host: String?, val runtime: String, val session: String?, val branch: Int)

/** Input comparison on the UI thread is constant time, including for a streamed long message. */
internal class ChatPresentationRequest(
    val identity: ChatPresentationIdentity,
    val messages: List<ChatMessage>,
    val timings: Map<String, TurnTiming>,
    val tools: Map<String, ToolActivity>,
    val pending: Map<String, PendingSend>,
    val graph: SessionGraph? = null,
) {
    override fun equals(other: Any?): Boolean = other is ChatPresentationRequest && identity == other.identity &&
        messages === other.messages && timings === other.timings && tools === other.tools && pending === other.pending && graph === other.graph
    override fun hashCode(): Int = identity.hashCode()
}

internal class ChatPresentationProjection(
    val identity: ChatPresentationIdentity,
    val presentation: ConversationPresentation,
    val items: List<ChatListItem>,
    val timings: Map<String, TurnTiming>,
    val turnIds: Map<String, String>,
    val requestTools: Map<String, ToolActivity>,
    val orphanTools: List<ToolActivity>,
    questionMessages: List<ChatMessage>,
    val error: String? = null,
) {
    val keys = items.map(ChatListItem::key)
    val arrivalRows = items.map { item -> item.key to when (item) {
        is ChatListItem.UserMessage -> listOf(item.message.messageId)
        is ChatListItem.AssistantTurn -> item.messages.map(ChatMessage::messageId)
    } }
    val artifactsByRow = items.associate { item ->
        val messages = when (item) {
            is ChatListItem.UserMessage -> listOf(item.message)
            is ChatListItem.AssistantTurn -> item.messages
        }
        item.key to messages.flatMap { it.content }.mapNotNull(RemoteContent::artifact)
    }
    val byKey = items.associateBy(ChatListItem::key)
    val indexByMessage = chatListItemIndexByMessageId(items)
    val latestQuestion = latestChatQuestion(questionMessages)
    val truncated = presentation.messages.firstNotNullOfOrNull { message ->
        message.content.firstOrNull { it.truncated }?.let { message.messageId to (it.originalBytes ?: 0L) }
    }
    val toolsByRow = items.associate { item ->
        val messages = when (item) {
            is ChatListItem.UserMessage -> listOf(item.message)
            is ChatListItem.AssistantTurn -> item.messages
        }
        val ids = messages.flatMap { it.content }.mapNotNull(RemoteContent::toolCallId).toSet()
        item.key to ids
    }
    val resultsByRow = items.associate { item ->
        val ids = toolsByRow[item.key].orEmpty()
        item.key to ids.mapNotNull { id -> presentation.toolResults[id]?.let { id to it } }.toMap()
    }
    val activitiesByRow = items.associate { item ->
        val ids = toolsByRow[item.key].orEmpty()
        item.key to ids.mapNotNull { id -> requestTools[id]?.let { id to it } }.toMap()
    }
}

/** One serial collector owns reuse. Only derived views are conflated; business events are not. */
internal class ChatPresentationWorker {
    private var previous: ChatPresentationProjection? = null
    private var grouped: List<ChatListItem> = emptyList()
    suspend fun resolve(request: ChatPresentationRequest): ChatPresentationProjection = withContext(Dispatchers.Default) {
        val source = request.graph?.let(::projectSessionGraph)
        val base = source?.messages ?: request.messages
        val timings = if (source == null) request.timings else source.turnTimings.associateBy(TurnTiming::turnId)
        val byMessage = timings.values.mapNotNull { timing -> timing.messageId?.let { it to timing } }.toMap()
        val turns = byMessage.mapValues { it.value.turnId }
        val presentation = buildConversationPresentation(mergePendingSends(base, request.pending.chatRows(request.identity.session)))
        val old = previous?.takeIf { it.identity == request.identity }
        grouped = buildChatListItems(presentation.messages, turns, if (old == null) emptyList() else grouped)
        val items = chatViewportItems(grouped, old?.items.orEmpty())
        val represented = presentation.messages.flatMap { it.content }.mapNotNull(RemoteContent::toolCallId).toSet()
        ChatPresentationProjection(request.identity, presentation, items, byMessage, turns, request.tools,
            orphanToolActivities(request.tools.values, represented), base, source?.error).also { previous = it }
    }
}

@Composable
internal fun rememberChatPresentation(request: ChatPresentationRequest): ChatPresentationProjection? {
    val current by rememberUpdatedState(request)
    val worker = remember { ChatPresentationWorker() }
    var result by remember { mutableStateOf<ChatPresentationProjection?>(null, referentialEqualityPolicy()) }
    LaunchedEffect(worker) {
        snapshotFlow { current }.conflate().collect { input ->
            val next = worker.resolve(input)
            if (next.identity == current.identity) result = next
        }
    }
    return result?.takeIf { it.identity == request.identity }
}
