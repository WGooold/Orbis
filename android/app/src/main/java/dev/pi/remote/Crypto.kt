package dev.pi.remote

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.math.ec.rfc7748.X25519

/**
 * E2E 密码学原语（spec §5.3）。与 `packages/e2e/src/primitives.ts` 逐字节对齐——
 * 两端任何一处编码/拼接顺序不同，都会表现为「AEAD 认证失败」或「MAC 不匹配」。
 *
 * 互操作契约（改动即为协议破坏性变更）：
 * - 出现在 `info` 串与 wire 字段里的公钥/nonce 一律 base64url（无 padding）文本；
 * - `hmacSha256` 的各段按顺序做 UTF-8 拼接后取 HMAC（等价 `HMAC(key, "label|" + v1 + v2)`）；
 * - AEAD 输出 `ciphertext || tag`，nonce 不随报文传输（由序号派生）；
 * - X25519 输出全零必须拒绝（BouncyCastle 对退化点静默返回全零，两端表现要一致）。
 */
object Crypto {
    const val X25519_KEY_BYTES = 32
    const val SYMMETRIC_KEY_BYTES = 32
    const val AEAD_NONCE_BYTES = 12
    const val AEAD_TAG_BYTES = 16

    class E2eCryptoException(val code: String, message: String) : Exception(message)

    private val random = SecureRandom()

    fun randomBytes(count: Int): ByteArray = ByteArray(count).also { random.nextBytes(it) }

    fun isAllZero(bytes: ByteArray): Boolean = bytes.all { it == 0.toByte() }

    /** 长度相同即逐位异或累积——不需要库级常量时间，目标是不依赖秘密内容的分支。 */
    fun constantTimeEqual(left: ByteArray, right: ByteArray): Boolean {
        if (left.size != right.size) return false
        var diff = 0
        for (i in left.indices) diff = diff or (left[i].toInt() xor right[i].toInt())
        return diff == 0
    }

    // ── base64url（严格） ────────────────────────────────────────────────────────

    private val BASE64URL_PATTERN = Regex("^[A-Za-z0-9_-]+$")

    fun toBase64Url(bytes: ByteArray): String =
        java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    /** 先正则拒掉非法字符再解——java.util.Base64 的宽容度与 Node 不一致，必须显式收紧。 */
    fun fromBase64Url(value: String, label: String): ByteArray {
        if (!BASE64URL_PATTERN.matches(value)) {
            throw E2eCryptoException("malformed", "$label 不是合法的 base64url")
        }
        return java.util.Base64.getUrlDecoder().decode(value)
    }

    fun fromBase64UrlFixed(value: String, bytes: Int, label: String): ByteArray {
        val decoded = fromBase64Url(value, label)
        if (decoded.size != bytes) {
            throw E2eCryptoException("invalid_key_length", "$label 必须是 $bytes 字节，实际 ${decoded.size}")
        }
        return decoded
    }

    // ── X25519 ──────────────────────────────────────────────────────────────────

    /**
     * `ss = X25519(自己的私钥, 对方的公钥)`。
     *
     * 全零输出拒绝是两端约定好的可移植规则：OpenSSL 遇退化点抛错、BouncyCastle
     * 静默返回全零，这里统一为显式失败（对应 Node 侧 `deriveSharedSecret`）。
     */
    fun deriveSharedSecret(privateRaw: ByteArray, peerPublicRaw: ByteArray): ByteArray {
        if (privateRaw.size != X25519_KEY_BYTES) {
            throw E2eCryptoException("invalid_key_length", "X25519 私钥必须是 $X25519_KEY_BYTES 字节")
        }
        if (peerPublicRaw.size != X25519_KEY_BYTES) {
            throw E2eCryptoException("invalid_key_length", "对方 X25519 公钥必须是 $X25519_KEY_BYTES 字节")
        }
        val secret = ByteArray(X25519_KEY_BYTES)
        try {
            X25519.calculateAgreement(privateRaw, 0, peerPublicRaw, 0, secret, 0)
        } catch (error: Exception) {
            throw E2eCryptoException("degenerate_public_key", "X25519 拒绝了这个公钥（退化点或小群元素）")
        }
        if (isAllZero(secret)) {
            throw E2eCryptoException("degenerate_shared_secret", "X25519 输出全零，公钥是退化点")
        }
        return secret
    }

