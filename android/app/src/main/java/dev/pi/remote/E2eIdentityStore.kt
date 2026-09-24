package dev.pi.remote

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * 手机侧的 E2E 身份材料。
 *
 * - 设备长期密钥对：首次配对生成、此后复用（spec §4.5）。私钥只存本机。
 * - 已配对 Host：`pskRoot` 是配对的存根（不直接加密，是每次连接掺进去的身份盐）。
 *
 * 目前存 SharedPreferences（应用沙箱内）。后续升级 Keystore 硬件封装时，
 * 只动这个文件的读写实现，密码学层不感知。
 */
@Serializable
data class HostIdentity(
    val hostId: String,
    val hostPub: String,
    /** base64url 的 pskRoot。 */
    val pskRoot: String,
    val lanEndpoints: List<LanEndpoint> = emptyList(),
    val hostName: String? = null,
)

class E2eIdentityStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences("pi_remote_e2e", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    /** 加载设备长期私钥；没有则生成并落盘。 */
    fun loadOrCreateDeviceKeyPair(): X25519KeyPair {
        val stored = preferences.getString("device_priv", null)
        if (stored != null) {
            val raw = runCatching { Crypto.fromBase64UrlFixed(stored, Crypto.X25519_KEY_BYTES, "device_priv") }
                .getOrNull()
            if (raw != null) return X25519KeyPair.fromPrivateRaw(raw)
            // 落盘数据坏了：重新生成（老 pskRoot 也一并失效，需要重新配对）。
        }
        val keyPair = X25519KeyPair.generate()
        preferences.edit().putString("device_priv", Crypto.toBase64Url(keyPair.privateRaw)).apply()
        return keyPair
    }

    /** 当前已配对的 Host。单机场景先只存一台；多 Host 之后按 hostId 扩展。 */
    fun loadPairedHost(): HostIdentity? = preferences.getString("paired_host", null)?.let {
        runCatching { json.decodeFromString<HostIdentity>(it) }.getOrNull()
    }

    fun savePairedHost(identity: HostIdentity) {
        preferences.edit().putString("paired_host", json.encodeToString(identity)).apply()
    }

    fun clear() {
        preferences.edit().clear().apply()
    }
}
