package com.orbising.orbis

import android.content.Context
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class SessionCatalogEntry(
    val sessionId: String,
    val name: String? = null,
    val cwd: String = "",
    val firstMessage: String? = null,
    val createdAt: Long = 0,
    val modifiedAt: Long = 0,
    val messageCount: Int = 0,
    val hasHistoryCache: Boolean = false,
    /**
     * Optional source metadata, retained for display labels in old pairing records.
     * Ownership belongs to the paired Host's catalog namespace, never this hostname.
     */
    val hostname: String? = null,
    /** 产生该会话的 agent（pi/codex，spec §8）；来自 session.list / runtime 元数据，旧缓存为 null。 */
    val agentKind: String? = null,
    /** Null on runtime history snapshots, which do not own archive state. */
    val archived: Boolean? = null,
    /** Provider ownership from the Host catalog; null means unknown, never the current provider. */
    val modelProvider: String? = null,
    /** Client-local Pi label: captured once, persisted without loading the transcript again. */
    val cachedDisplayName: String? = null,
)

/** Loading history must not erase the host supplied by the session directory. */
internal fun SessionCatalogEntry.withHistoryCache(runtimeHostname: String?): SessionCatalogEntry = copy(
    hasHistoryCache = true,
    hostname = runtimeHostname?.takeIf(String::isNotBlank) ?: hostname,
)

@Serializable
private data class PersistedSessionCatalog(
    val relayUrl: String,
    val deviceId: String,
    val sessions: List<SessionCatalogEntry>,
    val updatedAt: Long,
    val schemaVersion: Int = 1,
    val hostId: String? = null,
)

/** Lightweight Session index. It deliberately does not contain entry bodies. */
class SessionCatalogStore internal constructor(
    private val file: File,
    private val json: Json = Json { ignoreUnknownKeys = true },
    /**
     * Single-Host installs wrote one `catalog.cache`. Multi-Host keeps one file per Host, so the
     * old file is only read when this Host has none of its own, then migrated on first save.
     */
    private val legacyFile: File? = null,
) {
    constructor(context: Context, hostId: String, json: Json = Json { ignoreUnknownKeys = true }) :
        this(
            file = File(context.applicationContext.filesDir, "session-catalog/${
                hostId.replace(Regex("[^A-Za-z0-9._-]"), "_")
            }.cache"),
            json = json,
            legacyFile = File(context.applicationContext.filesDir, "session-catalog/catalog.cache"),
        )

    @Synchronized
    fun load(device: DeviceCredential, hostId: String): List<SessionCatalogEntry> {
        if (hostId.isBlank()) return emptyList()
        val source = file.takeIf(File::isFile) ?: legacyFile?.takeIf(File::isFile) ?: return emptyList()
        val stored = runCatching {
            json.decodeFromString<PersistedSessionCatalog>(source.readText(Charsets.UTF_8))
        }.getOrNull()?.takeIf {
            it.schemaVersion == 1 && it.relayUrl == device.relayUrl && it.deviceId == device.deviceId &&
                (it.hostId == null || it.hostId == hostId)
        } ?: return emptyList()
        // Old catalogs already belong to this exact pairing's device/Relay namespace.
        // Bind that namespace once, preserving all sessions, including empty and offline ones.
        if (stored.hostId == null || source !== file) runCatching { save(device, hostId, stored.sessions) }
        return stored.sessions
    }

    @Synchronized
    fun save(device: DeviceCredential, hostId: String, sessions: Collection<SessionCatalogEntry>) {
        require(hostId.isNotBlank()) { "Session catalog requires a paired Host" }
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
        runCatching {
            temporary.writeText(
                json.encodeToString(
                    PersistedSessionCatalog(
                        relayUrl = device.relayUrl,
                        deviceId = device.deviceId,
                        hostId = hostId,
                        sessions = sessions.sortedByDescending(SessionCatalogEntry::modifiedAt),
                        updatedAt = System.currentTimeMillis(),
                    ),
                ),
                Charsets.UTF_8,
            )
            replaceAtomically(temporary, file)
        }.onFailure {
            temporary.delete()
        }.getOrThrow()
    }

    @Synchronized
    fun clear() {
        file.delete()
    }

    private fun replaceAtomically(source: File, target: File) {
        try {
            Files.move(
                source.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

/** Session list time in the app's own language: 今天 / 昨天 with a clock time, then a date (same rules as iOS). */
internal fun sessionTimeText(
    millis: Long,
    now: Long = System.currentTimeMillis(),
    zone: java.time.ZoneId = java.time.ZoneId.systemDefault(),
): String {
    val time = java.time.Instant.ofEpochMilli(millis).atZone(zone)
    val today = java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val day = time.toLocalDate()
    val pattern = when {
        day == today -> "今天 HH:mm"
        day == today.minusDays(1) -> "昨天 HH:mm"
        day.year == today.year -> "M月d日"
        else -> "yyyy年M月d日"
    }
    return java.time.format.DateTimeFormatter.ofPattern(pattern, java.util.Locale.SIMPLIFIED_CHINESE).format(time)
}
