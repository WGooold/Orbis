package com.orbising.orbis

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
        // Stable storage name preserves existing Orbis drafts.
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

    /** ADR-0049 §6.2 / V17：写入通道前另存的等待消息正文；写入或用户处理后删除。 */
    fun saveWaiting(device: DeviceCredential, runtime: RuntimeSummary, messageId: String, text: String) {
        preferences.edit().putString(waitingDraftKey(draftPreferenceKey(draftIdentity(device, runtime)), messageId), text).apply()
    }

    fun removeWaiting(messageId: String) {
        val suffix = WAITING_SEPARATOR + messageId
        val keys = preferences.all.keys.filter { it.startsWith(WAITING_PREFIX) && it.endsWith(suffix) }
        if (keys.isNotEmpty()) preferences.edit().apply { keys.forEach(::remove) }.apply()
    }

    /** 进程退出时仍在等待的消息回到该会话的输入框，已有草稿则接在其后。 */
    fun restoreWaiting(live: Set<String> = emptySet()) {
        val (drafts, removed) = restoreWaitingDrafts(preferences.all, live)
        if (removed.isEmpty()) return
        preferences.edit().apply {
            drafts.forEach { (key, value) -> putString(key, value) }
            removed.forEach(::remove)
        }.apply()
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

private const val WAITING_PREFIX = "waiting\u001f"
private const val WAITING_SEPARATOR = "\u001f"

internal fun waitingDraftKey(draftKey: String, messageId: String) = WAITING_PREFIX + draftKey + WAITING_SEPARATOR + messageId

/** V17 副本的恢复：返回（要写入的草稿，要删除的副本键）。`live` 是当前进程里仍在等待、不该恢复的消息。 */
internal fun restoreWaitingDrafts(all: Map<String, *>, live: Set<String>): Pair<Map<String, String>, Set<String>> {
    val drafts = mutableMapOf<String, String>()
    val removed = mutableSetOf<String>()
    all.entries.filter { it.key.startsWith(WAITING_PREFIX) }
        .groupBy { it.key.removePrefix(WAITING_PREFIX).substringBeforeLast(WAITING_SEPARATOR) }
        .forEach { (draftKey, rows) ->
            val restored = rows.filter { it.key.substringAfterLast(WAITING_SEPARATOR) !in live }
            if (restored.isEmpty()) return@forEach
            val existing = (all[draftKey] as? String)?.takeIf(String::isNotBlank)
            drafts[draftKey] = (listOfNotNull(existing) + restored.mapNotNull { it.value as? String }.sorted()).joinToString("\n\n")
            removed += restored.map { it.key }
        }
    return drafts to removed
}
