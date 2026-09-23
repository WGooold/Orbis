package dev.pi.remote

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.InputStream
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * 手机上传到电脑的任务（spec: docs/adr/0012-receiver-driven-upload.md）。
 *
 * 与下载的 `ArtifactDownload` 镜像，但**发送方是手机**，所以这里不需要 `.part`：
 * 源文件本来就在手机上，持久前缀是 Host 报的 `receivedBytes`，我们只记它。
 */
@Serializable
data class UploadTask(
    val taskId: String,
    val runtimeId: String,
    /** 手机上的 `content://` URI。进程重启后靠它续传。 */
    val sourceUri: String,
    val displayName: String,
    val size: Long,
    val sha256: String,
    val directory: String,
    val mimeType: String? = null,
    /** Host 受理后分配的传输标识。 */
    val uploadId: String? = null,
    val status: String = "queued",
    val sentBytes: Long = 0,
    /** Host 确认已落盘的前缀。 */
    val durableBytes: Long = 0,
    /** `file.upload.finished` 报回的电脑端路径。 */
    val remotePath: String? = null,
    val error: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
)

/** 一条消息最多带几个附件（与协议的 `MAX_MESSAGE_ATTACHMENTS` 同值）。 */
internal const val MAX_ATTACHMENTS_PER_MESSAGE = 10

/** 单个上传文件的上限（与 `packages/protocol` 的 `MAX_UPLOAD_BYTES` 同值）。 */
internal const val MAX_UPLOAD_BYTES = 100L * 1024 * 1024

/**
 * 上传任务在电脑上的落地目录：会话 cwd 下的 `.pi-remote-uploads`。
 *
 * 分隔符要跟着 cwd 的形态走：Windows 的 cwd 形如 `D:\proj`，用 `/` 拼出来的路径 Node 也能
 * 处理，但会变成 `D:/proj\.pi-remote-uploads` 这种混合形式——日志和后来的人都会被它绊一下。
 */
/**
 * 上传的落盘目录：`<cwd>/.pi-remote-uploads/<sha256>`。
 *
 * 目录带内容摘要段是**重名问题的解**：发送端不知道电脑上已有什么文件，若所有上传都落在
 * 同一个目录，两个同名文件会互相覆盖、且「按路径引用」无法区分指哪一个。sha256 相同 =
 * 内容相同，共用一个目录恰好与续传语义一致（续传身份本来就含 sha256）；内容不同则目录
 * 必不同，路径引用天然无歧义。
 */
internal fun uploadDirectoryFor(cwd: String, sha256: String): String {
    val trimmed = cwd.trimEnd('\\', '/')
    val windows = cwd.contains('\\') || Regex("^[A-Za-z]:").containsMatchIn(cwd)
    return if (windows) "$trimmed\\.pi-remote-uploads\\$sha256" else "$trimmed/.pi-remote-uploads/$sha256"
}

/** 选择器里的一份待传文件。 */
data class UploadSource(
    val displayName: String,
    val size: Long,
    val sha256: String,
    val mimeType: String?,
)

/**
 * 上传任务的持久化与源文件读取。
 *
 * 源文件是手机上的 `content://`，没有随机访问保证，所以读取策略是「顺序读 + 需要时重开并
 * 跳过」：调度器正常顺序推进时复用同一个流，超时从持久前缀重发时才重开。缓存按 task 持一个
 * 流，[close] 负责收口，避免漏 fd。
 */
class ArtifactUploadStore(context: Context) {
    private val appContext = context.applicationContext
    private val metadataFile = java.io.File(appContext.filesDir, "upload-tasks.json")
    private val metadataTemporaryFile = java.io.File(appContext.filesDir, "upload-tasks.json.tmp")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val tasks = linkedMapOf<String, UploadTask>()

    private class OpenSource(val stream: InputStream, var position: Long)

    private val open = mutableMapOf<String, OpenSource>()

