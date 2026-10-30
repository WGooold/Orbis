package com.orbising.orbis

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class TurnFileChangesTest {
    private val agent = ToolAgent("host", "codex", "session")
    private fun file(id: String = "file", path: String = "src/long-name.test.ts") = FileChangeMetadata(id, path,
        changeKind = "modified", fileKind = "text", additions = 1, deletions = 1, beforeBytes = 5, afterBytes = 5,
        contentVersion = "content-$id", detail = "available")
    private fun summary(files: List<FileChangeMetadata> = listOf(file()), count: Long = files.size.toLong()) = TurnChangeSummary(
        projectionVersion = 1, agent = agent, reviewTurnId = "turn", changeSetId = "set", manifestVersion = 1,
        sourceTurnIds = listOf("native-turn"), anchorEntryId = "entry", startedAt = 1, finishedAt = 2,
        state = "ready", outcome = "completed", coverage = "complete", attribution = "workspace-window", reasons = emptyList(),
        fileCount = count, addedFiles = 0, modifiedFiles = count, deletedFiles = 0, additions = count, deletions = count, preview = files.take(4), revision = 1)
    private fun viewer() = FileChangeViewer("runtime", summary(), "file").select(file())
    private fun page(viewer: FileChangeViewer, text: String = "@@ -1 +1 @@\n-old\n+中😀\n", cursor: String? = null) = FileChangeDetailPage(
        viewer.current!!.requestId!!, "runtime", agent, "set", 1, "file", "content-file", viewer.viewerId, "read", text, cursor, cursor == null)

    @Test fun `metadata merge and opening file lists never request detail text`() {
        val state = TurnChangesState().merge(listOf(summary(count = 8)))
        val manifest = state.manifests.getValue("set:1").request()
        assertEquals("session.changes.read", manifest.command("runtime")!!["type"]!!.jsonPrimitive.content)
        assertFalse(manifest.command("runtime").toString().contains("detail.read"))
        assertNull(state.manifests.getValue("set:1").requestId)
        assertTrue(ChangeManifest(summary()).complete)
    }

    @Test fun `only settled selection starts detail and visited cache survives switching`() {
        val initial = viewer()
        assertEquals(setOf("file"), initial.cache.keys)
        val loaded = initial.page(page(initial))
        assertTrue(loaded.current!!.eof)
        val other = loaded.select(file("other"))
        assertNotEquals(loaded.viewerId, other.viewerId)
        assertEquals("other", other.command()!!["fileId"]!!.jsonPrimitive.content)
        val back = other.select(file())
        assertEquals(loaded.current!!.text, back.current!!.text)
        assertNull(back.command())
        assertEquals(back, back.page(page(initial)))
    }

    @Test fun `cross host session version file and oversized detail are rejected`() {
        val view = viewer()
        val good = page(view)
        listOf(good.copy(agent = agent.copy(hostId = "other")), good.copy(agent = agent.copy(sessionId = "other")),
            good.copy(fileId = "other"), good.copy(contentVersion = "stale"), good.copy(manifestVersion = 2),
            good.copy(text = "中".repeat(48 * 1024)), good.copy(eof = false)).forEach { bad ->
            val result = view.page(bad)
            assertNotNull(result.current!!.error)
            assertEquals("", result.current!!.text)
        }
        assertEquals(view, view.page(good.copy(requestId = "late")))
        assertEquals(view, view.page(good.copy(viewerId = "closed")))
    }

    @Test fun `opaque cursor and multibyte content continue without guessing offsets`() {
        val first = viewer()
        val partial = first.page(page(first, "@@ -1 +1 @@\n-old\n+中", "opaque-cursor"))
        val next = partial.request()
        assertEquals("opaque-cursor", next.command()!!["cursor"]!!.jsonPrimitive.content)
        assertEquals("read", next.command()!!["readId"]!!.jsonPrimitive.content)
        val final = next.page(page(next, "😀\n"))
        assertTrue(final.current!!.text.endsWith("+中😀\n"))
        assertTrue(final.current!!.eof)
        assertNull(final.request().command())
    }

    @Test fun `expired read lease reopens the same immutable cursor once without losing cached text`() {
        val initial = viewer()
        val waiting = initial.page(page(initial, "@@ -1 +1 @@\n-old\n+", "same-opaque-cursor")).request()
        val runtime = RuntimeSummary("runtime", "test", "/project", "idle", sessionId = "session", agentKind = "codex")
        val original = RemoteState(hostId = "host", runtimes = mapOf("runtime" to runtime), changeViewer = waiting)
        fun expired(id: String) = buildJsonObject {
            put("type", "runtime.event"); put("runtimeId", "runtime")
            putJsonObject("event") {
                put("type", "session.changes.failed"); put("requestId", id); put("runtimeId", "runtime"); put("reason", "expired")
            }
        }
        val oldRequest = waiting.current!!.requestId!!
        val reopenedState = reduceTurnChanges(original, expired(oldRequest))!!
        val reopened = reopenedState.changeViewer!!
        assertEquals(waiting.current!!.text, reopened.current!!.text)
        assertEquals(waiting.viewerId, reopened.viewerId)
        assertEquals(waiting.summary, reopened.summary)
        assertNull(reopened.current!!.readId)
        assertNotEquals(oldRequest, reopened.current!!.requestId)
        assertEquals(JsonNull, reopened.command()!!["readId"])
        assertEquals("same-opaque-cursor", reopened.command()!!["cursor"]!!.jsonPrimitive.content)
        assertEquals("content-file", reopened.command()!!["contentVersion"]!!.jsonPrimitive.content)
        assertEquals(reopenedState, reduceTurnChanges(reopenedState, expired(oldRequest)))
        assertEquals(waiting, waiting.failed(null, "expired", reopenExpiredLease = true))

        val unavailable = reduceTurnChanges(reopenedState, expired(reopened.current!!.requestId!!))!!.changeViewer!!
        assertNull(unavailable.command())
        assertNotNull(unavailable.current!!.error)
        assertEquals(waiting.current!!.text, unavailable.current!!.text)
        val successful = reopened.page(page(reopened, "new\n").copy(readId = "replacement-lease"))
        assertTrue(successful.current!!.eof)
        assertEquals("replacement-lease", successful.current!!.readId)

        val switched = reopenedState.copy(changeViewer = reopened.select(file("other")))
        assertEquals(switched, reduceTurnChanges(switched, expired(reopened.current!!.requestId!!)))
        val closed = reopenedState.copy(changeViewer = null)
        assertEquals(closed, reduceTurnChanges(closed, expired(reopened.current!!.requestId!!)))
    }

    @Test fun `manifest pages reject duplicates missing rows versions and nonadvancing cursor`() {
        val first = ChangeManifest(summary(count = 3)).request()
        fun page(files: List<FileChangeMetadata>, cursor: String? = "next") = ChangeManifestPage(first.requestId!!,
            "runtime", agent, "set", 1, files, 3, cursor)
        assertNotNull(first.page(page(listOf(file(), file()))).error)
        assertNotNull(first.page(page(listOf(file()), null)).error)
        assertNotNull(first.page(page(listOf(file())).copy(manifestVersion = 2)).error)
        val second = first.page(page(listOf(file()))).request()
        val rejected = second.page(ChangeManifestPage(second.requestId!!, "runtime", agent, "set", 1, listOf(file("two")), 3, "next"))
        assertNotNull(rejected.error)
        assertEquals(listOf(file()), rejected.files)
    }

    @Test fun `unified lines track both sides across hunks CRLF and fragments`() {
        val result = unifiedDiffLines("--- a/a\n+++ b/a\n@@ -10,2 +20,2 @@\r\n same\r\n-old\n+new\n\\ No newline at end of file\n@@ -30 +40 @@\n-x\n+y", true)
        assertEquals(listOf(10, 11, 30), result.mapNotNull { it.oldLine })
        assertEquals(listOf(20, 21, 40), result.mapNotNull { it.newLine })
        assertEquals("header", result[0].kind)
        assertEquals("header", result[6].kind)
        val partial = unifiedDiffLines("@@ -1 +1 @@\n+" + "😀".repeat(2000), false)
        assertTrue(partial.size > 2)
        assertTrue(partial.filter { it.kind == "addition" }.all { it.newLine == 1 })
        assertFalse(partial.any { it.text.lastOrNull()?.isHighSurrogate() == true })
    }

    @Test fun `middle elision preserves compound extensions leading name and Unicode`() {
        assertEquals("alphabett….ts", elideChangeFileName("alphabettest.ts") { it.length <= 13 })
        val compound = elideChangeFileName("LongComponent.test.tsx") { it.length <= 16 }
        assertTrue(compound.startsWith("Long")); assertTrue(compound.endsWith(".test.tsx"))
        assertEquals(".gitignore" to "", changeFileNameParts(".gitignore"))
        assertEquals("hello." to "", changeFileNameParts("hello."))
        val emoji = elideChangeFileName("😀😀😀😀.kt") { it.length <= 9 }
        assertFalse(emoji.substringBefore('…').lastOrNull()?.isHighSurrogate() == true)
    }

    @Test fun `long directories cannot displace the filename prefix or compound suffix`() {
        val name = "ImportantComponent.test.ts"
        val expected = elideChangeFileName(name) { it.length <= 18 }
        listOf("very-long-directory/another-long-directory/$name", "C:\\very-long-directory\\another-long-directory\\$name").forEach { path ->
            val display = elideChangeFileName(path) { it.length <= 18 }
            assertEquals(expected, display)
            assertTrue(display.startsWith("Important"))
            assertTrue(display.endsWith(".test.ts"))
            assertFalse(display.contains("directory"))
        }
        assertEquals("Short.kt", elideChangeFileName("very-long-directory/Short.kt") { it.length <= 10 })
        assertEquals(name, elideChangeFileName("nested/$name") { it.length <= 5 })
    }

    @Test fun `extensionless names and dotfiles elide only the middle at grapheme boundaries`() {
        assertEquals("abcde…vwxyz", elideChangeFileName("nested/abcdefghijklmnopqrstuvwxyz") { it.length <= 11 })
        assertEquals(".abcd…vwxyz", elideChangeFileName("nested/.abcdefghijklmnopqrstuvwxyz") { it.length <= 11 })
        val combined = elideChangeFileName("A\u0308longfilenameZ\u0308") { it.length <= 10 }
        assertTrue(combined.startsWith("A\u0308")); assertTrue(combined.endsWith("Z\u0308"))
        assertEquals("longfilename", elideChangeFileName("nested/longfilename") { it.length <= 2 })
    }

    @Test fun `stale collecting summaries cannot replace ready revisions or stable anchors`() {
        val ready = summary().copy(revision = 4, anchorEntryId = "final-answer")
        val state = TurnChangesState().merge(listOf(ready))
        val stale = ready.copy(revision = 2, state = "collecting", anchorEntryId = null, preview = emptyList(), fileCount = null)
        assertEquals(state, state.merge(listOf(stale)))
        assertEquals(state, state.merge(listOf(stale.copy(revision = 4))))
        val corrected = ready.copy(revision = 5, anchorEntryId = "corrected-answer")
        assertEquals(corrected, state.merge(listOf(corrected)).summaries.getValue("set"))
        val missingRevision = JsonObject(toolJson.encodeToJsonElement(ready).jsonObject - "revision")
        assertTrue(runCatching { toolJson.decodeFromJsonElement<TurnChangeSummary>(missingRevision) }.isFailure)
    }

    @Test fun `collecting to ready refreshes file preview without detail requests`() {
        val ready = summary().copy(revision = 3)
        val collecting = ready.copy(revision = 1, state = "collecting", preview = emptyList(), fileCount = null)
        val state = TurnChangesState().merge(listOf(collecting, ready))
        val manifest = state.manifests.getValue(ready.versionKey)
        assertEquals(ready.preview, manifest.files)
        assertTrue(manifest.complete)
        assertNull(manifest.requestId)

        val files = (1..5).map { file("file-$it") }
        val larger = summary(files).copy(revision = 4)
        val request = ChangeManifest(larger).request()
        val loaded = request.page(ChangeManifestPage(request.requestId!!, "runtime", agent, "set", 1, files, 5, null))
        val loadedState = TurnChangesState(mapOf("set" to larger), mapOf(larger.versionKey to loaded))
        val anchored = loadedState.merge(listOf(larger.copy(revision = 5, anchorEntryId = "new-anchor")))
        assertEquals(files, anchored.manifests.getValue(larger.versionKey).files)
        assertTrue(anchored.manifests.getValue(larger.versionKey).complete)
    }

    @Test fun `summary pages stay scoped and independent of the chat baseline`() {
        val runtime = RuntimeSummary("runtime", "test", "/project", "idle", sessionId = "session", agentKind = "codex")
        val request = ChangeSummaryRequest("request", agent, listOf("entry", "entry-2"), listOf("turn"))
        val original = RemoteState(hostId = "host", runtimes = mapOf("runtime" to runtime),
            conversations = mapOf("runtime" to RuntimeConversation(sourceEpoch = "chat", sourceSeq = 23)),
            turnChanges = mapOf("runtime" to TurnChangesState(request = request)))
        fun response(id: String, summaries: List<TurnChangeSummary>, cursor: String?) = buildJsonObject {
            put("type", "runtime.event"); put("runtimeId", "runtime")
            putJsonObject("event") {
                put("type", "session.changes.summaries"); put("requestId", id); put("runtimeId", "runtime")
                put("agent", toolJson.encodeToJsonElement(agent)); put("summaries", toolJson.encodeToJsonElement(summaries))
                put("nextCursor", cursor?.let(::JsonPrimitive) ?: JsonNull)
            }
        }
        val first = reduceTurnChanges(original, response("request", listOf(summary()), "opaque-next"))!!
        assertEquals(original.conversations, first.conversations)
        assertEquals("opaque-next", first.turnChanges.getValue("runtime").request!!.cursor)
        val secondSummary = summary().copy(changeSetId = "set-2", reviewTurnId = "turn-2", anchorEntryId = "entry-2")
        val second = reduceTurnChanges(first, response(first.turnChanges.getValue("runtime").request!!.requestId, listOf(secondSummary), null))!!
        assertEquals(2, second.turnChanges.getValue("runtime").summaries.size)
        assertNull(second.turnChanges.getValue("runtime").request)
        assertNull(second.changeViewer)
        assertEquals(second, reduceTurnChanges(second, response("request", listOf(summary()), null)))
        assertEquals(original, reduceTurnChanges(original, response("request", listOf(summary().copy(anchorEntryId = "other", reviewTurnId = "other", sourceTurnIds = emptyList())), null)))
    }

    @Test fun `wire detail reducer ignores unrequested cross scope and closed viewers`() {
        val viewer = viewer()
        val runtime = RuntimeSummary("runtime", "test", "/project", "idle", sessionId = "session", agentKind = "codex")
        val state = RemoteState(hostId = "host", runtimes = mapOf("runtime" to runtime), changeViewer = viewer)
        val envelope = buildJsonObject {
            put("type", "runtime.event"); put("runtimeId", "runtime")
            put("event", JsonObject(toolJson.encodeToJsonElement(page(viewer)).jsonObject + ("type" to JsonPrimitive("session.change.detail.page"))))
        }
        assertTrue(reduceTurnChanges(state, envelope)!!.changeViewer!!.current!!.eof)
        assertNull(reduceTurnChanges(state.copy(changeViewer = null), envelope)!!.changeViewer)
        assertEquals(state.copy(hostId = "other"), reduceTurnChanges(state.copy(hostId = "other"), envelope))
    }
}
