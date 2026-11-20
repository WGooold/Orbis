package com.orbising.orbis

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json

internal data class ExternalImportUi(
    val batches: List<ExternalImportBatch> = emptyList(),
    val open: Boolean = false,
    val busy: Boolean = false,
    val delivering: String? = null,
    val problem: ImportProblem? = null,
    val selected: String? = null,
    /** OI-08: what the explicit send is waiting on; presentation only. */
    val phase: ImportPhase? = null,
    /** OI-08: the Session confirmed receipt and the local copy already left the inbox. */
    val completed: ExternalImportDestination? = null,
    val recent: ExternalImportTarget? = null,
)

internal class ExternalImportViewModel(app: Application) : AndroidViewModel(app) {
    private val store = ExternalImportStore(File(app.noBackupFilesDir, "external-imports"))
    private val context = app.applicationContext
    private val disk = Mutex()
    private val mutableUi = MutableStateFlow(ExternalImportUi())
    val ui = mutableUi.asStateFlow()

    private val preferences = app.getSharedPreferences("external-import", Context.MODE_PRIVATE)

    init {
        viewModelScope.launch {
            val recent = withContext(Dispatchers.IO) {
                preferences.getString(RECENT, null)?.let { raw ->
                    runCatching { Json.decodeFromString(ExternalImportTarget.serializer(), raw) }.getOrNull()
                }
            }
            mutableUi.update { it.copy(recent = recent) }
            disk.withLock { refresh() }
        }
    }

    fun receive(intent: Intent?) {
        if (intent == null || !isExternalImportAction(intent.action)) return
        if (mutableUi.value.busy) {
            mutableUi.update { it.copy(open = true, problem = ImportProblem.BUSY) }
            return
        }
        mutableUi.update { it.copy(open = true, busy = true, problem = null, selected = null, completed = null) }
        viewModelScope.launch {
            disk.withLock {
                val inserted = withContext(Dispatchers.IO) {
                    runCatching { context.stageExternalImport(store, parseExternalImport(intent)) }
                }
                refresh()
                mutableUi.update { state ->
                    state.copy(busy = false, selected = inserted.getOrNull()?.id,
                        problem = inserted.exceptionOrNull()?.let { (it as? ImportRejected)?.problem ?: ImportProblem.UNREADABLE } ?: state.problem)
                }
            }
        }
    }

    fun show() { mutableUi.update { it.copy(open = true, selected = it.batches.singleOrNull()?.id, problem = null, completed = null) } }
    fun select(id: String?) { mutableUi.update { it.copy(selected = id, problem = null, completed = null) } }
    fun close() { mutableUi.update { it.copy(open = false, problem = null, completed = null) } }

    /** Leaves the completion page: back to remaining items, or out of the sheet when nothing is left. */
    fun finishCompleted() { mutableUi.update { it.copy(completed = null, open = it.open && it.batches.isNotEmpty()) } }

    fun delete(id: String) = mutate(id, null) { store.delete(id) }

    /** OI-08: one explicit action binds the chosen Session (replacing an unsent choice) and sends. */
    fun send(batch: ExternalImportBatch, destination: ExternalImportDestination, remote: RemoteViewModel, instruction: String) {
        if (remote.externalImportRuntime(destination.target) == null) {
            mutableUi.update { it.copy(problem = ImportProblem.TARGET_UNAVAILABLE) }
            return
        }
        runDelivery(batch, ImportPhase.Sending) { phase ->
            val bound = disk.withLock {
                withContext(Dispatchers.IO) {
                    val launch = batch.launch
                    if (launch != null && launch.failed && batch.destination == null) store.clearFailedLaunch(batch.id, launch.id)
                    val old = batch.destination
                    when {
                        // A Session created for this content stays its only target.
                        old != null && old.target == destination.target -> store.list().firstOrNull { it.id == batch.id } ?: batch
                        else -> {
                            if (old != null) store.unassign(batch.id, old.target)
                            store.assign(batch.id, destination)
                        }
                    }
                }
            }
            remote.deliverExternalImport(bound, store, instruction, phase)
        }
    }

