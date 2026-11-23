package com.orbising.orbis

import org.junit.Assert.*
import org.junit.Test

/** SC55: inputs the deployed protocol will reject must stay local before session.activate. */
class MessageInputTest {
    // CHAT-PATH-01: recognize a single at-sign at the cursor, not pasted paths or IME composition.
    @Test fun computerPathPickerTriggerTracksTheCaret() {
        assertEquals(3, insertedComputerPathTriggerIndex("检查 ", "检查 @", caretUtf16 = 4))
        assertEquals(1, insertedComputerPathTriggerIndex("前后", "前@后", caretUtf16 = 2))
        assertNull(insertedComputerPathTriggerIndex("", "@file", caretUtf16 = 5))
        assertNull(insertedComputerPathTriggerIndex("x", "x@", caretUtf16 = 2, markedText = true))
        assertNull(insertedComputerPathTriggerIndex("abc", "ab@c", caretUtf16 = 4))
    }

    // CHAT-PATH-01: selected computer paths replace only @, preserve surrounding prose and quote spaces.
    @Test fun computerPathMentionPreservesDraftAndQuotesPathsWithSpaces() {
        assertEquals(
            ComputerPathMentionInsertion("检查 @/repo/Source.swift 后续", 22),
            insertComputerPathMention("检查 @ 后续", triggerIndex = 3, path = "/repo/Source.swift"),
        )
        assertEquals(
            ComputerPathMentionInsertion("看 @\"C:\\Users\\Ada Lovelace\\notes.md\" ", "看 @\"C:\\Users\\Ada Lovelace\\notes.md\" ".length),
            insertComputerPathMention("看@", triggerIndex = 1, path = "C:\\Users\\Ada Lovelace\\notes.md"),
        )
        assertEquals("@/repo/file ", insertComputerPathMention("@", triggerIndex = 0, path = "/repo/file")?.text)
        assertNull(insertComputerPathMention("x", triggerIndex = 0, path = "/repo/file"))
    }

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
