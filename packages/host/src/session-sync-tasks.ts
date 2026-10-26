import { randomUUID } from "node:crypto";

import { SESSION_SYNC_DEFAULT_MAX_ENTRIES, SESSION_SYNC_MAX_BYTES, type RuntimeEvent, type SessionSyncRequest } from "@orbis/protocol";

import { sessionSyncWireBytes, SESSION_SYNC_WIRE_LIMIT_BYTES, type DeviceLink } from "./device-link.js";

const BACKEND_PREFIX = "host-sync:";
const RETAIN_MS = 300_000;
// ADR-0013 §6：活动名额与 DeviceLink 的线路预算一起扩容，后台仍最多占一个名额。
const MAX_RECORDS = 128;
const MAX_PENDING = 32;
const MAX_ACTIVE = 4;
const MAX_SENDS = 4;
const RETRY_AFTER_MS = 30_000;
/**
 * ADR-0037 §2/§3：协调者声明"仍然活着"的租约；设备据此延长等待，而不是自行判死。
 * 按阶段取值：`processing` 没有中间进展通道（后端只在算完时回一次），给足 120s 避免误杀慢后端；
 * `sending` 每写出一片都算进展，60s 无进展即判定卡死。两者都短于设备 150s 兜底。
 */
const PROCESSING_LEASE_MS = 120_000;
const DELIVERY_LEASE_MS = 60_000;
/** ADR-0037 §4：写完字节之后等设备 applied 回执的上限。只对会回执的设备生效。 */
const ACK_LEASE_MS = 30_000;
const RESERVED_BYTES = sessionSyncWireBytes(SESSION_SYNC_MAX_BYTES);
type Stage = "queued" | "processing" | "sending" | "delivered" | "failed";
type Task = {
  deviceId: string; runtimeId: string; commandId: string; command: SessionSyncRequest;
  fingerprint: string; createdAt: number; lastDispatch: number; lastProgressAt: number;
  attempts: number; stage: Stage; backendId: string; reserved: number;
  /** 设备确认已 applied（ADR-0037 §4）；只有它能证明事务提交成功。 */
  acknowledged: boolean;
};
type Options = {
  link: (deviceId: string) => (Pick<DeviceLink, "active" | "sendSessionSnapshot" | "sessionSyncQueuedBytes"> &
    Partial<Pick<DeviceLink, "sessionSyncRejection">>) | undefined;
  dispatch: (runtimeId: string, commandId: string, command: SessionSyncRequest) => "handled" | "offline" | "unsupported";
  encodeEvent: (runtimeId: string, event: RuntimeEvent) => Buffer;
  acceptSnapshot?: (runtimeId: string, event: Extract<RuntimeEvent, { type: "session.snapshot" }>) => boolean;
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
  /** 会发送 applied 回执的设备；只有它们才受 ack 租约约束（旧设备视为 sent 即完成）。 */
  readonly #ackCapable = new Set<string>();
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
      command.knownLeafId ?? null, command.targetLeafId ?? null, command.beforeEntryId ?? null, command.maxEntries ?? SESSION_SYNC_DEFAULT_MAX_ENTRIES,
      command.knownState === undefined ? null : [command.knownState.epoch, command.knownState.seq, command.knownState.head.leafId]]);
    const existing = this.#tasks.get(key);
    const duplicateSync = [...this.#tasks.values()].find((task) => task.deviceId === deviceId &&
      task.command.syncId === command.syncId && task !== existing);
    if (duplicateSync !== undefined || (existing !== undefined && existing.fingerprint !== fingerprint)) {
      this.#rejectRequest(deviceId, runtimeId, commandId, command, "session_sync_id_conflict", "id_conflict");
      return;
    }
    if (existing !== undefined) {
      // ADR-0037 §3：不再静默。协调者必须回答"还在处理"还是"已经结束"，否则设备只能靠本地超时猜。
      if (existing.stage === "queued" || existing.stage === "processing" || existing.stage === "sending") {
        this.#notifyPending(existing);
        return;
      }
      if (existing.stage === "failed" || existing.attempts >= MAX_SENDS) {
        this.#rejectRequest(deviceId, runtimeId, commandId, command, "session_sync_retry_exhausted", "retry_exhausted");
        return;
      }
      if (this.#now() - existing.lastDispatch < RETRY_AFTER_MS) {
        this.#notifyPending(existing);
        return;
      }
      if ([...this.#tasks.values()].filter((task) => task.deviceId === deviceId && this.#pending(task)).length >= MAX_PENDING) {
        this.#rejectRequest(deviceId, runtimeId, commandId, command, "session_sync_busy", "pending_limit");
        return;
      }
      existing.stage = "queued";
      this.#schedule();
      return;
    }
    if (this.#closed || this.#options.link(deviceId)?.active === undefined) {
      this.#rejectRequest(deviceId, runtimeId, commandId, command, "session_sync_path_unavailable", this.#closed ? "closed" : "path_unavailable");
      return;
    }
    const records = [...this.#tasks.values()].filter((task) => task.deviceId === deviceId);
    if (records.filter((task) => this.#pending(task)).length >= MAX_PENDING) {
      this.#rejectRequest(deviceId, runtimeId, commandId, command, "session_sync_busy", "pending_limit");
      return;
    }
    if (records.length >= MAX_RECORDS) {
      const retired = records.find((task) => !this.#pending(task));
      if (retired === undefined) {
        this.#rejectRequest(deviceId, runtimeId, commandId, command, "session_sync_busy", "record_limit");
        return;
      }
      this.#remove(retired);
    }
    const createdAt = this.#now();
    this.#tasks.set(key, { deviceId, runtimeId, commandId, command: { ...command }, fingerprint,
      createdAt, lastDispatch: 0, lastProgressAt: createdAt, attempts: 0, stage: "queued", backendId: "", reserved: 0,
      acknowledged: false });
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
      if (this.#options.acceptSnapshot?.(runtimeId, event) === false) {
        this.#fail(task, "session_sync_model_rejected");
        return true;
      }
      const payload = this.#options.encodeEvent(runtimeId, { ...event, syncId: task.command.syncId });
      if (payload.byteLength > SESSION_SYNC_MAX_BYTES) {
        this.#fail(task, "session_sync_response_too_large");
        return true;
      }
      task.stage = "sending";
      const start = this.#now();
      task.lastProgressAt = start;
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
      }, () => { if (this.#current(task)) task.lastProgressAt = this.#now(); }, {
        type: "runtime.event", eventType: event.type, runtimeId, sessionId: event.sessionId, payloadBytes: payload.byteLength,
      }) ?? false;
      if (!accepted && task.stage === "sending") {
        const rejection = link?.sessionSyncRejection;
        this.#log(task, "rejected", `reason=${rejection?.reason ?? "unknown"} path=${rejection?.path ?? link?.active ?? "none"} deliveries=${rejection?.deliveries ?? 0} syncQueueBytes=${rejection?.syncQueuedBytes ?? link?.sessionSyncQueuedBytes ?? 0} nonBulkQueueBytes=${rejection?.nonBulkQueuedBytes ?? 0} bulkQueueBytes=${rejection?.bulkQueuedBytes ?? 0} wireBytes=${sessionSyncWireBytes(payload.byteLength)}`);
        this.#fail(task, "session_sync_busy_or_unavailable");
      }
    } else if (event.type === "command.result") {
      // A success ACK is independent of snapshot delivery. It does not release the reservation.
      if (event.ok || event.status === "pending") {
        task.lastProgressAt = this.#now();
        this.#options.sendEvent(task.deviceId, runtimeId, { ...event, commandId: task.commandId });
      } else if (task.stage === "processing") this.#fail(task, "session_sync_backend_failed", event.error);
    } else if (event.type === "runtime.error" && task.stage === "processing") {
      this.#fail(task, "session_sync_backend_failed", event.message);
    }
    return true;
  }

  #pending(task: Task): boolean { return task.stage === "queued" || task.stage === "processing" || task.stage === "sending"; }

  /** 重复请求的协调者回应：不是终态，也不产生第二份工作，只告诉设备"我还在"。 */
  #notifyPending(task: Task): void {
    const stage: "queued" | "processing" | "sending" | "delivered" = task.stage === "failed" ? "queued" : task.stage;
    const leaseMs = stage === "sending" ? DELIVERY_LEASE_MS : PROCESSING_LEASE_MS;
    this.#options.sendEvent(task.deviceId, task.runtimeId, {
      type: "session.sync.pending", commandId: task.commandId, syncId: task.command.syncId, stage, leaseMs,
    });
    this.#log(task, "pending", `stage=${stage} leaseMs=${leaseMs}`);
  }

  /** 设备的提交回执。迟到的 ack 幂等忽略：那时事务可能已被 aborted，设备侧 applied 仍安全。 */
  acknowledge(deviceId: string, syncId: string, result: "applied" | "rejected"): void {
    this.#ackCapable.add(deviceId);
    const task = [...this.#tasks.values()].find((candidate) =>
      candidate.deviceId === deviceId && candidate.command.syncId === syncId);
    if (task === undefined) return;
    task.lastProgressAt = this.#now();
    if (result === "rejected") {
      this.#fail(task, "session_sync_device_rejected");
      return;
    }
    task.acknowledged = true;
    task.stage = "delivered";
    task.reserved = 0;
    this.#log(task, "ack", "applied");
    this.#schedule();
  }
  #fail(task: Task, code: string, message?: string): void {
    task.stage = "failed";
    task.reserved = 0;
    this.#options.error(task.deviceId, task.commandId, code, message);
    // 现场判据：距上次进展多久才被宣布结束（区分"慢"与"死"靠的就是这个数）。
    this.#log(task, "failed", `code=${code} sinceProgressMs=${this.#now() - task.lastProgressAt}`);
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
    // ADR-0037 §2/§7：持有资源的未终止事务必须由协调者宣布结束。只有"无进展"才到期——
    // 有进展（后端确认、快照生成、字节写出）就续期，因此慢不等于死。
    for (const task of this.#tasks.values()) {
      if (task.stage !== "processing" && task.stage !== "sending") continue;
      const lease = task.stage === "processing" ? PROCESSING_LEASE_MS : DELIVERY_LEASE_MS;
      if (this.#now() - task.lastProgressAt < lease) continue;
      this.#fail(task, "session_sync_lease_expired");
    }
    // ADR-0037 §4：写完字节不等于提交。会回执的设备若一直不 ack，说明设备没收到，
    // 协调者按租约 abort 让设备重试；旧设备不回执，因此不受这条约束。
    for (const task of this.#tasks.values()) {
      if (task.stage !== "delivered" || task.acknowledged) continue;
      if (!this.#ackCapable.has(task.deviceId)) continue;
      if (this.#now() - task.lastProgressAt < ACK_LEASE_MS) continue;
      this.#fail(task, "session_sync_ack_timeout");
    }
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
      task.lastProgressAt = task.lastDispatch;
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
  #rejectRequest(deviceId: string, runtimeId: string, commandId: string, command: SessionSyncRequest, code: string, reason: string): void {
    const stats = this.stats(deviceId);
    const link = this.#options.link(deviceId);
    this.#options.log?.(`[session.sync] stage=rejected device=${deviceId} runtime=${runtimeId} command=${commandId} sync=${command.syncId} range=${command.range} code=${code} reason=${reason} path=${link?.active ?? "none"} records=${stats.records} pending=${stats.pending} active=${stats.active} reservedBytes=${stats.reservedBytes} syncQueueBytes=${link?.sessionSyncQueuedBytes ?? 0}`);
    this.#options.error(deviceId, commandId, code);
  }
  clearDevice(deviceId: string): void {
    for (const task of this.#tasks.values()) if (task.deviceId === deviceId) this.#remove(task);
  }
  stats(deviceId: string): { records: number; pending: number; active: number; reservedBytes: number } {
    const tasks = [...this.#tasks.values()].filter((task) => task.deviceId === deviceId);
    return { records: tasks.length, pending: tasks.filter((task) => this.#pending(task)).length,
      active: tasks.filter((task) => task.reserved > 0).length, reservedBytes: tasks.reduce((sum, task) => sum + task.reserved, 0) };
  }
  aggregateStats(): { records: number; pending: number; active: number; reservedBytes: number } {
    const tasks = [...this.#tasks.values()];
    return { records: tasks.length, pending: tasks.filter(task => this.#pending(task)).length,
      active: tasks.filter(task => task.reserved > 0).length, reservedBytes: tasks.reduce((sum, task) => sum + task.reserved, 0) };
  }
  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#tasks.clear();
    this.#backend.clear();
  }
}
