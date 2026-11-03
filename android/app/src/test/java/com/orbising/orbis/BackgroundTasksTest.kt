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
        assertEquals("运行中 · 1 个子任务", runtime.copy(status = "running").presentationTitle)
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
}
