package com.orbising.orbis

import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.MessageDigest
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

internal enum class ImportProblem { EMPTY, UNSUPPORTED, LIMIT, FULL, BUSY, UNREADABLE, TARGET_UNAVAILABLE, ALREADY_ASSIGNED, HOST_UPGRADE, UPLOAD_FAILED, LAUNCH_CONFIGURATION }
internal class ImportRejected(val problem: ImportProblem) : Exception()

@Serializable
internal data class ImportedFile(val name: String, val bytes: Long)

/** A local draft can only be used by this exact paired computer and Session. */
@Serializable
internal data class ExternalImportTarget(val hostId: String, val pairingKey: String, val sessionId: String, val cwd: String)

/** Display labels are a snapshot, never used as routing identity. */
@Serializable
internal data class ExternalImportDestination(val target: ExternalImportTarget, val hostName: String, val sessionName: String)

@Serializable
internal data class ExternalImportLaunch(val id: String, val hostId: String, val pairingKey: String, val hostName: String,
    val agent: String, val cwd: String, val instruction: String, val failed: Boolean = false)

@Serializable
internal data class ExternalImportBatch(
    val id: String, val createdAt: Long, val text: String?, val files: List<ImportedFile>,
    val destination: ExternalImportDestination? = null,
    val attempt: ExternalImportAttempt? = null,
    val launch: ExternalImportLaunch? = null,
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
            readBatch(directory, id)
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

    /** Replaces only the manifest; the batch ID and payload bytes remain unchanged. */
    fun assign(id: String, destination: ExternalImportDestination): ExternalImportBatch = update(id) { batch ->
        if (batch.launch != null) reject(ImportProblem.ALREADY_ASSIGNED)
        val assigned = batch.destination
        if (assigned == null) batch.copy(destination = destination)
        else {
            if (assigned.target != destination.target) reject(ImportProblem.ALREADY_ASSIGNED)
            batch
        }
    }

    fun unassign(id: String, target: ExternalImportTarget): ExternalImportBatch = update(id) { batch ->
        if (batch.destination?.target != target || batch.launch != null) reject(ImportProblem.TARGET_UNAVAILABLE)
        if (batch.attempt?.receipt?.maySend == false) reject(ImportProblem.BUSY)
        batch.copy(destination = null, attempt = null)
    }

    fun reserveLaunch(id: String, launch: ExternalImportLaunch) = update(id) { batch ->
        if (batch.destination != null || batch.attempt != null || batch.launch != null) reject(ImportProblem.ALREADY_ASSIGNED)
        batch.copy(launch = launch)
    }

    fun failLaunch(id: String, launchId: String) = update(id) { batch ->
        val launch = batch.launch
        if (launch?.id == launchId && batch.destination == null) batch.copy(launch = launch.copy(failed = true)) else batch
    }

    fun clearFailedLaunch(id: String, launchId: String) = update(id) { batch ->
        if (batch.launch?.id != launchId || batch.launch.failed.not() || batch.destination != null) reject(ImportProblem.TARGET_UNAVAILABLE)
        batch.copy(launch = null)
    }

    fun bindLaunch(id: String, launch: ExternalImportLaunch, sessionId: String) = update(id) { batch ->
        val target = ExternalImportTarget(launch.hostId, launch.pairingKey, sessionId, launch.cwd)
        if (batch.launch != launch || launch.failed || sessionId.isBlank() || (batch.destination != null && batch.destination.target != target))
            reject(ImportProblem.TARGET_UNAVAILABLE)
        batch.copy(destination = ExternalImportDestination(target, launch.hostName, downloadDisplayName(launch.cwd)))
    }

    fun uploadSources(id: String, target: ExternalImportTarget): List<ImportUploadSource> = synchronized(lock) {
        if (!validId(id)) reject(ImportProblem.UNREADABLE)
        val directory = File(root, READY + id)
        val batch = readBatch(directory, id)
        if (batch.destination?.target != target || batch.attempt?.receipt?.maySend == false) reject(ImportProblem.TARGET_UNAVAILABLE)
        batch.files.mapIndexed { index, meta -> ImportUploadSource(File(directory, "file-$index"), meta) }
    }

    fun beginDelivery(id: String, target: ExternalImportTarget, attempt: ExternalImportAttempt) = update(id) { batch ->
        if (batch.destination?.target != target || batch.attempt?.receipt?.maySend == false) reject(ImportProblem.TARGET_UNAVAILABLE)
        batch.copy(attempt = attempt)
    }

    fun recordDelivery(id: String, attempt: String, receipt: ExternalImportReceipt) { update(id) { batch ->
        val current = batch.attempt
        if (current?.id == attempt && current.receipt.mayCheck) batch.copy(attempt = current.copy(receipt = receipt)) else batch
    } }

    private fun update(id: String, change: (ExternalImportBatch) -> ExternalImportBatch): ExternalImportBatch = synchronized(lock) {
        if (!validId(id)) reject(ImportProblem.UNREADABLE)
        val directory = File(root, READY + id)
        val current = readBatch(directory, id)
        val next = change(current)
        if (current != next) {
            val temporary = File(directory, "$MANIFEST.tmp")
            try {
                temporary.outputStream().use {
                    it.write(Json.encodeToString(ExternalImportBatch.serializer(), next).toByteArray(Charsets.UTF_8))
                    it.fd.sync()
                }
                Files.move(temporary.toPath(), File(directory, MANIFEST).toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
            } finally {
                temporary.delete()
            }
        }
        next
    }

    private fun readBatch(directory: File, id: String): ExternalImportBatch =
        Json.decodeFromString<ExternalImportBatch>(File(directory, MANIFEST).readText()).also { check(it.id == id) }

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

internal fun externalImportPairingKey(pairing: HostPairing): String {
    val raw = listOf(pairing.hostId, pairing.hostPub, pairing.pskRoot, pairing.relayUrl, pairing.deviceId, pairing.credential)
        .joinToString("") { "${it.toByteArray(Charsets.UTF_8).size}:$it" }
    return MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

/** Only an authenticated, unambiguous live session can receive a draft. */
internal fun RemoteState.externalImportRuntimes(): List<RuntimeSummary> {
    if (!canOperateSessions || !homeDirectoryReceived) return emptyList()
    val counts = runtimes.values.mapNotNull(RuntimeSummary::sessionId).groupingBy { it }.eachCount()
    val closing = closingRuntimeIds
    val archiving = archivingSessionIds
    return runtimes.values.filter { runtime ->
        val session = runtime.sessionId ?: return@filter false
        val agent = runtime.agentKind ?: sessions[session]?.agentKind ?: "pi"
        allowsAgentSource(agent) && session.isNotBlank() && counts[session] == 1 && runtime.cwd.isNotBlank() &&
            runtime.status in setOf("idle", "running") && runtime.runtimeId !in closing && session !in archiving &&
            sessions[session]?.archived != true && codexProviderMismatch(session) == null
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
