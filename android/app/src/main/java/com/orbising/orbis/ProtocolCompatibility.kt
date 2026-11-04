package com.orbising.orbis

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/** ADR-0064: this delivery implements the unchanged 18 core plus the additive 19 task inventory.
 * Future revisions require their own compatibility implementation and tests. */
internal const val MIN_PROTOCOL_VERSION = 18
internal const val INITIAL_WIRE_PROTOCOL_VERSION = MIN_PROTOCOL_VERSION

internal fun isSupportedProtocolVersion(version: Int): Boolean = version in MIN_PROTOCOL_VERSION..PROTOCOL_VERSION

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
