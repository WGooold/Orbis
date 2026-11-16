import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AgentKindSchema } from "@orbis/protocol";
import { HttpError } from "./http-utils.js";

export type LiveActivityState = {
  version: 1;
  phase: "running" | "attention" | "ended" | "stale";
  runningCount: number;
  pendingCount: number;
  focusKey: string | null;
  agentKind: string | null;
  startedAt: number | null;
  updatedAt: number;
  outcome: "completed" | "failed" | "cancelled" | "unknown" | null;
};
export type LiveActivityUpdate = {
  version: 1;
  hostId: string;
  producerId: string;
  revision: number;
  event: "update" | "end";
  contentState: LiveActivityState;
};
export type LiveActivityPush = {
  event: "update" | "end";
  timestamp: number;
  priority: 5 | 10;
  contentState: LiveActivityState;
};
type Environment = "sandbox" | "production";
type Registration = {
  deviceId: string;
  hostId: string;
  activityId: string;
  token: string;
  environment: Environment;
  expiresAt: number;
};
type Cached = { connection: object; update: LiveActivityUpdate };
type Job = { target: Registration; cached: Cached; resolve: (status?: "sent" | "failed") => void };
type Delivery = { activityId: string; lastTimestamp: number; pendingCount: number; ended: boolean; lastHighAt: number; fingerprint: string };
type LiveActivityOptions = {
  stateFile?: string;
  isPaired: (deviceId: string, hostId: string) => boolean;
  currentConnection: (hostId: string) => object | undefined;
  hasEnvironment: (environment: Environment) => boolean;
  send: (environment: Environment, token: string, push: LiveActivityPush) => Promise<"sent" | "invalid-token">;
};

