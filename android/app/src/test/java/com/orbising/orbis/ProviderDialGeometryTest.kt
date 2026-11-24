package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.PI
import kotlin.math.hypot

class ProviderDialGeometryTest {
    @Test fun detentsAreTheFixedThirtySixDegreeDesignStep() {
        assertEquals((PI / 5.0).toFloat(), ProviderDialGeometry.stepRadians(2), 0.00001f)
        assertEquals((PI / 5.0).toFloat(), ProviderDialGeometry.stepRadians(7), 0.00001f)
        assertEquals((PI / 5.0).toFloat(), ProviderDialGeometry.stepRadians(1), 0.00001f)
        assertEquals(1f, ProviderDialGeometry.dragOffset(-Math.toRadians(36.0).toFloat(), 1), 0.00001f)
    }

    @Test fun angularDragRoundsToWrappedPreviewWithoutWriting() {
        val oneTurn = Math.toRadians(36.0).toFloat()
        assertEquals(1f, ProviderDialGeometry.dragOffset(-oneTurn, 2), 0.00001f)
        assertEquals(-1f, ProviderDialGeometry.dragOffset(oneTurn, 2), 0.00001f)
        assertEquals(1, ProviderDialGeometry.roundedIndex(0, 1f, 2))
        assertEquals(0, ProviderDialGeometry.roundedIndex(1, 1f, 2))
        assertEquals(1, ProviderDialGeometry.wrap(-1, 2))
    }

    @Test fun adjacentRepeatedPanelsTiltByThirtySixDegreesAroundThePivot() {
        assertEquals(36f, ProviderDialGeometry.panelAngleDegrees(1, 0f, 3), 0.0001f)
        assertEquals(-36f, ProviderDialGeometry.panelAngleDegrees(-1, 0f, 3), 0.0001f)
        assertEquals(0f, ProviderDialGeometry.panelAngleDegrees(0, 0f, 1), 0f)
        assertEquals(36f, ProviderDialGeometry.panelAngleDegrees(1, 0f, 1), 0.0001f)
        assertEquals(1f, ProviderDialGeometry.radialX(0f, 1f, 0f), 0.0001f)
        assertEquals(1f, ProviderDialGeometry.radialY(0f, 1f, 90f), 0.0001f)
    }

    // AGENT-DIAL-01: motion starts in one zone; only an armed horizontal pin reaches a write.
    @Test fun pinChannelAndReelHaveIndependentGestureZones() {
        val layout = DualDialGeometry.measure(390f, 440f)
        val x = layout.pinStart + layout.pinTravel * 0.5f
        val y = layout.cy
        assertTrue(layout.inPinChannel(x, y))
        assertFalse(layout.inPinChannel(x, y + 28f))
        assertFalse(AgentDialPin.horizontal(12f, -70f))
        assertTrue(AgentDialPin.horizontal(30f, 8f))
        assertFalse(AgentDialPin.armed(false, AgentDialPin.drag(false, layout.pinTravel * 0.4f, layout.pinTravel)))
        assertEquals(AgentDialPin.HOLD, AgentDialPin.drag(false, layout.pinTravel * 1.5f, layout.pinTravel), 0.00001f)
        assertTrue(AgentDialPin.armed(true, AgentDialPin.drag(true, -layout.pinTravel, layout.pinTravel)))
    }

    // AGENT-DIAL-04: the stacked dial is sized by the page alone, at the disc's full width-bound size,
    // so quota, session or notice rows below can only scroll, not move or shrink the disc.
    @Test fun stackedDialKeepsItsFullDiscIndependentOfTheFactsBelow() {
        for ((width, height) in listOf(360f to 560f, 393f to 600f, 430f to 700f)) {
            val dial = DualDialGeometry.stackedHeight(width, height)
            assertEquals(DualDialGeometry.measure(width, 4000f).radius, DualDialGeometry.measure(width, dial).radius, 0f)
            assertTrue(height - dial >= 200f)
        }
        assertEquals(204f, DualDialGeometry.stackedHeight(393f, 300f), 0f)
    }

    // AGENT-DIAL-04: a docked pin is one continuous path — slot, groove, socket — with no jump between
    // the ring and the groove, and an extended pin never leaves the groove's centre line.
    @Test fun dockedPinRetractsAlongTheFixedGrooveWithoutJumping() {
        val g = DualDialGeometry.measure(393f, DualDialGeometry.stackedHeight(393f, 600f))
        assertEquals(g.pinStart + g.pinTravel, AgentDialPin.centre(g, 0f, 1f).first, 0.001f)
        assertEquals(g.pinStart, AgentDialPin.centre(g, 0f, 0f).first, 0.001f)
        assertEquals(g.cy, AgentDialPin.centre(g, 0f, 1f).second, 0.001f)
        assertEquals(AgentDialPin.centre(g, AgentDialPin.SEAT, 0f), AgentDialPin.centre(g, AgentDialPin.SEAT, 1f))
        var previous = AgentDialPin.centre(g, -0.6f, 1f)
        for (i in -599..600) {
            val distance = i / 1000f
            val (x, y) = AgentDialPin.centre(g, distance, 1f)
            assertTrue("jump at $distance", hypot(x - previous.first, y - previous.second) < 1f)
            if (x - AgentDialPin.centre(g, distance, 0f).first > 0.5f) assertTrue("off groove at $distance", kotlin.math.abs(y - g.cy) <= 3f)
            previous = x to y
        }
    }

}
