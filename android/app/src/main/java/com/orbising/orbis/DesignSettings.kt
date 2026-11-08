package com.orbising.orbis

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Design alignment: settings expose consequences before a transport-changing write. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DesignSettingsScreen(state: RemoteState, onBack: () -> Unit, root: Boolean,
    onApplyProtocol: (RelayTransportMode) -> Unit) {
    var protocolOpen by rememberSaveable { mutableStateOf(false) }
    var languageOpen by rememberSaveable { mutableStateOf(false) }
    Scaffold(containerColor = MaterialTheme.colorScheme.surface, topBar = {
        RemoteTopAppBar(title = { Text(L10n.tr("设置"), fontWeight = FontWeight.SemiBold) }, navigationIcon = {
            if (!root) NeumorphIconButton(onBack, OrbisSymbols.ArrowBack, L10n.tr("返回"))
        })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            SettingsGroup(L10n.tr("连接"), padding = 0.dp, spacing = 0.dp, tag = "settings-connection-group") {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(OrbisSymbols.Computer, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
                    Column(Modifier.weight(1f)) {
                        Text(state.hostName ?: L10n.tr("电脑"), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOf(connectionMethodText(state), connectionProtocolText(state), connectionLatencyText(state)).joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        val working = !state.e2eReady && state.connection != RelayConnection.OFFLINE
                        val color = if (state.e2eReady) LocalOrbisPalette.current.success else if (working) LocalOrbisPalette.current.warning else LocalOrbisPalette.current.danger
                        NeumorphStatusDot(color, working)
                        Text(if (state.e2eReady) L10n.tr("已连接") else if (working) L10n.tr("连接中") else L10n.tr("已断开"),
                            style = MaterialTheme.typography.labelMedium, color = color)
                    }
                }
                SettingsRow(L10n.tr("连接协议"), L10n.tr("{0} · 现在走 {1}", protocolName(state.relayTransportMode), connectionProtocolText(state)),
                    "settings-protocol", minHeight = 56.dp) { protocolOpen = true }
                }
            }
            SettingsGroup(L10n.tr("外观")) { AppearancePicker() }
            SettingsGroup(L10n.tr("语言"), padding = 8.dp, tag = "settings-language-group") {
                SettingsRow(when (AppLocalization.preference) { AppLanguage.System -> L10n.tr("跟随手机"); AppLanguage.Chinese -> "简体中文"; AppLanguage.English -> "English" },
                    if (AppLocalization.language == AppLanguage.Chinese) "简体中文" else "English", "settings-language") { languageOpen = true }
            }
        }
    }
    if (protocolOpen) ProtocolChoiceSheet(state.relayTransportMode, state.hostId != null, { protocolOpen = false }) {
        protocolOpen = false; onApplyProtocol(it)
    }
    if (languageOpen) OrbisChoiceSheet(title = L10n.tr("语言"), onDismiss = { languageOpen = false }) {
        AppLanguage.entries.forEach { choice ->
            val label = when (choice) { AppLanguage.System -> L10n.tr("跟随手机"); AppLanguage.Chinese -> "简体中文"; AppLanguage.English -> "English" }
            ChoiceRow(label, "", AppLocalization.preference == choice, "language-${choice.key}") { AppLocalization.select(choice); languageOpen = false }
        }
    }
}

@Composable
private fun SettingsGroup(title: String, padding: androidx.compose.ui.unit.Dp = 16.dp,
    spacing: androidx.compose.ui.unit.Dp = 12.dp, tag: String = "", content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        NeumorphSurface(Modifier.fillMaxWidth().testTag(tag), shape = RoundedCornerShape(24.dp), contentPadding = padding) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(spacing), content = content)
        }
    }
}

@Composable
private fun SettingsRow(title: String, sub: String, tag: String, minHeight: androidx.compose.ui.unit.Dp = 48.dp, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = minHeight).testTag(tag).orbisKeyboardFocus().clickable(role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(OrbisSymbols.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
    }
}

internal fun protocolName(mode: RelayTransportMode) = when (mode) {
    RelayTransportMode.AUTO -> L10n.tr("自动")
    RelayTransportMode.QUIC -> "QUIC"
    RelayTransportMode.WS -> "WebSocket"
}

