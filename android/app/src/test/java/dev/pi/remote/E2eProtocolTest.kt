package dev.pi.remote

import kotlinx.serialization.encodeToString
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 配对 → 握手 → 加密流的完整设备侧流程测试。对端的期望值全部来自
 * Node 侧权威实现（`packages/e2e`）的固定密钥输出（见 [E2eVectors]）。
 */
class E2eProtocolTest {
    // RFC 7748 向量：Alice = host 长期密钥，Bob = device 长期密钥
    private val hostPriv = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
    private val devicePriv = hex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
    private val hostPub = E2eVectors.HOST_PUB
    private val devicePub = E2eVectors.DEVICE_PUB

    @Test
    fun pairing_request_matches_node_vector() {
        val session = DevicePairingSession.create(
            hostPublicRaw = Crypto.fromBase64Url(hostPub, "hostPub"),
            psk = ByteArray(32) { 0x11 },
            deviceId = "device-1",
            deviceKeyPair = X25519KeyPair.fromPrivateRaw(devicePriv),
            nonceD = E2eVectors.NONCE_D,
        )
        assertEquals(E2eVectors.PSK_ROOT, Crypto.toBase64Url(session.pskRoot))
        assertEquals("pair-request", session.request.type)
        assertEquals(devicePub, session.request.devicePub)
        assertEquals("device-1", session.request.deviceId)
        assertEquals(E2eVectors.NONCE_D, session.request.nonceD)
        assertEquals(E2eVectors.MAC_D, session.request.macD)

        // Host 侧（Node 生成）的 pair-accept：macH 可被手机独立验证
        session.verifyAccept(
            PairAcceptBody(type = "pair-accept", hostId = "host-1", nonceH = E2eVectors.NONCE_H, macH = E2eVectors.MAC_H),
        )
    }

    @Test
    fun pairing_verify_rejects_wrong_mac() {
        val session = DevicePairingSession.create(
            hostPublicRaw = Crypto.fromBase64Url(hostPub, "hostPub"),
            psk = ByteArray(32) { 0x11 },
            deviceId = "device-1",
            deviceKeyPair = X25519KeyPair.fromPrivateRaw(devicePriv),
            nonceD = E2eVectors.NONCE_D,
        )
        try {
            session.verifyAccept(
                PairAcceptBody(type = "pair-accept", hostId = "host-1", nonceH = E2eVectors.NONCE_H, macH = E2eVectors.MAC_H.dropLast(4) + "AAAA"),
            )
            throw AssertionError("错误的 macH 应当被拒绝")
        } catch (error: Crypto.E2eCryptoException) {
            assertEquals("mac_mismatch", error.code)
        }
    }

    @Test
    fun handshake_full_flow_matches_node_vectors() {
        // 手机侧固定临时密钥（0x44），Host 侧临时公钥/密钥来自 Node 向量（0x55）
        val handshake = DeviceHandshake(
            pskRoot = Crypto.fromBase64Url(E2eVectors.PSK_ROOT, "pskRoot"),
            ephemeralSeed = ByteArray(32) { 0x44 },
        )
        val hs1 = handshake.start()
        assertEquals("hs1", hs1.type)
        assertEquals(E2eVectors.E_PUB_D, hs1.ePubD)

        // Node 侧 HostHandshake 对这个 HS1 会回的 hs2（macH 由 k_h2d 派生）
        val hs3 = handshake.accept(
            HandshakeAcceptBody(type = "hs2", ePubH = E2eVectors.E_PUB_H, macH = E2eVectors.HS_MAC_H),
        )
        assertEquals("hs3", hs3.type)
        assertEquals(E2eVectors.HS_MAC_D, hs3.macD)

        val keys = handshake.sessionKeys()
        assertEquals(E2eVectors.K_D2H, Crypto.toBase64Url(keys.kDeviceToHost))
        assertEquals(E2eVectors.K_H2D, Crypto.toBase64Url(keys.kHostToDevice))
    }

    @Test
    fun handshake_rejects_wrong_host_mac() {
        val handshake = DeviceHandshake(
            pskRoot = Crypto.fromBase64Url(E2eVectors.PSK_ROOT, "pskRoot"),
            ephemeralSeed = ByteArray(32) { 0x44 },
        )
        try {
            handshake.accept(HandshakeAcceptBody(type = "hs2", ePubH = E2eVectors.E_PUB_H, macH = E2eVectors.MAC_H))
            throw AssertionError("用配对 macH 冒充握手 macH 应当被拒绝")
        } catch (error: Crypto.E2eCryptoException) {
            assertEquals("mac_mismatch", error.code)
        }
    }

