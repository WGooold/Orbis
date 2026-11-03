package com.orbising.orbis

import kotlin.math.*
import org.junit.Assert.*
import org.junit.Test

class QuotaCoinGeometryTest {
    @Test fun contactShadowStaysVisibleAndInsideTheWellThroughoutBothDirections() {
        val resting = QuotaCoinGeometry.shadow(0.0)
        val side = QuotaCoinGeometry.shadow(90.0)
        assertTrue(side.widthScale < resting.widthScale)
        for (angle in 0..180) {
            val shadow = QuotaCoinGeometry.shadow(angle.toDouble())
            val reverse = QuotaCoinGeometry.shadow(180.0 - angle)
            assertTrue(shadow.opacityScale > 0 && shadow.opacityScale <= 1)
            assertEquals(shadow.widthScale, reverse.widthScale, 0.0001f)
            // Check the entire soft footprint against the 56dp circular well.
            for (step in 0..126) {
                val t = step * 0.05
                val x = QuotaCoinGeometry.ShadowDiameter / 2 * shadow.widthScale * cos(t)
                val y = QuotaCoinGeometry.ShadowOffsetY + QuotaCoinGeometry.ShadowHeight / 2 * sin(t)
                assertTrue(hypot(x, y) < 28)
            }
        }
    }

    @Test fun bothFacesLandUprightAtTheOriginalSize() {
        for (angle in listOf(0.0, 180.0)) {
            val matrix = QuotaCoinGeometry.faceProjection(angle)
            for ((x, y) in listOf(0.0 to 0.0, 44.0 to 0.0, 22.0 to 22.0, 44.0 to 44.0)) {
                val point = QuotaCoinGeometry.project(QuotaCoinGeometry.Point(x, y), matrix)
                assertEquals(x, point.x, 0.0001); assertEquals(y, point.y, 0.0001)
            }
        }
    }

    @Test fun theSideOnEdgeStaysSolidInsteadOfDisappearing() {
        val bands = QuotaCoinGeometry.bands(90.0)
        assertEquals(13, bands.size)
        val widths = mutableListOf<Double>()
        for (band in bands) {
            val area = abs(band.points.zip(band.points.drop(1) + band.points.first()).sumOf { (a, b) -> a.x * b.y - b.x * a.y }) / 2
            assertTrue("Every depth slice must have area at 90 degrees", area > 20)
            widths += band.points.map { it.x * cos(24 * PI / 180) + it.y * sin(24 * PI / 180) }
        }
        val width = widths.max() - widths.min()
        assertTrue(width > 8 && width < 10)
    }

    @Test fun rotationStaysBoundedAndNeverMirrorsTheVisibleMark() {
        assertFalse(QuotaCoinGeometry.faceVisible(90.0))
        for (angle in 0..180 step 3) {
            val m = QuotaCoinGeometry.faceProjection(angle.toDouble())
            val origin = QuotaCoinGeometry.project(QuotaCoinGeometry.Point(0.0, 0.0), m)
            val x = QuotaCoinGeometry.project(QuotaCoinGeometry.Point(44.0, 0.0), m)
            val y = QuotaCoinGeometry.project(QuotaCoinGeometry.Point(0.0, 44.0), m)
            if (QuotaCoinGeometry.faceVisible(angle.toDouble()))
                assertTrue((x.x - origin.x) * (y.y - origin.y) - (x.y - origin.y) * (y.x - origin.x) > 0)
            for (point in QuotaCoinGeometry.bands(angle.toDouble()).flatMap { it.points }) {
                assertTrue(point.x.isFinite() && point.y.isFinite())
                assertTrue(point.x in -1.0..45.0); assertTrue(point.y in -1.0..45.0)
            }
        }
    }

    @Test fun filmTimingAcceleratesOutAndDeceleratesToAnExactRest() {
        assertEquals(0.0, QuotaCoinGeometry.angle(-1f), 0.0)
        assertEquals(11.25, QuotaCoinGeometry.angle(45f), 0.0)
        assertEquals(90.0, QuotaCoinGeometry.angle(90f), 0.0)
        assertEquals(174.375, QuotaCoinGeometry.angle(135f), 0.0)
        assertEquals(180.0, QuotaCoinGeometry.angle(181f), 0.0)
        assertEquals(560, QuotaCoinGeometry.OutgoingDuration + QuotaCoinGeometry.IncomingDuration)
        val values = (0..180).map { QuotaCoinGeometry.angle(it.toFloat()) }
        assertTrue(values.zipWithNext().all { (a, b) -> b >= a })
        assertTrue(values[180] - values[179] < 0.001)
    }
}
