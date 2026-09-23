package dev.pi.remote

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Test

class ArtifactUploadStoreTest {
    @Test
    fun `deletion returns unfinished uploads to cancel and keeps completed remote files`() {
        val root = Files.createTempDirectory("upload-store-").toFile()
        val context = object : ContextWrapper(null) {
            override fun getApplicationContext(): Context = this
            override fun getFilesDir(): File = root
        }
        try {
            val store = ArtifactUploadStore(context)
            val task = UploadTask(
                taskId = "active", runtimeId = "runtime", sourceUri = "content://file",
                displayName = "file.bin", size = 1, sha256 = "0".repeat(64), directory = "D:/uploads",
            )
            store.register(task)
            store.bindUpload("active", "active-upload", 0)
            store.register(task.copy(taskId = "done", uploadId = "done-upload"))
            store.complete("done", "D:/uploads/file.bin")
            store.register(task.copy(taskId = "queued"))

            // 上传经 App 重启会变 paused，但删除时仍需通知 Host 收掉已分配的传输。
            val restarted = ArtifactUploadStore(context)
            assertEquals(listOf("active-upload"), restarted.delete(setOf("active", "done", "queued")))
            assertEquals(emptyList<UploadTask>(), ArtifactUploadStore(context).load())
        } finally {
            root.deleteRecursively()
        }
    }
}
