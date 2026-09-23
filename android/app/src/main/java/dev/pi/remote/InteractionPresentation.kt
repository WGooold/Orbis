package dev.pi.remote

internal fun isInteractionInputValid(value: String, request: PendingInteraction): Boolean {
    val length = value.length
    if (request.minLength != null && length < request.minLength) return false
    if (request.maxLength != null && length > request.maxLength) return false
    return true
}

internal fun interactionInputConstraintText(request: PendingInteraction): String? = when {
    request.minLength != null && request.maxLength != null ->
        "请输入 ${request.minLength}–${request.maxLength} 个字符"
    request.minLength != null -> "至少输入 ${request.minLength} 个字符"
    request.maxLength != null -> "最多输入 ${request.maxLength} 个字符"
    else -> null
}

internal fun isInteractionMultiSelectValid(selectedCount: Int, request: PendingInteraction): Boolean {
    val min = request.minSelections ?: 0
    val max = request.maxSelections
    if (selectedCount < min) return false
    if (max != null && selectedCount > max) return false
    return true
}

internal fun interactionMultiSelectConstraintText(request: PendingInteraction): String? = when {
    request.minSelections != null && request.maxSelections != null ->
        "请选择 ${request.minSelections}–${request.maxSelections} 项"
    request.minSelections != null -> "至少选择 ${request.minSelections} 项"
    request.maxSelections != null -> "最多选择 ${request.maxSelections} 项"
    else -> null
}

/**
 * A far-future `expiresAt` (the runtime's "no timeout" sentinel, e.g.
 * `Number.MAX_SAFE_INTEGER`) and the missing-field `Long.MAX_VALUE` default both
 * mean the request never expires. Anything at or beyond 2100 is treated as
 * unbounded so the dialog never shows a meaningless countdown.
 */
private const val MAX_INTERACTION_DEADLINE_MS = 4_102_444_800_000L

internal fun interactionHasDeadline(request: PendingInteraction): Boolean =
    request.expiresAt in 1 until MAX_INTERACTION_DEADLINE_MS

internal fun isInteractionExpired(request: PendingInteraction, nowMs: Long): Boolean =
    interactionHasDeadline(request) && nowMs >= request.expiresAt

internal fun interactionRemainingSeconds(request: PendingInteraction, nowMs: Long): Int {
    if (!interactionHasDeadline(request)) return Int.MAX_VALUE
    val remainingMs = (request.expiresAt - nowMs).coerceAtLeast(0)
    return ((remainingMs + 999) / 1_000).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
}
