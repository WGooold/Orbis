import { randomUUID } from "node:crypto";

import {
  agentKeyId, deviceKeyId, type AgentKey, type AgentStateDomain, type DeviceKey,
  type DeviceStateDomain, type DomainAvailability, type DomainCompleteness, type DomainSource,
  type DomainState, type HostStateDomain,
} from "@orbis/protocol";

/**
 * Host 端的 Agent 状态模型单写者（ADR-0032 §1/§6，issue #5 的实现）。
 *
 * 职责边界：
 * - 适配层先把原生事实归一成 snapshot/transaction，再调用这里；Registry 只做校验与提交，
 *   它的 API 全是同步的，**不会**在提交路径里发起原生 RPC、文件 IO 或网络探测。
 * - 提交是原子的：先落库，再通知订阅者；订阅者读到的就是已提交状态。
 * - 只有同一有效来源、`ready` + `complete` 的清单能用「缺席」删除条目。部分清单只合并，
 *   未知/失败保留最后已知值并标明待核对。
 * - 内容没变就不推进版本（心跳、分页请求、其他设备回执不冒充源端内容变化）。
 * - 这里只保存各领域的**当前投影**，不保存全量聊天历史。
 */

const DEFAULT_MAX_VALUE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 16_384;
const DEFAULT_MAX_RETIRED_EPOCHS = 64;

export type StateScope =
  | { readonly kind: "host" }
  | { readonly kind: "agent"; readonly key: AgentKey }
  /** 按设备投影：Host 持有，但不向其他设备广播。 */
  | { readonly kind: "device"; readonly key: DeviceKey };
export type StateDomain = AgentStateDomain | HostStateDomain | DeviceStateDomain;

export type DomainFact = {
  readonly source: DomainSource;
  readonly availability: DomainAvailability;
  readonly completeness: DomainCompleteness;
  /** 捕获这份事实时的宿主模型代次；不一致说明是迟到响应。省略表示按当前代次处理。 */
  readonly modelEpoch?: string;
};
export type ValueFact<T> = DomainFact & { readonly value: T };
/** 集合领域用一个按 id 索引的对象表示，Registry 才能安全地实施「缺席删除」。 */
export type CollectionFact = DomainFact & { readonly items: Readonly<Record<string, unknown>> };

export type CommitCode =
  | "invalid_fact"
  | "stale_model_epoch"
  | "source_conflict"
  | "stale_source_revision"
  | "retired_source_epoch"
  | "source_epoch_limit"
  | "source_epoch_baseline_required"
  | "value_too_large"
  | "registry_full";

export type CommitResult =
  | { readonly ok: true; readonly revision: number; readonly changed: boolean }
  | { readonly ok: false; readonly code: CommitCode; readonly detail?: string };

export type RegistryMutation =
  | { readonly kind: "value"; readonly scope: StateScope; readonly domain: StateDomain; readonly fact: ValueFact<unknown> }
  | { readonly kind: "collection"; readonly scope: StateScope; readonly domain: StateDomain; readonly fact: CollectionFact }
  | { readonly kind: "remove"; readonly scope: StateScope; readonly domain: StateDomain; readonly fact: DomainFact & { readonly removeIds: readonly string[] } };

/** Prepared owner state is finalized only after the whole registry transaction succeeds. */
export type PreparedRegistryCommit = {
  readonly changes: readonly RegistryMutation[];
  /** One prepared replacement per owner; two plans must not overwrite the same owner state. */
  readonly owner?: object;
  /** Optional exact native transaction dependency for conversation companion commits. */
  readonly conversationSource?: { readonly agent: AgentKey; readonly epoch: string; readonly seq: number };
  /** Reject a prepared owner state superseded since preparation, before swapping any companion. */
  readonly isCurrent?: () => boolean;
  readonly onCommitted: () => void;
};

/** All owners validate before any owner swaps. No asynchronous work or nested commit is allowed. */
export function commitPreparedRegistryTransaction(
  registry: AgentStateRegistry, plans: readonly PreparedRegistryCommit[],
): TransactionResult {
  const owners = plans.flatMap(plan => plan.owner ? [plan.owner] : []);
  if (new Set(owners).size !== owners.length) {
    return { ok: false, code: "invalid_fact", detail: "duplicate_prepared_owner", index: 0 };
  }
  if (plans.some(plan => plan.isCurrent?.() === false)) {
    return { ok: false, code: "invalid_fact", detail: "stale_prepared_state", index: 0 };
  }
  return registry.commitTransaction(plans.flatMap(plan => [...plan.changes]), () => {
    for (const plan of plans) plan.onCommitted();
  });
}

