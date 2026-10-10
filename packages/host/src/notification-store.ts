import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { notificationKey, notificationMessage, NotificationSourceEventSchema, NotificationInputSchema, PROTOCOL_VERSION,
  type ActiveNotification, type NotificationInput, type NotificationSnapshot, type NotificationSourceEvent } from "@pi-remote/protocol";

type Record = { item: ActiveNotification; transient: boolean; deviceId?: string };
type Projection = { sessionId: string | null; epoch?: string; active: boolean; sourceRevision: number; revision: number;
  verification: "confirmed" | "unknown"; complete: boolean; records: Map<string, Record>; dismissed: Map<string, Set<string>>;
  outcomeReceipts: Set<string> };

/** Current-state middleware. Native meaning belongs to producers; no message matching here. */
export class NotificationStore {
  readonly hostEpoch = randomUUID();
  readonly #runtimes = new Map<string, Projection>();
  #revision = 0;
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(readonly changed: (runtimeId: string) => void, readonly now = Date.now) {
    this.#timer = setInterval(() => this.expire(), 1000); this.#timer.unref();
  }
  #get(runtimeId: string): Projection | undefined {
    let state = this.#runtimes.get(runtimeId);
    if (state === undefined) {
      if (this.#runtimes.size >= 2048) {
        const retired = [...this.#runtimes].find(([, projection]) => !projection.active);
        if (retired === undefined) return undefined;
        this.#runtimes.delete(retired[0]);
      }
      state = { sessionId: null, active: true, sourceRevision: -1, revision: 0, verification: "unknown", complete: false,
        records: new Map(), dismissed: new Map(), outcomeReceipts: new Set() }; this.#runtimes.set(runtimeId, state);
    }
    return state;
  }
  #change(runtimeId: string, state: Projection): void { state.revision = ++this.#revision; this.changed(runtimeId); }
  /** Only the authenticated runtime connection lifecycle can permit a new producer epoch. */
  attach(runtimeId: string, sessionId?: string): boolean {
    const state = this.#get(runtimeId);
    if (!state) return false;
    if (state.sessionId !== (sessionId ?? null)) { state.records.clear(); state.dismissed.clear(); }
    for (const record of state.records.values()) record.item = { ...record.item, verification: "unknown" };
    delete state.epoch; state.sourceRevision = -1; state.verification = "unknown"; state.active = true; state.complete = false;
    state.sessionId = sessionId ?? null; this.#change(runtimeId, state);
    return true;
  }
  offline(runtimeId: string): void {
    const state = this.#runtimes.get(runtimeId); if (!state) return;
    if (state.verification === "unknown" && [...state.records.values()].every(record => record.item.verification === "unknown")) return;
    state.verification = "unknown";
    for (const record of state.records.values()) record.item = { ...record.item, verification: "unknown" };
    this.#change(runtimeId, state);
  }
  end(runtimeId: string): void {
    const state = this.#runtimes.get(runtimeId); if (!state) return;
    state.records.clear(); state.dismissed.clear(); delete state.epoch; state.sourceRevision = -1;
    state.verification = "unknown"; state.active = false; state.complete = true; this.#change(runtimeId, state);
  }
  has(runtimeId: string): boolean { return this.#runtimes.has(runtimeId); }
  needsAttach(runtimeId: string): boolean { return this.#runtimes.get(runtimeId)?.active === false; }
  apply(runtimeId: string, event: NotificationSourceEvent): boolean {
    const state = this.#runtimes.get(runtimeId);
    if (!state?.active) return false;
    if (state.epoch !== undefined && event.producerEpoch !== state.epoch) return false;
    if (state.sessionId !== null && state.sessionId !== event.sessionId) return false;
    if (event.revision < state.sourceRevision) return false;
    const parsed = NotificationSourceEventSchema.safeParse(event);
    if (!parsed.success) {
      if (Number.isSafeInteger(event.revision) && event.revision >= 0) state.sourceRevision = event.revision;
      state.complete = false; state.verification = "unknown"; this.#change(runtimeId, state); return false;
    }
    if (!event.complete) {
      state.epoch = event.producerEpoch; state.sessionId = event.sessionId; state.sourceRevision = event.revision;
      if (state.verification !== "unknown" || state.complete) {
        state.verification = "unknown"; state.complete = false; this.#change(runtimeId, state);
      }
      return false;
    }
    if (event.revision === state.sourceRevision && state.verification === "confirmed" && state.complete) return true;
    const first = state.epoch === undefined;
    const fresh = first || event.revision > state.sourceRevision;
    const records = new Map(state.records);
    const keep = new Set(event.notifications.map(notificationKey));
    for (const [key, record] of records) if (!record.transient && !keep.has(key)) records.delete(key);
    for (const input of event.notifications) this.#put(records, input, event.producerEpoch, false);
    // Reconnection baselines never contain one-shot results. A repeated source revision cannot replay them.
    const receipts: string[] = [];
    if (fresh) for (const input of event.outcomes ?? []) {
      const receipt = JSON.stringify([event.producerEpoch, notificationKey(input)]);
      if (state.outcomeReceipts.has(receipt)) continue;
      this.#put(records, input, event.producerEpoch, true); receipts.push(receipt);
    }
    if (records.size > 64 || Buffer.byteLength(JSON.stringify([...records.values()]), "utf8") > 256 * 1024) {
      state.complete = false; state.verification = "unknown"; this.#change(runtimeId, state); return false;
    }
    const changed = first || !state.complete || state.verification !== "confirmed" || !isDeepStrictEqual(records, state.records);
    state.epoch = event.producerEpoch; state.sourceRevision = event.revision; state.sessionId = event.sessionId;
    state.records = records; state.complete = true; state.verification = "confirmed";
    for (const receipt of receipts) this.#rememberOutcome(state, receipt);
    this.#pruneDismissals(state);
    if (changed) this.#change(runtimeId, state);
    return true;
  }
  #put(records: Map<string, Record>, input: NotificationInput, epoch: string, transient: boolean, deviceId?: string): void {
    const key = notificationKey(input) + (deviceId === undefined ? "" : `:${deviceId}`);
    const existing = records.get(key);
    const prior = existing?.item.producerEpoch === epoch ? existing : undefined;
    if (prior && prior.item.producerEpoch === epoch && isDeepStrictEqual({ ...prior.item, notificationId: undefined, producerEpoch: undefined,
      createdAt: undefined, updatedAt: undefined, expiresAt: undefined, verification: undefined },
    { ...input, notificationId: undefined, producerEpoch: undefined, createdAt: undefined, updatedAt: undefined,
      expiresAt: undefined, verification: undefined }) && prior.item.verification === "confirmed") return;
    const at = this.now();
    records.set(key, { transient, ...(deviceId === undefined ? {} : { deviceId }), item: { ...input,
      notificationId: prior?.item.notificationId ?? randomUUID(), producerEpoch: epoch,
      createdAt: prior?.item.createdAt ?? at, updatedAt: at, verification: "confirmed",
      ...(input.displayMs === undefined ? {} : { expiresAt: prior?.item.expiresAt ?? at + input.displayMs }) } });
  }
  outcome(runtimeId: string, input: NotificationInput, deviceId?: string): void {
    const state = this.#runtimes.get(runtimeId);
    if (!state?.active) return;
    const item = NotificationInputSchema.parse({ ...input, message: notificationMessage(input.message), lifecycle: "outcome",
      displayMs: input.displayMs ?? (input.severity === "info" ? 8000 : 30_000) });
    const receipt = JSON.stringify([this.hostEpoch, notificationKey(item), deviceId]);
    if (state.outcomeReceipts.has(receipt) || state.records.size >= 64) return;
    const records = new Map(state.records); this.#put(records, item, this.hostEpoch, true, deviceId);
    if (Buffer.byteLength(JSON.stringify([...records.values()]), "utf8") > 256 * 1024) return;
    this.#rememberOutcome(state, receipt);
    if (!isDeepStrictEqual(records, state.records)) { state.records = records; this.#change(runtimeId, state); }
  }
  #rememberOutcome(state: Projection, receipt: string): void {
    state.outcomeReceipts.add(receipt);
    if (state.outcomeReceipts.size > 256) state.outcomeReceipts.delete(state.outcomeReceipts.values().next().value!);
  }
  expire(): void {
    for (const [runtimeId, state] of this.#runtimes) {
      let changed = false;
      for (const [key, record] of state.records) if (record.item.expiresAt !== undefined && record.item.expiresAt <= this.now()) {
        state.records.delete(key); changed = true;
      }
      if (changed) { this.#pruneDismissals(state); this.#change(runtimeId, state); }
    }
  }
  dismiss(runtimeId: string, deviceId: string, notificationId: string): void {
    const state = this.#runtimes.get(runtimeId); if (!state) return;
    if (![...state.records.values()].some(record => record.item.notificationId === notificationId
      && (record.deviceId === undefined || record.deviceId === deviceId))) return;
    const ids = state.dismissed.get(deviceId) ?? new Set<string>();
    if (ids.has(notificationId)) return;
    ids.add(notificationId); state.dismissed.set(deviceId, ids); this.#change(runtimeId, state);
  }
  #pruneDismissals(state: Projection): void {
    const ids = new Set([...state.records.values()].map(record => record.item.notificationId));
    for (const [device, hidden] of state.dismissed) {
      for (const id of hidden) if (!ids.has(id)) hidden.delete(id);
      if (hidden.size === 0) state.dismissed.delete(device);
    }
  }
  releaseDevice(deviceId: string): void {
    for (const state of this.#runtimes.values()) {
      state.dismissed.delete(deviceId);
      for (const [key, record] of state.records) if (record.deviceId === deviceId) state.records.delete(key);
    }
  }
  snapshot(runtimeId: string, deviceId: string): NotificationSnapshot & { protocolVersion: typeof PROTOCOL_VERSION } {
    this.expire(); const state = this.#runtimes.get(runtimeId);
    return { type: "notification.snapshot", protocolVersion: PROTOCOL_VERSION, hostEpoch: this.hostEpoch, runtimeId,
      sessionId: state?.sessionId ?? null, revision: state?.revision ?? this.#revision, complete: state?.complete ?? false, verification: state?.verification ?? "unknown",
      notifications: [...(state?.records.values() ?? [])].filter(record => (record.deviceId === undefined || record.deviceId === deviceId)
        && !state?.dismissed.get(deviceId)?.has(record.item.notificationId)).map(record => record.item) };
  }
  close(): void { clearInterval(this.#timer); this.#runtimes.clear(); }
}
