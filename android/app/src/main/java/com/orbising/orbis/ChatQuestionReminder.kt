package com.orbising.orbis

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.NorthWest
import com.orbising.orbis.OrbisActionIcon as Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideIn
import androidx.compose.animation.slideOut
import androidx.compose.animation.core.tween
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Points to the source row; local outbox entries must not masquerade as delivered questions. */
@Immutable
internal data class ChatQuestion(val messageId: String, val text: String)

internal fun latestChatQuestion(messages: List<ChatMessage>, excludedMessageIds: Set<String> = emptySet()): ChatQuestion? =
    messages.asReversed().firstNotNullOfOrNull { message ->
        if (message.role != "user" || message.isError == true || message.messageId in excludedMessageIds) null
        else message.content.mapNotNull { block ->
            when {
                block.type == "text" -> block.text?.takeIf { it.isNotBlank() }
                block.type == "artifact" -> block.artifact?.let { L10n.tr("附件：{0}", it.fileName) }
                else -> null
            }
        }.joinToString("\n").trim().takeIf { it.isNotEmpty() }?.let { ChatQuestion(message.messageId, it) }
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
