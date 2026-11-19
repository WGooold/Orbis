package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceTextCleanupRulesTest {
    @Test fun removesStandaloneChineseAndEnglishFillers() {
        assertEquals("我想说，明天上午十点开会。", VoiceTextCleanupRules.clean("嗯，我想说，呃，明天上午十点开会。"))
        assertEquals("I think, we should meet tomorrow.", VoiceTextCleanupRules.clean("Um, I think, uh, we should meet tomorrow."))
    }

    @Test fun keepsMeaningfulWordsAndInterjections() {
        assertEquals("这是额外的内容。", VoiceTextCleanupRules.clean("这是额外的内容。"))
        assertEquals("嗯？你刚才说什么？", VoiceTextCleanupRules.clean("嗯？你刚才说什么？"))
        assertEquals("我就是这么想的。", VoiceTextCleanupRules.clean("我就是这么想的。"))
    }
}
