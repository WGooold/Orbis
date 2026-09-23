package dev.pi.remote

import kotlinx.serialization.Serializable

/**
 * 连接级握手（HS1/HS2/HS3）与加密流（spec §5.3 / §5.4）。
 * 与 `packages/e2e/src/session.ts` 逐字节对齐。
 *
 * `ee`、`pskRoot`、`k_h2d`、`k_d2h` 都从不上网，网络上只有临时公钥与 MAC。
 * 每次建立或更换路径都重跑一次握手——「换网络不掉线」和「前向保密」都来自这里。
 */
object HandshakeE2e {
    /**
     * 派生两把方向密钥。`info` 里两个临时公钥**固定 `e_pub_h` 在前**，
     * 写反会导致两端派生出不同的密钥（这是配对版 `hostPub` 在前的残留，别抄混）。
     */
    fun deriveSessionKeys(
        sharedSecret: ByteArray,
        pskRoot: ByteArray,
        hostEphemeralPublic: ByteArray,
        deviceEphemeralPublic: ByteArray,
    ): SessionKeys {
        val hostPub = Crypto.toBase64Url(hostEphemeralPublic)
        val devicePub = Crypto.toBase64Url(deviceEphemeralPublic)
        return SessionKeys(
            kHostToDevice = Crypto.hkdfSha256(sharedSecret, pskRoot, "h2d|$hostPub$devicePub"),
            kDeviceToHost = Crypto.hkdfSha256(sharedSecret, pskRoot, "d2h|$hostPub$devicePub"),
        )
    }

    /**
     * 每个确认 MAC 都用**发送方自己方向**的会话密钥：Host 用 `k_h2d`（它发数据用的），
     * 手机用 `k_d2h`。这样「谁确认」和「谁用哪把钥匙」是同一个事实。
     */
    fun handshakeMacFromHost(keys: SessionKeys, hostEphemeralPublic: ByteArray, deviceEphemeralPublic: ByteArray): ByteArray =
        Crypto.hmacSha256(keys.kHostToDevice, "hs-h|", Crypto.toBase64Url(hostEphemeralPublic), Crypto.toBase64Url(deviceEphemeralPublic))

    fun handshakeMacFromDevice(keys: SessionKeys, hostEphemeralPublic: ByteArray, deviceEphemeralPublic: ByteArray): ByteArray =
        Crypto.hmacSha256(keys.kDeviceToHost, "hs-d|", Crypto.toBase64Url(hostEphemeralPublic), Crypto.toBase64Url(deviceEphemeralPublic))
}

data class SessionKeys(val kHostToDevice: ByteArray, val kDeviceToHost: ByteArray)

@Serializable
data class HandshakeHello(val type: String, val ePubD: String)

@Serializable
data class HandshakeAcceptBody(val type: String, val ePubH: String, val macH: String)

@Serializable
data class HandshakeConfirmBody(val type: String, val macD: String)

/**
 * 手机侧握手状态机：发 HS1 → 收 HS2 → 验 `mac_h` → 产出 HS3。
 *
 * `ephemeralSeed` 仅测试注入用（固定临时密钥才能与 Node 侧向量对齐），
 * 生产路径一律走默认随机。
 */
class DeviceHandshake(
    pskRoot: ByteArray,
    ephemeralSeed: ByteArray? = null,
) {
    private val keyPair = ephemeralSeed?.let(X25519KeyPair::fromSeed) ?: X25519KeyPair.generate()
    private val pskRoot: ByteArray = pskRoot.copyOf()
    private var keys: SessionKeys? = null

    init {
        if (this.pskRoot.size != Crypto.SYMMETRIC_KEY_BYTES) {
            throw Crypto.E2eCryptoException("invalid_key_length", "pskRoot 必须是 32 字节")
        }
    }

    val ephemeralPublicRaw: ByteArray get() = keyPair.publicRaw

    fun start(): HandshakeHello = HandshakeHello(type = "hs1", ePubD = Crypto.toBase64Url(keyPair.publicRaw))

    /** 校验 `mac_h` 通过才落密钥——这一步就是「对面确实是那台电脑」。 */
    fun accept(body: HandshakeAcceptBody): HandshakeConfirmBody {
        val hostEphemeralPublic = Crypto.fromBase64UrlFixed(body.ePubH, Crypto.X25519_KEY_BYTES, "ePubH")
        val sharedSecret = Crypto.deriveSharedSecret(keyPair.privateRaw, hostEphemeralPublic)
        val derived = HandshakeE2e.deriveSessionKeys(sharedSecret, pskRoot, hostEphemeralPublic, keyPair.publicRaw)
        val expected = HandshakeE2e.handshakeMacFromHost(derived, hostEphemeralPublic, keyPair.publicRaw)
        val actual = Crypto.fromBase64Url(body.macH, "macH")
        if (!Crypto.constantTimeEqual(expected, actual)) {
            throw Crypto.E2eCryptoException("mac_mismatch", "mac_h 校验失败：对面拿不出这台电脑的 pskRoot")
        }
        keys = derived
        return HandshakeConfirmBody(
            type = "hs3",
            macD = Crypto.toBase64Url(HandshakeE2e.handshakeMacFromDevice(derived, hostEphemeralPublic, keyPair.publicRaw)),
        )
    }

    fun sessionKeys(): SessionKeys = keys ?: throw Crypto.E2eCryptoException("not_ready", "握手尚未完成")
}

