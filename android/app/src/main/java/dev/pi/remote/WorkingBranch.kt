package dev.pi.remote

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Latest read of the working directory's Git HEAD, independent of the conversation branch. */
data class WorkingBranch(
    val requestId: String,
    val sessionId: String?,
    val cwd: String,
    val branch: String? = null,
    val commit: String? = null,
    val loaded: Boolean = false,
)

/** A result for an old request/session/worktree must never overwrite the current label. */
internal fun RemoteState.withWorkingBranch(message: JsonObject): RemoteState {
    fun value(key: String) = message[key]?.jsonPrimitive?.contentOrNull
    val runtimeId = value("runtimeId") ?: return this
    val runtime = runtimes[runtimeId] ?: return this
    val pending = workingBranches[runtimeId] ?: return this
    if (value("requestId") != pending.requestId || value("cwd") != runtime.cwd ||
        value("sessionId") != runtime.sessionId || pending.cwd != runtime.cwd || pending.sessionId != runtime.sessionId
    ) return this
    return copy(workingBranches = workingBranches + (runtimeId to pending.copy(
        branch = value("branch")?.takeIf { it.isNotBlank() && it.length <= 256 },
        commit = value("commit")?.takeIf { it.matches(Regex("[a-f0-9]{8,64}")) },
        loaded = true,
    )))
}
