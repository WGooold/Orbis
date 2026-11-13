import { createHmac } from "node:crypto";

/** HOST-ACT-15: binds a Host key proof to one Host ID and one Relay recovery challenge. */
export const HOST_RECOVERY_PROOF_LABEL = "orbis-host-recovery/v1";

/**
 * Proof that the holder of a Host's long-term X25519 key answered one Relay challenge:
 * base64url(HMAC-SHA256(X25519(Host key, Relay challenge key), label|hostId|challengeId)).
 * The Host computes it with its private key; the Relay with the challenge's private key.
 */
export function hostRecoveryProof(sharedSecret: Uint8Array, hostId: string, challengeId: string): string {
  return createHmac("sha256", sharedSecret).update(`${HOST_RECOVERY_PROOF_LABEL}|${hostId}|${challengeId}`).digest("base64url");
}
