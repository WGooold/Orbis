import { randomUUID } from "node:crypto";
import type { AgentKey, RuntimeEvent, RuntimeMetadata } from "@orbis/protocol";
import type { TurnFileChangeService } from "./turn-file-change-service.js";

/** Execution barriers belong to the adapter; this owner serializes captures, not agent work. */
export class TurnChangeCoordinator {
  readonly #service: TurnFileChangeService;
  readonly #scope: (runtimeId: string) => AgentKey | undefined;
  readonly #metadata: (runtimeId: string) => RuntimeMetadata | undefined;
  readonly #pending = new Map<string, Promise<void>>();
  readonly #active = new Map<string, { id: string; nativeIds: Set<string>; controlled: boolean }>();
  readonly #finishing = new Map<string, object>();
  readonly #beginning = new Map<string, AbortController>();
  readonly #barrierMs: number;
  #closed = false;

  constructor(service: TurnFileChangeService, scope: (runtimeId: string) => AgentKey | undefined,
    metadata: (runtimeId: string) => RuntimeMetadata | undefined, barrierMs = 2_000) {
    this.#service = service; this.#scope = scope; this.#metadata = metadata; this.#barrierMs = barrierMs;
  }

  #enqueue(runtimeId: string, operation: () => Promise<void>): Promise<void> {
    const pending = (this.#pending.get(runtimeId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.#pending.set(runtimeId, pending);
    void pending.finally(() => { if (this.#pending.get(runtimeId) === pending) this.#pending.delete(runtimeId); }).catch(() => undefined);
    return pending;
  }

  /** A capture timeout releases native execution but can never claim a complete boundary. */
  #barrier(runtimeId: string, reviewTurnId: string | undefined, work: Promise<void>, controller: AbortController): Promise<void> {
    return new Promise((resolve, reject) => {
      const lost = (): void => { this.#service.markUnreliable(runtimeId, "capture-barrier-released", reviewTurnId); resolve(); };
      controller.signal.addEventListener("abort", lost, { once: true });
      const timer = setTimeout(() => controller.abort(), this.#barrierMs); timer.unref();
      if (controller.signal.aborted) lost();
      void work.then(resolve, reject).finally(() => { clearTimeout(timer); controller.signal.removeEventListener("abort", lost); });
    });
  }

  begin(runtimeId: string, id: string = randomUUID(), controlled = false, reliable = true, capture = true, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const disconnect = (): void => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", disconnect, { once: true });
    this.#beginning.set(runtimeId, controller);
    const work = this.#enqueue(runtimeId, async () => {
      if (this.#closed) return;
      const agent = this.#scope(runtimeId), runtime = this.#metadata(runtimeId);
      if (!agent || !runtime?.cwd) return;
      const previous = this.#active.get(runtimeId);
      if (previous?.id === id) return;
      if (previous) await this.#service.finish(runtimeId, { reviewTurnId: previous.id, reliable: false, outcome: "unknown" });
      this.#active.set(runtimeId, { id, controlled, nativeIds: new Set() });
      const aborted = (): void => this.#service.markUnreliable(runtimeId, "capture-barrier-disconnected", id);
      controller.signal.addEventListener("abort", aborted, { once: true });
      try {
        await this.#service.begin({ runtimeId, agent, cwd: runtime.cwd, reviewTurnId: id, reliable: reliable && !controller.signal.aborted, capture });
        if (controller.signal.aborted) aborted();
      } finally { controller.signal.removeEventListener("abort", aborted); }
    });
    void work.finally(() => {
      signal?.removeEventListener("abort", disconnect);
      if (this.#beginning.get(runtimeId) === controller) this.#beginning.delete(runtimeId);
    }).catch(() => undefined);
    return this.#barrier(runtimeId, id, work, controller);
  }

  hasTurn(runtimeId: string, reviewTurnId: string): boolean { return this.#active.get(runtimeId)?.id === reviewTurnId; }

  started(runtimeId: string, turnId: string): Promise<void> {
    this.#beginning.get(runtimeId)?.abort();
    if (this.#finishing.has(runtimeId)) this.#service.markUnreliable(runtimeId, "next-turn-started-during-capture");
    return this.#enqueue(runtimeId, async () => {
      if (this.#closed) return;
      let active = this.#active.get(runtimeId);
      if (active && !active.controlled && active.nativeIds.size && !active.nativeIds.has(turnId)) {
        await this.#service.finish(runtimeId, { reviewTurnId: active.id, reliable: false, outcome: "unknown" });
        this.#active.delete(runtimeId); active = undefined;
      }
      if (!active) {
        const agent = this.#scope(runtimeId), runtime = this.#metadata(runtimeId);
        if (!agent || !runtime?.cwd) return;
        active = { id: turnId, nativeIds: new Set(), controlled: false };
        this.#active.set(runtimeId, active);
        await this.#service.begin({ runtimeId, agent, cwd: runtime.cwd, reviewTurnId: turnId, reliable: false });
      }
      active.nativeIds.add(turnId);
      this.#service.observeTurn(runtimeId, turnId);
    });
  }

  finish(runtimeId: string, options: { turnId?: string; anchorEntryId?: string;
    outcome?: "completed" | "failed" | "cancelled" | "unknown"; reliable?: boolean; force?: boolean } = {}): Promise<void> {
    if (this.#active.get(runtimeId)?.controlled && !options.force) return Promise.resolve();
    const token = {}, controller = new AbortController();
    this.#finishing.set(runtimeId, token);
    const work = this.#enqueue(runtimeId, async () => {
      const active = this.#active.get(runtimeId);
      if (!active || active.controlled && !options.force) return;
      if (options.turnId && active.nativeIds.size && !active.nativeIds.has(options.turnId) && active.id !== options.turnId) return;
      this.#active.delete(runtimeId);
      await this.#service.finish(runtimeId, { reviewTurnId: active.id,
        ...(options.anchorEntryId ? { anchorEntryId: options.anchorEntryId } : {}),
        outcome: options.outcome ?? "unknown", reliable: (options.reliable ?? true) && !controller.signal.aborted });
    });
    void work.finally(() => { if (this.#finishing.get(runtimeId) === token) this.#finishing.delete(runtimeId); }).catch(() => undefined);
    return this.#barrier(runtimeId, options.turnId ?? this.#active.get(runtimeId)?.id, work, controller);
  }

  observe(runtimeId: string, event: RuntimeEvent): void {
    if (this.#closed) return;
    if (event.type === "turn.started") void this.started(runtimeId, event.turnId).catch(() => undefined);
    if (event.type === "turn.finished") {
      const anchor = event.persistedMessageId;
      void this.finish(runtimeId, { turnId: event.turnId, outcome: event.outcome ?? "unknown", ...(anchor ? { anchorEntryId: anchor } : {}) }).catch(() => undefined);
    }

  }

  async release(runtimeId: string): Promise<void> {
    await this.finish(runtimeId, { reliable: false, force: true, outcome: "unknown" });
    this.#service.releaseRuntime(runtimeId);
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#pending.values()]);
    await Promise.allSettled([...this.#active.keys()].map(runtimeId => this.release(runtimeId)));
  }
}
