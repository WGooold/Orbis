package dev.pi.remote

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
) {
    constructor(context: Context, json: Json = Json { ignoreUnknownKeys = true }) :
        this(File(context.applicationContext.filesDir, "session-catalog/catalog.cache"), json)

    @Synchronized
    fun load(device: DeviceCredential, hostId: String): List<SessionCatalogEntry> {
        if (hostId.isBlank() || !file.isFile) return emptyList()
        val stored = runCatching {
            json.decodeFromString<PersistedSessionCatalog>(file.readText(Charsets.UTF_8))
        }.getOrNull()?.takeIf {
            it.schemaVersion == 1 && it.relayUrl == device.relayUrl && it.deviceId == device.deviceId &&
                (it.hostId == null || it.hostId == hostId)
        } ?: return emptyList()
        // Old catalogs already belong to this exact pairing's device/Relay namespace.
        // Bind that namespace once, preserving all sessions, including empty and offline ones.
        if (stored.hostId == null) runCatching { save(device, hostId, stored.sessions) }
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
        file.parentFile?.listFiles()?.forEach(File::delete)
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
