package dev.pi.remote

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 交叉验证向量：由 Node 侧 `packages/e2e`（权威实现）用固定密钥生成，
 * 见仓库 `scripts/e2e-vectors.mjs`。两端任何一侧改动密码学行为，这里必挂。
 */
class CryptoTest {
    // RFC 7748 §5.2 测试向量
    private val alicePriv = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
    private val bobPriv = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
    private val alicePub = E2eVectors.HOST_PUB
    private val bobPub = E2eVectors.DEVICE_PUB
    private val shared = hex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")

    @Test
    fun x25519_publicKey_matches_rfc7748() {
        val alice = X25519KeyPair.fromPrivateRaw(alicePriv)
        val bob = X25519KeyPair.fromPrivateRaw(bobPriv)
        assertEquals(alicePub, Crypto.toBase64Url(alice.publicRaw))
        assertEquals(bobPub, Crypto.toBase64Url(bob.publicRaw))
    }

    @Test
    fun x25519_sharedSecret_both_directions() {
        val aliceKey = X25519KeyPair.fromPrivateRaw(alicePriv)
        val bobKey = X25519KeyPair.fromPrivateRaw(bobPriv)
        assertArrayEquals(shared, Crypto.deriveSharedSecret(aliceKey.privateRaw, bobKey.publicRaw))
        assertArrayEquals(shared, Crypto.deriveSharedSecret(bobKey.privateRaw, aliceKey.publicRaw))
    }

    @Test
    fun x25519_rejects_degenerate_public_key() {
        try {
            Crypto.deriveSharedSecret(alicePriv, ByteArray(32))
            throw AssertionError("全零公钥应当被拒绝")
        } catch (error: Crypto.E2eCryptoException) {
            assertTrue(error.code == "degenerate_public_key" || error.code == "degenerate_shared_secret")
        }
    }

    @Test
    fun base64url_roundtrip_and_strict_decode() {
        val bytes = byteArrayOf(0, 1, 2, 250.toByte(), 251.toByte(), 255.toByte())
        val encoded = Crypto.toBase64Url(bytes)
        assertFalse(encoded.contains("="))
        assertFalse(encoded.contains("+"))
        assertArrayEquals(bytes, Crypto.fromBase64Url(encoded, "test"))
        try {
            Crypto.fromBase64Url("abc+", "test")
            throw AssertionError("非法字符应当被拒绝")
        } catch (error: Crypto.E2eCryptoException) {
            assertEquals("malformed", error.code)
        }
    }

    @Test
    fun hkdf_matches_node_vectors() {
        // 由 Node 侧 derivePskRoot / deriveConfirmKey / deriveSessionKeys 生成（固定密钥）
        val pskRoot = Crypto.hkdfSha256(
            ikm = shared,
            salt = "pi-remote/v2".toByteArray(Charsets.UTF_8),
            info = "root|${alicePub}${bobPub}",
        )
        assertEquals("Xc5yaEsPIReHbncWPXU1GrW_YpUGNcpX5p1Zb-9dEwE", Crypto.toBase64Url(pskRoot))

        val psk = ByteArray(32) { 0x11 }
        val confirmKey = Crypto.hkdfSha256(psk, pskRoot, "pair-confirm|${alicePub}${bobPub}")
        assertEquals(E2eVectors.CONFIRM_KEY, Crypto.toBase64Url(confirmKey))

        // 握手方向密钥（临时密钥见 E2eVectors：eD = 32×0x44，eH = 32×0x55）
        val eD = ByteArray(32) { 0x44 }
        val ee = Crypto.deriveSharedSecret(eD, Crypto.fromBase64Url(E2eVectors.E_PUB_H, "ePubH"))
        val keys = HandshakeE2e.deriveSessionKeys(
            ee,
            pskRoot,
            Crypto.fromBase64Url(E2eVectors.E_PUB_H, "ePubH"),
            Crypto.fromBase64Url(E2eVectors.E_PUB_D, "ePubD"),
        )
        assertEquals(E2eVectors.K_H2D, Crypto.toBase64Url(keys.kHostToDevice))
        assertEquals(E2eVectors.K_D2H, Crypto.toBase64Url(keys.kDeviceToHost))

        // X25519 公钥推导也要与 Node 的 privateKeyFromRaw 一致
        val eDPub = X25519KeyPair.fromPrivateRaw(eD)
        assertEquals(E2eVectors.E_PUB_D, Crypto.toBase64Url(eDPub.publicRaw))
    }

