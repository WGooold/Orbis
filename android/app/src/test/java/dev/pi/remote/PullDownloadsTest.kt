package dev.pi.remote

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PullDownloadsTest {
    @Test
    fun `empty and recovered complete files are published once without requesting more bytes`() {
        val root = Files.createTempDirectory("pull-downloads-").toFile()
        val context = object : ContextWrapper(null) {
            override fun getApplicationContext(): Context = this
            override fun getFilesDir(): File = root
            override fun getExternalFilesDir(type: String?): File = File(root, "downloads")
        }
        var store = ArtifactDownloadStore(context)
        try {
            for ((index, data) in listOf(byteArrayOf(), "already received".toByteArray()).withIndex()) {
                val artifact = RemoteArtifact(
                    artifactId = "00000000-0000-4000-8000-00000000000$index",
                    fileName = "file-$index.bin",
                    mimeType = "application/octet-stream",
                    size = data.size.toLong(),
                    sha256 = MessageDigest.getInstance("SHA-256").digest(data)
                        .joinToString("") { "%02x".format(it.toInt() and 0xff) },
                )
                val transferId = "transfer-$index"
                val taskId = store.start("host", "command-$index", transferId, 0, artifact)
                if (data.isNotEmpty()) {
                    store.append("host", transferId, 0, data)
                    // App 在发布前重启：由同一临时文件恢复一条新的传输。
                    store.cancel(taskId)
                    store = ArtifactDownloadStore(context)
                    val paused = store.load().first { it.taskId == taskId }
                    store.register(paused.copy(status = "queued", commandId = "retry", transferId = null))
                    store.bindCommand("retry", taskId)
                    store.start("host", "retry", transferId, store.resumeOffset(paused), artifact)
                }
                var published = 0
                lateinit var pulls: PullDownloads
                pulls = PullDownloads(
                    read = { _, _, _, _ -> error("complete file must not request bytes") },
                    finish = { id ->
                        // 收尾尚未返回时，另一次 sync 看到的仍可能是 downloading。
                        // 它不能重建同一传输并再次发布。
                        pulls.sync(store.load(), interactive = false, connected = true)
                        val result = store.finish("host", id, artifact.artifactId)
                        assertNotNull(result)
                        assertTrue(File(result!!.location).readBytes().contentEquals(data))
                        published += 1
                    },
                )
                pulls.sync(store.load(), interactive = false, connected = true)
                pulls.sync(store.load(), interactive = false, connected = true)
                assertEquals(1, published)
                assertEquals("completed", store.load().first { it.taskId == taskId }.status)
            }
        } finally {
            store.clear()
            root.deleteRecursively()
        }
    }
}
