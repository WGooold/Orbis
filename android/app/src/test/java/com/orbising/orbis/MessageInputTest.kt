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
    @Test fun firstSessionNeedsTwoFreeLedgerSlotsAndSettledRowsDoNotConsumeCapacity() {
        val ledger = OperationLedger<String>(capacity=2)
        assertTrue(ledger.hasCapacity(2))
        val occupied = ledger.create("old","send","old",policy=LedgerPolicy(),basis=emptyMap(),payload="old",written=false,now=0).first
        assertTrue(occupied.hasCapacity())
        assertFalse(occupied.hasCapacity(2))
        val rejected = occupied.writeFailed("old","failed").ledger
        assertTrue(rejected.hasCapacity(2))
    }
}
