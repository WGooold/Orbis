package com.orbising.orbis

import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Serializable
internal enum class ExternalImportReceipt {
    PENDING, ACCEPTED, FAILED, UNCONFIRMED, UNKNOWN;

    val maySend: Boolean get() = this == FAILED
    val mayCheck: Boolean get() = this == PENDING || this == UNCONFIRMED || this == UNKNOWN

    companion object {
        fun fromWire(raw: String?): ExternalImportReceipt? = entries.firstOrNull { it.name.equals(raw, ignoreCase = true) }
    }
}

/** This identity is on disk before the transport can see a command. */
@Serializable
internal data class ExternalImportAttempt(
    val id: String, val runtimeId: String, val receipt: ExternalImportReceipt, val instruction: String = "",
)

internal data class ImportUploadSource(val file: File, val metadata: ImportedFile)

internal fun ExternalImportTarget.wire(): JsonObject = buildJsonObject {
    put("sessionId", sessionId)
    put("cwd", cwd)
}

internal fun announcesImportTarget(ready: JsonObject?): Boolean {
    if (ready == null || ready["type"] != JsonPrimitive("device.ready")) return false
    return supportedProtocolVersion(ready["protocolVersion"]) != null &&
        (ready["hostFeatures"] as? JsonArray)?.contains(JsonPrimitive("external-import.target-v1")) == true
}

internal fun JsonObject.importString(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

internal fun UploadTask.verifiedImportPath(message: JsonObject): String? = message.importString("path")?.takeIf {
    it.isNotBlank() && it.length <= 4096 && sha256 == message.importString("sha256") &&
        (message["size"] as? JsonPrimitive)?.longOrNull == size
}

/** Pending is a received signal, not necessarily the final answer to a write. */
internal fun importReceiptFor(message: JsonObject, attempt: ExternalImportAttempt, target: ExternalImportTarget,
                              query: Boolean): Pair<Boolean, ExternalImportReceipt?> {
    val type = message.importString("type")
    if (type == "external-import.result") {
        val exact = query && message.importString("commandId") == attempt.id && message.importString("runtimeId") == attempt.runtimeId &&
            message["importTarget"] == target.wire()
        return true to if (exact) ExternalImportReceipt.fromWire(message.importString("status")) else null
    }
    if (type == "protocol.error" && message.importString("commandId") == attempt.id) {
        val definite = setOf("import_target_changed", "import_attachments_unverified", "runtime_offline", "unsupported_command",
            "provider_switching", "host_busy", "invalid_command")
        return true to if (!query && message.importString("code") in definite) ExternalImportReceipt.FAILED else ExternalImportReceipt.UNCONFIRMED
    }
    if (type != "runtime.event" || query || message.importString("runtimeId") != attempt.runtimeId) return false to null
    val event = message["event"] as? JsonObject ?: return false to null
    if (event.importString("commandId") != attempt.id) return false to null
    val receipt = when (event.importString("type")) {
        "runtime.error" -> ExternalImportReceipt.UNCONFIRMED
        "command.result" -> when (event.importString("status")) {
            "pending" -> null
            "failure" -> ExternalImportReceipt.FAILED
            "success", null -> if ((event["ok"] as? JsonPrimitive)?.booleanOrNull == true) ExternalImportReceipt.ACCEPTED else ExternalImportReceipt.FAILED
            else -> ExternalImportReceipt.UNCONFIRMED
        }
        else -> return false to null
    }
    return true to receipt
}

internal fun externalImportMessage(text: String?, instruction: String, fallback: String, quotedPrefix: String): String {
    val body = listOf(instruction.trim(), text.orEmpty()).filter(String::isNotEmpty).joinToString("\n\n")
    val message = when {
        body.isEmpty() -> fallback
        body.trimStart().startsWith('/') -> "$quotedPrefix\n\n$body"
        else -> body
    }
    if (message.length > 100_000) reject(ImportProblem.LIMIT)
    return message
}

internal fun ExternalImportAttempt.wire(target: ExternalImportTarget, command: JsonObject?): JsonObject = buildJsonObject {
    put("type", if (command == null) "external-import.result.read" else "runtime.command")
    put("protocolVersion", PROTOCOL_VERSION)
    put("runtimeId", runtimeId)
    put("commandId", id)
    put("importTarget", target.wire())
    if (command != null) put("command", command)
}

/** Only explicit UI actions enter this transaction, including after interrupted uploads. */
internal class ExternalImportDelivery {
    private val gate = Mutex()

    suspend fun send(batch: ExternalImportBatch, inbox: ExternalImportStore, instruction: String,
                     runtime: () -> RuntimeSummary?, capable: () -> Boolean,
                     upload: suspend (ImportUploadSource, String) -> String,
                     request: suspend (ExternalImportAttempt, JsonObject?) -> ExternalImportReceipt) = exclusive {
        val target = batch.destination?.target ?: reject(ImportProblem.TARGET_UNAVAILABLE)
        val runtimeId = runtime()?.runtimeId ?: reject(ImportProblem.TARGET_UNAVAILABLE)
        if (!capable()) reject(ImportProblem.HOST_UPGRADE)
        val sources = inbox.uploadSources(batch.id, target)
        val body = externalImportMessage(batch.text, instruction, L10n.tr("请查看附件。"), L10n.tr("导入的内容："))
        val paths = sources.map { source ->
            if (!capable() || runtime()?.runtimeId != runtimeId) reject(ImportProblem.TARGET_UNAVAILABLE)
            upload(source, runtimeId)
        }
        if (!capable() || runtime()?.runtimeId != runtimeId) reject(ImportProblem.TARGET_UNAVAILABLE)
        val attempt = ExternalImportAttempt(UUID.randomUUID().toString(), runtimeId, ExternalImportReceipt.PENDING, instruction)
        currentCoroutineContext().ensureActive()
        inbox.beginDelivery(batch.id, target, attempt)
        val current = runtime()
        val receipt = if (!capable() || current == null || current.runtimeId != runtimeId) ExternalImportReceipt.FAILED else {
            request(attempt, buildJsonObject {
                put("type", "user_message")
                put("messageId", attempt.id)
                put("text", body)
                if (current.status == "running") put("delivery", "followUp")
                if (paths.isNotEmpty()) put("attachments", buildJsonArray { paths.forEach { add(JsonPrimitive(it)) } })
            })
        }
        inbox.recordDelivery(batch.id, attempt.id, receipt)
    }

    suspend fun check(batch: ExternalImportBatch, inbox: ExternalImportStore, capable: () -> Boolean,
                      request: suspend (ExternalImportAttempt, JsonObject?) -> ExternalImportReceipt) = exclusive {
        val attempt = batch.attempt ?: return@exclusive
        if (!attempt.receipt.mayCheck) return@exclusive
        if (!capable()) reject(ImportProblem.TARGET_UNAVAILABLE)
        inbox.recordDelivery(batch.id, attempt.id, request(attempt, null))
    }

    private suspend fun exclusive(action: suspend () -> Unit) = withContext(Dispatchers.IO) {
        if (!gate.tryLock()) reject(ImportProblem.BUSY)
        try { action() } finally { gate.unlock() }
    }
}