    @Test
    fun channel_seal_matches_node_ct() {
        val channel = deviceChannel()
        val envelope = channel.seal(
            kind = "data",
            room = "host-1",
            from = "device-1",
            to = "host-1",
            payload = "{\"type\":\"device.ready\"}".toByteArray(Charsets.UTF_8),
            channel = "ctl",
        )
        assertEquals(1L, envelope.hdr.n)
        assertEquals("data", envelope.hdr.k)
        assertEquals("host-1", envelope.hdr.room)
        assertEquals("device-1", envelope.hdr.from)
        assertEquals("host-1", envelope.hdr.to)
        assertEquals(2, envelope.v)
        assertEquals(E2eVectors.DATA_CT_N1, envelope.ct)

        val second = channel.seal("data", "host-1", "device-1", "host-1", "hello world".toByteArray(Charsets.UTF_8), "ctl")
        assertEquals(2L, second.hdr.n)
        assertEquals(E2eVectors.DATA_CT_N2, second.ct)
    }

    @Test
    fun channel_open_node_frames_and_rejects_replay() {
        // Node 向量是 device→host 方向的帧，host 角色的信道用 kD2h 解开
        val channel = hostChannel()
        // Node 向量的路由方向：device → host
        val frame1 = EnvelopeV2(
            v = 2,
            hdr = RoutingHeaderV2("data", "host-1", "device-1", "host-1", 1, "ctl"),
            ct = E2eVectors.DATA_CT_N1,
        )
        assertArrayEquals("{\"type\":\"device.ready\"}".toByteArray(Charsets.UTF_8), channel.open(frame1))

        // 重放（n 落回水位线以下）按幂等丢弃：返回 null 而不是抛错。
        // 把重放当错误上报的话，中继可以用重放把接收方刷进错误处理。
        assertNull(channel.open(frame1))
    }

    @Test
    fun channel_bidirectional_roundtrip_with_separate_direction_keys() {
        // 手机与 Host 各持一把方向密钥；对端解密必须用对方 seal 的输出。
        val keys = SessionKeys(
            kHostToDevice = Crypto.fromBase64Url(E2eVectors.K_H2D, "kH2d"),
            kDeviceToHost = Crypto.fromBase64Url(E2eVectors.K_D2H, "kD2h"),
        )
        val phone = E2eChannel(keys, E2eChannel.ROLE_DEVICE)
        val host = E2eChannel(keys, E2eChannel.ROLE_HOST)

        val outbound = phone.seal("data", "host-1", "device-1", "host-1", "你好，世界".toByteArray(Charsets.UTF_8), "ctl")
        assertArrayEquals("你好，世界".toByteArray(Charsets.UTF_8), host.open(outbound))

        val reply = host.seal("data", "host-1", "host-1", "device-1", "pong".toByteArray(Charsets.UTF_8), "ctl")
        assertArrayEquals("pong".toByteArray(Charsets.UTF_8), phone.open(reply))

        // 两个方向序号各自独立（各从 1 开始）
        assertEquals(1L, outbound.hdr.n)
        assertEquals(1L, reply.hdr.n)
        assertNotEquals(outbound.ct, reply.ct)
    }

    @Test
    fun plaintext_envelope_roundtrip() {
        val body = PairRequestBody("pair-request", devicePub, "device-1", E2eVectors.NONCE_D, E2eVectors.MAC_D)
        val envelope = PlaintextEnvelope.build("pair", room = "host-1", from = "device-1", to = "host-1", body = body)
        assertEquals(0L, envelope.hdr.n)
        assertEquals("pair", envelope.hdr.k)
        // 明文帧 ct 是可逆的 base64url JSON
        val decoded = PlaintextEnvelope.read<PairRequestBody>(envelope, "pair")
        assertEquals(body, decoded)
        // 用错种类读取必须报错
        try {
            PlaintextEnvelope.read<PairRequestBody>(envelope, "hs")
            throw AssertionError("种类不匹配应当报错")
        } catch (error: Crypto.E2eCryptoException) {
            assertTrue(error.message!!.contains("期望 hs"))
        }
    }

