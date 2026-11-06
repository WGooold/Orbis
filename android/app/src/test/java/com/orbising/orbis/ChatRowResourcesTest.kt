package com.orbising.orbis

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ChatRowResourcesTest {
    // Two match routes preserve first-task precedence; unrelated progress must reuse row objects.
    @Test fun `download progress and streaming invalidate only their owning rows`() = runBlocking {
        val artifact = RemoteArtifact("file", "file.txt", "text/plain", 100, path = "/file")
        val repeatedId = artifact.copy(path = "/second")
        val first = ChatMessage("u", "user", listOf(RemoteContent("artifact", artifact = artifact), RemoteContent("artifact", artifact = repeatedId)), 1)
        val answer = ChatMessage("a", "assistant", listOf(RemoteContent("text", "Reply")), 2)
        val identity = ChatPresentationIdentity("h", "r", "s", 0)
        val projection = ChatPresentationWorker().resolve(ChatPresentationRequest(identity, listOf(first, answer), emptyMap(), emptyMap(), emptyMap()))
        val userKey = projection.items.first().key
        val answerKey = projection.items.last().key
        val byPath = ArtifactDownload("path", "host", displayName = "File", sourcePath = "/file", receivedBytes = 10)
        val byId = ArtifactDownload("id", "host", displayName = "File", sourceArtifactId = "file")
        val unrelated = ArtifactDownload("other", "host", displayName = "Other", sourceArtifactId = "other")
        val worker = ChatRowResourcesWorker()
        fun input(tasks: Map<String, ArtifactDownload>, live: Set<String> = setOf("a", "other-session"), finished: Set<String> = emptySet()) =
            ChatResourcesRequest(projection, tasks, live, finished, true)
        val tasks = linkedMapOf("path" to byPath, "id" to byId, "other" to unrelated)
        val before = worker.resolve(input(tasks))
        assertEquals(byPath, before.rows.getValue(userKey).downloads[artifactDownloadKey(artifact)])
        assertEquals(byId, before.rows.getValue(userKey).downloads[artifactDownloadKey(repeatedId)])
        assertEquals(setOf("a"), before.rows.getValue(answerKey).streaming)
        assertTrue(before.rows.getValue(userKey).streaming.isEmpty())
        val ignored = worker.resolve(input(tasks + ("other" to unrelated.copy(receivedBytes = 50))))
        assertSame(before, ignored)
        val progress = worker.resolve(input(tasks + ("path" to byPath.copy(receivedBytes = 70))))
        assertNotSame(before.rows[userKey], progress.rows[userKey])
        assertSame(before.rows[answerKey], progress.rows[answerKey])
        val finished = worker.resolve(input(tasks + ("path" to byPath.copy(receivedBytes = 70)), finished = setOf("a")))
        assertTrue(finished.rows.getValue(answerKey).streaming.isEmpty())
        assertSame(progress.rows[userKey], finished.rows[userKey])
        val otherProjection = ChatPresentationWorker().resolve(ChatPresentationRequest(identity.copy(host = "other"), listOf(first, answer), emptyMap(), emptyMap(), emptyMap()))
        val switched = worker.resolve(ChatResourcesRequest(otherProjection, emptyMap(), emptySet(), emptySet(), false))
        assertTrue(switched.rows.values.all { it.downloads.isEmpty() && it.streaming.isEmpty() })
    }
}
