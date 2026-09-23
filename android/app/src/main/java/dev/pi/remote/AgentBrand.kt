package dev.pi.remote

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Agent identity is independent of the selected model/provider. */
internal enum class AgentBrand(val title: String, val icon: Int) {
    Pi("Pi", R.drawable.ic_agent_pi),
    Codex("Codex", R.drawable.ic_agent_codex),
    DeepSeek("DeepSeek", R.drawable.ic_agent_dsh),
}

internal fun agentBrand(isCodex: Boolean) = if (isCodex) AgentBrand.Codex else AgentBrand.Pi
internal fun agentBrand(kind: String?) = when (kind) {
    "codex" -> AgentBrand.Codex
    "dsh" -> AgentBrand.DeepSeek
    else -> AgentBrand.Pi
}
internal val LocalAgentBrand = staticCompositionLocalOf { AgentBrand.Pi }

@Composable
internal fun AgentBrand.accent(): Color = when (this) {
    AgentBrand.Pi -> if (isSystemInDarkTheme()) Color(0xFFF2AD90) else Color(0xFF99482F)
    AgentBrand.Codex -> if (isSystemInDarkTheme()) Color(0xFF77D6C7) else Color(0xFF006C64)
    AgentBrand.DeepSeek -> if (isSystemInDarkTheme()) Color(0xFFA1B5FF) else Color(0xFF4361D8)
}

/** Keep the shared soft base; focus rings, actions and selection inherit the agent accent. */
@Composable
internal fun AgentTheme(brand: AgentBrand, content: @Composable () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val accent = brand.accent()
    CompositionLocalProvider(LocalAgentBrand provides brand) {
        MaterialTheme(
            colorScheme = colors.copy(
                primary = accent,
                onPrimary = if (isSystemInDarkTheme()) Color(0xFF192326) else Color.White,
                primaryContainer = lerp(colors.surface, accent, 0.14f),
                onPrimaryContainer = accent,
            ),
            content = content,
        )
    }
}

@Composable
internal fun AgentIcon(brand: AgentBrand, modifier: Modifier = Modifier, description: String? = null) {
    Icon(
        painter = painterResource(brand.icon),
        contentDescription = description,
        modifier = modifier.size(22.dp),
        tint = if (brand == AgentBrand.Pi) Color.Unspecified else brand.accent(),
    )
}

/** A recessed identity medallion, never an extra click target. */
@Composable
internal fun AgentEmblem(brand: AgentBrand, size: Dp = 40.dp) {
    NeumorphSurface(
        modifier = Modifier.size(size),
        shape = RemoteUi.ControlShape,
        style = NeumorphStyle.Pressed,
        shadowScale = 0.45f,
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            AgentIcon(brand, Modifier.size(size * 0.56f))
        }
    }
}

@Composable
internal fun AgentLabel(brand: AgentBrand, modifier: Modifier = Modifier, suffix: String? = null) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        AgentIcon(brand, Modifier.size(16.dp))
        Text(
            if (suffix == null) brand.title else "${brand.title} · $suffix",
            color = brand.accent(),
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

@Composable
internal fun AgentChoice(brand: AgentBrand, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val interaction = remember { MutableInteractionSource() }
    NeumorphSurface(
        modifier = modifier.selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = onClick, interactionSource = interaction, indication = null),
        interactionSource = interaction,
        enabled = enabled,
        shape = RemoteUi.ControlShape,
        style = if (selected) NeumorphStyle.Pressed else NeumorphStyle.Raised,
        shadowScale = 0.6f,
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AgentIcon(brand)
            Text(brand.title, color = if (enabled) brand.accent() else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.38f), style = MaterialTheme.typography.labelLarge)
        }
    }
}
