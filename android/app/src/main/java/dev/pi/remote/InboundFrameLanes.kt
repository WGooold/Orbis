package dev.pi.remote

import kotlinx.coroutines.channels.Channel

/**
 * 入站帧的两条优先级通道（票 07 的接收侧一半）。
 *
 * **为什么必须拆。** `hdr.ch` 只把**序号**分开了，投递顺序一点没变：所有帧仍然按到达顺序挤在
 * 同一条队列里。而消费侧要落盘，比网络慢得多，于是队列会一路积压——一条控制帧排在这堆分片
 * 后面，用户看到的就是「下载一开，什么都点不动」。序号隔离救不了这个，只有派发顺序能救。
 *
 * **怎么拆。** 消费循环每次回到顶部都先把交互面清空，才去处理**一片**分片。最坏等待因此从
 * 「等完整条积压」降到「等一片落盘」。
 *
 * **顺序上的取舍。** 交互帧之间、分片之间的相对顺序都保持不变；被重排的只有跨类别的先后。
 * 那个方向是安全的，而且更好：`artifact.started` 是交互帧，现在它必然先于依赖它的分片生效
 * （以前靠「同一队列」碰巧成立，一旦积压顺序反过来，先到的分片会因为任务还没登记而被丢掉）。
 */
internal class InboundFrameLanes {
    /** 控制 / 消息面：命令结果、状态、会话同步、协议错误。 */
    private val interactive = Channel<InteractiveFrame>(Channel.UNLIMITED)

    /** 分片面：artifact 裸字节。慢，可以等。 */
    private val bulk = Channel<ByteArray>(Channel.UNLIMITED)

    /** 叫醒信号。合并成一条：积压多少都只需要通知一次。 */
    private val wakeup = Channel<Unit>(Channel.CONFLATED)

    internal data class InteractiveFrame(val payload: String, val channel: String?)

    /**
     * 入队一条载荷。[channel] 是信封头上的逻辑 channel。
     *
     * 类型是 `String?` 只是因为 `RoutingHeaderV2` 与握手帧共用一份定义（`hs`/`pair` 不带
     * `ch`）；加密帧缺 `ch` 在 `E2eChannel.open` 就被拒了（ADR-0008），所以实际取值只有
     * `ctl` / `msg` / `bulk`。
     *
     * 分类**以 channel 为准**，载荷形态只是退路。
     */
    fun offer(payload: String, channel: String?): Boolean {
        val accepted = if (channel == BULK_CHANNEL) {
            // 分片走 `bin` 帧，所以这条分支实际到不了；留着是为了让「按 channel 分类」这件事
            // 在代码里是完整的，而不是靠「实际上不会发生」。
            bulk.trySend(payload.toByteArray(Charsets.UTF_8)).isSuccess
        } else {
            interactive.trySend(InteractiveFrame(payload, channel)).isSuccess
        }
        if (accepted) wakeup.trySend(Unit)
        return accepted
    }

    /** 入队一片裸字节分片（E2E `bin` 帧）。 */
    fun offerBulk(bytes: ByteArray): Boolean {
        val accepted = bulk.trySend(bytes).isSuccess
        if (accepted) wakeup.trySend(Unit)
        return accepted
    }

    fun close() {
        interactive.close()
        bulk.close()
        wakeup.close()
    }

    /** 取一条交互载荷。`null` = 交互面暂时空了。 */
    fun takeInteractive(): InteractiveFrame? = interactive.tryReceive().getOrNull()

    /** 取一片分片。`null` = 暂时没有。 */
    fun takeBulk(): ByteArray? = bulk.tryReceive().getOrNull()

    /** 两面都空时挂起等叫醒。返回 `false` = 通道已关闭，消费循环该收工了。 */
    suspend fun awaitWork(): Boolean = wakeup.receiveCatching().isSuccess

    private companion object {
        const val BULK_CHANNEL = "bulk"
    }
}
