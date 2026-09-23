package dev.pi.remote

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.TreeMap
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Persists download metadata and a local partial file for resumable chunked transfers. */
class ArtifactDownloadStore(context: Context) {
    private val appContext = context.applicationContext
    private val temporaryDirectory = File(appContext.filesDir, "artifact-downloads")
    private val metadataFile = File(appContext.filesDir, "download-tasks.json")
    private val metadataTemporaryFile = File(appContext.filesDir, "download-tasks.json.tmp")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val tasks = linkedMapOf<String, ArtifactDownload>()
    private val active = mutableMapOf<String, ActiveDownload>()
    private val commandTasks = mutableMapOf<String, String>()

    private class InvalidDownloadContent(message: String) : IllegalStateException(message)

    private data class ActiveDownload(
        val taskId: String,
        val runtimeId: String,
        val transferId: String,
        val artifact: RemoteArtifact,
        val temporaryFile: File,
        var receivedBytes: Long,
        val pendingChunks: TreeMap<Long, ByteArray> = TreeMap(),
        var pendingBytes: Long = 0,
        /** Kept open for the whole transfer: opening/closing per 1 MiB chunk dominates throughput. */
        var output: RandomAccessFile? = null,
    )

    init {
        readTasks().forEach { task -> tasks[task.taskId] = task.asPausedIfNeeded() }
    }

    @Synchronized
    fun load(): List<ArtifactDownload> = tasks.values.toList()

    @Synchronized
    fun register(task: ArtifactDownload) {
        tasks[task.taskId] = task
        persistTasks()
    }

    @Synchronized
    fun resumeOffset(task: ArtifactDownload): Long {
        if (task.status == "completed") return 0
        val partLength = partFile(task.taskId).takeIf(File::exists)?.length() ?: 0
        val recordedBytes = if (task.receivedBytes == 0L) partLength else minOf(task.receivedBytes, partLength)
        val maximum = task.artifact?.size ?: Long.MAX_VALUE
        return minOf(recordedBytes, maximum)
    }

    @Synchronized
    fun bindCommand(commandId: String, taskId: String) {
        commandTasks[commandId] = taskId
    }

    @Synchronized
    fun start(runtimeId: String, transferId: String, offset: Long, artifact: RemoteArtifact): String =
        start(runtimeId, transferId, transferId, offset, artifact)

    @Synchronized
    fun start(
        runtimeId: String,
        commandId: String,
        transferId: String,
        offset: Long,
        artifact: RemoteArtifact,
    ): String {
        require(artifact.size >= 0) { "下载文件大小无效" }
        require(offset in 0..artifact.size) { "下载起点无效" }
        require(isSafeFileName(artifact.fileName)) { "下载文件名无效" }
        require(artifact.sha256.matches(Regex("^[a-f0-9]{64}$"))) { "下载校验值无效" }
        val boundTaskId = commandTasks.remove(commandId)
        val taskId = boundTaskId
            ?: findDownloadTaskId(tasks.values, runtimeId, artifact)
            ?: artifactDownloadTaskId(runtimeId, artifact.artifactId)
        val existing = tasks[taskId]
        if (existing != null && existing.status in setOf("completed", "failed") && boundTaskId == null) {
            return taskId
        }
        if (existing != null && existing.transferId == transferId &&
            existing.status in setOf("queued", "downloading", "paused") &&
            active.containsKey(artifactTransferKey(runtimeId, transferId))
        ) {
            return taskId
        }
        if (existing != null && existing.transferId != null && existing.transferId != transferId &&
            existing.commandId != null && existing.commandId != commandId
        ) {
            return taskId
        }
        removeActive { it.taskId == taskId }
        val temporaryFile = partFile(taskId)
        temporaryDirectory.mkdirs()
        val previousArtifact = existing?.artifact
        val sameArtifact = previousArtifact != null &&
            previousArtifact.size == artifact.size && previousArtifact.sha256 == artifact.sha256 &&
            (previousArtifact.artifactId == artifact.artifactId ||
                previousArtifact.path != null && previousArtifact.path == artifact.path)
        val canResume = sameArtifact && temporaryFile.exists()
        val availableBytes = if (canResume) {
            minOf(temporaryFile.length(), artifact.size)
        } else {
            temporaryFile.delete()
            0
        }
        val effectiveOffset = if (previousArtifact != null && !sameArtifact) 0 else offset
        if (effectiveOffset > availableBytes) error("下载临时文件不完整")
        val startOffset = availableBytes
        if (!temporaryFile.exists()) check(temporaryFile.createNewFile()) { "无法创建下载临时文件" }
        if (temporaryFile.length() != startOffset) {
            java.io.RandomAccessFile(temporaryFile, "rw").use { it.setLength(startOffset) }
        }
        val activeKey = artifactTransferKey(runtimeId, transferId)
        active[activeKey] = ActiveDownload(taskId, runtimeId, transferId, artifact, temporaryFile, startOffset)
        tasks[taskId] = (existing ?: ArtifactDownload(
            taskId = taskId,
            runtimeId = runtimeId,
            displayName = artifact.fileName,
            sourceArtifactId = artifact.artifactId,
            createdAt = System.currentTimeMillis(),
        )).copy(
            // Direct downloads are served by Host, while the task runtimeId is the source
            // session shown in the UI. Keep that source identity once the command is bound.
            runtimeId = existing?.runtimeId ?: runtimeId,
            displayName = existing?.displayName ?: artifact.fileName,
            commandId = commandId,
            sourcePath = existing?.sourcePath ?: artifact.path,
            sourceArtifactId = existing?.sourceArtifactId ?: artifact.artifactId,
            artifact = artifact,
            status = "downloading",
            transferId = transferId,
            receivedBytes = startOffset,
            error = null,
        )
        persistTasks()
        return taskId
    }

