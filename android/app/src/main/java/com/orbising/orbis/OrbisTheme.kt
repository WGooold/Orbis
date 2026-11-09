package com.orbising.orbis

import android.app.Activity
import android.graphics.drawable.ColorDrawable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineBreak
import androidx.core.view.WindowCompat

/** Four appearance themes share semantic roles; every screen inherits one material. */
private val NeumorphShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RemoteUi.ControlShape,
    large = RemoteUi.CardShape,
    extraLarge = RoundedCornerShape(32.dp),
)

internal val LocalOrbisDarkTheme = staticCompositionLocalOf { false }

/** One window owner chooses the visible page color; retained underlays never write the bars. */
@Composable
internal fun OrbisSystemBars(surface: Color, darkTheme: Boolean) {
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.setBackgroundDrawable(ColorDrawable(surface.toArgb()))
            window.statusBarColor = surface.toArgb()
            window.navigationBarColor = surface.toArgb()
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }
}

@Composable
fun OrbisTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    manageWindow: Boolean = true,
    content: @Composable () -> Unit,
) {
    val resolvedDark = AppAppearance.mode.resolve(darkTheme)
    val palette = orbisPalette(resolvedDark, AppAppearance.material)
    val sourceColors = if (resolvedDark) darkColorScheme() else lightColorScheme()
    val colors = animateOrbisScheme(orbisMaterialColorScheme(sourceColors, resolvedDark, AppAppearance.material))
    val material = animateOrbisMaterial(palette.material)
    if (manageWindow) OrbisSystemBars(colors.surface, resolvedDark)
    CompositionLocalProvider(
        LocalOrbisDarkTheme provides resolvedDark,
        LocalNeumorphColors provides material,
        LocalOrbisPalette provides palette,
        LocalContentColor provides colors.onSurface,
    ) {
        MaterialTheme(
            colorScheme = colors,
            typography = Typography().run {
                fun TextStyle.type(size: Int, height: Int, weight: FontWeight = FontWeight.Normal) =
                    copy(fontSize = size.sp, lineHeight = height.sp, fontWeight = weight,
                        fontFeatureSettings = "tnum", lineBreak = LineBreak.Paragraph)
                copy(
                    displayLarge = displayLarge.type(28, 34, FontWeight.SemiBold),
                    displayMedium = displayMedium.type(28, 34, FontWeight.SemiBold),
                    displaySmall = displaySmall.type(28, 34, FontWeight.SemiBold),
                    headlineLarge = headlineLarge.type(20, 28, FontWeight.SemiBold),
                    headlineMedium = headlineMedium.type(20, 28, FontWeight.SemiBold),
                    headlineSmall = headlineSmall.type(20, 28, FontWeight.SemiBold),
                    titleLarge = titleLarge.type(20, 28, FontWeight.SemiBold),
                    titleMedium = titleMedium.type(15, 24, FontWeight.SemiBold),
                    titleSmall = titleSmall.type(13, 20, FontWeight.SemiBold),
                    bodyLarge = bodyLarge.type(15, 24),
                    bodyMedium = bodyMedium.type(15, 24),
                    bodySmall = bodySmall.type(13, 20),
                    labelLarge = labelLarge.type(15, 24, FontWeight.SemiBold),
                    labelMedium = labelMedium.type(13, 20),
                    labelSmall = labelSmall.type(12, 18),
                )
            },
            shapes = NeumorphShapes,
            content = content,
        )
    }
}
