package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** ADR-0046 §6 / V21: session changes never push the home viewport away. */
class HomeViewportAnchorTest {
    private val cards = listOf("a", "b", "c", "d", "e", "f")

    @Test fun atTheTopTheNewestOrPromotedCardStaysVisible() {
        assertEquals(0 to 0, homeViewportTarget(cards, listOf("new") + cards, 0, 0, topSlop = 8))
        assertEquals(0 to 0, homeViewportTarget(cards, listOf("d", "a", "b", "c", "e", "f"), 0, 5, topSlop = 8))
    }

    @Test fun slightlyScrolledPastTheSlopIsNotTheTop() {
        assertNull(homeViewportTarget(cards, listOf("new") + cards, 0, 30, topSlop = 8))
    }

    @Test fun cardsMovingAboveTheAnchorKeepTheAnchorWhereItIs() {
        // "e" jumps from below to the top; the anchor "c" did not move itself, so it keeps its place.
        assertNull(homeViewportTarget(cards, listOf("e", "a", "b", "c", "d", "f"), 2, 40, topSlop = 8))
        // New sessions above the anchor do the same.
        assertNull(homeViewportTarget(cards, listOf("x", "y") + cards, 2, 40, topSlop = 8))
    }

    @Test fun anAnchorThatMovesItselfKeepsThePixelPositionInsteadOfBeingFollowed() {
        assertEquals(2 to 40, homeViewportTarget(cards, listOf("c", "a", "b", "d", "e", "f"), 2, 40, topSlop = 8))
    }

    @Test fun aRemovedAnchorKeepsThePixelPosition() {
        assertEquals(2 to 40, homeViewportTarget(cards, listOf("a", "b", "d", "e", "f"), 2, 40, topSlop = 8))
        assertEquals(1 to 40, homeViewportTarget(cards, listOf("a", "b"), 4, 40, topSlop = 8))
    }

    @Test fun unchangedFirstOrEmptyListsAreLeftAlone() {
        assertNull(homeViewportTarget(emptyList(), cards, 0, 0, topSlop = 8))
        assertNull(homeViewportTarget(cards, cards, 3, 10, topSlop = 8))
        assertNull(homeViewportTarget(cards, emptyList(), 3, 10, topSlop = 8))
    }
}
