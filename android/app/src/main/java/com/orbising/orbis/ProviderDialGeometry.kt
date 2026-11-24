package com.orbising.orbis

import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.pow

/** Pure angular rules shared by the provider arc and its JVM tests. */
internal object ProviderDialGeometry {
    const val VISIBLE_SLOTS = 7

    private val DETENT_RADIANS = (PI / 5.0).toFloat() // 36°; one-provider dials can rotate without changing the selected profile.

    fun stepRadians(providerCount: Int): Float = if (providerCount <= 0) 0f else DETENT_RADIANS

    fun normalizeAngle(delta: Float): Float {
        val pi = PI.toFloat()
        val twoPi = (2.0 * PI).toFloat()
        return when {
            delta > pi -> delta - twoPi
            delta < -pi -> delta + twoPi
            else -> delta
        }
    }

    /** A pointer moving clockwise follows the rotating contents in the opposite angular direction. */
    fun dragOffset(angularTravel: Float, providerCount: Int): Float {
        val step = stepRadians(providerCount)
        if (step == 0f) return 0f
        val offset = -angularTravel / step
        val detent = offset.roundToInt().toFloat()
        // Normalize floating-point noise at exact angular detents, including the wrap boundary.
        return if (kotlin.math.abs(offset - detent) < 0.0001f) detent else offset
    }

    fun wrap(index: Int, count: Int): Int = if (count <= 0) 0 else ((index % count) + count) % count

    fun roundedIndex(baseIndex: Int, offset: Float, count: Int): Int = wrap(baseIndex + offset.roundToInt(), count)

    /** Screen-space panel angle; zero keeps the selected detent at the rightmost arc pointer. */
    fun panelAngleDegrees(virtualIndex: Int, position: Float, count: Int): Float =
        if (count <= 0) 0f else (virtualIndex - position) * Math.toDegrees(stepRadians(count).toDouble()).toFloat()

    fun radialX(centerX: Float, radius: Float, angleDegrees: Float): Float =
        centerX + radius * kotlin.math.cos(Math.toRadians(angleDegrees.toDouble())).toFloat()

    fun radialY(centerY: Float, radius: Float, angleDegrees: Float): Float =
        centerY + radius * kotlin.math.sin(Math.toRadians(angleDegrees.toDouble())).toFloat()
}

internal enum class ProviderDialRing { Agent, Profile }

/** Physical layout in dp, shared by drawing, hit testing and gesture regression tests. */
internal data class DualDialGeometry(val cx: Float, val cy: Float, val radius: Float, val holeRadius: Float,
    val hubRadius: Float, val seamRadius: Float, val agentRadius: Float, val profileStep: Float, val agentStep: Float) {
    val pinTravel get() = seamRadius - agentRadius
    val pinStart get() = cx + agentRadius
    fun inPinChannel(x: Float, y: Float) = x in (pinStart - 22)..(pinStart + pinTravel + 22) && kotlin.math.abs(y - cy) <= 26
    val profilePitch get() = (radius + 28) * Math.toRadians(profileStep.toDouble()).toFloat()
    fun ringAt(x: Float, y: Float): ProviderDialRing? {
        if (x < 20) return null
        val r = kotlin.math.hypot(x-cx, y-cy)
        return when { r < holeRadius -> null; r < hubRadius -> ProviderDialRing.Agent; r < seamRadius -> null; else -> ProviderDialRing.Profile }
    }
    companion object {
        /**
         * AGENT-DIAL-04: the stacked dial height depends only on the page, never on the facts listed
         * below it, so the disc keeps its centre and radius while sessions, quotas or notices change.
         */
        fun stackedHeight(width: Float, height: Float): Float {
            val natural = 2 * (maxOf(140f, minOf(kotlin.math.round(width * 0.52f), width - 240)) + 28)
            return maxOf(height - 320, minOf(natural, height - 200)).coerceAtLeast(minOf(height, 204f))
        }
        fun measure(width: Float, height: Float): DualDialGeometry {
            val r0 = maxOf(140f, minOf(kotlin.math.round(width * 0.52f), kotlin.math.floor(height / 2)-28, width-240))
            val rimX = r0 + kotlin.math.round((r0 * 0.15f).coerceIn(22f, 30f)) + 24
            val r = kotlin.math.round(r0 * 1.6f)
            val cx = rimX-r
            val hole = maxOf(kotlin.math.round((r*0.15f).coerceIn(22f,44f)), 26-cx)
            val hub = maxOf(kotlin.math.round(r*0.5f), hole+72)
            val agent = kotlin.math.round((hole+hub)/2)+2
            return DualDialGeometry(cx, height/2, r, hole, hub, hub+24, agent,
                kotlin.math.round((96/(r+28)*180/PI).toFloat().coerceIn(16f,24f)),
                kotlin.math.round((56/agent*180/PI).toFloat().coerceIn(24f,40f)))
        }
        fun soften(value: Float, count: Int): Float {
            val last = (count-1).coerceAtLeast(0)
            return when { value < 0 -> value*0.3f; value > last -> last+(value-last)*0.3f; else -> value }
        }
        fun sticky(value: Float): Float {
            val i = kotlin.math.round(value)
            val d = value-i
            return i + kotlin.math.sign(d)*0.5f*kotlin.math.abs(d*2).toDouble().pow(2.4).toFloat()
        }
    }
}


