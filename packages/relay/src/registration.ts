import { createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, randomInt, timingSafeEqual, type KeyObject } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hostRecoveryProof } from "@orbis/protocol";

export type VerificationMail = { email: string; code: string; expiresInMinutes: number };
export type RegistrationOptions = {
  stateFile?: string;
  sendMail?: (mail: VerificationMail) => Promise<void>;
  now?: () => number;
};
// `hostPub` (HOST-ACT-15): the Host's long-term X25519 public key, recorded once by an activation or by an
// authenticated credential holder. Possession of the matching private key can later replace a lost credential.
type HostRegistration = { email: string | null; hostId: string; credentialHash: string; verifiedAt: number | null; registeredAt: number; activationResetAt?: number; hostPub?: string };
type RecoveryChallenge = { id: string; hostId: string; privateKey: KeyObject; expiresAt: number };
type Challenge = { id: string; email: string; hostId: string; digest: Buffer; expiresAt: number; attempts: number };
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
const CODE_TTL = 10 * 60_000;
const RECOVERY_TTL = 2 * 60_000;

export class RegistrationError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function normalizeQqEmail(value: unknown): string {
  if (typeof value !== "string") throw new RegistrationError(400, "qq_email_required");
  const email = value.trim().toLowerCase();
  // QQ accepts both numeric addresses and mailbox aliases; foxmail.com is deliberately excluded.
  if (email.length > 100 || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@qq\.com$/.test(email)) {
    throw new RegistrationError(400, "qq_email_required");
  }
  return email;
}

function hostKey(value: unknown): KeyObject | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  try { return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: value }, format: "jwk" }); } catch { return undefined; }
}

function optionalHostPub(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!hostKey(value)) throw new RegistrationError(400, "invalid_host_key");
  return value as string;
}

function validHostId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) {
    throw new RegistrationError(400, "invalid_host_id");
  }
  return value;
}

/** Every registration issues a credential for exactly one Host, never a Relay administrator token. */
export class RegistrationAuthority {
  readonly #options: RegistrationOptions;
  readonly #hosts = new Map<string, HostRegistration>();
  readonly #challenges = new Map<string, Challenge>();
  readonly #lastEmail = new Map<string, number>();
  readonly #requests = new Map<string, { count: number; until: number }>();
  readonly #directRequests = new Map<string, { count: number; until: number }>();
  readonly #recoveries = new Map<string, RecoveryChallenge>();
  readonly #recoveryRequests = new Map<string, { count: number; until: number }>();
  #persistence = Promise.resolve();

