package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** FT-G12-GAP-01: checkpoint ingestion must keep its display rows when a buffered patch
 * joins the same SQLite commit. These exercise the production merge, without a fake commit. */
class SessionSnapshotDisplayMergeTest {
    private fun row(id: String, text: String = id) = DisplayEntry(
        displayId = id, entryId = id, nativeType = "message", kind = "message",
        message = ChatMessage(id, "assistant", listOf(RemoteContent("text", text)), 1),
    )
    private fun batch(vararg rows: DisplayEntry, window: String? = null) =
        DisplayBatch(DISPLAY_PROJECTION_VERSION, rows.toList(), window)
    private fun patch(seq: Long, display: DisplayBatch?) = SessionPatch(
        sessionId = "session", source = SessionSourceEpoch("epoch", seq, true), baseSeq = seq - 1,
        seq = seq, checkpointId = "epoch:$seq", head = SessionBranchCursor("head-$seq"),
        headCompleteness = "complete", live = SessionLiveState(true), display = display,
    )

    @Test fun `checkpoint rows survive the buffered suffix production merge`() {
        val original = batch(row("tail-start"), row("tail-head"))
        val successor = batch(row("successor"))
        val merged = requireNotNull(mergedSnapshotDisplay(original, listOf(patch(81, successor))))
        assertEquals(listOf("tail-start", "tail-head", "successor"), merged.entries.map(DisplayEntry::displayId))
        assertEquals(DISPLAY_PROJECTION_VERSION, merged.projectionVersion)
    }

    @Test fun `later buffered revisions replace matching display identities without dropping other rows`() {
        val corrected = row("tail-head", "corrected")
        val latest = row("tail-head", "final")
        val merged = requireNotNull(mergedSnapshotDisplay(batch(row("tail-start"), row("tail-head")), listOf(
            patch(81, batch(corrected, row("first-successor"))),
            patch(82, batch(latest, row("second-successor"))),
        )))
        assertEquals(listOf("tail-start", "tail-head", "first-successor", "second-successor"),
            merged.entries.map(DisplayEntry::displayId))
        assertEquals(latest, merged.entries.single { it.displayId == "tail-head" })
    }

    @Test fun `only actual display batches change the authoritative window including an explicit clear`() {
        val initial = batch(row("tail"), window = "tail")
        assertEquals("tail", mergedSnapshotDisplay(initial, listOf(patch(81, null)))?.windowStart)
        assertEquals("successor", mergedSnapshotDisplay(initial, listOf(
            patch(81, batch(row("successor"), window = "successor")), patch(82, null),
        ))?.windowStart)
        assertNull(mergedSnapshotDisplay(initial, listOf(patch(81, batch(row("successor")))))?.windowStart)
    }

    @Test fun `projection versions cannot be mixed into one committed display representation`() {
        val original = batch(row("tail"))
        for (version in listOf(DISPLAY_PROJECTION_VERSION - 1, DISPLAY_PROJECTION_VERSION + 1)) {
            val changed = batch(row("successor")).copy(projectionVersion = version)
            val error = runCatching { mergedSnapshotDisplay(original, listOf(patch(81, changed))) }.exceptionOrNull()
            assertTrue(error is IllegalArgumentException)
            assertEquals("display_projection_version_mismatch", error?.message)
        }
    }

    @Test fun `absent displays remain absent while a lone supported batch is preserved`() {
        assertNull(mergedSnapshotDisplay(null, listOf(patch(81, null))))
        val original = batch(row("tail"), window = "tail")
        assertEquals(original, mergedSnapshotDisplay(original, emptyList()))
        assertEquals(original, mergedSnapshotDisplay(null, listOf(patch(81, original))))
    }
}
