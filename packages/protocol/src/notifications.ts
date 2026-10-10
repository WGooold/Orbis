import { z } from "zod";

const identity = z.string().min(1).max(256);
export const NotificationScopeSchema = z.strictObject({
  turnId: identity.optional(), requestId: identity.optional(), operationId: identity.optional(), commandId: identity.optional(),
});
export const NotificationInputSchema = z.strictObject({
  code: identity, occurrenceId: identity, scope: NotificationScopeSchema,
  severity: z.enum(["info", "warning", "error"]), message: z.string().min(1).max(4096)
    .refine(value => new TextEncoder().encode(value).length <= 4096, "Notification exceeds 4 KiB"),
  lifecycle: z.enum(["condition", "outcome"]),
  displayMs: z.number().int().min(1000).max(300_000).optional(),
}).refine(value => value.lifecycle === "outcome" || value.displayMs === undefined,
  "Conditions do not expire");
export type NotificationInput = z.infer<typeof NotificationInputSchema>;
export const NotificationSourceEventSchema = z.strictObject({
  type: z.literal("notification.source"), producerEpoch: identity, sessionId: identity,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), complete: z.boolean(),
  notifications: z.array(NotificationInputSchema).max(64),
  /** One-shot results are not replayed by a source baseline. */
  outcomes: z.array(NotificationInputSchema).max(64).optional(),
}).refine(value => value.notifications.every(item => item.displayMs === undefined)
  && (value.outcomes ?? []).every(item => item.lifecycle === "outcome" && item.displayMs !== undefined)
  && new Set(value.notifications.map(item => notificationKey(item))).size === value.notifications.length,
  "Invalid notification inventory");
export type NotificationSourceEvent = z.infer<typeof NotificationSourceEventSchema>;
export const ActiveNotificationSchema = NotificationInputSchema.safeExtend({
  notificationId: identity, producerEpoch: identity,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().optional(), verification: z.enum(["confirmed", "unknown"]),
});
export type ActiveNotification = z.infer<typeof ActiveNotificationSchema>;
export const NotificationSnapshotSchema = z.strictObject({
  type: z.literal("notification.snapshot"), protocolVersion: z.number().int(),
  hostEpoch: identity, runtimeId: identity, sessionId: identity.nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  complete: z.boolean(), verification: z.enum(["confirmed", "unknown"]),
  notifications: z.array(ActiveNotificationSchema).max(64),
});
export type NotificationSnapshot = z.infer<typeof NotificationSnapshotSchema>;

export function notificationKey(item: Pick<NotificationInput, "code" | "occurrenceId" | "scope">): string {
  return JSON.stringify([item.code, item.occurrenceId, item.scope.turnId, item.scope.requestId,
    item.scope.operationId, item.scope.commandId]);
}

/** Native diagnostics can be arbitrarily long. Bound display text before constructing an event. */
export function notificationMessage(value: string): string {
  if (new TextEncoder().encode(value).length <= 4096) return value || "Unknown notification";
  let message = ""; let bytes = 0;
  for (const character of value) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > 4093) break;
    message += character; bytes += size;
  }
  return `${message}…`;
}

/** A source-owned, bounded current inventory. Host owns result expiration and device views. */
export class NotificationSource {
  readonly #items = new Map<string, NotificationInput>();
  readonly #outcomes = new Set<string>();
  #revision = 0;
  #complete = true;
  #batch = false;
  #pending = false;
  constructor(readonly epoch: string, readonly sessionId: string,
    readonly emit: (event: NotificationSourceEvent) => void) {}

  snapshot(): NotificationSourceEvent {
    return { type: "notification.source", producerEpoch: this.epoch, sessionId: this.sessionId,
      revision: this.#revision, complete: this.#complete, notifications: [...this.#items.values()] };
  }
  announce(): void { this.emit(this.snapshot()); }
  batch(action: () => void): void {
    if (this.#batch) { action(); return; }
    this.#batch = true;
    try { action(); } finally { this.#batch = false; if (this.#pending) { this.#pending = false; this.announce(); } }
  }
  upsert(input: NotificationInput): void {
    const item = NotificationInputSchema.parse({ ...input, message: notificationMessage(input.message) });
    const key = notificationKey(item);
    if (JSON.stringify(this.#items.get(key)) === JSON.stringify(item)) return;
    if (!this.#items.has(key) && this.#items.size >= 64) { this.#complete = false; this.#send(); return; }
    this.#items.set(key, item); this.#send();
  }
  resolve(code: string, occurrenceId?: string): void {
    let changed = false;
    for (const [key, item] of this.#items) {
      if (item.code === code && (occurrenceId === undefined || item.occurrenceId === occurrenceId)) {
        this.#items.delete(key); changed = true;
      }
    }
    if (changed) this.#send();
  }
  outcome(input: Omit<NotificationInput, "lifecycle" | "displayMs"> & { displayMs?: number | undefined }): void {
    const item = NotificationInputSchema.parse({ ...input, message: notificationMessage(input.message), lifecycle: "outcome",
      displayMs: input.displayMs ?? (input.severity === "info" ? 8000 : 30_000) });
    const key = notificationKey(item);
    if (this.#outcomes.has(key)) return;
    this.#outcomes.add(key);
    if (this.#outcomes.size > 256) this.#outcomes.delete(this.#outcomes.values().next().value!);
    this.#send([item]);
  }
  #send(outcomes?: NotificationInput[]): void {
    ++this.#revision;
    if (this.#batch && outcomes === undefined) { this.#pending = true; return; }
    this.emit({ ...this.snapshot(), ...(outcomes === undefined ? {} : { outcomes }) });
  }
}