    init {
        readTasks().forEach { task -> tasks[task.taskId] = task.asPausedIfNeeded() }
    }

    @Synchronized
    fun load(): List<UploadTask> = tasks.values.toList()

    @Synchronized
    fun find(taskId: String): UploadTask? = tasks[taskId]

    @Synchronized
    fun register(task: UploadTask) {
        tasks[task.taskId] = task
        persistTasks()
    }

    @Synchronized
    fun update(taskId: String, transform: (UploadTask) -> UploadTask) {
        val task = tasks[taskId] ?: return
        tasks[taskId] = transform(task)
        persistTasks()
    }

    /**
     * 记下载入进度。
     *
     * `durableBytes` 单调不减：Host 重发的 `progress` 可能与旧信用乱序到达，
     * 把游标拽回去会让已经确认过的字节再发一遍。
     */
    @Synchronized
    fun noteProgress(taskId: String, receivedBytes: Long) {
        val task = tasks[taskId] ?: return
        if (receivedBytes <= task.durableBytes) return
        tasks[taskId] = task.copy(durableBytes = receivedBytes)
        persistTasks()
    }

    @Synchronized
    fun bindUpload(taskId: String, uploadId: String, receivedBytes: Long) {
        val task = tasks[taskId] ?: return
        tasks[taskId] = task.copy(
            uploadId = uploadId,
            status = "uploading",
            durableBytes = receivedBytes,
            sentBytes = receivedBytes,
            error = null,
        )
        persistTasks()
    }

    @Synchronized
    fun complete(taskId: String, remotePath: String) {
        val task = tasks[taskId] ?: return
        tasks[taskId] = task.copy(
            status = "completed",
            remotePath = remotePath,
            durableBytes = task.size,
            sentBytes = task.size,
            error = null,
        )
        closeSource(taskId)
        persistTasks()
    }

    @Synchronized
    fun fail(taskId: String, error: String?) {
        val task = tasks[taskId] ?: return
        // 已经完成的不能被一条迟到的失败改掉。
        if (tasks[taskId]?.status == "completed") return
        tasks[taskId] = task.copy(status = "failed", error = error)
        closeSource(taskId)
        persistTasks()
    }

    /** 删除本地任务并返回需要通知 Host 取消的传输；已完成文件不受影响。 */
    @Synchronized
    fun delete(taskIds: Set<String>): List<String> {
        val cancelled = mutableListOf<String>()
        for (taskId in taskIds) {
            val task = tasks.remove(taskId) ?: continue
            if (task.status != "completed") task.uploadId?.let(cancelled::add)
            closeSource(taskId)
        }
        persistTasks()
        return cancelled
    }

    /**
     * 读一段源文件。
     *
     * 返回的字节数**可能少于** [length]（源在传输中被改动/截断）。调用方必须以实际长度为准
     * 推进游标——按请求长度推进会让游标与真实内容错位，最后 Host 算的 sha256 必然对不上。
     */
    @Synchronized
    fun read(taskId: String, offset: Long, length: Int): ByteArray {
        val task = tasks[taskId] ?: error("上传任务不存在")
        var source = openSource(task)
        if (source.position != offset) {
            // 重传：content:// 不保证可 seek，重开并跳过是最稳的做法。
            // 注意必须改用 **重开后的流** 读：下面若继续用旧的 `source`，读到的就是
            // 刚被 closeSource 关闭的流 —— `IOException: Stream Closed`，RTO 每次重传都撞。
            closeSource(taskId)
            source = openSource(task)
            skipFully(source.stream, offset)
            source.position = offset
        }
        val buffer = ByteArray(minOf(length.toLong(), task.size - offset).coerceAtLeast(0).toInt())
        if (buffer.isEmpty()) return buffer
        var read = 0
        while (read < buffer.size) {
            val count = source.stream.read(buffer, read, buffer.size - read)
            if (count <= 0) break
            read += count
        }
        source.position += read
        return if (read == buffer.size) buffer else buffer.copyOf(read)
    }

