package com.orbising.orbis

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** All settings, including the API key, are encrypted with a device-local key and excluded from backup. */
internal class VoiceCleanupApiStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "voice-cleanup-api.v1"))

    suspend fun load(): VoiceCleanupApiConfig? = withContext(Dispatchers.IO) {
        synchronized(lock) {
            val encrypted = try { file.readFully() } catch (_: FileNotFoundException) { return@synchronized null }
            require(encrypted.size in (ivLength + 16)..(64 * 1024))
            val key = requireNotNull(keyStore().getKey(alias, null) as? SecretKey)
            val cipher = Cipher.getInstance(transformation).apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, encrypted, 0, ivLength))
            }
            val data = cipher.doFinal(encrypted, ivLength, encrypted.size - ivLength)
            Json.decodeFromString<VoiceCleanupApiConfig>(data.toString(Charsets.UTF_8))
        }
    }

    suspend fun save(config: VoiceCleanupApiConfig?) = withContext(Dispatchers.IO) {
        synchronized(lock) {
            if (config == null) {
                file.delete()
                check(!file.baseFile.exists())
                return@synchronized
            }
            require(VoiceTextCleanupApi.isValid(config))
            val key = (keyStore().getKey(alias, null) as? SecretKey) ?: KeyGenerator
                .getInstance(KeyProperties.KEY_ALGORITHM_AES, provider).run {
                    init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256).build())
                    generateKey()
                }
            val cipher = Cipher.getInstance(transformation).apply { init(Cipher.ENCRYPT_MODE, key) }
            check(cipher.iv.size == ivLength)
            val data = cipher.doFinal(Json.encodeToString(config).toByteArray(Charsets.UTF_8))
            val output = file.startWrite()
            try {
                output.write(cipher.iv)
                output.write(data)
                file.finishWrite(output)
            } catch (error: Exception) {
                file.failWrite(output)
                throw error
            }
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(provider).apply { load(null) }

    private companion object {
        val lock = Any()
        const val provider = "AndroidKeyStore"
        const val alias = "orbis.voice.cleanup.api.v1"
        const val transformation = "AES/GCM/NoPadding"
        const val ivLength = 12
    }
}
