// Orbis 测试用途（场景与判定见本文件断言）：
// - r24 整页导航（M07、M08、M14、V17、V18）
package com.orbising.orbis

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** M14: the navigation boundary supplies the same behavior to every full page. */
class PageNavigationInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    private class IsolatedApplication(base: Context) : Application() {
        private val prefix = "page-navigation-${UUID.randomUUID()}"
        private val root = File(base.filesDir, prefix).apply { mkdirs() }
        private val preferences = mutableSetOf<String>()
        init { attachBaseContext(base) }
        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = root
        override fun getCacheDir(): File = File(root, "cache").apply { mkdirs() }
        override fun getNoBackupFilesDir(): File = File(root, "no-backup").apply { mkdirs() }
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
            val isolated = "$prefix-$name"
            preferences += isolated
            return baseContext.getSharedPreferences(isolated, mode)
        }
        fun dispose() { preferences.forEach { baseContext.deleteSharedPreferences(it) }; root.deleteRecursively() }
    }

    private fun withModel(block: (RemoteViewModel) -> Unit) {
        val app = IsolatedApplication(ApplicationProvider.getApplicationContext())
        val owner = ViewModelStore()
        val model = RemoteViewModel(app)
        owner.put("pages", model)
        try { block(model) } finally { compose.runOnIdle { owner.clear() }; app.dispose() }
    }

    private fun swipeBack() = compose.onRoot().performTouchInput {
        swipeRight(startX = width * 0.15f, endX = width * 0.9f, durationMillis = 600)
    }

    private fun cancelAndCheck(title: String, shot: String) {
        val original = compose.onNodeWithText(title).fetchSemanticsNode().boundsInRoot.left
        compose.onRoot().performTouchInput {
            down(Offset(width * 0.15f, height * 0.6f))
            moveTo(Offset(width * 0.30f, height * 0.6f), 600)
        }
        assertTrue(compose.onNodeWithText(title).fetchSemanticsNode().boundsInRoot.left - original > 20f)
        capture(shot)
        compose.onRoot().performTouchInput { advanceEventTime(300); up() }
        compose.onNodeWithText(title).assertIsDisplayed()
        assertEquals(original, compose.onNodeWithText(title).fetchSemanticsNode().boundsInRoot.left, 1f)
    }

    @Test fun addComputerUsesThePageTransitionAndReturnsToTheRetainedDirectory() = withModel { model ->
        val state = RemoteState(hostId = "fixture-host", deviceId = "fixture-device").withReadyHomeFixture()
        val pairing = HostPairing("fixture-host", "Fixture computer", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "fixture-device", credential = "test-only")
        compose.setContent {
            OrbisTheme(darkTheme = false) { RemoteApp(state, listOf(HostSnapshot(pairing, state)), null, false, model) }
        }
        compose.onNodeWithContentDescription("打开会话目录").performClick()
        compose.onNodeWithText("电脑").performClick()
        compose.onNodeWithText("添加电脑").performClick()
        compose.onNodeWithText("连接你的电脑").assertIsDisplayed()
        cancelAndCheck("连接你的电脑", "pairing-drag-light")
        systemBack()
        // The source directory stays mounted and can open the same page again immediately.
        compose.onNodeWithText("电脑").assertIsDisplayed().performClick()
        compose.onNodeWithText("添加电脑").performClick()
        swipeBack()
        compose.onNodeWithText("电脑").performClick()
        compose.onNodeWithText("添加电脑").performClick()
        compose.onNodeWithContentDescription("取消添加电脑").performClick()
        compose.onNodeWithText("电脑").assertIsDisplayed()
        capture("pairing-returned-to-directory")
    }

    @Test fun offlineHistoryUsesTheSameTransitionAndReturnsToItsSource() = withModel { model ->
        var open by mutableStateOf(true)
        var disposed = false
        compose.setContent {
            OrbisTheme(darkTheme = true) {
                OrbisPageHost(onBack = { open = false }, open = open, underlay = {
                    DisposableEffect(Unit) { onDispose { disposed = true } }
                    Text("Retained session directory")
                }) { OfflineHistoryScreen(RemoteState(), "offline-fixture", model, onBack = { open = false }) }
            }
        }
        cancelAndCheck("offline-fixture", "offline-history-drag-dark")
        swipeBack()
        compose.onNodeWithText("Retained session directory").assertIsDisplayed()
        assertFalse(disposed)
        capture("offline-history-returned")
    }

    @Test fun nestedSystemBackPopsOnlyTheTopPageAndNeverTheSource() {
        var outer by mutableStateOf(true)
        var inner by mutableStateOf(true)
        var outerBacks = 0
        compose.setContent {
            OrbisTheme {
                OrbisPageHost(open = outer, onBack = { outerBacks++; outer = false }, underlay = { Text("Root") }) {
                    OrbisPageHost(open = inner, onBack = { inner = false }, underlay = { Text("First page") }) {
                        Text("Second page")
                    }
                }
            }
        }
        compose.onNodeWithText("Second page").assertIsDisplayed()
        systemBack()
        compose.onNodeWithText("First page").assertIsDisplayed()
        assertEquals(0, outerBacks)
        systemBack()
        compose.onNodeWithText("Root").assertIsDisplayed()
        assertEquals(1, outerBacks)
    }

    private fun systemBack() = InstrumentationRegistry.getInstrumentation().runOnMainSync {
        val current = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
            .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).single() as ComponentActivity
        current.onBackPressedDispatcher.onBackPressed()
    }

    private fun capture(name: String) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.getExternalFilesDir(null), "page-navigation").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use {
            compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
    }
}
