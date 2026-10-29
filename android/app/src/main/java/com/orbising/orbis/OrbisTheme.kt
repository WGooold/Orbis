package com.orbising.orbis

import android.app.Activity
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

/**
 * 新拟物主题：页面与**控件**共用同一块软底板（见 Neumorph.kt），
 * 层次感来自 NeumorphSurface 的双向柔影，Material 组件退居配角
 * （容器色=底板、大圆角、弱化描边）。
 *
 * 控件和独立内容面都使用新拟物；内容面阴影更浅，嵌套区域凹陷。连续画布与文字保持平面。
 * 会话内通过 AgentTheme 区分 Pi/Codex 的强调色，软底板与明暗主题保持一致。
 */
private val LightColors = lightColorScheme(
    primary = Color(0xFF2459D3),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD8E2FA),
    onPrimaryContainer = Color(0xFF1D3B7E),
    secondary = Color(0xFF4A5563),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFDDE3EF),
    onSecondaryContainer = Color(0xFF2A323D),
    tertiary = Color(0xFF1B7A57),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFCDEEDF),
    onTertiaryContainer = Color(0xFF0B4230),
    error = Color(0xFFB3261E),
    errorContainer = Color(0xFFF5DCDA),
    // 页面地面 = NeumorphColors.Light.base（#E6EBF4）。柔影的前提是「控件和地面是同一块
    // 材质」，主题底色若和底板差几个色阶，凸起/凹陷的对比就跟设计稿对不上了。
    background = Color(0xFFE6EBF4),
    onBackground = Color(0xFF232A36),
    surface = Color(0xFFE6EBF4),
    onSurface = Color(0xFF232A36),
    surfaceVariant = Color(0xFFDDE3EF),
    onSurfaceVariant = Color(0xFF4A5364),
    outline = Color(0xFF8A93A5),
    outlineVariant = Color(0xFFC9D1DE),
    // M3 的 surfaceContainer 系列不会从上面给的自定义色派生，缺省是基线紫灰——
    // 对话框/底部弹层/下拉菜单全在用它，必须在蓝灰家族里显式补齐。
    surfaceTint = Color(0xFFE6EBF4),
    surfaceDim = Color(0xFFDDE3EF),
    surfaceBright = Color(0xFFF3F6FB),
    surfaceContainerLowest = Color(0xFFDDE3EF),
    surfaceContainerLow = Color(0xFFE6EBF4),
    surfaceContainer = Color(0xFFE6EBF4),
    surfaceContainerHigh = Color(0xFFEDF1F8),
    surfaceContainerHighest = Color(0xFFF3F6FB),
    inverseSurface = Color(0xFF2A323D),
    inverseOnSurface = Color(0xFFEFF3FA),
    scrim = Color(0xFF2A3344),
    inversePrimary = Color(0xFFA9C0FF),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFA9C0FF),
    onPrimary = Color(0xFF12307A),
    primaryContainer = Color(0xFF2A4488),
    onPrimaryContainer = Color(0xFFD8E2FA),
    secondary = Color(0xFFB4BECC),
    onSecondary = Color(0xFF20262F),
    secondaryContainer = Color(0xFF313845),
    onSecondaryContainer = Color(0xFFD5DEEB),
    tertiary = Color(0xFF84D6B3),
    onTertiary = Color(0xFF003927),
    tertiaryContainer = Color(0xFF14513A),
    onTertiaryContainer = Color(0xFFA8E8CE),
    error = Color(0xFFFFB4AB),
    errorContainer = Color(0xFF6E201B),
    // 同上：暗色地面 = NeumorphColors.Dark.base（#23262E）。
    background = Color(0xFF23262E),
    onBackground = Color(0xFFDDE1E9),
    surface = Color(0xFF23262E),
    onSurface = Color(0xFFDDE1E9),
    surfaceVariant = Color(0xFF313845),
    onSurfaceVariant = Color(0xFFB8C0CE),
    outline = Color(0xFF7E8695),
    outlineVariant = Color(0xFF3A4150),
    surfaceTint = Color(0xFF23262E),
    surfaceDim = Color(0xFF1C1F26),
    surfaceBright = Color(0xFF2F333D),
    surfaceContainerLowest = Color(0xFF1C1F26),
    surfaceContainerLow = Color(0xFF23262E),
    surfaceContainer = Color(0xFF23262E),
    surfaceContainerHigh = Color(0xFF292D36),
    surfaceContainerHighest = Color(0xFF2F333D),
    inverseSurface = Color(0xFFDDE1E9),
    inverseOnSurface = Color(0xFF20242C),
    scrim = Color(0xFF0A0C11),
    inversePrimary = Color(0xFF2459D3),
)

/** 控件 16dp、卡片 20dp、弹层 28dp，保持同一套圆角层级。 */
private val NeumorphShapes = Shapes(
    extraSmall = RoundedCornerShape(10.dp),
    small = RoundedCornerShape(12.dp),
    medium = RemoteUi.ControlShape,
    large = RemoteUi.CardShape,
    extraLarge = RoundedCornerShape(32.dp),
)

internal val LocalOrbisDarkTheme = staticCompositionLocalOf { false }

@Composable
fun OrbisTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (darkTheme) DarkColors else LightColors
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colors.surface.toArgb()
            window.navigationBarColor = colors.surface.toArgb()
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }
    CompositionLocalProvider(LocalOrbisDarkTheme provides darkTheme, LocalContentColor provides colors.onSurface) {
        MaterialTheme(
            colorScheme = colors,
            typography = Typography().run {
                fun TextStyle.type(size: Int, height: Int, weight: FontWeight = fontWeight ?: FontWeight.Normal) =
                    copy(fontSize = size.sp, lineHeight = height.sp, fontWeight = weight,
                        fontFeatureSettings = "tnum", lineBreak = LineBreak.Paragraph)
                copy(
                    displayLarge = displayLarge.type(20, 28, FontWeight.SemiBold),
                    displayMedium = displayMedium.type(20, 28, FontWeight.SemiBold),
                    displaySmall = displaySmall.type(20, 28, FontWeight.SemiBold),
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
