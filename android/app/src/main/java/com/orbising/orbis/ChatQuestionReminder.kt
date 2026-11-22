package com.orbising.orbis

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.NorthWest
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import com.orbising.orbis.OrbisActionIcon as Icon
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideIn
import androidx.compose.animation.slideOut
import androidx.compose.animation.core.tween
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Points to the source row; local outbox entries must not masquerade as delivered questions. */
@Immutable
internal data class ChatQuestion(val messageId: String, val text: String)

internal fun sourceChatQuestion(message: ChatMessage): ChatQuestion? {
    if (message.role != "user" || message.isError == true) return null
    return message.content.mapNotNull { block ->
        when (block.type) {
            "text" -> block.text?.takeIf { it.isNotBlank() }
            "artifact" -> block.artifact?.let { L10n.tr("附件：{0}", it.fileName) }
            else -> null
        }
    }.joinToString("\n").trim().takeIf { it.isNotEmpty() }?.let { ChatQuestion(message.messageId, it) }
}

/** Built with the background transcript projection, not in the scroll observer. */
internal fun indexChatReadingQuestions(
    rowKeys: List<String>, source: List<ChatMessage>, excluded: Set<String>,
): Map<String, ChatQuestion> {
    val questions = source.asSequence().filter { it.messageId !in excluded }
        .mapNotNull(::sourceChatQuestion).associateBy(ChatQuestion::messageId)
    return buildMap {
        var predecessor: ChatQuestion? = null
        for (row in rowKeys) {
            val question = questions[row]
            if (question != null) predecessor = question
            else predecessor?.let { put(row, it) }
        }
    }
}

