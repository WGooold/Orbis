package dev.pi.remote

/**
 * 管理下载调度与收尾的交接。帧消费线程和定时器可以同时调用；同一传输只允许一个收尾者，
 * 文件校验/发布在锁外执行。空文件与恢复出的完整前缀也走相同的完成入口。
 */
internal class PullDownloads(
    private val read: (transferId: String, requestId: String, offset: Long, length: Int) -> Unit,
    private val finish: (transferId: String) -> Unit,
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private val lock = Any()
    private val schedulers = mutableMapOf<String, PullScheduler>()
    private val completing = mutableSetOf<String>()

    fun sync(tasks: Collection<ArtifactDownload>, interactive: Boolean, connected: Boolean) {
        synchronized(lock) {
            val live = tasks.filter {
                it.transferId != null && it.artifact != null &&
                    it.status in setOf("queued", "downloading", "paused")
            }
            schedulers.keys.retainAll(live.mapNotNull(ArtifactDownload::transferId).toSet())
            for (task in live) {
                val transferId = task.transferId ?: continue
                if (transferId in completing) continue
                val size = task.artifact?.size ?: continue
                val start = task.receivedBytes.coerceIn(0L, size)
                val scheduler = schedulers.getOrPut(transferId) {
                    PullScheduler(size, start, { requestId, offset, length ->
                        read(transferId, requestId, offset, length)
                    }, now)
                }
                scheduler.setInteractive(interactive)
                scheduler.setPaused(!connected)
            }
        }
        tick()
    }

    /** 收到并写入真实存储后的分片；返回 false 表示传输已经不归此处调度。 */
    fun onChunk(transferId: String, offset: Long, length: Int, durableOffset: Long): Boolean {
        synchronized(lock) {
            val scheduler = schedulers[transferId] ?: return false
            scheduler.onChunk(offset, length, durableOffset)
            scheduler.tick()
        }
        complete(transferId)
        return true
    }

    private fun tick() {
        val completed = synchronized(lock) {
            schedulers.mapNotNull { (transferId, scheduler) ->
                scheduler.tick()
                transferId.takeIf { scheduler.complete }
            }
        }
        completed.forEach(::complete)
    }

    private fun complete(transferId: String) {
        synchronized(lock) {
            if (schedulers[transferId]?.complete != true || !completing.add(transferId)) return
            schedulers.remove(transferId)
        }
        try {
            finish(transferId)
        } finally {
            synchronized(lock) { completing.remove(transferId) }
        }
    }
}
