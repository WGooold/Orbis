package dev.pi.remote

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ArtifactChunkFrameTest {
    /**
     * 版本字节是**跨语言契约**，两侧必须同时改：TS 侧 `encodeArtifactChunkFrame` /
     * `decodeArtifactChunkFrame`（`packages/protocol/src/index.ts`）用的就是 `PROTOCOL_VERSION`。
     *
     * 这里曾经把 `3` 写死进断言，手机侧也是写死的 `3`，而 TS 侧已经跟着协议升到 4——于是
     * 手机封的每一片都被电脑判「版本不兼容」，而单侧测试全绿，没有任何信号。
     */
    @Test
    fun `version byte must be the shared protocol version`() {
        val encoded = encodeArtifactChunkFrame("runtime-a", "transfer-1", 0L, byteArrayOf(9))
        assertEquals(PROTOCOL_VERSION.toByte(), encoded[4])

        // 旧版本的帧必须被拒，不能悄悄按现格式解下去。
        val stale = encoded.copyOf()
        stale[4] = (PROTOCOL_VERSION - 1).toByte()
        assertThrows(IllegalStateException::class.java) { decodeArtifactChunkFrame(stale) }
    }

    @Test
    fun `decodes a frame with runtime and transfer identity`() {
        val runtimeId = "runtime-a".toByteArray(Charsets.UTF_8)
        val transferId = "transfer-1".toByteArray(Charsets.UTF_8)
        val payload = byteArrayOf(1, 2, 3)
        val bytes = ByteBuffer.allocate(24 + runtimeId.size + transferId.size + payload.size)
            .order(ByteOrder.BIG_ENDIAN)
            .apply {
                put(byteArrayOf('P'.code.toByte(), 'I'.code.toByte(), 'R'.code.toByte(), '3'.code.toByte()))
                put(PROTOCOL_VERSION.toByte())
                put(1)
                putShort(runtimeId.size.toShort())
                putShort(transferId.size.toShort())
                putShort(0)
                putLong(7)
                putInt(payload.size)
                put(runtimeId)
                put(transferId)
                put(payload)
            }
            .array()

        val frame = decodeArtifactChunkFrame(bytes)

        assertEquals("runtime-a", frame.runtimeId)
        assertEquals("transfer-1", frame.transferId)
        assertEquals(7L, frame.offset)
        assertEquals(payload.toList(), frame.data.toList())
    }

    @Test
    fun `rejects malformed frame headers and payload lengths`() {
        val malformed = ByteArray(24)
        assertThrows(IllegalStateException::class.java) { decodeArtifactChunkFrame(malformed) }

        val invalidLength = ByteBuffer.allocate(24 + 1 + 1)
            .order(ByteOrder.BIG_ENDIAN)
            .apply {
                put(byteArrayOf('P'.code.toByte(), 'I'.code.toByte(), 'R'.code.toByte(), '3'.code.toByte()))
                put(PROTOCOL_VERSION.toByte())
                put(1)
                putShort(1)
                putShort(1)
                putShort(0)
                putLong(0)
                putInt(2)
                put('r'.code.toByte())
                put('t'.code.toByte())
            }
            .array()
        assertThrows(IllegalStateException::class.java) { decodeArtifactChunkFrame(invalidLength) }
    }
}
