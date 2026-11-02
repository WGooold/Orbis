package com.orbising.orbis

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InteractionMotionTest {
    @Test fun sendStartsQuicklyAndContinuouslySlowsToAStopWithoutBouncing() {
        val source = Offset(160f, 620f); val target = Offset(260f, 410f)
        for ((start, duration) in listOf(0f to 0.25f, 0.25f to 0.75f)) {
            val points = (0..20).map { InteractionMotion.sendPoint(source, target, start + duration * it / 20) }
            val distances = points.zipWithNext().map { (a, b) -> (b-a).getDistance() }
            distances.zipWithNext().forEach { (before, after) -> assertTrue(after <= before + 0.001f) }
            assertTrue(distances.first() > distances.last() * 100)
            assertTrue(distances.last() < 0.1f)
        }
        assertEquals(0.875f, InteractionMotion.sendEaseOut(0.5f))
        assertEquals(0f, InteractionMotion.sendEaseOut(-1f))
        assertEquals(1f, InteractionMotion.sendEaseOut(2f))
    }

    @Test fun sendArrivesCompactThenUnfoldsToTheWholeMessageWithoutAHeightCap() {
        val source = Rect(24f, 620f, 324f, 676f)
        for (target in listOf(Rect(80f, 490f, 320f, 554f), Rect(44f, 180f, 320f, 580f))) {
            assertEquals(source, InteractionMotion.sendFrame(source, target, 0f))
            val right = InteractionMotion.sendFrame(source, target, 70f / InteractionMotion.Send)
            assertTrue(right.center.x >= source.center.x + 24)
            assertEquals(source.center.y, right.center.y, 0.001f)
            val arrival = InteractionMotion.sendFrame(source, target, InteractionMotion.SendArrival)
            assertEquals(target.bottomRight, arrival.bottomRight)
            assertTrue(arrival.width < target.width && arrival.height < target.height)
            var previous = arrival
            for (step in 1..100) {
                val p = InteractionMotion.SendArrival + (1-InteractionMotion.SendArrival) * step / 100f
                val frame = InteractionMotion.sendFrame(source, target, p)
                assertEquals(target.right, frame.right, 0.001f)
                assertEquals(target.bottom, frame.bottom, 0.001f)
                assertTrue(frame.width >= previous.width && frame.height >= previous.height)
                previous = frame
            }
            assertEquals(target, previous)
            assertEquals(target, InteractionMotion.sendFrame(source, target, 2f))
        }
    }

    @Test fun revealCoversEveryCornerForEdgeAndCentralTouches() {
        val size = Size(340f, 126f)
        val corners = listOf(Offset.Zero, Offset(340f, 0f), Offset(0f, 126f), Offset(340f, 126f))
        for (origin in listOf(Offset.Zero, Offset(330f, 4f), Offset(170f, 63f))) {
            val radius = InteractionMotion.revealRadius(origin, size)
            corners.forEach { assertTrue((it - origin).getDistance() <= radius + 0.001f) }
        }
        assertEquals(Offset(170f, 63f), InteractionMotion.touchOrigin(null, size))
        assertEquals(Offset(0f, 126f), InteractionMotion.touchOrigin(Offset(-20f, 400f), size))
    }

    @Test fun sendMovesRightBeforeUpWithoutOvershooting() {
        val source = Offset(160f, 620f); val target = Offset(260f, 410f)
        val samples = (0..100).map { InteractionMotion.sendPoint(source, target, it / 100f) }
        assertEquals(source, samples.first()); assertEquals(target, samples.last())
        assertEquals(Offset(260f, 620f), samples[25])
        samples.zipWithNext().forEach { (a, b) ->
            assertTrue(b.x >= a.x && b.y <= a.y)
            assertTrue(b.x <= target.x && b.y >= target.y)
        }
        assertEquals(source, InteractionMotion.sendPoint(source, target, -1f))
        assertEquals(target, InteractionMotion.sendPoint(source, target, 2f))
        val leftTarget = Offset(120f, 410f)
        assertEquals(Offset(source.x + 24f, source.y), InteractionMotion.sendPoint(source, leftTarget, 0.25f))
        assertEquals(leftTarget, InteractionMotion.sendPoint(source, leftTarget, 1f))
    }
    @Test fun edgeBackAlwaysLeavesBothSidesVisibleAndMirrorsOnlyItsBias() {
        for (width in listOf(320f, 393f, 800f)) for (p in listOf(0f, 0.2f, 0.65f, 1f)) {
            val inset = width * InteractionMotion.EdgeShrink * p / 2
            val left = InteractionMotion.edgeShift(width, p, 1f, 8f)
            val right = InteractionMotion.edgeShift(width, p, -1f, 8f)
            assertEquals(left, -right, 0.001f)
            assertTrue(left >= 0f)
            assertTrue(inset - left >= 8f * p - 0.001f)
            assertTrue(inset + right >= 8f * p - 0.001f)
        }
    }

}
