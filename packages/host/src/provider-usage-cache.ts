import type { ProviderProfile } from "./provider-manager.js";
import { providerFields } from "./provider-form.js";
import { ProviderError } from "./provider-error.js";
import { queryProviderUsage, UsageQueryError } from "./provider-usage.js";

export type UsageSnapshot = { data?: unknown[]; error?: string; updatedAt?: number; attemptedAt: number };
/** Per-provider cache: transient failures keep the last result; credentials never leave Host. */
export class ProviderUsageCache {
  #values = new Map<string, UsageSnapshot>();
  #pending = new Map<string, Promise<unknown[]>>();
  #generation = new Map<string, number>();
  #timer?: NodeJS.Timeout;
  #ticking = false;
  #closed = false;
  constructor(readonly profiles: () => Promise<ProviderProfile[]>, readonly changed: (profile: ProviderProfile, state: UsageSnapshot) => void,
    readonly query = (profile: ProviderProfile) => queryProviderUsage(profile.usageScript!, providerFields(profile)), readonly now = Date.now) {}
  #key(kind: string, id: string): string { return `${kind}:${id}`; }
  get(kind: string, id: string): UsageSnapshot | undefined { return this.#values.get(this.#key(kind, id)); }
  invalidate(kind: string, id: string): void {
    const key = this.#key(kind, id);
    this.#generation.set(key, (this.#generation.get(key) ?? 0) + 1); this.#values.delete(key);
  }
  async refresh(profile: ProviderProfile): Promise<unknown[]> {
    if (this.#closed) throw new ProviderError("用量查询已停止");
    const key = this.#key(profile.kind, profile.id);
    const pending = this.#pending.get(key); if (pending) return pending;
    if (!profile.usageScript?.enabled) throw new ProviderError("用量查询未启用");
    const generation = this.#generation.get(key) ?? 0;
    const previous = this.#values.get(key);
    const publish = (state: UsageSnapshot): void => {
      if (this.#closed || (this.#generation.get(key) ?? 0) !== generation) return;
      this.#values.set(key, state); this.changed(profile, state);
    };
    const operation = Promise.resolve().then(() => this.query(profile)).then(data => {
      publish({ data, updatedAt: this.now(), attemptedAt: this.now() }); return data;
    }, (error: unknown) => {
      publish({ ...(error instanceof UsageQueryError && error.transient ? previous : {}), attemptedAt: this.now(), error: error instanceof ProviderError ? error.message : "用量查询失败" });
      throw error;
    }).finally(() => this.#pending.delete(key));
    this.#pending.set(key, operation); return operation;
  }
  async tick(): Promise<void> {
    if (this.#closed || this.#ticking) return;
    this.#ticking = true;
    try {
      for (const profile of await this.profiles()) {
        if (this.#closed) break;
        const script = profile.usageScript; const interval = script?.autoQueryInterval ?? 5;
        if (!script?.enabled || interval === 0) continue;
        const previous = this.get(profile.kind, profile.id);
        if (!previous || this.now() - previous.attemptedAt >= interval * 60_000) await this.refresh(profile).catch(() => {});
      }
    } finally { this.#ticking = false; }
  }
  start(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => { void this.tick().catch(() => {}); }, 15_000); this.#timer.unref();
    void this.tick().catch(() => {});
  }
  async close(): Promise<void> {
    this.#closed = true; if (this.#timer) clearInterval(this.#timer);
    await Promise.allSettled(this.#pending.values());
  }
}
