package com.orbising.orbis

internal fun isInteractionInputValid(value: String, request: PendingInteraction): Boolean {
    val length = value.length
    if (request.minLength != null && length < request.minLength) return false
    if (request.maxLength != null && length > request.maxLength) return false
    return true
}

internal fun interactionInputConstraintText(request: PendingInteraction): String? = when {
    request.minLength != null && request.maxLength != null ->
        L10n.tr("请输入 {0}–{1} 个字符", request.minLength, request.maxLength)
    request.minLength != null -> L10n.tr("至少输入 {0} 个字符", request.minLength)
    request.maxLength != null -> L10n.tr("最多输入 {0} 个字符", request.maxLength)
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
        L10n.tr("请选择 {0}–{1} 项", request.minSelections, request.maxSelections)
    request.minSelections != null -> L10n.tr("至少选择 {0} 项", request.minSelections)
    request.maxSelections != null -> L10n.tr("最多选择 {0} 项", request.maxSelections)
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
