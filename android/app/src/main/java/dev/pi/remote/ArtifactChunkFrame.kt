package dev.pi.remote

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction

/**
 * 分片帧头第 4 字节的版本号。
 *
 * **必须是 `PROTOCOL_VERSION`，不能自己维护一个字面量。** 这个帧是裸字节格式，没有 schema
 * 兜底：TS 侧（`packages/protocol/src/index.ts` 的 `encodeArtifactChunkFrame`）读写的就是
 * `PROTOCOL_VERSION`。这里曾经写死 `3`，和常量一起停留在旧值——手机封 3、电脑解 4，
 * 上传的每一片都被判「版本不兼容」，而单侧测试又把 3 写成期望值，于是漂移一直没人发现。
 */
private const val ARTIFACT_FRAME_KIND_CHUNK = 1
private const val ARTIFACT_FRAME_HEADER_BYTES = 24
private const val MAX_RUNTIME_ID_BYTES = 256
private const val MAX_TRANSFER_ID_BYTES = 256
internal const val ARTIFACT_CHUNK_BYTES = 1024 * 1024

internal data class ArtifactChunkFrame(
    val runtimeId: String,
    val transferId: String,
    val offset: Long,
    val data: ByteArray,
)

/**
 * 封一片上传分片。与 [decodeArtifactChunkFrame] 同一套帧格式，只是方向相反：
 * 下载是 Host 封、手机解，上传反过来。
 */
internal fun encodeArtifactChunkFrame(
    runtimeId: String,
    transferId: String,
    offset: Long,
    data: ByteArray,
): ByteArray {
    val runtimeIdBytes = runtimeId.toByteArray(Charsets.UTF_8)
    val transferIdBytes = transferId.toByteArray(Charsets.UTF_8)
    require(runtimeId.isNotBlank() && runtimeIdBytes.size <= MAX_RUNTIME_ID_BYTES) { "上传运行实例标识无效" }
    require(transferId.isNotBlank() && transferIdBytes.size <= MAX_TRANSFER_ID_BYTES) { "上传传输标识无效" }
    require(offset >= 0) { "上传分片偏移无效" }
    require(data.size in 1..ARTIFACT_CHUNK_BYTES) { "上传分片长度无效" }
    val output = ByteArray(ARTIFACT_FRAME_HEADER_BYTES + runtimeIdBytes.size + transferIdBytes.size + data.size)
    output[0] = 'P'.code.toByte()
    output[1] = 'I'.code.toByte()
    output[2] = 'R'.code.toByte()
    output[3] = '3'.code.toByte()
    val buffer = ByteBuffer.wrap(output).order(ByteOrder.BIG_ENDIAN)
    buffer.put(4, PROTOCOL_VERSION.toByte())
    buffer.put(5, ARTIFACT_FRAME_KIND_CHUNK.toByte())
    buffer.putShort(6, runtimeIdBytes.size.toShort())
    buffer.putShort(8, transferIdBytes.size.toShort())
    buffer.putShort(10, 0)
    buffer.putLong(12, offset)
    buffer.putInt(20, data.size)
    runtimeIdBytes.copyInto(output, ARTIFACT_FRAME_HEADER_BYTES)
    transferIdBytes.copyInto(output, ARTIFACT_FRAME_HEADER_BYTES + runtimeIdBytes.size)
    data.copyInto(output, ARTIFACT_FRAME_HEADER_BYTES + runtimeIdBytes.size + transferIdBytes.size)
    return output
}

internal fun decodeArtifactChunkFrame(bytes: ByteArray): ArtifactChunkFrame {
    if (bytes.size < ARTIFACT_FRAME_HEADER_BYTES) error("二进制下载分片无效")
    if (bytes[0] != 'P'.code.toByte() || bytes[1] != 'I'.code.toByte() ||
        bytes[2] != 'R'.code.toByte() || bytes[3] != '3'.code.toByte()
    ) {
        error("二进制下载分片无效")
    }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    if (buffer.get(4).toInt() != PROTOCOL_VERSION || buffer.get(5).toInt() != ARTIFACT_FRAME_KIND_CHUNK) {
        error("二进制下载分片版本不兼容")
    }
    val runtimeIdLength = buffer.getShort(6).toInt() and 0xffff
    val transferIdLength = buffer.getShort(8).toInt() and 0xffff
    if (buffer.getShort(10).toInt() != 0) error("二进制下载分片无效")
    val offset = buffer.getLong(12)
    val payloadLength = buffer.getInt(20)
    val transferIdStart = ARTIFACT_FRAME_HEADER_BYTES + runtimeIdLength
    val payloadStart = transferIdStart + transferIdLength
    if (runtimeIdLength !in 1..MAX_RUNTIME_ID_BYTES || transferIdLength !in 1..MAX_TRANSFER_ID_BYTES || offset < 0 ||
        payloadLength !in 1..ARTIFACT_CHUNK_BYTES ||
        payloadStart < ARTIFACT_FRAME_HEADER_BYTES || payloadStart + payloadLength != bytes.size
    ) {
        error("二进制下载分片无效")
    }
    val runtimeId = bytes.copyOfRange(ARTIFACT_FRAME_HEADER_BYTES, transferIdStart)
        .toString(Charsets.UTF_8)
    val transferId = bytes.copyOfRange(transferIdStart, payloadStart)
        .toString(Charsets.UTF_8)
    if (runtimeId.isBlank()) error("二进制下载运行实例标识无效")
    if (transferId.isBlank()) error("二进制下载传输标识无效")
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    val decodedRuntimeId = decoder.decode(ByteBuffer.wrap(bytes, ARTIFACT_FRAME_HEADER_BYTES, runtimeIdLength)).toString()
    val decodedTransferId = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes, transferIdStart, transferIdLength))
        .toString()
    if (decodedRuntimeId != runtimeId) error("二进制下载运行实例标识无效")
    if (decodedTransferId != transferId) error("二进制下载传输标识无效")
    return ArtifactChunkFrame(
        runtimeId = runtimeId,
        transferId = transferId,
        offset = offset,
        data = bytes.copyOfRange(payloadStart, bytes.size),
    )
}
