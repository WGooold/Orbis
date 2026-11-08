package com.orbising.orbis

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

internal enum class OrbisMaterial { Mist, Sage }
internal enum class OrbisAppearanceMode {
    System, Light, Dark;
    fun resolve(systemDark: Boolean) = when (this) { System -> systemDark; Light -> false; Dark -> true }
}

/** Appearance changes never recreate the Activity or disturb the live connection. */
internal object AppAppearance {
    var material by mutableStateOf(OrbisMaterial.Mist)
        private set
    var mode by mutableStateOf(OrbisAppearanceMode.System)
        private set
    private var preferences: android.content.SharedPreferences? = null
    fun configure(context: Context) {
        preferences = context.applicationContext.getSharedPreferences("orbis-appearance", Context.MODE_PRIVATE)
        material = OrbisMaterial.entries.firstOrNull { it.name == preferences?.getString("material", null) } ?: OrbisMaterial.Mist
        mode = OrbisAppearanceMode.entries.firstOrNull { it.name == preferences?.getString("mode", null) } ?: OrbisAppearanceMode.System
    }
    fun selectMaterial(value: OrbisMaterial) { material = value; preferences?.edit()?.putString("material", value.name)?.apply() }
    fun selectMode(value: OrbisAppearanceMode) { mode = value; preferences?.edit()?.putString("mode", value.name)?.apply() }
}

internal data class OrbisPalette(
    val material: NeumorphColors,
    val ink: Color, val muted: Color, val faint: Color, val hairline: Color,
    val accent: Color, val accentSoft: Color, val onAccent: Color,
    val success: Color, val warning: Color, val danger: Color,
)

/** 2026-11-08 design tokens. Insets use their parent face, never a darker private well. */
internal fun orbisPalette(dark: Boolean, appearance: OrbisMaterial = OrbisMaterial.Mist): OrbisPalette {
    val sage = appearance == OrbisMaterial.Sage
    fun value(mistLight: Long, mistDark: Long, sageLight: Long = mistLight, sageDark: Long = mistDark) =
        Color(if (sage) { if (dark) sageDark else sageLight } else { if (dark) mistDark else mistLight })
    val base = value(0xFFE6EBF4, 0xFF23262E, 0xFFE0E7DF, 0xFF33393D)
    return OrbisPalette(
        material = NeumorphColors(base = base, insetBase = base,
            lift = value(0xFFEDF1F8, 0xFF292D36, 0xFFE8EEE5, 0xFF3A4246),
            top = value(0xFFF3F6FB, 0xFF2F333D, 0xFFF0F5ED, 0xFF424B50),
            lightShadow = value(0xFFFFFFFF, 0xFF343946, 0xFFF8FBF5, 0xFF4A555A),
            darkShadow = value(0xFFA6B2C6, 0xFF0A0C11, 0xFFB2C0B0, 0xFF1C2427),
            scrim = value(0xFF2A3344, 0xFF05070A, 0xFF203626, 0xFF0B1214),
            darkShadowOpacity = if (dark) 0.70f else if (sage) 0.65f else 0.55f,
            lightShadowOpacity = if (sage && dark) 0.70f else if (dark || sage) 0.80f else 0.90f),
        ink = value(0xFF232A36, 0xFFDDE1E9, 0xFF2F4235, 0xFFEFF3F0),
        muted = value(0xFF4A5364, 0xFFB8C0CE, 0xFF4F6153, 0xFFBAC7C2),
        faint = value(0xFF737D90, 0xFF858D9C, 0xFF6E7F6F, 0xFF8E9C97),
        hairline = value(0xFFC9D1DE, 0xFF3A4150, 0xFFC7D1C5, 0xFF4A5653),
        accent = value(0xFF2F5287, 0xFFAFC6E6, 0xFF41603F, 0xFFA9DDC1),
        accentSoft = value(0xFFD0D9E7, 0xFF343944, 0xFFD3DCD2, 0xFF414D4D),
        onAccent = value(0xFFFFFFFF, 0xFF16233A, 0xFFFFFFFF, 0xFF173322),
        success = value(0xFF1A6A4D, 0xFF84D6B3, 0xFF1A6A4D, 0xFF8FDDB8),
        warning = value(0xFF845000, 0xFFF2C26B), danger = value(0xFFAD241C, 0xFFFFB4AB),
    )
}
internal val LocalOrbisPalette = staticCompositionLocalOf { orbisPalette(false) }
