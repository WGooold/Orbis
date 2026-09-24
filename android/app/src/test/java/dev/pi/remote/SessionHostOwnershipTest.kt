package dev.pi.remote

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SessionHostOwnershipTest {
    @get:Rule val temporary = TemporaryFolder()
    private val reducer = RelayReducer()
    private val device = DeviceCredential("wss://relay.example", "device", "test")
    private val paired = RemoteState(hostId = "host-1", hostName = "Desktop")

    private fun assertOwner(state: RemoteState, vararg sessions: String) {
        val host = cachedHistoryTree(state).single()
        assertEquals("host-1", host.hostId)
        assertEquals("Desktop", host.hostname)
        assertEquals(sessions.toSet(), host.directories.flatMap { it.sessions }.map { it.sessionId }.toSet())
    }

    @Test fun `empty Codex session keeps its Host through missing catalog offline and reconnect`() {
        val runtime = """{"runtimeId":"codex:empty","sessionId":"empty","name":"Codex","cwd":"D:/repo","status":"idle"}"""
        val online = reducer.reduce(paired, """{"type":"runtime.online","runtime":$runtime}""")
        assertOwner(online, "empty")
        assertEquals(0, online.sessions["empty"]?.messageCount)
        val missing = reducer.reduce(online, """{"type":"session.list.result","sessions":[]}""")
        assertOwner(missing, "empty")
        val offline = reducer.reduce(missing, """{"type":"runtime.offline","runtimeId":"codex:empty"}""")
        assertOwner(offline, "empty")
        val reconnected = reducer.reduce(offline, """{"type":"device.ready","deviceId":"device","runtimes":[$runtime]}""", channel = "ctl")
        assertOwner(reconnected, "empty")
        val file = temporary.newFile()
        SessionCatalogStore(file).save(device, "host-1", reconnected.sessions.values)
        assertOwner(paired.copy(sessions = SessionCatalogStore(file).load(device, "host-1").associateBy { it.sessionId }), "empty")
    }

    @Test fun `all catalog entry sources share the pairing owner regardless of hostname`() {
        var state = reducer.reduce(paired, """{"type":"session.list.result","sessions":[
            {"sessionId":"listed","cwd":"D:/repo","hostname":"old-name"},
            {"sessionId":"unnamed","cwd":"D:/repo"}]}""")
        state = reducer.reduce(state, """{"type":"runtime.event","runtimeId":"pi","sequence":1,"event":{
            "type":"session.catalog","sessions":[{"sessionId":"catalog","cwd":"D:/repo","hostname":"different-name"}]}}""")
        state = reducer.reduce(state, """{"type":"runtime.event","runtimeId":"pi","sequence":2,"event":{
            "type":"runtime.metadata","metadata":{"runtimeId":"pi","sessionId":"metadata","name":"Pi","cwd":"D:/repo","status":"idle","hostname":""}}}""")
        state = reducer.reduce(state, """{"type":"session.archive.changed","agentKind":"pi","sessionId":"archive","archived":true}""")
        assertOwner(state, "listed", "unnamed", "catalog", "metadata", "archive")
        val renamed = state.copy(hostName = "Renamed", runtimes = emptyMap())
        assertEquals("host-1", cachedHistoryTree(renamed).single().hostId)
        assertEquals("Renamed", cachedHistoryTree(renamed).single().hostname)
        assertEquals(5, cachedHistoryTree(renamed).single().directories.sumOf { it.sessions.size })
    }

    @Test fun `a paired Host exists before any sessions and unpaired metadata cannot invent one`() {
        assertOwner(paired)
        val session = SessionCatalogEntry("s", hostname = "Desktop")
        assertTrue(cachedHistoryTree(RemoteState(sessions = mapOf("s" to session))).isEmpty())
        assertNull(RemoteState(hostId = " ", sessions = mapOf("s" to session)).sessionHost)
        val legacy = paired.copy(hostName = null, sessions = mapOf("s" to session))
        assertEquals(SessionHost("host-1", "Desktop"), legacy.sessionHost)
        assertEquals(SessionHost("host-1", "已配对电脑"), legacy.copy(sessions = emptyMap()).sessionHost)
        assertEquals("host-1", legacy.copy(sessions = mapOf("s" to session, "other" to session.copy(sessionId = "other", hostname = "Laptop"))).sessionHost?.hostId)
    }

    @Test fun `new sessions require the same paired Host and an authenticated live channel`() {
        val ready = paired.copy(connection = RelayConnection.ONLINE, e2eReady = true)
        assertTrue(ready.canCreateSessionOn("host-1"))
        assertFalse(ready.canCreateSessionOn("host-2"))
        assertFalse(ready.canCreateSessionOn(null))
        assertFalse(ready.copy(hostId = null).canCreateSessionOn(null))
        assertFalse(ready.copy(e2eReady = false).canCreateSessionOn("host-1"))
        assertFalse(ready.copy(connection = RelayConnection.OFFLINE).canCreateSessionOn("host-1"))
        assertFalse(ready.copy(sessionActivateRequests = setOf("pending")).canCreateSessionOn("host-1"))
        val relayOnly = reducer.reduce(paired, """{"type":"device.ready","deviceId":"device","runtimes":[]}""")
        assertFalse(relayOnly.canCreateSessionOn("host-1"))
    }

    @Test fun `old device scoped cache migrates without losing unnamed empty or archived sessions`() {
        val file = temporary.newFile()
        file.writeText("""{"relayUrl":"wss://relay.example","deviceId":"device","updatedAt":1,"sessions":[
            {"sessionId":"empty","cwd":"D:/repo"},
            {"sessionId":"history","hostname":"old-name","hasHistoryCache":true,"archived":true}
        ]}""")
        val store = SessionCatalogStore(file)
        val loaded = store.load(device, "host-1")
        assertEquals(setOf("empty", "history"), loaded.map { it.sessionId }.toSet())
        assertEquals(true, loaded.single { it.sessionId == "history" }.hasHistoryCache)
        assertEquals(true, loaded.single { it.sessionId == "history" }.archived)
        assertOwner(paired.copy(sessions = loaded.associateBy { it.sessionId }), "empty", "history")
        assertEquals(loaded, SessionCatalogStore(file).load(device, "host-1"))
        assertTrue(store.load(device, "host-2").isEmpty())
        assertTrue(store.load(device.copy(deviceId = "other"), "host-1").isEmpty())
        assertTrue(store.load(device.copy(relayUrl = "wss://other.example"), "host-1").isEmpty())
        assertTrue(store.load(device, "").isEmpty())
        assertEquals(loaded, store.load(device, "host-1"))
    }

    @Test fun `cache from another pairing is not migrated into this Host`() {
        val file = temporary.newFile()
        val original = """{"relayUrl":"wss://relay.example","deviceId":"other-device","updatedAt":1,"sessions":[{"sessionId":"s"}]}"""
        file.writeText(original)
        assertTrue(SessionCatalogStore(file).load(device, "host-1").isEmpty())
        assertEquals(original, file.readText())
    }

    @Test fun `pairing display name survives persistence and old keys still load`() {
        val identity = HostIdentity("host-1", "public", "key", hostName = "Desktop")
        assertEquals(identity, Json.decodeFromString<HostIdentity>(Json.encodeToString(identity)))
        val old = Json.decodeFromString<HostIdentity>("""{"hostId":"host-1","hostPub":"public","pskRoot":"key"}""")
        assertEquals("host-1", old.hostId)
        assertEquals("key", old.pskRoot)
        assertNull(old.hostName)
    }
}
