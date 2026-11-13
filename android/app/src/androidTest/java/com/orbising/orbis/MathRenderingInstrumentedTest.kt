package com.orbising.orbis

import android.app.Activity
import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** MATH-01: exercise actual offline WebView, native table measurement, source copy and streaming. */
class MathRenderingInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun views(): List<IsolatedMathWebView> {
        var result = emptyList<IsolatedMathWebView>()
        instrumentation.runOnMainSync {
            fun collect(view: View): List<IsolatedMathWebView> =
                if (view is IsolatedMathWebView) listOf(view)
                else if (view is ViewGroup) (0 until view.childCount).flatMap { collect(view.getChildAt(it)) }
                else emptyList()
            result = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .flatMap { collect((it as Activity).window.decorView) }
        }
        return result
    }
    private fun evaluate(view: IsolatedMathWebView, expression: String): JsonElement {
        val latch = CountDownLatch(1)
        var result = "null"
        instrumentation.runOnMainSync { view.evaluateJavascript(expression) { result = it; latch.countDown() } }
        assertTrue("JavaScript response", latch.await(10, TimeUnit.SECONDS))
        return Json.parseToJsonElement(result)
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        // DOM completion and native height do not guarantee that Chromium's texture was drawn.
        views().forEach { view ->
            val painted = CountDownLatch(1)
            instrumentation.runOnMainSync {
                view.postVisualStateCallback(0, object : android.webkit.WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) { painted.countDown() }
                })
            }
            assertTrue("WebView visual state", painted.await(10, TimeUnit.SECONDS))
        }
        instrumentation.waitForIdleSync()
        val image = instrumentation.uiAutomation.takeScreenshot()
        File(instrumentation.targetContext.getExternalFilesDir(null), "$name.png").outputStream().use {
            image.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }
    private fun shown(views: List<IsolatedMathWebView>): Boolean {
        var shown = false
        instrumentation.runOnMainSync { shown = views.all { it.height > 10 } }
        return shown
    }
    @Test fun nativeParagraphAndTableRenderChineseAndPreserveFormulaSource() {
        val source = """
            **相邻变化** \(\Delta S=S_B-S_A\) 与参考值。

            \[
            \begin{aligned}\text{相邻变化：}\quad &\hat d_t=g_\theta(X_t)-g_\theta(X_{t-1})\\
            \text{相对基线：}\quad &\hat R_t=g_\theta(X_t)-g_\theta(X_0)\end{aligned}
            \]

            | 方式 | 公式 |
            |---|---|
            | 加权分 | \(\sum w_i R_i/15+|x|\) |

            \[\begin{pmatrix}1&2\\3&4\end{pmatrix}\]
        """.trimIndent()
        compose.setContent { MaterialTheme { Column(Modifier.width(360.dp).padding(16.dp)) { MarkdownText(source) {} } } }
        compose.waitUntil(20000) { views().size == 4 && shown(views()) && views().all { view -> evaluate(view, "document.querySelectorAll('.katex').length").jsonPrimitive.intOrNull?.let { it > 0 } == true } }
        val web = views().first()
        assertTrue(evaluate(web, "document.getElementById('content').getBoundingClientRect().height").jsonPrimitive.double > 15)
        val copied = evaluate(web, """
            (function(){
              var formula=document.querySelector('[data-raw]'), node=formula.querySelector('.katex-html .mord').firstChild;
              var r=document.createRange();r.selectNodeContents(node);
              var s=getSelection();s.removeAllRanges();s.addRange(r);
              var e=new Event('copy',{cancelable:true});var copied='';
              Object.defineProperty(e,'clipboardData',{value:{setData:function(_,value){copied=value;}}});
              document.dispatchEvent(e);s.removeAllRanges();return copied;
            })()
        """.trimIndent()).jsonPrimitive.content
        assertEquals("\\(\\Delta S=S_B-S_A\\)", copied)
        capture("math-native-paragraph-table")
    }
    @Test fun streamingCompletionAndInvalidCommandsRemainVisible() {
        val source = mutableStateOf("Before \\(\\frac{a}")
        compose.setContent { MaterialTheme { Column(Modifier.width(320.dp).padding(16.dp)) { MarkdownText(source.value) {} } } }
        compose.runOnIdle { source.value = "Before \\(\\frac{a}{b}\\) after" }
        compose.waitUntil(20000) { views().size == 1 && shown(views()) && evaluate(views().single(), "document.querySelectorAll('.katex').length").jsonPrimitive.intOrNull == 1 }
        compose.runOnIdle { source.value += " \\(\\unknownCommand{x}\\)" }
        compose.waitUntil(10000) { evaluate(views().single(), "document.querySelectorAll('.math-fallback').length").jsonPrimitive.intOrNull == 1 }
        assertTrue(evaluate(views().single(), "document.querySelector('.math-fallback').textContent").jsonPrimitive.content.contains("\\unknownCommand"))
        assertFalse(evaluate(views().single(), "document.documentElement.scrollWidth>innerWidth").jsonPrimitive.boolean)
        capture("math-stream-fallback")
    }
}
