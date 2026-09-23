package dev.pi.remote

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * v2 Envelope —— 端到端加密报文的线格式（spec §5.2）。
 *
 * 与 `packages/protocol/src/index.ts` 的 `EnvelopeV2Schema` 逐字段对齐。Relay 只看
 * `hdr`，`ct` 是不透明字符串。本文件是两端必须逐字节一致的互操作契约。
 */
object EnvelopeV2Contract {
    const val VERSION = 2
    const val HANDSHAKE_SEQUENCE = 0L

    /**
     * AAD = canon(hdr)：UTF-8 六行、LF 分隔、无尾随换行、每行 `字段名=值`。
     * 刻意不做 JSON 序列化——JSON 的转义与数字格式化在 JVM 与 V8 间会漂移，
     * AAD 差一个字节就解密失败，逐行 canon 是两端最不容易写岔的形式。
     *
     * `ch` 必须进 AAD：它参与 nonce 派生（见 [nonce]），不认证它等于给
     * 「两端对 ch 的理解不一致」留一条静默通道。
     */
    fun canonAad(hdr: RoutingHeaderV2): ByteArray =
        "k=${hdr.k}\nroom=${hdr.room}\nfrom=${hdr.from}\nto=${hdr.to}\nch=${hdr.ch}\nn=${hdr.n}".toByteArray(Charsets.UTF_8)

    /** channel 在 nonce 前四字节里的槽位。与 TS 侧 `CHANNEL_SLOT` 逐值一致。 */
    private val CHANNEL_SLOT = mapOf("ctl" to 1, "msg" to 2, "bulk" to 3)

    /**
     * `nonce = uint32BE(channel 槽位) ‖ uint64BE(n)`，12 字节。
     *
     * 序号 `n` 按 channel 各自从 1 开始，只用 `n` 派生 nonce 会让两条 channel 的第 1 帧
     * 拿到同一个 (key, nonce) 加密不同明文——AES-GCM 在 nonce 重用下机密性与认证同时
     * 失效（issue 01）。槽位把不同 channel 的 nonce 空间彻底分开。
     *
     * `n` 已进 AAD，nonce 无需随报文传输；`n` 由发送侧严格递增保证每个 nonce 只用一次
     * （接收侧不要求连续，见 `E2eChannel.open`）。
     */
    fun nonce(channel: String, n: Long): ByteArray {
        val slot = CHANNEL_SLOT[channel]
            ?: throw Crypto.E2eCryptoException("malformed", "未知 channel：$channel")
        val bytes = ByteArray(12)
        bytes[0] = ((slot ushr 24) and 0xFF).toByte()
        bytes[1] = ((slot ushr 16) and 0xFF).toByte()
        bytes[2] = ((slot ushr 8) and 0xFF).toByte()
        bytes[3] = (slot and 0xFF).toByte()
        for (i in 0 until 8) {
            bytes[4 + i] = ((n ushr ((7 - i) * 8)) and 0xFF).toByte()
        }
        return bytes
    }
}

/**
 * **每个可选字段都必须显式带 `@EncodeDefault(NEVER)`，一个都不能漏。**
 *
 * `E2eJson` 开了 `encodeDefaults`，Kotlin 于是会把「有默认值但没被显式赋值」的属性照样写上线路；
 * 对可空属性那就是 `"field":null`。而 Relay 与 Host 的 schema 是 `z.enum(...).optional()` 这类
 * **只认字段缺席、不认 null** 的写法，一个 null 就让**整帧**判非法、连接被关。
 *
 * 这个坑已经踩过两次：先是 `ch`（commit c65e3bf），再是切片引入的 `ik/mid/idx/last`——
 * 当时注释里写了「同样不能省」，注解却漏了，于是**每一条** v2 帧都带四个 null，手机一打开就被
 * 中继以 `invalid_message` 断开，而手机侧的文案还把这口锅扣在"协议版本不一致"上（版本其实是对的）。
 *
 * 为什么不在**类**上加一次？本仓库这一版的 kotlinx 里 `@EncodeDefault` 的 target 只有 property
 * （类级会编译失败：`not applicable to target 'class'`）。所以新增可选字段时**必须自己记得加**，
 * 唯一的自动护栏是 `E2eProtocolTest.no_optional_header_key_may_be_null_on_the_wire`——
 * 它断言的是整帧字节里不出现 `null`，漏注解会立刻变红，不用靠人记。
 */
