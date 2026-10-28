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

/**
 * One paired computer, from the phone's point of view.
 *
 * The pairing owns everything an APP feature needs to talk to one Host: the Relay credential that
 * authenticates this device to that Host's room, the E2E stub (`pskRoot`) that derives the secure
 * session, and the display name the Host announced. A phone may hold several of these at once; the
 * `hostId` is the identity that dedupes them.
 */
@Serializable
data class HostPairing(
    val hostId: String,
    val hostName: String? = null,
    val hostPub: String,
    val pskRoot: String,
    val lanEndpoints: List<LanEndpoint> = emptyList(),
    val relayUrl: String,
    val deviceId: String,
    val credential: String,
) {
    fun credential(): DeviceCredential = DeviceCredential(relayUrl, deviceId, credential)

    fun identity(): HostIdentity = HostIdentity(
        hostId = hostId,
        hostPub = hostPub,
        pskRoot = pskRoot,
        lanEndpoints = lanEndpoints,
        hostName = hostName,
    )
}

@Serializable
data class PersistedPairings(
    val schemaVersion: Int = 1,
    val activeHostId: String? = null,
    val hosts: List<HostPairing> = emptyList(),
)

/**
 * Durable list of paired Hosts, keyed by `hostId`.
 *
 * Re-pairing the same computer (a new QR code, a rotated credential) replaces that Host's record in
 * place instead of appending a second one: two records for one `hostId` would mean two live
 * connections to the same computer and two copies of its directory tree.
 */
class HostPairingStore internal constructor(
    private val file: File,
    private val json: Json = Json { ignoreUnknownKeys = true },
) {
    constructor(context: Context) : this(File(context.applicationContext.filesDir, "hosts/pairings.json"))

    @Synchronized
    fun snapshot(): PersistedPairings = read()

    @Synchronized
    fun hosts(): List<HostPairing> = read().hosts

    @Synchronized
    fun activeHostId(): String? = read().activeHostId

    /** Adds or replaces [pairing] by `hostId`, preserving the existing position. */
    @Synchronized
    fun add(pairing: HostPairing): List<HostPairing> {
        val current = read()
        val existing = current.hosts.indexOfFirst { it.hostId == pairing.hostId }
        val hosts = if (existing >= 0) {
            current.hosts.toMutableList().also { it[existing] = pairing }
        } else {
            current.hosts + pairing
        }
        val active = current.activeHostId?.takeIf { id -> hosts.any { it.hostId == id } } ?: pairing.hostId
        return write(current.copy(activeHostId = active, hosts = hosts)).hosts
    }

    @Synchronized
    fun remove(hostId: String): PersistedPairings {
        val current = read()
        if (current.hosts.none { it.hostId == hostId }) return current
        val hosts = current.hosts.filterNot { it.hostId == hostId }
        val active = current.activeHostId?.takeIf { id -> hosts.any { it.hostId == id } } ?: hosts.firstOrNull()?.hostId
        return write(current.copy(activeHostId = active, hosts = hosts))
    }

    @Synchronized
    fun setActiveHostId(hostId: String?): PersistedPairings {
        val current = read()
        val active = hostId?.takeIf { id -> current.hosts.any { it.hostId == id } }
        if (active == current.activeHostId) return current
        return write(current.copy(activeHostId = active))
    }

    @Synchronized
    fun clear(): PersistedPairings = write(PersistedPairings())

    private fun read(): PersistedPairings {
        val text = runCatching { file.takeIf(File::isFile)?.readText() }.getOrNull() ?: return PersistedPairings()
        return runCatching { json.decodeFromString<PersistedPairings>(text) }
            .getOrElse { PersistedPairings() }
    }

    private fun write(next: PersistedPairings): PersistedPairings {
        // 去重是写入口的职责：任何读路径都不该看到同一 hostId 的两条记录。
        val hosts = LinkedHashMap<String, HostPairing>()
        for (host in next.hosts) hosts[host.hostId] = host
        val normalized = next.copy(
            activeHostId = next.activeHostId?.takeIf { it in hosts } ?: hosts.keys.firstOrNull(),
            hosts = hosts.values.toList(),
        )
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.tmp")
        temporary.writeText(json.encodeToString(normalized))
        try {
            Files.move(
                temporary.toPath(), file.toPath(),
                StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
        return normalized
    }
}
