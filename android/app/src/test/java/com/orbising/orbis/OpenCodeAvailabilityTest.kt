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
    }
}
