import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LIVE_ACTIVITY_FRESHNESS_MS, liveActivityV1AgentKind, type LiveActivityAgentKind, type LiveActivityContentState } from "@orbis/protocol";
import { HttpError } from "./http-utils.js";

export type LiveActivityState = LiveActivityContentState & { sessionCount?: number };
// v0.1.24 Host sent kimiCode; the initial OpenCode implementation could send opencode.
// Accept both producer shapes without forwarding either label into a v1 widget.
type ProducerState = Omit<LiveActivityContentState, "agentKind"> & {
  agentKind: LiveActivityAgentKind | "kimiCode" | "opencode" | null;
};
const widgetState = (state: ProducerState): LiveActivityContentState => ({ ...state, agentKind: liveActivityV1AgentKind(state.agentKind) });
export type LiveActivityUpdate = {
  version: 1;
  hostId: string;
  producerId: string;
  revision: number;
  event: "update" | "end";
  contentState: ProducerState;
};
type StartAttributes = { hostId: string; pairingRef: string; launchId: string };
export type LiveActivityPush = ({ event: "update" | "end" } | {
  event: "start";
  attributes: StartAttributes;
  inputPushToken: boolean;
}) & {
  timestamp: number;
  priority: 5 | 10;
  contentState: LiveActivityState;
  dismissalTimestamp?: number;
};
type Environment = "sandbox" | "production";
type Registration = {
  deviceId: string;
  hostId: string;
  activityId: string;
  token: string;
  environment: Environment;
  expiresAt: number;
  launchId?: string;
};
type StartTarget = Pick<Registration, "deviceId" | "hostId" | "token" | "environment"> & { inputPushToken: boolean; pairingRef: string };
type Launch = {
  deviceId: string; hostId: string; id: string; issuedAt: number;
  via: "app" | "push";
  pendingCount?: number;
  activityId?: string;
  // A terminal summary must survive a late ActivityKit token, a new Host
  // batch, or a Relay restart. Only a matching launch can replay this end.
  terminal?: { state: LiveActivityContentState; receivedAt: number };
  invalidToken?: true;
  retired?: true;
};
type Cached = { connection: object; update: LiveActivityUpdate; sessionCount: number | undefined };
type Job = { target: Registration; cached: Cached | undefined; resolve: (status?: "sent" | "failed") => void };
type Delivery = { activityId: string; lastTimestamp: number; pendingCount: number; ended: boolean; lastHighAt: number; fingerprint: string };
type LiveActivityOptions = {
  stateFile?: string;
  isPaired: (deviceId: string, hostId: string, pairingRef?: string) => boolean;
  currentConnection: (hostId: string) => object | undefined;
  hasEnvironment: (environment: Environment) => boolean;
  send: (environment: Environment, token: string, push: LiveActivityPush) => Promise<"sent" | "invalid-token">;
};

