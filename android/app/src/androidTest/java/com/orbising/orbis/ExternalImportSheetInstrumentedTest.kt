package com.orbising.orbis

import android.graphics.Bitmap
import android.os.SystemClock
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import org.junit.Rule
import org.junit.Test

class ExternalImportSheetInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    // OI-08: one page; long content must not push Send away, and Send stays disabled until a Session is chosen.
    @Test fun sendWaitsForAChosenSessionOnOnePage() = withSheet { _ ->
        compose.onNodeWithTag("external-import-summary").assertIsDisplayed()
        compose.onNodeWithTag("external-import-note").assertIsDisplayed()
        compose.onNodeWithTag("external-import-send").assertIsDisplayed().assertIsNotEnabled()
        compose.onNodeWithTag("external-import-new-session").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("external-import-recheck").assertDoesNotExist()
    }

    // OI-08: an ambiguous receipt replaces Send with a read-only recheck, never a second submission.
    @Test fun ambiguousReceiptOffersOnlyRecheck() = withSheet { batch ->
        val target = ExternalImportTarget("host-a", "pair-a", "session-a", "/work")
        val assigned = batch.value.copy(destination = ExternalImportDestination(target, "Computer A", "Session A"))
        compose.runOnIdle {
            batch.value = assigned.copy(attempt = ExternalImportAttempt("attempt-a", "runtime-a", ExternalImportReceipt.UNKNOWN))
        }
        compose.onNodeWithTag("external-import-send").assertDoesNotExist()
        compose.onNodeWithTag("external-import-note").assertDoesNotExist()
        compose.onNodeWithTag("external-import-recheck").assertIsDisplayed()
    }

    // OI-08: visual evidence only — the real sheet with sample Sessions, chosen target, both themes, then the sent state.
    @Test fun capturesOnePageLayout() {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "external-import-capture")
        val owner = ViewModelStore()
        val remote = RemoteViewModel(app)
        val model = ExternalImportViewModel(app)
        owner.put("remote", remote)
        owner.put("import", model)
        fun choice(host: String, hostName: String, session: String, name: String, cwd: String, agent: String, running: Boolean = false) =
            ExternalImportChoice(ExternalImportDestination(ExternalImportTarget(host, "pair-$host", session, cwd), hostName, name), agent, running)
        val choices = listOf(
            choice("a", "MacBook Pro", "s1", "整理发布说明", "/Users/me/code/docs", "codex"),
            choice("a", "MacBook Pro", "s2", "修复登录跳转", "/Users/me/code/orbis", "claude", running = true),
            choice("b", "Studio", "s3", "API 重构", "/srv/api", "pi"),
        )
        val batch = ExternalImportBatch("capture", 0L, "https://example.com/spec\n对照这个规范检查登录流程",
            listOf(ImportedFile("Q3-roadmap.pdf", 2_400_000), ImportedFile("login-notes.md", 12_000)))
        val ui = mutableStateOf(ExternalImportUi(batches = listOf(batch), selected = batch.id, recent = choices[1].destination.target))
        val dark = mutableStateOf(false)
        try {
            compose.setContent {
                OrbisTheme(darkTheme = dark.value) { ExternalImportSheet(ui.value, model, remote) { choices } }
            }
            compose.onAllNodesWithTag("external-import-target")[0].performClick()
            capture("external-import-light")
            compose.runOnIdle { dark.value = true }
            capture("external-import-dark")
            compose.runOnIdle {
                dark.value = false
                ui.value = ExternalImportUi(batches = emptyList(), open = true, completed = choices[1].destination)
            }
            capture("external-import-sent-light")
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.waitForIdleSync()
        // The sheet is its own dialog window; let SurfaceFlinger present it before reading the screen.
        SystemClock.sleep(400)
        File(instrumentation.targetContext.getExternalFilesDir(null), "$name.png").outputStream().use {
            instrumentation.uiAutomation.takeScreenshot().compress(Bitmap.CompressFormat.PNG, 100, it)
        }
    }

    private fun withSheet(check: (androidx.compose.runtime.MutableState<ExternalImportBatch>) -> Unit) {
        val app = IsolatedTestApplication(ApplicationProvider.getApplicationContext(), prefix = "external-import-sheet")
        val owner = ViewModelStore()
        val remote = RemoteViewModel(app)
        val model = ExternalImportViewModel(app)
        owner.put("remote", remote)
        owner.put("import", model)
        val batch = mutableStateOf(ExternalImportBatch("shared-content", 0L, "Shared body\n".repeat(100), emptyList()))
        try {
            compose.setContent {
                OrbisTheme { ExternalImportSheet(ExternalImportUi(batches = listOf(batch.value), selected = batch.value.id), model, remote) }
            }
            check(batch)
        } finally {
            compose.runOnIdle { owner.clear() }
            app.dispose()
        }
    }
}
