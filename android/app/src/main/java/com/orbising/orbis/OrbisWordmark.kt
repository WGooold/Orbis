package com.orbising.orbis

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** The same three-layer engraved wordmark used by the Windows host. */
@Composable
internal fun OrbisWordmark(modifier: Modifier = Modifier) {
    val colors = rememberNeumorphColors()
    val dark = LocalOrbisDarkTheme.current
    val relief = 1.8.dp
    val type = MaterialTheme.typography.titleLarge.copy(
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.sp,
    )
    // The face carries the contrast (about 6:1 on the base); the walls stay a soft relief around it.
    val face = MaterialTheme.colorScheme.onSurface
    val darkWall = colors.darkShadow.copy(alpha = if (dark) 0.9f else 0.6f)
    val lightWall = colors.lightShadow.copy(alpha = 0.92f)

    // Keep one semantic Text node while the two wall layers remain purely visual.
    Box(modifier = modifier.padding(end = relief, bottom = relief)) {
        Text(
            text = "Orbis",
            style = type.copy(color = darkWall),
            modifier = Modifier.clearAndSetSemantics {},
        )
        Text(
            text = "Orbis",
            style = type.copy(color = lightWall),
            modifier = Modifier
                .clearAndSetSemantics {}
                .offset(x = relief, y = relief),
        )
        Text(
            text = "Orbis",
            style = type.copy(color = face),
            modifier = Modifier.offset(x = relief / 2, y = relief / 2),
        )
    }
}
