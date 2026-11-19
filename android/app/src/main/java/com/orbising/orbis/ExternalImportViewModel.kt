package com.orbising.orbis

import android.app.Application
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

internal data class ExternalImportUi(
    val batches: List<ExternalImportBatch> = emptyList(),
    val open: Boolean = false,
    val busy: Boolean = false,
    val delivering: String? = null,
    val problem: ImportProblem? = null,
    val selected: String? = null,
)

internal class ExternalImportViewModel(app: Application) : AndroidViewModel(app) {
    private val store = ExternalImportStore(File(app.noBackupFilesDir, "external-imports"))
    private val context = app.applicationContext
    private val disk = Mutex()
    private val mutableUi = MutableStateFlow(ExternalImportUi())
    val ui = mutableUi.asStateFlow()

    init { viewModelScope.launch { disk.withLock { refresh() } } }

    fun receive(intent: Intent?) {
        if (intent == null || !isExternalImportAction(intent.action)) return
        if (mutableUi.value.busy) {
            mutableUi.update { it.copy(open = true, problem = ImportProblem.BUSY) }
            return
        }
        mutableUi.update { it.copy(open = true, busy = true, problem = null, selected = null) }
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

    fun show() { mutableUi.update { it.copy(open = true, selected = null) } }
    fun select(id: String?) { mutableUi.update { it.copy(selected = id, problem = null) } }
    fun close() { mutableUi.update { it.copy(open = false, problem = null) } }

    fun assign(id: String, destination: ExternalImportDestination, ifCurrent: () -> Boolean) {
        if (mutableUi.value.busy) return
        if (!ifCurrent()) {
            mutableUi.update { it.copy(problem = ImportProblem.TARGET_UNAVAILABLE) }
            return
        }
        mutate(id, id) { store.assign(id, destination) }
    }

    fun unassign(id: String, target: ExternalImportTarget) = mutate(id, id) { store.unassign(id, target) }

    fun delete(id: String) = mutate(id, null) { store.delete(id) }

    fun deliver(batch: ExternalImportBatch, remote: RemoteViewModel, instruction: String?) = runDelivery(batch) {
        remote.deliverExternalImport(batch, store, instruction)
    }

    fun launch(batch: ExternalImportBatch, owner: HostConnection, agent: String, cwd: String, instruction: String) = runDelivery(batch) {
        owner.launchImport(batch, store, agent, cwd, instruction)
    }

    fun clearFailedLaunch(id: String, launchId: String) = mutate(id, id) { store.clearFailedLaunch(id, launchId) }

    private fun runDelivery(batch: ExternalImportBatch, action: suspend () -> Unit) {
        if (mutableUi.value.busy || mutableUi.value.delivering != null) return
        mutableUi.update { it.copy(delivering = batch.id, problem = null) }
        viewModelScope.launch {
            try {
                action()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                mutableUi.update { state -> if (state.selected == batch.id)
                    state.copy(problem = (error as? ImportRejected)?.problem ?: ImportProblem.UNREADABLE) else state }
            } finally {
                disk.withLock { refresh() }
                mutableUi.update { it.copy(delivering = null) }
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

    private suspend fun refresh() {
        val snapshot = withContext(Dispatchers.IO) { runCatching { store.list() } }
        mutableUi.update { old ->
            snapshot.fold(onSuccess = { old.copy(batches = it) }, onFailure = { old.copy(problem = ImportProblem.UNREADABLE) })
        }
    }
}
