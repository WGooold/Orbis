package com.orbising.orbis

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChatBubbleOutline
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.orbising.orbis.OrbisActionIcon as Icon

/** S32 / SC51: these are peer roots, not pages pushed over the chat list. */
internal enum class HomeTab(val key: String) { Chat("chat"), Providers("providers"), Settings("settings") }

@Composable
internal fun HomeTabBar(selected: HomeTab, onSelect: (HomeTab) -> Unit, modifier: Modifier = Modifier) {
    OrbisMaterialTheme {
        val haptic = rememberActionHaptic()
        Row(
            modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)
                .navigationBarsPadding().padding(horizontal = 20.dp, vertical = 10.dp)
                .selectableGroup().testTag("home-tabs"),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            HomeTab.entries.forEach { tab ->
                val label = when (tab) {
                    HomeTab.Chat -> L10n.tr("聊天")
                    HomeTab.Providers -> L10n.tr("供应商")
                    HomeTab.Settings -> L10n.tr("设置")
                }
                val active = selected == tab
                val color = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
                NeumorphSurface(
                    modifier = Modifier.weight(1f).heightIn(min = 58.dp)
                        .testTag("home-tab-${tab.key}")
                        .selectable(selected = active, role = Role.Tab) {
                            if (!active) { haptic(); onSelect(tab) }
                        }.semantics { contentDescription = label },
                    shape = RoundedCornerShape(19.dp),
                    style = if (active) NeumorphStyle.Pressed else NeumorphStyle.Raised,
                    shadowScale = 0.32f,
                ) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 9.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Icon(when (tab) {
                            HomeTab.Chat -> Icons.Rounded.ChatBubbleOutline
                            HomeTab.Providers -> Icons.Rounded.Tune
                            HomeTab.Settings -> Icons.Rounded.Settings
                        }, contentDescription = null, tint = color, modifier = Modifier.size(21.dp))
                        // Give scaled/fallback glyphs the whole slot instead of a rounded natural-width box.
                        Text(label, modifier = Modifier.fillMaxWidth(), color = color,
                            style = MaterialTheme.typography.labelMedium, textAlign = TextAlign.Center,
                            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal)
                    }
                }
            }
        }
    }
}
