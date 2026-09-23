package dev.pi.remote

import android.content.Context

/**
 * 「上次停在哪个会话」的持久化记录。
 *
 * 只为一件事服务：**掉线重连或 APP 重启后自动回到那个会话**（spec 第 16 行 / §14 B7
 * 「网络断开后继续阅读已缓存的 Session，并在重连后自动同步」）。
 *
 * 手机是遥控器：电脑上的 Pi 进程不受手机掉线影响，所以重连后应该回到原处接着看，
 * 而不是把用户丢回 Runtime 列表、让他「重新拉」一次——重新拉会再走一遍
 * `session.activate`，在电脑上**多起一个重复的 Pi 进程**。
 *
 * 记 deviceId 是为了防止换电脑配对后拿着旧的 runtimeId 去恢复（虽然 unpair 也会清）。
 */
class LastSessionStore(context: Context) {
    private val preferences =
        context.applicationContext.getSharedPreferences("pi_remote_last_session", Context.MODE_PRIVATE)

    fun save(deviceId: String, runtimeId: String, sessionId: String?) {
        val editor = preferences.edit()
            .putString(KEY_DEVICE, deviceId)
            .putString(KEY_RUNTIME, runtimeId)
        if (sessionId == null) editor.remove(KEY_SESSION) else editor.putString(KEY_SESSION, sessionId)
        editor.apply()
    }

    fun load(): LastSession? {
        val deviceId = preferences.getString(KEY_DEVICE, null) ?: return null
        val runtimeId = preferences.getString(KEY_RUNTIME, null) ?: return null
        return LastSession(
            deviceId = deviceId,
            runtimeId = runtimeId,
            sessionId = preferences.getString(KEY_SESSION, null),
        )
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private companion object {
        const val KEY_DEVICE = "deviceId"
        const val KEY_RUNTIME = "runtimeId"
        const val KEY_SESSION = "sessionId"
    }
}

data class LastSession(
    val deviceId: String,
    val runtimeId: String,
    val sessionId: String?,
)
