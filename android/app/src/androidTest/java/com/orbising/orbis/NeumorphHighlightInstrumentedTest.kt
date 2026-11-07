// S30: prevent a near-white highlight ridge and retain a tinted, gradually fading raised edge.
package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class NeumorphHighlightInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    @Test fun lightHighlightBlendsIntoItsSageGround() = exercise(false)
    @Test fun darkHighlightDoesNotBecomeABrightRim() = exercise(true)

    private fun exercise(dark: Boolean) {
        val material = orbisMaterialColors(dark)
        val previous = material.copy(
            lightShadow = if (dark) Color(0xFF475156) else Color(0xFFF8FFF4),
            lightShadowOpacity = if (dark) 0.88f else 0.85f,
            lightShadowBlurScale = 1f,
        )
        compose.setContent {
            OrbisTheme(darkTheme = dark) {
                Column(Modifier.fillMaxSize().background(material.base).padding(32.dp)) {
                    for ((name, colors) in listOf("previous" to previous, "corrected" to material)) {
                        Box(Modifier.fillMaxWidth().height(144.dp).padding(24.dp), contentAlignment = Alignment.Center) {
                            CompositionLocalProvider(LocalNeumorphColors provides colors) {
                                NeumorphSurface(modifier = Modifier.fillMaxWidth().height(72.dp).testTag("highlight-$name"),
                                    shape = RoundedCornerShape(24.dp), shadowScale = 1.1f) {}
                            }
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val image = compose.onRoot().captureToImage().asAndroidBitmap()
        val base = (material.base.red + material.base.green + material.base.blue) * 255f / 3f
        fun brightness(pixel: Int) = (android.graphics.Color.red(pixel) + android.graphics.Color.green(pixel) + android.graphics.Color.blue(pixel)) / 3f
        val profiles = listOf("previous", "corrected").associateWith { name ->
            val bounds = compose.onNodeWithTag("highlight-$name").fetchSemanticsNode().boundsInRoot
            val x = (bounds.center.x - root.left).toInt()
            (1..(20 * compose.density.density).toInt()).map { distance ->
                brightness(image.getPixel(x, (bounds.top - root.top).toInt() - distance)) - base
            }
        }
        val before = profiles.getValue("previous")
        val after = profiles.getValue("corrected")
        assertTrue("Corrected highlight must remain visible: $after", after.max() > 0.8f)
        assertTrue("Highlight must not form a white rim: $after", after.max() < if (dark) 14f else 11f)
        assertTrue("Peak highlight must fall substantially: before=$before after=$after", before.max() > after.max() * 1.5f)
        assertTrue("The highlight must fade back into the ground", kotlin.math.abs(after.last()) < 1.1f)
        // Both samples use identical geometry: the old parameters remain the regression control.
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.getExternalFilesDir(null), "highlight-${if (dark) "dark" else "light"}-before-after.png").outputStream().use {
            image.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        File(context.getExternalFilesDir(null), "highlight-${if (dark) "dark" else "light"}-profile.txt")
            .writeText("previous=$before\ncorrected=$after\n")
    }
}
