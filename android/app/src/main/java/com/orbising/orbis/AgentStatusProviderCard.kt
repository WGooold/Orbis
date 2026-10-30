package com.orbising.orbis

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Agent rows share one material panel; each row keeps independent query and switch actions. */
@Composable
internal fun AgentStatusProvidersCard(
    state: RemoteState,
    onSwitch: (AgentProvider, String?) -> Unit,
    onQuery: (AgentProvider, String?) -> Unit,
) {
    NeumorphSurface(modifier = Modifier.fillMaxWidth(), contentInset = 16.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            listOf("pi", "codex", "claude", "dsh").forEach { kind ->
                AgentStatusProviderCard(state, kind, onSwitch, onQuery)
            }
        }
    }
}

@Composable
internal fun AgentStatusProviderCard(
    state: RemoteState,
    kind: String,
    onSwitch: (AgentProvider, String?) -> Unit,
    onQuery: (AgentProvider, String?) -> Unit,
) {
    val providers = state.providersForKind(kind)
    val current = state.currentProviderForKind(kind)
    var menuOpen by remember(state.hostId, kind) { mutableStateOf(false) }
    LaunchedEffect(state.e2eReady, providers) { menuOpen = false }
    val snapshot = current?.let { state.subscriptionQuotas[kind]?.takeIf { it.providerId == current.id } }
    val quota = snapshot?.quota
    val loading = current?.id == state.agentProviders.quotaProviderId && state.agentProviders.quotaKind == kind && state.agentProviders.quotaRequestId != null
    val hasQuota = current?.subscriptionSupported == true
    val available = state.canUseProviders(kind)
    val accent = agentBrand(kind).accent()
    var queryPressed by remember { mutableStateOf(false) }
    val queryEnabled = hasQuota && available && !loading
    Box(Modifier.fillMaxWidth().testTag("provider-quota-$kind")
        .alpha(if (queryPressed && queryEnabled) 0.72f else 1f)
        .immediatePressFeedback(queryEnabled) { queryPressed = it }
        .then(if (hasQuota) Modifier.clickable(
            interactionSource = remember { MutableInteractionSource() }, indication = null,
            enabled = queryEnabled, role = Role.Button,
        ) { current?.let { onQuery(it, state.hostId) } } else Modifier)
        .padding(16.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (hasQuota) {
                    key(state.hostId, kind, current?.id) {
                        SubscriptionQuotaCoin(kind, quota, loading, available, accent) {
                            current?.let { onQuery(it, state.hostId) }
                        }
                    }
                } else AgentIcon(agentBrand(kind), Modifier.size(32.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(agentBrand(kind).title, modifier = Modifier.weight(1f, fill = false),
                            style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (hasQuota) SubscriptionRefreshGlyph(loading, pending = quota == null, tint = accent)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(state.providerNameForKind(kind), modifier = Modifier.weight(1f, fill = false),
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (current?.official == true) Icon(Icons.Rounded.CheckCircle, contentDescription = "官方供应商",
                            tint = accent, modifier = Modifier.size(16.dp))
                    }
                }
                Box {
                    val interactions = remember { MutableInteractionSource() }
                    val pressed by interactions.collectIsPressedAsState()
                    Row(Modifier.testTag("provider-switch-$kind")
                        .heightIn(min = 48.dp).widthIn(min = 64.dp)
                        .alpha(if (!available) 0.4f else if (pressed) 0.55f else 1f)
                        .clickable(interactionSource = interactions, indication = null, enabled = available, role = Role.Button) { menuOpen = true }
                        .semantics { contentDescription = "切换 ${agentBrand(kind).title} 供应商" },
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterHorizontally)) {
                        Icon(Icons.Rounded.SwapHoriz, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text("切换", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    NeumorphMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        providers.forEach { provider ->
                            NeumorphMenuItem(text = { Text(provider.name) },
                                leadingIcon = {
                                    if (provider.official) AgentIcon(agentBrand(kind), description = "官方供应商")
                                    else Icon(Icons.Rounded.Dns, contentDescription = null, modifier = Modifier.size(18.dp))
                                },
                                trailingIcon = { if (provider.enabled) Icon(Icons.Rounded.Check, contentDescription = "已启用", modifier = Modifier.size(18.dp)) },
                                enabled = available && (!provider.enabled || provider.additive),
                                onClick = { menuOpen = false; onSwitch(provider, state.hostId) })
                        }
                    }
                }
            }
            if (hasQuota) {
                snapshot?.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
            if (state.agentProviders.kind == kind) {
                state.agentProviders.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                state.agentProviders.notice?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}
