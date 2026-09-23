import { randomUUID } from "node:crypto";

import { SESSION_SYNC_MAX_BYTES, type RuntimeEvent, type SessionSyncRequest } from "@pi-remote/protocol";

import { sessionSyncWireBytes, SESSION_SYNC_WIRE_LIMIT_BYTES, type DeviceLink } from "./device-link.js";

const BACKEND_PREFIX = "host-sync:";
const RETAIN_MS = 300_000;
const MAX_RECORDS = 32;
const MAX_PENDING = 8;
const MAX_ACTIVE = 2;
const MAX_SENDS = 4;
const RETRY_AFTER_MS = 30_000;
const RESERVED_BYTES = sessionSyncWireBytes(SESSION_SYNC_MAX_BYTES);
type Stage = "queued" | "processing" | "sending" | "delivered" | "failed";
type Task = {
  deviceId: string; runtimeId: string; commandId: string; command: SessionSyncRequest;
  fingerprint: string; createdAt: number; lastDispatch: number; attempts: number; stage: Stage;
  backendId: string; reserved: number;
};
type Options = {
  link: (deviceId: string) => Pick<DeviceLink, "active" | "sendSessionSnapshot" | "sessionSyncQueuedBytes"> | undefined;
  dispatch: (runtimeId: string, commandId: string, command: SessionSyncRequest) => "handled" | "offline" | "unsupported";
  encodeEvent: (runtimeId: string, event: RuntimeEvent) => Buffer;
  sendEvent: (deviceId: string, runtimeId: string, event: RuntimeEvent) => void;
  error: (deviceId: string, commandId: string, code: string, message?: string) => void;
  log?: (line: string) => void;
  now?: () => number;
};

/** Host-owned correlation is registered before dispatch, including synchronous backend responses.
 * Bodies live only in the bounded DeviceLink queue; completed records retain parameters, not pages. */
export class SessionSyncTasks {
  readonly #options: Options;
  readonly #tasks = new Map<string, Task>();
  readonly #backend = new Map<string, Task>();
  readonly #timer: ReturnType<typeof setInterval>;
  #scheduled = false;
  #closed = false;

  constructor(options: Options) {
    this.#options = options;
    this.#timer = setInterval(() => this.tick(), 1_000);
    this.#timer.unref();
  }

  #now(): number { return this.#options.now?.() ?? Date.now(); }
  #key(deviceId: string, commandId: string): string { return JSON.stringify([deviceId, commandId]); }
  #current(task: Task): boolean { return this.#tasks.get(this.#key(task.deviceId, task.commandId)) === task; }

