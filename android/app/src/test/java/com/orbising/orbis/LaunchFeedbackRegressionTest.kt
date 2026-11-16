package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** LAUNCH-FEEDBACK-01: transient launch guards must not invalidate a previously confirmed native configuration. */
class LaunchFeedbackRegressionTest {
    private fun confirmed() = SessionConfigurationState(agentKind = "codex", cwd = "/repo/app",
        snapshot = SessionConfigurationSnapshot("codex", "/repo/app", "native-binding", 3,
            SessionConfigurationValues(model = "fixture-model"), SessionConfigurationCatalog("native-binding")))

    @Test fun `journal loading rejection permits retry after loading finishes`() {
        val first = confirmed().admitConfiguredLaunch("codex", "/repo/app", journalLoaded = false, journalPresent = false)
        assertFalse(first.allowed)
        assertEquals(ConfiguredLaunchBlock.JOURNAL_LOADING, first.block)
        assertNull(first.configuration.error)
        assertNotNull(first.configuration.launchError)
        val retry = first.configuration.admitConfiguredLaunch("codex", "/repo/app", journalLoaded = true, journalPresent = false)
        assertTrue("Loading the journal must release the launch guard without re-reading valid configuration", retry.allowed)
        assertEquals(confirmed().snapshot, retry.configuration.snapshot)
        assertNull(retry.configuration.launchError)
    }

    @Test fun `previous launch rejection permits retry after the journal is cleared`() {
        val first = confirmed().admitConfiguredLaunch("codex", "/repo/app", journalLoaded = true, journalPresent = true)
        assertFalse(first.allowed)
        assertEquals(ConfiguredLaunchBlock.PREVIOUS_LAUNCH, first.block)
        assertNull(first.configuration.error)
        assertNotNull(first.configuration.launchError)
        val retry = first.configuration.admitConfiguredLaunch("codex", "/repo/app", journalLoaded = true, journalPresent = false)
        assertTrue("Settling or abandoning the previous launch must permit a new launch with the confirmed configuration", retry.allowed)
        assertEquals(confirmed().snapshot, retry.configuration.snapshot)
        assertNull(retry.configuration.launchError)
    }

    // The retry fix must continue to require native confirmation after a real configuration failure or target change.
    @Test fun `configuration failures and mismatched targets still block launch`() {
        val blocked = listOf(confirmed().copy(error = "configuration save rejected"), confirmed().copy(snapshot = null))
        blocked.forEach {
            val result = it.admitConfiguredLaunch("codex", "/repo/app", journalLoaded = true, journalPresent = false)
            assertFalse(result.allowed)
            assertEquals(ConfiguredLaunchBlock.CONFIGURATION_UNCONFIRMED, result.block)
        }
        assertFalse(confirmed().admitConfiguredLaunch("claude", "/repo/app", journalLoaded = true, journalPresent = false).allowed)
        assertFalse(confirmed().admitConfiguredLaunch("codex", "/repo/other", journalLoaded = true, journalPresent = false).allowed)
        assertTrue(confirmed().admitConfiguredLaunch("codex", "/repo/app", journalLoaded = true, journalPresent = false).allowed)
    }

    // A successful explicit refresh resolves both the configuration request and its old launch warning.
    @Test fun `matching configuration confirmation clears the previous launch warning`() {
        val state = RemoteState(sessionConfiguration = confirmed().copy(requestId = "configuration-read", launchError = "previous launch unresolved"))
        val result = RelayReducer().reduce(state, """{"type":"session.configuration.result","requestId":"configuration-read","agentKind":"codex","cwd":"/repo/app","binding":"native-binding","revision":4,"values":{},"catalog":{"binding":"native-binding"}}""")
        assertNull(result.sessionConfiguration.requestId)
        assertNull(result.sessionConfiguration.launchError)
        assertEquals(4L, result.sessionConfiguration.snapshot?.revision)
    }

    // SC94 / LAUNCH-FEEDBACK-01: a first sentence is owned by the new-session card before any runtime exists.
    @Test fun `first sentence validation stays on its new session draft`() {
        val failure = userMessageInputError("/help")!!
        val rejected = RemoteState().composerFailure(null, failure)
        assertEquals(failure, rejected.sessionConfiguration.launchError)
        assertNull(rejected.sessionListError)
        assertTrue(rejected.conversations.isEmpty())
        assertTrue(rejected.sessionOperationErrors.isEmpty())
    }

    // Opening a new draft does not transfer ownership to a previously selected chat.
    @Test fun `explicit first sentence feedback does not touch a previously selected runtime`() {
        val initial = RemoteState(selectedRuntimeId = "previous-chat",
            conversations = mapOf("previous-chat" to RuntimeConversation(operationError = "previous operation failed")))
        val failure = userMessageInputError("/help")!!
        val rejected = initial.composerFailure(null, failure)
        assertEquals(failure, rejected.sessionConfiguration.launchError)
        assertEquals(initial.conversations, rejected.conversations)
        assertNull(rejected.sessionListError)
        assertTrue(rejected.sessionOperationErrors.isEmpty())
    }

    // Correcting the first sentence clears its warning without erasing an independent directory read failure.
    @Test fun `corrected first sentence clears only draft feedback and keeps confirmed configuration`() {
        val initial = RemoteState(sessionConfiguration = confirmed().copy(launchError = "invalid first sentence"), sessionListError = "directory read failed")
        val corrected = initial.composerFailure(null, "")
        assertNull(corrected.sessionConfiguration.launchError)
        assertEquals(initial.sessionConfiguration.snapshot, corrected.sessionConfiguration.snapshot)
        assertNull(corrected.sessionConfiguration.error)
        assertEquals(initial.sessionListError, corrected.sessionListError)
        assertTrue(corrected.sessionConfiguration.admitConfiguredLaunch("codex", "/repo/app", journalLoaded = true, journalPresent = false).allowed)
    }
}
