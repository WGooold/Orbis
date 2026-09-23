package dev.pi.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class PathPreferenceTest {

    /**
     * 本机存的顺序可能残缺/重复（旧版本、手改 prefs）。补全保证三档齐全——
     * 少一条路径就等于那条路从选路里消失，而且用户不会收到任何提示。
     */
    @Test
    fun `normalize fills missing paths so a short stored order cannot drop a path`() {
        assertEquals(listOf("lan", "p2p", "relay"), normalizePathPreference(listOf("lan", "p2p", "relay")))
        assertEquals(listOf("p2p", "lan", "relay"), normalizePathPreference(listOf("p2p")))
        assertEquals(listOf("relay", "p2p", "lan"), normalizePathPreference(listOf("relay", "relay", "p2p")))
    }
}
