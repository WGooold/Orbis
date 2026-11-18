package com.orbising.orbis

import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

internal enum class ImportProblem { EMPTY, UNSUPPORTED, LIMIT, FULL, BUSY, UNREADABLE }
internal class ImportRejected(val problem: ImportProblem) : Exception()

@Serializable
internal data class ImportedFile(val name: String, val bytes: Long)

@Serializable
internal data class ExternalImportBatch(
    val id: String, val createdAt: Long, val text: String?, val files: List<ImportedFile>,
)

internal data class ImportSource(val name: String?, val open: () -> InputStream)

/** Caller performs all I/O off Main. Only an atomically published directory is an inbox item. */
internal class ExternalImportStore(
    private val root: File,
    private val batchBytes: Long = MAX_UPLOAD_BYTES,
    private val inboxBytes: Long = 256L * 1024 * 1024,
) {
    fun list(): List<ExternalImportBatch> = synchronized(lock) { listLocked() }

    private fun listLocked(): List<ExternalImportBatch> {
        if (!root.exists()) return emptyList()
        return checkNotNull(root.listFiles()).mapNotNull { directory ->
            val id = directory.name.removePrefix(READY)
            if (!directory.name.startsWith(READY) || !validId(id) || !directory.isDirectory) return@mapNotNull null
            Json.decodeFromString<ExternalImportBatch>(File(directory, MANIFEST).readText()).also { check(it.id == id) }
        }.sortedByDescending { it.createdAt }
    }

    fun save(text: String?, files: List<ImportSource>): ExternalImportBatch = synchronized(lock) {
        if (files.size > MAX_ATTACHMENTS_PER_MESSAGE || (text?.length ?: 0) > TEXT_BYTES) reject(ImportProblem.LIMIT)
        val body = text?.takeUnless(String::isBlank)
        if (body == null && files.isEmpty()) reject(ImportProblem.EMPTY)
        val textBytes = body?.toByteArray(Charsets.UTF_8)?.size ?: 0
        if (textBytes > TEXT_BYTES) reject(ImportProblem.LIMIT)
        check(root.isDirectory || root.mkdirs())
        // Under the same process-wide lock no producer still owns one of these directories.
        checkNotNull(root.listFiles()).filter { it.name.startsWith(STAGE) }.forEach { check(it.deleteRecursively()) }
        val existing = listLocked()
        val available = inboxBytes - existing.sumOf { batch ->
            batch.files.sumOf { it.bytes } + (batch.text?.toByteArray(Charsets.UTF_8)?.size ?: 0)
        } - textBytes
        if (existing.size >= MAX_BATCHES || available < 0) reject(ImportProblem.FULL)

        val id = UUID.randomUUID().toString()
        val staging = File(root, STAGE + id)
        check(staging.mkdir())
        try {
            var total = 0L
            val buffer = ByteArray(64 * 1024)
            val contents = files.mapIndexed { index, source ->
                var count = 0L
                source.open().use { input ->
                    File(staging, "file-$index").outputStream().buffered().use { output ->
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            total += n; count += n
                            if (total > batchBytes) reject(ImportProblem.LIMIT)
                            if (total > available) reject(ImportProblem.FULL)
                            output.write(buffer, 0, n)
                        }
                    }
                }
                if (count == 0L) reject(ImportProblem.UNREADABLE)
                ImportedFile(externalFileName(source.name), count)
            }
            val batch = ExternalImportBatch(id, System.currentTimeMillis(), body, contents)
            File(staging, MANIFEST).writeText(Json.encodeToString(ExternalImportBatch.serializer(), batch))
            Files.move(staging.toPath(), File(root, READY + id).toPath(), ATOMIC_MOVE)
            batch
        } finally {
            if (staging.exists()) staging.deleteRecursively()
        }
    }

    fun delete(id: String) = synchronized(lock) {
        if (!validId(id)) return@synchronized
        val ready = File(root, READY + id)
        if (!ready.isDirectory) return@synchronized
        // Unpublish before unlinking any bytes, even across a crash during deletion.
        val staging = File(root, STAGE + id)
        Files.move(ready.toPath(), staging.toPath(), ATOMIC_MOVE)
        check(staging.deleteRecursively())
    }

    private companion object {
        val lock = Any()
        const val READY = "ready-"
        const val STAGE = "stage-"
        const val MANIFEST = "batch.json"
        const val MAX_BATCHES = 16
        const val TEXT_BYTES = 256 * 1024
    }
}

private fun validId(raw: String): Boolean = runCatching { UUID.fromString(raw).toString() == raw }.getOrDefault(false)
internal fun reject(problem: ImportProblem): Nothing = throw ImportRejected(problem)

// This label is never used as a disk path. Strip paths and display control characters.
internal fun externalFileName(raw: String?): String {
    val name = raw.orEmpty().substringAfterLast('/').substringAfterLast('\\')
        .filterNot { it.isISOControl() || it in '\u202A'..'\u202E' || it in '\u2066'..'\u2069' }.trim()
        .takeUnless { it.isEmpty() || it == "." || it == ".." } ?: "file"
    if (name.length <= 240) return name
    val ext = name.substringAfterLast('.', "").takeIf { it.length in 1..24 }?.let { ".$it" }.orEmpty()
    val prefix = name.take(240 - ext.length).trimEnd { it.isHighSurrogate() }
    return prefix + ext
}
