package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class OpenCodeAvailabilityTest {
    private fun availability(rows: String) = openCodeAvailability(Json.parseToJsonElement("""{"backends":[$rows]}""").jsonObject)

    @Test fun ignoresOldHostsAndDoesNotEnableMalformedStatuses() {
        assertNull(availability("""{"kind":"pi","ready":true}"""))
        assertNull(availability("""{"kind":"opencode","ready":"true"}"""))
    }

    @Test fun distinguishesReadyFromMissingServiceAndVersionMismatch() {
        val ready = availability("""{"kind":"opencode","ready":true,"reason":null}""")!!
        assertTrue(ready.ready)
        assertNull(ready.message())
        val missing = availability("""{"kind":"opencode","ready":false,"reason":"service_not_found"}""")!!
        val incompatible = availability("""{"kind":"opencode","ready":false,"reason":"unsupported_version"}""")!!
        assertFalse(missing.ready)
        assertFalse(incompatible.ready)
        assertNotNull(missing.message())
        assertNotNull(incompatible.message())
        assertNotEquals(missing.message(), incompatible.message())
        // Only surface OpenCode unavailability when OpenCode itself is selected in the draft card.
        assertNull(missing.draftNotice("codex"))
        assertNull(incompatible.draftNotice("claude"))
        assertEquals(missing.message(), missing.draftNotice("opencode"))
        assertNull(ready.draftNotice("opencode"))
    }

    @Test fun draftAgentReconciliationPrefersLaunchableWhileKeepingInspectedOpenCode() {
        val kinds = listOf("codex", "claude", "dsh", "pi", "opencode")
        val initial = reconcileDraftAgent(
            current = "opencode",
            supported = setOf("codex", "pi"),
            kinds = kinds,
            canChooseOpenCode = false,
            allowUnavailableOpenCode = false,
            preferLaunchable = true,
        )
        assertEquals(DraftAgentReconciliation("codex", false), initial)
        val inspected = reconcileDraftAgent(
            current = "opencode",
            supported = setOf("codex", "pi", "dsh"),
            kinds = kinds,
            canChooseOpenCode = false,
            allowUnavailableOpenCode = true,
            preferLaunchable = false,
        )
        assertEquals(DraftAgentReconciliation("opencode", true), inspected)
        val disabled = reconcileDraftAgent(
            current = "opencode",
            supported = setOf("codex", "pi"),
            kinds = listOf("codex", "claude", "dsh", "pi"),
            canChooseOpenCode = false,
            allowUnavailableOpenCode = true,
            preferLaunchable = false,
        )
        assertEquals(DraftAgentReconciliation("codex", false), disabled)
        val onlyOpenCode = reconcileDraftAgent(
            current = "codex",
            supported = emptySet(),
            kinds = listOf("opencode"),
            canChooseOpenCode = false,
            allowUnavailableOpenCode = false,
            preferLaunchable = true,
        )
        assertEquals(DraftAgentReconciliation("opencode", true), onlyOpenCode)
    }
}
