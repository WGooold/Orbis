package com.orbising.orbis

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

/** The native task list does not own the main turn's input or stop controls. */
@Composable
internal fun BackgroundTasksPanel(tasks: BackgroundTaskInventory) {
    var expanded by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = RemoteUi.PagePadding)) {
        NeumorphTextButton(
            text = tasks.panelTitle,
            icon = if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
            onClick = { expanded = !expanded },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("background-tasks-toggle")
                .semantics { stateDescription = if (expanded) L10n.tr("已展开") else L10n.tr("已收起") },
        )
        OrbisCollapse(expanded = expanded) {
            Column(Modifier.fillMaxWidth().heightIn(max = 160.dp).verticalScroll(rememberScrollState()).padding(bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)) {
                tasks.inventoryNotice?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
                tasks.items.forEach { task ->
                    key(task.id) {
                        Column(Modifier.fillMaxWidth().testTag("background-task-${task.id}")) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(task.title.ifEmpty { task.kind }, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 2)
                                Text(task.statusTitle, style = MaterialTheme.typography.labelSmall)
                            }
                            Text(task.kind, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            tasks.items.firstOrNull { it.id == task.parentId }?.let { parent ->
                                Text(L10n.tr("来自：{0}", parent.title), style = MaterialTheme.typography.labelSmall, maxLines = 1)
                            }
                        }
                    }
                }
            }
        }
    }
}