const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(v);
// Resource bound, not an assumption about Apple's variable token byte length.
const token = (v: unknown): v is string => typeof v === "string" && /^[a-fA-F0-9]{64,1024}$/u.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const millis = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
const count = (v: unknown, maximum: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= maximum;
const stateKeys = ["version", "phase", "runningCount", "pendingCount", "focusKey", "agentKind", "startedAt", "updatedAt", "outcome"];
const activityLifetime = 8 * 60 * 60 * 1000;

/** LA-R01: allowlist the complete payload so no session text can reach APNs. */
export function parseLiveActivityUpdate(value: unknown): LiveActivityUpdate {
  if (!object(value) || !exact(value, ["version", "hostId", "producerId", "revision", "event", "contentState"]) || value.version !== 1 ||
    !identifier(value.hostId) || !identifier(value.producerId) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.event !== "string" || !["update", "end"].includes(value.event) || !object(value.contentState)) throw new HttpError(400, "invalid_live_activity_update");
  const state = value.contentState;
  if (!exact(state, stateKeys) || state.version !== 1 || typeof state.phase !== "string" || !["running", "attention", "ended", "stale"].includes(state.phase) ||
    !count(state.runningCount, 2048) || !count(state.pendingCount, 131_072) || !millis(state.updatedAt) ||
    !(state.startedAt === null || millis(state.startedAt) && state.startedAt <= state.updatedAt) ||
    !(state.focusKey === null || typeof state.focusKey === "string" && /^[a-f0-9]{64}$/u.test(state.focusKey)) ||
    !(state.agentKind === null || AgentKindSchema.safeParse(state.agentKind).success) ||
    !(state.outcome === null || typeof state.outcome === "string" && ["completed", "failed", "cancelled", "unknown"].includes(state.outcome)) ||
    (value.event === "end") !== (state.phase === "ended") ||
    (state.phase !== "ended" && state.outcome !== null) ||
    (state.phase === "running" && (state.runningCount === 0 || state.pendingCount !== 0)) ||
    (state.phase === "ended" && (state.runningCount !== 0 || state.pendingCount !== 0)) ||
    (state.phase === "attention" && state.pendingCount === 0)) throw new HttpError(400, "invalid_live_activity_state");
  return value as LiveActivityUpdate;
}

/** Separate from legacy alert registration: one current ActivityKit token per
 * paired device/Host. Relay remains a metadata courier, never a state authority. */
export class RelayLiveActivities {
  readonly #targets = new Map<string, Registration>();
  readonly #latest = new Map<string, Cached>();
  readonly #pending = new Map<string, Job>();
  readonly #workers = new Map<string, Promise<void>>();
  readonly #deliveries = new Map<string, Delivery>();
  readonly #waits = new Map<string, { timer: ReturnType<typeof setTimeout>; finish: () => void }>();
  #mutation: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(readonly options: LiveActivityOptions) {}

  static async create(options: LiveActivityOptions): Promise<RelayLiveActivities> {
    const result = new RelayLiveActivities(options);
    if (options.stateFile) {
      try {
        const stored: unknown = JSON.parse(await readFile(options.stateFile, "utf8"));
        if (!object(stored) || stored.version !== 1 || !Array.isArray(stored.registrations) || stored.registrations.length > 16_384) throw new Error("Invalid Relay live activity state file");
        for (const target of stored.registrations) {
          if (object(target) && identifier(target.deviceId) && identifier(target.hostId) && identifier(target.activityId) && token(target.token) &&
            typeof target.environment === "string" && ["sandbox", "production"].includes(target.environment) && millis(target.expiresAt) && target.expiresAt > Date.now() &&
            options.isPaired(target.deviceId, target.hostId)) result.#targets.set(target.deviceId, target as Registration);
        }
        // Revocation in the main device registry takes precedence over stale files.
        if (result.#targets.size !== stored.registrations.length) await result.#persist();
      } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    return result;
  }

  async register(deviceId: string, hostId: string, value: unknown, authorized: () => boolean): Promise<void> {
    if (this.#closed) throw new HttpError(503, "relay_closing");
    if (!object(value) || value.version !== 1 || !identifier(value.activityId) || !(value.token === null || token(value.token)) ||
      Object.keys(value).some(k => !["version", "activityId", "token", "environment"].includes(k)) ||
      value.environment !== undefined && !(typeof value.environment === "string" && ["sandbox", "production"].includes(value.environment)) ||
      value.token !== null && value.environment === undefined) throw new HttpError(400, "invalid_live_activity_registration");
    if (value.token !== null && !this.options.hasEnvironment(value.environment as Environment)) throw new HttpError(409, "push_environment_mismatch");
    await this.#mutate(async () => {
      if (this.#closed) throw new HttpError(503, "relay_closing");
      if (!authorized() || !this.options.isPaired(deviceId, hostId)) throw new HttpError(401, "unauthorized");
      for (const target of this.#targets.values()) if (target.expiresAt <= Date.now()) this.#targets.delete(target.deviceId);
      if (value.token !== null && [...this.#targets.values()].some(target => target.hostId !== hostId && target.environment === value.environment && target.token === (value.token as string).toLowerCase())) throw new HttpError(409, "live_activity_host_mismatch");
      const previous = this.#targets.get(deviceId);
      if (value.token === null) {
        // A late cleanup from the previous activity cannot remove its replacement.
        if (previous?.activityId !== value.activityId) return;
        this.#targets.delete(deviceId);
      } else {
        if (!previous && this.#targets.size >= 16_384) throw new HttpError(503, "live_activity_capacity");
        const nextToken = (value.token as string).toLowerCase();
        const nextEnvironment = value.environment as Environment;
        // Preserve registration identity when the device refreshes the same
        // activity token. In-flight publish jobs validate that identity; making
        // an equivalent object here would make a concurrent register replay
        // cancel the publish and resolve it as an unsent no-op.
        const key = `${nextEnvironment}:${nextToken}`;
        const sameRegistration = previous && previous.activityId === value.activityId && previous.token === nextToken && previous.environment === nextEnvironment;
        // While APNs is in flight, keep a fresh registration identity so an
        // invalid-token response can retire only the old send. During the
        // same-second coalescing wait, retain identity so the queued publish
        // still validates and returns its actual APNs result.
        const preserveIdentity = sameRegistration && !(this.#workers.has(key) && !this.#waits.has(key) && !this.#pending.has(key));
        if (preserveIdentity) {
          this.#targets.set(deviceId, previous);
        } else {
          this.#targets.set(deviceId, { deviceId, hostId, activityId: value.activityId as string,
            token: nextToken, environment: nextEnvironment,
            expiresAt: previous && previous.activityId === value.activityId ? previous.expiresAt : Date.now() + activityLifetime });
        }
      }
      try { await this.#persist(); }
      catch (error) { if (previous) this.#targets.set(deviceId, previous); else this.#targets.delete(deviceId); throw error; }
      const target = this.#targets.get(deviceId), cached = this.#latest.get(hostId);
      if (target && cached && this.#current(cached) && cached.update.event !== "end" && cached.update.contentState.updatedAt >= Date.now() - 10 * 60_000) {
        // A worker that is coalescing a same-second update already owns the
        // latest cached payload. Re-enqueueing the registration replay would
        // replace that publish job and make its Promise resolve without the
        // eventual APNs result. Let the in-flight worker deliver it instead;
        // replay remains queued for active sends so a refreshed token can still
        // retry after an invalid-token response.
        const key = `${target.environment}:${target.token}`;
        if (!this.#waits.has(key) && !this.#pending.has(key)) void this.#enqueue(target, cached);
      }
    });
  }

  async publish(update: LiveActivityUpdate, connection: object): Promise<{ sent: string[]; failed: string[] }> {
    if (this.#closed) throw new HttpError(503, "relay_closing");
    if (this.options.currentConnection(update.hostId) !== connection) throw new HttpError(409, "host_connection_changed");
    const previous = this.#latest.get(update.hostId);
    if (previous?.connection === connection) {
      if (previous.update.producerId !== update.producerId) throw new HttpError(409, "live_activity_producer_mismatch");
      if (previous.update.revision > update.revision || previous.update.revision === update.revision && JSON.stringify(previous.update) !== JSON.stringify(update)) throw new HttpError(409, "stale_live_activity_revision");
    }
    if (!previous && this.#latest.size >= 512) {
      const retired = [...this.#latest].find(([, cached]) => !this.#current(cached));
      if (!retired) throw new HttpError(503, "live_activity_capacity");
      this.#latest.delete(retired[0]);
    }
    const cached = { connection, update };
    this.#latest.set(update.hostId, cached);
    const targets = [...this.#targets.values()].filter(target => target.hostId === update.hostId && this.#valid(target) && this.options.hasEnvironment(target.environment));
    const sent: string[] = [], failed: string[] = [];
    await Promise.all(targets.map(async target => {
      const status = await this.#enqueue(target, cached);
      if (status === "sent") sent.push(target.deviceId);
      if (status === "failed") failed.push(target.deviceId);
    }));
    return { sent, failed };
  }

  async removeDevice(deviceId: string): Promise<void> { await this.#remove(target => target.deviceId === deviceId); }
  async removeHost(hostId: string): Promise<void> {
    this.#latest.delete(hostId);
    await this.#remove(target => target.hostId === hostId);
  }
  async #remove(match: (target: Registration) => boolean): Promise<void> {
    await this.#mutate(async () => {
      const removed = [...this.#targets.values()].filter(match);
      for (const target of removed) this.#targets.delete(target.deviceId);
      try { await this.#persist(); }
      catch (error) { for (const target of removed) this.#targets.set(target.deviceId, target); throw error; }
    });
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#mutation.then(operation);
    this.#mutation = pending.then(() => {}, () => {});
    return pending;
  }
  async #persist(): Promise<void> {
    if (!this.options.stateFile) return;
    const temporary = `${this.options.stateFile}.${process.pid}.tmp`;
    await mkdir(dirname(this.options.stateFile), { recursive: true });
    await writeFile(temporary, JSON.stringify({ version: 1, registrations: [...this.#targets.values()] }), { mode: 0o600 });
    await rename(temporary, this.options.stateFile);
  }
  #current(cached: Cached): boolean {
    return this.options.currentConnection(cached.update.hostId) === cached.connection && this.#latest.get(cached.update.hostId)?.update.revision === cached.update.revision;
  }
  #valid(target: Registration): boolean {
    return !this.#closed && this.#targets.get(target.deviceId) === target && target.expiresAt > Date.now() && this.options.isPaired(target.deviceId, target.hostId);
  }
  #enqueue(target: Registration, cached: Cached): Promise<"sent" | "failed" | undefined> {
    return new Promise(resolve => {
      const key = `${target.environment}:${target.token}`;
      this.#pending.get(key)?.resolve();
      this.#pending.set(key, { target, cached, resolve });
      this.#start(key);
    });
  }
  #start(key: string): void {
    if (this.#closed || this.#workers.has(key)) return;
    const worker = this.#drain(key);
    this.#workers.set(key, worker);
    void worker.finally(() => {
      this.#workers.delete(key);
      if (this.#pending.has(key)) this.#start(key);
    });
  }
  async #drain(key: string): Promise<void> {
    while (!this.#closed) {
      const job = this.#pending.get(key);
      if (!job) return;
      this.#pending.delete(key);
      const { target, cached } = job;
      const delivery = this.#deliveries.get(key);
      const previous = delivery?.activityId === target.activityId ? delivery : undefined;
      const fingerprint = JSON.stringify(cached.update.contentState);
      if (previous?.fingerprint === fingerprint || previous?.ended) { job.resolve(); continue; }
      if (previous && Math.floor(Date.now() / 1000) <= previous.lastTimestamp) {
        // ActivityKit timestamps are seconds. Coalesce state changes while waiting
        // for the next second, instead of sending ambiguous same-second payloads.
        await new Promise<void>(finish => {
          const timer = setTimeout(() => { this.#waits.delete(key); finish(); }, Math.max(1, (previous.lastTimestamp + 1) * 1000 - Date.now()));
          timer.unref(); this.#waits.set(key, { timer, finish });
        });
      }
      if (!this.#valid(target) || !this.#current(cached) || this.#pending.has(key)) { job.resolve(); continue; }
      const state = cached.update.contentState;
      const urgent = cached.update.event === "end" || state.pendingCount > (previous?.pendingCount ?? 0) && Date.now() - (previous?.lastHighAt ?? 0) >= 15_000;
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const destinations = [...this.#targets.values()].filter(t => t.environment === target.environment && t.token === target.token);
        const result = await this.options.send(target.environment, target.token, {
          event: cached.update.event, timestamp, priority: urgent ? 10 : 5, contentState: state,
        });
        if (result === "invalid-token" || cached.update.event === "end") {
          await this.#mutate(async () => {
            // A registration refresh may replace the target object while this
            // APNs request is in flight. Retire only registrations that still
            // refer to the object used by this request; a refreshed same-token
            // registration must survive so its replay can retry the delivery.
            const removed = destinations.filter(t => this.#targets.get(t.deviceId) === t);
            for (const item of removed) this.#targets.delete(item.deviceId);
            try { await this.#persist(); } catch (error) { for (const item of removed) this.#targets.set(item.deviceId, item); throw error; }
          });
        }
        this.#deliveries.set(key, { activityId: target.activityId, lastTimestamp: timestamp, pendingCount: state.pendingCount,
          ended: result === "sent" && cached.update.event === "end", lastHighAt: urgent ? Date.now() : previous?.lastHighAt ?? 0,
          fingerprint: result === "sent" ? fingerprint : "" });
        // Token metadata is bounded by currently possible registrations, not by
        // unbounded old token rotations over the lifetime of the Relay process.
        while (this.#deliveries.size > 16_384) this.#deliveries.delete(this.#deliveries.keys().next().value!);
        job.resolve(result === "sent" ? "sent" : undefined);
      } catch { job.resolve("failed"); }
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const wait of this.#waits.values()) { clearTimeout(wait.timer); wait.finish(); }
    this.#waits.clear();
    for (const job of this.#pending.values()) job.resolve();
    this.#pending.clear();
    await Promise.allSettled([...this.#workers.values(), this.#mutation]);
  }
}