@Serializable
@OptIn(ExperimentalSerializationApi::class)
data class RoutingHeaderV2(
    /** 帧种类：pair / hs（明文，n=0）；data / ping / bin（密文，n 从 1 严格递增）。 */
    val k: String,
    val room: String,
    val from: String,
    val to: String,
    val n: Long,
    /**
     * 逻辑 channel：`ctl` / `msg` / `bulk`（spec 票 07）。
     *
     * **加密帧必填**；握手/配对帧（`hs` / `pair`）不带——它们不参与加密流，本来就没有 channel。
     * 不存在"缺省 = 单流"的旧对端（ADR-0008），因此加密帧缺它就是协议错误。
     *
     * **进 AAD**：canonAad 是六字段（k/room/from/to/ch/n）。
     */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val ch: String? = null,

    /**
     * 仅片帧（`k = "piece"`）携带，与 `packages/protocol/src/piece.ts` 逐字段对齐。
     *
     * - `ik`：**原信封**的 `k`（这一片属于 data 还是 bin）；
     * - `mid`：同一条消息的所有片共用的 id；
     * - `idx`：片序号，0 起连续；
     * - `last`：末片标记。
     *
     * 它们不进 AAD（canonAad 只用 k/room/from/to/ch/n）：片不被单独加密。
     */
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val ik: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val mid: String? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val idx: Int? = null,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val last: Boolean? = null,
)

@Serializable
data class EnvelopeV2(
    val v: Int,
    val hdr: RoutingHeaderV2,
    val ct: String,
)

/** v2 帧的传输外层：Relay 与 Path 只搬运 `envelope`，不看 `ct`。 */
@Serializable
data class V2Frame(
    val type: String,
    @SerialName("protocolVersion") val protocolVersion: Int,
    val envelope: EnvelopeV2,
)

object E2eJson {
    val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    inline fun <reified T> decode(value: String, label: String): T =
        runCatching { json.decodeFromString<T>(value) }.getOrElse {
            throw Crypto.E2eCryptoException("malformed", "$label 解析失败：${it.message ?: it::class.simpleName}")
        }

    inline fun <reified T> decodeElement(element: kotlinx.serialization.json.JsonElement, label: String): T =
        runCatching { json.decodeFromJsonElement<T>(element) }.getOrElse {
            throw Crypto.E2eCryptoException("malformed", "$label 解析失败：${it.message ?: it::class.simpleName}")
        }
}

/** 未加密帧（pair / hs）：`hdr.n = 0`，`ct` 装 base64url 明文 JSON。正文全是公开值。 */
object PlaintextEnvelope {
    inline fun <reified T> build(kind: String, room: String, from: String, to: String, body: T): EnvelopeV2 {
        if (kind != "pair" && kind != "hs") {
            throw Crypto.E2eCryptoException("malformed", "$kind 帧不属于明文帧")
        }
        return EnvelopeV2(
            v = EnvelopeV2Contract.VERSION,
            hdr = RoutingHeaderV2(k = kind, room = room, from = from, to = to, n = EnvelopeV2Contract.HANDSHAKE_SEQUENCE),
            ct = Crypto.toBase64Url(E2eJson.json.encodeToString(body).toByteArray(Charsets.UTF_8)),
        )
    }

    /** 解开明文帧并要求 `hdr.k` 匹配——收到别的种类属于协议违规，直接报错。 */
    inline fun <reified T> read(envelope: EnvelopeV2, expected: String): T {
        if (envelope.hdr.k != expected) {
            throw Crypto.E2eCryptoException("malformed", "期望 $expected 帧，收到 ${envelope.hdr.k}")
        }
        val raw = Crypto.fromBase64Url(envelope.ct, "${expected}.ct").toString(Charsets.UTF_8)
        return E2eJson.decode(raw, "${expected}.ct")
    }
}
