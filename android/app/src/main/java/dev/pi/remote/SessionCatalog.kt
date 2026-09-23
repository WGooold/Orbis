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
     * OS hostname of the Pi machine that last produced this Session's history cache, used to group
     * cached history by host in the sidebar. Null for entries cached before this field existed.
     */
    val hostname: String? = null,
    /** 产生该会话的 agent（pi/codex，spec §8）；来自 session.list / runtime 元数据，旧缓存为 null。 */
    val agentKind: String? = null,
    /** Null on runtime history snapshots, which do not own archive state. */
    val archived: Boolean? = null,
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
)

/** Lightweight Session index. It deliberately does not contain entry bodies. */
class SessionCatalogStore(
    context: Context,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    private val appContext = context.applicationContext
    private val file = File(appContext.filesDir, "session-catalog/catalog.cache")

    @Synchronized
    fun load(device: DeviceCredential): List<SessionCatalogEntry> {
        if (!file.isFile) return emptyList()
        return runCatching {
            json.decodeFromString<PersistedSessionCatalog>(file.readText(Charsets.UTF_8))
        }.getOrNull()?.takeIf {
            it.schemaVersion == 1 && it.relayUrl == device.relayUrl && it.deviceId == device.deviceId
        }?.sessions.orEmpty()
    }

    @Synchronized
    fun save(device: DeviceCredential, sessions: Collection<SessionCatalogEntry>) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
        runCatching {
            temporary.writeText(
                json.encodeToString(
                    PersistedSessionCatalog(
                        relayUrl = device.relayUrl,
                        deviceId = device.deviceId,
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
