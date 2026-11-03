package com.orbising.orbis

import kotlin.math.*

/** S19 / ADR-0058 QuotaCoin. The film's solid coin, inside the existing 64×56dp hit slot. */
internal object QuotaCoinGeometry {
    const val Diameter = 44.0
    const val HalfDepth = 4.6 * Diameter / 48
    const val Perspective = 190 * Diameter / 48
    const val OutgoingDuration = 220
    const val IncomingDuration = 340
    const val RimBands = 13
    const val ShadowDiameter = 34.0
    const val ShadowHeight = 10.0
    const val ShadowOffsetY = 21.0
    data class Shadow(val widthScale: Float, val opacityScale: Float)

    // Keep contact at rest; narrow the soft shadow as the coin turns edge-on.
    fun shadow(angle: Double): Shadow {
        val sideOn = abs(sin(angle * PI / 180)).toFloat()
        return Shadow(1 - 0.65f * sideOn, 1 - 0.25f * sideOn)
    }
    private val axisX = -sin(24 * PI / 180)
    private val axisY = cos(24 * PI / 180)
    data class Point(val x: Double, val y: Double)
    data class Band(val points: List<Point>, val brightness: Double)
    private val circumference = List(64) { index ->
        val angle = index * 2 * PI / 64
        Point(cos(angle) * Diameter / 2, sin(angle) * Diameter / 2)
    }

    // Each half has a linear clock; apply GSAP power2.in / power3.out exactly once.
    fun angle(phase: Float): Double {
        val p = phase.toDouble().coerceIn(0.0, 180.0)
        return if (p <= 90) 90 * (p / 90).pow(3) else 180 - 90 * ((180 - p) / 90).pow(4)
    }

    /** Row-major homography, normalized so both resting faces are exactly 44dp. */
    fun projection(angle: Double, depth: Double): DoubleArray {
        val a = angle * PI / 180; val c = cos(a); val s = sin(a); val k = 1 - c
        val xx = c + axisX * axisX * k; val xy = axisX * axisY * k; val xz = axisY * s
        val yy = c + axisY * axisY * k; val yz = -axisX * s
        val zx = -axisY * s; val zy = axisX * s
        val center = Diameter / 2; val scale = (Perspective - HalfDepth) / Perspective
        val wx = -zx / Perspective; val wy = -zy / Perspective
        val w = 1 + (zx + zy) * center / Perspective - c * depth / Perspective
        return doubleArrayOf(scale * xx + center * wx, scale * xy + center * wy,
            scale * (xz * depth - (xx + xy) * center) + center * w,
            scale * xy + center * wx, scale * yy + center * wy,
            scale * (yz * depth - (xy + yy) * center) + center * w, wx, wy, w)
    }

    fun project(point: Point, m: DoubleArray): Point {
        val w = m[6] * point.x + m[7] * point.y + m[8]
        return Point((m[0] * point.x + m[1] * point.y + m[2]) / w,
            (m[3] * point.x + m[4] * point.y + m[5]) / w)
    }

    // Mount the reverse about the same diagonal axis: no mirrored or tilted resting logo.
    fun faceProjection(angle: Double) = projection(if (angle > 90) angle - 180 else angle, HalfDepth)

    fun faceVisible(angle: Double) = abs(cos(angle * PI / 180)) > HalfDepth / Perspective

    /** Solid cylindrical slices preserve thickness even exactly side-on. Draw far to near. */
    fun bands(angle: Double): List<Band> {
        val order = if (cos(angle * PI / 180) >= 0) (0 until RimBands).toList() else (0 until RimBands).reversed().toList()
        return order.map { index ->
            val points = listOf(index, index + 1).flatMap { layer ->
                val matrix = projection(angle, -HalfDepth + layer * 2 * HalfDepth / RimBands)
                circumference.map { project(Point(it.x + Diameter / 2, it.y + Diameter / 2), matrix) }
            }
            Band(hull(points), 0.82 + 0.3 * exp(-((index - 6) / 3.0).pow(2)))
        }
    }

    private fun hull(points: List<Point>): List<Point> {
        val sorted = points.sortedWith(compareBy<Point> { it.x }.thenBy { it.y })
        fun cross(a: Point, b: Point, c: Point) = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
        fun chain(points: List<Point>): List<Point> {
            val result = mutableListOf<Point>()
            points.forEach { point ->
                while (result.size >= 2 && cross(result[result.lastIndex - 1], result.last(), point) <= 0) result.removeAt(result.lastIndex)
                result.add(point)
            }
            return result.dropLast(1)
        }
        return chain(sorted) + chain(sorted.reversed())
    }
}
