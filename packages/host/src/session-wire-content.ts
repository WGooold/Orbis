import { stateDelta, type RuntimeEvent, type SessionLiveState, type StateDeltaOperation } from "@orbis/protocol";

type Snapshot = Extract<RuntimeEvent, { type: "session.snapshot" | "session.patch" }>;
type Reference = { path: string[]; target: string[] };
type Shared = { format: "shared-v1"; references: Reference[]; liveDelta?: { baseRevision: number; operations: StateDeltaOperation[] } };
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** FT-G07: shared bodies and live edits are a wire representation only. The
 * source event stays intact for Host authority, recovery and deployed clients.
 * Cache eviction merely sends the next live state in full. */
export class SessionWireContent {
  readonly #live = new Map<string, { session: string; epoch: string; seq: number; value: SessionLiveState; bytes: number }>();
  #projected = new WeakMap<object, { event: Snapshot; sharedContent: Shared }>();
  #bytes = 0;

  clear(): void { this.#live.clear(); this.#bytes = 0; this.#projected = new WeakMap(); }
  project(message: object): object {
    const envelope = message as Record<string, unknown>, event = envelope.event as Snapshot | undefined;
    if (envelope.type !== "runtime.event" || !event || !["session.snapshot", "session.patch"].includes(event.type)) return message;
    const cached = this.#projected.get(event);
    if (cached) return { ...envelope, ...cached };
    const shared: Shared = { format: "shared-v1", references: [] };
    let projected: Snapshot = event;
    const runtime = String(envelope.runtimeId), old = this.#live.get(runtime);
    if (event.type === "session.patch" && event.source.ready && old?.session === event.sessionId && old.epoch === event.source.epoch && old.seq === event.baseSeq) {
      const operations = stateDelta(old.value, event.live);
      const delta = operations && { baseRevision: old.seq, operations };
      if (delta && bytes(delta) < bytes(event.live) * 0.8) {
        shared.liveDelta = delta;
        projected = { ...event, live: { complete: false, turn: null, messages: [], tools: [] } };
      }
    }
    if (event.source?.ready && event.live?.complete && (!old || old.epoch !== event.source.epoch || old.seq <= event.source.seq)) {
      const size = bytes(event.live);
      if (size <= 4 * 1024 * 1024) {
        this.#bytes -= old?.bytes ?? 0; this.#live.delete(runtime);
        this.#live.set(runtime, { session: event.sessionId, epoch: event.source.epoch, seq: event.source.seq, value: structuredClone(event.live), bytes: size });
        this.#bytes += size;
        while (this.#bytes > 16 * 1024 * 1024 || this.#live.size > 64) {
          const key = this.#live.keys().next().value!; this.#bytes -= this.#live.get(key)!.bytes; this.#live.delete(key);
        }
      }
    }
    // Only registered body strings are shared, never target IDs, timestamps or risk fields.
    const strings = new Map<string, string[]>();
    function visit(value: unknown, path: string[]): unknown {
      if (path.length > 32) return value;
      if (typeof value === "string" && value.length >= 128 && ["text", "thinking", "content", "summary"].includes(path.at(-1) ?? "")) {
        const target = strings.get(value);
        if (target && shared.references.length < 512 && bytes({ path, target }) + 8 < bytes(value)) { shared.references.push({ path, target }); return ""; }
        strings.set(value, path); return value;
      }
      if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, String(index)]));
      if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]));
      return value;
    }
    projected = visit(projected, []) as Snapshot;
    if (shared.references.length === 0 && shared.liveDelta === undefined) return message;
    const result = { event: projected, sharedContent: shared };
    this.#projected.set(event, result);
    return { ...envelope, ...result };
  }
}
