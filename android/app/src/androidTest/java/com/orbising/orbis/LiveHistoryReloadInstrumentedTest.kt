package com.orbising.orbis

import android.app.Application
import android.os.SystemClock
import android.os.Bundle
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in diagnosis against the phone's existing pairing. Never sends user messages,
 * activates a backend, deletes cache, or changes history. Recreates the ViewModel/transport
 * against the same SQLite cache; process-level reopening is covered by the Windows UI probe.
 */
class LiveHistoryReloadInstrumentedTest {
    @Test fun cachedPagesRemainLoadableAcrossClientRecreation() {
        assumeTrue("Explicitly opt in with -e liveHistory true",
            InstrumentationRegistry.getArguments().getString("liveHistory") == "true")
        val runId = InstrumentationRegistry.getArguments().getString("historyRunId")
        val app = ApplicationProvider.getApplicationContext<Application>()
        val stage = AtomicReference("load_pairing")
        val finished = CountDownLatch(1)
        // runOnMainSync, SQLite and transport shutdown do not have caller-side deadlines.
        // Bound the opt-in probe itself and retain only stacks, never heap/chat contents.
        thread(name = "history-probe-watchdog", isDaemon = true) {
            if (!finished.await(90, TimeUnit.SECONDS)) {
                val stacks = Thread.getAllStackTraces().filter { (worker, frames) ->
                    worker.name == "main" || frames.any { it.className.startsWith("com.orbising.orbis.") }
                }
                val report = buildJsonObject {
                    put("runId", runId)
                    put("stage", stage.get())
                    put("threads", buildJsonArray {
                        stacks.entries.take(16).forEach { (worker, frames) -> add(buildJsonObject {
                            put("kind", if (worker.name == "main") "main" else "worker")
                            put("state", worker.state.name)
                            put("frames", buildJsonArray { frames.take(48).forEach { add(kotlinx.serialization.json.JsonPrimitive(it.toString())) } })
                        }) }
                    })
                }
                File(app.getExternalFilesDir(null), "live-history-wait.json").writeText(report.toString())
                InstrumentationRegistry.getInstrumentation().finish(1, Bundle().apply {
                    putString("stream", "INCONCLUSIVE: probe deadline at ${stage.get()}; content-free stacks saved\n")
                })
            }
        }
        val device = requireNotNull(CredentialStore(app).load()) { "Existing phone pairing required" }
        val store = SessionGraphStore(app)
        val evidence = mutableListOf<kotlinx.serialization.json.JsonObject>()
        var owner = ViewModelStore()
        lateinit var model: RemoteViewModel
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        fun start() {
            stage.set("start_main")
            instrumentation.runOnMainSync {
                model = RemoteViewModel(app)
                owner.put("live-history", model)
            }
        }
        fun stop() {
            stage.set("stop_main")
            instrumentation.runOnMainSync { owner.clear(); owner = ViewModelStore() }
        }
        fun awaitState(label: String, predicate: () -> Boolean) {
            stage.set(label)
            val deadline = SystemClock.elapsedRealtime() + 60_000
            while (!predicate() && SystemClock.elapsedRealtime() < deadline) Thread.sleep(50)
            val state = model.state.value
            assertTrue("Timed out at $label: connection=${state.connection} e2eReady=${state.e2eReady} " +
                "runtimes=${state.runtimes.values.groupingBy { it.agentKind }.eachCount()} " +
                "syncFailures=${state.sessionSyncFailures.size} errorPresent=${state.error != null}", predicate())
        }
        fun key(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
            .take(8).joinToString("") { "%02x".format(it.toInt() and 255) }
        try {
            start()
            awaitState("connected Codex catalog") {
                model.state.value.e2eReady && model.state.value.runtimes.values.count {
                    it.agentKind in setOf("codex", "codexDesktop") && it.sessionId != null
                } >= 1
            }
            val targets = model.state.value.runtimes.values.filter {
                it.agentKind in setOf("codex", "codexDesktop") && it.sessionId != null
            }.take(3)
            for ((index, target) in targets.withIndex()) {
                val sessionId = requireNotNull(target.sessionId)
                val warmed = mutableSetOf<Triple<String?, String?, String>>()
                var comparisons = 0
                for (round in 0..3) {
                    if (round > 0 || index > 0) {
                        stop()
                        start()
                        awaitState("runtime reconnect") { model.state.value.e2eReady &&
                            model.state.value.runtimes[target.runtimeId]?.sessionId == sessionId }
                    }
                    stage.set("select_main")
                    instrumentation.runOnMainSync { model.selectRuntime(target.runtimeId) }
                    awaitState("initial snapshot") {
                        val state = model.state.value
                        val conversation = state.conversations[target.runtimeId]
                        conversation?.hasLiveSnapshot == true && !conversation.isChatSyncing &&
                            conversation.chatSyncError == null && state.sessionHistory[target.runtimeId]?.oldestEntryId != null
                    }
                    for (page in 1..2) {
                        val history = model.state.value.sessionHistory[target.runtimeId] ?: error("Missing history state")
                        if (!history.hasOlder) break
                        val boundary = requireNotNull(history.oldestEntryId)
                        stage.set("read_cache_page")
                        val (before, cacheEpoch) = synchronized(store) {
                            store.readBranch(device, sessionId, history.leafId,
                                beforeEntryId = boundary, maxEntries = 30) to store.cacheEpoch(device, sessionId)
                        }
                        val window = Triple(cacheEpoch, history.leafId, boundary)
                        // Missing older ancestors beyond this bounded page do not invalidate
                        // the contiguous rows returned for this exact cache window.
                        val sameCachedBoundary = round > 0 && window in warmed && before.entries.isNotEmpty()
                        val started = SystemClock.elapsedRealtime()
                        var acceptance = HistoryReadAcceptance()
                        stage.set("request_history_main")
                        instrumentation.runOnMainSync { acceptance = model.loadOlderHistory(target.runtimeId) }
                        assertTrue("History request rejected or merged: session ${index + 1}, round $round, page $page",
                            acceptance.operationId != null && !acceptance.merged)
                        var requestedRemote = false
                        var completed = false
                        stage.set("await_history_operation")
                        val deadline = started + 45_000
                        while (SystemClock.elapsedRealtime() < deadline) {
                            val state = model.state.value
                            requestedRemote = requestedRemote || state.sessionSyncCommands.values.any {
                                it.runtimeId == target.runtimeId && it.range == "history" && it.beforeEntryId == boundary
                            }
                            val next = state.sessionHistory[target.runtimeId]
                            val phase = state.sessionReads[acceptance.operationId]?.phase
                            if (phase in setOf(SessionReadPhase.SUCCEEDED, SessionReadPhase.END_REACHED) &&
                                next != null && !next.loading && (next.oldestEntryId != boundary || !next.hasOlder)) {
                                completed = true
                                break
                            }
                            if (phase != null && !phase.active) break
                            Thread.sleep(10)
                        }
                        val elapsed = SystemClock.elapsedRealtime() - started
                        val finalState = model.state.value
                        val finalHistory = finalState.sessionHistory[target.runtimeId]
                        val finalConversation = finalState.conversations[target.runtimeId]
                        evidence += buildJsonObject {
                            put("sessionNumber", index + 1); put("session", key(sessionId)); put("boundary", key(boundary))
                            put("epoch", key(cacheEpoch.orEmpty())); put("leaf", key(history.leafId.orEmpty()))
                            put("phase", finalState.sessionReads[acceptance.operationId]?.phase?.name)
                            put("round", round); put("page", page); put("cachedEntries", before.entries.size)
                            put("cacheRangeStatus", before.status.name)
                            put("sameCachedBoundary", sameCachedBoundary); put("remoteObserved", requestedRemote)
                            put("completed", completed); put("elapsedMs", elapsed)
                            put("selected", finalState.selectedRuntimeId == target.runtimeId)
                            put("failureGate", target.runtimeId in finalState.sessionSyncFailures)
                            put("limitReachedRangeFailure", finalState.sessionRangeFailures.values.any { it.endsWith("limit_reached") })
                            put("chatErrorPresent", finalConversation?.chatSyncError != null)
                            put("loading", finalHistory?.loading)
                            put("hasOlder", finalHistory?.hasOlder)
                            put("finalBoundary", finalHistory?.oldestEntryId?.let(::key))
                            put("sourceReady", finalConversation?.sourceReady)
                            put("pendingHistory", finalState.sessionSyncCommands.values.count { it.runtimeId == target.runtimeId && it.range == "history" })
                        }
                        assertTrue("History did not advance: session ${index + 1}, round $round, page $page", completed)
                        assertTrue("Bounded response was reported as a range failure: session ${index + 1}, round $round, page $page",
                            finalState.sessionRangeFailures.values.none { it.endsWith("limit_reached") })
                        if (sameCachedBoundary) {
                            comparisons++
                            assertTrue("Cached page required remote request", !requestedRemote)
                            assertTrue("Cached page took ${elapsed}ms", elapsed <= 3000)
                        }
                        if (round == 0) warmed += window
                    }
                }
                assertTrue("INCONCLUSIVE: no same-boundary cached reload for session ${index + 1}", comparisons > 0)
            }
        } finally {
            evidence += buildJsonObject {
                put("stage", "catalog")
                put("runId", runId)
                put("connection", model.state.value.connection.name)
                put("e2eReady", model.state.value.e2eReady)
                put("runtimeCount", model.state.value.runtimes.size)
                put("codexCount", model.state.value.runtimes.values.count { it.agentKind in setOf("codex", "codexDesktop") })
            }
            stop()
            store.close()
            stage.set("save_evidence")
            val path = File(app.getExternalFilesDir(null), "live-history-reload.json")
            path.writeText(Json.encodeToString(kotlinx.serialization.json.JsonArray.serializer(),
                buildJsonArray { evidence.forEach { add(it) } }))
            finished.countDown()
        }
    }
}
