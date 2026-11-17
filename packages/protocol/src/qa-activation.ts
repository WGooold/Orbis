/** QA-ACT-01: private package metadata, never a new wire authentication protocol. */
export interface QaActivation {
  version: 1;
  environmentId: string;
  relayUrl: string;
  credential: string;
}

/** Errors deliberately name fields rather than echoing private input. */
export function parseQaActivation(value: unknown): QaActivation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid QA activation file");
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error("Unsupported QA activation version");
  if (typeof input.environmentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.environmentId)) {
    throw new Error("Invalid QA environmentId");
  }
  // eslint-disable-next-line no-control-regex -- Reject ASCII control characters from private QA credentials.
  if (typeof input.credential !== "string" || input.credential.length < 16 || input.credential.length > 512 || /[\s\x00-\x1f\x7f]/u.test(input.credential)) {
    throw new Error("Invalid QA activation credential");
  }
  let relay: URL;
  try { relay = new URL(typeof input.relayUrl === "string" ? input.relayUrl : ""); }
  catch { throw new Error("Invalid QA relayUrl"); }
  if (!["ws:", "wss:"].includes(relay.protocol) || relay.username || relay.password || relay.search || relay.hash ||
      (relay.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(relay.hostname))) {
    throw new Error("QA relayUrl must use WSS (or loopback WS)");
  }
  return { version: 1, environmentId: input.environmentId, relayUrl: input.relayUrl as string, credential: input.credential };
}