/** AGENT-DIAL-01: the horizontal lane owns the initial contact; the real socket is reserved for Host acknowledgement. */
internal object AgentDialPin {
    const val HOLD = 0.72f
    const val LOCK = 8f
    fun horizontal(dx: Float, dy: Float) = kotlin.math.abs(dx) > kotlin.math.abs(dy) * 1.1f
    fun drag(enabled: Boolean, dx: Float, travel: Float): Float = if (enabled) (1 + dx / travel).coerceIn(1-HOLD, 1f) else (dx / travel).coerceIn(0f, HOLD)
    fun armed(enabled: Boolean, position: Float): Boolean = if (enabled) position < 0.5f else position > 0.5f

    /** Resting pin travel for any Agent: the socket end is reserved for a Host-confirmed enable. */
    fun rest(pending: AgentDialChoice?, enabled: Boolean): Float = when (pending?.target) {
        true -> HOLD; false -> 1 - HOLD; null -> if (enabled) 1f else 0f
    }

    /**
     * AGENT-DIAL-04: the groove is fixed at the gate; an Agent's pin may only ride it while that
     * Agent is docked. Docking is a function of ring position alone, so dragging, settling and
     * reversing all retract and extend the pin continuously instead of swapping elements.
     */
    const val DOCK = 0.2f
    /** Pins leave the ring only inside a narrower window, after the Agent is already held on the groove line. */
    const val SEAT = 0.1f
    fun docked(distance: Float): Float = 1 - smooth(kotlin.math.abs(distance) / DOCK)
    fun seated(distance: Float): Float = 1 - smooth(kotlin.math.abs(distance) / SEAT)
    /** The raised cap emerges over a wider window, so it never belongs to two Agents at once. */
    fun gate(distance: Float): Float = 1 - smooth(kotlin.math.abs(distance) / 0.5f)
    private fun smooth(t: Float): Float { val x = t.coerceIn(0f, 1f); return x * x * (3 - 2 * x) }

    /**
     * Pin centre in dp for an Agent [distance] slots from the gate. A docked pin stays on the
     * groove's centre line; an undocked one follows the ring.
     */
    fun centre(g: DualDialGeometry, distance: Float, travel: Float): Pair<Float, Float> {
        val angle = Math.toRadians((distance * g.agentStep).toDouble())
        val dock = docked(distance)
        val radius = g.agentRadius + travel.coerceIn(0f, 1f) * seated(distance) * g.pinTravel
        val x = g.cx + radius * kotlin.math.cos(angle).toFloat()
        val y = g.cy + radius * kotlin.math.sin(angle).toFloat() * (1 - dock)
        return x to y
    }
}
