package com.orbising.orbis

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color

internal fun orbisMaterialColors(dark: Boolean): NeumorphColors = orbisPalette(dark, AppAppearance.material).material

internal fun orbisMaterialColorScheme(source: ColorScheme, dark: Boolean, appearance: OrbisMaterial = AppAppearance.material): ColorScheme {
    val p = orbisPalette(dark, appearance)
    val m = p.material
    return source.copy(
        primary = p.accent, onPrimary = p.onAccent, primaryContainer = p.accentSoft, onPrimaryContainer = p.accent,
        secondary = p.muted, onSecondary = m.base, secondaryContainer = m.lift, onSecondaryContainer = p.ink,
        tertiary = p.success, onTertiary = m.base, tertiaryContainer = m.lift, onTertiaryContainer = p.ink,
        error = p.danger, onError = p.onAccent, errorContainer = m.base, onErrorContainer = p.danger,
        background = m.base, onBackground = p.ink, surface = m.base, onSurface = p.ink,
        surfaceVariant = m.base, onSurfaceVariant = p.muted, outline = p.faint, outlineVariant = p.hairline,
        surfaceTint = m.base, surfaceDim = m.base, surfaceBright = m.top,
        surfaceContainerLowest = m.base, surfaceContainerLow = m.base, surfaceContainer = m.base,
        surfaceContainerHigh = m.lift, surfaceContainerHighest = m.top,
        inverseSurface = p.ink, inverseOnSurface = m.base, inversePrimary = p.accent, scrim = m.scrim,
    )
}

@Composable
private fun themeColor(value: Color): Color {
    val animated by animateColorAsState(value, tween(InteractionMotion.duration(InteractionMotion.Panel)), label = "appearance")
    return animated
}

@Composable
internal fun animateOrbisMaterial(m: NeumorphColors) = m.copy(
    base = themeColor(m.base), insetBase = themeColor(m.base), lift = themeColor(m.lift), top = themeColor(m.top),
    lightShadow = themeColor(m.lightShadow), darkShadow = themeColor(m.darkShadow), scrim = themeColor(m.scrim),
)

@Composable
internal fun animateOrbisScheme(s: ColorScheme) = s.copy(
    primary = themeColor(s.primary), onPrimary = themeColor(s.onPrimary), primaryContainer = themeColor(s.primaryContainer),
    onPrimaryContainer = themeColor(s.onPrimaryContainer), secondary = themeColor(s.secondary), tertiary = themeColor(s.tertiary),
    error = themeColor(s.error), background = themeColor(s.background), onBackground = themeColor(s.onBackground),
    surface = themeColor(s.surface), onSurface = themeColor(s.onSurface), onSurfaceVariant = themeColor(s.onSurfaceVariant),
    surfaceVariant = themeColor(s.surfaceVariant), surfaceContainerHigh = themeColor(s.surfaceContainerHigh),
    surfaceContainerHighest = themeColor(s.surfaceContainerHighest), outline = themeColor(s.outline), outlineVariant = themeColor(s.outlineVariant),
)

/** Historical wrapper now preserves the single app theme and Agent scope. */
@Composable
internal fun OrbisMaterialTheme(content: @Composable () -> Unit) = content()