    @Test
    fun hmac_matches_node_vector() {
        val confirmKey = Crypto.fromBase64Url(E2eVectors.CONFIRM_KEY, "confirmKey")
        val nonceD = E2eVectors.NONCE_D
        val nonceH = E2eVectors.NONCE_H
        assertEquals(E2eVectors.MAC_D, Crypto.toBase64Url(PairingE2e.pairMacFromDevice(confirmKey, nonceD)))
        assertEquals(E2eVectors.MAC_H, Crypto.toBase64Url(PairingE2e.pairMacFromHost(confirmKey, nonceD, nonceH)))
    }

    @Test
    fun aead_seal_matches_node_ct_and_roundtrip() {
        val key = Crypto.fromBase64Url(E2eVectors.K_D2H, "key")
        val hdr = RoutingHeaderV2(k = "data", room = "host-1", from = "device-1", to = "host-1", n = 1, ch = "ctl")
        val payload = "{\"type\":\"device.ready\"}".toByteArray(Charsets.UTF_8)
        val sealed = Crypto.sealAead(key, EnvelopeV2Contract.nonce("ctl", 1), EnvelopeV2Contract.canonAad(hdr), payload)
        assertEquals(E2eVectors.DATA_CT_N1, Crypto.toBase64Url(sealed))
        assertArrayEquals(payload, Crypto.openAead(key, EnvelopeV2Contract.nonce("ctl", 1), EnvelopeV2Contract.canonAad(hdr), sealed))
    }

    @Test
    fun aead_open_rejects_tampered_aad() {
        val key = Crypto.fromBase64Url(E2eVectors.K_D2H, "key")
        val hdr = RoutingHeaderV2(k = "data", room = "host-1", from = "device-1", to = "host-1", n = 1, ch = "ctl")
        val sealed = Crypto.fromBase64Url(E2eVectors.DATA_CT_N1, "ct")
        val tampered = hdr.copy(room = "host-2")
        try {
            Crypto.openAead(key, EnvelopeV2Contract.nonce("ctl", 1), EnvelopeV2Contract.canonAad(tampered), sealed)
            throw AssertionError("AAD 被篡改后应当解密失败")
        } catch (error: Crypto.E2eCryptoException) {
            assertEquals("aead_failed", error.code)
        }
    }

    @Test
    fun aad_and_nonce_canonical_forms() {
        val hdr = RoutingHeaderV2(k = "data", room = "host-1", from = "device-1", to = "host-1", n = 1, ch = "ctl")
        assertEquals(
            "6b3d646174610a726f6f6d3d686f73742d310a66726f6d3d6465766963652d310a746f3d686f73742d310a63683d63746c0a6e3d31",
            hex(EnvelopeV2Contract.canonAad(hdr)),
        )
        // nonce 布局：前四字节是 channel 槽位（ctl=1），后八字节是 n。
        assertEquals("000000010000000000000001", hex(EnvelopeV2Contract.nonce("ctl", 1)))
        // 槽位把不同 channel 的 nonce 空间分开：同一个 n=1，三条道三个 nonce（issue 01）。
        assertEquals("000000020000000000000001", hex(EnvelopeV2Contract.nonce("msg", 1)))
        assertEquals("000000030000000000000001", hex(EnvelopeV2Contract.nonce("bulk", 1)))
        // 与 Node zod 上限一致：Number.MAX_SAFE_INTEGER = 2^53-1
        assertEquals("00000001001fffffffffffff", hex(EnvelopeV2Contract.nonce("ctl", 9007199254740991)))
    }

    @Test
    fun constant_time_equal_basic() {
        assertTrue(Crypto.constantTimeEqual(byteArrayOf(1, 2), byteArrayOf(1, 2)))
        assertFalse(Crypto.constantTimeEqual(byteArrayOf(1, 2), byteArrayOf(1, 3)))
        assertFalse(Crypto.constantTimeEqual(byteArrayOf(1), byteArrayOf(1, 1)))
        assertNotEquals(Crypto.randomBytes(32), Crypto.randomBytes(32))
    }

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    private fun hex(value: String): ByteArray = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