    @Test
    fun envelope_json_serializes_v2_wire_shape() {
        val envelope = EnvelopeV2(
            v = 2,
            hdr = RoutingHeaderV2("data", "host-1", "device-1", "host-1", 1),
            ct = E2eVectors.DATA_CT_N1,
        )
        val text = E2eJson.json.encodeToString(envelope)
        // 字段名必须与 Node 侧 zod schema 完全一致
        assertTrue(text.contains("\"v\":2"))
        assertTrue(text.contains("\"k\":\"data\""))
        assertTrue(text.contains("\"room\":\"host-1\""))
        assertTrue(text.contains("\"n\":1"))
        assertTrue(text.contains("\"ct\":\"${E2eVectors.DATA_CT_N1}\""))
        val round = E2eJson.decode<EnvelopeV2>(text, "envelope")
        assertEquals(envelope, round)
    }

    // 票 07 的全部收益：bulk 丢一帧只卡 bulk。升级前所有流量共用一个序号，
    // 分片丢一帧会让后面的 ctl / msg 全部卡在 sequence_gap 上——现场表现就是
    // 「下载一开，聊天记录不刷新、消息发不出去」。
    @Test
    fun channels_isolate_a_bulk_gap_from_the_control_plane() {
        val phone = deviceChannel()
        val host = hostChannel()

        fun seal(channel: String, payload: String): EnvelopeV2 {
            val kind = if (channel == "bulk") "bin" else "data"
            return phone.seal(kind, "host-1", "device-1", "host-1", payload.toByteArray(Charsets.UTF_8), channel)
        }

        assertEquals("chunk-1", host.open(seal("bulk", "chunk-1"))?.toString(Charsets.UTF_8))
        assertEquals("status", host.open(seal("ctl", "status"))?.toString(Charsets.UTF_8))
        assertEquals("delta", host.open(seal("msg", "delta"))?.toString(Charsets.UTF_8))

        // 丢一帧：封好但不投递。
        val chunk2 = seal("bulk", "chunk-2")
        val chunk3 = seal("bulk", "chunk-3")
        // 高水位线语义：chunk-3 照常解开，通道不再被空洞毒化（issue 04）。
        assertEquals("chunk-3", host.open(chunk3)?.toString(Charsets.UTF_8))

        // 控制面完全不受影响。
        assertEquals("status-2", host.open(seal("ctl", "status-2"))?.toString(Charsets.UTF_8))
        // 丢失的那一帧再到达时已落在水位线以下，按重放丢弃。
        assertNull(host.open(chunk2))
    }

    @Test
    fun channel_numbering_is_independent() {
        val phone = deviceChannel()
        // 每条 channel 各自从 1 开始。
        assertEquals(1L, phone.nextSequence("ctl"))
        assertEquals(1L, phone.nextSequence("bulk"))
        phone.seal("data", "host-1", "device-1", "host-1", "a".toByteArray(Charsets.UTF_8), "ctl")
        assertEquals(2L, phone.nextSequence("ctl"))
        assertEquals(1L, phone.nextSequence("bulk"))

        // 加密帧缺 channel 是协议错误（ADR-0008 取消了"缺省 = 单流"）。发送侧已无法省略
        // 该参数，所以这里从未携带 `ch` 的入站帧入手。
        var threw = false
        try {
            phone.open(
                EnvelopeV2(
                    v = 2,
                    hdr = RoutingHeaderV2(k = "data", room = "host-1", from = "device-1", to = "host-1", n = 1L),
                    ct = "AAAA",
                ),
            )
        } catch (error: Crypto.E2eCryptoException) {
            threw = error.message!!.contains("缺少 hdr.ch")
        }
        assertTrue("缺 hdr.ch 的加密帧必须被拒", threw)
    }

