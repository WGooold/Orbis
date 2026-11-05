package com.orbising.orbis

import androidx.test.platform.app.InstrumentationRegistry
import orbis.mobile.Mobile
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Ephemeral localhost fixture only; never changes app pairing or system trust. */
class RelayQuicInstrumentedTest {
    @Test fun fiveStreamNativeBindingPreservesEveryLaneAndCancellation() {
        val args = InstrumentationRegistry.getArguments()
        val port = args.getString("quicPort"); val certificate = args.getString("quicCertificateBase64")
        assumeTrue("requires isolated Go QUIC fixture", port != null && certificate != null)
        val connection = Mobile.newFiveConnection("10.0.2.2:$port", "localhost", "-----BEGIN CERTIFICATE-----\n$certificate\n-----END CERTIFICATE-----")
        try {
            connection.open()
            for ((lane, name) in listOf("ctl", "msg", "bulk", "history", "catchup").withIndex()) for (n in 0..2) {
                val frame = """{"type":"v2.frame","envelope":{"hdr":{"k":"data","ch":"$name"},"ct":"历史🙂-$n"}}""".toByteArray()
                connection.writeLane(lane.toLong(), frame)
                assertArrayEquals(frame, connection.readLane(lane.toLong()))
            }
        } finally { connection.close() }
        try { connection.readLane(3); fail("closed history stream remained usable") } catch (_: Exception) { }
    }

    @Test fun nativeBindingValidatesTlsAndExchangesOrderedFrames() {
        val args = InstrumentationRegistry.getArguments()
        val port = args.getString("quicPort")
        val certificate = args.getString("quicCertificateBase64")
        assumeTrue("requires isolated Go QUIC fixture", port != null && certificate != null)
        val roots = "-----BEGIN CERTIFICATE-----\n$certificate\n-----END CERTIFICATE-----"
        val address = "10.0.2.2:$port"
        val wrongHost = Mobile.newConnection(address, "wrong.invalid", roots)
        try {
            try { wrongHost.open(); fail("accepted wrong TLS hostname") } catch (_: Exception) { /* expected */ }
        } finally { wrongHost.close() }
        val connection = Mobile.newConnection(address, "localhost", roots)
        try {
            connection.open()
            for ((lane, name) in listOf("ctl", "msg", "bulk").withIndex()) {
                for (i in 0..20) {
                    val frame = """{"type":"v2.frame","envelope":{"hdr":{"k":"data","ch":"$name"},"ct":"你好🌍-$i"}}""".toByteArray()
                    connection.writeLane(lane.toLong(), frame)
                    assertArrayEquals(frame, connection.readLane(lane.toLong()))
                }
            }
            val large = ("{\"text\":\"" + "a".repeat(256 * 1024) + "\"}").toByteArray()
            connection.write(large)
            assertArrayEquals(large, connection.read())
        } finally { connection.close() }
        val cancelled = Mobile.newConnection(address, "localhost", roots)
        cancelled.close()
        try { cancelled.open(); fail("opened a cancelled connection") } catch (_: Exception) { /* expected */ }
    }
}
