// Review-only adapter. Never installed by production Host or Relay entrypoints.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { acceptPairRequest, buildPairEnvelope, buildPairingQrPayload, encodePairingQrText,
  fromBase64Url, privateKeyFromRaw, readPairEnvelope } from "@orbis/e2e";

export async function createFixedReviewPairing({ host, identity, accessPath, publicRelayUrl }) {
  let access;
  try { access = JSON.parse(await readFile(accessPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    access = { version: 1, code: randomBytes(24).toString("base64url"), psk: randomBytes(32).toString("base64url") };
    await writeFile(accessPath, JSON.stringify(access), { mode: 0o600, flag: "wx" });
  }
  const psk = fromBase64Url(access.psk, "review pairing secret");
  if (access.version !== 1 || !/^[A-Za-z0-9_-]{32}$/u.test(access.code) || psk.length !== 32) throw new Error("Invalid saved review pairing access");
  const expiresAt = Math.floor(Date.UTC(2099, 0, 1) / 1000);
  const payload = buildPairingQrPayload({ relayUrl: publicRelayUrl, code: access.code,
    hostId: identity.hostId, hostName: identity.hostName, hostPublicRaw: identity.publicRaw, psk, expiresAt });
  const hostPrivateKey = privateKeyFromRaw(identity.privateRaw);
  // Replace only this disposable Host instance's public pairing acceptor.
  // Normal Hosts keep their original short-lived, one-use pairing windows.
  host.pairing.acceptFrame = envelope => {
    const request = readPairEnvelope(envelope);
    if (request.type !== "pair-request" || request.deviceId !== envelope.hdr.from || envelope.hdr.to !== identity.hostId) throw new Error("Invalid review pairing request");
    const result = acceptPairRequest({ hostPrivateKey, request, window: {
      hostId: identity.hostId, hostPublicRaw: identity.publicRaw, psk: Buffer.from(psk),
      expiresAtMs: expiresAt * 1000, used: false,
    } });
    if (!result.ok) throw new Error(result.message);
    return { accept: buildPairEnvelope({ room: envelope.hdr.room, from: identity.hostId, to: envelope.hdr.from, body: result.accept }),
      device: { deviceId: result.device.deviceId, devicePub: result.device.devicePub, pskRoot: result.device.pskRoot,
        label: "Apple review", createdAt: Math.floor(Date.now() / 1000), revoked: false } };
  };
  return { payload, text: encodePairingQrText(payload), code: access.code,
    pagePath: `/${access.code}/`, dispose: () => psk.fill(0) };
}
