package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 落地目录的拼接。看着琐碎，但拼错了是「传完了但落在奇怪的地方」——
 * 用户只能去电脑上翻目录，而这正是他不想做的事。
 *
 * 目录带 sha256 段是重名问题的解：发送端不知道电脑上已有什么，同名不同内容的两次上传
 * 必须落在不同目录，路径引用才无歧义；内容相同 = sha256 相同 = 同一目录，与续传语义一致。
 */
class UploadDirectoryTest {

    private val backslash = "\\"
    private val windowsCwd = "D:${backslash}proj"
    private val sha = "a".repeat(64)

    @Test
    fun `uses the separator of the session cwd`() {
        assertEquals(
            "D:${backslash}proj${backslash}.pi-remote-uploads${backslash}$sha",
            uploadDirectoryFor(windowsCwd, sha),
        )
        assertEquals(
            "/home/me/proj/.pi-remote-uploads/$sha",
            uploadDirectoryFor("/home/me/proj", sha),
        )
        // 顶层目录不能拼成双斜杠
        assertEquals("D:${backslash}.pi-remote-uploads${backslash}$sha", uploadDirectoryFor("D:$backslash", sha))
        assertEquals("/.pi-remote-uploads/$sha", uploadDirectoryFor("/", sha))
    }

    @Test
    fun `same content shares the directory, different content does not`() {
        val other = "b".repeat(64)
        assertEquals(uploadDirectoryFor(windowsCwd, sha), uploadDirectoryFor(windowsCwd, sha))
        assertEquals(uploadDirectoryFor(windowsCwd, sha), uploadDirectoryFor("D:${backslash}proj${backslash}", sha))
        assert(
            uploadDirectoryFor(windowsCwd, sha) != uploadDirectoryFor(windowsCwd, other),
        )
    }
}
