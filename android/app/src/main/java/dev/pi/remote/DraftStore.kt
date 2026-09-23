package dev.pi.remote

import android.content.Context
import java.security.MessageDigest

/** Identity of the editor belonging to one Relay/device/runtime/Session context. */
data class DraftIdentity(
    val relayUrl: String,
    val deviceId: String,
    val runtimeId: String,
    val sessionId: String?,
)

internal fun draftIdentity(device: DeviceCredential, runtime: RuntimeSummary): DraftIdentity = DraftIdentity(
    relayUrl = device.relayUrl,
    deviceId = device.deviceId,
    runtimeId = runtime.runtimeId,
    sessionId = runtime.sessionId,
)

private fun draftDevicePrefix(identity: DraftIdentity): String {
    val value = "${identity.relayUrl}\u0000${identity.deviceId}"
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return "draft_" + digest.joinToString("") { byte -> "%02x".format(byte) } + "_"
}

internal fun draftPreferenceKey(identity: DraftIdentity): String {
    val value = "${identity.runtimeId}\u0000${identity.sessionId ?: "<no-session>"}"
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return draftDevicePrefix(identity) + digest.joinToString("") { byte -> "%02x".format(byte) }
}

/** Small store for drafts; blank values are removed rather than retained. */
class DraftStore(context: Context) {
    private val appContext = context.applicationContext
    private val preferences by lazy {
        appContext.getSharedPreferences("pi_remote_drafts", Context.MODE_PRIVATE)
    }

    fun load(device: DeviceCredential, runtime: RuntimeSummary): String =
        preferences.getString(draftPreferenceKey(draftIdentity(device, runtime)), "").orEmpty()

    fun save(device: DeviceCredential, runtime: RuntimeSummary, value: String) {
        val editor = preferences.edit()
        val key = draftPreferenceKey(draftIdentity(device, runtime))
        if (value.isBlank()) editor.remove(key) else editor.putString(key, value)
        editor.apply()
    }

    fun clear(device: DeviceCredential, runtimeId: String, sessionId: String?) {
        preferences.edit().remove(
            draftPreferenceKey(DraftIdentity(device.relayUrl, device.deviceId, runtimeId, sessionId)),
        ).apply()
    }

    fun clear(device: DeviceCredential) {
        val prefix = draftDevicePrefix(DraftIdentity(device.relayUrl, device.deviceId, "", null))
        preferences.edit().apply {
            preferences.all.keys.filter { it.startsWith(prefix) }.forEach(::remove)
        }.apply()
    }
}