    @Synchronized
    fun append(runtimeId: String, transferId: String, offset: Long, data: ByteArray): ArtifactAppendResult {
        // A runtime can finish emitting a stream after the app has been killed. Reattach to the
        // persisted task when possible; otherwise this is a stale event from a transfer we no
        // longer own and must not turn into a repeated error dialog.
        val activeDownload = active[artifactTransferKey(runtimeId, transferId)]
        val download = activeDownload
            ?: recoverPersistedDownload(runtimeId, transferId)
            ?: return ArtifactAppendResult(null, false, 0)
        // The same artifact can have overlapping streams after a reconnect/retry. A chunk that
        // has already been written belongs to the older stream and is safe to discard.
        if (offset < download.receivedBytes) return ArtifactAppendResult(runtimeId, true, download.receivedBytes)
        if (offset > download.receivedBytes) {
            // Keep a bounded in-memory window for frames that arrive before their missing prefix.
            // The durable prefix remains the ACK contract, so a process restart safely discards
            // this cache and makes the sender retransmit it.
            require(offset <= download.artifact.size) { "下载数据偏移无效" }
            require(data.isNotEmpty()) { "下载数据长度无效" }
            require(data.size.toLong() <= download.artifact.size - offset) { "下载数据超过文件大小" }
            if (!download.pendingChunks.containsKey(offset) &&
                download.pendingChunks.size < MAX_PENDING_CHUNKS &&
                download.pendingBytes + data.size <= MAX_PENDING_BYTES
            ) {
                val copy = data.copyOf()
                download.pendingChunks[offset] = copy
                download.pendingBytes += copy.size
            }
            return ArtifactAppendResult(runtimeId, true, download.receivedBytes)
        }
        require(data.isNotEmpty()) { "下载数据长度无效" }
        require(data.size.toLong() <= download.artifact.size - download.receivedBytes) { "下载数据超过文件大小" }
        appendContiguous(download, data)
        while (true) {
            val pending = download.pendingChunks.remove(download.receivedBytes) ?: break
            download.pendingBytes -= pending.size
            appendContiguous(download, pending)
        }
        tasks[download.taskId]?.let { task ->
            tasks[download.taskId] = task.copy(receivedBytes = download.receivedBytes, status = "downloading")
        }
        // The durable prefix is the `.part` file itself: resume and recovery read its length,
        // so persisting task metadata on every 1 MiB chunk is pure overhead on the hot path.
        // start/finish/pause/cancel/close still persist the task list.
        return ArtifactAppendResult(runtimeId, true, download.receivedBytes)
    }

