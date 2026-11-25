/**
 * LAUNCH-QUEUE-01 (ADR-0072): Host session operations wait only for earlier work
 * on the same resource. A slow or stuck native start must not hold launches of
 * other launch identities, sessions, devices or agents.
 */
export class KeyedLanes {
  readonly #tails = new Map<string, Promise<void>>();

  /** Runs after every earlier task sharing any key settles; tasks with disjoint keys run concurrently. */
  run<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)];
    const earlier = unique.flatMap(key => this.#tails.get(key) ?? []);
    const result = Promise.all(earlier).then(work);
    const tail = result.then(() => undefined, () => undefined);
    for (const key of unique) this.#tails.set(key, tail);
    void tail.then(() => { for (const key of unique) if (this.#tails.get(key) === tail) this.#tails.delete(key); });
    return result;
  }
}

/** Provider settings of one group are shared by the terminal and desktop flavours of an agent. */
export const providerGroup = (kind: string): string => kind === "codexDesktop" ? "codex" : kind === "dshDesktop" ? "dsh" : kind === "kimiCodeDesktop" ? "kimiCode" : kind;

const ANY_GROUP = "\u0000any";

/**
 * Launches and activations hold their provider group shared; a provider change
 * holds it exclusively. New launches wait for a running change, while a change
 * never waits for launches: it checks `busy` and refuses instead.
 */
export class ProviderLaunchGate {
  readonly #shared = new Map<string, number>();
  readonly #exclusive = new Map<string, Promise<void>>();

  /** `undefined` is an activation whose agent is resolved later; it conflicts with every group. */
  async enter(group: string | undefined): Promise<() => void> {
    for (;;) {
      const changing = group === undefined ? [...this.#exclusive.values()] : this.#exclusive.has(group) ? [this.#exclusive.get(group)!] : [];
      if (changing.length === 0) break;
      await Promise.all(changing);
    }
    // Check and count in the same turn, so a change that starts later always observes this holder.
    const key = group ?? ANY_GROUP;
    this.#shared.set(key, (this.#shared.get(key) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (this.#shared.get(key) ?? 1) - 1;
      if (left > 0) this.#shared.set(key, left); else this.#shared.delete(key);
    };
  }

  busy(group: string): boolean { return this.#shared.has(group) || this.#shared.has(ANY_GROUP); }

  /** Callers serialize changes; this only fences launches of the group while `work` runs. */
  async exclusive<T>(group: string, work: () => Promise<T>): Promise<T> {
    let reopen!: () => void;
    const closed = new Promise<void>(resolve => { reopen = resolve; });
    this.#exclusive.set(group, closed);
    try { return await work(); }
    finally {
      if (this.#exclusive.get(group) === closed) this.#exclusive.delete(group);
      reopen();
    }
  }
}