    // 线上契约：缺省的 channel 必须是「字段缺席」，不是「字段写个 null」。
    //
    // `E2eJson` 开了 `encodeDefaults`，而 `RoutingHeaderV2.ch` 的默认值是 null——少了
    // `@EncodeDefault(NEVER)`，Kotlin 会把它编码成 `"ch":null` 发上线。Relay 与 Host 的
    // schema 是 `z.enum([...]).optional()`，**只认缺席、不认 null**，于是整帧判非法
    // （Relay 回 `invalid_message` 并关连接，手机一打开就连不上）。TS 端用 JSON.stringify，
    // undefined 的键会被省略，所以这个不对称只在手机侧炸。
    //
    // 上面那条 `channel_numbering_...` 只断言了 `hdr.ch == null` 这个**对象属性**，
    // 所以没拦住它；这一条断言的是**上线后的字节**。
    @Test
    fun absent_channel_must_not_put_a_ch_key_on_the_wire() {
        val envelope = PlaintextEnvelope.build(
            kind = "hs",
            room = "host-1",
            from = "device-1",
            to = "host-1",
            body = HandshakeHello(type = "hs1", ePubD = "device-epub"),
        )
        val frame = V2Frame(type = "v2.frame", protocolVersion = PROTOCOL_VERSION, envelope = envelope)
        val wire = E2eJson.json.encodeToString(frame)

        assertTrue("缺省 channel 不得把 ch 键写上线路：$wire", !wire.contains("\"ch\""))

        // 显式 channel 必须照常出现——否则隔离静默失效。
        val explicit = E2eJson.json.encodeToString(
            RoutingHeaderV2(k = "data", room = "host-1", from = "device-1", to = "host-1", n = 1L, ch = "bulk"),
        )
        assertTrue("显式 channel 必须出现在线格式里：$explicit", explicit.contains("\"ch\":\"bulk\""))
    }

    // `hdr` 里**所有**可选字段都必须「缺席」而不是「写 null」。
    //
    // 上面那条只盯了 `ch`，因为它是第一个踩坑的字段；`ik/mid/idx/last`（切片引入）当时只在
    // 注释里写了「同样不能省 @EncodeDefault(NEVER)」，注解却没跟上——于是**每一条** v2 帧
    // 都带着 `"ik":null,"mid":null,"idx":null,"last":null` 上线。Relay/Host 的 schema 是
    // `z.enum(...).optional()`，只认缺席、不认 null，整帧判非法：手机一打开就被
    // `invalid_message` 关掉连接，而手机侧只显示「Relay 拒绝了协议消息」。
    //
    // 所以这里断言的是**整帧字节里不许出现 null**，而不是逐字段列名字——将来再加可选字段时
    // 漏注解会照样被这条拦住。
    @Test
    fun no_optional_header_key_may_be_null_on_the_wire() {
        val envelope = PlaintextEnvelope.build(
            kind = "hs",
            room = "host-1",
            from = "device-1",
            to = "host-1",
            body = HandshakeHello(type = "hs1", ePubD = "device-epub"),
        )
        val wire = E2eJson.json.encodeToString(V2Frame(type = "v2.frame", protocolVersion = PROTOCOL_VERSION, envelope = envelope))
        assertTrue("hdr 可选字段不得以 null 上线：$wire", !wire.contains("null"))

        // 真片帧必须把 ik/mid/idx/last 带上——否则切片静默失效（接收侧无法重组）。
        val piece = E2eJson.json.encodeToString(
            RoutingHeaderV2(
                k = "piece", room = "host-1", from = "device-1", to = "host-1", n = 1L,
                ch = "bulk", ik = "bin", mid = "m1", idx = 0, last = true,
            ),
        )
        assertTrue("显式片字段必须出现在线格式里：$piece", piece.contains("\"ik\":\"bin\""))
        assertTrue("末片标记必须出现在线格式里：$piece", piece.contains("\"last\":true"))
    }

    private fun hostChannel(): E2eChannel = E2eChannel(
        SessionKeys(
            kHostToDevice = Crypto.fromBase64Url(E2eVectors.K_H2D, "kH2d"),
            kDeviceToHost = Crypto.fromBase64Url(E2eVectors.K_D2H, "kD2h"),
        ),
        E2eChannel.ROLE_HOST,
    )

    private fun deviceChannel(): E2eChannel = E2eChannel(
        SessionKeys(
            kHostToDevice = Crypto.fromBase64Url(E2eVectors.K_H2D, "kH2d"),
            kDeviceToHost = Crypto.fromBase64Url(E2eVectors.K_D2H, "kD2h"),
        ),
        E2eChannel.ROLE_DEVICE,
    )

    private fun hex(value: String): ByteArray = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