    @Synchronized
    fun finish(runtimeId: String, transferId: String, artifactId: String): FinishResult? {
        val key = artifactTransferKey(runtimeId, transferId)
        val download = active[key] ?: recoverPersistedDownload(runtimeId, transferId) ?: return null
        if (download.artifact.artifactId != artifactId) return null
        active.remove(key)?.let(::releaseActive)
        if (download.receivedBytes != download.artifact.size) {
            tasks[download.taskId]?.let { task ->
                tasks[download.taskId] = task.copy(
                    status = "paused",
                    commandId = null,
                    error = "下载中断，可继续下载",
                )
            }
            persistTasks()
            return null
        }
        return runCatching { publish(download) }
            .onSuccess { location ->
                tasks[download.taskId]?.let { task ->
                    tasks[download.taskId] = task.copy(
                        status = "completed",
                        commandId = null,
                        receivedBytes = download.artifact.size,
                        savedLocation = location,
                        error = null,
                    )
                }
                persistTasks()
            }
            .onFailure { error ->
                // 校验拒绝的前缀不能续传；发布失败则保留已经验证过的内容以便重试。
                val invalidContent = error is InvalidDownloadContent
                if (invalidContent) download.temporaryFile.delete()
                tasks[download.taskId]?.let { task ->
                    tasks[download.taskId] = task.copy(
                        status = "failed",
                        commandId = null,
                        receivedBytes = if (invalidContent) 0 else download.receivedBytes,
                        error = error.message,
                    )
                }
                persistTasks()
            }
            .map { location -> FinishResult(download.taskId, location) }
            .getOrThrow()
    }

    @Synchronized
    fun cancel(taskId: String): CancelResult? {
        val task = tasks[taskId] ?: return null
        if (task.status !in setOf("queued", "downloading", "paused")) return null
        val activeDownload = active.values.firstOrNull { it.taskId == taskId }
        removeActive { it.taskId == taskId }
        tasks[taskId] = task.copy(
            status = "cancelled",
            commandId = null,
            // Keep the transfer identity so an offline cancellation can be replayed when Relay reconnects.
            transferId = task.transferId,
            error = "下载已取消，可继续下载",
        )
        persistTasks()
        return CancelResult(task.runtimeId, activeDownload?.transferId ?: task.transferId)
    }

    /**
     * 删除下载记录。
     *
     * 回执只覆盖**被停掉的在途下载**：只有这些任务需要上层去通知 Host 取消（`transferId`）并清掉
     * 待处理命令。已下完的任务只是从列表里消失——文件已经落到用户选定的位置，没有在途传输要取消，
     * 也没有分片要删，所以不回执（`ArtifactUploadStore.delete` 同一口径）。
     */
    @Synchronized
    fun delete(taskIds: Set<String>): List<DeleteResult> {
        if (taskIds.isEmpty()) return emptyList()
        var removed = false
        val results = taskIds.mapNotNull { taskId ->
            val task = tasks.remove(taskId) ?: return@mapNotNull null
            removed = true
            val transferId = task.transferId ?: active.values.firstOrNull { it.taskId == taskId }?.transferId
            removeActive { it.taskId == taskId }
            if (task.status == "completed") return@mapNotNull null
            partFile(taskId).delete()
            DeleteResult(taskId, transferId)
        }
        // 只删掉已完成的任务时 results 为空，但元数据已经变了，同样要落盘。
        if (removed) persistTasks()
        return results
    }

    @Synchronized
    fun fail(runtimeId: String, transferId: String, artifactId: String, error: String?) {
        val key = artifactTransferKey(runtimeId, transferId)
        val download = active[key]
        if (download != null && download.artifact.artifactId == artifactId) {
            active.remove(key)?.let(::releaseActive)
            tasks[download.taskId]?.let { task ->
                if (task.status !in setOf("paused", "completed", "cancelled")) {
                    tasks[download.taskId] = task.copy(status = "failed", commandId = null, error = error)
                }
            }
            persistTasks()
        }
    }

    @Synchronized
    fun clear() {
        active.values.forEach { download ->
            releaseActive(download)
            download.temporaryFile.delete()
        }
        active.clear()
        commandTasks.clear()
        temporaryDirectory.deleteRecursively()
        metadataFile.delete()
        metadataTemporaryFile.delete()
        tasks.clear()
    }

    private fun readTasks(): List<ArtifactDownload> {
        if (!metadataFile.isFile) return emptyList()
        return runCatching {
            json.decodeFromString(ListSerializer(ArtifactDownload.serializer()), metadataFile.readText())
        }.getOrDefault(emptyList())
    }

    private fun persistTasks() {
        metadataFile.parentFile?.mkdirs()
        metadataTemporaryFile.writeText(json.encodeToString(tasks.values.toList()))
        if (!metadataTemporaryFile.renameTo(metadataFile)) {
            metadataFile.delete()
            check(metadataTemporaryFile.renameTo(metadataFile)) { "无法保存下载记录" }
        }
    }

    private fun ArtifactDownload.asPausedIfNeeded(): ArtifactDownload = if (status == "queued" || status == "downloading") {
        copy(status = "paused", commandId = null, error = "应用已重新启动，可继续下载")
    } else {
        this
    }