export type TransactionResult =
  | { readonly ok: true; readonly results: ReadonlyArray<Extract<CommitResult, { ok: true }>> }
  | { readonly ok: false; readonly code: CommitCode; readonly detail?: string; readonly index: number };

export type BaselineAction = "unchanged" | "state" | "baseline";
export type BaselineRead<T> = { readonly action: BaselineAction; readonly state: DomainState<T> | null };

export type RegistryChange =
  | { readonly kind: "committed"; readonly scope: StateScope; readonly domain: StateDomain; readonly state: DomainState<unknown> }
  | { readonly kind: "closed"; readonly scope: StateScope; readonly domain: StateDomain }
  | { readonly kind: "reset"; readonly modelEpoch: string };

export type RegistryListener = (change: RegistryChange) => void;

export type RegistryOptions = {
  /** 认证生命周期确认的模型代次；缺省时自己生成一个。 */
  readonly modelEpoch?: string;
  readonly now?: () => number;
  readonly maxValueBytes?: number;
  readonly maxEntries?: number;
  /** 拒绝超过上限的新代次，不能靠遗忘旧代次来接受迟到数据。重建模型可释放这些有界 tombstone。 */
  readonly maxRetiredEpochsPerEntry?: number;
};

type Entry = {
  readonly scope: StateScope;
  readonly domain: StateDomain;
  readonly fingerprint: string;
  /** 当前来源已经取代过的代次；迟到的完整快照也不能将它重新激活。 */
  readonly retiredEpochs: ReadonlySet<string>;
  readonly baselineRequired: boolean;
  state: DomainState<unknown>;
};

const scopeId = (scope: StateScope): string => scope.kind === "host"
  ? "host"
  : scope.kind === "agent" ? "agent:" + agentKeyId(scope.key) : "device:" + deviceKeyId(scope.key);
