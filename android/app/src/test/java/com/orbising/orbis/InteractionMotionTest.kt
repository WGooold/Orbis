package com.orbising.orbis

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InteractionMotionTest {
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
}