    @Synchronized
    fun closeAll() {
        for (taskId in open.keys.toList()) closeSource(taskId)
    }

    private fun openSource(task: UploadTask): OpenSource = open.getOrPut(task.taskId) {
        val stream = appContext.contentResolver.openInputStream(Uri.parse(task.sourceUri))
            ?: error("无法读取所选文件")
        OpenSource(stream, 0)
    }

    private fun closeSource(taskId: String) {
        open.remove(taskId)?.let { source -> runCatching { source.stream.close() } }
    }

    private fun skipFully(stream: InputStream, offset: Long) {
        var remaining = offset
        while (remaining > 0) {
            val skipped = stream.skip(remaining)
            if (skipped > 0) {
                remaining -= skipped
                continue
            }
            // skip() 允许返回 0（网络源常见），退化成读一个字节。
            if (stream.read() < 0) error("源文件已不可读，无法续传")
            remaining -= 1
        }
    }

    private fun readTasks(): List<UploadTask> {
        if (!metadataFile.isFile) return emptyList()
        return runCatching {
            json.decodeFromString(ListSerializer(UploadTask.serializer()), metadataFile.readText())
        }.getOrDefault(emptyList())
    }

    private fun persistTasks() {
        metadataFile.parentFile?.mkdirs()
        metadataTemporaryFile.writeText(json.encodeToString(tasks.values.toList()))
        if (!metadataTemporaryFile.renameTo(metadataFile)) {
            metadataFile.delete()
            check(metadataTemporaryFile.renameTo(metadataFile)) { "无法保存上传记录" }
        }
    }

    /** 重启后没有在跑的传输：状态退回可续传，而不是假装还在传。 */
    private fun UploadTask.asPausedIfNeeded(): UploadTask = if (status == "uploading" || status == "queued") {
        copy(status = "paused", error = "应用已重新启动，可继续发送")
    } else {
        this
    }

    companion object {
        /**
         * 流式计算 sha256，并且顺带确认这个文件读得到、大小与声明一致。
         *
         * 必须在传输前算完：Host 那边要拿它做最终校验，而手机端的 `file.upload.init`
         * 就得把哈希报过去。整文件读进内存会在 100 MB 上直接 OOM，所以只能流式。
         */
        fun digestOf(resolver: ContentResolver, uri: Uri): Pair<String, Long> {
            val digest = MessageDigest.getInstance("SHA-256")
            var size = 0L
            resolver.openInputStream(uri)?.use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count <= 0) break
                    digest.update(buffer, 0, count)
                    size += count
                }
            } ?: error("无法读取所选文件")
            return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) } to size
        }

        /**
         * 读出一份待传文件的完整描述。
         *
         * 大小以**流实际读到的字节数**为准，不信 `OpenableColumns.SIZE`：那个列在不少
         * provider 上是可选的（云端文件常常给 -1 或旧值），而 Host 要拿 `size` 当续传和
         * 完成判据，报错了会让整个传输在最后一步失败。
         */
        fun inspect(resolver: ContentResolver, uri: Uri): UploadSource {
            var displayName: String? = null
            runCatching {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) displayName = cursor.getString(0)
                }
            }
            val (sha256, size) = digestOf(resolver, uri)
            return UploadSource(
                displayName = sanitizeFileName(displayName ?: uri.lastPathSegment ?: "upload"),
                size = size,
                sha256 = sha256,
                mimeType = runCatching { resolver.getType(uri) }.getOrNull(),
            )
        }

        /** 手机选来的名字可能带路径分隔符（某些 provider 会把整条路径当 display name 给）。 */
        private fun sanitizeFileName(name: String): String {
            val safe = name.map { character ->
                if (character == '/' || character == '\\' || character.code < 0x20 || character.code == 0x7f) '_' else character
            }.joinToString("")
            return safe.take(200).ifBlank { "upload" }
        }
    }
}
