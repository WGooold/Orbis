// Orbis 测试用途（场景与判定见本文件断言）：
// - Claude 后台子任务（S26、S17、S20、V05、V12、V16、V18、M03、M06、M10、M20）
package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

class BackgroundTasksTest {
    private val quit = RuntimeSlashCommand(name = "quit", source = "builtin")
    private fun tasks(status: String = "running", availability: String = "ready") = BackgroundTaskInventory(availability,
        listOf(BackgroundTask("child", "检查代码", "Explore", status)), false)

    @Test fun mainInputStaysIdleWhileBackgroundWorkIsVisibleAndQuitIsBlocked() {
        var runtime = RuntimeSummary("r", "Claude", "/repo", "idle", backgroundTasks = tasks())
        assertEquals("idle", runtime.status)
        assertEquals("background", runtime.presentationStatus)
        assertEquals("1 个子任务运行中", runtime.presentationTitle)
        assertFalse(runtime.allowsRemoteClose(listOf(quit)))
        assertEquals("运行中 1 个子任务", runtime.copy(status = "running").presentationTitle)
        assertEquals("waiting_local_interaction", runtime.copy(status = "waiting_local_interaction").presentationStatus)
        runtime = runtime.copy(backgroundTasks = tasks("completed"))
        assertEquals("空闲", runtime.presentationTitle)
        assertTrue(runtime.allowsRemoteClose(listOf(quit)))
        assertFalse(runtime.allowsRemoteClose(emptyList()))
    }
    @Test fun unknownAndIncompleteInventoryNeverProvesIdleOrClosure() {
        assertEquals("子任务状态待核对", tasks(availability = "unknown").activityTitle)
        assertFalse(tasks(availability = "unknown").allowsQuit)
        assertFalse(tasks("unknown").confirmed)
        assertFalse(tasks("completed").copy(truncated = true).valid)
        assertFalse(tasks("completed").copy(truncated = true).allowsQuit)
        assertFalse(tasks().copy(items = tasks().items + tasks().items).valid)
    }
    @Test fun pendingAndWaitingAreNotReportedAsRunning() {
        assertEquals("1 个子任务启动中", tasks("pending").activityTitle)
        assertEquals("1 个子任务等待中", tasks("waiting").activityTitle)
        assertNull(tasks("idle").activityTitle)
    }

    // S33 / SC52: all Agent kinds reuse the same local, read-only task presentation.
    @Test fun genericSubagentLabelsAndPartialInventoryKeepKnownWorkVisible() {
        val labels = mapOf("pending" to "启动中", "running" to "工作中", "waiting" to "等待", "idle" to "空闲",
            "completed" to "完成", "failed" to "失败", "killed" to "已停止", "unknown" to "未知")
        labels.forEach { (status, title) -> assertEquals(title, tasks(status).items.single().statusTitle) }
        val previous = tasks().copy(items = tasks().items + BackgroundTask("retained", "已有任务", "agent", "running"))
        val partial = BackgroundTaskInventory("unknown", listOf(
            BackgroundTask("child", "代码检查", "agent", "completed"),
            BackgroundTask("next", "等待检查", "agent", "waiting", "child")), true).reconciled(previous)
        assertTrue(partial.valid)
        assertEquals(listOf("child", "retained", "next"), partial.items.map { it.id })
        assertEquals(listOf("完成", "工作中", "等待"), partial.items.map { it.statusTitle })
        assertEquals("child", partial.items.last().parentId)
        assertEquals("子代理 3 项（清单不完整）", partial.panelTitle)
        assertEquals("清单不完整，显示已知任务", partial.inventoryNotice)
        assertFalse(partial.confirmed)
        assertFalse(partial.allowsQuit)
        listOf("pi", "codex", "codexDesktop", "claude", "deepseek").forEach { kind ->
            val runtime = RuntimeSummary("r", "Agent", "/repo", "idle", agentKind = kind, backgroundTasks = partial)
            assertEquals("idle", runtime.status)
            assertEquals("background", runtime.presentationStatus)
            assertEquals("1 个子代理工作中、1 个子代理等待（清单不完整）", runtime.presentationTitle)
            assertEquals("运行中 1 个子代理工作中、1 个子代理等待（清单不完整）", runtime.copy(status = "running").presentationTitle)
            assertFalse(runtime.allowsRemoteClose(listOf(quit)))
        }
        val stale = tasks("failed", "unknown").reconciled(partial)
        assertEquals(partial.items, stale.items)
        assertFalse(stale.truncated)
        assertEquals("子任务状态待核对", stale.activityTitle)
        assertEquals("子代理 3 项（状态待核对）", stale.panelTitle)
        assertEquals("状态待核对，显示最后已知信息", stale.inventoryNotice)
        assertEquals("子代理 1 项", tasks("completed").panelTitle)
        assertNull(tasks("completed").inventoryNotice)
        assertTrue(tasks("completed").reconciled(partial).confirmed)
    }

    // Keep the bounded display inventory valid when disjoint partial observations accumulate.
    @Test fun partialInventoryPrioritizesIncomingRowsAtTheDisplayLimit() {
        val previous = BackgroundTaskInventory("ready", (0 until 256).map {
            BackgroundTask("old-$it", "已有任务", "agent", "running") }, false)
        val incoming = tasks("failed", "unknown").copy(truncated = true)
        val merged = incoming.reconciled(previous)
        assertTrue(merged.valid)
        assertEquals(256, merged.items.size)
        assertEquals("failed", merged.items.single { it.id == "child" }.status)
    }

    // Unsupported / never-observed task sources must not turn ordinary idle sessions into unknown tasks.
    @Test fun firstUnknownEmptyInventoryDoesNotShowAWarningOrChangeMainPresentation() {
        val inventory = BackgroundTaskInventory("unknown", emptyList(), false)
        assertTrue(inventory.valid)
        assertFalse(inventory.visible)
        assertNull(inventory.activityTitle)
        val runtime = RuntimeSummary("r", "Agent", "/repo", "idle", backgroundTasks = inventory)
        assertEquals("idle", runtime.presentationStatus)
        assertEquals("空闲", runtime.presentationTitle)
        // No task evidence must not veto the backend's native quit capability.
        assertTrue(runtime.allowsRemoteClose(listOf(quit)))
        assertFalse(runtime.allowsRemoteClose(emptyList()))
        assertEquals("运行中", runtime.copy(status = "running").presentationTitle)
        assertTrue(inventory.copy(truncated = true).visible)
    }
}
