import {
  PROTOCOL_VERSION, decodeArtifactChunkFrame, encodeArtifactChunkFrame,
} from "@orbis/protocol";

// Business support evolves independently of the Relay's routing formats.
export type DeviceProtocolVersion = 18 | 19;
export class UnsupportedDeviceEventError extends Error {}
export const deviceProtocolVersion = (value: unknown): DeviceProtocolVersion | undefined => {
  return value === 18 || value === 19 ? value : undefined;
};

/** Normalize only the transport version, then run the ordinary strict business parser. */
export function normalizeDeviceRequest(payload: Buffer): { version: DeviceProtocolVersion; payload: Buffer } | undefined {
  let value: unknown;
  try { value = JSON.parse(payload.toString("utf8")); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  const version = deviceProtocolVersion(message.protocolVersion);
  if (version === undefined) return undefined;
  return { version, payload: version === PROTOCOL_VERSION ? payload : Buffer.from(JSON.stringify({ ...message, protocolVersion: PROTOCOL_VERSION })) };
}

/** Released 18 differs from 19 in execution.tasks and the execution-domain tasks field.
 * Project only those known additions; never recursively strip arbitrary user/tool data. */
export function encodeDeviceResponse(payload: Uint8Array, version: DeviceProtocolVersion): Uint8Array | undefined {
  if (version === PROTOCOL_VERSION) return payload;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload).toString("utf8")); } catch { return payload; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return payload;
  const message = value as Record<string, unknown>;
  if ("protocolVersion" in message && message.protocolVersion !== PROTOCOL_VERSION) throw new Error("Invalid canonical device response version");
  if (message.type === "runtime.event" && (message.event as { type?: unknown } | undefined)?.type === "execution.tasks") return undefined;
  const projected = { ...message };
  if ("protocolVersion" in projected) projected.protocolVersion = version;
  if (projected.type === "agent.state.snapshot" && Array.isArray(projected.domains)) {
    projected.domains = projected.domains.map((domain: Record<string, unknown>) => {
      if (domain.domain !== "execution" || !domain.value || typeof domain.value !== "object" || Array.isArray(domain.value)) return domain;
      const value = { ...domain.value } as Record<string, unknown>;
      delete value.tasks;
      return { ...domain, value };
    });
  }
  return Buffer.from(JSON.stringify(projected));
}

export function convertDeviceBinary(payload: Uint8Array, from: DeviceProtocolVersion, to: DeviceProtocolVersion): Uint8Array {
  // Decode and re-encode the complete validated frame; never patch a version byte blindly.
  const frame = decodeArtifactChunkFrame(payload, from);
  return from === to ? payload : encodeArtifactChunkFrame(frame, to);
}
