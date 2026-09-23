package dev.pi.remote

import java.security.SecureRandom

/**
 * 写入层切片：把一条**已封好的信封**切成小片交给 socket（issue 03）。
 *
 * 与 `packages/protocol/src/piece.ts` 是同一套语义，两端必须逐条对齐：
 *
 * - 一条 `bin` 信封的 `ct` 约 1.34 MB，一次写进 socket 就把出站水位（`bulk` 64 KiB /
 *   `msg` 1 MiB）同时跨过，闸门关死到它被链路排空——弱链路上控制帧要等秒级。
 *   把"一次交付给 socket 的量"降到几 KB，水位就重新变成节拍器。
 * - 切的是 `ct`（base64url，纯 ASCII）：片载荷在 JSON 里不需要任何转义，重组就是字符串拼接。
 * - 片仍是 `v2.frame`，`hdr.k = "piece"`，`hdr` 里带 `to`/`ch` 供中继路由与排队；
 *   `ik`/`n` 是**原信封**的 kind 与序号，重组时原样放回去。
 * - 小消息不切：否则每条控制帧都多背一个片头。
 *
 * **电话侧也要切**：上传分片与命令同样可能很大，而且 Host 侧的重组只认片。
 */
object EnvelopePieces {
    /** 一片能装多少 `ct` 字符。判据与取值见 `docs/adr/0010-write-layer-slicing.md`。 */
    const val MAX_CT_CHARS = 8 * 1024

    /** 同时重组的消息条数上限。 */
    const val MAX_MESSAGES = 4

    /** 重组缓冲的总上限（`ct` 字符数 ≈ 线上字节数）。 */
    const val MAX_CT_CHARS_TOTAL = 32 * 1024 * 1024

    /** 一条消息从首片到末片的最长等待。 */
    const val TIMEOUT_MS = 60_000L

    /** 只有加密帧会被切片：`hs`/`pair` 是握手帧，本来就很小，而且不走加密流。 */
    private val FRAGMENTABLE = setOf("data", "bin", "ping")

    private val random = SecureRandom()

    fun isPiece(envelope: EnvelopeV2): Boolean = envelope.hdr.k == "piece"

    /** 随机 `mid`：可打印 ASCII、不含空格（与协议的 `OpaqueIdSchema` 同一约束）。 */
    fun newMid(): String {
        val bytes = ByteArray(12)
        random.nextBytes(bytes)
        return Crypto.toBase64Url(bytes)
    }

    /**
     * 把一条信封切成片。小消息**原样返回**（不切）。
     *
     * 与 TS 侧一致：`ct` 不超过上限就不切；握手帧永远不切。
     */
    fun fragment(envelope: EnvelopeV2, mid: String = newMid()): List<EnvelopeV2> {
        require(!isPiece(envelope)) { "片帧不能再被切片" }
        if (envelope.hdr.k !in FRAGMENTABLE) return listOf(envelope)
        val channel = envelope.hdr.ch ?: error("加密帧 ${envelope.hdr.k} 缺少 hdr.ch，无法判断它的 channel")
        val ct = envelope.ct
        if (ct.length <= MAX_CT_CHARS) return listOf(envelope)

        val total = (ct.length + MAX_CT_CHARS - 1) / MAX_CT_CHARS
        return (0 until total).map { index ->
            EnvelopeV2(
                v = envelope.v,
                hdr = RoutingHeaderV2(
                    k = "piece",
                    room = envelope.hdr.room,
                    from = envelope.hdr.from,
                    to = envelope.hdr.to,
                    // 原信封的序号：重组后要原样放回去，AAD 与 nonce 都由它算出。
                    n = envelope.hdr.n,
                    ch = channel,
                    ik = envelope.hdr.k,
                    mid = mid,
                    idx = index,
                    last = index == total - 1,
                ),
                ct = ct.substring(index * MAX_CT_CHARS, minOf((index + 1) * MAX_CT_CHARS, ct.length)),
            )
        }
    }
}

/** 片层丢弃一条未完成消息的原因。 */
enum class PieceRejection { CONFLICT, BUDGET, TIMEOUT }

private class PartialMessage(
    val innerKind: String,
    val channel: String,
    val room: String,
    val from: String,
    val to: String,
    val n: Long,
) {
    /** 已收到的片：`idx` → 该片。乱序到达也能接住（换路径时会出现）。 */
    val parts = HashMap<Int, String>()
    var receivedChars = 0
    /** 已经知道的总片数（收到末片时确定）。 */
    var total: Int? = null
    var lastSeenAt: Long = 0
}

/**
 * 把片拼回信封。**只拼，不判合法性**：拼出来的信封照旧要过 `E2eChannel.open()`，
 * 序号、AEAD 标签、`ch` 都在那里查——这里多判一次只会制造第二份真相。
 *
 * 位置无关：片按 `idx` 存，收到末片时若 `0..total-1` 齐全就交付，否则继续等（缺片等超时）。
 * 超时/越界丢掉整条，且丢是安全的：接收侧只查高水位线，丢掉的那条 `n` 之后的帧照常接收，
 * 半条消息不会毒化任何 channel。丢 `ctl`/`msg` 的应用层后果由各自上层兜底（交互超时、
 * 会话同步），bulk 由 offset 幂等吸收。
 */
