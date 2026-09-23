package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 片层不变量（与 `packages/protocol/src/piece.test.ts` 同一份契约）：
 * **重组逐字节还原**、**小消息不切**、**乱序可拼**、**有界且会超时**。
 */
class EnvelopePiecesTest {
    private fun envelope(ctChars: Int, overrides: RoutingHeaderV2.() -> RoutingHeaderV2 = { this }): EnvelopeV2 {
        val base = RoutingHeaderV2(k = "bin", room = "r1", from = "d1", to = "h1", n = 7, ch = "bulk")
        return EnvelopeV2(
            v = EnvelopeV2Contract.VERSION,
            hdr = base.overrides(),
            // 真实 `ct` 是 base64url（纯 ASCII、不含引号），这里用同字符集填充以保持一致。
            ct = "A".repeat(ctChars),
        )
    }

    @Test
    fun `大信封切成片后能逐字节还原，小消息原样发`() {
        val big = envelope(EnvelopePieces.MAX_CT_CHARS * 3 + 17)
        val pieces = EnvelopePieces.fragment(big, mid = "m1")

        assertEquals(4, pieces.size)
        assertTrue(pieces.all { EnvelopePieces.isPiece(it) })
        assertEquals(true, pieces.last().hdr.last)
        // 片头带路由与 channel：中继不用重组，它只看 hdr。
        val first = pieces.first().hdr
        assertEquals("h1", first.to)
        assertEquals("bulk", first.ch)
        assertEquals("bin", first.ik)
        assertEquals(7L, first.n)
        assertEquals(0, first.idx)
        assertEquals(false, first.last)

        val reassembler = EnvelopeReassembler()
        val rebuilt = pieces.mapNotNull { reassembler.accept(it) }
        assertEquals(listOf(big), rebuilt)
        assertEquals(0, reassembler.bufferedChars)

        // 小消息不切：否则每条控制帧都要多背一个片头。握手帧永远不切。
        val small = envelope(EnvelopePieces.MAX_CT_CHARS)
        assertEquals(listOf(small), EnvelopePieces.fragment(small, mid = "m2"))
        assertEquals(small, reassembler.accept(small))
        val hs = envelope(0, overrides = { copy(k = "hs", ch = null) })
        assertEquals(listOf(hs), EnvelopePieces.fragment(hs, mid = "m3"))
    }

    @Test
    fun `乱序能重组；重传同内容的片幂等；同一个 mid 带不同身份则整条丢弃`() {
        val big = envelope(EnvelopePieces.MAX_CT_CHARS * 2 + 5)
        val pieces = EnvelopePieces.fragment(big, mid = "m1")
        val rejected = mutableListOf<PieceRejection>()
        val reassembler = EnvelopeReassembler(onRejected = { reason, _ -> rejected.add(reason) })

        // 换路径会让片乱序到达：按 idx 存，末片到了且 0..total-1 齐全就交付。
        assertNull(reassembler.accept(pieces[2]))
        assertNull(reassembler.accept(pieces[0]))
        // 发送侧重试过被拒的那一片 → 同一片可能来两次，同内容当无事发生。
        assertNull(reassembler.accept(pieces[0]))
        assertEquals(big, reassembler.accept(pieces[1]))
        assertEquals(emptyList<PieceRejection>(), rejected)

        // 同一个 mid 的片带着别的序号身份：不是同一条消息。
        val second = EnvelopeReassembler(onRejected = { reason, _ -> rejected.add(reason) })
        second.accept(pieces[0])
        second.accept(pieces[1].let { it.copy(hdr = it.hdr.copy(n = 99)) })
        assertEquals(0, second.bufferedChars)
        assertEquals(listOf(PieceRejection.CONFLICT), rejected)
    }

    @Test
    fun `重组缓冲有界：超并发条数或超总字节都丢掉`() {
        val rejected = mutableListOf<PieceRejection>()
        val reassembler = EnvelopeReassembler(maxMessages = 2, onRejected = { reason, _ -> rejected.add(reason) })
        fun piece(mid: String, chars: Int = 100, idx: Int = 0) = envelope(chars, overrides = {
            copy(k = "piece", ik = "bin", mid = mid, idx = idx, last = false)
        })

        reassembler.accept(piece("a"))
        reassembler.accept(piece("b"))
        // 第 3 条超并发上限：丢掉最旧的一条，新的一条仍然进得来（否则一次灌注就能永久占住槽位）。
        reassembler.accept(piece("c"))
        assertEquals(2, reassembler.pendingMessages)
        assertTrue(rejected.contains(PieceRejection.BUDGET))

        // 单条消息自己超过总字节上限：立刻丢，不占着内存等末片。
        val tight = EnvelopeReassembler(maxCtChars = 150, onRejected = { reason, _ -> rejected.add(reason) })
        tight.accept(piece("d"))
        tight.accept(piece("d", chars = 100, idx = 1))
        assertEquals(0, tight.bufferedChars)
    }

    @Test
    fun `缺片不猜：等超时丢掉半截消息，绝不交付半条`() {
        val big = envelope(EnvelopePieces.MAX_CT_CHARS * 2 + 5)
        val pieces = EnvelopePieces.fragment(big, mid = "m1")
        val rejected = mutableListOf<PieceRejection>()
        var now = 1_000L
        val reassembler = EnvelopeReassembler(
            timeoutMs = 5_000,
            onRejected = { reason, _ -> rejected.add(reason) },
        )

        assertNull(reassembler.accept(pieces[0], now))
        assertNull(reassembler.accept(pieces[2], now))
        now += 6_000
        reassembler.sweep(now)
        assertEquals(0, reassembler.bufferedChars)
        assertEquals(listOf(PieceRejection.TIMEOUT), rejected)

        // 迟到的缺片不会让一条已经作废的消息复活：它只是另一条新消息的第一片。
        assertNull(reassembler.accept(pieces[1], now))
        assertEquals(EnvelopePieces.MAX_CT_CHARS, reassembler.bufferedChars)
    }

    @Test
    fun `片帧不能再被切片`() {
        val piece = EnvelopePieces.fragment(envelope(EnvelopePieces.MAX_CT_CHARS * 2), mid = "m1").first()
        assertThrows(IllegalArgumentException::class.java) { EnvelopePieces.fragment(piece) }
    }
}
