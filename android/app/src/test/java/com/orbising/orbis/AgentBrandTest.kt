package com.orbising.orbis

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class AgentBrandTest {
    // AGENT-MARK-01: named agents must not pick up Pi's legacy fallback, and
    // OpenCode selects its own light or dark artwork instead of a tinted glyph.
    @Test fun agentKindsResolveToTheirOwnArtwork() {
        val brands = mapOf(
            "pi" to AgentBrand.Pi, "codex" to AgentBrand.Codex, "codexDesktop" to AgentBrand.Codex,
            "dsh" to AgentBrand.DeepSeek, "dshDesktop" to AgentBrand.DeepSeek, "claude" to AgentBrand.Claude,
            KIMI_CODE_KIND to AgentBrand.Kimi, "openclaw" to AgentBrand.OpenClaw, "hermes" to AgentBrand.Hermes,
            "opencode" to AgentBrand.OpenCode,
        )
        brands.forEach { (kind, brand) -> assertEquals(kind, brand, knownAgentBrand(kind)) }
        assertEquals(R.drawable.ic_agent_kimi, AgentBrand.Kimi.icon)
        assertEquals(R.drawable.ic_agent_kimi, AgentBrand.Kimi.darkIcon)
        assertEquals(R.drawable.ic_agent_opencode, AgentBrand.OpenCode.icon)
        assertEquals(R.drawable.ic_agent_opencode_dark, AgentBrand.OpenCode.darkIcon)
        assertNull(knownAgentBrand("future-agent"))
        assertEquals(AgentBrand.Pi, agentBrand(null))
    }

    /** Android PathParser merges compressed SVG arc flags like `012.948` into one float. */
    @Test fun hermesVectorArcCommandsSeparateFlagsFromCoordinates() {
        val file = listOf(
            File("src/main/res/drawable/ic_agent_hermes.xml"),
            File("android/app/src/main/res/drawable/ic_agent_hermes.xml"),
        ).first(File::isFile)
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val paths = doc.getElementsByTagName("path")
        assertTrue(paths.length > 0)
        val arity = mapOf('M' to 2, 'm' to 2, 'L' to 2, 'l' to 2, 'H' to 1, 'h' to 1, 'V' to 1, 'v' to 1,
            'C' to 6, 'c' to 6, 'S' to 4, 's' to 4, 'Q' to 4, 'q' to 4, 'T' to 2, 't' to 2, 'A' to 7, 'a' to 7)
        for (i in 0 until paths.length) {
            val d = paths.item(i).attributes.getNamedItem("android:pathData").nodeValue
            val tokens = d.trim().split(Regex("\\s+"))
            var idx = 0
            var cmd = '\u0000'
            while (idx < tokens.size) {
                val token = tokens[idx]
                if (token.length == 1 && token[0] in "MmLlHhVvCcSsQqTtAaZz") {
                    cmd = token[0]
                    idx++
                    if (cmd == 'Z' || cmd == 'z') continue
                } else {
                    if (cmd == 'M') cmd = 'L' else if (cmd == 'm') cmd = 'l'
                }
                val count = arity.getValue(cmd)
                assertTrue("Incomplete args for $cmd in path $i at token $idx", idx + count <= tokens.size)
                for (arg in 0 until count) {
                    val value = tokens[idx + arg]
                    assertTrue("Invalid float token '$value' in path $i", value.toFloatOrNull() != null)
                    if ((cmd == 'A' || cmd == 'a') && (arg == 3 || arg == 4)) {
                        assertTrue("Arc flag '$value' must be 0 or 1 in path $i", value == "0" || value == "1")
                    }
                }
                idx += count
            }
        }
    }
}
