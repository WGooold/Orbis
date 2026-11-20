package com.orbising.orbis

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** SC119: prove that the actual isolated Android reader displays a static memory document. */
class ChatFilePreviewRendererTest {
    @get:Rule val compose = createComposeRule()

    @Test fun displaysStaticDocumentWithoutFileNetworkOrScriptAccess() {
        val loaded = AtomicBoolean(false)
        val failed = AtomicBoolean(false)
        lateinit var surface: FrameLayout
        val html = """<!doctype html><html><head><title>Orbis preview fixture</title></head>
            <body><h1>Static report</h1><svg viewBox="0 0 160 80" width="160" height="80"><rect width="160" height="80" fill="#008000"/></svg></body></html>"""
        val document = html.toByteArray(Charsets.UTF_8)
        compose.setContent {
            AndroidView(factory = { FrameLayout(it).also { container ->
                surface = container
                PreviewWebOwner.load(container, document, fullScreen = false, loaded = { loaded.set(true) }, failed = { failed.set(true) })
            } }, modifier = Modifier.size(320.dp, 240.dp), onRelease = PreviewWebOwner::release, update = {})
        }
        try {
            compose.waitUntil(8_000) { loaded.get() || failed.get() }
            val bounds = compose.runOnIdle {
                assertFalse(failed.get())
                val web = surface.getChildAt(0) as WebView
                assertEquals("Orbis preview fixture", web.title)
                assertTrue(web.settings.blockNetworkLoads)
                assertFalse(web.settings.javaScriptEnabled)
                assertFalse(web.settings.allowFileAccess)
                assertFalse(web.settings.allowContentAccess)
                assertFalse(web.settings.domStorageEnabled)
                assertFalse(web.isVerticalScrollBarEnabled)
                val position = IntArray(2).also(surface::getLocationOnScreen)
                Rect(position[0], position[1], position[0] + surface.width, position[1] + surface.height)
            }
            // onPageFinished proves navigation, not paint. Check the distinctive SVG fill in the actual window.
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            var painted: Bitmap? = null
            compose.waitUntil(5_000) {
                val screenshot = instrumentation.uiAutomation.takeScreenshot() ?: return@waitUntil false
                var green = 0
                for (y in bounds.top.coerceAtLeast(0) until bounds.bottom.coerceAtMost(screenshot.height) step 4) {
                    for (x in bounds.left.coerceAtLeast(0) until bounds.right.coerceAtMost(screenshot.width) step 4) {
                        val pixel = screenshot.getPixel(x, y)
                        if (Color.red(pixel) < 20 && Color.green(pixel) in 110..145 && Color.blue(pixel) < 20) green++
                    }
                }
                if (green >= 16) { painted = screenshot; true } else { screenshot.recycle(); false }
            }
            val bitmap = checkNotNull(painted)
            try {
                java.io.File(instrumentation.targetContext.getExternalFilesDir(null), "SC119-static-preview.png").outputStream().use {
                    assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it))
                }
            } finally { bitmap.recycle() }
        } finally {
            compose.runOnIdle { PreviewWebOwner.release(surface) }
        }
    }
}
