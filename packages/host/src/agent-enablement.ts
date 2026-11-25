import { AgentEnablementChoiceSchema, AgentEnablementRevisionSchema, AgentKindSchema, type AgentKind, type AgentDisableReview } from "@orbis/protocol";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** The exhaustive Host-side catalog. Clients render rows, not per-Agent settings implementations. */
export const agentEnablementCatalog = {
  codex: { label: "Codex CLI" },
  codexDesktop: { label: "Codex Desktop" },
  claude: { label: "Claude Code" },
  dsh: { label: "DeepSeek CLI" },
  dshDesktop: { label: "DeepSeek Desktop" },
  pi: { label: "Pi" },
  kimiCode: { label: "Kimi Code Web" },
  kimiCodeDesktop: { label: "Kimi Code 桌面版" },
  opencode: { label: "OpenCode" },
  agy: { label: "Antigravity CLI" },
  hermes: { label: "Hermes Agent" },
  openclaw: { label: "OpenClaw" },
} as const satisfies Record<AgentKind, { label: string }>;

const fileName = "agent-enablement.json";
const fileSchema = z.strictObject({
  version: z.literal(1),
  revision: AgentEnablementRevisionSchema,
  // Keep entries for unknown kinds on disk when an older Host edits a known kind.
  choices: z.record(z.string(), z.boolean()),
});
type File = z.infer<typeof fileSchema>;

export class AgentDisableConfirmationRequired extends Error {
  constructor(readonly review: AgentDisableReview) { super("请确认停用正在工作的 Agent"); }
}

// Keep sibling sources adjacent without changing the shared AgentKind wire enum.
export const agentEnablementOrder = Object.keys(agentEnablementCatalog) as AgentKind[];

const changeSchema = AgentEnablementChoiceSchema.extend({ kind: AgentKindSchema });
// Desktop bridge only. The paired protocol keeps its negotiated single-source write.
const batchSchema = z.strictObject({
  kinds: z.array(AgentKindSchema).min(1).max(agentEnablementOrder.length).refine(kinds => new Set(kinds).size === kinds.length),
  enabled: z.boolean(),
  expectedRevision: AgentEnablementRevisionSchema,
  reviews: z.partialRecord(AgentKindSchema, AgentEnablementChoiceSchema.shape.review.unwrap()).optional(),
}).refine(({ kinds, enabled, reviews }) => !reviews || (!enabled && Object.keys(reviews).every(kind => kinds.includes(kind as AgentKind))));
type DisableVerifier = (kind: AgentKind, revision: number, review?: string) => void;
const allowed = (): boolean => true;
const noReview: DisableVerifier = () => {};
export class AgentBatchConfirmationRequired extends Error {
  constructor(readonly reviews: AgentDisableReview[]) { super("请确认停用正在工作的 Agent"); }
}
export type AgentEnablementSnapshot = {
  readonly revision: number;
  readonly agents: readonly { readonly kind: AgentKind; readonly label: string; readonly enabled: boolean }[];
};
export type AgentEnablementResult = {
  status: "applied" | "unchanged" | "conflict";
  snapshot: AgentEnablementSnapshot;
};

/**
 * One instance per Host state directory, owned by the Host process. All transports must
 * share this writer. No backend discovery belongs here: migration receives only local evidence.
 */
