package dev.pi.remote

import kotlinx.serialization.Serializable

/**
 * 扫码配对的密码学部分（spec §4）。与 `packages/e2e/src/pairing.ts` 逐字节对齐。
 *
 * 手机侧的信任根只有一个：二维码里的 `hostPub` 与 `psk`（物理路径，不经过网络）。
 * `pskRoot` 在配对成功后长期复用，是之后每次连接握手的身份盐。
 */
object PairingE2e {
    const val PAIRING_SALT = "pi-remote/v2"
    const val NONCE_BYTES = 32

    /**
     * `pskRoot = HKDF(ikm = ss, salt = "pi-remote/v2", info = "root|" + hostPub + devicePub)`
     * info 里的公钥是 base64url 文本，**host 在前 device 在后**。
     */
    fun derivePskRoot(sharedSecret: ByteArray, hostPublicRaw: ByteArray, devicePublicRaw: ByteArray): ByteArray {
        val info = "root|" + Crypto.toBase64Url(hostPublicRaw) + Crypto.toBase64Url(devicePublicRaw)
        return Crypto.hkdfSha256(sharedSecret, PAIRING_SALT.toByteArray(Charsets.UTF_8), info)
    }

    /** `confirmKey = HKDF(ikm = psk, salt = pskRoot, info = "pair-confirm|" + hostPub + devicePub)`。 */
    fun deriveConfirmKey(psk: ByteArray, pskRoot: ByteArray, hostPublicRaw: ByteArray, devicePublicRaw: ByteArray): ByteArray {
        val info = "pair-confirm|" + Crypto.toBase64Url(hostPublicRaw) + Crypto.toBase64Url(devicePublicRaw)
        return Crypto.hkdfSha256(psk, pskRoot, info)
    }

    /** `mac_d = HMAC(confirmKey, "device|" + nonce_d)`。`"device"` 是字面标签，不是 deviceId。 */
    fun pairMacFromDevice(confirmKey: ByteArray, nonceD: String): ByteArray =
        Crypto.hmacSha256(confirmKey, "device|", nonceD)

    /** `mac_h = HMAC(confirmKey, "host|" + nonce_d + nonce_h)` —— 覆盖两个 nonce。 */
    fun pairMacFromHost(confirmKey: ByteArray, nonceD: String, nonceH: String): ByteArray =
        Crypto.hmacSha256(confirmKey, "host|", nonceD, nonceH)
}

/** 配对帧正文（`ct` 是明文，里面全是公开值）。 */
@Serializable
data class PairRequestBody(
    val type: String,
    val devicePub: String,
    val deviceId: String,
    val nonceD: String,
    val macD: String,
)

@Serializable
data class PairAcceptBody(
    val type: String,
    val hostId: String,
    val nonceH: String,
    val macH: String,
)

/**
 * 手机扫到 QR 之后的本地计算——这一步一个字节都不上网。
 * 长期密钥对首次配对时生成、之后长期复用（见 [DeviceIdentityStore]）。
 */
class DevicePairingSession(
    val nonceD: String,
    val pskRoot: ByteArray,
    private val confirmKey: ByteArray,
    val request: PairRequestBody,
) {
    companion object {
        fun create(
            hostPublicRaw: ByteArray,
            psk: ByteArray,
            deviceId: String,
            deviceKeyPair: X25519KeyPair,
            nonceD: String = Crypto.toBase64Url(Crypto.randomBytes(PairingE2e.NONCE_BYTES)),
        ): DevicePairingSession {
            if (deviceKeyPair.publicRaw.size != Crypto.X25519_KEY_BYTES) {
                throw Crypto.E2eCryptoException("invalid_key_length", "设备公钥长度不对")
            }
            val sharedSecret = Crypto.deriveSharedSecret(deviceKeyPair.privateRaw, hostPublicRaw)
            val pskRoot = PairingE2e.derivePskRoot(sharedSecret, hostPublicRaw, deviceKeyPair.publicRaw)
            val confirmKey = PairingE2e.deriveConfirmKey(psk, pskRoot, hostPublicRaw, deviceKeyPair.publicRaw)
            return DevicePairingSession(
                nonceD = nonceD,
                pskRoot = pskRoot,
                confirmKey = confirmKey,
                request = PairRequestBody(
                    type = "pair-request",
                    devicePub = Crypto.toBase64Url(deviceKeyPair.publicRaw),
                    deviceId = deviceId,
                    nonceD = nonceD,
                    macD = Crypto.toBase64Url(PairingE2e.pairMacFromDevice(confirmKey, nonceD)),
                ),
            )
        }
    }

    /**
     * 校验 `mac_h`：通过即证明对面确实持有 `host_pub` 对应的私钥——
     * 这就是「没被中间人」的全部内容。
     */
    fun verifyAccept(accept: PairAcceptBody) {
        if (accept.hostId.isEmpty()) {
            throw Crypto.E2eCryptoException("malformed", "PAIR_ACCEPT 缺少 hostId")
        }
        val expected = PairingE2e.pairMacFromHost(confirmKey, nonceD, accept.nonceH)
        val actual = Crypto.fromBase64Url(accept.macH, "macH")
        if (!Crypto.constantTimeEqual(expected, actual)) {
            throw Crypto.E2eCryptoException("mac_mismatch", "mac_h 校验失败：对面不是持有 hostPub 对应私钥的那台电脑")
        }
    }
}
