package com.orbising.orbis

import android.content.Context

/** FILE-BROWSER-02: each computer has its own last successful download directory. */
internal class DownloadBrowserPathStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences("orbis_download_browser", Context.MODE_PRIVATE)

    fun load(hostId: String): String? = preferences.getString(hostId, null)

    fun save(hostId: String, path: String) { preferences.edit().putString(hostId, path).apply() }

    fun clear(hostId: String) { preferences.edit().remove(hostId).apply() }
}