class EnvelopeReassembler(
    private val maxMessages: Int = EnvelopePieces.MAX_MESSAGES,
    private val maxCtChars: Int = EnvelopePieces.MAX_CT_CHARS_TOTAL,
    private val timeoutMs: Long = EnvelopePieces.TIMEOUT_MS,
    private val onRejected: ((PieceRejection, String) -> Unit)? = null,
) {
    private val partials = HashMap<String, PartialMessage>()
    private var buffered = 0

    val bufferedChars: Int get() = buffered
    val pendingMessages: Int get() = partials.size

    /** 会话重置（重新握手）时调用：旧的半截消息与新会话无关。 */
    fun clear() {
        partials.clear()
        buffered = 0
    }

    /**
     * 收一片。返回重组完成的信封，或 `null`（还没齐）。
     * 非片帧直接原样返回——调用方可以对任何信封都先过这里一遍。
     */
    fun accept(envelope: EnvelopeV2, now: Long = System.currentTimeMillis()): EnvelopeV2? {
        if (!EnvelopePieces.isPiece(envelope)) return envelope
        sweep(now)

        val hdr = envelope.hdr
        val mid = hdr.mid ?: return null
        val idx = hdr.idx ?: return null
        val last = hdr.last ?: return null
        val innerKind = hdr.ik ?: return null
        val channel = hdr.ch ?: return null
        val key = "${hdr.from}\u0000$mid"

        val existing = partials[key]
        if (existing == null) {
            if (buffered + envelope.ct.length > maxCtChars) {
                onRejected?.invoke(PieceRejection.BUDGET, mid)
                return null
            }
            if (partials.size >= maxMessages) {
                // 超并发上限：丢掉最旧的一条，否则一次灌注就能永久占住槽位。
                evictOldest()
                if (partials.size >= maxMessages) return null
            }
            partials[key] = PartialMessage(
                innerKind = innerKind,
                channel = channel,
                room = hdr.room,
                from = hdr.from,
                to = hdr.to,
                n = hdr.n,
            )
        }
        val partial = partials[key] ?: return null
        if (
            partial.room != hdr.room || partial.to != hdr.to || partial.n != hdr.n ||
            partial.innerKind != innerKind || partial.channel != channel
        ) {
            // 同一个 mid 却带着不同的信封身份：不是同一条消息，整条丢弃（重放或 bug）。
            drop(key, PieceRejection.CONFLICT, mid)
            return null
        }

        partial.lastSeenAt = now
        val known = partial.parts[idx]
        if (known != null) {
            // 重传（发送侧重试了被拒的那一片）：同内容当无事发生，不同内容说明身份冲突。
            if (known == envelope.ct) return finishIfComplete(key, partial)
            drop(key, PieceRejection.CONFLICT, mid)
            return null
        }
        partial.parts[idx] = envelope.ct
        partial.receivedChars += envelope.ct.length
        buffered += envelope.ct.length
        if (last) partial.total = idx + 1
        if (partial.receivedChars > maxCtChars) {
            drop(key, PieceRejection.BUDGET, mid)
            return null
        }
        return finishIfComplete(key, partial)
    }

    /** 丢掉超时的半截消息。调用方可以挂在定时器上；`accept` 每次也会顺手扫一遍。 */
    fun sweep(now: Long = System.currentTimeMillis()) {
        val expired = partials.filterValues { now - it.lastSeenAt >= timeoutMs }.keys.toList()
        for (key in expired) drop(key, PieceRejection.TIMEOUT, key.substringAfter('\u0000'))
    }

    private fun evictOldest() {
        val oldest = partials.minByOrNull { it.value.lastSeenAt } ?: return
        drop(oldest.key, PieceRejection.BUDGET, oldest.key.substringAfter('\u0000'))
    }

    private fun finishIfComplete(key: String, partial: PartialMessage): EnvelopeV2? {
        val total = partial.total ?: return null
        if (partial.parts.size != total) return null
        val builder = StringBuilder()
        for (index in 0 until total) {
            val slice = partial.parts[index] ?: return null
            builder.append(slice)
        }
        partials.remove(key)
        buffered -= partial.receivedChars
        return EnvelopeV2(
            v = EnvelopeV2Contract.VERSION,
            hdr = RoutingHeaderV2(
                k = partial.innerKind,
                room = partial.room,
                from = partial.from,
                to = partial.to,
                n = partial.n,
                ch = partial.channel,
            ),
            ct = builder.toString(),
        )
    }

    private fun drop(key: String, reason: PieceRejection, mid: String) {
        val partial = partials.remove(key) ?: return
        buffered -= partial.receivedChars
        onRejected?.invoke(reason, mid)
    }
}