  private constructor(options: RegistrationOptions) { this.#options = options; }

  static async create(options: RegistrationOptions): Promise<RegistrationAuthority> {
    const authority = new RegistrationAuthority(options);
    if (options.stateFile) {
      try {
        const stored = JSON.parse(await readFile(options.stateFile, "utf8")) as { version: number; hosts: HostRegistration[] };
        if (![1, 2].includes(stored.version) || !Array.isArray(stored.hosts)) throw new Error("Invalid registration state");
        for (const host of stored.hosts) {
          if (host.email !== null) normalizeQqEmail(host.email);
          validHostId(host.hostId);
          const registeredAt = stored.version === 1 ? host.verifiedAt : host.registeredAt;
          if (!/^[a-f0-9]{64}$/.test(host.credentialHash) || !Number.isFinite(registeredAt) ||
              (host.email === null ? host.verifiedAt !== null : !Number.isFinite(host.verifiedAt)) ||
              (host.activationResetAt !== undefined && !Number.isFinite(host.activationResetAt)) ||
              (host.hostPub !== undefined && !hostKey(host.hostPub))) throw new Error("Invalid registered Host");
          authority.#hosts.set(host.hostId, { ...host, registeredAt: registeredAt! });
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return authority;
  }

  get enabled(): boolean { return this.#options.sendMail !== undefined; }
  hasHost(hostId: string): boolean { return this.#hosts.has(hostId); }
  recoveryForHost(hostId: string): "email" | "administrator" | undefined {
    const host = this.#hosts.get(hostId);
    return host === undefined ? undefined : host.email === null ? "administrator" : "email";
  }
  listHosts(): Array<Omit<HostRegistration, "credentialHash">> {
    return [...this.#hosts.values()].map(({ email, hostId, verifiedAt, registeredAt, activationResetAt }) => ({ email, hostId, verifiedAt, registeredAt,
      ...(activationResetAt === undefined ? {} : { activationResetAt }) }));
  }
  hostForCredential(credential: string): string | undefined {
    if (!credential.startsWith("orbis_host_") || credential.length > 128) return undefined;
    const candidate = digest(credential);
    for (const host of this.#hosts.values()) {
      if (host.activationResetAt !== undefined) continue;
      if (timingSafeEqual(Buffer.from(host.credentialHash, "hex"), candidate)) return host.hostId;
    }
    return undefined;
  }

  /** Only the authenticated operator route may authorize a fresh activation. */
  async resetHost(hostId: string): Promise<void> {
    const save = async (): Promise<void> => {
      const previous = this.#hosts.get(hostId);
      if (!previous) throw new RegistrationError(404, "host_not_found");
      // Retain the visible registration and its ownership metadata. No credential
      // is issued here; only the next policy-compliant activation may replace it.
      // A reset revokes every earlier authority over the Host, including its recorded key.
      const pending: HostRegistration = { ...previous, credentialHash: randomBytes(32).toString("hex"), activationResetAt: this.#options.now?.() ?? Date.now() };
      delete pending.hostPub;
      const hosts = new Map(this.#hosts).set(hostId, pending);
      if (this.#options.stateFile) {
        const path = this.#options.stateFile;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify({ version: 2, hosts: [...hosts.values()] }), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      }
      this.#hosts.set(hostId, pending);
      for (const [id, challenge] of this.#challenges) if (challenge.hostId === hostId) this.#challenges.delete(id);
      for (const [id, challenge] of this.#recoveries) if (challenge.hostId === hostId) this.#recoveries.delete(id);
    };
    const pending = this.#persistence.then(save);
    this.#persistence = pending.catch(() => {});
    await pending;
  }

  async requestCode(body: { email?: unknown; hostId?: unknown }, source: string): Promise<{ challengeId: string; expiresInSeconds: number; retryAfterSeconds: number }> {
    const email = normalizeQqEmail(body.email);
    const hostId = validHostId(body.hostId);
    if (!this.#options.sendMail) throw new RegistrationError(503, "registration_unavailable");
    const now = this.#options.now?.() ?? Date.now();
    for (const [id, challenge] of this.#challenges) if (challenge.expiresAt <= now) this.#challenges.delete(id);
    for (const [key, time] of this.#lastEmail) if (time + 60_000 <= now) this.#lastEmail.delete(key);
    for (const [key, rate] of this.#requests) if (rate.until <= now) this.#requests.delete(key);
    if (this.#lastEmail.has(email)) throw new RegistrationError(429, "code_cooldown");
    if (this.#challenges.size >= 10_000) throw new RegistrationError(503, "registration_busy");
    for (const key of [`ip:${source}`, `email:${email}`]) {
      const previous = this.#requests.get(key);
      if (previous && previous.count >= (key.startsWith("ip:") ? 30 : 6)) throw new RegistrationError(429, "too_many_requests");
    }
    this.#lastEmail.set(email, now);
    for (const key of [`ip:${source}`, `email:${email}`]) {
      const previous = this.#requests.get(key);
      this.#requests.set(key, { count: (previous?.count ?? 0) + 1, until: previous?.until ?? now + 3_600_000 });
    }
    const id = randomBytes(24).toString("base64url");
    const code = String(randomInt(100_000, 1_000_000));
    // Invalidate older challenges for this mailbox and computer, including in-flight send attempts.
    for (const [key, challenge] of this.#challenges) if (challenge.email === email && challenge.hostId === hostId) this.#challenges.delete(key);
    const challenge: Challenge = { id, email, hostId, digest: digest(`${id}:${code}`), expiresAt: now + CODE_TTL, attempts: 0 };
    this.#challenges.set(id, challenge);
    try { await this.#options.sendMail({ email, code, expiresInMinutes: CODE_TTL / 60_000 }); }
    catch { this.#challenges.delete(id); throw new RegistrationError(502, "verification_delivery_failed"); }
    return { challengeId: id, expiresInSeconds: CODE_TTL / 1_000, retryAfterSeconds: 60 };
  }

  async activate(body: { email?: unknown; hostId?: unknown; challengeId?: unknown; code?: unknown; hostPub?: unknown }, source = "unknown", verificationRequired: () => boolean = () => true): Promise<{ email: string | null; hostId: string; credential: string }> {
    const hostId = validHostId(body.hostId);
    const hostPub = optionalHostPub(body.hostPub);
    const now = this.#options.now?.() ?? Date.now();
    let email: string | null = null;
    const direct = body.challengeId === undefined && body.code === undefined;
    if (direct) {
      if (verificationRequired()) throw new RegistrationError(403, "email_verification_required");
      for (const [key, rate] of this.#directRequests) if (rate.until <= now) this.#directRequests.delete(key);
      const previous = this.#directRequests.get(source);
      if ((previous?.count ?? 0) >= 30 || (!previous && this.#directRequests.size >= 10_000)) throw new RegistrationError(429, "too_many_requests");
      this.#directRequests.set(source, { count: (previous?.count ?? 0) + 1, until: previous?.until ?? now + 3_600_000 });
    } else {
      email = normalizeQqEmail(body.email);
      const challenge = typeof body.challengeId === "string" ? this.#challenges.get(body.challengeId) : undefined;
      if (!challenge || challenge.email !== email || challenge.hostId !== hostId || challenge.expiresAt <= now || challenge.attempts >= 5) {
        throw new RegistrationError(401, "invalid_verification_code");
      }
      challenge.attempts++;
      if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code) || !timingSafeEqual(challenge.digest, digest(`${challenge.id}:${body.code}`))) {
        if (challenge.attempts >= 5) this.#challenges.delete(challenge.id);
        throw new RegistrationError(401, "invalid_verification_code");
      }
      this.#challenges.delete(challenge.id); // Consume before any await: a code can issue exactly one credential.
    }
    const credential = `orbis_host_${randomBytes(32).toString("base64url")}`;
    const save = async (): Promise<void> => {
      // A queued activation must still obey the policy in force when it is saved.
      if (direct && verificationRequired()) throw new RegistrationError(403, "email_verification_required");
      const previous = this.#hosts.get(hostId);
      if (previous && previous.activationResetAt === undefined && (direct || previous.email !== email)) throw new RegistrationError(409, "host_already_registered");
      // The first recorded key stays authoritative; an older client's activation adds none.
      const key = previous?.hostPub ?? hostPub;
      const registered: HostRegistration = { email, hostId, credentialHash: digest(credential).toString("hex"), verifiedAt: email === null ? null : now,
        registeredAt: previous?.registeredAt ?? now, ...(key === undefined ? {} : { hostPub: key }) };
      if (this.#options.stateFile) {
        const path = this.#options.stateFile;
        await mkdir(dirname(path), { recursive: true });
        const hosts = new Map(this.#hosts).set(hostId, registered);
        await writeFile(`${path}.tmp`, JSON.stringify({ version: 2, hosts: [...hosts.values()] }), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      }
      this.#hosts.set(hostId, registered);
    };
    const pending = this.#persistence.then(save);
    this.#persistence = pending.catch(() => {});
    await pending;
    return { email, hostId, credential };
  }

  /** HOST-ACT-15: a connected Host records its key once; a different key never replaces it. */
  async bindHostKey(credential: string, value: unknown): Promise<void> {
    const hostPub = optionalHostPub(value);
    if (hostPub === undefined) throw new RegistrationError(400, "invalid_host_key");
    const hostId = this.hostForCredential(credential);
    if (hostId === undefined) throw new RegistrationError(401, "unauthorized");
    await this.#save(hostId, previous => {
      if (!previous || previous.activationResetAt !== undefined || this.hostForCredential(credential) !== hostId) throw new RegistrationError(401, "unauthorized");
      if (previous.hostPub === hostPub) return undefined;
      if (previous.hostPub !== undefined) throw new RegistrationError(409, "host_key_mismatch");
      return { ...previous, hostPub };
    });
  }

  /** A single-use Relay key for one proof by the Host's recorded key; unknown and keyless Hosts have none. */
  recoveryChallenge(body: { hostId?: unknown }, source: string): { challengeId: string; relayPub: string; expiresInSeconds: number } {
    const hostId = validHostId(body.hostId);
    const now = this.#options.now?.() ?? Date.now();
    for (const [id, challenge] of this.#recoveries) if (challenge.expiresAt <= now) this.#recoveries.delete(id);
    for (const [key, rate] of this.#recoveryRequests) if (rate.until <= now) this.#recoveryRequests.delete(key);
    // Limited per source only: a per-Host limit would let anyone who knows a Host ID lock its owner out.
    const previous = this.#recoveryRequests.get(source);
    if ((previous?.count ?? 0) >= 30 || (!previous && this.#recoveryRequests.size >= 10_000)) throw new RegistrationError(429, "too_many_requests");
    this.#recoveryRequests.set(source, { count: (previous?.count ?? 0) + 1, until: previous?.until ?? now + 3_600_000 });
    if (this.#hosts.get(hostId)?.hostPub === undefined) throw new RegistrationError(404, "recovery_unavailable");
    if (this.#recoveries.size >= 10_000) throw new RegistrationError(503, "registration_busy");
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const id = randomBytes(24).toString("base64url");
    this.#recoveries.set(id, { id, hostId, privateKey, expiresAt: now + RECOVERY_TTL });
    return { challengeId: id, relayPub: String(publicKey.export({ format: "jwk" }).x), expiresInSeconds: RECOVERY_TTL / 1_000 };
  }

  /** Replaces the credential of a Host that proves possession of its recorded key; mailbox and policy are unchanged. */
  async recover(body: { hostId?: unknown; challengeId?: unknown; proof?: unknown }): Promise<{ email: string | null; hostId: string; credential: string }> {
    const hostId = validHostId(body.hostId);
    const now = this.#options.now?.() ?? Date.now();
    const challenge = typeof body.challengeId === "string" ? this.#recoveries.get(body.challengeId) : undefined;
    if (challenge) this.#recoveries.delete(challenge.id); // Single use, even when the proof is wrong.
    const recorded = this.#hosts.get(hostId)?.hostPub;
    const key = hostKey(recorded);
    if (!challenge || challenge.hostId !== hostId || challenge.expiresAt <= now || !key || typeof body.proof !== "string") {
      throw new RegistrationError(401, "invalid_recovery_proof");
    }
    let expected: Buffer;
    try { expected = Buffer.from(hostRecoveryProof(diffieHellman({ privateKey: challenge.privateKey, publicKey: key }), hostId, challenge.id), "base64url"); }
    catch { throw new RegistrationError(401, "invalid_recovery_proof"); }
    const proof = Buffer.from(body.proof, "base64url");
    if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) throw new RegistrationError(401, "invalid_recovery_proof");
    const credential = `orbis_host_${randomBytes(32).toString("base64url")}`;
    let email: string | null = null;
    await this.#save(hostId, previous => {
      // The key must still be the one proven: a reset or replacement in between wins.
      if (!previous || previous.hostPub !== recorded) throw new RegistrationError(401, "invalid_recovery_proof");
      email = previous.email;
      const recovered: HostRegistration = { ...previous, credentialHash: digest(credential).toString("hex") };
      delete recovered.activationResetAt; // a pending reset is fulfilled by the new credential
      return recovered;
    });
    return { email, hostId, credential };
  }

  /** Serialized read-modify-write of one registration; `undefined` leaves the state unchanged. */
  async #save(hostId: string, change: (previous: HostRegistration | undefined) => HostRegistration | undefined): Promise<void> {
    const save = async (): Promise<void> => {
      const next = change(this.#hosts.get(hostId));
      if (next === undefined) return;
      if (this.#options.stateFile) {
        const path = this.#options.stateFile;
        await mkdir(dirname(path), { recursive: true });
        const hosts = new Map(this.#hosts).set(hostId, next);
        await writeFile(`${path}.tmp`, JSON.stringify({ version: 2, hosts: [...hosts.values()] }), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      }
      this.#hosts.set(hostId, next);
    };
    const pending = this.#persistence.then(save);
    this.#persistence = pending.catch(() => {});
    await pending;
  }

  async close(): Promise<void> { await this.#persistence; }
}