export class AgentEnablementStore {
  readonly #directory: string;
  readonly #expose: (kind: AgentKind) => boolean;
  readonly #legacyChoices: () => Promise<Readonly<Partial<Record<AgentKind, boolean>>>>;
  #data: File | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, legacyChoices = async (): Promise<Readonly<Partial<Record<AgentKind, boolean>>>> => ({}),
    expose: (kind: AgentKind) => boolean = () => true) {
    this.#directory = directory;
    this.#legacyChoices = legacyChoices;
    this.#expose = expose;
  }

  read(): Promise<AgentEnablementSnapshot> {
    return this.#serial(async () => this.#snapshot(await this.#load()));
  }

  /** One-time compatibility migration for a source that was formerly a single toggle. */
  migrateChoices(migrate: (choices: Readonly<Record<string, boolean>>) => Record<string, boolean>): Promise<AgentEnablementSnapshot> {
    return this.#serial(async () => {
      const data = await this.#load();
      const choices = migrate(data.choices);
      if (JSON.stringify(choices) === JSON.stringify(data.choices)) return this.#snapshot(data);
      const next = fileSchema.parse({ ...data, revision: data.revision + 1, choices });
      await this.#commit(next);
      return this.#snapshot(next);
    });
  }

  async set(input: unknown, stillAuthorized = allowed, verifyDisable = noReview, scoped = false): Promise<AgentEnablementResult> {
    const { kind, enabled, expectedRevision, confirmDisable, review } = changeSchema.parse(input);
    return this.#setChoices([kind], enabled, expectedRevision, stillAuthorized, (kinds, revision) => {
      if (kinds.length && (scoped || !confirmDisable)) verifyDisable(kind, revision, scoped ? review : undefined);
    });
  }

  async setBatch(input: unknown, inspectDisable: (kind: AgentKind, revision: number, scope: string) => AgentDisableReview | undefined): Promise<AgentEnablementResult> {
    const { kinds, enabled, expectedRevision, reviews } = batchSchema.parse(input);
    // Approval covers this exact selection, not a larger batch or a single write.
    const scope = `desktop:batch:${JSON.stringify([...kinds].sort())}`;
    return this.#setChoices(kinds, enabled, expectedRevision, allowed, (disabling, revision) => {
      const affected = disabling.flatMap(kind => inspectDisable(kind, revision, scope) ?? []);
      if (affected.some(review => reviews?.[review.kind as AgentKind] !== review.token)) throw new AgentBatchConfirmationRequired(affected);
    });
  }

  #setChoices(kinds: readonly AgentKind[], enabled: boolean, expectedRevision: number, stillAuthorized: () => boolean,
    verify: (disabling: readonly AgentKind[], revision: number) => void): Promise<AgentEnablementResult> {
    return this.#serial(async () => {
      const data = await this.#load();
      if (!stillAuthorized() || kinds.some(kind => !this.#expose(kind))) throw new Error("Agent settings request is no longer authorized");
      const changed = kinds.filter(kind => !Object.hasOwn(data.choices, kind) || data.choices[kind] !== enabled);
      // Duplicate delivery after a successful commit is already satisfied. A stale
      // write with a different target must never undo a newer edit.
      if (!changed.length) return { status: "unchanged", snapshot: this.#snapshot(data) };
      if (expectedRevision !== data.revision) return { status: "conflict", snapshot: this.#snapshot(data) };
      const choices = { ...data.choices };
      for (const kind of changed) choices[kind] = enabled;
      const next = fileSchema.parse({ ...data, revision: data.revision + 1, choices });
      // Review all of the affected sources at the same revision before replacing anything.
      await this.#commit(next, () => {
        if (!stillAuthorized() || kinds.some(kind => !this.#expose(kind))) throw new Error("Agent settings request is no longer authorized");
        if (!enabled) verify(changed.filter(kind => data.choices[kind] === true), data.revision);
      });
      return { status: "applied", snapshot: this.#snapshot(next) };
    });
  }

  #snapshot(data: File): AgentEnablementSnapshot {
    return {
      revision: data.revision,
      agents: agentEnablementOrder.filter(this.#expose).map(kind => ({ kind, ...agentEnablementCatalog[kind], enabled: Object.hasOwn(data.choices, kind) && data.choices[kind] === true })),
    };
  }

  async #load(): Promise<File> {
    if (this.#data !== undefined) return this.#data;
    let text: string;
    try { text = await readFile(join(this.#directory, fileName), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // An empty persisted choice set also marks migration complete. Future sources
      // default off without seeding their entries from ambient legacy configuration.
      const legacy = await this.#legacyChoices();
      const choices: File["choices"] = {};
      for (const kind of AgentKindSchema.options) {
        const choice = legacy[kind];
        if (Object.hasOwn(legacy, kind) && typeof choice === "boolean") choices[kind] = choice;
      }
      const data: File = { version: 1, revision: 0, choices };
      await this.#commit(data);
      return data;
    }
    return this.#data = fileSchema.parse(JSON.parse(text));
  }

  async #commit(data: File, beforeReplace?: () => void): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const path = join(this.#directory, fileName);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
      finally { await handle.close(); }
      beforeReplace?.();
      await rename(temporary, path);
      this.#data = data;
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

/** A generation lease per enabled source. Adapters check it before publishing or attaching. */
export type AgentEnablementLease = {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
};

export class AgentEnablementGate {
  readonly #active = new Map<AgentKind, AbortController>();
  #revision = -1;

  apply(snapshot: AgentEnablementSnapshot): void {
    if (snapshot.revision <= this.#revision) return;
    this.#revision = snapshot.revision;
    const enabled = new Set(snapshot.agents.filter(row => row.enabled).map(row => row.kind));
    const revoked: AbortController[] = [];
    for (const [kind, controller] of this.#active) {
      if (enabled.has(kind)) continue;
      this.#active.delete(kind);
      revoked.push(controller);
    }
    for (const kind of enabled) {
      if (!this.#active.has(kind)) this.#active.set(kind, new AbortController());
    }
    // Abort listeners run synchronously; expose the whole new policy before calling them.
    for (const controller of revoked) controller.abort();
  }

  allows(kind: AgentKind): boolean { return this.#active.has(kind); }

  lease(kind: AgentKind): AgentEnablementLease | undefined {
    const controller = this.#active.get(kind);
    return controller === undefined ? undefined : {
      signal: controller.signal,
      isCurrent: () => this.#active.get(kind) === controller,
    };
  }
}

/** Shared facade for local and paired writers; publish only committed policy changes. */
export class AgentEnablementController {
  readonly #store: AgentEnablementStore;
  readonly #gate = new AgentEnablementGate();
  #publishedRevision = -1;
  readonly #subscribers = new Set<(snapshot: AgentEnablementSnapshot) => void>();

  constructor(store: AgentEnablementStore, private readonly publish: (snapshot: AgentEnablementSnapshot) => void) {
    this.#store = store;
  }

  async read(): Promise<AgentEnablementSnapshot> {
    const snapshot = await this.#store.read();
    this.#apply(snapshot);
    return snapshot;
  }

  async migrateChoices(migrate: Parameters<AgentEnablementStore["migrateChoices"]>[0]): Promise<AgentEnablementSnapshot> {
    const snapshot = await this.#store.migrateChoices(migrate);
    this.#apply(snapshot);
    return snapshot;
  }

  async set(input: unknown, stillAuthorized: () => boolean = () => true,
    verifyDisable: (kind: AgentKind, revision: number, review?: string) => void = () => {}, scoped = false): Promise<AgentEnablementResult> {
    const result = await this.#store.set(input, stillAuthorized, verifyDisable, scoped);
    this.#apply(result.snapshot);
    return result;
  }

  async setBatch(input: unknown, inspectDisable: Parameters<AgentEnablementStore["setBatch"]>[1]): Promise<AgentEnablementResult> {
    const result = await this.#store.setBatch(input, inspectDisable);
    this.#apply(result.snapshot);
    return result;
  }

  subscribe(listener: (snapshot: AgentEnablementSnapshot) => void): () => void {
    this.#subscribers.add(listener);
    return () => { this.#subscribers.delete(listener); };
  }

  allows(kind: AgentKind): boolean { return this.#gate.allows(kind); }
  lease(kind: AgentKind): AgentEnablementLease | undefined { return this.#gate.lease(kind); }

  #apply(snapshot: AgentEnablementSnapshot): void {
    if (snapshot.revision <= this.#publishedRevision) return;
    this.#publishedRevision = snapshot.revision;
    this.#gate.apply(snapshot);
    this.publish(snapshot);
    for (const listener of this.#subscribers) listener(snapshot);
  }
}

export type AgentLifecycleLease = AgentEnablementLease;
export type AgentLifecycleRegistration = {
  /** Prepare Orbis-owned resources only. The adapter must check the lease before publishing. */
  start(lease: AgentLifecycleLease): Promise<void>;
  /** Release Orbis-owned resources, including after a partial or cancelled start. */
  stop(): Promise<void>;
};

type LifecycleSlot = {
  registration: AgentLifecycleRegistration;
  current?: AbortController;
  running?: AbortController;
  queue: Promise<void>;
};

/**
 * Compose once at the Host boundary. Every source gets its own serialized lifecycle lane,
 * so a slow teardown cannot block unrelated sources. Pause is independent of saved choices.
 */
export class AgentLifecycleRegistry {
  readonly #slots: ReadonlyMap<AgentKind, LifecycleSlot>;

  constructor(
    registrations: Readonly<Partial<Record<AgentKind, AgentLifecycleRegistration>>>,
    private readonly onError: (kind: AgentKind, phase: "start" | "stop", error: unknown) => void,
  ) {
    this.#slots = new Map(AgentKindSchema.options.flatMap(kind => {
      const registration = registrations[kind];
      return registration === undefined ? [] : [[kind, { registration, queue: Promise.resolve() }]];
    }));
  }

  lease(kind: AgentKind): AgentLifecycleLease | undefined {
    const slot = this.#slots.get(kind);
    const controller = slot?.current;
    if (!controller || slot?.running !== controller) return undefined;
    return { signal: controller.signal, isCurrent: () => slot?.current === controller && slot.running === controller };
  }

  reconcile(snapshot: AgentEnablementSnapshot, running: boolean): Promise<void> {
    const wanted = new Set(running ? snapshot.agents.filter(row => row.enabled).map(row => row.kind) : []);
    // First revoke every removed lease. No source can publish a stale result while its
    // cleanup is queued behind a start that has not returned yet.
    for (const [kind, slot] of this.#slots) {
      if (wanted.has(kind) || slot.current === undefined) continue;
      const controller = slot.current;
      delete slot.current;
      delete slot.running;
      controller.abort();
      slot.queue = slot.queue.then(() => this.#stop(kind, slot));
    }
    for (const [kind, slot] of this.#slots) {
      if (!wanted.has(kind) || slot.current !== undefined) continue;
      const controller = slot.current = new AbortController();
      const lease = { signal: controller.signal, isCurrent: () => slot.current === controller };
      slot.queue = slot.queue.then(async () => {
        if (!lease.isCurrent()) return;
        slot.running = controller;
        try { await slot.registration.start(lease); }
        catch (error) {
          // If revoked during start, the queued stop already owns cleanup.
          if (!lease.isCurrent()) return;
          delete slot.current;
          delete slot.running;
          controller.abort();
          this.onError(kind, "start", error);
          await this.#stop(kind, slot);
        }
      });
    }
    return Promise.all(Array.from(this.#slots.values(), slot => slot.queue)).then(() => undefined);
  }

  async #stop(kind: AgentKind, slot: LifecycleSlot): Promise<void> {
    try { await slot.registration.stop(); }
    catch (error) { this.onError(kind, "stop", error); }
  }
}