    /** Read-only: asks the computer what happened to the original send or launch. Never sends again. */
    fun recheck(batch: ExternalImportBatch, remote: RemoteViewModel) =
        runDelivery(batch, ImportPhase.Checking) { phase -> remote.deliverExternalImport(batch, store, null, phase) }

    fun launch(batch: ExternalImportBatch, owner: HostConnection, agent: String, cwd: String, instruction: String) =
        runDelivery(batch, ImportPhase.Launching) { phase ->
            val fresh = disk.withLock {
                withContext(Dispatchers.IO) {
                    batch.destination?.let { store.unassign(batch.id, it.target) }
                    batch.launch?.takeIf { it.failed }?.let { store.clearFailedLaunch(batch.id, it.id) }
                    store.list().firstOrNull { it.id == batch.id } ?: batch
                }
            }
            owner.launchImport(fresh, store, agent, cwd, instruction, phase)
        }

    private fun runDelivery(batch: ExternalImportBatch, initial: ImportPhase, action: suspend ((ImportPhase) -> Unit) -> Unit) {
        if (mutableUi.value.busy || mutableUi.value.delivering != null) return
        mutableUi.update { it.copy(delivering = batch.id, problem = null, phase = initial) }
        val phase: (ImportPhase) -> Unit = { next -> mutableUi.update { if (it.delivering == batch.id) it.copy(phase = next) else it } }
        viewModelScope.launch {
            try {
                action(phase)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                mutableUi.update { state -> if (state.selected == batch.id)
                    state.copy(problem = (error as? ImportRejected)?.problem ?: ImportProblem.UNREADABLE) else state }
            } finally {
                val done = disk.withLock { refresh(keep = null) }.firstOrNull { it.id == batch.id }?.destination
                if (done != null) withContext(Dispatchers.IO) {
                    runCatching { preferences.edit().putString(RECENT, Json.encodeToString(ExternalImportTarget.serializer(), done.target)).apply() }
                }
                mutableUi.update { state ->
                    val showing = done != null && state.open && state.selected == batch.id
                    state.copy(delivering = null, phase = null,
                        recent = done?.target ?: state.recent,
                        completed = if (showing) done else state.completed,
                        selected = if (done != null && state.selected == batch.id) null else state.selected,
                        problem = if (showing) null else state.problem)
                }
            }
        }
    }

    private fun mutate(id: String, selectedAfter: String?, action: () -> Unit) {
        if (mutableUi.value.busy || mutableUi.value.delivering == id) return
        mutableUi.update { it.copy(busy = true, problem = null) }
        viewModelScope.launch {
            disk.withLock {
                val result = withContext(Dispatchers.IO) { runCatching { action() } }
                refresh()
                mutableUi.update { it.copy(busy = false, selected = if (result.isSuccess) selectedAfter else id,
                    problem = result.exceptionOrNull()?.let { error -> (error as? ImportRejected)?.problem ?: ImportProblem.UNREADABLE }
                        ?: it.problem) }
            }
        }
    }

    /** Accepted batches leave the inbox here, including ones confirmed by an earlier version. Returns them. */
    private suspend fun refresh(keep: String? = mutableUi.value.delivering): List<ExternalImportBatch> {
        val (accepted, snapshot) = withContext(Dispatchers.IO) {
            val accepted = runCatching { store.removeAccepted(keep) }.getOrDefault(emptyList())
            accepted to runCatching { store.list() }
        }
        mutableUi.update { old ->
            snapshot.fold(onSuccess = { old.copy(batches = it) }, onFailure = { old.copy(problem = ImportProblem.UNREADABLE) })
        }
        return accepted
    }

    private companion object { const val RECENT = "recent-target" }
}
