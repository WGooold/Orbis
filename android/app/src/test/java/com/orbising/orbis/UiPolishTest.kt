package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UiPolishTest {
    @Test fun fileExtensionsSurviveLongAndCompoundNames() {
        assertEquals("报告最终版本" to ".pdf", fileNameParts("报告最终版本.pdf"))
        assertEquals("archive.tar" to ".gz", fileNameParts("archive.tar.gz"))
        assertEquals("report" to ".longextensionname", fileNameParts("report.longextensionname"))
        assertEquals(".env" to "", fileNameParts(".env"))
        assertEquals("file." to "", fileNameParts("file."))
        assertEquals("README" to "", fileNameParts("README"))
    }

    @Test fun beingInsideTheLastRowDoesNotMeanBeingAtTheBottom() {
        assertEquals(3300f, chatBottomDistance(8, 9, 4000, 716, 16))
        assertEquals(16f, chatBottomDistance(8, 9, 716, 716, 16))
        assertEquals(0f, chatBottomDistance(8, 9, 680, 716, 16))
        assertTrue(chatBottomDistance(7, 9, 716, 716, 16).isInfinite())
    }
}