@Composable
internal fun ChatQuestionReminder(question: ChatQuestion, onClick: () -> Unit, modifier: Modifier = Modifier) {
    NeumorphSurface(
        modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("chat-question-reminder"),
        shape = RemoteUi.ControlShape, shadowScale = 0.6f, contentPadding = 12.dp,
        onClick = onClick,
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(L10n.tr("最近提问"), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(question.text, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Rounded.NorthWest, contentDescription = L10n.tr("定位到原消息"),
                modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
        }
    }
}

/** Keep the last rendered question for the exit frames; only the live question is actionable. */
@Composable
internal fun AnimatedChatQuestionReminder(
    question: ChatQuestion?, visible: Boolean, modifier: Modifier = Modifier,
    onClick: (ChatQuestion) -> Unit,
) {
    var displayed by remember { mutableStateOf(question) }
    LaunchedEffect(question) { if (question != null) displayed = question }
    val offset = with(LocalDensity.current) { IntOffset(32.dp.roundToPx(), -12.dp.roundToPx()) }
    AnimatedVisibility(visible = visible && question != null, modifier = modifier,
        enter = slideIn(tween(InteractionMotion.duration(InteractionMotion.Panel))) { offset } + fadeIn(tween(InteractionMotion.duration(InteractionMotion.Panel))),
        exit = slideOut(tween(InteractionMotion.duration(InteractionMotion.Exit))) { offset } + fadeOut(tween(InteractionMotion.duration(InteractionMotion.Exit))),
    ) {
        displayed?.let { shown ->
            ChatQuestionReminder(shown, onClick = { if (visible) question?.let(onClick) })
        }
    }
}

/** The artwork keeps the last positive pull for exit frames; resetting the gesture
 * must not empty the ring or change its label before it leaves. */
@Stable
internal class ChatHistoryPullVisual {
    var showing by mutableStateOf(false)
        private set
    var progress by mutableFloatStateOf(0f)
        private set

    fun update(value: Float) {
        if (value > 0f) progress = value
        showing = value > 0f
    }
}

internal enum class ChatHistoryStatus { Hidden, Pull, Loading, Retry }

/** CHAT-PAGING-07: this overlay owns the animation, never the transcript. Pull and
 * loading retain the same surface; only the live phase has semantics or actions. */
@Composable
internal fun AnimatedChatHistoryStatus(
    status: ChatHistoryStatus,
    pull: ChatHistoryPullVisual,
    modifier: Modifier = Modifier,
    retryEnabled: Boolean = false,
    onRetry: () -> Unit = {},
) {
    val enter = InteractionMotion.duration(InteractionMotion.State)
    val exit = InteractionMotion.duration(InteractionMotion.Exit)
    val offset = with(LocalDensity.current) { IntOffset(0, -6.dp.roundToPx()) }
    AnimatedContent(targetState = status, modifier = modifier, contentAlignment = Alignment.TopCenter,
        // Reuse the progress surface when releasing an armed pull.
        contentKey = { if (it == ChatHistoryStatus.Pull) ChatHistoryStatus.Loading else it },
        transitionSpec = {
            val appear = fadeIn(tween(enter, easing = InteractionMotion.GlyphEase),
                initialAlpha = if (initialState == ChatHistoryStatus.Hidden) 0.65f else 0f)
            val disappear = fadeOut(tween(exit))
            ((if (initialState == ChatHistoryStatus.Hidden && targetState != ChatHistoryStatus.Pull && enter > 0)
                appear + slideIn(tween(enter, easing = InteractionMotion.GlyphEase)) { offset } else appear) togetherWith
                (if (targetState == ChatHistoryStatus.Hidden && exit > 0)
                    disappear + slideOut(tween(exit)) { offset } else disappear)).using(null)
        }, label = "chat-history-status",
    ) { shown ->
        val live = shown == status
        when (shown) {
            ChatHistoryStatus.Hidden -> Unit
            ChatHistoryStatus.Pull, ChatHistoryStatus.Loading ->
                ChatHistoryProgress(loading = shown == ChatHistoryStatus.Loading, pull = pull, live = live)
            ChatHistoryStatus.Retry -> {
                // As with progress, leave room inside the animated layer for the soft shadows.
                Box(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                    ChatHistoryRetry(enabled = live && retryEnabled, onRetry = onRetry, live = live)
                }
            }
        }
    }
}

private enum class HistoryProgressContent(val title: String) {
    Pull("下拉加载历史"), Armed("松手加载"), Loading("正在加载更早的历史…"),
}

@Composable
private fun ChatHistoryProgress(loading: Boolean, pull: ChatHistoryPullVisual, live: Boolean) {
    // Only the threshold invalidates composition; the progress and position read in draw.
    val armed by remember(pull) { derivedStateOf { pull.progress >= 1f } }
    val phase = if (loading) HistoryProgressContent.Loading else if (armed) HistoryProgressContent.Armed
        else HistoryProgressContent.Pull
    val duration = InteractionMotion.duration(InteractionMotion.State)
    val accessibility = if (!live) Modifier.clearAndSetSemantics {} else
        Modifier.testTag(if (loading) "chat-history-loading" else "chat-history-pull").semantics(mergeDescendants = true) {
            text = AnnotatedString(L10n.tr(phase.title))
            if (loading) liveRegion = LiveRegionMode.Polite
        }
    // CHAT-PAGING-05: alpha composites into a bounded layer. Keep the transparent
    // gutter inside that layer so the pill and its outer shadows fade as one.
    Box(Modifier.testTag("chat-history-progress-artwork")) {
        NeumorphSurface(
            Modifier.graphicsLayer {
                val reveal = if (loading) 1f else pull.progress
                translationY = if (duration == 0) 0f else -6.dp.toPx() * (1f - reveal)
                alpha = 0.65f + 0.35f * reveal
            }.padding(horizontal = 16.dp, vertical = 8.dp)
                .then(accessibility),
            shape = RemoteUi.ControlShape, shadowScale = 0.6f,
        ) {
            AnimatedContent(targetState = phase, modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                contentAlignment = Alignment.CenterStart, transitionSpec = {
                    (fadeIn(tween(duration)) togetherWith fadeOut(tween(duration)))
                        .using(SizeTransform(clip = false) { _, _ -> tween(duration) })
                }, label = "chat-history-progress-content",
            ) { shown ->
                val color = if (shown == HistoryProgressContent.Armed) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant
                Row(Modifier.clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) {
                        if (shown == HistoryProgressContent.Loading) {
                            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                        } else {
                            CircularProgressIndicator(progress = { pull.progress }, modifier = Modifier.size(16.dp), color = color,
                                trackColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.2f), strokeWidth = 2.dp)
                            Icon(Icons.Rounded.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(10.dp), tint = color)
                        }
                    }
                    Text(L10n.tr(shown.title), style = MaterialTheme.typography.labelMedium, color = color)
                }
            }
        }
    }
}

@Composable
private fun ChatHistoryRetry(enabled: Boolean, onRetry: () -> Unit, live: Boolean) {
    NeumorphSurface(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).then(
            if (live) Modifier.testTag("chat-history-retry") else Modifier.clearAndSetSemantics {}),
        shape = RemoteUi.ControlShape, shadowScale = 0.6f, contentPadding = 12.dp,
        onClick = onRetry.takeIf { enabled },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(L10n.tr("历史加载失败"), modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(L10n.tr("重试"), color = MaterialTheme.colorScheme.primary, maxLines = 1)
        }
    }
}
