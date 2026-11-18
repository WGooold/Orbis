package com.orbising.orbis

import android.app.Application
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
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

    fun delete(id: String) {
        if (mutableUi.value.busy) return
        mutableUi.update { it.copy(busy = true, problem = null) }
        viewModelScope.launch {
            disk.withLock {
                val deleted = withContext(Dispatchers.IO) { runCatching { store.delete(id) } }
                refresh()
                mutableUi.update { it.copy(busy = false, selected = if (deleted.isSuccess) null else id,
                    problem = if (deleted.isFailure) ImportProblem.UNREADABLE else it.problem) }
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
