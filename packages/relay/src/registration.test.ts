import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { createHash, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import WebSocket from "ws";
import { PROTOCOL_VERSION, hostRecoveryProof } from "@orbis/protocol";
import { RegistrationAuthority, normalizeQqEmail, type VerificationMail } from "./registration.js";
import { createRelayServer, type RelayServer } from "./index.js";
import { verificationMailer } from "./verification-mail.js";

describe("QQ mailbox activation", () => {
  it("accepts QQ numeric and alias mailboxes, excluding other domains and header injection", () => {
    expect(normalizeQqEmail(" 12345678@QQ.COM ")).toBe("12345678@qq.com");
    expect(normalizeQqEmail("developer.name@qq.com")).toBe("developer.name@qq.com");
    for (const email of ["a@foxmail.com", "a@gmail.com", "a@qq.com.evil.test", "a@qq.com\r\nBcc:b@qq.com", "@qq.com"]) expect(() => normalizeQqEmail(email)).toThrow();
  });

  it("issues one host-bound credential after verification, persists hashes, and survives restart without SMTP", async () => {
    const stateFile = join(await testDirectory(join(tmpdir(), "orbis-registration-")), "accounts.json");
    let mail: VerificationMail | undefined;
    const auth = await RegistrationAuthority.create({ stateFile, sendMail: async m => { mail = m; } });
    const challenge = await auth.requestCode({ email: "123456@qq.com", hostId: "host-computer-1" }, "local");
    expect(challenge).not.toHaveProperty("code");
    const request = { email: mail!.email, hostId: "host-computer-1", challengeId: challenge.challengeId, code: mail!.code };
    const activated = await auth.activate(request);
    expect(auth.hostForCredential(activated.credential)).toBe("host-computer-1");
    expect(auth.hostForCredential(activated.credential + "bad")).toBeUndefined();
    await expect(auth.activate(request)).rejects.toMatchObject({ code: "invalid_verification_code" });
    expect(await readFile(stateFile, "utf8")).not.toContain(activated.credential);
    const restarted = await RegistrationAuthority.create({ stateFile });
    expect(restarted.enabled).toBe(false);
    expect(restarted.hostForCredential(activated.credential)).toBe("host-computer-1");
  });

  it("does not allow a code to activate a different Host or email", async () => {
    let code = "";
    const auth = await RegistrationAuthority.create({ sendMail: async mail => { code = mail.code; } });
    const challenge = await auth.requestCode({ email: "123456@qq.com", hostId: "computer-one" }, "local");
    await expect(auth.activate({ ...challenge, email: "123456@qq.com", hostId: "computer-two", code })).rejects.toMatchObject({ status: 401 });
    await expect(auth.activate({ ...challenge, email: "another@qq.com", hostId: "computer-one", code })).rejects.toMatchObject({ status: 401 });
    await expect(auth.activate({ ...challenge, email: "123456@qq.com", hostId: "computer-one", code })).resolves.toHaveProperty("credential");
  });

  it("expires codes and locks out repeated guesses", async () => {
    let now = 1_000_000, code = "";
    const auth = await RegistrationAuthority.create({ now: () => now, sendMail: async mail => { code = mail.code; } });
    const body = { email: "123456@qq.com", hostId: "computer-one" };
    const first = await auth.requestCode(body, "local");
    for (let i = 0; i < 5; i++) await expect(auth.activate({ ...body, ...first, code: "000000" })).rejects.toMatchObject({ status: 401 });
    await expect(auth.activate({ ...body, ...first, code })).rejects.toMatchObject({ status: 401 });
    now += 61_000;
    const second = await auth.requestCode(body, "local");
    now += 600_001;
    await expect(auth.activate({ ...body, ...second, code })).rejects.toMatchObject({ status: 401 });
  });

  it("limits concurrent sends and never exposes SMTP failures or codes", async () => {
    const auth = await RegistrationAuthority.create({ sendMail: async () => { throw new Error("smtp password=secret"); } });
    const body = { email: "123456@qq.com", hostId: "computer-one" };
    const results = await Promise.allSettled([auth.requestCode(body, "local"), auth.requestCode(body, "local")]);
    expect(results).toMatchObject([{ status: "rejected", reason: { code: "verification_delivery_failed" } }, { status: "rejected", reason: { code: "code_cooldown" } }]);
    const disabled = await RegistrationAuthority.create({});
    await expect(disabled.requestCode(body, "local")).rejects.toMatchObject({ status: 503, code: "registration_unavailable" });
    expect(verificationMailer({})).toBeUndefined();
  });

  it("rotates a Host credential only for its verified mailbox", async () => {
    let now = 10_000, code = "";
    const auth = await RegistrationAuthority.create({ now: () => now, sendMail: async mail => { code = mail.code; } });
    const body = { email: "owner@qq.com", hostId: "computer-one" };
    let challenge = await auth.requestCode(body, "local");
    const original = await auth.activate({ ...body, ...challenge, code });
    challenge = await auth.requestCode({ ...body, email: "someone@qq.com" }, "local");
    await expect(auth.activate({ ...body, email: "someone@qq.com", ...challenge, code })).rejects.toMatchObject({ code: "host_already_registered" });
    now += 61_000;
    challenge = await auth.requestCode(body, "local");
    const replacement = await auth.activate({ ...body, ...challenge, code });
    expect(auth.hostForCredential(original.credential)).toBeUndefined();
    expect(auth.hostForCredential(replacement.credential)).toBe(body.hostId);
  });

  it("permits a direct, Host-bound activation only while verification is optional", async () => {
    const stateFile = join(await testDirectory(join(tmpdir(), "orbis-direct-registration-")), "accounts.json");
    const authority = await RegistrationAuthority.create({ stateFile });
    const body = { hostId: "direct-computer" };
    await expect(authority.activate(body, "source", () => true)).rejects.toMatchObject({ code: "email_verification_required" });
    const issued = await authority.activate(body, "source", () => false);
    expect(issued).toMatchObject({ hostId: body.hostId, email: null });
    expect(authority.hostForCredential(issued.credential)).toBe(body.hostId);
    expect(authority.listHosts()[0]).toMatchObject({ hostId: body.hostId, email: null, verifiedAt: null });
    expect(await readFile(stateFile, "utf8")).not.toContain(issued.credential);
    await expect(authority.activate(body, "source", () => false)).rejects.toMatchObject({ code: "host_already_registered" });
    const restarted = await RegistrationAuthority.create({ stateFile });
    expect(restarted.hostForCredential(issued.credential)).toBe(body.hostId);
    await expect(restarted.activate(body, "source", () => true)).rejects.toMatchObject({ code: "email_verification_required" });
  });

  it("reads version 1 verified Hosts and preserves their credentials when writing version 2", async () => {
    const stateFile = join(await testDirectory(join(tmpdir(), "orbis-registration-migration-")), "accounts.json");
    const credential = "orbis_host_existing_credential";
    const hostId = "verified-computer";
    const verifiedAt = 1_700_000_000_000;
    await writeFile(stateFile, JSON.stringify({ version: 1, hosts: [{
      email: "owner@qq.com", hostId,
      credentialHash: createHash("sha256").update(credential).digest("hex"), verifiedAt,
    }] }));
    const authority = await RegistrationAuthority.create({ stateFile });
    expect(authority.hostForCredential(credential)).toBe(hostId);
    expect(authority.listHosts()).toContainEqual({ email: "owner@qq.com", hostId, verifiedAt, registeredAt: verifiedAt });
    await expect(authority.activate({ hostId }, "source", () => false)).rejects.toMatchObject({ code: "host_already_registered" });
    expect(authority.hostForCredential(credential)).toBe(hostId);
    await authority.activate({ hostId: "new-direct-host" }, "source", () => false);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({ version: 2 });
    const restarted = await RegistrationAuthority.create({ stateFile });
    expect(restarted.hostForCredential(credential)).toBe(hostId);
    expect(restarted.listHosts()).toContainEqual({ email: "owner@qq.com", hostId, verifiedAt, registeredAt: verifiedAt });
  });

  it("limits direct activations from one source", async () => {
    const authority = await RegistrationAuthority.create({});
    for (let index = 0; index < 30; index++) {
      await authority.activate({ hostId: `direct-host-${index}` }, "source", () => false);
    }
    await expect(authority.activate({ hostId: "direct-host-extra" }, "source", () => false)).rejects.toMatchObject({ code: "too_many_requests" });
  });

  it("retains a reset registration and follows the current verification policy before replacing its credential", async () => {
    // HOST-ACT-07: operator reset is a persisted recovery authorization, not an
    // automatic replacement. Even a formerly direct Host must obey a new email policy.
    const stateFile = join(await testDirectory(join(tmpdir(), "orbis-registration-reset-")), "accounts.json");
    let code = "";
    const authority = await RegistrationAuthority.create({ stateFile, sendMail: async mail => { code = mail.code; } });
    const hostId = "direct-reset-host";
    const original = await authority.activate({ hostId }, "source", () => false);
    const registeredAt = authority.listHosts()[0]!.registeredAt;
    await authority.resetHost(hostId);
    expect(authority.hostForCredential(original.credential)).toBeUndefined();
    expect(authority.listHosts()).toContainEqual(expect.objectContaining({ hostId, registeredAt, activationResetAt: expect.any(Number) }));
    const restarted = await RegistrationAuthority.create({ stateFile, sendMail: async mail => { code = mail.code; } });
    await expect(restarted.activate({ hostId }, "source", () => true)).rejects.toMatchObject({ code: "email_verification_required" });
    const body = { hostId, email: "owner@qq.com" };
    const challenge = await restarted.requestCode(body, "source");
    const replacement = await restarted.activate({ ...body, ...challenge, code }, "source", () => true);
    expect(restarted.hostForCredential(replacement.credential)).toBe(hostId);
    expect(restarted.hostForCredential(original.credential)).toBeUndefined();
    expect(restarted.listHosts()[0]).toMatchObject({ hostId, email: body.email, registeredAt });
    expect(restarted.listHosts()[0]).not.toHaveProperty("activationResetAt");
    await expect(restarted.activate({ hostId }, "source", () => false)).rejects.toMatchObject({ code: "host_already_registered" });
  });
});

describe("Host key recovery (HOST-ACT-15)", () => {
  // A lost credential must stay recoverable by the computer that still holds its Host key, whatever
  // mailbox or direct path registered it; nobody else may use that path, and each challenge works once.
  const hostKeys = (): { privateKey: KeyObject; hostPub: string } => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    return { privateKey, hostPub: String(publicKey.export({ format: "jwk" }).x) };
  };
  const prove = (privateKey: KeyObject, hostId: string, challenge: { challengeId: string; relayPub: string }): string =>
    hostRecoveryProof(diffieHellman({ privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: challenge.relayPub }, format: "jwk" }) }), hostId, challenge.challengeId);

  it("replaces a lost direct credential only for the recorded key, once per challenge, and persists the key", async () => {
    const stateFile = join(await testDirectory(join(tmpdir(), "orbis-registration-recovery-")), "accounts.json");
    let now = 1_000_000;
    const authority = await RegistrationAuthority.create({ stateFile, now: () => now });
    const hostId = "recoverable-host";
    const owner = hostKeys(), other = hostKeys();
    const original = await authority.activate({ hostId, hostPub: owner.hostPub }, "source", () => false);
    await expect(authority.activate({ hostId }, "source", () => false)).rejects.toMatchObject({ code: "host_already_registered" });
    const refused = authority.recoveryChallenge({ hostId }, "source");
    await expect(authority.recover({ hostId, challengeId: refused.challengeId, proof: prove(other.privateKey, hostId, refused) })).rejects.toMatchObject({ code: "invalid_recovery_proof" });
    // The refused challenge is spent even for the right key.
    await expect(authority.recover({ hostId, challengeId: refused.challengeId, proof: prove(owner.privateKey, hostId, refused) })).rejects.toMatchObject({ code: "invalid_recovery_proof" });
    const expired = authority.recoveryChallenge({ hostId }, "source");
    now += expired.expiresInSeconds * 1_000;
    await expect(authority.recover({ hostId, challengeId: expired.challengeId, proof: prove(owner.privateKey, hostId, expired) })).rejects.toMatchObject({ code: "invalid_recovery_proof" });
    const foreign = authority.recoveryChallenge({ hostId }, "source");
    await expect(authority.recover({ hostId: "another-host", challengeId: foreign.challengeId, proof: prove(owner.privateKey, "another-host", foreign) })).rejects.toMatchObject({ code: "invalid_recovery_proof" });
    const challenge = authority.recoveryChallenge({ hostId }, "source");
    const recovered = await authority.recover({ hostId, challengeId: challenge.challengeId, proof: prove(owner.privateKey, hostId, challenge) });
    expect(recovered).toMatchObject({ hostId, email: null });
    expect(authority.hostForCredential(recovered.credential)).toBe(hostId);
    expect(authority.hostForCredential(original.credential)).toBeUndefined();
    expect(await readFile(stateFile, "utf8")).not.toContain(recovered.credential);
    const restarted = await RegistrationAuthority.create({ stateFile, now: () => now });
    expect(restarted.hostForCredential(recovered.credential)).toBe(hostId);
    const again = restarted.recoveryChallenge({ hostId }, "source");
    expect(restarted.hostForCredential((await restarted.recover({ hostId, challengeId: again.challengeId, proof: prove(owner.privateKey, hostId, again) })).credential)).toBe(hostId);
    expect(() => restarted.recoveryChallenge({ hostId: "unknown-host" }, "source")).toThrow(expect.objectContaining({ code: "recovery_unavailable" }));
  });

  it("records a registered Host's key once from its credential, keeps it across mailbox rotation, and drops it on reset", async () => {
    let code = "";
    let now = 1_000_000;
    const authority = await RegistrationAuthority.create({ sendMail: async mail => { code = mail.code; }, now: () => now });
    const hostId = "legacy-mailbox-host";
    const body = { hostId, email: "owner@qq.com" };
    const verify = async (hostPub?: string) => {
      now += 61_000; // past the per-mailbox resend interval
      const challenge = await authority.requestCode(body, "source");
      return await authority.activate({ ...body, ...challenge, code, ...(hostPub === undefined ? {} : { hostPub }) });
    };
    // A released desktop activates without a key: no recovery path yet.
    const legacy = await verify();
    expect(() => authority.recoveryChallenge({ hostId }, "source")).toThrow(expect.objectContaining({ code: "recovery_unavailable" }));
    const owner = hostKeys(), other = hostKeys();
    await expect(authority.bindHostKey("orbis_host_unknown", owner.hostPub)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(authority.bindHostKey(legacy.credential, "not-a-key")).rejects.toMatchObject({ code: "invalid_host_key" });
    await authority.bindHostKey(legacy.credential, owner.hostPub);
    await authority.bindHostKey(legacy.credential, owner.hostPub);
    await expect(authority.bindHostKey(legacy.credential, other.hostPub)).rejects.toMatchObject({ code: "host_key_mismatch" });
    // Mailbox rotation offering another key keeps the recorded one.
    const rotated = await verify(other.hostPub);
    expect(authority.hostForCredential(legacy.credential)).toBeUndefined();
    const refused = authority.recoveryChallenge({ hostId }, "source");
    await expect(authority.recover({ hostId, challengeId: refused.challengeId, proof: prove(other.privateKey, hostId, refused) })).rejects.toMatchObject({ code: "invalid_recovery_proof" });
    const challenge = authority.recoveryChallenge({ hostId }, "source");
    const recovered = await authority.recover({ hostId, challengeId: challenge.challengeId, proof: prove(owner.privateKey, hostId, challenge) });
    expect(recovered.email).toBe("owner@qq.com");
    expect(authority.hostForCredential(rotated.credential)).toBeUndefined();
    await authority.resetHost(hostId);
    expect(() => authority.recoveryChallenge({ hostId }, "source")).toThrow(expect.objectContaining({ code: "recovery_unavailable" }));
    await expect(authority.bindHostKey(recovered.credential, owner.hostPub)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("limits recovery challenges per source without letting other sources lock a Host out", async () => {
    const authority = await RegistrationAuthority.create({});
    const owner = hostKeys();
    await authority.activate({ hostId: "limited-host", hostPub: owner.hostPub }, "source", () => false);
    // Probing unknown Hosts spends the prober's own allowance.
    for (let index = 0; index < 30; index++) expect(() => authority.recoveryChallenge({ hostId: `probe-host-${index}` }, "probe")).toThrow();
    expect(() => authority.recoveryChallenge({ hostId: "limited-host" }, "probe")).toThrow(expect.objectContaining({ code: "too_many_requests" }));
    for (let index = 0; index < 40; index++) authority.recoveryChallenge({ hostId: "limited-host" }, `attacker-${index}`);
    const challenge = authority.recoveryChallenge({ hostId: "limited-host" }, "owner");
    expect(authority.hostForCredential((await authority.recover({ hostId: "limited-host", challengeId: challenge.challengeId, proof: prove(owner.privateKey, "limited-host", challenge) })).credential)).toBe("limited-host");
  });
});

describe("registered Host Relay routes", () => {
  let relay: RelayServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await relay?.close(); });
  async function socketMessage(path: string, message: unknown): Promise<{ socket: WebSocket; message: any }> {
    const socket = new WebSocket(`${relay!.url}${path}`); sockets.push(socket);
    await once(socket, "open");
    const next = once(socket, "message"); socket.send(JSON.stringify(message));
    return { socket, message: JSON.parse(String((await next)[0])) };
  }
  async function setup(): Promise<{ hostId: string; credential: string; base: string }> {
    let code = "";
    const registration = await RegistrationAuthority.create({ sendMail: async mail => { code = mail.code; } });
    relay = await createRelayServer({ registration, adminToken: "legacy-admin", runtimeCredentials: ["legacy-runtime"] });
    const base = relay.url.replace("ws:", "http:");
    const body = { email: "owner@qq.com", hostId: "registered-computer" };
    const sent = await fetch(`${base}/v1/registration/code`, { method: "POST", body: JSON.stringify(body) });
    expect(sent.status).toBe(202);
    const challenge = await sent.json() as object;
    const activated = await fetch(`${base}/v1/registration/activate`, { method: "POST", body: JSON.stringify({ ...body, ...challenge, code }) });
    expect(activated.status).toBe(201);
    expect(activated.headers.get("cache-control")).toBe("no-store");
    return { ...await activated.json() as { hostId: string; credential: string }, base };
  }
  it("a verified Host can connect and create pairing codes but cannot become an administrator or impersonate another Host", async () => {
    const { hostId, credential, base } = await setup();
    const authenticate = (id: string, key: string) => ({ type: "runtime.authenticate", role: "host", protocolVersion: PROTOCOL_VERSION, credential: key, runtime: { runtimeId: id, name: "desktop", cwd: "/", status: "idle" } });
    expect((await socketMessage("/v1/runtime", authenticate(hostId, credential))).message.type).toBe("runtime.ready");
    expect((await socketMessage("/v1/runtime", authenticate("other-computer", credential))).message.code).toBe("unauthorized");
    expect((await socketMessage("/v1/runtime", authenticate(hostId, "legacy-runtime"))).message.code).toBe("unauthorized");
    const headers = { authorization: `Bearer ${credential}` };
    expect((await fetch(`${base}/v1/devices`, { headers })).status).toBe(401);
    const paired = await fetch(`${base}/v1/pairing-codes`, { method: "POST", headers });
    expect(paired.status).toBe(201);
    const { code } = await paired.json() as { code: string };
    const deviceResponse = await fetch(`${base}/v1/pairings`, { method: "POST", body: JSON.stringify({ code, deviceName: "phone" }) });
    const device = await deviceResponse.json() as { deviceId: string; credential: string };
    const connected = await socketMessage("/v1/device", { type: "device.authenticate", protocolVersion: PROTOCOL_VERSION, credential: device.credential });
    const next = once(connected.socket, "message");
    connected.socket.send(JSON.stringify({ type: "v2.frame", protocolVersion: PROTOCOL_VERSION, envelope: { v: 2, hdr: { k: "data", room: "other-computer", from: device.deviceId, to: "other-computer", n: 1, ch: "ctl" }, ct: "opaque" } }));
    expect(JSON.parse(String((await next)[0])).code).toBe("runtime_mismatch");
  });
  it("routes key recording and recovery: the recovered credential connects and the lost one is refused", async () => {
    // HOST-ACT-15 over HTTP, as the desktop calls it.
    const { hostId, credential, base } = await setup();
    expect(await (await fetch(`${base}/v1/registration/status`)).json()).toMatchObject({ hostKeyRecovery: true });
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    expect((await post("/v1/registration/recovery-challenge", { hostId })).status).toBe(404);
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const hostPub = String(publicKey.export({ format: "jwk" }).x);
    expect((await post("/v1/registration/host-key", { hostPub })).status).toBe(401);
    expect((await post("/v1/registration/host-key", { hostPub }, { authorization: `Bearer ${credential}` })).status).toBe(200);
    const challengeResponse = await post("/v1/registration/recovery-challenge", { hostId });
    expect(challengeResponse.status).toBe(201);
    expect(challengeResponse.headers.get("cache-control")).toBe("no-store");
    const challenge = await challengeResponse.json() as { challengeId: string; relayPub: string };
    const proof = hostRecoveryProof(diffieHellman({ privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: challenge.relayPub }, format: "jwk" }) }), hostId, challenge.challengeId);
    expect((await post("/v1/registration/recover", { hostId, challengeId: challenge.challengeId, proof: proof.replace(/^./, proof[0] === "A" ? "B" : "A") })).status).toBe(401);
    const retry = await (await post("/v1/registration/recovery-challenge", { hostId })).json() as { challengeId: string; relayPub: string };
    const recoveredResponse = await post("/v1/registration/recover", { hostId, challengeId: retry.challengeId,
      proof: hostRecoveryProof(diffieHellman({ privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: retry.relayPub }, format: "jwk" }) }), hostId, retry.challengeId) });
    expect(recoveredResponse.status).toBe(201);
    const recovered = await recoveredResponse.json() as { hostId: string; credential: string; email: string | null };
    expect(recovered).toMatchObject({ hostId, email: "owner@qq.com" });
    const authenticate = (key: string) => ({ type: "runtime.authenticate", role: "host", protocolVersion: PROTOCOL_VERSION, credential: key, runtime: { runtimeId: hostId, name: "desktop", cwd: "/", status: "idle" } });
    expect((await socketMessage("/v1/runtime", authenticate(credential))).message.code).toBe("unauthorized");
    expect((await socketMessage("/v1/runtime", authenticate(recovered.credential))).message.type).toBe("runtime.ready");
  });
  it("missing SMTP exposes a clear unavailable status without issuing any credentials", async () => {
    relay = await createRelayServer({ registration: await RegistrationAuthority.create({}) });
    const base = relay.url.replace("ws:", "http:");
    expect(await (await fetch(`${base}/v1/registration/status`)).json()).toMatchObject({ enabled: false, emailDomain: "qq.com", qqEmailVerificationRequired: true, mailConfigured: false });
    const sent = await fetch(`${base}/v1/registration/code`, { method: "POST", body: JSON.stringify({ email: "owner@qq.com", hostId: "computer-one" }) });
    expect(sent.status).toBe(503);
    expect(await sent.json()).toEqual({ error: "registration_unavailable" });
  });
});
