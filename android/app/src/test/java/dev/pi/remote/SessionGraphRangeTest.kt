package dev.pi.remote

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionGraphRangeTest {
    private fun entry(id: String, parentId: String?) = SessionGraphEntry(
        entryId = id,
        parentId = parentId,
        type = "message",
        timestamp = "2026-01-01T00:00:00.000Z",
        data = buildJsonObject {
            put("message", buildJsonObject {
                put("role", "user")
                put("content", id)
            })
        },
    )

    @Test
    fun `range selection keeps shared prefix once for the selected branch`() {
        val path = listOf(
            entry("root", null),
            entry("shared", "root"),
            entry("branch-a", "shared"),
        )

        val range = selectSessionGraphRange(path, startEntryId = "shared")

        assertEquals(listOf("shared", "branch-a"), range.entries.map(SessionGraphEntry::entryId))
        assertTrue(range.hasOlder)
        assertTrue(range.complete)
    }

    @Test
    fun `missing start keeps the known path and reports an incomplete range`() {
        val range = selectSessionGraphRange(
            path = listOf(
                entry("root", null),
                entry("child", "root"),
            ),
            startEntryId = "missing",
        )

        assertEquals(listOf("root", "child"), range.entries.map(SessionGraphEntry::entryId))
        assertFalse(range.complete)
        assertFalse(range.hasOlder)
        assertEquals(SessionGraphRangeStatus.RANGE_START_NOT_FOUND, range.status)

        val single = selectSessionGraphRange(listOf(entry("root", null)), startEntryId = "missing")

        assertFalse(single.complete)
        assertEquals(SessionGraphRangeStatus.RANGE_START_NOT_FOUND, single.status)
    }

    @Test
    fun `range selection marks a bounded tail as having older entries`() {
        val path = listOf(
            entry("entry-100", "entry-99"),
            entry("entry-101", "entry-100"),
        )

        val range = selectSessionGraphRange(path)

        assertEquals(listOf("entry-100", "entry-101"), range.entries.map(SessionGraphEntry::entryId))
        assertTrue(range.hasOlder)
        assertFalse(range.complete)
        assertEquals(SessionGraphRangeStatus.OLDER_AVAILABLE, range.status)
    }

    @Test
    fun `walking a branch excludes sibling entries`() {
        val entries = listOf(
            entry("root", null),
            entry("shared", "root"),
            entry("selected", "shared"),
            entry("sibling", "shared"),
        )
        val result = walkSessionGraphPath("selected", maxEntries = 10) { id ->
            entries.firstOrNull { it.entryId == id }
        }

        assertEquals(listOf("root", "shared", "selected"), result.entries.map(SessionGraphEntry::entryId))
    }

    @Test
    fun `walking a branch reports a missing parent`() {
        val entries = listOf(entry("leaf", "missing"))
        val result = walkSessionGraphPath("leaf", maxEntries = 10) { id ->
            entries.firstOrNull { it.entryId == id }
        }

        assertEquals(listOf("leaf"), result.entries.map(SessionGraphEntry::entryId))
        assertEquals(SessionGraphRangeStatus.MISSING_PARENT, result.status)
    }

    @Test
    fun `walking a branch reports a cycle without duplicating entries`() {
        val entries = listOf(
            entry("a", "b"),
            entry("b", "a"),
        )
        val result = walkSessionGraphPath("a", maxEntries = 10) { id ->
            entries.firstOrNull { it.entryId == id }
        }

        assertEquals(listOf("b", "a"), result.entries.map(SessionGraphEntry::entryId))
        assertEquals(SessionGraphRangeStatus.CYCLE_DETECTED, result.status)
    }

    @Test
    fun `walking a branch reports a missing leaf`() {
        val result = walkSessionGraphPath("unknown", maxEntries = 10) { null }

        assertTrue(result.entries.isEmpty())
        assertEquals(SessionGraphRangeStatus.LEAF_NOT_FOUND, result.status)
    }

    @Test
    fun `walking a branch reports a bounded path`() {
        val entries = listOf(
            entry("root", null),
            entry("middle", "root"),
            entry("leaf", "middle"),
        )
        val result = walkSessionGraphPath("leaf", maxEntries = 2) { id ->
            entries.firstOrNull { it.entryId == id }
        }

        assertEquals(listOf("middle", "leaf"), result.entries.map(SessionGraphEntry::entryId))
        assertEquals(SessionGraphRangeStatus.LIMIT_REACHED, result.status)
    }

    @Test
    fun `older range excludes the boundary and keeps stable order`() {
        val range = selectOlderSessionGraphRange(
            path = listOf(
                entry("root", null),
                entry("one", "root"),
                entry("two", "one"),
                entry("leaf", "two"),
            ),
            beforeEntryId = "two",
            maxEntries = 10,
        )

        assertEquals(listOf("root", "one"), range.entries.map(SessionGraphEntry::entryId))
        assertTrue(range.complete)
        assertEquals(SessionGraphRangeStatus.COMPLETE, range.status)
    }

    @Test
    fun `older range reports more history when bounded`() {
        val range = selectOlderSessionGraphRange(
            path = listOf(
                entry("root", null),
                entry("one", "root"),
                entry("two", "one"),
                entry("three", "two"),
            ),
            beforeEntryId = "three",
            maxEntries = 1,
        )

        assertEquals(listOf("two"), range.entries.map(SessionGraphEntry::entryId))
        assertTrue(range.hasOlder)
        assertEquals(SessionGraphRangeStatus.OLDER_AVAILABLE, range.status)
    }

    @Test
    fun `older range reports an unknown boundary`() {
        val range = selectOlderSessionGraphRange(
            path = listOf(entry("root", null)),
            beforeEntryId = "missing",
            maxEntries = 10,
        )

        assertFalse(range.complete)
        assertEquals(SessionGraphRangeStatus.RANGE_START_NOT_FOUND, range.status)
    }

    @Test
    fun `empty path with a leaf is not reported as complete`() {
        val range = selectSessionGraphRange(emptyList(), startEntryId = "leaf")

        assertFalse(range.complete)
        assertEquals(SessionGraphRangeStatus.RANGE_START_NOT_FOUND, range.status)
    }
}