    private fun partFile(taskId: String): File = File(temporaryDirectory, "$taskId.part")

    /** Rebuilds the in-memory stream after a process restart from durable task metadata. */
    private fun recoverPersistedDownload(runtimeId: String, transferId: String): ActiveDownload? {
        val task = tasks.values.firstOrNull {
            // Persisted runtimeId is the source session. The incoming runtimeId is the Host
            // route, so transferId is the only stable identity across a restart.
            it.transferId == transferId &&
                it.status in setOf("queued", "downloading", "paused")
        } ?: return null
        val artifact = task.artifact ?: return null
        val temporaryFile = partFile(task.taskId)
        if (!temporaryFile.isFile) return null
        val receivedBytes = temporaryFile.length()
        if (receivedBytes > artifact.size) return null
        return ActiveDownload(task.taskId, runtimeId, transferId, artifact, temporaryFile, receivedBytes).also {
            active[artifactTransferKey(runtimeId, transferId)] = it
        }
    }

    private fun publish(download: ActiveDownload): String {
        verifyChecksum(download)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, download.artifact.fileName)
                put(MediaStore.Downloads.MIME_TYPE, download.artifact.mimeType)
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = appContext.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("无法创建手机下载文件")
            try {
                appContext.contentResolver.openOutputStream(uri)?.use { output ->
                    download.temporaryFile.inputStream().use { input -> input.copyTo(output) }
                } ?: error("无法写入手机下载文件")
                appContext.contentResolver.update(
                    uri,
                    ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
                    null,
                    null,
                )
                download.temporaryFile.delete()
                return uri.toString()
            } catch (error: Throwable) {
                appContext.contentResolver.delete(uri, null, null)
                throw error
            }
        }

        val directory = appContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: File(appContext.filesDir, Environment.DIRECTORY_DOWNLOADS)
        directory.mkdirs()
        val target = uniqueTarget(directory, download.artifact.fileName)
        download.temporaryFile.copyTo(target, overwrite = false)
        download.temporaryFile.delete()
        return target.absolutePath
    }

    private fun appendContiguous(download: ActiveDownload, data: ByteArray) {
        val output = download.output ?: RandomAccessFile(download.temporaryFile, "rw").also { download.output = it }
        output.seek(download.receivedBytes)
        output.write(data)
        download.receivedBytes += data.size
    }

    /** Flushes and closes a transfer's file handle before the file is published or removed. */
    private fun releaseActive(download: ActiveDownload) {
        runCatching { download.output?.close() }
        download.output = null
    }

    /** Removes every active stream matching [match], releasing its file handle first. */
    private fun removeActive(match: (ActiveDownload) -> Boolean) {
        val keys = active.filterValues(match).keys.toList()
        for (key in keys) active.remove(key)?.let(::releaseActive)
    }

    private fun verifyChecksum(download: ActiveDownload) {
        if (download.temporaryFile.length() != download.artifact.size) {
            throw InvalidDownloadContent("下载文件大小校验失败")
        }
        val digest = MessageDigest.getInstance("SHA-256")
        download.temporaryFile.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count <= 0) break
                digest.update(buffer, 0, count)
            }
        }
        if (digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) } != download.artifact.sha256) {
            throw InvalidDownloadContent("下载文件校验失败")
        }
    }

    private fun uniqueTarget(directory: File, fileName: String): File {
        var target = File(directory, fileName)
        var suffix = 1
        while (target.exists()) {
            target = File(directory, "$fileName ($suffix)")
            suffix += 1
        }
        return target
    }

    private companion object {
        // Must hold the whole device pull window (Android `PullScheduler`: 4 MiB initial,
        // 1–8 MiB bounds) plus slack. If this is smaller than the in-flight amount, a lost
        // leading chunk makes every following chunk un-bufferable, the durable offset stops
        // advancing, and the transfer can only crawl forward on retransmission timeouts.
        const val MAX_PENDING_CHUNKS = 32
        const val MAX_PENDING_BYTES = 32L * 1024 * 1024
    }

    private fun isSafeFileName(fileName: String): Boolean = fileName.isNotBlank() &&
        fileName != "." && fileName != ".." &&
        !fileName.contains('/') && !fileName.contains('\\') &&
        fileName.none { it.code < 0x20 || it.code == 0x7f }
}

data class FinishResult(val taskId: String, val location: String)
data class CancelResult(val runtimeId: String, val transferId: String?)
data class DeleteResult(val taskId: String, val transferId: String?)
