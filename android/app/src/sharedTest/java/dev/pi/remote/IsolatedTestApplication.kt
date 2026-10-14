package dev.pi.remote

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import java.io.File
import java.util.UUID

/**
 * 设备测试用的隔离 Application：文件目录与 SharedPreferences 都带随机前缀，跑完 [dispose] 清掉。
 *
 * 这样同一个模拟器上既有的人工配对数据（用户自己的电脑）不会被测试读走或覆盖，测试之间也不互相污染。
 * 需要「真的落盘」的测试（配对、SQLite、凭据）都该用它，而不是直接用目标 App 的默认目录。
 */
internal class IsolatedTestApplication(base: Context, prefix: String = "orbis-test") : Application() {
    private val tag = "${prefix}-${UUID.randomUUID()}"
    val root = File(base.filesDir, tag).apply { mkdirs() }
    private val preferences = mutableSetOf<String>()

    init { attachBaseContext(base) }

    override fun getApplicationContext(): Context = this
    override fun getFilesDir(): File = root
    override fun getCacheDir(): File = File(root, "cache").apply { mkdirs() }
    override fun getNoBackupFilesDir(): File = File(root, "no-backup").apply { mkdirs() }
    override fun getSharedPreferences(name: String, mode: Int): SharedPreferences {
        val isolated = "$tag-$name"
        preferences += isolated
        return baseContext.getSharedPreferences(isolated, mode)
    }

    fun dispose() {
        preferences.forEach { baseContext.deleteSharedPreferences(it) }
        root.deleteRecursively()
    }
}