  request(deviceId: string, runtimeId: string, commandId: string, command: SessionSyncRequest): void {
    this.#expire();
    const key = this.#key(deviceId, commandId);
    const fingerprint = JSON.stringify([runtimeId, command.sessionId, command.syncId, command.range,
      command.knownLeafId ?? null, command.targetLeafId ?? null, command.beforeEntryId ?? null, command.maxEntries ?? 100]);
    const existing = this.#tasks.get(key);
    const duplicateSync = [...this.#tasks.values()].find((task) => task.deviceId === deviceId &&
      task.command.syncId === command.syncId && task !== existing);
    if (duplicateSync !== undefined || (existing !== undefined && existing.fingerprint !== fingerprint)) {
      this.#options.error(deviceId, commandId, "session_sync_id_conflict");
      return;
    }
    if (existing !== undefined) {
      if (existing.stage === "queued" || existing.stage === "processing" || existing.stage === "sending") return;
      if (existing.stage === "failed" || existing.attempts >= MAX_SENDS) {
        this.#options.error(deviceId, commandId, "session_sync_retry_exhausted");
        return;
      }
      if (this.#now() - existing.lastDispatch < RETRY_AFTER_MS) return;
      if ([...this.#tasks.values()].filter((task) => task.deviceId === deviceId && this.#pending(task)).length >= MAX_PENDING) {
        this.#options.error(deviceId, commandId, "session_sync_busy");
        return;
      }
      existing.stage = "queued";
      this.#schedule();
      return;
    }
    if (this.#closed || this.#options.link(deviceId)?.active === undefined) {
      this.#options.error(deviceId, commandId, "session_sync_path_unavailable");
      return;
    }
    const records = [...this.#tasks.values()].filter((task) => task.deviceId === deviceId);
    if (records.filter((task) => this.#pending(task)).length >= MAX_PENDING) {
      this.#options.error(deviceId, commandId, "session_sync_busy");
      return;
    }
    if (records.length >= MAX_RECORDS) {
      const retired = records.find((task) => !this.#pending(task));
      if (retired === undefined) {
        this.#options.error(deviceId, commandId, "session_sync_busy");
        return;
      }
      this.#remove(retired);
    }
    this.#tasks.set(key, { deviceId, runtimeId, commandId, command: { ...command }, fingerprint,
      createdAt: this.#now(), lastDispatch: 0, attempts: 0, stage: "queued", backendId: "", reserved: 0 });
    this.#schedule();
  }

  /** True means consumed. Unsolicited/obsolete snapshots never enter a device broadcast queue. */
  handleEvent(runtimeId: string, event: RuntimeEvent): boolean {
    const id = event.type === "session.snapshot" ? event.syncId
      : event.type === "command.result" || event.type === "runtime.error" ? event.commandId : undefined;
    const task = id === undefined ? undefined : this.#backend.get(id);
    if (task === undefined || task.runtimeId !== runtimeId) {
      return event.type === "session.snapshot" || id?.startsWith(BACKEND_PREFIX) === true;
    }
    if (event.type === "session.snapshot") {
      if (task.stage !== "processing") return true;
      const payload = this.#options.encodeEvent(runtimeId, { ...event, syncId: task.command.syncId });
      if (payload.byteLength > SESSION_SYNC_MAX_BYTES) {
        this.#fail(task, "session_sync_response_too_large");
        return true;
      }
      task.stage = "sending";
      const start = this.#now();
      const link = this.#options.link(task.deviceId);
      this.#log(task, "response", `entries=${event.entries.length} plaintextBytes=${payload.byteLength} wireBytes=${sessionSyncWireBytes(payload.byteLength)} queueBytes=${link?.sessionSyncQueuedBytes ?? 0} elapsedMs=${start - task.createdAt}`);
      const accepted = link?.sendSessionSnapshot(payload, (written) => {
        if (!this.#current(task)) return;
        if (!written) this.#fail(task, "session_sync_path_lost");
        else {
          task.stage = "delivered";
          task.reserved = 0;
          this.#log(task, "socket", `sendMs=${this.#now() - start}`);
          this.#schedule();
        }
      }) ?? false;
      if (!accepted && task.stage === "sending") this.#fail(task, "session_sync_busy_or_unavailable");
    } else if (event.type === "command.result") {
      // A success ACK is independent of snapshot delivery. It does not release the reservation.
      if (event.ok || event.status === "pending") {
        this.#options.sendEvent(task.deviceId, runtimeId, { ...event, commandId: task.commandId });
      } else if (task.stage === "processing") this.#fail(task, "session_sync_backend_failed", event.error);
    } else if (event.type === "runtime.error" && task.stage === "processing") {
      this.#fail(task, "session_sync_backend_failed", event.message);
    }
    return true;
  }

  #pending(task: Task): boolean { return task.stage === "queued" || task.stage === "processing" || task.stage === "sending"; }
  #fail(task: Task, code: string, message?: string): void {
    task.stage = "failed";
    task.reserved = 0;
    this.#options.error(task.deviceId, task.commandId, code, message);
    this.#log(task, "failed", `code=${code}`);
    this.#schedule();
  }
  #remove(task: Task): void {
    this.#tasks.delete(this.#key(task.deviceId, task.commandId));
    this.#backend.delete(task.backendId);
  }
  #expire(): void {
    for (const task of this.#tasks.values()) {
      if (this.#now() - task.createdAt < RETAIN_MS) continue;
      if (this.#pending(task)) this.#options.error(task.deviceId, task.commandId, "session_sync_expired");
      this.#remove(task);
    }
  }
  #schedule(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => { this.#scheduled = false; if (!this.#closed) this.tick(); });
  }

  tick(): void {
    this.#expire();
    const queued = [...this.#tasks.values()].filter((task) => task.stage === "queued")
      .sort((a, b) => Number(a.command.range === "catchup") - Number(b.command.range === "catchup"));
    for (const task of queued) {
      if (!this.#current(task)) continue;
      const active = [...this.#tasks.values()].filter((other) => other.deviceId === task.deviceId && other.reserved > 0);
      if (active.length >= MAX_ACTIVE || active.reduce((sum, other) => sum + other.reserved, 0) + RESERVED_BYTES > SESSION_SYNC_WIRE_LIMIT_BYTES) continue;
      const backgroundActive = active.some((other) => other.command.range === "catchup");
      if (task.command.range === "catchup" && backgroundActive) continue;
      if (task.command.range !== "catchup" && active.length === MAX_ACTIVE - 1 && !backgroundActive &&
        queued.some((other) => other.deviceId === task.deviceId && other.command.range === "catchup" && other.stage === "queued")) continue;
      if (this.#options.link(task.deviceId)?.active === undefined) {
        this.#fail(task, "session_sync_path_unavailable");
        continue;
      }
      this.#backend.delete(task.backendId);
      task.backendId = BACKEND_PREFIX + randomUUID();
      task.stage = "processing";
      task.reserved = RESERVED_BYTES;
      task.lastDispatch = this.#now();
      task.attempts += 1;
      this.#backend.set(task.backendId, task);
      this.#log(task, "dispatch", `reservedBytes=${active.reduce((sum, other) => sum + other.reserved, 0) + RESERVED_BYTES}`);
      try {
        const result = this.#options.dispatch(task.runtimeId, task.backendId, { ...task.command, syncId: task.backendId });
        if (result !== "handled") this.#fail(task, result === "offline" ? "runtime_offline" : "unsupported_command");
      } catch {
        this.#fail(task, "session_sync_backend_failed");
      }
    }
  }

  #log(task: Task, stage: string, detail: string): void {
    this.#options.log?.(`[session.sync] stage=${stage} device=${task.deviceId} runtime=${task.runtimeId} command=${task.commandId} sync=${task.command.syncId} range=${task.command.range} attempt=${task.attempts} ${detail}`);
  }
  clearDevice(deviceId: string): void {
    for (const task of this.#tasks.values()) if (task.deviceId === deviceId) this.#remove(task);
  }
  stats(deviceId: string): { records: number; pending: number; active: number; reservedBytes: number } {
    const tasks = [...this.#tasks.values()].filter((task) => task.deviceId === deviceId);
    return { records: tasks.length, pending: tasks.filter((task) => this.#pending(task)).length,
      active: tasks.filter((task) => task.reserved > 0).length, reservedBytes: tasks.reduce((sum, task) => sum + task.reserved, 0) };
  }
  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#tasks.clear();
    this.#backend.clear();
  }
}
