package dev.pi.remote

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CachedHistoryTreeTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun runtime(
        runtimeId: String,
        sessionId: String,
        cwd: String,
        hostname: String?,
    ) = RuntimeSummary(
        runtimeId = runtimeId,
        name = "Pi runtime",
        cwd = cwd,
        status = "online",
        sessionId = sessionId,
        hostname = hostname,
    )

    private fun session(
        sessionId: String,
        cwd: String,
        modifiedAt: Long,
        hasHistoryCache: Boolean = true,
        hostname: String? = null,
    ) = SessionCatalogEntry(
        sessionId = sessionId,
        cwd = cwd,
        modifiedAt = modifiedAt,
        hasHistoryCache = hasHistoryCache,
        hostname = hostname,
    )

    private fun userEntry(id: String, parentId: String?, text: String) = SessionGraphEntry(
        entryId = id,
        parentId = parentId,
        type = "message",
        timestamp = "2026-01-01T00:00:00.000Z",
        data = buildJsonObject {
            put(
                "message",
                buildJsonObject {
                    put("role", "user")
                    put("content", text)
                },
            )
        },
    )

    private fun assistantEntry(id: String, parentId: String?, text: String) = userEntry(id, parentId, text)
        .copy(
            data = buildJsonObject {
                put(
                    "message",
                    buildJsonObject {
                        put("role", "assistant")
                        put("content", text)
                    },
                )
            },
        )

    @Test
    fun `tree nests sessions under host then directory`() {
        val state = RemoteState(hostId = "paired-host", hostName = "devbox",
            runtimes = mapOf(
                "r1" to runtime("r1", "s1", "D:\\work\\alpha", "devbox"),
                "r2" to runtime("r2", "s2", "D:\\work\\beta", "devbox"),
                "r3" to runtime("r3", "s3", "D:\\work\\alpha", "laptop"),
            ),
            sessions = mapOf(
                "s1" to session("s1", "D:\\work\\alpha", modifiedAt = 1),
                "s2" to session("s2", "D:\\work\\beta", modifiedAt = 2),
                "s3" to session("s3", "D:\\work\\alpha", modifiedAt = 3),
            ),
        )

        val tree = cachedHistoryTree(state)

        assertEquals(listOf("paired-host"), tree.map { it.hostId })
        assertEquals(listOf("D:\\work\\alpha", "D:\\work\\beta"), tree[0].directories.map { it.cwd })
        assertEquals(listOf("s3", "s1"), tree[0].directories[0].sessions.map { it.sessionId })
        assertEquals(listOf("s2"), tree[0].directories[1].sessions.map { it.sessionId })
    }

    @Test
    fun `offline sessions with different legacy names share the paired Host`() {
        val state = RemoteState(hostId = "paired-host", hostName = "devbox",
            sessions = mapOf(
                "s1" to session("s1", "D:\\work\\alpha", modifiedAt = 1, hostname = "devbox"),
                "s2" to session("s2", "D:\\work\\beta", modifiedAt = 2, hostname = "laptop"),
            ),
        )

        val tree = cachedHistoryTree(state)

        assertEquals(listOf("devbox"), tree.map { it.hostname })
    }

    @Test
    fun `runtime and stored names cannot override the paired Host`() {
        val state = RemoteState(hostId = "paired-host", hostName = "devbox",
            runtimes = mapOf("r1" to runtime("r1", "s1", "D:\\work\\alpha", "devbox")),
            sessions = mapOf("s1" to session("s1", "D:\\work\\alpha", modifiedAt = 1, hostname = "stale-host")),
        )

        val tree = cachedHistoryTree(state)

        assertEquals(listOf("devbox"), tree.map { it.hostname })
    }

    @Test
    fun `opening a session without a runtime hostname keeps it in the same sidebar directory`() {
        val cwd = "D:\\work\\alpha"
        val initial = RemoteState(hostId = "paired-host", hostName = "devbox",
            sessions = mapOf(
                "s1" to session("s1", cwd, modifiedAt = 2, hostname = "devbox"),
                "s2" to session("s2", cwd, modifiedAt = 1, hostname = "devbox"),
            ),
        )
        val before = cachedHistoryTree(initial).single()

        for (runtimeId in listOf("r1", "codex:s1")) {
            for (hostname in listOf(null, "", "  ")) {
                val online = initial.copy(
                    runtimes = mapOf(runtimeId to runtime(runtimeId, "s1", cwd, hostname)),
                    selectedRuntimeId = runtimeId,
                )
                val host = cachedHistoryTree(online).single()
                assertEquals(before.hostname, host.hostname)
                val directory = host.directories.single()
                assertEquals(cwd, directory.cwd)
                assertEquals(listOf("s1", "s2"), directory.sessions.map { it.sessionId })
                val row = directory.sessions.first()
                assertEquals("devbox", row.hostname)
                assertEquals(runtimeId, row.runtimeId)
                assertTrue(row.isOnline)
            }
        }
    }

    @Test
    fun `an online session uses the catalog directory until its runtime reports one`() {
        val storedCwd = "D:\\work\\alpha"
        val initial = RemoteState(hostId = "paired-host", hostName = "devbox",
            sessions = mapOf("s1" to session("s1", storedCwd, modifiedAt = 1, hostname = "devbox")),
        )
        for (runtimeCwd in listOf("", "  ", "D:\\work\\beta")) {
            val online = initial.copy(
                runtimes = mapOf("r1" to runtime("r1", "s1", runtimeCwd, "devbox")),
            )
            val directory = cachedHistoryTree(online).single().directories.single()
            val expectedCwd = if (runtimeCwd.isBlank()) storedCwd else runtimeCwd
            assertEquals(expectedCwd, directory.cwd)
            assertEquals(expectedCwd, directory.sessions.single().cwd)
        }
    }

    @Test
    fun `loading history and closing a session preserve its sidebar host`() {
        val entry = session("s1", "D:\\work\\alpha", modifiedAt = 10, hasHistoryCache = false, hostname = "devbox")
            .copy(name = "Saved session", agentKind = "codex", archived = false)
        for (hostname in listOf(null, "", "  ", "new-host")) {
            val cached = entry.withHistoryCache(hostname)
            val expectedHost = if (hostname.isNullOrBlank()) "devbox" else hostname
            assertEquals(entry.copy(hasHistoryCache = true, hostname = expectedHost), cached)
            val offline = RemoteState(hostId = "paired-host", hostName = "devbox", sessions = mapOf(entry.sessionId to cached))
            val host = cachedHistoryTree(offline).single()
            assertEquals("devbox", host.hostname)
            assertEquals(entry.cwd, host.directories.single().cwd)
            val row = host.directories.single().sessions.single()
            assertEquals(entry.sessionId, row.sessionId)
            assertEquals(false, row.isOnline)
        }
    }

    @Test
    fun `sessions without hostname share the same paired Host as named sessions`() {
        val state = RemoteState(hostId = "paired-host", hostName = "devbox",
            sessions = mapOf(
                "s1" to session("s1", "D:\\work\\alpha", modifiedAt = 1),
                "s2" to session("s2", "D:\\work\\beta", modifiedAt = 2, hostname = "devbox"),
            ),
        )

        val tree = cachedHistoryTree(state)

        assertEquals(listOf("devbox"), tree.map { it.hostname })
        assertEquals(setOf("s1", "s2"), tree.single().directories.flatMap { it.sessions }.map { it.sessionId }.toSet())
    }

    @Test
    fun `sessions without a history cache still appear and newest comes first`() {
        val state = RemoteState(hostId = "paired-host", hostName = "devbox",
            sessions = mapOf(
                "s1" to session("s1", "D:\\work", modifiedAt = 1, hostname = "devbox"),
                "s2" to session("s2", "D:\\work", modifiedAt = 5, hostname = "devbox"),
                "s3" to session("s3", "D:\\work", modifiedAt = 9, hasHistoryCache = false, hostname = "devbox"),
            ),
        )

        val tree = cachedHistoryTree(state)

        // 侧栏是「聊天记录」的全量目录：电脑上有过的会话都要在，哪怕手机没缓存过它。
        // 没缓存只是意味着没有只读历史可看，点它照样能把会话加载进一个进程。
        assertEquals(1, tree.size)
        assertEquals(1, tree.single().directories.size)
        val rows = tree.single().directories.single().sessions
        assertEquals(listOf("s3", "s2", "s1"), rows.map { it.sessionId })
        assertEquals(false, rows.first().isOnline)
        assertEquals(false, rows.first().catalogEntry?.hasHistoryCache)
    }

    @Test
    fun `sidebar orders by modified time and does not promote online rows`() {
        val state = RemoteState(hostId = "paired-host", hostName = "devbox",
            runtimes = mapOf("r1" to runtime("r1", "s1", "D:\\work", "devbox")),
            sessions = mapOf(
                "s1" to session("s1", "D:\\work", modifiedAt = 1, hostname = "devbox"),
                "s2" to session("s2", "D:\\work", modifiedAt = 9, hasHistoryCache = false, hostname = "devbox"),
            ),
        )

        val tree = cachedHistoryTree(state)

        // 侧栏是聊天记录的目录，排序只看会话本身有多新：正在被进程打开的会话不会因此提前
        // （「哪些进程开着」是主页面的职责）。这里把这个默契钉住，免得以后被顺手改掉。
        val rows = tree.single().directories.single().sessions
        assertEquals(listOf("s2", "s1"), rows.map { it.sessionId })
        assertEquals(true, rows.last().isOnline)
    }

    @Test
    fun `directories are ordered by their newest session modified time`() {
        val state = RemoteState(hostId = "paired-host", hostName = "devbox",
            sessions = mapOf(
                "old" to session("old", "D:\\work\\old", modifiedAt = 100, hostname = "devbox"),
                "new" to session("new", "D:\\work\\new", modifiedAt = 300, hostname = "devbox"),
                "newer" to session("newer", "D:\\work\\new", modifiedAt = 500, hostname = "devbox"),
            ),
        )

        val tree = cachedHistoryTree(state)

        assertEquals(
            listOf("D:\\work\\new", "D:\\work\\old"),
            tree.single().directories.map { it.cwd },
        )
        assertEquals(500L, tree.single().directories.first().modifiedAt)
    }

    @Test
    fun `online runtimes appear even without a cached catalog entry`() {
        val state = RemoteState(hostId = "paired-host", hostName = "devbox",
            runtimes = mapOf(
                "r1" to runtime("r1", "live-1", "D:\\work\\alpha", "devbox"),
            ),
        )

        val tree = cachedHistoryTree(state)

        assertEquals(listOf("devbox"), tree.map { it.hostname })
        val row = tree.single().directories.single().sessions.single()
        assertEquals("live-1", row.sessionId)
        assertEquals("r1", row.runtimeId)
        assertTrue(row.isOnline)
    }

    @Test
    fun `online runtime deduplicates the matching cached session`() {
        val state = RemoteState(hostId = "paired-host", hostName = "devbox",
            runtimes = mapOf("r1" to runtime("r1", "s1", "D:\\work\\alpha", "devbox")),
            sessions = mapOf("s1" to session("s1", "D:\\work\\alpha", modifiedAt = 99, hostname = "devbox")),
        )

        val tree = cachedHistoryTree(state)
        val rows = tree.single().directories.single().sessions
        assertEquals(1, rows.size)
        assertTrue(rows.single().isOnline)
    }

    @Test
    fun `firstUserMessageTitle returns the first user message of the branch`() {
        val graph = SessionGraph(
            sessionId = "s1",
            entries = listOf(
                userEntry("u1", null, "这是第一句"),
                assistantEntry("a1", "u1", "收到"),
                userEntry("u2", "a1", "这是第二句"),
            ).associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("u2"),
        )

        assertEquals("这是第一句", graph.firstUserMessageTitle(json))
    }

    @Test
    fun `firstUserMessageTitle returns null when the branch has no user message`() {
        val graph = SessionGraph(
            sessionId = "s1",
            entries = listOf(assistantEntry("a1", null, "你好"))
                .associateBy(SessionGraphEntry::entryId),
            cursor = SessionBranchCursor("a1"),
        )

        assertNull(graph.firstUserMessageTitle(json))
    }
}
