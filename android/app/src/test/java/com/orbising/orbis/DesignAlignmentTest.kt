package com.orbising.orbis

import androidx.compose.ui.graphics.luminance
import org.junit.Assert.*
import org.junit.Test

/** S34 / SC54: readable neutral and action ink must survive all themes and nested faces. */
class DesignAlignmentTest {
    @Test fun themeInkRemainsReadableAndAnInsetNeverChangesTheMaterial() {
        for (material in OrbisMaterial.entries) for (dark in listOf(false, true)) {
            val p = orbisPalette(dark, material)
            assertEquals(p.material.base, p.material.insetBase)
            for (surface in listOf(p.material.base, p.material.lift, p.material.top)) {
                for (ink in listOf(p.ink, p.muted, p.accent, p.success, p.warning, p.danger)) {
                    val a = ink.luminance(); val b = surface.luminance()
                    val contrast = (maxOf(a,b)+0.05f)/(minOf(a,b)+0.05f)
                    assertTrue("$material dark=$dark contrast=$contrast ink=$ink face=$surface", contrast >= 4.5f)
                }
            }
        }
    }

    /** S36 / SC57: a gesture started in the hollow, moat or system edge has no owner. */
    @Test fun dualDialRegionsStaySeparatedAcrossPhoneAndTabletSizes() {
        for ((width,height) in listOf(320f to 300f, 393f to 450f, 720f to 520f)) {
            val g = DualDialGeometry.measure(width,height)
            assertEquals(24f, g.seamRadius-g.hubRadius, 0f)
            assertTrue(g.cx+g.holeRadius >= 26)
            assertNull(g.ringAt(19f,g.cy))
            assertNull(g.ringAt(g.cx+(g.hubRadius+g.seamRadius)/2,g.cy))
            assertEquals(ProviderDialRing.Agent,g.ringAt(g.cx+g.agentRadius,g.cy))
            assertEquals(ProviderDialRing.Profile,g.ringAt(g.cx+g.radius,g.cy))
            assertTrue(g.profilePitch in 84f..120f)
        }
    }

    /** The heavy Agent ring has a sticky centre; overdrag remains bounded and never wraps. */
    @Test fun dialDetentsSoftenTheEndsWithoutWrappingToAnotherAgent() {
        assertEquals(-0.3f,DualDialGeometry.soften(-1f,4),0.0001f)
        assertEquals(3.3f,DualDialGeometry.soften(4f,4),0.0001f)
        assertTrue(DualDialGeometry.sticky(0.2f) < 0.2f)
        assertEquals(1f,DualDialGeometry.sticky(1f),0f)
        assertEquals(1.5f,DualDialGeometry.sticky(1.5f),0f)
    }
}
