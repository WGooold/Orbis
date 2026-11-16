// Orbis 测试用途（场景与判定见本文件断言）：
// - Claude 后台子任务（S26、S17、S20、V05、V12、V16、V18、M03、M06、M10、M20）
// - 子代理与后台命令分组、命令不使会话呈现工作中（S60 / SC108）
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
        assertEquals("1 个子代理运行中", runtime.presentationTitle)
        assertFalse(runtime.allowsRemoteClose(listOf(quit)))
        assertEquals("运行中 1 个子代理", runtime.copy(status = "running").presentationTitle)
        assertEquals("waiting_local_interaction", runtime.copy(status = "waiting_local_interaction").presentationStatus)
        runtime = runtime.copy(backgroundTasks = tasks("completed"))
        assertEquals("空闲", runtime.presentationTitle)
        assertTrue(runtime.allowsRemoteClose(listOf(quit)))
        assertFalse(runtime.allowsRemoteClose(emptyList()))
    }
    @Test fun unknownAndIncompleteInventoryNeverProvesIdleOrClosure() {
        assertEquals("后台任务状态待核对", tasks(availability = "unknown").activityTitle)
        assertFalse(tasks(availability = "unknown").allowsQuit)
        assertFalse(tasks("unknown").confirmed)
        assertFalse(tasks("completed").copy(truncated = true).valid)
        assertFalse(tasks("completed").copy(truncated = true).allowsQuit)
        assertFalse(tasks().copy(items = tasks().items + tasks().items).valid)
    }
    @Test fun pendingAndWaitingAreNotReportedAsRunning() {
        assertEquals("1 个子代理启动中", tasks("pending").activityTitle)
        assertEquals("1 个子代理等待中", tasks("waiting").activityTitle)
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
        assertEquals("后台任务状态待核对", stale.activityTitle)
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

    // S59 / SC107: the tree view must list every task exactly once — partial parents, self-references and
    // cycles (not rejected by `valid`) would otherwise hide rows or recurse — and keep Host order among siblings.
    @Test fun taskTreeKeepsEveryTaskOnceInHostOrder() {
        fun task(id: String, parent: String? = null) = BackgroundTask(id, id, "agent", "running", parent)
        val inventory = BackgroundTaskInventory("unknown", listOf(
            task("b2", "a"), task("a"), task("orphan", "gone"), task("b1", "a"), task("c", "b2"),
            task("self", "self"), task("x", "y"), task("y", "x"), task("d1", "c"), task("d2", "d1")), true)
        assertTrue(inventory.valid)
        val rows = inventory.treeRows()
        assertEquals(listOf("a", "b2", "c", "d1", "d2", "b1", "orphan", "self", "x", "y"), rows.map { it.task.id })
        assertEquals(listOf(0, 1, 2, 3, 3, 1, 0, 0, 0, 1), rows.map { it.depth })
        val byId = rows.associateBy { it.task.id }
        assertFalse(byId.getValue("b2").last)
        assertTrue(byId.getValue("b1").last)
        // b2 has a later sibling, so its branch line continues past its descendants.
        assertEquals(listOf(true), byId.getValue("c").rails)
        // Indent stops at the cap: d2 stays level with d1, which draws no child stem and keeps its branch open for d2.
        assertFalse(byId.getValue("d1").hasChildren)
        assertFalse(byId.getValue("d1").last)
        assertTrue(byId.getValue("d2").last)
        assertTrue(byId.getValue("a").hasChildren)
        assertEquals(listOf(true, false), byId.getValue("d2").rails)
    }

    // S59 / SC107: panel dots must not show work that the session status has withdrawn (ADR-0068 §3).
    @Test fun taskDotsFollowInventoryCertainty() {
        val live = TaskDotStyle(TaskDotTone.Working, pulsing = true)
        val withdrawn = TaskDotStyle(TaskDotTone.Quiet, hollow = true)
        val ready = tasks()
        assertEquals(live, ready.summaryDot)
        assertEquals(live, ready.dotFor(ready.items.single()))
        val stale = tasks(availability = "unknown")
        assertEquals("tasks_unknown", RuntimeSummary("r", "Agent", "/repo", "idle", backgroundTasks = stale).presentationStatus)
        assertEquals(withdrawn, stale.summaryDot)
        assertEquals(withdrawn, stale.dotFor(stale.items.single()))
        val partial = stale.copy(truncated = true)
        assertEquals("background", RuntimeSummary("r", "Agent", "/repo", "idle", backgroundTasks = partial).presentationStatus)
        assertEquals(live, partial.summaryDot)
        assertEquals(live, partial.dotFor(partial.items.single()))
        assertEquals(withdrawn, tasks("completed", "unknown").copy(truncated = true).summaryDot)
        assertEquals(TaskDotStyle(TaskDotTone.Working), tasks("waiting").dotFor(tasks("waiting").items.single()))
        assertEquals(TaskDotStyle(TaskDotTone.Failed), tasks("failed").summaryDot)
        assertEquals(TaskDotStyle(TaskDotTone.Quiet), tasks("completed").summaryDot)
        assertEquals(withdrawn, tasks("killed").dotFor(tasks("killed").items.single()))
    }

    // S60 / SC108: commands never borrow the agents' wording or their pulsing "working" look, and a
    // command an agent started stays in that agent's branch instead of the session's own commands.
    @Test fun commandsAreGroupedApartFromAgentsAndLeaveTheSessionIdle() {
        val inventory = BackgroundTaskInventory("ready", listOf(
            BackgroundTask("agent", "检查代码", "Explore", "running"),
            BackgroundTask("agent-shell", "跑单测", "shell", "running", "agent"),
            BackgroundTask("dev", "启动开发服务器", "shell", "running"),
            BackgroundTask("watch", "", "monitor", "running")), false)
        assertEquals("子代理 1 · 后台命令 3", inventory.panelTitle)
        val (agents, commands) = inventory.groupedRows()
        assertEquals(listOf("agent", "agent-shell"), agents.map { it.task.id })
        assertEquals(listOf(0, 1), agents.map { it.depth })
        assertEquals(listOf("dev", "watch"), commands.map { it.task.id })
        val watch = inventory.items[3]
        assertEquals("监听", watch.displayTitle)
        assertFalse(watch.showsKind)
        assertEquals("命令", inventory.items[2].kindTitle)
        assertEquals(TaskDotStyle(TaskDotTone.Working), inventory.dotFor(inventory.items[2]))
        assertEquals(TaskDotStyle(TaskDotTone.Working, pulsing = true), inventory.dotFor(inventory.items[0]))
        var runtime = RuntimeSummary("r", "Claude", "/repo", "idle", backgroundTasks = inventory)
        assertEquals("background", runtime.presentationStatus)
        assertEquals("1 个子代理运行中 · 3 个后台命令", runtime.presentationTitle)

        val only = BackgroundTaskInventory("ready", listOf(inventory.items[2]), false)
        runtime = runtime.copy(backgroundTasks = only)
        assertEquals("后台命令 1 项", only.panelTitle)
        assertEquals(TaskDotStyle(TaskDotTone.Working), only.summaryDot)
        assertEquals("background_commands", runtime.presentationStatus)
        assertEquals("空闲 · 1 个后台命令", runtime.presentationTitle)
        assertFalse(runtime.allowsRemoteClose(listOf(quit)))
        assertEquals("运行中 1 个后台命令", runtime.copy(status = "running").presentationTitle)
        runtime = runtime.copy(backgroundTasks = BackgroundTaskInventory("unknown", only.items, true))
        assertEquals("background_commands", runtime.presentationStatus)
        assertEquals("空闲 · 1 个后台命令（清单不完整）", runtime.presentationTitle)
    }
}
