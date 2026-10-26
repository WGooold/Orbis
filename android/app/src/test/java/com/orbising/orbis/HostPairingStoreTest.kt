package com.orbising.orbis

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class HostPairingStoreTest {
    @get:Rule val temporary = TemporaryFolder()

    private fun store() = HostPairingStore(temporary.newFile("pairings.json"), Json)

    private fun pairing(
        hostId: String,
        deviceId: String = "device-$hostId",
        credential: String = "credential-$hostId",
        hostName: String? = hostId,
    ) = HostPairing(
        hostId = hostId,
        hostName = hostName,
        hostPub = "public-$hostId",
        pskRoot = "psk-$hostId",
        relayUrl = "wss://relay.example",
        deviceId = deviceId,
        credential = credential,
    )

    @Test
    fun `re-pairing the same computer replaces its record instead of adding a second Host`() {
        val store = store()
        store.add(pairing("host-1", hostName = "Desktop"))
        store.add(pairing("host-2"))
        val reparired = store.add(
            pairing("host-1", deviceId = "rotated", credential = "rotated", hostName = "Renamed"),
        )
        assertEquals(listOf("host-1", "host-2"), reparired.map(HostPairing::hostId))
        assertEquals("rotated", reparired.first().credential)
        assertEquals("Renamed", reparired.first().hostName)
        // The replacement survives a cold read: dedup is a property of the stored file, not of one call.
        assertEquals(reparired, store.hosts())
    }

    @Test
    fun `active Host survives re-pairing and falls back when the selected Host is removed`() {
        val store = store()
        store.add(pairing("host-1"))
        store.add(pairing("host-2"))
        store.setActiveHostId("host-2")
        store.add(pairing("host-1", hostName = "Renamed"))
        assertEquals("host-2", store.activeHostId())

        val remaining = store.remove("host-2")
        assertEquals(listOf("host-1"), remaining.hosts.map(HostPairing::hostId))
        assertEquals("host-1", remaining.activeHostId)

        assertNull(store.remove("host-1").activeHostId)
        assertTrue(store.hosts().isEmpty())
    }

    @Test
    fun `a corrupt file loads as unpaired instead of crashing the APP`() {
        val file = temporary.newFile("pairings.json")
        file.writeText("{not json")
        val store = HostPairingStore(file, Json)
        assertTrue(store.hosts().isEmpty())
        // A subsequent write repairs the file rather than propagating the damaged content.
        assertEquals(listOf("host-1"), store.add(pairing("host-1")).map(HostPairing::hostId))
    }
}
