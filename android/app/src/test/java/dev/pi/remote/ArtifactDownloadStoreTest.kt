package dev.pi.remote

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ArtifactDownloadStoreTest {
    @Test
    fun `file task identity is stable for the same runtime and path`() {
        val first = fileDownloadTaskId("runtime-a", "C:\\work\\report.zip")
        val second = fileDownloadTaskId("runtime-a", "C:\\work\\report.zip")

        assertEquals(first, second)
        assertNotEquals(first, fileDownloadTaskId("runtime-b", "C:\\work\\report.zip"))
        assertNotEquals(first, fileDownloadTaskId("runtime-a", "C:\\work\\other.zip"))
        assertNotEquals(
            fileDownloadTaskId("runtime-a", "session-1", "C:\\work\\report.zip"),
            fileDownloadTaskId("runtime-a", "session-2", "C:\\work\\report.zip"),
        )
    }

    @Test
    fun `download display name handles Windows and Unix paths`() {
        assertEquals("app-debug.apk", downloadDisplayName("D:\\build\\app-debug.apk"))
        assertEquals("result.zip", downloadDisplayName("/tmp/reports/result.zip"))
        assertEquals("电脑文件", downloadDisplayName("/"))
    }

    @Test
    fun `duplicate chunks from overlapping transfers are ignored`() {
        val root = Files.createTempDirectory("artifact-download-store-").toFile()
        try {
            val context = TestContext(root)
            val artifact = RemoteArtifact(
                artifactId = "00000000-0000-4000-8000-000000000011",
                fileName = "report.zip",
                sha256 = "0".repeat(64),
                mimeType = "application/zip",
                size = 6,
            )
            val store = ArtifactDownloadStore(context)
            store.bindCommand("command-1", "task-1")
            store.start("runtime-a", "command-1", 0, artifact)
            store.append("runtime-a", "command-1", 0, byteArrayOf(97, 98, 99))
            store.append("runtime-a", "command-1", 0, byteArrayOf(97, 98, 99))

            assertEquals(3L, store.load().single().receivedBytes)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `out of order chunks are acknowledged without corrupting the partial file`() {
        val root = Files.createTempDirectory("artifact-download-store-").toFile()
        try {
            val context = TestContext(root)
            val artifact = RemoteArtifact(
                artifactId = "00000000-0000-4000-8000-000000000012",
                fileName = "report.zip",
                sha256 = "0".repeat(64),
                mimeType = "application/zip",
                size = 9,
            )
            val store = ArtifactDownloadStore(context)
            store.bindCommand("command-1", "task-1")
            store.start("runtime-a", "command-1", 0, artifact)
            store.append("runtime-a", "command-1", 0, byteArrayOf(97, 98, 99))
            store.append("runtime-a", "command-1", 6, byteArrayOf(103, 104, 105))
            store.append("runtime-a", "command-1", 3, byteArrayOf(100, 101, 102))
            store.append("runtime-a", "command-1", 6, byteArrayOf(103, 104, 105))

            assertEquals("downloading", store.load().single().status)
            assertEquals(9L, store.load().single().receivedBytes)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `checksum mismatch rejects corrupt bytes and retry downloads a fresh copy`() {
        val root = Files.createTempDirectory("artifact-download-store-").toFile()
        try {
            val context = TestContext(root)
            val artifact = RemoteArtifact(
                artifactId = "00000000-0000-4000-8000-000000000021",
                fileName = "report.zip",
                mimeType = "application/zip",
                size = 3,
                sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            )
            val store = ArtifactDownloadStore(context)
            store.start("runtime-a", "command-1", "transfer-1", 0, artifact)
            store.append("runtime-a", "transfer-1", 0, byteArrayOf(120, 121, 122))

            assertThrows(IllegalStateException::class.java) {
                store.finish("runtime-a", "transfer-1", artifact.artifactId)
            }
            val failed = store.load().single()
            assertEquals("failed", failed.status)
            assertEquals(0L, store.resumeOffset(failed))

            // 重启后仍不能信任已被校验拒绝的前缀；用真实重试流程重新获取正确字节。
            val restarted = ArtifactDownloadStore(context)
            val retry = restarted.load().single()
            assertEquals(0L, restarted.resumeOffset(retry))
            restarted.register(retry.copy(status = "queued", commandId = "command-2", transferId = null))
            restarted.bindCommand("command-2", retry.taskId)
            restarted.start("runtime-a", "command-2", "transfer-2", 0, artifact)
            restarted.append("runtime-a", "transfer-2", 0, byteArrayOf(97, 98, 99))
            val finished = restarted.finish("runtime-a", "transfer-2", artifact.artifactId)!!
            assertEquals("abc", File(finished.location).readText())
            assertEquals("completed", restarted.load().single().status)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `restart keeps the durable prefix and adopts a transfer that is still sending chunks`() {
        val root = Files.createTempDirectory("artifact-download-store-").toFile()
        try {
            val context = TestContext(root)
            val artifact = RemoteArtifact(
                artifactId = "00000000-0000-4000-8000-000000000015",
                fileName = "report.zip",
                sha256 = "0".repeat(64),
                mimeType = "application/zip",
                size = 6,
            )
            val firstStore = ArtifactDownloadStore(context)
            firstStore.register(
                ArtifactDownload(
                    taskId = "task-1",
                    runtimeId = "runtime-a",
                    displayName = artifact.fileName,
                    sourceArtifactId = artifact.artifactId,
                    artifact = artifact,
                ),
            )
            firstStore.bindCommand("command-1", "task-1")
            firstStore.start("runtime-a", "command-1", "transfer-1", 0, artifact)
            firstStore.append("runtime-a", "transfer-1", 0, byteArrayOf(97, 98, 99))

            val restartedStore = ArtifactDownloadStore(context)
            assertEquals("paused", restartedStore.load().single().status)
            // The runtime may keep sending chunks after the app restarted; they are adopted by the
            // persisted transfer without waiting for a fresh start.
            restartedStore.append("runtime-a", "transfer-1", 3, byteArrayOf(100, 101, 102))
            assertEquals(6L, restartedStore.load().single().receivedBytes)

            // A replayed start must keep that durable prefix instead of rewinding the transfer.
            val replayedStore = ArtifactDownloadStore(context)
            replayedStore.start("runtime-a", "command-1", "transfer-1", 0, artifact)
            assertEquals(6L, replayedStore.load().single().receivedBytes)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `host route can serve a task owned by a different source runtime`() {
        val root = Files.createTempDirectory("artifact-download-store-").toFile()
        try {
            val context = TestContext(root)
            val artifact = RemoteArtifact(
                artifactId = "00000000-0000-4000-8000-000000000017",
                fileName = "app.apk",
                sha256 = "0".repeat(64),
                mimeType = "application/vnd.android.package-archive",
                size = 6,
            )
            val store = ArtifactDownloadStore(context)
            store.register(
                ArtifactDownload(
                    taskId = "task-1",
                    runtimeId = "source-runtime",
                    displayName = artifact.fileName,
                    sourceArtifactId = artifact.artifactId,
                    artifact = artifact,
                ),
            )
            store.bindCommand("command-1", "task-1")
            store.start("host-1", "command-1", "transfer-1", 0, artifact)

            store.append("host-1", "transfer-1", 0, byteArrayOf(1, 2, 3))

            assertEquals("source-runtime", store.load().single().runtimeId)
            assertEquals(3L, store.load().single().receivedBytes)

            val restartedStore = ArtifactDownloadStore(context)
            restartedStore.append("host-1", "transfer-1", 3, byteArrayOf(4, 5, 6))
            assertEquals(6L, restartedStore.load().single().receivedBytes)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `deleting unfinished tasks removes metadata and partial files but completed files remain`() {
        val root = Files.createTempDirectory("artifact-download-store-").toFile()
        try {
            val context = TestContext(root)
            val unfinishedArtifact = RemoteArtifact(
                artifactId = "00000000-0000-4000-8000-000000000031",
                fileName = "unfinished.zip",
                sha256 = "0".repeat(64),
                mimeType = "application/zip",
                size = 6,
            )
            val completedArtifact = RemoteArtifact(
                artifactId = "00000000-0000-4000-8000-000000000032",
                fileName = "completed.zip",
                sha256 = "0".repeat(64),
                mimeType = "application/zip",
                size = 3,
            )
            val store = ArtifactDownloadStore(context)
            store.start("runtime-a", "transfer-1", 0, unfinishedArtifact)
            store.append("runtime-a", "transfer-1", 0, byteArrayOf(1, 2, 3))
            store.register(
                ArtifactDownload(
                    taskId = "completed-task",
                    runtimeId = "runtime-a",
                    displayName = completedArtifact.fileName,
                    sourceArtifactId = completedArtifact.artifactId,
                    artifact = completedArtifact,
                    status = "completed",
                    receivedBytes = completedArtifact.size,
                    transferId = "transfer-completed",
                    savedLocation = "content://downloads/completed",
                ),
            )

            val unfinishedTaskId = store.load().first { it.artifact?.artifactId == unfinishedArtifact.artifactId }.taskId
            val unfinishedPart = File(root, "artifact-downloads/$unfinishedTaskId.part")
            assertEquals(true, unfinishedPart.isFile)
            assertEquals(
                listOf(DeleteResult(unfinishedTaskId, "transfer-1")),
                store.delete(setOf(unfinishedTaskId, "completed-task")),
            )

            assertEquals(emptyList<ArtifactDownload>(), store.load())
            assertEquals(false, unfinishedPart.exists())
            val restartedStore = ArtifactDownloadStore(context)
            assertEquals(emptyList<ArtifactDownload>(), restartedStore.load())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `stale start cannot replace a newer requested transfer`() {
        val root = Files.createTempDirectory("artifact-download-store-").toFile()
        try {
            val context = TestContext(root)
            val artifact = RemoteArtifact(
                artifactId = "00000000-0000-4000-8000-000000000016",
                fileName = "report.zip",
                sha256 = "0".repeat(64),
                mimeType = "application/zip",
                size = 6,
            )
            val store = ArtifactDownloadStore(context)
            store.register(ArtifactDownload("task-1", "runtime-a", displayName = artifact.fileName, artifact = artifact))
            store.bindCommand("command-1", "task-1")
            store.start("runtime-a", "command-1", "transfer-1", 0, artifact)
            store.register(store.load().single().copy(commandId = "command-2", transferId = null, status = "queued"))
            store.start("runtime-a", "command-2", "transfer-2", 0, artifact)
            store.start("runtime-a", "command-1", "transfer-1", 0, artifact)

            assertEquals("transfer-2", store.load().single().transferId)
            assertEquals("command-2", store.load().single().commandId)
        } finally {
            root.deleteRecursively()
        }
    }

    private class TestContext(root: File) : ContextWrapper(null) {
        private val files = root

        override fun getApplicationContext(): Context = this
        override fun getFilesDir(): File = files
        override fun getExternalFilesDir(type: String?): File = File(files, "downloads")
    }
}
