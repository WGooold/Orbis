package com.orbising.orbis

import androidx.compose.runtime.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.withContext

/** Paths participate in the original ID-or-path match, even when an ID is repeated. */
internal fun artifactDownloadKey(artifact: RemoteArtifact): String =
    "${artifact.artifactId.length}:${artifact.artifactId}:${artifact.path?.length ?: -1}:${artifact.path.orEmpty()}"

internal class ChatRowResources(
    /** Artifact identity/path -> first matching transfer in the original task order. */
    val downloads: Map<String, ArtifactDownload>,
    val streaming: Set<String>,
)

internal class ChatResourcesRequest(
    val projection: ChatPresentationProjection?,
    val downloads: Map<String, ArtifactDownload>,
    val streaming: Set<String>,
    val finished: Set<String>,
    val ready: Boolean,
) {
    override fun equals(other: Any?): Boolean = other is ChatResourcesRequest && projection === other.projection &&
        downloads === other.downloads && streaming === other.streaming && finished === other.finished && ready == other.ready
    override fun hashCode(): Int = projection?.identity.hashCode()
}

internal class ChatResourcesSnapshot(val identity: ChatPresentationIdentity?, val rows: Map<String, ChatRowResources>, val activeDownloads: Int)

/** Download progress never reruns transcript projection, and unrelated transfers reuse every row. */
internal class ChatRowResourcesWorker {
    private data class Indexed(val position: Int, val task: ArtifactDownload)
    private var downloads: Map<String, ArtifactDownload>? = null
    private var byArtifact: Map<String, Indexed> = emptyMap()
    private var byPath: Map<String, Indexed> = emptyMap()
    private var active = 0
    private var previous: ChatResourcesSnapshot? = null

    suspend fun resolve(input: ChatResourcesRequest): ChatResourcesSnapshot = withContext(Dispatchers.Default) {
        if (downloads !== input.downloads) {
            val artifacts = mutableMapOf<String, Indexed>()
            val paths = mutableMapOf<String, Indexed>()
            input.downloads.values.forEachIndexed { index, task ->
                val value = Indexed(index, task)
                task.sourceArtifactId?.let { artifacts.putIfAbsent(it, value) }
                task.sourcePath?.let { paths.putIfAbsent(it, value) }
            }
            byArtifact = artifacts; byPath = paths; downloads = input.downloads
            active = input.downloads.values.count { it.status == "queued" || it.status == "downloading" }
        }
        val old = previous?.takeIf { it.identity == input.projection?.identity }
        val rows = input.projection?.arrivalRows.orEmpty().associate { (key, ids) ->
            val tasks = input.projection?.artifactsByRow?.get(key).orEmpty().mapNotNull { artifact ->
                val byId = byArtifact[artifact.artifactId]
                val byFile = artifact.path?.let(byPath::get)
                val match = if (byId == null) byFile else if (byFile == null || byId.position <= byFile.position) byId else byFile
                match?.task?.let { artifactDownloadKey(artifact) to it }
            }.toMap()
            val live = if (input.ready) ids.filterTo(linkedSetOf()) { it in input.streaming && it !in input.finished } else emptySet()
            val before = old?.rows?.get(key)
            key to if (before != null && before.downloads == tasks && before.streaming == live) before else ChatRowResources(tasks, live)
        }
        if (old != null && old.activeDownloads == active && old.rows == rows) old
        else ChatResourcesSnapshot(input.projection?.identity, rows, active).also { previous = it }
    }
}

@Composable
internal fun rememberChatRowResources(request: ChatResourcesRequest): ChatResourcesSnapshot? {
    val current by rememberUpdatedState(request)
    val worker = remember { ChatRowResourcesWorker() }
    var result by remember { mutableStateOf<ChatResourcesSnapshot?>(null, referentialEqualityPolicy()) }
    LaunchedEffect(worker) {
        snapshotFlow { current }.conflate().collect { input ->
            val next = worker.resolve(input)
            if (next.identity == current.projection?.identity) result = next
        }
    }
    return result?.takeIf { it.identity == request.projection?.identity }
}
