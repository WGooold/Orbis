package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class DraftStoreTest {
    private val device = DeviceCredential("wss://relay.example.com", "device-1", "credential")
    private val runtime = RuntimeSummary("runtime-1", "Pi", "/work", "idle", "session-1")

    @Test
    fun `draft key is isolated by relay device runtime and session`() {
        val first = draftPreferenceKey(draftIdentity(device, runtime))

        assertNotEquals(first, draftPreferenceKey(draftIdentity(device.copy(relayUrl = "wss://other.example.com"), runtime)))
        assertNotEquals(first, draftPreferenceKey(draftIdentity(device.copy(deviceId = "device-2"), runtime)))
        assertNotEquals(first, draftPreferenceKey(draftIdentity(device, runtime.copy(runtimeId = "runtime-2"))))
        assertNotEquals(first, draftPreferenceKey(draftIdentity(device, runtime.copy(sessionId = "session-2"))))
    }

    @Test
    fun `unified Codex modes share a draft only for the same host catalog identity`() {
        val catalogId = "codex-history:" + "a".repeat(64)
        val terminal = runtime.copy(runtimeId = "codex:thread", sessionId = "thread", agentKind = "codex", codexCatalogId = catalogId)
        val desktop = runtime.copy(runtimeId = "codex-desktop:thread", sessionId = "codex-desktop:thread", agentKind = "codexDesktop", codexCatalogId = catalogId)
        assertEquals(draftIdentity(device, terminal), draftIdentity(device, desktop))
        assertEquals(draftPreferenceKey(draftIdentity(device, terminal)), draftPreferenceKey(draftIdentity(device, desktop)))
        assertNotEquals(draftPreferenceKey(draftIdentity(device, terminal)),
            draftPreferenceKey(draftIdentity(device, desktop.copy(codexCatalogId = "codex-history:" + "b".repeat(64)))))
        assertNotEquals(draftPreferenceKey(draftIdentity(device, terminal)),
            draftPreferenceKey(draftIdentity(device.copy(deviceId = "device-2"), desktop)))
    }

    @Test
    fun `missing session remains a stable isolated identity`() {
        val withoutSession = runtime.copy(sessionId = null)
        assertEquals(
            draftPreferenceKey(DraftIdentity(device.relayUrl, device.deviceId, runtime.runtimeId, null)),
            draftPreferenceKey(draftIdentity(device, withoutSession)),
        )
        assertNotEquals(
            draftPreferenceKey(draftIdentity(device, withoutSession)),
            draftPreferenceKey(draftIdentity(device, runtime)),
        )
    }
}
