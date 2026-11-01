package com.orbising.orbis

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.NorthWest
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
                block.type == "artifact" -> block.artifact?.let { "附件：${it.fileName}" }
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
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("最近提问", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(question.text, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            Icon(Icons.Rounded.NorthWest, contentDescription = "定位到原消息",
                modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
        }
    }
}