    // ── HKDF / HMAC ─────────────────────────────────────────────────────────────

    /** HKDF-SHA256（RFC 5869）：extract + expand，info 是 UTF-8 文本。 */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: String, length: Int = SYMMETRIC_KEY_BYTES): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // salt 为空时按 RFC 用 HashLen 个零字节。
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)

        val result = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(previous)
            mac.update(info.toByteArray(Charsets.UTF_8))
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val copy = minOf(previous.size, length - offset)
            System.arraycopy(previous, 0, result, offset, copy)
            offset += copy
            counter += 1
        }
        return result
    }

    /** 各段按顺序 UTF-8 拼接后取 HMAC（Node 侧 `hmacSha256(key, ...parts)`）。 */
    fun hmacSha256(key: ByteArray, vararg parts: String): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        for (part in parts) mac.update(part.toByteArray(Charsets.UTF_8))
        return mac.doFinal()
    }

    // ── AES-256-GCM ─────────────────────────────────────────────────────────────

    /** 返回 `ciphertext || tag`：nonce 由序号派生、不随报文传输（见 `envelopeNonce`）。 */
    fun sealAead(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray): ByteArray {
        requireKeyAndNonce(key, nonce)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(AEAD_TAG_BYTES * 8, nonce))
        cipher.updateAAD(aad)
        val ciphertext = cipher.doFinal(plaintext)
        return ciphertext // javax.crypto 的 GCM doFinal 已经是 ciphertext||tag
    }

    fun openAead(key: ByteArray, nonce: ByteArray, aad: ByteArray, sealed: ByteArray): ByteArray {
        requireKeyAndNonce(key, nonce)
        if (sealed.size < AEAD_TAG_BYTES) {
            throw E2eCryptoException("malformed", "密文短于认证标签长度")
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(AEAD_TAG_BYTES * 8, nonce))
        cipher.updateAAD(aad)
        return try {
            cipher.doFinal(sealed) // 输入是 ciphertext||tag，javax.crypto 直接接受并校验 tag
        } catch (error: Exception) {
            throw E2eCryptoException("aead_failed", "AEAD 认证失败：密文、AAD 或密钥不匹配")
        }
    }

    private fun requireKeyAndNonce(key: ByteArray, nonce: ByteArray) {
        if (key.size != SYMMETRIC_KEY_BYTES) {
            throw E2eCryptoException("invalid_key_length", "AEAD 密钥必须是 $SYMMETRIC_KEY_BYTES 字节")
        }
        if (nonce.size != AEAD_NONCE_BYTES) {
            throw E2eCryptoException("malformed", "AEAD nonce 必须是 $AEAD_NONCE_BYTES 字节")
        }
    }
}

/** 32 字节裸 X25519 密钥对。私钥永不外传；公钥可以出现在 wire 字段与 `info` 串里。 */
class X25519KeyPair(val privateRaw: ByteArray, val publicRaw: ByteArray) {
    companion object {
        /** 私钥 = 随机 32 字节；RFC 7748 的 clamp 在标量运算（生成公钥 / 协商）时进行，与 Node 行为一致。 */
        fun generate(): X25519KeyPair = fromPrivateRaw(Crypto.randomBytes(Crypto.X25519_KEY_BYTES))

        fun fromSeed(seed: ByteArray): X25519KeyPair = fromPrivateRaw(seed)

        fun fromPrivateRaw(raw: ByteArray): X25519KeyPair {
            if (raw.size != Crypto.X25519_KEY_BYTES) {
                throw Crypto.E2eCryptoException("invalid_key_length", "X25519 私钥必须是 32 字节")
            }
            val privateRaw = raw.copyOf()
            val publicRaw = ByteArray(Crypto.X25519_KEY_BYTES)
            X25519.generatePublicKey(privateRaw, 0, publicRaw, 0)
            return X25519KeyPair(privateRaw, publicRaw)
        }
    }
}
