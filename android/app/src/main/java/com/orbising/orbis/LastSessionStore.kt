package com.orbising.orbis

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * 「上次停在哪个会话」的持久化记录，按 Host 分开存。
 *
 * 只为一件事服务：**掉线重连或 APP 重启后自动回到那个会话**（spec 第 16 行 / §14 B7
 * 「网络断开后继续阅读已缓存的 Session，并在重连后自动同步」）。
 *
 * 手机是遥控器：电脑上的 Pi 进程不受手机掉线影响，所以重连后应该回到原处接着看，
 * 而不是把用户丢回 Runtime 列表、让他「重新拉」一次——重新拉会再走一遍
 * `session.activate`，在电脑上**多起一个重复的 Pi 进程**。
 *
 * 多 Host 下每个 Host 各记一条：切换 Host 不该把另一台电脑的打开位置冲掉。
 */
@Serializable
data class LastSession(
    val deviceId: String,
    val runtimeId: String,
    val sessionId: String? = null,
)

class LastSessionStore(context: Context) {
    // Stable storage name preserves the last opened sessions across branding upgrades.
    private val preferences =
        context.applicationContext.getSharedPreferences("pi_remote_last_session", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    fun save(hostId: String, deviceId: String, runtimeId: String, sessionId: String?) {
        val next = read().toMutableMap()
        next[hostId] = LastSession(deviceId = deviceId, runtimeId = runtimeId, sessionId = sessionId)
        preferences.edit().putString(KEY_ENTRIES, json.encodeToString(next)).apply()
    }

    fun load(hostId: String): LastSession? = read()[hostId]

    fun clear(hostId: String) {
        val next = read().toMutableMap()
        if (next.remove(hostId) == null) return
        preferences.edit().putString(KEY_ENTRIES, json.encodeToString(next)).apply()
    }

    private fun read(): Map<String, LastSession> {
        val stored = preferences.getString(KEY_ENTRIES, null) ?: return emptyMap()
        return runCatching { json.decodeFromString<Map<String, LastSession>>(stored) }.getOrElse { emptyMap() }
    }

    private companion object {
        const val KEY_ENTRIES = "entries"
    }
}
