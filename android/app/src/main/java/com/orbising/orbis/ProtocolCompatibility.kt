package com.orbising.orbis

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** ADR-0064: this delivery implements the unchanged 18 core plus the additive 19 task inventory.
 * Future revisions require their own compatibility implementation and tests. */
internal const val MIN_PROTOCOL_VERSION = 18
// Enumerate implemented codecs, not every integer between a minimum and maximum.
// Adding a future protocol requires its implementation and compatibility tests here.
internal val SUPPORTED_PROTOCOL_VERSIONS: Set<Int> = setOf(18, 19)
internal val PREFERRED_PROTOCOL_VERSIONS: List<Int> = SUPPORTED_PROTOCOL_VERSIONS.sortedDescending()
internal val INITIAL_WIRE_PROTOCOL_VERSION = PREFERRED_PROTOCOL_VERSIONS.first()

/** The same format may have two or more participants; select an actual intersection. */
internal fun highestCommonProtocolVersion(vararg supported: Collection<Int>): Int? =
    supported.firstOrNull()?.filter { version -> version >= MIN_PROTOCOL_VERSION && supported.all { version in it } }?.maxOrNull()

/** Legacy peers do not advertise sets. Probe descending, only after a pre-business
 * compatibility rejection; an authenticated ready confirms the selected codec. */
internal fun nextSupportedProtocolVersion(version: Int): Int? {
    val index = PREFERRED_PROTOCOL_VERSIONS.indexOf(version)
    return if (index >= 0) PREFERRED_PROTOCOL_VERSIONS.getOrNull(index + 1) else null
}

internal fun isSupportedProtocolVersion(version: Int): Boolean = version in SUPPORTED_PROTOCOL_VERSIONS

internal fun supportedProtocolVersion(value: JsonElement?): Int? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive.isString) return null
    return primitive.intOrNull?.takeIf(::isSupportedProtocolVersion)
}

/** Some existing receipts have no version. A present version must always be valid. */
internal fun JsonObject.hasUnsupportedProtocolVersion(): Boolean =
    containsKey("protocolVersion") && supportedProtocolVersion(get("protocolVersion")) == null

/** Select the wire format at the transport boundary, including queued requests and ACKs.
 * Keep every command ID, request ID and nested command byte-for-byte equivalent. */
internal fun JsonObject.withWireProtocolVersion(version: Int): JsonObject {
    require(isSupportedProtocolVersion(version))
    if (!containsKey("protocolVersion")) return this
    return JsonObject(toMutableMap().apply { put("protocolVersion", JsonPrimitive(version)) })
}
