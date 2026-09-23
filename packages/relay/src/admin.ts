import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { HttpError, requestSource } from "./http-utils.js";

const hash = (value: string): Buffer => createHash("sha256").update(value).digest();
const COOKIE = "orbis_relay_admin";
const SESSION_TTL = 8 * 60 * 60_000;
type Session = { csrf: string; expiresAt: number };
export type AuditEvent = { at: number; action: string; target: string };
type AdminState = { version: 1; disabledHosts: string[]; events: AuditEvent[]; qqEmailVerificationRequired: boolean };

/** Browser sessions are short lived; the administrator's long-lived token never enters browser storage. */
export class RelayAdmin {
  readonly #tokenHash: Buffer | undefined;
  readonly #sessions = new Map<string, Session>();
  readonly #attempts = new Map<string, { count: number; until: number }>();
  #state: AdminState = { version: 1, disabledHosts: [], events: [], qqEmailVerificationRequired: true };
  #persistence = Promise.resolve();

  private constructor(private readonly options: { token?: string; stateFile?: string; trustProxy?: boolean; now?: () => number }) {
    this.#tokenHash = options.token ? hash(options.token) : undefined;
  }

  static async create(options: { token?: string; stateFile?: string; trustProxy?: boolean; now?: () => number }): Promise<RelayAdmin> {
    const admin = new RelayAdmin(options);
    if (options.stateFile) {
      try {
        const state = JSON.parse(await readFile(options.stateFile, "utf8")) as AdminState;
        if (state.version !== 1 || !Array.isArray(state.disabledHosts) || !state.disabledHosts.every(id => typeof id === "string") ||
            !Array.isArray(state.events) || !state.events.every(event => Number.isFinite(event.at) && typeof event.action === "string" && typeof event.target === "string")) throw new Error("Invalid admin state");
        if (state.qqEmailVerificationRequired !== undefined && typeof state.qqEmailVerificationRequired !== "boolean") throw new Error("Invalid registration policy");
        admin.#state = { ...state, events: state.events.slice(-200), qqEmailVerificationRequired: state.qqEmailVerificationRequired ?? true };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return admin;
  }

  #now(): number { return this.options.now?.() ?? Date.now(); }
  get enabled(): boolean { return this.#tokenHash !== undefined; }
  get qqEmailVerificationRequired(): boolean { return this.#state.qqEmailVerificationRequired; }
  isDisabled(hostId: string): boolean { return this.#state.disabledHosts.includes(hostId); }
  disabledHosts(): string[] { return [...this.#state.disabledHosts]; }
  events(): AuditEvent[] { return this.#state.events.map(event => ({ ...event })).reverse(); }

  #sameOrigin(request: IncomingMessage): void {
    try {
      const origin = new URL(request.headers.origin ?? "");
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
      if (origin.host === request.headers.host && (origin.protocol === "https:" || (local && origin.protocol === "http:"))) return;
    } catch { /* Fail closed for missing, opaque, or malformed origins. */ }
    throw new HttpError(403, "invalid_origin");
  }

  #sessionId(request: IncomingMessage): string {
    const value = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) ?? "";
    return /^[a-zA-Z0-9_-]{43}$/.test(value) ? hash(value).toString("hex") : "";
  }

  #cookie(request: IncomingMessage, response: ServerResponse, value: string, maxAge: number): void {
    const host = (request.headers.host ?? "").split(":")[0];
    const local = host === "localhost" || host === "127.0.0.1" || request.headers.host?.startsWith("[::1]");
    response.setHeader("set-cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local ? "" : "; Secure"}`);
  }

  login(request: IncomingMessage, response: ServerResponse, token: unknown): Session {
    this.#sameOrigin(request);
    if (!this.enabled) throw new HttpError(503, "admin_unavailable");
    const now = this.#now();
    for (const [key, session] of this.#sessions) if (session.expiresAt <= now) this.#sessions.delete(key);
    for (const [key, rate] of this.#attempts) if (rate.until <= now) this.#attempts.delete(key);
    const source = requestSource(request, this.options.trustProxy);
    const rate = this.#attempts.get(source);
    if ((rate?.count ?? 0) >= 10 || this.#attempts.size >= 10_000) throw new HttpError(429, "too_many_attempts");
    this.#attempts.set(source, { count: (rate?.count ?? 0) + 1, until: rate?.until ?? now + 15 * 60_000 });
    if (typeof token !== "string" || token.length > 4096 || !timingSafeEqual(this.#tokenHash!, hash(token))) throw new HttpError(401, "unauthorized");
    this.#attempts.delete(source);
    this.#sessions.delete(this.#sessionId(request));
    if (this.#sessions.size >= 100) throw new HttpError(503, "admin_busy");
    const id = randomBytes(32).toString("base64url");
    const session = { csrf: randomBytes(32).toString("base64url"), expiresAt: now + SESSION_TTL };
    this.#sessions.set(hash(id).toString("hex"), session);
    this.#cookie(request, response, id, SESSION_TTL / 1000);
    return session;
  }

  authenticate(request: IncomingMessage, mutation = false): Session {
    const key = this.#sessionId(request);
    const session = this.#sessions.get(key);
    if (!session || session.expiresAt <= this.#now()) { this.#sessions.delete(key); throw new HttpError(401, "unauthorized"); }
    if (mutation) {
      this.#sameOrigin(request);
      const csrf = request.headers["x-orbis-csrf"];
      if (typeof csrf !== "string" || !timingSafeEqual(hash(csrf), hash(session.csrf))) throw new HttpError(403, "invalid_csrf");
    }
    return session;
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    this.authenticate(request, true);
    this.#sessions.delete(this.#sessionId(request));
    this.#cookie(request, response, "", 0);
  }

  async record(action: string, target: string, changes: { disabled?: boolean; qqEmailVerificationRequired?: boolean } = {}): Promise<void> {
    const save = async (): Promise<void> => {
      const { disabled } = changes;
      const state: AdminState = {
        version: 1,
        qqEmailVerificationRequired: changes.qqEmailVerificationRequired ?? this.#state.qqEmailVerificationRequired,
        disabledHosts: disabled === undefined ? [...this.#state.disabledHosts] : disabled ? [...new Set([...this.#state.disabledHosts, target])] : this.#state.disabledHosts.filter(id => id !== target),
        events: [...this.#state.events, { at: this.#now(), action, target }].slice(-200),
      };
      if (this.options.stateFile) {
        await mkdir(dirname(this.options.stateFile), { recursive: true });
        await writeFile(`${this.options.stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
        await rename(`${this.options.stateFile}.tmp`, this.options.stateFile);
      }
      this.#state = state;
    };
    const pending = this.#persistence.then(save);
    this.#persistence = pending.catch(() => {});
    await pending;
  }

  async close(): Promise<void> { this.#sessions.clear(); await this.#persistence; }
}