const entryKey = (scope: StateScope, domain: StateDomain): string => scopeId(scope) + "\u0000" + domain;
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export class AgentStateRegistry {
  readonly #now: () => number;
  readonly #maxValueBytes: number;
  readonly #maxEntries: number;
  readonly #maxRetiredEpochsPerEntry: number;
  #entries = new Map<string, Entry>();
  readonly #listeners = new Set<RegistryListener>();
  #transactionChanges: RegistryChange[] | undefined;
  #modelEpoch: string;

  constructor(options: RegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#maxRetiredEpochsPerEntry = options.maxRetiredEpochsPerEntry ?? DEFAULT_MAX_RETIRED_EPOCHS;
    this.#modelEpoch = options.modelEpoch ?? randomUUID();
  }

  currentModelEpoch(): string { return this.#modelEpoch; }

  /**
   * 将同一来源事务涉及的多个领域一起提交。任一校验失败即回滚全部领域与来源水位；
   * 全部成功后才发布变化，因此第一个订阅者也能读到完整批次。
   *
   * 这里没有异步回调或 IO，暂存中的 Map 不会泄漏到其它读取者；原有单领域 API 仍然可用。
   */
  commitTransaction(changes: readonly RegistryMutation[], onCommitted?: () => void): TransactionResult {
    const previous = this.#entries;
    this.#entries = new Map([...previous].map(([key, entry]) => [key, { ...entry }]));
    const notifications: RegistryChange[] = [];
    this.#transactionChanges = notifications;
    const results: Array<Extract<CommitResult, { ok: true }>> = [];
    let index = 0;
    try {
      for (const change of changes) {
        const result = change.kind === "value"
          ? this.commitValue(change.scope, change.domain, change.fact)
          : change.kind === "collection"
            ? this.commitCollection(change.scope, change.domain, change.fact)
            : this.removeCollectionItems(change.scope, change.domain, change.fact);
        if (!result.ok) {
          this.#entries = previous;
          return { ...result, index };
        }
        results.push(result);
        index += 1;
      }
      // Internal projection owners finalize their prepared in-memory state before any reader is
      // notified. The callback must only swap prepared values, never perform IO or nested commits.
      onCommitted?.();
    } catch {
      // 无法序列化/克隆的负载也不得留下已经暂存的半个事务。
      this.#entries = previous;
      return { ok: false, code: "invalid_fact", detail: "value", index };
    } finally {
      this.#transactionChanges = undefined;
    }
    this.#emitMany(notifications);
    return { ok: true, results };
  }

  /**
   * Host 重建或重新认证后开新代次。旧投影不能作为新代次的已确认事实，
   * 因此这里清空条目并广播 reset；来源要用完整清单重新建立基线。
   */
  beginModelEpoch(modelEpoch?: string): string {
    this.#modelEpoch = modelEpoch ?? randomUUID();
    this.#entries.clear();
    this.#emit({ kind: "reset", modelEpoch: this.#modelEpoch });
    return this.#modelEpoch;
  }

  /** 单值领域：整体替换当前投影。非 ready 的提交只更新核对状态，保留最后已知值。 */
  // ADR-0032 §6：未知/部分不删已有值；别把「这次没报」当删除。
  commitValue<T>(scope: StateScope, domain: StateDomain, fact: ValueFact<T>): CommitResult {
    const invalid = validateFact(fact);
    if (invalid !== undefined) return { ok: false, code: "invalid_fact", detail: invalid };
    const key = entryKey(scope, domain);
    const existing = this.#entries.get(key);
    const rejected = this.#reject(scope, domain, key, existing, fact);
    if (rejected !== undefined) return rejected;
    const previous = existing?.state.value ?? null;
    const next = fact.availability === "ready" ? fact.value ?? null : previous;
    return this.#store(scope, domain, key, existing, fact, next);
  }

  /**
   * 集合领域：`ready` + `complete` 时整份替换（缺席即删除）；`ready` + `partial` 时按 id 合并；
   * 其它情况保留最后已知集合，只更新可用性与核对时间。
   */
  commitCollection(scope: StateScope, domain: StateDomain, fact: CollectionFact): CommitResult {
    const invalid = validateFact(fact);
    if (invalid !== undefined) return { ok: false, code: "invalid_fact", detail: invalid };
    // 条目身份由来源决定，但不能是空白：空白键在模型里既不能索引也不能删除。
    for (const id of Object.keys(fact.items)) {
      if (id.trim() === "") return { ok: false, code: "invalid_fact", detail: "items.key" };
    }
    const key = entryKey(scope, domain);
    const existing = this.#entries.get(key);
    const rejected = this.#reject(scope, domain, key, existing, fact);
    if (rejected !== undefined) return rejected;
    const previous = (existing?.state.value ?? null) as Record<string, unknown> | null;
    const next = fact.availability !== "ready"
      ? previous
      : fact.completeness === "complete"
        ? { ...fact.items }
        : { ...(previous ?? {}), ...fact.items };
    return this.#store(scope, domain, key, existing, fact, next);
  }

  /**
   * 显式结束事实：按 id 删除条目（例如交互已回答）。
   *
   * 它不是「按缺席推断」——没有出现的 id 一律保留，只有明确列出的 id 会被删除，
   * 因此部分清单也能安全地报告自己知道的那几条已经结束。
   */
  removeCollectionItems(
    scope: StateScope,
    domain: StateDomain,
    fact: DomainFact & { readonly removeIds: readonly string[] },
  ): CommitResult {
    const invalid = validateFact(fact);
    if (invalid !== undefined) return { ok: false, code: "invalid_fact", detail: invalid };
    if (!Array.isArray(fact.removeIds) || fact.removeIds.some(id => typeof id !== "string" || id.trim() === "")) {
      return { ok: false, code: "invalid_fact", detail: "removeIds" };
    }
    const key = entryKey(scope, domain);
    const existing = this.#entries.get(key);
    const rejected = this.#reject(scope, domain, key, existing, fact);
    if (rejected !== undefined) return rejected;
    const previous = (existing?.state.value ?? null) as Record<string, unknown> | null;
    const next = { ...(previous ?? {}) };
    if (fact.availability === "ready") for (const id of fact.removeIds) delete next[id];
    return this.#store(scope, domain, key, existing, fact, next);
  }

  read<T>(scope: StateScope, domain: StateDomain): DomainState<T> | undefined {
    const entry = this.#entries.get(entryKey(scope, domain));
    return entry === undefined ? undefined : structuredClone(entry.state) as DomainState<T>;
  }

  /**
   * 基线读取契约：调用方带上自己已应用的版本，决定是「没变」「可直接应用」还是「必须重建基线」。
   * 只有 `ready` + `complete` 且有值的当前投影才自足；未知/部分/不可用都要回来源核对。
   */
  readForBaseline<T>(
    scope: StateScope,
    domain: StateDomain,
    known?: { readonly modelEpoch: string; readonly revision: number },
  ): BaselineRead<T> {
    const entry = this.#entries.get(entryKey(scope, domain));
    if (entry === undefined) return { action: "baseline", state: null };
    const state = structuredClone(entry.state) as DomainState<T>;
    if (known !== undefined && known.modelEpoch === state.modelEpoch && known.revision === state.revision) {
      return { action: "unchanged", state };
    }
    // ready + complete 才是自足的确认状态（value 为 null 表示「已确认没有内容」，不是未知）。
    const selfSufficient = state.availability === "ready" && state.completeness === "complete";
    return { action: selfSufficient ? "state" : "baseline", state };
  }

  /** 某个作用域当前的全部领域投影，用于快照发布。 */
  snapshot(scope: StateScope): Array<{ domain: StateDomain; state: DomainState<unknown> }> {
    const id = scopeId(scope);
    return [...this.#entries.values()]
      .filter(entry => scopeId(entry.scope) === id)
      .map(entry => ({ domain: entry.domain, state: structuredClone(entry.state) }));
  }

  /** 会话/接入确认结束后按作用域终结模型，不留旧写入者。 */
  endScope(scope: StateScope): number {
    const id = scopeId(scope);
    const removed = [...this.#entries.values()].filter(entry => scopeId(entry.scope) === id);
    for (const entry of removed) {
      this.#entries.delete(entryKey(entry.scope, entry.domain));
      this.#emit({ kind: "closed", scope: entry.scope, domain: entry.domain });
    }
    return removed.length;
  }

  subscribe(listener: RegistryListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  stats(): { modelEpoch: string; entries: number; writers: number } {
    return {
      modelEpoch: this.#modelEpoch,
      entries: this.#entries.size,
      writers: new Set([...this.#entries.values()].map(entry => entry.state.source.sourceId)).size,
    };
  }

  #reject(
    scope: StateScope,
    domain: StateDomain,
    key: string,
    existing: Entry | undefined,
    fact: DomainFact,
  ): CommitResult | undefined {
    if (fact.modelEpoch !== undefined && fact.modelEpoch !== this.#modelEpoch) {
      return { ok: false, code: "stale_model_epoch", detail: fact.modelEpoch };
    }
    if (existing === undefined) return undefined;
    if (existing.state.source.sourceId !== fact.source.sourceId || existing.state.source.producer !== fact.source.producer) {
      return { ok: false, code: "source_conflict", detail: scopeId(scope) + "/" + domain + " owned by " + existing.state.source.sourceId };
    }
    if (existing.retiredEpochs.has(fact.source.sourceEpoch)) {
      return { ok: false, code: "retired_source_epoch", detail: fact.source.sourceEpoch };
    }
    if (existing.state.source.sourceEpoch === fact.source.sourceEpoch
      && fact.source.sourceRevision < existing.state.source.sourceRevision) {
      return { ok: false, code: "stale_source_revision" };
    }
    if (existing.baselineRequired && fact.availability === "ready" && fact.completeness !== "complete") {
      return { ok: false, code: "source_epoch_baseline_required" };
    }
    if (existing.state.source.sourceEpoch !== fact.source.sourceEpoch) {
      if (existing.retiredEpochs.size >= this.#maxRetiredEpochsPerEntry) {
        return { ok: false, code: "source_epoch_limit" };
      }
      // 标记「来源未知/失败」永远允许：它保留最后已知值并标明待核对（ADR-0032 §9）。
      // 只有声称 ready 的内容必须先用完整清单重建基线，否则部分清单可能悄悄删掉有效状态。
      if (fact.availability === "ready" && fact.completeness !== "complete") {
        return { ok: false, code: "source_epoch_baseline_required" };
      }
    }
    return undefined;
  }

  #store(
    scope: StateScope,
    domain: StateDomain,
    key: string,
    existing: Entry | undefined,
    fact: DomainFact,
    value: unknown,
  ): CommitResult {
    // 内容指纹**不含** sourceRevision：来源水位只说明「来源核对过」，不是内容版本，
    // 否则每次心跳都会把领域版本推高。
    const fingerprint = JSON.stringify([fact.source.producer, fact.source.sourceId, fact.source.sourceEpoch,
      fact.availability, fact.completeness, value ?? null]);
    const bytes = byteLength(JSON.stringify(value ?? null));
    if (bytes > this.#maxValueBytes) {
      return { ok: false, code: "value_too_large", detail: bytes + " > " + this.#maxValueBytes };
    }
    if (existing === undefined && this.#entries.size >= this.#maxEntries) {
      return { ok: false, code: "registry_full" };
    }
    if (existing !== undefined && existing.fingerprint === fingerprint) {
      // 内容没变：只刷新来源水位与核对时间，不推进版本，也不广播。
      existing.state = { ...existing.state, source: { ...fact.source }, checkedAt: this.#now() };
      return { ok: true, revision: existing.state.revision, changed: false };
    }
    const revision = (existing?.state.revision ?? 0) + 1;
    const state: DomainState<unknown> = {
      modelEpoch: this.#modelEpoch,
      revision,
      availability: fact.availability,
      completeness: fact.completeness,
      source: { ...fact.source },
      checkedAt: this.#now(),
      value: structuredClone(value ?? null),
    };
    const retiredEpochs = new Set(existing?.retiredEpochs);
    const epochChanged = existing !== undefined && existing.state.source.sourceEpoch !== fact.source.sourceEpoch;
    if (epochChanged) {
      retiredEpochs.add(existing.state.source.sourceEpoch);
    }
    const baselineRequired = fact.availability === "ready" && fact.completeness === "complete"
      ? false : epochChanged || (existing?.baselineRequired ?? false);
    this.#entries.set(key, { scope: structuredClone(scope), domain, fingerprint, retiredEpochs, baselineRequired, state });
    // 没有订阅者时不必克隆：HostService 目前不订阅，这条路径是热路径。
    if (this.#listeners.size > 0) {
      const change: RegistryChange = { kind: "committed", scope: structuredClone(scope), domain, state: structuredClone(state) };
      if (this.#transactionChanges !== undefined) this.#transactionChanges.push(change);
      else this.#emit(change);
    }
    return { ok: true, revision, changed: true };
  }

  #publishing = false;
  readonly #queue: RegistryChange[] = [];

  /**
   * 先提交再发布。已经是发布中（订阅者又触发了一次提交）时把变化排队，
   * 由当前这一轮统一按顺序发完，避免后来的订阅者看到交错顺序。
   */
  #emit(change: RegistryChange): void {
    this.#emitMany([change]);
  }

  /** 整个事务先入发布队列，订阅者触发的新提交排在本批次之后。 */
  #emitMany(changes: readonly RegistryChange[]): void {
    this.#queue.push(...changes);
    if (this.#publishing) return;
    this.#publishing = true;
    try {
      while (this.#queue.length > 0) {
        const next = this.#queue.shift() as RegistryChange;
        for (const listener of [...this.#listeners]) {
          try { listener(next); } catch { /* 订阅者不能破坏写者的事务 */ }
        }
      }
    } finally { this.#publishing = false; }
  }
}

function validateFact(fact: DomainFact): string | undefined {
  const { source, availability, completeness } = fact;
  if (source === undefined || typeof source.sourceId !== "string" || source.sourceId.trim() === "") return "source.sourceId";
  if (typeof source.sourceEpoch !== "string" || source.sourceEpoch.trim() === "") return "source.sourceEpoch";
  if (!Number.isSafeInteger(source.sourceRevision) || source.sourceRevision < 0) return "source.sourceRevision";
  if (source.producer !== "native" && source.producer !== "adapter" && source.producer !== "host") return "source.producer";
  if (availability !== "ready" && availability !== "unavailable" && availability !== "unknown") return "availability";
  if (completeness !== "complete" && completeness !== "partial" && completeness !== "unknown") return "completeness";
  return undefined;
}
