package com.orbising.orbis

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** SC119 / SC128: the actual Android reader runs the original page offline and loads only its own files. */
class ChatFilePreviewRendererTest {
    @get:Rule val compose = createComposeRule()

    @Test fun runsTheOriginalPageWithItsOwnFilesAndNoNetwork() {
        val failed = AtomicBoolean(false)
        val captured = AtomicReference<Bitmap?>()
        lateinit var surface: FrameLayout
        lateinit var host: PreviewTestHost
        compose.setContent {
            val scope = rememberCoroutineScope()
            host = remember(scope) { PreviewTestHost(scope) }
            AndroidView(factory = { FrameLayout(it).also { container -> surface = container } },
                modifier = Modifier.size(320.dp, 240.dp), onRelease = PreviewWebOwner::release, update = {})
        }
        val key = ChatFilePreview.Key("session", "report:0", host.source, "report.html")
        compose.runOnIdle { host.preview.open(key) }
        compose.waitUntil(5_000) { host.preview.selection.value?.phase == ChatFilePreview.Phase.READY }
        val selection = checkNotNull(host.preview.selection.value)
        compose.runOnIdle {
            PreviewWebOwner.load(surface, checkNotNull(selection.entry), fullScreen = false,
                resources = { path, done -> host.preview.resource(selection.id, path, done) },
                painted = {}, captured = { captured.set(it) }, failed = { failed.set(true) })
        }
        try {
            compose.waitUntil(10_000) { failed.get() || compose.runOnIdle { (surface.getChildAt(0) as? WebView)?.title?.let { "blocked" in it && "img" in it } == true } }
            val bounds = compose.runOnIdle {
                assertFalse(failed.get())
                val web = surface.getChildAt(0) as WebView
                assertEquals(setOf("ran", "no-rtc", "blocked", "img"), web.title.orEmpty().split("|").toSet())
                assertEquals(setOf("style.css", "app.js", "pixel.png"), host.requested.toSet())
                assertTrue(web.settings.javaScriptEnabled)
                assertTrue(web.settings.blockNetworkLoads)
                assertFalse(web.settings.allowFileAccess)
                assertFalse(web.settings.allowContentAccess)
                assertFalse(web.isVerticalScrollBarEnabled)
                val position = IntArray(2).also(surface::getLocationOnScreen)
                Rect(position[0], position[1], position[0] + surface.width, position[1] + surface.height)
            }
            // A stylesheet from a sibling file paints the fixture's fill in the actual window.
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            var painted: Bitmap? = null
            compose.waitUntil(5_000) {
                val screenshot = instrumentation.uiAutomation.takeScreenshot() ?: return@waitUntil false
                if (green(screenshot, bounds) >= 16) { painted = screenshot; true } else { screenshot.recycle(); false }
            }
            compose.waitUntil(5_000) { captured.get() != null }
            val card = checkNotNull(captured.get())
            assertTrue(green(card, Rect(0, 0, card.width, card.height)) >= 16)
            val directory = instrumentation.targetContext.getExternalFilesDir(null)
            for ((name, bitmap) in listOf("SC128-original-page.png" to checkNotNull(painted), "SC128-card-image.png" to card)) {
                java.io.File(directory, name).outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            }
            painted?.recycle()
        } finally {
            compose.runOnIdle { PreviewWebOwner.release(surface); host.preview.close() }
        }
    }

    private fun green(bitmap: Bitmap, bounds: Rect): Int {
        var green = 0
        for (y in bounds.top.coerceAtLeast(0) until bounds.bottom.coerceAtMost(bitmap.height) step 4) {
            for (x in bounds.left.coerceAtLeast(0) until bounds.right.coerceAtMost(bitmap.width) step 4) {
                val pixel = bitmap.getPixel(x, y)
                if (Color.red(pixel) < 20 && Color.green(pixel) in 110..145 && Color.blue(pixel) < 20) green++
            }
        }
        return green
    }
}
