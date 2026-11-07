package com.orbising.orbis

import kotlin.math.PI
import kotlin.math.roundToInt

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
