package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InteractionPresentationTest {
    private fun inputRequest(
        minLength: Int? = null,
        maxLength: Int? = null,
        expiresAt: Long = 10_000,
    ) = PendingInteraction(
        requestId = "request-1",
        extensionId = "extension",
        kind = "input",
        title = "Input",
        description = null,
        options = emptyList(),
        placeholder = null,
        minLength = minLength,
        maxLength = maxLength,
        expiresAt = expiresAt,
    )

    @Test
    fun `input validity follows SDK constraints and mirrors them in the constraint copy`() {
        assertTrue(isInteractionInputValid("", inputRequest()))
        assertFalse(isInteractionInputValid("ab", inputRequest(minLength = 3)))
        assertTrue(isInteractionInputValid("abc", inputRequest(minLength = 3)))
        assertFalse(isInteractionInputValid("abcd", inputRequest(maxLength = 3)))
        assertTrue(isInteractionInputValid("abc", inputRequest(maxLength = 3)))

        assertEquals("请输入 3–8 个字符", interactionInputConstraintText(inputRequest(3, 8)))
        assertEquals("至少输入 3 个字符", interactionInputConstraintText(inputRequest(minLength = 3)))
        assertEquals("最多输入 8 个字符", interactionInputConstraintText(inputRequest(maxLength = 8)))
        assertEquals(null, interactionInputConstraintText(inputRequest()))
    }

    @Test
    fun `expiration is deterministic at the request deadline`() {
        val request = inputRequest(expiresAt = 5_000)
        assertFalse(isInteractionExpired(request, nowMs = 4_999))
        assertTrue(isInteractionExpired(request, nowMs = 5_000))
        assertEquals(2, interactionRemainingSeconds(request, nowMs = 3_001))
        assertEquals(0, interactionRemainingSeconds(request, nowMs = 5_000))
    }

    @Test
    fun `far-future and missing deadlines never expire or count down`() {
        val noTimeout = inputRequest(expiresAt = 9_007_199_254_740_991L)
        val missingDeadline = inputRequest(expiresAt = Long.MAX_VALUE)
        for (request in listOf(noTimeout, missingDeadline)) {
            assertFalse(interactionHasDeadline(request))
            assertFalse(isInteractionExpired(request, nowMs = Long.MAX_VALUE / 2))
            assertEquals(Int.MAX_VALUE, interactionRemainingSeconds(request, nowMs = 0))
        }
        assertTrue(interactionHasDeadline(inputRequest(expiresAt = 5_000)))
    }

    private fun multiSelectRequest(
        minSelections: Int? = null,
        maxSelections: Int? = null,
    ) = PendingInteraction(
        requestId = "request-multi",
        extensionId = "extension",
        kind = "multi-select",
        title = "Pick targets",
        description = null,
        options = listOf(
            InteractionOption("api", "API"),
            InteractionOption("worker", "Worker"),
            InteractionOption("db", "Database"),
        ),
        placeholder = null,
        minSelections = minSelections,
        maxSelections = maxSelections,
    )

    @Test
    fun `multi-select validity enforces the declared selection bounds and mirrors them in the copy`() {
        assertTrue(isInteractionMultiSelectValid(0, multiSelectRequest()))
        assertTrue(isInteractionMultiSelectValid(3, multiSelectRequest()))
        assertFalse(isInteractionMultiSelectValid(0, multiSelectRequest(minSelections = 1)))
        assertTrue(isInteractionMultiSelectValid(1, multiSelectRequest(minSelections = 1)))
        assertFalse(isInteractionMultiSelectValid(3, multiSelectRequest(maxSelections = 2)))
        assertTrue(isInteractionMultiSelectValid(2, multiSelectRequest(maxSelections = 2)))
        assertFalse(isInteractionMultiSelectValid(1, multiSelectRequest(minSelections = 2, maxSelections = 3)))
        assertTrue(isInteractionMultiSelectValid(2, multiSelectRequest(minSelections = 2, maxSelections = 3)))

        assertEquals("请选择 2–3 项", interactionMultiSelectConstraintText(multiSelectRequest(2, 3)))
        assertEquals("至少选择 2 项", interactionMultiSelectConstraintText(multiSelectRequest(minSelections = 2)))
        assertEquals("最多选择 3 项", interactionMultiSelectConstraintText(multiSelectRequest(maxSelections = 3)))
        assertEquals(null, interactionMultiSelectConstraintText(multiSelectRequest()))
    }
}
