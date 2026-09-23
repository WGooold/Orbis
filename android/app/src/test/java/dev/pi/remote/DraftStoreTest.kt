package dev.pi.remote

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