/**
 * 一个方向的加密流（手机视角：发 `k_d2h`、收 `k_h2d`）。发送序号按 channel 各自从 1 开始、严格递增。
 *
 * 接收侧**只查高水位线**（`n > last` 才收）：nonce 的唯一性由 `(channel 槽位, n)`
 * 共同保证（见 `EnvelopeV2Contract.nonce`），不依赖接收侧的连续性，所以丢一帧
 * 只是丢那一帧，不会把计数器卡死、更不会把这条 channel 毒成永久空洞（issue 04）。
 * 重放（`n <= last`）落在水位线以下，静默丢弃——对幂等的载荷这是正确行为，
 * 对「中继用重放刷错误」也是釜底抽薪。不做应用层重传、不做乱序重排：
 * 底层是有序可靠传输，丢的帧不会迟到。
 */
class E2eChannel(keys: SessionKeys, role: String) {
    private val sendKey: ByteArray
    private val receiveKey: ByteArray

    /**
     * 序号按 channel 各自计数（spec 票 07）。
     *
     * 这是多路复用的全部要害：`bulk` 丢一帧只影响 `bulk`，`ctl` / `msg` 的序列照常推进。
     *
     * 只有这一条路径：`channel` 是 `seal` 的必填参数（没有缺省值），而 `open` 对缺 `ch` 的
     * 加密帧直接抛错，所以不存在与之并列的「单流计数」（ADR-0008）。
     */
    private val sendSequences = mutableMapOf<String, Long>()
    private val receiveSequences = mutableMapOf<String, Long>()

    init {
        when (role) {
            ROLE_HOST -> {
                sendKey = keys.kHostToDevice
                receiveKey = keys.kDeviceToHost
            }
            ROLE_DEVICE -> {
                sendKey = keys.kDeviceToHost
                receiveKey = keys.kHostToDevice
            }
            else -> throw Crypto.E2eCryptoException("malformed", "未知角色：$role")
        }
    }

    /** 下一条该用的序号（按 channel 各自计数）。 */
    fun nextSequence(channel: String): Long = (sendSequences[channel] ?: 0L) + 1

    fun seal(
        kind: String,
        room: String,
        from: String,
        to: String,
        payload: ByteArray,
        channel: String,
    ): EnvelopeV2 {
        if (kind == "hs" || kind == "pair") {
            throw Crypto.E2eCryptoException("malformed", "$kind 帧不加密，请用 PlaintextEnvelope")
        }
        val next = (sendSequences[channel] ?: 0L) + 1
        val hdr = RoutingHeaderV2(k = kind, room = room, from = from, to = to, n = next, ch = channel)
        val sealed = Crypto.sealAead(
            key = sendKey,
            nonce = EnvelopeV2Contract.nonce(channel, hdr.n),
            aad = EnvelopeV2Contract.canonAad(hdr),
            plaintext = payload,
        )
        sendSequences[channel] = next
        return EnvelopeV2(v = EnvelopeV2Contract.VERSION, hdr = hdr, ct = Crypto.toBase64Url(sealed))
    }

    /**
     * 解开一条加密帧。
     *
     * 返回 `null` 表示这条帧是**重放**（`n <= last`）：它已被处理过，按幂等丢弃，
     * 不是故障——调用方不要把它当错误上报（否则中继可以用重放把接收方刷进错误处理）。
     */
    fun open(envelope: EnvelopeV2): ByteArray? {
        val hdr = envelope.hdr
        if (hdr.k == "hs" || hdr.k == "pair") {
            throw Crypto.E2eCryptoException("malformed", "${hdr.k} 帧不是密文，请用 PlaintextEnvelope")
        }
        val channel = hdr.ch ?: throw Crypto.E2eCryptoException("malformed", "加密帧 ${hdr.k} 缺少 hdr.ch")
        val last = receiveSequences[channel] ?: 0L
        if (hdr.n <= last) {
            return null
        }
        val plaintext = Crypto.openAead(
            key = receiveKey,
            nonce = EnvelopeV2Contract.nonce(channel, hdr.n),
            aad = EnvelopeV2Contract.canonAad(hdr),
            sealed = Crypto.fromBase64Url(envelope.ct, "ct"),
        )
        receiveSequences[channel] = hdr.n
        return plaintext
    }

    companion object {
        const val ROLE_HOST = "host"
        const val ROLE_DEVICE = "device"

    }
}
