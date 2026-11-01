package com.orbising.orbis

import android.graphics.Bitmap
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** ADR-0049: pending sends and optimistic closes, rendered by the production composables. */
class OptimisticActionsInstrumentedTest {
    @get:Rule val compose = createComposeRule()

    @Test fun pendingSendShowsItsStateInPlaceOfMessageActions() {
        val pending = mutableStateOf<PendingSendState?>(PendingSendState.Sending)
        val actions = mutableListOf<PendingSendAction>()
        compose.setContent {
            OrbisTheme {
                UserMessageCard("runtime", ChatMessage("app-1", "user", listOf(RemoteContent("text", "乐观发送")), 1),
                    downloads = emptyMap(), downloadArtifact = {}, downloadFile = {},
                    pending = pending.value, canResend = true, onPendingAction = { actions += it })
            }
        }
        compose.onNodeWithText("乐观发送").assertIsDisplayed()
        compose.onNodeWithText("发送中").assertIsDisplayed()
        compose.onNodeWithContentDescription("复制消息").assertDoesNotExist()

        compose.runOnIdle { pending.value = PendingSendState.Failed("会话正在运行，请选择插入或完成后发送") }
        compose.onNodeWithText("会话正在运行，请选择插入或完成后发送").assertIsDisplayed()
        compose.onNodeWithContentDescription("重新发送").assertIsEnabled().performClick()
        compose.onNodeWithContentDescription("放回输入框").performClick()
        compose.onNodeWithContentDescription("删除").performClick()
        compose.runOnIdle { assertEquals(listOf(PendingSendAction.Resend, PendingSendAction.Restore, PendingSendAction.Discard), actions) }

        compose.runOnIdle { pending.value = PendingSendState.Queued }
        compose.onNodeWithText("已排队").assertIsDisplayed()
        compose.onNodeWithText("发送中").assertDoesNotExist()
        capture("agent-input-queued")
        compose.onNodeWithContentDescription("撤回排队消息").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(PendingSendAction.Cancel, actions.last()) }

        // Once the source row replaces it, the ordinary message actions return.
        compose.runOnIdle { pending.value = null }
        compose.onNodeWithTag("pending-send-status").assertDoesNotExist()
        compose.onNodeWithContentDescription("复制消息").assertIsDisplayed()
    }

    @Test fun unconfirmedSendCanBeCheckedWithoutResending() {
        val actions = mutableListOf<PendingSendAction>()
        compose.setContent {
            OrbisTheme {
                UserMessageCard("runtime", ChatMessage("app-unknown", "user", listOf(RemoteContent("text", "需要核对的输入")), 1),
                    downloads = emptyMap(), downloadArtifact = {}, downloadFile = {},
                    pending = PendingSendState.Unconfirmed, canResend = true, onPendingAction = { actions += it })
            }
        }
        compose.onNodeWithText("未确认是否送达").assertIsDisplayed()
        compose.onNodeWithText("发送中").assertDoesNotExist()
        compose.onNodeWithContentDescription("重新发送").assertDoesNotExist()
        capture("agent-input-unconfirmed")
        compose.onNodeWithContentDescription("核对送达状态").assertIsEnabled().performClick()
        compose.onNodeWithText("需要核对的输入").assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(PendingSendAction.Check), actions) }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(context.getExternalFilesDir(null), "$name.png")
        file.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun swipeCloseHidesTheCardImmediatelyAndARejectionBringsItBack() {
        val pairing = HostPairing("host", "Test Host", "test-public", "test-root",
            relayUrl = "wss://relay.example", deviceId = "test-device", credential = "test-only")
        val state = mutableStateOf(RemoteState(hostId = "host", e2eReady = true,
            runtimes = listOf("one", "two").associateWith { RuntimeSummary(it, it, "/repo", "idle", sessionId = it) }))
        compose.setContent {
            OrbisTheme {
                RuntimeListScreen(state.value.withReadyHomeFixture(), listOf(HostSnapshot(pairing, state.value.withReadyHomeFixture())),
                    onOpenRuntime = { _, _ -> },
                    // Mirrors HostConnection.closeRuntimes: the command is written, the Host has not answered.
                    onCloseRuntimes = { _, ids ->
                        state.value = ids.fold(state.value) { current, id ->
                            current.createQuit("quit-$id", id, 0).first.ledgerWritten("quit-$id", 0)
                        }
                        ids
                    },
                    onOpenDownloads = {}, onUnpairHost = {},
                    onOpenSession = { _, _ -> }, onOpenHistory = { _, _ -> }, onNewSession = { _, _ -> },
                    onSetArchived = { _, _, _ -> }, onSelectHost = {}, onAddHost = {}, onOpenStatus = {}, onRequestProviders = {})
            }
        }
        val card = compose.onNodeWithTag("home-runtime-one")
        val width = card.fetchSemanticsNode().boundsInRoot.width
        card.performTouchInput { down(Offset(this.width * 0.85f, center.y)); moveBy(Offset(-width * 0.6f, 0f)); up() }
        compose.waitForIdle()
        compose.onNodeWithTag("home-runtime-one").assertDoesNotExist()
        compose.onNodeWithTag("home-runtime-two").assertIsDisplayed()

        // The computer rejected /quit: the ledger drops the operation and the card returns in place.
        compose.runOnIdle { state.value = state.value.copy(ledger = state.value.ledger.remove("quit-one")) }
        compose.waitForIdle()
        compose.onNodeWithTag("home-runtime-one").assertIsDisplayed()
        val restored = compose.onNodeWithTag("home-runtime-one").fetchSemanticsNode().boundsInRoot
        val sibling = compose.onNodeWithTag("home-runtime-two").fetchSemanticsNode().boundsInRoot
        assertEquals(sibling.left, restored.left, 1f)
    }
}