@Composable
internal fun ProtocolChoiceSheet(current: RelayTransportMode, enabled: Boolean, onDismiss: () -> Unit,
    onApply: (RelayTransportMode) -> Unit) {
    var selected by remember(current) { mutableStateOf(current) }
    OrbisChoiceSheet(L10n.tr("连接协议"), onDismiss) {
        listOf(RelayTransportMode.AUTO, RelayTransportMode.QUIC, RelayTransportMode.WS).forEach { mode ->
            ChoiceRow(protocolName(mode), when (mode) {
                RelayTransportMode.AUTO -> L10n.tr("推荐。自动模式使用 WebSocket")
                RelayTransportMode.QUIC -> L10n.tr("只使用 QUIC；网络不支持时无法连接")
                RelayTransportMode.WS -> L10n.tr("使用 WebSocket，适合限制较多的网络")
            }, selected == mode, "relay-mode-${mode.name}") { selected = mode }
        }
        NeumorphActionButton(text = if (selected == current) L10n.tr("正在使用") else L10n.tr("改用 {0} 并重新连接", protocolName(selected)),
            enabled = enabled && selected != current, modifier = Modifier.fillMaxWidth().testTag("protocol-apply"),
            onClick = { onApply(selected) })
        Text(L10n.tr("切换会让正在进行的回复短暂停顿，连上后自动继续。"), style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun ChoiceRow(title: String, sub: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    NeumorphSurface(Modifier.fillMaxWidth().testTag(tag).semantics { this.selected = selected },
        style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised, shape = RoundedCornerShape(16.dp),
        shadowScale = 0.4f, onClick = onClick) {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
                AgentIconRecess(Modifier.fillMaxSize(), CircleShape)
                if (selected) Box(Modifier.size(10.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
            }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium,
                    color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
internal fun AppearancePicker() {
    val systemDark = isSystemInDarkTheme()
    val actualDark = AppAppearance.mode.resolve(systemDark)
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            listOf(false, true).forEach { dark ->
                val selected = actualDark == dark
                val preview = orbisPalette(dark, AppAppearance.material)
                Column(Modifier.weight(1f).testTag("appearance-${if (dark) "dark" else "light"}")
                    .orbisKeyboardFocus().clickable(role = Role.RadioButton) { AppAppearance.selectMode(if (dark) OrbisAppearanceMode.Dark else OrbisAppearanceMode.Light) }
                    .semantics { this.selected = selected }, horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    NeumorphSurface(Modifier.fillMaxWidth().height(120.dp), shape = RoundedCornerShape(16.dp),
                        style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised, shadowScale = 0.4f, contentPadding = 8.dp) {
                        Canvas(Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)).background(preview.material.base)) {
                            val unitX = size.width / 100
                            val unitY = size.height / 100
                            val unit = minOf(unitX, unitY)
                            fun slab(x: Float, y: Float, w: Float, h: Float, color: Color) = drawRoundRect(color,
                                Offset(x * unitX, y * unitY), Size(w * unitX, h * unitY), CornerRadius(4 * unit))
                            slab(8f, 10f, 36f, 5f, preview.muted)
                            listOf(24f, 51f).forEachIndexed { index, y ->
                                slab(9f, y + 1f, 84f, 23f, preview.material.darkShadow.copy(alpha = 0.22f))
                                slab(8f, y, 84f, 23f, preview.material.lift)
                                drawCircle(if (index == 0) preview.success else preview.faint,
                                    3.5f * unit, Offset(15 * unitX, (y + 10) * unitY))
                                slab(23f, y + 6f, 49f, 3f, preview.muted)
                                slab(23f, y + 13f, 31f, 3f, preview.faint)
                            }
                            slab(8f, 80f, 84f, 15f, preview.material.darkShadow.copy(alpha = 0.24f))
                            slab(9f, 82f, 82f, 13f, preview.material.base)
                            drawCircle(preview.accent, 4.5f * unit, Offset(84 * unitX, 88 * unitY))
                        }
                    }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
                            AgentIconRecess(Modifier.fillMaxSize(), CircleShape)
                            if (selected) Box(Modifier.size(10.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
                        }
                        Text(if (dark) L10n.tr("深色") else L10n.tr("浅色"),
                            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal, style = MaterialTheme.typography.labelMedium)
                        if (selected && AppAppearance.mode == OrbisAppearanceMode.System) Text(L10n.tr("跟随系统"),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("appearance-system")
            .orbisKeyboardFocus().clickable(role = Role.Switch) { AppAppearance.selectMode(if (AppAppearance.mode == OrbisAppearanceMode.System) {
                if (systemDark) OrbisAppearanceMode.Dark else OrbisAppearanceMode.Light
            } else OrbisAppearanceMode.System) }, verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f)) {
                Text(L10n.tr("跟随系统"), style = MaterialTheme.typography.titleMedium)
                Text(L10n.tr("随手机的浅色与深色自动切换"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            OrbisSwitch(AppAppearance.mode == OrbisAppearanceMode.System)
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(L10n.tr("材质"), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            OrbisMaterial.entries.forEach { material ->
                val selected = AppAppearance.material == material
                val p = orbisPalette(actualDark, material)
                Row(Modifier.widthIn(min = 48.dp).heightIn(min = 48.dp).testTag("appearance-material-${material.name.lowercase()}")
                    .orbisKeyboardFocus().clickable(role = Role.RadioButton) { AppAppearance.selectMaterial(material) }
                    .semantics { this.selected = selected }, verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CompositionLocalProvider(LocalNeumorphColors provides p.material, LocalOrbisSurface provides null) {
                        NeumorphSurface(Modifier.size(36.dp), shape = CircleShape,
                            style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised, shadowScale = 0.4f) {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                Box(Modifier.size(12.dp).background(p.accent, CircleShape))
                            }
                        }
                    }
                    Text(if (material == OrbisMaterial.Mist) L10n.tr("雾蓝") else L10n.tr("灰绿"),
                        style = MaterialTheme.typography.labelMedium,
                        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun OrbisSwitch(checked: Boolean) {
    val offset by androidx.compose.animation.core.animateDpAsState(if (checked) 24.dp else 0.dp,
        androidx.compose.animation.core.tween(InteractionMotion.duration(InteractionMotion.Selection)), label = "switch")
    NeumorphSurface(Modifier.size(56.dp, 32.dp), shape = RoundedCornerShape(12.dp), style = NeumorphStyle.Pressed, shadowScale = 0.4f) {
        Box(Modifier.padding(4.dp).offset(x = offset).size(24.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(8.dp)),
            contentAlignment = Alignment.Center) {
            Box(Modifier.size(4.dp).background(if (checked) MaterialTheme.colorScheme.primary else LocalOrbisPalette.current.faint, CircleShape))
        }
    }
}
