package com.orbising.orbis

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color

// S18 / S30 share one continuous material, including recessed identity and search wells.
// A darker solid inset fill reads as a separate slab; depth comes from the paired shadows.
private val SageDrawerMaterial = NeumorphColors(
    base = Color(0xFFE0E7DF), insetBase = Color(0xFFE0E7DF),
    lightShadow = Color(0xFFEEF2EB), darkShadow = Color(0xFFBAC7B8),
    lift = Color(0xFFE8EEE5), top = Color(0xFFF0F5ED), scrim = Color(0xFF203626),
    darkShadowOpacity = 0.62f, lightShadowOpacity = 0.52f, lightShadowBlurScale = 1.8f,
)
private val GraphiteDrawerMaterial = NeumorphColors(
    base = Color(0xFF33393D), insetBase = Color(0xFF33393D),
    lightShadow = Color(0xFF475156), darkShadow = Color(0xFF20282B),
    lift = Color(0xFF3A4246), top = Color(0xFF424B50), scrim = Color(0xFF0F171A),
    darkShadowOpacity = 0.68f, lightShadowOpacity = 0.55f, lightShadowBlurScale = 1.8f,
)

internal fun orbisMaterialColors(dark: Boolean): NeumorphColors =
    if (dark) GraphiteDrawerMaterial else SageDrawerMaterial

/** Reuse exactly the approved home/drawer palette on every native screen. */
internal fun orbisMaterialColorScheme(source: ColorScheme, dark: Boolean): ColorScheme {
    val material = orbisMaterialColors(dark)
    val ink = if (dark) Color(0xFFEFF3F0) else Color(0xFF354A3C)
    val muted = if (dark) Color(0xFFBAC7C2) else Color(0xFF6E8171)
    val accent = if (dark) Color(0xFFA9DDC1) else Color(0xFF56775B)
    return source.copy(
        primary = accent,
        onPrimary = if (dark) Color(0xFF203D2E) else Color.White,
        primaryContainer = if (dark) Color(0xFF40564A) else Color(0xFFCFDDCA),
        onPrimaryContainer = ink,
        secondary = muted, onSecondary = material.base,
        secondaryContainer = material.lift, onSecondaryContainer = ink,
        tertiary = if (dark) Color(0xFFA9DDC1) else Color(0xFF54754F),
        tertiaryContainer = material.lift, onTertiaryContainer = ink,
        background = material.base, onBackground = ink,
        surface = material.base, onSurface = ink,
        surfaceVariant = material.insetBase, onSurfaceVariant = muted,
        outline = if (dark) Color(0xFF9BB0A7) else Color(0xFF93A493),
        outlineVariant = if (dark) Color(0xFF4A5653) else Color(0xFFC7D1C5),
        surfaceTint = material.base,
        surfaceDim = material.insetBase, surfaceBright = material.top,
        surfaceContainerLowest = material.insetBase,
        surfaceContainerLow = material.base, surfaceContainer = material.base,
        surfaceContainerHigh = material.lift, surfaceContainerHighest = material.top,
        inverseSurface = ink, inverseOnSurface = material.base,
        inversePrimary = if (dark) Color(0xFF56775B) else Color(0xFFBFD5B7),
        scrim = material.scrim,
    )
}

/** Share the approved soft material without altering sibling pages or agent brand colors. */
@Composable
internal fun OrbisMaterialTheme(content: @Composable () -> Unit) {
    val dark = LocalOrbisDarkTheme.current
    val material = orbisMaterialColors(dark)
    val ink = if (dark) Color(0xFFEFF3F0) else Color(0xFF354A3C)
    val scheme = orbisMaterialColorScheme(MaterialTheme.colorScheme, dark)
    CompositionLocalProvider(LocalNeumorphColors provides material, LocalContentColor provides ink) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
