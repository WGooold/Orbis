package dev.pi.remote

import java.net.URI

/** The official HTTPS hostname is proxied; UDP STUN uses the origin directly. */
internal fun relayStunHost(relayUrl: String): String? {
    val host = runCatching { URI(relayUrl.trim()).host }.getOrNull() ?: return null
    return if (host.equals("orbising.com", ignoreCase = true)) "74.81.55.191" else host
}
