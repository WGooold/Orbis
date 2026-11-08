package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** SC55: inputs the deployed protocol will reject must stay local before session.activate. */
class MessageInputTest {
    @Test fun slashAndProtocolLengthAreRejectedBeforeAnyFirstSessionCreation() {
        assertEquals("斜杠命令只能从当前会话提供的菜单中选择",userMessageInputError("  /help"))
        assertNotNull(userMessageInputError("x".repeat(100_001)))
        assertNull(userMessageInputError("x".repeat(100_000)))
        assertNull(userMessageInputError("  你好 /help  "))
    }
}
