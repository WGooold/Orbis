package com.orbising.orbis

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class ProtocolCompatibilityTest {
    // SC88: select the highest actual intersection, including noncontiguous/future
    // sets and three participants when all three parse the same representation.
    @Test fun `negotiation uses the highest common implemented version without filling gaps`() {
        assertEquals(21, highestCommonProtocolVersion(setOf(18, 19, 21), setOf(18, 21, 22)))
        assertEquals(18, highestCommonProtocolVersion(setOf(18, 19, 21), setOf(18, 21), setOf(18, 19)))
        assertNull(highestCommonProtocolVersion(setOf(18, 21), setOf(19, 20)))
        assertNull(highestCommonProtocolVersion(setOf(18), emptySet()))
        assertNull(highestCommonProtocolVersion(setOf(17, 18), setOf(16, 17)))
        assertEquals(18, highestCommonProtocolVersion(setOf(17, 18), setOf(17, 18)))
        assertNull(highestCommonProtocolVersion())
        assertEquals(SUPPORTED_PROTOCOL_VERSIONS.maxOrNull(), INITIAL_WIRE_PROTOCOL_VERSION)
        assertTrue(PROTOCOL_VERSION in SUPPORTED_PROTOCOL_VERSIONS)
        assertEquals(PREFERRED_PROTOCOL_VERSIONS.drop(1), PREFERRED_PROTOCOL_VERSIONS.mapNotNull(::nextSupportedProtocolVersion))
        assertNull(nextSupportedProtocolVersion(-1))
    }
    @Test fun `18 and 19 are supported but unimplemented formats and malformed versions are rejected`() {
        for (literal in listOf("18", "19")) {
            assertNotNull(supportedProtocolVersion(Json.parseToJsonElement(literal)))
            val next = RelayReducer().reduce(RemoteState(), """{"type":"device.ready","protocolVersion":$literal,"deviceId":"phone","runtimes":[]}""")
            assertEquals(RelayConnection.ONLINE, next.connection)
            assertNull(next.error)
        }
        for (literal in listOf("17", "0", "-1", "20", "19.5", "\"18\"", "true", "null", "{}", "[]", "9007199254740992")) {
            assertNull(literal, supportedProtocolVersion(Json.parseToJsonElement(literal)))
            val next = RelayReducer().reduce(RemoteState(), """{"type":"device.ready","protocolVersion":$literal,"deviceId":"phone","runtimes":[]}""")
            assertEquals(literal, PROTOCOL_VERSION_MISMATCH_ERROR, next.error)
            assertNotEquals(literal, RelayConnection.ONLINE, next.connection)
        }
    }

    @Test fun `wire selection preserves command identity and nested payload`() {
        val request = Json.parseToJsonElement("""{"type":"runtime.command","protocolVersion":19,"runtimeId":"r","commandId":"same-id","command":{"type":"user_message","messageId":"same-message","text":"hello"}}""").jsonObject
        val selected = request.withWireProtocolVersion(18)
        assertEquals(Json.parseToJsonElement("18"), selected["protocolVersion"])
        assertEquals(request - "protocolVersion", selected - "protocolVersion")
        assertEquals(Json.parseToJsonElement("19"), request["protocolVersion"])
        val receipt = buildJsonObject { put("type", "protocol.error"); put("code", "invalid_command") }
        assertSame(receipt, receipt.withWireProtocolVersion(18))
    }

    @Test fun `both file formats retain payload and reject unsupported or malformed headers`() {
        for (version in 18..19) {
            val bytes = encodeArtifactChunkFrame("runtime", "transfer", 7, byteArrayOf(1, 2, 3), version)
            assertEquals(version.toByte(), bytes[4])
            val decoded = decodeArtifactChunkFrame(bytes)
            assertEquals("transfer", decoded.transferId)
            assertEquals(7L, decoded.offset)
            assertArrayEquals(byteArrayOf(1, 2, 3), decoded.data)
            for (bad in listOf(0, 17, 20, 255)) {
                val malformed = bytes.copyOf().apply { this[4] = bad.toByte() }
                assertThrows(IllegalStateException::class.java) { decodeArtifactChunkFrame(malformed) }
            }
            val malformed = bytes.copyOf().apply { this[5] = 2 }
            assertThrows(IllegalStateException::class.java) { decodeArtifactChunkFrame(malformed) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            encodeArtifactChunkFrame("runtime", "transfer", 0, byteArrayOf(1), 17)
        }
    }
}
