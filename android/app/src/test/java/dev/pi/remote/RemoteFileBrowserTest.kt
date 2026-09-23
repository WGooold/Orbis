package dev.pi.remote

import org.junit.Assert.*
import org.junit.Test

class RemoteFileBrowserTest {
    @Test
    fun `browser joins computer paths independently of Android separators`() {
        assertEquals("D:\\", remoteBrowsePath(null, "D:\\"))
        assertEquals("/", remoteBrowsePath("", "/"))
        assertEquals("D:\\应用 v1.apk", remoteBrowsePath("D:\\", "应用 v1.apk"))
        assertEquals("D:\\build output\\应用 v1.apk", remoteBrowsePath("D:\\build output", "应用 v1.apk"))
        assertEquals("D:/build output/app.apk", remoteBrowsePath("D:/build output", "app.apk"))
        assertEquals("/report.txt", remoteBrowsePath("/", "report.txt"))
        assertEquals("/home/user/report.txt", remoteBrowsePath("/home/user", "report.txt"))
        assertEquals("\\\\server\\share\\report.txt", remoteBrowsePath("\\\\server\\share", "report.txt"))
    }

    @Test
    fun `file browse keeps folders first and rejects stale responses after navigation or dismissal`() {
        val reducer = RelayReducer()
        val state = RemoteState(sessionBrowse = SessionBrowseState("current", error = "previous error"))
        val response = """{"type":"session.browse.result","requestId":"current","path":"D:\\build","parent":"D:\\",
            "entries":[{"name":"a.apk","isDir":false,"hasSessions":false},
            {"name":"z","isDir":true,"hasSessions":false},
            {"name":"work","isDir":true,"hasSessions":true}]}"""
        val updated = reducer.reduce(state, response).sessionBrowse!!
        assertEquals(listOf("work", "z", "a.apk"), updated.entries.map { it.name })
        assertFalse(updated.isLoading)
        assertNull(updated.error)
        assertFalse(updated.entries.last().isDir)
        val navigating = state.copy(sessionBrowse = SessionBrowseState("next"))
        assertEquals(navigating, reducer.reduce(navigating, response))
        val dismissed = state.copy(sessionBrowse = null)
        assertEquals(dismissed, reducer.reduce(dismissed, response))
    }

    @Test
    fun `browse failures stop loading and stay in the selector for retry`() {
        val state = RemoteState(sessionBrowse = SessionBrowseState("read", path = "D:\\unreadable"))
        val result = RelayReducer().reduce(state,
            """{"type":"protocol.error","requestId":"read","code":"session_request_failed","message":"没有权限读取目录"}""")
        assertFalse(result.sessionBrowse!!.isLoading)
        assertEquals("没有权限读取目录", result.sessionBrowse.error)
        assertNull(result.error)
    }
}
