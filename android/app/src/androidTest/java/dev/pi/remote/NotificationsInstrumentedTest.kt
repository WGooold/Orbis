package dev.pi.remote

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Real Compose rendering of reducer inventories; transport is exercised separately by Host socket tests. */
class NotificationsInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val reducer = RelayReducer()
    private val json = Json { encodeDefaults = true }
    private fun initial() = RemoteState(notificationEpoch = "host", runtimes = mapOf(
        "runtime" to RuntimeSummary("runtime", "Codex", "D:/repo", "idle", "session")))
    private fun notice(id: String, message: String) = RuntimeNotice(id, "producer", id, "one", NoticeScope(),
        "warning", message, "condition", 1, 1, "confirmed")
    private fun receive(state: RemoteState, revision: Long, items: List<RuntimeNotice>, complete: Boolean = true): RemoteState {
        val payload = json.encodeToString(NoticeSnapshot("host", "runtime", "session", revision, complete, "confirmed", items))
            .dropLast(1) + ",\"type\":\"notification.snapshot\",\"protocolVersion\":$PROTOCOL_VERSION}"
        return reducer.reduce(state, payload, channel = "ctl")
    }
    @Test fun recoveryRemovesOnlyItsConditionAndClosingReportsTheExactIdentity() {
        val retry = notice("retry", "Reconnecting...")
        val sandbox = notice("sandbox", "沙箱需要配置")
        val state = mutableStateOf(receive(initial(), 1, listOf(retry, sandbox)))
        val dismissed = mutableListOf<String>()
        compose.setContent { PiRemoteTheme { RuntimeNotifications(state.value.notificationProjections.getValue("runtime"), "host", dismissed::add) } }
        compose.onNodeWithText("Reconnecting...").assertIsDisplayed()
        compose.onNodeWithText("沙箱需要配置").assertIsDisplayed()
        // Revision 2 was lost. A later full inventory repairs the missing clear.
        compose.runOnIdle { state.value = receive(state.value, 3, listOf(sandbox)) }
        compose.onNodeWithText("Reconnecting...").assertDoesNotExist()
        compose.onNodeWithText("沙箱需要配置").assertIsDisplayed()
        compose.onNodeWithText("关闭").performClick()
        compose.runOnIdle { assertEquals(listOf("sandbox"), dismissed) }
        compose.onNodeWithText("沙箱需要配置").assertIsDisplayed() // A click does not fabricate source recovery.
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        val output = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "notification-lifecycle.png")
        output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    @Test fun incompleteEmptyInventoryKeepsTheLastConditionAndShowsUnknown() {
        val retry = notice("retry", "Reconnecting...")
        val state = mutableStateOf(receive(initial(), 1, listOf(retry)))
        compose.setContent { PiRemoteTheme { RuntimeNotifications(state.value.notificationProjections.getValue("runtime"), "host") {} } }
        compose.runOnIdle { state.value = receive(state.value, 2, emptyList(), complete = false) }
        compose.onNodeWithText("Reconnecting...").assertIsDisplayed()
        compose.onNodeWithText("通知状态待核对").assertIsDisplayed()
        compose.runOnIdle { state.value = receive(state.value, 3, emptyList()) }
        compose.onNodeWithText("Reconnecting...").assertDoesNotExist()
        compose.onNodeWithText("通知状态待核对").assertDoesNotExist()
    }
}
