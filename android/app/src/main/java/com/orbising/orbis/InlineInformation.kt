package com.orbising.orbis

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** S53 / SC77: explanations are requested explicitly; the visible glyph stays secondary. */
@Composable
internal fun InlineInfoButton(message: String, title: String = L10n.tr("说明"), tag: String = "inline-info") {
    var open by rememberSaveable(message) { mutableStateOf(false) }
    NeumorphIconButton(onClick = { open = true }, icon = OrbisSymbols.Info,
        contentDescription = if (title == L10n.tr("说明")) L10n.tr("查看说明") else L10n.tr("查看{0}说明", title), size = 28.dp,
        tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag(tag))
    if (open) NeumorphDialog(onDismissRequest = { open = false },
        title = { Text(title) }, text = { SelectionContainer { Text(message) } },
        confirmButton = { NeumorphTextButton(L10n.tr("知道了"), { open = false }) })
}

/** A short state remains visible while its explanation is available separately. */
@Composable
internal fun StatusWithInfo(label: String, explanation: String, modifier: Modifier = Modifier, error: Boolean = false) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium,
            color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        InlineInfoButton(explanation, label)
    }
}
