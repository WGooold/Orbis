package dev.pi.remote

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * ADR-0041：历史分页是「进入顶部区域」的边沿，不是「当前在顶部」的电平。
 *
 * 过去 effect 的 key 里带着 `historyRead.operationId/phase`，每完成一页就重启并重放当前值，
 * 停在顶部时会一页接一页地下载。
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HistoryPagingTest {
    @Test fun `初始就在顶部不请求`() = runTest {
        var index by mutableStateOf(0)
        var blocked by mutableStateOf(false)
        var requests = 0
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            historyPagingRequests({ index }) { blocked }.collect { requests++ }
        }
        runCurrent()
        assertEquals(0, requests)

        // 一页完成、锚点释放：仍在顶部也不自动续页。
        blocked = true; Snapshot.sendApplyNotifications(); runCurrent()
        blocked = false; Snapshot.sendApplyNotifications(); runCurrent()
        assertEquals(0, requests)
    }

    @Test fun `进入顶部区域只触发一次`() = runTest {
        var index by mutableStateOf(20)
        var requests = 0
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            historyPagingRequests({ index }) { false }.collect { requests++ }
        }
        runCurrent()
        assertEquals(0, requests)

        index = 5; Snapshot.sendApplyNotifications(); runCurrent()
        assertEquals(0, requests)
        index = 1; Snapshot.sendApplyNotifications(); runCurrent()
        assertEquals(1, requests)

        // 视口继续停在顶部（甚至到 0）：不重复请求。
        index = 0; Snapshot.sendApplyNotifications(); runCurrent()
        assertEquals(1, requests)
    }

    @Test fun `离开顶部再进入才再次触发`() = runTest {
        var index by mutableStateOf(20)
        var requests = 0
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            historyPagingRequests({ index }) { false }.collect { requests++ }
        }
        runCurrent()
        index = 1; Snapshot.sendApplyNotifications(); runCurrent()
        assertEquals(1, requests)

        index = 8; Snapshot.sendApplyNotifications(); runCurrent()
        index = 1; Snapshot.sendApplyNotifications(); runCurrent()
        assertEquals(2, requests)
    }

    @Test fun `加载中越过顶部不触发，加载结束也不补发`() = runTest {
        var index by mutableStateOf(20)
        var blocked by mutableStateOf(false)
        var requests = 0
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            historyPagingRequests({ index }) { blocked }.collect { requests++ }
        }
        runCurrent()

        blocked = true; Snapshot.sendApplyNotifications(); runCurrent()
        index = 1; Snapshot.sendApplyNotifications(); runCurrent()
        assertEquals(0, requests)

        blocked = false; Snapshot.sendApplyNotifications(); runCurrent()
        assertEquals(0, requests)

        // 重新离开顶部后再进入，才算一次新的用户动作。
        index = 6; Snapshot.sendApplyNotifications(); runCurrent()
        index = 1; Snapshot.sendApplyNotifications(); runCurrent()
        assertEquals(1, requests)
    }
}
