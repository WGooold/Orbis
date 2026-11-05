package com.orbising.orbis

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** S19 / V21: asynchronous catalog arrival must preserve interaction and row geometry. */
class DrawerCatalogBackgroundInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private fun host(state: RemoteState) = HostSnapshot(HostPairing(requireNotNull(state.hostId), "Fixture", "public", "root",
        relayUrl = "wss://relay.example", deviceId = "fixture", credential = "fixture"), state)

    private fun awaitRow(id: String) = compose.waitUntil(10_000) {
        compose.onAllNodesWithTag("drawer-session-$id").fetchSemanticsNodes().any { it.boundsInRoot.height > 0 }
    }

    @Test fun firstAsyncCatalogExpandsAndExplicitCollapseSurvivesLaterUpdates() {
        val state = mutableStateOf(RemoteState(hostId = "host", hostName = "Fixture"))
        compose.setContent { OrbisTheme(darkTheme = false) {
            SessionDrawer(state.value, listOf(host(state.value)), {}, {}, {}, { _, _ -> }, { _, _ -> }, { _, _ -> }, { _, _, _ -> })
        } }
        compose.runOnIdle { state.value = state.value.copy(sessions = mapOf("s" to
            SessionCatalogEntry("s", name = "First session", cwd = "/repo", agentKind = "pi"))) }
        awaitRow("s")
        compose.onNodeWithTag("drawer-directory-/repo").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("drawer-session-s").assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(sessions = state.value.sessions +
            ("s" to state.value.sessions.getValue("s").copy(name = "Renamed", modifiedAt = 100))) }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("1 个目录，1 个会话").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("drawer-session-s").assertDoesNotExist()
        compose.onNodeWithTag("drawer-directory-/repo").performClick()
        awaitRow("s")
        compose.onNodeWithText("Renamed").assertIsDisplayed()
    }

    @Test fun continuousBodyAndStatusUpdatesKeepTheRowStableAndClickable() {
        val runtime = RuntimeSummary("r", "Runtime", "/repo", "idle", sessionId = "s", agentKind = "codex", sessionName = "Stable title")
        val message = ChatMessage("m", "assistant", listOf(RemoteContent("text", "first")), 1)
        val sessions = (0 until 1000).associate { index ->
            val id = "offline-$index"
            id to SessionCatalogEntry(id, name = id, cwd = "/repo/${index % 100}", agentKind = "pi")
        } + ("s" to SessionCatalogEntry("s", cwd = "/repo", agentKind = "codex", modifiedAt = 10000))
        val state = mutableStateOf(RemoteState(hostId = "host", hostName = "Fixture", sessions = sessions,
            runtimes = mapOf("r" to runtime), conversations = mapOf("r" to RuntimeConversation(messages = listOf(message)))))
        val opened = mutableListOf<Pair<String, String>>()
        compose.setContent { OrbisTheme(darkTheme = false) {
            SessionDrawer(state.value, listOf(host(state.value)), {}, {}, {}, { h, s -> opened += h to s },
                { _, _ -> }, { _, _ -> }, { _, _, _ -> })
        } }
        awaitRow("s")
        val before = compose.onNodeWithTag("drawer-session-s").fetchSemanticsNode().boundsInRoot
        repeat(60) { index -> compose.runOnIdle {
            state.value = state.value.copy(runtimes = mapOf("r" to runtime.copy(status = if (index % 2 == 0) "running" else "idle")),
                conversations = mapOf("r" to RuntimeConversation(messages = listOf(message.copy(
                    content = listOf(RemoteContent("text", "stream $index")))))))
        } }
        compose.waitForIdle()
        assertEquals(before, compose.onNodeWithTag("drawer-session-s").fetchSemanticsNode().boundsInRoot)
        compose.onNodeWithText("Stable title").assertIsDisplayed()
        compose.onNodeWithTag("drawer-session-s").performClick()
        assertEquals(listOf("host" to "s"), opened)
    }

    @Test fun hostSwitchAndSearchCannotPublishRowsFromThePreviousHost() {
        val state = mutableStateOf(RemoteState(hostId = "first", hostName = "Fixture", sessions = mapOf("one" to
            SessionCatalogEntry("one", name = "Target first", cwd = "/repo", agentKind = "pi"))))
        compose.setContent { OrbisTheme(darkTheme = false) {
            SessionDrawer(state.value, listOf(host(state.value)), {}, {}, {}, { _, _ -> }, { _, _ -> }, { _, _ -> }, { _, _, _ -> })
        } }
        awaitRow("one")
        compose.onNode(hasSetTextAction()).performTextInput("Target")
        compose.runOnIdle { state.value = RemoteState(hostId = "second", hostName = "Fixture", sessions = mapOf("two" to
            SessionCatalogEntry("two", name = "Target second", cwd = "/other", agentKind = "pi"))) }
        awaitRow("two")
        compose.onNodeWithTag("drawer-session-one").assertDoesNotExist()
        compose.onNodeWithText("Target second").assertIsDisplayed()
    }
}
