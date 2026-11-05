package com.orbising.orbis

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Disk reads, deserialization and initial title capture finish before the connection starts. */
internal suspend fun loadHostCache(
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
    load: () -> RemoteState,
): RemoteState = withContext(dispatcher) { load().cachePiSessionNames() }