const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(v);
// Resource bound, not an assumption about Apple's variable token byte length.
const token = (v: unknown): v is string => typeof v === "string" && /^[a-fA-F0-9]{64,1024}$/u.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const environment = (v: unknown): v is Environment => v === "sandbox" || v === "production";
const launchId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const millis = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
const count = (v: unknown, maximum: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= maximum;
const stateKeys = ["version", "phase", "runningCount", "pendingCount", "focusKey", "agentKind", "startedAt", "updatedAt", "outcome"];
const activityLifetime = 8 * 60 * 60 * 1000;
export const LIVE_ACTIVITY_START_WINDOW_SECONDS = 60;
const handoffWindow = LIVE_ACTIVITY_START_WINDOW_SECONDS * 1000;
const launchLifetime = activityLifetime + handoffWindow;
const capacity = 16_384;
const launchStateFile = (file: string) => `${file}.launches.json`;
const readState = async (file: string): Promise<unknown> => {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
};

// APNs receives neither the device ID nor its credential. The opaque reference
// distinguishes pairings sharing an ActivityKit start token, including rotation.
export const liveActivityPairingRef = (hostId: string, deviceId: string, credentialHash: string): string =>
  createHash("sha256").update(JSON.stringify(["orbis.live-activity-pairing-v1", hostId, deviceId, credentialHash]), "utf8").digest("hex");

function validState(state: unknown): state is ProducerState {
  if (!object(state) || !exact(state, stateKeys) || state.version !== 1 || typeof state.phase !== "string" || !["running", "attention", "ended", "stale"].includes(state.phase) ||
    !count(state.runningCount, 2048) || !count(state.pendingCount, 131_072) || !millis(state.updatedAt) ||
    !(state.startedAt === null || millis(state.startedAt) && state.startedAt <= state.updatedAt) ||
    !(state.focusKey === null || typeof state.focusKey === "string" && /^[a-f0-9]{64}$/u.test(state.focusKey)) ||
    !(state.agentKind === null || state.agentKind === "kimiCode" || state.agentKind === "opencode" || liveActivityV1AgentKind(state.agentKind) !== null) ||
    !(state.outcome === null || typeof state.outcome === "string" && ["completed", "failed", "cancelled", "unknown"].includes(state.outcome)) ||
    (state.phase !== "ended" && state.outcome !== null) ||
    (state.phase === "running" && (state.runningCount === 0 || state.pendingCount !== 0)) ||
    (state.phase === "ended" && (state.runningCount !== 0 || state.pendingCount !== 0)) ||
    (state.phase === "attention" && state.pendingCount === 0)) return false;
  return true;
}

/** LA-R01: allowlist the complete payload so no session text can reach APNs. */
export function parseLiveActivityUpdate(value: unknown): LiveActivityUpdate {
  if (!object(value) || !exact(value, ["version", "hostId", "producerId", "revision", "event", "contentState"]) || value.version !== 1 ||
    !identifier(value.hostId) || !identifier(value.producerId) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.event !== "string" || !["update", "end"].includes(value.event) || !object(value.contentState)) throw new HttpError(400, "invalid_live_activity_update");
  if (!validState(value.contentState) || (value.event === "end") !== (value.contentState.phase === "ended")) throw new HttpError(400, "invalid_live_activity_state");
  return value as LiveActivityUpdate;
}

/** Separate from legacy alert registration: one current ActivityKit token per
 * paired device/Host. Relay remains a metadata courier, never a state authority. */
export class RelayLiveActivities {
  readonly #targets = new Map<string, Registration>();
  readonly #startTargets = new Map<string, StartTarget>();
  readonly #launches = new Map<string, Launch>();
  readonly #startWorkers = new Map<string, Promise<void>>();
  readonly #latest = new Map<string, Cached>();
  readonly #pending = new Map<string, Job>();
  readonly #workers = new Map<string, Promise<void>>();
  readonly #deliveries = new Map<string, Delivery>();
  readonly #waits = new Map<string, { timer: ReturnType<typeof setTimeout>; finish: () => void }>();
  #mutation: Promise<void> = Promise.resolve();
  #closed = false;
  #savedRegistrations: string | undefined;
  #savedLaunches: string | undefined;

  private constructor(readonly options: LiveActivityOptions) {}

  static async create(options: LiveActivityOptions): Promise<RelayLiveActivities> {
    const result = new RelayLiveActivities(options);
    const file = options.stateFile;
    if (!file) return result;
    const stored = await readState(file);
    if (stored !== undefined && (!object(stored) || stored.version !== 1 || !Array.isArray(stored.registrations) || stored.registrations.length > capacity)) {
      throw new Error("Invalid Relay live activity state file");
    }
    const legacy = stored as { registrations: unknown[]; startTargets?: unknown; launches?: unknown } | undefined;
    const extension = await readState(launchStateFile(file));
    if (extension !== undefined && (!object(extension) || extension.version !== 1 || !Array.isArray(extension.startTargets) || !Array.isArray(extension.launches))) {
      throw new Error("Invalid Relay live activity launch state file");
    }
    const launchData = (extension ?? legacy) as { startTargets?: unknown; launches?: unknown } | undefined;
    const startTargets = launchData?.startTargets === undefined ? [] : launchData.startTargets;
    const launches = launchData?.launches === undefined ? [] : launchData.launches;
    if (!Array.isArray(startTargets) || startTargets.length > capacity || !Array.isArray(launches) || launches.length > capacity) {
      throw new Error("Invalid Relay live activity launch state file");
    }
    const registrations = legacy?.registrations ?? [];
    const now = Date.now();
    for (const target of registrations) {
      if (object(target) && identifier(target.deviceId) && identifier(target.hostId) && identifier(target.activityId) && token(target.token) &&
        environment(target.environment) && millis(target.expiresAt) && target.expiresAt > now && (target.launchId === undefined || launchId(target.launchId)) &&
        options.isPaired(target.deviceId, target.hostId)) result.#targets.set(target.deviceId, target as Registration);
    }
    for (const target of startTargets) {
      if (object(target) && identifier(target.deviceId) && identifier(target.hostId) && token(target.token) && environment(target.environment) &&
        typeof target.inputPushToken === "boolean" && digest(target.pairingRef) &&
        options.isPaired(target.deviceId, target.hostId, target.pairingRef)) result.#startTargets.set(target.deviceId, target as StartTarget);
    }
    for (const launch of launches) {
      if (!object(launch) || !identifier(launch.deviceId) || !identifier(launch.hostId) || !launchId(launch.id) || !millis(launch.issuedAt) ||
        launch.issuedAt + launchLifetime <= now || (launch.via !== "push" && launch.via !== "app") ||
        (launch.pendingCount !== undefined && !count(launch.pendingCount, 131_072)) ||
        (launch.activityId !== undefined && !identifier(launch.activityId)) ||
        (launch.invalidToken !== undefined && launch.invalidToken !== true) || (launch.retired !== undefined && launch.retired !== true) ||
        !options.isPaired(launch.deviceId, launch.hostId)) continue;
      const terminal = launch.terminal;
      if (terminal !== undefined && (!object(terminal) || !millis(terminal.receivedAt) || !validState(terminal.state) || terminal.state.phase !== "ended")) continue;
      result.#launches.set(launch.deviceId, { ...launch as Launch,
        ...(terminal === undefined ? {} : { terminal: { receivedAt: terminal.receivedAt as number, state: widgetState(terminal.state as ProducerState) } }),
      });
    }
    // The legacy file remains authoritative for the APNs token and activity ID.
    // v0.1.24 can replace a token without copying launchId, or remove a target.
    // Rejoin only the same activity; a replacement must not inherit its launch.
    for (const [id, launch] of result.#launches) {
      const target = result.#targets.get(id);
      if (target && target.hostId === launch.hostId &&
        (target.launchId === launch.id || target.launchId === undefined && target.activityId === launch.activityId) &&
        (launch.activityId === undefined || target.activityId === launch.activityId)) {
        if (!launch.retired) {
          result.#targets.set(id, { ...target, launchId: launch.id });
          result.#launches.set(id, { ...launch, activityId: target.activityId });
        } else {
          result.#targets.delete(id);
        }
      } else if (launch.activityId !== undefined && !launch.retired && (target || !launch.invalidToken)) {
        result.#launches.set(id, { ...launch, retired: true });
      }
    }
    for (const [id, target] of result.#targets) {
      if (target.launchId !== undefined && result.#launches.get(id)?.id !== target.launchId) result.#targets.delete(id);
    }
    // Prefer the sidecar even if migration was interrupted before rewriting the v1 file.
    result.#savedRegistrations = stored === undefined ? result.#registrationState([]) : JSON.stringify(legacy);
    result.#savedLaunches = extension === undefined ? (legacy?.startTargets === undefined && legacy?.launches === undefined ? result.#launchState([], []) : undefined) : JSON.stringify(extension);
    await result.#persist();
    return result;
  }

  async register(deviceId: string, hostId: string, value: unknown, authorized: () => boolean): Promise<void> {
    if (this.#closed) throw new HttpError(503, "relay_closing");
    if (!object(value) || value.version !== 1 || !identifier(value.activityId) || !(value.token === null || token(value.token)) ||
      Object.keys(value).some(k => !["version", "activityId", "token", "environment", "launchId"].includes(k)) ||
      value.launchId !== undefined && !launchId(value.launchId) ||
      value.environment !== undefined && !environment(value.environment) ||
      value.token !== null && value.environment === undefined) throw new HttpError(400, "invalid_live_activity_registration");
    if (value.token !== null && !this.options.hasEnvironment(value.environment as Environment)) throw new HttpError(409, "push_environment_mismatch");
    await this.#mutate(async () => {
      if (this.#closed) throw new HttpError(503, "relay_closing");
      if (!authorized() || !this.options.isPaired(deviceId, hostId)) throw new HttpError(401, "unauthorized");
      for (const target of this.#targets.values()) if (target.expiresAt <= Date.now()) this.#targets.delete(target.deviceId);
      if (value.token !== null && [...this.#targets.values()].some(target => target.hostId !== hostId && target.environment === value.environment && target.token === (value.token as string).toLowerCase())) throw new HttpError(409, "live_activity_host_mismatch");
      const previous = this.#targets.get(deviceId);
      const launch = this.#launches.get(deviceId);
      // Once APNs accepted the Host end, wait for ActivityKit to show it.
      // A foreground token refresh is not permission to dismiss the card.
      if (value.token !== null && launch && value.launchId === launch.id && launch.retired && launch.terminal) return;
      if (value.token !== null && value.launchId !== undefined && (!launch || launch.id !== value.launchId || launch.retired ||
        (launch.activityId !== undefined && launch.activityId !== value.activityId) || previous && (previous.activityId !== value.activityId || previous.launchId !== launch.id))) {
        throw new HttpError(410, "live_activity_launch_changed");
      }
      if (value.token !== null && value.launchId === undefined && (previous?.launchId !== undefined || (launch && !this.#slotAvailable(deviceId) && !previous))) {
        throw new HttpError(409, "live_activity_launch_changed");
      }
      if (value.token === null) {
        // A late cleanup from the previous activity cannot remove its replacement.
        if (previous && (previous.activityId !== value.activityId || previous.launchId !== value.launchId)) return;
        if (!previous && (!launch || value.launchId !== launch.id || launch.retired)) return;
        this.#targets.delete(deviceId);
        if (launch && value.launchId === launch.id) this.#launches.set(deviceId, { ...launch, retired: true });
      } else {
        if (!previous && this.#targets.size >= capacity) throw new HttpError(503, "live_activity_capacity");
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
            expiresAt: previous && previous.activityId === value.activityId ? previous.expiresAt : Date.now() + activityLifetime,
            ...(typeof value.launchId === "string" ? { launchId: value.launchId } : {}) });
        }
      }
      if (value.token !== null && launch && value.launchId === launch.id && (launch.activityId === undefined || launch.invalidToken)) {
        const bound = { ...launch, activityId: value.activityId as string };
        delete bound.invalidToken;
        this.#launches.set(deviceId, bound);
      }
      try { await this.#persist(); }
      catch (error) {
        if (previous) this.#targets.set(deviceId, previous); else this.#targets.delete(deviceId);
        if (launch) this.#launches.set(deviceId, launch);
        throw error;
      }
      const target = this.#targets.get(deviceId), cached = this.#latest.get(hostId);
      if (target && (this.#terminal(target) || cached && this.#fresh(cached) && cached.update.event !== "end")) {
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

  async registerStart(deviceId: string, hostId: string, pairingRef: string, value: unknown, authorized: () => boolean): Promise<void> {
    if (!object(value) || value.version !== 1 || !(value.token === null && exact(value, ["version", "token"]) ||
      exact(value, ["version", "token", "environment", "inputPushToken"]) && token(value.token) && environment(value.environment) && typeof value.inputPushToken === "boolean")) {
      throw new HttpError(400, "invalid_live_activity_start_registration");
    }
    const target: StartTarget | undefined = token(value.token) && environment(value.environment) ?
      { deviceId, hostId, pairingRef, token: value.token.toLowerCase(), environment: value.environment, inputPushToken: value.inputPushToken === true } : undefined;
    if (target && !this.options.hasEnvironment(target.environment)) throw new HttpError(409, "push_environment_mismatch");
    await this.#mutate(async () => {
      this.#requirePairing(deviceId, hostId, authorized);
      const previous = this.#startTargets.get(deviceId);
      if (!target && !previous || target && previous?.token === target.token && previous.environment === target.environment &&
        previous.pairingRef === target.pairingRef && previous.inputPushToken === target.inputPushToken) return;
      if (target && !previous && this.#startTargets.size >= capacity) throw new HttpError(503, "live_activity_capacity");
      if (target) this.#startTargets.set(deviceId, target); else this.#startTargets.delete(deviceId);
      try { await this.#persist(); }
      catch (error) { if (previous) this.#startTargets.set(deviceId, previous); else this.#startTargets.delete(deviceId); throw error; }
    });
  }

  async claim(deviceId: string, hostId: string, value: unknown, authorized: () => boolean): Promise<{ version: 1; launchId: string; contentState: LiveActivityState } | undefined> {
    if (!object(value) || !exact(value, ["version", "environment"]) || value.version !== 1 || !environment(value.environment)) throw new HttpError(400, "invalid_live_activity_claim");
    if (!this.options.hasEnvironment(value.environment)) throw new HttpError(409, "push_environment_mismatch");
    return this.#mutate(async () => {
      this.#requirePairing(deviceId, hostId, authorized);
      const cached = this.#startable(hostId);
      const held = this.#launches.get(deviceId);
      // The foreground caller checked ActivityKit's inventory. Recover a lost
      // handoff only after the original start could no longer be delivered.
      const canRecover = held && held.retired !== true && !this.#targets.has(deviceId) && held.issuedAt + handoffWindow <= Date.now();
      if (!cached || !(this.#slotAvailable(deviceId) || canRecover)) return undefined;
      const launch = await this.#reserve(deviceId, hostId, "app", cached.update.contentState.pendingCount);
      if (!this.#fresh(cached) || !authorized() || !this.options.isPaired(deviceId, hostId)) {
        await this.#discardLaunch(launch);
        return undefined;
      }
      return { version: 1, launchId: launch.id, contentState: this.#content(cached, true) };
    });
  }

  async cancelClaim(deviceId: string, hostId: string, value: unknown, authorized: () => boolean): Promise<void> {
    if (!object(value) || !exact(value, ["version", "launchId"]) || value.version !== 1 || !launchId(value.launchId)) throw new HttpError(400, "invalid_live_activity_claim");
    await this.#mutate(async () => {
      this.#requirePairing(deviceId, hostId, authorized);
      const launch = this.#launches.get(deviceId);
      if (launch && launch.id === value.launchId && launch.via === "app" && !launch.retired && !this.#targets.has(deviceId)) await this.#discardLaunch(launch);
    });
  }

  async publish(update: LiveActivityUpdate, connection: object, sessionCount?: number): Promise<{ sent: string[]; failed: string[] }> {
    const cached = await this.#mutate(async () => {
      if (this.#closed) throw new HttpError(503, "relay_closing");
      if (this.options.currentConnection(update.hostId) !== connection) throw new HttpError(409, "host_connection_changed");
      const previous = this.#latest.get(update.hostId);
      if (previous?.connection === connection) {
        if (previous.update.producerId !== update.producerId) throw new HttpError(409, "live_activity_producer_mismatch");
        if (previous.update.revision > update.revision || previous.update.revision === update.revision &&
          (JSON.stringify(previous.update) !== JSON.stringify(update) || sessionCount !== previous.sessionCount)) throw new HttpError(409, "stale_live_activity_revision");
      }
      if (!previous && this.#latest.size >= 512) {
        const retired = [...this.#latest].find(([, entry]) => !this.#current(entry));
        if (!retired) throw new HttpError(503, "live_activity_capacity");
        this.#latest.delete(retired[0]);
      }
      if (update.event === "end") {
        const ending = [...this.#launches.values()].filter(launch => launch.hostId === update.hostId && !launch.terminal);
        const terminal = { state: widgetState(update.contentState), receivedAt: Date.now() };
        for (const launch of ending) this.#launches.set(launch.deviceId, { ...launch, terminal });
        if (ending.length > 0) {
          try { await this.#persist(); }
          catch (error) { for (const launch of ending) this.#launches.set(launch.deviceId, launch); throw error; }
        }
      }
      const entry = { connection, update, sessionCount };
      this.#latest.set(update.hostId, entry);
      return entry;
    });
    const targets = [...this.#targets.values()].filter(target => target.hostId === update.hostId && this.#valid(target) && this.options.hasEnvironment(target.environment));
    for (const target of this.#startTargets.values()) if (target.hostId === update.hostId) this.#maybeStart(target.deviceId);
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
  async #remove(match: (target: { deviceId: string; hostId: string }) => boolean): Promise<void> {
    await this.#mutate(async () => {
      const removed = [...this.#targets.values()].filter(match);
      const starts = [...this.#startTargets.values()].filter(match);
      const launches = [...this.#launches.values()].filter(match);
      for (const target of removed) this.#targets.delete(target.deviceId);
      for (const target of starts) this.#startTargets.delete(target.deviceId);
      for (const launch of launches) this.#launches.delete(launch.deviceId);
      try { await this.#persist(); }
      catch (error) {
        for (const target of removed) this.#targets.set(target.deviceId, target);
        for (const target of starts) this.#startTargets.set(target.deviceId, target);
        for (const launch of launches) this.#launches.set(launch.deviceId, launch);
        throw error;
      }
    });
  }

  #requirePairing(deviceId: string, hostId: string, authorized: () => boolean): void {
    if (this.#closed) throw new HttpError(503, "relay_closing");
    if (!authorized() || !this.options.isPaired(deviceId, hostId)) throw new HttpError(401, "unauthorized");
  }
  #startable(hostId: string): Cached | undefined {
    const cached = this.#latest.get(hostId);
    return cached && this.#fresh(cached) && (cached.update.contentState.phase === "running" || cached.update.contentState.phase === "attention") ? cached : undefined;
  }
  #fresh(cached: Cached): boolean {
    return this.#current(cached) && cached.update.contentState.updatedAt >= Date.now() - LIVE_ACTIVITY_FRESHNESS_MS;
  }
  #slotAvailable(deviceId: string): boolean {
    const target = this.#targets.get(deviceId);
    if (target && target.expiresAt > Date.now()) return false;
    const launch = this.#launches.get(deviceId);
    if (!launch || launch.issuedAt + launchLifetime <= Date.now()) return true;
    // Do not reuse a push reservation before APNs' expiration, or recreate a
    // dismissed/lost-token activity on a same-batch heartbeat or reconnect.
    return launch.terminal !== undefined && (launch.retired === true || launch.invalidToken === true);
  }
  async #reserve(deviceId: string, hostId: string, via: Launch["via"], pendingCount: number): Promise<Launch> {
    for (const launch of this.#launches.values()) if (launch.issuedAt + launchLifetime <= Date.now()) this.#launches.delete(launch.deviceId);
    const previous = this.#launches.get(deviceId);
    if (!previous && this.#launches.size >= capacity) throw new HttpError(503, "live_activity_capacity");
    const launch: Launch = { deviceId, hostId, id: randomUUID(), issuedAt: Date.now(), via, pendingCount };
    this.#launches.set(deviceId, launch);
    try { await this.#persist(); }
    catch (error) { if (previous) this.#launches.set(deviceId, previous); else this.#launches.delete(deviceId); throw error; }
    return launch;
  }
  async #discardLaunch(launch: Launch): Promise<void> {
    const current = this.#launches.get(launch.deviceId);
    if (current?.id !== launch.id || this.#targets.get(launch.deviceId)?.launchId === launch.id) return;
    this.#launches.delete(launch.deviceId);
    try { await this.#persist(); }
    catch (error) { this.#launches.set(launch.deviceId, current); throw error; }
  }
  #terminal(target: Registration): Launch["terminal"] {
    const launch = this.#launches.get(target.deviceId);
    return launch && launch.id === target.launchId ? launch.terminal : undefined;
  }
  #content(cached: Cached, bound: boolean): LiveActivityState {
    const state = widgetState(cached.update.contentState);
    return bound && cached.sessionCount !== undefined ? { ...state, sessionCount: cached.sessionCount } : state;
  }
  #maybeStart(deviceId: string): void {
    if (this.#closed || this.#startWorkers.has(deviceId)) return;
    const target = this.#startTargets.get(deviceId);
    if (!target || !this.#slotAvailable(deviceId) || !this.#startable(target.hostId)) return;
    const worker = this.#startRemote(target).catch(() => {
      // No start is retried after an ambiguous transport error: it may already
      // be on-device. Specific APNs rejections are handled below.
    }).finally(() => {
      this.#startWorkers.delete(deviceId);
      if (this.#startTargets.get(deviceId) !== target) this.#maybeStart(deviceId);
    });
    this.#startWorkers.set(deviceId, worker);
  }
  async #startRemote(target: StartTarget): Promise<void> {
    const valid = () => !this.#closed && this.#startTargets.get(target.deviceId) === target &&
      this.options.isPaired(target.deviceId, target.hostId, target.pairingRef) && this.options.hasEnvironment(target.environment);
    const launch = await this.#mutate(async () => {
      const cached = this.#startable(target.hostId);
      if (!valid() || !this.#slotAvailable(target.deviceId) || !cached) return undefined;
      return this.#reserve(target.deviceId, target.hostId, "push", cached.update.contentState.pendingCount);
    });
    if (!launch) return;
    const cached = this.#startable(target.hostId);
    if (!valid() || !cached || this.#launches.get(target.deviceId) !== launch || launch.issuedAt + handoffWindow <= Date.now()) {
      await this.#mutate(() => this.#discardLaunch(launch));
      return;
    }
    let result: "sent" | "invalid-token";
    try {
      result = await this.options.send(target.environment, target.token, {
        event: "start", timestamp: Math.floor(launch.issuedAt / 1000), priority: 10, contentState: this.#content(cached, true),
        attributes: { hostId: target.hostId, pairingRef: target.pairingRef, launchId: launch.id },
        inputPushToken: target.inputPushToken,
      });
    } catch (error) {
      if (object(error) && error.apnsRejected === true) await this.#mutate(() => this.#discardLaunch(launch));
      return;
    }
    if (result === "invalid-token") await this.#mutate(async () => {
      // One start token can be registered by several pairings on this phone.
      // Only this unchanged registration is retired; never delete a rotation.
      if (this.#startTargets.get(target.deviceId) === target) {
        this.#startTargets.delete(target.deviceId);
        try { await this.#persist(); }
        catch (error) { this.#startTargets.set(target.deviceId, target); throw error; }
      }
      await this.#discardLaunch(launch);
    });
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#mutation.then(operation);
    this.#mutation = pending.then(() => {}, () => {});
    return pending;
  }
  #registrationState(registrations: Registration[]): string { return JSON.stringify({ version: 1, registrations }); }
  #launchState(startTargets: StartTarget[], launches: Launch[]): string { return JSON.stringify({ version: 1, startTargets, launches }); }
  async #persist(): Promise<void> {
    const file = this.options.stateFile;
    if (!file) return;
    const registrations = this.#registrationState([...this.#targets.values()]);
    const launches = this.#launchState([...this.#startTargets.values()], [...this.#launches.values()]);
    const write = async (path: string, contents: string) => {
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, path);
    };
    if (registrations === this.#savedRegistrations && launches === this.#savedLaunches) return;
    await mkdir(dirname(file), { recursive: true });
    const previousLaunches = this.#savedLaunches;
    const sidecar = launchStateFile(file);
    // Stage the binding (or its retirement) before exposing the registration to the old format.
    if (launches !== previousLaunches) { await write(sidecar, launches); this.#savedLaunches = launches; }
    try {
      if (registrations !== this.#savedRegistrations) { await write(file, registrations); this.#savedRegistrations = registrations; }
    } catch (error) {
      if (launches !== previousLaunches && previousLaunches !== undefined) {
        await write(sidecar, previousLaunches);
        this.#savedLaunches = previousLaunches;
      }
      throw error;
    }
  }
  #current(cached: Cached): boolean {
    return this.options.currentConnection(cached.update.hostId) === cached.connection && this.#latest.get(cached.update.hostId) === cached;
  }
  #valid(target: Registration): boolean {
    return !this.#closed && this.#targets.get(target.deviceId) === target && target.expiresAt > Date.now() && this.options.isPaired(target.deviceId, target.hostId);
  }
  #enqueue(target: Registration, cached: Cached | undefined): Promise<"sent" | "failed" | undefined> {
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
      // A terminal end reserved for this activity wins even if a new batch has
      // already published or the Host/Relay reconnected before token delivery.
      if (previous?.ended) { job.resolve(); continue; }
      const launch = this.#launches.get(target.deviceId);
      const after = Math.max(previous?.lastTimestamp ?? -1, launch && launch.id === target.launchId ? Math.floor(launch.issuedAt / 1000) : -1);
      if (Math.floor(Date.now() / 1000) <= after) {
        // ActivityKit timestamps are seconds. Coalesce state changes while waiting
        // for the next second, instead of sending ambiguous same-second payloads.
        await new Promise<void>(finish => {
          const timer = setTimeout(() => { this.#waits.delete(key); finish(); }, Math.max(1, (after + 1) * 1000 - Date.now()));
          timer.unref(); this.#waits.set(key, { timer, finish });
        });
      }
      const terminal = this.#terminal(target);
      if (!this.#valid(target) || (!terminal && (!cached || !this.#current(cached))) || this.#pending.has(key)) { job.resolve(); continue; }
      const state = terminal?.state ?? (cached && this.#content(cached, target.launchId !== undefined));
      if (!state) { job.resolve(); continue; }
      const fingerprint = JSON.stringify(state);
      if (previous?.fingerprint === fingerprint) { job.resolve(); continue; }
      const event = state.phase === "ended" ? "end" : "update";
      const lastPending = previous?.pendingCount ?? (launch?.id === target.launchId ? launch?.pendingCount : undefined) ?? 0;
      const urgent = event === "end" || (state.phase === "running" && lastPending > 0) ||
        state.pendingCount > lastPending && Date.now() - (previous?.lastHighAt ?? 0) >= 15_000;
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const destinations = [...this.#targets.values()].filter(t => t.environment === target.environment && t.token === target.token);
        const result = await this.options.send(target.environment, target.token, {
          event, timestamp, priority: urgent ? 10 : 5, contentState: state,
          ...(terminal && event === "end" ? { dismissalTimestamp: Math.floor(terminal.receivedAt / 1000) + 300 } : {}),
        });
        if (result === "invalid-token" || event === "end") {
          await this.#mutate(async () => {
            // A registration refresh may replace the target object while this
            // APNs request is in flight. Retire only registrations that still
            // refer to the object used by this request; a refreshed same-token
            // registration must survive so its replay can retry the delivery.
            const removed = destinations.filter(t => this.#targets.get(t.deviceId) === t);
            const retired: Launch[] = [];
            for (const item of removed) {
              const launch = this.#launches.get(item.deviceId);
              if (launch && launch.id === item.launchId) {
                retired.push(launch);
                this.#launches.set(item.deviceId, result === "sent" ? { ...launch, retired: true } : { ...launch, invalidToken: true });
              }
            }
            for (const item of removed) this.#targets.delete(item.deviceId);
            try { await this.#persist(); } catch (error) {
              for (const item of removed) this.#targets.set(item.deviceId, item);
              for (const launch of retired) this.#launches.set(launch.deviceId, launch);
              throw error;
            }
          });
        }
        this.#deliveries.set(key, { activityId: target.activityId, lastTimestamp: timestamp, pendingCount: state.pendingCount,
          ended: result === "sent" && event === "end", lastHighAt: urgent ? Date.now() : previous?.lastHighAt ?? 0,
          fingerprint: result === "sent" ? fingerprint : "" });
        // Token metadata is bounded by currently possible registrations, not by
        // unbounded old token rotations over the lifetime of the Relay process.
        while (this.#deliveries.size > 16_384) this.#deliveries.delete(this.#deliveries.keys().next().value!);
        job.resolve(result === "sent" ? "sent" : undefined);
        if (event === "end") for (const item of destinations) this.#maybeStart(item.deviceId);
      } catch { job.resolve("failed"); }
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const wait of this.#waits.values()) { clearTimeout(wait.timer); wait.finish(); }
    this.#waits.clear();
    for (const job of this.#pending.values()) job.resolve();
    this.#pending.clear();
    await Promise.allSettled([...this.#workers.values(), ...this.#startWorkers.values(), this.#mutation]);
  }
}
