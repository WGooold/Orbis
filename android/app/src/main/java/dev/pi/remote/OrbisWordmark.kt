package dev.pi.remote

import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** Engraved lettering: a shadow inside the upper-left wall and a lit lower-right lip. */
@Composable
internal fun OrbisWordmark(modifier: Modifier = Modifier) {
    val colors = rememberNeumorphColors()
    val dark = isSystemInDarkTheme()
    val ink = lerp(MaterialTheme.colorScheme.onSurfaceVariant, colors.base, 0.18f)
    val innerDark = if (dark) colors.darkShadow.copy(alpha = 0.85f) else Color(0xFF232A36).copy(alpha = 0.65f)
    val innerLight = Color.White.copy(alpha = if (dark) 0.45f else 0.90f)
    val lip = with(LocalDensity.current) { 0.7.dp.toPx() }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }

    // Keep a real Text node for font scaling, baseline alignment and accessibility.
    Text(
        text = "Orbis",
        maxLines = 1,
        softWrap = false,
        onTextLayout = { layout = it },
        style = MaterialTheme.typography.titleLarge.copy(
            fontWeight = FontWeight.Bold,
            color = ink,
            shadow = Shadow(
                color = Color.White.copy(alpha = if (dark) 0.18f else 0.95f),
                offset = Offset(lip, lip),
                blurRadius = lip * 0.6f,
            ),
        ),
        modifier = modifier.drawWithCache {
            val textLayout = layout
            // Cache the small glyph masks by layout/theme/density, never per frame. Software
            // rasterization also keeps the blur consistent on our API 26/27 devices.
            val shadows = textLayout?.takeIf { it.size.width > 0 && it.size.height > 0 }?.let {
                val mask = Bitmap.createBitmap(it.size.width, it.size.height, Bitmap.Config.ARGB_8888)
                it.multiParagraph.paint(
                    canvas = Canvas(android.graphics.Canvas(mask)),
                    color = Color.White,
                    shadow = Shadow.None,
                )
                val offset = 0.85.dp.toPx()
                val blur = 0.65.dp.toPx()
                insetLetterShadow(mask, innerDark, offset, blur).asImageBitmap() to
                    insetLetterShadow(mask, innerLight, -offset, blur).asImageBitmap()
            }
            onDrawWithContent {
                drawContent()
                shadows?.let { (darkShadow, lightShadow) ->
                    drawImage(darkShadow)
                    drawImage(lightShadow)
                }
            }
        },
    )
}

private fun insetLetterShadow(mask: Bitmap, color: Color, offset: Float, blur: Float): Bitmap {
    val shadow = Bitmap.createBitmap(mask.width, mask.height, Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(shadow)
    canvas.drawColor(color.toArgb())
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_OUT)
        maskFilter = BlurMaskFilter(blur, BlurMaskFilter.Blur.NORMAL)
    }
    // Subtract the shifted letters from a solid field, then clip to the original glyphs.
    // Positive offset leaves the dark inner edge at the top/left, including letter counters.
    canvas.drawBitmap(mask, offset, offset, paint)
    paint.maskFilter = null
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_IN)
    canvas.drawBitmap(mask, 0f, 0f, paint)
    return shadow
}
