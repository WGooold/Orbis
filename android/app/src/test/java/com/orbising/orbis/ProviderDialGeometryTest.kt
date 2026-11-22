package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.PI

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

}
