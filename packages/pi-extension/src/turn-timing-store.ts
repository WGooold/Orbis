import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeTurnTimingSchema, type RuntimeTurnTiming } from "@pi-remote/protocol";

const STORE_VERSION = 1;
const SIDECAR_SUFFIX = ".pi-remote-turn-timings.json";

type PersistedTurnTimingStore = {
  version: typeof STORE_VERSION;
  sessionId?: string;
  timings: RuntimeTurnTiming[];
};


/** Returns the sidecar path without touching the append-only Pi Session file. */
export function turnTimingSidecarPath(sessionFile: string): string {
  return `${sessionFile}${SIDECAR_SUFFIX}`;
}

/**
 * Persists completed turn timings next to a Pi Session. The sidecar is deliberately keyed by the
 * Session file rather than the current branch: timings are metadata about persisted assistant
 * messages and can be projected onto any branch that contains their message ID.
 */
export class PiTurnTimingStore {
  readonly #path: string | undefined;
  readonly #sessionId: string | undefined;
  readonly #timings = new Map<string, RuntimeTurnTiming>();
  #writeChain: Promise<void> = Promise.resolve();

  constructor(sessionFile: string | undefined, sessionId?: string) {
    this.#path = sessionFile === undefined ? undefined : turnTimingSidecarPath(sessionFile);
    this.#sessionId = sessionId;
  }

  async load(): Promise<void> {
    await this.#writeChain.catch(() => {});
    this.#timings.clear();
    if (this.#path === undefined) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      if (!parsed || typeof parsed !== "object") return;
      const store = parsed as Partial<PersistedTurnTimingStore>;
      if (store.version !== STORE_VERSION || !Array.isArray(store.timings)) return;
      const timings = RuntimeTurnTimingSchema.array().safeParse(store.timings);
      if (!timings.success) return;
      for (const timing of timings.data) this.#timings.set(timing.turnId, timing);
    } catch {
      // A missing or corrupt sidecar must not prevent Pi from loading the Session. Legacy timing
      // entries remain readable through turnTimingsFromEntries and a later completion can repair
      // the sidecar.
    }
  }

  list(): RuntimeTurnTiming[] {
    return [...this.#timings.values()];
  }

  /** Adds timings from a forked Session without rewriting or deleting existing ones. */
  async import(timings: readonly RuntimeTurnTiming[]): Promise<void> {
    let changed = false;
    for (const timing of timings) {
      if (this.#timings.has(timing.turnId)) continue;
      this.#timings.set(timing.turnId, timing);
      changed = true;
    }
    if (changed && this.#path !== undefined) {
      this.#writeChain = this.#writeChain.catch(() => {}).then(() => this.#flush());
      await this.#writeChain;
    }
  }

  async record(timing: RuntimeTurnTiming): Promise<void> {
    this.#timings.set(timing.turnId, timing);
    if (this.#path === undefined) return;
    this.#writeChain = this.#writeChain.catch(() => {}).then(() => this.#flush());
    await this.#writeChain;
  }

  async #flush(): Promise<void> {
    if (this.#path === undefined) return;
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const payload: PersistedTurnTimingStore = {
      version: STORE_VERSION,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      timings: this.list(),
    };
    try {
      await writeFile(temporary, JSON.stringify(payload), "utf8");
      try {
        await rename(temporary, this.#path);
      } catch (error) {
        // Windows does not replace an existing target for every filesystem/provider combination.
        // Keep the write atomic where possible, with a narrow compatibility fallback.
        const code = error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
        await unlink(this.#path).catch(() => {});
        await rename(temporary, this.#path);
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
