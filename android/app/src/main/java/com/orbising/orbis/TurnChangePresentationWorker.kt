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

internal data class TurnChangePresentationIdentity(
    val runtimeId: String,
    val sessionId: String?,
    val branchGeneration: Int,
)

/** Input comparisons stay constant-time on Main; matching work and its result are owned by Default. */
internal class TurnChangePresentationRequest(
    val identity: TurnChangePresentationIdentity,
    val items: List<ChatListItem>,
    val turnIdsByMessageId: Map<String, String>,
    val summaries: Map<String, TurnChangeSummary>,
) {
    override fun equals(other: Any?): Boolean = other is TurnChangePresentationRequest &&
        identity == other.identity && items === other.items && turnIdsByMessageId === other.turnIdsByMessageId && summaries === other.summaries

    override fun hashCode(): Int = identity.hashCode()
}

internal class TurnChangePresentationProjection(
    val identity: TurnChangePresentationIdentity,
    val summariesByRow: Map<String, List<TurnChangeSummary>>,
)

internal class TurnChangePresentationWorker {
    private var previousRequest: TurnChangePresentationRequest? = null
    private var previousProjection: TurnChangePresentationProjection? = null
    internal var computations = 0
        private set

    suspend fun resolve(request: TurnChangePresentationRequest): TurnChangePresentationProjection = withContext(Dispatchers.Default) {
        if (previousRequest == request) return@withContext checkNotNull(previousProjection)
        computations++
        val byRow = buildMap {
            request.items.filterIsInstance<ChatListItem.AssistantTurn>().forEach { item ->
                val messageIds = item.completedMessageIds
                val turns = messageIds.mapNotNullTo(hashSetOf(), request.turnIdsByMessageId::get)
                val matches = request.summaries.values.filter { summary ->
                    if (summary.anchorEntryId != null) summary.anchorEntryId in messageIds
                    else summary.reviewTurnId in turns || summary.sourceTurnIds.lastOrNull() in turns
                }.sortedBy(TurnChangeSummary::startedAt)
                if (matches.isNotEmpty()) put(item.key, matches)
            }
        }
        TurnChangePresentationProjection(request.identity, byRow).also {
            previousRequest = request
            previousProjection = it
        }
    }
}

@Composable
internal fun rememberTurnChangePresentation(request: TurnChangePresentationRequest): TurnChangePresentationProjection? {
    val current by rememberUpdatedState(request)
    val worker = remember { TurnChangePresentationWorker() }
    var result by remember { mutableStateOf<TurnChangePresentationProjection?>(null, referentialEqualityPolicy()) }
    LaunchedEffect(worker) {
        snapshotFlow { current }.conflate().collect { input ->
            val next = worker.resolve(input)
            if (input == current) result = next
        }
    }
    return result?.takeIf { it.identity == request.identity }
}
