package dev.pi.remote

import android.content.Context
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/** 三档路径，顺序即优先级（§6.2）。取值与 Host 的 PathKind 一致。 */
internal val PATH_KINDS: List<String> = listOf("lan", "p2p", "relay")

/** 没排过时的默认顺序：局域网 > P2P 直连 > 中继。 */
internal val DEFAULT_PATH_PREFERENCE: List<String> = PATH_KINDS

/**
 * 补成三档合法排列：丢掉未知/重复项，缺的按默认顺序补在后面。与 Host 的
 * `normalizePreference` 对称——手机存坏了也不该让某条路径从选路里消失。
 */
internal fun normalizePathPreference(order: List<String>): List<String> {
    val seen = mutableSetOf<String>()
    val result = mutableListOf<String>()
    for (kind in order) {
        if (kind !in PATH_KINDS || !seen.add(kind)) continue
        result.add(kind)
    }
    for (kind in PATH_KINDS) if (kind !in seen) result.add(kind)
    return result
}

/** 手机本地保存的连接优先级。每次 E2E 就绪后重发给 Host，所以只需本机持久化。 */
class PathPreferenceStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences("pi_remote_path_preference", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val serializer = ListSerializer(String.serializer())

    fun load(): List<String> {
        val stored = preferences.getString(KEY_ORDER, null) ?: return DEFAULT_PATH_PREFERENCE
        return runCatching { json.decodeFromString(serializer, stored) }
            .getOrNull()
            ?.let(::normalizePathPreference)
            ?.takeIf { it.size == PATH_KINDS.size }
            ?: DEFAULT_PATH_PREFERENCE
    }

    fun save(order: List<String>) {
        preferences.edit()
            .putString(KEY_ORDER, json.encodeToString(serializer, normalizePathPreference(order)))
            .apply()
    }

    private companion object {
        const val KEY_ORDER = "order"
    }
}
